import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemble } from '../src/result';
import { needsFreshnessEvidence } from '../src/freshness';
import type { AgentResult, Plan } from '../src/types';

function tmpDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

function finderWindowCount(): number | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    return Number(execFileSync('osascript', [
      '-e',
      'tell application "Finder" to return count of windows',
    ], { encoding: 'utf8', timeout: 5000 }).trim());
  } catch {
    return undefined;
  }
}

const freshnessPrompts = [
  '帮我做水泥价格当前行情核验报告',
  '查一下今天 P.O42.5 水泥全国均价并出 Word',
  '做一份钢材价格最新行情简报',
  '做一份沥青价格当前行情核验',
  '做一份砂石价格本周行情调研',
  '帮我做一下泰国柴油最近的行情调研',
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
  '去小红书看一下这礼拜讨论度最高的10个话题',
  '去B站看一下这个月讨论最高的十个关键词',
  '查微博今天热搜榜并做个简报',
  '看一下抖音最近一周热门话题',
  '整理本周知乎热榜前十',
  '查 GitHub 最近热门 agent 项目并做调研',
  '找最近一个月适合商务办公的 GitHub 技能方向',
  '看今年中铁办公室办公自动化热门需求',
  '查今天上海天气并写出门建议',
  '查现在美元兑人民币汇率',
  '看一下今天黄金价格走势',
  '做一份最新 CPI 数据简报',
  '查本月地产销售数据趋势',
  '整理近期水泥行业库存变化',
  '查当前航班延误情况并汇总',
  '看一下今天 A 股水泥板块走势',
  '做一份最近一周小红书中铁办公室相关内容调研',
  '检查这周 B 站 AI agent 讨论度最高话题',
  '查当前百年建筑网水泥行情公开可见信息',
  '查今天中国水泥网价格指数公开信息',
  '做一份近期办公软件采购价调研',
  '查最新 Microsoft 365 商务版价格',
  '看一下当前 WPS 会员价格',
  '整理最近一周 DeepSeek 相关 GitHub 趋势',
  '查这礼拜 Qwen coder 相关讨论热度',
  '做一份今天建材市场早报',
  '查最近钢铁网报价并做核验',
  // 产品裁决(2026-06-11):内部风险清单不进价格闸;要价格证据就点名价格
  '整理当前施工材料采购价格风险清单',
  '查本季度水泥价格走势公开来源',
  '做一份当下水泥价格和钢材价格对比',
];

test('50-round Codex-standard simulation rejects unsupported fresh-data answers', async () => {
  const outDir = tmpDir('aios-codex-50');
  const before = finderWindowCount();
  try {
    assert.equal(freshnessPrompts.length, 50);
    for (const [idx, prompt] of freshnessPrompts.entries()) {
      assert.equal(needsFreshnessEvidence(prompt), true, `intent should require freshness: ${prompt}`);
      const fakeValue = 300 + idx;
      const plan: Plan = {
        goal: prompt,
        understanding: `Codex 标准模拟: ${prompt}`,
        kind: 'document',
        subtasks: [{
          id: 's1',
          title: '证据型交付',
          objective: '按用户要求生成交付物',
          skill: 'research',
          complexity: 'deep',
          dependsOn: [],
          outFile: `codex-standard-${idx + 1}.md`,
        }],
      };
      const results: AgentResult[] = [{
        subtaskId: 's1',
        title: '证据型交付',
        skill: 'research',
        model: 'mock-codex-standard',
        ok: true,
        ms: 1,
        output: `当前结论: ${fakeValue} 元/吨,热度 ${fakeValue},排名第1。无 URL,无 as-of,无来源。`,
        evidenceText: '',
      }];
      const d = await assemble(plan, results, 1, outDir);
      assert.equal(d.freshness_verified, false, `round ${idx + 1}: ${prompt}`);
      assert.match(d.markdown, /需修复|不会输出任何未经验证的具体价格/, `round ${idx + 1}`);
      assert.doesNotMatch(d.markdown, /\d{2,4}\s*元\/吨/, `round ${idx + 1}`);
      assert.doesNotMatch(d.markdown, /排名第1|热度\s*\d+/, `round ${idx + 1}`);
      const readme = readFileSync(join(d.dir!, 'README.md'), 'utf8');
      const dataCsv = readFileSync(join(d.dir!, 'data.csv'), 'utf8').trim();
      assert.doesNotMatch(readme, /\d{2,4}\s*元\/吨|排名第1|热度\s*\d+/, `round ${idx + 1}`);
      assert.equal(dataCsv, 'context,date_text,value,unit', `round ${idx + 1}`);
    }
    const after = finderWindowCount();
    if (before !== undefined && after !== undefined) {
      assert.equal(after, before, 'Codex-standard simulation must not open Finder windows');
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
