import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { listGameMeta, getGameMeta } from '@ai-playground/core';
import { createMcpServer } from '@ai-playground/mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { RoomManager, SeatTakenError, SeatTokenRequiredError, normalizeSessionId } from './rooms.ts';
import { scheduleAgentTurnWake, scheduleRoomEndWake } from './wake.ts';
import { buildDescriptor, buildLlmsTxt } from './discovery.ts';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';

// /mcp 里的工具要回头调本服务的 REST 接口。默认连 8787，
// 所以起在非默认端口时必须把真实地址写回环境，否则 MCP 工具会打到另一个实例上。
process.env.PLAYGROUND_URL ??= `http://${HOST}:${PORT}`;
const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const rooms = new RoomManager();

/**
 * 唤醒桥：轮到 Agent 时叫醒已绑定的 DSH 会话（第 14 轮，设计稿 §3.1）。
 *
 * 为什么放在这一层：触发时机全是「一次 HTTP 动作之后」（入座开局 / 落子结算 / 绑定），
 * 只有这里能看到完整时机；rooms.ts 保持纯状态机，不掺网络。
 * fire-and-forget：任何失败都在 wake.ts 里被吃掉，绝不冒泡成对局响应的一部分。
 */
function notifyAgentTurn(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  scheduleAgentTurnWake(room, {
    onResult: (id, outcome) => rooms.noteWakeResult(id, outcome),
  });
}

/**
 * 对局结束也唤醒一次（第 15 轮补）——主人反馈「我赢了你那边没收到消息」。
 * 和「该你出招」分开是因为终局没有 currentSeat 可看；同房间只叫一次。
 */
function notifyRoomEnd(roomId: string): void {
  const room = rooms.get(roomId);
  if (!room) return;
  scheduleRoomEndWake(room, {
    onResult: (id, outcome) => rooms.noteWakeResult(id, outcome),
  });
}

// 静态目录：仓库内开发时默认 packages/web/dist；打成 npm 包后 import.meta.dirname 落在 dist/ 里，
// 相对路径算不到包内资源，所以允许 CLI 用 PLAYGROUND_WEB_DIST 注入绝对路径。
const webDist = process.env.PLAYGROUND_WEB_DIST ?? resolve(import.meta.dirname, '../../web/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  // 音频：必须给对 MIME，否则 <audio> 在部分浏览器里会拒绝播放 octet-stream
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'access-control-allow-origin': '*',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** 带状态码的请求错误：由最外层处理器统一转成 JSON 响应，避免异常逃逸打死进程。 */
class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 请求体上限：这个项目最大的合法请求是 MCP 的 JSON-RPC，64KB 足够。 */
const MAX_BODY_BYTES = 64 * 1024;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.byteLength;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大（上限 64KB）');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 以前这里静默返回 {}，结果「发坏 JSON」= 开了一桌默认游戏。现在明确报错。
    throw new HttpError(400, '请求体不是合法 JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

/**
 * 解析座位号：必须是 0 或 1 的整数。
 * 以前用 `Number(seat ?? 0)`：`true`/`"0"`/`[0]` 都会被强转成合法座位；
 * 更糟的是"忘了传"会被当成座位 0 —— 直接替人类下手。
 */
function parseSeat(value: unknown, options: { required: boolean }): number {
  if (value === undefined || value === null || value === '') {
    if (options.required) throw new HttpError(400, '缺少 seat（必须是 0 或 1）');
    return 0;
  }
  const seat =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(seat) || (seat !== 0 && seat !== 1)) {
    throw new HttpError(400, `seat 必须是 0 或 1，收到 ${JSON.stringify(value)}`);
  }
  return seat;
}

/** 把异常映射成 HTTP 状态码：参数类 400，「房间不存在」404，席位鉴权 403/409，其余 500。 */
function statusOf(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  if (err instanceof SeatTokenRequiredError) return 403;
  if (err instanceof SeatTakenError) return 409;
  const msg = String((err as Error)?.message ?? '');
  // sessionId 是第 14 轮唤醒桥的参数：格式不对属于「参数类」400，别掉进 500。
  if (/seat|sessionId|文本|太快|未知游戏|JSON/.test(msg)) return 400;
  if (/房间不存在/.test(msg)) return 404;
  return 500;
}

/**
 * 错误响应体：席位鉴权类错误回稳定的机器可读 code（契约要求 error 字段就是 code），
 * 其它错误沿用中文 message，方便人类直接看懂。
 */
function errorBody(err: unknown): { error: string } {
  if (err instanceof SeatTokenRequiredError || err instanceof SeatTakenError) {
    return { error: err.code };
  }
  return { error: String((err as Error)?.message ?? err) };
}

/** 统一发错误响应，extra 用来补 ok:false 之类的字段。 */
function sendError(res: ServerResponse, err: unknown, extra: Record<string, unknown> = {}): void {
  json(res, statusOf(err), { ...extra, ...errorBody(err) });
}

/**
 * 从 query / body 里取令牌：非字符串或空串一律视为「没带」。
 * 没带不是 400 —— 读操作要降级成旁观，写操作由 rooms 层给 403。
 */
function readToken(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 座位令牌的三个来源，按优先级取第一个非空：
 *   1. 请求体 `{"token": "…"}`
 *   2. 查询串 `?token=…`
 *   3. 请求头 `x-seat-token`（给不想把凭据写进 URL / 访问日志的客户端）
 *
 * 头部这条以前**只写在契约里、没实现**，导致照着文档用头的客户端一直拿到旁观视图。
 * 现在补齐——文档承诺什么，代码就做什么。
 */
function tokenFrom(req: IncomingMessage, ...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const token = readToken(candidate);
    if (token) return token;
  }
  const header = req.headers['x-seat-token'];
  return readToken(Array.isArray(header) ? header[0] : header);
}

function routeParts(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

/**
 * MCP over HTTP（Streamable HTTP，无状态）。
 * 新会话的 Agent 不用翻源码、不用配 stdio，直接连 `POST /mcp` 就能拿到 10 个工具。
 */
async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, mcp-session-id, mcp-protocol-version',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    });
    res.end();
    return;
  }
  try {
    const mcp = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void Promise.resolve(transport.close()).catch(() => undefined);
      void Promise.resolve(mcp.close()).catch(() => undefined);
    });
    await mcp.connect(transport);
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (!res.headersSent) {
      // 坏 JSON / 超大请求体沿用 HTTP 语义（400 / 413），别一律 500 —— MCP 客户端会按 500 当成服务端崩了
      const status = err instanceof HttpError ? err.status : 500;
      json(res, status, { error: String((err as Error)?.message ?? err) });
    } else res.end();
  }
}


async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
): Promise<boolean> {
  const method = req.method ?? 'GET';

  // GET /api/games —— 大厅目录（可玩 + 路线图占位）
  if (method === 'GET' && parts.length === 2 && parts[1] === 'games') {
    json(res, 200, { games: listGameMeta() });
    return true;
  }

  // POST /api/rooms
  if (method === 'POST' && parts.length === 2 && parts[1] === 'rooms') {
    const body = await readBody(req);
    const gameId = String(body.gameId ?? 'grab');
    const meta = getGameMeta(gameId);
    if (!meta) {
      json(res, 400, { error: `没有这款游戏：${gameId}` });
      return true;
    }
    // 开发中（wip）的游戏默认不让大厅开桌，免得人类点进去看到半成品界面。
    // 但自动化测试 / Agent 冒烟需要能进：显式传 allowWip 或起服务时设 PLAYGROUND_ALLOW_WIP=1。
    const allowWip = body.allowWip === true || process.env.PLAYGROUND_ALLOW_WIP === '1';
    if (meta.status === 'wip' && !allowWip) {
      json(res, 400, {
        error: `《${meta.name}》还在开发中，先开一桌《抢宝大作战》吧`,
        hint: '测试用途可传 {"allowWip":true}，或起服务时设 PLAYGROUND_ALLOW_WIP=1',
      });
      return true;
    }
    try {
      // 先校验 sessionId 再建桌：否则参数写错会留下一个没人接手的空房间。
      const sessionId = body.sessionId === undefined ? null : normalizeSessionId(body.sessionId);
      const room = rooms.create(gameId);
      if (sessionId !== null) rooms.bindWake(room.id, sessionId);
      // 此刻房间还是 waiting（双方没到齐），shouldWakeAgent 会挡掉；
      // 留着这行是为了「以后改成自动开局」时行为不用再想一遍。
      notifyAgentTurn(room.id);
      // 0 号位令牌在建桌时已预留；人类入口把它带在 URL 里，浏览器存进 sessionStorage 后
      // 应立刻用 history.replaceState 从地址栏抹掉，免得截图 / 日志把凭据带出去。
      const humanToken = room.seatTokens[0] as string;
      json(res, 200, {
        roomId: room.id,
        gameId: room.gameId,
        humanUrlPath: `/?room=${room.id}&seat=0&token=${encodeURIComponent(humanToken)}`,
        agentSeat: 1,
        // 令牌的另一份副本：前端 / MCP 客户端据此保存 0 号位凭据
        seatTokens: { 0: humanToken },
        // 建桌时顺带绑定的唤醒会话（没传就为 null，行为与加唤醒桥之前一致）。
        wake: sessionId === null ? null : { boundSessionId: sessionId },
        rules: room.game.meta.rules,
      });
    } catch (err) {
      sendError(res, err);
    }
    return true;
  }

  // /api/rooms/:id...
  if (parts.length >= 3 && parts[1] === 'rooms') {
    const roomId = parts[2];
    const sub = parts[3];

    if (method === 'GET' && !sub) {
      try {
        json(res, 200, rooms.summary(roomId));
      } catch (err) {
        json(res, 404, { error: String((err as Error).message) });
      }
      return true;
    }

    if (method === 'POST' && sub === 'join') {
      const body = await readBody(req);
      try {
        const seat = parseSeat(body.seat, { required: true });
        // sessionId 在入座**之前**校验：座位一旦占上就没有回滚一说，
        // 不能等 join 成功、绑定时才发现参数写错。
        const sessionId = body.sessionId === undefined ? null : normalizeSessionId(body.sessionId);
        const joined = rooms.join(roomId, seat, tokenFrom(req, body.token));
        if (sessionId !== null) rooms.bindWake(roomId, sessionId);
        // 双方到齐这一刻可能正好轮到 Agent（例如先手是 Agent 的局），需要把会话叫醒。
        notifyAgentTurn(roomId);
        // 令牌只回给入座的这一方；summary 里没有令牌，避免顺手泄露另一座位。
        json(res, 200, {
          ok: true,
          seat: joined.seat,
          token: joined.token,
          ...rooms.summary(roomId),
        });
      } catch (err) {
        sendError(res, err);
      }
      return true;
    }

    // POST /api/rooms/:id/bind —— 把房间绑定到一个 DSH 会话（唤醒桥）。
    // 只新增、不改既有路由；绑定不要求席位令牌（设计稿的唤醒链路只走本机回环），
    // 它只决定「叫醒谁」，拿不到任何对局权限，也读不到私有观测。
    if (method === 'POST' && sub === 'bind') {
      const body = await readBody(req);
      try {
        const binding = rooms.bindWake(roomId, normalizeSessionId(body.sessionId));
        // 绑定当下若已经轮到 Agent（人类先落了子、Agent 这才补绑），补叫一次；
        // 同一回合 3 秒去重会挡住重复触发。
        notifyAgentTurn(roomId);
        json(res, 200, {
          ok: true,
          roomId,
          sessionId: binding.sessionId,
          boundAt: binding.boundAt,
        });
      } catch (err) {
        sendError(res, err, { ok: false });
      }
      return true;
    }

    if (method === 'GET' && sub === 'state') {
      const params = new URL(req.url ?? '/', 'http://x').searchParams;
      const seat = parseSeat(params.get('seat'), { required: false });
      try {
        // 令牌不对不报错：降级为旁观观测（spectator=true），围观是正当场景。
        json(res, 200, rooms.observation(roomId, seat, tokenFrom(req, params.get('token'))));
      } catch (err) {
        sendError(res, err);
      }
      return true;
    }

    if (method === 'POST' && sub === 'action') {
      const body = await readBody(req);
      try {
        const seat = parseSeat(body.seat, { required: true });
        const result = rooms.submit(
          roomId,
          seat,
          (body.action ?? {}) as Record<string, unknown>,
          tokenFrom(req, body.token),
        );
        if (result.error) {
          json(res, 409, { ok: false, error: result.error, legalActions: result.legalActions ?? [] });
        } else {
          // 结算后的这一刻正是「该不该叫醒 Agent」的判定点：
          // turn 模式看 currentSeat===1；simultaneous 看人类已交、Agent 未交。
          //
          // 只由 **人类（seat 0）** 的动作触发：Agent 自己出招后如果仍轮到自己
          // （快艇 roll/hold、深海命中继续、黑白棋对手被自动跳过），它本来就是醒的，
          // 再叫一次只会往会话里多塞一条「该你了」，反而干扰它读盘。
          //
          // 终局例外（第 15 轮）：不管是谁下的最后一手，都要叫一次「结束了」——
          // 人类赢了 Agent 却不知道，只能等下一个人发消息，那种体验已经踩过。
          const after = rooms.get(roomId);
          if (after?.status === 'ended') notifyRoomEnd(roomId);
          else if (seat === 0) notifyAgentTurn(roomId);
          json(res, 200, { ok: true, resolved: result.resolved, events: result.events });
        }
      } catch (err) {
        // 缺令牌 / 令牌不对 → 403 seat_token_required（旁观者不能替座位出手）
        sendError(res, err, { ok: false });
      }
      return true;
    }

    if (method === 'POST' && sub === 'say') {
      const body = await readBody(req);
      try {
        const message = rooms.say(
          roomId,
          parseSeat(body.seat, { required: true }),
          String(body.text ?? ''),
          tokenFrom(req, body.token),
        );
        json(res, 200, { ok: true, message });
      } catch (err) {
        sendError(res, err, { ok: false });
      }
      return true;
    }

    if (method === 'GET' && sub === 'chat') {
      const since = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('since') ?? 0);
      try {
        json(res, 200, { messages: rooms.chat(roomId, since) });
      } catch (err) {
        json(res, 404, { error: String((err as Error).message) });
      }
      return true;
    }

    if (method === 'GET' && sub === 'result') {
      try {
        json(res, 200, rooms.summary(roomId).result ?? null);
      } catch (err) {
        json(res, 404, { error: String((err as Error).message) });
      }
      return true;
    }

    if (method === 'GET' && sub === 'log') {
      const seat = parseSeat(new URL(req.url ?? '/', 'http://x').searchParams.get('seat'), { required: false });
      try {
        json(res, 200, rooms.exportLog(roomId, seat));
      } catch (err) {
        json(res, statusOf(err), { error: String((err as Error).message) });
      }
      return true;
    }
  }

  return false;
}

/**
 * 仓库里的 Markdown 文档随服务一起发出去：
 * - 大厅有个「给 Agent 的接入说明」按钮指向 /AGENTS.md，不给路由就是 404；
 * - CC-BY 的 BGM 需要在应用里能点到署名（/CREDITS.md）。
 * 只走白名单 + docs 目录内的单层文件名，避免路径穿越。
 */
function serveMarkdown(res: ServerResponse, pathname: string): boolean {
  const repoRoot = REPO_ROOT;
  let filePath: string | null = null;
  if (pathname === '/AGENTS.md') filePath = join(repoRoot, 'AGENTS.md');
  else if (pathname === '/CREDITS.md') filePath = join(repoRoot, 'docs', 'CREDITS.md');
  else if (pathname.startsWith('/docs/')) {
    let name = '';
    try {
      name = decodeURIComponent(pathname.slice('/docs/'.length));
    } catch {
      // 非法百分号转义（例如 /docs/%ZZ.md）以前会抛未捕获的 URIError，
      // 直接把整个 Node 进程打死（房间全在内存 → 所有对局丢失）。
      res.writeHead(400, { 'content-type': 'text/markdown; charset=utf-8' });
      res.end('文档路径编码不合法');
      return true;
    }
    if (/^[A-Za-z0-9._-]+\.md$/.test(name) && !name.includes('..')) {
      filePath = join(repoRoot, 'docs', name);
    }
  }
  if (!filePath) return false;
  try {
    const data = readFileSync(filePath);
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/markdown; charset=utf-8' });
    res.end('未找到这份文档');
  }
  return true;
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  if (!existsSync(webDist)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<html><body style="font-family:system-ui;padding:40px">
        <h1>AI 游乐场 · 服务端已启动</h1>
        <p>前端尚未构建。开发模式请另开一个终端运行 <code>pnpm dev:web</code>（Vite 5173），
        或运行 <code>pnpm build</code> 生成 packages/web/dist。</p>
        <p>API 健康检查：<a href="/api/games">/api/games</a></p>
      </body></html>`,
    );
    return;
  }
  // 注意：Windows 上 normalize('/') 会变成 '\'，所以"要不要走 SPA 入口"必须
  // 用原始 pathname 判断，绝不能拿 normalize 之后的结果去比 '/'
  // （否则根路径会指向 dist 目录本身，readFileSync 抛 EISDIR）。
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const isSpaRoute = pathname === '/' || !extname(pathname);
  const target = join(webDist, isSpaRoute ? 'index.html' : safePath);
  const ext = extname(target);

  if (!existsSync(target) || !statSync(target).isFile()) {
    // 带扩展名的请求视为静态资源：缺失就 404。
    // 以前一律回退 index.html，导致 /audio/xxx.mp3 返回 200 + HTML，
    // <audio> 拿到 HTML 会静默失败，排查起来很难。
    if (!isSpaRoute) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    // 无扩展名 = 前端路由，回退 SPA 入口
    filePathFallback(res, 0);
    return;
  }

  let data: Buffer;
  try {
    data = readFileSync(target);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('读文件失败');
    return;
  }

  const type = MIME[ext] ?? 'application/octet-stream';
  const total = data.byteLength;
  const range = req.headers.range;

  // 支持 Range：4.4MB 的 BGM 必须要能 seek，否则 <audio> 拖动进度条会失效
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (match) {
      const start = match[1] === '' ? Math.max(0, total - Number(match[2] || 0)) : Number(match[1]);
      const end = match[1] !== '' && match[2] !== '' ? Number(match[2]) : total - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < total) {
        const slice = data.subarray(start, Math.min(end, total - 1) + 1);
        res.writeHead(206, {
          'content-type': type,
          'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${start + slice.byteLength - 1}/${total}`,
          'content-length': slice.byteLength,
        });
        res.end(slice);
        return;
      }
      res.writeHead(416, { 'content-range': `bytes */${total}` });
      res.end();
      return;
    }
  }

  res.writeHead(200, {
    'content-type': type,
    'accept-ranges': 'bytes',
    'content-length': total,
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  res.end(data);

  function filePathFallback(response: ServerResponse, _status: number): void {
    try {
      const html = readFileSync(join(webDist, 'index.html'));
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.byteLength });
      response.end(html);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('前端未构建');
    }
  }
}

export function startServer(): { close: () => void; port: number } {
  const server = createServer(async (req, res) => {
    // 最外层兜底：任何未捕获异常都必须变成 5xx 响应，
    // 而不是逃逸成 unhandledRejection 把进程打死（房间全在内存，进程一死全丢）。
    try {
      await handleRequest(req, res);
    } catch (err) {
      const status = statusOf(err);
      console.error('[server] 未捕获的请求异常:', err);
      if (!res.headersSent) json(res, status, { error: String((err as Error)?.message ?? err) });
      else res.end();
    }
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      });
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const baseUrl = `http://${req.headers.host ?? `${HOST}:${PORT}`}`;
    const discovery = { baseUrl, repoPath: REPO_ROOT };

    // —— Agent 发现层：让新会话第一眼就知道「接口在哪」——
    if (url.pathname === '/llms.txt') {
      sendText(res, 200, buildLlmsTxt(discovery));
      return;
    }
    if (url.pathname === '/.well-known/ai-playground.json' || url.pathname === '/api/agent') {
      json(res, 200, buildDescriptor(discovery));
      return;
    }
    if (url.pathname === '/mcp') {
      await handleMcpRequest(req, res);
      return;
    }
    if (serveMarkdown(res, url.pathname)) return;

    const parts = routeParts(url.pathname);
    if (parts[0] === 'api') {
      const handled = await handleApi(req, res, parts);
      if (!handled) json(res, 404, { error: 'not_found' });
      return;
    }
    serveStatic(req, res, url.pathname);
  }

  const wss = new WebSocketServer({ server, path: '/ws' });
  const roomClients = new Map<string, Set<WebSocket>>();

  wss.on('connection', (socket, req) => {
    const url = new URL(req.url ?? '/ws', 'http://localhost');
    const roomId = url.searchParams.get('room') ?? '';
    if (!roomId) {
      socket.close(1008, 'missing room');
      return;
    }
    // 房间不存在就别让它挂着等（以前会收下连接然后永久静默，前端只能干等心跳消失）
    let summary: unknown = null;
    try {
      summary = rooms.summary(roomId);
    } catch {
      socket.close(1008, 'room not found');
      return;
    }
    const set = roomClients.get(roomId) ?? new Set<WebSocket>();
    set.add(socket);
    roomClients.set(roomId, set);
    socket.send(JSON.stringify({ type: 'hello', roomId, summary }));

    // 心跳：清掉半死连接，否则 roomClients 只增不减
    let alive = true;
    socket.on('pong', () => {
      alive = true;
    });
    const beat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      try {
        socket.ping();
      } catch {
        /* 忽略 */
      }
    }, 30_000);
    beat.unref?.();

    const cleanup = () => {
      clearInterval(beat);
      set.delete(socket);
      if (set.size === 0) roomClients.delete(roomId);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  // 房间只在内存且无上限：定时清掉 2 小时没动静的房间（unref 不阻止进程退出）
  const sweeper = setInterval(() => {
    const removed = rooms.sweep();
    if (removed > 0) console.log('[rooms] 清理闲置房间', removed, '个，剩余', rooms.size);
  }, 10 * 60 * 1000);
  sweeper.unref?.();

  rooms.onEvents((roomId, events) => {
    const set = roomClients.get(roomId);
    if (!set) return;
    const payload = JSON.stringify({ type: 'events', roomId, events });
    for (const client of set) {
      if (client.readyState === 1) client.send(payload);
    }
  });

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  \x1b[36m🎪 AI 游乐场 已启动\x1b[0m');
    console.log(`  人类入口   \x1b[4mhttp://${HOST}:${PORT}\x1b[0m`);
    console.log(`  API        http://${HOST}:${PORT}/api/games`);
    console.log(`  MCP 接入   npx ai-playground mcp   (需服务已启动)`);
    console.log('');
  });

  return {
    port: PORT,
    close: () => {
      clearInterval(sweeper);
      wss.close();
      server.close();
    },
  };
}






