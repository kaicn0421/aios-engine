import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeDeliverable } from './build';
import type { DeliveryFile } from './office-quality';
import type { EventSink } from './types';

type Row = Array<string | number | Date | null>;

export function isFidicContractRadarGoal(goal: string): boolean {
  return /(FIDIC|菲迪克|工程合同|合同雷达|索赔|time-?bar|notice|DAAB|DAB|工程师决定|变更指令|EOT|工期索赔|付款申请|BOQ)/i.test(goal);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function disclaimer(): string {
  return [
    '本交付包用于工程合同管理、商务索赔辅助和证据整理,不是法律意见。',
    'FIDIC 条款文本及项目合同全文应由用户导入其合法持有版本;AIOS 不内置 FIDIC 版权原文。',
    '涉及当地法、争议策略、最终发函和权利保留时,必须由项目商务负责人/律师复核。',
  ].join(' ');
}

function healthDoc(goal: string): string {
  return [
    '# FIDIC / 工程合同健康体检报告',
    '',
    `> 任务: ${goal}`,
    `> 生成日期: ${today()}`,
    `> 边界说明: ${disclaimer()}`,
    '',
    '## 一、执行摘要',
    '',
    'AIOS 已按工程合同管理视角生成第一版合同雷达交付包。本版重点不是替代律师判断,而是帮助项目商务团队快速建立:条款风险、Notice 时限、索赔机会、证据缺口和拟发函动作的统一台账。',
    '',
    '| 重点事项 | 初步判断 | 复核要求 |',
    '|---|---|---|',
    '| Particular Conditions 偏离 | 需逐条对照通用条件和合同数据表 | 导入合同正文后更新 source_map |',
    '| Notice / Time-Bar | 已建立时限台账模板 | 确认事件起算日、合同通知期限、接收对象 |',
    '| 索赔机会 | 已按 EOT/Cost/Variation/Payment 分类 | 补齐指令、会议纪要、进度影响和费用证据 |',
    '| 证据链 | 已建立证据缺口清单 | 每个结论需绑定文件名、页码/段落、日期 |',
    '',
    '## 二、合同雷达工作流',
    '',
    '1. 读取主合同、特别条件、合同数据表、BOQ、技术规范和附件目录。',
    '2. 抽取 Notice、索赔、变更、付款、工程师决定、争议解决、适用法律等条款族。',
    '3. 对比 Particular Conditions 是否改变标准风险分配、期限、程序或通知对象。',
    '4. 根据事件/函件/纪要生成 Notice 日历和索赔机会雷达。',
    '5. 对每条风险建立 source_map 和 evidence_gap,未证实部分不得写成确定结论。',
    '',
    '## 三、优先风险清单',
    '',
    '| 风险 | 为什么重要 | 当前处理 |',
    '|---|---|---|',
    '| 通知期限被修改 | 可能触发 time-bar 或削弱索赔权利 | 在 Notice 日历中维护起算日、期限和倒计时 |',
    '| 特别条件改写风险分配 | 现场按通用条件理解会漏风险 | 在合同偏离清单中标红 |',
    '| 证据链断裂 | 有事件但无法证明因果和影响 | 在证据缺口清单中列文件、照片、纪要、进度影响 |',
    '| 付款/计量口径不清 | 影响现金流和结算争议 | 在付款/BOQ 核查列中维护口径和依据 |',
    '',
    '## 四、下一步',
    '',
    '- 导入项目真实合同文本和 Particular Conditions,替换模板中的待确认项。',
    '- 每周更新 Notice 日历和证据缺口,把即将到期事项推给责任人。',
    '- 所有拟发函先由项目商务负责人确认事实、条款、对象和日期。',
  ].join('\n');
}

function letterDraft(goal: string): string {
  return [
    '# FIDIC / 工程合同拟发函草稿包',
    '',
    `> 任务: ${goal}`,
    `> 生成日期: ${today()}`,
    `> 边界说明: ${disclaimer()}`,
    '',
    '## 一、Notice of Event / Potential Claim 草稿',
    '',
    '致: [Employer / Engineer / Contract Administrator]',
    '',
    '主题: Notice of Event and Reservation of Rights',
    '',
    '我方注意到 [事件名称] 于 [事件日期/首次可知日期] 发生,可能对工期、费用或合同履约造成影响。根据合同中关于通知、索赔和工程师决定的相关程序,我方谨此发出通知并保留进一步提交详细资料和主张的权利。',
    '',
    '初步事实:',
    '',
    '| 事项 | 内容 | 证据来源 |',
    '|---|---|---|',
    '| 事件 | [填写事件] | [文件/页码/照片/会议纪要] |',
    '| 影响 | [工期/费用/资源/现场条件] | [进度计划/日报/月报] |',
    '| 当前缺口 | [待补证据] | [责任人/期限] |',
    '',
    '请贵方确认收到本通知。我方将在合同允许期限内提交进一步资料。',
    '',
    '## 二、Request for Determination 草稿',
    '',
    '就 [争议/计量/付款/变更事项],我方请求工程师/合同管理员依据合同约定进行确认或决定。随函附上事实说明、条款依据、证据索引和影响测算。若资料仍需补充,请明确需补充清单和期限。',
    '',
    '## 三、人工复核清单',
    '',
    '- 是否确认收函对象、送达方式和合同约定地址。',
    '- 是否确认 Notice 起算日和提交期限。',
    '- 是否确认条款引用来自项目真实合同,而不是通用记忆。',
    '- 是否确认所有事实均有证据来源。',
    '- 是否由项目商务负责人/律师复核当地法与争议策略。',
  ].join('\n');
}

async function excelJs() {
  const mod = (await import('exceljs')) as any;
  return mod.default || mod;
}

function applyBaseSheet(ws: any, title: string, subtitle: string, endCol: string) {
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  ws.pageSetup = {
    paperSize: 9,
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.35, right: 0.35, top: 0.55, bottom: 0.55, header: 0.2, footer: 0.2 },
    printTitlesRow: '1:4',
  };
  ws.mergeCells(`A1:${endCol}1`);
  ws.getCell('A1').value = title;
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  ws.mergeCells(`A2:${endCol}2`);
  ws.getCell('A2').value = subtitle;
  ws.getCell('A2').font = { italic: true, color: { argb: 'FF666666' } };
}

function styleHeader(row: any) {
  row.eachCell((cell: any) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF305496' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD9E2F3' } } };
  });
}

function addDictionary(wb: any, rows: string[][]) {
  const ws = wb.addWorksheet('字段说明');
  ws.addRows([['字段', '填写说明'], ...rows]);
  styleHeader(ws.getRow(1));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.columns = [{ width: 24 }, { width: 88 }];
  ws.eachRow((row: any) => row.eachCell((cell: any) => {
    cell.alignment = { vertical: 'top', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } } };
  }));
}

function addDashboard(wb: any, rows: Row[]) {
  const ws = wb.addWorksheet('统计看板');
  ws.mergeCells('A1:D1');
  ws.getCell('A1').value = '合同雷达统计看板';
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  ws.addRow([]);
  ws.addRow(['指标', '数值', '说明', '复核']);
  rows.forEach((r) => ws.addRow(r));
  styleHeader(ws.getRow(3));
  ws.columns = [{ width: 24 }, { width: 16 }, { width: 44 }, { width: 18 }];
}

async function writeWorkbook(fp: string, sheetName: string, title: string, subtitle: string, headers: string[], rows: Row[], dict: string[][]) {
  const ExcelJS = await excelJs();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AIOS Contract Radar';
  wb.created = new Date();
  wb.modified = new Date();
  const ws = wb.addWorksheet(sheetName);
  const endCol = String.fromCharCode(64 + Math.min(headers.length, 26));
  applyBaseSheet(ws, title, subtitle, endCol);
  ws.getRow(4).values = headers;
  styleHeader(ws.getRow(4));
  rows.forEach((r, i) => {
    ws.getRow(5 + i).values = r;
  });
  while (ws.rowCount < 18) ws.addRow([]);
  ws.addTable({
    name: sheetName.replace(/[^\w\u4e00-\u9fa5]/g, ''),
    ref: 'A4',
    headerRow: true,
    totalsRow: false,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: headers.map((name) => ({ name, filterButton: true })),
    rows: Array.from({ length: Math.max(12, rows.length) }, (_, idx) => {
      const row = ws.getRow(5 + idx).values as any[];
      return headers.map((_, colIdx) => row[colIdx + 1] ?? null);
    }),
  });
  headers.forEach((h, idx) => {
    const col = ws.getColumn(idx + 1);
    col.width = Math.max(12, Math.min(28, h.length * 2 + 6));
    if (/日期|期限|起算/.test(h)) col.numFmt = 'yyyy-mm-dd';
    if (/天|倒计时|金额|影响/.test(h)) col.numFmt = '#,##0';
  });
  for (let r = 5; r <= 24; r += 1) {
    const riskCol = headers.findIndex((h) => /风险|等级|复核/.test(h)) + 1;
    if (riskCol > 0) ws.getCell(r, riskCol).dataValidation = { type: 'list', allowBlank: true, formulae: ['"高,中,低,需人工复核"'] };
    const statusCol = headers.findIndex((h) => /状态|闭环/.test(h)) + 1;
    if (statusCol > 0) ws.getCell(r, statusCol).dataValidation = { type: 'list', allowBlank: true, formulae: ['"待确认,补证据中,已发函,已闭环,需人工复核"'] };
  }
  const formulaCol = headers.findIndex((h) => /倒计时/.test(h)) + 1;
  if (formulaCol > 0) {
    for (let r = 5; r <= 24; r += 1) ws.getCell(r, formulaCol).value = { formula: `IF(D${r}="","",D${r}-TODAY())` };
  }
  addDictionary(wb, dict);
  addDashboard(wb, [
    ['高风险事项', `=COUNTIF(${sheetName}!H5:H24,"高")`, '按风险等级统计', '需每日检查'],
    ['需人工复核', `=COUNTIF(${sheetName}!H5:H24,"需人工复核")`, '法律/条款不确定项', '项目商务/律师'],
    ['待确认事项', `=COUNTIF(${sheetName}!I5:I24,"待确认")`, '尚未闭环动作', '责任人跟进'],
  ]);
  await wb.xlsx.writeFile(fp);
}

export async function buildFidicContractRadarPackage(goal: string, understanding: string, dir: string, emit: EventSink): Promise<{ files: DeliveryFile[]; sourceMap: unknown }> {
  mkdirSync(dir, { recursive: true });
  const files: DeliveryFile[] = [];
  emit({ type: 'result.step', stage: 'contract_radar', message: 'Building FIDIC contract health report' });
  files.push({ name: '合同健康体检.docx', path: await writeDeliverable(healthDoc(goal), '合同健康体检.docx', dir) });
  emit({ type: 'result.step', stage: 'contract_radar', message: 'Building Notice / Time-Bar calendar' });
  const noticePath = join(dir, 'Notice-TimeBar日历.xlsx');
  await writeWorkbook(
    noticePath,
    'Notice日历',
    'Notice / Time-Bar 日历',
    '用于维护事件、起算日、合同期限、接收对象、证据和倒计时。起算日不确定时必须列多情景,不得瞎算。',
    ['事件编号', '事件类型', '触发事实', '起算日期', '合同期限(天)', '倒计时(天)', '通知对象', '风险等级', '状态', '条款/来源', '证据缺口', '责任人'],
    [
      ['EVT-001', '潜在索赔通知', '工程师口头指令导致返工', new Date(), 28, null, 'Engineer / Employer', '需人工复核', '待确认', '待导入项目合同条款', '缺书面指令和现场记录', '商务经理'],
      ['EVT-002', '付款/计量争议', '付款申请未按期确认', new Date(), 14, null, 'Employer / Engineer', '中', '待确认', '待导入付款条款', '缺收件证明', '合约工程师'],
    ],
    [
      ['起算日期', '来自事件首次发生/首次可知日期;如不确定,列多个情景。'],
      ['合同期限(天)', '来自项目真实合同/特别条件,不得使用模型记忆。'],
      ['倒计时(天)', '公式列,用于识别即将 time-bar 的事项。'],
      ['条款/来源', '必须填写文件名、页码/段落或用户确认来源。'],
    ],
  );
  files.push({ name: 'Notice-TimeBar日历.xlsx', path: noticePath });
  emit({ type: 'result.step', stage: 'contract_radar', message: 'Building claim opportunity radar' });
  const claimPath = join(dir, '索赔机会雷达.xlsx');
  await writeWorkbook(
    claimPath,
    '索赔机会',
    '索赔机会雷达',
    '按 EOT / Cost / Variation / Payment / Unforeseeable Conditions 分类,把机会、证据、缺口和下一步动作放到同一张表。',
    ['机会编号', '机会类型', '事实摘要', '可能影响', '金额/工期影响', '当前证据', '证据覆盖率%', '风险等级', '状态', '条款/来源', '下一步动作', '责任人'],
    [
      ['CLM-001', 'Variation', '工程师指令调整施工范围', '费用+工期', '待测算', '会议纪要/现场照片待导入', 45, '需人工复核', '待确认', '待导入变更条款', '补书面指令和工程量记录', '商务经理'],
      ['CLM-002', 'EOT', '关键路径受业主原因影响', '工期', '待测算', '进度计划/月报待导入', 35, '高', '待确认', '待导入 EOT 条款', '建立因果链和关键路径说明', '计划工程师'],
    ],
    [
      ['机会类型', 'EOT、Cost、Variation、Payment、Unforeseeable Conditions 等。'],
      ['证据覆盖率%', 'AIOS 初步评估证据完整度;低于 70% 不建议直接对外发强结论。'],
      ['下一步动作', '必须是可执行动作,如补证据、发 Notice、测算影响、提请确定。'],
    ],
  );
  files.push({ name: '索赔机会雷达.xlsx', path: claimPath });
  emit({ type: 'result.step', stage: 'contract_radar', message: 'Building evidence gap list' });
  const evidencePath = join(dir, '证据缺口清单.xlsx');
  await writeWorkbook(
    evidencePath,
    '证据缺口',
    '证据缺口清单',
    '每个主张必须绑定事实、条款、文件、页码/段落、照片/纪要/进度影响。缺口不补齐,不得标 ready_to_use。',
    ['证据编号', '对应事项', '所需证据', '已有证据', '缺口描述', '来源文件/页码', '补证责任人', '风险等级', '状态', '截止日期', '备注'],
    [
      ['EVD-001', 'CLM-001', '工程师书面指令', '口头指令/会议提及', '缺正式书面确认', '待导入', '合约工程师', '高', '待确认', new Date(), '优先补书面确认'],
      ['EVD-002', 'CLM-002', '关键路径影响分析', '月报摘要', '缺更新进度计划和因果链', '待导入', '计划工程师', '高', '待确认', new Date(), '与计划部门核对'],
    ],
    [
      ['所需证据', '应能证明事实、影响、因果、金额/工期。'],
      ['来源文件/页码', '填写文件名、页码、段落、照片编号或会议纪要编号。'],
      ['风险等级', '缺关键证据且有期限风险时标高。'],
    ],
  );
  files.push({ name: '证据缺口清单.xlsx', path: evidencePath });
  emit({ type: 'result.step', stage: 'contract_radar', message: 'Building draft letters' });
  files.push({ name: '拟发函草稿.docx', path: await writeDeliverable(letterDraft(goal), '拟发函草稿.docx', dir) });
  const sourceMap = {
    schema: 'aios.contract_radar_source_map.v1',
    generated_at: new Date().toISOString(),
    goal,
    understanding,
    copyright_boundary: 'AIOS 内置 playbook/schema,不内置 FIDIC 版权全文;需用户导入合法合同文本后绑定条款来源。',
    required_inputs: ['主合同', 'Particular Conditions', 'Contract Data', 'BOQ', '往来函件', '会议纪要', '进度计划/月报', '现场照片/日报', '当地法律或律师意见'],
    source_status: 'template_until_user_contract_ingested',
    human_review_required: true,
  };
  const sourceMapPath = join(dir, 'contract_source_map.json');
  writeFileSync(sourceMapPath, JSON.stringify(sourceMap, null, 2), 'utf8');
  files.push({ name: 'contract_source_map.json', path: sourceMapPath });
  return { files, sourceMap };
}

