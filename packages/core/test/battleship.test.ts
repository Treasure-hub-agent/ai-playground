import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BATTLESHIP_ROUNDS_TOTAL,
  SEA_SIZE,
  Ship,
  battleship,
  coordLabel,
  type BattleshipState,
} from '../src/games/battleship.ts';

function fire(cell: [number, number]) {
  return { action: 'fire', cell };
}

function step(state: BattleshipState, cell: [number, number]) {
  return battleship.step(state, { [state.turn]: fire(cell) });
}

/** 取 seat1（对手）某艘船的第一个格子。 */
function enemyCellOf(state: BattleshipState, shipId: string): [number, number] {
  const ship = state.fleets[1].find((s) => s.id === shipId);
  assert.ok(ship, `对手应有 ${shipId}`);
  return [...ship.cells[0]] as [number, number];
}

test('setup: 5×5 海域，双方各 2 艘共 3 格，互不重叠且在界内', () => {
  const state = battleship.setup(42);
  assert.equal(SEA_SIZE, 5);
  assert.deepEqual(state.hits, { 0: [], 1: [] });
  assert.deepEqual(state.fired, { 0: [], 1: [] });
  assert.equal(state.turn, 0);
  assert.deepEqual(state.shots, []);

  for (const seat of [0, 1] as const) {
    const fleet: Ship[] = state.fleets[seat];
    assert.equal(fleet.length, 2, '每方 2 艘船');
    assert.equal(
      fleet.reduce((sum, s) => sum + s.cells.length, 0),
      3,
      '每方共占 3 格',
    );
    const keys = new Set<string>();
    for (const ship of fleet) {
      for (const [r, c] of ship.cells) {
        assert.ok(r >= 0 && r < SEA_SIZE && c >= 0 && c < SEA_SIZE, '船格应在海域内');
        const k = `${r},${c}`;
        assert.ok(!keys.has(k), '同一方船格不应重叠');
        keys.add(k);
      }
    }
    assert.equal(fleet.find((s) => s.id === 'destroyer')!.cells.length, 2);
    assert.equal(fleet.find((s) => s.id === 'sub')!.cells.length, 1);
  }

  // 两方舰队互不干涉（各在自己的海域里，可以重叠坐标）
  assert.equal(state.fleets[0].length + state.fleets[1].length, 4);
});

test('setup: 同种子可复现，不同种子布阵不同', () => {
  const a = JSON.stringify(battleship.setup(7).fleets);
  const b = JSON.stringify(battleship.setup(7).fleets);
  assert.equal(a, b);
  const set = new Set<string>();
  for (let seed = 0; seed < 20; seed++) set.add(JSON.stringify(battleship.setup(seed).fleets));
  assert.ok(set.size > 1, '不同种子应产生不同布阵');
});

test('legalActions: 开局 25 格；非当前座位为空；打过的格子被排除', () => {
  const state = battleship.setup(1);
  const acts = battleship.legalActions(state, 0);
  assert.equal(acts.length, SEA_SIZE * SEA_SIZE);
  assert.ok(acts.every((a) => a.action === 'fire' && Array.isArray(a.cell)));
  assert.deepEqual(battleship.legalActions(state, 1), [], '不是座位 1 的回合');

  // 打一格（无论命中与否）后该格从 legalActions 消失
  const { state: next } = step(state, [4, 4]);
  const after = battleship.legalActions(next, next.turn);
  assert.ok(
    !after.some((a) => Array.isArray(a.cell) && a.cell[0] === 4 && a.cell[1] === 4),
    '打过的格子不应再出现',
  );
  assert.equal(
    battleship.legalActions(next, 0).length + battleship.legalActions(next, 1).length,
    24,
    '25 格打掉 1 格后，剩余合法炮击来自当前行动方',
  );
});

test('未命中：换手，且记录一条 miss', () => {
  const state = battleship.setup(3);
  // 找一个确定不是船的空格
  const enemyCells = new Set(state.fleets[1].flatMap((s) => s.cells.map(([r, c]) => `${r},${c}`)));
  let miss: [number, number] | null = null;
  for (let r = 0; r < SEA_SIZE && !miss; r++) {
    for (let c = 0; c < SEA_SIZE && !miss; c++) {
      if (!enemyCells.has(`${r},${c}`)) miss = [r, c];
    }
  }
  assert.ok(miss);
  const { state: next, events } = step(state, miss);
  assert.equal(next.turn, 1, '未命中应换手');
  assert.equal(next.shots.length, 1);
  assert.equal(next.shots[0].hit, false);
  const ev = events.find((e) => e.type === 'fire')!;
  assert.equal(ev.hit, false);
  assert.equal(ev.nextSeat, 1);
});

test('命中：同一座位继续开炮（不等对手）', () => {
  const state = battleship.setup(11);
  const hit = enemyCellOf(state, 'destroyer');
  const { state: next, events } = step(state, hit);
  assert.equal(next.turn, 0, '命中应继续由同一方开炮');
  assert.equal(next.hits[1].length, 1, '对手海域应记录中弹');
  assert.equal(battleship.currentSeat?.(next), 0);
  assert.ok(events.some((e) => e.type === 'fire' && e.hit === true));
  // 同一座位可以继续提交
  assert.ok(battleship.legalActions(next, 0).length > 0);
});

test('击沉：一艘船的全部格子命中后宣告沉没', () => {
  let state = battleship.setup(5);
  const sub = state.fleets[1].find((s) => s.id === 'sub')!;
  const { state: next, events } = step(state, [...sub.cells[0]] as [number, number]);
  state = next;
  const ev = events.find((e) => e.type === 'fire')!;
  assert.equal(ev.hit, true);
  assert.equal(ev.sunk, '潜艇', '单格船一炮即沉');
  assert.equal(ev.opponentShipsLeft, 1);
});

test('全部击沉：终局、result 有胜者、legalActions 为空', () => {
  let state = battleship.setup(9);
  let guard = 0;
  while (!battleship.isTerminal(state) && guard++ < 80) {
    const seat = state.turn as 0 | 1;
    const firedKeys = new Set(state.fired[seat].map((f) => `${f[0]},${f[1]}`));
    const enemyFleet = state.fleets[(1 - seat) as 0 | 1];
    const enemyShipCells = enemyFleet.flatMap((s) => s.cells);
    const enemyKeys = new Set(enemyShipCells.map(([r, c]) => `${r},${c}`));

    let cell: [number, number] | null = null;
    // 座位 0 专打对手船格（命中继续），座位 1 只打空 —— 保证座位 0 赢
    if (seat === 0) {
      const target = enemyShipCells.find((c) => !firedKeys.has(`${c[0]},${c[1]}`));
      if (target) cell = [target[0], target[1]];
    }
    if (!cell) {
      for (let r = 0; r < SEA_SIZE && !cell; r++) {
        for (let c = 0; c < SEA_SIZE && !cell; c++) {
          if (!firedKeys.has(`${r},${c}`) && !enemyKeys.has(`${r},${c}`)) cell = [r, c];
        }
      }
    }
    assert.ok(cell, '应还有可打的格子');
    state = battleship.step(state, { [seat]: { action: 'fire', cell } }).state;
  }
  assert.ok(battleship.isTerminal(state), '应在有限炮数内结束');
  const obs = battleship.observe(state, 0);
  assert.equal(obs.status, 'ended');
  assert.equal(obs.currentSeat, null);
  assert.deepEqual(obs.legalActions, []);
  const result = battleship.result(state);
  assert.ok(result.winner === 0 || result.winner === 1, '应分出胜负');
  assert.equal(result.scores[result.winner === 0 ? 1 : 0], 0, '败方舰船应全灭');
  assert.ok(result.text.length > 0);
});

test('observe 遮蔽：敌方海域只有打过的格子透出结果', () => {
  const state = battleship.setup(21);
  const obs0 = battleship.observe(state, 0);
  assert.ok(
    obs0.enemyGrid.every((row) => row.every((cell) => cell === 'unknown')),
    '一炮未打时敌方海域全 unknown',
  );
  const enemyCells = new Set(state.fleets[1].flatMap((s) => s.cells.map(([r, c]) => `${r},${c}`)));
  const miss = [...Array(SEA_SIZE).keys()]
    .flatMap((r) => [...Array(SEA_SIZE).keys()].map((c) => [r, c] as [number, number]))
    .find(([r, c]) => !enemyCells.has(`${r},${c}`))!;
  const { state: next } = step(state, miss);
  const obs = battleship.observe(next, 0);
  assert.equal(obs.enemyGrid[miss[0]][miss[1]], 'miss');
  // 没打过的敌方船格仍然是 unknown（不泄露布阵）
  for (const [r, c] of state.fleets[1].flatMap((s) => s.cells)) {
    if (r === miss[0] && c === miss[1]) continue;
    assert.equal(obs.enemyGrid[r][c], 'unknown', '未打过的船格不应泄露');
  }
});

test('observe：自己的舰队对自己公开（含中弹格）', () => {
  let state = battleship.setup(13);
  const mySub = state.fleets[0].find((s) => s.id === 'sub')!;
  const enemyShot = [...mySub.cells[0]] as [number, number];
  // 让座位 1 打座位 0 的潜艇：先让座位 0 打空换手，再让座位 1 打
  const empty = battleship
    .legalActions(state, 0)
    .map((a) => a.cell as [number, number])
    .find(([r, c]) => !state.fleets[1].some((s) => s.cells.some(([sr, sc]) => sr === r && sc === c)))!;
  state = step(state, empty).state;
  assert.equal(state.turn, 1);
  state = step(state, enemyShot).state;

  const obs = battleship.observe(state, 0);
  assert.equal(obs.yourFleet.length, 2);
  const subView = obs.yourFleet.find((s) => s.id === 'sub')!;
  assert.equal(subView.hitCells.length, 1, '自己被打中的格子应可见');
  assert.equal(subView.sunk, true, '1 格船被打中就沉');
  assert.equal(obs.yourShipsLeft, 1);
});

test('observe: 座位相对 —— 双方看到的敌方海域各不相同', () => {
  const state = battleship.setup(17);
  const o0 = battleship.observe(state, 0);
  const o1 = battleship.observe(state, 1);
  assert.deepEqual(o0.scores, o1.scores, '剩余舰船数是公开信息');
  assert.notDeepEqual(o0.yourFleet, o1.yourFleet, '各自只看到自己的舰队');
  assert.equal(o0.isYourTurn, true);
  assert.equal(o1.isYourTurn, false);
});

test('非法炮击：越界 / 重复打同一格都会抛错', () => {
  const state = battleship.setup(2);
  assert.throws(() => step(state, [9, 9]), /非法炮击/);
  const { state: after } = step(state, [0, 0]);
  // 同一座位再打同一格（若命中了还是它的回合）
  if (after.turn === 0) {
    assert.throws(() => step(after, [0, 0]), /非法炮击/);
  }
});

test('textView：带 A–E 列标、敌方/我方海域与回合提示', () => {
  const state = battleship.setup(4);
  const view = String(battleship.observe(state, 0).textView);
  assert.match(view, /第 1 炮/);
  assert.match(view, /A B C D E/);
  assert.match(view, /敌方海域/);
  assert.match(view, /我方海域/);
  assert.match(view, /轮到你开炮/);
  assert.match(String(battleship.observe(state, 1).textView), /轮到对手开炮/);
});

test('meta 与坐标标签', () => {
  assert.equal(battleship.meta.id, 'battleship');
  assert.equal(battleship.meta.status, 'playable');
  assert.equal(battleship.meta.resolution, 'turn');
  assert.equal(BATTLESHIP_ROUNDS_TOTAL, 50);
  assert.equal(coordLabel([0, 0]), 'A1');
  assert.equal(coordLabel([4, 4]), 'E5');
  assert.match(battleship.meta.rules, /命中/);
});
