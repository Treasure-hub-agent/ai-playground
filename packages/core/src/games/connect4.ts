import type {
  Action,
  BaseObservation,
  GameEvent,
  GameMeta,
  GameResultSummary,
  GameSpec,
  Seat,
} from '../types.ts';

/** 棋盘行数（row 0 在最上，row ROWS-1 在最下）。 */
export const ROWS = 6;
/** 棋盘列数（column 0-6，文本棋盘用 A-G 标注）。 */
export const COLS = 7;
/** 文本棋盘的列标：A=0、B=1 …… G=6。 */
export const COLUMN_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
/** 总格数：一局最多 42 手，填满仍无人连成四子即平局。 */
export const CELLS_TOTAL = ROWS * COLS;

/** 格子内容：0 = 空，1 = 座位 0 的棋子，2 = 座位 1 的棋子。 */
export type Stone = 0 | 1 | 2;

/** 一手落子记录（也是 drop 事件里的 lastMove）。 */
export interface Move {
  seat: Seat;
  column: number;
  row: number;
}

export interface Connect4State {
  board: Stone[][];
  /** 当前该谁落子；终局后语义失效，读「当前行动方」请用 currentSeat。 */
  turn: Seat;
  history: Move[];
}

export interface Connect4Observation extends BaseObservation {
  board: Stone[][];
  history: Move[];
}

/** 四连的四个方向：横、竖、斜 ↘、斜 ↙（每条线只从起点扫一次，不会重复计数）。 */
const DIRECTIONS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
] as const;

const RULES = `四子棋（Connect Four）
一句话规则：轮流往 7 列里丢棋子，横、竖、斜任意方向先连成 4 个同色棋子者胜；42 格填满仍无人连成四子则平局。

细节：
- 棋盘 6 行 × 7 列：行号 0 在最上、5 在最下；列号 0-6（文本棋盘用 A-G 标注，A=0 … G=6）。
- 座位 0 先手，之后双方轮流落子，一方落子后立刻换手（resolution = turn）。
- 落子有重力：只能选一个未满的列，棋子落到该列最下面的空位；同一列还能继续加高，直到 6 格填满。
- 横、竖、两条斜线，任意方向连续 4 个同色棋子即获胜（连续 5 个及以上当然也算）。
- 对局结束（有人连成四子，或棋盘填满无人四连）后，legalActions 为空，不再接受落子。
- 没有隐藏信息：双方看到的棋盘完全一致。

动作：{"action":"drop","column":n}，n 是 0-6 的整数。
可用动作见 legalActions，形如 [{"action":"drop","column":0}, ...]；**只有轮到你时 legalActions 才非空**，不是你的回合请等待。
坐标格式 [row,column]，例如 [5,3] 表示最底行第 3 列（column 3 = D 列）。`;

/** 空棋盘（每次返回新数组，避免共享引用）。 */
export function emptyBoard(): Stone[][] {
  return Array.from({ length: ROWS }, () => Array<Stone>(COLS).fill(0));
}

/** 座位号 → 棋子颜色。 */
export function stoneFor(seat: Seat): Stone {
  return seat === 0 ? 1 : 2;
}

/** 棋子颜色 → 座位号；空格返回 null。 */
export function seatFor(stone: Stone): Seat | null {
  if (stone === 1) return 0;
  if (stone === 2) return 1;
  return null;
}

/** 该列是否已满（顶格有棋子就是满）。 */
export function isColumnFull(board: Stone[][], column: number): boolean {
  return board[0][column] !== 0;
}

/** 该列当前是否还能落子。 */
export function isColumnPlayable(board: Stone[][], column: number): boolean {
  return Number.isInteger(column) && column >= 0 && column < COLS && !isColumnFull(board, column);
}

/** 某列落子的行号（重力：该列最下面的空位）；满列返回 -1。 */
export function landingRow(board: Stone[][], column: number): number {
  for (let row = ROWS - 1; row >= 0; row--) {
    if (board[row][column] === 0) return row;
  }
  return -1;
}

/** 棋盘是否已满（只看顶行即可）。 */
export function isBoardFull(board: Stone[][]): boolean {
  return board[0].every((stone) => stone !== 0);
}

/**
 * 全盘扫描四连：返回连成四子的座位（0/1），没有则 null。
 * 每条线只从自己的起点往一个方向扫，所以横/竖/两条斜都不会漏、也不会重复。
 */
export function findWinningSeat(board: Stone[][]): Seat | null {
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < COLS; column++) {
      const stone = board[row][column];
      if (stone === 0) continue;
      for (const [dr, dc] of DIRECTIONS) {
        const endRow = row + dr * 3;
        const endColumn = column + dc * 3;
        if (endRow < 0 || endRow >= ROWS || endColumn < 0 || endColumn >= COLS) continue;
        if (
          board[row + dr][column + dc] === stone &&
          board[row + dr * 2][column + dc * 2] === stone &&
          board[endRow][endColumn] === stone
        ) {
          return seatFor(stone);
        }
      }
    }
  }
  return null;
}

/** 终局判定：有人四连，或棋盘已满。 */
export function isTerminalBoard(board: Stone[][]): boolean {
  return findWinningSeat(board) !== null || isBoardFull(board);
}

/** 结算摘要（result 与 observe 共用）。 */
function summarize(state: Connect4State): GameResultSummary {
  const winner = findWinningSeat(state.board);
  if (winner === null) {
    if (isBoardFull(state.board)) {
      return { winner: null, scores: { 0: 0, 1: 0 }, text: '平局！棋盘已满，双方都没能连成四子。' };
    }
    // 防御性分支：正常流程只会在终局调用 result
    return { winner: null, scores: { 0: 0, 1: 0 }, text: '对局还在进行，暂无胜负。' };
  }
  const scores: Record<string, number> = { 0: winner === 0 ? 1 : 0, 1: winner === 1 ? 1 : 0 };
  const suffix = state.history.length > 0 ? `（共 ${state.history.length} 手）` : '';
  return { winner, scores, text: `座位 ${winner} 获胜！率先连成四子${suffix}。` };
}

export const connect4: GameSpec<Connect4State, Connect4Observation> = {
  meta: {
    id: 'connect4',
    name: '四子棋',
    tagline: '横竖斜先连成四子',
    seats: 2,
    rules: RULES,
    category: '棋类',
    tags: ['完全信息', '经典', '快局'],
    duration: '2–4 分钟',
    status: 'playable',
    accent: '#3f7fd6',
    resolution: 'turn',
  } satisfies GameMeta,

  setup(_seed: number): Connect4State {
    // 四子棋没有任何随机信息：局面与 seed 无关，天然满足「同 seed 同局面」。
    return { board: emptyBoard(), turn: 0, history: [] };
  },

  legalActions(state: Connect4State, seat: Seat): Action[] {
    if (isTerminalBoard(state.board)) return []; // 对局结束后不再有可行动作
    if (seat !== state.turn) return []; // 轮流制关键契约：不是自己的回合就没有合法动作
    const out: Action[] = [];
    for (let column = 0; column < COLS; column++) {
      if (!isColumnFull(state.board, column)) out.push({ action: 'drop', column });
    }
    return out;
  },

  step(state: Connect4State, actions: Record<Seat, Action>) {
    // 轮流制：只认当前行动方的动作，另一个座位的键即使传了也要忽略。
    const seat = state.turn;
    const action = actions[seat];
    if (!action) throw new Error('connect4.step：缺少当前行动方的动作');
    if (action.action !== 'drop') {
      throw new Error(`connect4.step：动作类型必须是 drop，收到 ${String(action.action)}`);
    }
    const column = Number(action.column);
    if (!Number.isInteger(column) || column < 0 || column >= COLS) {
      throw new Error(`connect4.step：列号必须是 0-${COLS - 1} 的整数，收到 ${String(action.column)}`);
    }
    const row = landingRow(state.board, column);
    if (row < 0) throw new Error(`connect4.step：第 ${column} 列已满，不能再落子`);

    // 纯函数：复制棋盘，不改旧 state
    const board = state.board.map((line) => line.slice() as Stone[]);
    board[row][column] = stoneFor(seat);
    const lastMove: Move = { seat, column, row };
    const history = [...state.history, lastMove];
    const next: Connect4State = { board, turn: seat === 0 ? 1 : 0, history };
    const ended = isTerminalBoard(board);
    const nextSeat: Seat | null = ended ? null : next.turn;

    const events: GameEvent[] = [
      {
        type: 'drop',
        seat,
        column,
        row,
        board: board.map((line) => line.slice()),
        nextSeat,
        lastMove,
      },
    ];
    if (ended) events.push({ type: 'end', result: summarize(next) });
    return { state: next, events };
  },

  isTerminal(state: Connect4State): boolean {
    return isTerminalBoard(state.board);
  },

  result(state: Connect4State): GameResultSummary {
    return summarize(state);
  },

  currentSeat(state: Connect4State): Seat | null {
    // 终局没有「当前行动方」：返回 null，避免服务端/前端误以为还能落子
    return isTerminalBoard(state.board) ? null : state.turn;
  },

  observe(state: Connect4State, seat: Seat | null): Connect4Observation {
    const ended = isTerminalBoard(state.board);
    const current = ended ? null : state.turn;
    const summary = summarize(state);
    return {
      gameId: 'connect4',
      seat,
      round: ended ? state.history.length : state.history.length + 1,
      roundsTotal: CELLS_TOTAL,
      scores: ended ? { ...summary.scores } : { 0: 0, 1: 0 },
      // 旁观者不能行动：legalActions 恒为空（棋盘本来就是公开信息）
      legalActions: seat !== null && !ended ? connect4.legalActions(state, seat) : [],
      textView: buildConnect4TextView(state, seat),
      status: ended ? 'ended' : 'playing',
      currentSeat: current,
      isYourTurn: seat !== null && current !== null && current === seat,
      board: state.board.map((line) => line.slice()),
      history: state.history.map((move) => ({ ...move })),
    };
  },
};

/** 纯文本局面：给不看图、只会读文本的 Agent 用。 */
export function buildConnect4TextView(state: Connect4State, seat: Seat | null): string {
  const spectator = seat === null;
  // 旁观没有座位，但棋盘符号是绝对信息（X=座位 0 / O=座位 1），不需要「按座位 0 视角」改符号。
  const ended = isTerminalBoard(state.board);
  const current = ended ? null : state.turn;
  const moveNo = state.history.length;
  const mine = (seat ?? 0) === 0 ? 'X' : 'O';
  const lines: string[] = [];

  // 旁观时用中性称呼（座位 0 / 座位 1），不要写「你执 X」——旁观者并不执子。
  const who = spectator ? '旁观视图 · 座位 0 执 X · 座位 1 执 O' : `你执 ${mine}（座位 ${seat}）`;
  lines.push(
    ended
      ? `四子棋 · 对局结束（共 ${moveNo} 手）· ${who}`
      : `四子棋 · 第 ${moveNo + 1} 手（最多 ${CELLS_TOTAL} 手）· ${who}`,
  );
  lines.push('     ' + COLUMN_LABELS.join(' '));
  state.board.forEach((line, row) => {
    const cells = line.map((stone) => (stone === 0 ? '.' : stone === 1 ? 'X' : 'O')).join(' ');
    lines.push(`${row} |  ${cells}`);
  });
  lines.push('图例：X = 座位 0，O = 座位 1，. = 空；列 A-G 对应动作里的 column 0-6。');

  const last = state.history[state.history.length - 1];
  if (last) {
    lines.push(
      `上一手：座位 ${last.seat} 把棋子落在 ${COLUMN_LABELS[last.column]} 列（column ${last.column}）第 ${last.row} 行。`,
    );
  }

  if (ended) {
    lines.push(`对局已结束：${summarize(state).text}`);
  } else if (spectator) {
    lines.push(`现在轮到座位 ${current} 落子，旁观视图不可行动。`);
  } else if (current === seat) {
    lines.push('轮到你了：从 legalActions 里选一个 {"action":"drop","column":n}。');
  } else {
    lines.push(`现在轮到座位 ${current} 落子，等对方下完再到你。`);
  }
  return lines.join('\n');
}

export default connect4;
