// Trace —— Agent 运行日志与故障回溯系统。
// 每次 Agent 运行记录完整 trace：每轮对话、每个工具调用、耗时、成功/失败。
// 出错时能回溯到具体哪一步出了问题。

import { appendFileSync, mkdirSync, existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolCall, AgentMessage } from './types';

export interface ToolTrace {
  turn: number;
  index: number; // 本轮中第几个工具调用
  name: string;
  args: string;
  ok: boolean;
  duration_ms: number;
  summary: string; // 前 200 字结果摘要
}

export interface TurnTrace {
  n: number;
  llm_ms: number;
  input_tokens_est: number;
  toolCalls: ToolTrace[];
}

export interface AgentTrace {
  run_id: string;
  started_at: string;
  goal: string;
  work_dir: string;
  model: string;
  turns: TurnTrace[];
  final: {
    ok: boolean;
    turns: number;
    total_tool_calls: number;
    total_ms: number;
    error?: string;
  };
}

const TRACE_DIR = () => join(process.cwd(), '.aios-traces');

function ensureDir(): void {
  if (!existsSync(TRACE_DIR())) mkdirSync(TRACE_DIR(), { recursive: true });
}

function runId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  return `agent-${ts}-${rand}`;
}

/** 创建新的 Agent 运行 trace */
export function createTrace(goal: string, workDir: string, model: string): AgentTrace {
  ensureDir();
  return {
    run_id: runId(),
    started_at: new Date().toISOString(),
    goal: goal.slice(0, 200),
    work_dir: workDir,
    model,
    turns: [],
    final: { ok: false, turns: 0, total_tool_calls: 0, total_ms: 0 },
  };
}

/** 记录一轮 LLM 调用 */
export function traceTurn(
  t: AgentTrace,
  n: number,
  llmMs: number,
  inputTokensEst: number,
): TurnTrace {
  const turn: TurnTrace = { n, llm_ms: llmMs, input_tokens_est: inputTokensEst, toolCalls: [] };
  t.turns.push(turn);
  return turn;
}

/** 记录一个工具调用 */
export function traceTool(
  turn: TurnTrace,
  index: number,
  call: ToolCall,
  ok: boolean,
  ms: number,
  resultContent: string,
): void {
  turn.toolCalls.push({
    turn: turn.n,
    index,
    name: call.function.name,
    args: call.function.arguments.slice(0, 300),
    ok,
    duration_ms: ms,
    summary: resultContent.slice(0, 200).replace(/\n/g, ' '),
  });
}

/** 完成 trace 并写入磁盘 */
export function traceFinalize(
  t: AgentTrace,
  ok: boolean,
  turns: number,
  totalToolCalls: number,
  totalMs: number,
  error?: string,
): string {
  t.final = { ok, turns, total_tool_calls: totalToolCalls, total_ms: totalMs, error };
  const file = join(TRACE_DIR(), `${t.run_id}.json`);
  writeFileSync(file, JSON.stringify(t, null, 2), 'utf8');
  return file;
}

// ── 工具成功率统计 ──

interface ToolStats {
  total: number;
  ok: number;
  lastErrors: string[]; // 最近 5 个错误
}

const statsStore = new Map<string, ToolStats>();
let statsSaveCounter = 0;
const STATS_FILE = () => join(TRACE_DIR(), 'tool-stats.json');

/** 从磁盘加载历史统计 */
function loadToolStats(): void {
  try {
    if (!existsSync(STATS_FILE())) return;
    const raw = readFileSync(STATS_FILE(), 'utf8');
    const data = JSON.parse(raw) as Record<string, { total: number; ok: number; lastErrors: string[] }>;
    for (const [name, s] of Object.entries(data)) {
      statsStore.set(name, { total: s.total, ok: s.ok, lastErrors: s.lastErrors || [] });
    }
  } catch {
    // 文件损坏或不存在，忽略
  }
}

/** 保存统计到磁盘 */
function saveToolStats(): void {
  ensureDir();
  try {
    const data: Record<string, { total: number; ok: number; lastErrors: string[] }> = {};
    for (const [name, s] of statsStore.entries()) {
      data[name] = { total: s.total, ok: s.ok, lastErrors: s.lastErrors };
    }
    writeFileSync(STATS_FILE(), JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // 写入失败不阻塞
  }
}

/** 清空所有统计 */
export function statsReset(): void {
  statsStore.clear();
  statsSaveCounter = 0;
  try { if (existsSync(STATS_FILE())) writeFileSync(STATS_FILE(), '{}', 'utf8'); } catch { /* ok */ }
}

// 启动时自动加载
loadToolStats();

/** 记录一次工具调用结果 */
export function recordToolStats(name: string, ok: boolean, error?: string): void {
  let s = statsStore.get(name);
  if (!s) {
    s = { total: 0, ok: 0, lastErrors: [] };
    statsStore.set(name, s);
  }
  s.total++;
  if (ok) s.ok++;
  else if (error) {
    s.lastErrors.push(error.slice(0, 100));
    if (s.lastErrors.length > 5) s.lastErrors.shift();
  }
  // 每 10 次调用自动存盘
  statsSaveCounter++;
  if (statsSaveCounter % 10 === 0) saveToolStats();
}

/** 获取工具成功率报告 */
export function toolStatsReport(): string {
  if (statsStore.size === 0) return '暂无工具调用统计';
  const lines: string[] = [];
  for (const [name, s] of [...statsStore.entries()].sort((a, b) => b[1].total - a[1].total)) {
    const rate = s.total > 0 ? ((s.ok / s.total) * 100).toFixed(0) : '--';
    const icon = Number(rate) >= 90 ? '✅' : Number(rate) >= 70 ? '⚠️' : '🔴';
    lines.push(`${icon} ${name}: ${s.ok}/${s.total} (${rate}%)`);
    if (s.lastErrors.length) {
      lines.push(`   最近错误: ${s.lastErrors.slice(-2).join(' | ')}`);
    }
  }
  return lines.join('\n');
}

/** 获取持续失败的工具告警 */
export function toolAlerts(): string[] {
  const alerts: string[] = [];
  for (const [name, s] of statsStore.entries()) {
    if (s.total >= 3 && s.ok / s.total < 0.5) {
      alerts.push(`${name} 成功率仅 ${((s.ok / s.total) * 100).toFixed(0)}%，需排查`);
    }
  }
  return alerts;
}

// ── 崩溃恢复：Checkpoint ──────────────────────────────────

export interface AgentCheckpoint {
  run_id: string;
  saved_at: string;
  goal: string;
  work_dir: string;
  turn: number;
  total_tool_calls: number;
  last_good_text_snippet: string; // 前 500 字符
  can_resume: boolean;
}

/** 保存中间状态到磁盘 */
export function saveCheckpoint(
  runId: string,
  goal: string,
  workDir: string,
  turn: number,
  totalToolCalls: number,
  lastGoodText: string,
): string {
  ensureDir();
  const cp: AgentCheckpoint = {
    run_id: runId,
    saved_at: new Date().toISOString(),
    goal: goal.slice(0, 200),
    work_dir: workDir,
    turn,
    total_tool_calls: totalToolCalls,
    last_good_text_snippet: lastGoodText.slice(0, 500),
    can_resume: true,
  };
  const file = join(TRACE_DIR(), `${runId}-checkpoint.json`);
  writeFileSync(file, JSON.stringify(cp, null, 2), 'utf8');
  return file;
}

/** 列出所有未完成的 run（有 checkpoint 但没有对应完成的 trace） */
export function listIncompleteRuns(): AgentCheckpoint[] {
  ensureDir();
  try {
    const entries = readdirSync(TRACE_DIR());
    const checkpoints: AgentCheckpoint[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('-checkpoint.json')) continue;
      const runId = entry.replace('-checkpoint.json', '');
      // 检查是否有对应的完成 trace
      const traceFile = join(TRACE_DIR(), `${runId}.json`);
      if (existsSync(traceFile)) continue; // 已完成，跳过
      try {
        const raw = readFileSync(join(TRACE_DIR(), entry), 'utf8');
        const cp = JSON.parse(raw) as AgentCheckpoint;
        if (cp.can_resume) checkpoints.push(cp);
      } catch {
        // 损坏的 checkpoint，跳过
      }
    }
    return checkpoints.sort((a, b) => b.saved_at.localeCompare(a.saved_at));
  } catch {
    return [];
  }
}

/** 标记 checkpoint 为已处理（不可恢复） */
export function markCheckpointResolved(runId: string): void {
  ensureDir();
  const file = join(TRACE_DIR(), `${runId}-checkpoint.json`);
  if (existsSync(file)) {
    try {
      const raw = readFileSync(file, 'utf8');
      const cp = JSON.parse(raw) as AgentCheckpoint;
      cp.can_resume = false;
      writeFileSync(file, JSON.stringify(cp, null, 2), 'utf8');
    } catch {
      // 忽略写入错误
    }
  }
}
