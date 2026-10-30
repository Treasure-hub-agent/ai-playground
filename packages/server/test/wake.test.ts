/**
 * 唤醒桥（第 14 轮）平台侧集成测试。
 *
 * 覆盖设计稿 §6.1 要求的三项：
 *   1. 绑定落盘与回读（含旧 rooms.json 没有 wake 字段的兼容）；
 *   2. 同回合去重（3 秒窗口 + 同回合最多 2 次）；
 *   3. 投递失败（WAKE_URL 返回 500 / 不可达）时对局照常结算。
 * 另外补两条边界：未配置 WAKE_URL 时完全静默；绑定参数非法时 400。
 *
 * 为什么自己起一个假接收器：设计稿要求「用 PORT=8899 另起实例、WAKE_URL 指向本地假接收器」。
 * 这个文件同理——随机空闲端口起真服务，wake 指向本文件里的 http server，
 * 绝不碰 8787 上那间正在跑的真实游戏厅。
 *
 * 注意：server.ts 在模块顶层读 PORT，所以必须先定好端口再动态 import。
 */

import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type IncomingHttpHeaders } from 'node:http';
import { createServer as createProbe } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { RoomManager } from '../src/rooms.ts';
import { toSnapshot, PERSIST_VERSION } from '../src/persist.ts';
import { awaitPendingWakes, resetWakeState, wakeLogEntries } from '../src/wake.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 让内核分配一个空闲端口再立刻释放：避开 8787，也避免并发测试抢固定端口。 */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createProbe();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (typeof address !== 'object' || address === null) {
        probe.close();
        reject(new Error('拿不到空闲端口'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

// ─────────────────────────── 假接收器（模拟 DSH 插件的 /wake） ───────────────────────────

interface ReceivedWake {
  headers: IncomingHttpHeaders;
  body: any;
  at: number;
}

const received: ReceivedWake[] = [];
/** ok = 200；fail = 500（用来验证「失败重试 1 次 + 不影响对局」）。 */
let receiverMode: 'ok' | 'fail' = 'ok';

const receiver = createHttpServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
    received.push({ headers: req.headers, body, at: Date.now() });
    if (receiverMode === 'fail') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"boom"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});

await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
const receiverPort = (receiver.address() as AddressInfo).port;
const WAKE_URL = `http://127.0.0.1:${receiverPort}/whale-arcade/wake`;
const WAKE_SECRET = 'test-wake-secret';

// ─────────────────────────── 被测服务（随机端口，真 HTTP） ───────────────────────────

const PORT = await freePort();
process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';
process.env.PLAYGROUND_URL = `http://127.0.0.1:${PORT}`;
process.env.WAKE_URL = WAKE_URL;
process.env.WAKE_SECRET = WAKE_SECRET;

const { startServer } = await import('../src/server.ts');
const server = startServer();
const base = `http://127.0.0.1:${PORT}`;

after(() => {
  server.close();
  receiver.close();
});

beforeEach(async () => {
  receiverMode = 'ok';
  // 先把上一个用例在飞的投递等完，再清日志；反过来会把旧日志清掉又写回来。
  await awaitPendingWakes();
  resetWakeState();
});

interface ApiResponse {
  status: number;
  body: any;
}

async function request(path: string, init?: RequestInit): Promise<ApiResponse> {
  const response = await fetch(base + path, init);
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function post(path: string, body: unknown): Promise<ApiResponse> {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 建桌 + 双方入座，返回后续用例要用的凭据。 */
async function openTable(gameId = 'grab') {
  const created = await post('/api/rooms', { gameId });
  assert.equal(created.status, 200, '建桌应成功');
  const roomId = created.body.roomId as string;
  const token0 = created.body.seatTokens['0'] as string;
  const joined0 = await post(`/api/rooms/${roomId}/join`, { seat: 0, token: token0 });
  assert.equal(joined0.status, 200, '0 号位带预留令牌应能入座');
  const joined1 = await post(`/api/rooms/${roomId}/join`, { seat: 1 });
  assert.equal(joined1.status, 200, '1 号位应能入座');
  return { roomId, token0, token1: joined1.body.token as string };
}

/** 轮询到条件成立，最多等 ms 毫秒。 */
async function waitUntil(predicate: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时（${ms}ms）`);
    await sleep(20);
  }
}

async function legalActionsFor(roomId: string, seat: 0 | 1, token: string): Promise<any[]> {
  const state = await request(
    `/api/rooms/${roomId}/state?seat=${seat}&token=${encodeURIComponent(token)}`,
  );
  assert.equal(state.status, 200);
  return state.body.legalActions as any[];
}

// ─────────────────────────── 1. 绑定落盘与回读 ───────────────────────────

test('绑定落盘：WakeBinding 写进 rooms.json，重启后仍在；旧文件没有 wake 字段也照常恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-wake-'));
  const file = join(dir, 'rooms.json');
  try {
    const manager = new RoomManager({ persist: { file } });
    const room = manager.create('grab');
    const binding = manager.bindWake(room.id, 'session-unit-test');
    assert.equal(binding.sessionId, 'session-unit-test');
    assert.equal(typeof binding.boundAt, 'number');
    assert.equal(manager.flushSync(), true, '绑定后应能同步落盘');

    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.rooms[0].wake.sessionId, 'session-unit-test', 'wake.sessionId 必须落盘');
    assert.equal(raw.rooms[0].wake.boundAt, binding.boundAt, 'boundAt 必须落盘');
    assert.equal('lastWakeAt' in raw.rooms[0], false, '运行态诊断字段不该落盘');

    const restarted = new RoomManager({ persist: { file } });
    assert.equal(restarted.get(room.id)?.wake?.sessionId, 'session-unit-test', '重启后绑定必须回读得到');
    assert.equal(restarted.get(room.id)?.wake?.boundAt, binding.boundAt);
    assert.equal(restarted.get(room.id)?.lastWakeAt, undefined, '诊断字段重启后归零');

    // 旧文件（第 14 轮之前写的）没有 wake 字段：必须当「没绑定」恢复，而不是丢房间 / 崩。
    const legacy = toSnapshot(restarted.get(room.id)!);
    delete (legacy as { wake?: unknown }).wake;
    writeFileSync(
      join(dir, 'legacy.json'),
      JSON.stringify({ version: PERSIST_VERSION, savedAt: Date.now(), rooms: [legacy] }),
      'utf8',
    );
    const fromLegacy = new RoomManager({ persist: { file: join(dir, 'legacy.json') } });
    assert.equal(fromLegacy.size, 1, '旧文件里的房间应照常恢复');
    assert.equal(fromLegacy.get(room.id)?.wake, null, '缺 wake 字段 = 没绑定');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────── 2. 绑定接口与回读 ───────────────────────────

test('POST /bind：写入 wake 并可从 GET summary 回读；create/join 的 sessionId 等价于随后绑定', async () => {
  const { roomId } = await openTable('grab');

  const bound = await post(`/api/rooms/${roomId}/bind`, { sessionId: 'session-bind-01' });
  assert.equal(bound.status, 200);
  assert.equal(bound.body.ok, true);
  assert.equal(bound.body.sessionId, 'session-bind-01');
  assert.equal(typeof bound.body.boundAt, 'number');

  const summary = await request(`/api/rooms/${roomId}`);
  assert.equal(summary.status, 200);
  assert.equal(summary.body.wake.boundSessionId, 'session-bind-01', 'summary 应回读绑定');
  assert.equal(summary.body.wake.lastWakeAt, null, '还没叫过');
  assert.equal(summary.body.wake.lastWakeError, null);

  // 幂等：重复绑定只刷新时间，不报错
  const again = await post(`/api/rooms/${roomId}/bind`, { sessionId: 'session-bind-01' });
  assert.equal(again.status, 200);
  assert.ok(again.body.boundAt >= bound.body.boundAt);

  // 参数非法 → 400（不要 500，也不要把空串写进房间）
  for (const bad of [{}, { sessionId: '' }, { sessionId: 'has space' }, { sessionId: 'x'.repeat(129) }]) {
    const res = await post(`/api/rooms/${roomId}/bind`, bad);
    assert.equal(res.status, 400, `非法 sessionId 应 400：${JSON.stringify(bad)}`);
  }
  // 房间不存在 → 404
  const missing = await post('/api/rooms/nope/bind', { sessionId: 'session-x' });
  assert.equal(missing.status, 404);

  // create_room 带 sessionId：建桌即绑定
  const created = await post('/api/rooms', { gameId: 'grab', sessionId: 'session-create-01' });
  assert.equal(created.status, 200);
  assert.equal(created.body.wake.boundSessionId, 'session-create-01');
  const createdSummary = await request(`/api/rooms/${created.body.roomId}`);
  assert.equal(createdSummary.body.wake.boundSessionId, 'session-create-01');

  // join_room 带 sessionId：入座即绑定
  const joined = await post(`/api/rooms/${created.body.roomId}/join`, {
    seat: 0,
    token: created.body.seatTokens['0'],
    sessionId: 'session-create-01',
  });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.wake.boundSessionId, 'session-create-01', 'join 响应里应能看到绑定');

  // 非法 sessionId 在入座前就被拦下：座位不该被占
  const badJoin = await post(`/api/rooms/${created.body.roomId}/join`, {
    seat: 1,
    sessionId: 'bad session id',
  });
  assert.equal(badJoin.status, 400);
  const afterBad = await request(`/api/rooms/${created.body.roomId}`);
  assert.equal(afterBad.body.occupied[1], false, '参数错了不能先把座位占掉');
});

// ─────────────────────────── 3. 同回合去重（3 秒窗口 + 最多 2 次） ───────────────────────────

test('去重：同一房间同一回合 3 秒内只叫一次、整回合最多 2 次（simultaneous：人类提交后叫醒 Agent）', async () => {
  const { roomId, token0 } = await openTable('grab');
  await post(`/api/rooms/${roomId}/bind`, { sessionId: 'session-dedupe-01' });

  const baseline = received.length;
  // grab 是同时暗选：人类提交后 pending[0] 有值、pending[1] 为空 → 该叫 Agent 了。
  const [humanAction] = await legalActionsFor(roomId, 0, token0);
  const submitted = await post(`/api/rooms/${roomId}/action`, {
    seat: 0,
    action: humanAction,
    token: token0,
  });
  assert.equal(submitted.status, 200, `人类提交应成功：${JSON.stringify(submitted.body)}`);
  assert.equal(submitted.body.resolved, false, '同时暗选：先提交的一方不结算');

  await waitUntil(() => received.length > baseline);
  await awaitPendingWakes();
  assert.equal(received.length, baseline + 1, '该回合应只叫一次');

  // 投递体的线上契约（和插件侧对齐的字段，一个都不能少 / 不能改类型）
  const wake = received[baseline];
  assert.equal(wake.headers['x-wake-secret'], WAKE_SECRET, '必须带 x-wake-secret 头');
  assert.equal(wake.body.roomId, roomId);
  assert.equal(wake.body.sessionId, 'session-dedupe-01');
  assert.equal(wake.body.gameId, 'grab');
  assert.equal(typeof wake.body.round, 'number');
  assert.ok(wake.body.textView.length > 0, '应带 Agent 视角的只读摘要');
  assert.equal(typeof wake.body.createdAt, 'number');
  assert.equal(typeof wake.body.nonce, 'string');
  assert.equal('token' in wake.body, false, '唤醒投递里绝不能带令牌');

  // 3 秒窗口内再次触发（重新绑定也会触发一次唤醒判定）：必须被去重挡住
  await post(`/api/rooms/${roomId}/bind`, { sessionId: 'session-dedupe-01' });
  await awaitPendingWakes();
  await sleep(150);
  assert.equal(received.length, baseline + 1, '3 秒窗口内不能重复叫');

  // 窗口过后允许第 2 次（设计稿：同一回合最多 2 次，不无限轰炸）
  await sleep(3200);
  await post(`/api/rooms/${roomId}/bind`, { sessionId: 'session-dedupe-01' });
  await waitUntil(() => received.length === baseline + 2);
  await awaitPendingWakes();
  assert.equal(received.length, baseline + 2, '窗口过后允许第 2 次');

  // 第 3 次无论如何都不发：同一回合已经叫够次数
  await post(`/api/rooms/${roomId}/bind`, { sessionId: 'session-dedupe-01' });
  await awaitPendingWakes();
  await sleep(150);
  assert.equal(received.length, baseline + 2, '同一回合最多 2 次');
});

// ─────────────────────────── 4. 投递失败不影响对局 ───────────────────────────

test('投递失败（接收器 500）：重试 1 次后放弃，只记诊断与日志，对局照常结算', async () => {
  const { roomId, token0, token1 } = await openTable('connect4');
  await post(`/api/rooms/${roomId}/bind`, { sessionId: 'session-fail-01' });

  receiverMode = 'fail';
  const baseline = received.length;

  const [drop] = await legalActionsFor(roomId, 0, token0);
  const humanMove = await post(`/api/rooms/${roomId}/action`, {
    seat: 0,
    action: humanActionGuard(drop),
    token: token0,
  });
  assert.equal(humanMove.status, 200);
  assert.equal(humanMove.body.resolved, true, '轮流制提交即结算');

  // 有人类落子已经成功返还之后，唤醒才异步失败——先把这次投递等完。
  await waitUntil(() => received.length >= baseline + 2);
  await awaitPendingWakes();
  assert.equal(received.length, baseline + 2, '失败应只重试 1 次（共 2 次请求）');

  // 诊断字段：GET /api/rooms/:id 的 wake 只读字段
  const summary = await request(`/api/rooms/${roomId}`);
  assert.equal(summary.body.wake.boundSessionId, 'session-fail-01');
  assert.equal(typeof summary.body.wake.lastWakeAt, 'number', '失败也要记 lastWakeAt（最近一次尝试）');
  assert.match(String(summary.body.wake.lastWakeError), /HTTP 500/, 'lastWakeError 应带失败原因');

  // 内存环形日志：记录 ok=false + attempts=2
  const last = wakeLogEntries().at(-1);
  assert.ok(last, '应有一条唤醒日志');
  assert.equal(last!.ok, false);
  assert.equal(last!.attempts, 2);
  assert.equal(last!.roomId, roomId);
  assert.equal(typeof last!.round, 'number');
  assert.match(String(last!.error), /HTTP 500/);

  // 对局完全没被影响：Agent 仍是本回合行动方，能正常出招并推进局面
  const agentState = await request(
    `/api/rooms/${roomId}/state?seat=1&token=${encodeURIComponent(token1)}`,
  );
  assert.equal(agentState.status, 200);
  assert.equal(agentState.body.status, 'playing');
  assert.equal(agentState.body.isYourTurn, true, '人类落子后仍应轮到 Agent');
  assert.ok(agentState.body.legalActions.length > 0);

  const agentMove = await post(`/api/rooms/${roomId}/action`, {
    seat: 1,
    action: agentState.body.legalActions[0],
    token: token1,
  });
  assert.equal(agentMove.status, 200, '唤醒失败不能影响 Agent 出招');
  assert.equal(agentMove.body.resolved, true);
  // Agent 自己出招后即使仍轮到自己（命中继续 / 黑白棋对手被跳过），也不该反过来叫醒自己。
  await sleep(200);
  assert.equal(received.length, baseline + 2, 'Agent 自己的动作不应触发唤醒');
  const log = await request(`/api/rooms/${roomId}/log?seat=1`);
  assert.ok(log.body.events.length >= 1, '对局应照常推进');
});

// ─────────────────────────── 5. 未配置即关闭 ───────────────────────────

test('未配置 WAKE_URL：功能关闭，一个唤醒请求都不发，且不影响对局', async () => {
  const saved = process.env.WAKE_URL;
  process.env.WAKE_URL = '';
  try {
    const { roomId, token0 } = await openTable('connect4');
    await post(`/api/rooms/${roomId}/bind`, { sessionId: 'session-off-01' });
    const baseline = received.length;

    const [drop] = await legalActionsFor(roomId, 0, token0);
    const moved = await post(`/api/rooms/${roomId}/action`, {
      seat: 0,
      action: humanActionGuard(drop),
      token: token0,
    });
    assert.equal(moved.status, 200, `人类提交应成功：${JSON.stringify(moved.body)}`);
    await awaitPendingWakes();
    await sleep(200);
    assert.equal(received.length, baseline, '没配 WAKE_URL 时不该发任何请求');
    assert.equal(wakeLogEntries().length, 0, '关闭状态下也不该记日志');
  } finally {
    process.env.WAKE_URL = saved;
  }
});

/**
 * 把 legalActions 里的动作原样当提交体用。
 * connect4 的 legalActions 形如 {action:'drop', column:n}，直接放进 action 字段即可；
 * 这里只是把「取第一个合法动作」的意思写清楚，避免在用例里手搓坐标。
 */
function humanActionGuard(action: any): any {
  assert.ok(action, '应该有合法动作');
  return action;
}

// ─────────────────────── 6. 对局结束也唤醒一次（第 15 轮） ───────────────────────

test('对局结束唤醒：reason=ended 且带 resultText，同一房间只叫一次', async () => {
  const { roomId, token0, token1 } = await openTable('rps-duel');
  await post(`/api/rooms/${roomId}/bind`, { sessionId: 'session-end-01' });
  const baseline = received.length;

  // 猜拳共三局，双方各出三次；最后一局结算即终局。
  for (let round = 0; round < 3; round += 1) {
    const human = await post(`/api/rooms/${roomId}/action`, {
      seat: 0,
      token: token0,
      action: { action: 'throw', shape: 'rock' },
    });
    assert.equal(human.status, 200, `人类第 ${round + 1} 局提交应成功`);
    const agent = await post(`/api/rooms/${roomId}/action`, {
      seat: 1,
      token: token1,
      action: { action: 'throw', shape: 'scissors' },
    });
    assert.equal(agent.status, 200, `Agent 第 ${round + 1} 局提交应成功`);
  }

  const state = await request(`/api/rooms/${roomId}/state?seat=1&token=${encodeURIComponent(token1)}`);
  assert.equal(state.status, 200);
  assert.equal(state.body.status, 'ended', '三局打完应结束');

  await awaitPendingWakes();
  await waitUntil(() => received.some((wake) => wake.body.reason === 'ended'), 4000);
  const ended = received.slice(baseline).filter((wake) => wake.body.reason === 'ended');
  assert.equal(ended.length, 1, '同一房间终局只该叫一次');
  assert.equal(ended[0].body.sessionId, 'session-end-01');
  assert.equal(ended[0].body.roomId, roomId);
  assert.ok(String(ended[0].body.resultText ?? '').length > 0, '结束唤醒应带结算文案');

  // 再来一次「终局后的人类动作」不存在（已是 ended），但重复触发也不能再叫第二次。
  await awaitPendingWakes();
  await sleep(200);
  assert.equal(
    received.slice(baseline).filter((wake) => wake.body.reason === 'ended').length,
    1,
    '去重上限 = 1 次',
  );
});
