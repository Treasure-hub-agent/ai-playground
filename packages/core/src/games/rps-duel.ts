import type {
  Action,
  BaseObservation,
  GameEvent,
  GameMeta,
  GameResultSummary,
  GameSpec,
  Seat,
} from '../types.ts';

/** 三种出手。 */
export type Shape = 'rock' | 'paper' | 'scissors';

export const SHAPES: readonly Shape[] = ['rock', 'paper', 'scissors'];
export const RPS_ROUNDS_TOTAL = 3;
/** 每局分值：决胜局翻倍（总分 4）。 */
export const ROUND_POINTS: readonly number[] = [1, 1, 2];

export const SHAPE_LABEL: Record<Shape, string> = {
  rock: '石头',
  paper: '布',
  scissors: '剪刀',
};

export const SHAPE_EMOJI: Record<Shape, string> = {
  rock: '✊',
  paper: '✋',
  scissors: '✌️',
};

/** a 克 b 的对应表。 */
const BEATS: Record<Shape, Shape> = {
  rock: 'scissors',
  paper: 'rock',
  scissors: 'paper',
};

export interface RpsRoundRecord {
  /** 第几局（1-based）。 */
  round: number;
  /** 双方本局出手；只有结算后才进 history，结算前 state 里不存在任何挂起出手。 */
  shapes: { 0: Shape; 1: Shape };
  /** 本局胜者；同出手为 null。 */
  winner: Seat | null;
  /** 本局分值（1 或 2）。 */
  points: number;
  /** 双方本局得分。 */
  delta: { 0: number; 1: number };
  /** 本局结束后的累计比分。 */
  scores: { 0: number; 1: number };
}

export interface RpsState {
  scores: Record<number, number>;
  /** 当前局（1-based）；打完后为 4，判定以 history 长度为准。 */
  round: number;
  history: RpsRoundRecord[];
}

/** 座位相对视角的历史条目（已揭示的局）。 */
export interface RpsHistoryEntry {
  round: number;
  yourShape: Shape;
  opponentShape: Shape;
  outcome: 'win' | 'lose' | 'draw';
  points: number;
  yourDelta: number;
  opponentDelta: number;
  scoreAfter: { you: number; opponent: number };
}

export interface RpsObservation extends BaseObservation {
  history: RpsHistoryEntry[];
  lastRound: RpsHistoryEntry | null;
  /** 每局分值表，供前端画「×2」标记。 */
  roundPoints: number[];
  /** 当前局值多少分；终局为 null。 */
  currentRoundPoints: number | null;
  yourScore: number;
  opponentScore: number;
}

const RULES = `猜拳心理战（Rock-Paper-Scissors Duel）
一句话规则：三局定胜负，每局双方同时暗出手；出手相同不算分，决胜局分数翻倍。

细节：
- 共 3 局。第 1、2 局赢下各得 1 分；第 3 局是决胜局，赢下得 2 分（总分满分 4）。
- 每局双方同时暗出手（石头 / 布 / 剪刀）。先提交的一方看不到对手这一手，结算后一起揭示。
- 石头赢剪刀，剪刀赢布，布赢石头。双方出手相同 = 本局 0:0，谁都不得分，该局照常消耗。
- 三局打完比总分；同分算平局（例如前两局被连赢、决胜局翻盘，比分正好 2:2）。
- 决胜局单独值 2 分：即便前两局 0:2 落后，最后一手仍能追平甚至反超。

动作：{"action":"throw","shape":"rock"}，shape 取 rock（石头）/ paper（布）/ scissors（剪刀）。
可用动作见 legalActions，形如 [{"action":"throw","shape":"rock"}, {"action":"throw","shape":"paper"}, {"action":"throw","shape":"scissors"}]。`;

function isShape(value: unknown): value is Shape {
  return value === 'rock' || value === 'paper' || value === 'scissors';
}

/** 从提交动作里取出出手；非法出手由服务端 legalActions 拦截，这里是最后防线。 */
function readShape(action: Action | undefined): Shape {
  const raw = action?.shape;
  if (!isShape(raw)) throw new Error(`非法出手: ${JSON.stringify(action)}`);
  return raw;
}

/** a 对 b 的结果：1 = a 赢，-1 = a 输，0 = 平。 */
export function compareShapes(a: Shape, b: Shape): -1 | 0 | 1 {
  if (a === b) return 0;
  return BEATS[a] === b ? 1 : -1;
}

export const rpsDuel: GameSpec<RpsState, RpsObservation> = {
  meta: {
    id: 'rps-duel',
    name: '猜拳心理战',
    tagline: '读招、诈唬、连赌三局，决胜局翻倍看谁先崩',
    seats: 2,
    rules: RULES,
    category: '派对',
    tags: ['同时暗选', '心理战', '极短'],
    duration: '30–60 秒',
    status: 'playable',
    accent: '#a259c4',
    resolution: 'simultaneous',
  } satisfies GameMeta,

  setup(_seed: number): RpsState {
    // 猜拳不含任何随机因素：胜负完全取决于双方出手，seed 只是内核通用签名。
    return { scores: { 0: 0, 1: 0 }, round: 1, history: [] };
  },

  legalActions(state: RpsState, _seat: Seat): Action[] {
    if (rpsDuel.isTerminal(state)) return [];
    return SHAPES.map((shape) => ({ action: 'throw', shape }));
  },

  step(state: RpsState, actions: Record<Seat, Action>) {
    const shapes = { 0: readShape(actions[0]), 1: readShape(actions[1]) } as {
      0: Shape;
      1: Shape;
    };
    const verdict = compareShapes(shapes[0], shapes[1]);
    const winner: Seat | null = verdict === 0 ? null : verdict === 1 ? 0 : 1;
    const points = ROUND_POINTS[state.round - 1] ?? 0;
    const delta = {
      0: winner === 0 ? points : 0,
      1: winner === 1 ? points : 0,
    } as { 0: number; 1: number };
    const scores = {
      0: state.scores[0] + delta[0],
      1: state.scores[1] + delta[1],
    } as { 0: number; 1: number };

    const record: RpsRoundRecord = {
      round: state.round,
      shapes,
      winner,
      points,
      delta,
      scores,
    };
    const next: RpsState = {
      scores,
      round: state.round + 1,
      history: [...state.history, record],
    };

    const events: GameEvent[] = [
      {
        type: 'reveal',
        round: record.round,
        shapes,
        winner,
        points,
        delta,
        scores,
        labels: { 0: SHAPE_LABEL[shapes[0]], 1: SHAPE_LABEL[shapes[1]] },
      },
    ];
    if (rpsDuel.isTerminal(next)) {
      events.push({ type: 'end', result: rpsDuel.result(next) });
    }
    return { state: next, events };
  },

  isTerminal(state: RpsState): boolean {
    return state.history.length >= RPS_ROUNDS_TOTAL;
  },

  result(state: RpsState): GameResultSummary {
    const s0 = state.scores[0];
    const s1 = state.scores[1];
    const winner = s0 === s1 ? null : s0 > s1 ? 0 : 1;
    const line = state.history
      .map((r) => `第${r.round}局 ${SHAPE_LABEL[r.shapes[0]]} vs ${SHAPE_LABEL[r.shapes[1]]}`)
      .join(' · ');
    const head = winner === null ? `平局！${s0} : ${s1}` : `座位 ${winner} 获胜！${s0} : ${s1}`;
    return {
      winner,
      scores: { ...state.scores },
      text: `${head}（${line}）`,
    };
  },

  observe(state: RpsState, seat: Seat | null): RpsObservation {
    // 旁观者没有座位：座位相对字段按「座位 0 视角」呈现，前端用 spectator 标记把标签改成「座位 0 / 座位 1」。
    const viewer = (seat ?? 0) as 0 | 1;
    const opponent = (1 - viewer) as 0 | 1;
    const ended = rpsDuel.isTerminal(state);
    const played = state.history.length;

    // 座位相对视角的历史：只含已揭示的局，未结算的本局不出现在任何字段里。
    const history: RpsHistoryEntry[] = state.history.map((r) => {
      const mine = r.shapes[viewer];
      const theirs = r.shapes[opponent];
      const myDelta = r.delta[viewer];
      const theirDelta = r.delta[opponent];
      return {
        round: r.round,
        yourShape: mine,
        opponentShape: theirs,
        outcome: myDelta > theirDelta ? 'win' : myDelta < theirDelta ? 'lose' : 'draw',
        points: r.points,
        yourDelta: myDelta,
        opponentDelta: theirDelta,
        scoreAfter: { you: r.scores[viewer], opponent: r.scores[opponent] },
      };
    });

    return {
      gameId: rpsDuel.meta.id,
      seat,
      // 结束后显示「已打的局数」，避免出现「第 4/3 局」这种错位。
      round: ended ? played : Math.min(played + 1, RPS_ROUNDS_TOTAL),
      roundsTotal: RPS_ROUNDS_TOTAL,
      scores: { ...state.scores },
      // 旁观者不能行动：legalActions 恒为空。
      legalActions: seat !== null && !ended ? rpsDuel.legalActions(state, seat) : [],
      textView: buildRpsTextView(state, seat),
      status: ended ? 'ended' : 'playing',
      history,
      lastRound: history.length > 0 ? history[history.length - 1] : null,
      roundPoints: [...ROUND_POINTS],
      currentRoundPoints: ended ? null : ROUND_POINTS[Math.min(played, RPS_ROUNDS_TOTAL - 1)],
      yourScore: state.scores[viewer],
      opponentScore: state.scores[opponent],
    };
  },
};

export function buildRpsTextView(state: RpsState, seat: Seat | null): string {
  // 旁观时用中性称呼（座位 0 / 座位 1）：写「你 / 对手」会让旁观者误以为自己有座位。
  const spectator = seat === null;
  const viewer = (seat ?? 0) as 0 | 1;
  const opponent = (1 - viewer) as 0 | 1;
  const ended = rpsDuel.isTerminal(state);
  const played = state.history.length;
  const lines: string[] = [];
  const prefix = spectator ? '旁观视图 · ' : '';
  const scoreLine = spectator
    ? `座位 0 ${state.scores[0]} : ${state.scores[1]} 座位 1`
    : `你 ${state.scores[viewer]} : ${state.scores[opponent]} 对手`;

  if (ended) {
    lines.push(`${prefix}🏁 三局已打完 · ${scoreLine}`);
  } else {
    const roundNo = Math.min(played + 1, RPS_ROUNDS_TOTAL);
    const worth = ROUND_POINTS[roundNo - 1];
    const tag = worth === 2 ? '决胜局，赢下得 2 分' : `本局值 ${worth} 分`;
    lines.push(`${prefix}第 ${roundNo}/${RPS_ROUNDS_TOTAL} 局（${tag}）· ${scoreLine}`);
  }

  if (played === 0) {
    lines.push('还没有历史，这是第一局。');
  } else {
    lines.push('历史：');
    for (const r of state.history) {
      const mine = SHAPE_LABEL[r.shapes[viewer]];
      const theirs = SHAPE_LABEL[r.shapes[opponent]];
      const tag = spectator
        ? r.winner === null
          ? '平局'
          : `座位 ${r.winner} 赢 +${r.delta[r.winner as 0 | 1]}`
        : r.winner === null
          ? '平'
          : r.winner === viewer
            ? `你赢 +${r.delta[viewer]}`
            : `你输 +${r.delta[opponent]}（对手）`;
      lines.push(
        spectator
          ? `  第 ${r.round} 局（值 ${r.points} 分）：座位 0 ${SHAPE_LABEL[r.shapes[0]]} vs 座位 1 ${SHAPE_LABEL[r.shapes[1]]} → ${tag}`
          : `  第 ${r.round} 局（值 ${r.points} 分）：你 ${mine} vs 对手 ${theirs} → ${tag}`,
      );
    }
  }

  if (ended) {
    const s0 = state.scores[0];
    const s1 = state.scores[1];
    const verdict =
      s0 === s1 ? `平局（${s0} : ${s1}）` : `${s0 > s1 ? '座位 0' : '座位 1'} 获胜（${s0} : ${s1}）`;
    lines.push(`对局已结束：${verdict}。可调用 get_result / export_log 查看结算与复盘。`);
  } else if (spectator) {
    lines.push('对局进行中：双方本局正在同时暗出手，旁观视图看不到未揭示的出手。');
  } else {
    lines.push('动作：{"action":"throw","shape":"rock"|"paper"|"scissors"}（石头 / 布 / 剪刀）。');
    lines.push('本局还没结算：选一个合法出手提交，双方都提交后一起揭示。');
  }
  return lines.join('\n');
}

export default rpsDuel;
