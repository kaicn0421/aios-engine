import test from 'node:test';
import assert from 'node:assert/strict';
import { executeToolCall, TOOL_DEFINITIONS } from '../src/tools';
import type { ToolContext, AgentConfig } from '../src/types';

const config: AgentConfig = {
  model: 'deepseek-v4-pro', maxTurns: 5, temperature: 0.3,
  contextLimit: 120000, workDir: process.cwd(),
};
const ctx: ToolContext = { workDir: process.cwd(), config };

test('subagent tool is registered', () => {
  const def = TOOL_DEFINITIONS.find(t => t.function.name === 'subagent');
  assert.ok(def, 'subagent should be in TOOL_DEFINITIONS');
});

test('subagent can execute a simple task', async () => {
  const result = await executeToolCall(
    'subagent',
    JSON.stringify({
      task: 'Count how many .ts files are in the src/ directory',
    }),
    'test_sub_1',
    ctx
  );
  console.log('Subagent result:', result.content.slice(0, 300));
  assert.ok(result.content.length > 20, 'should return meaningful result');
  assert.ok(!result.content.startsWith('未知工具'), 'should not be unknown tool');
  assert.ok(!result.content.startsWith('工具执行异常'), 'should not throw');
});
