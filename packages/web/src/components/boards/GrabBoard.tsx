import { Board } from '../Board';
import { BoardShell } from '../BoardShell';
import { isCoin } from '../../utils';
import type { CellCoord, GrabObservation, RevealEvent } from '../../types';

interface GrabBoardProps {
  obs: GrabObservation;
  disabled: boolean;
  reveal: RevealEvent | null;
  yourPick: CellCoord | null;
  onPick: (cell: CellCoord) => void;
}

/** 抢宝大作战棋盘：直接把通用 Board 组件接上观测字段。 */
export function GrabBoard({ obs, disabled, reveal, yourPick, onPick }: GrabBoardProps) {
  // 金币抢完即结束，所以「场上还剩几枚金币」比笼统的进度更能说明还剩几回合
  const coinsLeft = obs.grid.reduce((sum, row) => sum + row.filter(isCoin).length, 0);

  return (
    <BoardShell
      label="抢宝大作战"
      kicker="点一格，双方同时暗选"
      meta={
        <span className="board-chip">
          场上金币 <b>{coinsLeft}</b> 枚
        </span>
      }
    >
      <Board
        grid={obs.grid}
        legalActions={obs.legalActions}
        disabled={disabled}
        reveal={reveal}
        yourPick={yourPick}
        onPick={onPick}
      />
    </BoardShell>
  );
}
