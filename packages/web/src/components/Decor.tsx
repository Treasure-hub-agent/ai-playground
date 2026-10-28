import { useId } from 'react';

export function WhaleMascot({ className = '' }: { className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const bodyId = `whale-body-${uid}`;
  const bellyId = `whale-belly-${uid}`;

  return (
    <svg
      className={`whale-mascot ${className}`}
      viewBox="0 0 260 210"
      role="img"
      aria-label="小鲸鱼接待员"
    >
      <defs>
        <linearGradient id={bodyId} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0%" stopColor="#7cc8ff" />
          <stop offset="100%" stopColor="#3f77f2" />
        </linearGradient>
        <linearGradient id={bellyId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f2fbff" />
          <stop offset="100%" stopColor="#c8ecff" />
        </linearGradient>
      </defs>

      <ellipse cx="132" cy="196" rx="78" ry="10" fill="#262044" opacity="0.12" />

      {/* 水花 */}
      <g className="whale-spout" fill="none" stroke="#8fdcff" strokeWidth="5" strokeLinecap="round">
        <path d="M118 44 C116 32 118 22 126 14" />
        <path d="M136 44 C140 34 146 28 154 24" />
        <circle cx="128" cy="10" r="5" fill="#8fdcff" stroke="none" />
        <circle cx="157" cy="19" r="4" fill="#8fdcff" stroke="none" />
      </g>

      {/* 尾巴 */}
      <path
        d="M62 110 C36 100 20 74 24 54 C48 58 64 78 74 96 Z"
        fill="#3f77f2"
        stroke="#262044"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <path
        d="M62 114 C42 124 32 148 40 162 C58 154 70 136 76 118 Z"
        fill="#5fa2ff"
        stroke="#262044"
        strokeWidth="4"
        strokeLinejoin="round"
      />

      {/* 身体 */}
      <path
        d="M62 108 C62 70 100 44 148 46 C196 48 230 70 236 106 C230 140 196 164 146 164 C98 164 62 146 62 108 Z"
        fill={`url(#${bodyId})`}
        stroke="#262044"
        strokeWidth="4.5"
        strokeLinejoin="round"
      />
      <path
        d="M96 132 C116 158 178 164 214 128 C206 150 180 166 148 166 C122 166 104 152 96 132 Z"
        fill={`url(#${bellyId})`}
        stroke="#262044"
        strokeWidth="4"
        strokeLinejoin="round"
      />

      {/* 鱼鳍 */}
      <path
        d="M132 138 C146 150 162 154 176 152 C170 162 150 164 132 156 Z"
        fill="#2f63dc"
        stroke="#262044"
        strokeWidth="4"
        strokeLinejoin="round"
      />

      {/* 派对帽 */}
      <path
        d="M136 50 L154 12 L172 50 Z"
        fill="#ffc93c"
        stroke="#262044"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <circle cx="154" cy="10" r="8" fill="#ff7a6b" stroke="#262044" strokeWidth="4" />
      <path d="M142 41 L163 41" stroke="#ff7a6b" strokeWidth="5" strokeLinecap="round" />

      {/* 脸 */}
      <ellipse cx="196" cy="96" rx="15" ry="16" fill="#ffffff" stroke="#262044" strokeWidth="4" />
      <circle cx="199" cy="98" r="8" fill="#262044" />
      <circle cx="202" cy="94" r="3" fill="#ffffff" />
      <ellipse cx="216" cy="120" rx="12" ry="7" fill="#ffa7bf" opacity="0.85" />
      <ellipse cx="182" cy="124" rx="8" ry="5" fill="#ffa7bf" opacity="0.6" />
      <path
        d="M198 120 C206 130 219 130 226 120"
        fill="none"
        stroke="#262044"
        strokeWidth="4"
        strokeLinecap="round"
      />

      {/* 小气泡 */}
      <g className="whale-bubbles" fill="#d9f4ff" stroke="#262044" strokeWidth="3">
        <circle cx="238" cy="62" r="7" />
        <circle cx="250" cy="44" r="5" />
        <circle cx="232" cy="36" r="4" />
      </g>
    </svg>
  );
}
