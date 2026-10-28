import {
  SFX_IDS,
  type AudioSnapshot,
  type BgmTrack,
  type ManifestState,
  type NormalizedManifest,
  type SfxId,
  type SfxOptions,
  type SfxTrack,
} from './audioTypes';
import { SynthEngine } from './synth';

/**
 * AudioManager（单例）
 * ------------------------------------------------------------------
 * - 预加载 `<BASE_URL>audio/manifest.json`；缺失 / 404 时静默降级
 * - BGM：随机洗牌轮播、不重复、两路淡入淡出交叉切换、visibility 暂停
 * - BGM 开关 + 主音量写 localStorage，跨标签页同步
 * - SFX：每次播放独立 Audio，可叠音；manifest 缺文件时用 WebAudio 合成兜底
 * - autoplay：首次 pointerdown / keydown / touchstart 后才真正播放
 */

const STORAGE_BGM = 'ai-playground.audio.bgm';
const STORAGE_VOLUME = 'ai-playground.audio.volume';
const DEFAULT_VOLUME = 0.55;
const BGM_GAIN_SCALE = 0.62;
const CROSSFADE_MS = 1600;
const MANIFEST_RETRIES = 2;
const MANIFEST_RETRY_DELAY_MS = 5000;

const SFX_ID_SET: ReadonlySet<string> = new Set(SFX_IDS);

/** 兼容 audio-scout 可能产出的短 id（任务书两版契约不完全一致） */
const SFX_ALIASES: Record<string, SfxId> = {
  roll: 'dice-roll',
  'dice-roll': 'dice-roll',
  dice_roll: 'dice-roll',
  diceroll: 'dice-roll',
  land: 'dice-land',
  'dice-land': 'dice-land',
  dice_land: 'dice-land',
  diceland: 'dice-land',
  'hold-on': 'hold-on',
  hold_on: 'hold-on',
  holdon: 'hold-on',
  'hold-off': 'hold-off',
  hold_off: 'hold-off',
  holdoff: 'hold-off',
  score: 'score',
  reveal: 'reveal',
  win: 'win',
  lose: 'lose',
  click: 'click',
};

const BASE_URL = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');

function assetUrl(file: string): string {
  const clean = file.replace(/^\/+/, '').replace(/^audio\//, '');
  return `${BASE_URL}/audio/${clean}`;
}

function manifestUrl(): string {
  return `${BASE_URL}/audio/manifest.json`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveSfxId(raw: string | undefined): SfxId | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (SFX_ALIASES[key]) return SFX_ALIASES[key];
  if (SFX_ID_SET.has(key)) return key as SfxId;
  return null;
}

function normalizeManifest(raw: unknown): NormalizedManifest {
  if (!isRecord(raw)) return { bgm: [], sfx: [] };

  // ── BGM：契约是数组；同时容忍 { file: meta } 形式 ──
  const bgm: BgmTrack[] = [];
  const seenBgm = new Set<string>();
  const pushBgm = (entry: unknown, fallbackId?: string) => {
    if (!isRecord(entry)) return;
    const file = readString(entry, 'file') ?? (fallbackId && fallbackId.includes('/') ? fallbackId : undefined);
    if (!file || seenBgm.has(file)) return;
    seenBgm.add(file);
    const id = readString(entry, 'id') ?? fallbackId ?? file;
    const title = readString(entry, 'title') ?? id.split('/').pop()?.replace(/\.[a-z0-9]+$/i, '') ?? id;
    bgm.push({
      id,
      file,
      title,
      author: readString(entry, 'author') ?? '未知作者',
      license: readString(entry, 'license'),
      licenseUrl: readString(entry, 'licenseUrl'),
      sourceUrl: readString(entry, 'sourceUrl'),
      durationSec: readNumber(entry, 'durationSec'),
    });
  };

  if (Array.isArray(raw.bgm)) {
    for (const entry of raw.bgm) pushBgm(entry);
  } else if (isRecord(raw.bgm)) {
    for (const [key, entry] of Object.entries(raw.bgm)) pushBgm(entry, key);
  }

  // ── SFX：契约是 [{id,file}]；也接受 { roll: "sfx/xxx.ogg" } 形式 ──
  const sfxMap = new Map<SfxId, SfxTrack>();
  const pushSfx = (rawId: string | undefined, entry: unknown) => {
    let id = resolveSfxId(rawId);
    let file: string | undefined;
    let meta: Record<string, unknown> = {};

    if (typeof entry === 'string') {
      file = entry;
    } else if (isRecord(entry)) {
      meta = entry;
      file = readString(entry, 'file');
      if (!id) id = resolveSfxId(readString(entry, 'id'));
    }
    if (!id || !file) return;
    sfxMap.set(id, {
      id,
      file,
      license: readString(meta, 'license'),
      licenseUrl: readString(meta, 'licenseUrl'),
      sourceUrl: readString(meta, 'sourceUrl'),
    });
  };

  if (Array.isArray(raw.sfx)) {
    for (const entry of raw.sfx) {
      if (!isRecord(entry)) continue;
      pushSfx(readString(entry, 'id'), entry);
    }
  } else if (isRecord(raw.sfx)) {
    for (const [key, entry] of Object.entries(raw.sfx)) pushSfx(key, entry);
  }

  return { bgm, sfx: Array.from(sfxMap.values()) };
}

function shuffle<T>(input: T[]): T[] {
  const list = input.slice();
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function readStoredBool(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch {
    // localStorage 不可用时静默
  }
  return fallback;
}

function readStoredVolume(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_VOLUME);
    if (raw !== null) {
      const value = Number(raw);
      if (Number.isFinite(value)) return clamp(value, 0, 1);
    }
  } catch {
    // ignore
  }
  return DEFAULT_VOLUME;
}

function persist(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export class AudioManager {
  private readonly synth = new SynthEngine();
  private listeners = new Set<() => void>();
  private snapshot: AudioSnapshot;

  private started = false;
  private destroyed = false;
  private enabled = true;
  private volume = DEFAULT_VOLUME;
  private unlocked = false;
  private hidden = false;

  private manifestState: ManifestState = 'loading';
  private manifestAttempts = 0;
  private manifestRetryTimer: number | undefined;

  private tracks: BgmTrack[] = [];
  private sfx = new Map<SfxId, SfxTrack>();
  private failedTracks = new Set<string>();
  private failedSfx = new Set<SfxId>();
  private queue: BgmTrack[] = [];
  private lastPlayedId: string | null = null;

  private currentEl: HTMLAudioElement | null = null;
  private currentTrack: BgmTrack | null = null;
  private playing = false;
  private playToken = 0;
  private advanceTimer: number | undefined;
  private fadeTimers = new Set<number>();
  private fadeByEl = new WeakMap<HTMLAudioElement, number>();
  private sfxEls = new Set<HTMLAudioElement>();
  private pendingTimeouts = new Set<number>();

  constructor() {
    if (typeof window !== 'undefined') {
      this.enabled = readStoredBool(STORAGE_BGM, true);
      this.volume = readStoredVolume();
      this.hidden = document.visibilityState === 'hidden';
    }
    this.snapshot = this.buildSnapshot();
    this.init();
  }

  // ── 生命周期 ─────────────────────────────────────────────────────

  init(): void {
    if (this.started || this.destroyed || typeof window === 'undefined') return;
    this.started = true;
    document.addEventListener('pointerdown', this.onUserGesture, { capture: true, passive: true });
    document.addEventListener('keydown', this.onUserGesture, { capture: true });
    document.addEventListener('touchstart', this.onUserGesture, { capture: true, passive: true });
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('storage', this.onStorage);
    void this.loadManifest();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.removeGestureListeners();
    if (typeof window !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      window.removeEventListener('storage', this.onStorage);
    }
    window.clearTimeout(this.manifestRetryTimer);
    this.clearAdvanceTimer();
    for (const id of this.fadeTimers) window.clearInterval(id);
    this.fadeTimers.clear();
    for (const id of this.pendingTimeouts) window.clearTimeout(id);
    this.pendingTimeouts.clear();
    for (const el of this.sfxEls) {
      try {
        el.pause();
      } catch {
        // ignore
      }
    }
    this.sfxEls.clear();
    const el = this.currentEl;
    this.currentEl = null;
    this.currentTrack = null;
    this.playing = false;
    if (el) {
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        // ignore
      }
    }
    this.synth.dispose();
    this.listeners.clear();
  }

  // ── 订阅（useSyncExternalStore）─────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.init();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): AudioSnapshot => this.snapshot;

  getServerSnapshot = (): AudioSnapshot => this.snapshot;

  // ── 公开 API ────────────────────────────────────────────────────

  toggleBgm = (): void => {
    this.setBgmEnabled(!this.enabled);
  };

  setBgmEnabled = (value: boolean): void => {
    if (this.enabled === value) return;
    this.enabled = value;
    persist(STORAGE_BGM, value ? '1' : '0');
    if (value) {
      if (this.unlocked && !this.hidden) this.startBgm();
    } else {
      this.stopBgm();
    }
    this.emit();
  };

  setVolume = (value: number): void => {
    const next = clamp(Math.round(value * 100) / 100, 0, 1);
    if (Math.abs(next - this.volume) < 0.001) return;
    this.volume = next;
    persist(STORAGE_VOLUME, String(next));
    if (this.currentEl && this.playing) this.fadeTo(this.currentEl, this.musicGain(), 120);
    this.emit();
  };

  playSfx = (id: SfxId, options: SfxOptions = {}): void => {
    if (this.destroyed || !SFX_ID_SET.has(id) || this.volume <= 0) return;
    this.init();
    const record = this.sfx.get(id);
    if (!record || this.failedSfx.has(id)) {
      this.playSynth(id, options);
      return;
    }

    const volume = clamp(this.volume * 1.15 * (options.volume ?? 1), 0, 1);
    const rate = clamp(options.rate ?? (id === 'dice-roll' ? 0.9 + Math.random() * 0.2 : 1), 0.5, 2);

    try {
      const el = new Audio(assetUrl(record.file));
      el.preload = 'auto';
      el.volume = volume;
      el.playbackRate = rate;
      let settled = false;
      const cleanup = () => {
        this.sfxEls.delete(el);
        el.onended = null;
        el.onerror = null;
      };
      const fallback = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.failedSfx.add(id);
        this.playSynth(id, options);
      };
      el.onended = cleanup;
      el.onerror = fallback;
      this.sfxEls.add(el);
      void el.play().catch(fallback);
    } catch {
      this.failedSfx.add(id);
      this.playSynth(id, options);
    }
  };

  /** 手动重试加载 manifest（例如 dev 时刚同步完素材） */
  refreshManifest = async (): Promise<void> => {
    if (this.destroyed) return;
    window.clearTimeout(this.manifestRetryTimer);
    this.manifestAttempts = 0;
    this.manifestState = 'loading';
    this.emit();
    await this.loadManifest();
  };

  // ── manifest ────────────────────────────────────────────────────

  private async loadManifest(): Promise<void> {
    if (this.destroyed) return;
    this.manifestAttempts += 1;
    try {
      const response = await fetch(manifestUrl(), { cache: 'no-store' });
      if (!response.ok) throw new Error(`manifest ${response.status}`);
      const raw: unknown = await response.json();
      const normalized = normalizeManifest(raw);
      this.tracks = normalized.bgm;
      this.sfx = new Map(normalized.sfx.map((entry) => [entry.id, entry]));
      this.failedTracks.clear();
      this.failedSfx.clear();
      this.queue = [];
      this.manifestState = 'ready';
      this.emit();
      if (this.enabled && this.unlocked && !this.hidden) this.startBgm();
    } catch {
      if (this.destroyed) return;
      if (this.manifestAttempts < MANIFEST_RETRIES) {
        this.manifestRetryTimer = window.setTimeout(() => {
          void this.loadManifest();
        }, MANIFEST_RETRY_DELAY_MS);
        return;
      }
      this.manifestState = 'missing';
      this.emit();
    }
  }

  // ── BGM ─────────────────────────────────────────────────────────

  private startBgm(): void {
    if (!this.enabled || !this.unlocked || this.hidden || this.playing) return;
    const resumeEl = this.currentEl;
    const resumeTrack = this.currentTrack;
    if (
      resumeEl &&
      resumeTrack &&
      !this.failedTracks.has(resumeTrack.id) &&
      resumeEl.currentTime > 0.15
    ) {
      this.playTrack(resumeTrack, resumeEl.currentTime);
      return;
    }
    const track = this.nextTrack();
    if (!track) {
      this.emit();
      return;
    }
    this.playTrack(track);
  }

  private nextTrack(): BgmTrack | null {
    const available = this.tracks.filter((track) => !this.failedTracks.has(track.id));
    if (available.length === 0) return null;
    for (let guard = 0; guard < 32; guard += 1) {
      if (this.queue.length === 0) this.refillQueue(available);
      const track = this.queue.shift();
      if (!track) return null;
      if (!this.failedTracks.has(track.id)) return track;
    }
    return null;
  }

  private refillQueue(available: BgmTrack[]): void {
    const shuffled = shuffle(available);
    if (shuffled.length > 1 && this.lastPlayedId && shuffled[0].id === this.lastPlayedId) {
      const swap = 1 + Math.floor(Math.random() * (shuffled.length - 1));
      [shuffled[0], shuffled[swap]] = [shuffled[swap], shuffled[0]];
    }
    this.queue = shuffled;
  }

  private playTrack(track: BgmTrack, startAt = 0): void {
    this.clearAdvanceTimer();
    this.playToken += 1;
    const token = this.playToken;
    const previous = this.currentEl;
    if (previous) {
      this.fadeTo(previous, 0, CROSSFADE_MS);
      this.later(() => {
        if (previous === this.currentEl) return;
        try {
          previous.pause();
          previous.removeAttribute('src');
          previous.load();
        } catch {
          // ignore
        }
      }, CROSSFADE_MS + 160);
    }

    let el: HTMLAudioElement;
    try {
      el = new Audio(assetUrl(track.file));
    } catch {
      this.failedTracks.add(track.id);
      return;
    }
    el.preload = 'auto';
    el.volume = 0;
    const single = this.tracks.filter((entry) => !this.failedTracks.has(entry.id)).length <= 1;
    el.loop = single;

    this.currentEl = el;
    this.currentTrack = track;
    this.playing = false;

    el.addEventListener('playing', () => {
      if (this.destroyed || token !== this.playToken || el !== this.currentEl) return;
      this.playing = true;
      this.lastPlayedId = track.id;
      this.fadeTo(el, this.musicGain(), CROSSFADE_MS);
      if (!single) this.scheduleAdvance(el, token);
      this.emit();
    });

    el.addEventListener('ended', () => {
      if (this.destroyed || token !== this.playToken || el !== this.currentEl || single) return;
      this.advance();
    });

    el.addEventListener('error', () => {
      if (this.destroyed || token !== this.playToken) return;
      this.failedTracks.add(track.id);
      this.playing = false;
      this.emit();
      this.later(() => {
        if (token === this.playToken) this.advance();
      }, 350);
    });

    if (startAt > 0.25) {
      el.addEventListener(
        'loadedmetadata',
        () => {
          try {
            el.currentTime = Math.min(startAt, Math.max(0, el.duration - 0.5));
          } catch {
            // ignore
          }
        },
        { once: true },
      );
    }

    void el.play().catch(() => {
      if (token !== this.playToken) return;
      this.playing = false;
      this.emit();
    });

    this.emit();
  }

  private scheduleAdvance(el: HTMLAudioElement, token: number): void {
    this.clearAdvanceTimer();
    const duration = el.duration;
    if (!Number.isFinite(duration) || duration < 3) return;
    const lead = Math.min(CROSSFADE_MS, duration * 0.25);
    const delay = Math.max(1200, (duration - lead) * 1000);
    this.advanceTimer = window.setTimeout(() => {
      if (token === this.playToken) this.advance();
    }, delay);
  }

  private advance(): void {
    if (!this.enabled || !this.unlocked || this.hidden) {
      this.playing = false;
      this.emit();
      return;
    }
    const track = this.nextTrack();
    if (!track) {
      this.playing = false;
      this.emit();
      return;
    }
    this.playTrack(track);
  }

  private stopBgm(): void {
    this.playToken += 1;
    this.clearAdvanceTimer();
    this.playing = false;
    const el = this.currentEl;
    this.currentEl = null;
    this.currentTrack = null;
    if (el) this.fadeTo(el, 0, 420, true);
    this.emit();
  }

  private pauseBgm(): void {
    this.playToken += 1;
    this.clearAdvanceTimer();
    const el = this.currentEl;
    if (el) {
      this.clearFade(el);
      try {
        el.pause();
      } catch {
        // ignore
      }
    }
    this.playing = false;
    this.emit();
  }

  private resumeBgm(): void {
    if (!this.enabled || this.hidden || !this.unlocked) return;
    const el = this.currentEl;
    const track = this.currentTrack;
    if (el && track && !this.failedTracks.has(track.id) && el.currentTime > 0.15) {
      this.playTrack(track, el.currentTime);
      return;
    }
    this.startBgm();
  }

  private musicGain(): number {
    return clamp(this.volume * BGM_GAIN_SCALE, 0, 1);
  }

  // ── 淡入淡出 ────────────────────────────────────────────────────

  private fadeTo(el: HTMLAudioElement, target: number, durationMs: number, pauseWhenDone = false): void {
    this.clearFade(el);
    const to = clamp(target, 0, 1);
    const from = clamp(el.volume, 0, 1);
    const start = performance.now();
    const duration = Math.max(0, durationMs);
    if (duration === 0 || Math.abs(to - from) < 0.005) {
      el.volume = to;
      if (pauseWhenDone) this.safePause(el);
      return;
    }
    const timer = window.setInterval(() => {
      const progress = Math.min(1, (performance.now() - start) / duration);
      const eased = 1 - (1 - progress) ** 2;
      el.volume = clamp(from + (to - from) * eased, 0, 1);
      if (progress >= 1) {
        window.clearInterval(timer);
        this.fadeTimers.delete(timer);
        this.fadeByEl.delete(el);
        el.volume = to;
        if (pauseWhenDone) this.safePause(el);
      }
    }, 40);
    this.fadeTimers.add(timer);
    this.fadeByEl.set(el, timer);
  }

  private clearFade(el: HTMLAudioElement): void {
    const timer = this.fadeByEl.get(el);
    if (timer === undefined) return;
    window.clearInterval(timer);
    this.fadeTimers.delete(timer);
    this.fadeByEl.delete(el);
  }

  private safePause(el: HTMLAudioElement): void {
    try {
      el.pause();
    } catch {
      // ignore
    }
  }

  private clearAdvanceTimer(): void {
    window.clearTimeout(this.advanceTimer);
    this.advanceTimer = undefined;
  }

  private later(fn: () => void, delayMs: number): void {
    const timer = window.setTimeout(() => {
      this.pendingTimeouts.delete(timer);
      if (!this.destroyed) fn();
    }, delayMs);
    this.pendingTimeouts.add(timer);
  }

  // ── SFX 合成兜底 ────────────────────────────────────────────────

  private playSynth(id: SfxId, options: SfxOptions): void {
    if (this.destroyed) return;
    try {
      this.synth.unlock();
      this.synth.play(id, Math.min(1, this.volume * 1.15), options.rate ?? 1);
    } catch {
      // ignore
    }
  }

  // ── 全局事件 ────────────────────────────────────────────────────

  private onUserGesture = (): void => {
    if (this.destroyed) return;
    if (!this.unlocked) {
      this.unlocked = true;
      this.synth.unlock();
      this.removeGestureListeners();
      this.emit();
    }
    if (this.enabled && !this.hidden) this.startBgm();
  };

  private onVisibilityChange = (): void => {
    const hidden = document.visibilityState === 'hidden';
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (hidden) this.pauseBgm();
    else this.resumeBgm();
  };

  private onStorage = (event: StorageEvent): void => {
    if (event.key === STORAGE_BGM) {
      const next = event.newValue !== '0';
      if (next !== this.enabled) this.setBgmEnabled(next);
    } else if (event.key === STORAGE_VOLUME && event.newValue !== null) {
      const next = Number(event.newValue);
      if (Number.isFinite(next)) this.setVolume(next);
    }
  };

  private removeGestureListeners(): void {
    document.removeEventListener('pointerdown', this.onUserGesture, { capture: true });
    document.removeEventListener('keydown', this.onUserGesture, { capture: true });
    document.removeEventListener('touchstart', this.onUserGesture, { capture: true });
  }

  // ── 快照 ────────────────────────────────────────────────────────

  private buildSnapshot(): AudioSnapshot {
    return {
      enabled: this.enabled,
      volume: this.volume,
      unlocked: this.unlocked,
      manifestState: this.manifestState,
      bgmCount: this.tracks.length,
      sfxCount: this.sfx.size,
      currentTrack: this.currentTrack,
      playing: this.playing,
    };
  }

  private emit(): void {
    if (this.destroyed) return;
    this.snapshot = this.buildSnapshot();
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch {
        // 单个订阅者出错不影响其它人
      }
    }
  }
}

export const audioManager = new AudioManager();
export const getAudioManager = (): AudioManager => audioManager;

/** 非 React 场景的快捷函数（例如事件回调里直接调用） */
export function playSfx(id: SfxId, options?: SfxOptions): void {
  audioManager.playSfx(id, options);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    audioManager.destroy();
  });
}
