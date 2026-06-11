import OpenAI from 'openai';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 零依赖 .env 加载(替代 dotenv)。
 *  dotenv 是 CJS,被 esbuild 打成单文件 ESM bundle 后曾两次在打包产物里崩:
 *  ERR_MODULE_NOT_FOUND(06-08)+ Dynamic require not supported(06-09)。
 *  行为对齐 dotenv 默认:读 cwd 下 .env、KEY=VALUE、跳过注释/空行、
 *  不覆盖已存在的环境变量、去首尾引号、双引号内展开 \n;文件不存在则静默跳过。 */
function loadDotEnv(): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !m[1]) continue;
    const key = m[1];
    let value = (m[2] ?? '').trim();
    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    } else if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf('#');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

export const CONFIG = {
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  models: {
    // DeepSeek 官方 V4:pro 强推理(Agent 主力),flash 便宜快(文档管线备选)
    default: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
    strong: process.env.DEEPSEEK_STRONG_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
    flash: process.env.DEEPSEEK_FLASH_MODEL || 'deepseek-v4-flash',
  },
  // Agent 模式配置
  agent: {
    maxTurns: Number(process.env.AIOS_AGENT_MAX_TURNS || '50'),
    temperature: Number(process.env.AIOS_AGENT_TEMPERATURE || '0.4'),
    contextLimit: Number(process.env.AIOS_AGENT_CONTEXT_LIMIT || '120000'),
    /** 推理深度: low | medium | high。开启后模型会先思考再行动 */
    reasoningEffort: (process.env.AIOS_REASONING_EFFORT || 'medium') as 'low' | 'medium' | 'high',
    /** 单次 Agent 运行最长时间（毫秒），0 = 不限。超时优雅退出，保留已产出文字 */
    maxTimeMs: Number(process.env.AIOS_AGENT_MAX_TIME_MS || '0'),
  },
} as const;

export function assertKey(): void {
  if (!CONFIG.apiKey) {
    console.error(
      '\n[AIOS] 缺少 DEEPSEEK_API_KEY。\n' +
      '  在 aios-engine/.env 里写一行:\n' +
      '    DEEPSEEK_API_KEY=sk-你的key\n'
    );
    process.exit(1);
  }
}

/** 全局 LLM 客户端(DeepSeek 兼容 OpenAI 接口) */
export const llm = new OpenAI({ apiKey: CONFIG.apiKey || 'sk-missing-key', baseURL: CONFIG.baseURL });

/** 火山方舟(火山引擎 Ark,OpenAI 兼容) —— 一个 key 调豆包/Kimi/GLM/DeepSeek 全家。按 ARK_API_KEY 启用,没配则 Router 自动跳过、兜底 DeepSeek。
 *  ARK_MODEL 填你在方舟开通的模型 ID 或接入点 ep-xxx;代码任务建议开通强代码模型(doubao-seed-2.0-code / kimi-k2.5 / glm-4.7) */
export const ARK = {
  apiKey: process.env.ARK_API_KEY || '',
  baseURL: process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
  model: process.env.ARK_MODEL || 'doubao-seed-1-6-251015',
};
export const arkClient = new OpenAI({ apiKey: ARK.apiKey || 'sk-missing-key', baseURL: ARK.baseURL });

/** 通义千问(阿里云 DashScope,OpenAI 兼容) —— 代码/通用都强,按 DASHSCOPE_API_KEY 启用;没配则 Router 自动跳过 */
export const QWEN = {
  apiKey: process.env.DASHSCOPE_API_KEY || '',
  baseURL: process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: process.env.QWEN_MODEL || 'qwen3-coder-plus',
};
export const qwenClient = new OpenAI({ apiKey: QWEN.apiKey || 'sk-missing-key', baseURL: QWEN.baseURL });
