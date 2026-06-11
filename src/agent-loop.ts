// Agent Loop —— AIOS 类 Claude Code 多轮 Agent 循环（稳定性增强版）。
// 新增：完整 trace 日志、崩溃恢复、工具成功率统计、智能自我修正。

import { CONFIG } from './config';
import { deepseek, isUsable, markFailed, type Provider } from './providers';
import { TOOL_DEFINITIONS, executeToolCall, type ToolContext, getEffectiveToolDefinitions } from './tools';
import { buildSystemPrompt } from './system-prompt';
import { estimateTokens, compactHistory, createFailureTracker, recordFailure, resetConsecutiveFailures } from './context';
import { createTrace, traceTurn, traceTool, traceFinalize, recordToolStats, toolStatsReport, saveCheckpoint, markCheckpointResolved } from './trace';
import type { AgentMessage, ToolCall, AgentRunResult, AgentEventSink, AgentConfig } from './types';

/** 默认 Agent 配置 */
export function defaultAgentConfig(workDir?: string): AgentConfig {
  return {
    model: CONFIG.models.strong,
    maxTurns: CONFIG.agent.maxTurns,
    temperature: CONFIG.agent.temperature,
    contextLimit: CONFIG.agent.contextLimit,
    workDir: workDir || process.cwd(),
    maxTimeMs: CONFIG.agent.maxTimeMs || undefined,
  };
}

function getAgentProvider(): Provider {
  if (isUsable(deepseek)) return deepseek;
  throw new Error('没有可用的 Agent Provider，请检查 DEEPSEEK_API_KEY 配置');
}

/** 任务复杂度评估 → 模型选择。
 *  简单任务用 flash（快/便宜），复杂任务用 pro（准/强推理）。*/
function selectModel(task: string, config: AgentConfig): string {
  // 用户显式指定 → 优先
  if (config.model !== CONFIG.models.strong) return config.model;

  // 启发式复杂度判断
  const len = task.length;
  const hasComplex = /修复|重构|实现|构建|审查|分析|设计|迁移|优化|排查|debug|refactor|implement|build|review|analyze|design|migrate|optimize|investigate/i.test(task);
  const hasCode = /(?:\.ts|\.js|\.rs|\.py|\.go|\.java|代码|函数|模块|组件|接口|类型|编译|构建|打包|部署)/.test(task);
  const isSimple = /^(?:ls|list|show|read|cat|查看|列出|显示|读|pwd|whoami|date|echo)\b/i.test(task.trim());

  // 简单命令 → flash
  if (isSimple && len < 100) return CONFIG.models.flash;

  // 短问题且不涉及代码/复杂操作 → flash
  if (len < 60 && !hasComplex && !hasCode) return CONFIG.models.flash;

  // 中等复杂度：有代码但不复杂 → 根据长度判断
  if (hasCode && !hasComplex && len < 200) return CONFIG.models.flash;

  // 其余 → pro
  return CONFIG.models.strong;
}

/** 判断工具结果是否成功 */
function isToolOk(resultContent: string): boolean {
  return (
    !resultContent.startsWith('工具执行异常') &&
    !resultContent.startsWith('未知工具') &&
    !resultContent.startsWith('工具参数解析失败') &&
    !resultContent.startsWith('安全阻止') &&
    !resultContent.startsWith('安全限制')
  );
}

/** 生成工具失败时的自我修正提示 */
function selfCorrectionHint(toolName: string, resultContent: string): string | null {
  if (resultContent.includes('未找到匹配') || resultContent.includes('不存在') || resultContent.includes('ENOENT')) {
    return `${toolName} 失败：文件或内容未找到。请检查路径是否正确，或先用 glob/grep 确认文件位置。`;
  }
  if (resultContent.includes('安全阻止') || resultContent.includes('安全限制')) {
    return `${toolName} 被安全机制阻止。请换一种更安全的方式完成操作。`;
  }
  if (resultContent.includes('超时') || resultContent.includes('timeout')) {
    return `${toolName} 超时。请尝试缩小范围（限制文件数量、搜索范围），或分步执行。`;
  }
  if (resultContent.includes('参数解析失败')) {
    return `${toolName} 参数格式错误。请检查 JSON 参数是否正确，特别注意字符串中的引号和换行符需要转义。`;
  }
  return null;
}

/** 主 Agent 循环 */
export async function runAgent(
  userMessage: string,
  emit: AgentEventSink = () => {},
  config: AgentConfig = defaultAgentConfig(),
): Promise<AgentRunResult> {
  const t0 = Date.now();
  const deadline = config.maxTimeMs && config.maxTimeMs > 0 ? t0 + config.maxTimeMs : Infinity;
  // 智能模型路由：简单任务用 flash，复杂任务用 pro
  const effectiveModel = selectModel(userMessage, config);
  if (effectiveModel !== config.model) {
    emit({ type: 'tool_done', name: 'model_router', ok: true, summary: `使用 ${effectiveModel.replace('deepseek-', '')}` });
  }
  // 初始化 MCP 工具
  const { ensureMCPTools } = await import('./tools');
  await ensureMCPTools();
  const effectiveTools = getEffectiveToolDefinitions();
  const systemPrompt = buildSystemPrompt(config.workDir, process.platform || 'darwin', userMessage);

  // 初始化 trace
  const trace = createTrace(userMessage, config.workDir, effectiveModel);

  const ctx: ToolContext = {
    workDir: config.workDir,
    messages: [],
    config,
  };

  const messages: AgentMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];
  ctx.messages = messages;

  let totalToolCalls = 0;
  let lastGoodText = ''; // 崩溃恢复：保留最后一次有效的助手文本
  let lastHeartbeatMs = t0;
  const tracker = createFailureTracker();
  const provider = getAgentProvider();

  let turn = 0;
  let finalError: string | undefined;

  try {
    while (turn < config.maxTurns) {
      // 检查整体超时（优雅退出，保留 lastGoodText）
      const elapsed = Date.now() - t0;
      if (Date.now() > deadline) {
        emit({ type: 'error', message: `Agent 运行超时（已运行 ${Math.round(elapsed / 1000)}s），已保留中间结果` });
        finalError = `超时退出：已运行 ${Math.round(elapsed / 1000)} 秒，${turn} 轮，${totalToolCalls} 次工具调用。已产出 ${lastGoodText.length} 字符的中间结果。`;
        break;
      }
      turn++;
      emit({ type: 'turn', n: turn });

      // 上下文检查
      const estTokens = estimateTokens(messages);
      traceTurn(trace, turn, 0, estTokens);
      if (estTokens > config.contextLimit * 0.85) {
        const before = messages.length;
        const compacted = compactHistory(messages, config.contextLimit);
        messages.length = 0;
        messages.push(...compacted);
        emit({
          type: 'tool_done',
          name: 'context_compact',
          ok: true,
          summary: `上下文裁剪: ${before} → ${messages.length} 条消息`,
        });
      }

      let content: string | null = null;
      let toolCalls: ToolCall[] = [];
      const llmT0 = Date.now();
      let hadThinking = false;

      try {
        let streamedText = '';
        const result = await provider.chatWithTools!(effectiveModel, {
          messages,
          tools: effectiveTools,
          temperature: config.temperature,
          reasoningEffort: CONFIG.agent.reasoningEffort, // ← Thinking 模式
          stream: true,
          onThinking: (thinking) => {
            if (!hadThinking) {
              hadThinking = true;
              emit({ type: 'thinking', content: '' }); // 信号：开始思考
            }
            emit({ type: 'thinking', content: thinking });
          },
          onText: (text) => {
            streamedText += text;
            emit({ type: 'text', content: text });
          },
          onToolCall: (tc) => {
            toolCalls.push(tc);
          },
        });
        content = result.content || streamedText;
        if (result.toolCalls.length > 0) toolCalls = result.toolCalls;
        const llmMs = Date.now() - llmT0;

        // 更新当前轮 trace
        const turnTrace = trace.turns[trace.turns.length - 1]!;
        turnTrace.llm_ms = llmMs;
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        markFailed(provider.id, 30000);
        emit({ type: 'error', message: `模型调用失败: ${errorMsg}` });

        if (turn <= 2) {
          emit({ type: 'tool_done', name: 'model_fallback', ok: true, summary: '降级到 flash 模型重试' });
          try {
            const fb = await provider.chatWithTools!(CONFIG.models.flash, {
              messages,
              tools: effectiveTools,
              temperature: config.temperature,
              stream: false,
            });
            content = fb.content;
            toolCalls = fb.toolCalls;
          } catch {
            finalError = `模型调用失败（含 fallback）: ${errorMsg}`;
            break;
          }
        } else {
          finalError = `模型调用失败: ${errorMsg}`;
          break;
        }
      }

      // 保存有效文本用于崩溃恢复
      if (content && content.trim().length > 10) lastGoodText = content;

      // 没有工具调用 → 任务完成门控
      if (!toolCalls.length) {
        const textLen = (content || '').trim().length;
        const endsAbruptly = /(?:正在|继续|接下来|然后|最后|下一步|未完|to be continued|continuing|\.{2,})$/.test((content || '').trim());

        // 门控 1: 回复过短且轮次较少 → 可能是截断，提示继续
        if (textLen < 10 && turn <= 2) {
          messages.push({ role: 'user', content: '(回复被截断，请继续完成你的分析和回答)' });
          continue;
        }

        // 门控 2: 回复结尾不完整（"正在..."、"接下来..."）→ 提示继续
        if (endsAbruptly && turn <= 10) {
          messages.push({ role: 'user', content: '(你的回复似乎还未完成，请继续做完剩下部分)' });
          emit({ type: 'tool_done', name: 'completion_gate', ok: true, summary: '检测到未完成，提示继续' });
          continue;
        }

        // 门控 3: 回复很短（< 50 字）且工具调用过 → 可能在回避任务
        if (textLen < 50 && totalToolCalls > 0 && turn <= 3) {
          messages.push({ role: 'user', content: '请检查是否已完成全部操作。如果还有未完成的工作请继续，如果已完成请明确告知。' });
          emit({ type: 'tool_done', name: 'completion_gate', ok: true, summary: '短回复门控，要求确认完成' });
          continue;
        }

        break;
      }

      // 添加助手消息
      messages.push({
        role: 'assistant',
        content: content,
        tool_calls: toolCalls,
      });

      // 执行工具调用
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]!;
        const toolName = tc.function.name;
        emit({
          type: 'tool_start',
          name: toolName,
          args: tc.function.arguments.slice(0, 200),
        });

        const toolT0 = Date.now();
        const result = await executeToolCall(toolName, tc.function.arguments, tc.id, ctx);
        const toolMs = Date.now() - toolT0;
        totalToolCalls++;

        const ok = isToolOk(result.content);
        recordToolStats(toolName, ok, ok ? undefined : result.content.slice(0, 100));

        // Trace 记录
        const curTurn = trace.turns[trace.turns.length - 1]!;
        traceTool(curTurn, i, tc, ok, toolMs, result.content);

        emit({
          type: 'tool_done',
          name: toolName,
          ok,
          summary: result.content.slice(0, 150).replace(/\n/g, ' '),
        });

        // ── 处理工具执行结果 ──
        if (ok) {
          resetConsecutiveFailures(tracker);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result.content });
        } else {
          // 先 push 失败结果
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result.content });

          const hint = selfCorrectionHint(toolName, result.content);
          if (hint) {
            // 添加修正提示（下一轮 LLM 会看到）
            messages.push({
              role: 'user',
              content: `[自我修正] ${toolName} 失败: ${hint}\n请修正参数后重新调用 ${toolName}，只返回修正后的工具调用，不要解释。`,
            });
            emit({ type: 'tool_done', name: 'self_correct', ok: true, summary: `🔧 ${hint.slice(0, 80)}` });

            // ── 即时 LLM 重试（同一轮内，不占 turn）──
            try {
              const retryResp = await provider.chatWithTools!(effectiveModel, {
                messages,
                tools: effectiveTools,
                temperature: 0.1,       // 低温度 = 精确修正
                stream: false,          // 非流式 = 快速
              });
              const correctedCall = retryResp.toolCalls[0];
              if (correctedCall && correctedCall.function.name === toolName) {
                const retryResult = await executeToolCall(correctedCall.function.name, correctedCall.function.arguments, correctedCall.id, ctx);
                totalToolCalls++;
                const retryOk = isToolOk(retryResult.content);
                recordToolStats(toolName, retryOk, retryOk ? undefined : retryResult.content.slice(0, 100));
                if (retryOk) {
                  // 修正成功！替换掉失败记录
                  resetConsecutiveFailures(tracker);
                  messages.pop(); // 移除修正提示
                  messages.pop(); // 移除失败结果
                  messages.push(
                    { role: 'assistant', content: null, tool_calls: [correctedCall] },
                    { role: 'tool', tool_call_id: correctedCall.id, content: retryResult.content },
                  );
                  emit({ type: 'tool_done', name: toolName, ok: true, summary: '✅ 自我修正成功' });
                }
                // 修正失败 → 提示留在 messages 里，下一轮 LLM 看到后继续尝试
              }
            } catch { /* LLM 重试异常不阻塞 */ }
          }
          // 持续失败告警（通过事件而非 console.error）
          const failHint = recordFailure(tracker, toolName);
          if (failHint) {
            emit({ type: 'error', message: failHint });
          }
        }
      }

      // 心跳：每 3 轮或每 30 秒发送一次进度
      const nowMs = Date.now();
      if (turn % 3 === 0 || nowMs - lastHeartbeatMs > 30000) {
        lastHeartbeatMs = nowMs;
        const snippet = lastGoodText ? lastGoodText.slice(0, 80) : undefined;
        emit({ type: 'heartbeat', turn, toolCalls: totalToolCalls, elapsedMs: nowMs - t0, lastTextSnippet: snippet });
      }

      // 每轮完成后保存 checkpoint（崩溃恢复）
      if (lastGoodText && lastGoodText.length > 10) {
        saveCheckpoint(trace.run_id, userMessage, config.workDir, turn, totalToolCalls, lastGoodText);
      }
    }
  } catch (crash) {
    // 崩溃恢复：保留已生成的内容
    finalError = `Agent 崩溃: ${crash instanceof Error ? crash.message : String(crash)}`;
    emit({ type: 'error', message: finalError });
    console.error(`[AIOS Agent] 崩溃恢复: ${finalError}`);
  }

  // 收集最终文本
  const finalText = lastGoodText || collectFinalText(messages);

  // 完成 trace
  const traceFile = traceFinalize(trace, !finalError, turn, totalToolCalls, Date.now() - t0, finalError);

  // 标记 checkpoint 为已处理（不再提示恢复）
  markCheckpointResolved(trace.run_id);

  // 每 5 次运行输出统计报告
  if (totalToolCalls > 0 && Math.random() < 0.2) {
    console.error(`[AIOS Agent] 工具统计:\n${toolStatsReport()}`);
  }

  return {
    text: finalText,
    turns: turn,
    toolCalls: totalToolCalls,
    ms: Date.now() - t0,
    error: finalError,
  };
}

function collectFinalText(messages: AgentMessage[]): string {
  const parts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim()) {
      parts.unshift(msg.content.trim());
    }
  }
  return parts.join('\n\n') || '(Agent 未生成文本回复)';
}
