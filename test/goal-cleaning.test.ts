import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanUserGoal } from '../src/goal';
import { needsFreshnessEvidence } from '../src/freshness';
import { defaultOutFileForFormat, officeFormatsFromGoal } from '../src/office-format';
import { localFallbackPlan } from '../src/brain';
import { __orchestratorTest } from '../src/orchestrator';
import type { SubTask } from '../src/types';

const pollutedRestaurantGoal = [
  '我想在宁波开启一个餐饮项目 目标是做到上市 准备做泰餐 你帮我调研后制定相关计划 pdf',
  '',
  '# AIOS 自动返修上下文',
  '上一版交付失败: 合同台账模板.xlsx',
  '{"formats":["xlsx"],"primary":"合同台账模板.xlsx"}',
  '',
  '# 数据时效/证据契约',
  '{"current_time":"2026-06-06T22:00:00+07:00"}',
  '执行要求: 必须实时价格核验。',
].join('\n');

test('engine strips injected repair and contract context before intent detection', () => {
  const clean = cleanUserGoal(pollutedRestaurantGoal);
  assert.equal(clean, '我想在宁波开启一个餐饮项目 目标是做到上市 准备做泰餐 你帮我调研后制定相关计划 pdf');
  assert.deepEqual(officeFormatsFromGoal(pollutedRestaurantGoal), ['docx', 'pdf']);
  assert.equal(defaultOutFileForFormat(pollutedRestaurantGoal, 'docx'), '餐饮项目商业计划书.docx');
  assert.equal(defaultOutFileForFormat(pollutedRestaurantGoal, 'pdf'), '餐饮项目商业计划书.pdf');
  assert.equal(defaultOutFileForFormat(pollutedRestaurantGoal, 'xlsx'), '餐饮项目商业计划书.xlsx');
});

test('repair context does not turn strategic reports into stale data tasks', () => {
  assert.equal(needsFreshnessEvidence(pollutedRestaurantGoal), false);
  assert.equal(needsFreshnessEvidence('今天泰国黄金价格'), true);
  assert.equal(needsFreshnessEvidence('泰国建筑工人的最新薪资是多少'), true);
});

test('common Word and PDF office tasks get business filenames instead of generic AIOS artifact names', () => {
  const weekly = '写一份中铁办公室项目周报 Word 和 PDF，内容包括本周完成、问题风险、下周计划、需要领导协调事项，正式一点';
  assert.equal(defaultOutFileForFormat(weekly, 'docx'), '项目周报.docx');
  assert.equal(defaultOutFileForFormat(weekly, 'pdf'), '项目周报.pdf');
  assert.equal(defaultOutFileForFormat('做一份宁波泰餐上市商业计划书 pdf', 'pdf'), '餐饮项目商业计划书.pdf');
});

test('office contract formats survive context cleaning for restaurant business plans', () => {
  const goal = [
    '帮我做一个从零开始到打造一个上市企业的计划 做泰餐吧 在宁波做一家店开始 目标是 10年干上市',
    '',
    '# AIOS 办公交付物质量契约',
    '{"schema":"aios.office_deliverable_profile.v1","formats":["docx","pdf"]}',
    '',
    '# 上一版交付物上下文',
    '{"formats":["xlsx"],"primary":"合同台账模板.xlsx"}',
  ].join('\n');

  assert.equal(cleanUserGoal(goal), '帮我做一个从零开始到打造一个上市企业的计划 做泰餐吧 在宁波做一家店开始 目标是 10年干上市');
  assert.deepEqual(officeFormatsFromGoal(goal), ['docx', 'pdf']);
  assert.equal(defaultOutFileForFormat(goal, 'docx'), '餐饮项目商业计划书.docx');
  assert.equal(defaultOutFileForFormat(goal, 'pdf'), '餐饮项目商业计划书.pdf');
});

test('restaurant listing plan without explicit pdf still maps to printable business plan formats', () => {
  const goal = '帮我做一个从零开始到打造一个上市企业的计划 做泰餐吧 在宁波做一家店开始 目标是 10年干上市';
  assert.deepEqual(officeFormatsFromGoal(goal), ['docx', 'pdf']);
  assert.equal(defaultOutFileForFormat(goal, 'docx'), '餐饮项目商业计划书.docx');
  assert.equal(defaultOutFileForFormat(goal, 'pdf'), '餐饮项目商业计划书.pdf');
});

test('brain fallback plan handles restaurant listing plan without hanging or dropping pdf', () => {
  const goal = '帮我做一个从零开始到打造一个上市企业的计划 做泰餐吧 在宁波做一家店开始 目标是 10年干上市';
  const plan = localFallbackPlan(goal, 'test_timeout');
  assert.equal(plan.kind, 'document');
  assert.match(plan.understanding, /兜底规划/);
  assert.ok(plan.subtasks.length >= 5, 'business fallback should still produce a real plan structure');
  assert.ok(plan.subtasks.some((s) => s.title.includes('财务') || s.skill === 'finance'));
  const outFiles = plan.subtasks.map((s) => s.outFile).filter(Boolean);
  assert.ok(outFiles.length >= 1);
  assert.ok(outFiles.every((f) => f === '餐饮项目商业计划书.docx'));
  assert.deepEqual(officeFormatsFromGoal(plan.goal), ['docx', 'pdf']);
});

test('subtask timeout guard returns a structured failure instead of hanging forever', () => {
  const sub: SubTask = {
    id: 's9',
    title: '风险分析与应对策略',
    objective: '分析餐饮项目主要风险',
    skill: 'analysis',
    complexity: 'deep',
    dependsOn: [],
  };
  const result = __orchestratorTest.timeoutAgentResult(sub, 240_000);
  assert.equal(result.ok, false);
  assert.equal(result.model, 'timeout_guard');
  assert.equal(result.error, 'subtask_timeout_240000ms');
  assert.match(result.output, /停止等待这一环/);
  assert.equal(__orchestratorTest.agentTimeoutMs(sub), 90_000);
  assert.equal(__orchestratorTest.agentTimeoutMs({ ...sub, complexity: 'standard' }), 75_000);
  assert.equal(__orchestratorTest.shouldRetryAgentResult(result), true);
  const retry = __orchestratorTest.compactRetrySubtask(sub);
  assert.equal(retry.complexity, 'standard');
  assert.match(retry.objective, /压缩交付方式补齐这一环/);
  assert.match(retry.objective, /原任务:分析餐饮项目主要风险/);
  assert.equal(__orchestratorTest.layerConcurrency(), 2);
});

test('timed-out retry falls back to an auditable rescue section instead of failing whole delivery', () => {
  const sub: SubTask = {
    id: 's9',
    title: '风险分析与应对策略',
    objective: '分析宁波泰餐项目从首店到上市过程中的主要风险和应对动作',
    skill: 'analysis',
    complexity: 'deep',
    dependsOn: ['s1'],
  };
  const first = __orchestratorTest.timeoutAgentResult(sub, 90_000);
  const retry = __orchestratorTest.timeoutAgentResult({ ...sub, complexity: 'standard' }, 45_000);
  const rescued = __orchestratorTest.timeoutRescueResult(sub, pollutedRestaurantGoal, [{
    subtaskId: 's1',
    title: '确立标准',
    skill: 'research',
    model: 'mock',
    ok: true,
    ms: 1,
    output: '商业计划书需要覆盖市场、运营、财务、融资、上市合规和风险控制。',
  }], first, retry);
  assert.equal(rescued.ok, true);
  assert.match(rescued.model, /timeout_rescue/);
  assert.match(rescued.output, /AIOS 超时救援/);
  assert.match(rescued.output, /执行动作表/);
  assert.match(rescued.output, /SOURCE_GAP|待核验/);
});
