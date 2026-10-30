/**
 * 唤醒桥 · 平台侧投递（第 14 轮，契约见 design-wake-bridge.md §3.1）。
 *
 * 为什么单独一个文件：rooms.ts 管「房间怎么活」，server.ts 管「HTTP 怎么进」，
 * 这里只管三件与对局无关的事——**该不该叫、怎么叫、叫失败怎么办**。
 *
 * 一条硬约束：唤醒是旁路。没配 WAKE_URL 就一个字节都不发；网络失败 / 超时 /
 * 插件没装，都只进环形日志，绝不让对局慢一拍、更不能让 HTTP 请求失败。
 * DSH 会话是消息驱动的，人类落子后 Agent 早已休眠，这个模块就是那根门铃线。
 */

import { randomBytes } from 'node:crypto';
import type { Room } from './rooms.ts';

/** POST 超时：设计稿给的 2 秒。人类等的是「叫醒」，不是「等插件回话」。 */
export const WAKE_TIMEOUT_MS = 2000;
/** 失败重试间隔：只重试一次，间隔 500ms。 */
export const WAKE_RETRY_DELAY_MS = 500;
/** 同一「房间+回合」的最小唤醒间隔（设计稿 3 秒）。 */
export const WAKE_DEDUPE_MS = 3000;
/** 同一回合最多唤醒次数：叫两次还不动，就别再轰炸会话了。 */
export const WAKE_MAX_PER_ROUND = 2;
/** 环形日志容量：失败原因要能回看，但不能无限吃内存。 */
export const WAKE_LOG_LIMIT = 50;
/**
 * textView 上限：插件侧还会截到 2KB，平台先兜一层，
 * 避免把一整盘大文本塞进唤醒通知体（这里有 4KB 余量给中文）。
 */
const MAX_TEXT_VIEW_CHARS = 4096;

/** 投递配置：未配 WAKE_URL = 功能关闭（wakeConfigFromEnv 返回 null）。 */
export interface WakeConfig {
  url: string;
  secret: string;
}

/**
 * 从环境变量读配置。**每次投递时读**而不是模块加载时读一次：
 * 这样测试可以按用例切换 WAKE_URL（同一个进程里先测成功、再测不可达），
 * 线上也不依赖 import 顺序——环境没配就是「功能关闭」，与加唤醒桥之前完全一致。
 */
export function wakeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WakeConfig | null {
  const url = env.WAKE_URL?.trim();
  if (!url) return null;
  return { url, secret: env.WAKE_SECRET?.trim() ?? '' };
}

/**
 * 绑定了一个「叫不醒」的会话时抛这个错（第 18 轮）。
 *
 * 真实测试波里，三个 spawn 出来的测试员都被绑上了房间，平台还回「已绑定」，
 * 直到人类落子才发现 409 —— 这次让 bind 当场失败，人类不用白等。
 */
export class SessionUnwakeableError extends Error {
  readonly code = 'session-unwakeable';
  constructor(
    readonly sessionId: string,
    readonly reason: string,
  ) {
    super(`会话 ${sessionId} 无法被唤醒：${reason}`);
    this.name = 'SessionUnwakeableError';
  }
}

/**
 * 问插件「这个会话叫得动吗」（第 18 轮）：只问不投。
 * 返回 `null` 表示「不知道」（没配 WAKE_URL / 插件没起 / 超时）—— 不拦，按老行为绑定。
 */
export async function probeWakeable(
  sessionId: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ wakeable: boolean | null; reason?: string }> {
  const config = wakeConfigFromEnv(options.env);
  if (config === null) return { wakeable: null };
  const url = `${config.url.replace(/\/+$/, '')}/check`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-wake-secret': config.secret },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(1500),
    });
    // 响应体必须先读完再丢弃：Node fetch 的 keep-alive 需要消费完连接。
    const text = await response.text().catch(() => '');
    if (!response.ok) return { wakeable: null };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { wakeable: null };
    }
    const record = body as { wakeable?: unknown; reason?: unknown };
    if (typeof record?.wakeable !== 'boolean') return { wakeable: null };
    return {
      wakeable: record.wakeable,
      reason: typeof record.reason === 'string' ? record.reason : undefined,
    };
  } catch {
    return { wakeable: null };
  }
}

/** 绑定前的硬校验：插件明确说「叫不动」就拒绝绑定；其余情况放行。 */
export async function assertWakeable(sessionId: string, options: { env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  const probe = await probeWakeable(sessionId, options);
  if (probe.wakeable === false) {
    throw new SessionUnwakeableError(sessionId, probe.reason ?? '插件报告不可唤醒');
  }
}

/** 投递体（和插件侧约定的线上契约，字段名别改）。 */
export interface WakePayload {
  roomId: string;
  sessionId: string;
  gameId: string;
  round: number;
  textView: string;
  /**
   * 为什么要叫醒它（第 15 轮补）：
   * - `turn`：轮到你出招了；
   * - `ended`：对局结束了，该去看比分、跟人类收个尾。
   * 插件按它选文案；不认识的 reason 一律按 `turn` 处理（向前兼容）。
   */
  reason: 'turn' | 'ended';
  /** 仅 `reason === 'ended'` 时携带：内核给的结算文案（如「座位 0 获胜！…」）。 */
  resultText?: string;
  /** 平台侧生成的投递时刻（epoch ms）。 */
  createdAt: number;
  /** 一次性随机串：插件侧去重 / 日志追踪用，平台不解释它。 */
  nonce: string;
}

/** 一次投递的最终结果（含重试次数），给房间诊断字段和环形日志共用。 */
export type WakeOutcome =
  | { at: number; ok: true; attempts: number; status: number | null }
  | { at: number; ok: false; error: string; attempts: number; status: number | null };

/** 环形日志条目：只记「这次唤醒」，不含令牌、不含完整 textView。 */
export interface WakeLogEntry {
  at: number;
  roomId: string;
  sessionId: string;
  round: number;
  ok: boolean;
  attempts: number;
  status: number | null;
  error: string | null;
  /** 整个投递耗时（含重试与 500ms 间隔）。 */
  ms: number;
}

/** 去重状态：每个房间只留最近一条，key = `${roomId}:${round}`。 */
interface DedupeState {
  key: string;
  at: number;
  count: number;
}

const wakeLog: WakeLogEntry[] = [];
/**
 * 去重状态：用 WeakMap 以房间对象为键。
 * 为什么不是 Map<roomId, …>：房间被 TTL 清掉后 Map 里的键永远不会有人删，
 * 长跑实例会慢慢攒垃圾；WeakMap 让去重状态跟着房间对象一起被回收。
 */
let dedupe = new WeakMap<Room, DedupeState>();
/** 正在飞的投递：测试要「等这次唤醒彻底落定」，线上靠它避免重复请求叠加。 */
const inFlight = new Set<Promise<void>>();
/**
 * 失败重试定时器（第 16 轮补）。
 *
 * 为什么必须有它：唤醒是「人类已经等你出手」的唯一信号。一次投递失败（插件没起、
 * DSH 端口变了、会话不可用）如果不重试，这局就**永远卡住**——人类在浏览器前干等，
 * Agent 睡死在会话里，双方都不会再产生新的触发点。原先「同回合最多 2 次」只在
 * 同一次触发里有效，等于没有重试。
 */
const retryTimers = new WeakMap<Room, NodeJS.Timeout>();
let warnedMissingSecret = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 失败后的重试节奏（毫秒）。默认 8s / 20s / 45s：第一次给人反应时间（插件可能正在
 * 重连），之后拉长避免刷日志。测试可用 `WAKE_RETRY_DELAYS=50,100` 覆盖。
 */
const DEFAULT_RETRY_DELAYS_MS = [8_000, 20_000, 45_000];

function retryDelays(env: NodeJS.ProcessEnv = process.env): number[] {
  const raw = env.WAKE_RETRY_DELAYS?.trim();
  if (!raw) return DEFAULT_RETRY_DELAYS_MS;
  const parsed = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length > 0 ? parsed : DEFAULT_RETRY_DELAYS_MS;
}

function clearRetry(room: Room): void {
  const timer = retryTimers.get(room);
  if (timer) {
    clearTimeout(timer);
    retryTimers.delete(room);
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    // fetch 的真实原因在 cause.code（ECONNREFUSED / ENOTFOUND 等），不带上等于没报错。
    const code = (error as { cause?: { code?: string } }).cause?.code;
    return code ? `${error.name}: ${error.message}（${code}）` : `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * 判断「现在该不该叫 Agent」。这是唯一一处棋局语义判断，信源只有房间状态：
 * - 必须已绑定 wake.sessionId；
 * - 对局必须 playing（对局结束 / 还没开局都不叫）；
 * - turn 模式：当前行动方是 Agent（seat 1）；
 * - simultaneous 模式：人类已提交、Agent 还没提交（这时结算在等 Agent）。
 */
export function shouldWakeAgent(room: Room): boolean {
  if (!room.wake) return false;
  if (room.status !== 'playing') return false;
  const mode = room.game.meta.resolution;
  if (mode === 'turn') {
    // currentSeat 在终局统一返回 null，所以上面那条 status 判断不是唯一保险。
    // 覆盖了特殊规则：battleship 命中继续开炮（仍轮到自己 → 不叫）、
    // reversi 对手无子可下被自动跳过（又轮回人类 → 不叫）。
    return (room.game.currentSeat?.(room.state) ?? null) === 1;
  }
  if (mode === 'simultaneous') {
    // 双盲模式：只认「人类已提交、Agent 还没提交」——这时结算卡在 Agent 身上。
    // 不叫的两种情况都是对的：人类还没交（该人类）、两边都交了（正在结算）。
    return room.pending[0] !== null && room.pending[1] === null;
  }
  // 未知结算模式：宁可漏叫也不乱叫（将来加了新模式，这里会打一条日志提醒补规则）。
  console.warn(`[wake] 未知的游戏结算模式「${String(mode)}」（房间 ${room.id}），跳过唤醒判定`);
  return false;
}

function buildPayload(
  room: Room,
  round: number,
  textView: string,
  sessionId: string,
  reason: WakePayload['reason'] = 'turn',
  resultText?: string,
): WakePayload {
  const payload: WakePayload = {
    roomId: room.id,
    sessionId,
    gameId: room.gameId,
    round,
    // 只给 Agent 视角的只读摘要：不含令牌、不含对手未揭示的动作。
    textView: textView.slice(0, MAX_TEXT_VIEW_CHARS),
    reason,
    createdAt: Date.now(),
    nonce: randomBytes(8).toString('hex'),
  };
  if (reason === 'ended' && resultText) payload.resultText = resultText.slice(0, 500);
  return payload;
}

interface PostResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/** 单次 POST。永远不抛：超时、连不上、5xx 都翻译成结果对象。 */
async function postOnce(config: WakeConfig, payload: WakePayload): Promise<PostResult> {
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-wake-secret': config.secret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
    });
    // 必须把响应体读掉，否则连接不会被释放（Node fetch 的 keep-alive 需要消费完）。
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      const detail = text.trim().slice(0, 200);
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}${detail ? `：${detail}` : ''}`,
      };
    }
    return { ok: true, status: response.status, error: null };
  } catch (error) {
    return { ok: false, status: null, error: describeError(error) };
  }
}

/** 投递一次（含失败重试 1 次），结果只记录、不抛。 */
async function deliver(config: WakeConfig, payload: WakePayload): Promise<WakeOutcome> {
  const startedAt = Date.now();
  let attempts = 0;
  let lastError: string | null = null;
  let status: number | null = null;

  // 第一次 + 重试一次：人已经坐在牌桌前等你，多试一次比立刻放弃划算。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(WAKE_RETRY_DELAY_MS);
    attempts += 1;
    const result = await postOnce(config, payload);
    status = result.status;
    if (result.ok) {
      return { at: Date.now(), ok: true, attempts, status };
    }
    lastError = result.error;
  }

  return {
    at: Date.now(),
    ok: false,
    error: lastError ?? '未知错误',
    attempts,
    status,
  };
}

/**
 * 真正发出去（含去重记账 / 环形日志 / 诊断回调）。
 * 调用方只管「该不该叫」和「叫醒后说什么」，投递细节在这里收口。
 */
function dispatchWake(
  room: Room,
  config: WakeConfig,
  payload: WakePayload,
  key: string,
  options: { onResult?: (roomId: string, outcome: WakeOutcome) => void },
  maxPerKey: number,
): void {
  const now = Date.now();
  const previous = dedupe.get(room);
  if (previous && previous.key === key) {
    // 同一个 key（房间+回合 / 房间+ended）：3 秒内不重复叫，且累计不超过上限。
    if (now - previous.at < WAKE_DEDUPE_MS) return;
    if (previous.count >= maxPerKey) return;
  }
  dedupe.set(room, {
    key,
    at: now,
    count: previous && previous.key === key ? previous.count + 1 : 1,
  });

  if (config.secret === '' && !warnedMissingSecret) {
    warnedMissingSecret = true;
    // 这条只提醒一次：插件侧很可能以 bad-secret 拒绝，排查时省得翻半天。
    console.warn('[wake] 未配置 WAKE_SECRET：仍会投递，但插件侧很可能以 bad-secret 拒绝');
  }

  const task = deliver(config, payload)
    .then((outcome) => {
      wakeLog.push({
        at: outcome.at,
        roomId: payload.roomId,
        sessionId: payload.sessionId,
        round: payload.round,
        ok: outcome.ok,
        attempts: outcome.attempts,
        status: outcome.status,
        error: outcome.ok ? null : outcome.error,
        ms: outcome.at - now,
      });
      if (wakeLog.length > WAKE_LOG_LIMIT) wakeLog.shift();
      // 失败只记录、不抛：唤醒是旁路，绝不能把异常带进对局请求。
      if (!outcome.ok) {
        console.warn(
          `[wake] 唤醒失败（不影响对局）：房间 ${payload.roomId} 第 ${payload.round} 回合（${payload.reason}）→ ${outcome.error}`,
        );
      }
      try {
        options.onResult?.(payload.roomId, outcome);
      } catch (error) {
        // 诊断回调写坏了也只是少一条诊断，不许反过来影响投递链路。
        console.warn(`[wake] 记录唤醒诊断失败：${describeError(error)}`);
      }
    })
    .catch((error) => {
      // deliver 内部已经兜住了所有失败，这里只是最后一道保险。
      console.warn(`[wake] 投递任务异常（已忽略）：${describeError(error)}`);
    });

  inFlight.add(task);
  void task.finally(() => {
    inFlight.delete(task);
  });
}

/**
 * 触发一次「该你出招了」唤醒（fire-and-forget）：调用方**不要 await**，也不能让它影响对局。
 * 守卫全在这里：未配置 / 未绑定 / 不在 Agent 回合 / 去重窗口内，都直接返回。
 *
 * 第 16 轮：失败会自动退避重试（见 {@link scheduleRetry}），否则同时暗选局会永久卡死。
 */
export function scheduleAgentTurnWake(
  room: Room,
  options: { env?: NodeJS.ProcessEnv; onResult?: (roomId: string, outcome: WakeOutcome) => void } = {},
): void {
  // 新触发 = 新的回合语义，之前排着的重试作废（别让旧重试在换手后乱叫）。
  clearRetry(room);
  attemptAgentTurnWake(room, options, 0);
}

function attemptAgentTurnWake(
  room: Room,
  options: { env?: NodeJS.ProcessEnv; onResult?: (roomId: string, outcome: WakeOutcome) => void },
  attempt: number,
): void {
  const config = wakeConfigFromEnv(options.env);
  if (config === null) return; // 未配置 = 功能关闭，行为与今天完全一致
  if (!shouldWakeAgent(room) || !room.wake) return;

  // 读观测拿 round / textView；游戏内核万一抛异常，宁可漏叫也不乱叫。
  let round: number;
  let textView: string;
  try {
    const observation = room.game.observe(room.state, 1);
    round = Number(observation.round);
    textView = String(observation.textView ?? '');
  } catch (error) {
    console.warn(`[wake] 取 Agent 观测失败，跳过唤醒（房间 ${room.id}）：${describeError(error)}`);
    return;
  }
  if (!Number.isFinite(round)) return;

  const payload = buildPayload(room, round, textView, room.wake.sessionId, 'turn');
  // 重试用的 key 带 attempt 后缀：去重表是按「同 key 3 秒 / 上限次数」记账的，
  // 如果重试沿用同一个 key，会被「同回合最多 2 次」直接挡掉——那就等于没重试。
  const key = attempt === 0 ? `${room.id}:${round}` : `${room.id}:${round}:retry${attempt}`;
  const innerOnResult = options.onResult;
  dispatchWake(
    room,
    config,
    payload,
    key,
    {
      onResult: (roomId, outcome) => {
        try {
          innerOnResult?.(roomId, outcome);
        } catch (error) {
          console.warn(`[wake] 记录唤醒诊断失败：${describeError(error)}`);
        }
        if (outcome.ok) {
          clearRetry(room);
          return;
        }
        scheduleRetry(room, options, attempt + 1);
      },
    },
    WAKE_MAX_PER_ROUND,
  );
}

/**
 * 失败后退避重试：同一个房间只排一个定时器；每次触发前都重新判断「是否还轮到 Agent」，
 * 已经被人类反悔 / 对局结束 / 解除绑定的房间不会再被叫。
 */
function scheduleRetry(
  room: Room,
  options: { env?: NodeJS.ProcessEnv; onResult?: (roomId: string, outcome: WakeOutcome) => void },
  nextAttempt: number,
): void {
  const delays = retryDelays(options.env);
  if (nextAttempt > delays.length) {
    console.warn(`[wake] 房间 ${room.id} 唤醒重试 ${delays.length} 次仍失败，放弃（对局不受影响，人类可以发消息叫 Agent）`);
    return;
  }
  const delay = delays[nextAttempt - 1];
  clearRetry(room);
  const timer = setTimeout(() => {
    retryTimers.delete(room);
    attemptAgentTurnWake(room, options, nextAttempt);
  }, delay);
  // 不要让定时器把进程吊住（测试里尤其重要）。
  timer.unref?.();
  retryTimers.set(room, timer);
  console.warn(`[wake] 房间 ${room.id} 唤醒失败，${delay}ms 后重试（第 ${nextAttempt}/${delays.length} 次）`);
}

/**
 * 对局结束也唤醒一次（第 15 轮补）：人类赢了/输了，Agent 该知道结果并收尾，
 * 而不是等下一个人发消息才「猜」到自己已经输了。
 *
 * 与「该你出招」的区别：不看 currentSeat（终局恒为 null），只看是否已结束；
 * 同一个房间只叫一次（key = `房间:ended`，上限 1 次）。
 */
export function scheduleRoomEndWake(
  room: Room,
  options: { env?: NodeJS.ProcessEnv; onResult?: (roomId: string, outcome: WakeOutcome) => void } = {},
): void {
  // 终局了，之前排着的「该你出招」重试必须作废，别在结算后再叫一次。
  clearRetry(room);
  const config = wakeConfigFromEnv(options.env);
  if (config === null) return;
  if (!room.wake) return;
  if (room.status !== 'ended') return;

  let round: number;
  let textView: string;
  try {
    const observation = room.game.observe(room.state, 1);
    round = Number(observation.round);
    textView = String(observation.textView ?? '');
  } catch (error) {
    console.warn(`[wake] 取结算观测失败，跳过结束唤醒（房间 ${room.id}）：${describeError(error)}`);
    return;
  }
  if (!Number.isFinite(round)) return;

  const resultText = room.result?.text;
  const payload = buildPayload(room, round, textView, room.wake.sessionId, 'ended', resultText);
  dispatchWake(room, config, payload, `${room.id}:ended`, options, 1);
}

/** 等当前所有在飞的唤醒投递落定（测试用；线上没有任何地方需要它）。 */
export async function awaitPendingWakes(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

/** 环形日志快照（副本，调用方改了也不影响内部）。 */
export function wakeLogEntries(): WakeLogEntry[] {
  return wakeLog.map((entry) => ({ ...entry }));
}

/** 清空环形日志与去重状态（测试隔离用）。 */
export function resetWakeState(): void {
  wakeLog.length = 0;
  dedupe = new WeakMap<Room, DedupeState>();
  warnedMissingSecret = false;
}
