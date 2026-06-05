import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { assemble } from '../src/result';
import { pdfBrowserCandidates } from '../src/build';
import type { AgentResult, Plan } from '../src/types';

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
    const d = await assemble(plan, results, 1, outDir);
    assert.ok(d.dir, 'should create project directory');
    assert.ok(d.files?.some((f) => f.name.endsWith('.xlsx')), JSON.stringify(d.files));
    assert.ok(!d.artifactPath, 'office Excel must not be returned as html artifact');
    const readme = readFileSync(join(d.dir!, 'README.md'), 'utf8');
    assert.match(readme, /优先打开: 合同台账模板\.xlsx/);
    assert.match(readme, /office_quality_manifest\.json/);
    assert.match(readme, /source_content\.md/);
    assert.match(readme, /delivery_manifest\.json/);
    assert.ok(d.office_quality_manifest, 'office delivery should write a quality manifest');
    const quality = JSON.parse(readFileSync(d.office_quality_manifest!, 'utf8'));
    assert.equal(quality.schema, 'aios.office_quality_manifest.v1');
    assert.equal(quality.status, 'pass');
    assert.ok(quality.rules.some((r: string) => /OB|正式交付|Office|Excel|PDF/.test(r)));
    assert.ok(d.delivery_manifest, 'office delivery should write a delivery manifest');
    const manifest = JSON.parse(readFileSync(d.delivery_manifest!, 'utf8'));
    assert.equal(manifest.schema, 'aios.delivery_manifest.v1');
    assert.equal(manifest.primary, '合同台账模板.xlsx');
    assert.equal(manifest.source_content, 'source_content.md');
    assert.equal(manifest.smoke.status, 'pass');
    assert.equal(manifest.office_quality.status, 'pass');
    const primaryEntry = manifest.files.find((f: any) => f.name === '合同台账模板.xlsx');
    assert.ok(primaryEntry, JSON.stringify(manifest.files));
    assert.equal(primaryEntry.role, 'primary');
    assert.ok(primaryEntry.bytes > 1000, JSON.stringify(primaryEntry));
    assert.match(primaryEntry.sha256, /^[a-f0-9]{64}$/);
    const sourceEntry = manifest.files.find((f: any) => f.name === 'source_content.md');
    assert.ok(sourceEntry, JSON.stringify(manifest.files));
    assert.equal(sourceEntry.role, 'source');
    assert.ok(sourceEntry.bytes > 0, JSON.stringify(sourceEntry));
    assert.match(sourceEntry.sha256, /^[a-f0-9]{64}$/);
    const selfEntry = manifest.files.find((f: any) => f.name === 'delivery_manifest.json');
    assert.ok(selfEntry, JSON.stringify(manifest.files));
    assert.equal(selfEntry.role, 'manifest');
    assert.equal(selfEntry.self_hash_excluded, true);
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

test('pdf browser candidate detection supports packaged Windows machines', () => {
  const env = {
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\AIOS\\AppData\\Local',
  } as NodeJS.ProcessEnv;
  const candidates = pdfBrowserCandidates(env, 'win32', false).join('\n');
  assert.match(candidates, /Microsoft\\Edge\\Application\\msedge\.exe|Google\\Chrome\\Application\\chrome\.exe/);
});
