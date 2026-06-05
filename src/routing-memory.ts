// kNN 自学习路由记忆 —— 记录每次执行的客观质量,路由时检索相似历史给候选模型打分加权。
// 越用越准:冷启动靠 P1 能力画像,积累历史后用"相似任务上谁表现好"微调排序。
// 用文本 token 相似度(Jaccard)做 kNN,不依赖 embedding API —— 零额外延迟/成本。
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

interface HistRecord { text: string; skill: string; model: string; q: number } // q:客观质量 0-1
const FILE = join(process.cwd(), 'routing-history.jsonl');

/** 记录一次执行结果(model 用 "provider:model" 作 key,q 为客观质量) */
export function recordOutcome(text: string, skill: string, model: string, q: number): void {
  try {
    appendFileSync(FILE, JSON.stringify({ text: (text || '').slice(0, 200), skill, model, q }) + '\n');
  } catch { /* 记录失败不影响主流程 */ }
}

// 文本相似度:中文/英数 token 的 Jaccard 交并比
function sim(a: string, b: string): number {
  const tok = (s: string) => new Set((s || '').toLowerCase().match(/[一-龥]|[a-z0-9]+/g) || []);
  const ta = tok(a);
  const tb = tok(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** 检索同 skill、最相似的 top-k 历史,返回每个模型的"相似度加权平均质量"(0-1)。无历史返回空 */
export function historyBoost(text: string, skill: string, k = 20): Record<string, number> {
  if (!existsSync(FILE)) return {};
  let recs: HistRecord[] = [];
  try {
    recs = readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as HistRecord; } catch { return null; } })
      .filter((r): r is HistRecord => !!r && r.skill === skill);
  } catch { return {}; }
  const top = recs.map((r) => ({ r, s: sim(text, r.text) })).sort((a, b) => b.s - a.s).slice(0, k);
  const agg: Record<string, { ws: number; wq: number }> = {};
  for (const { r, s } of top) {
    const w = s + 0.01; // 加平滑,避免相似度全 0 时除零
    (agg[r.model] ||= { ws: 0, wq: 0 }).ws += w;
    agg[r.model]!.wq += w * r.q;
  }
  const boost: Record<string, number> = {};
  for (const m of Object.keys(agg)) boost[m] = agg[m]!.wq / agg[m]!.ws;
  return boost;
}
