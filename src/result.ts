// Result Engine —— 把多个 Agent 的产出整合成一份最终交付物。
// 块3.5: 先调 LLM 生成全局"执行摘要",再拼接各部分 → 从"拼接"升级为"整合报告"。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { llm, CONFIG } from './config';
import { extractHtml, writeArtifact, sanitizeName, writeDeliverable } from './build';
import { buildFreshnessArtifacts, type FreshnessSummary } from './freshness';
import { buildOfficeQualityArtifacts, isOfficeDelivery } from './office-quality';
import type { AgentResult, Deliverable, Plan } from './types';

function officeFormatsFromGoal(goal: string): string[] {
  const match = goal.match(/"formats"\s*:\s*\[([\s\S]*?)\]/);
  if (match) {
    return [...new Set([...match[1]!.matchAll(/"([a-z0-9]+)"/gi)]
      .map((m) => m[1]!.toLowerCase())
      .filter((ext) => ['docx', 'pdf', 'xlsx', 'pptx', 'md'].includes(ext)))];
  }
  const compact = goal.toLowerCase().replace(/\s+/g, '');
  const formats: string[] = [];
  if (/pptx?|powerpoint|幻灯片|演示/.test(compact)) formats.push('pptx');
  if (/excel|xlsx|表格|台账|清单|报表/.test(compact)) formats.push('xlsx');
  if (/word|docx/.test(compact)) formats.push('docx');
  if (/pdf/.test(compact)) formats.push('pdf');
  return [...new Set(formats)];
}

function extOf(name: string): string {
  return (name.split('.').pop() || '').toLowerCase();
}

function withoutExt(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function defaultOutFileForFormat(goal: string, ext: string): string {
  const compact = goal.replace(/\s+/g, '');
  const base = /报销|费用|发票|票据/i.test(compact)
    ? '费用报销台账模板'
    : /会议|纪要|督办|待办|闭环/i.test(compact)
      ? '会议事项跟踪清单'
      : /合同/i.test(compact)
        ? '合同台账模板'
        : /台账|excel|xlsx|表格|清单|报表/i.test(compact)
          ? '办公台账模板'
          : /ppt|pptx|汇报|演示/i.test(compact)
            ? '汇报材料'
            : /报告|调研|研究/i.test(compact)
              ? '调研报告'
              : 'AIOS交付物';
  return `${base}.${ext}`;
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
  if (['sources.jsonl', 'data.csv', 'freshness_summary.json', 'evidence_manifest.json'].includes(name)) return 'evidence';
  return 'support';
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

function deliverySmoke(
  entries: DeliveryManifestFile[],
  primary: string,
  requiredFormats: string[],
  quality: Awaited<ReturnType<typeof buildOfficeQualityArtifacts>> | undefined,
  freshness: Awaited<ReturnType<typeof buildFreshnessArtifacts>>,
) {
  const primaryEntry = entries.find((f) => f.name === primary);
  const sourceEntry = entries.find((f) => f.name === 'source_content.md');
  const nonSelfEntries = entries.filter((f) => f.role !== 'manifest');
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
      id: 'files_integrity',
      ok: nonSelfEntries.every((f) => f.exists && f.bytes > 0 && /^[a-f0-9]{64}$/.test(f.sha256 || '')),
      detail: `${nonSelfEntries.length} checked`,
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
  return [
    `本任务要求当前/最新数据，但 AIOS 没有拿到足够的可复核证据，因此本次交付标记为“需修复”，不会输出任何未经验证的具体价格。`,
    `核验状态：来源 ${summary.verified_source_count}/${summary.source_count} 通过 HTTP 校验；最新可解析日期：${summary.latest_date || '无'}；缺口：${gaps}。`,
    `下一步需要补充可访问的行业数据库/API/登录态，或由用户提供权威来源链接后重新生成。`,
  ].join('\n\n');
}

function freshnessRepairReport(goal: string, understanding: string, summary: FreshnessSummary): string {
  const gaps = summary.gaps.length ? summary.gaps.map((g) => `- ${g}`).join('\n') : '- 数据时效核验未通过';
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

export async function assemble(plan: Plan, results: AgentResult[], ms: number, outDir: string): Promise<Deliverable> {
  const requiredFormats = officeFormatsFromGoal(plan.goal);
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
    const freshness = await buildFreshnessArtifacts(plan.goal, ok, dir);
    const freshnessFailed = freshness.freshness_summary && !freshness.freshness_verified;
    const sum = freshnessFailed
      ? freshnessRepairSummary(plan.goal, freshness.freshness_summary!)
      : await execSummary(plan.goal, ok);
    files.push(...freshness.files);
    // 同名 outFile 的多个子任务 = 同一文件的多个部分,合并拼接成一个完整文件,避免互相覆盖丢内容
    const groups = new Map<string, string[]>();
    for (const r of deliverFiles) {
      const name = sanitizeName(fileOf(r)!);
      const part = freshnessFailed
        ? freshnessRepairReport(plan.goal, plan.understanding, freshness.freshness_summary!)
        : r.output;
      groups.set(name, [...(groups.get(name) || []), part]);
    }
    for (const [name, parts] of groups) {
      const content = parts.join('\n\n');
      const fp = await writeDeliverable(content, name, dir);
      files.push({ name, path: fp });
      for (const ext of requiredFormats) {
        if (ext === extOf(name)) continue;
        const extraName = sanitizeName(`${withoutExt(name)}.${ext}`);
        if (files.some((f) => f.name === extraName)) continue;
        const extraPath = await writeDeliverable(content, extraName, dir);
        files.push({ name: extraName, path: extraPath });
      }
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
    const sourceContentPath = join(dir, 'source_content.md');
    writeFileSync(sourceContentPath, sourceContent, 'utf8');
    files.push({ name: 'source_content.md', path: sourceContentPath });
    const quality = isOfficeDelivery(files)
      ? await buildOfficeQualityArtifacts(plan.goal, files, dir, freshness.freshness_verified)
      : undefined;
    if (quality) files.push(...quality.files);
    const primary = primaryFileName(files, requiredFormats);
    const deliveryManifestPath = join(dir, 'delivery_manifest.json');
    const filesForReadme = [...files, { name: 'delivery_manifest.json', path: deliveryManifestPath }];
    const readme =
      `# ${plan.goal}\n\n> ${plan.understanding}\n\n## 使用说明\n\n` +
      `- 优先打开: ${primary}\n` +
      `- 源文件可继续编辑;若包含 PDF,PDF 适合发送/打印,源文件适合修改复用。\n` +
      `- 需要继续修改内容时,可先看 source_content.md;需要机器可读交付清单时,看 delivery_manifest.json。\n` +
      `- 若数据/价格/行情类交付被标记为需修复,请先看 freshness_summary / sources / data 底稿。\n\n` +
      (quality ? `## 质量验收\n\n- 质量分: ${quality.manifest.score}\n- 状态: ${quality.manifest.status}\n- 详见: office_quality_manifest.json / OFFICE_DELIVERY_CHECKLIST.md\n\n` : '') +
      `## 执行摘要\n\n${sum}\n\n## 交付文件\n` +
      filesForReadme.map((f) => `- ${f.name}`).join('\n') + '\n';
    const readmePath = join(dir, 'README.md');
    writeFileSync(readmePath, readme, 'utf8');
    files.unshift({ name: 'README.md', path: readmePath });
    const finalFiles = [...files, { name: 'delivery_manifest.json', path: deliveryManifestPath }];
    writeFileSync(deliveryManifestPath, '', 'utf8');
    const manifestFiles = finalFiles.map((f) => manifestFileEntry(f, primary, deliveryManifestPath));
    const smoke = deliverySmoke(manifestFiles, primary, requiredFormats, quality, freshness);
    writeFileSync(deliveryManifestPath, JSON.stringify({
      schema: 'aios.delivery_manifest.v1',
      generated_at: new Date().toISOString(),
      goal: plan.goal,
      understanding: plan.understanding,
      primary,
      required_formats: requiredFormats,
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
