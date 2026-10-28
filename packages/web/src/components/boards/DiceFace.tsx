/**
 * 平面骰面：3×3 网格排布的点数。
 * 用途：3D 不可用 / 减少动效 / 计分板预览里的小骰子。
 */
import type { CSSProperties } from 'react';

/** 3×3 网格里的点位（0 左上，8 右下）。 */
const PIP_LAYOUT: Record<number, number[]> = {
  1: [4],
  2: [2, 6],
  3: [2, 4, 6],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

export interface DiceFaceProps {
  value: number;
  /** 边长（px），默认由 CSS 里的 --die-size 控制 */
  size?: number;
  held?: boolean;
  dimmed?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** 用 CSS 画的六面骰面（无图片、无依赖）。 */
export function DiceFace({
  value,
  size,
  held = false,
  dimmed = false,
  className = '',
  style,
}: DiceFaceProps) {
  const pips = PIP_LAYOUT[value] ?? PIP_LAYOUT[1];
  const classes = [
    'die-face',
    held ? 'is-held' : '',
    dimmed ? 'is-dimmed' : '',
    value === 0 ? 'is-blank' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span
      className={classes}
      style={{ ...(size ? ({ '--die-size': `${size}px` } as CSSProperties) : {}), ...style }}
      aria-label={value > 0 ? `${value} 点` : '未掷'}
    >
      <span className="die-face-grid" aria-hidden="true">
        {Array.from({ length: 9 }, (_, index) => (
          <span key={index} className={pips.includes(index) ? 'die-pip is-on' : 'die-pip'} />
        ))}
      </span>
    </span>
  );
}
