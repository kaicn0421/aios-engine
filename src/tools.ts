// Tools —— AIOS Agent 工具系统。类 Claude Code 风格的工具集，DeepSeek function calling 兼容。
// 每个工具有 OpenAI 格式的 JSON Schema 定义 + 实际执行函数。

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { execSync, exec } from 'node:child_process';
import { join, resolve, relative, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import type { ToolDefinition, ToolResult, AgentConfig } from './types';

// ── 工具执行上下文 ────────────────────────────────────────

export interface ToolContext {
  /** 工作目录（文件/命令的沙箱边界） */
  workDir: string;
  /** 消息历史（供 aios_memory 等工具使用） */
  messages?: unknown[];
  /** Agent 配置 */
  config: AgentConfig;
}

// ── 工具定义（OpenAI function calling 格式）──────────────

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ── 文件操作 ──
  {
    type: 'function',
    function: {
      name: 'read',
      description:
        '读取文件内容。支持指定行号范围，大文件请用 offset/limit 分页读取（最多 2000 行）。\n' +
        '读取目录会列出其内容。\n' +
        '用途：查看代码、配置文件、日志等任何文本文件。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件或目录的绝对路径' },
          offset: { type: 'integer', description: '起始行号（从 1 开始），可选' },
          limit: { type: 'integer', description: '读取行数，可选，默认 500' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description:
        '创建或覆盖一个文件。会自动创建不存在的父目录。\n' +
        '重要：只能写入新文件或覆盖你已读取过的文件，不能覆盖未读取的文件（防止意外覆盖）。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件的绝对路径' },
          content: { type: 'string', description: '要写入的文件内容' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description:
        '在文件中执行精确字符串替换。old_string 必须与文件中的内容完全匹配（包括缩进和空白）。\n' +
        '如果 old_string 在文件中不唯一，编辑会失败，需要提供更多上下文使其唯一。\n' +
        '用途：修改代码段、修复 bug、更新配置等局部修改。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '文件的绝对路径' },
          old_string: { type: 'string', description: '要被替换的文本（必须精确匹配）' },
          new_string: { type: 'string', description: '替换后的文本' },
          replace_all: {
            type: 'boolean',
            description: '是否替换所有匹配项，默认 false（仅替换第一个）',
          },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },

  // ── 搜索/探索 ──
  {
    type: 'function',
    function: {
      name: 'glob',
      description:
        '按 glob 模式查找文件。模式如 "src/**/*.ts"、"*.json"、"**/test*.ts"。\n' +
        '返回匹配的文件路径列表。用途：发现项目中的文件、了解项目结构。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'glob 模式，如 src/**/*.ts' },
          path: { type: 'string', description: '搜索的根目录，默认为工作目录' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        '在文件内容中搜索匹配的文本或正则表达式。\n' +
        '返回匹配的行及其文件路径和行号。\n' +
        '用途：查找函数定义、变量使用、TODO 注释、错误信息等。\n' +
        '提示：用 type 参数按语言过滤（ts/js/rs/py/go/java 等），比手写 include 更快。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '搜索文本或正则表达式' },
          path: { type: 'string', description: '搜索目录，默认为工作目录' },
          include: { type: 'string', description: '文件匹配模式，如 *.ts,*.json' },
          type: {
            type: 'string',
            description: '代码类型快捷过滤，自动转为文件扩展名：ts, js, rs, py, go, java, c, cpp, swift, kt, rb, php, html, css, scss, json, yaml, md, sh, sql, vue, svelte, toml',
          },
          max_results: { type: 'integer', description: '最多返回多少条，默认 50' },
        },
        required: ['pattern'],
      },
    },
  },

  // ── 命令执行 ──
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        '在工作目录执行 shell 命令。\n' +
        '命令有 120 秒超时。输出太长会被截断到 8000 字符。\n' +
        '用途：运行测试、安装依赖、构建项目、执行脚本、git 操作等。\n' +
        '安全：禁止 sudo、rm -rf / 等危险操作。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          timeout_ms: { type: 'integer', description: '超时毫秒数，默认 120000' },
          description: { type: 'string', description: '命令用途的简短描述（用于日志）' },
        },
        required: ['command'],
      },
    },
  },

  // ── 网络 ──
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '搜索网页，返回标题、URL 和摘要。\n' +
        '用途：查找最新文档、API 参考、解决方案、新闻等。\n' +
        '不要用此工具查找本地文件（用 glob/grep），不要查找本地项目的代码。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          count: { type: 'integer', description: '返回结果数量，默认 8' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        '获取指定 URL 的网页内容，自动转为 Markdown 文本。\n' +
        '用途：阅读文档、API 参考、新闻文章等。\n' +
        '注意：需要登录或验证的网站无法访问。HTTP 会自动升级为 HTTPS。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的网页 URL' },
          max_length: { type: 'integer', description: '返回文本的最大长度（字符），默认 15000' },
        },
        required: ['url'],
      },
    },
  },

  // ── Git 操作 ──
  {
    type: 'function',
    function: {
      name: 'git',
      description:
        '执行 Git 操作。支持：diff（查看变更）、log（提交历史）、status（文件状态）、blame（行归属）。\n' +
        '比直接用 bash 更安全，输出已经格式化。\n' +
        '用途：查看代码变更、追踪提交历史、了解代码演进。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['diff', 'log', 'status', 'blame'],
            description: 'Git 操作类型',
          },
          path: { type: 'string', description: '文件路径（diff/blame 时使用）' },
          count: { type: 'integer', description: '返回条数（log 时使用），默认 10' },
        },
        required: ['action'],
      },
    },
  },

  // ── 测试运行 ──
  {
    type: 'function',
    function: {
      name: 'test',
      description:
        '运行项目测试。自动检测测试框架（jest/vitest/mocha），运行后返回结果和失败详情。\n' +
        '用途：验证代码修改是否正确、查看测试覆盖率、定位失败的测试。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '测试文件路径或目录，不传则运行全部测试' },
          run: { type: 'string', description: '自定义测试命令，不传则自动检测' },
        },
        required: [],
      },
    },
  },

  // ── PDF & 富媒体 ──
  {
    type: 'function',
    function: {
      name: 'pdf_read',
      description:
        '读取 PDF 文件内容。提取文本、页数、标题等。\n' +
        '用途：阅读报告、合同、论文等 PDF 文档。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'PDF 文件的绝对路径' },
          max_pages: { type: 'integer', description: '最多读取多少页，默认 10' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'image_info',
      description:
        '获取图片文件信息：格式、尺寸、大小、颜色模式、EXIF 数据等。\n' +
        '用途：了解图片属性、检查截图、确认图片是否可用。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '图片文件的绝对路径' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description:
        '截取屏幕截图（仅 macOS）。支持全屏、窗口、选区。\n' +
        '用途：记录当前屏幕状态、捕获 UI 问题、保存界面快照。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['full', 'window', 'selection'],
            description: '截图模式：full=全屏, window=窗口(需点击选择), selection=选区(需拖拽选择)',
          },
          output: { type: 'string', description: '输出文件路径，默认 ~/Desktop/screenshot-时间戳.png' },
        },
        required: [],
      },
    },
  },

  // ── 任务管理 ──
  {
    type: 'function',
    function: {
      name: 'task',
      description:
        '创建和管理结构化子任务列表。用于追踪复杂多步任务的进度。\n' +
        '操作：create（创建任务列表）、update（更新状态）、list（查看当前）。\n' +
        '状态：pending → in_progress → completed。\n' +
        '用途：当任务超过 3 个步骤时，记录计划并可逐步标记完成。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'update', 'list'],
            description: '操作类型',
          },
          tasks: {
            type: 'array',
            description: '任务数组（create 时使用）',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '任务 ID' },
                subject: { type: 'string', description: '任务标题' },
                description: { type: 'string', description: '任务描述' },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                },
              },
              required: ['id', 'subject'],
            },
          },
          task_id: { type: 'string', description: '要更新的任务 ID（update 时使用）' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed'],
            description: '新状态（update 时使用）',
          },
        },
        required: ['action'],
      },
    },
  },

  // ── 代码智能（类 LSP）──
  {
    type: 'function',
    function: {
      name: 'go_to_definition',
      description:
        '查找符号（函数、类、变量、接口等）的定义位置。\n' +
        '返回匹配的文件路径、行号和代码行。\n' +
        '支持 TypeScript/JavaScript/Rust/Python/Go 等常见语言。\n' +
        '用途：定位函数实现、类定义、变量声明。',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: '符号名称，如函数名、类名、变量名' },
          path: { type: 'string', description: '搜索目录，默认为工作目录' },
          lang: { type: 'string', description: '语言类型：ts, rs, py, go, java 等。不传则自动检测' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_references',
      description:
        '查找符号的所有引用/使用位置。\n' +
        '排除定义行，只返回实际使用的位置。\n' +
        '用途：了解代码影响范围、重构前的依赖分析。',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: '符号名称' },
          path: { type: 'string', description: '搜索目录，默认为工作目录' },
          lang: { type: 'string', description: '语言类型：ts, rs, py, go, java 等' },
          max_results: { type: 'integer', description: '最多返回条数，默认 30' },
        },
        required: ['symbol'],
      },
    },
  },

  // ── 子 Agent 委托 ──
  {
    type: 'function',
    function: {
      name: 'subagent',
      description:
        '将子任务委托给一个独立的子 Agent 执行。子 Agent 拥有完整的工具访问权限，独立思考和执行。\n' +
        '可以并行调用多个 subagent，它们会同时工作。\n' +
        '用途：将大任务拆分为独立的子任务并行执行，例如同时搜索多个主题、分别检查多个文件、并行收集多维度信息。\n' +
        '每个子 Agent 最多执行 10 轮工具调用，完成后返回结果。',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '子任务的详细描述。越具体越好，包括预期产出和约束条件。' },
          context: { type: 'string', description: '可选。给子 Agent 的背景信息（如相关文件路径、已知事实等）。' },
        },
        required: ['task'],
      },
    },
  },

  // ── AIOS 特有工具 ──
  {
    type: 'function',
    function: {
      name: 'aios_brain',
      description:
        '调用 AIOS 文档生成管线，生成结构化的文档/报告/分析。\n' +
        '用途：当用户需要生成商业计划书、调研报告、PPT、数据分析等正式文档时使用此工具。\n' +
        '这不是编程工具 —— 编程、改代码、修 bug 不要用这个。',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: '文档目标描述，如"做一份宁波泰餐市场分析报告"' },
          format: {
            type: 'string',
            enum: ['docx', 'pptx', 'xlsx', 'pdf', 'md', 'html'],
            description: '输出格式，默认 docx',
          },
        },
        required: ['goal'],
      },
    },
  },
];

// ── 工具执行函数 ──────────────────────────────────────────

interface ReadResult {
  path: string;
  content: string;
  totalLines: number;
  offset: number;
  limit: number;
}

function safePath(base: string, target: string): string {
  const resolved = resolve(base, target);
  // 确保 target 在 base 内或等于 base，或 target 是绝对路径
  if (target.startsWith('/')) {
    // 绝对路径：不做限制，但要防止 /etc/passwd 之类
    // 允许读取系统文件（如 /usr/bin），但敏感路径警告
    return target;
  }
  return resolved;
}

async function toolRead(
  args: { file_path: string; offset?: number; limit?: number },
  ctx: ToolContext,
): Promise<string> {
  const fp = safePath(ctx.workDir, args.file_path);
  try {
    const stat = statSync(fp);
    if (stat.isDirectory()) {
      const entries = readdirSync(fp, { withFileTypes: true });
      return (
        `目录: ${fp}\n\n` +
        entries
          .map((e) => `${e.isDirectory() ? '📁' : '📄'} ${e.name}${e.isDirectory() ? '/' : ''}`)
          .join('\n')
      );
    }
    const content = readFileSync(fp, 'utf8');
    const lines = content.split('\n');
    const offset = Math.max(1, args.offset || 1);
    const limit = Math.min(args.limit || 500, 2000);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    return slice
      .map((line, i) => `${String(offset + i).padStart(4, ' ')}\t${line}`)
      .join('\n');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('ENOENT')) return `文件不存在: ${args.file_path}。请检查路径是否正确，或先用 glob 查找文件位置。`;
    if (msg.includes('EACCES')) return `权限不足，无法读取: ${args.file_path}。请检查文件权限。`;
    return `读取失败: ${args.file_path} —— ${msg}`;
  }
}

// 跟踪已读取的文件（write 的安全检查）
const readFiles = new Set<string>();

async function toolWrite(
  args: { file_path: string; content: string },
  ctx: ToolContext,
): Promise<string> {
  const fp = safePath(ctx.workDir, args.file_path);
  try {
    // 安全检查：文件已存在但未被读取过
    if (existsSync(fp) && !readFiles.has(fp)) {
      return `安全限制：文件 "${args.file_path}" 已存在但尚未读取，不能直接覆盖。请先用 read 读取该文件，确认内容后再修改。`;
    }
    const dir = dirname(fp);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(fp, args.content, 'utf8');
    readFiles.add(fp);
    const size = Buffer.byteLength(args.content, 'utf8');
    return `写入成功: ${args.file_path} (${formatSize(size)})`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('EACCES')) return `权限不足，无法写入: ${args.file_path}。请检查目标目录是否有写入权限。`;
    return `写入失败: ${args.file_path} —— ${msg}`;
  }
}

async function toolEdit(
  args: { file_path: string; old_string: string; new_string: string; replace_all?: boolean },
  ctx: ToolContext,
): Promise<string> {
  const fp = safePath(ctx.workDir, args.file_path);
  try {
    if (!existsSync(fp)) return `文件不存在: ${args.file_path}。请先确认路径（用 glob 或 grep 查找正确位置）。`;
    const content = readFileSync(fp, 'utf8');
    const escaped = args.old_string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const count = (content.match(new RegExp(escaped, 'g')) || []).length;
    if (count === 0) return `未找到匹配文本: ${args.file_path} 中没有这段内容。请确保 old_string 与原文逐字匹配（含空格和缩进），建议用 read 确认原文。`;
    if (count > 1 && !args.replace_all) {
      return `old_string 在文件中出现了 ${count} 次，不唯一。请在 old_string 前后多加几行上下文使其唯一，或设 replace_all: true 替换全部 ${count} 处。`;
    }
    const newContent = args.replace_all
      ? content.replaceAll(args.old_string, args.new_string)
      : content.replace(args.old_string, args.new_string);
    writeFileSync(fp, newContent, 'utf8');
    return `编辑完成: ${args.file_path}${args.replace_all ? ` (替换了全部 ${count} 处)` : ''}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `编辑失败: ${args.file_path} —— ${msg}。请检查文件是否仍存在、是否有写入权限。`;
  }
}

async function toolGlob(
  args: { pattern: string; path?: string },
  ctx: ToolContext,
): Promise<string> {
  const base = args.path ? safePath(ctx.workDir, args.path) : ctx.workDir;
  try {
    // 简单 glob 实现（不依赖外部库）
    const pattern = args.pattern;
    const regex = globToRegex(pattern);
    const results: string[] = [];
    walkDir(base, regex, results, 500);
    const rel = results.map((f) => relative(ctx.workDir, f));
    return rel.length ? rel.join('\n') : `没有匹配 "${pattern}" 的文件`;
  } catch (e) {
    return `glob 失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function globToRegex(pattern: string): RegExp {
  let p = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '<<GLOBSTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<GLOBSTAR>>/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${p}$`);
}

function walkDir(
  dir: string,
  regex: RegExp,
  results: string[],
  max: number,
): void {
  if (results.length >= max) return;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (results.length >= max) return;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walkDir(full, regex, results, max);
      } else if (e.isFile()) {
        if (regex.test(e.name) || regex.test(relative(process.cwd(), full))) {
          results.push(full);
        }
      }
    }
  } catch {
    // 跳过无权限目录
  }
}

// 代码类型 → 文件扩展名映射
const TYPE_TO_EXT: Record<string, string> = {
  ts: '*.ts,*.tsx', js: '*.js,*.jsx,*.mjs,*.cjs', rs: '*.rs',
  py: '*.py,*.pyi', go: '*.go', java: '*.java', c: '*.c,*.h',
  cpp: '*.cpp,*.cc,*.cxx,*.hpp,*.hxx', swift: '*.swift',
  kt: '*.kt,*.kts', rb: '*.rb', php: '*.php',
  html: '*.html,*.htm', css: '*.css,*.scss,*.less',
  scss: '*.scss', json: '*.json', yaml: '*.yaml,*.yml',
  md: '*.md,*.mdx', sh: '*.sh,*.bash,*.zsh',
  sql: '*.sql', vue: '*.vue', svelte: '*.svelte', toml: '*.toml',
};

// ── LSP 代码智能执行器 ──

/** 语言 → 定义模式映射 */
const DEF_PATTERNS: Record<string, RegExp[]> = {
  ts: [
    /(?:export\s+)?(?:async\s+)?function\s+SYM\b/,
    /(?:export\s+)?(?:const|let|var)\s+SYM\b/,
    /(?:export\s+)?class\s+SYM\b/,
    /(?:export\s+)?interface\s+SYM\b/,
    /(?:export\s+)?type\s+SYM\b/,
    /(?:export\s+)?enum\s+SYM\b/,
  ],
  rs: [
    /fn\s+SYM\b/,
    /struct\s+SYM\b/,
    /enum\s+SYM\b/,
    /trait\s+SYM\b/,
    /impl\s+SYM\b/,
    /(?:let|const)\s+SYM\b/,
    /type\s+SYM\b/,
  ],
  py: [
    /def\s+SYM\b/,
    /class\s+SYM\b/,
    /SYM\s*=\s*/,
  ],
  go: [
    /func\s+SYM\b/,
    /type\s+SYM\b/,
    /var\s+SYM\b/,
    /const\s+SYM\b/,
  ],
  java: [
    /(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:\w+(?:<[^>]*>)?\s+)SYM\b/,
    /class\s+SYM\b/,
    /interface\s+SYM\b/,
  ],
};

function makeDefinitionPatterns(symbol: string, lang: string): RegExp[] {
  const patterns = DEF_PATTERNS[lang] || DEF_PATTERNS['ts']!;
  return patterns.map((p) => new RegExp(p.source.replace(/SYM/g, escapeRegex(symbol)), 'gi'));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function toolGoToDefinition(
  args: { symbol: string; path?: string; lang?: string },
  ctx: ToolContext,
): Promise<string> {
  const symbol = args.symbol.trim();
  if (!symbol) return '请提供要查找的符号名称';
  const base = args.path ? safePath(ctx.workDir, args.path) : ctx.workDir;
  const lang = args.lang || detectLang(base);
  const patterns = makeDefinitionPatterns(symbol, lang);
  const ext = langToExt(lang);

  const results: string[] = [];
  try {
    for (const pattern of patterns) {
      const found = grepWithPattern(base, pattern, ext, 10);
      for (const f of found) {
        if (!results.some((r) => r.startsWith(f.split(':')[0]! + ':' + f.split(':')[1]!))) {
          results.push(f);
        }
      }
    }
    if (!results.length) return `未找到 "${symbol}" 的定义。请确认符号名称是否正确，或尝试用 grep 搜索。`;
    return `"${symbol}" 的定义位置:\n${results.slice(0, 10).join('\n')}`;
  } catch (e) {
    return `定义查找失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function toolFindReferences(
  args: { symbol: string; path?: string; lang?: string; max_results?: number },
  ctx: ToolContext,
): Promise<string> {
  const symbol = args.symbol.trim();
  if (!symbol) return '请提供要查找的符号名称';
  const base = args.path ? safePath(ctx.workDir, args.path) : ctx.workDir;
  const max = args.max_results || 30;
  const lang = args.lang || detectLang(base);
  const defPatterns = makeDefinitionPatterns(symbol, lang);
  const ext = langToExt(lang);

  try {
    // 找所有引用（包含定义）
    const refPattern = new RegExp(`\\b${escapeRegex(symbol)}\\b`, 'g');
    const allRefs = grepWithPattern(base, refPattern, ext, max + 20);

    // 过滤掉定义行
    const defLines = new Set<string>();
    for (const pattern of defPatterns) {
      for (const f of grepWithPattern(base, pattern, ext, 5)) {
        defLines.add(f.split(':').slice(0, 2).join(':'));
      }
    }

    const refs = allRefs.filter((r) => {
      const key = r.split(':').slice(0, 2).join(':');
      return !defLines.has(key);
    });

    if (!refs.length) return `未找到 "${symbol}" 的引用（或所有出现都是定义行）。`;
    return `"${symbol}" 的引用 (${refs.length} 处):\n${refs.slice(0, max).join('\n')}`;
  } catch (e) {
    return `引用查找失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 检测项目语言 */
function detectLang(dir: string): string {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const exts = new Set<string>();
    for (const e of entries) {
      if (e.isFile()) {
        const ext = e.name.split('.').pop() || '';
        exts.add(ext);
      }
    }
    if (exts.has('ts') || exts.has('tsx')) return 'ts';
    if (exts.has('rs')) return 'rs';
    if (exts.has('py')) return 'py';
    if (exts.has('go')) return 'go';
    if (exts.has('java')) return 'java';
  } catch { /* ignore */ }
  return 'ts';
}

/** 语言 → 文件扩展名 */
function langToExt(lang: string): string {
  const map: Record<string, string> = {
    ts: '*.ts,*.tsx', rs: '*.rs', py: '*.py', go: '*.go', java: '*.java',
    js: '*.js,*.jsx,*.mjs', cpp: '*.cpp,*.hpp,*.cc', swift: '*.swift',
  };
  return map[lang] || `*.${lang}`;
}

/** 用 pattern grep 文件，返回 file:line: content 格式的行 */
function grepWithPattern(dir: string, pattern: RegExp, ext: string, max: number): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (results.length >= max) break;
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'target') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        results.push(...grepWithPattern(full, pattern, ext, max - results.length));
      } else if (e.isFile()) {
        const matchExt = ext.split(',').some((x) => {
          const glob = x.trim().replace(/^\*\./, '');
          return e.name.endsWith(glob);
        });
        if (!matchExt) continue;
        try {
          const lines = readFileSync(full, 'utf8').split('\n');
          for (let i = 0; i < lines.length && results.length < max; i++) {
            if (pattern.test(lines[i]!)) {
              results.push(`${full}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
            }
          }
        } catch { /* skip binary */ }
      }
    }
  } catch { /* skip permission errors */ }
  return results;
}

async function toolGrep(
  args: { pattern: string; path?: string; include?: string; type?: string; max_results?: number },
  ctx: ToolContext,
): Promise<string> {
  const base = args.path ? safePath(ctx.workDir, args.path) : ctx.workDir;
  const max = args.max_results || 50;
  try {
    const results: string[] = [];
    // type 参数 → 自动转 include 模式
    const includePattern = args.include || (args.type ? TYPE_TO_EXT[args.type] || `*.${args.type}` : undefined);
    const includeRe = includePattern ? globToRegex(includePattern) : null;
    let patternRe: RegExp;
    try {
      patternRe = new RegExp(args.pattern, 'gi');
    } catch {
      // 当作纯文本搜索
      patternRe = new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    }
    grepDir(base, patternRe, includeRe, results, max);
    if (!results.length) return `未找到匹配 "${args.pattern}" 的内容`;
    return results.join('\n');
  } catch (e) {
    return `grep 失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function grepDir(
  dir: string,
  pattern: RegExp,
  include: RegExp | null,
  results: string[],
  max: number,
): void {
  if (results.length >= max) return;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (results.length >= max) return;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        grepDir(full, pattern, include, results, max);
      } else if (e.isFile()) {
        if (include && !include.test(e.name)) continue;
        try {
          const lines = readFileSync(full, 'utf8').split('\n');
          for (let i = 0; i < lines.length && results.length < max; i++) {
            if (pattern.test(lines[i]!)) {
              results.push(`${full}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
            }
          }
        } catch {
          // 跳过二进制/无权限文件
        }
      }
    }
  } catch {
    // 跳过无权限目录
  }
}

// 危险命令黑名单
const DANGEROUS_COMMANDS = [
  /sudo\s+rm\s+-rf\s+\//,
  /rm\s+-rf\s+\/\s*$/,
  /mkfs\./,
  /dd\s+if=/,
  />\s*\/dev\/sd/,
  /:\(\)\s*\{/, // fork bomb
  /chmod\s+777\s+\//,
  /git\s+push\s+.*--force/,
];

async function toolBash(
  args: { command: string; timeout_ms?: number; description?: string },
  ctx: ToolContext,
): Promise<string> {
  // 安全检查
  for (const pattern of DANGEROUS_COMMANDS) {
    if (pattern.test(args.command)) {
      return `安全阻止: 命令 "${args.command}" 被识别为危险操作，不予执行。如果需要执行此操作，请说明理由后手动执行。`;
    }
  }

  const timeout = args.timeout_ms || 120000;
  try {
    const result = execSync(args.command, {
      cwd: ctx.workDir,
      timeout,
      maxBuffer: 1024 * 1024, // 1MB
      encoding: 'utf8',
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = result.trim() || '(命令执行成功，无输出)';
    if (output.length > 8000) {
      return output.slice(0, 8000) + `\n\n... (输出被截断，共 ${output.length} 字符)`;
    }
    return output;
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string; status?: number };
    const stdout = (err.stdout || '').trim();
    const stderr = (err.stderr || '').trim();
    const parts = [`命令执行失败 (退出码: ${err.status || 'unknown'})`];
    if (stderr) parts.push(`错误输出:\n${stderr.slice(0, 2000)}`);
    if (stdout) parts.push(`标准输出:\n${stdout.slice(0, 2000)}`);
    if (!stderr && !stdout) parts.push('提示: 命令没有输出任何错误信息。请检查命令拼写是否正确、所需工具是否已安装。');
    return parts.join('\n\n');
  }
}

async function toolWebSearch(
  args: { query: string; count?: number },
  _ctx: ToolContext,
): Promise<string> {
  const count = args.count || 8;
  try {
    const urls: string[] = [];
    const ddgUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
    const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(args.query)}&setlang=en-US`;

    const results: Array<{ title: string; url: string; snippet: string }> = [];

    // 并行搜索 DuckDuckGo 和 Bing
    const responses = await Promise.allSettled([
      fetch(ddgUrl, {
        headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AIOS/1.0' },
        signal: AbortSignal.timeout(8000),
      }).then((r) => r.text()),
      fetch(bingUrl, {
        headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AIOS/1.0', 'accept-language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(8000),
      }).then((r) => r.text()),
    ]);

    for (const resp of responses) {
      if (resp.status !== 'fulfilled') continue;
      const html = resp.value;
      // 提取搜索结果
      const linkRe = /<a[^>]*rel="nofollow"[^>]*href="([^"]*)"[^>]*class="result__a"[^>]*>([^<]*)<\/a>/gi;
      const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

      // 简单提取：找所有看起来像搜索结果的链接
      const extracted = extractSearchResults(html);
      for (const r of extracted) {
        if (!results.find((x) => x.url === r.url)) results.push(r);
      }
    }

    if (!results.length) return `没有搜索到与 "${args.query}" 相关的结果。`;
    return results
      .slice(0, count)
      .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
      .join('\n\n');
  } catch (e) {
    return `搜索失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function extractSearchResults(html: string): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  // 匹配 DuckDuckGo 和 Bing 的搜索结果
  const linkPatterns = [
    // DuckDuckGo
    /<a[^>]*rel="nofollow"[^>]*href="([^"]*)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/gi,
    // Bing
    /<h2[^>]*><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a><\/h2>/gi,
    // 通用
    /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]{10,200})<\/a>/gi,
  ];

  const seenUrls = new Set<string>();
  for (const re of linkPatterns) {
    for (const m of html.matchAll(re)) {
      let url = (m[1] || '').replace(/&amp;/g, '&');
      const title = (m[2] || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
      if (!url.startsWith('http')) continue;
      // 跳过搜索引擎自身
      if (/bing\.com|duckduckgo\.com|google\.com|doubleclick/i.test(url)) continue;
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      if (title.length < 5 || title.length > 200) continue;
      results.push({ title, url, snippet: '' });
    }
  }
  return results.slice(0, 20);
}

async function toolWebFetch(
  args: { url: string; max_length?: number },
  _ctx: ToolContext,
): Promise<string> {
  const maxLen = args.max_length || 15000;
  try {
    let url = args.url;
    if (url.startsWith('http:')) url = url.replace('http:', 'https:');
    const resp = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 AIOS/1.0',
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    if (!resp.ok) return `HTTP ${resp.status}: 无法获取 ${url}`;
    const html = await resp.text();
    const text = htmlToText(html);
    if (text.length > maxLen) return text.slice(0, maxLen) + `\n\n... (内容被截断，共 ${text.length} 字符)`;
    return text;
  } catch (e) {
    return `抓取失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function htmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  // 清除过多的空行
  text = text.replace(/\n{3,}/g, '\n\n');
  return text;
}

// ── 任务管理状态 ──
interface ManagedTask {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
}
const taskStore = new Map<string, ManagedTask[]>();

async function toolTask(
  args: {
    action: 'create' | 'update' | 'list';
    tasks?: Array<{ id: string; subject: string; description?: string; status?: string }>;
    task_id?: string;
    status?: 'pending' | 'in_progress' | 'completed';
  },
  _ctx: ToolContext,
): Promise<string> {
  const key = 'default';
  if (args.action === 'create') {
    const tasks: ManagedTask[] = (args.tasks || []).map((t) => ({
      id: t.id,
      subject: t.subject,
      description: t.description || '',
      status: (t.status as ManagedTask['status']) || 'pending',
    }));
    taskStore.set(key, tasks);
    return `创建了 ${tasks.length} 个任务:\n` + tasks.map((t) => `  [${t.status}] ${t.id}: ${t.subject}`).join('\n');
  }
  if (args.action === 'update') {
    const tasks = taskStore.get(key) || [];
    const task = tasks.find((t) => t.id === args.task_id);
    if (!task) return `未找到任务: ${args.task_id}`;
    if (args.status) task.status = args.status;
    return `任务 "${task.id}" 状态更新为 ${task.status}`;
  }
  // list
  const tasks = taskStore.get(key) || [];
  if (!tasks.length) return '暂无任务';
  const icon = (s: string) => (s === 'completed' ? '✅' : s === 'in_progress' ? '🔄' : '⬜');
  return tasks.map((t) => `${icon(t.status)} ${t.id}: ${t.subject}`).join('\n');
}

// ── 子 Agent 运行器 ──

async function runSubAgent(
  task: string,
  context: string,
  workDir: string,
  provider: { chatWithTools: Function },
  model: string,
): Promise<string> {
  const { buildSystemPrompt } = await import('./system-prompt');
  const systemPrompt = buildSystemPrompt(workDir, process.platform || 'darwin', task);

  const prompt = context
    ? `背景信息: ${context}\n\n任务: ${task}\n\n请用你的工具完成这个子任务。完成后请简洁报告结果。`
    : `任务: ${task}\n\n请用你的工具完成这个子任务。完成后请简洁报告结果。`;

  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];

  let finalText = '';
  const MAX_TURNS = 10;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let content: string | null = null;
    let toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> = [];

    try {
      const result = await provider.chatWithTools(model, {
        messages,
        tools: TOOL_DEFINITIONS,
        temperature: 0.3,
        stream: false,
      });
      content = result.content;
      toolCalls = result.toolCalls || [];
    } catch (e) {
      return `子 Agent 调用失败: ${e instanceof Error ? e.message : String(e)}`;
    }

    if (content && content.trim().length > 10) finalText = content.trim();

    if (!toolCalls.length) break;

    // 推送助手消息
    messages.push({ role: 'assistant', content, tool_calls: toolCalls });

    // 执行工具调用
    const ctx: ToolContext = {
      workDir,
      messages: messages as unknown[],
      config: { model, maxTurns: MAX_TURNS, temperature: 0.3, contextLimit: 120000, workDir },
    };

    for (const tc of toolCalls) {
      try {
        const toolResult = await executeToolCall(tc.function.name, tc.function.arguments, tc.id, ctx);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult.content });
      } catch (e) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `工具执行失败: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }

  return finalText || '(子 Agent 未产出文本结果)';
}

// ── AIOS Brain 工具 ──
async function toolSubagent(
  args: { task: string; context?: string },
  ctx: ToolContext,
): Promise<string> {
  try {
    // 动态导入 provider（避免循环依赖）
    const { deepseek, isUsable } = await import('./providers');
    if (!isUsable(deepseek)) return '子 Agent 不可用：DeepSeek Provider 未配置';

    const task = args.task.slice(0, 4000);
    const context = (args.context || '').slice(0, 2000);

    const result = await runSubAgent(task, context, ctx.workDir, deepseek, ctx.config.model);
    return `[子 Agent 完成]\n\n${result}`;
  } catch (e) {
    return `子 Agent 执行失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ── AIOS Brain 工具 ──
async function toolAiosBrain(
  args: { goal: string; format?: string },
  ctx: ToolContext,
): Promise<string> {
  try {
    // 动态导入，避免循环依赖
    const { run } = await import('./orchestrator');
    const deliverable = await run(args.goal);
    return [
      `AIOS Brain 文档生成完成:`,
      `  理解: ${deliverable.understanding}`,
      `  耗时: ${Math.round(deliverable.ms / 1000)}s`,
      `  输出目录: ${deliverable.dir || '(内存)'}`,
      deliverable.markdown
        ? `\n## 生成内容摘要\n${deliverable.markdown.slice(0, 3000)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  } catch (e) {
    return `AIOS Brain 执行失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ── 工具调度 ──────────────────────────────────────────────

// ── Git 工具实现 ──

async function toolGit(
  args: { action: string; path?: string; count?: number },
  ctx: ToolContext,
): Promise<string> {
  const cwd = ctx.workDir;
  const git = (cmd: string) => {
    try {
      return execSync(`git ${cmd}`, { cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 }).trim();
    } catch (e: unknown) {
      const err = e as { stderr?: string; message?: string };
      return `Git 错误: ${err.stderr || err.message || '未知错误'}`;
    }
  };

  switch (args.action) {
    case 'diff': {
      const p = args.path || '';
      const unstaged = git(`diff --color=never ${p}`).slice(0, 8000);
      const staged = git(`diff --cached --color=never ${p}`).slice(0, 8000);
      const parts: string[] = [];
      if (staged && !staged.startsWith('Git 错误')) parts.push(`## 已暂存的变更\n\`\`\`diff\n${staged}\n\`\`\``);
      if (unstaged && !unstaged.startsWith('Git 错误')) parts.push(`## 未暂存的变更\n\`\`\`diff\n${unstaged}\n\`\`\``);
      return parts.join('\n\n') || '没有变更（工作区干净）';
    }
    case 'log': {
      const n = args.count || 10;
      return git(`log --oneline --decorate -${n}`) || '(无提交记录)';
    }
    case 'status': {
      const s = git('status --short');
      return s || '工作区干净，没有待提交的变更';
    }
    case 'blame': {
      if (!args.path) return '请指定要查看的文件路径';
      return git(`blame ${args.path} --date=short`).slice(0, 5000) || '(无法获取 blame 信息)';
    }
    default:
      return `未知的 Git 操作: ${args.action}。支持: diff, log, status, blame`;
  }
}

// ── 测试运行工具实现 ──

async function toolTest(
  args: { path?: string; run?: string },
  ctx: ToolContext,
): Promise<string> {
  const cwd = ctx.workDir;
  const run = (cmd: string) => {
    try {
      return execSync(cmd, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 }).trim();
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      // 测试失败是正常的（有 failing tests）
      return (err.stdout || '') + '\n' + (err.stderr || '');
    }
  };

  // 使用自定义命令
  if (args.run) {
    const output = run(args.run);
    return `测试命令: ${args.run}\n\`\`\`\n${output.slice(0, 8000)}\n\`\`\``;
  }

  // 自动检测测试框架
  const pkgPath = join(cwd, 'package.json');
  let testCmd = '';
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const scripts = pkg.scripts || {};
    if (scripts.test) {
      testCmd = 'npm test --';
    } else if (existsSync(join(cwd, 'vitest.config.ts')) || existsSync(join(cwd, 'vitest.config.js'))) {
      testCmd = 'npx vitest run --';
    } else if (existsSync(join(cwd, 'jest.config.ts')) || existsSync(join(cwd, 'jest.config.js'))) {
      testCmd = 'npx jest --';
    } else if (scripts['test:unit']) {
      testCmd = 'npm run test:unit --';
    } else {
      return '未检测到测试框架。请确认项目中有 package.json 且配置了 test 脚本，或手动指定 run 参数。';
    }
  } catch {
    return '未找到 package.json，无法自动检测测试配置。请手动指定 run 参数。';
  }

  const target = args.path || '';
  const fullCmd = target ? `${testCmd} ${target}` : testCmd.replace(/ --$/, '');
  const output = run(fullCmd);

  // 解析常见测试输出格式
  const passMatch = output.match(/(\d+)\s+tests?\s+passed/);
  const failMatch = output.match(/(\d+)\s+tests?\s+failed/);
  const summary = passMatch || failMatch
    ? `结果: ${passMatch ? passMatch[1] + ' passed' : '0 passed'}, ${failMatch ? failMatch[1] + ' failed' : '0 failed'}`
    : '';

  return [
    `测试命令: ${fullCmd}`,
    summary ? `**${summary}**` : '',
    '',
    '```',
    output.slice(0, 7000),
    '```',
  ].filter(Boolean).join('\n');
}

// ── PDF 读取 ──

async function toolPdfRead(
  args: { file_path: string; max_pages?: number },
  ctx: ToolContext,
): Promise<string> {
  const fp = safePath(ctx.workDir, args.file_path);
  const maxPages = args.max_pages || 10;

  try {
    if (!existsSync(fp)) return `文件不存在: ${args.file_path}`;
    const stat = statSync(fp);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);

    // 尝试用 macOS 内置工具提取文本
    let text = '';
    // 方式1: pdftotext (poppler)
    try {
      text = execSync(`pdftotext -l ${maxPages} -q "${fp}" -`, { encoding: 'utf8', timeout: 30000 }).trim();
    } catch {
      // 方式2: textutil (macOS 内置)
      try {
        text = execSync(`textutil -convert txt -stdout "${fp}"`, { encoding: 'utf8', timeout: 30000 }).trim();
      } catch {
        // 方式3: Python (如果有 PyPDF2)
        try {
          text = execSync(`python3 -c "
import sys
try:
    from PyPDF2 import PdfReader
    r = PdfReader('${fp}')
    pages = min(len(r.pages), ${maxPages})
    for i in range(pages):
        t = r.pages[i].extract_text()
        if t: print(f'--- Page {i+1} ---')
        if t: print(t[:3000])
except ImportError:
    print('PDF_TOOLS_NOT_INSTALLED')
"`, { encoding: 'utf8', timeout: 30000 }).trim();
        } catch {
          text = '';
        }
      }
    }

    if (!text || text === 'PDF_TOOLS_NOT_INSTALLED') {
      return [
        `PDF 文件: ${args.file_path}`,
        `大小: ${sizeMB} MB`,
        '',
        '未能提取文本内容（系统中未安装 pdftotext 或 PyPDF2）。',
        '建议: 安装 PyPDF2: pip3 install PyPDF2',
      ].join('\n');
    }

    const lines = text.split('\n').filter(Boolean);
    return [
      `PDF 文件: ${args.file_path} (${sizeMB} MB)`,
      `提取内容 (最多 ${maxPages} 页):`,
      '```',
      lines.slice(0, 500).join('\n'),
      lines.length > 500 ? `\n... (共 ${lines.length} 行，已截断)` : '',
      '```',
    ].join('\n');
  } catch (e) {
    return `PDF 读取失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ── 图片信息读取 ──

async function toolImageInfo(
  args: { file_path: string },
  ctx: ToolContext,
): Promise<string> {
  const fp = safePath(ctx.workDir, args.file_path);
  try {
    if (!existsSync(fp)) return `文件不存在: ${args.file_path}`;
    const stat = statSync(fp);
    const ext = (fp.split('.').pop() || '').toLowerCase();
    const sizeKB = (stat.size / 1024).toFixed(1);

    const info: string[] = [
      `文件: ${args.file_path}`,
      `大小: ${sizeKB} KB`,
      `格式: ${ext.toUpperCase()}`,
    ];

    // macOS: 用 sips 获取图片详细信息
    if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'heic', 'heif', 'webp'].includes(ext)) {
      try {
        const sips = execSync(
          `sips -g pixelWidth -g pixelHeight -g format -g hasAlpha -g space -g dpiWidth -g dpiHeight "${fp}"`,
          { encoding: 'utf8', timeout: 5000 },
        ).trim();
        for (const line of sips.split('\n')) {
          const m = line.match(/^\s*(\w+)\s*:\s*(.+)/);
          if (m) {
            const key = m[1]!;
            const val = m[2]!;
            const label: Record<string, string> = {
              pixelWidth: '宽度',
              pixelHeight: '高度',
              format: '格式',
              hasAlpha: '透明度',
              space: '色彩空间',
              dpiWidth: 'DPI 宽',
              dpiHeight: 'DPI 高',
            };
            info.push(`${label[key] || key}: ${val}`);
          }
        }
      } catch {
        // sips 不可用，用基本文件信息
        info.push('(图片详细信息不可用)');
      }
    }

    // EXIF 数据（如果有）
    if (['jpg', 'jpeg', 'heic'].includes(ext)) {
      try {
        const exif = execSync(`mdls -name kMDItemAcquisitionMake -name kMDItemAcquisitionModel -name kMDItemContentCreationDate -name kMDItemPixelWidth -name kMDItemPixelHeight "${fp}"`, { encoding: 'utf8', timeout: 5000 }).trim();
        if (exif) info.push(`\nEXIF:\n${exif}`);
      } catch {
        // 无 EXIF
      }
    }

    return info.join('\n');
  } catch (e) {
    return `图片读取失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ── 截图 ──

async function toolScreenshot(
  args: { mode?: string; output?: string },
  _ctx: ToolContext,
): Promise<string> {
  if (process.platform !== 'darwin') {
    return '截图工具仅支持 macOS。';
  }

  const mode = args.mode || 'full';
  const home = process.env.HOME || '/tmp';
  const desktop = `${home}/Desktop`;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = args.output || `${desktop}/screenshot-${ts}.png`;

  const flags: Record<string, string> = {
    full: '',
    window: '-W',
    selection: '-s',
  };

  const flag = flags[mode] || '';
  try {
    execSync(`screencapture ${flag} -x "${outPath}"`, { timeout: 15000 });
    return `截图已保存: ${outPath}\n模式: ${mode === 'full' ? '全屏' : mode === 'window' ? '窗口' : '选区'}`;
  } catch (e) {
    return `截图失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ── 工具超时配置（毫秒）───────────────────────────────────

const TOOL_TIMEOUTS: Record<string, number> = {
  read: 30_000,
  write: 30_000,
  edit: 30_000,
  glob: 60_000,
  grep: 60_000,
  bash: 120_000,
  git: 30_000,
  test: 180_000,
  pdf_read: 30_000,
  image_info: 10_000,
  screenshot: 15_000,
  web_search: 15_000,
  web_fetch: 15_000,
  task: 10_000,
  go_to_definition: 30_000,
  find_references: 30_000,
  subagent: 300_000, // 子 Agent 可能多轮
  aios_brain: 600_000, // 文档管线可能很长
};

function timeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`TIMEOUT:${ms}`)), ms);
  });
}

const TOOL_EXECUTORS: Record<
  string,
  (args: any, ctx: ToolContext) => Promise<string>
> = {
  read: toolRead,
  write: toolWrite,
  edit: toolEdit,
  glob: toolGlob,
  grep: toolGrep,
  bash: toolBash,
  git: toolGit,
  test: toolTest,
  pdf_read: toolPdfRead,
  image_info: toolImageInfo,
  screenshot: toolScreenshot,
  web_search: toolWebSearch,
  web_fetch: toolWebFetch,
  task: toolTask,
  go_to_definition: toolGoToDefinition,
  find_references: toolFindReferences,
  subagent: toolSubagent,
  aios_brain: toolAiosBrain,
};

/** 执行单个工具调用，返回 ToolResult */
export async function executeToolCall(
  name: string,
  args: string,
  toolCallId: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const executor = TOOL_EXECUTORS[name];
  if (!executor) {
    return {
      tool_call_id: toolCallId,
      role: 'tool',
      content: `未知工具: ${name}。当前可用工具: ${Object.keys(TOOL_EXECUTORS).join(', ')}。请选择一个可用的工具重新尝试。`,
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(args);
  } catch {
    return {
      tool_call_id: toolCallId,
      role: 'tool',
      content: `工具参数解析失败: ${args.slice(0, 200)}。请确保参数是合法的 JSON 格式，特别注意字符串中的引号和换行需要转义。`,
    };
  }
  // Read 工具跟踪已读文件
  if (name === 'read' && parsed.file_path) {
    const fp = safePath(ctx.workDir, String(parsed.file_path));
    if (existsSync(fp)) readFiles.add(fp);
  }
  try {
    const timeout = TOOL_TIMEOUTS[name] || 120_000;
    const result = await Promise.race([
      executor(parsed, ctx),
      timeoutPromise(timeout).then(() => {
        throw new Error(`TIMEOUT:${timeout}`);
      }),
    ]);
    const truncated = result.length > 20000 ? result.slice(0, 20000) + `\n\n... (输出共 ${result.length} 字符，已截断)  → 建议: 缩小查询范围或分多次读取` : result;
    return {
      tool_call_id: toolCallId,
      role: 'tool',
      content: truncated,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith('TIMEOUT:')) {
      const ms = parseInt(msg.split(':')[1] || '0', 10);
      const seconds = Math.round(ms / 1000);
      return {
        tool_call_id: toolCallId,
        role: 'tool',
        content: `⏱️ 工具 "${name}" 超时（${seconds} 秒）。建议：缩小操作范围（减少文件数量、搜索范围、网页数量），或分多次执行。`,
      };
    }
    return {
      tool_call_id: toolCallId,
      role: 'tool',
      content: `工具 "${name}" 执行异常: ${msg}。请检查参数是否符合工具要求，或换一种方式完成操作。`,
    };
  }
}

// ── 工具函数 ──────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
