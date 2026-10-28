/**
 * 黑白棋（reversi）对局界面。
 *
 * 8×8 公开棋盘：合法落点小圆点可点；落子后按 lastMove.flips 播放一次 260ms 翻面动画；
 * 上一手位置带琥珀描边。对手无子可下的 pass 提示由 GameRoom 的统一 toast 处理。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CellCoord, ReversiObservation } from '../../types';
import { BoardShell } from '../BoardShell';
import '../../styles/reversi.css';

export interface ReversiBoardProps {
  obs: ReversiObservation;
  disabled: boolean;
  onPick: (cell: CellCoord) => void;
}

const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const FLIP_ANIMATION_MS = 280;

function keyOf(r: number, c: number): string {
  return `${r},${c}`;
}

function coordLabel(r: number, c: number): string {
  return `${COLS[c] ?? '?'}${r + 1}`;
}

function sameCell(a: CellCoord | null | undefined, r: number, c: number): boolean {
  return Boolean(a && a[0] === r && a[1] === c);
}

export function ReversiBoard({ obs, disabled, onPick }: ReversiBoardProps) {
  const canPlay = !disabled && obs.status === 'playing' && obs.isYourTurn === true;
  const legalSet = useMemo(
    () => new Set(obs.legalActions.map((action) => keyOf(action.cell[0], action.cell[1]))),
    [obs.legalActions],
  );

  const moveKey = obs.lastMove
    ? `${obs.lastMove.move}:${obs.lastMove.seat}:${obs.lastMove.cell[0]},${obs.lastMove.cell[1]}`
    : 'none';
  const lastMoveKeyRef = useRef(moveKey);
  const flipTimerRef = useRef<number | undefined>(undefined);
  const [flipping, setFlipping] = useState<ReadonlySet<string>>(() => new Set());

  // 新的一手：flips 里的棋子做翻面动画；刷新后的历史不做动画。
  useEffect(() => {
    if (moveKey === 'none' || moveKey === lastMoveKeyRef.current) return;
    lastMoveKeyRef.current = moveKey;
    const move = obs.lastMove;
    if (!move) return;
    const next = new Set<string>();
    for (const [r, c] of move.flips) next.add(keyOf(r, c));
    setFlipping(next);
    window.clearTimeout(flipTimerRef.current);
    flipTimerRef.current = window.setTimeout(() => setFlipping(new Set()), FLIP_ANIMATION_MS);
    return () => window.clearTimeout(flipTimerRef.current);
    // 只关心这一手的 key，避免轮询刷新（数组换引用）时重置动画
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveKey]);

  useEffect(
    () => () => {
      window.clearTimeout(flipTimerRef.current);
    },
    [],
  );

  const lastMove = obs.lastMove;
  const lastMoveNewKey = lastMove ? keyOf(lastMove.cell[0], lastMove.cell[1]) : null;

  let lastMoveText = '还没落子，你先手。';
  if (lastMove) {
    lastMoveText = `上一手：${lastMove.seat === 0 ? '你' : 'Agent'} 落 ${coordLabel(
      lastMove.cell[0],
      lastMove.cell[1],
    )} · 翻 ${lastMove.flips.length} 子`;
  }

  let turnText = '等待中';
  if (obs.status === 'ended') turnText = '对局结束';
  else if (obs.isYourTurn === true) turnText = '你的回合';
  else if (obs.isYourTurn === false) turnText = 'Agent 回合';

  return (
    <BoardShell
      className="rv-board"
      label="黑白棋"
      kicker="点小圆点落子，夹住就翻面"
      meta={
        <div className="rv-head-meta">
          <span className={`rv-turn ${obs.isYourTurn === true && obs.status === 'playing' ? 'is-mine' : ''}`}>
            <i className="rv-turn-dot" aria-hidden="true" />
            {turnText}
          </span>
          <span className="rv-legal-count">
            {canPlay ? `${legalSet.size} 个落点` : obs.status === 'ended' ? '终局' : '等待对手'}
          </span>
        </div>
      }
    >
      <div className="rv-info">
        <div className="rv-counts" aria-label={`你 ${obs.yourDiscs} 子，Agent ${obs.opponentDiscs} 子`}>
          <span className="rv-count">
            <i className="rv-mini is-you" aria-hidden="true" />
            你 <b>{obs.yourDiscs}</b> 子
          </span>
          <span className="rv-count is-opp">
            <i className="rv-mini is-opp" aria-hidden="true" />
            Agent <b>{obs.opponentDiscs}</b> 子
          </span>
        </div>
        <span className="rv-last-move">{lastMoveText}</span>
      </div>

      <div className="rv-board-frame">
        <div className="rv-grid" role="group" aria-label="黑白棋棋盘，8 乘 8">
          {obs.board.map((row, r) =>
            row.map((disc, c) => {
              const legal = canPlay && legalSet.has(keyOf(r, c));
              const isLast = lastMove?.seat !== undefined && sameCell(lastMove?.cell, r, c);
              const isNew = Boolean(lastMoveNewKey === keyOf(r, c));
              const isFlipping = flipping.has(keyOf(r, c)) && !isNew;
              const label =
                disc === null
                  ? `${coordLabel(r, c)}，空位${legal ? '，可落子' : '，不可落子'}`
                  : `${coordLabel(r, c)}，${disc === 0 ? '你的' : 'Agent 的'}棋子${isLast ? '，上一手' : ''}`;
              return (
                <button
                  key={keyOf(r, c)}
                  type="button"
                  className={[
                    'rv-cell',
                    legal ? 'is-legal' : '',
                    isLast ? 'is-last' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  disabled={!legal}
                  onClick={() => onPick([r, c])}
                  aria-label={label}
                  title={coordLabel(r, c)}
                >
                  {disc === null && legal && <span className="rv-hint" aria-hidden="true" />}
                  {disc !== null && (
                    <span
                      className={[
                        'rv-disc',
                        disc === 0 ? 'is-you' : 'is-opp',
                        isNew ? 'is-new' : '',
                        isFlipping ? 'is-flipping' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      aria-hidden="true"
                    />
                  )}
                </button>
              );
            }),
          )}
        </div>
      </div>

      <div className="rv-legend" aria-hidden="true">
        <span>
          <i className="rv-mini is-you" /> 你
        </span>
        <span>
          <i className="rv-mini is-opp" /> Agent
        </span>
        <span className="rv-legend-hint">小圆点 = 可落子 · 琥珀边框 = 上一手</span>
      </div>
    </BoardShell>
  );
}

export default ReversiBoard;
