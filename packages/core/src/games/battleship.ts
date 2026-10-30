import { mulberry32 } from '../rng.ts';
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

/** 海域边长（5×5 = 25 格）。 */
export const SEA_SIZE = 5;
export const SEA_CELLS = SEA_SIZE * SEA_SIZE;

/** 单方舰队：一艘 2 格驱逐舰 + 一艘 1 格潜艇（共 3 格）。 */
export interface Ship {
  id: string;
  name: string;
  size: number;
  cells: Coord[];
}

export interface ShotRecord {
  /** 第几炮（1-based，全局计数）。 */
  round: number;
  seat: Seat;
  cell: Coord;
  hit: boolean;
  /** 本炮击沉了哪艘船（船名）；没击沉为 null。 */
  sunk: string | null;
}

export interface BattleshipState {
  fleets: { 0: Ship[]; 1: Ship[] };
  /** 各座位自己舰队里被打中的格子。 */
  hits: { 0: Coord[]; 1: Coord[] };
  /** 各座位已经打过的格子（含未命中）。 */
  fired: { 0: Coord[]; 1: Coord[] };
  turn: Seat;
  shots: ShotRecord[];
}

/** 敌方海域里每一格的可见状态。 */
export type EnemyCell = 'unknown' | 'miss' | 'hit' | 'sunk';

export interface ShipView extends Ship {
  hitCells: Coord[];
  sunk: boolean;
}

export interface BattleshipObservation extends BaseObservation {
  yourFleet: ShipView[];
  /** 5×5，敌方海域：你打过的格子才透出结果，其余 unknown。 */
  enemyGrid: EnemyCell[][];
  enemyShipsLeft: number;
  yourShipsLeft: number;
  lastShot: ShotRecord | null;
  shotsFired: number;
}

export const SHIP_SPECS: ReadonlyArray<{ id: string; name: string; size: number }> = [
  { id: 'destroyer', name: '驱逐舰', size: 2 },
  { id: 'sub', name: '潜艇', size: 1 },
];

export const BATTLESHIP_ROUNDS_TOTAL = SEA_CELLS * 2;

function key(cell: Coord): string {
  return `${cell[0]},${cell[1]}`;
}

function keySet(cells: readonly Coord[]): Set<string> {
  return new Set(cells.map(key));
}

function inSea(cell: Coord): boolean {
  return (
    Number.isInteger(cell[0]) &&
    Number.isInteger(cell[1]) &&
    cell[0] >= 0 &&
    cell[0] < SEA_SIZE &&
    cell[1] >= 0 &&
    cell[1] < SEA_SIZE
  );
}

/** A1 风格坐标，给人看比 [行,列] 亲切。 */
export function coordLabel(cell: Coord): string {
  return `${'ABCDE'[cell[1]]}${cell[0] + 1}`;
}

/** 随机布阵：先放驱逐舰（横或竖），再放潜艇；不重叠。 */
export function placeFleet(rand: () => number): Ship[] {
  const occupied = new Set<string>();
  const ships: Ship[] = [];

  for (const spec of SHIP_SPECS) {
    if (spec.size === 1) {
      const free: Coord[] = [];
      for (let r = 0; r < SEA_SIZE; r++) {
        for (let c = 0; c < SEA_SIZE; c++) if (!occupied.has(`${r},${c}`)) free.push([r, c]);
      }
      const pick = free[Math.floor(rand() * free.length)] ?? free[0];
      occupied.add(key(pick));
      ships.push({ id: spec.id, name: spec.name, size: 1, cells: [pick] });
      continue;
    }

    // 长度为 2：所有合法摆放（横竖各一套），随机取一个
    const placements: Coord[][] = [];
    for (let r = 0; r < SEA_SIZE; r++) {
      for (let c = 0; c < SEA_SIZE; c++) {
        if (c + 1 < SEA_SIZE) placements.push([[r, c], [r, c + 1]]);
        if (r + 1 < SEA_SIZE) placements.push([[r, c], [r + 1, c]]);
      }
    }
    const free = placements.filter((cells) => cells.every((cell) => !occupied.has(key(cell))));
    const pick = free[Math.floor(rand() * free.length)] ?? free[0];
    for (const cell of pick) occupied.add(key(cell));
    ships.push({ id: spec.id, name: spec.name, size: 2, cells: pick });
  }

  return ships;
}

function shipSunk(ship: Ship, hits: readonly Coord[]): boolean {
  const hit = keySet(hits);
  return ship.cells.every((cell) => hit.has(key(cell)));
}

function shipsLeft(fleet: readonly Ship[], hits: readonly Coord[]): number {
  return fleet.filter((ship) => !shipSunk(ship, hits)).length;
}

const RULES = `深海猎手（Battleship / Deep Sea Hunter）
一句话规则：5×5 海域里藏着你对手的 2 艘船（2 格驱逐舰 + 1 格潜艇），轮流开炮；命中可以继续打，未命中就换手。

细节：
- 海域 5×5（25 格），坐标 [行,列]，行/列取值 0-4，A1 风格显示为 A1–E5。
- 双方舰队组成相同、开局随机布阵（互不重叠，横竖两种朝向）。
- 轮到你时炮击一格：命中（对手的船被击中）就**继续由你开炮**，直到打空（未命中）才换手。
- 一艘船的所有格子都被命中即沉没，会公开宣告；已打过的格子不能再打。
- **把对手 2 艘船全部击沉即获胜**。没有平局（不会同归于尽）。
- 你自己的舰队布阵对你是公开的，对手的布阵只有打过的格子才透出结果。

动作：{"action":"fire","cell":[row,col]}，row/col 取值 0-4。
可用动作见 legalActions（打过的格子会被排除），形如 [{"action":"fire","cell":[0,0]}, ...]。`;

export const battleship: GameSpec<BattleshipState, BattleshipObservation> = {
  meta: {
    id: 'battleship',
    name: '深海猎手',
    tagline: '5×5 盲射找船，命中继续开炮',
    seats: 2,
    rules: RULES,
    category: '推理',
    tags: ['隐藏信息', '推理', '中局'],
    duration: '5–8 分钟',
    status: 'playable',
    accent: '#2f8f86',
    resolution: 'turn',
  } satisfies GameMeta,

  setup(seed: number): BattleshipState {
    const rand = mulberry32(seed);
    return {
      fleets: { 0: placeFleet(rand), 1: placeFleet(rand) },
      hits: { 0: [], 1: [] },
      fired: { 0: [], 1: [] },
      turn: 0,
      shots: [],
    };
  },

  legalActions(state: BattleshipState, seat: Seat): Action[] {
    if (battleship.isTerminal(state)) return [];
    if (battleship.currentSeat?.(state) !== seat) return [];
    const already = keySet(state.fired[seat as 0 | 1]);
    const out: Action[] = [];
    for (let r = 0; r < SEA_SIZE; r++) {
      for (let c = 0; c < SEA_SIZE; c++) {
        if (already.has(`${r},${c}`)) continue;
        out.push({ action: 'fire', cell: [r, c] });
      }
    }
    return out;
  },

  step(state: BattleshipState, actions: Record<Seat, Action>) {
    const shooter = state.turn;
    const raw = actions[shooter]?.cell;
    const cell = Array.isArray(raw) ? ([Number(raw[0]), Number(raw[1])] as Coord) : null;
    if (!cell || !inSea(cell) || keySet(state.fired[shooter as 0 | 1]).has(key(cell))) {
      throw new Error(`非法炮击: ${JSON.stringify(actions[shooter])}`);
    }

    const target = (1 - shooter) as 0 | 1;
    const enemyFleet = state.fleets[target];
    const hitShip = enemyFleet.find((ship) => ship.cells.some((c) => key(c) === key(cell)));
    const hit = Boolean(hitShip);

    const fired = { ...state.fired, [shooter]: [...state.fired[shooter as 0 | 1], cell] };
    const hits = {
      ...state.hits,
      [target]: hit ? [...state.hits[target], cell] : state.hits[target],
    };

    let sunk: string | null = null;
    if (hit && hitShip && shipSunk(hitShip, hits[target])) sunk = hitShip.name;

    const record: ShotRecord = {
      round: state.shots.length + 1,
      seat: shooter,
      cell,
      hit,
      sunk,
    };

    // 命中继续开炮（同一座位），未命中换手。
    const next: BattleshipState = {
      fleets: state.fleets,
      hits,
      fired,
      turn: hit ? shooter : ((1 - shooter) as Seat),
      shots: [...state.shots, record],
    };

    const events: GameEvent[] = [
      {
        type: 'fire',
        seat: shooter,
        cell,
        label: coordLabel(cell),
        hit,
        sunk,
        opponentShipsLeft: shipsLeft(enemyFleet, hits[target]),
        nextSeat: battleship.isTerminal(next) ? null : next.turn,
      },
    ];
    if (battleship.isTerminal(next)) {
      events.push({ type: 'end', result: battleship.result(next) });
    }
    return { state: next, events };
  },

  isTerminal(state: BattleshipState): boolean {
    return (
      shipsLeft(state.fleets[0], state.hits[0]) === 0 ||
      shipsLeft(state.fleets[1], state.hits[1]) === 0
    );
  },

  result(state: BattleshipState): GameResultSummary {
    const left0 = shipsLeft(state.fleets[0], state.hits[0]);
    const left1 = shipsLeft(state.fleets[1], state.hits[1]);
    const winner: Seat | null = left0 === 0 && left1 === 0 ? null : left0 === 0 ? 1 : 0;
    const text =
      winner === null
        ? '双方同归于尽，平局。'
        : `座位 ${winner} 获胜！对手 2 艘船全部击沉（共 ${state.shots.length} 炮）。`;
    return { winner, scores: { 0: left0, 1: left1 }, text };
  },

  currentSeat(state: BattleshipState): Seat | null {
    return battleship.isTerminal(state) ? null : state.turn;
  },

  observe(state: BattleshipState, seat: Seat | null): BattleshipObservation {
    const ended = battleship.isTerminal(state);
    const current = ended ? null : state.turn;
    // 剩余舰船数是公开信息（沉船会被公开宣告），两个视角一致。
    const scores = {
      0: shipsLeft(state.fleets[0], state.hits[0]),
      1: shipsLeft(state.fleets[1], state.hits[1]),
    };
    const lastShot = state.shots.length > 0 ? state.shots[state.shots.length - 1] : null;
    const round = Math.min(state.shots.length + (ended ? 0 : 1), BATTLESHIP_ROUNDS_TOTAL);

    // 旁观者没有座位：舰队布阵是这款唯一的私有信息，必须整体遮蔽；
    // 落点/命中/沉没都是公开宣告的，可以保留。
    if (seat === null) {
      return {
        gameId: battleship.meta.id,
        seat: null,
        round,
        roundsTotal: BATTLESHIP_ROUNDS_TOTAL,
        scores,
        legalActions: [],
        textView: buildBattleshipTextView(state, null),
        status: ended ? 'ended' : 'playing',
        currentSeat: current,
        isYourTurn: false,
        // 旁观不是「借座位 0 偷看」：任何一方的舰队布阵都不给。
        yourFleet: [],
        enemyGrid: Array.from({ length: SEA_SIZE }, () => Array<EnemyCell>(SEA_SIZE).fill('unknown')),
        // 座位相对的「剩余舰船数」按座位 0 视角呈现（前端用 spectator 改标签）。
        enemyShipsLeft: scores[1],
        yourShipsLeft: scores[0],
        lastShot,
        shotsFired: 0,
      };
    }

    const opponent = (1 - seat) as 0 | 1;
    const mine = seat as 0 | 1;
    const myFleet = state.fleets[mine];
    const enemyFleet = state.fleets[opponent];
    const myHits = state.hits[mine];
    const enemyHits = state.hits[opponent];

    const yourFleet: ShipView[] = myFleet.map((ship) => ({
      ...ship,
      hitCells: ship.cells.filter((cell) => keySet(myHits).has(key(cell))),
      sunk: shipSunk(ship, myHits),
    }));

    // 敌方海域：只有自己打过的格子才透出结果，且未沉没的船不给形状。
    const enemyGrid: EnemyCell[][] = [];
    for (let r = 0; r < SEA_SIZE; r++) {
      const row: EnemyCell[] = [];
      for (let c = 0; c < SEA_SIZE; c++) {
        const cell: Coord = [r, c];
        const shot = state.shots.find((s) => s.seat === seat && key(s.cell) === key(cell));
        if (!shot) {
          row.push('unknown');
          continue;
        }
        if (!shot.hit) {
          row.push('miss');
          continue;
        }
        // 命中的格子：若该船已沉，标 sunk（形状已在终局或宣告时公开）
        const ship = enemyFleet.find((s) => s.cells.some((sc) => key(sc) === key(cell)));
        row.push(ship && shipSunk(ship, enemyHits) ? 'sunk' : 'hit');
      }
      enemyGrid.push(row);
    }

    const firedCount = state.fired[mine].length;

    return {
      gameId: battleship.meta.id,
      seat,
      round,
      roundsTotal: BATTLESHIP_ROUNDS_TOTAL,
      // 比分即「剩余舰船数」，直观看得出来
      scores,
      legalActions: ended ? [] : battleship.legalActions(state, seat),
      textView: buildBattleshipTextView(state, seat),
      status: ended ? 'ended' : 'playing',
      currentSeat: current,
      isYourTurn: ended ? false : state.turn === seat,
      yourFleet,
      enemyGrid,
      enemyShipsLeft: shipsLeft(enemyFleet, enemyHits),
      yourShipsLeft: shipsLeft(myFleet, myHits),
      lastShot,
      shotsFired: firedCount,
    };
  },
};

export function buildBattleshipTextView(state: BattleshipState, seat: Seat | null): string {
  const ended = battleship.isTerminal(state);

  // 旁观视图：只写公开信息（双方剩余舰船数 + 已宣告的炮击结果），
  // 绝不画「我方海域」——那会把座位 0 的布阵原样送给围观者。
  if (seat === null) {
    const left0 = shipsLeft(state.fleets[0], state.hits[0]);
    const left1 = shipsLeft(state.fleets[1], state.hits[1]);
    const current = ended ? null : state.turn;
    const lines: string[] = [];
    lines.push(
      ended
        ? `🏁 旁观视图 · 对局结束 · 座位 0 剩 ${left0} 艘 · 座位 1 剩 ${left1} 艘 · 全场共 ${state.shots.length} 炮`
        : `旁观视图 · 全场第 ${state.shots.length + 1} 炮 · 座位 0 剩 ${left0} 艘 · 座位 1 剩 ${left1} 艘`,
    );
    // 每一炮的命中/打空/击沉都会公开广播，所以合图展示不泄露新信息；
    // 但没被打中的船格永远是 ░，布阵不会因此透出。
    lines.push('公开战况（░ 未打 · ○ 打空 · ✕ 命中 · ☠ 沉没）：');
    lines.push('    ' + 'ABCDE'.split('').join(' '));
    for (let r = 0; r < SEA_SIZE; r++) {
      const row: string[] = [];
      for (let c = 0; c < SEA_SIZE; c++) {
        const shot = state.shots.find((s) => key(s.cell) === `${r},${c}`);
        if (!shot) {
          row.push('░');
          continue;
        }
        if (!shot.hit) {
          row.push('○');
          continue;
        }
        const target = (1 - shot.seat) as 0 | 1;
        const ship = state.fleets[target].find((s) => s.cells.some((sc) => key(sc) === `${r},${c}`));
        row.push(ship && shipSunk(ship, state.hits[target]) ? '☠' : '✕');
      }
      lines.push(` ${r + 1}  ` + row.join(' '));
    }

    const last = state.shots.length > 0 ? state.shots[state.shots.length - 1] : null;
    if (last) {
      const result = last.hit ? (last.sunk ? `命中并击沉了${last.sunk}` : '命中') : '打空';
      lines.push(`上一炮：座位 ${last.seat} 打 ${coordLabel(last.cell)} → ${result}`);
    }

    if (ended) {
      // 不能直接复用 result().text：它写的是「对手 2 艘船全部击沉」，旁观视角没有「对手」。
      const result = battleship.result(state);
      const verdict =
        result.winner === null
          ? `平局（双方剩余舰船 ${result.scores[0]} : ${result.scores[1]}）`
          : `座位 ${result.winner} 获胜（剩余舰船 ${result.scores[0]} : ${result.scores[1]}）`;
      lines.push(`对局已结束：${verdict}。（Agent 可用 get_result / export_log 复盘）`);
    } else if (current !== null) {
      lines.push(`现在轮到座位 ${current} 开炮，旁观视图不可行动。`);
    }
    return lines.join('\n');
  }

  const opponent = (1 - seat) as 0 | 1;
  const mine = seat as 0 | 1;
  const myFleet = state.fleets[mine];
  const enemyFleet = state.fleets[opponent];
  const lines: string[] = [];

  const myLeft = shipsLeft(myFleet, state.hits[mine]);
  const enemyLeft = shipsLeft(enemyFleet, state.hits[opponent]);
  // 注意两个计数口径不同：全场的「炮」和「你打了几炮」，写清楚免得 Agent 糊涂
  lines.push(
    ended
      ? `🏁 对局结束 · 我方剩 ${myLeft} 艘 · 敌方剩 ${enemyLeft} 艘 · 全场共 ${state.shots.length} 炮`
      : `全场第 ${state.shots.length + 1} 炮（你已开炮 ${state.fired[mine].length} 次）· 我方剩 ${myLeft} 艘 · 敌方剩 ${enemyLeft} 艘`,
  );

  lines.push('敌方海域（░ 未打 · ○ 打空 · ✕ 命中 · ☠ 沉没）：');
  lines.push('    ' + 'ABCDE'.split('').join(' '));
  for (let r = 0; r < SEA_SIZE; r++) {
    const row: string[] = [];
    for (let c = 0; c < SEA_SIZE; c++) {
      const shot = state.shots.find((s) => s.seat === seat && key(s.cell) === `${r},${c}`);
      if (!shot) {
        row.push('░');
        continue;
      }
      if (!shot.hit) {
        row.push('○');
        continue;
      }
      const ship = enemyFleet.find((s) => s.cells.some((sc) => key(sc) === `${r},${c}`));
      row.push(ship && shipSunk(ship, state.hits[opponent]) ? '☠' : '✕');
    }
    lines.push(` ${r + 1}  ` + row.join(' '));
  }

  lines.push('我方海域（● 完好 · ✕ 中弹）：');
  lines.push('    ' + 'ABCDE'.split('').join(' '));
  const myHits = keySet(state.hits[mine]);
  for (let r = 0; r < SEA_SIZE; r++) {
    const row: string[] = [];
    for (let c = 0; c < SEA_SIZE; c++) {
      const ship = myFleet.find((s) => s.cells.some((sc) => key(sc) === `${r},${c}`));
      if (!ship) row.push('·');
      else row.push(myHits.has(`${r},${c}`) ? '✕' : '●');
    }
    lines.push(` ${r + 1}  ` + row.join(' '));
  }

  const last = state.shots.length > 0 ? state.shots[state.shots.length - 1] : null;
  if (last) {
    const who = last.seat === seat ? '你' : '对手';
    const result = last.hit ? (last.sunk ? `命中并击沉了${last.sunk}` : '命中') : '打空';
    lines.push(`上一炮：${who} 打 ${coordLabel(last.cell)} → ${result}`);
  }

  if (ended) {
    const result = battleship.result(state);
    lines.push(`对局已结束：${result.text}（Agent 可用 get_result / export_log 复盘）`);
  } else if (state.turn === seat) {
    lines.push('轮到你开炮：{"action":"fire","cell":[row,col]}，row/col 取 0-4。命中可继续打。');
  } else {
    lines.push('轮到对手开炮，等它打完（命中会连打几炮）。');
  }
  return lines.join('\n');
}

export default battleship;


