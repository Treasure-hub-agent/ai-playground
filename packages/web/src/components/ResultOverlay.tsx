import type { GameResultSummary } from '../types';
import { resultHeadline } from '../utils';
import { Dialog } from './Dialog';
import { AgentAvatar, HumanAvatar } from './Icons';

interface ResultOverlayProps {
  result: GameResultSummary;
  roundsPlayed: number;
  replaying: boolean;
  onReplay: () => void;
  onLobby: () => void;
  /** 游戏 id：决定副标题用哪套词 */
  gameId?: string;
  /** 计量单位：回合 / 手 */
  unitLabel?: string;
  /** 比分单位（默认「分」；battleship=艘、reversi=子） */
  scoreUnit?: string;
  /** 是否展示比分（四子棋这类无分游戏只显示结果，避免出现「1 分 : 0 分」） */
  showScores?: boolean;
}

export function ResultOverlay({
  result,
  roundsPlayed,
  replaying,
  onReplay,
  onLobby,
  gameId = 'grab',
  unitLabel = '回合',
  scoreUnit = '分',
  showScores = true,
}: ResultOverlayProps) {
  const headline = resultHeadline(result, gameId);
  const you = result.scores['0'] ?? 0;
  const agent = result.scores['1'] ?? 0;
  const tone = result.winner === 0 ? 'is-win' : result.winner === 1 ? 'is-lose' : 'is-draw';
  const badge = result.winner === 0 ? '你赢了' : result.winner === 1 ? 'Agent 赢了' : '平局';

  const metaText = result.text
    .replace(/座位\s*(\d)/g, (_, seat: string) => (seat === '0' ? '你' : 'Agent'))
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([！!])/g, '$1');
  // 四子棋和深海猎手的 core 文案里已经写了「（共 N 手）/（共 N 炮）」，
  // 前端再拼一次「共 N 手 ·」就是同一句话重复两遍。只在 core 没写时才补。
  const mentionCount = new RegExp(`共\\s*${roundsPlayed}\\b`).test(metaText);

  return (
    <Dialog
      labelledBy="result-title"
      backdropClassName="result-overlay"
      shellClassName="result-card"
      onClose={onLobby}
    >
      <span className={`result-badge ${tone}`}>{badge}</span>
      <h2 id="result-title" className="result-title">
        {headline.title}
      </h2>
      <p className="result-subtitle">{headline.subtitle}</p>

      {showScores && (
        <div className="result-scoreboard">
          <div className={`result-col ${result.winner === 0 ? 'is-winner' : ''}`}>
            <span className="result-avatar">
              <HumanAvatar size={26} />
            </span>
            <span className="result-name">你</span>
            <span className={`result-score ${result.winner === 0 ? 'is-win' : ''}`}>{you}</span>
            <span className="result-unit">{scoreUnit}</span>
          </div>
          <span className="result-colon">:</span>
          <div className={`result-col ${result.winner === 1 ? 'is-winner' : ''}`}>
            <span className="result-avatar">
              <AgentAvatar size={26} />
            </span>
            <span className="result-name">Agent</span>
            <span className={`result-score ${result.winner === 1 ? 'is-win' : ''}`}>{agent}</span>
            <span className="result-unit">{scoreUnit}</span>
          </div>
        </div>
      )}

      <p className="result-meta">
        {mentionCount ? metaText : `共 ${roundsPlayed} ${unitLabel} · ${metaText}`}
      </p>

      <div className="result-actions">
        <button
          type="button"
          className="btn btn-primary btn-lg"
          onClick={onReplay}
          disabled={replaying}
          data-autofocus
        >
          {replaying ? '开桌中…' : '再来一桌'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onLobby} disabled={replaying}>
          回大厅
        </button>
      </div>
    </Dialog>
  );
}
