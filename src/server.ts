// HTTP server —— 把引擎暴露给浏览器。/chat 返回前端页,/api/run 用 SSE 流式推任务流。
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertKey } from './config';
import { run } from './orchestrator';
import { runAgent, defaultAgentConfig } from './agent-loop';
import { clarify } from './clarify';
import type { AgentEvent } from './types';

const PORT = Number(process.env.PORT) || 8799;
const PAGE = join(process.cwd(), 'public', 'chat.html');
const OUTPUT_ROOT = process.env.AIOS_ENGINE_OUTPUT_DIR || join(process.cwd(), 'output');

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, service: 'aios-engine' }));
    return;
  }

  // 前端页
  if (url.pathname === '/' || url.pathname === '/chat') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(PAGE, 'utf8'));
    } catch {
      res.writeHead(500);
      res.end('chat.html not found');
    }
    return;
  }

  // 需求澄清:返回是否需要追问 + 问题清单
  if (url.pathname === '/api/clarify') {
    const goal = (url.searchParams.get('goal') || '').trim();
    if (!goal) { res.writeHead(400); res.end('missing goal'); return; }
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    try {
      res.writeHead(200, headers);
      res.end(JSON.stringify(await clarify(goal)));
    } catch {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ clear: true, questions: [] }));
    }
    return;
  }

  // 成品文件:让前端 iframe 能加载 output 下的可运行成品
  if (url.pathname.startsWith('/artifact/')) {
    const name = decodeURIComponent(url.pathname.slice('/artifact/'.length));
    if (!/^aios-artifact-\d+\.html$/.test(name)) { res.writeHead(400); res.end('bad name'); return; }
    try {
      const html = readFileSync(join(OUTPUT_ROOT, name), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch { res.writeHead(404); res.end('not found'); }
    return;
  }

  // 项目文件:服务多文件交付文件夹(output/aios-时间/文件名)里的文件
  if (url.pathname.startsWith('/project/')) {
    const rel = decodeURIComponent(url.pathname.slice('/project/'.length));
    if (rel.includes('..') || !/^aios-\d+\/[^/]+$/.test(rel)) { res.writeHead(400); res.end('bad path'); return; }
    try {
      const fp = join(OUTPUT_ROOT, rel);
      const ext = (rel.split('.').pop() || '').toLowerCase();
      const fname = rel.split('/').pop() || 'file';
      if (ext === 'html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(readFileSync(fp, 'utf8'));
      } else if (ext === 'md' || ext === 'csv' || ext === 'txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(readFileSync(fp, 'utf8'));
      } else {
        // docx/pdf 等二进制:按 Buffer 返回 + 触发下载(不能当 utf8 文本读)
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
        });
        res.end(readFileSync(fp));
      }
    } catch { res.writeHead(404); res.end('not found'); }
    return;
  }

  // 同步产出:给一句话、跑完返回成品(供 aios-app 等外部调用,非 SSE)
  if (url.pathname === '/api/produce' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const goal = String((JSON.parse(body || '{}') as { goal?: unknown }).goal || '').trim();
        if (!goal) { res.writeHead(400); res.end('{"error":"missing goal"}'); return; }
        const d = await run(goal);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          kind: d.dir ? 'project' : d.artifactPath ? 'artifact' : 'doc',
          understanding: d.understanding,
          markdown: d.markdown,
          dir: d.dir,
          files: d.files,
          artifactPath: d.artifactPath,
          freshness_verified: d.freshness_verified,
          freshness_summary: d.freshness_summary,
          sources_path: d.sources_path,
          data_path: d.data_path,
          evidence_manifest: d.evidence_manifest,
          office_quality_manifest: d.office_quality_manifest,
          delivery_manifest: d.delivery_manifest,
          task_satisfaction: d.task_satisfaction,
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
    });
    return;
  }

  // 流式产出:POST body 传 goal,用 SSE 推送 brain/agent/result 真实事件。
  if (url.pathname === '/api/produce-stream' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      const started = Date.now();
      let beat = 0;
      const heartbeat = setInterval(() => {
        beat += 1;
        send({
          type: 'progress',
          label: 'Still working',
          detail: `后台仍在运行,已持续约 ${Math.floor((Date.now() - started) / 1000)} 秒`,
          beat,
        });
      }, 15000);
      try {
        const goal = String((JSON.parse(body || '{}') as { goal?: unknown }).goal || '').trim();
        if (!goal) {
          send({ type: 'error', message: 'missing goal' });
        } else {
          await run(goal, send);
        }
      } catch (e) {
        send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      } finally {
        clearInterval(heartbeat);
      }
      res.write('event: end\ndata: {}\n\n');
      res.end();
    });
    return;
  }

  // 运行引擎,SSE 流式推事件
  if (url.pathname === '/api/run') {
    const goal = (url.searchParams.get('goal') || '').trim();
    if (!goal) { res.writeHead(400); res.end('missing goal'); return; }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);

    try {
      await run(goal, send);
    } catch (e) {
      send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
    res.write('event: end\ndata: {}\n\n');
    res.end();
    return;
  }

  // Agent 模式:POST body 传 goal,用 SSE 推送多轮工具调用事件
  if (url.pathname === '/api/agent' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const send = (e: AgentEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      try {
        const goal = String((JSON.parse(body || '{}') as { goal?: unknown }).goal || '').trim();
        if (!goal) {
          send({ type: 'error', message: 'missing goal' });
        } else {
          const config = defaultAgentConfig(process.cwd());
          const result = await runAgent(goal, send, config);
          send({ type: 'done', result });
        }
      } catch (e) {
        send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      }
      res.write('event: end\ndata: {}\n\n');
      res.end();
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

assertKey();
server.listen(PORT, () => {
  console.log(`\n  AIOS chat  →  http://localhost:${PORT}\n`);
});
