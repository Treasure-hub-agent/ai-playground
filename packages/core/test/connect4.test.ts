import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Action, GameEvent } from '../src/types.ts';
import {
  CELLS_TOTAL,
  COLUMN_LABELS,
  COLS,
  ROWS,
  connect4,
  findWinningSeat,
  isTerminalBoard,
  type Connect4State,
  type Stone,
} from '../src/games/connect4.ts';
import { games, getGame, getGameMeta, listGameMeta } from '../src/index.ts';

/** 轮流制工具：只给当前行动方传动作，模拟服务端 turn 模式对 step 的调用方式。 */
function play(state: Connect4State, column: number): { state: Connect4State; events: GameEvent[] } {
  const actions: Record<number, Action> = { [state.turn]: { action: 'drop', column } };
  return connect4.step(state, actions);
}

/** 连续落子，返回最终局面。 */
function playAll(state: Connect4State, columns: number[]): Connect4State {
  let cur = state;
  for (const column of columns) cur = play(cur, column).state;
  return cur;
}

/** 构造一块「满盘但没有任何四连」的平局棋盘（用于测边界）。 */
function drawBoard(): Stone[][] {
  const board: Stone[][] = [];
  for (let row = 0; row < ROWS; row++) {
    const line: Stone[] = [];
    for (let column = 0; column < COLS; column++) {
      // 值只由 (row + 2*column) % 4 决定：横/竖/两条斜的单向步进都会改变象限，天然断连
      line.push((row + 2 * column) % 4 < 2 ? 1 : 2);
    }
    board.push(line);
  }
  board[0][0] = 2; // 原始配比是 22:20，把这个角换掉正好 21:21（标准对局每方 21 子）
  return board;
}

/** 独立于实现的自检：数出棋盘里所有「4 连」窗口，用来验证平局棋盘真的没有四连。 */
function countFourWindows(board: Stone[][]): number {
  const dirs = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  let found = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const stone = board[r][c];
      if (stone === 0) continue;
      for (const [dr, dc] of dirs) {
        const endRow = r + dr * 3;
        const endCol = c + dc * 3;
        if (endRow < 0 || endRow >= ROWS || endCol < 0 || endCol >= COLS) continue;
        let win = true;
        for (let k = 1; k < 4; k++) {
          if (board[r + dr * k][c + dc * k] !== stone) {
            win = false;
            break;
          }
        }
        if (win) found++;
      }
    }
  }
  return found;
}

test('setup: 6x7 空盘、座位 0 先手、局面与 seed 无关', () => {
  const state = connect4.setup(1);
  assert.equal(ROWS, 6);
  assert.equal(COLS, 7);
  assert.equal(state.board.length, ROWS);
  for (const line of state.board) {
    assert.equal(line.length, COLS);
    assert.ok(line.every((stone) => stone === 0), '开局所有格子都应是空');
  }
  assert.equal(state.turn, 0);
  assert.deepEqual(state.history, []);
  // 四子棋没有随机信息：任何 seed 的初始局面都必须完全一致（保证可回放）
  assert.deepEqual(connect4.setup(1), connect4.setup(999999));
  assert.deepEqual(connect4.setup(0).board, state.board);
});

test('重力落子：同列从最底行往上堆，drop 事件字段齐全且不改旧 state', () => {
  const initial = connect4.setup(7);
  const first = play(initial, 3);
  assert.equal(first.events.length, 1);
  const drop = first.events[0];
  assert.equal(drop.type, 'drop');
  assert.equal(drop.seat, 0);
  assert.equal(drop.column, 3);
  assert.equal(drop.row, 5);
  assert.deepEqual(drop.lastMove, { seat: 0, column: 3, row: 5 });
  assert.equal(drop.nextSeat, 1);
  assert.equal((drop.board as Stone[][])[5][3], 1);
  // 纯函数：旧 state 不能被改写
  assert.equal(initial.board[5][3], 0);
  assert.equal(initial.turn, 0);
  assert.equal(initial.history.length, 0);

  const state = first.state;
  assert.equal(state.board[5][3], 1);
  assert.equal(state.board[0][3], 0);
  assert.equal(state.turn, 1);

  const second = play(state, 3);
  assert.equal(second.events[0].seat, 1);
  assert.equal(second.events[0].row, 4);
  assert.equal(second.state.board[4][3], 2);
  assert.equal(second.state.turn, 0);
  assert.deepEqual(second.state.history, [
    { seat: 0, column: 3, row: 5 },
    { seat: 1, column: 3, row: 4 },
  ]);
});

test('legalActions 按「是否轮到自己」返回：非当前行动方为空', () => {
  const state = connect4.setup(3);
  const legal0 = connect4.legalActions(state, 0);
  assert.deepEqual(
    legal0.map((a) => a.column),
    [0, 1, 2, 3, 4, 5, 6],
  );
  for (const action of legal0) assert.equal(action.action, 'drop');
  assert.deepEqual(connect4.legalActions(state, 1), [], '没轮到你时必须返回空数组');

  const obs0 = connect4.observe(state, 0);
  const obs1 = connect4.observe(state, 1);
  assert.equal(obs0.currentSeat, 0);
  assert.equal(obs0.isYourTurn, true);
  assert.equal(obs1.currentSeat, 0);
  assert.equal(obs1.isYourTurn, false);
  assert.deepEqual(obs1.legalActions, []);

  // 座位 0 落子后换手给座位 1
  const after = play(state, 0).state;
  assert.deepEqual(connect4.legalActions(after, 0), []);
  assert.equal(connect4.legalActions(after, 1).length, 7);
  assert.equal(connect4.observe(after, 1).isYourTurn, true);
  assert.equal(connect4.observe(after, 0).isYourTurn, false);
  assert.equal(connect4.currentSeat?.(after), 1);
});

test('step 只取当前行动方的动作，忽略对手座位混进来的动作', () => {
  const state = connect4.setup(5);
  const { state: next, events } = connect4.step(state, {
    0: { action: 'drop', column: 2 },
    1: { action: 'drop', column: 6 },
  });
  assert.equal(next.board[5][2], 1, '当前行动方（座位 0）的动作生效');
  assert.equal(next.board[5][6], 0, '座位 1 的动作必须被忽略');
  assert.equal(events.length, 1);
  assert.equal(events[0].seat, 0);
  assert.equal(next.turn, 1);
});

test('横向四连：底行 0-3 连成四子即获胜，终局 legalActions 为空', () => {
  let state = connect4.setup(11);
  let events: GameEvent[] = [];
  for (const column of [0, 0, 1, 1, 2, 2, 3]) {
    const result = play(state, column);
    state = result.state;
    events = result.events;
  }
  assert.deepEqual(state.board[5].slice(0, 4), [1, 1, 1, 1]);
  assert.ok(connect4.isTerminal(state));
  assert.equal(findWinningSeat(state.board), 0);

  const result = connect4.result(state);
  assert.equal(result.winner, 0);
  assert.deepEqual(result.scores, { 0: 1, 1: 0 });
  assert.match(result.text, /座位 0 获胜/);

  assert.equal(events[events.length - 1].type, 'end');
  assert.deepEqual(connect4.legalActions(state, 0), []);
  assert.deepEqual(connect4.legalActions(state, 1), []);
  assert.equal(connect4.currentSeat?.(state), null);
});

test('竖向四连：同一列叠四个同样获胜', () => {
  const state = playAll(connect4.setup(12), [0, 1, 0, 1, 0, 1, 0]);
  assert.deepEqual(
    [state.board[2][0], state.board[3][0], state.board[4][0], state.board[5][0]],
    [1, 1, 1, 1],
  );
  assert.ok(connect4.isTerminal(state));
  assert.equal(connect4.result(state).winner, 0);
});

test('斜向四连：座位 0 沿右上斜线 (5,0)→(4,1)→(3,2)→(2,3) 获胜', () => {
  const state = playAll(connect4.setup(13), [0, 1, 1, 2, 5, 2, 2, 3, 6, 3, 4, 3, 3]);
  assert.deepEqual(
    [state.board[5][0], state.board[4][1], state.board[3][2], state.board[2][3]],
    [1, 1, 1, 1],
  );
  assert.ok(connect4.isTerminal(state));
  assert.equal(connect4.result(state).winner, 0);
  assert.deepEqual(state.history[state.history.length - 1], { seat: 0, column: 3, row: 2 });
});

test('满列不可落子：legalActions 排除满列，step 拒绝越界/满列/错类型', () => {
  let state = connect4.setup(21);
  for (let i = 0; i < ROWS; i++) state = play(state, 0).state;
  assert.ok(
    state.board.every((line) => line[0] !== 0),
    '第 0 列应已填满',
  );
  // 交替堆叠不会出现四连，棋盘也没满 → 对局仍在进行
  assert.equal(connect4.isTerminal(state), false);
  assert.equal(connect4.currentSeat?.(state), 0);

  const legal = connect4.legalActions(state, 0);
  assert.deepEqual(
    legal.map((a) => a.column),
    [1, 2, 3, 4, 5, 6],
  );
  assert.ok(!legal.some((a) => a.column === 0), '满列不能被枚举为合法动作');

  assert.throws(() => play(state, 0), /第 0 列已满/);
  assert.throws(() => connect4.step(state, { 0: { action: 'drop', column: 7 } }), /列号必须是 0-6/);
  assert.throws(() => connect4.step(state, { 0: { action: 'drop', column: -1 } }), /列号必须是 0-6/);
  assert.throws(
    () => connect4.step(state, { 0: { action: 'grab', cell: [0, 0] } }),
    /动作类型必须是 drop/,
  );
});

test('满盘且无四连 → 平局（winner=null，双方 0 分）', () => {
  const board = drawBoard();
  // 先独立自检棋盘：满盘、每方 21 子、确实一个四连都没有
  assert.ok(board.every((line) => line.every((stone) => stone !== 0)), '平局棋盘必须填满');
  assert.equal(countFourWindows(board), 0, '平局棋盘不能含四连');
  const stones = board.flat();
  assert.equal(stones.filter((s) => s === 1).length, 21);
  assert.equal(stones.filter((s) => s === 2).length, 21);

  const state: Connect4State = { board, turn: 0, history: [] };
  assert.ok(connect4.isTerminal(state));
  assert.equal(findWinningSeat(board), null);

  const result = connect4.result(state);
  assert.equal(result.winner, null);
  assert.deepEqual(result.scores, { 0: 0, 1: 0 });
  assert.match(result.text, /平局/);

  for (const seat of [0, 1] as const) {
    const obs = connect4.observe(state, seat);
    assert.equal(obs.status, 'ended');
    assert.equal(obs.currentSeat, null);
    assert.equal(obs.isYourTurn, false);
    assert.deepEqual(obs.legalActions, []);
  }
  assert.equal(connect4.currentSeat?.(state), null);
  assert.deepEqual(connect4.legalActions(state, 0), []);
  assert.deepEqual(connect4.legalActions(state, 1), []);
});

test('observe: 返回副本（改观测不污染内核），textView 含列标与回合提示', () => {
  const state = connect4.setup(4);
  const obs = connect4.observe(state, 0);
  obs.board[5][0] = 1;
  obs.history.push({ seat: 1, column: 0, row: 0 });
  assert.equal(state.board[5][0], 0, 'observe 必须深拷贝棋盘');
  assert.equal(state.history.length, 0, 'observe 必须深拷贝历史');

  assert.equal(obs.round, 1);
  assert.equal(obs.roundsTotal, CELLS_TOTAL);
  assert.equal(CELLS_TOTAL, 42);
  assert.match(String(obs.textView), /A B C D E F G/);
  assert.match(String(obs.textView), /轮到你了/);
  assert.match(String(connect4.observe(state, 1).textView), /现在轮到座位 0/);
});

test('observe 终局：currentSeat=null、isYourTurn=false、scores 1:0、textView 带结论', () => {
  const state = playAll(connect4.setup(31), [0, 0, 1, 1, 2, 2, 3]);
  assert.ok(isTerminalBoard(state.board));
  for (const seat of [0, 1] as const) {
    const obs = connect4.observe(state, seat);
    assert.equal(obs.status, 'ended');
    assert.equal(obs.currentSeat, null);
    assert.equal(obs.isYourTurn, false);
    assert.deepEqual(obs.legalActions, []);
    assert.deepEqual(obs.scores, { 0: 1, 1: 0 });
    assert.match(String(obs.textView), /对局已结束/);
    assert.match(String(obs.textView), /座位 0 获胜/);
  }
  assert.equal(connect4.currentSeat?.(state), null);
  assert.equal(connect4.result(state).winner, 0);
});

test('注册表加一行即上线：getGame / getGameMeta / listGameMeta 都能看到四子棋', () => {
  assert.equal(games.connect4, connect4);
  assert.equal(getGame('connect4'), connect4);

  const meta = getGameMeta('connect4');
  assert.ok(meta, 'getGameMeta 应能找到四子棋');
  assert.equal(meta!.id, 'connect4');
  assert.equal(meta!.name, '四子棋');
  assert.equal(meta!.tagline, '横竖斜先连成四子');
  assert.equal(meta!.seats, 2);
  assert.equal(meta!.status, 'playable', 'playable 才能开桌（大厅不再显示开发中）');
  assert.equal(meta!.resolution, 'turn');
  assert.equal(meta!.category, '棋类');
  assert.deepEqual(meta!.tags, ['完全信息', '经典', '快局']);
  assert.equal(meta!.duration, '2–4 分钟');
  assert.equal(meta!.accent, '#3f7fd6');
  assert.match(meta!.rules, /四子棋/);

  // 大厅目录里恰好出现一次，不会和路线图占位重复
  assert.equal(listGameMeta().filter((m) => m.id === 'connect4').length, 1);
  // 原有游戏不受影响
  assert.ok(getGame('grab'));
  assert.equal(COLUMN_LABELS[3], 'D');
});
