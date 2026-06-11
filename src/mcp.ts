// MCP Client —— Model Context Protocol 客户端。
// 连接外部 MCP Server，发现并调用其工具，扩展 AIOS 能力边界。

import { spawn, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ToolDefinition } from './types';

export interface MCPServerConfig {
  name: string;
  command: string;       // 启动命令，如 "npx @anthropic/mcp-server-filesystem /tmp"
  env?: Record<string, string>;
  enabled?: boolean;
}

export interface MCPTool {
  serverName: string;
  definition: ToolDefinition;
}

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class MCPConnection {
  name: string;
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private rl: ReturnType<typeof createInterface> | null = null;
  private buffer = '';
  private dead = false;

  constructor(name: string) {
    this.name = name;
  }

  async start(command: string, env?: Record<string, string>): Promise<void> {
    const [cmd, ...args] = command.split(/\s+/);
    this.proc = spawn(cmd!, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    this.proc.on('exit', (code) => {
      if (code !== 0 && !this.dead) {
        console.error(`[MCP] ${this.name} exited with code ${code}`);
      }
    });

    this.rl = createInterface({ input: this.proc.stdout! });
    this.rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as JSONRPCResponse;
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        // 非 JSON 行忽略
      }
    });

    // 发送 initialize
    const initResult = await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'AIOS', version: '0.1.0' },
    });

    // 发送 initialized 通知
    this.proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    return initResult;
  }

  private async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const req: JSONRPCRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin!.write(JSON.stringify(req) + '\n');
      // 超时 30 秒
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP ${this.name} call ${method} timeout`));
        }
      }, 30000);
    });
  }

  async listTools(): Promise<ToolDefinition[]> {
    const result = (await this.send('tools/list')) as { tools?: Array<{
      name: string; description?: string; inputSchema?: Record<string, unknown>;
    }> };
    return (result.tools || []).map((t) => ({
      type: 'function' as const,
      function: {
        name: `mcp_${this.name}_${t.name}`,
        description: `[MCP:${this.name}] ${t.description || t.name}`,
        parameters: t.inputSchema || { type: 'object', properties: {} },
      },
    }));
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    // 去掉 mcp_<server>_ 前缀
    const realName = toolName.replace(`mcp_${this.name}_`, '');
    const result = await this.send('tools/call', { name: realName, arguments: args });
    const r = result as { content?: Array<{ type: string; text?: string }> };
    if (r.content) {
      return r.content.map((c) => c.text || '').join('\n');
    }
    return JSON.stringify(result);
  }

  async close(): Promise<void> {
    this.dead = true;
    this.rl?.close();
    this.proc?.kill();
  }
}

// ── MCP Manager ───────────────────────────────────────────

const connections = new Map<string, MCPConnection>();
let mcpTools: MCPTool[] = [];
let initialized = false;

/** 获取 MCP 服务器配置 */
export function loadMCPConfig(): MCPServerConfig[] {
  const raw = process.env.AIOS_MCP_SERVERS;
  if (!raw) return [];
  try {
    return JSON.parse(raw) as MCPServerConfig[];
  } catch {
    // 也支持简单的 key=value 格式: AIOS_MCP_SERVERS="filesystem:npx -y @anthropic/mcp-server-filesystem /tmp"
    return raw.split(';').filter(Boolean).map((entry) => {
      const [name, ...cmdParts] = entry.split(':');
      return { name: name!.trim(), command: cmdParts.join(':').trim(), enabled: true };
    });
  }
}

/** 初始化所有 MCP 连接，发现并注册工具 */
export async function initMCP(): Promise<MCPTool[]> {
  if (initialized) return mcpTools;
  initialized = true;

  const configs = loadMCPConfig().filter((c) => c.enabled !== false);
  const tools: MCPTool[] = [];

  for (const cfg of configs) {
    try {
      const conn = new MCPConnection(cfg.name);
      await conn.start(cfg.command, cfg.env);
      connections.set(cfg.name, conn);

      const serverTools = await conn.listTools();
      for (const t of serverTools) {
        tools.push({ serverName: cfg.name, definition: t });
      }
      console.error(`[MCP] ${cfg.name}: ${serverTools.length} tools`);
    } catch (e) {
      console.error(`[MCP] ${cfg.name} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  mcpTools = tools;
  return tools;
}

/** 获取所有 MCP 工具定义（供 Agent 使用） */
export function getMCPToolDefinitions(): ToolDefinition[] {
  return mcpTools.map((t) => t.definition);
}

/** 执行 MCP 工具调用 */
export async function executeMCPTool(name: string, args: Record<string, unknown>): Promise<string | null> {
  const tool = mcpTools.find((t) => t.definition.function.name === name);
  if (!tool) return null;
  const conn = connections.get(tool.serverName);
  if (!conn) return `MCP server "${tool.serverName}" not connected`;
  return conn.callTool(name, args);
}

/** 关闭所有 MCP 连接 */
export async function shutdownMCP(): Promise<void> {
  for (const conn of connections.values()) {
    await conn.close();
  }
  connections.clear();
  mcpTools = [];
  initialized = false;
}
