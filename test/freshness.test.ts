import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemble } from '../src/result';
import { __freshnessTest, buildFreshnessArtifacts, needsFreshnessEvidence, needsResearchEvidence } from '../src/freshness';
import type { AgentResult, Plan } from '../src/types';

function tmpDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

test('freshness artifacts reject model-memory prices without verified source evidence', async () => {
  const dir = tmpDir('aios-freshness');
  try {
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '水泥行情',
      skill: 'research',
      model: 'mock',
      ok: true,
      ms: 1,
      output: '2026年6月 P.O42.5 水泥价格约 380 元/吨。这个数字没有 URL 支撑。',
      evidenceText: 'SEARCH_QUERIES: 2026年6月 P.O42.5 水泥 价格 全国 均价 最新',
    }];
    const freshness = await buildFreshnessArtifacts('做一份水泥价格当前行情核验报告', results, dir);
    assert.equal(freshness.freshness_verified, false);
    assert.deepEqual((freshness.freshness_summary as { verified: boolean }).verified, false);
    assert.equal(readFileSync(join(dir, 'data.csv'), 'utf8').trim(), 'context,date_text,value,unit');
    const manifest = JSON.parse(readFileSync(join(dir, 'evidence_manifest.json'), 'utf8'));
    assert.equal(manifest.data_rows.length, 0);
    assert.equal(manifest.rejected_data_rows.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('freshness verifier ignores model-claimed URLs and prices outside observed evidence', async () => {
  const dir = tmpDir('aios-model-claims');
  try {
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '模型伪证据',
      skill: 'research',
      model: 'mock',
      ok: true,
      ms: 1,
      output: '当前泰国柴油价格 31.94 baht/litre。来源: https://example.com/fake-energy-price',
      evidenceText: 'AIOS web observe 已执行\nOBSERVE_RESULT: 没有搜索到与任务主题相关的可抓取网页。',
    }];
    const freshness = await buildFreshnessArtifacts('帮我做一下泰国柴油最近的行情调研', results, dir);
    assert.equal(freshness.freshness_verified, false);
    const sources = readFileSync(join(dir, 'sources.jsonl'), 'utf8');
    assert.doesNotMatch(sources, /example\.com\/fake-energy-price/);
    assert.equal(readFileSync(join(dir, 'data.csv'), 'utf8').trim(), 'context,date_text,value,unit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assemble replaces stale price report with repair report when freshness fails', async () => {
  const outDir = tmpDir('aios-assemble');
  try {
    const plan: Plan = {
      goal: '做一份水泥价格当前行情核验报告',
      understanding: '核验当前水泥价格',
      kind: 'document',
      subtasks: [{
        id: 's1',
        title: '水泥价格报告',
        objective: '生成报告',
        skill: 'research',
        complexity: 'deep',
        dependsOn: [],
        outFile: '水泥价格调研报告.docx',
      }],
    };
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '水泥价格报告',
      skill: 'research',
      model: 'mock',
      ok: true,
      ms: 1,
      output: '当前 P.O42.5 散装水泥约 380 元/吨。',
      evidenceText: '',
    }];
    const deliverable = await assemble(plan, results, 1, outDir);
    assert.equal(deliverable.freshness_verified, false);
    assert.match(deliverable.markdown, /交付标记为“需修复”/);
    assert.doesNotMatch(deliverable.markdown, /380\s*元\/吨/);
    const readme = readFileSync(join(deliverable.dir!, 'README.md'), 'utf8');
    assert.match(readme, /不会输出任何未经验证的具体价格/);
    assert.doesNotMatch(readme, /380\s*元\/吨/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('assemble degrades research business plans instead of replacing full content with repair stub', async () => {
  const outDir = tmpDir('aios-assemble-research-degrade');
  try {
    const plan: Plan = {
      goal: '我想在宁波开启一个餐饮项目 目标是做到上市 准备做泰餐 你帮我调研后制定相关计划 pdf',
      understanding: '制定宁波泰餐从首店到上市的商业计划',
      kind: 'document',
      subtasks: [{
        id: 's1',
        title: '宁波泰餐上市计划',
        objective: '生成商业计划 PDF',
        skill: 'research',
        complexity: 'deep',
        dependsOn: [],
        outFile: '宁波泰餐上市计划.pdf',
      }],
    };
    const results: AgentResult[] = [{
      subtaskId: 's1',
      title: '宁波泰餐上市计划',
      skill: 'research',
      model: 'mock',
      ok: true,
      ms: 1,
      output: [
        '# 宁波泰餐上市计划',
        '',
        '## 定位与产品',
        '从宁波首店开始验证泰餐品牌定位、菜单结构、客单价、复购和标准化 SOP。',
        '',
        '## 扩张与上市路径',
        '十年路径分为首店模型验证、区域复制、供应链建设、融资规范化和资本市场准备。',
      ].join('\n'),
      evidenceText: 'AIOS web observe 已执行\nOBSERVE_RESULT: 没有搜索到与任务主题相关的可抓取网页。',
    }];
    const deliverable = await assemble(plan, results, 1, outDir);
    assert.equal(deliverable.freshness_verified, false);
    const manifest = JSON.parse(readFileSync(join(deliverable.dir!, 'delivery_manifest.json'), 'utf8'));
    const freshnessSummary = JSON.parse(readFileSync(join(deliverable.dir!, 'freshness_summary.json'), 'utf8'));
    assert.equal(freshnessSummary.reason, 'research_evidence_delivery');
    assert.equal(manifest.freshness.verified, false, JSON.stringify(manifest.freshness));
    assert.equal(manifest.task_satisfaction.verdict, 'review_recommended', JSON.stringify(manifest.task_satisfaction));
    assert.ok(manifest.task_satisfaction.score >= 80, JSON.stringify(manifest.task_satisfaction));
    assert.match(deliverable.markdown, /证据声明/);
    assert.match(deliverable.markdown, /部分市场判断、竞品枚举或数字口径尚未完成逐条公开来源绑定/);
    const sourceContent = readFileSync(join(deliverable.dir!, 'source_content.md'), 'utf8');
    assert.match(sourceContent, /宁波泰餐上市计划/);
    assert.match(sourceContent, /扩张与上市路径/);
    assert.doesNotMatch(sourceContent, /交付标记为“需修复”/);
    assert.ok(readFileSync(join(deliverable.dir!, 'claim_evidence.json'), 'utf8').includes('required'));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('freshness detector and extractor handle current Thailand diesel evidence', () => {
  const prompt = '帮我做一下泰国柴油最近的行情调研';
  assert.equal(needsFreshnessEvidence(prompt), true);
  const queries = __freshnessTest.freshnessSearchQueries(prompt, new Date('2026-06-04T00:00:00+07:00'));
  assert.ok(queries.some((q) => /Thailand diesel price/i.test(q)), queries.join('\n'));
  assert.ok(queries.some((q) => /EPPO Thailand diesel/i.test(q)), queries.join('\n'));

  const rows = __freshnessTest.extractDataRows([
    'As of 2026-06-03, Thailand retail diesel price was 31.94 baht/litre according to public energy data.',
    'The current price of diesel fuel in Thailand is THB 39.82 per liter based on the latest update from 01-Jun-2026.',
    '2026-06-03 泰国柴油零售价格为 31.94 baht/litre。',
    'SEARCH_QUERIES: Thailand diesel price 2026 6 official',
  ].join('\n'));
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.date_text, '2026-06-03');
  assert.equal(rows[0]?.value, '31.94');
  assert.equal(rows[0]?.unit, 'baht/litre');
  assert.equal(rows[1]?.date_text, '2026-06-01');
  assert.equal(rows[1]?.value, '39.82');
  assert.equal(rows[1]?.unit, 'baht/litre');
  assert.ok(rows.every((row) => !/SEARCH_QUERIES/.test(row.context)));
});

test('freshness extractor handles Thai gold price evidence and Buddhist dates', () => {
  const prompt = '今天泰国黄金价格 简短给来源';
  assert.equal(needsFreshnessEvidence(prompt), true);
  const queries = __freshnessTest.freshnessSearchQueries(prompt, new Date('2026-06-06T00:00:00+07:00'));
  assert.ok(queries.some((q) => /goldtraders\.or\.th|ราคาทองวันนี้/i.test(q)), queries.join('\n'));

  const dates = __freshnessTest.extractDates('ประจำวันที่ 06/06/2569 ราคาทองวันนี้');
  assert.deepEqual(dates, ['2026-06-06']);

  const rows = __freshnessTest.extractDataRows([
    'ราคาทองวันนี้ 06/06/2569 ทองคำแท่ง ขายออก 69,150 บาท รับซื้อ 69,050 บาท',
    'Thailand Gold Price Today: gold bar sell 69,150 บาท per baht weight.',
  ].join('\n'));
  assert.ok(rows.some((row) => row.date_text === '2026-06-06' && row.value === '69,150' && row.unit === 'baht/baht-weight'), JSON.stringify(rows));
});

test('research evidence detector requires sources for strategic business plans without treating them as live prices', async () => {
  const prompt = '我想在宁波开启一个餐饮项目 目标是做到上市 准备做泰餐 你帮我调研后制定相关计划 pdf';
  assert.equal(needsFreshnessEvidence(prompt), false);
  assert.equal(needsResearchEvidence(prompt), true);

  const dir = tmpDir('aios-research-evidence');
  try {
    const freshness = await buildFreshnessArtifacts(prompt, [{
      subtaskId: 's1',
      title: '商业计划',
      skill: 'research',
      model: 'mock',
      ok: true,
      ms: 1,
      output: '宁波泰餐市场规模 5 亿元,但没有来源。',
      evidenceText: 'AIOS web observe 已执行\nOBSERVE_RESULT: 没有搜索到与任务主题相关的可抓取网页。',
    }], dir);
    assert.equal(freshness.freshness_verified, false);
    assert.equal((freshness.freshness_summary as any).reason, 'research_evidence_delivery');
    assert.match(JSON.stringify((freshness.freshness_summary as any).gaps), /调研型交付缺少可校验来源/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local restaurant business plan rejects unsupported named competitors and fake platform evidence', async () => {
  const prompt = '我想在宁波开启一个餐饮项目 目标是做到上市 准备做泰餐 你帮我调研后制定相关计划 pdf';
  assert.equal(__freshnessTest.needsLocalBusinessClaimAudit(prompt), true);
  const dir = tmpDir('aios-claim-evidence');
  try {
    const freshness = await buildFreshnessArtifacts(prompt, [{
      subtaskId: 's1',
      title: '宁波泰餐商业计划',
      skill: 'research',
      model: 'mock',
      ok: true,
      ms: 1,
      output: [
        '数据来源：大众点评宁波站（2026年5月数据爬取）、美团外卖宁波站、实地走访（假设）。',
        '竞品A：泰谣（高端泰餐）。竞品C：泰妃殿（中端连锁），宁波约6家。',
        '宁波泰餐门店数量约85-110家，市场年增速约12-15%。',
      ].join('\n'),
      evidenceText: [
        'AIOS web observe 已执行',
        'OBSERVED_SOURCE_1 URL: https://example.com/ningbo-food-report TITLE: Ningbo food service report TEXT_EXCERPT: Ningbo restaurant market overview.',
        'OBSERVED_SOURCE_2 URL: https://example.org/china-catering TITLE: China catering trend TEXT_EXCERPT: China restaurant chain trend.',
      ].join('\n'),
    }], dir);
    assert.equal(freshness.freshness_verified, false);
    const summary = freshness.freshness_summary as any;
    assert.equal(summary.reason, 'research_evidence_delivery');
    assert.match(JSON.stringify(summary.gaps), /未绑定来源的关键主张|至少需要 3 条可校验来源/);
    const claimLedger = JSON.parse(readFileSync(join(dir, 'claim_evidence.json'), 'utf8'));
    assert.equal(claimLedger.required, true);
    assert.equal(claimLedger.verified, false);
    assert.ok(claimLedger.claims.some((claim: any) => claim.claim.includes('大众点评') && claim.status === 'unverified'));
    assert.ok(claimLedger.claims.some((claim: any) => claim.claim.includes('泰谣') && claim.status === 'unverified'));
    assert.ok(claimLedger.claims.some((claim: any) => claim.claim.includes('泰妃殿') && claim.status === 'unverified'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
