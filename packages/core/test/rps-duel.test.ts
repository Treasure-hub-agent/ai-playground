import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ROUND_POINTS,
  RPS_ROUNDS_TOTAL,
  SHAPES,
  compareShapes,
  rpsDuel,
  type RpsState,
  type Shape,
} from '../src/games/rps-duel.ts';

function throwAction(shape: Shape) {
  return { action: 'throw', shape };
}

/** 打一局：seat0 出 a、seat1 出 b。 */
function playRound(state: RpsState, a: Shape, b: Shape) {
  return rpsDuel.step(state, { 0: throwAction(a), 1: throwAction(b) }).state;
}

test('setup: 0:0、第 1 局、无历史，且不含随机因素', () => {
  const a = rpsDuel.setup(1);
  const b = rpsDuel.setup(999);
  assert.deepEqual(a.scores, { 0: 0, 1: 0 });
  assert.equal(a.round, 1);
  assert.deepEqual(a.history, []);
  // 猜拳没有随机性：不同 seed 的初始局面必须一致
  assert.deepEqual(a, b);
});

test('legalActions: 三种出手，形状正确；终局后为空', () => {
  const state = rpsDuel.setup(0);
  const acts = rpsDuel.legalActions(state, 0);
  assert.equal(acts.length, 3);
  assert.deepEqual(
    acts.map((x) => x.shape),
    ['rock', 'paper', 'scissors'],
  );
  for (const a of acts) assert.equal(a.action, 'throw');
  // 双方看到的合法动作一致
  assert.deepEqual(rpsDuel.legalActions(state, 1), acts);

  let ended = state;
  for (let i = 0; i < RPS_ROUNDS_TOTAL; i++) ended = playRound(ended, 'rock', 'rock');
  assert.ok(rpsDuel.isTerminal(ended));
  assert.deepEqual(rpsDuel.legalActions(ended, 0), []);
});

test('compareShapes: 9 种组合全对（石头>剪刀>布>石头）', () => {
  const table: Record<string, number> = {
    'rock-rock': 0,
    'paper-paper': 0,
    'scissors-scissors': 0,
    'rock-scissors': 1,
    'scissors-rock': -1,
    'paper-rock': 1,
    'rock-paper': -1,
    'scissors-paper': 1,
    'paper-scissors': -1,
  };
  for (const [key, expected] of Object.entries(table)) {
    const [a, b] = key.split('-') as [Shape, Shape];
    assert.equal(compareShapes(a, b), expected, key);
  }
});

test('第 1 局：胜者 +1，本局分值 1', () => {
  const { state, events } = rpsDuel.step(rpsDuel.setup(0), {
    0: throwAction('rock'),
    1: throwAction('scissors'),
  });
  assert.deepEqual(state.scores, { 0: 1, 1: 0 });
  const reveal = events.find((e) => e.type === 'reveal');
  assert.ok(reveal);
  assert.equal(reveal!.winner, 0);
  assert.equal(reveal!.points, 1);
  assert.deepEqual(reveal!.shapes, { 0: 'rock', 1: 'scissors' });
});

test('同出手：本局 0:0，双方都不得分，但该局照常消耗', () => {
  const { state, events } = rpsDuel.step(rpsDuel.setup(0), {
    0: throwAction('paper'),
    1: throwAction('paper'),
  });
  assert.deepEqual(state.scores, { 0: 0, 1: 0 });
  assert.equal(state.round, 2, '平局也要消耗一局');
  assert.equal(state.history.length, 1);
  const reveal = events.find((e) => e.type === 'reveal');
  assert.equal(reveal!.winner, null);
  assert.deepEqual(reveal!.delta, { 0: 0, 1: 0 });
});

test('决胜局（第 3 局）赢下得 2 分', () => {
  let state = rpsDuel.setup(0);
  state = playRound(state, 'rock', 'paper'); // 局 1 输 → 0:1
  state = playRound(state, 'rock', 'paper'); // 局 2 输 → 0:2
  assert.deepEqual(state.scores, { 0: 0, 1: 2 });
  state = playRound(state, 'rock', 'scissors'); // 局 3 赢 +2 → 2:2
  assert.deepEqual(state.scores, { 0: 2, 1: 2 });
  assert.equal(state.history[2].points, 2);
});

test('三局结束即终局；全胜时总分 4:0', () => {
  let state = rpsDuel.setup(0);
  state = playRound(state, 'rock', 'scissors');
  state = playRound(state, 'paper', 'rock');
  assert.equal(rpsDuel.isTerminal(state), false, '两局后还没结束');
  state = playRound(state, 'scissors', 'paper');
  assert.ok(rpsDuel.isTerminal(state));
  assert.deepEqual(state.scores, { 0: 4, 1: 0 });
  const result = rpsDuel.result(state);
  assert.equal(result.winner, 0);
  assert.match(result.text, /座位 0 获胜！4 : 0/);
});

test('平局路径：0:2 落后靠决胜局翻盘 = 2:2 平局', () => {
  let state = rpsDuel.setup(0);
  state = playRound(state, 'rock', 'paper');
  state = playRound(state, 'rock', 'paper');
  state = playRound(state, 'rock', 'scissors');
  const result = rpsDuel.result(state);
  assert.equal(result.winner, null, '2:2 应该判平局');
  assert.match(result.text, /平局！2 : 2/);
  assert.equal(rpsDuel.observe(state, 0).status, 'ended');
});

test('平局也可以一路到底：三局全平 = 0:0', () => {
  let state = rpsDuel.setup(0);
  for (let i = 0; i < RPS_ROUNDS_TOTAL; i++) state = playRound(state, 'scissors', 'scissors');
  assert.ok(rpsDuel.isTerminal(state));
  assert.deepEqual(state.scores, { 0: 0, 1: 0 });
  assert.equal(rpsDuel.result(state).winner, null);
});

test('observe 遮蔽：结算前不泄露任何出手，历史为空', () => {
  const state = rpsDuel.setup(0);
  const obs = rpsDuel.observe(state, 0);
  assert.deepEqual(obs.history, []);
  assert.equal(obs.lastRound, null);
  // legalActions / textView 里出现 rock/paper/scissors 是「合法选项」，不是对手出手；
  // 真正的遮蔽点是 history / lastRound 必须为空。
  assert.equal(JSON.stringify(obs.history), '[]');
  assert.equal(JSON.stringify(obs.lastRound), 'null');
  // 只打了一局后，第 2 局仍未结算，历史里只有第 1 局
  const mid = playRound(state, 'rock', 'paper');
  assert.equal(rpsDuel.observe(mid, 0).history.length, 1);
  assert.equal(rpsDuel.observe(mid, 0).round, 2);
});

test('observe: 历史是座位相对视角，双方各看各的', () => {
  const state = playRound(rpsDuel.setup(0), 'rock', 'scissors');
  const o0 = rpsDuel.observe(state, 0);
  const o1 = rpsDuel.observe(state, 1);
  assert.equal(o0.history[0].yourShape, 'rock');
  assert.equal(o0.history[0].opponentShape, 'scissors');
  assert.equal(o0.history[0].outcome, 'win');
  assert.equal(o1.history[0].yourShape, 'scissors');
  assert.equal(o1.history[0].opponentShape, 'rock');
  assert.equal(o1.history[0].outcome, 'lose');
  assert.equal(o0.yourScore, 1);
  assert.equal(o1.yourScore, 0);
  assert.equal(o0.scores[0], o1.scores[0], '公共比分应一致');
});

test('observe: 回合号与分值不越界（结束后是 3/3 而非 4/3）', () => {
  let state = rpsDuel.setup(0);
  state = playRound(state, 'rock', 'paper');
  state = playRound(state, 'paper', 'rock');
  let obs = rpsDuel.observe(state, 0);
  assert.equal(obs.round, 3);
  assert.equal(obs.roundsTotal, 3);
  assert.equal(obs.currentRoundPoints, 2, '第 3 局应提示翻倍');
  state = playRound(state, 'rock', 'paper');
  obs = rpsDuel.observe(state, 0);
  assert.equal(obs.round, 3, '结束后应显示已打局数');
  assert.equal(obs.currentRoundPoints, null);
  assert.ok(String(obs.textView).includes('三局已打完'));
});

test('第 3 局 textView 会标出「决胜局，赢下得 2 分」', () => {
  let state = rpsDuel.setup(0);
  state = playRound(state, 'rock', 'paper');
  state = playRound(state, 'rock', 'paper');
  const view = String(rpsDuel.observe(state, 0).textView);
  assert.match(view, /第 3\/3 局（决胜局，赢下得 2 分）/);
});

test('非法出手被拒绝（score/空/错误词）', () => {
  const state = rpsDuel.setup(0);
  for (const bad of ['', 'ROCK', 'lizard', null, undefined]) {
    assert.throws(
      () => rpsDuel.step(state, { 0: { action: 'throw', shape: bad }, 1: throwAction('rock') }),
      /非法出手/,
      `shape=${String(bad)} 应被拒绝`,
    );
  }
});

test('meta: 可开桌、同时暗选、附加分值表一致', () => {
  assert.equal(rpsDuel.meta.id, 'rps-duel');
  assert.equal(rpsDuel.meta.status, 'playable');
  assert.equal(rpsDuel.meta.resolution, 'simultaneous');
  assert.equal(rpsDuel.meta.seats, 2);
  assert.deepEqual([...ROUND_POINTS], [1, 1, 2]);
  assert.equal(ROUND_POINTS.reduce((a, b) => a + b, 0), 4);
  assert.deepEqual([...SHAPES], ['rock', 'paper', 'scissors']);
  assert.match(rpsDuel.meta.rules, /决胜局/);
});
