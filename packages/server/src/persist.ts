/**
 * 房间落盘（第 13 轮 P1，契约见 docs/design-engineering-round13.md §2）
 *
 * 为什么单独一个文件：rooms.ts 管的是「房间怎么活」，这里管的是「房间怎么存」。
 * 拆开之后测试可以直接对快照 / 读写 / 调度器下手，不用先搭一局游戏。
 *
 * 一条硬规矩：**快照里绝不能出现 `room.game`**。
 * `GameSpec` 带函数（setup / step / observe …），JSON.stringify 会把这些键整块丢掉，
 * 读回来的 `game` 变成空对象，下一次 `room.game.observe(...)` 就是
 * "undefined is not a function"，而且错在离现场很远的地方。所以 `RoomSnapshot`
 * 用 `Omit<Room, 'game'>`：一旦 Room 新增字段，这里不补字段就**编译不过**，
 * 逼着人回来显式决定「这个新字段要不要落盘」。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getGame } from '@ai-playground/core';
import type { Room, WakeBinding } from './rooms.ts';

/** 快照格式版本：字段含义变了就 +1，读盘时版本不符一律当空启动，不做半吊子迁移。 */
export const PERSIST_VERSION = 1;

/** 落盘文件名（放在 dataDir 下）。 */
export const ROOMS_FILE_NAME = 'rooms.json';

/** Room 去掉 `game` 之后的纯数据形状。 */
export type RoomSnapshot = Omit<Room, 'game'>;

export interface PersistedRoomsFile {
  version: number;
  savedAt: number;
  rooms: RoomSnapshot[];
}

/** 落盘策略：文件路径 + 合并写盘的防抖窗口。 */
export interface PersistConfig {
  file: string;
  debounceMs?: number;
}

export const DEFAULT_DEBOUNCE_MS = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 从环境变量解析落盘策略（设计稿 §2「存储」）：
 * - `PLAYGROUND_DATA_DIR` 覆盖数据目录，默认 `./data`（按启动时的 cwd 解析成绝对路径，
 *   这样日志里的路径和实际写入位置对得上，不会因为后来 chdir 漂移）；
 * - `PLAYGROUND_PERSIST=0` 完全关闭——测试和一次性演示用，此时一个字节都不写。
 */
export function persistConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PersistConfig | null {
  if (env.PLAYGROUND_PERSIST === '0') return null;
  const dataDir = resolve(env.PLAYGROUND_DATA_DIR ?? './data');
  return { file: join(dataDir, ROOMS_FILE_NAME) };
}

/**
 * Room → 快照。显式逐字段列出，理由见文件头：
 * ① 用 `{ ...room }` 会把 `game` 一起带进去，正是要避免的东西；
 * ② 数组字段重新拷贝一份，快照与活房间不共享可变引用（写盘期间房间还在被改）。
 */
export function toSnapshot(room: Room): RoomSnapshot {
  return {
    id: room.id,
    gameId: room.gameId,
    seed: room.seed,
    state: room.state,
    status: room.status,
    occupied: [room.occupied[0], room.occupied[1]],
    // 第 12 轮加的座位令牌：与房间同生命周期，必须原样落盘，
    // 否则重启后浏览器手里的令牌全失效，所有人都得重新入座。
    seatTokens: [room.seatTokens[0], room.seatTokens[1]],
    pending: [room.pending[0], room.pending[1]],
    // 唤醒桥绑定必须落盘：重启后人类继续落子，还得能叫醒同一个会话。
    // lastWakeAt / lastWakeError 是进程内运行态，刻意不落盘（重启后按「没叫过」呈现）。
    wake: room.wake ? { sessionId: room.wake.sessionId, boundAt: room.wake.boundAt } : null,
    chat: room.chat,
    log: room.log,
    result: room.result,
    createdAt: room.createdAt,
    lastActivity: room.lastActivity,
    lastSayAt: room.lastSayAt,
    chatSeq: room.chatSeq,
  };
}

/**
 * 从快照里读唤醒绑定。磁盘上的文件可能被手改过，所以逐字段校验：
 * 形状不对就当「没绑定」，不要把一个会抛异常的绑定装回房间。
 */
function readWakeBinding(value: unknown): WakeBinding | null {
  if (!isRecord(value)) return null;
  const sessionId = value.sessionId;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  const boundAt = Number(value.boundAt);
  return {
    sessionId,
    boundAt: Number.isFinite(boundAt) && boundAt > 0 ? boundAt : Date.now(),
  };
}

/**
 * 快照 → Room；未知游戏（或快照缺 id）返回 null，由调用方丢弃并 warn。
 *
 * 这里同样逐字段重建而不用 `{ ...snapshot, game }`：文件在磁盘上可能被人手改过、
 * 也可能是别的版本写的，多余字段不该混进 Room。顺带把几个可选字段兜底，
 * 让「半截快照」退化成能跑的房间，而不是在下一帧抛 TypeError。
 */
export function fromSnapshot(snapshot: RoomSnapshot): Room | null {
  if (!isRecord(snapshot)) return null;
  if (typeof snapshot.id !== 'string' || snapshot.id === '') return null;
  if (typeof snapshot.gameId !== 'string') return null;
  const game = getGame(snapshot.gameId);
  if (!game) return null;
  return {
    id: snapshot.id,
    gameId: snapshot.gameId,
    // 唯一不能从 JSON 里读回来的东西：用注册表里的 GameSpec 重新挂上。
    game,
    seed: snapshot.seed,
    state: snapshot.state,
    status: snapshot.status,
    occupied: [Boolean(snapshot.occupied?.[0]), Boolean(snapshot.occupied?.[1])],
    seatTokens: [snapshot.seatTokens?.[0] ?? null, snapshot.seatTokens?.[1] ?? null],
    pending: [snapshot.pending?.[0] ?? null, snapshot.pending?.[1] ?? null],
    // 旧文件（第 14 轮之前写的）没有 wake 字段：当成「没绑定」恢复即可，
    // 所以**不 bump PERSIST_VERSION**——一 bump 就会把主人机器上正在打的真实房间全丢。
    wake: readWakeBinding(snapshot.wake),
    chat: Array.isArray(snapshot.chat) ? snapshot.chat : [],
    log: Array.isArray(snapshot.log) ? snapshot.log : [],
    result: snapshot.result ?? null,
    createdAt: Number(snapshot.createdAt) || Date.now(),
    lastActivity: Number(snapshot.lastActivity) || Date.now(),
    lastSayAt: isRecord(snapshot.lastSayAt) ? (snapshot.lastSayAt as Record<number, number>) : {},
    chatSeq: Number(snapshot.chatSeq) || 1,
  };
}

/**
 * 读盘。**永不抛**：不存在 / JSON 坏 / 版本不匹配都是「从空开始 + warning」。
 * 理由：一个坏文件不该让整个服务起不来——房间可以重开，服务起不来就什么都没了。
 */
export function loadRooms(file: string): RoomSnapshot[] {
  try {
    if (!existsSync(file)) {
      // 首次启动的常规路径，别用 warning：一个正常的空启动不该在控制台里长得像出错。
      // 真正需要人注意的情况（JSON 坏 / 版本不匹配 / 读失败）下面各自有 warning。
      return [];
    }
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(parsed)) {
      console.warn(`[persist] 房间文件顶层不是对象，忽略：${file}`);
      return [];
    }
    if (parsed.version !== PERSIST_VERSION) {
      // 不做迁移：宁可空启动也不要拿旧结构去喂新代码（错在更远的地方更难查）。
      console.warn(
        `[persist] 房间文件版本不匹配（文件 ${String(parsed.version)}，当前 ${PERSIST_VERSION}），忽略旧数据：${file}`,
      );
      return [];
    }
    if (!Array.isArray(parsed.rooms)) {
      console.warn(`[persist] 房间文件的 rooms 不是数组，忽略：${file}`);
      return [];
    }
    return parsed.rooms as RoomSnapshot[];
  } catch (error) {
    console.warn(`[persist] 读取房间文件失败（按空启动）：${file} — ${describeError(error)}`);
    return [];
  }
}

/**
 * 写盘：先写 `<file>.tmp`，再 `renameSync` 覆盖。
 * rename 在同一文件系统内是原子的，所以任何时刻磁盘上的 rooms.json 要么是旧的完整内容、
 * 要么是新的完整内容；进程在写一半时被 kill 只会留下 .tmp，不会留下半截 JSON。
 */
export function saveRooms(file: string, snapshots: RoomSnapshot[]): void {
  // 目录可能第一次还不存在；放在这里而不是入口，任何调用方都不用先操心建目录。
  mkdirSync(dirname(file), { recursive: true });
  const payload: PersistedRoomsFile = {
    version: PERSIST_VERSION,
    savedAt: Date.now(),
    rooms: snapshots,
  };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload), 'utf8');
  renameSync(tmp, file);
}

/**
 * 计时器抽象：生产用真 setTimeout，测试可以注入假时钟，
 * 这样「400ms 防抖」不用真的 sleep 400ms，也不会让用例互相抢时序。
 */
export interface PersistTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const systemPersistTimers: PersistTimers = {
  set(fn, ms) {
    const handle = setTimeout(fn, ms);
    // unref：只有一个待写盘定时器时不该拖着进程不退出（退出前有 flushSync 兜底）。
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export interface PersistSchedulerOptions {
  file: string;
  /** 取当前全量快照——只有真正写盘时才调用，避免每次打点都白跑一遍 O(n)。 */
  snapshot: () => RoomSnapshot[];
  debounceMs?: number;
  timers?: PersistTimers;
  onError?: (error: unknown) => void;
}

/**
 * 防抖写盘调度器：改状态时 `schedule()`，最后一次打点后静默 `debounceMs` 才真正落盘。
 *
 * 为什么必须防抖：一次同时暗选结算会连着改 pending / state / log 三处，
 * 每一步都写一次盘就是三倍 I/O；聊天刷屏同理。合并之后磁盘压力与房间活跃度解耦。
 */
export class PersistScheduler {
  readonly file: string;
  private readonly debounceMs: number;
  private readonly snapshot: () => RoomSnapshot[];
  private readonly timers: PersistTimers;
  private readonly onError: (error: unknown) => void;

  private dirty = false;
  private handle: unknown = null;
  private writeCount = 0;

  constructor(options: PersistSchedulerOptions) {
    this.file = options.file;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.snapshot = options.snapshot;
    this.timers = options.timers ?? systemPersistTimers;
    this.onError = options.onError ?? ((error) => console.warn(`[persist] 写盘失败：${describeError(error)}`));
  }

  /** 标记有变更；已经在等的那次定时器不重排（首个变更起算，最多等 debounceMs）。 */
  schedule(): void {
    this.dirty = true;
    if (this.handle !== null) return;
    this.handle = this.timers.set(() => {
      this.handle = null;
      this.flush();
    }, this.debounceMs);
  }

  /** 立即同步落盘；返回是否真的写了。没有变更就不写。 */
  flush(): boolean {
    if (this.handle !== null) {
      this.timers.clear(this.handle);
      this.handle = null;
    }
    if (!this.dirty) return false;
    this.dirty = false;
    try {
      saveRooms(this.file, this.snapshot());
      this.writeCount += 1;
    } catch (error) {
      // 写盘失败不能把服务打死（磁盘满 / 权限），但下次变更还得能再试，所以把 dirty 还回去。
      this.dirty = true;
      this.onError(error);
      return false;
    }
    return true;
  }

  /** 取消待写盘（关闭持久化 / 测试收尾用），不 flush。 */
  stop(): void {
    if (this.handle !== null) {
      this.timers.clear(this.handle);
      this.handle = null;
    }
    this.dirty = false;
  }

  /** 是否还有未落盘的变更（测试断言用）。 */
  get pending(): boolean {
    return this.dirty;
  }

  /** 累计成功写盘次数（用来验证防抖真的合并了）。 */
  get writes(): number {
    return this.writeCount;
  }
}
