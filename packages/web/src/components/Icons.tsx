/**
 * 统一图标层：线条风格 SVG，颜色继承 currentColor。
 * 目的：把界面里散落的 emoji 换成可控的矢量图形，视觉更精致、缩放到高分屏也不糊。
 */
interface IconProps {
  className?: string;
  size?: number;
  strokeWidth?: number;
}

const base = (size: number) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none' });

export function CoinIcon({ className, size = 34, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="8.4" stroke="currentColor" strokeWidth={strokeWidth} fill="rgba(255,206,102,.22)" />
      <circle cx="12" cy="12" r="5.4" stroke="currentColor" strokeWidth={strokeWidth} opacity=".55" />
      <path d="M12 8.6v6.8M10.2 10.3h2.9a1.4 1.4 0 0 1 0 2.8h-2.2a1.4 1.4 0 0 0 0 2.8h3" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

export function BombIcon({ className, size = 34, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <circle cx="11.2" cy="14" r="6.2" stroke="currentColor" strokeWidth={strokeWidth} fill="rgba(27,31,42,.06)" />
      <path d="M15.6 8.4l1.5-1.5M17.1 6.9l1.4-1.4M16.4 9.6h2.2" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
      <circle cx="17.6" cy="6.4" r="1.5" fill="currentColor" opacity=".9" />
    </svg>
  );
}

export function EmptyIcon({ className, size = 30, strokeWidth = 1.6 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M7 12h10" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" opacity=".45" />
    </svg>
  );
}

export function LockIcon({ className, size = 13, strokeWidth = 1.8 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <rect x="5.5" y="10.5" width="13" height="9" rx="2.4" stroke="currentColor" strokeWidth={strokeWidth} />
      <path d="M8.4 10.5V8.6a3.6 3.6 0 0 1 7.2 0v1.9" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  );
}

export function SparkIcon({ className, size = 14 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M12 3.6l1.7 5 5 1.7-5 1.7-1.7 5-1.7-5-5-1.7 5-1.7z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function ArrowIcon({ className, size = 16 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M5 12h13M13 6.8l5.2 5.2L13 17.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function HumanAvatar({ className, size = 34 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path
        d="M4.4 13.2c0-3.4 3.2-6.2 7.6-6.2s7.6 2.8 7.6 6.2c0 2.6-2 4.4-5 4.4-1.4 0-2.6-.4-2.6.8 0 .9.9 1.3.9 2 0 .8-.8 1.3-1.9 1.3-3.7 0-6.6-3.6-6.6-8.5z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        fill="rgba(63,127,214,.12)"
      />
      <circle cx="9.6" cy="12.2" r="1" fill="currentColor" />
      <path d="M15.4 15.6c-1.2 1-2.8 1.2-4.2.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function AgentAvatar({ className, size = 34 }: IconProps) {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <rect x="4.6" y="7.6" width="14.8" height="11" rx="3.4" stroke="currentColor" strokeWidth="1.6" fill="rgba(162,89,196,.12)" />
      <path d="M12 4.4v3.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="3.8" r="1.3" fill="currentColor" />
      <circle cx="9.4" cy="12.4" r="1.15" fill="currentColor" />
      <circle cx="14.6" cy="12.4" r="1.15" fill="currentColor" />
      <path d="M9.8 15.6h4.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity=".7" />
    </svg>
  );
}

/** 大厅卡片的游戏图形（按游戏 id 映射，未登记的回退到骰子）。 */
export function GameGlyph({ gameId, className, size = 44 }: IconProps & { gameId: string }) {
  const common = { ...base(size), className, 'aria-hidden': true } as const;
  switch (gameId) {
    case 'grab':
      return (
        <svg {...common}>
          <circle cx="9.4" cy="14.4" r="5.2" stroke="currentColor" strokeWidth="1.5" fill="rgba(255,206,102,.2)" />
          <circle cx="15.4" cy="9.6" r="5.2" stroke="currentColor" strokeWidth="1.5" fill="rgba(255,206,102,.32)" />
          <path d="M15.4 6.9v5.4M14 8.2h2a1.1 1.1 0 0 1 0 2.2h-1.6a1.1 1.1 0 0 0 0 2.2h2.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    case 'connect4':
      return (
        <svg {...common}>
          <rect x="4.4" y="5.2" width="15.2" height="13.6" rx="3" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="9" cy="10" r="1.5" fill="currentColor" opacity=".85" />
          <circle cx="15" cy="10" r="1.5" fill="currentColor" opacity=".45" />
          <circle cx="9" cy="14.6" r="1.5" fill="currentColor" opacity=".45" />
          <circle cx="15" cy="14.6" r="1.5" fill="currentColor" opacity=".85" />
        </svg>
      );
    case 'battleship':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7.6" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.5" opacity=".6" />
          <path d="M12 4.4v2M12 17.6v2M4.4 12h2M17.6 12h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    case 'yacht':
      return (
        <svg {...common}>
          <rect x="4.4" y="4.4" width="15.2" height="15.2" rx="4.2" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="9" cy="9" r="1.35" fill="currentColor" />
          <circle cx="15" cy="9" r="1.35" fill="currentColor" />
          <circle cx="12" cy="12" r="1.35" fill="currentColor" />
          <circle cx="9" cy="15" r="1.35" fill="currentColor" />
          <circle cx="15" cy="15" r="1.35" fill="currentColor" />
        </svg>
      );
    case 'rps-duel':
      return (
        <svg {...common}>
          <path d="M8.6 15.8c-2-2-2.4-4.6-.8-6.2 1.4-1.4 3.2-1 4.2 0 1-1 2.8-1.4 4.2 0 1.6 1.6 1.2 4.2-.8 6.2-1.6 1.6-3.4 2.4-3.4 2.4s-1.8-.8-3.4-2.4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M12 9.6V6.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity=".55" />
        </svg>
      );
    case 'reversi':
      return (
        <svg {...common}>
          <circle cx="9" cy="12" r="4.2" fill="currentColor" />
          <circle cx="15" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <rect x="4.8" y="4.8" width="14.4" height="14.4" rx="4" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="9.4" cy="9.4" r="1.2" fill="currentColor" />
          <circle cx="14.6" cy="9.4" r="1.2" fill="currentColor" />
          <circle cx="9.4" cy="14.6" r="1.2" fill="currentColor" />
          <circle cx="14.6" cy="14.6" r="1.2" fill="currentColor" />
        </svg>
      );
  }
}


