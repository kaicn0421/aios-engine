import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemble } from '../src/result';
import { __freshnessTest, buildFreshnessArtifacts, needsFreshnessEvidence } from '../src/freshness';
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
