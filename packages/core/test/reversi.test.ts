import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BOARD_SIZE,
  REVERSI_MAX_MOVES,
  countDiscs,
  flipsAt,
  legalMovesFor,
  reversi,
  type Disc,
  type ReversiState,
} from '../src/games/reversi.ts';

function boardWith(entries: Array<[number, number, 0 | 1]>): Disc[][] {
  const board: Disc[][] = Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => null as Disc),
  );
  for (const [r, c, v] of entries) board[r][c] = v;
  return board;
}

function stateWith(board: Disc[][], turn: 0 | 1 = 0): ReversiState {
  return { board, turn, passes: 0, lastPassSeat: null, history: [] };
}

function place(cell: [number, number]) {
  return { action: 'place', cell };
}

test('setup: 开局四子位置与先手', () => {
  const state = reversi.setup(0);
  assert.equal(state.board[3][3], 1);
  assert.equal(state.board[3][4], 0);
  assert.equal(state.board[4][3], 0);
  assert.equal(state.board[4][4], 1);
  assert.equal(state.turn, 0, '座位 0 先手');
  assert.deepEqual(state.history, []);
  assert.deepEqual(countDiscs(state.board), { 0: 2, 1: 2 });
  // 没有随机性：不同 seed 初始局面一致
  assert.deepEqual(reversi.setup(999).board, state.board);
});

test('开局合法落点：正好 4 个标准位置', () => {
  const state = reversi.setup(0);
  const cells = legalMovesFor(state.board, 0)
    .map((a) => a.cell as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  assert.deepEqual(cells, [
    [2, 3],
    [3, 2],
    [4, 5],
    [5, 4],
  ]);
  // 座位 1 的合法落点也是 4 个（镜像）
  assert.equal(legalMovesFor(state.board, 1).length, 4);
});

test('flipsAt: 八方向夹子，空点/已被占/翻不到子都返回空', () => {
  const board = boardWith([
    [3, 3, 1],
    [3, 4, 0],
    [4, 3, 0],
    [4, 4, 1],
  ]);
  assert.deepEqual(flipsAt(board, 2, 3, 0), [[3, 3]]);
  assert.deepEqual(flipsAt(board, 3, 5, 0), [], '起点右侧无对手子，翻不到');
  assert.deepEqual(flipsAt(board, 3, 3, 0), [], '已被占的点不能落子');
  assert.deepEqual(flipsAt(board, 0, 0, 0), [], '角上空点翻不到子');
});

test('落子：翻面、换手、计数正确', () => {
  const state = reversi.setup(0);
  const { state: next, events } = reversi.step(state, { 0: place([2, 3]) });
  assert.equal(next.board[2][3], 0, '落子生效');
  assert.equal(next.board[3][3], 0, '被夹的子翻成座位 0 的颜色');
  assert.deepEqual(countDiscs(next.board), { 0: 4, 1: 1 });
  assert.equal(next.turn, 1, '落子后换手');
  assert.equal(next.history.length, 1);
  const ev = events.find((e) => e.type === 'place')!;
  assert.equal(ev.seat, 0);
  assert.deepEqual(ev.flips, [[3, 3]]);
});

test('非法落子：已占格 / 翻不到子都会抛错', () => {
  const state = reversi.setup(0);
  assert.throws(() => reversi.step(state, { 0: place([3, 3]) }), /不合法落点|非法落子/);
  assert.throws(() => reversi.step(state, { 0: place([0, 0]) }), /不合法落点/);
  assert.throws(() => reversi.step(state, { 0: place([9, 9]) }), /非法落子/);
});

test('legalActions: 只给当前行动方，终局为空', () => {
  const state = reversi.setup(0);
  assert.equal(reversi.legalActions(state, 0).length, 4);
  assert.deepEqual(reversi.legalActions(state, 1), [], '不是座位 1 的回合');
  assert.deepEqual(reversi.legalActions(state, 0)[0].action, 'place');
});

test('对手无子可下：自动跳过，不换手、广播 pass 事件', () => {
  // 座位 0 两处可下；座位 1 在任何空点都翻不到子
  const board = boardWith([
    [0, 0, 0],
    [0, 1, 1],
    [5, 5, 1],
    [5, 6, 0],
    [5, 7, 1],
  ]);
  const state = stateWith(board, 0);
  const { state: next, events } = reversi.step(state, { 0: place([0, 2]) });
  assert.equal(next.board[0][1], 0, '被夹的子应翻面');
  assert.equal(next.turn, 0, '对手无子可下 → 跳过，还是座位 0 走');
  assert.equal(next.passes, 1);
  assert.ok(events.some((e) => e.type === 'pass' && e.seat === 1), '应广播 pass 事件');
  assert.equal(next.lastPassSeat, 1, 'state 应记住最近被跳过的座位');
  assert.equal(reversi.observe(next, 0).lastPassSeat, 1, '观测应能读到跳过信息');
  assert.equal(reversi.isTerminal(next), false, '座位 0 还能下，不该终局');
  assert.ok(reversi.legalActions(next, 0).length > 0);
});

test('终局：双方都无子可下 → status ended、按子数判胜负', () => {
  // 棋盘下满（全白）：既没有空点也没有黑子
  const full = boardWith(
    Array.from({ length: BOARD_SIZE * BOARD_SIZE }, (_, i) => [
      Math.floor(i / BOARD_SIZE),
      i % BOARD_SIZE,
      0 as 0 | 1,
    ]) as Array<[number, number, 0 | 1]>,
  );
  const state = stateWith(full, 0);
  assert.ok(reversi.isTerminal(state));
  const result = reversi.result(state);
  assert.equal(result.winner, 0);
  assert.deepEqual(result.scores, { 0: 64, 1: 0 });
  const obs = reversi.observe(state, 0);
  assert.equal(obs.status, 'ended');
  assert.equal(obs.currentSeat, null);
  assert.deepEqual(obs.legalActions, []);
});

test('平局：双方子数相同 → winner null', () => {
  // 32 : 32 满盘
  const entries: Array<[number, number, 0 | 1]> = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      entries.push([r, c, r < 4 ? 0 : 1]);
    }
  }
  const result = reversi.result(stateWith(boardWith(entries), 0));
  assert.equal(result.winner, null);
  assert.deepEqual(result.scores, { 0: 32, 1: 32 });
  assert.match(result.text, /平局/);
});

test('observe: 棋盘公开、比分即子数、座位相对字段', () => {
  const state = reversi.setup(0);
  const o0 = reversi.observe(state, 0);
  const o1 = reversi.observe(state, 1);
  assert.deepEqual(o0.board, o1.board, '棋盘对双方透明');
  assert.deepEqual(o0.scores, { 0: 2, 1: 2 });
  assert.equal(o0.yourDiscs, 2);
  assert.equal(o1.yourDiscs, 2);
  assert.equal(o0.isYourTurn, true);
  assert.equal(o1.isYourTurn, false);
  assert.equal(o0.round, 1);
  assert.equal(o0.roundsTotal, REVERSI_MAX_MOVES);
  assert.equal(o0.lastMove, null);
});

test('textView: A–H 列标、座位相对棋子符号、合法落点列表', () => {
  const state = reversi.setup(0);
  const view = String(reversi.observe(state, 0).textView);
  assert.match(view, /A B C D E F G H/);
  assert.match(view, /第 1 手/);
  assert.match(view, /轮到你落子/);
  assert.match(view, /D3/);
  const enemyView = String(reversi.observe(state, 1).textView);
  assert.match(enemyView, /轮到对手落子/);
  // 座位相对符号：座位 0 看到自己的子是 ●
  assert.ok(view.includes('●'));
  assert.ok(view.includes('○'));
});

test('多手连续：合法落点随局面变化，历史可回溯', () => {
  let state = reversi.setup(0);
  let guard = 0;
  while (!reversi.isTerminal(state) && guard++ < 70) {
    const seat = state.turn;
    const legal = legalMovesFor(state.board, seat);
    if (legal.length === 0) break;
    const cell = legal[0].cell as [number, number];
    state = reversi.step(state, { [seat]: place(cell) }).state;
  }
  assert.ok(state.history.length > 0, '应有落子历史');
  assert.ok(reversi.isTerminal(state) || state.history.length >= 60);
  const obs = reversi.observe(state, 0);
  assert.equal(obs.board.length, BOARD_SIZE);
  assert.equal(obs.board[0].length, BOARD_SIZE);
});

test('meta 契约', () => {
  assert.equal(reversi.meta.id, 'reversi');
  assert.equal(reversi.meta.status, 'playable');
  assert.equal(reversi.meta.resolution, 'turn');
  assert.equal(reversi.meta.seats, 2);
  assert.equal(BOARD_SIZE, 8);
  assert.match(reversi.meta.rules, /八个方向|夹住/);
});
