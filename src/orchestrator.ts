// 编排 —— 串起整条链路:Brain 拆解 → Agent 并行执行 → Result 整合。
import { join } from 'node:path';
import { plan as makePlan } from './brain';
import { runAgent } from './agent';
import { assemble } from './result';
import { recall, remember } from './memory';
import type { AgentResult, Deliverable, EventSink } from './types';

export async function run(
  goal: string,
  emit: EventSink = () => {},
  outDir: string = join(process.cwd(), 'output'),
): Promise<Deliverable> {
  const t0 = Date.now();

  emit({ type: 'brain.start', goal });
  const p = await makePlan(goal, recall()); // 召回长期记忆注入 Brain
  emit({ type: 'brain.done', plan: p });

  // 依赖编排:按 dependsOn 分层执行。无依赖的先并行跑,完成后再跑依赖它们的(把前置产出当上下文传入)。
  const siblings = p.subtasks.map((s) => s.title);
  const done = new Map<string, AgentResult>();
  let remaining = [...p.subtasks];
  while (remaining.length) {
    let ready = remaining.filter((s) => s.dependsOn.every((d) => done.has(d)));
    if (ready.length === 0) ready = remaining; // 兜底:循环/坏依赖时剩余全跑
    const layer = await Promise.all(
      ready.map(async (sub) => {
        emit({ type: 'agent.start', subtask: sub });
        const deps = sub.dependsOn.map((d) => done.get(d)).filter((x): x is AgentResult => !!x);
        const r = await runAgent(sub, goal, siblings, deps);
        emit({ type: 'agent.done', result: r });
        return r;
      }),
    );
    ready.forEach((s, i) => done.set(s.id, layer[i]!));
    remaining = remaining.filter((s) => !done.has(s.id));
  }
  const results = p.subtasks.map((s) => done.get(s.id)!);

  emit({ type: 'result.start' });
  const deliverable = await assemble(p, results, Date.now() - t0, outDir, emit);
  emit({ type: 'result.done', deliverable });

  await remember(goal, p.kind).catch(() => {}); // 记录任务 + 提炼偏好(确保写入,CLI 短进程才不丢)
  return deliverable;
}
