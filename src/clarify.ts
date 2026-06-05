// Clarify —— 需求澄清。指令宽泛时,问到刀刃上的几个关键问题(各带合理默认);明确则放行。
import { llm, CONFIG } from './config';

export interface ClarifyQuestion {
  q: string;          // 问题
  why: string;        // 为什么需要问
  suggestion: string; // 合理默认值(用户不答也能用)
}
export interface ClarifyResult {
  clear: boolean;             // 是否已足够明确、可直接产出
  questions: ClarifyQuestion[];
}

export async function clarify(goal: string): Promise<ClarifyResult> {
  const system =
`你是 AIOS 的需求澄清助手。判断用户这句话目标是否需要澄清。

【最优先】用户若是想【即时做件事或要个直接答案】——听歌/看视频/打开网页/查一个具体事实/简单问答闲聊——一律 clear=true、不问任何问题(这类后续会直接处理,根本不需要"交付形式/受众/标准")。

否则,按是否能直接产出高质量成品判断:
- 已明确(说清做什么 + 关键格式/标准/受众)→ clear=true,questions 留空。
- 宽泛的【产出型需求】(要方案/报告/论文等成果文件,但关键信息缺失)→ clear=false,生成 2-4 个【最关键】的澄清问题。

每个问题必须给一个合理的默认建议(suggestion),这样用户即使不答、也能用默认值直接跑。
问题要问在刀刃上:交付格式? 专业标准/受众? 范围与深度? 硬性约束? —— 不要问废话、不要超过 4 个。
若涉及学术/专业产出,标准默认按"通用高校/行业标准",并把"是否指定具体学校/专业/级别"作为一个带默认的问题。

只输出 JSON(不要代码块):
{"clear": false, "questions": [{"q": "问题", "why": "为什么需要问", "suggestion": "合理默认值"}]}`;

  const resp = await llm.chat.completions.create({
    model: CONFIG.models.default,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: goal },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.4,
  });

  const raw = resp.choices[0]?.message?.content || '{}';
  try {
    const p = JSON.parse(raw) as { clear?: boolean; questions?: Array<Record<string, unknown>> };
    const questions: ClarifyQuestion[] = (p.questions || [])
      .map((x) => ({ q: String(x.q || ''), why: String(x.why || ''), suggestion: String(x.suggestion || '') }))
      .filter((x) => x.q);
    return { clear: p.clear === true || questions.length === 0, questions };
  } catch {
    return { clear: true, questions: [] };
  }
}
