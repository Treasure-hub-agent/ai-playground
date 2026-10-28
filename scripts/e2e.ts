/**
 * 《AI 游乐场》端到端验证：grab（同时暗选）/ connect4（轮流）/ yacht（轮流 + 多子状态）
 * + rps-duel / battleship / reversi 回归。
 *
 * 第 12 轮（席位鉴权）之后，`?seat=` 只表示「想看哪个视角」，不再代表身份：
 * 建桌拿 0 号位令牌、入座拿各座位令牌，之后每个 /state、/action、/say 请求都按座位带上；
 * 另外每间房开局跑一次鉴权探针（无令牌 → 旁观视图；无令牌行动 → 403 seat_token_required）。
 *
 * 用法：
 *   pnpm e2e                        # 连 http://127.0.0.1:8787，跑 grab + connect4 + yacht
 *   pnpm e2e -- --game=yacht        # 只跑一款（可选 grab / connect4 / yacht / all，可逗号组合）
 *   pnpm e2e -- --game=grab,connect4
 *   pnpm e2e -- --base http://127.0.0.1:8799   # 指定服务地址（或用 BASE_URL / PORT 环境变量）
 *   $env:PORT=8799; pnpm e2e        # 换端口（服务端也用同样的 PORT 起）
 *   $env:E2E_GAMES=2; pnpm e2e      # 少打几局 grab（默认 3 局）
 *
 * 依赖：Node >= 22 自带的 fetch / 全局 WebSocket，无需任何 npm 包。
 * 退出码：全部断言通过 0；任何失败 1。
 */

// ────────────────────────────── 类型 ──────────────────────────────

type Cell = number | 'empty' | 'bomb' | 'taken';
type Coord = [number, number];

interface Action {
  action: 'grab';
  cell: Coord;
}

interface Scores {
  [seat: string]: number;
}

interface RevealEvent {
  type: 'reveal';
  round: number;
  picks: Record<string, Coord>;
  delta: Scores;
  applied: Record<string, string>;
  collision: boolean;
  scores: Scores;
  grid: Cell[][];
}

interface EndEvent {
  type: 'end';
  result: { winner: number | null; scores: Scores; text: string };
}

interface ChatMessage {
  id: number;
  seat: number;
  text: string;
  at: number;
}

interface ChatEvent {
  type: 'chat';
  message: ChatMessage;
}

type GameEvent = RevealEvent | EndEvent | ChatEvent;

interface Observation {
  gameId: string;
  /** 被判定持有的座位；null = 旁观者（没带该座位的有效令牌）。 */
  seat: number | null;
  /** 第 12 轮：true = 旁观视图（legalActions 恒空、私有信息被遮蔽）。 */
  spectator?: boolean;
  round: number;
  roundsTotal: number;
  scores: Scores;
  legalActions: Action[];
  textView: string;
  status: 'waiting' | 'playing' | 'ended';
  grid: Cell[][];
  history: { round: number; picks: Record<string, Coord>; delta: Scores; collision: boolean }[];
  yourScore: number;
  opponentScore: number;
  roomId: string;
  youSubmitted: boolean;
  waitingFor: number[];
  result: { winner: number | null; scores: Scores; text: string } | null;
}

type RoundMode = 'collision' | 'avoid' | 'random';

interface GameConfig {
  label: string;
  /** 第一回合强制撞车（同时覆盖重复提交探测） */
  forceCollisionFirst?: boolean;
  /** 每回合尽量选不同格，验证双方各自吃到 delta 的路径 */
  avoidCollision?: boolean;
  /** 开局跑非法动作 / 聊天 / WS 协议探测 */
  probes?: boolean;
  /** 挂 WebSocket，验证 reveal / chat / end 推送 */
  ws?: boolean;
}

// ────────────────────────────── 基础设施 ──────────────────────────────

const PORT = Number(process.env.PORT ?? 8787);

/** 读取 --name=value / --name value 形式的命令行参数（与 replay.ts 一致）。 */
function cliArgValue(argv: string[], names: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    for (const name of names) {
      if (arg === `--${name}`) {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) return next;
      }
      if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
    }
  }
  return undefined;
}

const BASE = (
  cliArgValue(process.argv.slice(2), ['base', 'base-url', 'url']) ??
  process.env.BASE_URL ??
  `http://127.0.0.1:${PORT}`
).replace(/\/+$/, '');
const WS_BASE = BASE.replace(/^http/, 'ws');
const GAMES_TO_PLAY = Math.max(1, Number(process.env.E2E_GAMES ?? 3));

/** 可回归的游戏（新增游戏时在这里加一项 + 写一条 playXxx）。 */
const ALL_GAMES = ['grab', 'connect4', 'yacht', 'rps-duel', 'battleship', 'reversi'] as const;
type GameId = (typeof ALL_GAMES)[number];

/** GET /api/games 的元数据缓存（用来判断 wip 需要 allowWip 建桌）。 */
const GAME_META = new Map<string, any>();

let assertionCount = 0;

class CheckFailure extends Error {}

function check(cond: unknown, message: string, detail?: unknown): void {
  assertionCount++;
  if (cond) return;
  const suffix = detail === undefined ? '' : `\n  详情: ${safeJson(detail)}`;
  throw new CheckFailure(`断言失败: ${message}${suffix}`);
}

function must<T>(value: T | null | undefined, message: string): T {
  check(value !== null && value !== undefined, message);
  return value as T;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function num(record: Scores | undefined, seat: number): number {
  const value = record?.[String(seat)];
  return typeof value === 'number' ? value : Number.NaN;
}

function sameCell(a: Coord | undefined, b: Coord | undefined): boolean {
  return Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
}

function cellKeys(actions: Action[]): string {
  return actions
    .map((a) => `${a.cell?.[0]},${a.cell?.[1]}`)
    .sort()
    .join('|');
}

// ─────────────────────────── 席位令牌（第 12 轮鉴权） ───────────────────────────

/**
 * 每间房、每个座位已拿到的席位令牌：roomId → seat → token。
 *
 * 为什么 e2e 也要自己维护：鉴权之后 `?seat=` 只表示「想看哪个视角」，不再代表身份；
 * 读 /state、提交 /action、发 /say 都必须带**该座位自己的**令牌。
 * e2e 相当于同时扮演两个浏览器，所以按座位各存一份，请求时按座位附加。
 */
const SEAT_TOKENS = new Map<string, { 0?: string; 1?: string }>();

/** 令牌格式：32 位十六进制（16 字节随机数），见 docs/design-auth-round12.md §3.1。 */
const SEAT_TOKEN_RE = /^[0-9a-f]{32}$/i;

function isSeatToken(value: unknown): value is string {
  return typeof value === 'string' && SEAT_TOKEN_RE.test(value);
}

/** 从建桌响应（seatTokens）或入座响应（seat + token）里收下令牌。 */
function rememberSeatTokens(roomId: string, body: any): void {
  if (!roomId || !body || typeof body !== 'object') return;
  const entry = SEAT_TOKENS.get(roomId) ?? {};
  const fromCreate = body.seatTokens;
  if (fromCreate && typeof fromCreate === 'object') {
    for (const [key, value] of Object.entries(fromCreate)) {
      const seat = Number(key);
      if ((seat === 0 || seat === 1) && isSeatToken(value)) entry[seat as 0 | 1] = value;
    }
  }
  const seat = body.seat;
  if ((seat === 0 || seat === 1) && isSeatToken(body.token)) {
    entry[seat as 0 | 1] = body.token;
  }
  SEAT_TOKENS.set(roomId, entry);
}

function tokenOf(roomId: string, seat: number): string | undefined {
  return SEAT_TOKENS.get(roomId)?.[seat as 0 | 1];
}

/** 取座位令牌；取不到说明脚本流程错了（还没 join 就读写），直接断言失败。 */
function requireSeatToken(roomId: string, seat: number, what: string): string {
  const token = tokenOf(roomId, seat);
  check(isSeatToken(token), `${what}: 座位 ${seat} 应已通过入座拿到席位令牌`);
  // check 失败会抛；这里断言一下让 TS 收窄（断言函数的控制流收窄到不了调用点之后）。
  return token as string;
}

/** GET /state 的查询串（带令牌）。 */
function stateQuery(roomId: string, seat: number): string {
  return `seat=${seat}&token=${encodeURIComponent(requireSeatToken(roomId, seat, '读取 /state'))}`;
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      const value = probe();
      if (value !== undefined) {
        resolve(value);
        return;
      }
      if (Date.now() > deadline) {
        reject(new CheckFailure(`超时: 等待 ${what} 超过 ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

// ────────────────────────────── HTTP ──────────────────────────────

interface ApiResponse {
  status: number;
  body: any;
}

async function api(
  path: string,
  init?: { method?: 'GET' | 'POST'; body?: unknown },
): Promise<ApiResponse> {
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

/** 带令牌读观测：正常的座位视角（不是旁观视图）。 */
async function getObservation(roomId: string, seat: number): Promise<any> {
  const res = await api(`/api/rooms/${roomId}/state?${stateQuery(roomId, seat)}`);
  check(res.status === 200, `GET /state?seat=${seat} 应返回 200，实际 ${res.status}`, res.body);
  check(res.body?.spectator !== true, `座位 ${seat} 带令牌的观测不应是旁观视图`, res.body?.spectator);
  return res.body;
}

/** 显式令牌 / 无令牌读观测：鉴权探针专用（不是正式对局读数）。 */
async function readObservation(roomId: string, seat: number, token?: string): Promise<any> {
  const query = token ? `seat=${seat}&token=${encodeURIComponent(token)}` : `seat=${seat}`;
  const res = await api(`/api/rooms/${roomId}/state?${query}`);
  check(
    res.status === 200,
    `GET /state（${token ? '带令牌' : '无令牌'}）应返回 200（旁观降级而不是报错），实际 ${res.status}`,
    res.body,
  );
  return res.body;
}

function getState(roomId: string, seat: number): Promise<Observation> {
  return getObservation(roomId, seat) as Promise<Observation>;
}

function submitAction(roomId: string, seat: number, cell: Coord): Promise<ApiResponse> {
  return api(`/api/rooms/${roomId}/action`, {
    method: 'POST',
    body: {
      seat,
      token: requireSeatToken(roomId, seat, '提交动作'),
      action: { action: 'grab', cell },
    },
  });
}

async function submit(roomId: string, seat: number, cell: Coord): Promise<ApiResponse> {
  const res = await submitAction(roomId, seat, cell);
  return res;
}

/** 通用动作提交（connect4 / yacht 用），同样带该座位令牌。 */
function submitRaw(roomId: string, seat: number, action: Record<string, unknown>): Promise<ApiResponse> {
  return api(`/api/rooms/${roomId}/action`, {
    method: 'POST',
    body: { seat, token: requireSeatToken(roomId, seat, '提交动作'), action },
  });
}

/**
 * 建桌：先读 /api/games 的 status。
 * - playable：正常建桌；
 * - wip：按 Lead 约定的测试通道带 allowWip:true 重试（/api/games 里仍是 wip 属预期，不是失败）。
 */
async function createRoomForGame(gameId: string): Promise<{ roomId: string; rules: string }> {
  const meta = must(GAME_META.get(gameId), `服务端应注册 ${gameId}（GET /api/games）`);
  check(typeof meta.rules === 'string' && meta.rules.length > 0, `${gameId} 的 rules 不应为空`);
  check(meta.seats === 2, `${gameId} 应为 2 座游戏`);

  const wip = meta.status === 'wip';
  const payload: Record<string, unknown> = { gameId };
  if (wip) payload.allowWip = true;

  const res = await api('/api/rooms', { method: 'POST', body: payload });
  if (res.status !== 200 && !wip) {
    // 防御：元数据说 playable 但服务端拒绝时，再用 allowWip 试一次并保留错误信息
    const retry = await api('/api/rooms', { method: 'POST', body: { gameId, allowWip: true } });
    check(retry.status === 200, `创建 ${gameId} 房间应返回 200`, retry.body);
    return finishCreate(gameId, retry, false);
  }
  check(res.status === 200, `创建 ${gameId} 房间应返回 200`, res.body);
  return finishCreate(gameId, res, wip);
}

function finishCreate(
  gameId: string,
  res: ApiResponse,
  wip: boolean,
): { roomId: string; rules: string } {
  const roomId = String(res.body?.roomId ?? '');
  check(roomId.length > 0, `创建 ${gameId} 房间应返回 roomId`, res.body);
  check(res.body?.gameId === gameId, `房间 gameId 应为 ${gameId}`, res.body?.gameId);
  check(res.body?.agentSeat === 1, 'agentSeat 应为 1', res.body?.agentSeat);

  // ── 第 12 轮：建桌必须预发 0 号位令牌，并把它拼进 humanUrlPath ──
  // 人类打开的链接就是「入场券」：带令牌 = 浏览器零配置入座；不带 = 一进房就是旁观者。
  const seatTokens = res.body?.seatTokens ?? {};
  const seat0Token = seatTokens['0'];
  check(
    isSeatToken(seat0Token),
    '建桌响应应带 seatTokens["0"]（32 位十六进制的人类席位令牌）',
    seatTokens,
  );
  const humanUrlPath = String(res.body?.humanUrlPath ?? '');
  const queryStart = humanUrlPath.indexOf('?');
  const humanQuery = new URLSearchParams(queryStart >= 0 ? humanUrlPath.slice(queryStart + 1) : '');
  check(
    humanQuery.get('room') === roomId,
    'humanUrlPath 应指向本房间（?room=<roomId>）',
    humanUrlPath,
  );
  check(humanQuery.get('seat') === '0', 'humanUrlPath 应指向人类座位（seat=0）', humanUrlPath);
  check(
    humanQuery.get('token') === seat0Token,
    'humanUrlPath 应带上人类席位令牌（否则人类打开链接只能旁观）',
    humanUrlPath,
  );
  check(
    seatTokens['1'] === undefined,
    '建桌时不应预发 1 号位令牌（Agent 必须自己入座领取）',
    seatTokens,
  );
  rememberSeatTokens(roomId, res.body);
  check(typeof res.body?.rules === 'string' && res.body.rules.length > 0, '建桌响应应带 rules 全文');
  if (wip) {
    console.log(`  ⚠️ ${gameId} 当前 status=wip，已用 allowWip:true 建桌（测试用途）`);
  }
  return { roomId, rules: res.body.rules };
}

/**
 * 席位鉴权探针（第 12 轮验收点），每间房开局跑一次。
 *
 * 全部发生在正式开打之前，不会污染 pending / 回合数：
 * - 无令牌、或拿错座位的令牌 → GET /state 降级为旁观视图（不是 401）；
 * - 无令牌 POST /action、/say → 403 seat_token_required。
 */
async function probeSeatAuth(roomId: string): Promise<void> {
  const anonymous = await readObservation(roomId, 1);
  check(
    anonymous.spectator === true,
    '无令牌 GET /state 应降级为旁观视图（spectator=true）而不是报错',
    anonymous,
  );
  check(anonymous.seat === null, '旁观视图的 seat 应为 null', anonymous.seat);
  check(
    Array.isArray(anonymous.legalActions) && anonymous.legalActions.length === 0,
    '旁观视图 legalActions 必须为空',
    anonymous.legalActions,
  );
  check(
    anonymous.isYourTurn === false || anonymous.isYourTurn === undefined,
    '旁观视图不可能是自己的回合',
    anonymous.isYourTurn,
  );

  // 令牌隔离：0 号位令牌读 1 号位，也只能拿到旁观视图
  const crossSeat = await readObservation(roomId, 1, requireSeatToken(roomId, 0, '令牌隔离探针'));
  check(
    crossSeat.spectator === true && crossSeat.seat === null,
    '0 号位令牌不能读 1 号位视角（令牌按座位隔离）',
    crossSeat,
  );

  // 占座：座位已被占用 / 0 号位令牌已预发时，不带令牌的 join 必须 409 seat_taken
  const takeSeat = await api(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    body: { seat: 0 },
  });
  check(takeSeat.status === 409, '已入座座位无令牌 join 应返回 409', takeSeat.body);
  check(takeSeat.body?.error === 'seat_taken', '无令牌占座 error 应为 seat_taken', takeSeat.body);

  const anonymousAction = await api(`/api/rooms/${roomId}/action`, {
    method: 'POST',
    body: { seat: 1, action: { action: 'noop' } },
  });
  check(anonymousAction.status === 403, '无令牌提交动作应返回 403', anonymousAction.body);
  check(
    anonymousAction.body?.error === 'seat_token_required',
    '无令牌提交动作 error 应为 seat_token_required',
    anonymousAction.body,
  );

  const anonymousSay = await api(`/api/rooms/${roomId}/say`, {
    method: 'POST',
    body: { seat: 1, text: '旁观者不能说话' },
  });
  check(anonymousSay.status === 403, '无令牌 say 应返回 403', anonymousSay.body);
  check(
    anonymousSay.body?.error === 'seat_token_required',
    '无令牌 say error 应为 seat_token_required',
    anonymousSay.body,
  );
}

/** 双方入座 + 幂等复查 + 席位鉴权探针。 */
async function joinBoth(roomId: string): Promise<void> {
  // 0 号位令牌在建桌时就预发了（防止别人一个无令牌 join 抢走房主的人类位），
  // 所以 seat0 入座必须带上建桌响应里的那把令牌。
  const join0 = await api(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    body: { seat: 0, token: requireSeatToken(roomId, 0, 'seat0 入座') },
  });
  check(join0.status === 200 && join0.body?.ok === true, 'seat0 入座应成功', join0.body);
  check(join0.body?.status === 'waiting', '只有一人入座时 status 应为 waiting', join0.body?.status);
  check(join0.body?.occupied?.[0] === true, 'seat0 应已入座', join0.body?.occupied);
  check(isSeatToken(join0.body?.token), '入座响应应带 0 号位令牌', join0.body?.token);
  rememberSeatTokens(roomId, join0.body);

  const join1 = await api(`/api/rooms/${roomId}/join`, { method: 'POST', body: { seat: 1 } });
  check(join1.status === 200 && join1.body?.ok === true, 'seat1 入座应成功', join1.body);
  check(join1.body?.status === 'playing', '双方入座后 status 应为 playing', join1.body?.status);
  check(
    join1.body?.occupied?.[0] === true && join1.body?.occupied?.[1] === true,
    '双方均应标记为已入座',
    join1.body?.occupied,
  );
  check(isSeatToken(join1.body?.token), '入座响应应带 1 号位令牌', join1.body?.token);
  rememberSeatTokens(roomId, join1.body);
  check(
    tokenOf(roomId, 0) !== tokenOf(roomId, 1),
    '0/1 号位令牌必须不同（否则令牌隔离无从谈起）',
  );

  // 幂等：带原令牌重复入座，应 200 且**不换令牌**
  const rejoin = await api(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    body: { seat: 0, token: requireSeatToken(roomId, 0, '重复入座') },
  });
  check(rejoin.status === 200 && rejoin.body?.status === 'playing', '重复入座应保持 playing（幂等）', rejoin.body);
  check(rejoin.body?.token === tokenOf(roomId, 0), '幂等入座不应更换令牌', rejoin.body?.token);

  // 房间摘要必须去掉 humanUrlPath：否则任何人 GET 一次摘要就能拿到人类令牌
  const summary = await api(`/api/rooms/${roomId}`);
  check(summary.status === 200, 'GET 房间摘要应返回 200');
  check(
    !Object.prototype.hasOwnProperty.call(summary.body ?? {}, 'humanUrlPath'),
    '房间摘要不应再返回 humanUrlPath（否则等于广播人类令牌）',
    summary.body,
  );

  await probeSeatAuth(roomId);

  console.log(`  🏠 房间 ${roomId} 建好，双方入座（waiting → playing，令牌已就位）`);
}

// ────────────────────────────── WebSocket 探针 ──────────────────────────────

class WsProbe {
  hello: any = null;
  events: GameEvent[] = [];
  reveals: RevealEvent[] = [];
  chats: ChatMessage[] = [];
  ends: EndEvent[] = [];
  errors: string[] = [];
  private socket: WebSocket;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener('message', (ev: MessageEvent) => {
      const raw = typeof ev.data === 'string' ? ev.data : '';
      if (!raw) return;
      let payload: any;
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }
      if (payload?.type === 'hello') {
        this.hello = payload;
        return;
      }
      if (payload?.type === 'events' && Array.isArray(payload.events)) {
        for (const event of payload.events as GameEvent[]) {
          this.events.push(event);
          if (event.type === 'reveal') this.reveals.push(event);
          if (event.type === 'chat') this.chats.push(event.message);
          if (event.type === 'end') this.ends.push(event);
        }
      }
    });
    this.socket.addEventListener('error', () => {
      this.errors.push('WebSocket error 事件');
    });
  }

  waitHello(timeoutMs = 3000): Promise<any> {
    return waitFor(() => this.hello ?? undefined, timeoutMs, 'WS hello');
  }

  waitReveal(round: number, timeoutMs = 3000): Promise<RevealEvent> {
    return waitFor(
      () => this.reveals.find((r) => r.round === round),
      timeoutMs,
      `WS reveal (round ${round})`,
    );
  }

  waitChat(id: number, timeoutMs = 3000): Promise<ChatMessage> {
    return waitFor(
      () => this.chats.find((m) => m.id === id),
      timeoutMs,
      `WS chat (id ${id})`,
    );
  }

  waitEnd(timeoutMs = 3000): Promise<EndEvent> {
    return waitFor(() => this.ends[0], timeoutMs, 'WS end');
  }

  close(): void {
    try {
      if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
        this.socket.close();
      }
    } catch {
      /* 忽略关闭异常 */
    }
  }
}

// ────────────────────────────── 选格 ──────────────────────────────

function pickRandom(actions: Action[], what: string): Action {
  check(actions.length > 0, `${what}: legalActions 不应为空`);
  return actions[Math.floor(Math.random() * actions.length)];
}

function pickDifferent(actions: Action[], avoid: Coord): Action {
  const options = actions.filter((a) => !sameCell(a.cell, avoid));
  if (options.length === 0) return actions[0];
  return options[Math.floor(Math.random() * options.length)];
}

// ────────────────────────────── 协议探测（非法动作 / 聊天） ──────────────────────────────

async function probeIllegalAction(roomId: string): Promise<void> {
  const before = await getState(roomId, 0);
  const legalCount = before.legalActions.length;
  check(legalCount === 9, '刚开局应有 9 个合法格', legalCount);

  const res = await submitAction(roomId, 0, [9, 9]);
  check(res.status === 409, '非法动作应返回 HTTP 409', res.status);
  check(res.body?.ok === false, '非法动作响应 ok 应为 false', res.body);
  check(
    res.body?.error === 'illegal_action',
    '非法动作 error 应为 illegal_action',
    res.body?.error,
  );
  check(
    Array.isArray(res.body?.legalActions) && res.body.legalActions.length === legalCount,
    '409 响应应回带完整 legalActions（用于纠正）',
    res.body?.legalActions,
  );
  check(
    cellKeys(res.body.legalActions) === cellKeys(before.legalActions),
    '409 的 legalActions 应与 /state 的 legalActions 一致',
  );

  // 非法动作不得写入 pending、不得推进回合
  const after = await getState(roomId, 0);
  check(after.youSubmitted === false, '非法动作不应把座位标记为已提交');
  check(after.round === before.round, '非法动作不应推进回合');
  check(after.history.length === 0, '非法动作不应写入历史');
  console.log('  🔎 非法动作 ✅ 409 illegal_action + legalActions');
}

async function probeChat(roomId: string, ws: WsProbe | null): Promise<void> {
  const text0 = '这枚金币归我了';
  const text1 = '哼，看我的！';

  const say0 = await api(`/api/rooms/${roomId}/say`, {
    method: 'POST',
    body: { seat: 0, token: requireSeatToken(roomId, 0, 'say'), text: text0 },
  });
  check(say0.status === 200 && say0.body?.ok === true, 'say seat0 应成功', say0.body);
  check(
    say0.body?.message?.seat === 0 && say0.body?.message?.text === text0,
    'say 返回的 message 应带座位与文本',
    say0.body?.message,
  );

  const say1 = await api(`/api/rooms/${roomId}/say`, {
    method: 'POST',
    body: { seat: 1, token: requireSeatToken(roomId, 1, 'say'), text: text1 },
  });
  check(say1.status === 200 && say1.body?.ok === true, 'say seat1 应成功', say1.body);

  // 限流：同一座位 800ms 内再次发言应 400
  const throttled = await api(`/api/rooms/${roomId}/say`, {
    method: 'POST',
    body: { seat: 1, token: requireSeatToken(roomId, 1, 'say'), text: '再说一句' },
  });
  check(throttled.status === 400, '同一座位 800ms 内重复发言应被限流（400）', throttled.status);

  const all = await api(`/api/rooms/${roomId}/chat?since=0`);
  check(all.status === 200 && Array.isArray(all.body?.messages), 'GET /chat 应返回 messages 数组', all.body);
  const messages = all.body.messages as ChatMessage[];
  check(messages.length === 2, 'since=0 应返回全部 2 条聊天', messages.length);
  check(messages[0].id === 1 && messages[1].id === 2, '聊天 id 应从 1 开始递增', messages.map((m) => m.id));
  check(messages[0].seat === 0 && messages[1].seat === 1, '聊天座位应正确', messages.map((m) => m.seat));
  check(messages[0].text === text0 && messages[1].text === text1, '聊天文本应正确');

  const since = await api(`/api/rooms/${roomId}/chat?since=${messages[0].id}`);
  check(since.status === 200, 'GET /chat?since 应返回 200');
  check(
    since.body?.messages?.length === 1 && since.body.messages[0].id === messages[1].id,
    'chat?since 应只返回新消息',
    since.body?.messages,
  );

  if (ws) {
    await ws.waitChat(messages[0].id);
    await ws.waitChat(messages[1].id);
    check(ws.chats.length >= 2, 'WS 应推送 chat 事件', ws.chats.length);
  }
  console.log('  🔎 聊天 ✅ say×2 / 限流 400 / chat?since 过滤' + (ws ? ' / WS 推送' : ''));
}

// ────────────────────────────── 单回合 ──────────────────────────────

interface RoundOutcome {
  reveal: RevealEvent;
  end: EndEvent | null;
  expected: Scores;
}

/**
 * 打一个完整回合：双方各取 /state → 选格 → 提交。
 * 断言：单人提交 resolved=false；双方提交后 resolved=true 且带 reveal；
 *       reveal/state/history 的 delta 与比分互相自洽。
 */
async function playRound(
  label: string,
  roomId: string,
  mode: RoundMode,
  expectedBefore: Scores,
  opts: { duplicateProbe?: boolean; ws?: WsProbe | null } = {},
): Promise<RoundOutcome> {
  const before0 = await getState(roomId, 0);
  const before1 = await getState(roomId, 1);
  const round = before0.round;

  check(before0.status === 'playing', `第 ${round} 回合开始前 status 应为 playing`, before0.status);
  check(before0.legalActions.length > 0, `第 ${round} 回合 legalActions 不应为空`);
  check(
    before0.legalActions.length === before1.legalActions.length,
    `第 ${round} 回合双方 legalActions 数量应一致`,
    [before0.legalActions.length, before1.legalActions.length],
  );
  check(
    cellKeys(before0.legalActions) === cellKeys(before1.legalActions),
    'grid 是公开信息，双方 legalActions 应一致',
  );
  check(
    num(before0.scores, 0) === num(before1.scores, 0) && num(before0.scores, 1) === num(before1.scores, 1),
    '双方观测的 scores 应一致',
  );
  check(safeJson(before0.grid) === safeJson(before1.grid), '双方观测的 grid 应一致');
  check(
    num(before0.scores, 0) === expectedBefore['0'] && num(before0.scores, 1) === expectedBefore['1'],
    `第 ${round} 回合开始前比分应等于历史 delta 累加`,
    { scores: before0.scores, expected: expectedBefore },
  );
  check(before0.youSubmitted === false, `第 ${round} 回合开始时应未提交`);
  check(before1.youSubmitted === false, `第 ${round} 回合开始时应未提交`);
  check(
    before0.waitingFor.length === 2 && before0.waitingFor.includes(0) && before0.waitingFor.includes(1),
    `第 ${round} 回合开始时双方都应待提交（waitingFor=[0,1]）`,
    before0.waitingFor,
  );
  check(before0.yourScore === num(before0.scores, 0), 'yourScore 应等于自己座位分数');
  check(before0.opponentScore === num(before0.scores, 1), 'opponentScore 应等于对手座位分数');

  const chosen0 = pickRandom(before0.legalActions, `第 ${round} 回合 seat0`);
  const cell0: Coord = [chosen0.cell[0], chosen0.cell[1]];
  let cell1: Coord;

  if (mode === 'collision') {
    check(
      before1.legalActions.some((a) => sameCell(a.cell, cell0)),
      `第 ${round} 回合撞车目标格 [${cell0}] 在双方视角都应仍然存在`,
      before1.legalActions.map((a) => a.cell),
    );
    cell1 = [cell0[0], cell0[1]];
  } else if (mode === 'avoid') {
    const chosen1 = pickDifferent(before1.legalActions, cell0);
    cell1 = [chosen1.cell[0], chosen1.cell[1]];
  } else {
    const chosen1 = pickRandom(before1.legalActions, `第 ${round} 回合 seat1`);
    cell1 = [chosen1.cell[0], chosen1.cell[1]];
  }

  // ── seat0 提交 ──
  const res0 = await submit(roomId, 0, cell0);
  check(res0.status === 200, 'seat0 合法动作应返回 200', res0.body);
  check(res0.body?.ok === true, 'seat0 提交 ok 应为 true', res0.body);
  check(res0.body?.resolved === false, '只有 seat0 提交时 resolved 应为 false', res0.body);
  check(
    Array.isArray(res0.body?.events) && res0.body.events.length === 0,
    '只有 seat0 提交时不应产生事件',
    res0.body?.events,
  );

  const mid = await getState(roomId, 0);
  check(mid.youSubmitted === true, 'seat0 提交后 youSubmitted 应为 true');
  check(
    mid.waitingFor.length === 1 && mid.waitingFor[0] === 1,
    'seat0 提交后 waitingFor 应只剩座位 1',
    mid.waitingFor,
  );

  if (opts.duplicateProbe) {
    check(mode === 'collision', '重复提交探测应发生在强制撞车回合（避免污染随机回合）');
    const alternative = before0.legalActions.find((a) => !sameCell(a.cell, cell0));
    const other = must(alternative, '应有第二个候选格用于重复提交探测');
    const dup = await submit(roomId, 0, [other.cell[0], other.cell[1]]);
    check(dup.status === 409, '同座位重复提交应返回 409', dup.status);
    check(
      dup.body?.error === 'action_already_submitted',
      '重复提交 error 应为 action_already_submitted',
      dup.body?.error,
    );
    const mid2 = await getState(roomId, 0);
    check(mid2.youSubmitted === true, '重复提交被拒后仍应保持已提交状态');
    check(
      mid2.waitingFor.length === 1 && mid2.waitingFor[0] === 1,
      '重复提交被拒后 waitingFor 仍应只剩座位 1',
      mid2.waitingFor,
    );
    const summary = await api(`/api/rooms/${roomId}`);
    check(summary.status === 200, 'GET 房间摘要应返回 200');
    check(
      Array.isArray(summary.body?.pendingSeats) &&
        summary.body.pendingSeats.length === 1 &&
        summary.body.pendingSeats[0] === 0,
      '房间摘要 pendingSeats 应只有 [0]',
      summary.body?.pendingSeats,
    );
    console.log('  🔎 重复提交 ✅ 409 action_already_submitted（原动作仍挂着）');
  }

  // ── seat1 提交 → 结算 ──
  const res1 = await submit(roomId, 1, cell1);
  check(res1.status === 200, 'seat1 合法动作应返回 200', res1.body);
  check(res1.body?.ok === true, 'seat1 提交 ok 应为 true');
  check(res1.body?.resolved === true, '双方提交后 resolved 应为 true', res1.body);
  check(Array.isArray(res1.body?.events), '结算响应应带 events 数组');

  const reveal = must(
    (res1.body.events as GameEvent[]).find((e) => e.type === 'reveal') as RevealEvent | undefined,
    '结算响应 events 应包含 reveal 事件',
  );
  const end = ((res1.body.events as GameEvent[]).find((e) => e.type === 'end') as EndEvent | undefined) ?? null;

  check(reveal.round === round, 'reveal.round 应等于本回合号', { reveal: reveal.round, round });
  check(sameCell(reveal.picks?.['0'], cell0), 'reveal.picks[0] 应与 seat0 实际提交一致', reveal.picks);
  check(sameCell(reveal.picks?.['1'], cell1), 'reveal.picks[1] 应与 seat1 实际提交一致', reveal.picks);
  for (const seat of [0, 1] as const) {
    check(typeof reveal.delta?.[String(seat)] === 'number', `reveal.delta[${seat}] 应为数字`, reveal.delta);
  }

  if (mode === 'collision') {
    check(reveal.collision === true, '双方同格时应标记 collision=true', reveal.collision);
    check(
      reveal.delta['0'] === 0 && reveal.delta['1'] === 0,
      '撞车时双方 delta 都应为 0',
      reveal.delta,
    );
    check(
      reveal.applied?.['0'] === 'collision' && reveal.applied?.['1'] === 'collision',
      '撞车时 applied 双方都应为 collision',
      reveal.applied,
    );
  }
  if (mode === 'avoid') {
    if (before0.legalActions.length >= 2) {
      check(reveal.collision === false, 'avoid 模式双方选不同格，不应撞车');
    } else {
      check(reveal.collision === true, '只剩最后一格时双方必然撞车');
    }
  }

  // 被选中的格子必须变成 taken
  for (const [seat, pick] of Object.entries(reveal.picks) as [string, Coord][]) {
    check(
      reveal.grid?.[pick[0]]?.[pick[1]] === 'taken',
      `座位 ${seat} 选中的格子 [${pick}] 应变成 taken`,
      reveal.grid?.[pick[0]]?.[pick[1]],
    );
  }
  // grid 取值合法
  for (const row of reveal.grid) {
    for (const cell of row) {
      check(
        cell === 1 || cell === 2 || cell === 3 || cell === 'empty' || cell === 'bomb' || cell === 'taken',
        'grid 取值应合法',
        cell,
      );
    }
  }

  const expectedAfter: Scores = {
    '0': expectedBefore['0'] + Number(reveal.delta['0']),
    '1': expectedBefore['1'] + Number(reveal.delta['1']),
  };
  check(
    num(reveal.scores, 0) === expectedAfter['0'] && num(reveal.scores, 1) === expectedAfter['1'],
    'reveal.scores 应等于历史 delta 累加',
    { scores: reveal.scores, expected: expectedAfter },
  );

  // ── 结算后的观测 ──
  const after0 = await getState(roomId, 0);
  const after1 = await getState(roomId, 1);
  check(
    num(after0.scores, 0) === expectedAfter['0'] && num(after0.scores, 1) === expectedAfter['1'],
    '/state 的 scores 应等于历史 delta 累加',
    { scores: after0.scores, expected: expectedAfter },
  );
  check(
    num(after1.scores, 0) === expectedAfter['0'] && num(after1.scores, 1) === expectedAfter['1'],
    '对方视角 /state 的 scores 也应一致',
  );
  check(
    after0.history.length === before0.history.length + 1,
    '每回合结束后 history 应 +1',
    { before: before0.history.length, after: after0.history.length },
  );
  const lastHistory = after0.history[after0.history.length - 1];
  check(lastHistory.round === round, 'history 末条 round 应等于本回合', lastHistory);
  check(lastHistory.collision === reveal.collision, 'history.collision 应与 reveal 一致');
  check(sameCell(lastHistory.picks['0'], cell0) && sameCell(lastHistory.picks['1'], cell1), 'history.picks 应与 reveal 一致');
  check(
    num(lastHistory.delta, 0) === Number(reveal.delta['0']) &&
      num(lastHistory.delta, 1) === Number(reveal.delta['1']),
    'history.delta 应与 reveal.delta 一致',
  );
  check(safeJson(after0.grid) === safeJson(reveal.grid), '/state.grid 应等于 reveal.grid');
  // 结束时 round 显示「已进行回合数」，进行中则是「本回合号」
  const expectedRound = end ? round : round + 1;
  check(after0.round === expectedRound, '结算后 round 应推进（结束时等于已打回合数）', {
    before: round,
    after: after0.round,
    ended: Boolean(end),
  });
  check(
    after0.youSubmitted === false && after1.youSubmitted === false,
    '结算后双方 pending 应被清空（youSubmitted=false）',
  );

  const consumed = reveal.collision ? 1 : 2;
  if (end) {
    check(after0.status === 'ended', '收到 end 事件后 status 应为 ended', after0.status);
    check(after0.waitingFor.length === 0, '结束后 waitingFor 应为空', after0.waitingFor);
    check(after0.result !== null, '结束后 /state.result 不应为 null');
    check(
      safeJson(after0.result) === safeJson(end.result),
      '/state.result 应等于 end 事件的 result',
      { state: after0.result, event: end.result },
    );
    check(
      num(after0.result?.scores, 0) === expectedAfter['0'] && num(after0.result?.scores, 1) === expectedAfter['1'],
      'result.scores 应等于历史 delta 累加',
    );
    check(after0.legalActions.length === 0, '结束后 legalActions 应为空', after0.legalActions);
    check(after1.legalActions.length === 0, '结束后对方视角 legalActions 也应为空');
    check(after0.result?.winner === (expectedAfter['0'] === expectedAfter['1'] ? null : expectedAfter['0'] > expectedAfter['1'] ? 0 : 1), 'result.winner 应与比分一致');
    check(typeof after0.result?.text === 'string' && after0.result.text.length > 0, 'result.text 不应为空');
  } else {
    check(after0.status === 'playing', '未结束时应保持 playing', after0.status);
    check(
      after0.waitingFor.length === 2,
      '下一回合双方都应重新待提交（waitingFor=[0,1]）',
      after0.waitingFor,
    );
    check(
      after0.legalActions.length === before0.legalActions.length - consumed,
      '剩余合法格数量应按本回合消耗减少',
      { before: before0.legalActions.length, after: after0.legalActions.length, consumed },
    );
    check(after0.round === round + 1, 'round 应推进');
  }

  // ── WS 推送（只探测一次） ──
  if (opts.ws) {
    const wsReveal = await opts.ws.waitReveal(round);
    check(wsReveal.collision === reveal.collision, 'WS reveal.collision 应与 REST 一致');
    check(sameCell(wsReveal.picks['0'], cell0) && sameCell(wsReveal.picks['1'], cell1), 'WS reveal.picks 应与 REST 一致');
    console.log(`  🔌 WS ✅ 收到 round ${round} reveal`);
  }

  const deltaText = `Δ0=${Number(reveal.delta['0']) >= 0 ? '+' : ''}${reveal.delta['0']} Δ1=${Number(reveal.delta['1']) >= 0 ? '+' : ''}${reveal.delta['1']}`;
  const picksText = `0=[${cell0}] 1=[${cell1}]`;
  const remaining = after0.legalActions.length;
  const tag = reveal.collision ? '💥 撞车' : '✅ 结算';
  console.log(
    `[${label}] 第 ${round} 回合 ${tag}  ${picksText}  ${deltaText}  比分 ${expectedAfter['0']}:${expectedAfter['1']}  剩余 ${remaining} 格`,
  );

  return { reveal, end, expected: expectedAfter };
}

// ────────────────────────────── 一局 ──────────────────────────────

interface GameReport {
  game: string;
  label: string;
  roomId: string;
  rounds: number;
  final: Scores;
  result: { winner: number | null; scores: Scores; text: string };
  wsSummary: string | null;
}

async function playGame(config: GameConfig): Promise<GameReport> {
  console.log(`\n──────── ${config.label} ────────`);

  // 建桌
  const created = await api('/api/rooms', { method: 'POST', body: { gameId: 'grab' } });
  check(created.status === 200, '创建房间应返回 200', created.body);
  check(typeof created.body?.roomId === 'string' && created.body.roomId.length > 0, '创建房间应返回 roomId', created.body);
  check(created.body?.gameId === 'grab', '房间游戏应为 grab');
  check(created.body?.agentSeat === 1, 'agentSeat 应为 1');
  check(typeof created.body?.rules === 'string' && created.body.rules.length > 0, '建桌响应应带 rules 全文');
  const roomId = created.body.roomId as string;
  // 建桌令牌 + humanUrlPath 的断言与其它游戏走同一套（finishCreate），避免两条路径漂移
  finishCreate('grab', created, false);

  // 入座 + 幂等 + 席位鉴权探针（与其它游戏共用 joinBoth）
  await joinBoth(roomId);

  const probe = config.ws ? new WsProbe(`${WS_BASE}/ws?room=${roomId}`) : null;
  try {
    if (probe) {
      await probe.waitHello();
      check(probe.hello?.roomId === roomId, 'WS hello.roomId 应等于房间 id', probe.hello?.roomId);
      check(probe.hello?.summary?.status === 'playing', 'WS hello.summary.status 应为 playing', probe.hello?.summary?.status);
      console.log(`  🔌 WS ✅ 已连接并收到 hello（${probe.hello.summary.status}）`);
    }

    if (config.probes) {
      await probeIllegalAction(roomId);
      await probeChat(roomId, probe);
    }

    const rounds: RoundOutcome[] = [];
    let expected: Scores = { '0': 0, '1': 0 };
    let endEvent: EndEvent | null = null;
    let guard = 0;

    while (!endEvent) {
      if (++guard > 12) throw new CheckFailure('对局超过 12 回合仍未结束，疑似死循环');
      const first = rounds.length === 0;
      const mode: RoundMode =
        config.forceCollisionFirst && first ? 'collision' : config.avoidCollision ? 'avoid' : 'random';
      const outcome = await playRound(config.label, roomId, mode, expected, {
        duplicateProbe: Boolean(config.probes && first),
        ws: probe && first ? probe : null,
      });
      rounds.push(outcome);
      expected = outcome.expected;
      endEvent = outcome.end;

      // 顺带验证每回合 GET /state 的 history 累计分数（累积版）
      const cumulative = rounds.reduce(
        (acc, r) => {
          acc['0'] += Number(r.reveal.delta['0']);
          acc['1'] += Number(r.reveal.delta['1']);
          return acc;
        },
        { '0': 0, '1': 0 } as Scores,
      );
      check(
        cumulative['0'] === expected['0'] && cumulative['1'] === expected['1'],
        '历史 delta 累加应与当前 expected 比分一致',
      );
    }

    // ── 终局断言 ──
    const finalResult = must(endEvent, '对局应以 end 事件结束').result;
    check(finalResult !== null && typeof finalResult === 'object', '最终 result 不应为空');
    check(typeof finalResult.text === 'string' && finalResult.text.length > 0, 'result.text 不应为空');
    check(
      num(finalResult.scores, 0) === expected['0'] && num(finalResult.scores, 1) === expected['1'],
      'result.scores 应等于全场 delta 累加',
      { result: finalResult.scores, expected },
    );

    const final0 = await getState(roomId, 0);
    const final1 = await getState(roomId, 1);
    for (const [name, obs] of [['seat0', final0], ['seat1', final1]] as const) {
      check(obs.status === 'ended', `结束后 ${name} 视角 status 应为 ended`, obs.status);
      check(obs.result !== null, `结束后 ${name} 视角 result 不应为空`);
      check(obs.legalActions.length === 0, `结束后 ${name} 视角 legalActions 应为空`, obs.legalActions);
      check(obs.round === rounds.length, `结束后 ${name} 视角 round 应为已打回合数`, {
        round: obs.round,
        played: rounds.length,
      });
      check(
        num(obs.scores, 0) === expected['0'] && num(obs.scores, 1) === expected['1'],
        `结束后 ${name} 视角 scores 应等于全场 delta 累加`,
      );
      check(safeJson(obs.result) === safeJson(finalResult), `${name} 视角 result 应与 end 事件一致`);
    }

    const resultRes = await api(`/api/rooms/${roomId}/result`);
    check(resultRes.status === 200, 'GET /result 应返回 200');
    check(safeJson(resultRes.body) === safeJson(finalResult), 'GET /result 应等于结算结果', resultRes.body);

    // 结束后不能再提交
    const late = await submit(roomId, 0, [0, 0]);
    check(late.status === 409, '结束后再提交应返回 409', late.status);
    check(late.body?.error === 'room_ended', '结束后再提交 error 应为 room_ended', late.body);

    // 回放日志
    const logRes = await api(`/api/rooms/${roomId}/log?seat=0`);
    check(logRes.status === 200, 'GET /log 应返回 200');
    check(typeof logRes.body?.seed === 'number', '日志应带 seed', logRes.body?.seed);
    check(Array.isArray(logRes.body?.events), '日志应带 events 数组');
    const logEvents = logRes.body.events as { t: number; event: GameEvent }[];
    const logReveals = logEvents.filter((entry) => entry.event?.type === 'reveal');
    check(logReveals.length === rounds.length, '日志 reveal 数应等于回合数', {
      log: logReveals.length,
      played: rounds.length,
    });
    check(logEvents.some((entry) => entry.event?.type === 'end'), '日志应含 end 事件');
    check(
      logReveals.map((e) => (e.event as RevealEvent).round).join(',') === rounds.map((r) => r.reveal.round).join(','),
      '日志 reveal 的回合顺序应与实战一致',
    );
    check(safeJson(logRes.body.result) === safeJson(finalResult), '日志 result 应等于结算结果');
    check(logRes.body.events.length === rounds.length + 1, '日志应恰好包含每回合 reveal + 1 个 end', logRes.body.events.length);

    // WS 终局：全部 reveal + end 都应推送
    let wsSummary: string | null = null;
    if (probe) {
      await waitFor(
        () => (probe.reveals.length >= rounds.length ? true : undefined),
        3000,
        `WS 收到全部 ${rounds.length} 条 reveal`,
      );
      await probe.waitEnd();
      check(
        probe.reveals.map((r) => r.round).join(',') === rounds.map((r) => r.reveal.round).join(','),
        'WS reveal 序列应与实战回合一致',
        probe.reveals.map((r) => r.round),
      );
      check(probe.ends[0].result !== null, 'WS end 事件应带 result');
      check(safeJson(probe.ends[0].result) === safeJson(finalResult), 'WS end.result 应等于最终结果');
      wsSummary = `reveal×${probe.reveals.length} / chat×${probe.chats.length} / end×${probe.ends.length}`;
    }

    console.log(`\n🏁 ${config.label} 结束：共 ${rounds.length} 回合`);
    console.log(`   比分  座位0 ${expected['0']} : ${expected['1']} 座位1`);
    console.log(`   结果  ${finalResult.text}`);
    if (wsSummary) console.log(`   WS    ${wsSummary}`);

    return {
      game: 'grab',
      label: config.label,
      roomId,
      rounds: rounds.length,
      final: expected,
      result: finalResult,
      wsSummary,
    };
  } finally {
    probe?.close();
  }
}

// ────────────────────────────── 四子棋（turn） ──────────────────────────────

const C4_ROWS = 6;
const C4_COLS = 7;

/** 独立扫描四连（不依赖 core，e2e 自己作为裁判）。返回赢家座位或 null。 */
function c4ScanWinner(board: number[][]): number | null {
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ] as const;
  for (let row = 0; row < C4_ROWS; row++) {
    for (let column = 0; column < C4_COLS; column++) {
      const stone = board?.[row]?.[column];
      if (!stone) continue;
      for (const [dr, dc] of directions) {
        const endRow = row + dr * 3;
        const endColumn = column + dc * 3;
        if (endRow < 0 || endRow >= C4_ROWS || endColumn < 0 || endColumn >= C4_COLS) continue;
        if (
          board[row + dr][column + dc] === stone &&
          board[row + dr * 2][column + dc * 2] === stone &&
          board[endRow][endColumn] === stone
        ) {
          return stone - 1;
        }
      }
    }
  }
  return null;
}

function c4IsFull(board: number[][]): boolean {
  return board[0].every((stone) => stone !== 0);
}

/** 校验棋盘形状 / 取值 / 重力（每列棋子必须从底部连续堆叠，不能悬空）。 */
function c4ValidateBoard(board: number[][], what: string): void {
  check(Array.isArray(board) && board.length === C4_ROWS, `${what}: 棋盘应有 6 行`);
  board.forEach((line, row) => {
    check(Array.isArray(line) && line.length === C4_COLS, `${what}: 第 ${row} 行应有 7 列`);
    for (const stone of line) check(stone === 0 || stone === 1 || stone === 2, `${what}: 棋子取值应合法`, stone);
  });
  for (let column = 0; column < C4_COLS; column++) {
    let sawEmpty = false;
    for (let row = C4_ROWS - 1; row >= 0; row--) {
      if (board[row][column] === 0) {
        sawEmpty = true;
      } else {
        check(!sawEmpty, `${what}: 第 ${column} 列出现悬空棋子（重力错误）`);
      }
    }
  }
}

/** 一条「下满 42 手仍无四连」的脚本落子序列（用于覆盖平局分支）。 */
const C4_DRAW_SEQUENCE = [
  1, 5, 2, 5, 2, 1, 4, 2, 1, 3, 6, 6, 5, 3, 0, 2, 0, 2, 1, 0, 3, 6, 5, 6, 2, 3, 6, 3, 0, 5, 3, 6, 4, 5, 0, 1,
  1, 0, 4, 4, 4, 4,
];

/** 四子棋一局：脚本固定「竖四连胜」/「满盘平局」或随机对局，终局用独立扫描校验 winner。 */
async function playConnect4(
  label: string,
  mode: 'vertical-win' | 'draw' | 'random',
): Promise<GameReport> {
  console.log(`\n──────── ${label}（connect4）────────`);
  const room = await createRoomForGame('connect4');
  const roomId = room.roomId;
  await joinBoth(roomId);

  const start0 = await getObservation(roomId, 0);
  const start1 = await getObservation(roomId, 1);
  check(start0.status === 'playing', '四子棋入座后 status 应为 playing', start0.status);
  check(start0.currentSeat === 0 && start0.isYourTurn === true, '四子棋应由座位 0 先手');
  check(start0.legalActions.length === C4_COLS, '空盘应有 7 列可选', start0.legalActions.length);
  check(start0.history.length === 0, '开局 history 应为空');
  check(start1.currentSeat === 0 && start1.isYourTurn === false, '座位 1 开局不应轮到');
  check(start1.legalActions.length === 0, '非当前回合 legalActions 应为空', start1.legalActions);

  // 轮流制错误分支：非自己回合 / 非法列
  const wrongTurn = await submitRaw(roomId, 1, { action: 'drop', column: 0 });
  check(wrongTurn.status === 409, '非当前回合提交应 409', wrongTurn.status);
  check(wrongTurn.body?.error === 'not_your_turn', '非当前回合 error 应为 not_your_turn', wrongTurn.body);
  const illegal = await submitRaw(roomId, 0, { action: 'drop', column: 9 });
  check(illegal.status === 409, '非法列应 409', illegal.status);
  check(illegal.body?.error === 'illegal_action', '非法列 error 应为 illegal_action', illegal.body);
  check(
    Array.isArray(illegal.body?.legalActions) && illegal.body.legalActions.length === C4_COLS,
    '非法列 409 应回带 7 个合法列',
    illegal.body?.legalActions,
  );
  const afterIllegal = await getObservation(roomId, 0);
  check(afterIllegal.currentSeat === 0 && afterIllegal.history.length === 0, '非法动作不应改变局面');
  console.log('  🔎 轮流制错误分支 ✅ not_your_turn / illegal_action + legalActions');

  const moves: { seat: number; column: number; row: number }[] = [];
  let endResult: any = null;
  let lastBoard: number[][] | null = null;
  let guard = 0;

  while (!endResult) {
    if (++guard > 42) throw new CheckFailure('四子棋超过 42 手仍未结束');
    const globalView = await getObservation(roomId, 0);
    const current = globalView.currentSeat;
    check(current === 0 || current === 1, 'currentSeat 应为 0 或 1', current);
    const actor = await getObservation(roomId, current);
    check(actor.isYourTurn === true, '当前行动方 isYourTurn 应为 true');
    check(actor.legalActions.length > 0, '当前行动方应有合法列');

    let column: number;
    if (mode === 'vertical-win') {
      column = current === 0 ? 0 : 6;
      check(
        (actor.legalActions as any[]).some((a) => Number(a.column) === column),
        `脚本列 ${column} 应仍合法`,
        actor.legalActions,
      );
    } else if (mode === 'draw') {
      column = C4_DRAW_SEQUENCE[moves.length];
      check(Number.isInteger(column), '平局脚本应覆盖到全部 42 手', { move: moves.length });
      check(
        (actor.legalActions as any[]).some((a) => Number(a.column) === column),
        `平局脚本列 ${column} 应仍合法`,
        actor.legalActions,
      );
    } else {
      const columns = (actor.legalActions as any[]).map((a) => Number(a.column));
      column = columns[Math.floor(Math.random() * columns.length)];
    }

    const res = await submitRaw(roomId, current, { action: 'drop', column });
    check(res.status === 200, '当前行动方落子应返回 200', res.body);
    check(res.body?.ok === true && res.body?.resolved === true, '轮流制落子应立即结算', res.body);
    const drop = must(
      (res.body.events as any[]).find((e) => e.type === 'drop'),
      'drop 响应应包含 drop 事件',
    );
    const end = ((res.body.events as any[]).find((e) => e.type === 'end') as any | undefined) ?? null;
    check(drop.seat === current && drop.column === column, 'drop 事件字段应与提交一致', drop);
    check(Number.isInteger(drop.row) && drop.row >= 0 && drop.row < C4_ROWS, 'drop 行号应合法', drop.row);
    c4ValidateBoard(drop.board, 'drop 事件棋盘');
    for (let row = drop.row + 1; row < C4_ROWS; row++) {
      check(drop.board[row][column] !== 0, '落子下方不应为空（重力）', { row, column });
    }
    check(drop.board[drop.row][column] === current + 1, '落子格棋子应属于当前座位');
    moves.push({ seat: current, column, row: drop.row });
    lastBoard = drop.board;
    check(
      drop.board.flat().filter((stone: number) => stone !== 0).length === moves.length,
      '棋盘棋子数应等于手数',
      { stones: drop.board.flat().filter((stone: number) => stone !== 0).length, moves: moves.length },
    );
    check(
      safeJson(drop.lastMove) === safeJson({ seat: current, column, row: drop.row }),
      'drop 事件 lastMove 应正确',
      drop.lastMove,
    );

    if (!end) {
      const nextSeat = 1 - current;
      check(drop.nextSeat === nextSeat, '未终局时 nextSeat 应换手', drop.nextSeat);
      const nextObs = await getObservation(roomId, nextSeat);
      check(nextObs.currentSeat === nextSeat && nextObs.isYourTurn === true, '换手后 isYourTurn 应正确');
      const oldObs = await getObservation(roomId, current);
      check(oldObs.isYourTurn === false && oldObs.legalActions.length === 0, '交棒方应无合法动作');
    } else {
      endResult = end.result;
    }

    if (mode === 'vertical-win' || moves.length <= 7) {
      console.log(`[${label}] 第 ${moves.length} 手 seat${current} → 第 ${column} 列 · 第 ${drop.row} 行`);
    }
  }

  // ── 终局断言：winner 与 board 一致 ──
  const final0 = await getObservation(roomId, 0);
  const final1 = await getObservation(roomId, 1);
  check(final0.status === 'ended' && final1.status === 'ended', '终局 status 应为 ended');
  check(final0.currentSeat === null && final1.currentSeat === null, '终局 currentSeat 应为 null');
  check(final0.isYourTurn === false && final1.isYourTurn === false, '终局 isYourTurn 应为 false');
  check(final0.legalActions.length === 0 && final1.legalActions.length === 0, '终局 legalActions 应为空');
  check(safeJson(final0.board) === safeJson(final1.board), '双方看到的棋盘应一致');
  check(safeJson(final0.board) === safeJson(lastBoard), '终局观测棋盘应等于最后一次 drop 事件的棋盘');
  check(final0.history.length === moves.length, 'history 手数应与实战一致', {
    history: final0.history.length,
    moves: moves.length,
  });
  c4ValidateBoard(final0.board, '终局棋盘');

  const scannedWinner = c4ScanWinner(final0.board);
  const boardFull = c4IsFull(final0.board);
  check(scannedWinner !== null || boardFull, '终局应有人连成四子或棋盘已下满');
  check(
    scannedWinner === final0.result.winner,
    'result.winner 应与棋盘四连扫描一致',
    { scanned: scannedWinner, result: final0.result },
  );
  check(
    safeJson(final0.result) === safeJson(endResult),
    '终局观测 result 应等于 end 事件的 result',
  );
  const expectedScores =
    scannedWinner === null
      ? { '0': 0, '1': 0 }
      : { '0': scannedWinner === 0 ? 1 : 0, '1': scannedWinner === 1 ? 1 : 0 };
  check(
    safeJson(final0.result.scores) === safeJson(expectedScores),
    'result.scores 应与 winner 一致',
    { scores: final0.result.scores, expected: expectedScores },
  );
  check(typeof final0.result.text === 'string' && final0.result.text.length > 0, 'result.text 不应为空');
  if (scannedWinner === null) {
    check(boardFull, '平局时棋盘必须下满');
  } else {
    check(!boardFull || scannedWinner !== null, '四连胜时允许棋盘未满');
  }
  if (mode === 'draw') {
    check(scannedWinner === null && boardFull, '平局脚本应打满 42 手且无人四连', {
      winner: scannedWinner,
      full: boardFull,
      moves: moves.length,
    });
    check(final0.result.winner === null, '平局脚本的 result.winner 应为 null');
    check(
      num(final0.result.scores, 0) === 0 && num(final0.result.scores, 1) === 0,
      '平局的 result.scores 应为 0:0',
    );
    check(final0.result.text.includes('平'), '平局的 result.text 应说明平局', final0.result.text);
  }

  // 用 history 独立重建棋盘，与终局棋盘比对
  const rebuilt = Array.from({ length: C4_ROWS }, () => Array<number>(C4_COLS).fill(0));
  for (const move of final0.history as { seat: number; column: number; row: number }[]) {
    let landing = -1;
    for (let row = C4_ROWS - 1; row >= 0; row--) {
      if (rebuilt[row][move.column] === 0) {
        landing = row;
        break;
      }
    }
    check(landing >= 0, 'history 重建时该列应还有空位');
    check(landing === move.row, 'history 记录的落子行应符合重力', { move, landing });
    rebuilt[landing][move.column] = move.seat + 1;
  }
  check(safeJson(rebuilt) === safeJson(final0.board), 'history 重建出的棋盘应等于终局棋盘');

  const resultRes = await api(`/api/rooms/${roomId}/result`);
  check(resultRes.status === 200 && safeJson(resultRes.body) === safeJson(final0.result), 'GET /result 应等于终局结果');

  const late = await submitRaw(roomId, 0, { action: 'drop', column: 0 });
  check(late.status === 409 && late.body?.error === 'room_ended', '终局后再落子应 409 room_ended', late.body);

  const logRes = await api(`/api/rooms/${roomId}/log?seat=0`);
  check(logRes.status === 200, 'GET /log 应返回 200');
  check(logRes.body?.gameId === 'connect4', '日志 gameId 应为 connect4');
  check(typeof logRes.body?.seed === 'number', '日志应带 seed');
  const logEvents = (logRes.body.events as { event: any }[]).map((entry) => entry.event);
  const logDrops = logEvents.filter((event) => event.type === 'drop');
  check(logDrops.length === moves.length, '日志 drop 数应等于手数', {
    log: logDrops.length,
    moves: moves.length,
  });
  check(
    logDrops.every(
      (event: any, index: number) =>
        event.seat === moves[index].seat &&
        event.column === moves[index].column &&
        event.row === moves[index].row,
    ),
    '日志 drop 序列应与实战一致',
  );
  check(logEvents.some((event) => event.type === 'end'), '日志应含 end 事件');
  check(logEvents.length === moves.length + 1, '日志应恰好包含 drop×N + 1 个 end', logEvents.length);

  console.log(`\n🏁 ${label} 结束：${moves.length} 手 · 棋盘${boardFull ? '已满' : '未满'} · ${final0.result.text}`);
  return {
    game: 'connect4',
    label,
    roomId,
    rounds: moves.length,
    final: { '0': num(final0.result.scores, 0), '1': num(final0.result.scores, 1) },
    result: final0.result,
    wsSummary: null,
  };
}

// ────────────────────────────── 快艇骰子（turn + 多子状态） ──────────────────────────────

const YACHT_CATEGORIES = [
  'ones',
  'twos',
  'threes',
  'fours',
  'fives',
  'sixes',
  'three_kind',
  'four_kind',
  'full_house',
  'small_straight',
  'large_straight',
  'yacht',
  'chance',
] as const;
type YachtCategory = (typeof YACHT_CATEGORIES)[number];

const YACHT_LABELS: Record<YachtCategory, string> = {
  ones: '一点',
  twos: '二点',
  threes: '三点',
  fours: '四点',
  fives: '五点',
  sixes: '六点',
  three_kind: '三条',
  four_kind: '四条',
  full_house: '葫芦',
  small_straight: '小顺',
  large_straight: '大顺',
  yacht: '快艇',
  chance: '全骰',
};

const YACHT_LOWER: readonly YachtCategory[] = [
  'three_kind',
  'four_kind',
  'full_house',
  'small_straight',
  'large_straight',
  'yacht',
  'chance',
];

function yachtSubmit(roomId: string, seat: number, action: Record<string, unknown>): Promise<ApiResponse> {
  return submitRaw(roomId, seat, action);
}

function sumLower(card: any): number {
  return YACHT_LOWER.reduce((total, category) => total + Number(card?.[category] ?? 0), 0);
}

/**
 * 快艇骰子一整局：两个脚本座位轮流各打 13 手（共 26 手）。
 * 每手 roll → hold（隔手覆盖，验证 toggle）→ roll → roll → must_score → score。
 * 覆盖错误分支：非自己回合 not_your_turn、must_score 再 roll/hold 的 illegal_action、重复记同一格 illegal_action。
 */
async function playYacht(label: string): Promise<GameReport> {
  console.log(`\n──────── ${label}（yacht）────────`);
  const room = await createRoomForGame('yacht');
  const roomId = room.roomId;
  await joinBoth(roomId);

  const start0 = await getObservation(roomId, 0);
  const start1 = await getObservation(roomId, 1);
  check(start0.status === 'playing', 'yacht 入座后 status 应为 playing', start0.status);
  check(start0.currentSeat === 0 && start0.isYourTurn === true, 'yacht 应由座位 0 先手');
  check(start0.round === 1 && start0.roundsTotal === 26, 'yacht 开局应为第 1/26 手', {
    round: start0.round,
    roundsTotal: start0.roundsTotal,
  });
  check(start0.upperTarget === 63 && start0.upperBonusValue === 35, '上区奖励门槛应为 63 → +35');
  check(start0.phase === 'roll' && start0.rollsLeft === 3, '开局 phase 应为 roll、剩 3 次掷骰');
  check(start0.dice.every((face: number) => face === 0), '开局骰子应未掷（全 0）');
  check(start0.legalActions.length === 1 && start0.legalActions[0].action === 'roll', '开局 legalActions 应只有 roll');
  check(
    YACHT_CATEGORIES.every((category) => start0.previewScores[category] === null),
    '未掷骰时 previewScores 应全为 null',
  );
  check(start1.currentSeat === 0 && start1.isYourTurn === false, '座位 1 开局不应轮到');
  check(start1.legalActions.length === 0, '非当前回合 legalActions 应为空');

  // 错误分支 1：非自己回合提交
  const wrongTurn = await yachtSubmit(roomId, 1, { action: 'roll' });
  check(wrongTurn.status === 409, '非当前回合提交应 409', wrongTurn.status);
  check(wrongTurn.body?.error === 'not_your_turn', '非当前回合 error 应为 not_your_turn', wrongTurn.body);
  check(
    Array.isArray(wrongTurn.body?.legalActions) && wrongTurn.body.legalActions.length === 0,
    'not_your_turn 的 legalActions 应为空',
    wrongTurn.body?.legalActions,
  );
  console.log('  🔎 not_your_turn ✅ 409（非当前回合提交被拒）');

  const used: Record<number, Set<string>> = { 0: new Set(), 1: new Set() };
  const handDice: number[][] = [];
  let scoreEvents = 0;
  let rollEvents = 0;
  let holdEvents = 0;
  let mustScoreProbeDone = false;
  let duplicateScoreProbeDone = false;
  let endResult: any = null;
  let guard = 0;

  while (!endResult) {
    if (++guard > 40) throw new CheckFailure('yacht 超过 40 手仍未结束，疑似死循环');

    const globalView = await getObservation(roomId, 0);
    check(globalView.status === 'playing', '对局进行中 status 应为 playing', globalView.status);
    const expectedRound = Math.min(scoreEvents + 1, 26);
    check(globalView.round === expectedRound, 'round 应为「已记格数 + 1」', {
      round: globalView.round,
      expected: expectedRound,
    });
    const current = globalView.currentSeat;
    check(current === 0 || current === 1, 'currentSeat 应为 0 或 1', current);
    const actor = await getObservation(roomId, current);
    const idle = await getObservation(roomId, 1 - current);
    check(actor.isYourTurn === true, '当前行动方 isYourTurn 应为 true');
    check(idle.isYourTurn === false, '非行动方 isYourTurn 应为 false');
    check(idle.legalActions.length === 0, '非行动方 legalActions 应为空');
    check(
      YACHT_CATEGORIES.every((category) => idle.previewScores[category] === null),
      '非行动方 previewScores 应全为 null',
    );
    check(actor.phase === 'roll' && actor.rollsLeft === 3, '每手开始 phase 应为 roll、剩 3 次掷骰', {
      phase: actor.phase,
      rollsLeft: actor.rollsLeft,
    });
    check(actor.dice.every((face: number) => face === 0), '每手开始骰子应归零');
    check(actor.held.every((held: boolean) => held === false), '每手开始锁定状态应清空');
    check(
      actor.legalActions.length === 1 && actor.legalActions[0].action === 'roll',
      'phase=roll 时 legalActions 应只有 roll',
      actor.legalActions,
    );
    check(
      YACHT_CATEGORIES.every((category) => actor.previewScores[category] === null),
      '未掷骰时 previewScores 应全为 null',
    );

    // ── 一手：3 次 roll（第 1 次后按需 hold），最后必须 score ──
    let obs = actor;
    const holdThisHand = scoreEvents % 2 === 0; // 隔手覆盖「hold / 不 hold」两条路径
    for (let rollIndex = 0; rollIndex < 3; rollIndex++) {
      const beforeDice = [...obs.dice];
      const beforeHeld = [...obs.held];
      const beforeRollsLeft = obs.rollsLeft;
      const rollRes = await yachtSubmit(roomId, current, { action: 'roll' });
      check(rollRes.status === 200, 'roll 应返回 200', rollRes.body);
      check(rollRes.body?.ok === true && rollRes.body?.resolved === true, 'roll 应立即结算', rollRes.body);
      const rollEvent = must(
        (rollRes.body.events as any[]).find((event) => event.type === 'roll'),
        'roll 响应应包含 roll 事件',
      );
      check(rollEvent.seat === current, 'roll 事件的 seat 应为当前行动方');
      check(
        Array.isArray(rollEvent.dice) && rollEvent.dice.length === 5,
        'roll 事件应带 5 颗骰子',
        rollEvent.dice,
      );
      rollEvents++;

      obs = await getObservation(roomId, current);
      check(
        Array.isArray(obs.dice) && obs.dice.length === 5 && obs.dice.every((face: number) => Number.isInteger(face) && face >= 1 && face <= 6),
        '掷骰后骰面应为 5 颗 1-6',
        obs.dice,
      );
      check(obs.rollsLeft === beforeRollsLeft - 1, 'rollsLeft 应递减', {
        before: beforeRollsLeft,
        after: obs.rollsLeft,
      });
      check(
        obs.phase === (obs.rollsLeft === 0 ? 'must_score' : 'choice'),
        'phase 应随剩余掷骰次数变化',
        obs.phase,
      );
      for (let index = 0; index < 5; index++) {
        if (beforeHeld[index]) {
          check(obs.dice[index] === beforeDice[index], '已锁定的骰子不应被重掷', { index });
        }
      }
      check(safeJson(obs.held) === safeJson(beforeHeld), 'roll 不应改变锁定状态');

      if (obs.rollsLeft > 0) {
        const legal = obs.legalActions as any[];
        check(legal.filter((a) => a.action === 'roll').length === 1, 'choice 阶段应有 1 个 roll');
        check(
          legal.filter((a) => a.action === 'hold').length === 6,
          'choice 阶段应有 6 个 hold（5 个单颗 + 1 个全解锁）',
          legal.filter((a) => a.action === 'hold').length,
        );
        check(
          legal.filter((a) => a.action === 'score').length === 13 - used[current].size,
          'choice 阶段 score 动作数应为未记格数',
        );
        check(
          legal.length === 20 - used[current].size,
          'choice 阶段 legalActions 总数应为 20 - 已记格数',
          { legal: legal.length, used: used[current].size },
        );
      }

      if (rollIndex === 0 && holdThisHand) {
        // hold 是单颗 toggle：连发两次，分别验证「锁上」与「不解锁其它颗」
        for (const index of [0, 2]) {
          const beforeHold = [...obs.held];
          const holdRes = await yachtSubmit(roomId, current, { action: 'hold', indices: [index] });
          check(holdRes.status === 200, 'hold 应返回 200', holdRes.body);
          check(holdRes.body?.ok === true && holdRes.body?.resolved === true, 'hold 应立即结算', holdRes.body);
          const holdEvent = must(
            (holdRes.body.events as any[]).find((event) => event.type === 'hold'),
            'hold 响应应包含 hold 事件',
          );
          holdEvents++;
          obs = await getObservation(roomId, current);
          check(obs.held[index] === !beforeHold[index], 'hold 应 toggle 单颗锁定状态', {
            index,
            before: beforeHold[index],
            after: obs.held[index],
          });
          check(
            obs.held.every((held: boolean, i: number) => i === index || held === beforeHold[i]),
            '一次 hold 只应影响目标骰子',
            { index, held: obs.held },
          );
          check(obs.phase === 'choice', 'hold 不应改变 phase', obs.phase);
          check(
            safeJson(holdEvent.held) === safeJson(obs.held),
            'hold 事件的 held 应与观测一致',
            { event: holdEvent.held, observation: obs.held },
          );
        }
      }
      if (obs.rollsLeft === 0) break;
    }

    // ── must_score：只能记分 ──
    check(obs.phase === 'must_score', '3 次掷骰后 phase 应为 must_score', obs.phase);
    check(obs.rollsLeft === 0, 'must_score 阶段 rollsLeft 应为 0', obs.rollsLeft);
    const scoreActions = (obs.legalActions as any[]).filter((a) => a.action === 'score');
    check(
      scoreActions.length === 13 - used[current].size,
      'must_score 阶段应只枚举未记格的 score 动作',
      { legal: scoreActions.length, used: used[current].size },
    );
    check(
      (obs.legalActions as any[]).every((a) => a.action === 'score'),
      'must_score 阶段 legalActions 应只含 score',
      obs.legalActions,
    );
    for (const category of YACHT_CATEGORIES) {
      if (used[current].has(category)) {
        check(obs.previewScores[category] === null, `已记格 ${category} 的 preview 应为 null`);
      } else {
        check(typeof obs.previewScores[category] === 'number', `未记格 ${category} 应有 preview 分数`);
      }
    }

    if (!mustScoreProbeDone) {
      const badRoll = await yachtSubmit(roomId, current, { action: 'roll' });
      check(badRoll.status === 409, 'must_score 阶段再 roll 应 409', badRoll.status);
      check(badRoll.body?.error === 'illegal_action', 'must_score 阶段再 roll 应为 illegal_action', badRoll.body);
      check(
        Array.isArray(badRoll.body?.legalActions) && badRoll.body.legalActions.length === scoreActions.length,
        'must_score 阶段 roll 的 409 应回带 score legalActions',
        badRoll.body?.legalActions,
      );
      check(
        badRoll.body.legalActions.every((a: any) => a.action === 'score'),
        'must_score 阶段 409 的 legalActions 应只含 score',
      );
      const badHold = await yachtSubmit(roomId, current, { action: 'hold', indices: [0] });
      check(badHold.status === 409, 'must_score 阶段 hold 应 409', badHold.status);
      check(badHold.body?.error === 'illegal_action', 'must_score 阶段 hold 应为 illegal_action', badHold.body);
      mustScoreProbeDone = true;
      console.log('  🔎 must_score ✅ roll / hold 均 409 illegal_action + score legalActions');
    }

    if (!duplicateScoreProbeDone && used[current].size > 0) {
      const usedCategory = [...used[current]][0];
      const duplicate = await yachtSubmit(roomId, current, { action: 'score', category: usedCategory });
      check(duplicate.status === 409, '重复记同一格应 409', duplicate.status);
      check(duplicate.body?.error === 'illegal_action', '重复记同一格应为 illegal_action', duplicate.body);
      check(
        Array.isArray(duplicate.body?.legalActions) && duplicate.body.legalActions.length === scoreActions.length,
        '重复记格的 409 应回带 legalActions',
      );
      check(
        !duplicate.body.legalActions.some((a: any) => a.category === usedCategory),
        '409 的 legalActions 不应包含已记格',
      );
      duplicateScoreProbeDone = true;
      console.log(`  🔎 重复记格 ✅ 409 illegal_action（${usedCategory} 已用过）`);
    }

    // 选当前骰面预览分最高的未记格
    const ranked = [...scoreActions].sort((a, b) => {
      const diff = Number(obs.previewScores[b.category]) - Number(obs.previewScores[a.category]);
      return diff !== 0 ? diff : String(a.category).localeCompare(String(b.category));
    });
    const bestCategory = String(ranked[0].category);
    const expectedGain = Number(obs.previewScores[bestCategory]);
    check(Number.isInteger(expectedGain) && expectedGain >= 0, '预览分应为非负整数', expectedGain);
    const beforeCard = globalView.scorecards[current];
    check(beforeCard !== undefined, '应有当前座位计分板快照');

    const scoreRes = await yachtSubmit(roomId, current, { action: 'score', category: bestCategory });
    check(scoreRes.status === 200, 'score 应返回 200', scoreRes.body);
    check(scoreRes.body?.ok === true && scoreRes.body?.resolved === true, 'score 应立即结算', scoreRes.body);
    const scoreEvent = must(
      (scoreRes.body.events as any[]).find((event) => event.type === 'score'),
      'score 响应应包含 score 事件',
    );
    const endEvent = ((scoreRes.body.events as any[]).find((event) => event.type === 'end') as any | undefined) ?? null;
    check(scoreEvent.seat === current && scoreEvent.category === bestCategory, 'score 事件字段应与提交一致', scoreEvent);
    check(scoreEvent.gained === expectedGain, 'score 事件的 gained 应等于预览分', {
      gained: scoreEvent.gained,
      expectedGain,
    });
    check(
      scoreEvent.nextSeat === (endEvent ? null : 1 - current),
      'score 事件的 nextSeat 应正确',
      scoreEvent.nextSeat,
    );
    scoreEvents++;
    used[current].add(bestCategory);
    handDice.push([...obs.dice]);

    const after0 = await getObservation(roomId, 0);
    const afterActor = await getObservation(roomId, current);
    const card = afterActor.scorecards[current];
    check(card[bestCategory] === expectedGain, '计分卡应记录本手得分', {
      category: bestCategory,
      card: card[bestCategory],
      expectedGain,
    });
    check(card.total === scoreEvent.scorecard.total, 'score 事件的 scorecard 应与观测一致');
    const expectedTotal = beforeCard.total + expectedGain + (card.upperBonus - beforeCard.upperBonus);
    check(card.total === expectedTotal, '计分卡总分应为旧分 + 本手得分 + 新增上区奖励', {
      before: beforeCard.total,
      gained: expectedGain,
      bonusDelta: card.upperBonus - beforeCard.upperBonus,
      total: card.total,
    });
    check(after0.scores[current] === card.total, 'scores 应同步为 scorecard.total');
    check(after0.scores[1 - current] === beforeCardOpponentTotal(globalView, current), '对手总分不应变化');
    for (const seat of [0, 1] as const) {
      check(after0.scores[seat] === after0.scorecards[seat].total, `scores[${seat}] 应等于 scorecards[${seat}].total`);
      check(
        after0.scorecards[seat].upperBonus === (after0.scorecards[seat].upperSubtotal >= 63 ? 35 : 0),
        `座位 ${seat} 的上区奖励应正确`,
      );
      check(
        after0.scorecards[seat].total ===
          after0.scorecards[seat].upperSubtotal + after0.scorecards[seat].upperBonus + sumLower(after0.scorecards[seat]),
        `座位 ${seat} 的 total 应等于 小计 + 奖励 + 下区`,
      );
    }

    console.log(
      `[${label}] 第 ${scoreEvents}/26 手 seat${current} · ${YACHT_LABELS[bestCategory as YachtCategory] ?? bestCategory} +${expectedGain} · 总分 ${after0.scores[0]}:${after0.scores[1]}`,
    );

    if (endEvent) {
      endResult = endEvent.result;
      check(scoreEvents === 26, '终局时应恰好记满 26 手', scoreEvents);
      break;
    }

    // 换手断言
    const nextSeat = 1 - current;
    check(after0.currentSeat === nextSeat, 'score 后应换手', after0.currentSeat);
    const nextObs = await getObservation(roomId, nextSeat);
    check(nextObs.currentSeat === nextSeat && nextObs.isYourTurn === true, '下一行动方 isYourTurn 应为 true');
    check(nextObs.phase === 'roll' && nextObs.rollsLeft === 3, '换手后应重置为 roll / 3 次掷骰');
    check(
      nextObs.dice.every((face: number) => face === 0) && nextObs.held.every((held: boolean) => held === false),
      '换手后骰子与锁定应重置',
    );
    check(
      nextObs.legalActions.length === 1 && nextObs.legalActions[0].action === 'roll',
      '换手后 legalActions 应只有 roll',
    );
    const oldObs = await getObservation(roomId, current);
    check(oldObs.isYourTurn === false && oldObs.legalActions.length === 0, '交棒方应无合法动作');
  }

  // ── 终局断言 ──
  const finalResult = must(endResult, 'yacht 应以 end 事件结束');
  check(scoreEvents === 26, '应恰好打满 26 手', scoreEvents);
  check(handDice.length === 26, '应记录 26 手骰面');
  check(used[0].size === 13 && used[1].size === 13, '双方应各记满 13 格', {
    seat0: used[0].size,
    seat1: used[1].size,
  });

  const final0 = await getObservation(roomId, 0);
  const final1 = await getObservation(roomId, 1);
  for (const [name, obs] of [
    ['seat0', final0],
    ['seat1', final1],
  ] as const) {
    check(obs.status === 'ended', `${name} 终局 status 应为 ended`);
    check(obs.legalActions.length === 0, `${name} 终局 legalActions 应为空`);
    check(obs.currentSeat === null, `${name} 终局 currentSeat 应为 null`);
    check(obs.isYourTurn === false, `${name} 终局 isYourTurn 应为 false`);
    check(obs.round === 26 && obs.roundsTotal === 26, `${name} 终局 round/roundsTotal 应为 26`, {
      round: obs.round,
      roundsTotal: obs.roundsTotal,
    });
    check(obs.result !== null && safeJson(obs.result) === safeJson(finalResult), `${name} 的 result 应等于 end 事件`);
    for (const seat of [0, 1] as const) {
      const card = obs.scorecards[seat];
      const filled = YACHT_CATEGORIES.filter((category) => card[category] !== null).length;
      check(filled === 13, `${name} 视角座位 ${seat} 应有 13 格填满`, filled);
      check(obs.scores[seat] === card.total, `${name} 视角 scores[${seat}] 应等于 scorecard.total`);
    }
  }
  check(safeJson(final0.scorecards) === safeJson(final1.scorecards), '双方视角计分板应一致');
  check(safeJson(final0.scores) === safeJson(final1.scores), '双方视角总分应一致');

  const finalScores = { '0': num(final0.scores, 0), '1': num(final0.scores, 1) };
  const expectedWinner = finalScores['0'] === finalScores['1'] ? null : finalScores['0'] > finalScores['1'] ? 0 : 1;
  check(finalResult.winner === expectedWinner, 'result.winner 应与总分大小一致', {
    winner: finalResult.winner,
    scores: finalScores,
  });
  check(
    num(finalResult.scores, 0) === finalScores['0'] && num(finalResult.scores, 1) === finalScores['1'],
    'result.scores 应等于终局总分',
  );
  check(typeof finalResult.text === 'string' && finalResult.text.length > 0, 'result.text 不应为空');

  const resultRes = await api(`/api/rooms/${roomId}/result`);
  check(resultRes.status === 200 && safeJson(resultRes.body) === safeJson(finalResult), 'GET /result 应等于终局结果');

  const late = await yachtSubmit(roomId, 0, { action: 'roll' });
  check(late.status === 409 && late.body?.error === 'room_ended', '终局后再提交应 409 room_ended', late.body);

  const logRes = await api(`/api/rooms/${roomId}/log?seat=0`);
  check(logRes.status === 200, 'GET /log 应返回 200');
  check(logRes.body?.gameId === 'yacht', '日志 gameId 应为 yacht');
  check(typeof logRes.body?.seed === 'number', '日志应带 seed');
  const logEvents = (logRes.body.events as { event: any }[]).map((entry) => entry.event);
  const logRolls = logEvents.filter((event) => event.type === 'roll');
  const logHolds = logEvents.filter((event) => event.type === 'hold');
  const logScores = logEvents.filter((event) => event.type === 'score');
  check(logRolls.length === rollEvents, '日志 roll 事件数应与实战一致', {
    log: logRolls.length,
    played: rollEvents,
  });
  check(logHolds.length === holdEvents, '日志 hold 事件数应与实战一致', {
    log: logHolds.length,
    played: holdEvents,
  });
  check(logScores.length === 26, '日志 score 事件应为 26', logScores.length);
  check(logEvents.some((event) => event.type === 'end'), '日志应含 end 事件');
  check(
    logRolls.every(
      (event: any) =>
        Array.isArray(event.dice) &&
        event.dice.length === 5 &&
        event.dice.every((face: number) => face >= 1 && face <= 6),
    ),
    '日志 dice 序列应为合法的 5 颗 1-6',
  );
  for (const seat of [0, 1] as const) {
    const gainedSum = logScores
      .filter((event: any) => event.seat === seat)
      .reduce((total: number, event: any) => total + Number(event.gained ?? 0), 0);
    check(
      gainedSum + final0.scorecards[seat].upperBonus === final0.scores[seat],
      `座位 ${seat} 的 13 手得分之和 + 上区奖励应等于总分`,
      {
        gainedSum,
        upperBonus: final0.scorecards[seat].upperBonus,
        total: final0.scores[seat],
      },
    );
    check(
      logScores.filter((event: any) => event.seat === seat).length === 13,
      `座位 ${seat} 在日志里应恰好记 13 手`,
    );
  }
  check(safeJson(logRes.body.result) === safeJson(finalResult), '日志 result 应等于终局结果');

  const firstFiveDice = handDice.slice(0, 5).map((dice) => dice.join(''));
  console.log(`  🎲 前 5 手终局骰面: ${firstFiveDice.join(' / ')}`);
  console.log(
    `\n🏁 ${label} 结束：26 手 · 座位0 ${finalScores['0']} : ${finalScores['1']} 座位1 · ${finalResult.text}`,
  );

  return {
    game: 'yacht',
    label,
    roomId,
    rounds: 26,
    final: finalScores,
    result: finalResult,
    wsSummary: null,
  };
}

/** 对手总分（取全局观测里另一边座位的 total）。 */
function beforeCardOpponentTotal(globalView: any, current: number): number {
  return Number(globalView.scorecards[1 - current]?.total ?? 0);
}

// ────────────────────────────── 入口 ──────────────────────────────

function buildConfigs(count: number): GameConfig[] {
  const configs: GameConfig[] = [
    { label: 'game-1', probes: true, ws: true, forceCollisionFirst: true },
    { label: 'game-2', avoidCollision: true },
    { label: 'game-3' },
  ];
  for (let i = 4; i <= count; i++) configs.push({ label: `game-${i}` });
  return configs.slice(0, count);
}

/** 解析 --game / --games（逗号分隔，支持 all）与 E2E_GAME 环境变量；默认全跑。 */
function parseGames(argv: string[]): GameId[] {
  const raw: string[] = [];
  const pushIds = (text: string): void => {
    // pnpm 有时会把逗号分隔的参数重新拼成空格，这里两种分隔都接受
    raw.push(...text.split(/[,\s]+/));
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || arg === '--') continue;
    const inline = arg.match(/^--games?=(.*)$/);
    if (inline) {
      pushIds(inline[1]);
      continue;
    }
    if (arg === '--game' || arg === '--games') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        pushIds(next);
        i++;
      }
      continue;
    }
  }
  const envList = (process.env.E2E_GAME ?? '').trim();
  if (raw.length === 0 && envList) pushIds(envList);
  if (raw.length === 0) return [...ALL_GAMES];

  const picked: GameId[] = [];
  for (const item of raw) {
    const id = item.trim().toLowerCase();
    if (!id) continue;
    if (id === 'all') {
      for (const gameId of ALL_GAMES) if (!picked.includes(gameId)) picked.push(gameId);
      continue;
    }
    if (!(ALL_GAMES as readonly string[]).includes(id)) {
      throw new CheckFailure(`未知游戏 "${id}"；可选：${ALL_GAMES.join(' / ')} / all`);
    }
    if (!picked.includes(id as GameId)) picked.push(id as GameId);
  }
  if (picked.length === 0) throw new CheckFailure('--game 未指定有效游戏');
  return picked;
}

async function ensureServer(games: GameId[]): Promise<void> {
  let health: ApiResponse;
  try {
    health = await api('/api/games');
  } catch (err) {
    const cause = (err as { cause?: { message?: string } })?.cause?.message;
    console.error(`\n❌ 连不上服务端 ${BASE}`);
    console.error(`   原始错误: ${(err as Error).message}${cause ? `（${cause}）` : ''}`);
    console.error('   请先启动服务：');
    console.error('     pnpm -C packages/server start');
    console.error('   如需换端口：');
    console.error('     $env:PORT=8799; pnpm -C packages/server start   # 另开终端');
    console.error('     $env:PORT=8799; pnpm e2e');
    process.exit(1);
  }
  check(health.status === 200, 'GET /api/games 应返回 200', health.status);
  check(Array.isArray(health.body?.games), 'GET /api/games 应返回 games 数组', health.body);
  GAME_META.clear();
  for (const meta of health.body.games as any[]) GAME_META.set(meta.id, meta);

  for (const gameId of games) {
    const meta = must(GAME_META.get(gameId), `服务端应提供 ${gameId}（GET /api/games 未找到）`);
    check(typeof meta.rules === 'string' && meta.rules.length > 0, `${gameId} 应带 rules 全文`);
    check(meta.seats === 2, `${gameId} 应为 2 座游戏`);
  }
  const statuses = games.map((gameId) => `${gameId}(${GAME_META.get(gameId)?.status ?? '?'})`).join(' · ');
  console.log(`🔗 服务端可达：${BASE} · ${statuses}`);
}

// ═══════════════════════════ 猜拳心理战（rps-duel）═══════════════════════════

type RpsShape = 'rock' | 'paper' | 'scissors';

const RPS_BEATS: Record<RpsShape, RpsShape> = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

function rpsWinner(a: RpsShape, b: RpsShape): 0 | 1 | null {
  if (a === b) return null;
  return RPS_BEATS[a] === b ? 0 : 1;
}

function throwShape(shape: RpsShape): Record<string, unknown> {
  return { action: 'throw', shape };
}

/**
 * 一局猜拳：脚本每项 = [先提交的座位, 座位0出手, 座位1出手]。
 * 先手交替，覆盖「先提交方拿不到结算事件」这条同时暗选语义。
 */
async function playRpsDuel(
  label: string,
  script: Array<[0 | 1, RpsShape, RpsShape]>,
): Promise<GameReport> {
  console.log(`\n──────── ${label}（rps-duel）────────`);
  const room = await createRoomForGame('rps-duel');
  const roomId = room.roomId;
  await joinBoth(roomId);

  const start0 = await getObservation(roomId, 0);
  const start1 = await getObservation(roomId, 1);
  check(start0.status === 'playing', 'rps-duel 入座后 status 应为 playing', start0.status);
  check(start0.currentSeat === null, 'simultaneous 不应有 currentSeat', start0.currentSeat);
  check(start0.round === 1 && start0.roundsTotal === 3, 'rps-duel 开局应为第 1/3 局', {
    round: start0.round,
    roundsTotal: start0.roundsTotal,
  });
  check(start0.currentRoundPoints === 1, '第 1 局应值 1 分', start0.currentRoundPoints);
  check(
    safeJson(start0.roundPoints) === safeJson([1, 1, 2]),
    'roundPoints 应为 [1,1,2]（决胜局翻倍）',
    start0.roundPoints,
  );
  check(start0.history.length === 0 && start0.lastRound === null, '开局不应有历史');
  check(start0.youSubmitted === false, '开局不该已提交');
  check(!('yourPending' in start0), '观测不应携带挂起动作（防 ?seat=X 偷看）');
  check(start0.legalActions.length === 3, '开局应有 3 种出手', start0.legalActions);
  check(
    safeJson(start0.legalActions.map((a: any) => a.shape).sort()) ===
      safeJson(['paper', 'rock', 'scissors']),
    'legalActions 应覆盖石头/布/剪刀',
    start0.legalActions,
  );
  check(
    safeJson(start0.legalActions) === safeJson(start1.legalActions),
    '双方看到的合法出手应一致',
  );
  check(start0.textView.includes('第 1/3 局'), 'textView 应标出第 1/3 局', start0.textView);
  check(start0.scores['0'] === 0 && start0.scores['1'] === 0, '开局比分应为 0:0');

  let score0 = 0;
  let score1 = 0;
  let illegalProbed = false;

  for (let i = 0; i < script.length; i++) {
    const [firstSeat, s0, s1] = script[i];
    const secondSeat = (1 - firstSeat) as 0 | 1;
    const shapes: Record<0 | 1, RpsShape> = { 0: s0, 1: s1 };
    const roundNo = i + 1;
    const expectedPoints = roundNo === 3 ? 2 : 1;

    const before = await getObservation(roomId, 0);
    check(before.status === 'playing', `第 ${roundNo} 局开始前 status 应为 playing`);
    check(before.round === roundNo, `第 ${roundNo} 局 round 应为 ${roundNo}`, before.round);
    check(
      before.currentRoundPoints === expectedPoints,
      `第 ${roundNo} 局应值 ${expectedPoints} 分`,
      before.currentRoundPoints,
    );

    // 非法出手探测（只做一次）
    if (!illegalProbed) {
      const bad = await submitRaw(roomId, firstSeat, { action: 'throw', shape: 'lizard' });
      check(bad.status === 409, '非法出手应 409', bad.status);
      check(bad.body?.error === 'illegal_action', '非法出手 error 应为 illegal_action', bad.body);
      check(
        Array.isArray(bad.body?.legalActions) && bad.body.legalActions.length === 3,
        'illegal_action 应回带 3 条合法出手',
        bad.body?.legalActions,
      );
      console.log('  🔎 illegal_action ✅ 409（shape=lizard 被拒，回带 3 条合法出手）');
      illegalProbed = true;
    }

    // 先提交的一方：不结算，自己读得回，对手看不到
    const firstRes = await submitRaw(roomId, firstSeat, throwShape(shapes[firstSeat]));
    check(firstRes.status === 200, `第 ${roundNo} 局先手提交应 200`, firstRes.status);
    check(firstRes.body?.resolved === false, '先提交不应结算', firstRes.body);
    check(
      Array.isArray(firstRes.body?.events) && firstRes.body.events.length === 0,
      '先提交不应返回事件',
      firstRes.body?.events,
    );

    const mine = await getObservation(roomId, firstSeat);
    const theirs = await getObservation(roomId, secondSeat);
    check(mine.youSubmitted === true, '先手方 youSubmitted 应为 true');
    check(!('yourPending' in mine), '观测不应携带挂起动作（防对手 ?seat=X 偷看）');
    check(theirs.youSubmitted === false, '后手方 youSubmitted 应为 false');
    check(!('yourPending' in theirs), '对手视角更不应有挂起动作');
    check(
      safeJson(mine.waitingFor) === safeJson([secondSeat]),
      '只应等后手方提交',
      mine.waitingFor,
    );
    check(before.history.length === roundNo - 1, '结算前历史不应增加');

    // 同一座位同一局重复提交 → 409，且不覆盖第一次出手
    const dupAction = throwShape(shapes[firstSeat] === 'rock' ? 'paper' : 'rock');
    const dup = await submitRaw(roomId, firstSeat, dupAction);
    check(dup.status === 409, '重复提交应 409', dup.status);
    check(
      dup.body?.error === 'action_already_submitted',
      '重复提交 error 应为 action_already_submitted',
      dup.body,
    );

    // 后手方提交 → 结算
    const secondRes = await submitRaw(roomId, secondSeat, throwShape(shapes[secondSeat]));
    check(secondRes.status === 200, `第 ${roundNo} 局后手提交应 200`);
    check(secondRes.body?.resolved === true, '双方到齐应立即结算', secondRes.body);
    const reveal = (secondRes.body?.events ?? []).find((e: any) => e?.type === 'reveal');
    check(Boolean(reveal), '结算事件应包含 reveal', secondRes.body?.events);
    check(reveal.round === roundNo, `reveal.round 应为 ${roundNo}`, reveal.round);
    check(reveal.points === expectedPoints, `reveal.points 应为 ${expectedPoints}`, reveal.points);
    check(
      safeJson(reveal.shapes) === safeJson({ 0: s0, 1: s1 }),
      'reveal.shapes 应与双方出手一致',
      reveal.shapes,
    );
    const expectWinner = rpsWinner(s0, s1);
    check(reveal.winner === expectWinner, 'reveal.winner 应与猜拳规则一致', {
      shapes: { s0, s1 },
      winner: reveal.winner,
      expectWinner,
    });

    if (expectWinner === 0) score0 += expectedPoints;
    if (expectWinner === 1) score1 += expectedPoints;

    const after = await getObservation(roomId, 0);
    check(after.scores['0'] === score0 && after.scores['1'] === score1, '累计比分应与脚本一致', {
      scores: after.scores,
      expect: { score0, score1 },
    });
    check(after.history.length === roundNo, `历史应有 ${roundNo} 局`, after.history.length);
    check(!('yourPending' in after), '结算后观测依然不含动作内容');

    // 座位相对历史：双方各看各的
    const h0 = after.history[roundNo - 1];
    check(h0.yourShape === s0 && h0.opponentShape === s1, 'seat0 历史的出手方向应正确', h0);
    const expectOutcome = expectWinner === 0 ? 'win' : expectWinner === 1 ? 'lose' : 'draw';
    check(h0.outcome === expectOutcome, 'seat0 历史结果应正确', h0);
    const after1 = await getObservation(roomId, 1);
    const h1 = after1.history[roundNo - 1];
    check(h1.yourShape === s1 && h1.opponentShape === s0, 'seat1 历史的出手方向应相反', h1);
  }

  // 终局
  const end = await getObservation(roomId, 0);
  check(end.status === 'ended', '三局打完 status 应为 ended', end.status);
  check(end.round === 3, '结束后 round 应显示已打 3 局', end.round);
  check(end.currentRoundPoints === null, '终局 currentRoundPoints 应为 null');
  check(end.currentSeat === null, '终局不应有 currentSeat');
  check(end.legalActions.length === 0, '终局 legalActions 应为空');
  check(end.textView.includes('三局已打完'), 'textView 应带结束文案', end.textView);

  const resultRes = await api(`/api/rooms/${roomId}/result`);
  check(resultRes.status === 200, '结算接口应 200', resultRes.status);
  const result = resultRes.body as { winner: number | null; scores: Scores; text: string };
  const expectWinner = score0 === score1 ? null : score0 > score1 ? 0 : 1;
  check(result.winner === expectWinner, 'result.winner 应与比分一致', {
    winner: result.winner,
    expectWinner,
    scores: result.scores,
  });
  check(
    result.scores['0'] === score0 && result.scores['1'] === score1,
    'result.scores 应与脚本累计一致',
    result.scores,
  );
  check(typeof result.text === 'string' && result.text.length > 0, 'result.text 不应为空');

  const late = await submitRaw(roomId, 0, throwShape('rock'));
  check(late.status === 409, '终局后提交应 409', late.status);
  check(late.body?.error === 'room_ended', '终局后提交 error 应为 room_ended', late.body);

  // 终局后 seed 才公开（反作弊）
  const log = await api(`/api/rooms/${roomId}/log?seat=0`);
  check(log.status === 200, '终局日志应 200', log.status);
  check(typeof log.body?.seed === 'number', '终局后日志应公开数字 seed', log.body?.seed);

  const verdict = result.winner === null ? '平局' : `座位 ${result.winner} 胜`;
  console.log(`  🏁 ${score0} : ${score1} · ${verdict}`);

  return {
    game: 'rps-duel',
    label,
    roomId,
    rounds: script.length,
    final: { 0: score0, 1: score1 },
    result,
    wsSummary: null,
  };
}

// ═══════════════════════════ 深海猎手（battleship）═══════════════════════════

function fireAction(cell: Coord): Record<string, unknown> {
  return { action: 'fire', cell: [cell[0], cell[1]] };
}

/**
 * 深海猎手：黑盒打法（人类/Agent 都看不到对手布阵）。
 * 每次读当前行动方的 legalActions 取第一项，靠事件验证「命中连射」与终局。
 */
async function playBattleship(label: string): Promise<GameReport> {
  console.log(`\n──────── ${label}（battleship）────────`);
  const room = await createRoomForGame('battleship');
  const roomId = room.roomId;
  await joinBoth(roomId);

  const start0 = await getObservation(roomId, 0);
  const start1 = await getObservation(roomId, 1);
  check(start0.status === 'playing', 'battleship 入座后 status 应为 playing', start0.status);
  check(start0.currentSeat === 0 && start0.isYourTurn === true, 'battleship 应由座位 0 先手');
  check(start0.legalActions.length === 25, '开局应有 25 个可炮击格', start0.legalActions.length);
  check(start0.yourFleet.length === 2, '自己应有 2 艘船', start0.yourFleet);
  check(
    start0.yourFleet.reduce((n: number, s: any) => n + s.cells.length, 0) === 3,
    '自己舰队共占 3 格',
  );
  check(
    start0.enemyGrid.length === 5 && start0.enemyGrid.every((row: string[]) => row.length === 5),
    '敌方海域应为 5×5',
  );
  check(
    start0.enemyGrid.every((row: string[]) => row.every((c) => c === 'unknown')),
    '开局敌方海域应全 unknown（不泄露布阵）',
  );
  check(
    safeJson(start0.scores) === safeJson({ 0: 2, 1: 2 }),
    '开局双方剩余艘数应为 2:2',
    start0.scores,
  );
  check(start1.isYourTurn === false, '座位 1 开局不应轮到');
  check(start1.legalActions.length === 0, '非行动方 legalActions 应为空');
  check(start0.textView.includes('敌方海域'), 'textView 应包含敌方海域');

  // 第 12 轮最关键的一条：旁观者绝不能借 ?seat=1 读走对手的舰队布阵
  const spectatorView = await readObservation(roomId, 1);
  check(spectatorView.spectator === true, '深海猎手旁观视图应标记 spectator=true', spectatorView.spectator);
  check(
    Array.isArray(spectatorView.yourFleet) && spectatorView.yourFleet.length === 0,
    '旁观视图不应返回任何舰队布阵（yourFleet 必须为空）',
    spectatorView.yourFleet,
  );
  check(spectatorView.shotsFired === 0, '旁观视图 shotsFired 应为 0', spectatorView.shotsFired);
  check(
    Array.isArray(spectatorView.enemyGrid) &&
      spectatorView.enemyGrid.every(
        (row: string[]) => Array.isArray(row) && row.every((cell) => cell === 'unknown'),
      ),
    '旁观视图敌方海域应全 unknown（不泄露已打结果之外的布阵）',
    spectatorView.enemyGrid,
  );
  console.log('  🔎 深海猎手旁观视图 ✅ 无舰队布阵 / 全 unknown / shotsFired=0');

  // 越界
  const oob = await submitRaw(roomId, 0, { action: 'fire', cell: [9, 9] });
  check(oob.status === 409, '越界炮击应 409', oob.status);
  check(oob.body?.error === 'illegal_action', '越界 error 应为 illegal_action');
  // 抢跑
  const early = await submitRaw(roomId, 1, { action: 'fire', cell: [0, 0] });
  check(early.status === 409 && early.body?.error === 'not_your_turn', '非行动方提交应 not_your_turn', early.body);

  let shots = 0;
  let hits = 0;
  let chains = 0;
  let endResult: any = null;
  while (!endResult) {
    if (++shots > 80) throw new CheckFailure('battleship 超过 80 炮仍未结束');
    const view = await getObservation(roomId, 0);
    const seat = view.currentSeat;
    check(seat === 0 || seat === 1, '进行中应有当前行动方', seat);
    const actor = await getObservation(roomId, seat);
    check(actor.isYourTurn === true, '行动方 isYourTurn 应为 true');
    const idle = await getObservation(roomId, 1 - seat);
    check(idle.legalActions.length === 0, '非行动方 legalActions 应为空');

    const action = actor.legalActions[0];
    check(Boolean(action), '行动方应有可炮击的格子');
    check(action.action === 'fire', 'legalActions 形状应为 fire');
    const cell = action.cell as Coord;

    const res = await submitRaw(roomId, seat, fireAction(cell));
    check(res.status === 200, `第 ${shots} 炮应 200`, res.body);
    check(res.body?.resolved === true, 'turn 模式单方提交应立即结算');
    const fire = (res.body?.events ?? []).find((e: any) => e?.type === 'fire');
    check(Boolean(fire), '结算事件应含 fire', res.body?.events);
    check(fire.seat === seat, 'fire.seat 应为行动方');
    check(safeJson(fire.cell) === safeJson(cell), 'fire.cell 应与提交一致');
    check(typeof fire.hit === 'boolean', 'fire.hit 应为布尔');

    if (fire.hit) hits++;
    const expectedNext = fire.hit ? seat : 1 - seat;
    check(
      fire.nextSeat === expectedNext || fire.nextSeat === null,
      '命中应连射、未命中应换手（终局除外）',
      { hit: fire.hit, nextSeat: fire.nextSeat, expectedNext },
    );
    if (fire.hit) chains++;

    // 视角校验：敌方海域只透出打过的格子
    const mine = await getObservation(roomId, seat);
    check(
      mine.enemyGrid[cell[0]][cell[1]] !== 'unknown',
      '自己刚打的格子应已透出结果',
      mine.enemyGrid[cell[0]][cell[1]],
    );

    const end = (res.body?.events ?? []).find((e: any) => e?.type === 'end');
    if (end) endResult = end.result;
  }

  const done = await getObservation(roomId, 0);
  check(done.status === 'ended', '打完全部船后 status 应为 ended', done.status);
  check(done.currentSeat === null, '终局不应有 currentSeat');
  check(done.legalActions.length === 0, '终局 legalActions 应为空');
  check(Boolean(endResult), '最后一炮应带 end 事件');
  const loser = endResult.winner === 0 ? 1 : 0;
  check(endResult.scores[String(loser)] === 0, '败方剩余艘数应为 0', endResult.scores);
  check(endResult.scores[String(endResult.winner)] > 0, '胜方应还有船', endResult.scores);

  const log = await api(`/api/rooms/${roomId}/log?seat=0`);
  check(log.status === 200, '终局日志应 200');
  check(typeof log.body?.seed === 'number', '终局后应公开 seed', log.body?.seed);

  console.log(`  🎯 ${shots} 炮（命中 ${hits} 次，连射 ${chains} 次）→ ${endResult.text}`);

  return {
    game: 'battleship',
    label,
    roomId,
    rounds: shots,
    final: endResult.scores,
    result: endResult,
    wsSummary: null,
  };
}

// ═══════════════════════════ 黑白棋（reversi）═══════════════════════════

function placeAction(cell: Coord): Record<string, unknown> {
  return { action: 'place', cell: [cell[0], cell[1]] };
}

function discCount(state: any): number {
  return state.board.flat().filter((c: unknown) => c === 0 || c === 1).length;
}

async function playReversi(label: string): Promise<GameReport> {
  console.log(`\n──────── ${label}（reversi）────────`);
  const room = await createRoomForGame('reversi');
  const roomId = room.roomId;
  await joinBoth(roomId);

  const start0 = await getObservation(roomId, 0);
  const start1 = await getObservation(roomId, 1);
  check(start0.status === 'playing', 'reversi 入座后 status 应为 playing');
  check(start0.currentSeat === 0 && start0.isYourTurn === true, 'reversi 应由座位 0 先手');
  check(start0.legalActions.length === 4, '开局应有 4 个合法落点', start0.legalActions);
  check(
    start0.board.length === 8 && start0.board.every((row: unknown[]) => row.length === 8),
    '棋盘应为 8×8',
  );
  check(discCount(start0) === 4, '开局应有 4 子');
  check(
    safeJson(start0.scores) === safeJson({ 0: 2, 1: 2 }),
    '开局双方应各 2 子',
    start0.scores,
  );
  check(start0.textView.includes('A B C D E F G H'), 'textView 应带 A–H 列标');
  check(start1.isYourTurn === false, '座位 1 开局不应轮到');
  check(start1.legalActions.length === 0, '非行动方 legalActions 应为空');

  // 已占格 / 翻不到子 → 409
  const occupied = await submitRaw(roomId, 0, placeAction([3, 3]));
  check(occupied.status === 409 && occupied.body?.error === 'illegal_action', '已占格应 409', occupied.body);
  check(Array.isArray(occupied.body?.legalActions) && occupied.body.legalActions.length === 4, '409 应回带 legalActions');
  // 抢跑
  const early = await submitRaw(roomId, 1, placeAction([2, 3]));
  check(early.status === 409 && early.body?.error === 'not_your_turn', '非行动方落子应 not_your_turn');

  let moves = 0;
  let passes = 0;
  let endResult: any = null;
  let prev = await getObservation(roomId, 0);
  const boardValue = (board: number[][], r: number, c: number) => board[r][c];

  while (!endResult) {
    if (++moves > 70) throw new CheckFailure('reversi 超过 70 手仍未结束');
    const seat = prev.currentSeat;
    check(seat === 0 || seat === 1, '进行中应有当前行动方', seat);
    const legal = (await getObservation(roomId, seat)).legalActions;
    check(legal.length > 0, '行动方应有合法落点（无子可下应由内核自动跳过）');

    const cell = legal[0].cell as Coord;
    const before = discCount(prev);
    const res = await submitRaw(roomId, seat, placeAction(cell));
    check(res.status === 200, `第 ${moves} 手应 200`, res.body);
    check(res.body?.resolved === true, '落子应立即结算');
    const place = (res.body?.events ?? []).find((e: any) => e?.type === 'place');
    check(Boolean(place), '事件应含 place');
    check(place.seat === seat, 'place.seat 应为行动方');
    check(
      Array.isArray(place.flips) && place.flips.length > 0,
      '合法落子至少要翻一枚子',
      place.flips,
    );
    const passEvent = (res.body?.events ?? []).find((e: any) => e?.type === 'pass');
    if (passEvent) {
      passes++;
      check(passEvent.seat === 1 - seat, 'pass 应属于对手');
    }

    const after = await getObservation(roomId, 0);
    // 盘面：落点变成本方颜色，被翻的格子也变成本方
    const boardAfter = after.board as number[][];
    check(
      boardAfter[cell[0]][cell[1]] === seat,
      '落点应变成落子方的颜色',
      boardValue(boardAfter, cell[0], cell[1]),
    );
    for (const [r, c] of place.flips as Coord[]) {
      check(boardAfter[r][c] === seat, `被翻的 ${r},${c} 应变成本方颜色`);
    }
    check(
      discCount(after) === before + 1,
      '每手只增加一枚棋子',
      { before, after: discCount(after) },
    );
    check(
      after.scores['0'] + after.scores['1'] === discCount(after),
      'scores 应等于盘面子数',
      after.scores,
    );

    const end = (res.body?.events ?? []).find((e: any) => e?.type === 'end');
    if (end) endResult = end.result;
    prev = after;
    if (endResult) break;
    check(after.status === 'playing', '未终局时 status 应为 playing');
  }

  const done = await getObservation(roomId, 0);
  check(done.status === 'ended', '终局 status 应为 ended');
  check(done.currentSeat === null, '终局不应有 currentSeat');
  check(done.legalActions.length === 0, '终局 legalActions 应为空');
  check(done.scores['0'] + done.scores['1'] <= 64, '子数之和不应超过 64', done.scores);
  check(
    endResult.winner === (done.scores['0'] === done.scores['1'] ? null : done.scores['0'] > done.scores['1'] ? 0 : 1),
    'winner 应与子数一致',
    { winner: endResult.winner, scores: done.scores },
  );

  const late = await submitRaw(roomId, 0, placeAction([0, 0]));
  check(late.status === 409 && late.body?.error === 'room_ended', '终局后再落子应 room_ended');

  console.log(
    `  ⚫ ${moves} 手（跳过 ${passes} 次）→ ${done.scores['0']} : ${done.scores['1']} · ${endResult.text}`,
  );

  return {
    game: 'reversi',
    label,
    roomId,
    rounds: moves,
    final: { 0: done.scores['0'], 1: done.scores['1'] },
    result: endResult,
    wsSummary: null,
  };
}

async function main(): Promise<void> {
  const picked = parseGames(process.argv.slice(2));
  console.log('🎪 AI 游乐场 · e2e');
  console.log(`   服务端 ${BASE}`);
  console.log(`   游戏   ${picked.join(' / ')}`);

  await ensureServer(picked);

  const reports: GameReport[] = [];
  if (picked.includes('grab')) {
    const configs = buildConfigs(GAMES_TO_PLAY);
    console.log(`   grab：跑 ${configs.length} 局`);
    for (const config of configs) reports.push(await playGame(config));
  }
  if (picked.includes('connect4')) {
    reports.push(await playConnect4('connect4-1（竖四连胜）', 'vertical-win'));
    reports.push(await playConnect4('connect4-2（满盘平局）', 'draw'));
    reports.push(await playConnect4('connect4-3（随机）', 'random'));
  }
  if (picked.includes('yacht')) {
    reports.push(await playYacht('yacht-1'));
  }
  if (picked.includes('rps-duel')) {
    // 覆盖两种「谁先提交」路径 + 平局局 + 决胜局翻倍 + 2:2 平局
    reports.push(
      await playRpsDuel('rps-duel-1（先赢一局、被决胜局翻盘）', [
        [0, 'rock', 'scissors'],
        [1, 'paper', 'paper'],
        [0, 'scissors', 'rock'],
      ]),
    );
    reports.push(
      await playRpsDuel('rps-duel-2（0:2 落后、决胜局追成 2:2）', [
        [1, 'rock', 'paper'],
        [0, 'rock', 'paper'],
        [1, 'rock', 'scissors'],
      ]),
    );
  }

  if (picked.includes('battleship')) {
    reports.push(await playBattleship('battleship-1'));
  }
  if (picked.includes('reversi')) {
    reports.push(await playReversi('reversi-1'));
  }

  console.log('\n════════════════ 总结 ════════════════');
  let totalMoves = 0;
  const byGame = new Map<string, { games: number; moves: number }>();
  for (const report of reports) {
    totalMoves += report.rounds;
    const bucket = byGame.get(report.game) ?? { games: 0, moves: 0 };
    bucket.games++;
    bucket.moves += report.rounds;
    byGame.set(report.game, bucket);
    const winner = report.result.winner === null ? '平局' : `座位 ${report.result.winner} 胜`;
    console.log(
      `  ${report.label}（房间 ${report.roomId}）: ${report.rounds} 手 · ${report.final['0']} : ${report.final['1']} · ${winner}`,
    );
  }
  const parts = [...byGame].map(([gameId, bucket]) => `${gameId} ${bucket.games} 局/${bucket.moves} 手`);
  console.log(`  ${parts.join(' · ')}；合计 ${reports.length} 局 / ${totalMoves} 手，断言 ${assertionCount} 条`);
  console.log('✅ e2e 全部通过');
}

main().catch((err) => {
  console.error('\n❌ e2e 失败');
  if (err instanceof CheckFailure) {
    console.error(err.message);
  } else {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  }
  console.error(`   已执行断言 ${assertionCount} 条`);
  process.exitCode = 1;
});
