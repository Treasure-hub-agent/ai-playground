import type { RevealEvent, RoomStatus } from '../types';
import { formatDelta } from '../utils';
import { AgentAvatar, HumanAvatar } from './Icons';

interface ScoreBarProps {
  scores: Record<string, number>;
  round: number;
  roundsTotal: number;
  status: RoomStatus;
  /** 本回合我是否已经「交过了」（同时暗选）或「轮到对方」（轮流制） */
  youSubmitted: boolean;
  connected: boolean;
  reveal: RevealEvent | null;
  resultShown: boolean;
  mode?: 'simultaneous' | 'turn';
  showScores?: boolean;
  unitLabel?: string;
  /** 比分单位（默认「分」；深海猎手用「艘」、黑白棋用「子」） */
  scoreUnit?: string;
  /** 轮到玩家时的动作文案（不同游戏动词不同：落子 / 掷骰） */
  turnLabel?: string;
  /** 等对手时的文案 */
  waitLabel?: string;
  /** 旁观模式：没有座位令牌，计分条不要把「等 Agent」当成自己在等 */
  spectator?: boolean;
}

function deltaOf(reveal: RevealEvent | null, seat: number): number {
  if (!reveal) return 0;
  return reveal.delta[String(seat)] ?? 0;
}

export function ScoreBar({
  scores,
  round,
  roundsTotal,
  status,
  youSubmitted,
  connected,
  reveal,
  resultShown,
  mode = 'simultaneous',
  showScores = true,
  unitLabel = '回合',
  scoreUnit = '分',
  turnLabel,
  waitLabel,
  spectator = false,
}: ScoreBarProps) {
  const you = scores['0'] ?? 0;
  const agent = scores['1'] ?? 0;
  const doneRounds = reveal ? reveal.round : Math.min(round - 1, roundsTotal);
  // 揭示中要显示「刚揭晓的这一回合」：applyReveal 会把观测的 round 提前 +1，
  // 直接拿 round 显示会出现「左上第 4 回合、揭示条第 3 回合」的自相矛盾。
  const displayRound = reveal ? reveal.round : Math.min(round, roundsTotal);
  const isTurn = mode === 'turn';

  let turnText = turnLabel ?? '轮到你出招';
  let turnTone = 'is-turn';
  if (spectator) {
    // 旁观者不是「在等 Agent」，他就是不能出手
    turnText = '旁观中';
    turnTone = 'is-waiting';
  } else if (resultShown || status === 'ended') {
    turnText = '对局结束';
    turnTone = 'is-over';
  } else if (reveal) {
    turnText = '揭示中…';
    turnTone = 'is-reveal';
  } else if (!connected && status === 'playing') {
    turnText = '重连中…';
    turnTone = 'is-offline';
  } else if (status === 'waiting') {
    turnText = '等 Agent 入座';
    turnTone = 'is-waiting';
  } else if (youSubmitted) {
    turnText = waitLabel ?? (isTurn ? '等 Agent 落子' : '已密封，等 Agent');
    turnTone = 'is-waiting';
  }

  return (
    <div className="scorebar">
      <div className={`player-chip ${turnTone === 'is-turn' ? 'is-active' : ''}`}>
        <span className="player-avatar">
          <HumanAvatar size={24} />
        </span>
        <div className="player-info">
          <span className="player-tag">seat 0 · 人类</span>
          <span className="player-name">{spectator ? '座位 0' : '你'}</span>
        </div>
        {showScores && (
          <div className="player-score-wrap">
            <span className="player-score">{you}</span>
            <span className="player-score-unit">{scoreUnit}</span>
            {reveal && deltaOf(reveal, 0) !== 0 && (
              <span
                key={`you-${reveal.round}`}
                className={`delta-float ${deltaOf(reveal, 0) > 0 ? 'is-plus' : 'is-minus'}`}
              >
                {formatDelta(deltaOf(reveal, 0))}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="round-center">
        <span className="round-chip">
          第 {displayRound} {unitLabel}
        </span>
        {!isTurn && (
          <div className="round-dots" aria-hidden="true">
            {Array.from({ length: roundsTotal }, (_, index) => (
              <i key={index} className={index < doneRounds ? 'is-done' : ''} />
            ))}
          </div>
        )}
        <span className={`turn-state ${turnTone}`}>
          <i className={`online-dot ${connected ? 'is-on' : 'is-off'}`} aria-hidden="true" />
          {turnText}
        </span>
      </div>

      <div className={`player-chip player-agent ${turnTone === 'is-waiting' ? 'is-active' : ''}`}>
        <span className="player-avatar player-avatar-agent">
          <AgentAvatar size={24} />
        </span>
        <div className="player-info">
          <span className="player-tag">seat 1 · AI</span>
          <span className="player-name">{spectator ? '座位 1' : 'Agent'}</span>
        </div>
        {showScores && (
          <div className="player-score-wrap">
            <span className="player-score">{agent}</span>
            <span className="player-score-unit">{scoreUnit}</span>
            {reveal && deltaOf(reveal, 1) !== 0 && (
              <span
                key={`agent-${reveal.round}`}
                className={`delta-float ${deltaOf(reveal, 1) > 0 ? 'is-plus' : 'is-minus'}`}
              >
                {formatDelta(deltaOf(reveal, 1))}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
