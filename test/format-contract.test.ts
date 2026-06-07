import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { assemble } from '../src/result';
import { pdfBrowserCandidates, writeDeliverable } from '../src/build';
import { defaultOutFileForFormat, officeFileSignatureOk, officeFormatsFromGoal } from '../src/office-format';
import { buildOfficeQualityArtifacts } from '../src/office-quality';
import type { AgentResult, AiosEvent, Plan } from '../src/types';

async function startLocalSource(body: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('local source server failed to start');
  return {
    url: `http://127.0.0.1:${address.port}/source`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

test('office intent detection covers common Chinese business deliverables', () => {
  const cases: Array<[string, string[]]> = [
    ['做一个合同台账模板 字段适合办公室使用', ['xlsx']],
    ['做一个采购比价表 给项目部用', ['xlsx']],
    ['做一份资料归档登记表', ['xlsx']],
    ['做一个会议督办跟踪表', ['xlsx']],
    ['写一份办公室采购流程优化建议书', ['docx']],
    ['整理一份项目情况说明', ['docx']],
    ['做一个月度工作汇报PPT', ['pptx']],
    ['做一份调研报告并导出PDF', ['docx', 'pdf']],
  ];
  for (const [goal, expected] of cases) {
    assert.deepEqual(officeFormatsFromGoal(goal), expected, goal);
  }
});

test('contract ledger naming keeps contract domain even when payment and invoice are mentioned', () => {
  const goal = '做一个中铁办公室合同台账 Excel 模板 字段要适合日常合同管理、付款节点、发票、履约风险跟踪';
  assert.equal(defaultOutFileForFormat(goal, 'xlsx'), '合同台账模板.xlsx');
});

test('weekly report quality rejects generic PDF filename even when file exists', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-weekly-name-'));
  try {
    const path = join(outDir, 'AIOS交付物.pdf');
    writeFileSync(path, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(9000, 32)]));
    const { manifest } = await buildOfficeQualityArtifacts(
      '写一份中铁办公室项目周报 Word 和 PDF，内容包括本周完成、问题风险、下周计划、需要领导协调事项',
      [{ name: 'AIOS交付物.pdf', path }],
      outDir,
      true,
    );
    const pdfQuality = manifest.files.find((f: any) => f.name === 'AIOS交付物.pdf');
    assert.ok(pdfQuality?.checks.some((c: any) => c.id === 'pdf_filename_domain' && !c.ok), JSON.stringify(manifest));
    assert.equal(manifest.status, 'fail');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('office agent prompt contract forces structured spreadsheet output', () => {
  const brain = readFileSync(join(process.cwd(), 'src/brain.ts'), 'utf8');
  const agent = readFileSync(join(process.cwd(), 'src/agent.ts'), 'utf8');
  assert.match(brain, /必须包含一张 Markdown 表格/);
  assert.match(brain, /第一行是本任务专属字段/);
  assert.match(agent, /Excel 输出硬规则/);
  assert.match(agent, /表头必须贴合本次 prompt 的真实业务字段/);
  assert.match(agent, /至少 8 个字段、2 行样例数据/);
  assert.match(agent, /PPT 输出硬规则/);
  assert.match(agent, /Word\/PDF 输出硬规则/);
});

test('FIDIC contract radar prompts deliver editable expert package', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-fidic-radar-'));
  try {
    const goal = '做一个 FIDIC 合同雷达，帮项目商务部识别 Notice time-bar、索赔机会、证据缺口和拟发函';
    assert.deepEqual(officeFormatsFromGoal(goal), ['docx', 'xlsx']);
    const plan: Plan = {
      goal,
      understanding: '生成 FIDIC 工程合同雷达专业交付包',
      kind: 'document',
      subtasks: [{
        id: 's1',
        title: '合同雷达专业标准',
        objective: '确立 FIDIC 合同管理和索赔辅助标准',
        skill: 'analysis',
        complexity: 'deep',
        dependsOn: [],
      }],
    };
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '合同雷达专业标准',
      skill: 'analysis',
      model: 'mock',
      ok: true,
      ms: 1,
      output: 'FIDIC 合同雷达必须覆盖 Notice、Time-Bar、Variation、EOT、Payment、DAAB、证据缺口和人工复核。',
    }];
    const events: AiosEvent[] = [];
    const d = await assemble(plan, results, 1, outDir, (e) => events.push(e));
    assert.ok(d.dir, 'should create contract radar project directory');
    const names = (d.files || []).map((f) => f.name);
    for (const name of ['合同健康体检.docx', 'Notice-TimeBar日历.xlsx', '索赔机会雷达.xlsx', '证据缺口清单.xlsx', '拟发函草稿.docx', 'contract_source_map.json', 'delivery_manifest.json']) {
      assert.ok(names.includes(name), `${name} missing in ${JSON.stringify(names)}`);
    }
    assert.ok(events.some((e) => e.type === 'result.step' && e.stage === 'contract_radar'), JSON.stringify(events));
    const notice = d.files!.find((f) => f.name === 'Notice-TimeBar日历.xlsx')!;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(notice.path);
    assert.ok(wb.getWorksheet('Notice日历'));
    assert.ok(wb.getWorksheet('字段说明'));
    assert.ok(wb.getWorksheet('统计看板'));
    const quality = JSON.parse(readFileSync(d.office_quality_manifest!, 'utf8'));
    assert.equal(quality.status, 'pass', JSON.stringify(quality));
    assert.ok(quality.files.some((f: any) => f.name === 'Notice-TimeBar日历.xlsx'
      && f.checks.some((c: any) => c.id === 'xlsx_prompt_relevance' && c.ok)));
    const manifest = JSON.parse(readFileSync(d.delivery_manifest!, 'utf8'));
    assert.equal(manifest.domain, 'fidic_contract_radar');
    assert.equal(manifest.contract_radar.schema, 'aios.contract_radar.v1');
    assert.equal(manifest.contract_radar.human_review_required, true);
    assert.match(manifest.contract_radar.copyright_boundary, /不内置 FIDIC 版权全文/);
    assert.equal(manifest.format_contract.html_artifact_allowed, false);
    assert.equal(manifest.smoke.status, 'pass');
    assert.equal(manifest.task_satisfaction.schema, 'aios.task_satisfaction.v1');
    assert.ok(manifest.task_satisfaction.score >= 80, JSON.stringify(manifest.task_satisfaction));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('office Excel delivery writes xlsx instead of html artifact', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-format-'));
  try {
    const goal = '做一个合同台账的Excel模板 字段适合办公室使用\n\n# AIOS 办公交付物质量契约\n{"schema":"aios.office_deliverable_profile.v1","formats":["xlsx"]}';
    const plan: Plan = {
      goal,
      understanding: '生成办公室合同台账 Excel 模板',
      kind: 'document',
      subtasks: [{
        id: 's1',
        title: '合同台账字段设计',
        objective: '生成可编辑 Excel 台账模板',
        skill: 'data',
        complexity: 'standard',
        dependsOn: [],
        outFile: '合同台账模板.xlsx',
      }],
    };
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '合同台账字段设计',
      skill: 'data',
      model: 'mock',
      ok: true,
      ms: 1,
      output: [
        '| 合同编号 | 合同名称 | 供应商 | 合同金额 | 签订日期 | 履约状态 | 到期日期 | 责任人 | 备注 |',
        '|---|---|---|---:|---|---|---|---|---|',
        '| HT-001 | 示例合同 | 示例供应商 | 10000 | 2026-06-04 | 履约中 | 2026-12-31 | 办公室 | 示例 |',
      ].join('\n'),
    }];
    const events: AiosEvent[] = [];
    const d = await assemble(plan, results, 1, outDir, (e) => events.push(e));
    assert.ok(d.dir, 'should create project directory');
    assert.ok(d.files?.some((f) => f.name.endsWith('.xlsx')), JSON.stringify(d.files));
    assert.ok(!d.artifactPath, 'office Excel must not be returned as html artifact');
    const readme = readFileSync(join(d.dir!, 'README.md'), 'utf8');
    assert.match(readme, /Task 满意度/);
    assert.match(readme, /First-Pass Usable: 是/);
    assert.match(readme, /优先打开: 合同台账模板\.xlsx/);
    assert.match(readme, /修改说明/);
    assert.match(readme, /可编辑源文件: 合同台账模板\.xlsx/);
    assert.match(readme, /office_quality_manifest\.json/);
    assert.match(readme, /source_content\.md/);
    assert.match(readme, /delivery_manifest\.json/);
    assert.ok(d.office_quality_manifest, 'office delivery should write a quality manifest');
    const quality = JSON.parse(readFileSync(d.office_quality_manifest!, 'utf8'));
    assert.equal(quality.schema, 'aios.office_quality_manifest.v1');
    assert.equal(quality.status, 'pass');
    assert.ok(quality.rules.some((r: string) => /OB|正式交付|Office|Excel|PDF/.test(r)));
    const xlsxQuality = quality.files.find((f: any) => f.name === '合同台账模板.xlsx');
    assert.ok(xlsxQuality, JSON.stringify(quality.files));
    assert.ok(xlsxQuality.checks.some((c: any) => c.id === 'xlsx_prompt_relevance' && c.ok));
    assert.ok(xlsxQuality.checks.some((c: any) => c.id === 'xlsx_minimum_fields' && c.ok && /主表字段数:20/.test(c.detail)));
    assert.ok(xlsxQuality.checks.some((c: any) => c.id === 'xlsx_sample_rows' && c.ok));
    assert.ok(xlsxQuality.checks.some((c: any) => c.id === 'xlsx_table_filter' && c.ok));
    assert.ok(d.delivery_manifest, 'office delivery should write a delivery manifest');
    const manifest = JSON.parse(readFileSync(d.delivery_manifest!, 'utf8'));
    assert.equal(manifest.schema, 'aios.delivery_manifest.v1');
    assert.equal(manifest.primary, '合同台账模板.xlsx');
    assert.equal(manifest.source_content, 'source_content.md');
    assert.deepEqual(manifest.format_contract.requested_formats, ['xlsx']);
    assert.equal(manifest.format_contract.primary_format, 'xlsx');
    assert.equal(manifest.format_contract.html_artifact_allowed, false);
    assert.equal(manifest.format_contract.compliance, 'pass');
    assert.equal(manifest.editability.primary_is_editable, true);
    assert.deepEqual(manifest.editability.editable_sources, ['合同台账模板.xlsx']);
    assert.equal(manifest.editability.source_content_path, 'source_content.md');
    assert.equal(manifest.smoke.status, 'pass');
    assert.equal(manifest.office_quality.status, 'pass');
    assert.equal(manifest.task_satisfaction.schema, 'aios.task_satisfaction.v1');
    assert.equal(manifest.task_satisfaction.north_star, 'first_pass_usable_rate');
    assert.equal(manifest.task_satisfaction.first_pass_usable, true);
    assert.equal(manifest.task_satisfaction.verdict, 'ready_to_use', JSON.stringify(manifest.task_satisfaction));
    assert.ok(manifest.task_satisfaction.score >= 90, JSON.stringify(manifest.task_satisfaction));
    assert.ok(manifest.task_satisfaction.dimensions.some((d: any) => d.id === 'format_fidelity' && d.score === d.max));
    assert.ok(manifest.task_satisfaction.dimensions.some((d: any) => d.id === 'business_polish' && d.score >= 12));
    assert.ok(Array.isArray(manifest.task_satisfaction.feedback_options));
    assert.ok(d.task_satisfaction, 'assemble should expose task satisfaction to app-server');
    assert.ok(manifest.smoke.checks.some((c: any) => c.id === 'primary_office_signature' && c.ok));
    assert.ok(manifest.smoke.checks.some((c: any) => c.id === 'required_office_signatures' && c.ok));
    const primaryEntry = manifest.files.find((f: any) => f.name === '合同台账模板.xlsx');
    assert.ok(primaryEntry, JSON.stringify(manifest.files));
    assert.equal(primaryEntry.role, 'primary');
    assert.ok(primaryEntry.bytes > 1000, JSON.stringify(primaryEntry));
    assert.match(primaryEntry.sha256, /^[a-f0-9]{64}$/);
    assert.equal(officeFileSignatureOk(primaryEntry.path, 'xlsx'), true);
    const sourceEntry = manifest.files.find((f: any) => f.name === 'source_content.md');
    assert.ok(sourceEntry, JSON.stringify(manifest.files));
    assert.equal(sourceEntry.role, 'source');
    assert.ok(sourceEntry.bytes > 0, JSON.stringify(sourceEntry));
    assert.match(sourceEntry.sha256, /^[a-f0-9]{64}$/);
    const selfEntry = manifest.files.find((f: any) => f.name === 'delivery_manifest.json');
    assert.ok(selfEntry, JSON.stringify(manifest.files));
    assert.equal(selfEntry.role, 'manifest');
    assert.equal(selfEntry.self_hash_excluded, true);
    const steps = events.filter((e): e is Extract<AiosEvent, { type: 'result.step' }> => e.type === 'result.step');
    assert.ok(steps.some((e) => e.stage === 'write' && /Writing editable deliverable/.test(e.message) && e.detail === '合同台账模板.xlsx'));
    assert.ok(steps.some((e) => e.stage === 'quality' && /Office quality verified/.test(e.message)));
    assert.ok(steps.some((e) => e.stage === 'smoke' && e.detail === 'pass'));
    assert.ok(steps.some((e) => e.stage === 'write' && e.detail === 'delivery_manifest.json'));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('restaurant listing plan writes both editable Word and printable PDF from plain user wording', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-restaurant-plan-formats-'));
  try {
    const goal = '帮我做一个从零开始到打造一个上市企业的计划 做泰餐吧 在宁波做一家店开始 目标是 10年干上市';
    assert.deepEqual(officeFormatsFromGoal(goal), ['docx', 'pdf']);
    const plan: Plan = {
      goal,
      understanding: '生成宁波泰餐项目从首店到上市的商业计划',
      kind: 'document',
      subtasks: [{
        id: 's1',
        title: '泰餐上市计划',
        objective: '制定宁波泰餐项目从首店到十年上市的完整计划',
        skill: 'writing',
        complexity: 'deep',
        dependsOn: [],
        outFile: '泰餐上市计划书.docx',
      }],
    };
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '泰餐上市计划',
      skill: 'writing',
      model: 'mock',
      ok: true,
      ms: 1,
      output: [
        '# 宁波泰餐项目十年上市计划',
        '',
        '## 一、项目定位',
        '从宁波首店起步,围绕泰餐品牌、门店模型、供应链标准化和上市公司治理建立长期路线。',
        '',
        '## 二、首店模型',
        '| 模块 | 关键动作 | 验收口径 |',
        '|---|---|---|',
        '| 选址 | 宁波核心商圈首店验证 | 月流水、翻台率、复购率达标 |',
        '| 产品 | 泰餐爆品与标准菜单 | 毛利、出餐稳定性和顾客评价达标 |',
        '| 供应链 | 食材、中央厨房、食品安全 SOP | 支撑多店复制 |',
        '',
        '## 三、十年上市路径',
        '第1年验证单店模型,第2-3年复制区域门店,第4-6年建立中央厨房和组织体系,第7-10年完成财务规范、融资和上市准备。',
        '',
        '## 四、风险与治理',
        '重点管理食品安全、租金、现金流、加盟控制、财务合规和品牌复购。',
      ].join('\n'),
    }];
    const events: AiosEvent[] = [];
    const d = await assemble(plan, results, 1, outDir, (e) => events.push(e));
    assert.ok(d.dir, 'should create delivery directory');
    const names = (d.files || []).map((f) => f.name);
    assert.ok(names.includes('泰餐上市计划书.docx'), JSON.stringify(names));
    assert.ok(names.includes('泰餐上市计划书.pdf'), JSON.stringify(names));
    assert.ok(events.some((e) => e.type === 'result.step' && e.stage === 'write' && e.detail === '泰餐上市计划书.pdf'), JSON.stringify(events));
    const manifest = JSON.parse(readFileSync(d.delivery_manifest!, 'utf8'));
    assert.deepEqual(manifest.required_formats, ['docx', 'pdf']);
    assert.deepEqual(manifest.format_contract.requested_formats, ['docx', 'pdf']);
    assert.equal(manifest.format_contract.html_artifact_allowed, false);
    assert.ok(manifest.smoke.checks.some((c: any) => c.id === 'required_formats_present' && c.ok), JSON.stringify(manifest.smoke));
    assert.equal(officeFileSignatureOk(join(d.dir!, '泰餐上市计划书.docx'), 'docx'), true);
    assert.equal(officeFileSignatureOk(join(d.dir!, '泰餐上市计划书.pdf'), 'pdf'), true);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('delivery with failed subtasks cannot be marked first-pass usable', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-failed-subtask-'));
  try {
    const plan: Plan = {
      goal: '做一个合同台账的Excel模板 字段适合办公室使用',
      understanding: '生成办公室合同台账 Excel 模板',
      kind: 'document',
      subtasks: [{
        id: 's1',
        title: '合同台账字段设计',
        objective: '生成可编辑 Excel 台账模板',
        skill: 'data',
        complexity: 'standard',
        dependsOn: [],
        outFile: '合同台账模板.xlsx',
      }, {
        id: 's2',
        title: '履约风险规则',
        objective: '补充履约风险规则',
        skill: 'analysis',
        complexity: 'standard',
        dependsOn: [],
      }],
    };
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '合同台账字段设计',
      skill: 'data',
      model: 'mock',
      ok: true,
      ms: 1,
      output: [
        '| 合同编号 | 合同名称 | 供应商 | 合同金额 | 签订日期 | 履约状态 | 到期日期 | 责任人 | 付款节点 | 发票状态 | 备注 |',
        '|---|---|---|---:|---|---|---|---|---|---|---|',
        '| HT-001 | 示例合同 | 示例供应商 | 10000 | 2026-06-04 | 履约中 | 2026-12-31 | 办公室 | 首付款 | 已开票 | 示例 |',
      ].join('\n'),
    }, {
      subtaskId: 's2',
      title: '履约风险规则',
      skill: 'analysis',
      model: 'timeout_guard',
      ok: false,
      ms: 240000,
      error: 'subtask_timeout_240000ms',
      output: 'TIMEOUT: 风险规则超时。',
    }];
    const d = await assemble(plan, results, 1, outDir);
    const manifest = JSON.parse(readFileSync(d.delivery_manifest!, 'utf8'));
    assert.equal(manifest.format_contract.compliance, 'fail');
    assert.equal(manifest.task_satisfaction.first_pass_usable, false);
    assert.equal(manifest.task_satisfaction.verdict, 'needs_repair');
    assert.ok(manifest.task_satisfaction.score < 80, JSON.stringify(manifest.task_satisfaction));
    assert.deepEqual(manifest.task_satisfaction.failed_subtasks, [{
      title: '履约风险规则',
      error: 'subtask_timeout_240000ms',
    }]);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('office quality fails when Excel content is generic and not prompt-specific', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-office-xlsx-relevance-'));
  try {
    const workbookPath = join(outDir, '设备巡检表.xlsx');
    const wb = new ExcelJS.Workbook();
    const main = wb.addWorksheet('业务明细');
    const dict = wb.addWorksheet('字段说明');
    const summary = wb.addWorksheet('统计看板');
    main.views = [{ state: 'frozen', ySplit: 4 }];
    main.pageSetup = { fitToPage: true, orientation: 'landscape' } as any;
    main.getRow(4).values = ['设备编号', '设备名称', '巡检日期', '巡检人', '位置', '风险等级', '当前状态', '处理措施', '备注'];
    main.getRow(5).values = ['SB-001', '空调', '2026-06-05', '张三', '一楼', '低', '正常', '定期清洁', '示例'];
    main.getRow(6).values = ['SB-002', '水泵', '2026-06-05', '李四', '机房', '中', '待处理', '更换配件', '示例'];
    main.addTable({
      name: '业务明细',
      ref: 'A4',
      headerRow: true,
      totalsRow: false,
      columns: ['设备编号', '设备名称', '巡检日期', '巡检人', '位置', '风险等级', '当前状态', '处理措施', '备注'].map((name) => ({ name, filterButton: true })),
      rows: [
        ['SB-001', '空调', '2026-06-05', '张三', '一楼', '低', '正常', '定期清洁', '示例'],
        ['SB-002', '水泵', '2026-06-05', '李四', '机房', '中', '待处理', '更换配件', '示例'],
      ],
    });
    main.getCell('G5').dataValidation = { type: 'list', allowBlank: true, formulae: ['"正常,待处理"'] };
    main.getCell('I7').value = { formula: 'COUNTA(A5:A6)' };
    dict.getRow(1).values = ['字段', '填写说明'];
    dict.getRow(2).values = ['设备编号', '填写设备编码'];
    summary.getRow(1).values = ['指标', '值'];
    summary.getRow(2).values = ['设备数', { formula: 'COUNTA(业务明细!A5:A6)' }];
    await wb.xlsx.writeFile(workbookPath);

    const quality = await buildOfficeQualityArtifacts(
      '做一个合同台账Excel模板 字段适合办公室使用',
      [{ name: '设备巡检表.xlsx', path: workbookPath }],
      outDir,
      true,
    );
    assert.equal(quality.manifest.status, 'fail');
    const xlsxQuality = quality.manifest.files.find((f: any) => f.name === '设备巡检表.xlsx');
    assert.ok(xlsxQuality, JSON.stringify(quality.files));
    assert.ok(xlsxQuality.checks.some((c: any) => c.id === 'xlsx_prompt_relevance' && !c.ok), JSON.stringify(xlsxQuality.checks));
    assert.ok(xlsxQuality.checks.some((c: any) => c.id === 'xlsx_domain_fit' && !c.ok), JSON.stringify(xlsxQuality.checks));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('contract ledger with payment and invoice terms does not route to expense template', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-contract-ledger-route-'));
  try {
    const plan: Plan = {
      goal: '做一个中铁办公室合同台账 Excel 模板 字段要适合日常合同管理、付款节点、发票、履约风险跟踪',
      understanding: '生成中铁办公室合同台账 Excel 模板',
      kind: 'document',
      subtasks: [{
        id: 's1',
        title: '合同台账字段设计',
        objective: '生成合同台账 Excel 模板',
        skill: 'data',
        complexity: 'standard',
        dependsOn: [],
        outFile: '合同台账模板.xlsx',
      }],
    };
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '合同台账字段设计',
      skill: 'data',
      model: 'mock',
      ok: true,
      ms: 1,
      output: [
        '| 合同编号 | 合同名称 | 签约方 | 合同金额(万元) | 签约日期 | 付款节点 | 发票状态 | 履约风险 | 归档情况 |',
        '|---|---|---|---|---|---|---|---|---|',
        '| HT2026001 | 采购合同 | 供应商A | 120 | 2026-01-01 | 首付款30% | 已开票 | 低 | 已归档 |',
        '| HT2026002 | 服务合同 | 供应商B | 80 | 2026-02-01 | 验收后付款 | 待开票 | 中 | 未归档 |',
      ].join('\n'),
    }];
    const d = await assemble(plan, results, 1, outDir);
    const xlsx = d.files?.find((f) => f.name === '合同台账模板.xlsx');
    assert.ok(xlsx, JSON.stringify(d.files));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(xlsx.path);
    assert.ok(wb.getWorksheet('合同台账'), wb.worksheets.map((ws) => ws.name).join(','));
    assert.ok(!wb.getWorksheet('费用报销台账'), wb.worksheets.map((ws) => ws.name).join(','));
    const quality = JSON.parse(readFileSync(d.office_quality_manifest!, 'utf8'));
    const q = quality.files.find((f: any) => f.name === '合同台账模板.xlsx');
    assert.ok(q.checks.some((c: any) => c.id === 'xlsx_filename_domain' && c.ok), JSON.stringify(q.checks));
    assert.ok(q.checks.some((c: any) => c.id === 'xlsx_domain_fit' && c.ok), JSON.stringify(q.checks));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('contract ledger quality rejects expense filename even when workbook content is correct', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-contract-ledger-name-gate-'));
  try {
    const plan: Plan = {
      goal: '做一个中铁办公室合同台账 Excel 模板 字段要适合日常合同管理、付款节点、发票、履约风险跟踪',
      understanding: '生成中铁办公室合同台账 Excel 模板',
      kind: 'document',
      subtasks: [{
        id: 's1',
        title: '合同台账字段设计',
        objective: '生成合同台账 Excel 模板',
        skill: 'data',
        complexity: 'standard',
        dependsOn: [],
        outFile: '费用报销台账模板.xlsx',
      }],
    };
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '合同台账字段设计',
      skill: 'data',
      model: 'mock',
      ok: true,
      ms: 1,
      output: [
        '| 合同编号 | 合同名称 | 签约方 | 合同金额(万元) | 签约日期 | 付款节点 | 发票状态 | 履约风险 | 归档情况 |',
        '|---|---|---|---|---|---|---|---|---|',
        '| HT2026001 | 采购合同 | 供应商A | 120 | 2026-01-01 | 首付款30% | 已开票 | 低 | 已归档 |',
        '| HT2026002 | 服务合同 | 供应商B | 80 | 2026-02-01 | 验收后付款 | 待开票 | 中 | 未归档 |',
      ].join('\n'),
    }];
    const d = await assemble(plan, results, 1, outDir);
    const quality = JSON.parse(readFileSync(d.office_quality_manifest!, 'utf8'));
    assert.equal(quality.status, 'fail', JSON.stringify(quality));
    const q = quality.files.find((f: any) => f.name === '费用报销台账模板.xlsx');
    assert.ok(q.checks.some((c: any) => c.id === 'xlsx_filename_domain' && !c.ok), JSON.stringify(q.checks));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('office format request overrides mistaken html artifact planning', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-format-override-'));
  try {
    const plan: Plan = {
      goal: '做一个合同台账的Excel模板 字段适合办公室使用',
      understanding: '生成办公室合同台账 Excel 模板',
      kind: 'artifact',
      subtasks: [{
        id: 's1',
        title: '合同台账模板',
        objective: '错误地生成了网页预览,但用户明确要 Excel',
        skill: 'code',
        complexity: 'standard',
        dependsOn: [],
      }],
    };
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '合同台账模板',
      skill: 'code',
      model: 'mock',
      ok: true,
      ms: 1,
      output: '<html><body>合同台账预览</body></html>',
    }];
    const d = await assemble(plan, results, 1, outDir);
    assert.ok(d.dir, 'explicit office format should create a project directory');
    assert.ok(!d.artifactPath, 'explicit Excel request must not be returned as html artifact');
    const xlsx = d.files?.find((f) => f.name === '合同台账模板.xlsx');
    assert.ok(xlsx, JSON.stringify(d.files));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(xlsx.path);
    assert.ok(wb.getWorksheet('合同台账'), 'fallback Excel should still use the office ledger template');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});


test('office spreadsheet prompts deliver editable xlsx project folders', async () => {
  const cases = [
    {
      goal: '做一个费用报销台账Excel模板 适合办公室日常登记\n\n# AIOS 办公交付物质量契约\n{"schema":"aios.office_deliverable_profile.v1","formats":["xlsx"]}',
      outFile: '费用报销台账模板.xlsx',
      output: [
        '| 报销编号 | 报销人 | 部门 | 费用类型 | 金额 | 发生日期 | 审批状态 | 付款状态 | 备注 |',
        '|---|---|---|---|---:|---|---|---|---|',
        '| BX-001 | 张三 | 办公室 | 差旅费 | 1200 | 2026-06-04 | 待审批 | 未付款 | 示例 |',
      ].join('\n'),
    },
    {
      goal: '做一个会议纪要跟踪清单Excel 字段适合中铁办公室使用\n\n# AIOS 办公交付物质量契约\n{"schema":"aios.office_deliverable_profile.v1","formats":["xlsx"]}',
      outFile: '会议纪要跟踪清单.xlsx',
      output: [
        '| 会议日期 | 会议主题 | 责任事项 | 责任部门 | 责任人 | 截止日期 | 完成状态 | 风险 | 备注 |',
        '|---|---|---|---|---|---|---|---|---|',
        '| 2026-06-04 | 周例会 | 补齐合同归档 | 办公室 | 李四 | 2026-06-10 | 进行中 | 中 | 示例 |',
      ].join('\n'),
    },
  ];

  for (const item of cases) {
    const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-office-xlsx-'));
    try {
      const plan: Plan = {
        goal: item.goal,
        understanding: '生成可编辑办公室 Excel 模板',
        kind: 'document',
        subtasks: [{
          id: 's1',
          title: '字段设计与模板生成',
          objective: '生成可编辑 Excel 台账模板',
          skill: 'data',
          complexity: 'standard',
          dependsOn: [],
          outFile: item.outFile,
        }],
      };
      const results: AgentResult[] = [{
        subtaskId: 's1',
        title: '字段设计与模板生成',
        skill: 'data',
        model: 'mock',
        ok: true,
        ms: 1,
        output: item.output,
      }];
      const d = await assemble(plan, results, 1, outDir);
      assert.ok(d.dir, `should create project directory for ${item.outFile}`);
      const xlsx = d.files?.find((f) => f.name === item.outFile);
      assert.ok(xlsx, JSON.stringify(d.files));
      assert.ok(!d.artifactPath, 'office spreadsheet must not be returned as html artifact');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(xlsx.path);
      assert.ok(wb.getWorksheet('字段说明'), 'business workbook should include a field dictionary');
      assert.ok(wb.getWorksheet('统计看板'), 'business workbook should include a summary dashboard');
      const qualityFile = d.files?.find((f) => f.name === 'office_quality_manifest.json');
      assert.ok(qualityFile, JSON.stringify(d.files));
      const quality = JSON.parse(readFileSync(qualityFile.path, 'utf8'));
      assert.equal(quality.status, 'pass');
      assert.ok(quality.score >= 85, JSON.stringify(quality));
      assert.ok(quality.files.some((f: any) => f.checks.some((c: any) => c.id === 'xlsx_field_dictionary' && c.ok)));
      const main = wb.worksheets[0]!;
      assert.ok(main.views?.some((v) => v.state === 'frozen'), 'main sheet should freeze headers');
      assert.equal(main.pageSetup.orientation, 'landscape');
      assert.equal(main.pageSetup.fitToPage, true);
      assert.match(String(main.headerFooter?.oddFooter || ''), /第 &P \/ &N 页/);
      if (item.outFile.includes('报销')) {
        assert.ok(wb.getWorksheet('费用报销台账'), 'expense workbook should use a business sheet name');
        assert.deepEqual(main.getCell('K5').value, { formula: 'IF(I5="","",MAX(I5-J5,0))' });
        assert.equal(main.getCell('F5').dataValidation?.type, 'list');
      }
      if (item.outFile.includes('会议')) {
        assert.ok(wb.getWorksheet('会议事项跟踪'), 'meeting workbook should use a business sheet name');
        assert.match(String((main.getCell('M5').value as { formula?: string }).formula || ''), /TODAY/);
        assert.equal(main.getCell('K5').dataValidation?.type, 'list');
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
});

test('generic office spreadsheet prompts use commercial ledger template', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-office-generic-xlsx-'));
  try {
    const plan: Plan = {
      goal: '做一个办公室资料归档清单Excel 适合中铁项目部日常使用\n\n# AIOS 办公交付物质量契约\n{"schema":"aios.office_deliverable_profile.v1","formats":["xlsx"]}',
      understanding: '生成办公室通用台账 Excel 模板',
      kind: 'document',
      subtasks: [{
        id: 's1',
        title: '资料归档清单字段设计',
        objective: '生成可编辑 Excel 清单模板',
        skill: 'data',
        complexity: 'standard',
        dependsOn: [],
        outFile: '资料归档清单.xlsx',
      }],
    };
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '资料归档清单字段设计',
      skill: 'data',
      model: 'mock',
      ok: true,
      ms: 1,
      output: [
        '| 序号 | 资料名称 | 类别 | 责任部门 | 责任人 | 截止日期 | 状态 | 归档位置 | 备注 |',
        '|---|---|---|---|---|---|---|---|---|',
        '| 1 | 办公资料归档 | 资料归档 | 办公室 | 张三 | 2026-06-10 | 进行中 | 档案室A柜 | 示例 |',
      ].join('\n'),
    }];
    const d = await assemble(plan, results, 1, outDir);
    assert.ok(d.dir, 'should create project directory');
    const xlsx = d.files?.find((f) => f.name === '资料归档清单.xlsx');
    assert.ok(xlsx, JSON.stringify(d.files));
    assert.ok(!d.artifactPath, 'generic office spreadsheet must not be returned as html artifact');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(xlsx.path);
    const main = wb.getWorksheet('办公台账');
    assert.ok(main, 'generic office workbook should use a business ledger sheet');
    assert.ok(wb.getWorksheet('字段说明'), 'generic office workbook should include field dictionary');
    assert.ok(wb.getWorksheet('统计看板'), 'generic office workbook should include dashboard');
    const qualityFile = d.files?.find((f) => f.name === 'office_quality_manifest.json');
    assert.ok(qualityFile, JSON.stringify(d.files));
    const quality = JSON.parse(readFileSync(qualityFile.path, 'utf8'));
    assert.equal(quality.status, 'pass');
    assert.ok(quality.rules.some((r: string) => r.includes('Excel 必须适合真实维护')));
    assert.ok(quality.files.some((f: any) => f.name === '资料归档清单.xlsx'));
    assert.ok(main.views?.some((v) => v.state === 'frozen'), 'main sheet should freeze headers');
    assert.equal(main.pageSetup.orientation, 'landscape');
    assert.equal(main.getCell('J5').dataValidation?.type, 'list');
    assert.equal(main.getCell('K5').dataValidation?.type, 'list');
    assert.match(String((main.getCell('N5').value as { formula?: string }).formula || ''), /TODAY/);
    assert.equal(main.getColumn('M').numFmt, '0%');
    const summary = wb.getWorksheet('统计看板')!;
    assert.match(String(summary.getCell('B6').value || ''), /COUNTIF/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('dynamic office spreadsheet keeps prompt-specific fields instead of fixed template', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-office-dynamic-xlsx-'));
  try {
    const plan: Plan = {
      goal: '做一个采购比价表 给中铁项目部用\n\n# AIOS 办公交付物质量契约\n{"schema":"aios.office_deliverable_profile.v1","formats":["xlsx"]}',
      understanding: '生成采购比价 Excel 表',
      kind: 'document',
      subtasks: [{
        id: 's1',
        title: '采购比价字段设计',
        objective: '生成可编辑采购比价表',
        skill: 'data',
        complexity: 'standard',
        dependsOn: [],
        outFile: '采购比价台账.xlsx',
      }],
    };
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '采购比价字段设计',
      skill: 'data',
      model: 'mock',
      ok: true,
      ms: 1,
      output: [
        '| 物资名称 | 规格型号 | 单位 | 数量 | 供应商A报价 | 供应商B报价 | 交货周期 | 推荐供应商 | 推荐理由 | 经办人 | 状态 | 备注 |',
        '|---|---|---|---:|---:|---:|---|---|---|---|---|---|',
        '| 钢筋 | HRB400E Φ16 | 吨 | 30 | 3850 | 3820 | 3天 | 供应商B | 总价低且交期满足 | 张三 | 待审批 | 示例 |',
        '| 水泥 | P.O42.5 散装 | 吨 | 80 | 410 | 406 | 2天 | 供应商B | 单价低 | 李四 | 已比价 | 示例 |',
      ].join('\n'),
    }];
    const d = await assemble(plan, results, 1, outDir);
    const xlsx = d.files?.find((f) => f.name === '采购比价台账.xlsx');
    assert.ok(xlsx, JSON.stringify(d.files));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(xlsx.path);
    const main = wb.getWorksheet('业务明细');
    assert.ok(main, 'dynamic workbook should use a prompt-specific business detail sheet');
    const headers = (main.getRow(4).values as any[]).slice(1);
    assert.deepEqual(headers.slice(0, 12), ['物资名称', '规格型号', '单位', '数量', '供应商A报价', '供应商B报价', '交货周期', '推荐供应商', '推荐理由', '经办人', '状态', '备注']);
    assert.equal(main.getCell('A5').value, '钢筋');
    assert.equal(main.getCell('E5').value, '3850');
    assert.equal(main.getCell('K5').dataValidation?.type, 'list');
    assert.ok(wb.getWorksheet('字段说明'), 'dynamic workbook should include field dictionary');
    assert.ok(wb.getWorksheet('统计看板'), 'dynamic workbook should include dashboard');
    const qualityFile = d.files?.find((f) => f.name === 'office_quality_manifest.json');
    assert.ok(qualityFile, JSON.stringify(d.files));
    const quality = JSON.parse(readFileSync(qualityFile.path, 'utf8'));
    assert.equal(quality.status, 'pass');
    const q = quality.files.find((f: any) => f.name === '采购比价台账.xlsx');
    assert.ok(q.checks.some((c: any) => c.id === 'xlsx_minimum_fields' && c.ok && /主表字段数:12/.test(c.detail)));
    assert.ok(q.checks.some((c: any) => c.id === 'xlsx_table_filter' && c.ok));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('office presentation prompts deliver structured editable pptx decks', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-office-pptx-'));
  try {
    const plan: Plan = {
      goal: '做一个中铁办公室月度工作汇报PPT 要正式一点\n\n# AIOS 办公交付物质量契约\n{"schema":"aios.office_deliverable_profile.v1","formats":["pptx"]}',
      understanding: '生成可编辑办公室 PPT 汇报',
      kind: 'document',
      subtasks: [{
        id: 's1',
        title: '月度工作汇报结构',
        objective: '生成正式办公室汇报 PPT',
        skill: 'writing',
        complexity: 'standard',
        dependsOn: [],
        outFile: '月度工作汇报.pptx',
      }],
    };
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '月度工作汇报结构',
      skill: 'writing',
      model: 'mock',
      ok: true,
      ms: 1,
      output: [
        '# 月度工作汇报',
        '- 本月重点工作完成情况',
        '- 合同归档与会议督办持续推进',
        '',
        '## 一、重点工作',
        '- 完成办公室资料归集',
        '- 推进台账标准化',
        '',
        '## 二、问题与风险',
        '- 个别材料反馈不及时',
        '- 需加强跨部门协同',
        '',
        '## 三、下月计划',
        '- 完成重点事项闭环',
        '- 优化日常督办机制',
      ].join('\n'),
    }];
    const d = await assemble(plan, results, 1, outDir);
    assert.ok(d.dir, 'should create project directory');
    const pptx = d.files?.find((f) => f.name === '月度工作汇报.pptx');
    assert.ok(pptx, JSON.stringify(d.files));
    assert.ok(!d.artifactPath, 'office presentation must not be returned as html artifact');
    const zipText = readFileSync(pptx.path, 'latin1');
    const slideFiles = [...zipText.matchAll(/ppt\/slides\/slide\d+\.xml/g)].map((m) => m[0]);
    assert.ok(new Set(slideFiles).size >= 5, `deck should include cover, agenda, and content slides: ${slideFiles.join(',')}`);
    assert.match(zipText, /ppt\/theme\/theme1\.xml/, 'deck should include a theme');
    const qualityFile = d.files?.find((f) => f.name === 'office_quality_manifest.json');
    assert.ok(qualityFile, JSON.stringify(d.files));
    const quality = JSON.parse(readFileSync(qualityFile.path, 'utf8'));
    const pptxQuality = quality.files.find((f: any) => f.name === '月度工作汇报.pptx');
    assert.ok(pptxQuality, JSON.stringify(quality.files));
    assert.ok(pptxQuality.checks.some((c: any) => c.id === 'pptx_has_real_text' && c.ok));
    assert.ok(pptxQuality.checks.some((c: any) => c.id === 'pptx_has_flow' && c.ok));
    assert.ok(pptxQuality.checks.some((c: any) => c.id === 'pptx_not_single_dump' && c.ok));
    assert.ok(pptxQuality.checks.some((c: any) => c.id === 'pptx_prompt_relevance' && c.ok));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('office presentation keeps long section content by adding continuation slides', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-office-pptx-long-'));
  try {
    const longBullets = Array.from({ length: 20 }, (_, i) => `- 第 ${i + 1} 项重点工作说明`).join('\n');
    const plan: Plan = {
      goal: '做一个办公室专项工作汇报PPT',
      understanding: '生成长内容 PPT 汇报',
      kind: 'document',
      subtasks: [{
        id: 's1',
        title: '专项工作汇报',
        objective: '生成不截断正文的 PPT',
        skill: 'writing',
        complexity: 'standard',
        dependsOn: [],
        outFile: '专项工作汇报.pptx',
      }],
    };
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '专项工作汇报',
      skill: 'writing',
      model: 'mock',
      ok: true,
      ms: 1,
      output: `# 专项工作汇报\n${longBullets}`,
    }];
    const d = await assemble(plan, results, 1, outDir);
    const pptx = d.files?.find((f) => f.name === '专项工作汇报.pptx');
    assert.ok(pptx, JSON.stringify(d.files));
    const zipText = readFileSync(pptx.path, 'latin1');
    const slides = new Set([...zipText.matchAll(/ppt\/slides\/slide\d+\.xml/g)].map((m) => m[0]));
    assert.ok(slides.size >= 4, `long section should create continuation slides instead of truncating content: ${[...slides].join(',')}`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('office presentation auto-structures flat business notes into usable slides', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-office-pptx-flat-'));
  try {
    const plan: Plan = {
      goal: '做一个中铁办公室月度工作汇报PPT 要正式一点\n\n# AIOS 办公交付物质量契约\n{"schema":"aios.office_deliverable_profile.v1","formats":["pptx"]}',
      understanding: '生成可编辑办公室 PPT 汇报',
      kind: 'document',
      subtasks: [{
        id: 's1',
        title: '月度工作汇报',
        objective: '生成正式办公室汇报 PPT',
        skill: 'writing',
        complexity: 'standard',
        dependsOn: [],
        outFile: '月度工作汇报.pptx',
      }],
    };
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '月度工作汇报',
      skill: 'writing',
      model: 'mock',
      ok: true,
      ms: 1,
      output: [
        '中铁办公室月度工作汇报',
        '本月重点完成合同归档、资料台账整理和会议事项督办。',
        '当前问题是部分部门反馈滞后,存在资料补交不及时风险。',
        '下一步计划推进台账标准化,落实责任人和截止日期。',
        '数据依据来自办公室月度统计和会议纪要台账。',
      ].join('\n'),
    }];
    const d = await assemble(plan, results, 1, outDir);
    const pptx = d.files?.find((f) => f.name === '月度工作汇报.pptx');
    assert.ok(pptx, JSON.stringify(d.files));
    const zipText = readFileSync(pptx.path, 'latin1');
    const slides = new Set([...zipText.matchAll(/ppt\/slides\/slide\d+\.xml/g)].map((m) => m[0]));
    assert.ok(slides.size >= 5, `flat notes should become cover/agenda/content slides: ${[...slides].join(',')}`);
    const qualityFile = d.files?.find((f) => f.name === 'office_quality_manifest.json');
    assert.ok(qualityFile, JSON.stringify(d.files));
    const quality = JSON.parse(readFileSync(qualityFile.path, 'utf8'));
    assert.equal(quality.status, 'pass');
    const pptxQuality = quality.files.find((f: any) => f.name === '月度工作汇报.pptx');
    assert.ok(pptxQuality.checks.some((c: any) => c.id === 'pptx_has_flow' && c.ok));
    assert.ok(pptxQuality.checks.some((c: any) => c.id === 'pptx_prompt_relevance' && c.ok));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('office report prompts deliver real editable docx files', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-office-docx-'));
  try {
    const plan: Plan = {
      goal: '做一份办公室采购流程优化建议书 Word文档\n\n# AIOS 办公交付物质量契约\n{"schema":"aios.office_deliverable_profile.v1","formats":["docx"]}',
      understanding: '生成正式办公室 Word 建议书',
      kind: 'document',
      subtasks: [{
        id: 's1',
        title: '采购流程优化建议',
        objective: '生成可编辑 Word 文档',
        skill: 'writing',
        complexity: 'standard',
        dependsOn: [],
        outFile: '采购流程优化建议书.docx',
      }],
    };
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '采购流程优化建议',
      skill: 'writing',
      model: 'mock',
      ok: true,
      ms: 1,
      output: [
        '# 办公室采购流程优化建议书',
        '',
        '## 一、现状问题',
        '- 采购申请材料分散',
        '- 审批节点缺少统一台账',
        '',
        '## 二、优化建议',
        '| 序号 | 措施 | 责任部门 | 预期效果 |',
        '|---|---|---|---|',
        '| 1 | 建立采购台账 | 办公室 | 过程可追踪 |',
        '| 2 | 固定归档规则 | 财务/办公室 | 降低漏项风险 |',
      ].join('\n'),
    }];
    const d = await assemble(plan, results, 1, outDir);
    assert.ok(d.dir, 'should create project directory');
    const docx = d.files?.find((f) => f.name === '采购流程优化建议书.docx');
    assert.ok(docx, JSON.stringify(d.files));
    assert.ok(!d.artifactPath, 'office report must not be returned as html artifact');
    const xml = execFileSync('unzip', ['-p', docx.path, 'word/document.xml'], { encoding: 'utf8', timeout: 5000 });
    assert.match(xml.replace(/<[^>]+>/g, ''), /办公室采购流程优化建议书/);
    assert.match(xml, /word\/|w:document|采购流程优化建议书/);
    const qualityFile = d.files?.find((f) => f.name === 'office_quality_manifest.json');
    assert.ok(qualityFile, JSON.stringify(d.files));
    const quality = JSON.parse(readFileSync(qualityFile.path, 'utf8'));
    const docxQuality = quality.files.find((f: any) => f.name === '采购流程优化建议书.docx');
    assert.ok(docxQuality, JSON.stringify(quality.files));
    assert.ok(docxQuality.checks.some((c: any) => c.id === 'docx_heading_hierarchy' && c.ok));
    assert.ok(docxQuality.checks.some((c: any) => c.id === 'docx_table_or_action_list' && c.ok));
    assert.ok(docxQuality.checks.some((c: any) => c.id === 'docx_prompt_relevance' && c.ok));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('office quality reads large DOCX without maxBuffer false negatives', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-large-docx-quality-'));
  try {
    const chunks = Array.from({ length: 180 }, (_, idx) =>
      `## 第${idx + 1}节: 宁波泰餐上市计划\n\n` +
      `本节围绕宁波餐饮市场、泰餐品牌定位、上市路径、供应链、财务测算和门店复制展开。` +
      `需要保留调研来源、风险假设、执行计划和下一步责任事项。\n\n` +
      `- 行动:完善门店 SOP、食品安全、融资资料和上市合规底稿。\n` +
      `- 风险:客流波动、租金压力、供应链稳定性和组织复制能力。\n`,
    );
    const path = await writeDeliverable(`# 餐饮项目商业计划书\n\n${chunks.join('\n')}`, '餐饮项目商业计划书.docx', outDir);
    const { manifest } = await buildOfficeQualityArtifacts(
      '我想在宁波开启一个餐饮项目 目标是做到上市 准备做泰餐 你帮我调研后制定相关详细计划 pdf',
      [{ name: '餐饮项目商业计划书.docx', path }],
      outDir,
      true,
    );
    const docx = manifest.files.find((f: any) => f.name === '餐饮项目商业计划书.docx');
    assert.equal(manifest.status, 'pass', JSON.stringify(manifest));
    assert.ok(docx?.checks.some((c: any) => c.id === 'docx_readable' && c.ok), JSON.stringify(docx));
    assert.ok(docx?.checks.some((c: any) => c.id === 'docx_has_content' && /正文长度:[1-9]\d{4,}/.test(c.detail)), JSON.stringify(docx));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('office quality fails when Word content is generic and not prompt-specific', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-office-docx-relevance-'));
  try {
    const plan: Plan = {
      goal: '做一份办公室采购流程优化建议书 Word文档\n\n# AIOS 办公交付物质量契约\n{"schema":"aios.office_deliverable_profile.v1","formats":["docx"]}',
      understanding: '生成正式办公室 Word 建议书',
      kind: 'document',
      subtasks: [{
        id: 's1',
        title: '采购流程优化建议',
        objective: '生成可编辑 Word 文档',
        skill: 'writing',
        complexity: 'standard',
        dependsOn: [],
        outFile: '采购流程优化建议书.docx',
      }],
    };
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '采购流程优化建议',
      skill: 'writing',
      model: 'mock',
      ok: true,
      ms: 1,
      output: [
        '# 通用材料',
        '',
        '## 一、事项',
        '- 请各部门按时提交材料。',
        '',
        '## 二、下一步',
        '| 序号 | 措施 | 责任部门 |',
        '|---|---|---|',
        '| 1 | 按计划推进 | 综合部 |',
      ].join('\n'),
    }];
    const d = await assemble(plan, results, 1, outDir);
    assert.ok(d.delivery_manifest);
    const manifest = JSON.parse(readFileSync(d.delivery_manifest!, 'utf8'));
    assert.equal(manifest.format_contract.compliance, 'fail');
    assert.equal(manifest.office_quality.status, 'fail');
    assert.equal(manifest.task_satisfaction.schema, 'aios.task_satisfaction.v1');
    assert.equal(manifest.task_satisfaction.first_pass_usable, false);
    assert.equal(manifest.task_satisfaction.verdict, 'needs_repair');
    assert.ok(manifest.task_satisfaction.score < 80, JSON.stringify(manifest.task_satisfaction));
    const readme = readFileSync(join(d.dir!, 'README.md'), 'utf8');
    assert.match(readme, /需返修/);
    assert.match(readme, /First-Pass Usable: 否/);
    const quality = JSON.parse(readFileSync(d.office_quality_manifest!, 'utf8'));
    const docxQuality = quality.files.find((f: any) => f.name === '采购流程优化建议书.docx');
    assert.ok(docxQuality.checks.some((c: any) => c.id === 'docx_prompt_relevance' && !c.ok));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('restaurant business plan relevance uses cleaned user goal, not repair context', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-restaurant-quality-'));
  const source = await startLocalSource([
    '<html><head><title>宁波餐饮行业观察</title></head><body>',
    '<p>2026年宁波餐饮消费继续复苏,特色餐饮和东南亚风味门店受到年轻客群关注。</p>',
    '<p>餐饮连锁企业上市路径通常要求标准化门店、食品安全体系、供应链和财务规范。</p>',
    '</body></html>',
  ].join(''));
  try {
    const goal = [
      '我想在宁波开启一个餐饮项目 目标是做到上市 准备做泰餐 你帮我调研后制定相关计划 pdf',
      '',
      '# AIOS 办公交付物质量契约',
      '{"formats":["docx","pdf"],"target_customer":"中铁办公室/商务办公员工"}',
      '',
      '# 上一版交付物上下文',
      '合同台账模板.xlsx / 合同台账模板.docx',
    ].join('\n');
    const plan: Plan = {
      goal,
      understanding: '生成宁波泰餐项目从首店到上市的商业计划书',
      kind: 'document',
      subtasks: [{
        id: 's1',
        title: '宁波泰餐上市商业计划',
        objective: '制定餐饮项目商业计划书',
        skill: 'writing',
        complexity: 'deep',
        dependsOn: [],
        outFile: '餐饮项目商业计划书.docx',
      }],
    };
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '宁波泰餐上市商业计划',
      skill: 'writing',
      model: 'mock',
      ok: true,
      ms: 1,
      output: [
        '# 宁波泰餐项目商业计划书',
        '',
        '## 一、项目定位与上市目标',
        '本计划围绕宁波首店、泰餐品牌定位、餐饮门店模型、融资路径和 IPO 上市规范化展开。',
        '',
        '## 二、首店选址与商业模式',
        '| 模块 | 核心动作 | 验收标准 |',
        '|---|---|---|',
        '| 选址 | 聚焦宁波核心商圈与写字楼客群 | 首店模型可复制 |',
        '| 菜单 | 泰餐爆品、客单价、毛利结构 | 可支撑连锁化 |',
        '| 供应链 | 泰式食材、中央厨房、食品安全 SOP | 支撑规模化 |',
        '',
        '## 三、融资与上市路径',
        '融资节奏、股权结构、财务测算、门店扩张、食品安全合规和信息披露要提前按上市公司标准建设。',
        '',
        '## 四、风险与下一步',
        '重点管理翻台率、坪效、租金、供应链稳定性、品牌复购和组织能力。',
      ].join('\n'),
      evidenceText: [
        '# AIOS web observe 已执行',
        `URL: ${source.url}`,
        'TITLE: 宁波餐饮行业观察',
        'DATES: 2026-06-01',
        'TEXT_EXCERPT: 2026年宁波餐饮消费继续复苏,特色餐饮和东南亚风味门店受到年轻客群关注。餐饮连锁企业上市路径通常要求标准化门店、食品安全体系、供应链和财务规范。',
      ].join('\n'),
    }];
    const d = await assemble(plan, results, 1, outDir);
    assert.ok(d.delivery_manifest);
    const names = (d.files || []).map((f) => f.name);
    assert.ok(names.includes('餐饮项目商业计划书.docx'), JSON.stringify(names));
    assert.ok(names.includes('餐饮项目商业计划书.pdf'), JSON.stringify(names));
    assert.ok(!names.some((name) => name.includes('合同台账')), JSON.stringify(names));
    const quality = JSON.parse(readFileSync(d.office_quality_manifest!, 'utf8'));
    const docxQuality = quality.files.find((f: any) => f.name === '餐饮项目商业计划书.docx');
    assert.ok(docxQuality.checks.some((c: any) => c.id === 'docx_prompt_relevance' && c.ok), JSON.stringify(docxQuality.checks));
    const manifest = JSON.parse(readFileSync(d.delivery_manifest!, 'utf8'));
    const freshnessSummary = JSON.parse(readFileSync(join(d.dir!, 'freshness_summary.json'), 'utf8'));
    assert.equal(freshnessSummary.verified, false, JSON.stringify(freshnessSummary));
    assert.equal(freshnessSummary.reason, 'research_evidence_delivery', JSON.stringify(freshnessSummary));
    assert.equal(manifest.freshness.verified, false, JSON.stringify(manifest.freshness));
    assert.equal(manifest.task_satisfaction.verdict, 'review_recommended', JSON.stringify(manifest.task_satisfaction));
    assert.ok(manifest.task_satisfaction.score >= 80, JSON.stringify(manifest.task_satisfaction));
    assert.ok(
      manifest.task_satisfaction.dimensions.some((d: any) => d.id === 'source_evidence' && d.score < d.max),
      JSON.stringify(manifest.task_satisfaction),
    );
    assert.match(d.markdown, /证据声明/);
    assert.match(d.markdown, /部分市场判断、竞品枚举或数字口径尚未完成逐条公开来源绑定/);
    assert.match(d.markdown, /具体门店|竞品|市场规模/);
    assert.doesNotMatch(d.markdown, /当前价格报告|具体价格|DATA_GAP/);
    const sourceContent = readFileSync(join(d.dir!, 'source_content.md'), 'utf8');
    assert.match(sourceContent, /宁波|泰餐|餐饮项目商业计划书/);
    assert.match(sourceContent, /融资与上市路径/);
    assert.doesNotMatch(sourceContent, /当前价格报告|具体价格|DATA_GAP/);
    const claimEvidenceText = readFileSync(join(d.dir!, 'claim_evidence.json'), 'utf8');
    assert.ok(claimEvidenceText.includes('required'));
    assert.ok(claimEvidenceText.includes('claim_evidence'));
  } finally {
    await source.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('office report auto-structures flat notes without inventing facts', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-office-docx-flat-'));
  try {
    const plan: Plan = {
      goal: '做一份中铁办公室资料归档优化方案 Word文档\n\n# AIOS 办公交付物质量契约\n{"schema":"aios.office_deliverable_profile.v1","formats":["docx"]}',
      understanding: '生成正式办公室 Word 方案',
      kind: 'document',
      subtasks: [{
        id: 's1',
        title: '资料归档优化方案',
        objective: '生成可编辑 Word 文档',
        skill: 'writing',
        complexity: 'standard',
        dependsOn: [],
        outFile: '资料归档优化方案.docx',
      }],
    };
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '资料归档优化方案',
      skill: 'writing',
      model: 'mock',
      ok: true,
      ms: 1,
      output: [
        '中铁办公室资料归档优化方案',
        '办公室当前需要统一资料归档口径。',
        '资料台账要覆盖合同、会议纪要、审批材料和移交记录。',
        '主要风险是部分资料反馈滞后,影响后续检查。',
        '下一步建议建立归档清单,明确责任人和截止日期。',
      ].join('\n'),
    }];
    const d = await assemble(plan, results, 1, outDir);
    const docx = d.files?.find((f) => f.name === '资料归档优化方案.docx');
    assert.ok(docx, JSON.stringify(d.files));
    const text = execFileSync('unzip', ['-p', docx.path, 'word/document.xml'], { encoding: 'utf8', timeout: 5000 }).replace(/<[^>]+>/g, '');
    assert.match(text, /一、执行摘要/);
    assert.match(text, /二、正文事项/);
    assert.match(text, /三、风险与建议/);
    assert.match(text, /四、下一步/);
    assert.match(text, /资料归档/);
    const quality = JSON.parse(readFileSync(d.office_quality_manifest!, 'utf8'));
    assert.equal(quality.status, 'pass');
    const docxQuality = quality.files.find((f: any) => f.name === '资料归档优化方案.docx');
    assert.ok(docxQuality.checks.some((c: any) => c.id === 'docx_prompt_relevance' && c.ok));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('office docx conversion works through bundled cross-platform converter', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-office-docx-fallback-'));
  const oldForce = process.env.AIOS_FORCE_HTML_TO_DOCX;
  process.env.AIOS_FORCE_HTML_TO_DOCX = '1';
  try {
    const plan: Plan = {
      goal: '做一份办公室通知Word文档\n\n# AIOS 办公交付物质量契约\n{"schema":"aios.office_deliverable_profile.v1","formats":["docx"]}',
      understanding: '生成办公室通知 Word',
      kind: 'document',
      subtasks: [{
        id: 's1',
        title: '办公室通知',
        objective: '生成跨平台 docx',
        skill: 'writing',
        complexity: 'standard',
        dependsOn: [],
        outFile: '办公室通知.docx',
      }],
    };
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '办公室通知',
      skill: 'writing',
      model: 'mock',
      ok: true,
      ms: 1,
      output: '# 办公室通知\n\n## 一、事项\n- 请各部门按时提交材料。',
    }];
    const d = await assemble(plan, results, 1, outDir);
    const docx = d.files?.find((f) => f.name === '办公室通知.docx');
    assert.ok(docx, JSON.stringify(d.files));
    const xml = execFileSync('unzip', ['-p', docx.path, 'word/document.xml'], { encoding: 'utf8', timeout: 5000 });
    assert.match(xml.replace(/<[^>]+>/g, ''), /办公室通知/);
  } finally {
    if (oldForce === undefined) delete process.env.AIOS_FORCE_HTML_TO_DOCX;
    else process.env.AIOS_FORCE_HTML_TO_DOCX = oldForce;
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('office pptx conversion uses bundled dependency without runtime npm install', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'aios-engine-office-pptx-runtime-'));
  const fakeCwd = mkdtempSync(join(tmpdir(), 'aios-engine-no-package-json-'));
  const oldCwd = process.cwd();
  const oldPath = process.env.PATH;
  try {
    process.chdir(fakeCwd);
    process.env.PATH = '';
    const fp = await writeDeliverable([
      '# 宁波泰餐上市计划',
      '',
      '## 第1页: 项目定位',
      '- 从宁波首店开始验证模型。',
      '- 十年目标是区域连锁、标准化供应链和资本化路径。',
      '',
      '## 第2页: 运营路径',
      '- 首店打磨产品、坪效、复购和点评口碑。',
      '- 第二阶段复制门店,第三阶段建设中央厨房。',
    ].join('\n'), '宁波泰餐上市计划.pptx', outDir);
    assert.equal(officeFileSignatureOk(fp, 'pptx'), true);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    process.chdir(oldCwd);
    rmSync(fakeCwd, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('pdf browser candidate detection supports packaged Windows machines', () => {
  const env = {
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\AIOS\\AppData\\Local',
  } as NodeJS.ProcessEnv;
  const candidates = pdfBrowserCandidates(env, 'win32', false).join('\n');
  assert.match(candidates, /Microsoft\\Edge\\Application\\msedge\.exe|Google\\Chrome\\Application\\chrome\.exe/);
});
