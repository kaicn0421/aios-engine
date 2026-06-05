// Memory —— 长期记忆。跑前召回(偏好+历史)注入 Brain,跑后提炼新偏好+记录任务。
// 让 AIOS 越用越懂这个用户,而非每次从零。存在 memory.json。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { llm, CONFIG } from './config';

interface MemStore {
  facts: string[];                                       // 提炼的长期偏好/事实
  history: Array<{ goal: string; kind: string; time: number }>; // 任务历史
}

const FILE = () => join(process.cwd(), 'memory.json');

function load(): MemStore {
  try {
    const m = JSON.parse(readFileSync(FILE(), 'utf8'));
    return { facts: Array.isArray(m.facts) ? m.facts : [], history: Array.isArray(m.history) ? m.history : [] };
  } catch {
    return { facts: [], history: [] };
  }
}

function save(m: MemStore): void {
  try { writeFileSync(FILE(), JSON.stringify(m, null, 2), 'utf8'); } catch { /* 记忆失败不影响主流程 */ }
}

/** 跑前召回:拼成注入 Brain 的记忆上下文(偏好 + 最近任务) */
export function recall(): string {
  const m = load();
  if (!m.facts.length && !m.history.length) return '';
  const facts = m.facts.length ? `已知偏好/事实:\n${m.facts.map((f) => '- ' + f).join('\n')}` : '';
  const recent = m.history.slice(-5);
  const hist = recent.length ? `\n最近做过:\n${recent.map((h) => '- ' + h.goal).join('\n')}` : '';
  return (facts + hist).trim();
}

/** 跑后记忆:记录任务历史 + 用轻量 LLM 提炼可复用的长期偏好 */
export async function remember(goal: string, kind: string): Promise<void> {
  const m = load();
  m.history.push({ goal, kind, time: Date.now() });
  try {
    const resp = await llm.chat.completions.create({
      model: CONFIG.models.default,
      messages: [
        {
          role: 'system',
          content:
            '从用户这次需求里提炼值得【长期记住的稳定偏好或事实】(如所在地、行业、常用格式/标准、风格倾向、身份)。' +
            '只提炼明确、可跨任务复用的;一次性细节不要,已知的不要重复。只输出 JSON:{"facts":["..."]},没有就空数组。',
        },
        { role: 'user', content: `本次需求:${goal}\n\n已知事实:${m.facts.join('；') || '无'}` },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });
    const p = JSON.parse(resp.choices[0]?.message?.content || '{}') as { facts?: unknown };
    const fresh = Array.isArray(p.facts) ? p.facts.map((x) => String(x)).filter(Boolean) : [];
    fresh.forEach((f) => { if (!m.facts.includes(f)) m.facts.push(f); });
  } catch { /* 提炼失败仍记录历史 */ }
  if (m.facts.length > 40) m.facts = m.facts.slice(-40);
  if (m.history.length > 50) m.history = m.history.slice(-50);
  save(m);
}
