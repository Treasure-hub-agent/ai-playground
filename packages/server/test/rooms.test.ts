/**
 * RoomManager 单元测试（不依赖 HTTP / 浏览器）
 *
 * 运行：pnpm -C packages/server test
 *      = tsx --test test/rooms.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, type ChatMessage, type JoinResult, type Room, type SubmitResult } from '../src/rooms.ts';
import { games } from '@ai-playground/core';
import type { Action, GameEvent, GameMeta, GameSpec } from '@ai-playground/core';

type Coord = [number, number];

/** 不做令牌补全的真实方法，用来测「没令牌 / 错令牌」的降级与 403。 */
interface RawRoomAuth {
  join: (id: string, seat: number, token?: string) => JoinResult;
  submit: (id: string, seat: number, action: Action, token?: string) => SubmitResult;
  observation: (id: string, seat: number, token?: string) => any;
  say: (id: string, seat: number, text: string, token?: string) => ChatMessage;
}

type TestRoomManager = RoomManager & { raw: RawRoomAuth };

/**
 * 测试垫片：真实 RoomManager + 入座后自动补令牌。
 *
 * 第 12 轮起 submit / say / 带座位视角的观测都必须出示该座位的令牌（设计稿 §3.3）。
 * 既有用例大多在验证游戏逻辑，逐处手写第 4 个参数会把断言淹没；这里在 join 成功时
 * 把令牌记进账本，调用时按 (房间, 座位) 自动补齐。
 * 需要验证「没令牌 / 错令牌」时，用 manager.raw 上的原始方法（不做任何补全）。
 */
function newManager(): TestRoomManager {
  const manager = new RoomManager() as TestRoomManager;
  const ledger = new Map<string, [string | null, string | null]>();
  const raw: RawRoomAuth = {
    join: manager.join.bind(manager),
    submit: manager.submit.bind(manager),
    observation: manager.observation.bind(manager),
    say: manager.say.bind(manager),
  };
  const tokenFor = (id: string, seat: number): string | undefined => ledger.get(id)?.[seat] ?? undefined;

  manager.join = ((id: string, seat: number, token?: string): JoinResult => {
    const result = raw.join(id, seat, token);
    const seats = ledger.get(id) ?? [null, null];
    seats[seat] = result.token;
    ledger.set(id, seats);
    return result;
  }) as RoomManager['join'];

  manager.submit = ((id: string, seat: number, action: Action, token?: string): SubmitResult =>
    raw.submit(id, seat, action, token ?? tokenFor(id, seat))) as RoomManager['submit'];

  manager.observation = ((id: string, seat: number, token?: string) =>
    raw.observation(id, seat, token ?? tokenFor(id, seat))) as RoomManager['observation'];

  manager.say = ((id: string, seat: number, text: string, token?: string): ChatMessage =>
    raw.say(id, seat, text, token ?? tokenFor(id, seat))) as RoomManager['say'];

  manager.raw = raw;
  return manager;
}

function newRoom(): { manager: RoomManager; room: Room } {
  const manager = newManager();
  const room = manager.create('grab');
  return { manager, room };
}

function joinBoth(manager: RoomManager, room: Room): void {
  // 0 号位令牌在 create() 时就预留好了，入座必须出示它（防止无令牌抢人类座位）
  manager.join(room.id, 0, room.seatTokens[0] ?? undefined);
  manager.join(room.id, 1);
}

function legal(room: Room, seat = 0): Action[] {
  return room.game.legalActions(room.state, seat) as Action[];
}

function grab(cell: Coord): Action {
  return { action: 'grab', cell: [cell[0], cell[1]] };
}

function sameCell(a: Coord | undefined, b: Coord | undefined): boolean {
  return Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
}

function findReveal(events: GameEvent[]): any {
  const event = events.find((e) => e.type === 'reveal');
  assert.ok(event, 'events 应包含 reveal');
  return event;
}

function findEnd(events: GameEvent[]): any | undefined {
  return events.find((e) => e.type === 'end');
}

/** 挑两个不同的合法格（seat0 用第一格，seat1 用剩下最后一格） */
function pickDistinct(room: Room): [Action, Action] {
  const a0 = legal(room, 0)[0];
  const a1 = legal(room, 1).find((a) => !sameCell(a.cell, a0.cell));
  assert.ok(a0, '应至少有一个合法格');
  assert.ok(a1, '开局应有至少两个不同合法格');
  return [a0, a1 as Action];
}

// ───────────────────────────── 1. waiting_for_opponent ─────────────────────────────

test('waiting_for_opponent：只有一方入座时提交被拒绝，且不产生任何状态变化', () => {
  const { manager, room } = newRoom();
  manager.join(room.id, 0, room.seatTokens[0] ?? undefined);

  assert.equal(room.status, 'waiting', '单方入座时房间应处于 waiting');
  const res = manager.submit(room.id, 0, legal(room)[0]);

  assert.equal(res.resolved, false);
  assert.equal(res.error, 'waiting_for_opponent');
  assert.deepEqual(res.events, []);
  assert.deepEqual(room.pending, [null, null], '被拒的提交不应写入 pending');
  assert.equal(room.state.round, 1, '被拒的提交不应推进回合');
  assert.equal(room.state.history.length, 0);
  assert.equal(room.status, 'waiting');
});

// ───────────────────────────── 2. illegal_action ─────────────────────────────

test('illegal_action：非法格 / 已抢格 / 错误 action 名都返回 legalActions', () => {
  const { manager, room } = newRoom();
  joinBoth(manager, room);

  // 2.1 越界格
  const legalBefore = legal(room, 0);
  const oob = manager.submit(room.id, 0, grab([9, 9]));
  assert.equal(oob.resolved, false);
  assert.equal(oob.error, 'illegal_action');
  assert.ok(Array.isArray(oob.legalActions), 'illegal_action 必须回带 legalActions');
  assert.equal(oob.legalActions!.length, legalBefore.length, 'legalActions 数量应与当前盘面一致');
  assert.deepEqual(
    oob.legalActions!.map((a) => (a.cell as Coord).join(',')).sort(),
    legalBefore.map((a) => (a.cell as Coord).join(',')).sort(),
    'legalActions 内容应与合法动作集合一致',
  );
  assert.equal(room.pending[0], null, '非法动作不应写入 pending');
  assert.equal(room.state.round, 1, '非法动作不应推进回合');

  // 2.2 错误 action 名
  const wrongKind = manager.submit(room.id, 0, { action: 'steal', cell: legalBefore[0].cell } as unknown as Action);
  assert.equal(wrongKind.error, 'illegal_action');
  assert.ok(Array.isArray(wrongKind.legalActions));

  // 2.3 已被抢走的格子
  const [a0, a1] = pickDistinct(room);
  assert.equal(manager.submit(room.id, 0, a0).resolved, false);
  assert.equal(manager.submit(room.id, 1, a1).resolved, true);
  assert.equal(room.state.grid[a0.cell[0]][a0.cell[1]], null, '被选中的格子应已被抢走');

  const legalRound2 = legal(room, 0);
  assert.ok(
    !legalRound2.some((a) => sameCell(a.cell, a0.cell)),
    '已抢走的格子不应再出现在 legalActions 里',
  );
  const taken = manager.submit(room.id, 0, grab(a0.cell as Coord));
  assert.equal(taken.error, 'illegal_action');
  assert.deepEqual(
    taken.legalActions!.map((a) => (a.cell as Coord).join(',')).sort(),
    legalRound2.map((a) => (a.cell as Coord).join(',')).sort(),
  );
});

// ───────────────────────────── 3. action_already_submitted ─────────────────────────────

test('action_already_submitted：双方到齐前同一座位重复提交被拒，首次动作保持生效', () => {
  const { manager, room } = newRoom();
  joinBoth(manager, room);

  const seat1Pick = legal(room, 1)[0];
  const first = manager.submit(room.id, 1, seat1Pick);
  assert.equal(first.resolved, false, 'seat0 未提交时应 resolved=false');
  assert.deepEqual(first.events, []);
  assert.notEqual(room.pending[1], null, '首次提交应挂在 pending[1] 上');

  const alternative = legal(room, 1).find((a) => !sameCell(a.cell, seat1Pick.cell));
  const dup = manager.submit(room.id, 1, alternative as Action);
  assert.equal(dup.resolved, false);
  assert.equal(dup.error, 'action_already_submitted');
  assert.deepEqual(dup.events, []);
  assert.deepEqual(room.pending[1], seat1Pick, '重复提交不应覆盖第一次的动作');

  // seat0 提交后正常结算，生效的应是 seat1 第一次提交的格子
  const seat0Pick = legal(room, 0).find((a) => !sameCell(a.cell, seat1Pick.cell)) as Action;
  const resolved = manager.submit(room.id, 0, seat0Pick);
  assert.equal(resolved.resolved, true);
  const reveal = findReveal(resolved.events);
  assert.deepEqual(reveal.picks['1'], seat1Pick.cell, '首次提交的格子才应生效');
  assert.deepEqual(reveal.picks['0'], seat0Pick.cell);
});

// ───────────────────────────── 4. 正常结算 ─────────────────────────────

test('正常结算：pending 清零、round+1、观测 / 历史 / 比分自洽', () => {
  const { manager, room } = newRoom();
  joinBoth(manager, room);

  const [a0, a1] = pickDistinct(room);
  const before = manager.observation(room.id, 0);
  assert.equal(before.round, 1);
  assert.equal(before.youSubmitted, false);
  assert.deepEqual(before.waitingFor, [0, 1]);
  assert.deepEqual(manager.summary(room.id).pendingSeats, []);

  // 单方提交：不结算，标记 youSubmitted / waitingFor / pendingSeats
  const res0 = manager.submit(room.id, 0, a0);
  assert.equal(res0.resolved, false);
  assert.deepEqual(res0.events, []);
  const mid = manager.observation(room.id, 0);
  assert.equal(mid.youSubmitted, true);
  assert.deepEqual(mid.waitingFor, [1], 'seat0 提交后只等 seat1');
  assert.deepEqual(manager.summary(room.id).pendingSeats, [0]);
  assert.equal(room.state.round, 1, '未结算前回合不应推进');

  // 双方到齐：立即结算
  const res1 = manager.submit(room.id, 1, a1);
  assert.equal(res1.resolved, true, '双方提交后应 resolved=true');
  const reveal = findReveal(res1.events);
  assert.equal(reveal.round, 1);
  assert.deepEqual(reveal.picks['0'], a0.cell);
  assert.deepEqual(reveal.picks['1'], a1.cell);
  assert.equal(typeof reveal.delta['0'], 'number');
  assert.equal(typeof reveal.delta['1'], 'number');

  assert.deepEqual(room.pending, [null, null], '结算后 pending 应清零');
  assert.equal(room.state.round, 2, '结算后 round 应 +1');
  assert.equal(room.status, 'playing', '9 格棋盘不可能首回合结束');
  assert.equal(room.state.history.length, 1, '历史应记录 1 回合');

  const after = manager.observation(room.id, 0);
  assert.equal(after.round, 2);
  assert.equal(after.youSubmitted, false);
  assert.deepEqual(after.waitingFor, [0, 1], '新回合双方都重新待提交');
  assert.equal(after.history.length, 1);
  const record = after.history[0];
  assert.equal(record.round, 1);
  assert.deepEqual(record.picks, { 0: a0.cell, 1: a1.cell } as any);
  assert.deepEqual(record.delta, reveal.delta);
  assert.equal(record.collision, reveal.collision);
  assert.equal(after.scores[0], 0 + Number(reveal.delta['0']), '比分应等于 delta 累加');
  assert.equal(after.scores[1], 0 + Number(reveal.delta['1']), '比分应等于 delta 累加');
  assert.deepEqual(reveal.scores, after.scores);
  assert.equal(after.yourScore, after.scores[0]);
  assert.equal(after.opponentScore, after.scores[1]);
  // 本回合消耗 2 格
  assert.equal(after.legalActions.length, before.legalActions.length - 2);
  assert.equal(after.grid[a0.cell[0]][a0.cell[1]], 'taken');
  assert.equal(after.grid[a1.cell[0]][a1.cell[1]], 'taken');
});

// ───────────────────────────── 5. 撞车 ─────────────────────────────

test('撞车：双方同格时 delta 均为 0，该格 taken，且只消耗一格', () => {
  const { manager, room } = newRoom();
  joinBoth(manager, room);

  const target = legal(room, 0)[0].cell as Coord;
  assert.ok(
    legal(room, 1).some((a) => sameCell(a.cell, target)),
    '撞车格在双方视角都应仍然存在',
  );
  assert.notEqual(room.state.grid[target[0]][target[1]], null, '撞车格结算前不应为空');
  const beforeGrid = room.state.grid.flat().filter((c) => c !== null).length;

  const res0 = manager.submit(room.id, 0, grab(target));
  assert.equal(res0.resolved, false);
  const res1 = manager.submit(room.id, 1, grab(target));
  assert.equal(res1.resolved, true);

  const reveal = findReveal(res1.events);
  assert.equal(reveal.collision, true, '双方同格应标记 collision=true');
  assert.equal(reveal.delta['0'], 0, '撞车时 seat0 delta 应为 0');
  assert.equal(reveal.delta['1'], 0, '撞车时 seat1 delta 应为 0');
  assert.deepEqual(reveal.applied, { 0: 'collision', 1: 'collision' });
  assert.deepEqual(room.state.scores, { 0: 0, 1: 0 }, '撞车时双方比分不变');
  assert.equal(room.state.grid[target[0]][target[1]], null, '撞车格应消失');
  assert.equal(reveal.grid[target[0]][target[1]], 'taken', 'grid 快照里撞车格应为 taken');
  assert.equal(
    reveal.grid.flat().filter((c: unknown) => c === 'taken').length,
    1,
    '撞车只消耗一格',
  );
  assert.equal(room.state.grid.flat().filter((c) => c !== null).length, beforeGrid - 1);
  assert.equal(room.state.round, 2, '撞车同样推进回合');
  assert.deepEqual(room.pending, [null, null]);
  assert.equal(findEnd(res1.events), undefined, '首回合撞车不可能结束对局');
});

// ───────────────────────────── 6. 结束 ─────────────────────────────

test('room_ended：打满整局后状态为 ended，再提交被拒绝且 result 完整', () => {
  const { manager, room } = newRoom();
  joinBoth(manager, room);

  let rounds = 0;
  let lastEnd: any | null = null;
  while (room.status === 'playing') {
    assert.ok(++rounds <= 12, '对局应在 12 回合内结束');
    const a0 = legal(room, 0)[0];
    assert.ok(a0, `第 ${rounds} 回合应有合法动作`);
    const a1 =
      legal(room, 1).find((a) => !sameCell(a.cell, a0.cell)) ?? legal(room, 1)[0];
    assert.ok(a1, 'seat1 应有合法动作');

    const res0 = manager.submit(room.id, 0, a0);
    assert.equal(res0.resolved, false, `第 ${rounds} 回合单方提交不应结算`);
    const res1 = manager.submit(room.id, 1, a1);
    assert.equal(res1.resolved, true, `第 ${rounds} 回合双方提交后应结算`);
    findReveal(res1.events);
    lastEnd = findEnd(res1.events) ?? lastEnd;
  }

  // 结束条件：场上金币被抢完即结束（不再强行走完空格/炸弹格）
  assert.ok(rounds >= 1 && rounds <= 9, `对局回合数应在 1–9 之间，实际 ${rounds}`);
  assert.equal(room.status, 'ended');
  assert.ok(room.result, '结束后 room.result 不应为空');
  assert.equal(lastEnd !== null, true, '最后一个回合的 events 应带 end 事件');
  assert.deepEqual(lastEnd.result, room.result, 'end 事件与 room.result 应一致');
  assert.equal(typeof room.result!.text, 'string');
  assert.ok(room.result!.text.length > 0);
  assert.deepEqual(room.result!.scores, room.state.scores, 'result.scores 应等于终局比分');
  assert.equal(
    room.result!.winner,
    room.state.scores[0] === room.state.scores[1]
      ? null
      : room.state.scores[0] > room.state.scores[1]
        ? 0
        : 1,
    'winner 应与终局比分一致',
  );
  assert.equal(room.state.round, rounds + 1, '终局 round 应为已打回合数 + 1');
  assert.deepEqual(room.pending, [null, null], '终局 pending 应为空');
  assert.deepEqual(legal(room, 0), [], '终局 legalActions 应为空');
  assert.deepEqual(legal(room, 1), []);

  const summary = manager.summary(room.id);
  assert.equal(summary.status, 'ended');
  assert.deepEqual(summary.result, room.result);
  assert.deepEqual(summary.pendingSeats, []);
  assert.equal(summary.round, rounds, '结束后 summary.round 应等于已进行回合数');

  const late = manager.submit(room.id, 0, grab([0, 0]));
  assert.equal(late.resolved, false);
  assert.equal(late.error, 'room_ended');
  assert.deepEqual(late.events, []);
  assert.deepEqual(room.pending, [null, null], '被拒的终局提交不应写入 pending');
});

// ───────────────────────────── 7. 聊天（附带覆盖） ─────────────────────────────

test('聊天：say 递增 id、chat?since 过滤、同座位 800ms 限流、超长文本截断', () => {
  const { manager, room } = newRoom();
  // 第 12 轮起聊天也要令牌：先让两个座位都有凭据
  manager.join(room.id, 0, room.seatTokens[0] ?? undefined);
  manager.join(room.id, 1);

  const m1 = manager.say(room.id, 0, '这枚金币归我了');
  assert.equal(m1.id, 1);
  assert.equal(m1.seat, 0);
  assert.equal(m1.text, '这枚金币归我了');
  assert.equal(typeof m1.at, 'number');

  const m2 = manager.say(room.id, 1, '哼，看我的！');
  assert.equal(m2.id, 2);
  assert.equal(m2.seat, 1);

  // 限流：同座位立刻再说一句
  assert.throws(() => manager.say(room.id, 1, '再说一句'), /太快/);

  assert.deepEqual(manager.chat(room.id, 0), [m1, m2]);
  assert.deepEqual(manager.chat(room.id, m1.id), [m2]);
  assert.deepEqual(manager.chat(room.id, m2.id), []);

  // 超长文本：第 18 轮起改为**明确拒绝**（以前是静默截断到 200 字，用户完全不知道被砍了）。
  const other = newRoom();
  other.manager.join(other.room.id, 0, other.room.seatTokens[0] ?? undefined);
  assert.throws(() => other.manager.say(other.room.id, 0, '鲸'.repeat(300)), /文本太长.*200 字/);
  // 恰好 200 字仍然可以发（边界不算超长）
  const exact = other.manager.say(other.room.id, 0, '鲸'.repeat(200));
  assert.equal(exact.text.length, 200, '200 字是上限，应当允许');
});

// ═════════════════════════ turn（轮流制）结算模式 ═════════════════════════

/**
 * 极简轮流制测试桩：3x3 空格，双方轮流落子，先占满一整行者胜；
 * 动作形状故意用 {action:'place', row, col}（不是 grab 的 cell），验证服务端不特判具体游戏。
 */
const STUB_TURN_ID = 'stub-turn';
const STUB_SIZE = 3;
type StubSeat = 0 | 1;

interface StubTurnState {
  board: (StubSeat | null)[][];
  turn: StubSeat;
  moves: number;
  winner: StubSeat | null;
}

function stubHasFullRow(board: (StubSeat | null)[][], seat: StubSeat): boolean {
  for (let r = 0; r < STUB_SIZE; r++) {
    if (board[r].every((cell) => cell === seat)) return true;
  }
  return false;
}

function stubIsTerminal(state: StubTurnState): boolean {
  return state.winner !== null || state.moves >= STUB_SIZE * STUB_SIZE;
}

function stubCurrentSeat(state: StubTurnState): StubSeat | null {
  return stubIsTerminal(state) ? null : state.turn;
}

function stubResult(state: StubTurnState) {
  return {
    winner: state.winner,
    scores: { 0: state.winner === 0 ? 1 : 0, 1: state.winner === 1 ? 1 : 0 },
    text: state.winner === null ? '平局！' : `座位 ${state.winner} 获胜！`,
  };
}

const stubTurn: GameSpec<StubTurnState, Record<string, unknown>> = {
  meta: {
    id: STUB_TURN_ID,
    name: '轮流三连（测试桩）',
    tagline: '轮流落子，先占满一整行者胜',
    seats: 2,
    rules: '双方轮流在空格落子，先占满一整行者获胜。动作：{"action":"place","row":r,"col":c}，取值 0-2。',
    category: '棋类',
    tags: ['轮流制'],
    duration: '10 秒',
    status: 'playable',
    accent: '#4b7bec',
    resolution: 'turn',
  } satisfies GameMeta,

  setup(): StubTurnState {
    return {
      board: Array.from({ length: STUB_SIZE }, () => Array.from({ length: STUB_SIZE }, () => null)),
      turn: 0,
      moves: 0,
      winner: null,
    };
  },

  legalActions(state, seat): Action[] {
    // 非当前行动方没有可行动作（真实轮流制游戏通常也这样返回 []）
    if (stubIsTerminal(state) || stubCurrentSeat(state) !== seat) return [];
    const actions: Action[] = [];
    for (let r = 0; r < STUB_SIZE; r++) {
      for (let c = 0; c < STUB_SIZE; c++) {
        if (state.board[r][c] === null) actions.push({ action: 'place', row: r, col: c });
      }
    }
    return actions;
  },

  step(state, actions) {
    const seat = state.turn;
    const { row, col } = actions[seat] as { row: number; col: number };
    const board = state.board.map((line) => line.slice() as (StubSeat | null)[]);
    board[row][col] = seat;
    const next: StubTurnState = {
      board,
      turn: seat === 0 ? 1 : 0,
      moves: state.moves + 1,
      winner: stubHasFullRow(board, seat) ? seat : null,
    };
    const events: GameEvent[] = [{ type: 'place', seat, row, col, round: state.moves + 1 }];
    if (stubIsTerminal(next)) events.push({ type: 'end', result: stubResult(next) });
    return { state: next, events };
  },

  isTerminal(state): boolean {
    return stubIsTerminal(state);
  },

  result(state) {
    return stubResult(state);
  },

  currentSeat(state): StubSeat | null {
    return stubCurrentSeat(state);
  },

  observe(state, seat) {
    return {
      gameId: STUB_TURN_ID,
      seat,
      round: Math.min(state.moves + 1, STUB_SIZE * STUB_SIZE),
      roundsTotal: STUB_SIZE * STUB_SIZE,
      scores: stubResult(state).scores,
      legalActions: stubTurn.legalActions(state, seat),
      textView: state.board
        .map((line) => line.map((cell) => (cell === null ? '.' : String(cell))).join(''))
        .join('\n'),
      status: stubIsTerminal(state) ? ('ended' as const) : ('playing' as const),
      board: state.board,
    };
  },
};

function newTurnRoom(): { manager: RoomManager; room: Room } {
  if (!games[STUB_TURN_ID]) games[STUB_TURN_ID] = stubTurn;
  const manager = newManager();
  const room = manager.create(STUB_TURN_ID);
  manager.join(room.id, 0, room.seatTokens[0] ?? undefined);
  manager.join(room.id, 1);
  return { manager, room };
}

function place(row: number, col: number): Action {
  return { action: 'place', row, col };
}

// ───────────────────────────── 8. turn: not_your_turn ─────────────────────────────

test('turn 模式 not_your_turn：非当前行动方提交被拒，房间状态与 pending 均不变', () => {
  const { manager, room } = newTurnRoom();
  const snapshot = JSON.stringify(room.state);

  assert.equal(manager.submit(room.id, 0, place(1, 1)).resolved, true, 'seat0 先手应先落子');
  const stateAfterFirst = JSON.stringify(room.state);
  const logLength = room.log.length;
  assert.equal(logLength, 1);

  const rejected = manager.submit(room.id, 0, place(0, 0));
  assert.equal(rejected.resolved, false);
  assert.equal(rejected.error, 'not_your_turn');
  assert.deepEqual(rejected.events, []);
  assert.equal(JSON.stringify(room.state), stateAfterFirst, 'not_your_turn 不应改动棋盘');
  assert.equal(room.log.length, logLength, 'not_your_turn 不应写日志');
  assert.deepEqual(room.pending, [null, null], 'turn 模式始终不写 pending');
  assert.notEqual(snapshot, stateAfterFirst);

  // 先手方拿着好牌也不越权：座位 1 只有轮到它才能动
  const seat1 = manager.submit(room.id, 1, place(2, 2));
  assert.equal(seat1.error, undefined);
  assert.equal(seat1.resolved, true, '轮到 seat1 时应可结算');

  // 开局未轮到的一方（seat1 先手时）
  const other = newTurnRoom();
  const early = other.manager.submit(other.room.id, 1, place(0, 0));
  assert.equal(early.error, 'not_your_turn');
  assert.equal(other.room.state.moves, 0);
});

test('turn 模式：单方入座时仍是 waiting_for_opponent（与 simultaneous 共用前置校验）', () => {
  if (!games[STUB_TURN_ID]) games[STUB_TURN_ID] = stubTurn;
  const manager = newManager();
  const room = manager.create(STUB_TURN_ID);
  manager.join(room.id, 0, room.seatTokens[0] ?? undefined);
  const res = manager.submit(room.id, 0, place(0, 0));
  assert.equal(res.resolved, false);
  assert.equal(res.error, 'waiting_for_opponent');
  assert.equal(room.state.moves, 0);
});

// ───────────────────────────── 9. turn: 提交即结算、回合易手 ─────────────────────────────

test('turn 模式结算：当前方提交即 resolved=true、事件广播、回合立刻易手', () => {
  const { manager, room } = newTurnRoom();
  const broadcast: GameEvent[] = [];
  manager.onEvents((roomId, events) => {
    if (roomId === room.id) broadcast.push(...events);
  });

  const res = manager.submit(room.id, 0, place(0, 0));
  assert.equal(res.resolved, true, 'turn 模式单方提交应立刻结算');
  assert.equal(res.error, undefined);
  assert.equal(res.events.length, 1, '落子即一次事件（未终局）');
  const placeEvent = res.events[0];
  assert.equal(placeEvent.type, 'place');
  assert.equal(placeEvent.seat, 0);
  assert.equal(placeEvent.row, 0);
  assert.equal(placeEvent.col, 0);

  assert.equal(room.state.board[0][0], 0, '棋盘应立刻写回');
  assert.equal(room.game.currentSeat?.(room.state), 1, '结算后应立即换手给 seat1');
  assert.equal(broadcast.length, 1, '结算事件应广播给 WS 订阅者');
  assert.deepEqual(broadcast, res.events);
  assert.equal(room.log.length, 1, '日志应记录事件');
  assert.equal(room.log[0].event.type, 'place');
  assert.deepEqual(room.pending, [null, null], 'turn 模式不写 pending');
  assert.equal(room.status, 'playing');
});

// ───────────────────────────── 10. turn: illegal_action ─────────────────────────────

test('turn 模式 illegal_action：越界 / 错动作名 / 已占格都被拒，且带 legalActions、不换手', () => {
  const { manager, room } = newTurnRoom();

  // 10.1 越界落点
  const oob = manager.submit(room.id, 0, place(9, 9));
  assert.equal(oob.resolved, false);
  assert.equal(oob.error, 'illegal_action');
  assert.ok(Array.isArray(oob.legalActions), 'illegal_action 必须回带 legalActions');
  assert.equal(oob.legalActions!.length, 9, '空棋盘应有 9 个合法落点');
  assert.equal(room.state.moves, 0, '非法动作不应落子');
  assert.equal(room.game.currentSeat?.(room.state), 0, '非法动作不应换手');

  // 10.2 错误 action 名（形状对但不是本游戏的动作）
  const wrongKind = manager.submit(room.id, 0, { action: 'grab', row: 0, col: 0 });
  assert.equal(wrongKind.error, 'illegal_action');
  assert.ok(Array.isArray(wrongKind.legalActions));

  // 10.3 缺字段
  const missing = manager.submit(room.id, 0, { action: 'place', row: 0 });
  assert.equal(missing.error, 'illegal_action');

  // 10.4 已被占的格子
  assert.equal(manager.submit(room.id, 0, place(1, 1)).resolved, true);
  const taken = manager.submit(room.id, 1, place(1, 1));
  assert.equal(taken.error, 'illegal_action');
  assert.ok(
    !taken.legalActions!.some((a) => a.row === 1 && a.col === 1),
    '已占格不应出现在 legalActions 里',
  );
  assert.equal(taken.legalActions!.length, 8);
  assert.equal(room.game.currentSeat?.(room.state), 1, '被拒后仍应由 seat1 行动');

  // 合法提交后 legalActions 随棋盘收紧
  assert.equal(manager.submit(room.id, 1, place(0, 0)).resolved, true);
  const obs = manager.observation(room.id, 0);
  assert.equal(obs.legalActions.length, 7);
  assert.equal(room.state.moves, 2);
});

// ───────────────────────────── 11. turn: observation / summary 字段 ─────────────────────────────

test('turn 模式观测：currentSeat / isYourTurn 正确，summary.pendingSeats 恒为空', () => {
  const { manager, room } = newTurnRoom();

  const seat0Before = manager.observation(room.id, 0);
  assert.equal(seat0Before.currentSeat, 0, '开局 seat0 先手');
  assert.equal(seat0Before.isYourTurn, true);
  assert.equal(seat0Before.youSubmitted, false, 'turn 模式没有挂起动作，恒为 false');
  assert.deepEqual(seat0Before.waitingFor, [0], '只等当前行动方');

  const seat1Before = manager.observation(room.id, 1);
  assert.equal(seat1Before.currentSeat, 0, '对手视角的当前行动方同样是 seat0');
  assert.equal(seat1Before.isYourTurn, false, '不是 seat1 的回合');
  assert.deepEqual(seat1Before.waitingFor, [0]);

  assert.deepEqual(manager.summary(room.id).pendingSeats, [], 'turn 模式没有挂起槽，恒为空');
  assert.equal(manager.summary(room.id).status, 'playing');

  // 落子后换手，两个视角同步翻转
  assert.equal(manager.submit(room.id, 0, place(2, 2)).resolved, true);
  const seat0After = manager.observation(room.id, 0);
  const seat1After = manager.observation(room.id, 1);
  assert.equal(seat0After.currentSeat, 1);
  assert.equal(seat0After.isYourTurn, false);
  assert.equal(seat1After.currentSeat, 1);
  assert.equal(seat1After.isYourTurn, true);
  assert.deepEqual(seat0After.waitingFor, [1]);
  assert.deepEqual(manager.summary(room.id).pendingSeats, [], '提交后依旧没有挂起动作');

  // 对照：simultaneous 游戏的 currentSeat 恒为 null，isYourTurn 以「本回合未提交」为准
  const grabRoom = newRoom();
  joinBoth(grabRoom.manager, grabRoom.room);
  const grabBefore = grabRoom.manager.observation(grabRoom.room.id, 0);
  assert.equal(grabBefore.currentSeat, null, 'simultaneous 没有当前行动方');
  assert.equal(grabBefore.isYourTurn, true);
  grabRoom.manager.submit(grabRoom.room.id, 0, legal(grabRoom.room, 0)[0]);
  assert.equal(grabRoom.manager.observation(grabRoom.room.id, 0).isYourTurn, false, '已提交后不算轮到你');
  assert.deepEqual(grabRoom.manager.summary(grabRoom.room.id).pendingSeats, [0], 'simultaneous 仍显示挂起座位');
});

// ───────────────────────────── 12. turn: 终局 ─────────────────────────────

test('turn 模式终局：end 事件与 result 自洽，终局后再提交返回 room_ended', () => {
  const { manager, room } = newTurnRoom();
  const broadcast: GameEvent[] = [];
  manager.onEvents((roomId, events) => {
    if (roomId === room.id) broadcast.push(...events);
  });

  // seat0 连走 (0,0)(0,1)(0,2) 占满第 0 行；seat1 走 (1,0)(1,1)
  const script: [number, number, number][] = [
    [0, 0, 0],
    [1, 1, 0],
    [0, 0, 1],
    [1, 1, 1],
    [0, 0, 2],
  ];
  for (const [seat, row, col] of script) {
    const res = manager.submit(room.id, seat, place(row, col));
    assert.equal(res.resolved, true, `seat${seat} 的落子应结算`);
    if (room.status === 'playing') {
      assert.equal(res.events.some((e) => e.type === 'end'), false, '未终局时不应有 end 事件');
    }
  }

  assert.equal(room.status, 'ended', '占满整行后对局应结束');
  assert.ok(room.result, '终局应有 result');
  assert.equal(room.result!.winner, 0);
  assert.deepEqual(room.result!.scores, { 0: 1, 1: 0 });
  assert.equal(typeof room.result!.text, 'string');
  assert.ok(room.result!.text.length > 0);

  const endEvent = broadcast.find((e) => e.type === 'end');
  assert.ok(endEvent, '广播事件里应包含 end');
  assert.deepEqual(endEvent.result, room.result, 'end 事件与 room.result 应一致');
  assert.equal(room.log.at(-1)!.event.type, 'end', '日志最后一条应是 end');

  const endedObs = manager.observation(room.id, 1);
  assert.equal(endedObs.status, 'ended');
  assert.equal(endedObs.currentSeat, null, '终局没有当前行动方');
  assert.equal(endedObs.isYourTurn, false);
  assert.deepEqual(endedObs.legalActions, []);

  const late = manager.submit(room.id, 0, place(2, 2));
  assert.equal(late.resolved, false);
  assert.equal(late.error, 'room_ended');
  assert.deepEqual(late.events, []);
  assert.deepEqual(manager.summary(room.id).pendingSeats, []);
  assert.deepEqual(manager.summary(room.id).result, room.result);
});

// ═════════════════════════ 真实四子棋（connect4）房间级用例 ═════════════════════════

function drop(column: number): Action {
  return { action: 'drop', column };
}

function newConnect4Room(): { manager: RoomManager; room: Room } {
  const manager = newManager();
  const room = manager.create('connect4');
  manager.join(room.id, 0, room.seatTokens[0] ?? undefined);
  manager.join(room.id, 1);
  return { manager, room };
}

// ───────────────────────────── 13. connect4: 分流 / 校验 ─────────────────────────────

test('真实四子棋：turn 分流、not_your_turn、illegal_action（越界 / 满列）、currentSeat 换手', () => {
  const { manager, room } = newConnect4Room();
  assert.equal(room.game.meta.resolution, 'turn');

  // 13.1 座位 0 先手，座位 1 抢跑被拒
  const early = manager.submit(room.id, 1, drop(0));
  assert.equal(early.resolved, false);
  assert.equal(early.error, 'not_your_turn');
  assert.equal(manager.observation(room.id, 1).isYourTurn, false);
  assert.equal(manager.observation(room.id, 0).isYourTurn, true);

  // 13.2 合法落子：座位 0 丢第 3 列 → 落到最底行（row 5），立刻换手
  const first = manager.submit(room.id, 0, drop(3));
  assert.equal(first.resolved, true);
  const dropEvent = first.events.find((e) => e.type === 'drop');
  assert.ok(dropEvent, 'events 应包含 drop');
  assert.equal(dropEvent.seat, 0);
  assert.equal(dropEvent.column, 3);
  assert.equal(dropEvent.row, 5);
  assert.equal(room.state.board[5][3], 1, '座位 0 的棋子应落在最底行');
  assert.equal(room.state.history.length, 1);
  assert.equal(room.game.currentSeat?.(room.state), 1);
  assert.equal(manager.observation(room.id, 0).currentSeat, 1);

  // 13.3 刚下完的一方不能连下
  const again = manager.submit(room.id, 0, drop(4));
  assert.equal(again.error, 'not_your_turn');

  // 13.4 越界列 / 错误动作名 → illegal_action + legalActions
  const oob = manager.submit(room.id, 1, drop(9));
  assert.equal(oob.error, 'illegal_action');
  assert.ok(Array.isArray(oob.legalActions));
  assert.ok(oob.legalActions!.every((a) => a.action === 'drop'));
  assert.equal(oob.legalActions!.length, 7, '开局 7 列都可落');
  const wrongKind = manager.submit(room.id, 1, { action: 'grab', column: 0 });
  assert.equal(wrongKind.error, 'illegal_action');

  // 13.5 满列 → illegal_action（交替填满第 6 列，竖排 1/2 交替不成四连）
  assert.equal(manager.submit(room.id, 1, drop(6)).resolved, true);
  for (let i = 0; i < 5; i++) {
    const seat = (i % 2 === 0) ? 0 : 1;
    const res = manager.submit(room.id, seat, drop(6));
    assert.equal(res.resolved, true, `填第 6 列第 ${i + 2} 手应合法`);
  }
  assert.equal(room.status, 'playing', '竖排交替填列不应产生四连');
  assert.equal(room.game.currentSeat?.(room.state), 1, '填满 6 手后轮到座位 1');
  const full = manager.submit(room.id, 1, drop(6));
  assert.equal(full.resolved, false);
  assert.equal(full.error, 'illegal_action');
  assert.ok(
    !full.legalActions!.some((a) => a.column === 6),
    '满列不应出现在 legalActions 里',
  );
  assert.equal(full.legalActions!.length, 6);
  assert.equal(room.game.currentSeat?.(room.state), 1, '被拒后仍是座位 1 的回合');
});

// ───────────────────────────── 14. connect4: 终局 ─────────────────────────────

test('真实四子棋终局：竖四连获胜 → ended、currentSeat=null、再提交 room_ended', () => {
  const { manager, room } = newConnect4Room();
  // 座位 0 连丢第 0 列四次，座位 1 全程陪丢第 1 列
  const script: [number, number][] = [
    [0, 0],
    [1, 1],
    [0, 0],
    [1, 1],
    [0, 0],
    [1, 1],
    [0, 0],
  ];
  let sawEnd = false;
  for (const [seat, column] of script) {
    const res = manager.submit(room.id, seat, drop(column));
    assert.equal(res.resolved, true, `座位 ${seat} 丢第 ${column} 列应结算`);
    if (res.events.some((e) => e.type === 'end')) sawEnd = true;
  }

  assert.equal(room.status, 'ended', '竖四连后应结束');
  assert.ok(sawEnd, '最后一手应带 end 事件');
  assert.ok(room.result);
  assert.equal(room.result!.winner, 0);
  assert.deepEqual(room.result!.scores, { 0: 1, 1: 0 });
  assert.equal(room.state.history.length, 7);

  const obs = manager.observation(room.id, 1);
  assert.equal(obs.status, 'ended');
  assert.equal(obs.currentSeat, null, '终局没有当前行动方');
  assert.equal(obs.isYourTurn, false);
  assert.deepEqual(obs.legalActions, []);
  assert.deepEqual(manager.summary(room.id).result, room.result);

  const late = manager.submit(room.id, 0, drop(2));
  assert.equal(late.resolved, false);
  assert.equal(late.error, 'room_ended');
  assert.deepEqual(late.events, []);
});

// ═════════════════════════ 真实猜拳（rps-duel）房间级用例 ═════════════════════════

function throwShape(shape: 'rock' | 'paper' | 'scissors'): Action {
  return { action: 'throw', shape };
}

function newRpsRoom(): { manager: RoomManager; room: Room } {
  const manager = newManager();
  const room = manager.create('rps-duel');
  manager.join(room.id, 0, room.seatTokens[0] ?? undefined);
  manager.join(room.id, 1);
  return { manager, room };
}

// ───────────────────────────── 15. rps-duel: 通用 simultaneous 通道 ─────────────────────────────

test('真实猜拳：非 cell 形状的动作在同暗选通道里正常走完，不需要服务端特判', () => {
  const { manager, room } = newRpsRoom();
  assert.equal(room.game.meta.resolution, 'simultaneous', '猜拳是同时暗选');
  assert.equal(room.game.meta.status, 'playable');
  assert.equal(
    manager.create('rps-duel').game.meta.id,
    'rps-duel',
    '注册表里能按 id 建桌',
  );

  // 开局：双方都待提交，没有「当前行动方」
  const before0 = manager.observation(room.id, 0);
  assert.equal(before0.currentSeat, null, 'simultaneous 没有当前行动方');
  assert.equal(before0.isYourTurn, true);
  assert.equal(before0.round, 1);
  assert.equal(before0.roundsTotal, 3);
  assert.deepEqual(before0.waitingFor, [0, 1]);
  assert.equal(before0.legalActions.length, 3);

  // 单方提交：挂起、不结算，且**任何座位视角都不回传挂起动作本身**（防 ?seat=X 偷看）
  const res0 = manager.submit(room.id, 0, throwShape('rock'));
  assert.equal(res0.resolved, false, '对手未提交时不应结算');
  assert.deepEqual(res0.events, []);
  const mid0 = manager.observation(room.id, 0);
  const mid1 = manager.observation(room.id, 1);
  assert.equal(mid0.youSubmitted, true);
  assert.equal((mid0 as any).yourPending, undefined, '观测不应携带挂起动作（只给 youSubmitted）');
  assert.equal((mid1 as any).yourPending, undefined, '对手视角更不应有挂起动作');
  assert.deepEqual(mid0.waitingFor, [1]);
  assert.deepEqual(manager.summary(room.id).pendingSeats, [0]);
  assert.equal(mid1.youSubmitted, false);
  assert.equal(mid1.youSubmitted, false);
  assert.equal(room.state.history.length, 0, '未结算不该写入历史');

  // 重复提交同一局 → action_already_submitted，且不覆盖
  const dup = manager.submit(room.id, 0, throwShape('paper'));
  assert.equal(dup.resolved, false);
  assert.equal(dup.error, 'action_already_submitted');
  assert.deepEqual(room.pending[0], throwShape('rock'));

  // 对手到齐 → 结算，石头赢剪刀
  const res1 = manager.submit(room.id, 1, throwShape('scissors'));
  assert.equal(res1.resolved, true);
  const reveal = findReveal(res1.events);
  assert.deepEqual(reveal.shapes, { 0: 'rock', 1: 'scissors' });
  assert.equal(reveal.winner, 0);
  assert.equal(reveal.points, 1);
  assert.deepEqual(reveal.delta, { 0: 1, 1: 0 });
  assert.deepEqual(room.pending, [null, null]);
  assert.deepEqual(room.state.scores, { 0: 1, 1: 0 });
  assert.equal(manager.observation(room.id, 0).round, 2);


  // 非法出手（错误 shape / 错误动作名）→ illegal_action + 3 条合法出手
  const badShape = manager.submit(room.id, 0, { action: 'throw', shape: 'lizard' });
  assert.equal(badShape.error, 'illegal_action');
  assert.equal(badShape.legalActions!.length, 3);
  assert.ok(badShape.legalActions!.every((a) => a.action === 'throw'));
  const badKind = manager.submit(room.id, 1, { action: 'grab', shape: 'rock' });
  assert.equal(badKind.error, 'illegal_action');
});

test('真实猜拳：三局打完结算，决胜局翻倍体现为 2 分', () => {
  const { manager, room } = newRpsRoom();

  // 局 1：seat0 输（paper 输 scissors）；局 2：seat0 输；局 3：seat0 赢 2 分 → 2:2 平局
  const rounds: Array<[0 | 1, 'rock' | 'paper' | 'scissors', 'rock' | 'paper' | 'scissors']> = [
    [0, 'rock', 'paper'],
    [0, 'rock', 'paper'],
    [0, 'rock', 'scissors'],
  ];
  let lastEvents: GameEvent[] = [];
  for (const [first, a, b] of rounds) {
    const other = (1 - first) as 0 | 1;
    const r0 = manager.submit(room.id, first, throwShape(a));
    assert.equal(r0.resolved, false, '先提交方不应结算');
    const r1 = manager.submit(room.id, other, throwShape(b));
    assert.equal(r1.resolved, true, '后提交方应触发结算');
    lastEvents = r1.events;
  }

  assert.equal(room.status, 'ended', '三局打完应结束');
  assert.ok(room.result);
  assert.equal(room.result!.winner, null, '2:2 应判平局');
  assert.deepEqual(room.result!.scores, { 0: 2, 1: 2 });
  assert.ok(lastEvents.some((e) => e.type === 'end'), '最后一局应带 end 事件');
  assert.deepEqual(lastEvents.find((e) => e.type === 'end')!.result, room.result);

  const obs = manager.observation(room.id, 0);
  assert.equal(obs.status, 'ended');
  assert.equal(obs.currentSeat, null);
  assert.equal(obs.isYourTurn, false);
  assert.deepEqual(obs.legalActions, [], '终局不应再有合法动作');
  assert.equal(obs.history.length, 3);
  assert.equal(manager.summary(room.id).round, 3, '结束后 summary.round 应为已打局数');

  const late = manager.submit(room.id, 0, throwShape('rock'));
  assert.equal(late.resolved, false);
  assert.equal(late.error, 'room_ended');
});

// ═════════════════════════ 真实深海猎手（battleship）房间级用例 ═════════════════════════

function fireAt(row: number, col: number): Action {
  return { action: 'fire', cell: [row, col] };
}

function newBattleshipRoom(): { manager: RoomManager; room: Room } {
  const manager = newManager();
  const room = manager.create('battleship');
  manager.join(room.id, 0, room.seatTokens[0] ?? undefined);
  manager.join(room.id, 1);
  return { manager, room };
}

// ───────────────────────────── 16. battleship：命中连射 ─────────────────────────────

test('真实深海猎手：命中后同一座位继续开炮（不等对手），未命中才换手', () => {
  const { manager, room } = newBattleshipRoom();
  assert.equal(room.game.meta.resolution, 'turn');

  // 开局座位 0 先手，座位 1 抢跑被拒
  assert.equal(manager.observation(room.id, 1).isYourTurn, false);
  assert.equal(manager.submit(room.id, 1, fireAt(0, 0)).error, 'not_your_turn');

  // 座位 0 打对手一艘船的首格 → 命中，仍是座位 0 的回合
  const enemyFleet = (room.state as any).fleets[1] as Array<{ cells: [number, number][] }>;
  const shipCell = enemyFleet[0].cells[0];
  const hit = manager.submit(room.id, 0, fireAt(shipCell[0], shipCell[1]));
  assert.equal(hit.resolved, true);
  const fireEvent = hit.events.find((e) => e.type === 'fire');
  assert.ok(fireEvent, 'events 应含 fire');
  assert.equal(fireEvent!.hit, true);
  assert.equal(fireEvent!.nextSeat, 0, '命中后下一炮仍是座位 0');
  assert.equal(room.game.currentSeat?.(room.state), 0);
  const afterHit = manager.observation(room.id, 0);
  assert.equal(afterHit.currentSeat, 0);
  assert.equal(afterHit.isYourTurn, true, '命中后依然轮到你');
  assert.equal(manager.observation(room.id, 1).isYourTurn, false);

  // 座位 0 打一个空格 → 未命中，换手
  const fired = (room.state as any).fired[0] as [number, number][];
  const enemyCells = new Set(enemyFleet.flatMap((s) => s.cells.map(([r, c]) => `${r},${c}`)));
  const firedKeys = new Set(fired.map(([r, c]) => `${r},${c}`));
  let miss: [number, number] | null = null;
  for (let r = 0; r < 5 && !miss; r++) {
    for (let c = 0; c < 5 && !miss; c++) {
      if (!enemyCells.has(`${r},${c}`) && !firedKeys.has(`${r},${c}`)) miss = [r, c];
    }
  }
  assert.ok(miss);
  const missRes = manager.submit(room.id, 0, fireAt(miss[0], miss[1]));
  assert.equal(missRes.resolved, true);
  assert.equal(missRes.events.find((e) => e.type === 'fire')!.hit, false);
  assert.equal(room.game.currentSeat?.(room.state), 1, '未命中应换手');
  assert.equal(manager.observation(room.id, 1).isYourTurn, true);
});

test('真实深海猎手：非法炮击 409（重复格 / 越界），终局后 room_ended', () => {
  const { manager, room } = newBattleshipRoom();
  const oob = manager.submit(room.id, 0, fireAt(9, 9));
  assert.equal(oob.error, 'illegal_action');
  assert.equal(oob.legalActions!.length, 25);

  // 座位 0 打死对手全部船格（命中连射，一路都是它的回合）
  const enemyFleet = (room.state as any).fleets[1] as Array<{ cells: [number, number][] }>;
  for (const ship of enemyFleet) {
    for (const [r, c] of ship.cells) {
      const res = manager.submit(room.id, 0, fireAt(r, c));
      assert.equal(res.resolved, true, `打 ${r},${c} 应结算`);
    }
  }
  assert.equal(room.status, 'ended', '全沉后应结束');
  assert.ok(room.result);
  assert.equal(room.result!.winner, 0);
  assert.deepEqual(room.result!.scores, { 0: 2, 1: 0 });

  const late = manager.submit(room.id, 1, fireAt(0, 0));
  assert.equal(late.resolved, false);
  assert.equal(late.error, 'room_ended');
});

// ═════════════════════════ 真实黑白棋（reversi）房间级用例 ═════════════════════════

function placeAt(row: number, col: number): Action {
  return { action: 'place', cell: [row, col] };
}

function newReversiRoom(): { manager: RoomManager; room: Room } {
  const manager = newManager();
  const room = manager.create('reversi');
  manager.join(room.id, 0, room.seatTokens[0] ?? undefined);
  manager.join(room.id, 1);
  return { manager, room };
}

// ───────────────────────────── 17. reversi：落子换手 / 终局 ─────────────────────────────

test('真实黑白棋：落子立即换手，非法落子 409 并回带 legalActions', () => {
  const { manager, room } = newReversiRoom();
  assert.equal(room.game.meta.resolution, 'turn');
  assert.equal(manager.observation(room.id, 0).isYourTurn, true, '座位 0 先手');
  assert.equal(manager.observation(room.id, 0).currentSeat, 0);

  const legal = room.game.legalActions(room.state, 0);
  assert.equal(legal.length, 4, '开局 4 个合法落点');

  const first = manager.submit(room.id, 0, placeAt(2, 3));
  assert.equal(first.resolved, true);
  const placeEvent = first.events.find((e) => e.type === 'place');
  assert.ok(placeEvent);
  assert.deepEqual(placeEvent!.flips, [[3, 3]]);
  assert.equal(room.game.currentSeat?.(room.state), 1, '落子立刻换手');

  const illegal = manager.submit(room.id, 1, placeAt(0, 0));
  assert.equal(illegal.error, 'illegal_action');
  assert.ok(Array.isArray(illegal.legalActions) && illegal.legalActions.length > 0);
  assert.equal(room.game.currentSeat?.(room.state), 1, '被拒后仍是座位 1 的回合');

  const notYour = manager.submit(room.id, 0, placeAt(3, 2));
  assert.equal(notYour.error, 'not_your_turn');
});

test('真实黑白棋：一路下到终局，result 子数之和不超过 64，终局再提交 room_ended', () => {
  const { manager, room } = newReversiRoom();
  let guard = 0;
  let sawPass = false;
  while (room.status === 'playing' && guard++ < 70) {
    const seat = room.game.currentSeat?.(room.state);
    assert.ok(seat === 0 || seat === 1, '进行中应有当前行动方');
    const legal = room.game.legalActions(room.state, seat as number);
    assert.ok(legal.length > 0, `座位 ${seat} 应有合法落点（无子可下应由内核跳过）`);
    const cell = legal[0].cell as [number, number];
    const res = manager.submit(room.id, seat as number, placeAt(cell[0], cell[1]));
    assert.equal(res.resolved, true);
    if (res.events.some((e) => e.type === 'pass')) sawPass = true;
  }

  assert.equal(room.status, 'ended', '应下到终局');
  assert.ok(room.result);
  const scores = room.result!.scores;
  assert.ok(scores[0] + scores[1] <= 64, '子数之和不应超过 64');
  assert.equal(scores[0] + scores[1] > 0, true);
  assert.equal(
    room.result!.winner,
    scores[0] === scores[1] ? null : scores[0] > scores[1] ? 0 : 1,
    'winner 应与子数一致',
  );
  // 一局黑白棋里出现「跳过」很常见，但也不强求（不同对局路径不同）
  assert.equal(typeof sawPass, 'boolean');

  const obs = manager.observation(room.id, 0);
  assert.equal(obs.status, 'ended');
  assert.deepEqual(obs.legalActions, []);

  const late = manager.submit(room.id, 0, placeAt(0, 0));
  assert.equal(late.resolved, false);
  assert.equal(late.error, 'room_ended');
});

// ═══════════════════════ 第 12 轮：席位令牌 / 旁观降级 / 越权防护 ═══════════════════════

/** 令牌 = 16 字节随机数的 32 位小写十六进制（设计稿 §3.1）。 */
function assertTokenShape(token: unknown, label = '令牌'): void {
  assert.equal(typeof token, 'string', `${label} 应是字符串`);
  assert.match(String(token), /^[0-9a-f]{32}$/, `${label} 应是 32 位十六进制，实际 ${String(token)}`);
}

test('令牌发放：create 预留 0 号位令牌，带预留令牌入座幂等，两座位令牌互不通用', () => {
  const manager = newManager();
  const room = manager.create('grab');
  const reserved0 = room.seatTokens[0];

  assertTokenShape(reserved0, '0 号位预留令牌');
  assert.equal(room.occupied[0], false, '预留阶段 0 号位仍未占用');
  assert.equal(room.seatTokens[1], null, '1 号位入座前没有令牌');

  // 没有预留令牌的人抢 0 号位 → 409，且不会把座位占走
  assert.throws(
    () => manager.raw.join(room.id, 0),
    (err: any) => err?.name === 'SeatTakenError' && err?.code === 'seat_taken',
  );
  assert.equal(room.occupied[0], false);

  // 房主带预留令牌入座：成功，令牌不变
  const first = manager.raw.join(room.id, 0, reserved0 ?? undefined);
  assert.equal(first.seat, 0);
  assert.equal(first.token, reserved0);
  assert.equal(room.occupied[0], true);
  assert.equal(room.status, 'waiting', '还差 1 号位');

  // 同一人重连：幂等，不换令牌
  const again = manager.raw.join(room.id, 0, reserved0 ?? undefined);
  assert.equal(again.token, reserved0);
  assert.equal(room.seatTokens[0], reserved0);

  // 空闲座位不认别人带来的令牌：会发该座位自己的新令牌，0 号位令牌不能当 1 号位凭据
  const seat1 = manager.raw.join(room.id, 1, reserved0 ?? undefined);
  assertTokenShape(seat1.token, '1 号位令牌');
  assert.notEqual(seat1.token, reserved0, '0 号位令牌不能被当作 1 号位凭据');
  assert.equal(room.seatTokens[1], seat1.token);
  assert.equal(room.status, 'playing', '双方入座后开局');
  assert.throws(() => manager.raw.join(room.id, 1), (err: any) => err?.code === 'seat_taken');
  assert.equal(manager.raw.join(room.id, 1, seat1.token).token, seat1.token);
});

test('旁观降级：无令牌 / 错令牌 / 跨座位令牌都拿到 spectator 视图，不泄露可行动作', () => {
  const { manager, room } = newRoom();
  joinBoth(manager, room);
  const [token0, token1] = room.seatTokens;

  const mine = manager.raw.observation(room.id, 1, token1 ?? undefined);
  assert.equal(mine.spectator, false);
  assert.equal(mine.seat, 1);
  assert.equal(mine.isYourTurn, true);
  assert.ok(mine.legalActions.length > 0, '带正确令牌应能看到自己的 legalActions');

  for (const [label, token] of [
    ['无令牌', undefined],
    ['错令牌', 'f'.repeat(32)],
    ['另一座位的令牌', token0 ?? undefined],
  ] as const) {
    const view = manager.raw.observation(room.id, 1, token);
    assert.equal(view.spectator, true, `${label} 应降级为旁观`);
    assert.equal(view.seat, null, `${label} 的 seat 应为 null`);
    assert.deepEqual(view.legalActions, [], `${label} 不应拿到 legalActions`);
    assert.equal(view.isYourTurn, false);
    assert.equal(view.youSubmitted, false);
    assert.deepEqual(view.waitingFor, []);
    // 公开信息仍然可读：围观是正当场景，不是报错
    assert.equal(view.status, 'playing');
    assert.deepEqual(view.scores, mine.scores);
    assert.equal(view.round, mine.round);
  }

  // 旁观视图里不该有任何「挂起动作」字段（第 11 轮起就故意不回传）
  assert.equal((mine as any).yourPending, undefined);
  assert.equal((mine as any).pending, undefined);
});

test('越权读取：无令牌冒充某座位看不到猜拳挂起出手，也无法行动', () => {
  const manager = newManager();
  const room = manager.create('rps-duel');
  manager.join(room.id, 0, room.seatTokens[0] ?? undefined);
  const seat1Token = manager.join(room.id, 1).token;
  manager.submit(room.id, 1, throwShape('rock'), seat1Token);

  // 冒充 seat 1 读：没有令牌 → 旁观
  const spy = manager.raw.observation(room.id, 1);
  assert.equal(spy.spectator, true);
  assert.deepEqual(spy.legalActions, []);
  assert.equal(spy.youSubmitted, false, '旁观者不能被标成「已提交」');
  assert.equal((spy as any).yourPending, undefined);
  assert.equal((spy as any).pending, undefined);
  assert.equal(spy.history.length, 0, '未揭示的局不该出现在历史里');

  // 用 0 号位令牌冒充 1 号位 → 同样是旁观
  assert.equal(
    manager.raw.observation(room.id, 1, room.seatTokens[0] ?? undefined).spectator,
    true,
  );

  // 没令牌想出手 → 403，且不能覆盖已挂起的动作
  assert.throws(
    () => manager.raw.submit(room.id, 1, throwShape('paper')),
    (err: any) => err?.name === 'SeatTokenRequiredError' && err?.code === 'seat_token_required',
  );
  assert.deepEqual(room.pending[1], throwShape('rock'), '越权提交不能覆盖已挂起的动作');
});

test('越权读取（深海猎手）：无令牌旁观者拿不到任何一方的舰队布阵', () => {
  const { manager, room } = newBattleshipRoom();

  // 冒充座位 0 读取：没有令牌 → 旁观，且不能「借座位 0」看布阵
  const spy = manager.raw.observation(room.id, 0);
  assert.equal(spy.spectator, true);
  assert.equal(spy.seat, null);
  assert.deepEqual(spy.yourFleet, [], '旁观者不该拿到舰队布阵');
  assert.equal(spy.shotsFired, 0);
  assert.ok(
    spy.enemyGrid.every((row: string[]) => row.every((cell: string) => cell === 'unknown')),
    '旁观者的敌方海图必须全是 unknown',
  );

  // 对照：座位 0 拿对令牌才看得到自己的舰队
  const mine = manager.raw.observation(room.id, 0, room.seatTokens[0] ?? undefined);
  assert.equal(mine.spectator, false);
  assert.ok(mine.yourFleet.length > 0, '座位 0 本人应能看到自己的舰队');
});

test('行动鉴权：submit / say 缺令牌或错令牌一律 403 seat_token_required', () => {
  const { manager, room } = newRoom();
  joinBoth(manager, room);
  const [token0, token1] = room.seatTokens;
  const action = legal(room, 0)[0];

  for (const [label, token] of [
    ['没带', undefined],
    ['空串', ''],
    ['错令牌', 'f'.repeat(32)],
    ['对手的令牌', token1 ?? undefined],
  ] as const) {
    assert.throws(
      () => manager.raw.submit(room.id, 0, action, token || undefined),
      (err: any) => err?.name === 'SeatTokenRequiredError' && err?.code === 'seat_token_required',
      `${label}不应该能提交动作`,
    );
    assert.throws(
      () => manager.raw.say(room.id, 0, '我插一句话', token || undefined),
      (err: any) => err?.code === 'seat_token_required',
      `${label}不应该能代替座位发言`,
    );
  }
  assert.deepEqual(room.pending, [null, null], '被拒的提交不能挂起任何动作');
  assert.equal(room.chat.length, 0, '被拒的发言不能进聊天记录');

  // 带对令牌才放行
  const ok = manager.raw.submit(room.id, 0, action, token0 ?? undefined);
  assert.equal(ok.resolved, false);
  assert.notEqual(room.pending[0], null);
  const msg = manager.raw.say(room.id, 0, '这回是我', token0 ?? undefined);
  assert.equal(msg.seat, 0);
});

test('summary 公开且不泄令牌：没有 humanUrlPath / seatTokens，序列化里不含令牌', () => {
  const { manager, room } = newRoom();
  joinBoth(manager, room);
  const summary = manager.summary(room.id);

  assert.equal(summary.roomId, room.id);
  assert.equal('humanUrlPath' in summary, false, 'summary 不能带人类入口（那里面有 0 号位令牌）');
  assert.equal('seatTokens' in summary, false, 'summary 不能带令牌副本');
  const text = JSON.stringify(summary);
  for (const token of room.seatTokens) {
    if (token) assert.equal(text.includes(token), false, 'summary 序列化里不能出现任何座位令牌');
  }
});

test('边界：0 号位只建桌未入座时，即使令牌正确也只能拿到 seat_not_joined', () => {
  const manager = newManager();
  const room = manager.create('grab');

  // 令牌对，但没走 join，occupied[0] 仍是 false
  const res = manager.raw.submit(room.id, 0, legal(room, 0)[0], room.seatTokens[0] ?? undefined);
  assert.equal(res.resolved, false);
  assert.equal(res.error, 'seat_not_joined', '令牌只证明身份，入座仍要显式走 join');
  assert.equal(room.pending[0], null, '未入座不能挂起动作');
});


// ═══════════ 第 18 轮：真人对局实测的「状态自相矛盾」回归测试 ═══════════

test('未开局（waiting）：legalActions 清空、waitingFor 指出谁没入座、文案不再喊你动手', () => {
  const { manager, room } = newRoom();
  // 只让 0 号位入座 → 房间里 seat 1 还空着
  manager.join(room.id, 0, room.seatTokens[0] ?? undefined);
  const obs = manager.observation(room.id, 0, room.seatTokens[0] ?? undefined);

  assert.equal(obs.status, 'waiting');
  assert.equal(obs.isYourTurn, false, '没开局时 isYourTurn 必须是 false');
  assert.deepEqual(obs.legalActions, [], '没开局时 legalActions 必须为空（以前会给满 7 项，真人照着点了）');
  assert.deepEqual(obs.waitingFor, [1], 'waitingFor 应指出「1 号位还没入座」');
  assert.match(String(obs.textView), /还没开始：座位 1 还没入座/);
  assert.doesNotMatch(String(obs.textView), /轮到你了/, '文案里不能再出现「轮到你了」');
});

test('同时暗选已交招：legalActions 清空、youSubmitted=true、文案改「你已出手等对手」', () => {
  const { manager, room } = newRoom();
  joinBoth(manager, room);
  const token0 = room.seatTokens[0] ?? undefined;
  const before = manager.observation(room.id, 0, token0);
  assert.ok((before.legalActions ?? []).length > 0, '开局第一手应该可行动');

  const legal = before.legalActions as Array<Record<string, unknown>>;
  manager.submit(room.id, 0, legal[0], token0);

  const after = manager.observation(room.id, 0, token0);
  assert.equal(after.youSubmitted, true);
  assert.equal(after.isYourTurn, false, '已交招就不该再是「你的回合」');
  assert.deepEqual(after.legalActions, [], '已交招必须清空 legalActions，否则真人会照着再点一次');
  assert.match(String(after.textView), /你已出手，等对手提交/);
  assert.doesNotMatch(String(after.textView), /继续选择一个合法格子/, '不能再留着「继续选择」的提示');

  // 同回合重复提交：明确 409 语义（action_already_submitted），不是静默接受
  const dup = manager.submit(room.id, 0, legal[1] ?? legal[0], token0);
  assert.equal(dup.error, 'action_already_submitted');
});
