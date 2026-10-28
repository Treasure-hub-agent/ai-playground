import { mulberry32, randInt } from '../rng.ts';
import type {
  Action,
  BaseObservation,
  GameEvent,
  GameMeta,
  GameResultSummary,
  GameSpec,
  Seat,
} from '../types.ts';

/** 骰子颗数。 */
export const DICE_COUNT = 5;
/** 一手最多掷骰次数。 */
export const MAX_ROLLS = 3;

/** 13 个栏目 id（顺序即计分板的显示顺序：上区 6 格 + 下区 7 格）。 */
export const CATEGORIES = [
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

export type Category = (typeof CATEGORIES)[number];

/** 上区 6 格。 */
export const UPPER_CATEGORIES = CATEGORIES.slice(0, 6) as readonly Category[];
/** 下区 7 格。 */
export const LOWER_CATEGORIES = CATEGORIES.slice(6) as readonly Category[];

/** 栏目中文名（textView 与前端计分板共用）。 */
export const CATEGORY_LABELS: Record<Category, string> = {
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

/** 上区奖励门槛：上区 6 格合计 ≥ 63。 */
export const UPPER_TARGET = 63;
/** 上区奖励分数。 */
export const UPPER_BONUS = 35;
/** 一局总手数：每人 13 手（13 格各一次）。grab 已有同名 ROUNDS_TOTAL，这里加前缀避免 index.ts 重导出冲突。 */
export const YACHT_ROUNDS_TOTAL = CATEGORIES.length * 2;

/** 葫芦固定分。 */
export const FULL_HOUSE_SCORE = 25;
/** 小顺固定分。 */
export const SMALL_STRAIGHT_SCORE = 30;
/** 大顺固定分。 */
export const LARGE_STRAIGHT_SCORE = 40;
/** 快艇固定分。 */
export const YACHT_SCORE = 50;

/**
 * 一手内的子状态：
 * - `roll`       还没掷过骰（dice 全 0），只能 roll；
 * - `choice`     掷过骰、还有剩余次数，可以 roll / hold / score；
 * - `must_score` 3 次掷骰用完，只能 score。
 */
export type Phase = 'roll' | 'choice' | 'must_score';

/** 单个栏目：null = 还没记过；number = 已记的分数（可能是 0）。 */
export type Card = Record<Category, number | null>;
/** 双方计分表。 */
export type Cards = Record<Seat, Card>;

/** 一手记录（一手 = 一次 score）。 */
export interface TurnRecord {
  seat: Seat;
  category: Category;
  gained: number;
  dice: number[];
}

export interface YachtState {
  /** 种子：整局的骰子序列由它唯一决定。 */
  seed: number;
  /** 已经消耗掉的随机数个数：保证「同 seed 同掷骰序列」，且状态可序列化。 */
  draws: number;
  /** 5 颗骰子点数；0 = 本手还没掷。 */
  dice: number[];
  /** 锁定的骰子（true = 本次重掷保持不变）。 */
  held: boolean[];
  /** 本手还剩几次掷骰（3 → 0）。 */
  rollsLeft: number;
  phase: Phase;
  /** 当前该谁行动；终局后语义失效，读「当前行动方」请用 currentSeat。 */
  turn: Seat;
  cards: Cards;
  history: TurnRecord[];
}

/** 计分板单方快照：13 格 + 上区小计 + 上区奖励 + 总分。 */
export interface Scorecard {
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
  /** 上区 6 格合计。 */
  upperSubtotal: number;
  /** 上区奖励：小计 ≥ 63 时为 35，否则 0。 */
  upperBonus: number;
  /** 总分 = 上区小计 + 上区奖励 + 下区合计。 */
  total: number;
}

export interface YachtObservation extends BaseObservation {
  dice: number[];
  held: boolean[];
  rollsLeft: number;
  phase: Phase;
  scorecards: Record<Seat, Scorecard>;
  /** 当前骰面对 13 格各能得多少分；已记过的格子、未掷骰、不是你的回合时为 null。 */
  previewScores: Record<Category, number | null>;
  upperTarget: number;
  upperBonusValue: number;
  history: TurnRecord[];
}

const RULES = `快艇骰子（Yacht，简化版 Yahtzee）
一句话规则：每手最多掷 3 次 5 颗骰子，可锁定保留的骰子重掷其余骰子，然后在 13 个栏目里选一格记分；双方各填满 13 格后比总分。

细节：
- 5 颗六面骰（d6）。一手内：掷骰 → 可锁定/解锁任意多颗 → 再掷未锁定的骰，最多共掷 3 次 → 必须选一格记分。
- 骰子点数只由服务端产生（种子化随机），动作里不能指定点数，只能决定「掷」与「锁」。
- 锁定是切换语义：{"action":"hold","indices":[0]} 把第 0 颗切成锁定，再传一次就解锁；**一次 hold 只切换一颗**，要锁多颗就连续发多次 hold；indices 传空数组表示全部解锁。
- 必须先掷至少 1 次才能记分。3 次掷骰用完（phase = must_score）后只能记分，legalActions 里不再有 roll / hold。
- 记分后立刻换手：dice 归零、锁定清空、rollsLeft 回到 3、phase 回到 roll。一手中只有 score 会换手。
- 每个栏目一局只能用一次；打不出分也必须选一格记 0 分（这是策略的一部分）。
- 13 个栏目 id 固定：
  上区 ones / twos / threes / fours / fives / sixes（一点…六点）：只累计该点数之和。
  下区 three_kind（三条：≥3 颗同点 → 五骰总和，否则 0）、four_kind（四条：≥4 颗同点 → 五骰总和，否则 0）、
      full_house（葫芦：恰好 3+2 → 25，5 颗同点不算葫芦）、small_straight（小顺：含 4 个连续点数 → 30）、
      large_straight（大顺：5 个连续点数 → 40）、yacht（快艇：5 颗同点 → 50）、chance（全骰：五骰总和）。
- 小顺与大顺独立计分：掷出 1-2-3-4-5 时既可以记大顺 40，也可以记小顺 30。
- 上区奖励：上区 6 格合计 ≥ 63 时额外 +35（记在上区奖励 upperBonus，只加一次）。
- 终局：双方各自填满 13 格（共 26 手）；总分高者获胜，同分平局。总分 = 上区小计 + 上区奖励 + 下区合计。

动作：
  {"action":"roll"}                             掷骰（只重掷未锁定的骰）
  {"action":"hold","indices":[0]}                切换第 0 颗的锁定（一次只切一颗；indices:[] 表示全部解锁）
  {"action":"score","category":"full_house"}    记分（category 见上，且本玩家还没用过）
可用动作见 legalActions；**只有轮到你时 legalActions 才非空**，不是你的回合请等待（先看 isYourTurn / currentSeat）。
观测里的 previewScores 给出「当前骰面对 13 格各能得多少分」；已记过的格子恒为 null，未掷骰或不是你的回合时也全为 null。`;

/** 空的计分表（每格 null = 未记分）。 */
export function emptyCard(): Card {
  const card = {} as Card;
  for (const category of CATEGORIES) card[category] = null;
  return card;
}

/** 该格是否还没记分。 */
export function isCardFull(card: Card): boolean {
  return CATEGORIES.every((category) => card[category] !== null);
}

/** 已记分的格子数。 */
export function filledCount(card: Card): number {
  return CATEGORIES.reduce((n, category) => n + (card[category] === null ? 0 : 1), 0);
}

/** 该文案是否 13 个合法栏目之一。 */
export function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

/** 是否已经掷过骰（phase 离开 roll 就代表至少掷过一次）。 */
export function hasRolled(state: YachtState): boolean {
  return state.phase === 'choice' || state.phase === 'must_score';
}

/** 数每个点数出现的次数，返回下标 1-6 的数组（下标 0 恒为 0）。 */
function countFaces(dice: readonly number[]): number[] {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const face of dice) {
    if (face >= 1 && face <= 6) counts[face]++;
  }
  return counts;
}

/** 骰面里是否含有长度为 length 的连续点数序列（小顺 4 连 / 大顺 5 连）。 */
function hasConsecutiveRun(dice: readonly number[], length: number): boolean {
  const faces = new Set(dice);
  for (let start = 1; start + length - 1 <= 6; start++) {
    let ok = true;
    for (let face = start; face < start + length; face++) {
      if (!faces.has(face)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * 单一栏目在给定骰面下的得分（纯函数，13 类判定全在这里）。
 * 注意：大顺（1-2-3-4-5 / 2-3-4-5-6）同时也满足小顺的「4 连」，两种栏目各自独立可记。
 */
export function scoreCategory(dice: readonly number[], category: Category): number {
  const counts = countFaces(dice);
  const sum = dice.reduce((total, face) => total + face, 0);
  const maxCount = Math.max(...counts);

  switch (category) {
    case 'ones':
      return counts[1] * 1;
    case 'twos':
      return counts[2] * 2;
    case 'threes':
      return counts[3] * 3;
    case 'fours':
      return counts[4] * 4;
    case 'fives':
      return counts[5] * 5;
    case 'sixes':
      return counts[6] * 6;
    case 'three_kind':
      return maxCount >= 3 ? sum : 0;
    case 'four_kind':
      return maxCount >= 4 ? sum : 0;
    case 'full_house': {
      // 恰好 3+2：只统计出现的点数种类，必须正好两种且分别是 3 颗与 2 颗（5 颗同点不算）
      const groups = counts.filter((n) => n > 0).sort((a, b) => a - b);
      return groups.length === 2 && groups[0] === 2 && groups[1] === 3 ? FULL_HOUSE_SCORE : 0;
    }
    case 'small_straight':
      return hasConsecutiveRun(dice, 4) ? SMALL_STRAIGHT_SCORE : 0;
    case 'large_straight':
      return hasConsecutiveRun(dice, 5) ? LARGE_STRAIGHT_SCORE : 0;
    case 'yacht':
      return maxCount === 5 ? YACHT_SCORE : 0;
    case 'chance':
      return sum;
    default:
      return 0;
  }
}

/** 当前骰面对 13 格各自的得分（14 键全在，含未掷骰时全 0 的情形）。 */
export function previewScoresOf(dice: readonly number[]): Record<Category, number> {
  const out = {} as Record<Category, number>;
  for (const category of CATEGORIES) out[category] = scoreCategory(dice, category);
  return out;
}

/** 计分表 → 计分板快照（上区小计 / 上区奖励 / 总分）。 */
export function summarizeCard(card: Card): Scorecard {
  let upperSubtotal = 0;
  for (const category of UPPER_CATEGORIES) upperSubtotal += card[category] ?? 0;
  let lowerSubtotal = 0;
  for (const category of LOWER_CATEGORIES) lowerSubtotal += card[category] ?? 0;
  const upperBonus = upperSubtotal >= UPPER_TARGET ? UPPER_BONUS : 0;
  return {
    ones: card.ones,
    twos: card.twos,
    threes: card.threes,
    fours: card.fours,
    fives: card.fives,
    sixes: card.sixes,
    three_kind: card.three_kind,
    four_kind: card.four_kind,
    full_house: card.full_house,
    small_straight: card.small_straight,
    large_straight: card.large_straight,
    yacht: card.yacht,
    chance: card.chance,
    upperSubtotal,
    upperBonus,
    total: upperSubtotal + upperBonus + lowerSubtotal,
  };
}

/**
 * 重掷未锁定的骰子，返回新的骰面与新的随机数游标。
 * 随机流是一条连续的种子化序列：先跳过已消耗的 draws 个随机数，再按骰子顺序抽，
 * 所以「同 seed + 同动作序列」必然得到同一串骰面（可回放）。
 */
export function rollUnheld(
  seed: number,
  draws: number,
  dice: readonly number[],
  held: readonly boolean[],
): { dice: number[]; draws: number } {
  const rand = mulberry32(seed);
  for (let i = 0; i < draws; i++) rand();
  const next = dice.slice();
  let used = draws;
  for (let index = 0; index < DICE_COUNT; index++) {
    if (held[index]) continue;
    next[index] = randInt(rand, 1, 6);
    used++;
  }
  return { dice: next, draws: used };
}

/** 终局：双方 13 格都填满。 */
export function isTerminalState(state: YachtState): boolean {
  return isCardFull(state.cards[0]) && isCardFull(state.cards[1]);
}

/** 结算摘要（result 与 end 事件共用）。 */
function summarize(state: YachtState): GameResultSummary {
  const c0 = summarizeCard(state.cards[0]);
  const c1 = summarizeCard(state.cards[1]);
  const winner: Seat | null = c0.total === c1.total ? null : c0.total > c1.total ? 0 : 1;
  const text =
    winner === null
      ? `平局！双方都是 ${c0.total} 分。`
      : `座位 ${winner} 获胜！${c0.total} : ${c1.total}。`;
  return { winner, scores: { 0: c0.total, 1: c1.total }, text };
}

/** 观测里的 previewScores：已记格恒为 null；未掷骰或不是你的回合时也全为 null。 */
function buildPreview(state: YachtState, seat: Seat): Record<Category, number | null> {
  const card = state.cards[seat];
  const previewable = !isTerminalState(state) && state.turn === seat && hasRolled(state);
  const out = {} as Record<Category, number | null>;
  for (const category of CATEGORIES) {
    out[category] =
      previewable && card[category] === null ? scoreCategory(state.dice, category) : null;
  }
  return out;
}

/** 全 null 的 previewScores：旁观者没有「自己的回合」，不该拿到任何记分建议。 */
function emptyPreview(): Record<Category, number | null> {
  const out = {} as Record<Category, number | null>;
  for (const category of CATEGORIES) out[category] = null;
  return out;
}

/** 纯文本局面：给不看图、只会读文本的 Agent 用。 */
export function buildYachtTextView(state: YachtState, seat: Seat | null): string {
  // 旁观时用中性称呼（座位 0 / 座位 1）：不写「你 / 对手」，也不给记分预览（那等于替人算牌）。
  const spectator = seat === null;
  const viewer = (seat ?? 0) as 0 | 1;
  const opponent = (1 - viewer) as 0 | 1;
  const ended = isTerminalState(state);
  const current = ended ? null : state.turn;
  const mine = summarizeCard(state.cards[viewer]);
  const theirs = summarizeCard(state.cards[opponent]);
  const filled = filledCount(state.cards[0]) + filledCount(state.cards[1]);
  const hand = Math.min(filled + 1, YACHT_ROUNDS_TOTAL);
  const lines: string[] = [];

  const turnNote = ended ? '对局结束' : spectator ? `轮到座位 ${current}` : current === seat ? '轮到你了' : `轮到座位 ${current}`;
  lines.push(
    `${spectator ? '旁观视图 · ' : ''}快艇骰子 · 第 ${hand}/${YACHT_ROUNDS_TOTAL} 手 · 剩 ${state.rollsLeft} 次掷骰 · ${turnNote}`,
  );

  if (hasRolled(state)) {
    const faces = state.dice.map((face, index) => (state.held[index] ? `[${face}*]` : `[${face}]`));
    lines.push(`骰子: ${faces.join(' ')}   （* = 已锁定）`);
  } else {
    lines.push(spectator ? '骰子: 还没掷骰' : '骰子: 还没掷骰（先执行 {"action":"roll"}）');
  }

  // 记分预览是「当前行动方」的私有辅助：旁观者拿到的 previewScores 全为 null，这里也不展示。
  if (seat !== null) {
    const preview = buildPreview(state, seat);
    const cell = (category: Category): string => {
      const label = CATEGORY_LABELS[category];
      if (state.cards[viewer][category] !== null) return `${label}=已记`;
      const value = preview[category];
      return `${label}=${value === null ? '—' : value}`;
    };
    lines.push('可记分（本回合预览）:');
    lines.push(`  上区: ${UPPER_CATEGORIES.map(cell).join(' ')}`);
    lines.push(`  下区: ${LOWER_CATEGORIES.map(cell).join(' ')}`);
  }

  const scoredList = (card: Card): string => {
    const parts = CATEGORIES.filter((category) => card[category] !== null).map(
      (category) => `${CATEGORY_LABELS[category]}=${card[category]}`,
    );
    return parts.length > 0 ? parts.join(' ') : '（还没有记分）';
  };
  lines.push(
    `${spectator ? '座位 0 ' : '你'}已记: ${scoredList(state.cards[viewer])}（上区小计 ${mine.upperSubtotal}/${UPPER_TARGET}，奖励 ${mine.upperBonus}）`,
  );
  lines.push(
    `${spectator ? '座位 1 ' : '对手'}已记: ${scoredList(state.cards[opponent])}（上区小计 ${theirs.upperSubtotal}/${UPPER_TARGET}，奖励 ${theirs.upperBonus}）`,
  );
  lines.push(
    spectator
      ? `总分: 座位 0 ${mine.total} · 座位 1 ${theirs.total}`
      : `总分: 你 ${mine.total} · 对手 ${theirs.total}`,
  );

  if (ended) {
    lines.push(`对局已结束：${summarize(state).text}`);
  } else if (spectator) {
    lines.push(`现在轮到座位 ${current} 掷骰记分，旁观视图不可行动。`);
  } else if (current !== seat) {
    lines.push(`现在轮到座位 ${current} 掷骰记分，等对方 score 后换你。legalActions 为空是正常的。`);
  } else if (state.phase === 'roll') {
    lines.push('可执行: {"action":"roll"}（掷 5 颗骰）。掷完才能锁定或记分。');
  } else if (state.phase === 'choice') {
    lines.push(
      `可执行: {"action":"roll"}（再掷未锁定的骰）/ {"action":"hold","indices":[i]}（切换第 i 颗的锁定）/ {"action":"score","category":"..."}（记分后换手）`,
    );
  } else {
    lines.push('掷骰次数已用完，只能记分: {"action":"score","category":"..."}（选了就换手）。');
  }
  return lines.join('\n');
}

export const yacht: GameSpec<YachtState, YachtObservation> = {
  meta: {
    id: 'yacht',
    name: '快艇骰子',
    tagline: '五颗骰子三次机会，凑牌型、比总分',
    seats: 2,
    rules: RULES,
    category: '骰子',
    tags: ['运气', '记分策略', '中局'],
    duration: '3–5 分钟',
    status: 'playable',
    accent: '#b4622f',
    resolution: 'turn',
  } satisfies GameMeta,

  setup(seed: number): YachtState {
    return {
      seed,
      draws: 0,
      dice: Array<number>(DICE_COUNT).fill(0),
      held: Array<boolean>(DICE_COUNT).fill(false),
      rollsLeft: MAX_ROLLS,
      phase: 'roll',
      turn: 0,
      cards: { 0: emptyCard(), 1: emptyCard() },
      history: [],
    };
  },

  legalActions(state: YachtState, seat: Seat): Action[] {
    if (isTerminalState(state)) return []; // 终局后不再有可行动作
    if (state.turn !== seat) return []; // 轮流制契约：不是自己的回合就没有合法动作
    const out: Action[] = [];
    if (state.phase !== 'must_score' && state.rollsLeft > 0) out.push({ action: 'roll' });
    if (state.phase === 'choice') {
      // 锁定是切换语义：枚举 5 个单颗切换 + 「空数组 = 全部解锁」。
      // 服务端按 legalActions 做「模式匹配」校验，多下标的 hold 提交会对不上模式，
      // 所以对外契约是「一次只切一颗」；引擎本身也接受多下标（测试/直连用）。
      for (let index = 0; index < DICE_COUNT; index++) {
        out.push({ action: 'hold', indices: [index] });
      }
      out.push({ action: 'hold', indices: [] });
    }
    if (state.phase !== 'roll') {
      // 必须先掷过骰才能记分；已用过的栏目不再枚举
      for (const category of CATEGORIES) {
        if (state.cards[seat][category] === null) out.push({ action: 'score', category });
      }
    }
    return out;
  },

  step(state: YachtState, actions: Record<Seat, Action>) {
    if (isTerminalState(state)) throw new Error('yacht.step：对局已结束，不能再行动');
    const seat = state.turn;
    const action = actions[seat];
    if (!action) throw new Error('yacht.step：缺少当前行动方的动作');
    const kind = action.action;
    if (kind === 'roll') return doRoll(state, seat);
    if (kind === 'hold') return doHold(state, seat, action);
    if (kind === 'score') return doScore(state, seat, action);
    throw new Error(`yacht.step：动作类型必须是 roll / hold / score，收到 ${String(kind)}`);
  },

  isTerminal(state: YachtState): boolean {
    return isTerminalState(state);
  },

  result(state: YachtState): GameResultSummary {
    return summarize(state);
  },

  currentSeat(state: YachtState): Seat | null {
    // 终局没有「当前行动方」，避免服务端/前端以为还能掷骰
    return isTerminalState(state) ? null : state.turn;
  },

  observe(state: YachtState, seat: Seat | null): YachtObservation {
    const ended = isTerminalState(state);
    const current = ended ? null : state.turn;
    const filled = filledCount(state.cards[0]) + filledCount(state.cards[1]);
    const summary = summarize(state);
    const card0 = summarizeCard(state.cards[0]);
    const card1 = summarizeCard(state.cards[1]);
    return {
      gameId: 'yacht',
      seat,
      // 一手 = 一次 score；双方各 13 手，共 26 手
      round: Math.min(filled + 1, YACHT_ROUNDS_TOTAL),
      roundsTotal: YACHT_ROUNDS_TOTAL,
      scores: { ...summary.scores },
      // 旁观者不能行动：legalActions 恒为空。
      legalActions: seat !== null && !ended ? yacht.legalActions(state, seat) : [],
      textView: buildYachtTextView(state, seat),
      status: ended ? 'ended' : 'playing',
      currentSeat: current,
      isYourTurn: seat !== null && current !== null && current === seat,
      dice: [...state.dice],
      held: [...state.held],
      rollsLeft: state.rollsLeft,
      phase: state.phase,
      scorecards: { 0: card0, 1: card1 },
      // previewScores 是「当前行动方的记分建议」：旁观者一律 null，免得替人算牌。
      previewScores: seat === null ? emptyPreview() : buildPreview(state, seat),
      upperTarget: UPPER_TARGET,
      upperBonusValue: UPPER_BONUS,
      history: state.history.map((record) => ({ ...record, dice: [...record.dice] })),
    };
  },
};

/** 掷骰：只重掷未锁定的骰子，rollsLeft 递减，0 次时 phase 必须变成 must_score。 */
function doRoll(state: YachtState, seat: Seat): { state: YachtState; events: GameEvent[] } {
  if (state.phase === 'must_score' || state.rollsLeft <= 0) {
    throw new Error('yacht.step：3 次掷骰已用完，只能记分（phase = must_score）');
  }
  const rolled = rollUnheld(state.seed, state.draws, state.dice, state.held);
  const rollsLeft = state.rollsLeft - 1;
  const phase: Phase = rollsLeft === 0 ? 'must_score' : 'choice';
  const next: YachtState = {
    ...state,
    dice: rolled.dice,
    draws: rolled.draws,
    rollsLeft,
    phase,
  };
  const events: GameEvent[] = [
    { type: 'roll', seat, dice: [...rolled.dice], held: [...state.held], rollsLeft },
  ];
  return { state: next, events };
}

/** 锁定：切换 indices 里每颗骰子的锁定状态（仅在掷过骰、且还有掷骰次数时允许）。 */
function doHold(
  state: YachtState,
  seat: Seat,
  action: Action,
): { state: YachtState; events: GameEvent[] } {
  if (state.phase === 'roll') {
    throw new Error('yacht.step：还没掷骰，不能锁定（先执行 {"action":"roll"}）');
  }
  if (state.phase === 'must_score') {
    throw new Error('yacht.step：3 次掷骰已用完，只能记分，不能再锁定');
  }
  const raw = action.indices;
  if (!Array.isArray(raw)) {
    throw new Error('yacht.step：hold 需要 indices 数组，例如 {"action":"hold","indices":[0]}');
  }
  // 空数组 = 全部解锁（一次动作清空锁定状态）
  if (raw.length === 0) {
    const cleared = Array<boolean>(DICE_COUNT).fill(false);
    const next: YachtState = { ...state, held: cleared };
    return { state: next, events: [{ type: 'hold', seat, held: [...cleared] }] };
  }
  const held = [...state.held];
  for (const item of raw) {
    const index = Number(item);
    if (!Number.isInteger(index) || index < 0 || index >= DICE_COUNT) {
      throw new Error(`yacht.step：indices 必须是 0-${DICE_COUNT - 1} 的整数，收到 ${String(item)}`);
    }
    held[index] = !held[index];
  }
  const next: YachtState = { ...state, held };
  const events: GameEvent[] = [{ type: 'hold', seat, held: [...held] }];
  return { state: next, events };
}

/** 记分：该格未用过 → 记分、换手、重置 dice/held/rollsLeft；双方填满即终局。 */
function doScore(
  state: YachtState,
  seat: Seat,
  action: Action,
): { state: YachtState; events: GameEvent[] } {
  if (state.phase === 'roll') {
    throw new Error('yacht.step：还没掷骰，不能记分（必须先掷至少 1 次）');
  }
  const category = action.category;
  if (!isCategory(category)) {
    throw new Error(`yacht.step：category 必须是 13 个栏目之一，收到 ${String(category)}`);
  }
  const card = state.cards[seat];
  if (card[category] !== null) {
    throw new Error(
      `yacht.step：栏目 ${CATEGORY_LABELS[category]}（${category}）本局已经记过分，请换一格`,
    );
  }
  const gained = scoreCategory(state.dice, category);
  const nextCard: Card = { ...card };
  nextCard[category] = gained;
  const cards: Cards = { 0: state.cards[0], 1: state.cards[1] };
  cards[seat] = nextCard;
  const nextSeat: Seat = seat === 0 ? 1 : 0;
  const next: YachtState = {
    ...state,
    dice: Array<number>(DICE_COUNT).fill(0),
    held: Array<boolean>(DICE_COUNT).fill(false),
    rollsLeft: MAX_ROLLS,
    phase: 'roll',
    turn: nextSeat,
    cards,
    history: [...state.history, { seat, category, gained, dice: [...state.dice] }],
  };
  const ended = isTerminalState(next);
  const events: GameEvent[] = [
    {
      type: 'score',
      seat,
      category,
      gained,
      scorecard: summarizeCard(nextCard),
      nextSeat: ended ? null : nextSeat,
    },
  ];
  if (ended) events.push({ type: 'end', result: summarize(next) });
  return { state: next, events };
}

export default yacht;

