import { useCallback, useSyncExternalStore } from 'react';
import { audioManager, getAudioManager } from './AudioManager';
import type { AudioSnapshot, SfxId, SfxOptions } from './audioTypes';

export interface AudioHookState extends AudioSnapshot {
  toggleBgm: () => void;
  setBgmEnabled: (value: boolean) => void;
  setVolume: (value: number) => void;
}

/**
 * 订阅 AudioManager 的全局状态（BGM 开关 / 音量 / 当前曲目 / 播放状态）。
 * 任何组件都可以调用，单例状态在所有组件间共享。
 */
export function useAudioManager(): AudioHookState {
  const manager = getAudioManager();
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getServerSnapshot);
  return {
    ...snapshot,
    toggleBgm: manager.toggleBgm,
    setBgmEnabled: manager.setBgmEnabled,
    setVolume: manager.setVolume,
  };
}

/**
 * 返回稳定的 SFX 播放函数：
 *   const play = useSfx();
 *   play('dice-roll');
 */
export function useSfx(): (id: SfxId, options?: SfxOptions) => void {
  const manager = getAudioManager();
  return useCallback((id: SfxId, options?: SfxOptions) => manager.playSfx(id, options), [manager]);
}

/** 便捷别名：某些界面里更习惯 useSoundEffect 的命名 */
export const useSoundEffect = useSfx;

/** 非 Hook 场景可直接调用 */
export { audioManager, getAudioManager };
export type { AudioSnapshot, SfxId, SfxOptions };
