/**
 * AI 游乐场 HTTP 客户端（MCP server 与 smoke 测试共用）。
 *
 * 服务地址：process.env.PLAYGROUND_URL ?? "http://127.0.0.1:8787"
 * 只使用 Node 内置 fetch，不额外引入 HTTP 依赖。
 *
 * 约定：seat 0 = 人类，seat 1 = Agent。
 *
 * 第 12 轮（席位鉴权）：`seat` 参数不再代表身份。入座会拿到该座位的席位令牌，
 * 之后所有读/写请求都由本模块自动附加（见下方 seatTokenStore）；
 * 不带令牌的 GET /state 只会得到旁观视图，POST action/say 会被 403 拒绝。
 */

export type Seat = 0 | 1;
export type Coord = [number, number];
export type RoomStatus = 'waiting' | 'playing' | 'ended';

export interface GameInfo {
  id: string;
  name: string;
  tagline: string;
  seats: number;
  rules: string;
  /** playable = 可开桌；wip = 路线图/开发中（需要 allowWip 才能建桌）。 */
  status?: 'playable' | 'wip';
  category?: string;
  tags?: string[];
  duration?: string;
  resolution?: 'simultaneous' | 'turn';
  accent?: string;
}

export interface GameResult {
  winner: number | null;
  scores: Record<string, number>;
  text: string;
}

export interface CreatedRoom {
  roomId: string;
  gameId: string;
  /** 服务端返回的相对路径，例如 /?room=abc&seat=0&token=<hex>（人类座位令牌随链接下发） */
  humanUrlPath: string;
  /** 客户端补全的完整人类入口，例如 http://127.0.0.1:8787/?room=abc&seat=0&token=<hex> */
  humanUrl: string;
  agentSeat: number;
  rules: string;
  /** 是否因为游戏仍是 wip，自动带 allowWip 重试才建成的房间。 */
  wipBypass?: boolean;
  /**
   * 建桌时服务端**预发**的 0 号位令牌（人类座位）。
   * 1 号位不会预发：Agent 必须调用 joinRoom(roomId, 1) 之后才拿到自己的令牌。
   * 契约见 docs/design-auth-round12.md §3.2。
   */
  seatTokens?: Partial<Record<Seat, string>>;
  /** 建桌时顺带绑定的唤醒会话（第 14 轮；没传 sessionId 时为 null / undefined）。 */
  wake?: { boundSessionId: string } | null;
}

/** 唤醒桥绑定结果（POST /api/rooms/:id/bind）。 */
export interface BindWakeResult {
  ok: boolean;
  roomId: string;
  sessionId: string;
  boundAt: number;
}

export interface RoomSummary {
  roomId: string;
  gameId: string;
  status: RoomStatus;
  round: number;
  scores: Record<string, number>;
  occupied: [boolean, boolean];
  pendingSeats: number[];
  result: GameResult | null;
  /** 唤醒桥只读诊断（第 14 轮）：没绑定时 boundSessionId 为 null。 */
  wake?: {
    boundSessionId: string | null;
    lastWakeAt: number | null;
    lastWakeError: string | null;
  };
  humanUrlPath: string;
  /** 客户端补全的完整人类入口 */
  humanUrl: string;
}

export interface ChatMessage {
  id: number;
  seat: number;
  text: string;
  at: number;
}

export interface Observation {
  gameId: string;
  /** 被判定持有的座位；**null = 旁观者**（没带该座位的有效令牌）。 */
  seat: Seat | null;
  /**
   * 是否旁观视图（第 12 轮席位鉴权新增）。
   * true 时 legalActions 恒为 []、私有信息被遮蔽 —— 千万不要把它当成「正常观测」，
   * 否则 Agent 会以为规则不允许自己行动而一直空转。
   */
  spectator?: boolean;
  round: number;
  roundsTotal: number;
  scores: Record<string, number>;
  legalActions: Array<Record<string, unknown>>;
  textView: string;
  status: RoomStatus;
  grid: unknown[][];
  history: unknown[];
  yourScore: number;
  opponentScore: number;
  roomId: string;
  youSubmitted: boolean;
  waitingFor: number[];
  currentSeat?: number | null;
  isYourTurn?: boolean;
  /** yacht：'roll' | 'choice' | 'must_score'（其它游戏没有该字段）。 */
  phase?: string;
  /** yacht：5 颗骰子点数（0 = 本手还没掷）。 */
  dice?: number[];
  /** yacht：5 颗骰子的锁定状态。 */
  held?: boolean[];
  /** yacht：本手还剩几次掷骰。 */
  rollsLeft?: number;
  /** yacht：当前骰面对 13 栏的预览得分（不可记的格子为 null）。 */
  previewScores?: Record<string, number | null>;
  result: GameResult | null;
}

export interface RevealEvent {
  type: 'reveal';
  round: number;
  picks: Record<string, Coord>;
  delta: Record<string, number>;
  applied: Record<string, string>;
  collision: boolean;
  scores: Record<string, number>;
  grid: unknown[][];
}

export interface EndEvent {
  type: 'end';
  result: GameResult;
}

export interface ChatEvent {
  type: 'chat';
  message: ChatMessage;
}

/** yacht：掷骰（held 是掷骰前的锁定状态）。 */
export interface RollEvent {
  type: 'roll';
  seat: number;
  dice: number[];
  held: boolean[];
  rollsLeft: number;
}

/** yacht：锁定 / 解锁（held 是切换后的完整锁定状态）。 */
export interface HoldEvent {
  type: 'hold';
  seat: number;
  held: boolean[];
}

/** yacht：记分（记完立即换手；终局时 nextSeat 为 null）。 */
export interface ScoreEvent {
  type: 'score';
  seat: number;
  category: string;
  gained: number;
  scorecard: Record<string, number | null>;
  nextSeat: number | null;
}

/** connect4：落子。 */
export interface DropEvent {
  type: 'drop';
  seat: number;
  column: number;
  row: number;
}

/** rps-duel：一局揭示（与 grab 的 reveal 形状不同，没有 picks/grid）。 */
export interface RpsRevealEvent {
  type: 'reveal';
  round: number;
  shapes: Record<string, string>;
  winner: number | null;
  points: number;
  delta: Record<string, number>;
  scores: Record<string, number>;
  labels?: Record<string, string>;
}

/** battleship：炮击（命中时 nextSeat 仍是自己，终局为 null）。 */
export interface FireEvent {
  type: 'fire';
  seat: number;
  cell: Coord;
  label?: string;
  hit: boolean;
  sunk: string | null;
  opponentShipsLeft: number;
  nextSeat: number | null;
}

/** reversi：落子 + 翻面。 */
export interface PlaceEvent {
  type: 'place';
  seat: number;
  cell: Coord;
  flips: Coord[];
  counts: Record<string, number>;
  board: unknown[][];
}

/** reversi：无子可下，自动跳过。 */
export interface PassEvent {
  type: 'pass';
  seat: number;
  nextSeat: number;
}

export type GameEvent =
  | RevealEvent
  | RpsRevealEvent
  | EndEvent
  | ChatEvent
  | RollEvent
  | HoldEvent
  | ScoreEvent
  | DropEvent
  | FireEvent
  | PlaceEvent
  | PassEvent;

export interface SubmitResult {
  ok: true;
  resolved: boolean;
  events: GameEvent[];
}

export interface SayResult {
  ok: true;
  message: ChatMessage;
}

export interface ExportLog {
  roomId: string;
  gameId: string;
  /** 只在终局后给出：进行中为 null，避免用 seed 预测后续骰面 */
  seed: number | null;
  seat: number;
  result: GameResult | null;
  rules: string;
  events: Array<{ t: number; event: GameEvent }>;
  createdAt: number;
}

/** 服务端错误码 → 中文人话提示 */
const SERVER_ERROR_HINTS: Record<string, string> = {
  waiting_for_opponent: '对手还没入座。请把人类入口发给人类打开入座，再调用 playground_wait_for_turn 等待。',
  room_ended: '对局已经结束，请调用 playground_get_result 查看结算。',
  seat_not_joined: '该座位还没入座，请先调用 playground_join_room。',
  action_already_submitted: '这个座位本回合已经提交过动作，不能重复提交；请调用 playground_wait_for_turn 等对手。',
  illegal_action: '动作不合法（该格不可选），请从 legalActions 里重新选一格再提交。',
  not_your_turn: '还没轮到你行动：请先调用 playground_wait_for_turn 等自己的回合，不要抢对方的行动。',
  not_found: '接口不存在，请检查 PLAYGROUND_URL 是否指向 AI 游乐场服务。',
  // ── 第 12 轮席位鉴权 ──
  seat_token_required:
    '这个座位需要有效的席位令牌才能行动：本次请求没带令牌，或者令牌已失效' +
    '（房间只在内存里，服务重启 / 房间过期后令牌会一起失效）。\n' +
    '下一步：重新调用 playground_join_room({ roomId, seat }) 入座拿新令牌 —— ' +
    '令牌由本客户端自动保存并附加，Agent 不需要手动处理；拿到后重试本次动作。',
  seat_taken:
    '该座位已经被占用，而且手里的令牌对不上（令牌按座位隔离：0 号位令牌不能用于 1 号位）。\n' +
    '下一步：如果这个房间是别人开的，请让人类把 1 号位的入场链接发给你，或换一个新房间；' +
    '如果是自己开的，先 playground_join_room({ roomId, seat: 1 }) 拿该座位令牌再行动。',
};

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';

export interface PlaygroundApiErrorOptions {
  url: string;
  status?: number | null;
  code?: string | null;
  legalActions?: unknown[] | null;
  body?: unknown;
}

/** 带 HTTP 状态码 / 错误码 / legalActions 的可读错误。 */
export class PlaygroundApiError extends Error {
  readonly url: string;
  readonly status: number | null;
  readonly code: string | null;
  readonly legalActions: unknown[] | null;
  readonly body: unknown;

  constructor(message: string, options: PlaygroundApiErrorOptions) {
    super(message);
    this.name = 'PlaygroundApiError';
    this.url = options.url;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.legalActions = options.legalActions ?? null;
    this.body = options.body;
  }
}

/** 当前服务地址（去掉末尾斜杠）。 */
export function getBaseUrl(): string {
  const raw = process.env.PLAYGROUND_URL?.trim();
  const base = raw && raw.length > 0 ? raw : DEFAULT_BASE_URL;
  return base.replace(/\/+$/, '');
}

/* ────────────────────────── 席位令牌（第 12 轮鉴权） ────────────────────────── */

/**
 * 令牌格式：32 位十六进制（16 字节随机数），见 docs/design-auth-round12.md §3.1。
 * 格式不对的字符串直接不入库，避免把服务端异常响应里的脏数据当成令牌反复重试。
 */
const SEAT_TOKEN_PATTERN = /^[0-9a-f]{32}$/i;

/**
 * 已拿到的席位令牌：roomId → seat → token。
 *
 * 为什么客户端必须自己存：鉴权之后 `seat` 参数不再代表身份，只有令牌对得上
 * `seatTokens[seat]` 才拿得到该座位的私有视图和行动权限；不带令牌的 `GET /state`
 * 会被服务端**降级成旁观视图**（`spectator: true`、`legalActions` 恒为 `[]`）。
 * 如果客户端不自动透传，Agent 看到的是「规则不让我动」而不是「我没入座」，
 * 就会一直空转 —— 所以令牌在客户端统一保管，读/写接口一律自动附加。
 *
 * 生命周期：`joinRoom()` 成功时写入该座位（`createRoom()` 会预写 0 号位），
 * 房间从服务端消失（404 / 房间不存在，通常是服务重启或 TTL 清理）时整间清掉。
 * 403 `seat_token_required` **不清**：令牌和房间同生命周期，此时更可能是这次请求
 * 没带对，清掉反而会丢掉仍然有效的令牌（幂等重入座需要它）。
 */
const seatTokenStore = new Map<string, Partial<Record<Seat, string>>>();

function isSeatToken(value: unknown): value is string {
  return typeof value === 'string' && SEAT_TOKEN_PATTERN.test(value);
}

/** 记住某个座位的令牌（供 joinRoom / createRoom 与测试使用）。 */
export function rememberSeatToken(roomId: string, seat: Seat, token: string): void {
  if (!isSeatToken(token)) return;
  const tokens = seatTokenStore.get(roomId) ?? {};
  tokens[seat] = token;
  seatTokenStore.set(roomId, tokens);
}

/** 读取某个座位已保存的令牌；没有则返回 null。 */
export function getSeatToken(roomId: string, seat: Seat): string | null {
  return seatTokenStore.get(roomId)?.[seat] ?? null;
}

/** 忘掉令牌：不传 seat 表示整间房间一起忘（房间没了的时候用）。 */
export function forgetSeatToken(roomId: string, seat?: Seat): void {
  if (seat === undefined) {
    seatTokenStore.delete(roomId);
    return;
  }
  const tokens = seatTokenStore.get(roomId);
  if (!tokens) return;
  delete tokens[seat];
  if (!tokens[0] && !tokens[1]) seatTokenStore.delete(roomId);
}

/** 令牌缺失 / 失效时给 Agent 看的可读错误：告诉它「缺什么、下一步调哪个工具」。 */
function seatTokenMissingError(roomId: string, seat: Seat, purpose: string): PlaygroundApiError {
  const joinTool = `playground_join_room({ roomId: "${roomId}", seat: ${seat} })`;
  return new PlaygroundApiError(
    `❌ 缺少房间 ${roomId} 座位 ${seat}（${seat === 0 ? '人类' : 'Agent'}）的席位令牌，无法${purpose}。\n` +
      '席位鉴权之后，`seat` 参数不再代表身份：没有该座位的令牌，服务端只会给旁观观测' +
      '（spectator: true、legalActions 恒为空），也不会允许提交动作。\n' +
      `下一步：先调用 ${joinTool} 入座拿令牌 —— 令牌由本客户端自动保存并在后续请求里附加，不需要手动传递。`,
    {
      url: `${getBaseUrl()}/api/rooms/${encodeURIComponent(roomId)}`,
      status: 403,
      code: 'seat_token_missing',
    },
  );
}

/** 服务端说令牌不对 / 房间没了时的本地清理：只清「房间已不存在」的情况，原因见 store 注释。 */
function noteAuthFailure(roomId: string, err: unknown): void {
  if (!(err instanceof PlaygroundApiError)) return;
  const gone =
    err.status === 404 && /房间不存在|room not found|room_not_found/i.test(err.message);
  if (gone) forgetSeatToken(roomId);
}

/** 显式令牌 / 旁观请求的选项（测试与「主动旁观」场景用）。 */
export interface SeatAuthOptions {
  /** 显式指定令牌；`null` 表示这次故意不带令牌。 */
  token?: string | null;
  /** 故意以旁观者身份请求：不带任何令牌（用于验证旁观降级 / 403 语义）。 */
  spectator?: boolean;
}

/** 解析本次请求要用的令牌：显式优先，其次本地保存；缺失则抛可读错误。 */
function resolveSeatToken(
  roomId: string,
  seat: Seat,
  purpose: string,
  options: SeatAuthOptions = {},
): string | undefined {
  if (options.spectator) return undefined;
  if (options.token === null) return undefined;
  const explicit = options.token;
  if (typeof explicit === 'string') {
    // 这里用正则直接判而不是 isSeatToken：后者是类型守卫，取反分支会把 string 收窄成 never。
    if (!SEAT_TOKEN_PATTERN.test(explicit)) {
      throw new PlaygroundApiError(
        `显式传入的席位令牌格式不对（应为 32 位十六进制）：${explicit.slice(0, 12)}…`,
        { url: `${getBaseUrl()}/api/rooms/${encodeURIComponent(roomId)}`, status: null, code: 'seat_token_invalid' },
      );
    }
    return explicit;
  }
  const saved = getSeatToken(roomId, seat);
  if (saved) return saved;
  throw seatTokenMissingError(roomId, seat, purpose);
}

/** 把创建响应里的 seatTokens 记下来（0 号位令牌是建桌时预发的）。 */
function rememberSeatTokensFrom(roomId: string, seatTokens: unknown): void {
  if (!seatTokens || typeof seatTokens !== 'object') return;
  for (const [key, value] of Object.entries(seatTokens as Record<string, unknown>)) {
    const seat = Number(key);
    if ((seat === 0 || seat === 1) && isSeatToken(value)) {
      rememberSeatToken(roomId, seat as Seat, value);
    }
  }
}

/** 拼出人类的房间入口（seat 0）；已知人类令牌时随链接带上，浏览器零配置入座。 */
export function humanUrlFor(roomId: string): string {
  const token = getSeatToken(roomId, 0);
  const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : '';
  return `${getBaseUrl()}/?room=${encodeURIComponent(roomId)}&seat=0${tokenQuery}`;
}

function absoluteUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = getBaseUrl();
  return `${base}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}

function describeServerError(code: string, legalActions?: unknown[] | null): string {
  const hint = SERVER_ERROR_HINTS[code];
  if (hint) {
    const lines = [hint];
    if (legalActions && legalActions.length > 0) {
      lines.push(`legalActions：${JSON.stringify(legalActions)}`);
    }
    return lines.join('\n');
  }
  // 服务端有些错误直接回中文文本（如 "房间不存在: abc"），原样展示即可。
  return code;
}

function parseJson(text: string): { ok: boolean; value: unknown } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const base = getBaseUrl();
  const url = `${base}${path}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as Error & { cause?: unknown };
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new PlaygroundApiError(
        `请求 AI 游乐场服务超时（${REQUEST_TIMEOUT_MS / 1000} 秒）：${method} ${url}\n` +
          '服务端可能卡住了，请确认 127.0.0.1:8787 上的后端进程仍在运行。',
        { url },
      );
    }
    throw new PlaygroundApiError(
      `连不上 AI 游乐场服务：${base}\n` +
        '请先在项目根目录启动后端：pnpm -C packages/server start（或 pnpm dev:server），\n' +
        '如果后端不在默认地址，请设置环境变量 PLAYGROUND_URL。\n' +
        `原始错误：${e.message}`,
      { url },
    );
  }

  const rawText = await response.text();
  const hasBody = rawText.trim().length > 0;
  const parsed = hasBody ? parseJson(rawText) : { ok: true, value: null };
  const data = parsed.value;
  const record = asRecord(data);

  if (!response.ok) {
    const code = typeof record?.error === 'string' ? record.error : null;
    const legalActions = Array.isArray(record?.legalActions) ? (record.legalActions as unknown[]) : null;
    const detail = code ? describeServerError(code, legalActions) : rawText.slice(0, 800);
    const lines = [`AI 游乐场接口返回错误（HTTP ${response.status}）`, `接口：${method} ${url}`];
    if (code) lines.push(`错误码：${code}`);
    if (detail) lines.push(`说明：${detail}`);
    if (!code && !rawText) lines.push('说明：服务端没有返回错误详情。');
    throw new PlaygroundApiError(lines.join('\n'), {
      url,
      status: response.status,
      code,
      legalActions,
      body: data,
    });
  }

  if (!parsed.ok) {
    throw new PlaygroundApiError(
      `AI 游乐场返回了无法解析的内容（HTTP ${response.status}）：${method} ${url}\n` +
        `响应片段：${rawText.slice(0, 500)}`,
      { url, status: response.status, body: rawText },
    );
  }

  return data as T;
}

/** 列出所有可玩游戏（含规则全文）。 */
export async function listGames(): Promise<GameInfo[]> {
  const data = await request<{ games?: GameInfo[] }>('GET', '/api/games');
  return Array.isArray(data.games) ? data.games : [];
}

/**
 * 创建房间，返回 roomId / humanUrl / 规则全文，并记下 0 号位（人类）令牌。
 *
 * `sessionId` 是第 14 轮唤醒桥的可选参数：传了就等于建桌后立刻
 * `bindSession(roomId, sessionId)`，之后人类每次落子、轮到 Agent 时服务端会主动叫醒它。
 * 不传 = 行为与以前完全一致。
 */
export async function createRoom(gameId = 'grab', sessionId?: string): Promise<CreatedRoom> {
  const requestBody: Record<string, unknown> = { gameId };
  if (sessionId) requestBody.sessionId = sessionId;
  const wrap = (data: Omit<CreatedRoom, 'humanUrl'>, wipBypass: boolean): CreatedRoom => {
    const roomId = data.roomId;
    // 服务端建桌时会给人类座位预发令牌；先入库，join(0) 才能带着它做幂等复查。
    rememberSeatTokensFrom(roomId, (data as { seatTokens?: unknown }).seatTokens);
    return {
      ...data,
      humanUrl: absoluteUrl(data.humanUrlPath ?? `/?room=${roomId}&seat=0`),
      ...(wipBypass ? { wipBypass: true } : {}),
    };
  };

  try {
    const data = await request<Omit<CreatedRoom, 'humanUrl'>>('POST', '/api/rooms', requestBody);
    return wrap(data, false);
  } catch (err) {
    // 开发中（wip）的游戏默认不让开桌；服务端会在 400 里带 hint，提示传 allowWip。
    // 这里做「先不带、失败后带 allowWip 重试」，这样 playable / wip 两种状态都能跑。
    if (!(err instanceof PlaygroundApiError) || err.status !== 400) throw err;
    const errorBody = asRecord(err.body);
    const hint = typeof errorBody?.hint === 'string' ? errorBody.hint : '';
    const looksLikeWip =
      /allowWip/i.test(hint) || /开发中|wip/i.test(`${err.message} ${hint}`);
    if (!looksLikeWip) throw err;

    try {
      const data = await request<Omit<CreatedRoom, 'humanUrl'>>('POST', '/api/rooms', {
        ...requestBody,
        allowWip: true,
      });
      return wrap(data, true);
    } catch (retryErr) {
      if (retryErr instanceof PlaygroundApiError) {
        retryErr.message +=
          '\n（注：已按服务端 hint 自动带 {"allowWip":true} 重试一次，仍然失败。）';
      }
      throw retryErr;
    }
  }
}

/** join 的返回：summary + ok + 本座位令牌（第 12 轮新增）。 */
export interface JoinResult extends RoomSummary {
  ok: boolean;
  /** 该座位的席位令牌；服务端未改造时为 undefined。 */
  token?: string;
  seat?: Seat;
}

/**
 * 入座（幂等），并把返回的令牌记进 roomId → seat 的令牌表。
 *
 * 已保存令牌时会随请求带回去：座位已被自己占用时服务端要靠令牌判定「幂等成功」，
 * 否则会 409 seat_taken（令牌隔离）。
 *
 * `tokenOverride`（第 16 轮）：服务端的令牌表在**进程内存**里，游戏厅重启就清空，
 * 但座位仍归旧令牌 —— 这时光靠本模块的缓存（跟着 MCP 进程一起没了）救不回来。
 * 调用方把自己记住的令牌传进来即可幂等续座。
 */
export async function joinRoom(
  roomId: string,
  seat: Seat = 1,
  sessionId?: string,
  tokenOverride?: string,
): Promise<JoinResult> {
  const existing = isSeatToken(tokenOverride) ? tokenOverride : getSeatToken(roomId, seat);
  const data = await request<Omit<RoomSummary, 'humanUrl'> & { ok: boolean; token?: string }>(
    'POST',
    `/api/rooms/${encodeURIComponent(roomId)}/join`,
    { seat, ...(existing ? { token: existing } : {}), ...(sessionId ? { sessionId } : {}) },
  );
  if (isSeatToken(data.token)) rememberSeatToken(roomId, seat, data.token);
  // summary 已按设计去掉 humanUrlPath（否则等于广播令牌）；缺失时用本地人类令牌兜底拼。
  const fallbackToken = getSeatToken(roomId, 0);
  const humanUrlPath =
    data.humanUrlPath ??
    `/?room=${encodeURIComponent(roomId)}&seat=0${fallbackToken ? `&token=${encodeURIComponent(fallbackToken)}` : ''}`;
  return { ...data, humanUrlPath, humanUrl: absoluteUrl(humanUrlPath) };
}

/**
 * 绑定唤醒会话（第 14 轮唤醒桥）：之后人类落子、轮到 Agent 时服务端会主动
 * POST 到 DSH 插件的 /wake，把会话叫醒。
 *
 * 幂等：同一个 sessionId 重复绑定只会刷新 boundAt；换 sessionId 即改绑（最后一次说了算）。
 * 绑定只决定「叫醒谁」，不改变对局规则，也不影响席位令牌。
 */
export async function bindSession(roomId: string, sessionId: string): Promise<BindWakeResult> {
  return request<BindWakeResult>('POST', `/api/rooms/${encodeURIComponent(roomId)}/bind`, {
    sessionId,
  });
}

/**
 * 读取某座位能看到的观测（唯一读数出口）。
 *
 * 默认自动附加该座位已保存的令牌；没有令牌会抛可读错误，**不会**静默去拿旁观视图
 * ——旁观视图 legalActions 恒为空，Agent 会误判成规则问题。
 * 想主动围观用 `{ spectator: true }`（不发送令牌，服务端返回 spectator: true）。
 */
export async function getState(
  roomId: string,
  seat: Seat = 1,
  options: SeatAuthOptions = {},
): Promise<Observation> {
  const token = resolveSeatToken(roomId, seat, '读取该座位的观测', options);
  const query = new URLSearchParams({ seat: String(seat) });
  if (token) query.set('token', token);
  try {
    return await request<Observation>('GET', `/api/rooms/${encodeURIComponent(roomId)}/state?${query}`);
  } catch (err) {
    noteAuthFailure(roomId, err);
    throw err;
  }
}

/**
 * 提交动作。动作原样交给服务端校验（不合法会抛 PlaygroundApiError，status=409 且带 legalActions）。
 * 鉴权失败（403 seat_token_required）同样抛 PlaygroundApiError，错误信息里会给出重新入座的指引。
 * @param action 例如 { action: 'grab', cell: [0, 1] }
 */
export async function submitAction(
  roomId: string,
  seat: Seat,
  action: unknown,
  options: SeatAuthOptions = {},
): Promise<SubmitResult> {
  const token = resolveSeatToken(roomId, seat, '提交动作', options);
  try {
    return await request<SubmitResult>('POST', `/api/rooms/${encodeURIComponent(roomId)}/action`, {
      seat,
      action,
      ...(token ? { token } : {}),
    });
  } catch (err) {
    noteAuthFailure(roomId, err);
    throw err;
  }
}

/** 发送气泡聊天（服务端限流 800ms/座位，≤200 字）。没有令牌会被 403。 */
export async function say(
  roomId: string,
  seat: Seat,
  text: string,
  options: SeatAuthOptions = {},
): Promise<SayResult> {
  const token = resolveSeatToken(roomId, seat, '发送聊天', options);
  try {
    return await request<SayResult>('POST', `/api/rooms/${encodeURIComponent(roomId)}/say`, {
      seat,
      text,
      ...(token ? { token } : {}),
    });
  } catch (err) {
    noteAuthFailure(roomId, err);
    throw err;
  }
}

/** 读取结算结果；对局未结束时为 null。 */
export async function getResult(roomId: string): Promise<GameResult | null> {
  return request<GameResult | null>('GET', `/api/rooms/${encodeURIComponent(roomId)}/result`);
}

/**
 * 导出对局日志（含 seed / events，可回放）。
 *
 * `GET /log` 按契约仍然是公开接口，所以**没有令牌也不报错**（旁观者、复盘者都能拿）；
 * 有令牌时照样附加上，方便服务端以后收紧权限时不用再改客户端。
 */
export async function exportLog(
  roomId: string,
  seat: Seat = 1,
  options: SeatAuthOptions = {},
): Promise<ExportLog> {
  const token = options.spectator
    ? undefined
    : options.token === null
      ? undefined
      : (options.token ?? getSeatToken(roomId, seat) ?? undefined);
  const query = new URLSearchParams({ seat: String(seat) });
  if (token) query.set('token', token);
  try {
    return await request<ExportLog>('GET', `/api/rooms/${encodeURIComponent(roomId)}/log?${query}`);
  } catch (err) {
    noteAuthFailure(roomId, err);
    throw err;
  }
}



