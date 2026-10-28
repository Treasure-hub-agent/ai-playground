/**
 * 音频层的公共类型与常量。
 * 运行时 URL 约定：manifest 与素材都从 `<BASE_URL>audio/` 下取。
 */

export const SFX_IDS = [
  'dice-roll',
  'dice-land',
  'hold-on',
  'hold-off',
  'score',
  'reveal',
  'win',
  'lose',
  'click',
] as const;

export type SfxId = (typeof SFX_IDS)[number];

export interface SfxOptions {
  /** 播放速率（0.5–2），dice-roll 默认带一点随机抖动 */
  rate?: number;
  /** 单次音量倍率（0–1），最终还会乘以全局音量 */
  volume?: number;
}

export interface BgmTrack {
  id: string;
  file: string;
  title: string;
  author: string;
  license?: string;
  licenseUrl?: string;
  sourceUrl?: string;
  durationSec?: number;
}

export interface SfxTrack {
  id: SfxId;
  file: string;
  license?: string;
  licenseUrl?: string;
  sourceUrl?: string;
}

export type ManifestState = 'loading' | 'ready' | 'missing';

export interface AudioSnapshot {
  /** BGM 开关（localStorage 记忆） */
  enabled: boolean;
  /** 主音量 0–1（localStorage 记忆，同时作用于 BGM 与 SFX） */
  volume: number;
  /** 是否已经收到过首次用户交互（绕过 autoplay 限制） */
  unlocked: boolean;
  manifestState: ManifestState;
  bgmCount: number;
  sfxCount: number;
  currentTrack: BgmTrack | null;
  playing: boolean;
}

export interface NormalizedManifest {
  bgm: BgmTrack[];
  sfx: SfxTrack[];
}
