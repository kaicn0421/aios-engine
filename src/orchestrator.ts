// 编排 —— 串起整条链路:Brain 拆解 → Agent 并行执行 → Result 整合。
import { join } from 'node:path';
import { localFallbackPlan, plan as makePlan } from './brain';
import { runAgent } from './agent';
import { assemble } from './result';
import { recall, remember } from './memory';
import { cleanUserGoal, hostContextSlices, hasRepairContext } from './goal';
import { officeFormatsFromGoal, defaultOutFileForFormat } from './office-format';
import { freshnessObservationContext, invalidateFreshnessObservation } from './freshness';
import { getProvider } from './providers';
import { CONFIG } from './config';
import type { AgentResult, Deliverable, EventSink, SubTask } from './types';

function defaultOutputDir(): string {
  return process.env.AIOS_ENGINE_OUTPUT_DIR || join(process.cwd(), 'output');
}

function agentTimeoutMs(sub: SubTask): number {
  const fromEnv = Number(process.env.AIOS_ENGINE_AGENT_TIMEOUT_MS || '');
  if (Number.isFinite(fromEnv) && fromEnv >= 30_000) return fromEnv;
  return sub.complexity === 'deep' ? 90_000 : 75_000;
}

function brainTimeoutMs(): number {
  const fromEnv = Number(process.env.AIOS_ENGINE_BRAIN_TIMEOUT_MS || '');
  if (Number.isFinite(fromEnv) && fromEnv >= 5_000) return fromEnv;
  return 20_000;
}

async function makePlanWithTimeout(goal: string, memory: string, emit: EventSink): Promise<Awaited<ReturnType<typeof makePlan>>> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutMs = brainTimeoutMs();
  const timeout = new Promise<Awaited<ReturnType<typeof makePlan>>>((resolve) => {
    timer = setTimeout(() => {
      emit({ type: 'result.step', stage: 'brain_timeout', message: 'Brain planning timeout', detail: `fallback after ${Math.round(timeoutMs / 1000)}s`, ok: false });
      resolve(localFallbackPlan(goal, `brain_timeout_${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([makePlan(goal, memory), timeout]);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    emit({ type: 'result.step', stage: 'brain_fallback', message: 'Brain planning failed', detail: reason.slice(0, 120), ok: false });
    return localFallbackPlan(goal, reason);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function timeoutAgentResult(sub: SubTask, ms: number): AgentResult {
  return {
    subtaskId: sub.id,
    title: sub.title,
    skill: sub.skill,
    model: 'timeout_guard',
    output: [
      `TIMEOUT: "${sub.title}" 子任务超过 ${Math.round(ms / 1000)} 秒仍未返回。`,
      'AIOS 已停止等待这一环,后续交付会保留已完成内容并标注缺口,避免任务无限卡住。',
    ].join('\n'),
    ok: false,
    error: `subtask_timeout_${ms}ms`,
    ms,
  };
}

function retryTimeoutMs(): number {
  const fromEnv = Number(process.env.AIOS_ENGINE_AGENT_RETRY_TIMEOUT_MS || '');
  if (Number.isFinite(fromEnv) && fromEnv >= 30_000) return fromEnv;
  return 45_000;
}

function layerConcurrency(): number {
  const fromEnv = Number(process.env.AIOS_ENGINE_LAYER_CONCURRENCY || '');
  if (Number.isFinite(fromEnv) && fromEnv >= 1) return Math.min(6, Math.floor(fromEnv));
  return 2;
}

function shouldRetryAgentResult(result: AgentResult): boolean {
  return !result.ok && /^subtask_timeout_\d+ms$/.test(result.error || '');
}

function compactRetrySubtask(sub: SubTask): SubTask {
  return {
    ...sub,
    complexity: 'standard',
    objective: [
      `上一轮"${sub.title}"执行超时。请改用压缩交付方式补齐这一环,不要追求长篇幅。`,
      `必须覆盖本环最关键的结论、3-5 条依据、风险/动作清单;禁止空话、禁止说无法完成。`,
      `如果缺少外部数据,明确写"待核验"和需要补的来源,不要编造数字。`,
      `原任务:${sub.objective}`,
    ].join('\n'),
  };
}

async function runAgentRace(
  sub: SubTask,
  goal: string,
  siblings: string[],
  deps: AgentResult[],
  ms: number,
): Promise<AgentResult> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<AgentResult>((resolve) => {
    timeout = setTimeout(() => resolve(timeoutAgentResult(sub, ms)), ms);
  });
  try {
    return await Promise.race([runAgent(sub, goal, siblings, deps), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runAgentWithTimeout(
  sub: SubTask,
  goal: string,
  siblings: string[],
  deps: AgentResult[],
): Promise<AgentResult> {
  return runAgentRace(sub, goal, siblings, deps, agentTimeoutMs(sub));
}

async function retryTimedOutAgent(
  sub: SubTask,
  goal: string,
  siblings: string[],
  deps: AgentResult[],
  first: AgentResult,
): Promise<AgentResult> {
  const retry = await runAgentRace(compactRetrySubtask(sub), goal, siblings, deps, retryTimeoutMs());
  if (retry.ok) {
    return {
      ...retry,
      title: sub.title,
      model: `${first.model}->retry:${retry.model}`,
      output: [
        `> 上一轮执行超时,AIOS 已自动改用压缩补写完成本环。`,
        '',
        retry.output,
      ].join('\n'),
      ms: first.ms + retry.ms,
    };
  }
  return timeoutRescueResult(sub, goal, deps, first, retry);
}

function dependencyDigest(deps: AgentResult[]): string {
  return deps
    .filter((d) => d.ok && d.output.trim())
    .slice(0, 3)
    .map((d) => `### ${d.title}\n${d.output.slice(0, 900)}`)
    .join('\n\n');
}

function timeoutRescueResult(
  sub: SubTask,
  goal: string,
  deps: AgentResult[],
  first: AgentResult,
  retry: AgentResult,
): AgentResult {
  const depText = dependencyDigest(deps);
  const evidenceNote = depText
    ? '本环依据前置标准和已完成子任务做压缩补齐;涉及市场数字、租金、客流、融资倍数等精确值时均保留为“待核验/假设”。'
    : '本环因模型长时间未返回,采用 AIOS 超时救援模板收口;涉及精确外部数据时均标为“待核验/假设”。';
  const actionRows = [
    '| 模块 | 建议动作 | 验收口径 | 风险边界 |',
    '|---|---|---|---|',
    `| ${sub.title} | 先形成可执行版本,再用真实调研数据复核 | 能支持用户继续决策和修改 | 不把未经验证的数据写成事实 |`,
    '| 资料补强 | 补充政府统计、行业报告、竞品门店、供应商报价 | 每个关键判断至少 1 个来源 | 没来源处标 SOURCE_GAP |',
    '| 落地推进 | 拆成 30/60/90 天任务清单 | 有负责人、时间、产出物 | 避免只停留在概念层 |',
  ].join('\n');
  const output = [
    `## ${sub.title}`,
    '',
    '> AIOS 超时救援: 原模型请求和压缩重试均未在限定时间内返回。为避免长任务卡死,本节先给出可编辑的保底章节,并明确证据边界。',
    '',
    `### 本节目标`,
    sub.objective.replace(/\n+/g, '\n').slice(0, 1200),
    '',
    `### 当前可用结论`,
    evidenceNote,
    '',
    `### 执行动作表`,
    actionRows,
    '',
    `### 需要补证的关键问题`,
    '- 当地市场规模、消费频次、商圈租金、竞品坪效、供应链报价等数字必须以后续来源复核。',
    '- 财务测算应区分“模型假设”和“已核验事实”,不要把假设当成最终结论。',
    '- 上市路径应先按公司治理、食品安全、财务规范、门店复制能力建立底稿。',
    depText ? `\n### 前置依据摘录\n${depText}` : '',
  ].filter(Boolean).join('\n\n');
  return {
    subtaskId: sub.id,
    title: sub.title,
    skill: sub.skill,
    model: `${first.model}->retry_failed->timeout_rescue`,
    output,
    evidenceText: [first.evidenceText, retry.evidenceText].filter(Boolean).join('\n\n'),
    ok: true,
    ms: first.ms + retry.ms,
  };
}

export async function run(
  goal: string,
  emit: EventSink = () => {},
  outDir: string = defaultOutputDir(),
): Promise<Deliverable> {
  const t0 = Date.now();
  const userGoal = cleanUserGoal(goal);
  // 宿主上下文(返修说明/质量契约/客户偏好)曾在这一行后全程蒸发=自动返修断链。
  // 现在:展示与意图判定用干净 userGoal,执行用 hostContext 随子任务下发。
  const hostContext = hostContextSlices(goal);
  const repairRound = hasRepairContext(goal);

  emit({ type: 'brain.start', goal: userGoal });
  const p = await makePlanWithTimeout(userGoal, recall(), emit); // 召回长期记忆注入 Brain;超时走本地兜底计划
  if (hostContext) {
    for (const sub of p.subtasks) {
      sub.objective += `\n\n【宿主上下文(契约/返修要求,执行时必须遵守)】\n${hostContext}`;
    }
  }
  // 质量契约里点名的格式:干净 goal 推不出格式时按契约补(契约 slice 只在原始 goal 里)
  const contractFormats = officeFormatsFromGoal(goal);
  if (contractFormats.length && officeFormatsFromGoal(userGoal).length === 0) {
    const primary = contractFormats[0]!;
    const shared = p.subtasks.map((s) => s.outFile || '').find((n) => n.toLowerCase().endsWith(`.${primary}`))
      || defaultOutFileForFormat(userGoal, primary);
    for (const sub of p.subtasks) sub.outFile = shared;
  }
  emit({ type: 'brain.done', plan: p });

  emit({ type: 'result.step', stage: 'evidence', message: 'Collecting shared web evidence', detail: 'task-level cache' });
  if (repairRound) invalidateFreshnessObservation(goal); // 返修轮不许吃第一轮失败取证的缓存
  await freshnessObservationContext(userGoal).catch(() => '');

  // 依赖编排:按 dependsOn 分层执行。无依赖的先并行跑,完成后再跑依赖它们的(把前置产出当上下文传入)。
  const siblings = p.subtasks.map((s) => s.title);
  const done = new Map<string, AgentResult>();
  let remaining = [...p.subtasks];
  while (remaining.length) {
    let ready = remaining.filter((s) => s.dependsOn.every((d) => done.has(d)));
    if (ready.length === 0) ready = remaining; // 兜底:循环/坏依赖时剩余全跑
    const layer: AgentResult[] = [];
    const concurrency = layerConcurrency();
    for (let i = 0; i < ready.length; i += concurrency) {
      const batch = ready.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (sub) => {
          emit({ type: 'agent.start', subtask: sub });
          const deps = sub.dependsOn.map((d) => done.get(d)).filter((x): x is AgentResult => !!x);
          let r = await runAgentWithTimeout(sub, userGoal, siblings, deps);
          if (shouldRetryAgentResult(r)) {
            emit({ type: 'result.step', stage: 'agent_retry', message: 'Retrying timed-out subtask', detail: sub.title });
            r = await retryTimedOutAgent(sub, userGoal, siblings, deps, r);
          }
          emit({ type: 'agent.done', result: r });
          return r;
        }),
      );
      layer.push(...batchResults);
    }
    ready.forEach((s, i) => done.set(s.id, layer[i]!));
    remaining = remaining.filter((s) => !done.has(s.id));
  }
  const results = p.subtasks.map((s) => done.get(s.id)!);

  emit({ type: 'result.start' });
  // 页数校准器:合并后整份内容统一补页/裁剪(见 result.calibrateOfficeContent)
  const calibrator = { provider: getProvider('deepseek'), model: CONFIG.models.default };
  const deliverable = await assemble(p, results, Date.now() - t0, outDir, emit, calibrator);
  emit({ type: 'result.done', deliverable });

  await remember(userGoal, p.kind).catch(() => {}); // 记录任务 + 提炼偏好(确保写入,CLI 短进程才不丢)
  return deliverable;
}

export const __orchestratorTest = {
  brainTimeoutMs,
  makePlanWithTimeout,
  agentTimeoutMs,
  timeoutAgentResult,
  compactRetrySubtask,
  shouldRetryAgentResult,
  timeoutRescueResult,
  layerConcurrency,
};
