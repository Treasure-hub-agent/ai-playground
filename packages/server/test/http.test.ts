/**
 * REST 路由集成测试：在随机空闲端口起一个真服务，验证第 12 轮「席位令牌」的 HTTP 契约
 * （错误码、旁观降级、summary 不泄令牌、discovery 文案）。
 *
 * 为什么不用 8787：那是主人正在用的实例，绝不能杀 / 重启。
 * 注意 server.ts 在模块顶层读 PORT，所以必须先定好端口再 import。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createProbe } from 'node:net';

/** 让内核分配一个空闲端口再立刻释放：避开 8787，也避免测试并发时抢固定端口。 */
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

const PORT = await freePort();
process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';
process.env.PLAYGROUND_URL = `http://127.0.0.1:${PORT}`;
const { startServer } = await import('../src/server.ts');
const server = startServer();
after(() => server.close());

const base = `http://127.0.0.1:${PORT}`;

interface ApiResponse {
  status: number;
  // 测试里对响应体做宽松断言，用 any 省得给每个路由写一套类型
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

// ───────────────────────────── 1. 建桌：令牌随响应下发 ─────────────────────────────

test('POST /api/rooms：humanUrlPath 带 token，seatTokens["0"] 是 32 位十六进制，且不泄露 1 号位', async () => {
  const created = await post('/api/rooms', { gameId: 'grab' });
  assert.equal(created.status, 200);

  const token0 = created.body.seatTokens?.['0'];
  assert.equal(typeof token0, 'string');
  assert.match(token0, /^[0-9a-f]{32}$/, '0 号位令牌应是 16 字节随机数的 32 位十六进制');
  assert.equal(created.body.agentSeat, 1);
  assert.equal(
    created.body.humanUrlPath,
    `/?room=${created.body.roomId}&seat=0&token=${token0}`,
    '人类入口必须带着 0 号位令牌一起下发',
  );
  assert.equal('1' in created.body.seatTokens, false, '1 号位令牌只在入座后发');
  assert.ok(Array.isArray(created.body.rules) || typeof created.body.rules === 'string');
});

// ───────────────────────────── 2. 入座：409 / 幂等 / 令牌隔离 ─────────────────────────────

test('POST /join：已预留的 0 号位无令牌 409 seat_taken；带原令牌幂等；1 号位令牌不能混用', async () => {
  const created = await post('/api/rooms', { gameId: 'grab' });
  const roomId = created.body.roomId as string;
  const token0 = created.body.seatTokens['0'] as string;

  // 0 号位从建桌起就预留：别人没令牌抢不走
  const stolen = await post(`/api/rooms/${roomId}/join`, { seat: 0 });
  assert.equal(stolen.status, 409);
  assert.equal(stolen.body.error, 'seat_taken');

  // 房主带预留令牌入座：成功，令牌不变
  const joined0 = await post(`/api/rooms/${roomId}/join`, { seat: 0, token: token0 });
  assert.equal(joined0.status, 200);
  assert.equal(joined0.body.seat, 0);
  assert.equal(joined0.body.token, token0, '入座不应换掉预留令牌');
  assert.equal(joined0.body.roomId, roomId);

  // 同座位重复 join（带令牌）→ 幂等，令牌不变
  const again0 = await post(`/api/rooms/${roomId}/join`, { seat: 0, token: token0 });
  assert.equal(again0.status, 200);
  assert.equal(again0.body.token, token0);

  // 1 号位：空闲入座发新令牌；之后无令牌 join → 409
  const joined1 = await post(`/api/rooms/${roomId}/join`, { seat: 1 });
  assert.equal(joined1.status, 200);
  assert.match(joined1.body.token, /^[0-9a-f]{32}$/);
  assert.notEqual(joined1.body.token, token0, '两个座位的令牌必须不同');
  const stolen1 = await post(`/api/rooms/${roomId}/join`, { seat: 1 });
  assert.equal(stolen1.status, 409);
  assert.equal(stolen1.body.error, 'seat_taken');
  const again1 = await post(`/api/rooms/${roomId}/join`, { seat: 1, token: joined1.body.token });
  assert.equal(again1.status, 200);
  assert.equal(again1.body.token, joined1.body.token, '同座位重复 join 令牌不变');

  // 0 号位令牌不能用来占/读 1 号位（令牌按座位隔离，见下一组观测用例）
  const crossed = await request(
    `/api/rooms/${roomId}/state?seat=1&token=${encodeURIComponent(token0)}`,
  );
  assert.equal(crossed.body.spectator, true, '跨座位令牌只能看到旁观视图');
});

// ───────────────────────────── 3. 观测降级与行动 403 ─────────────────────────────

test('GET /state：无令牌 / 错令牌 ⭢ spectator=true；正确令牌 ⭢ 正式视角且能出招', async () => {
  const { roomId, token1 } = await openTable();

  // 无令牌：200 + 旁观，不泄露可行动作
  const anon = await request(`/api/rooms/${roomId}/state?seat=0`);
  assert.equal(anon.status, 200, '旁观是正当场景，不该报错');
  assert.equal(anon.body.spectator, true);
  assert.equal(anon.body.seat, null);
  assert.deepEqual(anon.body.legalActions, []);
  assert.equal(anon.body.isYourTurn, false);
  assert.equal(anon.body.youSubmitted, false);
  assert.deepEqual(anon.body.waitingFor, []);

  // 错令牌：同样降级
  const wrong = await request(`/api/rooms/${roomId}/state?seat=1&token=${'f'.repeat(32)}`);
  assert.equal(wrong.status, 200);
  assert.equal(wrong.body.spectator, true);
  assert.equal(wrong.body.seat, null);

  // 正确令牌：正式视角
  const mine = await request(`/api/rooms/${roomId}/state?seat=1&token=${encodeURIComponent(token1)}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.spectator, false);
  assert.equal(mine.body.seat, 1);
  assert.ok(mine.body.legalActions.length > 0, '带对令牌要能看到自己的 legalActions');

  // 令牌放请求头也认（契约里写了 X-Seat-Token，以前只写在文档里没实现）
  const viaHeader = await request(`/api/rooms/${roomId}/state?seat=1`, {
    headers: { 'x-seat-token': token1 },
  });
  assert.equal(viaHeader.status, 200);
  assert.equal(viaHeader.body.spectator, false, 'X-Seat-Token 头必须被接受');
  assert.equal(viaHeader.body.seat, 1);

  // 头里放错令牌 → 仍旧降级旁观
  const badHeader = await request(`/api/rooms/${roomId}/state?seat=1`, {
    headers: { 'x-seat-token': 'f'.repeat(32) },
  });
  assert.equal(badHeader.body.spectator, true);

  // 无令牌出招 → 403 seat_token_required
  const noToken = await post(`/api/rooms/${roomId}/action`, {
    seat: 1,
    action: { action: 'grab', cell: [0, 0] },
  });
  assert.equal(noToken.status, 403);
  assert.equal(noToken.body.error, 'seat_token_required');
  assert.equal(noToken.body.ok, false);

  // 错令牌出招 → 也是 403
  const wrongToken = await post(`/api/rooms/${roomId}/action`, {
    seat: 1,
    action: { action: 'grab', cell: [0, 0] },
    token: 'f'.repeat(32),
  });
  assert.equal(wrongToken.status, 403);
  assert.equal(wrongToken.body.error, 'seat_token_required');

  // 无令牌发言 → 403（不能冒名）
  const say = await post(`/api/rooms/${roomId}/say`, { seat: 1, text: '大家好' });
  assert.equal(say.status, 403);
  assert.equal(say.body.error, 'seat_token_required');

  // 带对令牌才放行：挂起不结算（对手还没交）
  const ok = await post(`/api/rooms/${roomId}/action`, {
    seat: 1,
    action: { action: 'grab', cell: [0, 0] },
    token: token1,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.resolved, false);

  const said = await post(`/api/rooms/${roomId}/say`, { seat: 1, text: '这格归我', token: token1 });
  assert.equal(said.status, 200);
  assert.equal(said.body.message.seat, 1);
});

// ───────────────────────────── 4. summary / log 公开且不泄令牌 ─────────────────────────────

test('GET /api/rooms/:id 不含 humanUrlPath；GET /log 保持公开', async () => {
  const { roomId, token0, token1 } = await openTable();

  const summary = await request(`/api/rooms/${roomId}`);
  assert.equal(summary.status, 200);
  assert.equal('humanUrlPath' in summary.body, false, 'summary 绝不能带人类入口（里面有令牌）');
  assert.equal('seatTokens' in summary.body, false, 'summary 不能回传令牌副本');
  const serialized = JSON.stringify(summary.body);
  assert.equal(serialized.includes(token0), false, 'summary 里不能出现 0 号位令牌');
  assert.equal(serialized.includes(token1), false, 'summary 里不能出现 1 号位令牌');
  assert.equal(summary.body.roomId, roomId);

  // 日志公开：不带令牌也能读
  const log = await request(`/api/rooms/${roomId}/log?seat=1`);
  assert.equal(log.status, 200);
  assert.equal(log.body.roomId, roomId);
  assert.ok(Array.isArray(log.body.events));
  assert.equal(log.body.seed, null, '对局进行中不公开 seed');
});

// ───────────────────────────── 5. 房间不存在 / 发现层文案 ─────────────────────────────

test('房间不存在仍 404；/llms.txt 与 /.well-known 说明「入座拿令牌、之后要带令牌」', async () => {
  const missing = await request('/api/rooms/nope/state?seat=0');
  assert.equal(missing.status, 404);

  const llms = await fetch(`${base}/llms.txt`);
  assert.equal(llms.status, 200);
  const llmsText = await llms.text();
  assert.ok(llmsText.includes('席位与令牌'), 'llms.txt 应有席位令牌说明段');
  assert.ok(llmsText.includes('seat_token_required'), 'llms.txt 应写清 403 的 code');
  assert.ok(llmsText.includes('seat_taken'), 'llms.txt 应写清 409 的 code');
  assert.ok(llmsText.includes('spectator'), 'llms.txt 应说明无令牌读观测会降级为旁观');

  const descriptor = await request('/.well-known/ai-playground.json');
  assert.equal(descriptor.status, 200);
  assert.ok(descriptor.body.seatAuth, '机器可读描述里应有 seatAuth 段');
  assert.ok(descriptor.body.seatAuth.errors['403 seat_token_required']);
  assert.ok(descriptor.body.seatAuth.errors['409 seat_taken']);
  // 端点表的 key 明写 token，说明文字解释不带令牌会降级为旁观
  const stateDoc = descriptor.body.rest.endpoints['GET /api/rooms/:id/state?seat=1&token=<t>'];
  assert.equal(typeof stateDoc, 'string');
  assert.ok(stateDoc.includes('旁观'), 'state 端点说明要写清不带令牌 = 旁观');
  assert.ok(
    String(descriptor.body.rest.endpoints['POST /api/rooms/:id/join']).includes('令牌'),
    'join 端点说明要写清会发令牌',
  );
});
