// CLI 入口 —— 一句话进,任务流实时打印,最终交付物写入 output/。
// 支持两种模式:
//   aios "做一份商业计划书"      → 文档管线（Brain → Agents → Result）
//   aios agent "修复 bug"        → Agent 模式（多轮工具调用，类 Claude Code）
//   aios chat                    → 交互多轮对话模式

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { assertKey, CONFIG } from './config';
import { run } from './orchestrator';
import { runAgent, defaultAgentConfig } from './agent-loop';
import { runPlanMode, type PlanStep } from './plan-mode';
import { SKILLS } from './skills';
import { listIncompleteRuns, toolStatsReport, toolAlerts, statsReset } from './trace';
import type { AiosEvent, AgentEvent } from './types';

const C = {
  dim: '\x1b[2m', reset: '\x1b[0m', purple: '\x1b[35m', cyan: '\x1b[36m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', bold: '\x1b[1m',
};

// ── 文档管线事件打印 ──

function docPrinter(e: AiosEvent): void {
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

async function runDocMode(goal: string, shouldOpen: boolean): Promise<void> {
  const d = await run(goal, docPrinter);

  const freshnessFailed = Boolean(d.freshness_summary) && !d.freshness_verified;
  const taskSatisfaction = d.task_satisfaction as { first_pass_usable?: boolean; verdict?: string; score?: number } | undefined;
  const needsRepair = freshnessFailed || taskSatisfaction?.first_pass_usable === false || taskSatisfaction?.verdict === 'needs_repair';
  console.log(
    needsRepair
      ? `\n${C.yellow}${C.bold}⚠ 交付需修复${C.reset} ${C.dim}(总耗时 ${(d.ms / 1000).toFixed(1)}s)${C.reset}`
      : `\n${C.green}${C.bold}✓ 交付完成${C.reset} ${C.dim}(总耗时 ${(d.ms / 1000).toFixed(1)}s)${C.reset}`,
  );
  if (taskSatisfaction) {
    console.log(`${C.bold}首轮可用度:${C.reset} ${taskSatisfaction.first_pass_usable ? `${C.green}PASS${C.reset}` : `${C.red}NEEDS_REPAIR${C.reset}`} ${C.dim}${taskSatisfaction.score ?? '?'}分${C.reset}`);
  }
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

// ── Agent 模式事件打印 ──

function agentPrinter(e: AgentEvent): void {
  switch (e.type) {
    case 'turn':
      // 静默，不打印轮次
      break;
    case 'text':
      process.stdout.write(e.content);
      break;
    case 'tool_start': {
      const shortArgs = e.args.length > 120 ? e.args.slice(0, 120) + '…' : e.args;
      console.log(`\n${C.cyan}${C.dim}⚙ ${e.name}${C.reset} ${C.dim}${shortArgs}${C.reset}`);
      break;
    }
    case 'tool_done': {
      const icon = e.ok ? C.green + '✓' : C.red + '✗';
      console.log(`  ${icon}${C.reset} ${C.dim}${e.summary}${C.reset}`);
      break;
    }
    case 'done':
      console.log(`\n${C.dim}─`.repeat(52) + C.reset);
      console.log(
        `${C.bold}${e.result.error ? C.red + '✗' : C.green + '✓'} ${e.result.turns} 轮 · ${e.result.toolCalls} 次工具调用 · ${(e.result.ms / 1000).toFixed(1)}s${C.reset}`,
      );
      break;
    case 'heartbeat':
      // 显示进度但避免污染输出（用 stderr 实现覆盖式进度）
      process.stderr.write(
        `\r${C.dim}[第 ${e.turn} 轮 · ${e.toolCalls} 次工具调用 · ${Math.round(e.elapsedMs / 1000)}s]${C.reset}`
      );
      break;
    case 'error':
      console.log(`\n${C.red}错误: ${e.message}${C.reset}`);
      break;
  }
}

async function runPlanModeCLI(goal: string): Promise<void> {
  console.log(`${C.bold}任务:${C.reset} ${goal}`);
  console.log(`${C.purple}${C.bold}Plan 模式${C.reset} ${C.dim}(探索 → 计划 → 确认 → 执行)${C.reset}\n`);

  const config = defaultAgentConfig(process.cwd());

  await runPlanMode(
    goal,
    config,
    async (plan, steps) => {
      // 展示计划给用户
      console.log(`\n${C.dim}${'─'.repeat(52)}${C.reset}`);
      console.log(`${C.purple}${C.bold}📋 执行计划${C.reset}\n`);
      console.log(`${C.dim}${plan}${C.reset}\n`);
      console.log(`${C.bold}步骤:${C.reset}`);
      steps.forEach((s) => {
        console.log(`  ${C.bold}${s.step}.${C.reset} ${s.title}`);
        console.log(`     ${C.dim}${s.action.slice(0, 120)}${C.reset}`);
        if (s.tools.length) console.log(`     ${C.dim}工具: ${s.tools.join(', ')}${C.reset}`);
      });
      console.log(`\n${C.dim}${'─'.repeat(52)}${C.reset}`);

      // 等用户确认
      const answer = await new Promise<string>((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`${C.bold}执行此计划? [Y/n]${C.reset} `, (a) => {
          rl.close();
          resolve(a.trim().toLowerCase());
        });
      });

      if (answer === 'n' || answer === 'no') {
        console.log(`${C.yellow}已取消${C.reset}`);
        return false;
      }
      console.log(`${C.green}开始执行…${C.reset}\n`);
      return true;
    },
    (e) => {
      // Plan 事件回调
      switch (e.type) {
        case 'explore_start':
          console.log(`${C.cyan}🔍 探索项目…${C.reset}`);
          break;
        case 'explore_done':
          console.log(`${C.green}✓${C.reset} ${C.dim}探索完成：${e.context.slice(0, 120)}…${C.reset}\n`);
          break;
        case 'exec_start':
          process.stdout.write(`  ${C.bold}[${e.step}/${e.total}]${C.reset} `);
          break;
        case 'exec_done':
          console.log(`${C.green}✓${C.reset} ${C.dim}${e.result.slice(0, 80)}${C.reset}`);
          break;
        case 'done':
          console.log(`\n${C.green}${C.bold}✓ 计划执行完成${C.reset}`);
          break;
      }
    },
  );
}

async function runAgentMode(goal: string): Promise<void> {
  // 检查是否有未完成的上次运行
  const incomplete = listIncompleteRuns();
  if (incomplete.length) {
    console.log(`${C.yellow}⚠ 发现 ${incomplete.length} 个未完成的 Agent 运行:${C.reset}`);
    for (const r of incomplete.slice(0, 3)) {
      console.log(`  ${C.dim}·${C.reset} ${r.goal.slice(0, 80)} ${C.dim}(${r.turn} 轮, ${r.saved_at})${C.reset}`);
    }
    console.log(`${C.dim}已完成或放弃的 checkpoint 将在下次成功运行后自动清理。${C.reset}\n`);
  }

  console.log(`${C.bold}目标:${C.reset} ${goal}`);
  console.log(`${C.cyan}${C.bold}AIOS Agent${C.reset} ${C.dim}(模型: ${CONFIG.models.strong}, 模式: 多轮工具调用)${C.reset}\n`);

  const config = defaultAgentConfig(process.cwd());
  const result = await runAgent(goal, agentPrinter, config);

  if (result.error) {
    console.log(`\n${C.yellow}⚠ Agent 异常结束: ${result.error}${C.reset}`);
  }
}

// ── Chat 交互模式 ──

async function runChatMode(): Promise<void> {
  console.log(`${C.cyan}${C.bold}AIOS Agent Chat${C.reset} ${C.dim}(输入消息开始对话，输入 /quit 退出)${C.reset}\n`);
  console.log(`${C.dim}模型: ${CONFIG.models.strong} | 工作目录: ${process.cwd()}${C.reset}\n`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.cyan}>${C.reset} `,
  });

  const config = defaultAgentConfig(process.cwd());

  const ask = (): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(`${C.cyan}>${C.reset} `, (answer) => {
        resolve(answer.trim());
      });
    });
  };

  try {
    while (true) {
      const input = await ask();
      if (!input) continue;
      if (input === '/quit' || input === '/exit' || input === '/q') {
        console.log(`${C.dim}再见。${C.reset}`);
        break;
      }
      if (input === '/help') {
        console.log(`${C.dim}命令: /quit 退出 | /help 帮助 | /doc <目标> 调用文档管线${C.reset}`);
        continue;
      }

      console.log('');
      const result = await runAgent(input, agentPrinter, config);
      console.log('');

      if (result.error) {
        console.log(`${C.yellow}⚠ ${result.error}${C.reset}\n`);
      }
    }
  } finally {
    rl.close();
  }
}

// ── 主入口 ──

async function main(): Promise<void> {
  assertKey();
  const args = process.argv.slice(2);

  // aios stats → 工具统计
  if (args[0] === 'stats' || args[0] === 's') {
    if (args[1] === 'reset' || args[1] === '--reset') {
      statsReset();
      console.log('统计已清空');
      return;
    }
    console.log(`\n${C.bold}AIOS 工具调用统计:${C.reset}\n`);
    console.log(toolStatsReport());
    const alerts = toolAlerts();
    if (alerts.length) {
      console.log(`\n${C.yellow}⚠ 告警:${C.reset}`);
      alerts.forEach((a) => console.log(`  ${C.yellow}•${C.reset} ${a}`));
    }
    const incomplete = listIncompleteRuns();
    if (incomplete.length) {
      console.log(`\n${C.yellow}⚠ 未完成的运行:${C.reset} ${incomplete.length} 个`);
    }
    console.log('');
    return;
  }

  // aios chat → 交互对话模式
  if (args[0] === 'chat' || args[0] === 'c') {
    await runChatMode();
    return;
  }

  // aios plan "task" → Plan 模式（先探索→出计划→确认→执行）
  if (args[0] === 'plan' || args[0] === 'p') {
    const goal = args.slice(1).join(' ').trim();
    if (!goal) {
      console.error(`${C.red}用法: aios plan "复杂任务描述"${C.reset}`);
      process.exit(1);
    }
    await runPlanModeCLI(goal);
    return;
  }

  // aios agent "task" → Agent 模式
  if (args[0] === 'agent' || args[0] === 'a') {
    const hasPlan = args.includes('--plan');
    const goal = args.filter((a) => a !== '--plan').slice(1).join(' ').trim();
    if (!goal) {
      console.error(`${C.red}用法: aios agent "你的任务描述" [--plan]${C.reset}`);
      process.exit(1);
    }
    if (hasPlan) {
      await runPlanModeCLI(goal);
    } else {
      await runAgentMode(goal);
    }
    return;
  }

  // aios "goal" → 默认文档管线
  const shouldOpen = args.includes('--open') || process.env.AIOS_ENGINE_AUTO_OPEN === '1';
  const goal = args.filter((a) => a !== '--open').join(' ').trim() || '帮我做一份泰国麻辣烫开店方案';
  console.log(`${C.bold}目标:${C.reset} ${goal}`);
  await runDocMode(goal, shouldOpen);
}

main().catch((e) => {
  console.error(`\n${C.red}AIOS 出错:${C.reset}`, e instanceof Error ? e.message : e);
  process.exit(1);
});
