// Context —— Agent 上下文管理与 token 估算。
// 负责在接近上下文上限时智能裁剪消息历史，保护关键信息不丢失。

import type { AgentMessage, ToolCall } from './types';

/** 粗略估算 token 数（DeepSeek 中文约 1.5 字符/token，英文约 4 字符/token，代码约 3 字符/token） */
export function estimateTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTextTokens(msg.content);
    }
    // tool_calls 序列化后的 token
    if ('tool_calls' in msg && msg.tool_calls) {
      total += estimateTextTokens(JSON.stringify(msg.tool_calls));
    }
    // role 开销
    total += 4;
  }
  // 加一些工具定义和系统开销
  total += 500;
  return Math.ceil(total);
}

function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let chars = 0;
  let cjk = 0;
  let code = 0;
  for (const ch of text) {
    chars++;
    if (/[一-鿿　-〿＀-￯]/.test(ch)) {
      cjk++;
    } else if (/[{}[\]();:<>|&$@#!%^*/\\=+\-~`'".,]/.test(ch)) {
      code++;
    }
  }
  // 中文字符约 2 char/token,英文/代码约 3.5 char/token,混合取平均
  const cjkTokens = cjk / 1.5;
  const otherTokens = (chars - cjk) / 3.5;
  return Math.ceil(cjkTokens + otherTokens);
}

/** 智能裁剪消息历史，在接近上下文限制时保护关键信息 */
export function compactHistory(
  messages: AgentMessage[],
  contextLimit: number,
): AgentMessage[] {
  // 保留系统提示词（第一条）
  const systemMsg = messages[0];
  const rest = messages.slice(1);

  // 如果消息不多，不做裁剪
  if (rest.length <= 6) return messages;

  const result: AgentMessage[] = [systemMsg!];

  // 策略：保留最近 8 轮完整对话 + 更早轮次的摘要
  const keepRecent = 8; // 保留最近 8 条消息
  const recentStart = Math.max(0, rest.length - keepRecent);

  if (recentStart > 2) {
    // 对早期消息生成摘要
    const earlyMessages = rest.slice(1, recentStart); // 跳过用户首条消息
    const earlyTokens = estimateTokens(earlyMessages);
    if (earlyTokens > 2000) {
      result.push({
        role: 'user',
        content: `[上下文摘要] 前 ${recentStart - 1} 轮对话涵盖了任务初始探索、文件分析和工具调用。关键发现已被保留在最近的消息中。`,
      });
    } else {
      result.push(...earlyMessages);
    }
  } else {
    // 没那么多消息，都保留
    result.push(...rest.slice(1, recentStart));
  }

  // 保留最近的消息
  result.push(...rest.slice(recentStart));

  return result;
}

/** 为工具输出做截断（保留关键信息） */
export function truncateToolOutput(output: string, maxLen: number = 20000): string {
  if (output.length <= maxLen) return output;

  const head = output.slice(0, Math.floor(maxLen * 0.6));
  const tail = output.slice(-Math.floor(maxLen * 0.4));
  return (
    head +
    `\n\n... [中间 ${output.length - maxLen} 字符已省略] ...\n\n` +
    tail
  );
}

/** 工具连续失败计数与策略提示 */
export interface FailureTracker {
  failures: Map<string, number>;
  consecutiveFailures: number;
}

export function createFailureTracker(): FailureTracker {
  return { failures: new Map(), consecutiveFailures: 0 };
}

export function recordFailure(tracker: FailureTracker, toolName: string): string | null {
  tracker.consecutiveFailures++;
  const count = (tracker.failures.get(toolName) || 0) + 1;
  tracker.failures.set(toolName, count);

  if (count >= 3) {
    return `工具 "${toolName}" 已连续失败 ${count} 次。建议：检查工具参数是否正确、改用其他方式获取信息、或向用户说明遇到的困难。`;
  }
  if (tracker.consecutiveFailures >= 5) {
    return `已连续 ${tracker.consecutiveFailures} 次工具调用失败。建议：整理已有信息向用户报告进展，说明哪些操作遇到了问题。`;
  }
  return null;
}

export function resetConsecutiveFailures(tracker: FailureTracker): void {
  tracker.consecutiveFailures = 0;
}
