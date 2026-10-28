/**
 * 与 docs/api-contract.md 对齐的前端类型。
 * 字段名一律以服务端契约为准，不要在组件里临时改名。
 */

export type Seat = 0 | 1;

export type RoomStatus = 'waiting' | 'playing' | 'ended';

export type CellCoord = [number, number];

/** 服务端格子的 JSON 形态：金币面值 / 炸弹 / 空格 / 已被抢走 */
export type GridCell = 1 | 2 | 3 | 'bomb' | 'empty' | 'taken';

/** 通用动作：抓宝/落子是格子类，快艇骰子是 roll/hold/score，这里只要求可序列化。 */
export type AnyAction = Record<string, unknown>;

/** 猜拳的三种出手。 */
export type RpsShape = 'rock' | 'paper' | 'scissors';


export interface LegalAction {
  action: 'grab';
  cell: CellCoord;
}

export interface RoundRecord {
  round: number;
  picks: Record<string, CellCoord>;
  delta: Record<string, number>;
  collision: boolean;
}

export interface GameResultSummary {
  winner: Seat | null;
  scores: Record<string, number>;
  text: string;
}

export interface ChatMessage {
  id: number;
  seat: number;
  text: string;
  at: number;
}

export interface GrabObservation {
  gameId: string;
  /** null = 旁观者（这个浏览器没有该座位的令牌） */
  seat: number | null;
  /** 服务端判定请求方无座位凭据时返回旁观视图：legalActions 为空、私有字段已遮蔽 */
  spectator?: boolean;
  round: number;
  roundsTotal: number;
  scores: Record<string, number>;
  legalActions: LegalAction[];
  textView: string;
  status: RoomStatus;
  grid: GridCell[][];
  history: RoundRecord[];
  yourScore: number;
  opponentScore: number;
  roomId: string;
  youSubmitted: boolean;
  waitingFor: number[];
  currentSeat?: number | null;
  isYourTurn?: boolean;
  result: GameResultSummary | null;
}

export interface GameMeta {
  id: string;
  name: string;
  tagline: string;
  seats: number;
  rules: string;
  category: string;
  tags: string[];
  duration: string;
  status: 'playable' | 'wip';
  accent: string;
  /** 结算模式：同时暗选 / 轮流行动（服务端 /api/games 会带） */
  resolution?: 'simultaneous' | 'turn';
}

export interface CreateRoomResponse {
  roomId: string;
  gameId: string;
  humanUrlPath: string;
  agentSeat: number;
  rules: string;
  /** 各座位的入座令牌：{"0":"<hex>"}；1 号位由 Agent 在 join 时领取 */
  seatTokens?: Record<string, string>;
}

export interface RoomSummary {
  roomId: string;
  gameId: string;
  status: RoomStatus;
  round: number;
  scores: Record<string, number>;
  occupied: [boolean, boolean];
  pendingSeats: number[];
  result: GameResultSummary | null;
  /** 仅创建房间的响应会带（含座位令牌）；公开的 summary 里不含，避免泄露凭据 */
  humanUrlPath?: string;
}

export interface SubmitActionResponse {
  ok: boolean;
  resolved: boolean;
  events: GameEvent[];
}

export interface RevealEvent {
  type: 'reveal';
  round: number;
  picks: Record<string, CellCoord>;
  delta: Record<string, number>;
  applied: Record<string, string>;
  collision: boolean;
  scores: Record<string, number>;
  grid: GridCell[][];
}

/** 猜拳：一局揭示事件（结构和 grab 的 reveal 不同，没有 picks/grid） */
export interface RpsRevealEvent {
  type: 'reveal';
  round: number;
  shapes: { 0: RpsShape; 1: RpsShape };
  winner: Seat | null;
  points: number;
  delta: Record<number, number>;
  scores: Record<number, number>;
  labels?: Record<number, string>;
}

export interface EndEvent {
  type: 'end';
  result: GameResultSummary;
}

export interface ChatEvent {
  type: 'chat';
  message: ChatMessage;
}

/** 快艇骰子：掷骰事件（dice 是重掷后的完整骰面） */
export interface RollEvent {
  type: 'roll';
  seat: number;
  dice: number[];
  held: boolean[];
  rollsLeft: number;
}

/** 快艇骰子：锁定切换事件（held 是切换后的完整快照） */
export interface HoldEvent {
  type: 'hold';
  seat: number;
  held: boolean[];
}

/** 快艇骰子：记分事件（只有它会换手） */
export interface ScoreEvent {
  type: 'score';
  seat: number;
  category: YachtCategory;
  gained: number;
  scorecard: YachtScorecard;
  nextSeat: number | null;
}

/** 深海猎手：一次炮击事件 */
export interface FireEvent {
  type: 'fire';
  seat: number;
  cell: CellCoord;
  label?: string;
  hit: boolean;
  sunk: string | null;
  opponentShipsLeft?: number;
  nextSeat?: number | null;
}

/** 黑白棋：一次落子事件 */
export interface PlaceEvent {
  type: 'place';
  seat: number;
  cell: CellCoord;
  flips: CellCoord[];
  counts?: Record<string, number>;
  board?: ReversiDisc[][];
}

/** 黑白棋：无子可下自动跳过事件 */
export interface PassEvent {
  type: 'pass';
  seat: number;
  nextSeat?: number | null;
}

export type GameEvent =
  | RevealEvent
  | RpsRevealEvent
  | EndEvent
  | ChatEvent
  | RollEvent
  | HoldEvent
  | ScoreEvent
  | FireEvent
  | PlaceEvent
  | PassEvent;

export type ServerWsMessage =
  | { type: 'hello'; roomId: string; summary: RoomSummary | null }
  | { type: 'events'; roomId: string; events: GameEvent[] };

/** 四子棋观测（turn 模式）：board 6×7，0 空 / 1 seat0 / 2 seat1 */
export interface Connect4Observation {
  gameId: string;
  /** null = 旁观者（这个浏览器没有该座位的令牌） */
  seat: number | null;
  /** 服务端判定请求方无座位凭据时返回旁观视图：legalActions 为空、私有字段已遮蔽 */
  spectator?: boolean;
  round: number;
  roundsTotal: number;
  scores: Record<string, number>;
  legalActions: Array<{ action: 'drop'; column: number }>;
  textView: string;
  status: RoomStatus;
  board: number[][];
  history: Array<{ seat: number; column: number; row: number }>;
  currentSeat?: number | null;
  isYourTurn?: boolean;
  yourScore: number;
  opponentScore: number;
  roomId: string;
  youSubmitted: boolean;
  waitingFor: number[];
  result: GameResultSummary | null;
}

/** 快艇骰子的 13 个栏目 id（顺序即计分板顺序） */
export type YachtCategory =
  | 'ones'
  | 'twos'
  | 'threes'
  | 'fours'
  | 'fives'
  | 'sixes'
  | 'three_kind'
  | 'four_kind'
  | 'full_house'
  | 'small_straight'
  | 'large_straight'
  | 'yacht'
  | 'chance';

export interface YachtScorecard {
  ones: number | null;
  twos: number | null;
  threes: number | null;
  fours: number | null;
  fives: number | null;
  sixes: number | null;
  three_kind: number | null;
  four_kind: number | null;
  full_house: number | null;
  small_straight: number | null;
  large_straight: number | null;
  yacht: number | null;
  chance: number | null;
  upperSubtotal: number;
  upperBonus: number;
  total: number;
}

export interface YachtTurnRecord {
  seat: number;
  category: YachtCategory;
  gained: number;
  dice: number[];
}

/** 快艇骰子观测（turn 模式） */
export interface YachtObservation {
  gameId: string;
  /** null = 旁观者（这个浏览器没有该座位的令牌） */
  seat: number | null;
  /** 服务端判定请求方无座位凭据时返回旁观视图：legalActions 为空、私有字段已遮蔽 */
  spectator?: boolean;
  round: number;
  roundsTotal: number;
  scores: Record<string, number>;
  legalActions: AnyAction[];
  textView: string;
  status: RoomStatus;
  currentSeat?: number | null;
  isYourTurn?: boolean;
  dice: number[];
  held: boolean[];
  rollsLeft: number;
  phase: 'roll' | 'choice' | 'must_score';
  scorecards: Record<string, YachtScorecard>;
  /** 当前骰面对 13 格各能得多少分；已记过的格子 / 未掷骰 / 非自己回合时为 null */
  previewScores: Record<YachtCategory, number | null>;
  upperTarget: number;
  upperBonusValue: number;
  history: YachtTurnRecord[];
  yourScore: number;
  opponentScore: number;
  roomId: string;
  youSubmitted: boolean;
  waitingFor: number[];
  result: GameResultSummary | null;
}

/** 猜拳：一局已揭示的历史（座位相对视角） */
export interface RpsHistoryEntry {
  round: number;
  yourShape: RpsShape;
  opponentShape: RpsShape;
  outcome: 'win' | 'lose' | 'draw';
  points: number;
  yourDelta: number;
  opponentDelta: number;
  scoreAfter: { you: number; opponent: number };
}

/** 猜拳心理战观测（simultaneous 模式） */
export interface RpsObservation {
  gameId: string;
  /** null = 旁观者（这个浏览器没有该座位的令牌） */
  seat: number | null;
  /** 服务端判定请求方无座位凭据时返回旁观视图：legalActions 为空、私有字段已遮蔽 */
  spectator?: boolean;
  round: number;
  roundsTotal: number;
  scores: Record<string, number>;
  legalActions: Array<{ action: 'throw'; shape: RpsShape }>;
  textView: string;
  status: RoomStatus;
  currentSeat?: number | null;
  isYourTurn?: boolean;
  history: RpsHistoryEntry[];
  /** 每局分值表 [1, 1, 2]，用于画决胜局 ×2 标记 */
  roundPoints: number[];
  /** 当前局值多少分；终局为 null */
  currentRoundPoints: number | null;
  yourScore: number;
  opponentScore: number;
  roomId: string;
  youSubmitted: boolean;
  waitingFor: number[];
  result: GameResultSummary | null;
}

/** 通用观测：房间页按 gameId 取对应实现 */
export type RoomObservation =
  | GrabObservation
  | Connect4Observation
  | YachtObservation
  | RpsObservation
  | BattleshipObservation
  | ReversiObservation;

/* ── 深海猎手（battleship） ─────────────────────────────────────────────── */

export type EnemyCell = 'unknown' | 'miss' | 'hit' | 'sunk';

export interface BattleshipShipView {
  id: string;
  name: string;
  size: number;
  cells: CellCoord[];
  hitCells: CellCoord[];
  sunk: boolean;
}

export interface BattleshipShot {
  round: number;
  seat: number;
  cell: CellCoord;
  hit: boolean;
  sunk: string | null;
}

export interface BattleshipObservation {
  gameId: string;
  /** null = 旁观者（这个浏览器没有该座位的令牌） */
  seat: number | null;
  /** 服务端判定请求方无座位凭据时返回旁观视图：legalActions 为空、私有字段已遮蔽 */
  spectator?: boolean;
  round: number;
  roundsTotal: number;
  scores: Record<string, number>;
  legalActions: Array<{ action: 'fire'; cell: CellCoord }>;
  textView: string;
  status: RoomStatus;
  currentSeat?: number | null;
  isYourTurn?: boolean;
  /** 我方舰队（对自己公开） */
  yourFleet: BattleshipShipView[];
  /** 5×5 敌方海域：只有打过的格子透出结果 */
  enemyGrid: EnemyCell[][];
  enemyShipsLeft: number;
  yourShipsLeft: number;
  lastShot: BattleshipShot | null;
  shotsFired: number;
  roomId: string;
  youSubmitted: boolean;
  waitingFor: number[];
  result: GameResultSummary | null;
}

/* ── 黑白棋（reversi） ─────────────────────────────────────────────────── */

export type ReversiDisc = 0 | 1 | null;

export interface ReversiMove {
  move: number;
  seat: number;
  cell: CellCoord;
  flips: CellCoord[];
}

export interface ReversiObservation {
  gameId: string;
  /** null = 旁观者（这个浏览器没有该座位的令牌） */
  seat: number | null;
  /** 服务端判定请求方无座位凭据时返回旁观视图：legalActions 为空、私有字段已遮蔽 */
  spectator?: boolean;
  round: number;
  roundsTotal: number;
  scores: Record<string, number>;
  legalActions: Array<{ action: 'place'; cell: CellCoord }>;
  textView: string;
  status: RoomStatus;
  currentSeat?: number | null;
  isYourTurn?: boolean;
  /** 8×8，0 = 座位0（你），1 = 座位1（Agent），null 空 */
  board: ReversiDisc[][];
  yourDiscs: number;
  opponentDiscs: number;
  lastMove: ReversiMove | null;
  lastPassSeat: number | null;
  roomId: string;
  youSubmitted: boolean;
  waitingFor: number[];
  result: GameResultSummary | null;
}
