// 执行器 —— 一个 Agent 拿一个子任务,经 Router 选定的候选链(主选+fallback)产出成果。
// P0-2:遍历候选链 —— 上下文预检超限跳过、chat 失败则冷却该后端 + 降级到下一候选,成功后用该模型续写/自测。
import { SKILLS } from './skills';
import { routeChain } from './router';
import { getProvider, markFailed, type Provider } from './providers';
import { extractHtml } from './build';
import { playtest } from './playtest';
import { recordOutcome } from './routing-memory';
import { freshnessInstruction, freshnessObservationContext } from './freshness';
import type { SubTask, AgentResult } from './types';

// 续写补全:造物代码常超单次输出上限被截断,检测 HTML 没写完(无 </html>)就让模型接着写,最多 4 轮拼到完整
async function completeHtml(provider: Provider, model: string, system: string, output: string): Promise<string> {
  let out = output;
  let rounds = 0;
  while (rounds < 4 && out && !/<\/html\s*>/i.test(out)) {
    rounds++;
    const tail = out.slice(-1800);
    const cont =
      (await provider.chat(model, {
        system,
        user:
          `你正在写的单文件 HTML 被截断了。请【从最后一个字符紧接着往下写】,把剩余部分补全到完整结束(以 </html> 收尾)。` +
          `要求:不要重复任何已有内容、不要解释、不要 markdown 代码块标记,只输出接续的代码。\n\n已写到这里(末尾片段):\n${tail}`,
        maxTokens: 8192,
        temperature: 0.6,
      })) || '';
    if (!cont.trim()) break;
    out += cont.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '');
  }
  return out;
}

function officeExecutionInstruction(sub: SubTask): string {
  const ext = (sub.outFile?.split('.').pop() || '').toLowerCase();
  if (ext === 'xlsx') {
    return [
      '',
      '【Excel 输出硬规则】',
      '- 必须输出一张 Markdown 表格,不要只写说明文字。',
      '- 表头必须贴合本次 prompt 的真实业务字段,不要套固定模板;例如采购比价要有供应商报价/交期/推荐理由,合同台账要有金额/履约/付款/归档。',
      '- 表格至少 8 个字段、2 行样例数据;字段名要可直接变成 Excel 列名。',
      '- 可在表格后补充简短字段说明,但表格必须先出现。',
    ].join('\n');
  }
  if (ext === 'pptx') {
    return [
      '',
      '【PPT 输出硬规则】',
      '- 必须按幻灯片分页输出,用 "## 第N页: 标题" 标识每页。',
      '- 每页只放一个主要观点,包含重点结论、问题风险、下一步安排等真实汇报逻辑。',
      '- 禁止把整篇长文堆成一页。',
    ].join('\n');
  }
  if (ext === 'docx' || ext === 'pdf') {
    return [
      '',
      '【Word/PDF 输出硬规则】',
      '- 必须输出正式材料结构:标题、执行摘要/结论、正文分节、表格或行动清单、风险与下一步。',
      '- 禁止只写提纲、占位语或“已完成”。',
    ].join('\n');
  }
  return '';
}

export async function runAgent(
  sub: SubTask,
  goal: string,
  siblings: string[] = [],
  deps: AgentResult[] = [],
): Promise<AgentResult> {
  const t0 = Date.now();
  const skill = SKILLS[sub.skill];

  // 让 Agent 知道别人负责什么 → 聚焦本环、不重复
  const others = siblings.filter((t) => t !== sub.title);
  const boundary = others.length
    ? `\n\n本方案的其他部分由别的 Agent 负责:${others.join('、')}。你只产出"${sub.title}",不要重复他们的内容。`
    : '';
  // 前置依赖的产出(如已确立的标准/规格),作为必须严格遵循的上下文
  const depContext = deps.length
    ? `\n\n以下是前置环节已确立的标准/成果,你必须严格遵循:\n` +
      deps.map((d) => `### ${d.title}\n${d.output.slice(0, 3000)}`).join('\n\n')
    : '';
  const fresh = freshnessInstruction(goal);
  const evidenceText = await freshnessObservationContext(goal);
  const officeInstruction = officeExecutionInstruction(sub);

  const base = {
    system: skill.system,
    user:
      `整体目标:${goal}\n\n` +
      `你这一环的任务:${sub.objective}${boundary}${depContext}\n\n` +
      (evidenceText ? `${evidenceText}\n\n` : '') +
      officeInstruction +
      fresh +
      `请直接产出这部分成果(markdown,聚焦本环)。` +
      `只给成品内容本身,不要任何开场白、寒暄、自我介绍或"好的"之类的过渡话,也不要重复任务标题。`,
    maxTokens: 8192,
    temperature: 0.6,
  };

  // 动态 fallback:按候选链依次试,上下文超限跳过、失败则冷却该后端并降级到下一候选
  const chain = routeChain(sub);
  const approxInTokens = (base.system.length + base.user.length) / 2; // 粗估输入 token(中文约 2 字符/token 上界)
  let output = '';
  let usedP: Provider | null = null;
  let usedModel = '';
  let lastErr = '';
  for (const r of chain) {
    const p = getProvider(r.provider);
    if (approxInTokens > p.meta.contextLimit * 0.9) { lastErr = `输入超 ${p.label} 上下文上限`; continue; }
    try {
      output = (await p.chat(r.model, base)) || '';
      usedP = p;
      usedModel = r.model;
      break;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      markFailed(p.id); // 失败 → 该后端进冷却,试下一候选
    }
  }
  if (!usedP) {
    return { subtaskId: sub.id, title: sub.title, skill: sub.skill, model: 'none', output: '', evidenceText, ok: false, error: `候选模型全失败:${lastErr}`, ms: Date.now() - t0 };
  }
  const tag = `${usedP.id}:${usedModel}`;

  try {
    // 造物(code):续写补全 + "自测→修复"闭环(用选中的 provider)
    let lastPlayable = true; // 非造物任务默认视为达标(无客观自测信号)
    if (sub.skill === 'code') {
      lastPlayable = false;
      output = await completeHtml(usedP, usedModel, skill.system, output);
      for (let fix = 0; fix < 2; fix++) {
        const res = await playtest(extractHtml(output));
        console.error(`[playtest #${fix} @${tag}] ${res.playable ? 'PASS ✓' : '不可玩: ' + res.issues.join(' | ')}`);
        lastPlayable = res.playable;
        if (res.playable) break;
        const fixUser =
          `你写的这个程序经过真机自测,发现这些"不能玩"的问题:\n- ${res.issues.join('\n- ')}\n\n` +
          `请针对性修复(尤其:把"按键→角色移动"整条链跑通、确保 gameLoop 持续运行且不报错、角色出生站稳、别一开始就死或就赢),` +
          '输出【完整可运行】的修正版,只要一个 ```html 代码块,不要解释。\n\n当前代码:\n' +
          output;
        const fixed =
          (await usedP.chat(usedModel, { system: skill.system, user: fixUser, maxTokens: 8192, temperature: 0.4 })) || '';
        if (!fixed.trim()) break;
        output = await completeHtml(usedP, usedModel, skill.system, fixed);
      }
    }
    if (!output) output = '(空)';
    // kNN 自学习:记录本次客观质量(造物看可玩性、其余视为成功产出),供后续相似任务路由微调
    recordOutcome(sub.objective, sub.skill, tag, sub.skill === 'code' ? (lastPlayable ? 1 : 0.4) : 0.85);
    return { subtaskId: sub.id, title: sub.title, skill: sub.skill, model: tag, output, evidenceText, ok: true, ms: Date.now() - t0 };
  } catch (e) {
    // 续写/自测阶段出错:首轮 output 已在手,降级返回它(避免整任务作废)
    const error = e instanceof Error ? e.message : String(e);
    return { subtaskId: sub.id, title: sub.title, skill: sub.skill, model: tag, output: output || '(空)', evidenceText, ok: !!output, error, ms: Date.now() - t0 };
  }
}
