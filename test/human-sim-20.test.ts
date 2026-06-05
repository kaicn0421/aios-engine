import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemble } from '../src/result';
import type { AgentResult, Plan } from '../src/types';

function tmpDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

function finderWindowCount(): number | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const out = execFileSync('osascript', [
      '-e',
      'tell application "Finder" to return count of windows',
    ], { encoding: 'utf8', timeout: 5000 }).trim();
    return Number(out);
  } catch {
    return undefined;
  }
}

function plainDocxText(path: string): string {
  if (!existsSync(path)) return '';
  try {
    const xml = execFileSync('unzip', ['-p', path, 'word/document.xml'], { encoding: 'utf8', timeout: 5000 });
    return xml.replace(/<[^>]+>/g, '');
  } catch {
    return '';
  }
}

const prompts = [
  '帮我做水泥价格当前行情核验报告',
  '查一下今天 P.O42.5 水泥全国均价并出 Word',
  '做一份钢材价格最新行情简报',
  '做一份沥青价格当前行情核验',
  '做一份砂石价格本周行情调研',
  '做一份柴油价格最新走势简报',
  '做一份人民币汇率当前走势分析',
  '做一份铜价今日行情核验',
  '做一份煤炭价格本月行情报告',
  '做一份螺纹钢最新报价核验',
  '做一份水泥价格数据滞后修复版',
  '重新查当前水泥价格,不要用旧数据',
  '做一份全国建材价格最新调研',
  '做一份混凝土价格当前行情报告',
  '做一份建筑材料价格今日简报',
  '做一份办公室采购价格最新核验表',
  '做一份中铁项目水泥报价当前调研',
  '做一份华东水泥价格本周走势',
  '做一份西南水泥行情最新报告',
  '做一份水泥价格公开来源核验清单',
];

test('20-round human simulation blocks stale market deliverables without desktop side effects', async () => {
  const outDir = tmpDir('aios-human-sim');
  const before = finderWindowCount();
  try {
    for (const [idx, prompt] of prompts.entries()) {
      const fakePrice = 300 + idx;
      const plan: Plan = {
        goal: prompt,
        understanding: `模拟真人办公请求: ${prompt}`,
        kind: 'document',
        subtasks: [{
          id: 's1',
          title: '当前行情报告',
          objective: '生成当前行情交付物',
          skill: 'research',
          complexity: 'deep',
          dependsOn: [],
          outFile: `第${idx + 1}轮行情核验报告.docx`,
        }],
      };
      const results: AgentResult[] = [{
        subtaskId: 's1',
        title: '当前行情报告',
        skill: 'research',
        model: 'mock-human',
        ok: true,
        ms: 1,
        output: `当前价格约 ${fakePrice} 元/吨,但这是没有 URL/as-of 的模型记忆。`,
      }];
      const d = await assemble(plan, results, 1, outDir);
      assert.equal(d.freshness_verified, false, `round ${idx + 1}`);
      assert.match(d.markdown, /需修复|不会输出任何未经验证的具体价格/, `round ${idx + 1}`);
      assert.doesNotMatch(d.markdown, /\d{2,4}\s*元\/吨/, `round ${idx + 1}`);
      assert.ok(d.dir, `round ${idx + 1} should create project dir`);
      const readme = readFileSync(join(d.dir!, 'README.md'), 'utf8');
      const dataCsv = readFileSync(join(d.dir!, 'data.csv'), 'utf8').trim();
      assert.doesNotMatch(readme, /\d{2,4}\s*元\/吨/, `round ${idx + 1}`);
      assert.equal(dataCsv, 'context,date_text,value,unit', `round ${idx + 1}`);
      const docx = d.files?.find((f) => f.name.endsWith('.docx'))?.path;
      assert.ok(docx, `round ${idx + 1} should write docx`);
      assert.doesNotMatch(plainDocxText(docx!), /\d{2,4}\s*元\/吨/, `round ${idx + 1}`);
    }
    const after = finderWindowCount();
    if (before !== undefined && after !== undefined) {
      assert.equal(after, before, 'simulation must not open extra Finder windows');
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
