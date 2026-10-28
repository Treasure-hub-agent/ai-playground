import { BoardShell } from '../BoardShell';
import type { CellCoord, Connect4Observation } from '../../types';

interface Connect4BoardProps {
  obs: Connect4Observation;
  disabled: boolean;
  onPick: (cell: CellCoord) => void;
}

const COLS = 7;

function seatClass(cell: number): string {
  if (cell === 1) return 'is-p0';
  if (cell === 2) return 'is-p1';
  return 'is-empty';
}

/**
 * 四子棋棋盘：操作逻辑对齐实体玩法 —— 点「列」落子，而不是点某一格。
 * 棋盘本身只负责显示，落子按钮在顶部一行。
 */
export function Connect4Board({ obs, disabled, onPick }: Connect4BoardProps) {
  const legalCols = new Set(obs.legalActions.map((action) => action.column));
  const last = obs.history.length ? obs.history[obs.history.length - 1] : null;
  const cols = obs.board[0]?.length ?? COLS;
  // 七列里还能落几列：比「第 N 手」直观，也顺手提醒哪些列已经满了
  const canPlay = !disabled && obs.isYourTurn !== false;

  return (
    <BoardShell
      label="四子棋"
      kicker="点顶部箭头选列，棋子落最底"
      meta={
        canPlay && legalCols.size > 0 ? (
          <span className="board-chip">
            可落 <b>{legalCols.size}</b> 列
          </span>
        ) : (
          <span className="board-chip">{obs.status === 'ended' ? '终局' : '等待对手'}</span>
        )
      }
    >
      <div className="c4-wrap">
        <div className="c4-drops" aria-hidden={false}>
          {Array.from({ length: cols }, (_, column) => {
            const legal = legalCols.has(column) && !disabled;
            return (
              <button
                key={column}
                type="button"
                className={`c4-drop ${legal ? 'is-legal' : ''}`}
                disabled={!legal}
                aria-label={`在第 ${column + 1} 列落子`}
                onClick={() => onPick([0, column])}
              >
                <span aria-hidden="true">↓</span>
              </button>
            );
          })}
        </div>

        <div className="c4-board" role="grid" aria-label="四子棋棋盘">
          {obs.board.map((row, r) =>
            row.map((cell, c) => {
              const isLast = last !== null && last.row === r && last.column === c;
              return (
                <div
                  key={`${r}-${c}`}
                  role="gridcell"
                  className={`c4-cell ${seatClass(cell)} ${isLast ? 'is-last' : ''}`}
                  aria-label={`第 ${r + 1} 行第 ${c + 1} 列${cell === 1 ? '，你的棋子' : cell === 2 ? '，Agent 的棋子' : '，空'}`}
                >
                  <span className="c4-disc" aria-hidden="true" />
                </div>
              );
            }),
          )}
        </div>

        <p className="c4-legend">
          <span className="c4-dot is-p0" aria-hidden="true" /> 你
          <span className="c4-dot is-p1" aria-hidden="true" /> Agent · 先连成四子者胜
        </p>
      </div>
    </BoardShell>
  );
}
