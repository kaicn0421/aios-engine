// Plan Mode —— 复杂任务先出计划、用户确认后再执行。
// 三阶段：探索 → 计划 → 执行

import { CONFIG } from './config';
import { deepseek, isUsable, type Provider } from './providers';
import { TOOL_DEFINITIONS } from './tools';
import type { ToolContext } from './tools';
import { buildSystemPrompt } from './system-prompt';
import type { AgentMessage, AgentConfig } from './types';

/** Plan 阶段的事件 */
export type PlanEvent =
  | { type: 'explore_start' }
  | { type: 'explore_done'; context: string }
  | { type: 'plan_ready'; plan: string; steps: PlanStep[] }
  | { type: 'exec_start'; step: number; total: number }
  | { type: 'exec_done'; step: number; result: string }
  | { type: 'done' };

export interface PlanStep {
  step: number;
  title: string;
  action: string; // 描述这个步骤要做什么
  tools: string[]; // 预计使用的工具
}

function getProvider(): Provider {
  if (isUsable(deepseek)) return deepseek;
  throw new Error('Plan 模式需要 DeepSeek Provider');
}

/** 阶段1：探索 —— 理解任务和代码上下文 */
async function explorePhase(
  goal: string,
  config: AgentConfig,
  emit: (e: PlanEvent) => void,
  provider: Provider,
): Promise<string> {
  emit({ type: 'explore_start' });

  const explorePrompt = `你需要完成以下任务。在开始执行之前，请先探索工作目录，了解项目结构和相关代码。

任务: ${goal}

请用 glob、grep、read 等工具探索项目，收集足够上下文后，用简短的一段话总结：
1. 项目是做什么的
2. 相关代码在哪些文件中
3. 实现这个任务的大致难度和风险点

注意：这个阶段只探索和总结，不要做任何修改。`;

  const systemPrompt = buildSystemPrompt(config.workDir, process.platform || 'darwin');
  const messages: AgentMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: explorePrompt },
  ];

  let context = '';
  let turns = 0;

  while (turns < 10) {
    turns++;
    const result = await provider.chatWithTools!(config.model, {
      messages,
      tools: TOOL_DEFINITIONS,
      temperature: 0.3,
      reasoningEffort: 'medium',
      stream: false,
    });

    if (result.toolCalls.length === 0) {
      context = result.content || '';
      break;
    }

    messages.push({
      role: 'assistant',
      content: result.content,
      tool_calls: result.toolCalls,
    });

    const { executeToolCall } = await import('./tools');
    const ctx: ToolContext = { workDir: config.workDir, messages, config };

    for (const tc of result.toolCalls) {
      const toolResult = await executeToolCall(tc.function.name, tc.function.arguments, tc.id, ctx);
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolResult.content,
      });
    }
  }

  emit({ type: 'explore_done', context });
  return context;
}

/** 阶段2：制定计划 */
async function planPhase(
  goal: string,
  context: string,
  config: AgentConfig,
  emit: (e: PlanEvent) => void,
  provider: Provider,
): Promise<{ plan: string; steps: PlanStep[] }> {
  const planPrompt = `基于以下探索结果，为任务制定一个详细的执行计划。

任务目标: ${goal}

探索结果:
${context.slice(0, 4000)}

请制定一个分步执行计划。输出 JSON 格式：

{
  "plan": "整体方案的简述（一段话）",
  "steps": [
    {"step": 1, "title": "步骤名", "action": "具体要做什么", "tools": ["用到哪些工具"]}
  ]
}

要求：
- 步骤不要超过 6 个
- 每个步骤说清楚要做什么、用什么工具
- 优先做影响面小的改动
- 每个步骤做完后要验证`;

  const systemPrompt = buildSystemPrompt(config.workDir, process.platform || 'darwin');
  const messages: AgentMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: planPrompt },
  ];

  const result = await provider.chatWithTools!(config.model, {
    messages,
    tools: TOOL_DEFINITIONS,
    temperature: 0.3,
    reasoningEffort: 'medium',
    stream: false,
  });

  const text = result.content || '{}';
  // 提取 JSON
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  let parsed: { plan?: string; steps?: PlanStep[] };
  try {
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch {
    parsed = { plan: text.slice(0, 500), steps: [] };
  }

  const steps = (parsed.steps || []).map((s, i) => ({
    step: s.step || i + 1,
    title: s.title || `步骤 ${i + 1}`,
    action: s.action || '',
    tools: s.tools || [],
  }));

  const plan = parsed.plan || '计划: 按步骤执行以下操作';
  emit({ type: 'plan_ready', plan, steps });
  return { plan, steps };
}

/** 阶段3：执行计划 */
async function executePhase(
  goal: string,
  steps: PlanStep[],
  config: AgentConfig,
  emit: (e: PlanEvent) => void,
  provider: Provider,
): Promise<string[]> {
  const results: string[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    emit({ type: 'exec_start', step: step.step, total: steps.length });

    const execPrompt = `你现在要执行计划中的第 ${step.step}/${steps.length} 步。

完整任务: ${goal}
当前步骤: ${step.title}
具体操作: ${step.action}
建议工具: ${step.tools.join(', ') || '自行选择'}

请执行这个步骤，完成后简要报告完成了什么、结果如何。只做这一步，不要做其他步骤的事。`;

    const systemPrompt = buildSystemPrompt(config.workDir, process.platform || 'darwin');
    const messages: AgentMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: execPrompt },
    ];

    const { executeToolCall } = await import('./tools');
    const ctx: ToolContext = { workDir: config.workDir, messages, config };

    let stepResult = '';
    let turns = 0;

    while (turns < 15) {
      turns++;
      const result = await provider.chatWithTools!(config.model, {
        messages,
        tools: TOOL_DEFINITIONS,
        temperature: 0.4,
        reasoningEffort: 'medium',
        stream: false,
      });

      if (result.toolCalls.length === 0) {
        stepResult = result.content || '';
        break;
      }

      messages.push({
        role: 'assistant',
        content: result.content,
        tool_calls: result.toolCalls,
      });

      for (const tc of result.toolCalls) {
        const toolResult = await executeToolCall(tc.function.name, tc.function.arguments, tc.id, ctx);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult.content });
      }
    }

    results.push(stepResult);
    emit({ type: 'exec_done', step: step.step, result: stepResult.slice(0, 500) });
  }

  emit({ type: 'done' });
  return results;
}

/** Plan 模式主入口：探索 → 计划 → 执行 */
export async function runPlanMode(
  goal: string,
  config: AgentConfig,
  onPlanReady: (plan: string, steps: PlanStep[]) => Promise<boolean>, // 返回 true 继续执行，false 取消
  emit: (e: PlanEvent) => void = () => {},
): Promise<{ approved: boolean; results: string[]; plan: string; steps: PlanStep[] }> {
  const provider = getProvider();

  // 阶段 1: 探索
  const context = await explorePhase(goal, config, emit, provider);

  // 阶段 2: 制定计划
  const { plan, steps } = await planPhase(goal, context, config, emit, provider);

  // 等待用户确认
  const approved = await onPlanReady(plan, steps);
  if (!approved) {
    return { approved: false, results: [], plan, steps };
  }

  // 阶段 3: 执行
  const results = await executePhase(goal, steps, config, emit, provider);
  return { approved: true, results, plan, steps };
}
