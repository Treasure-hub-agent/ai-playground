/** 座位号：0 = 人类，1 = Agent（MVP 约定）。 */
export type Seat = number;

export type GameStatus = 'playable' | 'wip';

/** simultaneous = 双方同时暗选；turn = 轮流行动 */
export type Resolution = 'simultaneous' | 'turn';

export interface GameMeta {
  id: string;
  name: string;
  tagline: string;
  seats: number;
  /** 给 Agent 读的规则文本（也作为 MCP resource 暴露）。 */
  rules: string;
  /** 大厅分类：派对 / 棋类 / 纸牌 / 骰子 / 语言 …… */
  category: string;
  /** 大厅筛选标签，例如 ['同时暗选', '短局', '心理战']。 */
  tags: string[];
  /** 单局时长的人话描述，例如 '60–90 秒'。 */
  duration: string;
  /** playable = 可开桌；wip = 路线图占位。 */
  status: GameStatus;
  /** 卡片主题色（CSS 颜色），用于大厅微渐变与点缀。 */
  accent: string;
  /** 结算模式：同时暗选 or 轮流行动。 */
  resolution: Resolution;
}

export type Action = Record<string, unknown>;

export interface BaseObservation {
  gameId: string;
  /**
   * 请求方被判定持有的座位；**null = 旁观者**（没有该座位的令牌）。
   * seat 为 null 时这里的一切都必须是公开信息：legalActions 为空、私有字段被遮蔽。
   */
  seat: Seat | null;
  round: number;
  roundsTotal: number;
  scores: Record<string, number>;
  /** 本回合可执行的动作（枚举，供 Agent 直接引用）；旁观者恒为空数组。 */
  legalActions: Action[];
  /** 纯文本局面（适配纯文本 Agent）。 */
  textView: string;
  status: "waiting" | "playing" | "ended";
  /** 当前行动方（turn 模式有意义；simultaneous 模式恒为 null）。 */
  currentSeat?: Seat | null;
  /** 现在是不是轮到你（以「本回合你还没提交」为准）；旁观者恒为 false。 */
  isYourTurn?: boolean;
}

export type Observation = BaseObservation & Record<string, unknown>;

export interface GameEvent {
  type: string;
  [key: string]: unknown;
}

export interface GameResultSummary {
  winner: Seat | null;
  scores: Record<string, number>;
  text: string;
}

/**
 * 游戏内核接口。
 * - step 接收「所有座位本回合的动作」，支持同时暗选类游戏；轮流制游戏可只传当前座位。
 * - observe 是观测唯一出口：隐藏信息必须在这里遮蔽；
 *   **seat = null 表示旁观者**，此时必须返回公开视图（legalActions 为空、私有字段遮蔽）。
 */
export interface GameSpec<TState = unknown, TObs extends object = object> {
  meta: GameMeta;
  setup(seed: number): TState;
  observe(state: TState, seat: Seat | null): TObs & BaseObservation;
  legalActions(state: TState, seat: Seat): Action[];
  step(state: TState, actions: Record<Seat, Action>): { state: TState; events: GameEvent[] };
  isTerminal(state: TState): boolean;
  result(state: TState): GameResultSummary;
  /** 仅在 meta.resolution === 'turn' 时需要实现。 */
  currentSeat?(state: TState): Seat | null;
}
