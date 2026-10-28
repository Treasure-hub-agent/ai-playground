/**
 * 第 12 轮「席位鉴权」：旁观视图（seat = null）的契约测试。
 *
 * 为什么单独一个文件：这组用例横跨六款游戏，验的是同一条跨包契约——
 * 没有座位令牌的人只能看到公开信息、legalActions 恒空、textView 不能出现「你 / 对手」。
 * 放在一起可以一眼看完「旁观到底能看什么」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEA_SIZE, battleship } from '../src/games/battleship.ts';
import { connect4 } from '../src/games/connect4.ts';
import { grab, type GrabState } from '../src/games/grab.ts';
import { reversi } from '../src/games/reversi.ts';
import { rpsDuel } from '../src/games/rps-duel.ts';
import { yacht, CATEGORIES } from '../src/games/yacht.ts';

/**
 * 旁观文案里不允许出现的座位相对称呼。
 * 「你 / 对手」会让读 textView 的纯文本 Agent 误以为自己坐了一边，
 * 「我方 / 敌方」则是深海猎手旧文案里会带出布阵的措辞。
 */
const SEAT_RELATIVE_WORDS = ['你', '对手', '我方', '敌方'];

function assertNeutralText(view: string, gameId: string): void {
  for (const word of SEAT_RELATIVE_WORDS) {
    assert.ok(
      !view.includes(word),
      `${gameId} 的旁观 textView 不应出现「${word}」，实际：\n${view}`,
    );
  }
}

test('旁观视图（grab）：seat=null、legalActions 为空、座位相对字段按座位 0、文案中性', () => {
  const state = grab.setup(3);
  const obs = grab.observe(state, null);
  assert.equal(obs.seat, null);
  assert.deepEqual(obs.legalActions, [], '旁观者不能抢格子');
  // 座位 0 此刻本来有 9 个合法动作，旁观必须是 0
  assert.ok(grab.observe(state, 0).legalActions.length > 0, '座位 0 视角应有合法动作（对照）');
  assert.equal(obs.yourScore, state.scores[0], '座位相对分数按座位 0 呈现');
  assert.equal(obs.opponentScore, state.scores[1]);
  const view = String(obs.textView);
  assert.match(view, /旁观视图/);
  assert.match(view, /座位 0 0 分/, '旁观没有「你」的分数，只有座位 0 / 座位 1');
  assertNeutralText(view, 'grab');
});

test('旁观观测（grab）：不带未揭示的落点信息', () => {
  const state = grab.setup(11);
  const opening = grab.observe(state, null);
  const openingHistory = opening.history as GrabState['history'];
  assert.equal(openingHistory.length, 0, '开局没有已结算回合，history 必须为空');
  // 本回合的暗选只存在服务端 room.pending 里；内核观测绝不该出现这类字段
  for (const key of ['pending', 'pendingActions', 'picks', 'pendingPicks']) {
    assert.equal(key in opening, false, `旁观观测不应出现 ${key} 字段`);
  }

  // 结算一回合后：落点已经是公开信息（reveal 事件同源），才允许出现在旁观视图
  const settled = grab.step(state, {
    0: { action: 'grab', cell: [0, 0] },
    1: { action: 'grab', cell: [2, 2] },
  }).state;
  const revealed = grab.observe(settled, null);
  assert.equal(revealed.seat, null);
  assert.deepEqual(revealed.legalActions, []);
  const revealedHistory = revealed.history as GrabState['history'];
  assert.equal(revealedHistory.length, 1, '只有已揭示的回合进 history');
  assert.deepEqual(revealedHistory[0].picks, { 0: [0, 0], 1: [2, 2] });
  assert.equal(revealedHistory[0].collision, false);
  // 旁观不是「另一个偷看视角」：公开字段必须与座位 0 完全一致
  assert.deepEqual(revealed.grid, grab.observe(settled, 0).grid);
  assert.deepEqual(revealed.scores, grab.observe(settled, 0).scores);
});

test('旁观视图（connect4）：seat=null、legalActions 为空、isYourTurn=false、文案中性', () => {
  const state = connect4.setup(1);
  const obs = connect4.observe(state, null);
  assert.equal(obs.seat, null);
  assert.deepEqual(obs.legalActions, [], '旁观者不能落子');
  assert.equal(obs.isYourTurn, false);
  assert.equal(obs.currentSeat, 0, '当前行动方是公开信息，旁观也应看得到');
  const view = String(obs.textView);
  assert.match(view, /旁观视图/);
  assert.match(view, /座位 0 执 X/, '旁观用绝对符号命名双方棋子');
  assert.match(view, /现在轮到座位 0 落子/);
  assertNeutralText(view, 'connect4');
});

test('旁观视图（rps-duel）：seat=null、legalActions 为空、历史按座位 0 视角、文案中性', () => {
  // 打一局再旁观，顺便验证「已揭示的历史」在旁观视角下也对得上座位 0
  const settled = rpsDuel.step(rpsDuel.setup(0), {
    0: { action: 'throw', shape: 'rock' },
    1: { action: 'throw', shape: 'paper' },
  }).state;
  const obs = rpsDuel.observe(settled, null);
  assert.equal(obs.seat, null);
  assert.deepEqual(obs.legalActions, [], '旁观者不能出拳');
  assert.equal(obs.yourScore, settled.scores[0]);
  assert.equal(obs.opponentScore, settled.scores[1]);
  assert.equal(obs.history.length, 1);
  assert.equal(obs.history[0].yourShape, 'rock', '座位相对历史按座位 0 呈现');
  assert.equal(obs.history[0].opponentShape, 'paper');
  assert.equal(obs.history[0].outcome, 'lose');
  const view = String(obs.textView);
  assert.match(view, /旁观视图/);
  assert.match(view, /座位 0 石头 vs 座位 1 布/);
  assertNeutralText(view, 'rps-duel');
});

test('旁观视图（yacht）：seat=null、legalActions 为空、previewScores 全为 null', () => {
  // 先掷一次骰，让座位 0 有真实的「记分预览」；旁观必须拿不到这份私有辅助
  const rolled = yacht.step(yacht.setup(9), { 0: { action: 'roll' } }).state;
  const seat0 = yacht.observe(rolled, 0);
  assert.ok(
    Object.values(seat0.previewScores).some((value) => value !== null),
    '座位 0 掷骰后应有记分预览（对照）',
  );

  const obs = yacht.observe(rolled, null);
  assert.equal(obs.seat, null);
  assert.deepEqual(obs.legalActions, [], '旁观者不能掷骰 / 记分');
  assert.equal(obs.isYourTurn, false);
  assert.ok(
    Object.values(obs.previewScores).every((value) => value === null),
    '旁观者不该拿到任何栏目的记分预览',
  );
  // 骰面与双方记分表是公开信息，保留
  assert.deepEqual(obs.dice, rolled.dice);
  assert.deepEqual(obs.scorecards, seat0.scorecards);
  const view = String(obs.textView);
  assert.match(view, /旁观视图/);
  assert.match(view, /座位 0 已记/);
  assert.doesNotMatch(view, /可记分/, '旁观视图不展示记分预览');
  assertNeutralText(view, 'yacht');
});

test('旁观视图（reversi）：seat=null、legalActions 为空、isYourTurn=false、文案中性', () => {
  const state = reversi.setup(0);
  const obs = reversi.observe(state, null);
  assert.equal(obs.seat, null);
  assert.deepEqual(obs.legalActions, [], '旁观者不能落子');
  assert.equal(obs.isYourTurn, false);
  assert.equal(obs.currentSeat, 0);
  assert.equal(obs.yourDiscs, 2, '座位相对子数按座位 0 呈现');
  assert.equal(obs.opponentDiscs, 2);
  const view = String(obs.textView);
  assert.match(view, /旁观视图/);
  assert.match(view, /● = 座位 0/);
  assert.doesNotMatch(view, /轮到你落子/, '旁观视图不给「轮到你」提示');
  assertNeutralText(view, 'reversi');
});

test('旁观视图（battleship）：seat=null、不可行动、剩余舰船数按座位 0 视角', () => {
  const state = battleship.setup(29);
  const obs = battleship.observe(state, null);
  assert.equal(obs.seat, null);
  assert.deepEqual(obs.legalActions, [], '旁观者不能开炮');
  assert.equal(obs.isYourTurn, false);
  assert.equal(obs.currentSeat, 0, '该谁开炮是公开信息');
  assert.deepEqual(obs.scores, { 0: 2, 1: 2 }, '剩余舰船数是公开信息');
  assert.equal(obs.yourShipsLeft, 2);
  assert.equal(obs.enemyShipsLeft, 2);
  assert.equal(obs.shotsFired, 0);
  const view = String(obs.textView);
  assert.match(view, /旁观视图/);
  assert.match(view, /座位 0 剩 2 艘/);
  assert.match(view, /现在轮到座位 0 开炮/);
  assertNeutralText(view, 'battleship');
});

test('旁观观测（battleship）：不泄露任何一方的舰队布阵', () => {
  const state = battleship.setup(23);
  const obs = battleship.observe(state, null);
  assert.deepEqual(obs.yourFleet, [], '旁观者的 yourFleet 必须为空数组');
  // 连船名与船格结构都不能出现：旁观拿到的是「没有舰队」的视图，而不是座位 0 的舰队。
  const json = JSON.stringify(obs);
  for (const name of ['驱逐舰', '潜艇']) {
    assert.ok(!json.includes(name), `旁观观测不应出现船名「${name}」`);
  }
  assert.ok(!json.includes('"cells"'), '旁观观测不应出现 cells 字段');
  // textView 也不能画「我方海域」（那是座位 0 的布阵原样）
  const view = String(obs.textView);
  assert.doesNotMatch(view, /我方海域/);
  assert.ok(!view.includes('●'), '旁观视图不应出现「完好船格」符号');
  // 对照：座位 0 视角本来能看到自己的两艘船，说明上面不是「所有视角都空」的假绿
  assert.equal(battleship.observe(state, 0).yourFleet.length, 2);
});

test('旁观观测（battleship）：enemyGrid 全部 unknown，即便已经开过炮', () => {
  const state = battleship.setup(31);
  // 打一炮再旁观：落点/命中会公开，但海域图对旁观者仍应是全 unknown
  const fired = battleship.step(state, { 0: { action: 'fire', cell: [0, 0] } }).state;
  const obs = battleship.observe(fired, null);
  assert.equal(obs.enemyGrid.length, SEA_SIZE);
  assert.ok(
    obs.enemyGrid.every((row) => row.length === SEA_SIZE && row.every((cell) => cell === 'unknown')),
    '旁观者的敌方格必须是全 unknown，只有公开战况图能看落点',
  );
  assert.equal(obs.shotsFired, 0, '旁观者没开过炮');
  assert.ok(obs.lastShot, '落点本来就是公开宣告的，lastShot 保留');
  assert.deepEqual(obs.lastShot!.cell, [0, 0]);
  // 沉船是公开宣告的 → 剩余舰船数保留，且不形状化
  assert.equal(typeof obs.enemyShipsLeft, 'number');
  assert.equal(typeof obs.yourShipsLeft, 'number');
  // 旁观 textView 的公开战况图只标落点结果，绝不出现「未打却已知的船格」
  assert.match(String(obs.textView), /公开战况/);
});

/**
 * 下面五个小函数把每款打到终局。
 * 为什么需要：上面的用例都停在「开局」状态，而终局文案走的是另一条分支
 * （结果是 result().text），恰恰最容易漏掉「对手」这类座位相对称呼。
 */
function playGrabToEnd(): GrabState {
  let state = grab.setup(77);
  let guard = 0;
  while (!grab.isTerminal(state) && guard++ < 20) {
    const cells = grab.legalActions(state, 0).map((action) => action.cell as [number, number]);
    assert.ok(cells.length > 0, '还有金币时应有合法格子');
    // 双方各挑一头，尽量不撞车，金币会被逐个抢完
    state = grab.step(state, {
      0: { action: 'grab', cell: cells[0] },
      1: { action: 'grab', cell: cells[cells.length - 1] },
    }).state;
  }
  assert.ok(grab.isTerminal(state), '抢宝应在有限回合内结束');
  return state;
}

function playConnect4ToEnd() {
  let state = connect4.setup(0);
  let guard = 0;
  while (!connect4.isTerminal(state) && guard++ < 42) {
    const actions = connect4.legalActions(state, state.turn);
    assert.ok(actions.length > 0, '未终局时当前行动方应有合法列');
    state = connect4.step(state, { [state.turn]: actions[0] }).state;
  }
  assert.ok(connect4.isTerminal(state), '四子棋应在 42 手内结束');
  return state;
}

function playRpsToEnd() {
  const plays = [
    ['rock', 'paper'],
    ['paper', 'scissors'],
    ['rock', 'paper'],
  ] as const;
  let state = rpsDuel.setup(0);
  for (const [seat0, seat1] of plays) {
    state = rpsDuel.step(state, {
      0: { action: 'throw', shape: seat0 },
      1: { action: 'throw', shape: seat1 },
    }).state;
  }
  assert.ok(rpsDuel.isTerminal(state), '三局打完应终局');
  return state;
}

function playYachtToEnd() {
  let state = yacht.setup(5);
  let guard = 0;
  while (!yacht.isTerminal(state) && guard++ < 80) {
    const seat = state.turn;
    // 每手先掷一次骰，再立刻记到第一个空栏目：必然推进，26 手后终局
    state = yacht.step(state, { [seat]: { action: 'roll' } }).state;
    const category = CATEGORIES.find((candidate) => state.cards[seat][candidate] === null);
    assert.ok(category, '未终局时必有空栏目可记');
    state = yacht.step(state, { [seat]: { action: 'score', category } }).state;
  }
  assert.ok(yacht.isTerminal(state), '双方各 13 格记满后应终局');
  return state;
}

function playBattleshipToEnd() {
  let state = battleship.setup(29);
  let guard = 0;
  while (!battleship.isTerminal(state) && guard++ < 60) {
    const seat = state.turn;
    const actions = battleship.legalActions(state, seat);
    assert.ok(actions.length > 0, '未终局时当前行动方应有可打格');
    state = battleship.step(state, { [seat]: actions[0] }).state;
  }
  assert.ok(battleship.isTerminal(state), '深海猎手应在 50 炮内结束');
  return state;
}

function playReversiToEnd() {
  let state = reversi.setup(0);
  let guard = 0;
  while (!reversi.isTerminal(state) && guard++ < 70) {
    const moves = reversi.legalActions(state, state.turn);
    assert.ok(moves.length > 0, '未终局时当前行动方应有落点（无子可下会自动跳过）');
    state = reversi.step(state, { [state.turn]: moves[0] }).state;
  }
  assert.ok(reversi.isTerminal(state), '黑白棋应在 60 手内结束');
  return state;
}

test('终局旁观：六款 textView 仍然中性，legalActions 依旧为空', () => {
  const cases: Array<[string, { seat: unknown; legalActions: unknown[]; textView: unknown }]> = [
    ['grab', grab.observe(playGrabToEnd(), null)],
    ['connect4', connect4.observe(playConnect4ToEnd(), null)],
    ['rps-duel', rpsDuel.observe(playRpsToEnd(), null)],
    ['yacht', yacht.observe(playYachtToEnd(), null)],
    ['reversi', reversi.observe(playReversiToEnd(), null)],
    ['battleship', battleship.observe(playBattleshipToEnd(), null)],
  ];
  for (const [gameId, obs] of cases) {
    assert.equal(obs.seat, null);
    assert.deepEqual(obs.legalActions, [], `${gameId} 终局旁观也不该有合法动作`);
    assertNeutralText(String(obs.textView), `${gameId}（终局旁观）`);
  }
});
