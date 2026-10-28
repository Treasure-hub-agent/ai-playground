import type { CellCoord, GridCell, LegalAction, RevealEvent } from '../types';
import { coordKey, isCoin } from '../utils';
import { BombIcon, CoinIcon, EmptyIcon, LockIcon } from './Icons';

interface BoardProps {
  grid: GridCell[][];
  legalActions: LegalAction[];
  disabled: boolean;
  reveal: RevealEvent | null;
  yourPick: CellCoord | null;
  onPick: (cell: CellCoord) => void;
}

function pickKey(reveal: RevealEvent | null, seat: 0 | 1): string | null {
  if (!reveal) return null;
  const pick = reveal.picks[String(seat)];
  return Array.isArray(pick) ? coordKey(pick as CellCoord) : null;
}

function cellAriaLabel(row: number, col: number, cell: GridCell): string {
  const position = `第 ${row + 1} 行第 ${col + 1} 列`;
  if (isCoin(cell)) return `${position}，金币 ${cell} 分`;
  if (cell === 'bomb') return `${position}，炸弹，扣 2 分`;
  if (cell === 'empty') return `${position}，空格`;
  return `${position}，已被抢走`;
}

function CellFace({ cell }: { cell: GridCell }) {
  if (isCoin(cell)) {
    return (
      <span className="cell-face cell-face-coin">
        <CoinIcon size={36} />
        <span className="coin-value">+{cell}</span>
      </span>
    );
  }
  if (cell === 'bomb') {
    return (
      <span className="cell-face cell-face-bomb">
        <BombIcon size={32} />
        <span className="bomb-value">−2</span>
      </span>
    );
  }
  if (cell === 'empty') {
    return (
      <span className="cell-face cell-face-empty">
        <EmptyIcon size={28} />
      </span>
    );
  }
  return (
    <span className="cell-face cell-face-taken">
      <span className="taken-mark" aria-hidden="true">
        ✕
      </span>
      <span className="taken-text">已抢走</span>
    </span>
  );
}

export function Board({ grid, legalActions, disabled, reveal, yourPick, onPick }: BoardProps) {
  const legalSet = new Set(legalActions.map((action) => coordKey(action.cell)));
  const yourRevealKey = pickKey(reveal, 0);
  const agentRevealKey = pickKey(reveal, 1);
  const collisionKey = reveal?.collision ? yourRevealKey : null;

  return (
    <div className={`board ${reveal ? 'is-revealing' : ''} ${collisionKey ? 'is-collision' : ''}`}>
      <div className="board-grid">
        {grid.map((row, rowIndex) =>
          row.map((cell, colIndex) => {
            const cellCoord: CellCoord = [rowIndex, colIndex];
            const key = coordKey(cellCoord);
            const legal = legalSet.has(key);
            const isYou = yourRevealKey === key;
            const isAgent = agentRevealKey === key;
            const isCollision = collisionKey === key;
            const isYourPending = !reveal && yourPick !== null && coordKey(yourPick) === key;
            const interactive = legal && !disabled;
            const classes = [
              'board-cell',
              `cell-${cell === 'taken' ? 'taken' : cell}`,
              legal && !disabled ? 'is-legal' : '',
              interactive ? 'is-interactive' : '',
              isYou ? 'is-picked-you' : '',
              isAgent ? 'is-picked-agent' : '',
              isCollision ? 'is-picked-collision' : '',
              isYourPending ? 'is-pending-you' : '',
            ]
              .filter(Boolean)
              .join(' ');

            return (
              <button
                key={key}
                type="button"
                className={classes}
                style={{ ['--i' as string]: rowIndex * 3 + colIndex }}
                aria-label={cellAriaLabel(rowIndex, colIndex, cell)}
                disabled={!interactive}
                onClick={() => onPick(cellCoord)}
              >
                <span className="cell-inner">
                  <CellFace cell={cell} />
                  {isYourPending && (
                    <span className="pending-chip" title="你已经选好了这一格">
                      <LockIcon size={11} /> 已选
                    </span>
                  )}
                  {(isYou || isAgent) && (
                    <span className="pick-badges">
                      {isYou && <span className="pick-badge pick-badge-you">你</span>}
                      {isAgent && <span className="pick-badge pick-badge-agent">AI</span>}
                    </span>
                  )}
                  {isCollision && (
                    <span className="collision-burst" aria-hidden="true">
                      撞车
                    </span>
                  )}
                </span>
              </button>
            );
          }),
        )}
      </div>

      {reveal && (
        <div className={`reveal-flash ${reveal.collision ? 'is-collision' : ''}`} aria-hidden="true" />
      )}
    </div>
  );
}
