/**
 * 对局回放校验脚本（六款全支持）
 *
 * 用法：
 *   pnpm replay --room <roomId> [--base http://127.0.0.1:8787] [--seat 0] [--game yacht]
 *   pnpm replay --file <log.json>
 *
 * 原理：日志里保存了 seed 与事件流。用同一内核（强确定性）从 seed 重建对局：
 * - grab：按 reveal 里的 picks 逐回合重放，比对 delta / scores / grid / collision / 终局；
 * - connect4：按 drop 事件逐手重放，比对落子行列 / 棋盘 / 换手 / 终局；
 * - yacht：按 roll / hold / score 事件还原动作序列，比对每次掷骰的 dice、rollsLeft、held、
 *          每手 gained / scorecard、终局；并再跑一遍「同 seed + 同动作序列」，
 *          断言骰面序列可复现（至少前 5 手）。
 * - rps-duel：按 reveal 里的双方出手逐局重放，比对 winner / points / delta / scores / 终局；
 * - battleship：按 fire 事件逐炮重放，比对 hit / sunk / opponentShipsLeft / nextSeat（含命中连射的座位自洽）；
 * - reversi：按 place 事件逐手重放，比对翻面集合 / 子数，并校验内核的 pass 与日志同步。
 * 比对失败退出码非 0。
 */
import { readFileSync } from 'node:fs';
import { grab, ROUNDS_TOTAL } from '../packages/core/src/games/grab.ts';
import type { Coord, GrabState } from '../packages/core/src/games/grab.ts';
import { connect4 } from '../packages/core/src/games/connect4.ts';
import { rpsDuel } from '../packages/core/src/games/rps-duel.ts';
import { battleship } from '../packages/core/src/games/battleship.ts';
import { reversi, countDiscs } from '../packages/core/src/games/reversi.ts';
import {
  yacht,
  CATEGORIES,
  summarizeCard,
  isCardFull,
} from '../packages/core/src/games/yacht.ts';
import type { Category, YachtState } from '../packages/core/src/games/yacht.ts';
import type { Action } from '../packages/core/src/types.ts';

type Wrapped = { t: number; event: any };
interface RoomLog {
  roomId: string;
  gameId: string;
  seed: number;
  seat: number;
  result: { winner: number | null; scores: Record<string, number>; text: string } | null;
  events: Wrapped[];
}

let checks = 0;

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const raw = a.slice(2);
    const eqIndex = raw.indexOf('=');
    if (eqIndex >= 0) {
      out[raw.slice(0, eqIndex)] = raw.slice(eqIndex + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[raw] = next;
      i++;
    } else {
      out[raw] = 'true';
    }
  }
  return out;
}

function fail(msg: string): never {
  console.error(`\n❌ 回放失败：${msg}`);
  console.error(`   已比对 ${checks} 项`);
  process.exit(1);
}

/** 逐项断言：失败即退出非 0，成功则计数。 */
function verify(cond: unknown, msg: string): void {
  checks++;
  if (!cond) fail(msg);
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameCoord = (a: Coord, b: Coord) => a[0] === b[0] && a[1] === b[1];

async function loadLog(): Promise<RoomLog> {
  const args = parseArgs(process.argv.slice(2));
  if (args.file) {
    return JSON.parse(readFileSync(args.file, 'utf8')) as RoomLog;
  }
  const room = args.room;
  if (!room) {
    console.error('用法：pnpm replay --room <roomId> [--base http://127.0.0.1:8787] [--seat 0] [--game yacht]');
    console.error('   或 pnpm replay --file <log.json>');
    process.exit(2);
  }
  const base = (args.base ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
  const seat = args.seat ?? '0';
  // 第 12 轮席位鉴权之后，GET /log 仍按契约保持公开（日志只含结算后的公开事件，
  // seed 也在终局后才给），所以回放脚本**不需要**席位令牌；--seat 只影响日志里的 seat 字段。
  const res = await fetch(`${base}/api/rooms/${room}/log?seat=${seat}`);
  if (!res.ok) fail(`拉取日志失败 HTTP ${res.status}：${await res.text()}`);
  return (await res.json()) as RoomLog;
}

// ───────────────────────────── grab ─────────────────────────────

function replayGrab(log: RoomLog): void {
  let state: GrabState = grab.setup(log.seed);
  let round = 0;
  let lastResult: any = null;

  for (const wrapped of log.events) {
    const ev = wrapped.event;
    if (ev.type === 'reveal') {
      round++;
      const picks = ev.picks as Record<string, Coord>;
      if (typeof picks?.['0']?.[0] !== 'number' || typeof picks?.['1']?.[0] !== 'number') {
        fail(`第 ${round} 回合 reveal 缺少 picks`);
      }
      const before = { ...state.scores };
      const r = grab.step(state, {
        0: { action: 'grab', cell: picks['0'] },
        1: { action: 'grab', cell: picks['1'] },
      });
      state = r.state;
      const own = r.events[0] as any;

      // 逐项与日志对齐：撞车、得分、盘面
      verify(Boolean(own.collision) === Boolean(ev.collision), `第 ${round} 回合 collision 不一致`);
      verify(
        eq(own.scores, ev.scores),
        `第 ${round} 回合 scores 不一致：重放 ${JSON.stringify(own.scores)} vs 日志 ${JSON.stringify(ev.scores)}`,
      );
      verify(eq(own.delta, ev.delta), `第 ${round} 回合 delta 不一致`);
      verify(eq(own.grid, ev.grid), `第 ${round} 回合 grid 不一致`);

      console.log(
        `  第 ${String(round).padStart(2)} 回合  ${own.collision ? '💥 撞车' : '✅ 结算'}  ` +
          `picks[0]=[${picks['0']}] picks[1]=[${picks['1']}]  ` +
          `Δ=${own.delta['0'] >= 0 ? '+' : ''}${own.delta['0']}/${own.delta['1'] >= 0 ? '+' : ''}${own.delta['1']}  ` +
          `比分 ${before['0']}→${own.scores['0']} : ${before['1']}→${own.scores['1']}`,
      );
    } else if (ev.type === 'end') {
      lastResult = ev.result;
    } else if (ev.type === 'chat') {
      const m = ev.message;
      console.log(`  💬 seat ${m.seat}: ${m.text}`);
    }
  }

  if (grab.isTerminal(state)) {
    const replayed = grab.result(state);
    if (lastResult) {
      verify(replayed.winner === lastResult.winner, `终局胜者不一致：重放 ${replayed.winner} vs 日志 ${lastResult.winner}`);
      verify(eq(replayed.scores, lastResult.scores), '终局比分不一致');
    }
    console.log(`\n🏁 重放终局：${replayed.text}`);
  } else {
    console.log(`\n⏸ 日志未包含终局（可能对局中断），已重放 ${round} 回合，当前比分 ${JSON.stringify(state.scores)}`);
  }

  console.log(`\n✅ 回放校验通过：grab ${round} 回合与日志逐项一致（上限 ${ROUNDS_TOTAL} 回合，比对 ${checks} 项）`);
}

// ───────────────────────────── connect4 ─────────────────────────────

function replayConnect4(log: RoomLog): void {
  let state = connect4.setup(log.seed);
  let moves = 0;
  let lastResult: any = null;

  for (const wrapped of log.events) {
    const ev = wrapped.event;
    if (ev.type === 'drop') {
      const seat = state.turn;
      verify(ev.seat === seat, `第 ${moves + 1} 手 drop 座位 ${ev.seat} 与回放当前行动方 ${seat} 不一致`);
      const column = Number(ev.column);
      const r = connect4.step(state, { [seat]: { action: 'drop', column } } as Record<number, Action>);
      state = r.state;
      moves++;
      const own = r.events[0] as any;
      verify(own.column === column, `第 ${moves} 手 column 不一致`);
      verify(own.row === ev.row, `第 ${moves} 手 row 不一致：重放 ${own.row} vs 日志 ${ev.row}`);
      verify(eq(own.board, ev.board), `第 ${moves} 手 board 不一致`);
      verify(own.nextSeat === ev.nextSeat, `第 ${moves} 手 nextSeat 不一致`);
      verify(eq(own.lastMove, ev.lastMove), `第 ${moves} 手 lastMove 不一致`);
    } else if (ev.type === 'end') {
      lastResult = ev.result;
    } else if (ev.type === 'chat') {
      continue;
    } else {
      fail(`未知事件类型 ${ev.type}`);
    }
  }

  const replayed = connect4.result(state);
  if (!connect4.isTerminal(state)) {
    console.log(`\n⏸ 日志未包含终局，已重放 ${moves} 手，当前结果：${replayed.text}`);
    console.log(`\n✅ 回放校验通过：connect4 ${moves} 手与日志逐项一致（比对 ${checks} 项）`);
    return;
  }
  if (lastResult) {
    verify(replayed.winner === lastResult.winner, `终局胜者不一致：重放 ${replayed.winner} vs 日志 ${lastResult.winner}`);
    verify(eq(replayed.scores, lastResult.scores), '终局比分不一致');
  }
  console.log(`\n🏁 重放终局：${replayed.text}`);
  console.log(`\n✅ 回放校验通过：connect4 ${moves} 手与日志逐项一致（比对 ${checks} 项）`);
}

// ───────────────────────────── yacht ─────────────────────────────

/** 纯模拟：给定 seed + 动作序列，返回每次掷骰的骰面与每手终局骰面。 */
function simulateYacht(seed: number, actions: Action[]): { rollDice: number[][]; handDice: number[][] } {
  let state = yacht.setup(seed);
  const rollDice: number[][] = [];
  const handDice: number[][] = [];
  for (const action of actions) {
    const finalDice = [...state.dice];
    const r = yacht.step(state, { [state.turn]: action } as Record<number, Action>);
    state = r.state;
    const ev = r.events[0] as any;
    if (ev.type === 'roll') rollDice.push([...ev.dice]);
    if (ev.type === 'score') handDice.push(finalDice);
  }
  return { rollDice, handDice };
}

function replayYacht(log: RoomLog): void {
  let state: YachtState = yacht.setup(log.seed);
  const actions: Action[] = [];
  const logRollDice: number[][] = [];
  const handDice: number[][] = [];
  let lastResult: any = null;
  let hands = 0;

  for (const wrapped of log.events) {
    const ev = wrapped.event;
    if (ev.type === 'roll') {
      const seat = state.turn;
      verify(ev.seat === seat, `第 ${logRollDice.length + 1} 次 roll 座位 ${ev.seat} 与回放当前行动方 ${seat} 不一致`);
      const beforeRolls = state.rollsLeft;
      const r = yacht.step(state, { [seat]: { action: 'roll' } } as Record<number, Action>);
      state = r.state;
      const own = r.events[0] as any;
      verify(eq(own.dice, ev.dice), `第 ${logRollDice.length + 1} 次 roll 骰面不一致：重放 ${JSON.stringify(own.dice)} vs 日志 ${JSON.stringify(ev.dice)}`);
      verify(own.rollsLeft === ev.rollsLeft, `第 ${logRollDice.length + 1} 次 roll 的 rollsLeft 不一致`);
      verify(state.rollsLeft === beforeRolls - 1, 'roll 后 rollsLeft 应递减 1');
      verify(eq(state.held, ev.held), `第 ${logRollDice.length + 1} 次 roll 后的 held 不一致`);
      actions.push({ action: 'roll' });
      logRollDice.push([...own.dice]);
    } else if (ev.type === 'hold') {
      const seat = state.turn;
      verify(ev.seat === seat, `hold 事件座位 ${ev.seat} 与回放当前行动方 ${seat} 不一致`);
      const toggles: number[] = [];
      for (let index = 0; index < state.held.length; index++) {
        if (Boolean(state.held[index]) !== Boolean(ev.held?.[index])) toggles.push(index);
      }
      verify(toggles.length > 0, 'hold 事件没有改变任何锁定状态');
      const r = yacht.step(state, { [seat]: { action: 'hold', indices: toggles } } as Record<number, Action>);
      state = r.state;
      verify(eq(state.held, ev.held), 'hold 回放后的 held 与日志不一致');
      actions.push({ action: 'hold', indices: toggles });
    } else if (ev.type === 'score') {
      const seat = state.turn;
      verify(ev.seat === seat, `第 ${hands + 1} 手 score 座位 ${ev.seat} 与回放当前行动方 ${seat} 不一致`);
      verify(
        (CATEGORIES as readonly string[]).includes(String(ev.category)),
        `第 ${hands + 1} 手 category 非法：${String(ev.category)}`,
      );
      const finalDice = [...state.dice];
      const r = yacht.step(state, {
        [seat]: { action: 'score', category: ev.category as Category },
      } as Record<number, Action>);
      state = r.state;
      const own = r.events[0] as any;
      verify(own.gained === ev.gained, `第 ${hands + 1} 手 gained 不一致：重放 ${own.gained} vs 日志 ${ev.gained}`);
      verify(eq(own.scorecard, ev.scorecard), `第 ${hands + 1} 手 scorecard 不一致`);
      verify(own.nextSeat === ev.nextSeat, `第 ${hands + 1} 手 nextSeat 不一致`);
      actions.push({ action: 'score', category: ev.category as Category });
      handDice.push(finalDice);
      hands++;
    } else if (ev.type === 'end') {
      lastResult = ev.result;
    } else if (ev.type === 'chat') {
      continue;
    } else {
      fail(`未知事件类型 ${ev.type}`);
    }
  }

  const replayed = yacht.result(state);
  if (!yacht.isTerminal(state)) {
    console.log(`\n⏸ 日志未包含终局，已重放 ${hands} 手，当前总分 ${JSON.stringify(replayed.scores)}`);
  } else {
    if (lastResult) {
      verify(replayed.winner === lastResult.winner, `终局胜者不一致：重放 ${replayed.winner} vs 日志 ${lastResult.winner}`);
      verify(eq(replayed.scores, lastResult.scores), '终局比分不一致');
    }
    if (hands === 26) {
      for (const seat of [0, 1] as const) {
        verify(isCardFull(state.cards[seat]), `座位 ${seat} 的 13 格应已填满`);
        verify(
          replayed.scores[String(seat)] === summarizeCard(state.cards[seat]).total,
          `座位 ${seat} 的 result.scores 应等于 scorecard.total`,
        );
      }
      console.log(`\n🏁 重放终局：${replayed.text}`);
    }
  }

  // 同 seed + 同动作序列 → 骰面序列可复现（全部断言，重点看前 5 手）
  const again = simulateYacht(log.seed, actions);
  verify(eq(again.rollDice, logRollDice), '同 seed + 同动作序列的第二次回放，掷骰序列不一致');
  verify(eq(again.handDice, handDice), '同 seed + 同动作序列的第二次回放，每手骰面不一致');
  const firstFive = handDice.slice(0, 5);
  const firstFiveAgain = again.handDice.slice(0, 5);
  verify(eq(firstFive, firstFiveAgain), '前 5 手的 dice 序列不一致');
  verify(
    firstFive.length === Math.min(5, hands),
    `前 5 手样本数量应为 ${Math.min(5, hands)}，实际 ${firstFive.length}`,
  );
  verify(
    firstFive.every((dice) => dice.length === 5 && dice.every((face) => face >= 1 && face <= 6)),
    '前 5 手骰面应均为 5 颗 1-6',
  );

  console.log(`  🎲 前 ${firstFive.length} 手终局骰面: ${firstFive.map((dice) => dice.join('')).join(' / ')}`);
  console.log(`  🎲 掷骰序列样本: ${logRollDice.slice(0, 8).map((dice) => dice.join('')).join(' → ')}${logRollDice.length > 8 ? ' → …' : ''}`);
  console.log(
    `\n✅ 回放校验通过：yacht ${hands} 手 / ${logRollDice.length} 次掷骰，同 seed + 同动作序列复现同一骰面序列（比对 ${checks} 项）`,
  );
}

// ───────────────────────────── 猜拳 / 深海猎手 / 黑白棋 ─────────────────────────────

function replayRps(log: RoomLog): void {
  let state = rpsDuel.setup(log.seed);
  let rounds = 0;
  let lastResult: any = null;

  for (const wrapped of log.events) {
    const ev = wrapped.event;
    if (ev.type === 'reveal') {
      verify(ev.shapes && typeof ev.shapes === 'object', 'rps reveal 应带 shapes');
      const r = rpsDuel.step(state, {
        0: { action: 'throw', shape: ev.shapes['0'] },
        1: { action: 'throw', shape: ev.shapes['1'] },
      });
      state = r.state;
      const own = r.events[0] as any;
      verify(eq(own.shapes, ev.shapes), `第 ${rounds + 1} 局出手不一致`);
      verify(own.winner === ev.winner, `第 ${rounds + 1} 局 winner 不一致：重放 ${own.winner} vs 日志 ${ev.winner}`);
      verify(own.points === ev.points, `第 ${rounds + 1} 局分值不一致`);
      verify(eq(own.delta, ev.delta), `第 ${rounds + 1} 局 delta 不一致`);
      verify(eq(own.scores, ev.scores), `第 ${rounds + 1} 局比分不一致`);
      rounds++;
    } else if (ev.type === 'end') {
      lastResult = ev.result;
    } else if (ev.type !== 'chat') {
      fail(`rps 回放遇到未知事件 ${ev.type}`);
    }
  }

  verify(rpsDuel.isTerminal(state), 'rps 回放结束后应为终局');
  const result = rpsDuel.result(state);
  verify(eq(lastResult, result), 'rps 终局结果与日志不一致');
  console.log(`\n✅ 回放校验通过：rps-duel ${rounds} 局，比分 ${result.scores['0']} : ${result.scores['1']}（比对 ${checks} 项）`);
}

function replayBattleship(log: RoomLog): void {
  let state = battleship.setup(log.seed);
  let shots = 0;
  let hits = 0;
  let lastResult: any = null;

  for (const wrapped of log.events) {
    const ev = wrapped.event;
    if (ev.type === 'fire') {
      const seat = battleship.currentSeat?.(state);
      verify(ev.seat === seat, `第 ${shots + 1} 炮座位 ${ev.seat} 与回放当前行动方 ${seat} 不一致（命中连射应保持同座位）`);
      const r = battleship.step(state, { [seat as number]: { action: 'fire', cell: ev.cell } });
      state = r.state;
      const own = r.events[0] as any;
      verify(own.hit === ev.hit, `第 ${shots + 1} 炮 hit 不一致：重放 ${own.hit} vs 日志 ${ev.hit}`);
      verify(own.sunk === ev.sunk, `第 ${shots + 1} 炮 sunk 不一致`);
      verify(own.opponentShipsLeft === ev.opponentShipsLeft, `第 ${shots + 1} 炮 opponentShipsLeft 不一致`);
      verify(own.nextSeat === ev.nextSeat, `第 ${shots + 1} 炮 nextSeat 不一致`);
      shots++;
      if (own.hit) hits++;
    } else if (ev.type === 'end') {
      lastResult = ev.result;
    } else if (ev.type !== 'chat') {
      fail(`battleship 回放遇到未知事件 ${ev.type}`);
    }
  }

  verify(battleship.isTerminal(state), 'battleship 回放结束后应为终局');
  const result = battleship.result(state);
  verify(eq(lastResult, result), 'battleship 终局结果与日志不一致');
  console.log(
    `\n✅ 回放校验通过：battleship ${shots} 炮（命中 ${hits} 次），${result.text}（比对 ${checks} 项）`,
  );
}

function replayReversi(log: RoomLog): void {
  let state = reversi.setup(log.seed);
  let moves = 0;
  let passes = 0;
  let lastResult: any = null;
  const events = log.events;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i].event;
    if (ev.type === 'place') {
      const seat = state.turn;
      verify(ev.seat === seat, `第 ${moves + 1} 手座位 ${ev.seat} 与回放当前行动方 ${seat} 不一致`);
      const r = reversi.step(state, { [seat]: { action: 'place', cell: ev.cell } });
      state = r.state;
      const own = r.events[0] as any;
      verify(eq(own.flips, ev.flips), `第 ${moves + 1} 手翻面集合不一致`);
      verify(eq(own.counts, ev.counts), `第 ${moves + 1} 手子数不一致`);
      // 跳过事件必须和日志同步：内核产生的 pass 应与上一条日志一致
      const ownPass = r.events.find((e: any) => e.type === 'pass') as any;
      const nextLog = events[i + 1]?.event;
      if (ownPass) {
        verify(
          nextLog?.type === 'pass' && nextLog.seat === ownPass.seat,
          `第 ${moves + 1} 手内核判定座位 ${ownPass.seat} 跳过，但日志里没有对应 pass`,
        );
        passes++;
        i++;
      } else {
        verify(nextLog?.type !== 'pass', `第 ${moves + 1} 手日志有 pass，但内核没有跳过`);
      }
      moves++;
    } else if (ev.type === 'end') {
      lastResult = ev.result;
    } else if (ev.type !== 'chat') {
      fail(`reversi 回放遇到未知事件 ${ev.type}`);
    }
  }

  verify(reversi.isTerminal(state), 'reversi 回放结束后应为终局');
  const result = reversi.result(state);
  verify(eq(lastResult, result), 'reversi 终局结果与日志不一致');
  const counts = countDiscs(state.board);
  verify(counts[0] === result.scores['0'] && counts[1] === result.scores['1'], '终局子数应与盘面一致');
  console.log(
    `\n✅ 回放校验通过：reversi ${moves} 手（跳过 ${passes} 次），${counts[0]} : ${counts[1]}（比对 ${checks} 项）`,
  );
}

// ───────────────────────────── 入口 ─────────────────────────────

async function main() {
  const log = await loadLog();
  const args = parseArgs(process.argv.slice(2));
  if (args.game && args.game !== log.gameId) {
    fail(`--game=${args.game} 与日志 gameId=${log.gameId} 不一致`);
  }
  console.log(`🎬 回放房间 ${log.roomId} · game=${log.gameId} · seed=${log.seed} · ${log.events.length} 条事件\n`);

  if (log.gameId === 'grab') replayGrab(log);
  else if (log.gameId === 'connect4') replayConnect4(log);
  else if (log.gameId === 'yacht') replayYacht(log);
  else if (log.gameId === 'rps-duel') replayRps(log);
  else if (log.gameId === 'battleship') replayBattleship(log);
  else if (log.gameId === 'reversi') replayReversi(log);
  else fail(`不支持的游戏 ${log.gameId}（支持 grab / connect4 / yacht / rps-duel / battleship / reversi）`);
}

main().catch((err) => {
  console.error('回放异常：', err);
  process.exit(1);
});
