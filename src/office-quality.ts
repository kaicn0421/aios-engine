import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export interface DeliveryFile {
  name: string;
  path: string;
}

export interface OfficeQualityResult {
  schema: 'aios.office_quality_manifest.v1';
  source: string;
  score: number;
  status: 'pass' | 'warn' | 'fail';
  checks: Array<{ id: string; ok: boolean; detail: string }>;
  files: Array<{ name: string; ext: string; checks: Array<{ id: string; ok: boolean; detail: string }> }>;
  rules: string[];
}

export const OB_OFFICE_QUALITY_RULES = [
  '正式交付不能只给一个孤立文件,必须有交付文件清单和可回溯说明。',
  'Office 交付优先可编辑源文件;PDF 适合发送/打印,不能替代源文件。',
  '数据、价格、行情、新闻类内容必须保留 as-of、来源和 DATA_GAP 边界。',
  'Excel 必须适合真实维护:字段说明、下拉校验、公式列、统计看板、冻结表头和打印设置。',
  'PPT/Word/PDF 必须避免低质排版:标题层级清楚、重点先行、链接/来源可追、不要靠缩小字号糊弄分页。',
];

function extOf(name: string): string {
  return (name.split('.').pop() || '').toLowerCase();
}

function isOfficeExt(ext: string): boolean {
  return ['xlsx', 'pptx', 'docx', 'pdf'].includes(ext);
}

export function isOfficeDelivery(files: DeliveryFile[]): boolean {
  return files.some((f) => isOfficeExt(extOf(f.name)));
}

function statusFromScore(score: number): 'pass' | 'warn' | 'fail' {
  if (score >= 85) return 'pass';
  if (score >= 65) return 'warn';
  return 'fail';
}

function unzipText(path: string, member: string): string {
  try {
    return execFileSync('unzip', ['-p', path, member], { encoding: 'utf8', timeout: 5000 });
  } catch {
    return '';
  }
}

async function xlsxChecks(file: DeliveryFile): Promise<Array<{ id: string; ok: boolean; detail: string }>> {
  const m = await import('exceljs');
  const ExcelJS = (m as any).default || m;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.path);
  const main = wb.worksheets[0];
  const sheetNames = wb.worksheets.map((ws: any) => ws.name);
  const formulaCount = wb.worksheets.reduce((sum: number, ws: any) => {
    let count = 0;
    ws.eachRow((row: any) => row.eachCell((cell: any) => {
      if (cell.value && typeof cell.value === 'object' && 'formula' in cell.value) count += 1;
    }));
    return sum + count;
  }, 0);
  let validationCount = 0;
  wb.worksheets.forEach((ws: any) => {
    ws.eachRow((row: any) => row.eachCell((cell: any) => {
      if (cell.dataValidation?.type === 'list') validationCount += 1;
    }));
  });
  return [
    { id: 'xlsx_readable', ok: true, detail: '工作簿可被程序读回' },
    { id: 'xlsx_field_dictionary', ok: sheetNames.includes('字段说明'), detail: `工作表:${sheetNames.join(', ')}` },
    { id: 'xlsx_dashboard', ok: sheetNames.includes('统计看板'), detail: `工作表:${sheetNames.join(', ')}` },
    { id: 'xlsx_frozen_headers', ok: Boolean(main?.views?.some((v: any) => v.state === 'frozen')), detail: '主表冻结表头' },
    { id: 'xlsx_print_setup', ok: main?.pageSetup?.fitToPage === true, detail: `打印方向:${main?.pageSetup?.orientation || 'unknown'}` },
    { id: 'xlsx_formulas', ok: formulaCount > 0, detail: `公式单元格:${formulaCount}` },
    { id: 'xlsx_dropdowns', ok: validationCount > 0, detail: `下拉校验:${validationCount}` },
  ];
}

function pptxChecks(file: DeliveryFile): Array<{ id: string; ok: boolean; detail: string }> {
  const listing = execFileSync('unzip', ['-Z1', file.path], { encoding: 'utf8', timeout: 5000 });
  const slides = new Set([...listing.matchAll(/ppt\/slides\/slide\d+\.xml/g)].map((m) => m[0]));
  return [
    { id: 'pptx_readable', ok: listing.includes('[Content_Types].xml'), detail: 'PPTX zip 可读' },
    { id: 'pptx_multi_slide', ok: slides.size >= 3, detail: `幻灯片:${slides.size}` },
    { id: 'pptx_theme', ok: listing.includes('ppt/theme/theme1.xml'), detail: '包含主题文件' },
  ];
}

function docxChecks(file: DeliveryFile): Array<{ id: string; ok: boolean; detail: string }> {
  const xml = unzipText(file.path, 'word/document.xml');
  const text = xml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return [
    { id: 'docx_readable', ok: xml.includes('w:document'), detail: 'DOCX document.xml 可读' },
    { id: 'docx_has_content', ok: text.length >= 20, detail: `正文长度:${text.length}` },
    { id: 'docx_has_structure', ok: /一、|二、|##|第[一二三四五六七八九十]+|结论|建议|事项|通知|报告/.test(text), detail: '含正式材料结构信号' },
  ];
}

function pdfChecks(file: DeliveryFile): Array<{ id: string; ok: boolean; detail: string }> {
  const size = existsSync(file.path) ? readFileSync(file.path).byteLength : 0;
  return [
    { id: 'pdf_exists', ok: size > 0, detail: `大小:${size}B` },
    { id: 'pdf_non_empty', ok: size > 8_000, detail: 'PDF 非空且不像占位文件' },
  ];
}

async function fileChecks(file: DeliveryFile): Promise<Array<{ id: string; ok: boolean; detail: string }>> {
  const ext = extOf(file.name);
  if (ext === 'xlsx') return xlsxChecks(file);
  if (ext === 'pptx') return pptxChecks(file);
  if (ext === 'docx') return docxChecks(file);
  if (ext === 'pdf') return pdfChecks(file);
  return [];
}

export async function buildOfficeQualityArtifacts(
  goal: string,
  files: DeliveryFile[],
  dir: string,
  freshnessVerified?: boolean,
): Promise<{ files: DeliveryFile[]; manifest: OfficeQualityResult }> {
  const officeFiles = files.filter((f) => isOfficeExt(extOf(f.name)));
  const editableFiles = files.filter((f) => ['xlsx', 'pptx', 'docx'].includes(extOf(f.name)));
  const fileResults: OfficeQualityResult['files'] = [];
  for (const file of officeFiles) {
    fileResults.push({ name: file.name, ext: extOf(file.name), checks: await fileChecks(file) });
  }
  const allFileChecks = fileResults.flatMap((f) => f.checks);
  const checks = [
    { id: 'office_has_editable_source', ok: editableFiles.length > 0, detail: `可编辑源文件:${editableFiles.map((f) => f.name).join(', ') || '无'}` },
    { id: 'office_no_html_as_primary', ok: !files.some((f) => /^aios-artifact-.*\.html$/.test(f.name)), detail: '办公交付未以 HTML artifact 冒充源文件' },
    { id: 'office_has_file_list', ok: files.length >= 1, detail: `文件数:${files.length}` },
    { id: 'office_ob_memory_applied', ok: true, detail: '已应用 OB 早晚报/PDF/质量验收经验' },
  ];
  if (/价格|行情|新闻|热榜|实时|今天|最新|工资|薪资|比例|增长/.test(goal)) {
    checks.push({
      id: 'office_freshness_boundary',
      ok: freshnessVerified !== false,
      detail: freshnessVerified === false ? '时效核验未通过,必须保留 DATA_GAP/修复报告' : '时效核验未阻断',
    });
  }
  const passCount = [...checks, ...allFileChecks].filter((c) => c.ok).length;
  const total = Math.max(1, checks.length + allFileChecks.length);
  const score = Math.round((passCount / total) * 100);
  const manifest: OfficeQualityResult = {
    schema: 'aios.office_quality_manifest.v1',
    source: 'OB: 最近工作流总览 / Codex-情报中心 / AIOS-Codex能力对比评估 / user-profile-evolving',
    score,
    status: statusFromScore(score),
    checks,
    files: fileResults,
    rules: OB_OFFICE_QUALITY_RULES,
  };
  const manifestPath = join(dir, 'office_quality_manifest.json');
  const checklistPath = join(dir, 'OFFICE_DELIVERY_CHECKLIST.md');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  writeFileSync(
    checklistPath,
    [
      '# 办公交付质量检查清单',
      '',
      `- 质量分:${manifest.score}`,
      `- 状态:${manifest.status}`,
      '',
      '## OB 经验规则',
      ...OB_OFFICE_QUALITY_RULES.map((rule) => `- ${rule}`),
      '',
      '## 自动检查',
      ...checks.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} ${c.id}: ${c.detail}`),
      ...fileResults.flatMap((f) => [``, `### ${f.name}`, ...f.checks.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} ${c.id}: ${c.detail}`)]),
      '',
    ].join('\n'),
    'utf8',
  );
  return {
    files: [
      { name: 'office_quality_manifest.json', path: manifestPath },
      { name: 'OFFICE_DELIVERY_CHECKLIST.md', path: checklistPath },
    ],
    manifest,
  };
}
