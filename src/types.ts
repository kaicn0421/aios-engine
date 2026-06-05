// AIOS 核心数据结构 —— 整条链路的"通用语言",所有模块靠这些类型对接。

/** Brain 拆解出的一个子任务 */
export interface SubTask {
  id: string;          // s1, s2 ...
  title: string;       // 如 "市场分析"
  objective: string;   // 这个子任务具体要产出什么(给执行 Agent 的指令)
  skill: SkillName;    // 用哪个 Skill 执行
  complexity: 'standard' | 'deep'; // Cost Optimizer 据此选模型:deep→更强模型
  dependsOn: string[]; // 依赖的子任务 id
  outFile?: string;    // 若该子任务是最终交付物,产出的文件名(如 市场分析.md / slides.html);中间步骤留空
}

/** Brain 输出的完整任务计划 */
export interface Plan {
  goal: string;          // 用户原话
  understanding: string; // Brain 对目标的复述/理解
  kind: 'document' | 'artifact' | 'action'; // document=方案/报告;artifact=可运行成品;action=即时动作/直接回答(不出文件)
  subtasks: SubTask[];
}

/** 一个 Agent 执行完一个子任务的产出 */
export interface AgentResult {
  subtaskId: string;
  title: string;
  skill: SkillName;
  model: string;
  output: string;   // markdown
  evidenceText?: string; // 工具/网页观察到的原始证据摘要,供 Result Engine 做 freshness 校验
  ok: boolean;
  error?: string;
  ms: number;       // 耗时
}

/** Result Engine 整合后的最终交付物 */
export interface Deliverable {
  goal: string;
  understanding: string;
  markdown: string;        // 整合后的完整文档(artifact 时为成品说明)
  results: AgentResult[];  // 各子任务原始产出
  ms: number;              // 总耗时
  artifactPath?: string;   // 若是 artifact,产出的可运行文件路径
  dir?: string;            // 多文件交付:项目文件夹路径
  files?: Array<{ name: string; path: string }>; // 多文件交付:文件清单
  freshness_verified?: boolean; // 数据/实时类交付是否通过来源和 as-of 核验
  freshness_summary?: unknown;  // 数据时效核验摘要
  sources_path?: string;        // sources.jsonl 路径
  data_path?: string;           // data.csv/xlsx 路径
  evidence_manifest?: string;   // evidence_manifest.json 路径
  office_quality_manifest?: string; // office_quality_manifest.json 路径
  delivery_manifest?: string;   // delivery_manifest.json 路径
  task_satisfaction?: unknown;  // aios.task_satisfaction.v1,首轮可用度评分
}

/** Skill 名 */
export type SkillName =
  | 'research'    // 调研/查证/事实梳理
  | 'analysis'    // 分析/对比/风险判断
  | 'writing'     // 写作/文案/表达
  | 'planning'    // 方案/计划/落地步骤
  | 'finance'     // 财务建模/单位经济/现金流
  | 'deck'        // 演示文稿结构/PPT 大纲
  | 'data'        // 数据分析/指标/可视化
  | 'marketing'   // 营销增长/渠道/获客
  | 'code';       // 造物:把需求实现成可运行的代码/页面

/** 一个 Skill 的定义 */
export interface Skill {
  name: SkillName;
  label: string;        // 中文名,给 Brain 和日志看
  description: string;  // 能力描述,Brain 据此分配
  system: string;       // 这个 Skill 执行时的 system prompt
}

/** 事件流 —— CLI 实时打印任务流,未来前端也订阅同一套 */
export type AiosEvent =
  | { type: 'brain.start'; goal: string }
  | { type: 'brain.done'; plan: Plan }
  | { type: 'agent.start'; subtask: SubTask }
  | { type: 'agent.done'; result: AgentResult }
  | { type: 'result.start' }
  | { type: 'result.step'; stage: string; message: string; detail?: string; ok?: boolean }
  | { type: 'result.done'; deliverable: Deliverable };

export type EventSink = (e: AiosEvent) => void;
