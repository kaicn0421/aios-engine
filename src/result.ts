// Result Engine —— 把多个 Agent 的产出整合成一份最终交付物。
// 块3.5: 先调 LLM 生成全局"执行摘要",再拼接各部分 → 从"拼接"升级为"整合报告"。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { llm, CONFIG } from './config';
import { extractHtml, writeArtifact, sanitizeName, writeDeliverable } from './build';
import { buildFreshnessArtifacts, type FreshnessSummary } from './freshness';
import { buildOfficeQualityArtifacts, isOfficeDelivery } from './office-quality';
import { buildFidicContractRadarPackage, isFidicContractRadarGoal } from './fidic-radar';
import {
  defaultOutFileForFormat,
  officeFileSignatureOk,
  officeFormatsFromGoal,
  officePrimaryExt,
  requestedOfficeSize,
  goalAllowsMorePages,
  pptContentSlideCount,
  estimateDocumentPages,
  truncatePptMarkdownToSlides,
} from './office-format';
import type { Provider } from './providers';
import { requiresStructuredDataRows } from './freshness';
import type { AgentResult, Deliverable, EventSink, Plan } from './types';

function extOf(name: string): string {
  return (name.split('.').pop() || '').toLowerCase();
}

function withoutExt(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function primaryFileName(files: Array<{ name: string; path: string }>, requiredFormats: string[]): string {
  const wanted = [...requiredFormats, 'xlsx', 'pptx', 'docx', 'pdf', 'md'];
  for (const ext of wanted) {
    const found = files.find((f) => f.name.toLowerCase().endsWith(`.${ext}`));
    if (found) return found.name;
  }
  return files.find((f) => f.name !== 'README.md')?.name || 'README.md';
}

interface DeliveryManifestFile {
  name: string;
  path: string;
  ext: string;
  role: 'primary' | 'source' | 'readme' | 'quality' | 'evidence' | 'manifest' | 'support';
  exists: boolean;
  bytes: number;
  sha256: string | null;
  self_hash_excluded?: boolean;
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function fileSha256(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return '';
  }
}

function fileRole(name: string, primary: string): DeliveryManifestFile['role'] {
  if (name === primary) return 'primary';
  if (name === 'source_content.md') return 'source';
  if (name === 'README.md') return 'readme';
  if (name === 'delivery_manifest.json') return 'manifest';
  if (name === 'office_quality_manifest.json' || name === 'OFFICE_DELIVERY_CHECKLIST.md') return 'quality';
  if (['sources.jsonl', 'data.csv', 'freshness_summary.json', 'evidence_manifest.json', 'claim_evidence.json'].includes(name)) return 'evidence';
  return 'support';
}

function isEditableOfficeExt(ext: string): boolean {
  return ['xlsx', 'pptx', 'docx'].includes(ext);
}

function manifestFileEntry(file: { name: string; path: string }, primary: string, manifestPath: string): DeliveryManifestFile {
  const role = fileRole(file.name, primary);
  const isSelf = file.path === manifestPath;
  return {
    name: file.name,
    path: file.path,
    ext: extOf(file.name),
    role,
    exists: existsSync(file.path),
    bytes: isSelf ? 0 : fileBytes(file.path),
    sha256: isSelf ? null : fileSha256(file.path),
    ...(isSelf ? { self_hash_excluded: true } : {}),
  };
}

/** manifest 单一权威状态:与 Rust 端 delivery_completion_message 同源信号,
 *  让任何读 manifest 的人不必从 compliance/satisfaction/smoke 自己重算。
 *  注:Rust 端还有路径存在性/格式等额外闸,最终用户可见状态以 Rust 为准;
 *  这里是 engine 侧 best-effort 汇总。 */
function deliveryManifestStatus(
  compliance: 'pass' | 'fail',
  smoke: { status?: string },
  quality: { manifest: { status: string } } | undefined,
  satisfaction: { verdict?: string; score?: number; first_pass_usable?: boolean } | undefined,
): 'completed' | 'needs_repair' {
  if (compliance === 'fail') return 'needs_repair';
  if (smoke?.status === 'fail') return 'needs_repair';
  if (quality && quality.manifest.status === 'fail') return 'needs_repair';
  if (satisfaction) {
    const score = typeof satisfaction.score === 'number' ? satisfaction.score : 100;
    const firstPass = satisfaction.first_pass_usable === true;
    if (satisfaction.verdict === 'needs_repair' || (!firstPass && score < 80)) return 'needs_repair';
  }
  return 'completed';
}

function deliverySmoke(
  entries: DeliveryManifestFile[],
  primary: string,
  requiredFormats: string[],
  quality: Awaited<ReturnType<typeof buildOfficeQualityArtifacts>> | undefined,
  freshness: Awaited<ReturnType<typeof buildFreshnessArtifacts>>,
) {
  const primaryEntry = entries.find((f) => f.name === primary);
  const sourceEntry = entries.find((f) => f.name === 'source_content.md');
  const integrityEntries = entries.filter((f) => f.role !== 'manifest' && f.role !== 'evidence');
  const primaryExt = extOf(primary);
  const officeRequiredFormats = requiredFormats.filter((ext) => ['xlsx', 'pptx', 'docx', 'pdf'].includes(ext));
  const checks = [
    {
      id: 'primary_exists',
      ok: Boolean(primaryEntry?.exists && primaryEntry.bytes > 0 && /^[a-f0-9]{64}$/.test(primaryEntry.sha256 || '')),
      detail: primary,
    },
    {
      id: 'source_content_exists',
      ok: Boolean(sourceEntry?.exists && sourceEntry.bytes > 0 && /^[a-f0-9]{64}$/.test(sourceEntry.sha256 || '')),
      detail: 'source_content.md',
    },
    {
      id: 'required_formats_present',
      ok: requiredFormats.every((ext) => entries.some((f) => f.ext === ext && f.exists && f.bytes > 0)),
      detail: requiredFormats.length ? requiredFormats.join(', ') : 'none',
    },
    {
      id: 'primary_office_signature',
      ok: !['xlsx', 'pptx', 'docx', 'pdf'].includes(primaryExt)
        || Boolean(primaryEntry && officeFileSignatureOk(primaryEntry.path, primaryExt)),
      detail: primary,
    },
    {
      id: 'required_office_signatures',
      ok: officeRequiredFormats.every((ext) =>
        entries
          .filter((f) => f.ext === ext)
          .every((f) => officeFileSignatureOk(f.path, ext))),
      detail: officeRequiredFormats.length ? officeRequiredFormats.join(', ') : 'none',
    },
    {
      id: 'files_integrity',
      ok: integrityEntries.every((f) => f.exists && f.bytes > 0 && /^[a-f0-9]{64}$/.test(f.sha256 || '')),
      detail: `${integrityEntries.length} checked`,
    },
    {
      id: 'office_quality',
      ok: !quality || quality.manifest.status === 'pass',
      detail: quality ? `${quality.manifest.status}:${quality.manifest.score}` : 'not_required',
    },
    {
      id: 'freshness',
      ok: freshness.freshness_verified || !freshness.freshness_summary,
      detail: freshness.freshness_summary ? (freshness.freshness_verified ? 'verified' : 'repair_required') : 'not_required',
      warnOnly: Boolean(freshness.freshness_summary && !freshness.freshness_verified),
    },
  ];
  const hardFailures = checks.filter((c) => !c.ok && !c.warnOnly);
  const warnings = checks.filter((c) => !c.ok && c.warnOnly);
  return {
    status: hardFailures.length ? 'fail' : warnings.length ? 'warn' : 'pass',
    checks,
  };
}

function checkOk(checks: Array<{ id: string; ok: boolean }>, id: string): boolean {
  return checks.some((c) => c.id === id && c.ok);
}

function qualityCheckOk(
  quality: Awaited<ReturnType<typeof buildOfficeQualityArtifacts>> | undefined,
  id: string,
): boolean {
  if (!quality) return true;
  return quality.manifest.files.some((file) => file.checks.some((c) => c.id === id && c.ok));
}

function promptRelevanceChecksPass(
  quality: Awaited<ReturnType<typeof buildOfficeQualityArtifacts>> | undefined,
): boolean {
  if (!quality) return true;
  const checks = quality.manifest.files.flatMap((file) =>
    file.checks.filter((c) => c.id.endsWith('_prompt_relevance')));
  if (checks.length === 0) return true;
  return checks.every((c) => c.ok);
}

function scoreBand(score: number): string {
  if (score >= 90) return '可直接交付';
  if (score >= 80) return '可用,建议小修';
  if (score >= 60) return '有价值但必须修复';
  return '任务失败或有信任风险';
}

function buildTaskSatisfaction(
  requiredFormats: string[],
  deliveryCompliance: 'pass' | 'fail',
  smoke: ReturnType<typeof deliverySmoke>,
  quality: Awaited<ReturnType<typeof buildOfficeQualityArtifacts>> | undefined,
  freshness: Awaited<ReturnType<typeof buildFreshnessArtifacts>>,
  editableSourceNames: string[],
  failed: AgentResult[],
) {
  const failedSubtasksOk = failed.length === 0;
  const formatOk = checkOk(smoke.checks, 'required_formats_present')
    && checkOk(smoke.checks, 'required_office_signatures');
  const freshnessRequired = Boolean(freshness.freshness_summary);
  const freshnessOk = !freshnessRequired || freshness.freshness_verified;
  // 研究/商业计划类证据不足时降级交付(已成稿+待核验),给部分分并走复核,不再一票否决
  const degradedResearch = freshnessRequired
    && !freshness.freshness_verified
    && freshness.freshness_summary?.reason === 'research_evidence_delivery';
  const qualityStatus = quality?.manifest.status || 'not_required';
  const qualityScore = quality?.manifest.score ?? 100;
  const promptRelevant = promptRelevanceChecksPass(quality);
  const dimensions = [
    { id: 'intent_fit', label: '需求理解', max: 15, score: promptRelevant && failedSubtasksOk ? 15 : 8 },
    { id: 'format_fidelity', label: '格式忠诚', max: 15, score: formatOk ? 15 : 0 },
    { id: 'content_accuracy', label: '内容准确', max: 20, score: freshnessOk && qualityStatus !== 'fail' ? 20 : freshnessOk ? 12 : degradedResearch ? 12 : 0 },
    { id: 'source_evidence', label: '来源证据', max: 15, score: freshnessRequired ? (freshnessOk ? 15 : degradedResearch ? 8 : 5) : 10 },
    { id: 'business_polish', label: '商用品质', max: 15, score: Math.round((Math.max(0, Math.min(100, qualityScore)) / 100) * 15) },
    { id: 'editability', label: '可编辑性', max: 10, score: requiredFormats.length === 0 || editableSourceNames.length > 0 ? 10 : 0 },
    { id: 'actionability', label: '行动闭环', max: 5, score: checkOk(smoke.checks, 'source_content_exists') ? 5 : 3 },
    { id: 'risk_transparency', label: '风险透明', max: 5, score: failedSubtasksOk && (quality || freshnessRequired) ? 5 : 2 },
  ];
  const rawScore = dimensions.reduce((sum, d) => sum + d.score, 0);
  // Research/business-plan deliveries may legitimately have a few unverified
  // claims after the evidence audit. Do not cap them at 69 just because one
  // research subtask timed out; the output is still useful if it is clearly
  // marked as review-required. Time-sensitive price/market data still hard
  // blocks earlier and never reaches this degraded path.
  const score = failedSubtasksOk || degradedResearch ? rawScore : Math.min(rawScore, 69);
  const firstPassUsable = failedSubtasksOk
    && score >= 80
    && deliveryCompliance === 'pass'
    && freshnessOk
    && qualityStatus !== 'fail';
  const verdict = !firstPassUsable && score < 80 ? 'needs_repair' : score < 90 ? 'review_recommended' : 'ready_to_use';
  return {
    schema: 'aios.task_satisfaction.v1',
    north_star: 'first_pass_usable_rate',
    score,
    band: scoreBand(score),
    verdict,
    first_pass_usable: firstPassUsable,
    dimensions,
    failed_subtasks: failed.map((f) => ({ title: f.title, error: f.error || 'unknown' })),
    feedback_options: ['可直接用', '需要小改', '不能用'],
    feedback_reasons: ['格式不对', '内容不准', '数据旧', '排版差', '不符合单位口径', '少了来源', '没按我的要求', '任务没闭环'],
  };
}

async function execSummary(goal: string, ok: AgentResult[]): Promise<string> {
  if (!ok.length) return '';
  const digest = ok.map((r) => `### ${r.title}\n${r.output.slice(0, 1200)}`).join('\n\n');
  try {
    const resp = await llm.chat.completions.create({
      model: CONFIG.models.default,
      messages: [
        {
          role: 'system',
          content:
            '你是 AIOS 的总编。下面是针对同一个目标、由多个 Agent 产出的各部分成果。' +
            '写一段"执行摘要"(200-350字):提炼核心结论、关键数字、整体可行性判断,以及最关键的 2-3 条建议。' +
            '要有全局视角、像一份报告的开篇,不要逐章罗列。输出 markdown。' +
            '直接给摘要正文,不要"好的""以下是"之类的开场白,也不要自己写"执行摘要"标题(外层已有)。',
        },
        { role: 'user', content: `目标:${goal}\n\n各部分成果摘录:\n${digest}` },
      ],
      temperature: 0.5,
    });
    return resp.choices[0]?.message?.content?.trim() || '';
  } catch {
    return ''; // 摘要失败不阻断整体交付,降级为无摘要
  }
}

function freshnessRepairSummary(goal: string, summary: FreshnessSummary): string {
  const gaps = summary.gaps.length ? summary.gaps.join('；') : '数据时效核验未通过';
  if (summary.reason === 'research_evidence_delivery') {
    return [
      `本任务需要可复核的商业/行业证据，但 AIOS 没有拿到足够来源来支撑报告里的关键门店、竞品、市场数字或增长判断，因此本次交付标记为“需修复”。`,
      `核验状态：来源 ${summary.verified_source_count}/${summary.source_count} 通过 HTTP 校验；证据缺口：${gaps}。`,
      `下一步需要补充可访问的公开来源、行业报告、平台页面、实地记录或用户提供资料；没有来源的具体门店和数字只能进入 SOURCE_GAP/待核验清单，不能写成已证实事实。`,
    ].join('\n\n');
  }
  return [
    `本任务要求当前/最新数据，但 AIOS 没有拿到足够的可复核证据，因此本次交付标记为“需修复”，不会输出任何未经验证的具体价格。`,
    `核验状态：来源 ${summary.verified_source_count}/${summary.source_count} 通过 HTTP 校验；最新可解析日期：${summary.latest_date || '无'}；缺口：${gaps}。`,
    `下一步需要补充可访问的行业数据库/API/登录态，或由用户提供权威来源链接后重新生成。`,
  ].join('\n\n');
}

// 降级交付:证据不足但仍出完整正文时,在正文顶部加一段"待核验声明",而不是阻断交付
function freshnessDisclosureBanner(summary: FreshnessSummary): string {
  const gapLines = summary.gaps.length
    ? summary.gaps.map((g) => `> - ${g}`)
    : ['> - 部分具体门店/数字暂缺可核验来源'];
  return [
    '> 证据声明(发送前请复核)',
    '>',
    '> 本版已按要求出完整框架与可执行内容,但下列具体门店、品牌、市场规模、增长率或平台数据暂未取得公开可核验来源,已按"待核验/假设"处理,请勿当作已证实事实直接对外:',
    '>',
    ...gapLines,
    '>',
    '> 逐条核验明细见 claim_evidence.json;补来源或大众点评/美团/门店清单后可升级为正式版。',
  ].join('\n');
}

function freshnessDegradedSummary(goal: string, summary: FreshnessSummary): string {
  const gaps = summary.gaps.length ? summary.gaps.join('；') : '部分具体数据缺少可核验来源';
  return [
    `证据声明(发送前请复核):本版已交付完整框架与可执行内容,但属于“需复核”版本;部分市场判断、竞品枚举或数字口径尚未完成逐条公开来源绑定,具体门店、竞品、市场数字等暂缺公开可核验来源,已标为待核验/假设。`,
    `核验状态：来源 ${summary.verified_source_count}/${summary.source_count} 通过 HTTP 校验；待核验：${gaps}。`,
    `对外发送前请按 claim_evidence.json 逐条核验或补充来源;补齐后可升级为正式版。`,
  ].join('\n\n');
}

function freshnessRepairReport(goal: string, understanding: string, summary: FreshnessSummary): string {
  const gaps = summary.gaps.length ? summary.gaps.map((g) => `- ${g}`).join('\n') : '- 数据时效核验未通过';
  if (summary.reason === 'research_evidence_delivery') {
    return [
      `# ${goal}`,
      '',
      `> ${understanding}`,
      '',
      '## 结论',
      '',
      '本次未生成可直接对外使用的商业计划书。原因是 AIOS 没有取得足够的可复核证据来支撑报告中的具体门店、竞品、市场规模、增长率或平台数据。为避免把模型推断、未核验门店或旧资料包装成事实，系统已阻断正式交付。',
      '',
      '## 核验状态',
      '',
      `- 当前时间: ${summary.current_time}`,
      `- HTTP 可验证来源: ${summary.verified_source_count}/${summary.source_count}`,
      '',
      '## SOURCE_GAP',
      '',
      gaps,
      '',
      '## 返修要求',
      '',
      '- 对每一个具体门店、品牌、平台数据、市场规模和增长率补来源 URL、发布日期或证据片段。',
      '- 无来源的内容只能放入“待核验清单/行业假设”,不能写入“竞品事实/市场事实/已知事实”。',
      '- 如果公开网页拿不到充分证据,请用户补充大众点评/美团截图、门店清单、访谈记录或行业报告后再生成正式版。',
    ].join('\n');
  }
  return [
    `# ${goal}`,
    '',
    `> ${understanding}`,
    '',
    '## 结论',
    '',
    '本次未生成当前价格报告。原因是 AIOS 没有取得足够的可复核网页证据。为避免把旧数据或模型记忆冒充当前行情，系统已阻断具体价格输出。',
    '',
    '## 核验状态',
    '',
    `- 当前时间: ${summary.current_time}`,
    `- HTTP 可验证来源: ${summary.verified_source_count}/${summary.source_count}`,
    `- 最新可解析日期: ${summary.latest_date || '无'}`,
    `- 最大数据年龄: ${typeof summary.max_source_age_days === 'number' ? `${summary.max_source_age_days} 天` : '无法计算'}`,
    '',
    '## DATA_GAP',
    '',
    gaps,
    '',
    '## 下一步',
    '',
    '- 提供可访问的权威来源 URL、行业数据库/API 或登录态后重跑。',
    '- 若只允许公开网页，应只输出已验证来源中的日期、口径和价格样本；缺失项必须继续保留 DATA_GAP。',
  ].join('\n');
}

async function calibrateOfficeContent(
  content: string,
  fileName: string,
  goal: string,
  calibrator: { provider: Provider; model: string } | undefined,
  emit: EventSink,
): Promise<string> {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (!['pptx', 'docx', 'pdf'].includes(ext)) return content;
  const target = requestedOfficeSize(goal, fileName);
  if (ext === 'pptx') {
    const wanted = target.slides || 0;
    if (wanted <= 0) return content;
    let out = content;
    // 超额裁剪:用户说"3页"就给 3 页;只有"至少/以上"才放行超额
    if (!goalAllowsMorePages(goal) && pptContentSlideCount(out) > wanted + 2) {
      const before = pptContentSlideCount(out);
      out = truncatePptMarkdownToSlides(out, wanted);
      emit({ type: 'result.step', stage: 'write', message: 'Trimming slides to requested count', detail: `${before}→${pptContentSlideCount(out)}/${wanted}` });
    }
    let rounds = 0;
    while (calibrator && pptContentSlideCount(out) < wanted && rounds < 10) {
      rounds++;
      const have = pptContentSlideCount(out);
      const cont = await calibrator.provider.chat(calibrator.model, {
        system: '你是严谨的商务 PPT 内容续写助手。只输出可直接拼接到原 Markdown 后面的内容。',
        user:
          `整体目标:${goal}\n\n这份 PPT 需要 ${wanted} 页,当前只有约 ${have} 页。` +
          `请继续写第 ${have + 1} 页到第 ${Math.min(wanted, have + 8)} 页。\n\n` +
          '硬规则:\n- 每页必须用 "## 第N页: 标题" 开头。\n- 每页 4-6 条要点,适合办公室汇报。\n- 不要重复已有页面,不要解释,不要代码块。\n\n' +
          `已有内容末尾:\n${out.slice(-5000)}`,
        maxTokens: 8192,
        temperature: 0.45,
      });
      if (!cont.trim()) break;
      out += `\n\n${cont.trim()}`;
    }
    return out;
  }
  const wanted = target.pages || 0;
  if (wanted <= 0 || !calibrator) return content;
  let out = content;
  let rounds = 0;
  while (estimateDocumentPages(out) < wanted && rounds < 12) {
    rounds++;
    const cont = await calibrator.provider.chat(calibrator.model, {
      system: '你是正式商务文档续写助手。只输出可直接拼接到原 Markdown 后面的新章节内容。',
      user:
        `整体目标:${goal}\n\n这份 ${ext.toUpperCase()} 至少需要 ${wanted} 页,当前估算约 ${estimateDocumentPages(out)} 页。` +
        '请继续补充新的正式章节,每轮约 2500-3500 个中文字符。\n\n' +
        '硬规则:\n- 使用清晰标题层级、表格或清单、结论和下一步。\n- 不要重复已有段落,不要解释,不要代码块。\n- 内容必须贴合用户任务,不能用占位话。\n\n' +
        `已有内容末尾:\n${out.slice(-6000)}`,
      maxTokens: 8192,
      temperature: 0.45,
    });
    if (!cont.trim()) break;
    out += `\n\n${cont.trim()}`;
  }
  return out;
}

export async function assemble(
  plan: Plan,
  results: AgentResult[],
  ms: number,
  outDir: string,
  emit: EventSink = () => {},
  calibrator?: { provider: Provider; model: string },
): Promise<Deliverable> {
  const requiredFormats = officeFormatsFromGoal(plan.goal);
  const primaryFormat = officePrimaryExt(requiredFormats);
  // artifact:把 code Agent 的产出落地成可运行的单文件成品
  if (plan.kind === 'artifact' && requiredFormats.length === 0) {
    const codeRes = results.find((r) => r.skill === 'code' && r.ok);
    if (codeRes) {
      const path = writeArtifact(extractHtml(codeRes.output), outDir);
      const markdown =
        `# ${plan.goal}\n\n> ${plan.understanding}\n\n` +
        `## ✓ 已生成可运行成品\n\n\`${path}\`\n\n` +
        `浏览器直接打开即可运行 —— 单文件 HTML,内联全部代码,无外部依赖。\n`;
      return { goal: plan.goal, understanding: plan.understanding, markdown, results, ms, artifactPath: path };
    }
    // code 失败则落到下面的文档兜底
  }

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  if (isFidicContractRadarGoal(plan.goal)) {
    const dir = join(outDir, `aios-contract-radar-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    emit({ type: 'result.step', stage: 'contract_radar', message: 'Starting FIDIC contract radar package' });
    const radar = await buildFidicContractRadarPackage(plan.goal, plan.understanding, dir, emit);
    const sourceContentPath = join(dir, 'source_content.md');
    const sourceContent = [
      `# ${plan.goal}`,
      '',
      `> ${plan.understanding}`,
      '',
      '## Contract Radar Boundary',
      '',
      'AIOS 本版交付的是工程合同管理 playbook、台账和草稿包,不内置 FIDIC 版权全文,不替代律师意见。',
      '导入项目真实合同、Particular Conditions、BOQ、函件、会议纪要、进度计划后,应把每条结论绑定到 source_map。',
      '',
      '## Agent Outputs',
      '',
      ...ok.map((r) => `### ${r.title}\n\n${r.output}`).join('\n\n---\n\n').split('\n'),
    ].join('\n');
    writeFileSync(sourceContentPath, sourceContent, 'utf8');
    const files = [{ name: 'source_content.md', path: sourceContentPath }, ...radar.files];
    const quality = isOfficeDelivery(files) ? await buildOfficeQualityArtifacts(plan.goal, files, dir, true) : undefined;
    if (quality) files.push(...quality.files);
    const primary = '合同健康体检.docx';
    const deliveryManifestPath = join(dir, 'delivery_manifest.json');
    writeFileSync(deliveryManifestPath, '', 'utf8');
    const filesForReadme = [...files, { name: 'delivery_manifest.json', path: deliveryManifestPath }];
    let manifestFiles = filesForReadme.map((f) => manifestFileEntry(f, primary, deliveryManifestPath));
    const freshness = { freshness_verified: true, freshness_summary: undefined } as Awaited<ReturnType<typeof buildFreshnessArtifacts>>;
    let smoke = deliverySmoke(manifestFiles, primary, ['docx', 'xlsx'], quality, freshness);
    const taskSatisfaction = buildTaskSatisfaction(['docx', 'xlsx'], failed.length || smoke.status === 'fail' || (quality && quality.manifest.status !== 'pass') ? 'fail' : 'pass', smoke, quality, freshness, files.filter((f) => isEditableOfficeExt(extOf(f.name))).map((f) => f.name), failed);
    const readme = [
      `# ${plan.goal}`,
      '',
      `> ${plan.understanding}`,
      '',
      '## 优先打开',
      '',
      '- 合同健康体检.docx',
      '- Notice-TimeBar日历.xlsx',
      '- 索赔机会雷达.xlsx',
      '- 证据缺口清单.xlsx',
      '- 拟发函草稿.docx',
      '',
      '## 使用边界',
      '',
      '- 本包用于合同管理、商务索赔辅助和证据整理,不是法律意见。',
      '- AIOS 不内置 FIDIC 版权全文;请导入项目合法合同文本后再做条款级判断。',
      '- 发函、索赔、争议策略必须由项目商务负责人/律师复核。',
      '',
      '## Task 满意度',
      '',
      `- 分数: ${taskSatisfaction.score}/100`,
      `- 判断: ${taskSatisfaction.band}`,
      `- First-Pass Usable: ${taskSatisfaction.first_pass_usable ? '是' : '否'}`,
      '',
      '## 质量验收',
      '',
      quality ? `- Office 质量分: ${quality.manifest.score}` : '- Office 质量未触发',
      quality ? `- 状态: ${quality.manifest.status}` : '',
      '- 查看 delivery_manifest.json / contract_source_map.json 获得可审计清单。',
      '',
      '## 交付文件',
      '',
      ...filesForReadme.map((f) => `- ${f.name}`),
      '',
    ].join('\n');
    const readmePath = join(dir, 'README.md');
    writeFileSync(readmePath, readme, 'utf8');
    files.unshift({ name: 'README.md', path: readmePath });
    manifestFiles = [...files, { name: 'delivery_manifest.json', path: deliveryManifestPath }]
      .map((f) => manifestFileEntry(f, primary, deliveryManifestPath));
    smoke = deliverySmoke(manifestFiles, primary, ['docx', 'xlsx'], quality, freshness);
    writeFileSync(deliveryManifestPath, JSON.stringify({
      schema: 'aios.delivery_manifest.v1',
      generated_at: new Date().toISOString(),
      goal: plan.goal,
      understanding: plan.understanding,
      domain: 'fidic_contract_radar',
      primary,
      status: deliveryManifestStatus(
        smoke.status === 'fail' || (quality && quality.manifest.status !== 'pass') ? 'fail' : 'pass',
        smoke, quality, taskSatisfaction,
      ),
      required_formats: ['docx', 'xlsx'],
      format_contract: {
        requested_formats: ['docx', 'xlsx'],
        primary_format: 'docx',
        html_artifact_allowed: false,
        compliance: smoke.status === 'fail' || (quality && quality.manifest.status !== 'pass') ? 'fail' : 'pass',
      },
      contract_radar: {
        schema: 'aios.contract_radar.v1',
        outputs: ['合同健康体检.docx', 'Notice-TimeBar日历.xlsx', '索赔机会雷达.xlsx', '证据缺口清单.xlsx', '拟发函草稿.docx'],
        source_map: 'contract_source_map.json',
        copyright_boundary: '不内置 FIDIC 版权全文;条款级判断依赖用户导入合法项目合同文本。',
        human_review_required: true,
      },
      editability: {
        primary_is_editable: true,
        editable_sources: files.filter((f) => isEditableOfficeExt(extOf(f.name))).map((f) => f.name),
        source_content_path: 'source_content.md',
      },
      source_content: 'source_content.md',
      smoke,
      freshness: { verified: true, summary_path: null, sources_path: null, data_path: null },
      office_quality: quality ? {
        score: quality.manifest.score,
        status: quality.manifest.status,
        manifest_path: 'office_quality_manifest.json',
        checklist_path: 'OFFICE_DELIVERY_CHECKLIST.md',
      } : null,
      task_satisfaction: taskSatisfaction,
      files: manifestFiles,
    }, null, 2), 'utf8');
    files.push({ name: 'delivery_manifest.json', path: deliveryManifestPath });
    return {
      goal: plan.goal,
      understanding: plan.understanding,
      markdown: readme,
      results,
      ms,
      dir,
      files,
      freshness_verified: true,
      office_quality_manifest: quality ? join(dir, 'office_quality_manifest.json') : undefined,
      delivery_manifest: deliveryManifestPath,
      task_satisfaction: taskSatisfaction,
    };
  }

  // action:即时动作/直接回答 → 直接给回应,不出文件、不做执行摘要
  if (plan.kind === 'action') {
    return { goal: plan.goal, understanding: plan.understanding, markdown: ok[0]?.output || '(无结果)', results, ms };
  }

  // 多文件交付:有 outFile 的子任务各成一个交付文件,组织成项目文件夹 + README
  const fallbackOutFile = requiredFormats.length ? defaultOutFileForFormat(plan.goal, requiredFormats[0]!) : undefined;
  const fileOf = (r: AgentResult) => plan.subtasks.find((s) => s.id === r.subtaskId)?.outFile || fallbackOutFile;
  const deliverFiles = ok.filter((r) => fileOf(r));
  if (deliverFiles.length) {
    const dir = join(outDir, `aios-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const files: Array<{ name: string; path: string }> = [];
    emit({ type: 'result.step', stage: 'freshness', message: 'Checking freshness evidence' });
    const freshness = await buildFreshnessArtifacts(plan.goal, ok, dir);
    const freshnessFailed = freshness.freshness_summary && !freshness.freshness_verified;
    emit({
      type: 'result.step',
      stage: 'freshness',
      message: freshness.freshness_summary ? 'Freshness evidence checked' : 'No freshness check required',
      detail: freshness.freshness_verified ? 'verified' : freshness.freshness_summary ? 'repair_required' : 'not_required',
      ok: freshness.freshness_verified || !freshness.freshness_summary,
    });
    // research_evidence_delivery(商业计划/调研)证据不足时降级交付:保留正文+顶部加待核验声明;其它(如实时行情)仍阻断
    // hardBlock 只留给"必须给出具体数字行"的任务(价格表/行情数据);
    // 其余时效任务取证不足时 banner 降级交付,正文不再整篇蒸发(审计实证:
    // 办公清单任务曾被整体替换成"未生成当前价格报告")。
    const degradeDeliver = Boolean(
      freshnessFailed
        && (freshness.freshness_summary!.reason === 'research_evidence_delivery'
          || !requiresStructuredDataRows(plan.goal)),
    );
    const hardBlock = Boolean(freshnessFailed) && !degradeDeliver;
    const sum = hardBlock
      ? freshnessRepairSummary(plan.goal, freshness.freshness_summary!)
      : degradeDeliver
        ? freshnessDegradedSummary(plan.goal, freshness.freshness_summary!)
        : await execSummary(plan.goal, ok);
    files.push(...freshness.files);
    // 同名 outFile 的多个子任务 = 同一文件的多个部分,合并拼接成一个完整文件,避免互相覆盖丢内容
    const groups = new Map<string, string[]>();
    if (hardBlock) {
      const repairReport = freshnessRepairReport(plan.goal, plan.understanding, freshness.freshness_summary!);
      for (const r of deliverFiles) {
        const name = sanitizeName(fileOf(r)!);
        if (!groups.has(name)) groups.set(name, [repairReport]);
      }
    } else {
      const banner = degradeDeliver ? freshnessDisclosureBanner(freshness.freshness_summary!) : '';
      for (const r of deliverFiles) {
        const name = sanitizeName(fileOf(r)!);
        const parts = groups.get(name) || [];
        if (parts.length === 0 && banner) parts.push(banner);
        parts.push(r.output);
        groups.set(name, parts);
      }
    }
    const degradedFormats: Array<{ name: string; ext: string; reason: string }> = [];
    for (const [name, parts] of groups) {
      let content = parts.join('\n\n');
      // 页数单点校准:补页/裁剪只在合并后的整份内容上做一次。
      // 旧版在 agent 层按每个子任务各自补满整体页数,N 个子任务合并后 N 倍超标(审计实证)。
      content = await calibrateOfficeContent(content, name, plan.goal, calibrator, emit);
      emit({ type: 'result.step', stage: 'write', message: 'Writing editable deliverable', detail: name });
      let writtenName = name;
      let fp: string;
      try {
        fp = await writeDeliverable(content, name, dir);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // PDF 在无 Chromium 环境(干净 Windows)必失败:主文件降级为可编辑 docx,
        // 不让渲染器缺失毁掉整单交付。空内容错误不降级(降级救不了,该走返修)。
        if (extOf(name) === 'pdf' && !reason.includes('deliverable_empty_content')) {
          writtenName = sanitizeName(`${withoutExt(name)}.docx`);
          emit({ type: 'result.step', stage: 'write', message: 'PDF degraded to editable source', detail: `${name}: ${reason}` });
          degradedFormats.push({ name, ext: 'pdf', reason });
          fp = await writeDeliverable(content, writtenName, dir);
        } else {
          throw err;
        }
      }
      files.push({ name: writtenName, path: fp });
      for (const ext of requiredFormats) {
        if (ext === extOf(writtenName)) continue;
        if (degradedFormats.some((d) => d.ext === ext)) continue;
        // 禁 xlsx companion:goal 捎带表类词就把 docx 正文再塞进台账模板管线,
        // 附赠一份与正文无关的 xlsx,烟测还把凑数文件当达标证据(审计实证)。
        // pdf(预览形态)和 docx(pdf 为主时的可编辑源)是正当 companion,保留。
        if (ext === 'xlsx') continue;
        const extraName = sanitizeName(`${withoutExt(writtenName)}.${ext}`);
        if (files.some((f) => f.name === extraName)) continue;
        emit({ type: 'result.step', stage: 'write', message: 'Writing requested companion format', detail: extraName });
        try {
          const extraPath = await writeDeliverable(content, extraName, dir);
          files.push({ name: extraName, path: extraPath });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          if (ext === 'pdf' && !reason.includes('deliverable_empty_content')) {
            emit({ type: 'result.step', stage: 'write', message: 'Companion PDF degraded', detail: `${extraName}: ${reason}` });
            degradedFormats.push({ name: extraName, ext, reason });
          } else {
            throw err;
          }
        }
      }
    }
    if (degradedFormats.length) {
      // 降级格式从 requiredFormats 摘除:烟测/满意度按"实际承诺"验收,降级事实单独留痕
      for (const degraded of degradedFormats) {
        const at = requiredFormats.indexOf(degraded.ext);
        if (at >= 0) requiredFormats.splice(at, 1);
      }
      const notePath = join(dir, 'PDF降级说明.txt');
      writeFileSync(notePath, [
        '本次交付环境缺少可用的 Chromium/Chrome/Edge,以下 PDF 未生成:',
        ...degradedFormats.map((d) => `- ${d.name}:${d.reason}`),
        '',
        '可编辑源文件已完整交付,内容不受影响。',
        '安装 Chrome/Edge,或设置 AIOS_PDF_BROWSER_PATH 指向浏览器后重试即可生成 PDF。',
      ].join('\n'), 'utf8');
      files.push({ name: 'PDF降级说明.txt', path: notePath });
    }
    const sourceContent = [
      `# ${plan.goal}`,
      '',
      `> ${plan.understanding}`,
      '',
      '## Source Content',
      '',
      ...[...groups.entries()].flatMap(([name, parts]) => [
        `### ${name}`,
        '',
        parts.join('\n\n'),
        '',
      ]),
    ].join('\n');
    emit({ type: 'result.step', stage: 'write', message: 'Writing source content', detail: 'source_content.md' });
    const sourceContentPath = join(dir, 'source_content.md');
    writeFileSync(sourceContentPath, sourceContent, 'utf8');
    files.push({ name: 'source_content.md', path: sourceContentPath });
    if (isOfficeDelivery(files)) {
      emit({ type: 'result.step', stage: 'quality', message: 'Verifying Office delivery quality' });
    }
    const quality = isOfficeDelivery(files)
      ? await buildOfficeQualityArtifacts(plan.goal, files, dir, freshness.freshness_verified)
      : undefined;
    if (quality) {
      emit({
        type: 'result.step',
        stage: 'quality',
        message: 'Office quality verified',
        detail: `${quality.manifest.status}:${quality.manifest.score}`,
        ok: quality.manifest.status === 'pass',
      });
    }
    if (quality) files.push(...quality.files);
    const primary = primaryFileName(files, requiredFormats);
    const deliveryManifestPath = join(dir, 'delivery_manifest.json');
    const filesForReadme = [...files, { name: 'delivery_manifest.json', path: deliveryManifestPath }];
    const editableSourceNames = filesForReadme
      .filter((f) => isEditableOfficeExt(extOf(f.name)))
      .map((f) => f.name);
    const qualityWarning = quality && quality.manifest.status !== 'pass'
      ? `## 需返修\n\n- Office 质量状态:${quality.manifest.status}\n- 质量分:${quality.manifest.score}\n- 请先查看 office_quality_manifest.json / OFFICE_DELIVERY_CHECKLIST.md,修复失败项后再对外发送。\n\n`
      : '';
    let readme =
      `# ${plan.goal}\n\n> ${plan.understanding}\n\n## 使用说明\n\n` +
      `- 优先打开: ${primary}\n` +
      `- 源文件可继续编辑;若包含 PDF,PDF 适合发送/打印,源文件适合修改复用。\n` +
      `- 需要继续修改内容时,可先看 source_content.md;需要机器可读交付清单时,看 delivery_manifest.json。\n` +
      `- 若数据/价格/行情类交付被标记为需修复,请先看 freshness_summary / sources / data 底稿。\n\n` +
      `## 修改说明\n\n` +
      `- 可编辑源文件: ${editableSourceNames.length ? editableSourceNames.join('、') : '无'}\n` +
      `- 修改建议:优先改主文件 ${primary};source_content.md 是内容底稿,delivery_manifest.json 是验收清单。\n` +
      `- 对外发送:如有 PDF,优先发送 PDF;如需继续协作,发送可编辑源文件。\n\n` +
      qualityWarning +
      (quality ? `## 质量验收\n\n- 质量分: ${quality.manifest.score}\n- 状态: ${quality.manifest.status}\n- 详见: office_quality_manifest.json / OFFICE_DELIVERY_CHECKLIST.md\n\n` : '') +
      `## 执行摘要\n\n${sum}\n\n## 交付文件\n` +
      filesForReadme.map((f) => `- ${f.name}`).join('\n') + '\n';
    const readmePath = join(dir, 'README.md');
    writeFileSync(readmePath, readme, 'utf8');
    files.unshift({ name: 'README.md', path: readmePath });
    const finalFiles = [...files, { name: 'delivery_manifest.json', path: deliveryManifestPath }];
    writeFileSync(deliveryManifestPath, '', 'utf8');
    let manifestFiles = finalFiles.map((f) => manifestFileEntry(f, primary, deliveryManifestPath));
    let smoke = deliverySmoke(manifestFiles, primary, requiredFormats, quality, freshness);
    const deliveryCompliance: 'pass' | 'fail' = failed.length || smoke.status === 'fail' || (quality && quality.manifest.status !== 'pass') ? 'fail' : 'pass';
    const taskSatisfaction = buildTaskSatisfaction(requiredFormats, deliveryCompliance, smoke, quality, freshness, editableSourceNames, failed);
    const satisfactionBlock =
      `## Task 满意度\n\n` +
      `- 分数: ${taskSatisfaction.score}/100\n` +
      `- 判断: ${taskSatisfaction.band}\n` +
      `- First-Pass Usable: ${taskSatisfaction.first_pass_usable ? '是' : '否'}\n` +
      `- 反馈选项: ${taskSatisfaction.feedback_options.join(' / ')}\n\n`;
    readme = readme.replace('## 执行摘要', `${satisfactionBlock}## 执行摘要`);
    writeFileSync(readmePath, readme, 'utf8');
    manifestFiles = finalFiles.map((f) => manifestFileEntry(f, primary, deliveryManifestPath));
    smoke = deliverySmoke(manifestFiles, primary, requiredFormats, quality, freshness);
    emit({
      type: 'result.step',
      stage: 'smoke',
      message: 'Smoke checking deliverable files',
      detail: smoke.status,
      ok: smoke.status !== 'fail',
    });
    emit({ type: 'result.step', stage: 'write', message: 'Writing delivery manifest', detail: 'delivery_manifest.json' });
    writeFileSync(deliveryManifestPath, JSON.stringify({
      schema: 'aios.delivery_manifest.v1',
      generated_at: new Date().toISOString(),
      goal: plan.goal,
      understanding: plan.understanding,
      primary,
      status: deliveryManifestStatus(deliveryCompliance, smoke, quality, taskSatisfaction),
      required_formats: requiredFormats,
      format_contract: {
        requested_formats: requiredFormats,
        primary_format: primaryFormat,
        html_artifact_allowed: requiredFormats.length === 0,
        compliance: deliveryCompliance,
      },
      editability: {
        primary_is_editable: isEditableOfficeExt(extOf(primary)),
        editable_sources: editableSourceNames,
        source_content_path: 'source_content.md',
      },
      source_content: 'source_content.md',
      smoke,
      freshness: {
        verified: freshness.freshness_verified,
        summary_path: freshness.freshness_summary ? 'freshness_summary.json' : null,
        sources_path: freshness.sources_path ? 'sources.jsonl' : null,
        data_path: freshness.data_path ? 'data.csv' : null,
      },
      office_quality: quality ? {
        score: quality.manifest.score,
        status: quality.manifest.status,
        manifest_path: 'office_quality_manifest.json',
        checklist_path: 'OFFICE_DELIVERY_CHECKLIST.md',
      } : null,
      task_satisfaction: taskSatisfaction,
      files: manifestFiles,
    }, null, 2), 'utf8');
    files.push({ name: 'delivery_manifest.json', path: deliveryManifestPath });
    return {
      goal: plan.goal,
      understanding: plan.understanding,
      markdown: readme,
      results,
      ms,
      dir,
      files,
      freshness_verified: freshness.freshness_verified,
      freshness_summary: freshness.freshness_summary,
      sources_path: freshness.sources_path,
      data_path: freshness.data_path,
      evidence_manifest: freshness.evidence_manifest,
      office_quality_manifest: quality ? join(dir, 'office_quality_manifest.json') : undefined,
      delivery_manifest: deliveryManifestPath,
      task_satisfaction: taskSatisfaction,
    };
  }

  const summary = await execSummary(plan.goal, ok);
  const summaryBlock = summary ? `## 执行摘要\n\n${summary}\n\n---\n\n` : '';

  const body = ok.map((r) => `## ${r.title}\n\n${r.output}`).join('\n\n---\n\n');
  const failNote = failed.length
    ? `\n\n---\n\n> ⚠️ ${failed.length} 个子任务执行失败:${failed.map((f) => `${f.title}(${f.error})`).join('、')}`
    : '';

  const markdown =
`# ${plan.goal}

> ${plan.understanding}
> — AIOS 自动拆解为 ${plan.subtasks.length} 个子任务并交付

${summaryBlock}${body}${failNote}
`;

  return { goal: plan.goal, understanding: plan.understanding, markdown, results, ms };
}
