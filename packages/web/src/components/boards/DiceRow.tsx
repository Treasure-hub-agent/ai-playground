/**
 * 平面骰子行：3D 不可用时的降级形态，也用于「减少动效」偏好。
 * 交互与 3D 版保持一致：点一颗 = 切换这颗的锁定。
 */
import { DiceFace } from './DiceFace';

export interface DiceRowProps {
  dice: number[];
  held: boolean[];
  canHold: boolean;
  onToggleHold: (index: number) => void;
}

export function DiceRow({ dice, held, canHold, onToggleHold }: DiceRowProps) {
  return (
    <div className={`dice-row ${canHold ? 'is-interactive' : ''}`}>
      {dice.map((value, index) => (
        <button
          key={index}
          type="button"
          className={`dice-row-item ${held[index] ? 'is-held' : ''} ${value ? '' : 'is-blank'}`}
          onClick={() => canHold && onToggleHold(index)}
          disabled={!canHold}
          aria-pressed={!!held[index]}
          aria-label={`第 ${index + 1} 颗${value ? `，${value} 点` : '，未掷'}${held[index] ? '，已锁定' : ''}`}
          title={canHold ? (held[index] ? '点一下解锁' : '点一下锁定这颗') : undefined}
        >
          <DiceFace value={value} held={held[index]} />
          <span className="dice-row-pin" aria-hidden="true">
            {held[index] ? '锁' : ''}
          </span>
        </button>
      ))}
    </div>
  );
}

export default DiceRow;
