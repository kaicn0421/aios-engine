// 三大模型横评 —— 同一批代表任务,DeepSeek / 豆包 / 千问 各跑一遍,自动检测后汇总成对比数据,
// 为"哪类任务派给哪个模型"的路由分配提供一手依据。
// 跑法: npx tsx src/eval-models.ts   (结果存 output/model-eval-*.json,过程打印到控制台)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deepseek, ark, qwen, type Provider } from './providers';
import { QWEN } from './config';
import { SKILLS } from './skills';
import type { SkillName } from './types';
import { extractHtml } from './build';
import { playtest } from './playtest';

interface ModelCfg { name: string; p: Provider; model: string; }
const ALL_MODELS: ModelCfg[] = [
  { name: 'DeepSeek-V4-Pro', p: deepseek, model: process.env.EVAL_DEEPSEEK || 'deepseek-v4-pro' },
  { name: '豆包2.0-code', p: ark, model: process.env.EVAL_DOUBAO || 'doubao-seed-2-0-code-preview-260215' },
  { name: '千问3-Coder', p: qwen, model: QWEN.model },
];
// EVAL_ONLY=DeepSeek 之类 → 只跑名字匹配的模型(补测/重测单列,不重跑其他两个)
const MODELS: ModelCfg[] = process.env.EVAL_ONLY
  ? ALL_MODELS.filter((m) => m.name.includes(process.env.EVAL_ONLY as string))
  : ALL_MODELS;

interface Task { name: string; skill: SkillName; kind: 'code' | 'doc'; goal: string; }
const TASKS: Task[] = [
  { name: '贪吃蛇·简单游戏', skill: 'code', kind: 'code', goal: '做一个贪吃蛇网页游戏,方向键控制移动,吃食物变长加分,撞墙或撞自己结束,有开始和重新开始按钮' },
  { name: '马里奥·复杂游戏', skill: 'code', kind: 'code', goal: '做一个横版马里奥小游戏,方向键或AD左右移动、空格或W跳跃,踩敌人消灭、吃金币加分,有平台和地面,到右侧旗子过关' },
  { name: '打砖块·中等游戏', skill: 'code', kind: 'code', goal: '做一个打砖块游戏,左右键或鼠标控制挡板,反弹小球击碎上方砖块,有分数、生命和过关' },
  { name: 'SaaS落地页·网页', skill: 'code', kind: 'code', goal: '做一个SaaS产品落地页,包含顶部导航、Hero主视觉、功能介绍、定价方案、客户评价、页脚,现代审美、响应式' },
  { name: '充电桩调研·文档', skill: 'research', kind: 'doc', goal: '写一份中国新能源汽车充电桩行业的市场调研报告,涵盖市场规模、竞争格局、商业模式、发展趋势、风险提示,要有数据和来源' },
];

// 续写补全(造物常超 8192 被截断):没写完就接着写,最多 4 轮
async function completeOnce(p: Provider, model: string, system: string, out: string): Promise<string> {
  let o = out;
  let rounds = 0;
  while (rounds < 4 && o && !/<\/html\s*>/i.test(o)) {
    rounds++;
    const tail = o.slice(-1800);
    const cont =
      (await p.chat(model, {
        system,
        user: `单文件 HTML 被截断了,从最后一个字符紧接着写到完整结束(以 </html> 收尾),不要重复、不要解释、不要 markdown 标记:\n${tail}`,
        maxTokens: 8192,
        temperature: 0.6,
      })) || '';
    if (!cont.trim()) break;
    o += cont.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '');
  }
  return o;
}

async function evalCode(p: Provider, model: string, system: string, output: string) {
  const truncatedFirst = !/<\/html\s*>/i.test(extractHtml(output)); // 首轮是否就被截断(反映输出上限)
  const full = await completeOnce(p, model, system, output);
  const html = extractHtml(full);
  const complete = /<\/html\s*>/i.test(html);
  const pt = complete ? await playtest(html) : { playable: false, issues: ['HTML 不完整,无法测'] };
  return { bytes: html.length, truncatedFirst, complete, playable: pt.playable, issues: pt.issues.slice(0, 2) };
}

function evalDoc(output: string) {
  const sections = (output.match(/^#{1,4}\s/gm) || []).length;
  const tableRows = (output.match(/^\|.*\|/gm) || []).length;
  const dataPoints = (output.match(/\d[\d,.]*\s*(%|亿|万|元|台|个|km|kW)/g) || []).length;
  return { bytes: output.length, sections, tableRows, dataPoints };
}

(async () => {
  const live = MODELS.filter((m) => m.p.available);
  console.log('参评模型:', live.map((m) => `${m.name}(${m.model})`).join(' | ') || '(无可用,先配 key)');
  const results: Array<Record<string, unknown>> = [];
  for (const task of TASKS) {
    for (const m of MODELS) {
      if (!m.p.available) { console.log(`— 跳过 ${task.name} × ${m.name}(未配 key)`); continue; }
      const t0 = Date.now();
      try {
        const out = (await m.p.chat(m.model, { system: SKILLS[task.skill].system, user: task.goal, maxTokens: 8192, temperature: 0.6 })) || '';
        const metrics = task.kind === 'code' ? await evalCode(m.p, m.model, SKILLS[task.skill].system, out) : evalDoc(out);
        const row = { task: task.name, model: m.name, sec: Math.round((Date.now() - t0) / 1000), ...metrics };
        results.push(row);
        console.log(`✓ ${task.name} × ${m.name} (${row.sec}s):`, JSON.stringify(metrics));
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        results.push({ task: task.name, model: m.name, error: err });
        console.log(`✗ ${task.name} × ${m.name}:`, err.slice(0, 120));
      }
    }
  }
  const outPath = join(process.cwd(), 'output', `model-eval-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
  console.log('\n=== 横评完成,完整数据 →', outPath, '===');
})();
