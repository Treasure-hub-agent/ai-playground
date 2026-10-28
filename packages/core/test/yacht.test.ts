import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Action, GameEvent } from '../src/types.ts';
import {
  CATEGORIES,
  DICE_COUNT,
  LOWER_CATEGORIES,
  MAX_ROLLS,
  YACHT_ROUNDS_TOTAL,
  UPPER_BONUS,
  UPPER_CATEGORIES,
  UPPER_TARGET,
  emptyCard,
  filledCount,
  isCategory,
  isTerminalState,
  previewScoresOf,
  scoreCategory,
  summarizeCard,
  yacht,
  type Card,
  type Category,
  type Scorecard,
  type YachtState,
} from '../src/games/yacht.ts';
import { games, getGame, getGameMeta, listGameMeta } from '../src/index.ts';
import { plannedGames } from '../src/catalog.ts';

type ActionResult = { state: YachtState; events: GameEvent[] };

/** 轮流制工具：只给当前行动方传动作，模拟服务端 turn 模式对 step 的调用方式。 */
function act(state: YachtState, action: Action): ActionResult {
  return yacht.step(state, { [state.turn]: action });
}

const roll = (state: YachtState): ActionResult => act(state, { action: 'roll' });
const hold = (state: YachtState, indices: number[]): ActionResult =>
  act(state, { action: 'hold', indices });
const score = (state: YachtState, category: Category): ActionResult =>
  act(state, { action: 'score', category });

/** 手工搭一个局面（测奖励/终局等边界，不用等随机骰凑出来）。 */
function forced(overrides: Partial<YachtState>): YachtState {
  return { ...yacht.setup(2026), ...overrides };
}

/** 13 格全部 null，再按 entries 填指定格。 */
function cardOf(entries: Partial<Record<Category, number>>): Card {
  const card = emptyCard();
  for (const category of CATEGORIES) {
    const value = entries[category];
    card[category] = value === undefined ? null : value;
  }
  return card;
}

/** 上区刚好 63 的合法记分表（3+6+9+12+15+18）。 */
function upperCard(ones: number): Card {
  return cardOf({ ones, twos: 6, threes: 9, fours: 12, fives: 15, sixes: 18 });
}

/** 13 格全部记满（没指定的格记 0 分）。 */
function fullCard(entries: Partial<Record<Category, number>> = {}): Card {
  const card = emptyCard();
  for (const category of CATEGORIES) card[category] = entries[category] ?? 0;
  return card;
}

/** 打满一局：每手掷 1 次（不锁定），然后选第一个还没用过的栏目记分。 */
function playFullGame(seed: number): { state: YachtState; events: GameEvent[]; rounds: number[] } {
  let state = yacht.setup(seed);
  const events: GameEvent[] = [];
  const rounds: number[] = [];
  while (!yacht.isTerminal(state)) {
    rounds.push(yacht.observe(state, state.turn).round);
    const rolled = roll(state);
    state = rolled.state;
    events.push(...rolled.events);
    const category = CATEGORIES.find((c) => state.cards[state.turn][c] === null)!;
    const scored = score(state, category);
    state = scored.state;
    events.push(...scored.events);
  }
  return { state, events, rounds };
}

test('setup: 5 颗骰未掷、rollsLeft=3、phase=roll、座位 0 先手、共 26 手', () => {
  const state = yacht.setup(7);
  assert.equal(DICE_COUNT, 5);
  assert.equal(MAX_ROLLS, 3);
  assert.equal(YACHT_ROUNDS_TOTAL, 26);
  assert.equal(UPPER_TARGET, 63);
  assert.equal(UPPER_BONUS, 35);
  assert.equal(CATEGORIES.length, 13);
  assert.equal(UPPER_CATEGORIES.length, 6);
  assert.equal(LOWER_CATEGORIES.length, 7);

  assert.deepEqual(state.dice, [0, 0, 0, 0, 0]);
  assert.deepEqual(state.held, [false, false, false, false, false]);
  assert.equal(state.rollsLeft, 3);
  assert.equal(state.phase, 'roll');
  assert.equal(state.turn, 0);
  assert.equal(state.draws, 0);
  assert.deepEqual(state.history, []);
  for (const seat of [0, 1] as const) {
    assert.ok(CATEGORIES.every((c) => state.cards[seat][c] === null), '开局 13 格都应未记分');
    assert.equal(filledCount(state.cards[seat]), 0);
    assert.equal(isTerminalState(state), false);
  }

  // 局面结构与 seed 无关，只有 seed 字段不同（骰子序列由 seed 决定）
  const a = yacht.setup(1);
  const b = yacht.setup(2);
  assert.deepEqual({ ...a, seed: 0 }, { ...b, seed: 0 });

  const obs = yacht.observe(state, 0);
  assert.equal(obs.round, 1);
  assert.equal(obs.roundsTotal, 26);
  assert.equal(obs.status, 'playing');
  assert.equal(obs.currentSeat, 0);
  assert.equal(obs.isYourTurn, true);
  assert.deepEqual(obs.scores, { 0: 0, 1: 0 });
  assert.equal(obs.phase, 'roll');
  assert.equal(obs.rollsLeft, 3);
  assert.equal(obs.upperTarget, 63);
  assert.equal(obs.upperBonusValue, 35);
  assert.equal(obs.scorecards[0].total, 0);
  assert.equal(obs.scorecards[1].upperBonus, 0);
});

test('上区 6 格：只累计该点数之和，没掷出该点数记 0', () => {
  const dice = [1, 1, 2, 3, 4];
  assert.equal(scoreCategory(dice, 'ones'), 2);
  assert.equal(scoreCategory(dice, 'twos'), 2);
  assert.equal(scoreCategory(dice, 'threes'), 3);
  assert.equal(scoreCategory(dice, 'fours'), 4);
  assert.equal(scoreCategory(dice, 'fives'), 0);
  assert.equal(scoreCategory(dice, 'sixes'), 0);
  assert.equal(scoreCategory([6, 6, 6, 1, 2], 'sixes'), 18);
  assert.equal(scoreCategory([5, 5, 5, 5, 5], 'fives'), 25);
});

test('三条 / 四条：够数记五骰总和，不够记 0（≥ 语义，5 同点也算）', () => {
  assert.equal(scoreCategory([4, 4, 4, 2, 1], 'three_kind'), 15);
  assert.equal(scoreCategory([4, 4, 2, 2, 1], 'three_kind'), 0);
  assert.equal(scoreCategory([5, 5, 5, 5, 2], 'four_kind'), 22);
  assert.equal(scoreCategory([5, 5, 5, 2, 1], 'four_kind'), 0);
  // 5 颗同点同时满足三条 / 四条 / 快艇
  assert.equal(scoreCategory([6, 6, 6, 6, 6], 'three_kind'), 30);
  assert.equal(scoreCategory([6, 6, 6, 6, 6], 'four_kind'), 30);
});

test('葫芦：恰好 3+2 才算 25，4+1 与 5 同点都是 0', () => {
  assert.equal(scoreCategory([3, 3, 3, 5, 5], 'full_house'), 25);
  assert.equal(scoreCategory([6, 6, 2, 2, 2], 'full_house'), 25);
  assert.equal(scoreCategory([4, 4, 4, 4, 2], 'full_house'), 0);
  assert.equal(scoreCategory([4, 4, 4, 4, 4], 'full_house'), 0);
  assert.equal(scoreCategory([1, 2, 3, 4, 5], 'full_house'), 0);
});

test('小顺 4 连 = 30、大顺 5 连 = 40；按点数集合判定，大顺同时满足小顺', () => {
  assert.equal(scoreCategory([1, 2, 3, 4, 6], 'small_straight'), 30);
  assert.equal(scoreCategory([2, 3, 4, 5, 6], 'small_straight'), 30);
  assert.equal(scoreCategory([1, 2, 3, 5, 6], 'small_straight'), 0);
  assert.equal(scoreCategory([1, 2, 3, 4, 5], 'large_straight'), 40);
  assert.equal(scoreCategory([2, 3, 4, 5, 6], 'large_straight'), 40);
  assert.equal(scoreCategory([1, 2, 3, 4, 6], 'large_straight'), 0);
  // 5 颗骰子最多 5 个不同点数，「6 连」不可能出现，大顺也不额外叠加
  assert.equal(scoreCategory([1, 2, 3, 4, 5], 'small_straight'), 30);
  assert.equal(scoreCategory([1, 2, 3, 4, 5], 'chance'), 15);
});

test('快艇 5 同点 = 50，全骰 = 五骰求和', () => {
  assert.equal(scoreCategory([2, 2, 2, 2, 2], 'yacht'), 50);
  assert.equal(scoreCategory([2, 2, 2, 2, 3], 'yacht'), 0);
  assert.equal(scoreCategory([6, 6, 6, 6, 6], 'yacht'), 50);
  assert.equal(scoreCategory([1, 2, 3, 4, 5], 'chance'), 15);
  assert.equal(scoreCategory([6, 6, 6, 6, 6], 'chance'), 30);
  assert.equal(scoreCategory([1, 1, 1, 1, 1], 'chance'), 5);
});

test('previewScoresOf 一次给出全 13 键', () => {
  const preview = previewScoresOf([1, 2, 3, 4, 5]);
  assert.deepEqual(Object.keys(preview).sort(), [...CATEGORIES].sort());
  assert.equal(preview.ones, 1);
  assert.equal(preview.fives, 5);
  assert.equal(preview.three_kind, 0);
  assert.equal(preview.small_straight, 30);
  assert.equal(preview.large_straight, 40);
  assert.equal(preview.yacht, 0);
  assert.equal(preview.chance, 15);
});

test('掷骰：只重掷未锁定的骰，rollsLeft 递减、phase 变 choice，事件字段齐全', () => {
  const start = yacht.setup(2024);
  const first = roll(start);
  const afterFirst = first.state;
  assert.equal(afterFirst.rollsLeft, 2);
  assert.equal(afterFirst.phase, 'choice');
  assert.equal(afterFirst.draws, 5);
  assert.equal(first.events.length, 1);
  assert.deepEqual(first.events[0], {
    type: 'roll',
    seat: 0,
    dice: afterFirst.dice,
    held: [false, false, false, false, false],
    rollsLeft: 2,
  });
  assert.ok(afterFirst.dice.every((d) => d >= 1 && d <= 6), '骰子必须是 1-6');
  // 纯函数：旧 state 不被改写
  assert.deepEqual(start.dice, [0, 0, 0, 0, 0]);
  assert.equal(start.rollsLeft, 3);
  assert.equal(start.draws, 0);

  const beforeSecond = afterFirst.dice.slice();
  const heldResult = hold(afterFirst, [0, 2]);
  assert.deepEqual(heldResult.state.held, [true, false, true, false, false]);
  assert.deepEqual(heldResult.events[0], {
    type: 'hold',
    seat: 0,
    held: [true, false, true, false, false],
  });

  const second = roll(heldResult.state);
  assert.equal(second.state.dice[0], beforeSecond[0], '锁定的骰必须保持不变');
  assert.equal(second.state.dice[2], beforeSecond[2], '锁定的骰必须保持不变');
  assert.equal(second.state.rollsLeft, 1);
  assert.equal(second.state.phase, 'choice');
  assert.equal(second.state.draws, 5 + 3, '只重掷 3 颗未锁定的骰，只消耗 3 个随机数');
  assert.deepEqual(second.state.held, [true, false, true, false, false], '锁定状态跨重掷保留');
});

test('全部锁定时再掷：骰面完全不变，但 rollsLeft 照样递减', () => {
  let state = roll(yacht.setup(99)).state;
  state = hold(state, [0, 1, 2, 3, 4]).state;
  state = hold(state, [0, 1, 2, 3, 4]).state; // 再切换一次 → 全解锁
  assert.deepEqual(state.held, [false, false, false, false, false]);
  state = hold(state, [0, 1, 2, 3, 4]).state;
  const dice = state.dice.slice();
  const draws = state.draws;
  const again = roll(state);
  assert.deepEqual(again.state.dice, dice);
  assert.equal(again.state.draws, draws, '全部锁定时不消耗随机数');
  assert.equal(again.state.rollsLeft, 1);
});

test('3 次掷骰用完 → phase=must_score，legalActions 只剩 score，roll/hold 被拒', () => {
  let state = yacht.setup(555);
  state = roll(state).state;
  state = roll(state).state;
  state = roll(state).state;
  assert.equal(state.rollsLeft, 0);
  assert.equal(state.phase, 'must_score');

  const legal = yacht.legalActions(state, 0);
  assert.equal(legal.filter((a) => a.action === 'roll').length, 0, 'must_score 不能再掷骰');
  assert.equal(legal.filter((a) => a.action === 'hold').length, 0, 'must_score 不能再锁定');
  assert.equal(legal.filter((a) => a.action === 'score').length, 13);

  assert.throws(() => roll(state), /只能记分/);
  assert.throws(() => hold(state, [0]), /只能记分/);
  // 但记分可以
  const scored = score(state, 'chance');
  assert.equal(scored.state.turn, 1);
  assert.equal(scored.state.phase, 'roll');
});

test('未掷骰不能锁定/记分；hold 下标越界、动作类型错误都报中文错误', () => {
  const state = yacht.setup(9);
  assert.throws(() => hold(state, [0]), /还没掷骰/);
  assert.throws(() => score(state, 'ones'), /还没掷骰/);
  // phase=roll 时 legalActions 只有 roll，不枚举 hold / score
  assert.deepEqual(yacht.legalActions(state, 0), [{ action: 'roll' }]);

  const rolled = roll(state).state;
  assert.throws(() => hold(rolled, [5]), /0-4/);
  assert.throws(() => hold(rolled, [-1]), /0-4/);
  assert.throws(() => hold(rolled, [1.5]), /0-4/);
  assert.throws(() => act(rolled, { action: 'hold' }), /indices 数组/);
  assert.throws(() => act(rolled, { action: 'nope' }), /动作类型必须是 roll/);
  assert.throws(() => act(rolled, { action: 'score', category: 'yahtzee' }), /13 个栏目之一/);
});

test('legalActions 按 phase 生成，且只有轮到你时非空', () => {
  const state = yacht.setup(31);
  assert.deepEqual(yacht.legalActions(state, 0), [{ action: 'roll' }]);
  assert.deepEqual(yacht.legalActions(state, 1), [], '不是你的回合必须返回空数组');
  assert.deepEqual(yacht.observe(state, 1).legalActions, []);
  assert.equal(yacht.observe(state, 1).isYourTurn, false);
  assert.equal(yacht.observe(state, 1).currentSeat, 0);
  assert.equal(yacht.currentSeat?.(state), 0);

  const rolled = roll(state).state;
  const legal = yacht.legalActions(rolled, 0);
  assert.deepEqual(legal[0], { action: 'roll' });
  assert.equal(legal.filter((a) => a.action === 'hold').length, DICE_COUNT + 1);
  assert.deepEqual(
    legal.filter((a) => a.action === 'score').map((a) => a.category),
    [...CATEGORIES],
  );
});

test('记分后立刻换手：dice 归零、held 清空、rollsLeft=3、phase=roll；事件字段齐全', () => {
  const rolled = roll(yacht.setup(77)).state;
  const before = rolled.dice.slice();
  const expectedSum = before.reduce((a, b) => a + b, 0);
  const result = score(rolled, 'chance');
  const next = result.state;

  assert.equal(result.events.length, 1);
  const scoreEvent = result.events[0];
  assert.equal(scoreEvent.type, 'score');
  assert.equal(scoreEvent.seat, 0);
  assert.equal(scoreEvent.category, 'chance');
  assert.equal(scoreEvent.gained, expectedSum);
  assert.equal(scoreEvent.nextSeat, 1);
  const card = scoreEvent.scorecard as Scorecard;
  assert.equal(card.chance, expectedSum);
  assert.equal(card.total, expectedSum);

  assert.equal(next.turn, 1);
  assert.deepEqual(next.dice, [0, 0, 0, 0, 0]);
  assert.deepEqual(next.held, [false, false, false, false, false]);
  assert.equal(next.rollsLeft, 3);
  assert.equal(next.phase, 'roll');
  assert.equal(next.cards[0].chance, expectedSum);
  assert.equal(next.cards[1].chance, null);
  assert.deepEqual(next.history, [
    { seat: 0, category: 'chance', gained: expectedSum, dice: before },
  ]);
  // 换手后轮到座位 1；座位 0 不再有动作
  assert.equal(yacht.observe(next, 1).isYourTurn, true);
  assert.equal(yacht.observe(next, 1).currentSeat, 1);
  assert.deepEqual(yacht.legalActions(next, 0), []);
  assert.equal(yacht.currentSeat?.(next), 1);
});

test('已用栏目不能再用：previewScores 为 null、legalActions 不再枚举、step 报错', () => {
  let state = score(roll(yacht.setup(88)).state, 'chance').state; // 座位 0 用掉 chance
  state = score(roll(state).state, 'chance').state; // 座位 1 用掉 chance
  const rolled = roll(state).state;

  const legal = yacht.legalActions(rolled, 0);
  assert.equal(legal.filter((a) => a.action === 'score').length, 12);
  assert.ok(!legal.some((a) => a.action === 'score' && a.category === 'chance'));

  const obs = yacht.observe(rolled, 0);
  assert.equal(obs.previewScores.chance, null, '已用格必须是 null（不是 0）');
  assert.equal(typeof obs.scorecards[0].chance, 'number');
  assert.ok((obs.scorecards[0].chance as number) > 0);
  assert.throws(() => score(rolled, 'chance'), /已经记过分/);
});

test('previewScores 与真实记分、scorecard 完全一致', () => {
  let state = yacht.setup(31337);
  state = roll(state).state;
  state = roll(hold(state, [1, 3]).state).state;
  const obs = yacht.observe(state, 0);
  for (const category of CATEGORIES) {
    const previewed = obs.previewScores[category];
    assert.equal(previewed, scoreCategory(state.dice, category), `${category} 预览分应与判定函数一致`);
    const trial = score(state, category);
    assert.equal(trial.events[0].gained, previewed, `${category} 实际记分应与预览一致`);
    assert.equal((trial.events[0].scorecard as Scorecard)[category], previewed);
  }
  // 未掷骰、或不是你的回合 → previewScores 全 null
  assert.ok(CATEGORIES.every((c) => yacht.observe(yacht.setup(1), 0).previewScores[c] === null));
  assert.ok(CATEGORIES.every((c) => yacht.observe(state, 1).previewScores[c] === null));
});

test('observe 返回深拷贝：改观测不污染内核状态', () => {
  const state = roll(yacht.setup(5)).state;
  const obs = yacht.observe(state, 0);
  obs.dice[0] = 99;
  obs.held[1] = true;
  obs.scorecards[0].ones = 999;
  obs.previewScores.chance = 999;
  obs.history.push({ seat: 1, category: 'ones', gained: 0, dice: [] });
  assert.notEqual(state.dice[0], 99);
  assert.equal(state.held[1], false);
  assert.equal(state.cards[0].ones, null);
  assert.equal(state.cards[0].chance, null);
  assert.equal(state.history.length, 0);
});

test('上区 63 → +35 奖励，只加一次；上区 <63 无奖励', () => {
  const at63 = summarizeCard(upperCard(3));
  assert.equal(at63.upperSubtotal, 63);
  assert.equal(at63.upperBonus, UPPER_BONUS);
  assert.equal(at63.total, 98);

  const below = summarizeCard(upperCard(0));
  assert.equal(below.upperSubtotal, 60);
  assert.equal(below.upperBonus, 0);
  assert.equal(below.total, 60);

  // 下区分数加上去，奖励仍只有一次 35
  const withLower = summarizeCard({ ...upperCard(3), chance: 20 });
  assert.equal(withLower.upperBonus, UPPER_BONUS);
  assert.equal(withLower.total, 63 + 35 + 20);

  // 从观测里也能读到奖励与总分
  const state = forced({ cards: { 0: { ...upperCard(3), chance: 20 }, 1: emptyCard() } });
  const obs = yacht.observe(state, 0);
  assert.equal(obs.scorecards[0].upperSubtotal, 63);
  assert.equal(obs.scorecards[0].upperBonus, 35);
  assert.equal(obs.scorecards[0].total, 118);
  assert.deepEqual(obs.scores, { 0: 118, 1: 0 });
});

test('终局：双方 13 格填满后 isTerminal、winner 按总分、end 事件带结果', () => {
  const card1 = fullCard({ chance: 20 });
  card1.ones = null; // 座位 1 只差「一点」这一格
  let state = forced({
    dice: [6, 6, 6, 6, 6],
    rollsLeft: 0,
    phase: 'must_score',
    turn: 1,
    cards: { 0: fullCard({ chance: 5 }), 1: card1 },
  });
  assert.equal(isTerminalState(state), false, '座位 1 还差一格');

  const result = score(state, 'ones'); // 骰面上没有 1 点 → 记 0 分
  state = result.state;
  assert.equal(result.events[0].gained, 0);
  assert.equal(result.events[0].nextSeat, null, '终局后没有下一个行动方');
  assert.equal(result.events.length, 2);
  assert.equal(result.events[1].type, 'end');
  assert.deepEqual(result.events[1].result, {
    winner: 1,
    scores: { 0: 5, 1: 20 },
    text: '座位 1 获胜！5 : 20。',
  });
  assert.ok(isTerminalState(state));
  assert.equal(yacht.isTerminal(state), true);
  assert.equal(yacht.currentSeat?.(state), null);
  assert.deepEqual(yacht.legalActions(state, 1), []);
  for (const seat of [0, 1] as const) {
    const obs = yacht.observe(state, seat);
    assert.equal(obs.status, 'ended');
    assert.equal(obs.currentSeat, null);
    assert.equal(obs.isYourTurn, false);
    assert.deepEqual(obs.legalActions, []);
    assert.equal(obs.round, 26);
  }
  assert.throws(() => roll(state), /对局已结束/);
});

test('终局同分 → winner=null，文案是平局', () => {
  const card1 = fullCard({ chance: 20 });
  card1.ones = null; // 只差一格
  const state = forced({
    dice: [2, 2, 2, 2, 2],
    rollsLeft: 1,
    phase: 'choice',
    turn: 1,
    cards: { 0: fullCard({ chance: 20 }), 1: card1 },
  });
  const result = score(state, 'ones'); // 0 分 → 双方都是 20
  const end = result.events[result.events.length - 1];
  assert.equal(end.type, 'end');
  const summary = end.result as { winner: number | null; scores: Record<string, number>; text: string };
  assert.equal(summary.winner, null);
  assert.deepEqual(summary.scores, { 0: 20, 1: 20 });
  assert.match(summary.text, /平局/);
  assert.equal(yacht.result(result.state).winner, null);
});

test('打满一局：26 手、round 递增、每格各用一次、终局 total 与 13 格合计一致', () => {
  const { state, events, rounds } = playFullGame(20261026);
  assert.equal(rounds.length, 26);
  assert.deepEqual(
    rounds,
    Array.from({ length: 26 }, (_, i) => i + 1),
  );
  assert.ok(isTerminalState(state));
  assert.equal(state.history.length, 26);
  for (const seat of [0, 1] as const) {
    assert.equal(filledCount(state.cards[seat]), 13);
    const card = state.cards[seat];
    assert.ok(CATEGORIES.every((c) => card[c] !== null), `座位 ${seat} 的 13 格都应已记分`);
    const summary = summarizeCard(card);
    const faceSum = CATEGORIES.reduce((sum, c) => sum + (card[c] ?? 0), 0);
    assert.equal(
      summary.total,
      faceSum + summary.upperBonus,
      '总分 = 13 格合计 + 上区奖励',
    );
    assert.equal(summary.upperBonus, summary.upperSubtotal >= 63 ? 35 : 0);
  }
  const summary = yacht.result(state);
  assert.equal(summary.scores[0], summarizeCard(state.cards[0]).total);
  assert.equal(summary.scores[1], summarizeCard(state.cards[1]).total);
  assert.equal(summary.winner, summary.scores[0] === summary.scores[1] ? null : summary.scores[0] > summary.scores[1] ? 0 : 1);

  // 事件：26 次 roll + 26 次 score + 最后一手 1 次 end
  assert.equal(events.filter((e) => e.type === 'roll').length, 26);
  assert.equal(events.filter((e) => e.type === 'score').length, 26);
  assert.equal(events.filter((e) => e.type === 'end').length, 1);
  assert.equal(events[events.length - 1].type, 'end');

  const obs = yacht.observe(state, 0);
  assert.equal(obs.round, 26);
  assert.equal(obs.roundsTotal, 26);
  assert.equal(obs.status, 'ended');
  assert.match(String(obs.textView), /对局已结束/);
});

test('同 seed 同掷骰序列（可回放），不同 seed 序列不同', () => {
  const a = playFullGame(4242);
  const b = playFullGame(4242);
  const c = playFullGame(4243);
  const rollDice = (events: GameEvent[]): string[] =>
    events.filter((e) => e.type === 'roll').map((e) => (e.dice as number[]).join(','));

  assert.deepEqual(rollDice(a.events), rollDice(b.events));
  assert.deepEqual(a.state.cards, b.state.cards);
  assert.deepEqual(a.state.history, b.state.history);
  assert.deepEqual(
    a.events.map((e) => e.type),
    b.events.map((e) => e.type),
  );
  assert.notDeepEqual(rollDice(a.events), rollDice(c.events), '不同 seed 的骰子序列应不同');
});

test('textView 能让纯文本 Agent 直接决策：骰面/锁定标记/剩余次数/13 格预览/已记/上区进度/总分', () => {
  let state = roll(yacht.setup(600)).state;
  state = hold(state, [2]).state;
  const text = String(yacht.observe(state, 0).textView);

  assert.match(text, /快艇骰子 · 第 1\/26 手 · 剩 2 次掷骰 · 轮到你了/);
  assert.ok(text.includes(`[${state.dice[2]}*]`), '锁定的骰子要用 * 标记');
  assert.match(text, /（\* = 已锁定）/);
  for (const label of ['一点', '二点', '三点', '四点', '五点', '六点', '三条', '四条', '葫芦', '小顺', '大顺', '快艇', '全骰']) {
    assert.ok(text.includes(label), `textView 应列出栏目 ${label}`);
  }
  assert.match(text, /上区小计 0\/63，奖励 0/);
  assert.match(text, /总分: 你 0 · 对手 0/);
  assert.match(text, /可执行: \{"action":"roll"\}/);
  // 预览值要和 previewScores 对得上
  const obs = yacht.observe(state, 0);
  assert.ok(text.includes(`全骰=${obs.previewScores.chance}`));

  // 未掷骰时提示先掷
  assert.match(String(yacht.observe(yacht.setup(1), 0).textView), /还没掷骰/);
  // 不是你的回合时告诉你等对方
  assert.match(String(yacht.observe(state, 1).textView), /现在轮到座位 0/);
});

test('轮流制：缺当前行动方动作报错，对手座位的动作被忽略', () => {
  const state = roll(yacht.setup(3)).state;
  assert.throws(() => yacht.step(state, { 1: { action: 'roll' } }), /缺少当前行动方的动作/);
  const mixed = yacht.step(state, {
    0: { action: 'hold', indices: [0] },
    1: { action: 'roll' },
  });
  assert.deepEqual(mixed.state.held, [true, false, false, false, false]);
  assert.deepEqual(mixed.state.dice, state.dice, '座位 1 的动作必须被忽略');
  assert.equal(mixed.events.length, 1);
  assert.equal(mixed.events[0].seat, 0);
});

test('注册表：yacht 可玩、目录不重复、路线图占位已移除', () => {
  assert.equal(games.yacht, yacht);
  assert.equal(getGame('yacht'), yacht);

  const meta = getGameMeta('yacht');
  assert.ok(meta, 'getGameMeta 应能找到快艇骰子');
  assert.equal(meta!.id, 'yacht');
  assert.equal(meta!.name, '快艇骰子');
  assert.equal(meta!.tagline, '五颗骰子三次机会，凑牌型、比总分');
  assert.equal(meta!.seats, 2);
  assert.equal(meta!.status, 'playable', '界面已接入注册表，status 必须回到 playable');
  assert.equal(meta!.resolution, 'turn');
  assert.equal(meta!.category, '骰子');
  assert.deepEqual(meta!.tags, ['运气', '记分策略', '中局']);
  assert.equal(meta!.duration, '3–5 分钟');
  assert.equal(meta!.accent, '#b4622f');
  assert.match(meta!.rules, /快艇骰子/);
  assert.match(meta!.rules, /previewScores/);

  // 大厅目录里恰好出现一次（占位已删，不会重复）
  assert.equal(listGameMeta().filter((m) => m.id === 'yacht').length, 1);
  assert.ok(!plannedGames.some((m) => m.id === 'yacht'));
  // 原有游戏不受影响
  assert.equal(listGameMeta().filter((m) => m.id === 'grab').length, 1);
  assert.equal(listGameMeta().filter((m) => m.id === 'connect4').length, 1);
  assert.ok(isCategory('yacht') && !isCategory('yahtzee'));
  assert.equal(emptyCard().ones, null);
});
