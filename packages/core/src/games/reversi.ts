import type {
  Action,
  BaseObservation,
  GameEvent,
  GameMeta,
  GameResultSummary,
  GameSpec,
  Seat,
} from '../types.ts';

type Coord = [number, number];
export type Disc = 0 | 1 | null;

export const BOARD_SIZE = 8;
/** 8×8 去掉开局 4 子，最多 60 手。 */
export const REVERSI_MAX_MOVES = 60;

/** 八个方向：左右上下 + 四条斜线。 */
const DIRECTIONS: ReadonlyArray<Coord> = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export interface MoveRecord {
  /** 第几手（1-based，只算真正落子）。 */
  move: number;
  seat: Seat;
  cell: Coord;
  flips: Coord[];
}

export interface ReversiState {
  board: Disc[][];
  turn: Seat;
  /** 连续「跳过」次数；用于判定终局。 */
  passes: number;
  /** 最近一次被跳过的座位（没有跳过为 null）。 */
  lastPassSeat: Seat | null;
  history: MoveRecord[];
}

export interface ReversiObservation extends BaseObservation {
  board: Disc[][];
  yourDiscs: number;
  opponentDiscs: number;
  lastMove: MoveRecord | null;
  /** 上一步之后对手是否被跳过（无子可下）。 */
  lastPassSeat: Seat | null;
}

const RULES = `黑白棋（Reversi / Othello）
一句话规则：8×8 棋盘，落子后把被夹住的对手棋子全部翻成自己的；双方都无子可下或棋盘下满时，子多者胜。

细节：
- 开局中央摆 4 子：**D5/E4 是座位 0 的子、D4/E5 是座位 1 的子**（D4=第 3 行第 3 列，坐标 [3,3]）；**座位 0 先手**。
- 落子必须能夹住（沿横/竖/斜八个方向，至少翻到一枚对手棋子），否则这步不合法。
- 落子后，所有被夹住的对手棋子翻面成你的颜色。
- 轮到的一方若无合法落点，**自动跳过**（不消耗手数，机器会广播 pass 事件）；双方都无合法落点即终局。
- 终局数子：棋子多者胜，数量相同算平局。
- 完全是公开信息：棋盘对双方透明，观测里的 board 每一位都是真实值。

动作：{"action":"place","cell":[row,col]}，row/col 取值 0-7（左上角 0,0）。
可用动作见 legalActions，形如 [{"action":"place","cell":[2,3]}, ...]。`;

function opponentOf(seat: Seat): Seat {
  return 1 - seat;
}

function inBoard(r: number, c: number): boolean {
  return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;
}

/** 在 (r,c) 落 seat 的子会翻掉哪些棋子（空数组 = 不合法落点）。 */
export function flipsAt(board: readonly Disc[][], r: number, c: number, seat: Seat): Coord[] {
  if (!inBoard(r, c) || board[r][c] !== null) return [];
  const enemy = opponentOf(seat);
  const all: Coord[] = [];
  for (const [dr, dc] of DIRECTIONS) {
    const line: Coord[] = [];
    let rr = r + dr;
    let cc = c + dc;
    while (inBoard(rr, cc) && board[rr][cc] === enemy) {
      line.push([rr, cc]);
      rr += dr;
      cc += dc;
    }
    if (line.length > 0 && inBoard(rr, cc) && board[rr][cc] === seat) {
      all.push(...line);
    }
  }
  return all;
}

/** 某座位当前所有合法落点。 */
export function legalMovesFor(board: readonly Disc[][], seat: Seat): Action[] {
  const out: Action[] = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] !== null) continue;
      if (flipsAt(board, r, c, seat).length === 0) continue;
      out.push({ action: 'place', cell: [r, c] });
    }
  }
  return out;
}

export function countDiscs(board: readonly Disc[][]): { 0: number; 1: number } {
  let a = 0;
  let b = 0;
  for (const row of board) {
    for (const cell of row) {
      if (cell === 0) a++;
      else if (cell === 1) b++;
    }
  }
  return { 0: a, 1: b };
}

function cloneBoard(board: readonly Disc[][]): Disc[][] {
  return board.map((row) => row.slice());
}

export const reversi: GameSpec<ReversiState, ReversiObservation> = {
  meta: {
    id: 'reversi',
    name: '黑白棋',
    tagline: '夹住就翻面，一盘翻盘不断',
    seats: 2,
    rules: RULES,
    category: '棋类',
    tags: ['完全信息', '回合制', '中局'],
    duration: '4–8 分钟',
    status: 'playable',
    accent: '#4a5a6a',
    resolution: 'turn',
  } satisfies GameMeta,

  setup(_seed: number): ReversiState {
    // 黑白棋没有随机性：开局固定四子，seed 只是内核通用签名。
    const board: Disc[][] = Array.from({ length: BOARD_SIZE }, () =>
      Array.from({ length: BOARD_SIZE }, () => null as Disc),
    );
    board[3][3] = 1;
    board[3][4] = 0;
    board[4][3] = 0;
    board[4][4] = 1;
    return { board, turn: 0, passes: 0, lastPassSeat: null, history: [] };
  },

  legalActions(state: ReversiState, seat: Seat): Action[] {
    if (reversi.isTerminal(state)) return [];
    if (state.turn !== seat) return [];
    return legalMovesFor(state.board, seat);
  },

  step(state: ReversiState, actions: Record<Seat, Action>) {
    const mover = state.turn;
    const raw = actions[mover]?.cell;
    const cell = Array.isArray(raw) ? ([Number(raw[0]), Number(raw[1])] as Coord) : null;
    if (!cell || !inBoard(cell[0], cell[1])) {
      throw new Error(`非法落子: ${JSON.stringify(actions[mover])}`);
    }
    const flips = flipsAt(state.board, cell[0], cell[1], mover);
    if (flips.length === 0) {
      throw new Error(`不合法落点（翻不到子）: ${JSON.stringify(actions[mover])}`);
    }

    const board = cloneBoard(state.board);
    board[cell[0]][cell[1]] = mover as 0 | 1;
    for (const [r, c] of flips) board[r][c] = mover as 0 | 1;

    const record: MoveRecord = { move: state.history.length + 1, seat: mover, cell, flips };
    const history = [...state.history, record];
    const enemy = opponentOf(mover);

    const counts = countDiscs(board);
    const events: GameEvent[] = [
      {
        type: 'place',
        seat: mover,
        cell,
        flips,
        counts,
        board: board.map((row) => row.slice()),
      },
    ];

    let turn: Seat = mover;
    let passes = 0;
    let lastPassSeat: Seat | null = null;

    if (legalMovesFor(board, enemy).length > 0) {
      turn = enemy;
    } else if (legalMovesFor(board, mover).length > 0) {
      // 对手无子可下 → 跳过，还是你走
      turn = mover;
      passes = state.passes + 1;
      lastPassSeat = enemy;
      events.push({ type: 'pass', seat: enemy, nextSeat: mover });
    }

    const next: ReversiState = { board, turn, passes, lastPassSeat, history };
    if (reversi.isTerminal(next)) {
      // 终局时把轮次归零，避免出现「谁都不该走但标了 turn」
      events.push({ type: 'end', result: reversi.result(next) });
    }

    return { state: next, events };
  },

  isTerminal(state: ReversiState): boolean {
    return (
      legalMovesFor(state.board, 0).length === 0 && legalMovesFor(state.board, 1).length === 0
    );
  },

  result(state: ReversiState): GameResultSummary {
    const counts = countDiscs(state.board);
    const winner: Seat | null = counts[0] === counts[1] ? null : counts[0] > counts[1] ? 0 : 1;
    const text =
      winner === null
        ? `平局！双方都是 ${counts[0]} 子。`
        : `座位 ${winner} 获胜！${counts[0]} : ${counts[1]}。`;
    return { winner, scores: { 0: counts[0], 1: counts[1] }, text };
  },

  currentSeat(state: ReversiState): Seat | null {
    return reversi.isTerminal(state) ? null : state.turn;
  },

  observe(state: ReversiState, seat: Seat | null): ReversiObservation {
    // 旁观者没有座位：座位相对字段按「座位 0 视角」呈现，前端用 spectator 标记把标签改成「座位 0 / 座位 1」。
    const viewer = (seat ?? 0) as 0 | 1;
    const opponent = opponentOf(viewer) as 0 | 1;
    const ended = reversi.isTerminal(state);
    const counts = countDiscs(state.board);
    const moves = state.history.length;
    const lastMove = moves > 0 ? state.history[moves - 1] : null;

    return {
      gameId: reversi.meta.id,
      seat,
      round: ended ? moves : Math.min(moves + 1, REVERSI_MAX_MOVES),
      roundsTotal: REVERSI_MAX_MOVES,
      scores: { 0: counts[0], 1: counts[1] },
      // 旁观者不能行动：legalActions 恒为空（棋盘本身完全公开）。
      legalActions: seat !== null && !ended ? reversi.legalActions(state, seat) : [],
      textView: buildReversiTextView(state, seat),
      status: ended ? 'ended' : 'playing',
      currentSeat: ended ? null : state.turn,
      isYourTurn: seat !== null && !ended && state.turn === seat,
      board: state.board.map((row) => row.slice()),
      yourDiscs: counts[viewer],
      opponentDiscs: counts[opponent],
      lastMove,
      lastPassSeat: state.lastPassSeat,
    };
  },
};

export function buildReversiTextView(state: ReversiState, seat: Seat | null): string {
  // 旁观时用中性称呼（座位 0 / 座位 1）：不写「你 / 对手」，也不给自己标合法落点（旁观不能落子）。
  const spectator = seat === null;
  const viewer = (seat ?? 0) as 0 | 1;
  const opponent = opponentOf(viewer) as 0 | 1;
  const ended = reversi.isTerminal(state);
  const lines: string[] = [];
  const counts = countDiscs(state.board);
  const mine = counts[viewer];
  const theirs = counts[opponent];

  if (spectator) {
    lines.push(
      ended
        ? `🏁 旁观视图 · 对局结束 · 座位 0 ${mine} 子 : ${theirs} 子 座位 1`
        : `旁观视图 · 第 ${state.history.length + 1} 手 · 座位 0 ${mine} 子 : ${theirs} 子 座位 1`,
    );
  } else {
    lines.push(
      ended
        ? `🏁 对局结束 · 你 ${mine} 子 : ${theirs} 子 对手`
        : `第 ${state.history.length + 1} 手 · 你 ${mine} 子 : ${theirs} 子 对手`,
    );
  }

  lines.push('    ' + 'ABCDEFGH'.split('').join(' '));
  for (let r = 0; r < BOARD_SIZE; r++) {
    const row: string[] = [];
    for (let c = 0; c < BOARD_SIZE; c++) {
      const disc = state.board[r][c];
      if (disc === null) {
        // 合法落点标记只给有座位的当前行动方：旁观视图的棋盘是只读的。
        const legal =
          !spectator && !ended && state.turn === viewer && flipsAt(state.board, r, c, viewer).length > 0;
        row.push(legal ? '·' : ' ');
      } else if (spectator) {
        // 旁观用绝对符号：● = 座位 0，○ = 座位 1
        row.push(disc === 0 ? '●' : '○');
      } else {
        // 座位相对：● = 你，○ = 对手
        row.push(disc === viewer ? '●' : '○');
      }
    }
    lines.push(` ${r + 1}  ` + row.join(' '));
  }
  if (spectator) lines.push('图例：● = 座位 0，○ = 座位 1；旁观视图不展示可落点。');
  else if (!ended) lines.push(`图例：● = 你（座位 ${seat}），○ = 对手，· = 你现在能落子；列 A–H、行 1–8。`);

  if (ended) {
    const result = reversi.result(state);
    // 这句话是给人看的，别塞 Agent 才有的工具名（人类在浏览器里没有 get_result 按钮）。
    lines.push(`对局已结束：${result.text}（Agent 可用 get_result / export_log 复盘）`);
  } else if (spectator) {
    lines.push(`现在轮到座位 ${state.turn} 落子，旁观视图不可行动。`);
  } else if (state.turn === seat) {
    const legal = legalMovesFor(state.board, viewer)
      .map((a) => {
        const [r, c] = a.cell as Coord;
        return `${'ABCDEFGH'[c]}${r + 1}`;
      })
      .join(' ');
    lines.push(`轮到你落子，合法落点：${legal}`);
    lines.push('动作：{"action":"place","cell":[row,col]}，row/col 取 0-7。');
  } else {
    lines.push('轮到对手落子。对手若无子可下会自动跳过。');
  }
  return lines.join('\n');
}

export default reversi;
