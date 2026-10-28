import assert from 'node:assert/strict';
import { test } from 'node:test';
import { grab, ROUNDS_TOTAL, SIZE, type GrabState } from '../src/games/grab.ts';

function cells(state: GrabState) {
  return state.grid.flat();
}

test('setup: 3x3 棋盘，6 金币 + 1 炸弹 + 2 空格', () => {
  const state = grab.setup(42);
  const flat = cells(state);
  assert.equal(flat.length, SIZE * SIZE);
  assert.equal(flat.filter((c) => c !== null && c.k === 'coin').length, 6);
  assert.equal(flat.filter((c) => c !== null && c.k === 'bomb').length, 1);
  assert.equal(flat.filter((c) => c !== null && c.k === 'empty').length, 2);
  const values = flat
    .filter((c) => c !== null && c.k === 'coin')
    .map((c) => (c !== null && c.k === 'coin' ? c.v : 0))
    .sort();
  assert.deepEqual(values, [1, 1, 2, 2, 3, 3]);
});

test('setup: 同种子可复现，不同种子不同', () => {
  const a = JSON.stringify(grab.setup(7).grid);
  const b = JSON.stringify(grab.setup(7).grid);
  assert.equal(a, b);
  const grids = new Set<string>();
  for (let seed = 0; seed < 20; seed++) grids.add(JSON.stringify(grab.setup(seed).grid));
  assert.ok(grids.size > 1, '不同种子应产生不同布阵');
});

test('legalActions: 初始 9 个动作，格式为 [row,col]', () => {
  const state = grab.setup(1);
  const acts = grab.legalActions(state, 0);
  assert.equal(acts.length, 9);
  for (const a of acts) {
    assert.equal(a.action, 'grab');
    const cell = a.cell as [number, number];
    assert.ok(cell[0] >= 0 && cell[0] < SIZE);
    assert.ok(cell[1] >= 0 && cell[1] < SIZE);
  }
});

test('同时选不同格：金币加分、炸弹扣 2 分、空格无事', () => {
  // 构造固定棋盘便于断言
  const state: GrabState = {
    grid: [
      [{ k: 'coin', v: 3 }, { k: 'bomb' }, { k: 'coin', v: 1 }],
      [{ k: 'empty' }, { k: 'coin', v: 2 }, { k: 'coin', v: 1 }],
      [{ k: 'empty' }, { k: 'coin', v: 3 }, { k: 'coin', v: 2 }],
    ],
    scores: { 0: 0, 1: 0 },
    round: 1,
    history: [],
  };
  const { state: next, events } = grab.step(state, {
    0: { action: 'grab', cell: [0, 0] }, // 金币 3
    1: { action: 'grab', cell: [0, 1] }, // 炸弹
  });
  assert.equal(next.scores[0], 3);
  assert.equal(next.scores[1], -2);
  assert.equal(next.grid[0][0], null);
  assert.equal(next.grid[0][1], null);
  const reveal = events.find((e) => e.type === 'reveal');
  assert.ok(reveal);
  assert.equal(reveal!.collision, false);
});

test('同时选同一格：撞车，双方都拿不到（炸弹也不扣分）', () => {
  const state: GrabState = {
    grid: [
      [{ k: 'bomb' }, { k: 'coin', v: 2 }, null],
      [null, null, null],
      [null, null, null],
    ],
    scores: { 0: 5, 1: 5 },
    round: 2,
    history: [],
  };
  const { state: next, events } = grab.step(state, {
    0: { action: 'grab', cell: [0, 0] },
    1: { action: 'grab', cell: [0, 0] },
  });
  assert.deepEqual(next.scores, { 0: 5, 1: 5 });
  assert.equal(next.grid[0][0], null, '撞车格子应消失');
  assert.equal(events[0].collision, true);
});

test('9 回合内结束，结束后 legalActions 为空，result 正确', () => {
  let state = grab.setup(99);
  let guard = 0;
  while (!grab.isTerminal(state) && guard++ < 20) {
    const acts = grab.legalActions(state, 0);
    const cellA = acts[0].cell as [number, number];
    const cellB = acts[acts.length - 1].cell as [number, number];
    state = grab.step(state, {
      0: { action: 'grab', cell: cellA },
      1: { action: 'grab', cell: cellB },
    }).state;
  }
  assert.ok(grab.isTerminal(state));
  assert.ok(state.history.length <= ROUNDS_TOTAL);
  const obs = grab.observe(state, 0);
  assert.equal(obs.status, 'ended');
  assert.equal(obs.legalActions.length, 0);
  const result = grab.result(state);
  assert.ok(result.text.length > 0);
});

test('observe: 双方看到的公开信息一致，且带 textView', () => {
  const state = grab.setup(5);
  const o0 = grab.observe(state, 0);
  const o1 = grab.observe(state, 1);
  assert.deepEqual(o0.grid, o1.grid);
  assert.equal(o0.yourScore, 0);
  assert.equal(o1.yourScore, 0);
  assert.ok(String(o0.textView).includes('第 1/9 回合'));
});

test('金币抢完即结束：剩余空格/炸弹不再进行，且结束态文案正确', () => {
  const state: GrabState = {
    grid: [
      [{ k: 'coin', v: 3 }, { k: 'empty' }, null],
      [{ k: 'bomb' }, null, null],
      [null, null, null],
    ],
    scores: { 0: 0, 1: 0 },
    round: 3,
    history: [],
  };
  const { state: next, events } = grab.step(state, {
    0: { action: 'grab', cell: [0, 0] },
    1: { action: 'grab', cell: [0, 1] },
  });
  assert.equal(next.scores[0], 3);
  assert.ok(grab.isTerminal(next), '金币抢完应立即结束');
  assert.ok(events.some((e) => e.type === 'end'));

  const obs = grab.observe(next, 0);
  assert.equal(obs.status, 'ended');
  assert.equal(obs.legalActions.length, 0);
  assert.equal(obs.round, 1, '结束时应显示已进行回合数');
  const view = String(obs.textView);
  assert.match(view, /对局已结束/);
  assert.match(view, /座位 0 获胜/);
  assert.match(view, /第 1\/9 回合/);
});
