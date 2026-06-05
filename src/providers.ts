// Providers —— AIOS 能调度的执行后端。Agent Router 据此跨模型/Agent 分配任务。
// 关键:每个 provider 自报 available;不可用的(没配 key)自动被 Router 跳过 → 永远有 DeepSeek 兜底。
import { llm, CONFIG, ARK, arkClient, QWEN, qwenClient } from './config';

export interface ChatOpts { system: string; user: string; json?: boolean; maxTokens?: number; temperature?: number; }
export interface ProviderMeta { contextLimit: number; costTier: 'low' | 'mid' | 'high'; caps: string[] }
export interface Provider {
  id: string;
  label: string;
  available: boolean;
  meta: ProviderMeta; // 上下文上限/成本档/能力维度 —— 供路由画像与上下文预检
  chat(model: string, o: ChatOpts): Promise<string>;
}

// DeepSeek(OpenAI 兼容,复用全局 client) —— 性价比主力
export const deepseek: Provider = {
  id: 'deepseek', label: 'DeepSeek', available: !!CONFIG.apiKey,
  meta: { contextLimit: 128000, costTier: 'low', caps: ['文档', '调研', '推理', '分析', '写作'] },
  async chat(model, o) {
    const r = await llm.chat.completions.create({
      model,
      messages: [{ role: 'system', content: o.system }, { role: 'user', content: o.user }],
      ...(o.json ? { response_format: { type: 'json_object' as const } } : {}),
      ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
      temperature: o.temperature ?? 0.6,
    });
    return r.choices[0]?.message?.content?.trim() || '';
  },
};

// Claude(Anthropic /v1/messages,用 fetch,按 ANTHROPIC_API_KEY 启用) —— 强推理/代码
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
export const claude: Provider = {
  id: 'claude', label: 'Claude', available: !!ANTHROPIC_KEY,
  meta: { contextLimit: 200000, costTier: 'high', caps: ['推理', '代码'] },
  async chat(model, o) {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: o.maxTokens || 4096,
        system: o.system,
        messages: [{ role: 'user', content: o.user + (o.json ? '\n\n只输出合法 JSON,不要多余文字。' : '') }],
      }),
    });
    if (!resp.ok) throw new Error(`Claude API ${resp.status}`);
    const data = (await resp.json()) as { content?: Array<{ text?: string }> };
    return (data.content?.[0]?.text || '').trim();
  },
};

// 火山方舟(火山引擎 Ark,OpenAI 兼容) —— 一个后端调度豆包/Kimi/GLM/DeepSeek;造物时用其上的强代码模型
export const ark: Provider = {
  id: 'ark', label: '火山方舟', available: !!ARK.apiKey,
  meta: { contextLimit: 256000, costTier: 'mid', caps: ['造物', '多模态', '视觉', '代码'] },
  async chat(model, o) {
    const r = await arkClient.chat.completions.create({
      model: model || ARK.model,
      messages: [{ role: 'system', content: o.system }, { role: 'user', content: o.user }],
      ...(o.json ? { response_format: { type: 'json_object' as const } } : {}),
      ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
      temperature: o.temperature ?? 0.6,
    });
    return r.choices[0]?.message?.content?.trim() || '';
  },
};

// 通义千问(阿里云 DashScope,OpenAI 兼容) —— 代码与通用都强,横评/路由备选
export const qwen: Provider = {
  id: 'qwen', label: '通义千问', available: !!QWEN.apiKey,
  meta: { contextLimit: 256000, costTier: 'low', caps: ['造物', '代码', '前端', '工具'] },
  async chat(model, o) {
    const r = await qwenClient.chat.completions.create({
      model: model || QWEN.model,
      messages: [{ role: 'system', content: o.system }, { role: 'user', content: o.user }],
      ...(o.json ? { response_format: { type: 'json_object' as const } } : {}),
      ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
      temperature: o.temperature ?? 0.6,
    });
    return r.choices[0]?.message?.content?.trim() || '';
  },
};

export const PROVIDERS: Provider[] = [deepseek, ark, qwen, claude];

// 冷却:某后端失败(限流/超时)则暂时跳过,到期自动恢复 —— 支撑动态 fallback,不让一个挂了的模型拖垮整体
const cooldowns = new Map<string, number>();
export function markFailed(id: string, ms = 60000): void { cooldowns.set(id, Date.now() + ms); }
/** 真正可用 = 配了 key 且不在冷却期 */
export function isUsable(p: Provider): boolean {
  if (!p.available) return false;
  const until = cooldowns.get(p.id);
  return !until || Date.now() >= until;
}

/** 取可用的 provider;不可用则永远兜底到 DeepSeek */
export function getProvider(id: string): Provider {
  return PROVIDERS.find((p) => p.id === id && p.available) || deepseek;
}

/** 当前可用的 provider 列表(供日志/展示) */
export function availableProviders(): string[] {
  return PROVIDERS.filter((p) => p.available).map((p) => p.label);
}
