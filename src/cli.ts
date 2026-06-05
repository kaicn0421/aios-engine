// CLI 入口 —— 一句话进,任务流实时打印,最终交付物写入 output/。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { assertKey } from './config';
import { run } from './orchestrator';
import { SKILLS } from './skills';
import type { AiosEvent } from './types';

const C = {
  dim: '\x1b[2m', reset: '\x1b[0m', purple: '\x1b[35m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', bold: '\x1b[1m',
};

function printer(e: AiosEvent): void {
  switch (e.type) {
    case 'brain.start':
      console.log(`\n${C.purple}${C.bold}AIOS Brain${C.reset} ${C.dim}理解目标…${C.reset}`);
      break;
    case 'brain.done':
      console.log(`${C.dim}  ↳ ${e.plan.understanding}${C.reset}`);
      console.log(`${C.purple}拆解为 ${e.plan.subtasks.length} 个子任务:${C.reset}`);
      e.plan.subtasks.forEach((s) =>
        console.log(`  ${C.dim}·${C.reset} [${SKILLS[s.skill].label}] ${s.title}`),
      );
      console.log(`${C.dim}分配 Agent,并行执行…${C.reset}`);
      break;
    case 'agent.start':
      console.log(`  ${C.dim}▸ ${e.subtask.title} …${C.reset}`);
      break;
    case 'agent.done':
      console.log(
        e.result.ok
          ? `  ${C.green}✓${C.reset} ${e.result.title} ${C.dim}(${(e.result.ms / 1000).toFixed(1)}s · ${e.result.model.replace('deepseek-', '')})${C.reset}`
          : `  ${C.red}✗ ${e.result.title}: ${e.result.error}${C.reset}`,
      );
      break;
    case 'result.start':
      console.log(`${C.purple}Result Engine${C.reset} ${C.dim}汇总交付…${C.reset}`);
      break;
    case 'result.step':
      console.log(
        `  ${e.ok === false ? C.yellow : C.dim}${e.ok === false ? '!' : '▸'} ${e.message}${e.detail ? ` · ${e.detail}` : ''}${C.reset}`,
      );
      break;
    case 'result.done':
      break;
  }
}

async function main(): Promise<void> {
  assertKey();
  const args = process.argv.slice(2);
  const shouldOpen = args.includes('--open') || process.env.AIOS_ENGINE_AUTO_OPEN === '1';
  const goal = args.filter((a) => a !== '--open').join(' ').trim() || '帮我做一份泰国麻辣烫开店方案';
  console.log(`${C.bold}目标:${C.reset} ${goal}`);

  const d = await run(goal, printer);

  const freshnessFailed = Boolean(d.freshness_summary) && !d.freshness_verified;
  console.log(
    freshnessFailed
      ? `\n${C.yellow}${C.bold}⚠ 交付需修复${C.reset} ${C.dim}(总耗时 ${(d.ms / 1000).toFixed(1)}s)${C.reset}`
      : `\n${C.green}${C.bold}✓ 交付完成${C.reset} ${C.dim}(总耗时 ${(d.ms / 1000).toFixed(1)}s)${C.reset}`,
  );
  if (d.freshness_summary) {
    const status = d.freshness_verified ? `${C.green}PASS${C.reset}` : `${C.red}NEEDS_REPAIR${C.reset}`;
    const gaps = (d.freshness_summary as { gaps?: string[] }).gaps || [];
    console.log(`${C.bold}数据时效核验:${C.reset} ${status}${gaps.length ? ` ${C.dim}${gaps.join('；')}${C.reset}` : ''}`);
  }
  if (d.dir) {
    console.log(`${C.green}${C.bold}✓ 项目文件夹:${C.reset} ${d.dir}`);
    (d.files || []).forEach((f) => console.log(`  ${C.dim}·${C.reset} ${f.name}`));
    if (shouldOpen) execFile('open', [d.dir]);
  } else if (d.artifactPath) {
    const suffix = shouldOpen ? ` ${C.dim}(浏览器打开中…)${C.reset}` : '';
    console.log(`${C.green}${C.bold}✓ 可运行成品:${C.reset} ${d.artifactPath}${suffix}`);
    if (shouldOpen) execFile('open', [d.artifactPath]);
  } else {
    const file = join(process.cwd(), 'output', `aios-${Date.now()}.md`);
    writeFileSync(file, d.markdown, 'utf8');
    console.log(`${C.dim}文档已写入:${C.reset} ${file}`);
  }
  console.log('');
  console.log(`${C.dim}${'─'.repeat(52)}${C.reset}\n`);
  const preview = d.markdown.length > 1400 ? d.markdown.slice(0, 1400) + `\n\n${C.dim}…(完整见上面的 .md 文件)${C.reset}` : d.markdown;
  console.log(preview);
}

main().catch((e) => {
  console.error(`\n${C.red}AIOS 出错:${C.reset}`, e instanceof Error ? e.message : e);
  process.exit(1);
});
