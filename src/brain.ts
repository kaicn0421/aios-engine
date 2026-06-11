// AIOS Brain —— 任务理解与拆解中枢。一句话目标 → 结构化任务计划。
import { llm, CONFIG } from './config';
import { SKILLS, SKILL_CATALOG } from './skills';
import { needsFreshnessEvidence } from './freshness';
import { defaultOutFileForFormat, officeFormatsFromGoal } from './office-format';
import type { Plan, SubTask, SkillName } from './types';

// 动态从 Skill 库取,以后加 Skill 不用改这里
const VALID = Object.keys(SKILLS) as SkillName[];

function businessPlanSubtasks(goal: string, outFile?: string): SubTask[] {
  const standard: SubTask = {
    id: 's1',
    title: '确立商业计划书的标准与规格',
    objective:
      '查实并确立本任务需要遵循的商业计划书结构、宁波本地餐饮调研口径、上市路径材料标准和评价标准。输出后续章节必须遵守的结构、证据边界和质量要求。',
    skill: 'research',
    complexity: 'standard',
    dependsOn: [],
  };
  const sections: Array<[string, string, SkillName, 'standard' | 'deep']> = [
    ['市场分析与客群定位', '围绕宁波餐饮消费、泰餐品类机会、目标客群、竞品格局、选址逻辑和差异化定位产出完整章节。必须区分已知事实、合理假设和待核验数据。', 'research', 'deep'],
    ['品牌定位与产品策略', '设计从第一家店开始可复制的泰餐品牌定位、菜单结构、价格带、门店体验、供应链和食品安全标准。内容要能指导真实开店。', 'planning', 'deep'],
    ['门店模型与扩张计划', '拆解首店模型、标准店模型、区域复制、组织能力、供应链建设、数字化系统和10年扩张节奏。必须给出阶段目标和关键动作。', 'planning', 'deep'],
    ['财务测算与融资上市路径', '建立收入、成本、毛利、人效、坪效、现金流、融资轮次、治理规范和上市路径测算。数字没有来源时必须标注为假设。', 'finance', 'deep'],
    ['风险清单与执行里程碑', '输出食品安全、合规、选址、供应链、资金、团队、品牌和上市规范风险清单,并给出30/90/180天与1/3/5/10年行动里程碑。', 'analysis', 'standard'],
  ];
  return [
    standard,
    ...sections.map((s, i): SubTask => ({
      id: `s${i + 2}`,
      title: s[0],
      objective: `严格按 s1 确立的标准产出"${s[0]}"章节。\n整体目标:${goal}\n${s[1]}`,
      skill: s[2],
      complexity: s[3],
      dependsOn: ['s1'],
      outFile,
    })),
  ];
}

export function localFallbackPlan(goal: string, reason: string = 'brain_timeout'): Plan {
  const officeFormats = officeFormatsFromGoal(goal);
  const freshnessRequired = needsFreshnessEvidence(goal);
  const kind: Plan['kind'] = officeFormats.length || freshnessRequired ? 'document' : 'document';
  const primary = officeFormats[0] || 'docx';
  const outFile = defaultOutFileForFormat(goal, primary);
  const isBusinessPlan = /上市|商业计划|餐饮|泰餐|门店|融资|扩张|宁波|公司|企业/.test(goal);
  const subtasks = isBusinessPlan
    ? businessPlanSubtasks(goal, outFile)
    : [
        {
          id: 's1',
          title: '整理需求与交付标准',
          objective: `在 Brain 规划超时后,先用本地兜底计划整理用户需求、交付格式和质量标准。\n整体目标:${goal}`,
          skill: 'research' as SkillName,
          complexity: 'standard' as const,
          dependsOn: [],
        },
        {
          id: 's2',
          title: '生成可交付正文',
          objective: `严格围绕用户目标生成可直接使用的正式材料,避免空话和占位内容。\n整体目标:${goal}`,
          skill: 'writing' as SkillName,
          complexity: 'deep' as const,
          dependsOn: ['s1'],
          outFile,
        },
      ];

  const formats = officeFormats.length ? officeFormats : ['docx'];
  for (const sub of subtasks) {
    if (sub.outFile) {
      sub.objective += `\n本任务必须产出 ${formats.map((f) => `.${f}`).join('/')} 可编辑/可交付文件,禁止输出 HTML artifact 冒充办公文件。`;
    }
  }
  return {
    goal,
    understanding: `已按本地兜底规划处理: ${goal}`,
    kind,
    subtasks,
  };
}

export async function plan(goal: string, memory: string = ''): Promise<Plan> {
  const system =
`你是 AIOS 的任务规划中枢(AIOS Brain)。用户给你一句话目标,你要:

1. 判断 kind:
   - "action":用户想【即时做件事或得到直接答案】——听歌/看视频/打开网页、查一个具体事实、简单问答闲聊。无需产出文件。
   - "artifact":用户要【能直接运行/使用的成品】——游戏、网页、落地页、小工具、可视化、原型。
   - "document":用户要【方案、分析、调研、报告、文案、计划】等文字成果。
   准则:要"立刻得到或做某事"→action;要"一份成品文件"→document/artifact。拿不准时:简单即时的归 action,复杂成体系的归 document。
2. 用一句话复述你对目标的理解。
3. 拆子任务:
   - kind=action → 只输出 1 个子任务:objective 写"直接给用户要的——听歌/看视频就给可点的 YouTube 搜索链接(https://www.youtube.com/results?search_query=关键词,多词用+连),打开网页给网址,查事实/问答就简洁直接回答";不要长篇大论、不要文件;skill 选 research(需查)或 writing(直接答),complexity 用 standard,不给 outFile。
   - kind=document → 这是【一份完整成果】。拆成 3-6 个【章节/内容】子任务,每个负责成果的一个部分(如市场分析、客群、选址、财务测算、风险),各指派最合适的 Skill。
     **核心规则:这些内容子任务【全部用同一个 outFile】(同一个报告文件名)——引擎会按子任务顺序自动拼接成一份完整成果。每个子任务必须产出该部分的【完整实际内容】(小标题+数据+论述),不是提纲、不是"已完成"之类的交代。**
     **绝不要**拆"汇总/整合/输出/排版/质检/生成PDF"这类子任务——合并、排版、转格式、写执行摘要全由引擎自动完成,多拆这种只会产出占位空话、冒充成果。
     **若要符合专业/学术标准(论文、正式报告、商业计划书、合同):第 1 个子任务用 research/analysis【确立该领域真实标准与规格】(结构/篇幅/格式/引用规范/评价标准),它是中间步骤【不给 outFile】;后续各章节子任务 dependsOn 指向它,严格按标准产出而非套模板。**
   - kind=artifact → 只输出 1 个子任务,skill 必须为 "code",complexity 为 "standard",objective 写清楚:做什么、核心功能/玩法、关键技术要点(单文件 HTML5、可独立运行)。

可用 Skill:
${SKILL_CATALOG}

每个子任务标 complexity:"standard" 或 "deep"(需严谨多步推理/复杂实现)。多数 standard。
可选 dependsOn:本子任务依赖哪些子任务的产出(数组,默认 [])。被依赖者先执行,其成果作为上下文传入。
outFile 规则:【同一份成果的所有章节子任务必须用同一个 outFile】(如都写"调研报告.docx",引擎据此把它们按序合并成一份完整报告)。格式:报告/分析/文案/论文/方案/计划书→.docx(默认),PPT/演示/汇报→.pptx,数据表/测算表→.xlsx,网页/程序/游戏→.html;仅当用户明确要 PDF→.pdf、明确要 Markdown→.md。只有用户确实要【多个不同交付物】(例:一份报告+一个测算表+一套PPT)时才用不同 outFile。纯中间步骤(如"确立标准")不给 outFile。

办公交付质量规则:
- Word/PDF:必须像正式材料,包含标题层级、执行摘要/结论、正文分节、必要表格、风险/下一步,禁止口水话和占位段落。
- PPT:必须像办公室汇报,一页一个观点,包含封面、目录/汇报逻辑、重点工作/问题风险/下一步,正文不要堆长段。
- Excel:必须是可编辑工作簿,字段适合实际登记,包含字段说明、状态/类别下拉、公式列、统计看板、冻结表头和打印友好设置;禁止输出 HTML 预览冒充 Excel。
- 合同/费用/会议/资料归档/事项跟踪/清单/报表等办公室场景,默认按中铁办公室人员日常使用习惯设计:编号、日期、责任部门、责任人、状态、风险、归档位置、下一步动作必须尽量结构化。
- FIDIC/菲迪克/工程合同/索赔/Notice/Time-Bar/DAAB/变更/付款/BOQ 类任务,默认进入"合同雷达"工作流:先读项目资料和合同文本,输出风险、时限、索赔机会、证据缺口和拟发函;没有来源时必须标缺口,不得冒充法律意见。

只输出 JSON(不要代码块、不要多余文字):
{
  "kind": "document",
  "understanding": "对目标的理解(一句话)",
  "subtasks": [
    {"id":"s1","title":"确立XX领域的标准与规格","objective":"查实结构/篇幅/格式/评价标准...","skill":"research","complexity":"standard","dependsOn":[]},
    {"id":"s2","title":"...","objective":"严格按 s1 确立的标准产出...","skill":"writing","complexity":"deep","dependsOn":["s1"],"outFile":"成果.docx"}
  ]
}
要求:document 子任务合起来完整覆盖目标;skill 只能从上面列出的里选。`;

  const resp = await llm.chat.completions.create({
    model: CONFIG.models.default,
    messages: [
      { role: 'system', content: system + (memory ? `\n\n【关于此用户的长期记忆,理解与拆解时贴合、但不要被绑架】\n${memory}` : '') },
      { role: 'user', content: goal },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.4,
  });

  const raw = resp.choices[0]?.message?.content || '{}';
  let parsed: { kind?: string; understanding?: string; subtasks?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Brain 返回的不是合法 JSON:\n' + raw.slice(0, 300));
  }

  const subtasks: SubTask[] = (parsed.subtasks || []).map((t, i) => {
    const skill = String(t.skill || '');
    return {
      id: String(t.id || `s${i + 1}`),
      title: String(t.title || `子任务 ${i + 1}`),
      objective: String(t.objective || t.title || ''),
      skill: (VALID.includes(skill as SkillName) ? skill : 'research') as SkillName,
      complexity: t.complexity === 'deep' ? 'deep' : 'standard',
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map((d) => String(d)) : [],
      outFile: typeof t.outFile === 'string' && t.outFile.trim() ? t.outFile.trim() : undefined,
    };
  });

  if (subtasks.length === 0) throw new Error('Brain 没拆出任何子任务');

  const officeFormats = officeFormatsFromGoal(goal);
  const freshnessRequired = needsFreshnessEvidence(goal);
  const kind = officeFormats.length
    ? 'document'
    : parsed.kind === 'artifact'
    ? 'artifact'
    : parsed.kind === 'action' && !freshnessRequired
      ? 'action'
      : 'document';
  if (officeFormats.length) {
    const primary = officeFormats[0] || 'docx';
    for (const sub of subtasks) {
      sub.outFile = defaultOutFileForFormat(goal, primary);
      if (sub.skill === 'code') sub.skill = primary === 'xlsx' ? 'data' : 'writing';
      sub.objective += `\n本任务必须产出 ${officeFormats.map((f) => `.${f}`).join('/')} 可编辑文件,禁止输出 HTML artifact 冒充办公文件。`;
      if (primary === 'xlsx') {
        sub.objective += '\nExcel 必须按办公室可长期维护的台账/清单设计:字段说明、下拉校验、公式列、统计看板、冻结表头、打印设置都要考虑。';
        sub.objective += '\n关键要求:你的输出必须包含一张 Markdown 表格,第一行是本任务专属字段,第二行是分隔线,后面给 2-3 行真实业务样例;不要只写字段说明或空泛描述。';
      } else if (primary === 'pptx') {
        sub.objective += '\nPPT 必须按正式办公室汇报设计:封面、目录、重点结论、问题风险、下一步安排,一页一观点,避免长段堆砌。';
      } else if (primary === 'docx' || primary === 'pdf') {
        sub.objective += '\nWord/PDF 必须按正式材料设计:标题层级、执行摘要、正文分节、表格/清单、结论和下一步完整,不得写占位内容。';
      }
    }
  }
  if (freshnessRequired) {
    for (const sub of subtasks) {
      if (!sub.outFile) sub.outFile = '数据时效核验报告.docx';
      sub.complexity = 'deep';
      sub.objective += '\n必须给出可点击 URL、as-of 日期、数据口径、DATA_GAP;没有可验证来源时明确标注缺口,禁止把旧数据冒充当前数据。';
    }
  }
  return { goal, understanding: String(parsed.understanding || goal), kind, subtasks };
}
