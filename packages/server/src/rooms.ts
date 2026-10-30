import { randomBytes, timingSafeEqual } from 'node:crypto';
import { getGame } from '@ai-playground/core';
import type { Action, GameEvent, GameSpec } from '@ai-playground/core';
import { PersistScheduler, fromSnapshot, loadRooms, toSnapshot } from './persist.ts';
import type { PersistConfig, RoomSnapshot } from './persist.ts';

export type RoomStatus = 'waiting' | 'playing' | 'ended';

/**
 * 唤醒桥绑定（第 14 轮）：房间 ↔ DSH 会话。
 * 为什么要存在房间上而不是进程内存里：绑定得跨重启活着，否则服务一重启，
 * 人类继续落子就再也叫不醒那个会话了（房间本身是落盘恢复的）。
 */
export interface WakeBinding {
  sessionId: string;
  /** 绑定时刻（epoch ms），排查「这条绑定是什么时候来的」用。 */
  boundAt: number;
}

/**
 * 会话 id 形状：与插件侧（dsh-whale-game 的 /wake 校验）保持一致。
 * 在平台入口就拦掉脏数据，别等插件返回 400 才发现是这边传错了。
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** 校验并规范化 sessionId；不合法直接抛（HTTP 层会映射成 400）。 */
export function normalizeSessionId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) throw new Error('缺少 sessionId（通常取环境变量 DSH_SESSION_ID）');
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new Error(`sessionId 格式不合法（只允许 A-Za-z0-9._:-，最长 128）：${JSON.stringify(value)}`);
  }
  return id;
}

export interface ChatMessage {
  id: number;
  seat: number;
  text: string;
  at: number;
}

export interface Room {
  id: string;
  gameId: string;
  game: GameSpec<any, any>;
  seed: number;
  state: any;
  status: RoomStatus;
  occupied: [boolean, boolean];
  /**
   * 每个座位的入座令牌（16 字节随机数的 32 位十六进制）；null = 还没发过。
   * 0 号位在建桌时就预先生成（人类入口 URL 里带出去），1 号位等 Agent 入座时才发。
   */
  seatTokens: [string | null, string | null];
  pending: [Action | null, Action | null];
  /** 唤醒桥绑定；null = 没绑定，此时行为与加唤醒桥之前完全一致。 */
  wake: WakeBinding | null;
  /**
   * 最近一次唤醒投递尝试的时间（只读诊断，**不落盘**）。
   * 为什么可选又刻意不持久化：它是「本次进程」的运行态，重启后按「没叫过」呈现更诚实；
   * 用可选字段是为了让 RoomSnapshot 继续能表达「这个字段不需要存盘」。
   */
  lastWakeAt?: number | null;
  /** 最近一次唤醒失败原因；成功一次就清空（只读诊断，不落盘）。null = 最近一次是成功 / 还没叫过。 */
  lastWakeError?: string | null;
  chat: ChatMessage[];
  log: { t: number; event: GameEvent }[];
  result: { winner: number | null; scores: Record<string, number>; text: string } | null;
  createdAt: number;
  /** 最近一次有效活动时间：TTL 清理全靠它 */
  lastActivity: number;
  lastSayAt: Record<number, number>;
  chatSeq: number;
}

export interface RoomSummary {
  roomId: string;
  gameId: string;
  status: RoomStatus;
  round: number;
  scores: Record<string, number>;
  occupied: [boolean, boolean];
  pendingSeats: number[];
  result: { winner: number | null; scores: Record<string, number>; text: string } | null;
  /**
   * 唤醒桥只读诊断（第 14 轮）。只有 boundSessionId 是持久化的，
   * lastWakeAt / lastWakeError 是本次进程的运行态；没绑定时 boundSessionId 为 null。
   */
  wake: { boundSessionId: string | null; lastWakeAt: number | null; lastWakeError: string | null };
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function assertSeat(seat: number): void {
  if (seat !== 0 && seat !== 1) throw new Error('seat 必须是 0（人类）或 1（Agent）');
}

/** 令牌 = 16 字节随机数的 32 位小写十六进制；不要用 Math.random，座位凭据不能可预测。 */
function createSeatToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * 定长令牌比较。
 * 长度不等直接 false（timingSafeEqual 长度不等会抛异常），长度相同走常量时间比较，
 * 避免普通 `===` 按字节提前返回、把令牌前缀泄露给计时攻击。
 */
function seatTokenMatches(expected: string | null, provided: unknown): boolean {
  if (expected === null || typeof provided !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 座位已被占（含 0 号位令牌已预留）——HTTP 409 seat_taken。 */
export class SeatTakenError extends Error {
  readonly code = 'seat_taken';

  constructor(roomId: string, seat: number) {
    super(`座位 ${seat} 已被占用（房间 ${roomId}）；请带上入座时拿到的令牌，或换个座位`);
    this.name = 'SeatTakenError';
  }
}

/** 写操作缺少有效令牌——HTTP 403 seat_token_required（读操作用旁观降级，不抛）。 */
export class SeatTokenRequiredError extends Error {
  readonly code = 'seat_token_required';

  constructor(message = '缺少或无效的座位令牌，不能行动') {
    super(message);
    this.name = 'SeatTokenRequiredError';
  }
}

/** 入座结果：seat 是请求的座位，token 是该座位（新建或原有的）令牌。 */
export interface JoinResult {
  room: Room;
  seat: number;
  token: string;
}

/** submit 的统一返回：被拒时带 error（必要时带 legalActions），结算时带 events。 */
export interface SubmitResult {
  resolved: boolean;
  events: GameEvent[];
  error?: 'room_ended' | 'waiting_for_opponent' | 'seat_not_joined' | 'action_already_submitted' | 'illegal_action' | 'not_your_turn';
  legalActions?: Action[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 键序无关的深比较（只处理 JSON 可表达的值）。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => key in b && deepEqual(a[key], b[key]));
  }
  return false;
}

/**
 * 轮流制动作合法性：把 legalActions 里的动作当「模式」用——它的每个字段都必须在提交动作里等价出现。
 * 提交里多带的字段会被游戏忽略；这样 cell / col / index 等各种动作形状无需服务端特判。
 */
function matchesLegalAction(action: Action, pattern: Action): boolean {
  if (!isPlainRecord(action) || !isPlainRecord(pattern)) return false;
  return Object.keys(pattern).every((key) => key in action && deepEqual(action[key], pattern[key]));
}

/**
 * 「喊你动手」的提示行前缀（第 18 轮）。
 *
 * 这些行由各游戏内核生成，在 hanging 状态（没开始 / 已交招）下必须摘掉：
 * 留着就会出现「文案说选一个合法动作、接口说 legalActions 为空」的自相矛盾，
 * 真人对局实测里正是这么误点了一手。
 */
const ACTION_HINT_RE = /^(轮到你了：|还没结束：|本局还没结算：|下一步：|可执行：)/;

function stripActionHints(textView: string): string {
  return textView
    .split('\n')
    .filter((line) => !ACTION_HINT_RE.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

/**
 * 给「不能动手」的状态加一句明确的前置说明（第 18 轮）。
 * 只改文案，不改规则：`waiting`（还没开始）与「已交招等对手」两种情形。
 */
function decorateTextView(
  raw: string,
  info: { waiting: boolean; submitted: boolean; unoccupied: number[] },
): string {
  if (!info.waiting && !info.submitted) return raw;
  const body = stripActionHints(raw);
  const banner = info.waiting
    ? info.unoccupied.length > 0
      ? `⏳ 还没开始：座位 ${info.unoccupied.join('、')} 还没入座，现在不能出招。`
      : '⏳ 还没开始，现在不能出招。'
    : '✅ 你已出手，等对手提交；本局还没结算 —— 不要再提交（重复提交会被拒）。';
  return body ? `${banner}\n\n${body}` : banner;
}

type Listener = (roomId: string, events: GameEvent[]) => void;

/** 单个 RoomManager 的落盘配置；传 `null` 表示这个实例明确不落盘。 */
export type RoomPersistOptions = PersistConfig;

export interface RoomManagerOptions {
  /**
   * 不传 = 用进程级默认（configurePersistence 配的）；传 null = 明确不落盘。
   * 为什么默认不读环境变量：测试里 `new RoomManager()` 满天飞，一读环境就会把用例
   * 写进仓库的 ./data；「这次是不是真服务」只有入口知道，所以由入口显式配置。
   */
  persist?: RoomPersistOptions | null;
}

let defaultPersistConfig: PersistConfig | null = null;

/** 由入口（index.ts）在构造 RoomManager 之前调用，配置进程级默认落盘策略。 */
export function configurePersistence(config: PersistConfig | null): void {
  defaultPersistConfig = config;
}

/**
 * 已启用落盘的实例。为什么需要这层登记：server.ts 里的 `const rooms = new RoomManager()`
 * 是模块私有单例（本轮不改 server.ts），入口拿不到引用，又要能在进程退出时同步 flush，
 * 只能由 RoomManager 自己登记、入口按集合统一 flush。单进程只会有一个实例。
 */
const persistedManagers = new Set<RoomManager>();

/** 进程退出前调用：把所有已登记实例的脏数据同步落盘；返回是否写了盘。 */
export function flushActiveRooms(): boolean {
  let wrote = false;
  for (const manager of persistedManagers) {
    if (manager.flushSync()) wrote = true;
  }
  return wrote;
}

/** 给启动日志用：落盘文件与本次恢复的房间数；没有启用持久化时返回 null。 */
export function activePersistenceInfo(): { file: string; restored: number } | null {
  // 取最近构造的那个：真服务里只会有一个 RoomManager，测试里会造很多，
  // 入口刚构造完就问「你用的是哪个文件」，自然是最后注册的那个。
  let latest: RoomManager | null = null;
  for (const manager of persistedManagers) latest = manager;
  if (latest === null) return null;
  const file = latest.persistenceFile;
  return file === null ? null : { file, restored: latest.restoredCount };
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private listeners = new Set<Listener>();
  /** null = 不落盘（测试 / PLAYGROUND_PERSIST=0） */
  private readonly persist: PersistScheduler | null;
  private restored = 0;

  constructor(options: RoomManagerOptions = {}) {
    const config = options.persist === undefined ? defaultPersistConfig : options.persist;
    if (config === null) {
      this.persist = null;
      return;
    }
    this.persist = new PersistScheduler({
      file: config.file,
      debounceMs: config.debounceMs,
      // 快照只在真正写盘那一刻取：房间在防抖窗口里可能被改了十几次，取早的都是脏数据。
      snapshot: (): RoomSnapshot[] => [...this.rooms.values()].map(toSnapshot),
    });
    persistedManagers.add(this);
    this.restore();
  }

  /** 本次启动从磁盘恢复的房间数（没有启用持久化时为 0）。 */
  get restoredCount(): number {
    return this.restored;
  }

  /** 当前落盘文件；未启用持久化时为 null。 */
  get persistenceFile(): string | null {
    return this.persist?.file ?? null;
  }

  /**
   * 构造时恢复。任何一条坏数据都只丢那一条：
   * 未知 gameId（回滚了版本 / 手改过文件）→ 丢弃 + warning，其余房间照常恢复。
   */
  private restore(): void {
    if (this.persist === null) return;
    const snapshots = loadRooms(this.persist.file);
    let dropped = 0;
    for (const snapshot of snapshots) {
      const room = fromSnapshot(snapshot);
      if (room === null) {
        dropped += 1;
        console.warn(
          `[persist] 丢弃房间 ${String((snapshot as { id?: unknown })?.id ?? '?')}：未知游戏 ${String((snapshot as { gameId?: unknown })?.gameId ?? '?')}`,
        );
        continue;
      }
      // 设计稿 §2「加载时的两个细节」之一：lastActivity 必须刷新成 now。
      // TTL 是 2 小时，服务停了 3 小时再起，按原值所有房间都已超时，
      // 下一次 sweep 会把它们全清掉——而「重启」不该等于「清空」。
      // 注意 seatTokens 走的是原值（另一个细节）：令牌与房间同生命周期。
      room.lastActivity = Date.now();
      this.rooms.set(room.id, room);
    }
    this.restored = this.rooms.size;
    if (dropped > 0) console.warn(`[persist] 共丢弃 ${dropped} 个不可恢复的房间`);
  }

  /**
   * 改状态后打点。调用点：create / join / submit / say / sweep。
   * 只打点不立刻写——400ms 防抖把一次操作里的连环改动合并成一次落盘。
   */
  private markDirty(): void {
    this.persist?.schedule();
  }

  /** 同步落盘，供进程退出（SIGINT / SIGTERM / beforeExit）调用；返回是否真的写了。 */
  flushSync(): boolean {
    return this.persist?.flush() ?? false;
  }

  onEvents(listener: Listener): void {
    this.listeners.add(listener);
  }

  private emit(roomId: string, events: GameEvent[]): void {
    for (const l of this.listeners) l(roomId, events);
  }

  create(gameId: string): Room {
    const game = getGame(gameId);
    if (!game) throw new Error(`未知游戏: ${gameId}`);
    const seed = Math.floor(Math.random() * 0x7fffffff);
    const room: Room = {
      id: shortId(),
      gameId,
      game,
      seed,
      state: game.setup(seed),
      status: 'waiting',
      occupied: [false, false],
      // 0 号位令牌在建桌时就生成并预留：只有拿到 humanUrl（含该令牌）的人能坐人类位。
      // 若等 join 时才发，任何访客一个 POST /join {seat:0} 就能抢走房主的人类座位。
      seatTokens: [createSeatToken(), null],
      pending: [null, null],
      wake: null,
      chat: [],
      log: [],
      result: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      lastSayAt: {},
      chatSeq: 1,
    };
    this.rooms.set(room.id, room);
    // 建桌也要立刻排队：否则建桌后 400ms 内重启，人类手里的 humanUrl 直接指向不存在的房间。
    this.markDirty();
    return room;
  }

  /** 标记房间活跃，供 TTL 清理判断 */
  private touch(room: Room): Room {
    room.lastActivity = Date.now();
    return room;
  }

  /** 清掉长时间无活动的房间，避免内存无限增长；返回被清数量。 */
  sweep(maxIdleMs = 2 * 60 * 60 * 1000): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, room] of this.rooms) {
      if (now - room.lastActivity <= maxIdleMs) continue;
      this.rooms.delete(id);
      removed += 1;
    }
    // 只有真的删了才写盘：10 分钟一次的清扫不该每轮都刷新文件；
    // 但删掉的房间必须尽快从磁盘消失，否则下次重启又把它捞回来。
    if (removed > 0) this.markDirty();
    return removed;
  }

  get size(): number {
    return this.rooms.size;
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  /**
   * 入座（设计稿 §3.2）：
   * - 座位空闲且没发过令牌 → 占用 + 发新令牌；
   * - 已占用 / 0 号位令牌已预留 → 令牌匹配才幂等成功（返回同一令牌）；
   * - 已占用或已预留但令牌缺失/不匹配 → 抛 SeatTakenError（HTTP 409）。
   *
   * 「已预留但未占用」的判定是契约没写死的边界：0 号位从建桌起就有令牌，
   * 若不认预留，随便谁一个无令牌 join(0) 就能把房主的位置占走。
   */
  join(id: string, seat: number, token?: string): JoinResult {
    assertSeat(seat);
    const room = this.mustGet(id);
    const existing = room.seatTokens[seat];
    if (room.occupied[seat] || existing !== null) {
      if (!seatTokenMatches(existing, token)) throw new SeatTakenError(id, seat);
      // 同一个人重连：幂等，不换令牌
      room.occupied[seat] = true;
      this.startIfReady(room);
      this.markDirty();
      return { room, seat, token: existing as string };
    }
    const issued = createSeatToken();
    room.seatTokens[seat] = issued;
    room.occupied[seat] = true;
    this.startIfReady(room);
    // 新令牌必须落盘：重启后浏览器/MCP 手里那张令牌还要继续有效。
    this.markDirty();
    return { room, seat, token: issued };
  }

  /** 双方都入座就开局；从 join 里抽出来，两条入座分支共用。 */
  private startIfReady(room: Room): void {
    if (room.occupied[0] && room.occupied[1] && room.status === 'waiting') {
      room.status = 'playing';
    }
  }

  /**
   * 绑定唤醒会话（第 14 轮）。幂等：同一个 sessionId 重复绑定只会刷新 boundAt。
   *
   * 为什么允许改绑：Agent 换会话（重开 DSH / 换 profile）是正常情况，
   * 「最后绑的那个说了算」比报错更好用；旧会话此后不会再被叫醒。
   */
  bindWake(id: string, sessionId: string): WakeBinding {
    const normalized = normalizeSessionId(sessionId);
    const room = this.mustGet(id);
    const binding: WakeBinding = { sessionId: normalized, boundAt: Date.now() };
    room.wake = binding;
    // 换绑之后旧的失败原因不再代表当前绑定的状态，清掉免得误诊。
    room.lastWakeError = null;
    room.lastWakeAt = null;
    this.markDirty();
    return binding;
  }

  /**
   * 记一次唤醒投递结果，供 GET /api/rooms/:id 的只读诊断字段。
   * 用 `rooms.get` 而不是 `mustGet`：唤醒是旁路，不该因为房间刚好被 TTL 清掉就
   * 顺手延长它（更不该在唤醒链路上抛异常）。
   */
  noteWakeResult(
    id: string,
    result: { at: number } & ({ ok: true } | { ok: false; error: string }),
  ): void {
    const room = this.rooms.get(id);
    if (!room) return;
    room.lastWakeAt = result.at;
    room.lastWakeError = result.ok ? null : result.error;
  }

  /** 公开摘要：**绝不能**带令牌或 humanUrlPath，否则任意 GET 一次就能拿到座位凭据。 */
  summary(id: string): RoomSummary {
    const room = this.mustGet(id);
    // 这里只是借 observe 拿公开的 round / scores（比分本来就在大厅展示），
    // 返回值里只挑这两个字段，不会把任何私有观测带出去。
    const obs = room.game.observe(room.state, 0);
    const turnBased = this.isTurnBased(room);
    return {
      roomId: room.id,
      gameId: room.gameId,
      status: room.status,
      round: obs.round,
      scores: obs.scores,
      occupied: room.occupied,
      // 轮流制没有「挂起动作」这一说，恒为空，避免前端误显示「对方已提交」。
      pendingSeats: turnBased ? [] : [0, 1].filter((s) => room.pending[s] !== null),
      result: room.result,
      // 只读诊断：不回传任何令牌；boundSessionId 本身就是 Agent 的会话 id，
      // 设计稿明确要它出现在公开 summary 里（人类 / 排查者据此确认「绑定生效了没」）。
      wake: {
        boundSessionId: room.wake?.sessionId ?? null,
        lastWakeAt: room.lastWakeAt ?? null,
        lastWakeError: room.lastWakeError ?? null,
      },
    };
  }

  /**
   * 观测（设计稿 §3.4）：令牌有效 → 该座位视角；否则**降级为旁观**，不报错。
   * 降级是正当场景（把房间链接发给朋友围观），但旁观者拿不到私有字段，也不能行动。
   */
  observation(id: string, seat: number, token?: string) {
    assertSeat(seat);
    const room = this.mustGet(id);
    const turnBased = this.isTurnBased(room);
    const playing = room.status === 'playing';
    // turn：当前行动方来自 game.currentSeat；simultaneous：没有「当前行动方」概念，恒为 null。
    const currentSeat = turnBased ? (room.game.currentSeat?.(room.state) ?? null) : null;

    if (!seatTokenMatches(room.seatTokens[seat], token)) {
      // 旁观：core 用 seat=null 产出公开视图；下面再把契约要求清空的字段强制清空，
      // 不依赖各游戏内核的 null 分支写得是否完美。
      return {
        ...room.game.observe(room.state, null),
        roomId: room.id,
        status: room.status,
        currentSeat,
        seat: null,
        spectator: true,
        isYourTurn: false,
        youSubmitted: false,
        legalActions: [],
        waitingFor: [],
        result: room.result,
      };
    }

    const obs = room.game.observe(room.state, seat);
    const submitted = !turnBased && room.pending[seat] !== null;
    /**
     * 第 18 轮（真实对局实测）：`waiting` 与「已交招」这两种「你不该动手」的状态，
     * 必须把 legalActions 清空、并把 textView 里喊你动手的提示行摘掉。
     * 否则文案还在说「选一个合法动作」，真人会照着再点一次——那一手会被算进**下一回合**
     *（rps-duel / grab 实测：第 2 局那次「布」就是这么来的）。
     */
    const blocked = !playing || submitted;
    return {
      ...obs,
      textView: decorateTextView(String(obs.textView ?? ''), {
        waiting: room.status === 'waiting',
        submitted,
        unoccupied: [0, 1].filter((s) => !room.occupied[s]),
      }),
      roomId: room.id,
      status: room.status,
      currentSeat,
      seat,
      spectator: false,
      isYourTurn: turnBased
        ? playing && currentSeat === seat
        : playing && room.pending[seat] === null,
      youSubmitted: submitted,
      legalActions: blocked ? [] : (obs.legalActions ?? []),
      // 注意：这里**故意不回传挂起动作本身**。
      // 第 12 轮起 seat 参数不再代表身份（令牌才算），但即便拿到令牌也没必要把
      // 自己的挂起动作塞回观测里；需要"刷新后还记得自己出了什么"由客户端自己保存。
      waitingFor: !playing
        ? [0, 1].filter((s) => !room.occupied[s])
        : turnBased
          ? currentSeat === null
            ? []
            : [currentSeat]
          : [0, 1].filter((s) => room.pending[s] === null),
      result: room.result,
    };
  }

  /**
   * 写操作的令牌闸门：缺令牌 / 令牌不对一律抛 SeatTokenRequiredError（HTTP 403）。
   * 与读操作的「旁观降级」区分开：围观可以，但不能替别人出手。
   */
  private assertSeatToken(room: Room, seat: number, token?: string): void {
    if (!seatTokenMatches(room.seatTokens[seat], token)) {
      throw new SeatTokenRequiredError(`座位 ${seat} 的令牌缺失或不匹配，无法行动（房间 ${room.id}）`);
    }
  }

  submit(id: string, seat: number, action: Action, token?: string): SubmitResult {
    assertSeat(seat);
    const room = this.mustGet(id);
    // 令牌检查必须排在所有游戏状态判断之前：越权方连「房间是否结束 / 轮到谁」都不该探到。
    this.assertSeatToken(room, seat, token);
    if (room.status === 'ended') return { resolved: false, error: 'room_ended', events: [] };
    // 入座检查必须在 waiting 之前：以前先判 waiting，导致「没入座就提交」
    // 永远只看到 waiting_for_opponent，seat_not_joined 分支根本不可达。
    if (!room.occupied[seat]) return { resolved: false, error: 'seat_not_joined', events: [] };
    if (room.status === 'waiting') return { resolved: false, error: 'waiting_for_opponent', events: [] };

    // 轮流制：当前行动方提交即结算，不写 pending（pending 是同时暗选专用的挂起槽）。
    if (this.isTurnBased(room)) return this.submitTurn(room, seat, action);

    const legal = room.game.legalActions(room.state, seat);
    if (room.pending[seat] !== null) {
      return { resolved: false, error: 'action_already_submitted', events: [], legalActions: legal };
    }
    // 通用匹配：以前这里写死了 action==='grab' + cell 结构，
    // 任何新的 simultaneous 游戏（如路线图里的猜拳）都会整体不可用。
    if (!legal.some((candidate) => matchesLegalAction(action, candidate))) {
      return { resolved: false, error: 'illegal_action', events: [], legalActions: legal };
    }

    room.pending[seat] = action;
    // 挂起动作也是状态：第一个交招的人先重启，另一半交上来时必须还能结算，
    // 所以这里立刻打点（防抖会把这个写和后面结算的写合并）。
    this.markDirty();
    if (room.pending[0] === null || room.pending[1] === null) {
      return { resolved: false, events: [] };
    }

    const { state, events } = room.game.step(room.state, {
      0: room.pending[0] as Action,
      1: room.pending[1] as Action,
    });
    room.state = state;
    room.pending = [null, null];
    room.log.push(...events.map((event) => ({ t: Date.now(), event })));
    if (room.game.isTerminal(state)) {
      room.status = 'ended';
      room.result = room.game.result(state);
    }
    this.markDirty();
    this.emit(room.id, events);
    return { resolved: true, events };
  }

  /** 轮流制结算：只校验 / 传递当前座位的动作，落子后立刻写回并换手。 */
  private submitTurn(room: Room, seat: number, action: Action): SubmitResult {
    const currentSeat = room.game.currentSeat?.(room.state) ?? null;
    if (currentSeat !== seat) return { resolved: false, error: 'not_your_turn', events: [] };

    const legal = room.game.legalActions(room.state, seat);
    if (!legal.some((candidate) => matchesLegalAction(action, candidate))) {
      return { resolved: false, error: 'illegal_action', events: [], legalActions: legal };
    }

    const { state, events } = room.game.step(room.state, { [seat]: action } as Record<number, Action>);
    room.state = state;
    room.log.push(...events.map((event) => ({ t: Date.now(), event })));
    if (room.game.isTerminal(state)) {
      room.status = 'ended';
      room.result = room.game.result(state);
    }
    this.markDirty();
    this.emit(room.id, events);
    return { resolved: true, events };
  }

  private isTurnBased(room: Room): boolean {
    return room.game.meta.resolution === 'turn';
  }

  say(id: string, seat: number, text: string, token?: string): ChatMessage {
    assertSeat(seat);
    const room = this.mustGet(id);
    // 聊天也是「以某座位的身份发消息」，同样要令牌；否则旁观者能冒名挑事。
    this.assertSeatToken(room, seat, token);
    // 第 18 轮：超长气泡以前是**静默截断**（250 字发出去、存下来只剩 200，用户完全不知道）。
    // 真人对局实测报了这条：改成明确拒绝，让人知道该裁剪。
    const raw = String(text ?? '').trim();
    if (!raw) throw new Error('空文本');
    if (raw.length > 200) {
      throw new Error(`文本太长：${raw.length} 字，上限 200 字（请裁剪后再发，不要指望服务端替你截断）`);
    }
    const clean = raw;
    const now = Date.now();
    if (now - (room.lastSayAt[seat] ?? 0) < 800) throw new Error('说话太快了，歇一下');
    room.lastSayAt[seat] = now;
    const msg: ChatMessage = { id: room.chatSeq++, seat, text: clean, at: now };
    room.chat.push(msg);
    if (room.chat.length > 200) room.chat.shift();
    this.markDirty();
    this.emit(room.id, [{ type: 'chat', message: msg }]);
    return msg;
  }

  chat(id: string, since = 0): ChatMessage[] {
    const room = this.mustGet(id);
    return room.chat.filter((m) => m.id > since);
  }

  exportLog(id: string, seat: number) {
    assertSeat(seat);
    const room = this.mustGet(id);
    return {
      roomId: room.id,
      gameId: room.gameId,
      // 只有对局结束才公开 seed：yacht 的骰面完全由 seed+draws 决定，
      // 进行中把 seed 给出去等于让人能精确预测后面的骰子。
      seed: room.status === 'ended' ? room.seed : null,
      seat,
      result: room.result,
      rules: room.game.meta.rules,
      events: room.log,
      createdAt: room.createdAt,
    };
  }

  private mustGet(id: string): Room {
    const room = this.rooms.get(id);
    if (!room) throw new Error(`房间不存在: ${id}`);
    // 任何一次访问都算活跃，TTL 清理才不会误删正在打的房间
    return this.touch(room);
  }
}


