import type { CSSProperties } from 'react';
import { useAudioManager, useSfx } from '../audio/useAudio';
import '../styles/audio.css';

interface SpeakerIconProps {
  muted?: boolean;
  size?: number;
}

/** 与 components/Icons.tsx 同一套线条语言：24 网格、currentColor、圆头描边 */
function SpeakerIcon({ muted = false, size = 17 }: SpeakerIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4.6 9.4h3.1l4.1-3.4c.5-.4 1.2 0 1.2.6v10.8c0 .6-.7 1-1.2.6l-4.1-3.4H4.6z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      {muted ? (
        <path d="M16.4 9.6l4.2 4.8M20.6 9.6l-4.2 4.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      ) : (
        <>
          <path d="M16.2 9.2a4.1 4.1 0 0 1 0 5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M18.9 6.8a7.4 7.4 0 0 1 0 10.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity=".55" />
        </>
      )}
    </svg>
  );
}

/**
 * 大厅右上角的音频控件：BGM 开关 + 主音量滑块。
 * 未收到首次用户交互前不会响（浏览器 autoplay 策略）；
 * manifest 缺失时控件仍可用，只是没有 BGM，SFX 走合成兜底。
 */
export function AudioControls({ className = '', compact = false }: { className?: string; compact?: boolean }) {
  const { enabled, volume, playing, currentTrack, manifestState, bgmCount, toggleBgm, setVolume } = useAudioManager();
  const playSfx = useSfx();
  const percent = Math.round(volume * 100);
  const muted = !enabled || percent === 0;

  let tipTitle = '背景音乐已关闭';
  let tipSub = '点一下扬声器重新打开';
  if (enabled && currentTrack) {
    tipTitle = currentTrack.title;
    tipSub = [currentTrack.author, currentTrack.license].filter(Boolean).join(' · ') || '正在播放';
  } else if (enabled && manifestState === 'loading') {
    tipTitle = '正在加载音乐…';
    tipSub = '素材就位后会自动播放';
  } else if (enabled && manifestState === 'missing') {
    tipTitle = '暂无 BGM 素材';
    tipSub = '音效使用 WebAudio 合成兜底';
  } else if (enabled && bgmCount === 0) {
    tipTitle = '暂无 BGM';
    tipSub = '音效使用 WebAudio 合成兜底';
  } else if (enabled) {
    tipTitle = muted ? '已静音' : '音乐待播放';
    tipSub = '点一下页面任意处即可开始';
  }

  return (
    <div
      className={`audio-controls ${enabled ? 'is-on' : 'is-muted'} ${playing && enabled ? 'is-playing' : ''} ${compact ? 'is-compact' : ''} ${className}`.trim()}
      data-manifest={manifestState}
      role="group"
      aria-label={`音频控制 · ${
        !enabled ? '背景音乐已关闭' : playing ? `正在播放${currentTrack ? ` ${currentTrack.title}` : ''}` : '背景音乐待播放'
      }`}
    >
      <button
        type="button"
        className="audio-toggle"
        aria-label={enabled ? '关闭背景音乐' : '开启背景音乐'}
        aria-pressed={enabled}
        title={enabled ? '关闭背景音乐' : '开启背景音乐'}
        onClick={() => {
          playSfx('click');
          toggleBgm();
        }}
      >
        <SpeakerIcon muted={muted} />
        <span className="audio-eq" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </button>

      <span className="audio-divider" aria-hidden="true" />

      <input
        className="audio-range"
        type="range"
        min={0}
        max={100}
        step={1}
        value={percent}
        aria-label="音量"
        title={`音量 ${percent}%`}
        style={{ '--audio-fill': `${percent}%` } as CSSProperties}
        onChange={(event) => setVolume(Number(event.target.value) / 100)}
        onPointerUp={() => playSfx('click', { volume: 0.5 })}
      />
      <span className="audio-value" aria-hidden="true">
        {percent}
      </span>

      <span className="audio-tip" role="tooltip">
        <b>{tipTitle}</b>
        <span>{tipSub}</span>
      </span>
    </div>
  );
}


