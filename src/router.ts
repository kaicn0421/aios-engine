// Agent Router(P1:能力画像版)—— 不再硬编码"skill→模型",而是用【能力画像 × 任务需求 − β×成本】算分排序。
// 落地 InferenceDynamics 思路:加模型只需填一张能力卡,路由自动算;β 旋钮调"质量优先 vs 省钱"。
// 能力分初值来自 2026-06-01 三模型横评实测(见《AIOS 核心能力优化计划》),后续由评测常态化自动更新。
import { CONFIG, QWEN, ARK } from './config';
import { qwen, ark, deepseek, isUsable, type Provider } from './providers';
import type { SubTask } from './types';
import { historyBoost } from './routing-memory';

export interface Route { provider: string; model: string; reason: string }

// 路由目标 = provider 实例 + model + 能力画像(各维 0-1)+ 归一化成本(0-1)
interface Target { p: Provider; provider: string; model: string; cap: Record<string, number>; cost: number }
const TARGETS: Target[] = [
  { p: qwen,     provider: 'qwen',     model: QWEN.model,             cap: { 造物: 0.95, 文档: 0.40, 推理: 0.70, 多模态: 0.30 }, cost: 0.2 },
  { p: deepseek, provider: 'deepseek', model: CONFIG.models.default,  cap: { 造物: 0.30, 文档: 0.90, 推理: 0.75, 多模态: 0.20 }, cost: 0.2 }, // V4-flash
  { p: deepseek, provider: 'deepseek', model: CONFIG.models.strong,   cap: { 造物: 0.35, 文档: 0.92, 推理: 0.95, 多模态: 0.20 }, cost: 0.5 }, // V4-pro
  { p: ark,      provider: 'ark',      model: ARK.model,              cap: { 造物: 0.60, 文档: 0.55, 推理: 0.60, 多模态: 0.90 }, cost: 0.5 }, // 豆包
];

// 任务需求向量:每个 skill 需要哪些能力(权重);complexity=deep 时加重推理
const SKILL_NEED: Record<string, Record<string, number>> = {
  code:      { 造物: 1.0, 推理: 0.3 },
  research:  { 文档: 1.0, 推理: 0.3 },
  analysis:  { 文档: 0.5, 推理: 0.9 },
  finance:   { 文档: 0.5, 推理: 0.9 },
  data:      { 文档: 0.7, 推理: 0.6 },
  writing:   { 文档: 1.0 },
  planning:  { 文档: 0.8, 推理: 0.4 },
  deck:      { 文档: 1.0 },
  marketing: { 文档: 1.0 },
};

// 成本惩罚旋钮:大→省钱优先,小→质量优先。BYOK 下可设小、激进偏质量。
const BETA = Number(process.env.AIOS_COST_PENALTY ?? 0.3);
// kNN 历史学习权重:相似历史任务上表现好的模型上浮、差的下压(0=纯画像、关闭学习)
const GAMMA = Number(process.env.AIOS_HISTORY_WEIGHT ?? 0.4);

function need(sub: SubTask): Record<string, number> {
  const base: Record<string, number> = { ...(SKILL_NEED[sub.skill] ?? { 文档: 1.0 }) };
  if (sub.complexity === 'deep') base['推理'] = (base['推理'] ?? 0) + 0.6;
  return base;
}

function score(t: Target, nd: Record<string, number>): number {
  let s = 0;
  for (const dim of Object.keys(nd)) s += (t.cap[dim] ?? 0) * (nd[dim] ?? 0);
  return s - BETA * t.cost;
}

// 按【能力画像 + kNN 历史学习】算分、降序排候选链(只留当前可用的);全不可用则 DeepSeek 兜底
export function routeChain(sub: SubTask): Route[] {
  const nd = need(sub);
  const boost = historyBoost(sub.objective || sub.title || '', sub.skill); // 相似历史任务上各模型的质量
  const ranked = [...TARGETS].map((t) => {
    const key = `${t.provider}:${t.model}`;
    const hb = boost[key]; // 无历史 → undefined
    const adj = hb === undefined ? 0 : GAMMA * (hb - 0.5); // >0.5 上浮、<0.5 下压、无历史不动
    return { t, s: score(t, nd) + adj, learned: hb !== undefined };
  }).sort((a, b) => b.s - a.s);
  const top = ranked[0];
  const learned = ranked.some((x) => x.learned);
  const reason = top ? `画像路由:${top.t.provider}(综合分 ${top.s.toFixed(2)}, β=${BETA}${learned ? ', 含历史学习' : ''})` : '兜底';
  const usable = ranked.filter((x) => isUsable(x.t.p)).map((x) => ({ provider: x.t.provider, model: x.t.model, reason }));
  return usable.length ? usable : [{ provider: 'deepseek', model: CONFIG.models.default, reason: '候选均不可用,兜底' }];
}

// 单选:取候选链首选 —— 向后兼容入口
export function route(sub: SubTask): Route { return routeChain(sub)[0]!; }

// ── Agent 模式专用路由 ──

/** Agent 模式路由：直接选最强可用模型（DeepSeek V4 Pro），不做 cost/skill 评估 */
export function routeAgent(): Route {
  if (isUsable(deepseek)) {
    return { provider: 'deepseek', model: CONFIG.models.strong, reason: 'Agent 模式: DeepSeek V4 Pro (强推理+工具调用)' };
  }
  return { provider: 'qwen', model: QWEN.model, reason: 'Agent 模式: 千问 (DeepSeek 不可用时的备选)' };
}
