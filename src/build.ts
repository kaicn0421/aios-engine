// Build —— 交付物落地。代码成品 + 文档格式转换(md→docx/pdf)。
// 打包版必须内置转换依赖;运行时不允许 npm install,否则用户机器离线/无 npm 时会在最后一步失败。
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { marked } from 'marked';

/** 从 LLM 输出提取 HTML 代码(优先 ```html 代码块) */
export function extractHtml(output: string): string {
  // 有成对 ``` fence:取中间
  const paired = output.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (paired && paired[1]) return paired[1].trim();
  // 只有开头 fence(被截断/未闭合):剥掉首行 ```html 与可能的结尾 ```,别把标记留进 HTML
  return output.trim().replace(/^```(?:html)?[ \t]*\r?\n?/i, '').replace(/\r?\n?```[ \t]*$/i, '').trim();
}

/** 按扩展名提取内容:.md/.txt 原文;其它(html/csv/py…)优先提取对应代码块 */
export function extractByExt(output: string, ext: string): string {
  if (ext === 'md' || ext === 'txt' || !ext) return output.trim();
  const re = new RegExp('```(?:' + ext + ')?\\s*([\\s\\S]*?)```', 'i');
  const m = output.match(re);
  return (m && m[1] ? m[1] : output).trim();
}

/** 文件名消毒 */
export function sanitizeName(name: string): string {
  return name.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 80) || 'file.md';
}

/** 写成可运行的单文件成品(造物) */
export function writeArtifact(code: string, outDir: string): string {
  const file = join(outDir, `aios-artifact-${Date.now()}.html`);
  writeFileSync(file, code, 'utf8');
  return file;
}

// ── 文档转换 ──────────────────────────────────────────────

function injectExplicitPageBreaks(md: string): string {
  let seen = 0;
  return md.replace(
    /^([ \t]*#{2,3}\s*第\s*(?:\d+|[一二三四五六七八九十百]+)\s*(?:页|頁|张|張|slide|幻灯片|投影片)?\s*[:：].*)$/gim,
    (line) => {
      seen++;
      return seen === 1 ? line : `<div class="aios-page-break"></div>\n${line}`;
    },
  );
}

function mdToHtml(md: string): string {
  const body = marked.parse(injectExplicitPageBreaks(md)) as string;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>` +
    `@page{size:A4;margin:22mm 18mm 20mm 18mm}` +
    `body{font-family:"Microsoft YaHei","PingFang SC","Helvetica Neue",Arial,sans-serif;line-height:1.72;font-size:14px;color:#1f2937;max-width:820px;margin:0 auto;padding:34px 36px;background:#fff;}` +
    `h1{font-size:26px;line-height:1.28;margin:0 0 22px;padding:18px 20px;color:#fff;background:#1f4e78;border-radius:4px;}` +
    `h2{font-size:20px;line-height:1.35;margin:26px 0 12px;padding:0 0 7px 12px;color:#1f2937;border-left:5px solid #1f4e78;border-bottom:1px solid #d9dee8;}` +
    `h3{font-size:16px;margin:18px 0 8px;color:#374151}` +
    `p{margin:8px 0}ul,ol{margin:8px 0 12px 24px;padding:0}li{margin:4px 0}` +
    `table{border-collapse:collapse;width:100%;margin:14px 0 18px;font-size:13px;table-layout:auto}` +
    `th,td{border:1px solid #b8c2cc;padding:7px 9px;text-align:left;vertical-align:top}` +
    `th{background:#eaf1f8;color:#1f2937;font-weight:700}` +
    `tr:nth-child(even) td{background:#fafafa}` +
    `blockquote{border-left:4px solid #1f4e78;background:#f4f7fb;padding:9px 13px;color:#4b5563;margin:12px 0}` +
    `code{background:#eef2f7;padding:1px 5px;border-radius:3px}pre{background:#f6f8fb;padding:12px;border-radius:6px;overflow:auto}` +
    `.aios-page-break{break-before:page;page-break-before:always;height:0;margin:0;padding:0}` +
    `</style></head><body>${body}</body></html>`;
}

function normalizeFormalDocumentMarkdown(md: string): string {
  const raw = md.trim();
  if (/^#{1,3}\s/m.test(raw) && /一、|二、|执行摘要|结论|建议|下一步|风险|事项|通知|报告/m.test(raw)) return raw;
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s*/, '').replace(/^#{1,6}\s*/, ''));
  if (lines.length < 3) return raw;
  const title = lines.shift() || '正式材料';
  const buckets: Record<'summary' | 'body' | 'risk' | 'next', string[]> = {
    summary: [],
    body: [],
    risk: [],
    next: [],
  };
  for (const line of lines) {
    if (/问题|风险|不足|滞后|缺口|困难|待协调|异常/.test(line)) buckets.risk.push(line);
    else if (/下一步|计划|后续|推进|完成|落实|优化|安排|建议|措施/.test(line)) buckets.next.push(line);
    else if (buckets.summary.length < 2) buckets.summary.push(line);
    else buckets.body.push(line);
  }
  return [
    `# ${title}`,
    '',
    '## 一、执行摘要',
    ...(buckets.summary.length ? buckets.summary : lines.slice(0, 2)).map((line) => `- ${line}`),
    '',
    '## 二、正文事项',
    ...(buckets.body.length ? buckets.body : lines.slice(2)).map((line) => `- ${line}`),
    '',
    '## 三、风险与建议',
    ...(buckets.risk.length ? buckets.risk : ['原文未提供明确风险项,需人工补充。']).map((line) => `- ${line}`),
    '',
    '## 四、下一步',
    ...(buckets.next.length ? buckets.next : ['原文未提供下一步安排,需补充责任人和时间节点。']).map((line) => `- ${line}`),
  ].join('\n');
}

function hasCmd(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; }
}

async function importBundled<T = any>(pkg: string): Promise<T> {
  try {
    return (await import(pkg)) as T;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`bundled_dependency_missing:${pkg};${detail}`);
  }
}

/** md → docx:macOS 可用 textutil;跨平台包内置 html-to-docx 兜底 */
async function toDocx(md: string, fp: string): Promise<void> {
  const html = mdToHtml(normalizeFormalDocumentMarkdown(md));
  if (process.env.AIOS_FORCE_HTML_TO_DOCX !== '1' && hasCmd('textutil')) {
    const tmp = fp + '.tmp.html';
    writeFileSync(tmp, html, 'utf8');
    try { execFileSync('textutil', ['-convert', 'docx', '-output', fp, tmp]); }
    finally { try { unlinkSync(tmp); } catch { /* ignore */ } }
    return;
  }
  const htmlToDocx = (await importBundled<{ default: (h: string) => Promise<Buffer> }>('html-to-docx')).default;
  writeFileSync(fp, await htmlToDocx(html));
}

export function pdfBrowserCandidates(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, existingOnly = true): string[] {
  const candidates = [env.AIOS_PDF_BROWSER_PATH, env.PUPPETEER_EXECUTABLE_PATH].filter(Boolean) as string[];
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    );
  } else if (platform === 'win32') {
    const roots = [
      env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      env.PROGRAMFILES && `${env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      env['PROGRAMFILES(X86)'] && `${env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
      env.PROGRAMFILES && `${env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
      env['PROGRAMFILES(X86)'] && `${env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
      env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ].filter(Boolean) as string[];
    candidates.push(...roots);
  } else {
    for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
      try {
        const p = execSync(`command -v ${cmd}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (p) candidates.push(p);
      } catch { /* ignore */ }
    }
  }
  const unique = [...new Set(candidates)].filter((p) => p);
  return existingOnly ? unique.filter((p) => existsSync(p)) : unique;
}

/** md → pdf:用 puppeteer;打包不带 Chromium 时自动使用系统 Chrome/Edge */
async function toPdf(md: string, fp: string): Promise<void> {
  const puppeteer = (await importBundled<{ default: { launch: (o?: unknown) => Promise<any> } }>('puppeteer')).default;
  let browser: any;
  let lastErr: unknown;
  for (const executablePath of [undefined, ...pdfBrowserCandidates()]) {
    try {
      browser = await puppeteer.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!browser) {
    const hint = '未找到可用于生成 PDF 的 Chromium/Chrome/Edge。请安装 Chrome/Edge,或设置 AIOS_PDF_BROWSER_PATH。';
    throw new Error(`${hint} ${lastErr instanceof Error ? lastErr.message : String(lastErr || '')}`);
  }
  try {
    const page = await browser.newPage();
    await page.setContent(mdToHtml(normalizeFormalDocumentMarkdown(md)), { waitUntil: 'load' });
    await page.pdf({ path: fp, format: 'A4', printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' } });
  } finally {
    await browser.close();
  }
}

/** 提取 md 表格 → 行列(每个表格一组) */
function extractMdTables(md: string): string[][][] {
  const tables: string[][][] = [];
  let cur: string[][] = [];
  for (const line of md.split('\n')) {
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // 分隔行 |---|
      cur.push(line.split('|').slice(1, -1).map((c) => c.trim()));
    } else if (cur.length) { tables.push(cur); cur = []; }
  }
  if (cur.length) tables.push(cur);
  return tables;
}

function looksLikeContractLedger(name: string, content: string): boolean {
  const head = content.split('\n').slice(0, 12).join('\n');
  const text = `${name}\n${head}`.toLowerCase();
  return (
    /合同/.test(name)
    || /(合同编号|合同名称|签约方|合同金额|履约状态|履约风险|签约日期|乙方\/供应商)/.test(head)
  ) && /(台账|excel|xlsx|模板|登记|履约|付款|发票|风险)/i.test(text);
}

function looksLikeExpenseLedger(name: string, content: string): boolean {
  const text = `${name}\n${content}`.toLowerCase();
  return /(报销|费用|付款|支出|票据|发票)/.test(text) && /(台账|excel|xlsx|模板|登记|清单)/i.test(text);
}

function looksLikeMeetingTracker(name: string, content: string): boolean {
  const text = `${name}\n${content}`.toLowerCase();
  return /(会议|纪要|督办|待办|事项|闭环)/.test(text) && /(跟踪|清单|台账|excel|xlsx|模板|登记)/i.test(text);
}

function looksLikeGenericOfficeLedger(name: string, content: string): boolean {
  const text = `${name}\n${content}`.toLowerCase();
  if (looksLikeContractLedger(name, content) || looksLikeExpenseLedger(name, content) || looksLikeMeetingTracker(name, content)) {
    return false;
  }
  return /(台账|清单|报表|登记表|明细表|跟踪表|excel|xlsx|表格)/i.test(text)
    && /(办公室|办公|商务|中铁|项目部|部门|责任人|归档|审批|状态|备注|日期|编号)/i.test(text);
}

function shouldUseDynamicOfficeWorkbook(name: string, content: string): boolean {
  const text = `${name}\n${content}`.toLowerCase();
  return /(采购|比价|报价|预算|测算|物资|材料|供应商|付款计划|成本)/.test(text)
    && /(台账|清单|报表|登记表|明细表|统计表|汇总表|excel|xlsx|表格)/i.test(text);
}

function styleTitle(ws: any, range: string, title: string, subtitle: string, color = 'FF1F4E78'): void {
  ws.mergeCells(range);
  const firstCell = range.split(':')[0]!;
  ws.getCell(firstCell).value = title;
  ws.getCell(firstCell).font = { bold: true, size: 18, color: { argb: 'FFFFFFFF' } };
  ws.getCell(firstCell).alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getCell(firstCell).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
  ws.getRow(1).height = 30;
  const endCol = range.split(':')[1]!.replace(/\d+/g, '');
  ws.mergeCells(`A2:${endCol}2`);
  ws.getCell('A2').value = subtitle;
  ws.getCell('A2').font = { color: { argb: 'FF666666' }, italic: true };
  ws.getCell('A2').alignment = { horizontal: 'left', vertical: 'middle' };
}

function styleHeader(row: any, color = 'FF305496'): void {
  row.height = 24;
  row.eachCell((cell: any) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFD9E2F3' } },
      left: { style: 'thin', color: { argb: 'FFD9E2F3' } },
      bottom: { style: 'thin', color: { argb: 'FFD9E2F3' } },
      right: { style: 'thin', color: { argb: 'FFD9E2F3' } },
    };
  });
}

function styleDictionary(ws: any, rows: string[][]): void {
  ws.addRows(rows);
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF305496' } };
  ws.columns = [{ width: 22 }, { width: 76 }];
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.eachRow((row: any) => row.eachCell((cell: any) => {
    cell.alignment = { vertical: 'top', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } };
  }));
}

function addSummarySheet(summary: any, title: string, cards: string[][]): void {
  summary.mergeCells('A1:F1');
  summary.getCell('A1').value = title;
  summary.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  summary.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  summary.getCell('A1').alignment = { horizontal: 'center' };
  summary.getRow(3).values = ['指标', '数值'];
  summary.addRows(cards);
  for (let r = 3; r <= 3 + cards.length; r += 1) {
    summary.getRow(r).eachCell((cell: any) => {
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFD9E2F3' } } };
      cell.alignment = { vertical: 'middle' };
    });
  }
  summary.getRow(3).font = { bold: true };
  summary.getColumn(1).width = 20;
  summary.getColumn(2).width = 22;
  summary.getColumn(2).numFmt = '#,##0.00';
}

function applyWorksheetPrintDefaults(ws: any, titleRows = '1:4'): void {
  ws.pageSetup = {
    ...(ws.pageSetup || {}),
    paperSize: 9,
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    margins: { left: 0.35, right: 0.35, top: 0.55, bottom: 0.55, header: 0.2, footer: 0.2 },
    printTitlesRow: titleRows,
  };
  ws.headerFooter = {
    oddHeader: '&C&"Microsoft YaHei,Bold"AIOS 办公交付',
    oddFooter: '&L&F&C第 &P / &N 页&R&D',
  };
}

async function writeContractLedgerTemplate(ExcelJS: any, fp: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AIOS';
  wb.created = new Date();
  wb.modified = new Date();

  const ledger = wb.addWorksheet('合同台账');
  const dict = wb.addWorksheet('字段说明');
  const summary = wb.addWorksheet('统计看板');
  applyWorksheetPrintDefaults(ledger);
  applyWorksheetPrintDefaults(dict, '1:1');
  applyWorksheetPrintDefaults(summary, '1:3');

  ledger.views = [{ state: 'frozen', ySplit: 4 }];
  ledger.properties.defaultRowHeight = 20;
  styleTitle(ledger, 'A1:T1', '合同台账模板', '适用于办公室合同登记、履约跟踪、付款跟踪、归档管理。黄色列为建议重点维护字段。');

  const headers = [
    '合同编号', '合同名称', '合同类型', '甲方/项目部', '乙方/供应商',
    '合同金额(元)', '签订日期', '生效日期', '到期日期', '履约状态',
    '付款方式', '已付款金额(元)', '未付款金额(元)', '保证金/质保金(元)',
    '责任部门', '经办人', '归档位置', '风险等级', '到期提醒', '备注',
  ];
  ledger.getRow(4).values = headers;
  styleHeader(ledger.getRow(4));

  const samples = [
    ['HT2026001', '办公用品年度采购合同', '采购合同', '中铁XX项目部', '示例供应商A', 120000, new Date('2026-01-10'), new Date('2026-01-10'), new Date('2026-12-31'), '履约中', '分期付款', 36000, null, 6000, '办公室', '张三', '档案室A柜-01', '中', null, '示例行，可删除'],
    ['HT2026002', '办公区维修服务合同', '服务合同', '中铁XX项目部', '示例供应商B', 58000, new Date('2026-02-15'), new Date('2026-02-20'), new Date('2026-08-31'), '未开始', '验收后付款', 0, null, 0, '综合部', '李四', '档案室A柜-02', '低', null, '示例行，可删除'],
    ['HT2026003', '临建材料供应合同', '材料合同', '中铁XX项目部', '示例供应商C', 320000, new Date('2026-03-01'), new Date('2026-03-01'), new Date('2026-07-15'), '待验收', '按月结算', 180000, null, 16000, '物资部', '王五', '档案室B柜-01', '高', null, '示例行，可删除'],
  ];
  for (let r = 0; r < 50; r += 1) {
    const rowIndex = 5 + r;
    const row = ledger.getRow(rowIndex);
    if (r < samples.length) row.values = samples[r];
    ledger.getCell(`M${rowIndex}`).value = { formula: `IF(F${rowIndex}="","",MAX(F${rowIndex}-L${rowIndex},0))` };
    ledger.getCell(`S${rowIndex}`).value = { formula: `IF(I${rowIndex}="","",IF(I${rowIndex}<TODAY(),"已逾期",IF(I${rowIndex}-TODAY()<=30,"30天内到期","正常")))` };
  }

  ledger.addTable({
    name: '合同台账',
    ref: 'A4',
    headerRow: true,
    totalsRow: false,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: headers.map((name) => ({ name, filterButton: true })),
    rows: Array.from({ length: 50 }, (_, idx) => {
      const row = ledger.getRow(5 + idx).values as any[];
      return headers.map((_, colIdx) => row[colIdx + 1] ?? null);
    }),
  });

  // ExcelJS addTable writes its own row payload, so restore formula columns after
  // table creation to keep the delivered template editable and self-calculating.
  for (let r = 5; r <= 54; r += 1) {
    ledger.getCell(`M${r}`).value = { formula: `IF(F${r}="","",MAX(F${r}-L${r},0))` };
    ledger.getCell(`S${r}`).value = { formula: `IF(I${r}="","",IF(I${r}<TODAY(),"已逾期",IF(I${r}-TODAY()<=30,"30天内到期","正常")))` };
  }

  const widths = [16, 26, 14, 20, 22, 14, 13, 13, 13, 12, 14, 15, 15, 16, 14, 12, 20, 10, 14, 24];
  widths.forEach((width, idx) => { ledger.getColumn(idx + 1).width = width; });
  ['F', 'L', 'M', 'N'].forEach((col) => { ledger.getColumn(col).numFmt = '#,##0.00'; });
  ['G', 'H', 'I'].forEach((col) => { ledger.getColumn(col).numFmt = 'yyyy-mm-dd'; });
  for (let r = 5; r <= 54; r += 1) {
    ledger.getCell(`C${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"采购合同,服务合同,材料合同,分包合同,租赁合同,其他"'] };
    ledger.getCell(`J${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"未开始,履约中,待验收,已完成,暂停,终止"'] };
    ledger.getCell(`R${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"低,中,高"'] };
  }

  const dictRows = [
    ['字段', '填写说明'],
    ['合同编号', '唯一编号，建议按年份+流水号，如 HT2026001'],
    ['合同名称', '合同完整名称，便于检索'],
    ['合同类型', '采购/服务/材料/分包/租赁等，可下拉选择'],
    ['合同金额(元)', '含税合同总金额；金额变更后应同步更新'],
    ['履约状态', '未开始/履约中/待验收/已完成/暂停/终止'],
    ['未付款金额(元)', '公式列：合同金额 - 已付款金额'],
    ['到期提醒', '公式列：自动判断逾期、30天内到期或正常'],
    ['归档位置', '填写实体档案或电子档案路径，如 档案室A柜-01'],
  ];
  styleDictionary(dict, dictRows);
  const cards = [
    ['合同数量', '=COUNTA(合同台账!A5:A54)'],
    ['合同总金额', '=SUM(合同台账!F5:F54)'],
    ['已付款金额', '=SUM(合同台账!L5:L54)'],
    ['未付款金额', '=SUM(合同台账!M5:M54)'],
    ['30天内到期', '=COUNTIF(合同台账!S5:S54,"30天内到期")'],
    ['已逾期', '=COUNTIF(合同台账!S5:S54,"已逾期")'],
  ];
  addSummarySheet(summary, '合同台账统计看板', cards);

  await wb.xlsx.writeFile(fp);
}

async function writeExpenseLedgerTemplate(ExcelJS: any, fp: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AIOS';
  wb.created = new Date();
  wb.modified = new Date();
  const ledger = wb.addWorksheet('费用报销台账');
  const dict = wb.addWorksheet('字段说明');
  const summary = wb.addWorksheet('统计看板');
  applyWorksheetPrintDefaults(ledger);
  applyWorksheetPrintDefaults(dict, '1:1');
  applyWorksheetPrintDefaults(summary, '1:3');
  ledger.views = [{ state: 'frozen', ySplit: 4 }];
  ledger.properties.defaultRowHeight = 20;
  styleTitle(ledger, 'A1:R1', '费用报销台账模板', '适用于办公室费用报销、票据登记、审批付款和归档追踪。金额列带公式,状态列可下拉。');
  const headers = [
    '报销编号', '申请日期', '报销人', '部门', '项目/合同', '费用类型',
    '事由摘要', '发票张数', '报销金额(元)', '已付款金额(元)', '未付款金额(元)',
    '审批状态', '付款状态', '付款日期', '票据状态', '责任人', '归档位置', '备注',
  ];
  ledger.getRow(4).values = headers;
  styleHeader(ledger.getRow(4), 'FF4472C4');
  const samples = [
    ['BX2026001', new Date('2026-06-01'), '张三', '办公室', '综合管理', '差旅费', '项目协调出差', 3, 1280, 0, null, '待审批', '未付款', null, '票据齐全', '李四', '财务共享/2026/06', '示例行，可删除'],
    ['BX2026002', new Date('2026-06-03'), '王五', '物资部', 'HT2026003', '材料运杂费', '临建材料运输', 2, 5600, 5600, null, '已通过', '已付款', new Date('2026-06-04'), '已归档', '赵六', '财务共享/2026/06', '示例行，可删除'],
  ];
  for (let r = 0; r < 60; r += 1) {
    const rowIndex = 5 + r;
    const row = ledger.getRow(rowIndex);
    if (r < samples.length) row.values = samples[r];
    ledger.getCell(`K${rowIndex}`).value = { formula: `IF(I${rowIndex}="","",MAX(I${rowIndex}-J${rowIndex},0))` };
  }
  ledger.addTable({
    name: '费用报销台账',
    ref: 'A4',
    headerRow: true,
    totalsRow: false,
    style: { theme: 'TableStyleMedium4', showRowStripes: true },
    columns: headers.map((name) => ({ name, filterButton: true })),
    rows: Array.from({ length: 60 }, (_, idx) => {
      const row = ledger.getRow(5 + idx).values as any[];
      return headers.map((_, colIdx) => row[colIdx + 1] ?? null);
    }),
  });
  for (let r = 5; r <= 64; r += 1) {
    ledger.getCell(`K${r}`).value = { formula: `IF(I${r}="","",MAX(I${r}-J${r},0))` };
    ledger.getCell(`F${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"差旅费,办公费,招待费,材料费,运杂费,培训费,其他"'] };
    ledger.getCell(`L${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"待提交,待审批,已通过,已驳回,需补票"'] };
    ledger.getCell(`M${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"未付款,部分付款,已付款"'] };
    ledger.getCell(`O${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"待补票,票据齐全,已归档"'] };
  }
  [16, 13, 11, 14, 18, 12, 28, 10, 14, 15, 15, 12, 12, 13, 12, 12, 22, 24]
    .forEach((width, idx) => { ledger.getColumn(idx + 1).width = width; });
  ['I', 'J', 'K'].forEach((col) => { ledger.getColumn(col).numFmt = '#,##0.00'; });
  ['B', 'N'].forEach((col) => { ledger.getColumn(col).numFmt = 'yyyy-mm-dd'; });
  styleDictionary(dict, [
    ['字段', '填写说明'],
    ['报销编号', '建议按 BX+年份+流水号,如 BX2026001'],
    ['项目/合同', '可填写项目名称、合同编号或成本归集对象'],
    ['费用类型', '下拉选择,便于后续统计'],
    ['报销金额/已付款/未付款', '未付款金额为公式列,用于跟踪财务闭环'],
    ['审批状态', '待提交/待审批/已通过/已驳回/需补票'],
    ['票据状态', '待补票/票据齐全/已归档,避免票据缺口遗漏'],
  ]);
  addSummarySheet(summary, '费用报销统计看板', [
    ['报销单数量', '=COUNTA(费用报销台账!A5:A64)'],
    ['报销总金额', '=SUM(费用报销台账!I5:I64)'],
    ['已付款金额', '=SUM(费用报销台账!J5:J64)'],
    ['未付款金额', '=SUM(费用报销台账!K5:K64)'],
    ['待审批数量', '=COUNTIF(费用报销台账!L5:L64,"待审批")'],
    ['需补票数量', '=COUNTIF(费用报销台账!L5:L64,"需补票")+COUNTIF(费用报销台账!O5:O64,"待补票")'],
  ]);
  await wb.xlsx.writeFile(fp);
}

async function writeMeetingTrackerTemplate(ExcelJS: any, fp: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AIOS';
  wb.created = new Date();
  wb.modified = new Date();
  const ledger = wb.addWorksheet('会议事项跟踪');
  const dict = wb.addWorksheet('字段说明');
  const summary = wb.addWorksheet('统计看板');
  applyWorksheetPrintDefaults(ledger);
  applyWorksheetPrintDefaults(dict, '1:1');
  applyWorksheetPrintDefaults(summary, '1:3');
  ledger.views = [{ state: 'frozen', ySplit: 4 }];
  ledger.properties.defaultRowHeight = 22;
  styleTitle(ledger, 'A1:R1', '会议纪要事项跟踪清单', '适用于会议纪要、领导交办、督办事项闭环管理。自动判断逾期和完成率。', 'FF375623');
  const headers = [
    '会议日期', '会议类型', '会议主题', '事项编号', '决议/待办事项', '责任部门',
    '责任人', '协同部门', '优先级', '截止日期', '完成状态', '进度%',
    '逾期提醒', '风险等级', '最新进展', '需协调问题', '归档链接', '备注',
  ];
  ledger.getRow(4).values = headers;
  styleHeader(ledger.getRow(4), 'FF548235');
  const samples = [
    [new Date('2026-06-04'), '周例会', '办公室周例会', 'HY20260604-01', '补齐合同归档清单', '办公室', '张三', '财务部', '高', new Date('2026-06-10'), '进行中', 0.55, null, '中', '已完成首轮核对', '待财务确认付款附件', '会议纪要/2026-06-04', '示例行，可删除'],
    [new Date('2026-06-04'), '专题会', '材料采购专题会', 'HY20260604-02', '更新供应商履约评价表', '物资部', '李四', '办公室', '中', new Date('2026-06-20'), '未开始', 0, null, '低', '待启动', '', '会议纪要/2026-06-04', '示例行，可删除'],
  ];
  for (let r = 0; r < 80; r += 1) {
    const rowIndex = 5 + r;
    const row = ledger.getRow(rowIndex);
    if (r < samples.length) row.values = samples[r];
    ledger.getCell(`M${rowIndex}`).value = { formula: `IF(K${rowIndex}="已完成","已完成",IF(J${rowIndex}="","",IF(J${rowIndex}<TODAY(),"已逾期",IF(J${rowIndex}-TODAY()<=3,"3天内到期","正常"))))` };
  }
  ledger.addTable({
    name: '会议事项跟踪',
    ref: 'A4',
    headerRow: true,
    totalsRow: false,
    style: { theme: 'TableStyleMedium7', showRowStripes: true },
    columns: headers.map((name) => ({ name, filterButton: true })),
    rows: Array.from({ length: 80 }, (_, idx) => {
      const row = ledger.getRow(5 + idx).values as any[];
      return headers.map((_, colIdx) => row[colIdx + 1] ?? null);
    }),
  });
  for (let r = 5; r <= 84; r += 1) {
    ledger.getCell(`M${r}`).value = { formula: `IF(K${r}="已完成","已完成",IF(J${r}="","",IF(J${r}<TODAY(),"已逾期",IF(J${r}-TODAY()<=3,"3天内到期","正常"))))` };
    ledger.getCell(`B${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"周例会,专题会,协调会,安全会,生产会,其他"'] };
    ledger.getCell(`I${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"高,中,低"'] };
    ledger.getCell(`K${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"未开始,进行中,待验收,已完成,暂停"'] };
    ledger.getCell(`N${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"低,中,高"'] };
  }
  [13, 12, 22, 16, 36, 14, 12, 14, 10, 13, 12, 10, 13, 10, 28, 28, 24, 22]
    .forEach((width, idx) => { ledger.getColumn(idx + 1).width = width; });
  ['A', 'J'].forEach((col) => { ledger.getColumn(col).numFmt = 'yyyy-mm-dd'; });
  ledger.getColumn('L').numFmt = '0%';
  styleDictionary(dict, [
    ['字段', '填写说明'],
    ['事项编号', '建议按 HY+日期+序号,如 HY20260604-01'],
    ['决议/待办事项', '写清动作、对象和交付标准,避免只写口号'],
    ['责任部门/责任人', '必须唯一明确;协同部门可多填'],
    ['完成状态/进度%', '状态下拉,进度用百分比填写'],
    ['逾期提醒', '公式列,自动判断已逾期、3天内到期、正常或已完成'],
    ['需协调问题', '记录阻塞项,用于下一次会议追踪'],
  ]);
  addSummarySheet(summary, '会议事项统计看板', [
    ['事项总数', '=COUNTA(会议事项跟踪!D5:D84)'],
    ['已完成', '=COUNTIF(会议事项跟踪!K5:K84,"已完成")'],
    ['进行中', '=COUNTIF(会议事项跟踪!K5:K84,"进行中")'],
    ['已逾期', '=COUNTIF(会议事项跟踪!M5:M84,"已逾期")'],
    ['3天内到期', '=COUNTIF(会议事项跟踪!M5:M84,"3天内到期")'],
    ['高优先级', '=COUNTIF(会议事项跟踪!I5:I84,"高")'],
  ]);
  await wb.xlsx.writeFile(fp);
}

async function writeGenericOfficeLedgerTemplate(ExcelJS: any, fp: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AIOS';
  wb.created = new Date();
  wb.modified = new Date();
  const ledger = wb.addWorksheet('办公台账');
  const dict = wb.addWorksheet('字段说明');
  const summary = wb.addWorksheet('统计看板');
  applyWorksheetPrintDefaults(ledger);
  applyWorksheetPrintDefaults(dict, '1:1');
  applyWorksheetPrintDefaults(summary, '1:3');
  ledger.views = [{ state: 'frozen', ySplit: 4 }];
  ledger.properties.defaultRowHeight = 22;
  styleTitle(ledger, 'A1:Q1', '办公室通用台账模板', '适用于资料归档、事项登记、审批流转、物资清单、日常报表等办公室场景。状态、优先级、风险均可下拉维护。', 'FF2F5597');

  const headers = [
    '序号', '事项/资料名称', '类别', '来源/发起人', '责任部门', '责任人',
    '开始日期', '计划完成日期', '实际完成日期', '当前状态', '优先级',
    '风险等级', '完成率', '逾期提醒', '归档位置/链接', '下一步动作', '备注',
  ];
  ledger.getRow(4).values = headers;
  styleHeader(ledger.getRow(4), 'FF2F5597');
  const samples = [
    [1, '合同扫描件归档核对', '资料归档', '办公室', '办公室', '张三', new Date('2026-06-01'), new Date('2026-06-10'), null, '进行中', '高', '中', 0.45, null, '档案室A柜/电子档案/合同', '补齐付款附件', '示例行，可删除'],
    [2, '月度办公用品领用汇总', '日常报表', '综合部', '综合部', '李四', new Date('2026-06-03'), new Date('2026-06-08'), null, '未开始', '中', '低', 0, null, '共享盘/办公室/报表', '收集各部门需求', '示例行，可删除'],
  ];
  for (let r = 0; r < 80; r += 1) {
    const rowIndex = 5 + r;
    const row = ledger.getRow(rowIndex);
    if (r < samples.length) row.values = samples[r];
    else ledger.getCell(`A${rowIndex}`).value = rowIndex - 4;
    ledger.getCell(`N${rowIndex}`).value = { formula: `IF(J${rowIndex}="已完成","已完成",IF(H${rowIndex}="","",IF(H${rowIndex}<TODAY(),"已逾期",IF(H${rowIndex}-TODAY()<=3,"3天内到期","正常"))))` };
  }
  ledger.addTable({
    name: '办公台账',
    ref: 'A4',
    headerRow: true,
    totalsRow: false,
    style: { theme: 'TableStyleMedium9', showRowStripes: true },
    columns: headers.map((name) => ({ name, filterButton: true })),
    rows: Array.from({ length: 80 }, (_, idx) => {
      const row = ledger.getRow(5 + idx).values as any[];
      return headers.map((_, colIdx) => row[colIdx + 1] ?? null);
    }),
  });
  for (let r = 5; r <= 84; r += 1) {
    ledger.getCell(`N${r}`).value = { formula: `IF(J${r}="已完成","已完成",IF(H${r}="","",IF(H${r}<TODAY(),"已逾期",IF(H${r}-TODAY()<=3,"3天内到期","正常"))))` };
    ledger.getCell(`C${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"资料归档,审批流转,日常报表,物资清单,会议督办,费用登记,其他"'] };
    ledger.getCell(`J${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"未开始,进行中,待确认,已完成,暂停,取消"'] };
    ledger.getCell(`K${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"高,中,低"'] };
    ledger.getCell(`L${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"高,中,低"'] };
  }
  [8, 28, 14, 16, 14, 12, 13, 13, 13, 12, 10, 10, 10, 13, 28, 30, 22]
    .forEach((width, idx) => { ledger.getColumn(idx + 1).width = width; });
  ['G', 'H', 'I'].forEach((col) => { ledger.getColumn(col).numFmt = 'yyyy-mm-dd'; });
  ledger.getColumn('M').numFmt = '0%';
  styleDictionary(dict, [
    ['字段', '填写说明'],
    ['事项/资料名称', '写清对象和动作,避免只写简称'],
    ['类别', '下拉选择,便于筛选归类'],
    ['责任部门/责任人', '必须唯一明确,便于追踪闭环'],
    ['计划完成日期/实际完成日期', '用于判断逾期和完成效率'],
    ['当前状态/完成率', '状态下拉,完成率用百分比填写'],
    ['逾期提醒', '公式列,自动判断已逾期、3天内到期、正常或已完成'],
    ['归档位置/链接', '填写实体柜号、共享盘路径或系统链接'],
    ['下一步动作', '写清下一步动作、责任人和预计时间'],
  ]);
  addSummarySheet(summary, '办公台账统计看板', [
    ['事项总数', '=COUNTA(办公台账!B5:B84)'],
    ['已完成', '=COUNTIF(办公台账!J5:J84,"已完成")'],
    ['进行中', '=COUNTIF(办公台账!J5:J84,"进行中")'],
    ['已逾期', '=COUNTIF(办公台账!N5:N84,"已逾期")'],
    ['3天内到期', '=COUNTIF(办公台账!N5:N84,"3天内到期")'],
    ['高优先级', '=COUNTIF(办公台账!K5:K84,"高")'],
  ]);
  await wb.xlsx.writeFile(fp);
}

function excelColumnLetter(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function normalizeDynamicHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, idx) => {
    const base = (h || `字段${idx + 1}`).replace(/\s+/g, '').slice(0, 24) || `字段${idx + 1}`;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}${count}`;
  });
}

function dynamicFieldGuide(header: string): string {
  if (/编号|序号|编码/.test(header)) return '唯一编号，建议按项目/年份/流水号维护。';
  if (/日期|时间/.test(header)) return '填写日期，统一使用 yyyy-mm-dd 格式，便于筛选和打印。';
  if (/供应商|单位|公司/.test(header)) return '填写完整单位名称，避免简称导致后续对账困难。';
  if (/金额|单价|总价|报价|预算|费用|成本/.test(header)) return '金额字段，按人民币元维护；同一张表内口径必须一致。';
  if (/数量|工程量|面积|吨|米|件|套/.test(header)) return '数量字段，需与单位字段口径一致。';
  if (/状态|进度/.test(header)) return '使用下拉状态维护，便于筛选待办、进行中和已完成项。';
  if (/责任|经办|联系人/.test(header)) return '明确唯一责任人或经办人，便于闭环追踪。';
  if (/备注|说明/.test(header)) return '填写补充说明、风险点或待确认事项。';
  return '按实际业务口径填写，保持同列数据类型一致。';
}

function dynamicSampleValue(header: string, row: number): string | number | Date | null {
  if (/编号|序号/.test(header)) return row;
  if (/日期|时间/.test(header)) return new Date(row === 1 ? '2026-06-01' : '2026-06-05');
  if (/供应商|单位|公司/.test(header)) return row === 1 ? '示例供应商A' : '示例供应商B';
  if (/材料|物资|品名|名称|事项|项目/.test(header)) return row === 1 ? '示例材料/事项A' : '示例材料/事项B';
  if (/数量|工程量|面积|吨|米|件|套/.test(header)) return row === 1 ? 100 : 80;
  if (/单价|报价/.test(header)) return row === 1 ? 120 : 128;
  if (/总价|金额|预算|费用|成本/.test(header)) return row === 1 ? 12000 : 10240;
  if (/状态|进度/.test(header)) return row === 1 ? '待确认' : '已比价';
  if (/责任|经办|联系人/.test(header)) return row === 1 ? '张三' : '李四';
  if (/备注|说明/.test(header)) return '示例行，可删除';
  return null;
}

async function writeDynamicOfficeTableWorkbook(ExcelJS: any, fp: string, name: string, table: string[][]): Promise<void> {
  const headers = normalizeDynamicHeaders(table[0] || ['序号', '事项名称', '责任部门', '责任人', '状态', '备注']);
  const dataRows = table.slice(1).filter((row) => row.some((cell) => String(cell || '').trim()));
  while (dataRows.length < 2) dataRows.push(headers.map((header) => String(dynamicSampleValue(header, dataRows.length + 1) ?? '')));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'AIOS';
  wb.created = new Date();
  wb.modified = new Date();
  const main = wb.addWorksheet('业务明细');
  const dict = wb.addWorksheet('字段说明');
  const summary = wb.addWorksheet('统计看板');
  applyWorksheetPrintDefaults(main);
  applyWorksheetPrintDefaults(dict, '1:1');
  applyWorksheetPrintDefaults(summary, '1:3');
  main.views = [{ state: 'frozen', ySplit: 4 }];
  main.properties.defaultRowHeight = 22;
  const endCol = excelColumnLetter(headers.length);
  styleTitle(main, `A1:${endCol}1`, name.replace(/\.[^.]+$/, ''), '按用户需求动态生成的可编辑业务表。字段来自本次任务内容，可继续增删改。', 'FF2F5597');
  main.getRow(4).values = headers;
  styleHeader(main.getRow(4), 'FF2F5597');
  dataRows.forEach((row, idx) => {
    main.getRow(5 + idx).values = headers.map((_, colIdx) => row[colIdx] ?? '');
  });
  for (let r = 5 + dataRows.length; r <= 64; r += 1) {
    main.getCell(`A${r}`).value = r - 4;
  }
  main.addTable({
    name: '业务明细',
    ref: 'A4',
    headerRow: true,
    totalsRow: false,
    style: { theme: 'TableStyleMedium9', showRowStripes: true },
    columns: headers.map((header) => ({ name: header, filterButton: true })),
    rows: Array.from({ length: 60 }, (_, idx) => {
      const row = main.getRow(5 + idx).values as any[];
      return headers.map((_, colIdx) => row[colIdx + 1] ?? null);
    }),
  });
  headers.forEach((header, idx) => {
    const col = main.getColumn(idx + 1);
    col.width = Math.max(10, Math.min(28, Math.max(header.length + 6, ...dataRows.map((row) => String(row[idx] || '').length + 4))));
    if (/日期|时间/.test(header)) col.numFmt = 'yyyy-mm-dd';
    if (/金额|单价|总价|报价|预算|费用|成本/.test(header)) col.numFmt = '#,##0.00';
    if (/完成率|比例|占比/.test(header)) col.numFmt = '0%';
    const letter = excelColumnLetter(idx + 1);
    for (let r = 5; r <= 64; r += 1) {
      if (/状态|进度/.test(header)) main.getCell(`${letter}${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"未开始,待确认,已比价,审批中,进行中,已完成,暂停"'] };
      if (/优先级|风险/.test(header)) main.getCell(`${letter}${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"高,中,低"'] };
      if (/是否/.test(header)) main.getCell(`${letter}${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"是,否"'] };
      main.getCell(`${letter}${r}`).alignment = { vertical: 'top', wrapText: true };
    }
  });
  styleDictionary(dict, [['字段', '填写说明'], ...headers.map((header) => [header, dynamicFieldGuide(header)])]);
  addSummarySheet(summary, '业务明细统计看板', [
    ['字段数量', headers.length],
    ['当前数据行', dataRows.length],
    ['可维护预留行', 60],
    ['可筛选字段', headers.length],
  ]);
  await wb.xlsx.writeFile(fp);
}

/** md → xlsx:表格成工作表;合同台账类需求走专用模板;无表格则整段按行 */
async function toXlsx(content: string, fp: string, name: string): Promise<void> {
  const mod = await importBundled<any>('exceljs');
  const ExcelJS = mod.default || mod;
  const tables = extractMdTables(content);
  if (looksLikeContractLedger(name, content)) {
    await writeContractLedgerTemplate(ExcelJS, fp);
    return;
  }
  if (looksLikeExpenseLedger(name, content)) {
    await writeExpenseLedgerTemplate(ExcelJS, fp);
    return;
  }
  if (looksLikeMeetingTracker(name, content)) {
    await writeMeetingTrackerTemplate(ExcelJS, fp);
    return;
  }
  if (shouldUseDynamicOfficeWorkbook(name, content) && tables.length) {
    await writeDynamicOfficeTableWorkbook(ExcelJS, fp, name, tables[0]!);
    return;
  }
  if (looksLikeGenericOfficeLedger(name, content)) {
    await writeGenericOfficeLedgerTemplate(ExcelJS, fp);
    return;
  }
  const wb = new ExcelJS.Workbook();
  if (!tables.length) {
    const ws = wb.addWorksheet('内容');
    applyWorksheetPrintDefaults(ws, '1:1');
    ws.columns = [{ width: 100 }];
    content.split('\n').filter((l) => l.trim()).forEach((l) => ws.addRow([l.replace(/^[#>*\-]\s*/, '')]));
    ws.eachRow((row: any) => row.eachCell((cell: any) => {
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } };
    }));
  } else {
    tables.forEach((rows, i) => {
      const ws = wb.addWorksheet(`表${i + 1}`);
      applyWorksheetPrintDefaults(ws, '1:1');
      rows.forEach((r) => ws.addRow(r));
      if (rows.length) {
        styleHeader(ws.getRow(1), 'FF5B6C8F');
        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: rows[0]!.length } };
      }
      rows[0]?.forEach((_, idx) => { ws.getColumn(idx + 1).width = Math.max(12, Math.min(32, Math.max(...rows.map((r) => String(r[idx] || '').length)) + 4)); });
      ws.eachRow((row: any, rowNumber: number) => {
        if (rowNumber === 1) return;
        row.eachCell((cell: any) => {
          cell.alignment = { vertical: 'top', wrapText: true };
          cell.border = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } };
        });
      });
    });
  }
  await wb.xlsx.writeFile(fp);
}

/** md → pptx:按标题分页 */
function normalizePptMarkdown(md: string): string {
  const raw = md.trim();
  const parts = raw.split(/\n(?=#{1,3}\s)/).filter((p) => p.trim());
  if (parts.length >= 3 && /目录|重点|问题|风险|计划|下一步|结论|汇报逻辑/.test(raw)) return raw;

  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s*/, '').replace(/^#{1,6}\s*/, ''));
  if (!lines.length) return raw;
  const title = lines.shift() || '商务汇报';
  const buckets: Record<'summary' | 'risk' | 'next' | 'support', string[]> = {
    summary: [],
    risk: [],
    next: [],
    support: [],
  };
  for (const line of lines) {
    if (/问题|风险|不足|滞后|缺口|困难|待协调|需协调|异常/.test(line)) buckets.risk.push(line);
    else if (/下一步|计划|下月|后续|推进|完成|落实|优化|安排|建议/.test(line)) buckets.next.push(line);
    else if (/数据|依据|来源|支撑|附件|口径|说明|背景/.test(line)) buckets.support.push(line);
    else buckets.summary.push(line);
  }
  const sections: Array<[string, string[]]> = [
    ['重点结论', buckets.summary],
    ['问题与风险', buckets.risk],
    ['下一步安排', buckets.next],
    ['支撑材料', buckets.support],
  ].filter(([, items]) => items.length);
  if (sections.length < 2) return raw;
  return [
    `# ${title}`,
    '',
    ...sections.flatMap(([name, items], idx) => [
      `## 第${idx + 1}页: ${name}`,
      ...items.slice(0, 10).map((item) => `- ${item}`),
      '',
    ]),
  ].join('\n').trim();
}

async function toPptx(md: string, fp: string): Promise<void> {
  const mod = await importBundled<any>('pptxgenjs');
  const PptxGen = mod.default || mod;
  const pptx = new PptxGen();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'AIOS';
  pptx.company = 'AIOS';
  pptx.subject = 'AIOS 商务办公交付';
  pptx.lang = 'zh-CN';
  pptx.theme = {
    headFontFace: 'Microsoft YaHei',
    bodyFontFace: 'Microsoft YaHei',
    lang: 'zh-CN',
  };
  const normalized = normalizePptMarkdown(md);
  const parts = normalized.split(/\n(?=#{1,3}\s)/).filter((p) => p.trim());
  const chunks = parts.length ? parts : [md];
  const slideTitles = chunks.map((p, idx) => {
    const line = p.split('\n').find((l) => /^#{1,3}\s/.test(l));
    return (line ? line.replace(/^#+\s*/, '').replace(/^第\d+页[:：]?\s*/, '') : `第 ${idx + 1} 部分`).trim();
  });
  const mainTitle = slideTitles[0] || '商务汇报';
  const addFooter = (slide: any, page: number) => {
    slide.addText('AIOS', { x: 0.55, y: 7.08, w: 1.2, h: 0.22, fontSize: 8, color: '8A8F98' });
    slide.addText(String(page), { x: 12.35, y: 7.08, w: 0.4, h: 0.22, fontSize: 8, color: '8A8F98', align: 'right' });
  };

  let page = 1;
  const cover = pptx.addSlide();
  cover.background = { color: 'F5F7FA' };
  cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.18, fill: { color: '1F4E78' }, line: { color: '1F4E78' } });
  cover.addText(mainTitle, { x: 0.72, y: 1.75, w: 11.9, h: 1.15, fontSize: 34, bold: true, color: '1F2937', breakLine: false });
  cover.addText('AIOS 商务办公交付', { x: 0.75, y: 3.05, w: 5.6, h: 0.35, fontSize: 15, color: '4B5563' });
  cover.addText('可编辑 PPTX · 自动结构化 · 适合办公室汇报', { x: 0.75, y: 3.55, w: 7.2, h: 0.3, fontSize: 11, color: '6B7280' });
  addFooter(cover, page++);

  if (slideTitles.length > 1) {
    const agenda = pptx.addSlide();
    agenda.background = { color: 'FFFFFF' };
    agenda.addText('目录', { x: 0.6, y: 0.45, w: 11.8, h: 0.55, fontSize: 28, bold: true, color: '1F2937' });
    slideTitles.slice(0, 8).forEach((title, idx) => {
      agenda.addText(`${idx + 1}. ${title}`, { x: 0.95, y: 1.35 + idx * 0.52, w: 10.8, h: 0.34, fontSize: 16, color: '374151' });
    });
    addFooter(agenda, page++);
  }

  const addContentSlide = (title: string, bodyLines: string[], suffix = '') => {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.16, fill: { color: '1F4E78' }, line: { color: '1F4E78' } });
    slide.addText(`${title}${suffix}`, { x: 0.6, y: 0.45, w: 11.8, h: 0.72, fontSize: 26, bold: true, color: '1F2937', margin: 0.02 });
    slide.addShape(pptx.ShapeType.line, { x: 0.6, y: 1.25, w: 12.1, h: 0, line: { color: 'D1D5DB', width: 1 } });
    slide.addText(bodyLines.join('\n') || ' ', { x: 0.72, y: 1.55, w: 11.7, h: 4.95, fontSize: 16, color: '374151', valign: 'top', breakLine: false, fit: 'shrink' });
    addFooter(slide, page++);
  };

  for (const p of chunks) {
    const lines = p.split('\n');
    const tIdx = lines.findIndex((l) => /^#{1,3}\s/.test(l));
    const title = (tIdx >= 0 ? lines[tIdx]!.replace(/^#+\s*/, '').replace(/^第\d+页[:：]?\s*/, '') : '幻灯片').trim() || '幻灯片';
    const bodyLines = lines
      .filter((_, i) => i !== tIdx)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^[-*]\s*/, '• ').replace(/^#{1,6}\s*/, ''));
    const pages = Math.max(1, Math.ceil(bodyLines.length / 8));
    for (let idx = 0; idx < pages; idx++) {
      addContentSlide(title, bodyLines.slice(idx * 8, idx * 8 + 8), pages > 1 ? ` (${idx + 1})` : '');
    }
  }
  await pptx.writeFile({ fileName: fp });
}

/** 按文件名扩展名写交付文件:docx/pdf/xlsx/pptx 自动转换并补齐工具,其余按文本写 */
export async function writeDeliverable(output: string, name: string, dir: string): Promise<string> {
  const ext = (name.split('.').pop() || 'md').toLowerCase();
  // 空内容 kill-switch:模型输出退化成空白时,过去仍会写出带封面页的合法空壳 OOXML
  // (7-8KB,"打得开但什么都没有")。直接失败让上游走返修,而不是把空壳交付给用户。
  if (['docx', 'pdf', 'pptx', 'xlsx'].includes(ext) && output.trim().length < 30) {
    throw new Error(
      `deliverable_empty_content:${name} 的生成内容为空或过短(${output.trim().length} 字符),拒绝写出空壳文件`,
    );
  }
  const fp = join(dir, name);
  if (ext === 'docx') await toDocx(output, fp);
  else if (ext === 'pdf') await toPdf(output, fp);
  else if (ext === 'xlsx') await toXlsx(output, fp, basename(name));
  else if (ext === 'pptx') await toPptx(output, fp);
  else if (ext === 'html') writeFileSync(fp, extractByExt(output, 'html'), 'utf8');
  else writeFileSync(fp, ext === 'md' || ext === 'txt' ? output.trim() : extractByExt(output, ext), 'utf8');
  return fp;
}
