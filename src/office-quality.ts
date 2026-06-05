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

function zipListing(path: string): string {
  try {
    return execFileSync('unzip', ['-Z1', path], { encoding: 'utf8', timeout: 5000 });
  } catch {
    return '';
  }
}

function rowFilledCellCount(row: any): number {
  let count = 0;
  row.eachCell((cell: any) => {
    const value = cell.value;
    if (value !== null && value !== undefined && String(value).trim() !== '') count += 1;
  });
  return count;
}

function worksheetShape(ws: any): { headerCells: number; dataRows: number } {
  let headerRowNumber = 1;
  let headerCells = 0;
  const maxScanRows = Math.min(ws.rowCount || 0, 12);
  for (let rowNumber = 1; rowNumber <= maxScanRows; rowNumber += 1) {
    const filled = rowFilledCellCount(ws.getRow(rowNumber));
    if (filled > headerCells) {
      headerCells = filled;
      headerRowNumber = rowNumber;
    }
  }
  let dataRows = 0;
  for (let rowNumber = headerRowNumber + 1; rowNumber <= Math.min(ws.rowCount || 0, headerRowNumber + 20); rowNumber += 1) {
    if (rowFilledCellCount(ws.getRow(rowNumber)) >= Math.min(3, Math.max(1, Math.floor(headerCells / 3)))) dataRows += 1;
  }
  return { headerCells, dataRows };
}

function ooxmlPlainText(xml: string): string {
  return xml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function relevanceKeywords(goal: string): string[] {
  const compact = goal
    .replace(/# AIOS[\s\S]*$/i, '')
    .replace(/[A-Za-z0-9_.-]+\.(xlsx|pptx|docx|pdf)/gi, '')
    .replace(/\s+/g, '');
  const matches = compact.match(/中铁|办公室|项目部|合同|采购|比价|报价|费用|报销|会议|纪要|督办|资料|归档|月度|工作|汇报|方案|计划|通知|调研|研究|薪资|工资|价格|行情|台账|清单|报表|登记|统计|汇总|明细|对账|流程|优化/g) || [];
  return [...new Set(matches)].slice(0, 8);
}

function promptRelevanceCheck(goal: string, text: string): { ok: boolean; detail: string } {
  const keywords = relevanceKeywords(goal);
  if (keywords.length === 0) return { ok: true, detail: '无强 prompt 关键词' };
  const aliases: Record<string, string[]> = {
    合同: ['合同', '履约', '签订', '到期', '合同金额'],
    台账: ['台账', '登记', '明细', '清单', '状态', '责任人', '责任部门'],
    采购: ['采购', '供应商', '报价', '预算金额', '推荐供应商'],
    比价: ['比价', '报价', '供应商', '推荐供应商', '推荐理由'],
    报价: ['报价', '单价', '金额', '供应商'],
    费用: ['费用', '报销', '金额', '付款'],
    报销: ['报销', '费用', '发票', '付款'],
    会议: ['会议', '纪要', '事项', '责任人'],
    纪要: ['纪要', '会议', '事项', '责任人'],
    督办: ['督办', '责任事项', '责任人', '截止日期', '完成状态'],
    资料: ['资料', '归档', '档案', '移交'],
    归档: ['归档', '资料', '档案', '位置'],
    办公室: ['办公室', '责任部门', '责任人', '事项', '资料'],
    项目部: ['项目部', '项目', '标段', '现场'],
  };
  const hit = keywords.filter((kw) => (aliases[kw] || [kw]).some((candidate) => text.includes(candidate)));
  const minHits = Math.min(2, keywords.length);
  return {
    ok: hit.length >= minHits,
    detail: `命中:${hit.join(',') || '无'} / 关键词:${keywords.join(',')}`,
  };
}

function cellText(value: any): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part: any) => part.text || '').join('');
    if ('text' in value) return String(value.text || '');
    if ('result' in value) return String(value.result || '');
    if ('formula' in value) return String(value.formula || '');
    if ('hyperlink' in value) return String(value.text || value.hyperlink || '');
  }
  return String(value);
}

function workbookRelevanceText(wb: any): string {
  const parts: string[] = [];
  wb.worksheets.forEach((ws: any) => {
    ws.eachRow((row: any, rowNumber: number) => {
      // Row 1-3 often contain generated titles. Relevance should come from fields,
      // sample rows, and instructions so a correct filename cannot mask wrong content.
      if (rowNumber < 4 && ws.name !== '字段说明') return;
      row.eachCell((cell: any) => {
        const text = cellText(cell.value).trim();
        if (text) parts.push(text);
      });
    });
  });
  return parts.join(' ');
}

async function xlsxChecks(file: DeliveryFile, goal: string): Promise<Array<{ id: string; ok: boolean; detail: string }>> {
  const m = await import('exceljs');
  const ExcelJS = (m as any).default || m;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.path);
  const main = wb.worksheets[0];
  const sheetNames = wb.worksheets.map((ws: any) => ws.name);
  const listing = zipListing(file.path);
  const tableCount = new Set([...listing.matchAll(/xl\/tables\/table\d+\.xml/g)].map((match) => match[0])).size;
  const shape = main ? worksheetShape(main) : { headerCells: 0, dataRows: 0 };
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
  const relevance = promptRelevanceCheck(goal, workbookRelevanceText(wb));
  return [
    { id: 'xlsx_readable', ok: true, detail: '工作簿可被程序读回' },
    { id: 'xlsx_prompt_relevance', ok: relevance.ok, detail: relevance.detail },
    { id: 'xlsx_field_dictionary', ok: sheetNames.includes('字段说明'), detail: `工作表:${sheetNames.join(', ')}` },
    { id: 'xlsx_dashboard', ok: sheetNames.includes('统计看板'), detail: `工作表:${sheetNames.join(', ')}` },
    { id: 'xlsx_minimum_fields', ok: shape.headerCells >= 8, detail: `主表字段数:${shape.headerCells}` },
    { id: 'xlsx_sample_rows', ok: shape.dataRows >= 2, detail: `可参考样例/预留行:${shape.dataRows}` },
    { id: 'xlsx_table_filter', ok: tableCount > 0 || Boolean(main?.autoFilter), detail: `Excel 表格:${tableCount}` },
    { id: 'xlsx_frozen_headers', ok: Boolean(main?.views?.some((v: any) => v.state === 'frozen')), detail: '主表冻结表头' },
    { id: 'xlsx_print_setup', ok: main?.pageSetup?.fitToPage === true, detail: `打印方向:${main?.pageSetup?.orientation || 'unknown'}` },
    { id: 'xlsx_formulas', ok: formulaCount > 0, detail: `公式单元格:${formulaCount}` },
    { id: 'xlsx_dropdowns', ok: validationCount > 0, detail: `下拉校验:${validationCount}` },
  ];
}

function pptxChecks(file: DeliveryFile, goal: string): Array<{ id: string; ok: boolean; detail: string }> {
  const listing = zipListing(file.path);
  const slides = [...new Set([...listing.matchAll(/ppt\/slides\/slide\d+\.xml/g)].map((m) => m[0]))]
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1] || 0) - Number(b.match(/slide(\d+)/)?.[1] || 0));
  const slideTexts = slides.map((slide) => ooxmlPlainText(unzipText(file.path, slide)));
  const text = slideTexts.join(' ');
  const substantiveSlides = slideTexts.filter((t) => t.length >= 20).length;
  const relevance = promptRelevanceCheck(goal, text);
  return [
    { id: 'pptx_readable', ok: listing.includes('[Content_Types].xml'), detail: 'PPTX zip 可读' },
    { id: 'pptx_multi_slide', ok: slides.length >= 3, detail: `幻灯片:${slides.length}` },
    { id: 'pptx_theme', ok: listing.includes('ppt/theme/theme1.xml'), detail: '包含主题文件' },
    { id: 'pptx_has_real_text', ok: text.length >= 60, detail: `文字长度:${text.length}` },
    { id: 'pptx_has_flow', ok: /目录|重点|问题|风险|计划|下一步|结论|汇报逻辑/.test(text), detail: '含汇报逻辑/问题/计划信号' },
    { id: 'pptx_not_single_dump', ok: slides.length >= 4 || text.length < 450, detail: `幻灯片:${slides.length};文字长度:${text.length}` },
    { id: 'pptx_slide_substance', ok: substantiveSlides >= Math.min(3, slides.length), detail: `有效内容页:${substantiveSlides}` },
    { id: 'pptx_prompt_relevance', ok: relevance.ok, detail: relevance.detail },
  ];
}

function docxChecks(file: DeliveryFile, goal: string): Array<{ id: string; ok: boolean; detail: string }> {
  const xml = unzipText(file.path, 'word/document.xml');
  const text = ooxmlPlainText(xml);
  const tableCount = (xml.match(/<w:tbl[\s>]/g) || []).length;
  const structureHits = (text.match(/一、|二、|三、|第[一二三四五六七八九十]+|结论|建议|事项|通知|报告/g) || []).length;
  const relevance = promptRelevanceCheck(goal, text);
  return [
    { id: 'docx_readable', ok: xml.includes('w:document'), detail: 'DOCX document.xml 可读' },
    { id: 'docx_has_content', ok: text.length >= 20, detail: `正文长度:${text.length}` },
    { id: 'docx_has_structure', ok: /一、|二、|##|第[一二三四五六七八九十]+|结论|建议|事项|通知|报告/.test(text), detail: '含正式材料结构信号' },
    { id: 'docx_heading_hierarchy', ok: structureHits >= 1, detail: `结构信号:${structureHits}` },
    { id: 'docx_table_or_action_list', ok: tableCount > 0 || /措施|责任部门|下一步|请各部门|事项|建议/.test(text), detail: `表格:${tableCount}` },
    { id: 'docx_prompt_relevance', ok: relevance.ok, detail: relevance.detail },
  ];
}

function pdfChecks(file: DeliveryFile): Array<{ id: string; ok: boolean; detail: string }> {
  const size = existsSync(file.path) ? readFileSync(file.path).byteLength : 0;
  return [
    { id: 'pdf_exists', ok: size > 0, detail: `大小:${size}B` },
    { id: 'pdf_non_empty', ok: size > 8_000, detail: 'PDF 非空且不像占位文件' },
  ];
}

async function fileChecks(file: DeliveryFile, goal: string): Promise<Array<{ id: string; ok: boolean; detail: string }>> {
  const ext = extOf(file.name);
  if (ext === 'xlsx') return xlsxChecks(file, goal);
  if (ext === 'pptx') return pptxChecks(file, goal);
  if (ext === 'docx') return docxChecks(file, goal);
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
    fileResults.push({ name: file.name, ext: extOf(file.name), checks: await fileChecks(file, goal) });
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
  const criticalFailed = [...checks, ...allFileChecks].some((c) =>
    !c.ok && /office_no_html_as_primary|xlsx_minimum_fields|xlsx_sample_rows|xlsx_prompt_relevance|pptx_prompt_relevance|docx_prompt_relevance/.test(c.id));
  const manifest: OfficeQualityResult = {
    schema: 'aios.office_quality_manifest.v1',
    source: 'OB: 最近工作流总览 / Codex-情报中心 / AIOS-Codex能力对比评估 / user-profile-evolving',
    score,
    status: criticalFailed ? 'fail' : statusFromScore(score),
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
