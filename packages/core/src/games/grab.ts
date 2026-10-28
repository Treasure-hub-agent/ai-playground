import { mulberry32, shuffle } from '../rng.ts';
import type {
  Action,
  BaseObservation,
  GameEvent,
  GameMeta,
  GameResultSummary,
  GameSpec,
  Seat,
} from '../types.ts';

export type Coord = [number, number];

export type Cell =
  | null // 已被抢走
  | { k: 'coin'; v: number }
  | { k: 'bomb' }
  | { k: 'empty' };

export interface RoundRecord {
  round: number;
  picks: Record<number, Coord>;
  delta: Record<number, number>;
  collision: boolean;
}

export interface GrabState {
  grid: Cell[][];
  scores: Record<number, number>;
  round: number;
  history: RoundRecord[];
}

export const SIZE = 3;
export const ROUNDS_TOTAL = 9;
const COIN_VALUES = [1, 1, 2, 2, 3, 3];
const BOMB_PENALTY = 2;

const RULES = `抢宝大作战（Grab & Grab）
一句话规则：每回合你和对手同时抢一格；金币归你，炸弹扣你，抢同一格谁都拿不到。

细节：
- 棋盘 3x3 九宫格，开局随机摆放 6 枚金币（面值 1/2/3）、1 枚炸弹、2 个空格。
- 每回合双方同时暗选一格（看不到对方选哪）。
- 双方选不同格：各自生效（金币加分、炸弹扣 2 分、空格无事）。
- 双方选同一格：撞车，该格宝物撞飞，双方都拿不到（炸弹不扣分）。
- 已抢的格子消失。**场上金币被抢完即结束**（剩下的空格/炸弹不再进行，避免无意义的残局）。
- 结束时总分高者获胜；同分算平局。

动作：{"action":"grab","cell":[row,col]}，row/col 取值 0-2。
可用动作见 legalActions，形如 [{"action":"grab","cell":[0,0]}, {"action":"grab","cell":[0,2]}, ...]。`;

function sameCoord(a: Coord, b: Coord): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export function cellToJson(c: Cell): unknown {
  if (c === null) return 'taken';
  if (c.k === 'coin') return c.v;
  if (c.k === 'bomb') return 'bomb';
  return 'empty';
}

function cellToText(c: Cell): string {
  if (c === null) return ' ✖ ';
  if (c.k === 'coin') return ` 💰${c.v}`;
  if (c.k === 'bomb') return ' 💣 ';
  return ' 空 ';
}

function allCoords(): Coord[] {
  const out: Coord[] = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) out.push([r, c]);
  return out;
}

export const grab: GameSpec<GrabState, Record<string, unknown>> = {
  meta: {
    id: 'grab',
    name: '抢宝大作战',
    tagline: '同时暗选抢金币，撞车谁都拿不到',
    seats: 2,
    rules: RULES,
    category: '派对',
    tags: ['同时暗选', '短局', '心理战'],
    duration: '60–90 秒',
    status: 'playable',
    accent: '#d99b2b',
    resolution: 'simultaneous',
  } satisfies GameMeta,

  setup(seed: number): GrabState {
    const rand = mulberry32(seed);
    const bag: Cell[] = [
      ...COIN_VALUES.map((v) => ({ k: 'coin', v }) as Cell),
      { k: 'bomb' } as Cell,
      { k: 'empty' } as Cell,
      { k: 'empty' } as Cell,
    ];
    const shuffled = shuffle(bag, rand);
    const grid: Cell[][] = [];
    for (let r = 0; r < SIZE; r++) {
      grid.push(shuffled.slice(r * SIZE, (r + 1) * SIZE));
    }
    return { grid, scores: { 0: 0, 1: 0 }, round: 1, history: [] };
  },

  legalActions(state: GrabState, _seat: Seat): Action[] {
    if (grab.isTerminal(state)) return []; // 对局结束后不再有可行动作
    const out: Action[] = [];
    for (const [r, c] of allCoords()) {
      if (state.grid[r][c] !== null) out.push({ action: 'grab', cell: [r, c] });
    }
    return out;
  },

  step(state: GrabState, actions: Record<Seat, Action>) {
    const picks: Record<number, Coord> = {
      0: actions[0].cell as Coord,
      1: actions[1].cell as Coord,
    };
    const collision = sameCoord(picks[0], picks[1]);
    const grid = state.grid.map((row) => row.slice() as Cell[]);
    const delta: Record<number, number> = { 0: 0, 1: 0 };
    const applied: Record<number, string> = {};

    if (collision) {
      // 撞车：宝物被撞飞，双方都拿不到（炸弹也不扣分）
      grid[picks[0][0]][picks[0][1]] = null;
      applied[0] = 'collision';
      applied[1] = 'collision';
    } else {
      for (const seat of [0, 1] as const) {
        const [r, c] = picks[seat];
        const cell = grid[r][c];
        if (cell === null) {
          applied[seat] = 'taken';
          continue;
        }
        if (cell.k === 'coin') {
          delta[seat] = cell.v;
          applied[seat] = 'coin';
        } else if (cell.k === 'bomb') {
          delta[seat] = -BOMB_PENALTY;
          applied[seat] = 'bomb';
        } else {
          applied[seat] = 'empty';
        }
        grid[r][c] = null;
      }
    }

    const scores: Record<number, number> = {
      0: state.scores[0] + delta[0],
      1: state.scores[1] + delta[1],
    };
    const record: RoundRecord = { round: state.round, picks, delta, collision };
    const next: GrabState = {
      grid,
      scores,
      round: state.round + 1,
      history: [...state.history, record],
    };

    const events: GameEvent[] = [
      {
        type: 'reveal',
        round: state.round,
        picks,
        delta,
        applied,
        collision,
        scores,
        grid: grid.map((row) => row.map(cellToJson)),
      },
    ];
    if (grab.isTerminal(next)) {
      events.push({ type: 'end', result: grab.result(next) });
    }
    return { state: next, events };
  },

  isTerminal(state: GrabState): boolean {
    // 场上金币被抢完即结束：剩下的空格/炸弹不再进行，避免无意义的残局。
    return !state.grid.some((row) => row.some((cell) => cell !== null && cell.k === 'coin'));
  },

  result(state: GrabState): GameResultSummary {
    const s0 = state.scores[0];
    const s1 = state.scores[1];
    const winner = s0 === s1 ? null : s0 > s1 ? 0 : 1;
    const text =
      winner === null
        ? `平局！双方都是 ${s0} 分。`
        : `座位 ${winner} 获胜！比分 ${s0} : ${s1}。`;
    return { winner, scores: { ...state.scores }, text };
  },

  observe(state: GrabState, seat: Seat | null): Record<string, unknown> & BaseObservation {
    // 旁观者没有座位：座位相对字段按「座位 0 视角」呈现，前端用 spectator 标记把标签改成「座位 0 / 座位 1」。
    const viewer = seat ?? 0;
    const opponent = 1 - viewer;
    const ended = grab.isTerminal(state);
    const played = state.history.length;
    return {
      gameId: grab.meta.id,
      seat,
      // 结束时显示「已进行的回合数」，避免出现「第 7/9 回合但已结束」的错位
      round: ended ? played : Math.min(played + 1, ROUNDS_TOTAL),
      roundsTotal: ROUNDS_TOTAL,
      scores: { ...state.scores },
      // 旁观者不能行动：即便棋盘上还有空位，legalActions 也必须是空数组。
      legalActions: seat !== null && !ended ? grab.legalActions(state, seat) : [],
      textView: buildTextView(state, seat),
      status: ended ? 'ended' : 'playing',
      grid: state.grid.map((row) => row.map(cellToJson)),
      // 落点只在结算（reveal）之后才进 history；本回合的暗选根本不在 state 里，
      // 所以旁观视图拿不到「对手这一回合选了哪格」这类未揭示信息。
      history: state.history,
      yourScore: state.scores[viewer],
      opponentScore: state.scores[opponent],
    };
  },
};

export function buildTextView(state: GrabState, seat: Seat | null): string {
  // 旁观时用中性称呼（座位 0 / 座位 1）：没有「你」，否则纯文本 Agent 会误以为自己有座位。
  const spectator = seat === null;
  const viewer = seat ?? 0;
  const opponent = 1 - viewer;
  const ended = !state.grid.some((row) => row.some((cell) => cell !== null && cell.k === 'coin'));
  const played = state.history.length;
  const lines: string[] = [];
  const roundNo = ended ? Math.min(played, ROUNDS_TOTAL) : Math.min(played + 1, ROUNDS_TOTAL);
  const scoreLine = spectator
    ? `座位 0 ${state.scores[0]} 分 · 座位 1 ${state.scores[1]} 分`
    : `你 ${state.scores[viewer]} 分 · 对手 ${state.scores[opponent]} 分`;
  lines.push(`${spectator ? '旁观视图 · ' : ''}第 ${roundNo}/${ROUNDS_TOTAL} 回合 · ${scoreLine}`);
  state.grid.forEach((row, r) => {
    lines.push(`第 ${r} 行: ` + row.map(cellToText).join('|'));
  });
  lines.push('坐标格式 [行,列]，例如 [0,2] 表示第 0 行第 2 列。');
  if (ended) {
    const s0 = state.scores[0];
    const s1 = state.scores[1];
    const verdict = s0 === s1 ? `平局（${s0} : ${s1}）` : `${s0 > s1 ? '座位 0' : '座位 1'} 获胜（${s0} : ${s1}）`;
    lines.push(`🏁 对局已结束：${verdict}。可调用 get_result / export_log 查看结算与复盘。`);
  } else if (spectator) {
    lines.push('对局进行中：双方本回合正在同时暗选，旁观视图看不到未结算的落点。');
  } else {
    lines.push('还没结束：继续选择一个合法格子。');
  }
  return lines.join('\n');
}

export default grab;
