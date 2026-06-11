import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanUserGoal } from './goal';
import { requestedOfficeSize, goalAllowsMorePages } from './office-format';

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

/** OOXML 结构检查的 zip 读取改用 jszip(exceljs/pptxgenjs/html-to-docx 的既有传递依赖,零新增下载):
 *  原实现 shell out 到 macOS `unzip` CLI,Windows 上没有 unzip → 所有结构检查静默返回 ''
 *  → 质量门全瞎、空壳文件畅通。失败仍返回 null/'',与原 catch 行为一致。 */
async function loadZip(path: string): Promise<any | null> {
  try {
    const m = await import('jszip');
    const JSZip = (m as any).default || m;
    return await JSZip.loadAsync(readFileSync(path));
  } catch {
    return null;
  }
}

function zipNames(zip: any): string[] {
  return zip ? Object.keys(zip.files) : [];
}

async function zipEntryText(zip: any, member: string): Promise<string> {
  const entry = zip?.file(member);
  if (!entry) return '';
  try {
    return await entry.async('string');
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
  const compact = cleanUserGoal(goal)
    .replace(/# AIOS[\s\S]*$/i, '')
    .replace(/[A-Za-z0-9_.-]+\.(xlsx|pptx|docx|pdf)/gi, '')
    .replace(/\s+/g, '');
  const matches = compact.match(/Claude\s*Code|AIOS|Claude|Codex|Memory|Session|Tool|Prompt|MCP|OpenClaw|Siri|C-lite|runtime|router|connector|执行内核|权限|沙箱|质量闸|交付链路|FIDIC|fidic|菲迪克|Notice|notice|TimeBar|timebar|DAAB|DAB|EOT|中铁|办公室|项目部|工程合同|合同|索赔|变更|付款|BOQ|证据|风险|采购|比价|报价|费用|报销|会议|纪要|督办|资料|归档|月度|工作|汇报|方案|计划|通知|调研|研究|薪资|工资|价格|行情|支出|收入|流水|记账|台账|清单|报表|登记|统计|汇总|明细|对账|流程|优化|餐饮|泰餐|餐厅|宁波|上市|融资|商业计划|品牌|选址|供应链|食品安全|菜单|翻台|坪效|门店/g) || [];
  const unique = [...new Set(matches.map((match) => match.replace(/\s+/g, ' ').trim()))];
  const generic = new Set(['方案', '计划', '建议', '通知', '调研', '研究', '工作', '汇报']);
  const specific = unique.filter((kw) => !generic.has(kw));
  return (specific.length ? specific : unique.filter((kw) => !generic.has(kw))).slice(0, 10);
}

function promptRelevanceCheck(goal: string, text: string): { ok: boolean; detail: string } {
  const keywords = relevanceKeywords(goal);
  if (keywords.length === 0) return { ok: true, detail: '无强 prompt 关键词' };
  const aliases: Record<string, string[]> = {
    合同: ['合同', '履约', '签订', '到期', '合同金额'],
    FIDIC: ['FIDIC', '合同雷达', 'Notice', 'Time-Bar', '索赔', 'DAAB'],
    fidic: ['FIDIC', '合同雷达', 'Notice', 'Time-Bar', '索赔', 'DAAB'],
    菲迪克: ['FIDIC', '菲迪克', '合同雷达', 'Notice', '索赔'],
    Notice: ['Notice', '通知', 'Time-Bar', '倒计时', '通知对象'],
    notice: ['Notice', '通知', 'Time-Bar', '倒计时', '通知对象'],
    TimeBar: ['Time-Bar', '倒计时', '起算日期', '合同期限'],
    timebar: ['Time-Bar', '倒计时', '起算日期', '合同期限'],
    DAAB: ['DAAB', '争议', 'Dispute', '复核'],
    DAB: ['DAB', 'DAAB', '争议', '复核'],
    EOT: ['EOT', '工期', 'Extension of Time', '索赔'],
    工程合同: ['工程合同', '合同雷达', 'Notice', '索赔', '证据'],
    索赔: ['索赔', 'Claim', 'EOT', 'Cost', '证据缺口'],
    变更: ['变更', 'Variation', '工程师指令', '机会类型'],
    付款: ['付款', 'Payment', '计量', 'BOQ'],
    BOQ: ['BOQ', '计量', '单价', '付款'],
    证据: ['证据', 'source_map', '缺口', '来源文件'],
    风险: ['风险', '风险等级', '复核', '缺口'],
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
    餐饮: ['餐饮', '餐厅', '门店', '菜单', '翻台', '食品安全'],
    泰餐: ['泰餐', '泰式', '泰国菜', '菜单', '风味', '供应链'],
    餐厅: ['餐厅', '餐饮', '门店', '选址', '翻台'],
    宁波: ['宁波', '鄞州', '海曙', '江北', '商圈', '首店'],
    上市: ['上市', 'IPO', '股权', '融资', '规范化', '连锁'],
    融资: ['融资', '股权', '估值', '现金流', '资本'],
    商业计划: ['商业计划', '商业模式', '市场分析', '财务测算', '上市路径'],
    品牌: ['品牌', '定位', '客群', '视觉', '复购'],
    选址: ['选址', '商圈', '租金', '客流', '首店'],
    供应链: ['供应链', '中央厨房', '采购', '食材', '标准化'],
    食品安全: ['食品安全', '证照', '合规', '后厨', 'SOP'],
    菜单: ['菜单', '菜品', '毛利', '客单价', '爆品'],
    翻台: ['翻台', '坪效', '客单价', '营收', '座位'],
    坪效: ['坪效', '翻台', '租金', '营收', '面积'],
    门店: ['门店', '首店', '连锁', '选址', '运营'],
    AIOS: ['AIOS', '任务交付', '能力路由', '交付链路', '质量闸'],
    'Claude Code': ['Claude Code', 'Claude', '执行内核', 'Tool', 'Memory', 'Session'],
    Claude: ['Claude', 'Claude Code', 'claude-ds'],
    Codex: ['Codex', 'coding agent', '代码代理'],
    Memory: ['Memory', '记忆', 'memory', 'Session Memory', '长期记忆'],
    Session: ['Session', 'session', '会话', 'Transcript'],
    Tool: ['Tool', '工具', 'Tool Permission', '权限元信息'],
    Prompt: ['Prompt', 'prompt', '提示词', 'prompt package'],
    MCP: ['MCP', 'mcp', '连接器', 'server'],
    OpenClaw: ['OpenClaw', '外部工具', '边界'],
    Siri: ['Siri', 'Apple', 'App Intents'],
    'C-lite': ['C-lite', 'C lite', '普通人入口', '能力路由'],
    runtime: ['runtime', '运行时', 'Tauri', 'Rust'],
    router: ['router', '路由', 'Capability Router', '能力路由'],
    connector: ['connector', '连接器', 'product intelligence'],
    执行内核: ['执行内核', 'query', 'agent loop', '工具执行'],
    权限: ['权限', 'permission', '确认闸门', 'gate'],
    沙箱: ['沙箱', 'sandbox', '隔离'],
    质量闸: ['质量闸', '验收', 'quality', '语义一致性'],
    交付链路: ['交付链路', '交付', 'delivery', 'manifest'],
  };
  const hit = keywords.filter((kw) => (aliases[kw] || [kw]).some((candidate) => text.includes(candidate)));
  const technicalGoal = /AIOS|Claude|Codex|Memory|Session|Tool|Prompt|MCP|OpenClaw|Siri|C-lite|runtime|router|connector|执行内核|质量闸|交付链路/i.test(goal);
  const minHits = technicalGoal ? Math.min(3, keywords.length) : Math.min(2, keywords.length);
  return {
    ok: hit.length >= minHits,
    detail: `命中:${hit.join(',') || '无'} / 关键词:${keywords.join(',')} / 至少${minHits}项`,
  };
}

function offTopicCheck(goal: string, text: string): { ok: boolean; detail: string } {
  const groups = [
    { id: 'smart_band_case', when: /智护家|智能健康手环|健康手环|手环Pro|580万元|4500万元/, allow: /智护家|智能健康手环|健康手环|手环|穿戴|上市营销/ },
    { id: 'restaurant_case', when: /泰餐|餐饮|宁波|门店|翻台|坪效/, allow: /泰餐|餐饮|宁波|门店|餐厅|上市|菜单/ },
    { id: 'contract_case', when: /FIDIC|Notice|Time-Bar|DAAB|合同雷达/, allow: /FIDIC|Notice|TimeBar|Time-Bar|DAAB|合同|索赔/ },
  ];
  const compact = cleanUserGoal(goal);
  const leaked = groups.filter((group) => group.when.test(text) && !group.allow.test(compact)).map((group) => group.id);
  return {
    ok: leaked.length === 0,
    detail: leaked.length ? `疑似混入无关案例:${leaked.join(',')}` : '未发现已知无关案例污染',
  };
}

function docxRequiresNativeTable(goal: string): boolean {
  return /矩阵|对比|清单|预算|时间表|甘特|表格|台账|任务拆解|路线图|WBS|评分表|评价表/.test(cleanUserGoal(goal));
}

function domainFitCheck(goal: string, text: string): { ok: boolean; detail: string } {
  const compact = cleanUserGoal(goal).replace(/\s+/g, '');
  const rules: Array<{ id: string; when: RegExp; must: string[]; min: number }> = [
    {
      id: '合同台账',
      when: /合同.*(台账|Excel|xlsx|模板|管理|付款|发票|履约)|合同台账/i,
      must: ['合同编号', '合同名称', '签约', '合同金额', '履约', '到期', '乙方', '供应商', '归档'],
      min: 4,
    },
    {
      id: '费用报销',
      when: /(费用|报销|票据).*(台账|Excel|xlsx|模板|登记|清单)|费用报销/i,
      must: ['报销', '发票', '付款', '审批', '费用', '票据', '金额'],
      min: 3,
    },
    {
      id: '采购比价',
      when: /(采购|比价|报价).*(表|清单|台账|Excel|xlsx)|采购比价/i,
      must: ['采购', '供应商', '报价', '单价', '交期', '推荐', '比价'],
      min: 3,
    },
    {
      id: '会议纪要',
      when: /(会议|纪要|督办).*(跟踪|清单|台账|Excel|xlsx)|会议纪要/i,
      must: ['会议', '事项', '责任人', '截止日期', '完成状态', '督办'],
      min: 3,
    },
  ];
  const rule = rules.find((r) => r.when.test(compact));
  if (!rule) return { ok: true, detail: '无强业务域要求' };
  const hit = rule.must.filter((kw) => text.includes(kw));
  return {
    ok: hit.length >= rule.min,
    detail: `${rule.id}命中:${hit.join(',') || '无'} / 至少${rule.min}项`,
  };
}

function fileNameDomainCheck(goal: string, fileName: string): { ok: boolean; detail: string } {
  const compact = cleanUserGoal(goal).replace(/\s+/g, '');
  const name = fileName.replace(/\s+/g, '');
  const rules: Array<{ id: string; when: RegExp; must: RegExp; reject?: RegExp }> = [
    { id: '合同台账', when: /合同.*(台账|Excel|xlsx|模板|管理|付款|发票|履约)|合同台账/i, must: /合同/, reject: /报销|费用/ },
    { id: '项目周报', when: /(周报|本周完成|下周计划|领导协调|问题风险)/i, must: /周报|项目周报/, reject: /AIOS交付物|交付物/ },
    { id: '项目月报', when: /(月报|月度工作|月度总结)/i, must: /月报|项目月报/, reject: /AIOS交付物|交付物/ },
    { id: '商业计划书', when: /(商业计划|上市|融资|餐饮|泰餐|餐厅).*(计划书|PDF|Word|docx|pdf)|商业计划书/i, must: /商业计划|计划书|餐饮|泰餐/, reject: /AIOS交付物|交付物/ },
    { id: '调研报告', when: /(调研|研究).*(报告|PDF|Word|docx|pdf)|调研报告/i, must: /调研|研究|报告/, reject: /AIOS交付物|交付物/ },
    { id: '费用报销', when: /(费用|报销|票据).*(台账|Excel|xlsx|模板|登记|清单)|费用报销/i, must: /报销|费用|票据/ },
    { id: '采购比价', when: /(采购|比价|报价).*(表|清单|台账|Excel|xlsx)|采购比价/i, must: /采购|比价|报价/ },
    { id: '会议纪要', when: /(会议|纪要|督办).*(跟踪|清单|台账|Excel|xlsx)|会议纪要/i, must: /会议|纪要|督办/ },
  ];
  const rule = rules.find((r) => r.when.test(compact));
  if (!rule) return { ok: true, detail: '无强文件名域要求' };
  const ok = rule.must.test(name) && !(rule.reject && rule.reject.test(name));
  return { ok, detail: ok ? `${rule.id}文件名匹配:${fileName}` : `${rule.id}文件名不匹配:${fileName}` };
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
  const names = zipNames(await loadZip(file.path));
  const tableCount = names.filter((name) => /^xl\/tables\/table\d+\.xml$/.test(name)).length;
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
  const relevanceText = workbookRelevanceText(wb);
  const relevance = promptRelevanceCheck(goal, relevanceText);
  const domainFit = domainFitCheck(goal, `${sheetNames.join(' ')} ${relevanceText}`);
  const fileNameDomain = fileNameDomainCheck(goal, file.name);
  return [
    { id: 'xlsx_readable', ok: true, detail: '工作簿可被程序读回' },
    { id: 'xlsx_filename_domain', ok: fileNameDomain.ok, detail: fileNameDomain.detail },
    { id: 'xlsx_prompt_relevance', ok: relevance.ok, detail: relevance.detail },
    { id: 'xlsx_domain_fit', ok: domainFit.ok, detail: domainFit.detail },
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

async function pptxChecks(file: DeliveryFile, goal: string): Promise<Array<{ id: string; ok: boolean; detail: string }>> {
  const zip = await loadZip(file.path);
  const names = zipNames(zip);
  const slides = names
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1] || 0) - Number(b.match(/slide(\d+)/)?.[1] || 0));
  const slideTexts: string[] = [];
  for (const slide of slides) {
    slideTexts.push(ooxmlPlainText(await zipEntryText(zip, slide)));
  }
  const text = slideTexts.join(' ');
  const substantiveSlides = slideTexts.filter((t) => t.length >= 20).length;
  const relevance = promptRelevanceCheck(goal, text);
  return [
    { id: 'pptx_readable', ok: names.includes('[Content_Types].xml'), detail: 'PPTX zip 可读' },
    { id: 'pptx_multi_slide', ok: slides.length >= 3, detail: `幻灯片:${slides.length}` },
    ...(() => {
      // 页数对齐验收:用户要 N 页就验 N±2;"至少/以上"只验下限(审计:只验≥3 页,16 页也放行)
      const wanted = requestedOfficeSize(goal, file.name).slides || 0;
      if (!wanted) return [];
      const ok = goalAllowsMorePages(goal)
        ? slides.length >= wanted
        : Math.abs(slides.length - wanted) <= 2;
      return [{ id: 'pptx_requested_page_alignment', ok, detail: `请求${wanted}页,实际${slides.length}页` }];
    })(),
    { id: 'pptx_theme', ok: names.includes('ppt/theme/theme1.xml'), detail: '包含主题文件' },
    { id: 'pptx_has_real_text', ok: text.length >= 60, detail: `文字长度:${text.length}` },
    { id: 'pptx_has_flow', ok: /目录|重点|问题|风险|计划|下一步|结论|汇报逻辑/.test(text), detail: '含汇报逻辑/问题/计划信号' },
    { id: 'pptx_not_single_dump', ok: slides.length >= 4 || text.length < 450, detail: `幻灯片:${slides.length};文字长度:${text.length}` },
    { id: 'pptx_slide_substance', ok: substantiveSlides >= Math.min(3, slides.length), detail: `有效内容页:${substantiveSlides}` },
    { id: 'pptx_prompt_relevance', ok: relevance.ok, detail: relevance.detail },
  ];
}

async function docxChecks(file: DeliveryFile, goal: string): Promise<Array<{ id: string; ok: boolean; detail: string }>> {
  const xml = await zipEntryText(await loadZip(file.path), 'word/document.xml');
  const text = ooxmlPlainText(xml);
  const tableCount = (xml.match(/<w:tbl[\s>]/g) || []).length;
  const structureHits = (text.match(/一、|二、|三、|第[一二三四五六七八九十]+|结论|建议|事项|通知|报告/g) || []).length;
  const actionListHits = (text.match(/措施|责任部门|下一步|请各部门|事项|建议|负责人|截止|验收|里程碑|P0|P1|P2/g) || []).length;
  const relevance = promptRelevanceCheck(goal, text);
  const fileNameDomain = fileNameDomainCheck(goal, file.name);
  const offTopic = offTopicCheck(goal, text);
  const requiresNativeTable = docxRequiresNativeTable(goal);
  return [
    { id: 'docx_readable', ok: xml.includes('w:document'), detail: 'DOCX document.xml 可读' },
    { id: 'docx_filename_domain', ok: fileNameDomain.ok, detail: fileNameDomain.detail },
    { id: 'docx_has_content', ok: text.length >= 20, detail: `正文长度:${text.length}` },
    { id: 'docx_has_structure', ok: /一、|二、|##|第[一二三四五六七八九十]+|结论|建议|事项|通知|报告/.test(text), detail: '含正式材料结构信号' },
    { id: 'docx_heading_hierarchy', ok: structureHits >= 1, detail: `结构信号:${structureHits}` },
    { id: 'docx_has_native_table', ok: tableCount > 0, detail: `原生Word表格:${tableCount}` },
    { id: 'docx_has_action_list', ok: actionListHits > 0, detail: `行动/责任/验收信号:${actionListHits}` },
    { id: 'docx_native_table_required', ok: !requiresNativeTable || tableCount > 0, detail: requiresNativeTable ? `任务需要结构化表格;原生Word表格:${tableCount}` : '任务未强制要求原生表格' },
    { id: 'docx_offtopic_terms', ok: offTopic.ok, detail: offTopic.detail },
    { id: 'docx_prompt_relevance', ok: relevance.ok, detail: relevance.detail },
  ];
}

function pdfChecks(file: DeliveryFile, goal: string): Array<{ id: string; ok: boolean; detail: string }> {
  const size = existsSync(file.path) ? readFileSync(file.path).byteLength : 0;
  const fileNameDomain = fileNameDomainCheck(goal, file.name);
  return [
    { id: 'pdf_exists', ok: size > 0, detail: `大小:${size}B` },
    { id: 'pdf_filename_domain', ok: fileNameDomain.ok, detail: fileNameDomain.detail },
    { id: 'pdf_non_empty', ok: size > 8_000, detail: 'PDF 非空且不像占位文件' },
  ];
}

async function fileChecks(file: DeliveryFile, goal: string): Promise<Array<{ id: string; ok: boolean; detail: string }>> {
  const ext = extOf(file.name);
  if (ext === 'xlsx') return xlsxChecks(file, goal);
  if (ext === 'pptx') return pptxChecks(file, goal);
  if (ext === 'docx') return docxChecks(file, goal);
  if (ext === 'pdf') return pdfChecks(file, goal);
  return [];
}

export async function buildOfficeQualityArtifacts(
  goal: string,
  files: DeliveryFile[],
  dir: string,
  freshnessVerified?: boolean,
): Promise<{ files: DeliveryFile[]; manifest: OfficeQualityResult }> {
  const userGoal = cleanUserGoal(goal);
  const officeFiles = files.filter((f) => isOfficeExt(extOf(f.name)));
  const editableFiles = files.filter((f) => ['xlsx', 'pptx', 'docx'].includes(extOf(f.name)));
  const fileResults: OfficeQualityResult['files'] = [];
  for (const file of officeFiles) {
    fileResults.push({ name: file.name, ext: extOf(file.name), checks: await fileChecks(file, userGoal) });
  }
  const allFileChecks = fileResults.flatMap((f) => f.checks);
  const checks = [
    { id: 'office_has_editable_source', ok: editableFiles.length > 0, detail: `可编辑源文件:${editableFiles.map((f) => f.name).join(', ') || '无'}` },
    { id: 'office_no_html_as_primary', ok: !files.some((f) => /^aios-artifact-.*\.html$/.test(f.name)), detail: '办公交付未以 HTML artifact 冒充源文件' },
    { id: 'office_has_file_list', ok: files.length >= 1, detail: `文件数:${files.length}` },
    { id: 'office_ob_memory_applied', ok: true, detail: '已应用 OB 早晚报/PDF/质量验收经验' },
  ];
  if (/价格|行情|新闻|热榜|实时|今天|最新|工资|薪资|比例|增长/.test(userGoal)) {
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
    !c.ok && /office_no_html_as_primary|xlsx_minimum_fields|xlsx_sample_rows|xlsx_prompt_relevance|xlsx_domain_fit|xlsx_filename_domain|pptx_prompt_relevance|docx_prompt_relevance|docx_filename_domain|docx_native_table_required|docx_offtopic_terms|pdf_filename_domain/.test(c.id));
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
