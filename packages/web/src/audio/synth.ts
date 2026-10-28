import type { SfxId } from './audioTypes';

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  return ctor ?? null;
}

interface ToneOptions {
  freq: number;
  endFreq?: number;
  type: OscillatorType;
  start: number;
  duration: number;
  gain: number;
  rate?: number;
}

/**
 * 极轻量的 WebAudio 兜底音效：
 * 当 manifest 里没有对应 SFX（或音频文件 404）时，用 OscillatorNode 合成短音，
 * 保证骰子/按钮的手感不缺。不加载任何外部资源，也不会报错。
 */
export class SynthEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = getAudioContextCtor();
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.0001;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
      this.master = null;
    }
    return this.ctx;
  }

  /** 在用户手势里调用，解除 AudioContext 的 suspended 状态 */
  unlock(): void {
    const ctx = this.context();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined);
    }
  }

  play(id: SfxId, volume: number, rate = 1): void {
    const ctx = this.context();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined);
    }
    const master = Math.max(0, Math.min(1, volume)) * 0.34;
    if (master <= 0) return;
    this.context();
    const masterNode = this.master;
    if (!masterNode) return;
    try {
      masterNode.gain.cancelScheduledValues(ctx.currentTime);
      masterNode.gain.setValueAtTime(master, ctx.currentTime);
    } catch {
      masterNode.gain.value = master;
    }
    const now = ctx.currentTime + 0.01;
    const pitch = Math.max(0.5, Math.min(2, rate));

    try {
      switch (id) {
        case 'click':
          this.tone(ctx, { freq: 740, endFreq: 520, type: 'triangle', start: now, duration: 0.055, gain: 0.5, rate: pitch });
          break;
        case 'dice-roll': {
          // 三下快速碰撞的木质咔哒声
          for (let i = 0; i < 4; i += 1) {
            this.tone(ctx, {
              freq: 250 + i * 36,
              endFreq: 150,
              type: 'square',
              start: now + i * 0.062,
              duration: 0.03,
              gain: 0.22,
              rate: pitch,
            });
          }
          break;
        }
        case 'dice-land':
          this.tone(ctx, { freq: 170, endFreq: 68, type: 'sine', start: now, duration: 0.16, gain: 0.7, rate: pitch });
          this.tone(ctx, { freq: 920, endFreq: 760, type: 'triangle', start: now, duration: 0.035, gain: 0.3, rate: pitch });
          break;
        case 'hold-on':
          this.tone(ctx, { freq: 620, endFreq: 880, type: 'triangle', start: now, duration: 0.09, gain: 0.45, rate: pitch });
          break;
        case 'hold-off':
          this.tone(ctx, { freq: 620, endFreq: 420, type: 'triangle', start: now, duration: 0.09, gain: 0.38, rate: pitch });
          break;
        case 'score':
          [523.25, 659.25, 783.99].forEach((freq, index) => {
            this.tone(ctx, {
              freq,
              type: 'sine',
              start: now + index * 0.058,
              duration: 0.1,
              gain: 0.42,
              rate: pitch,
            });
          });
          break;
        case 'reveal':
          this.tone(ctx, { freq: 330, endFreq: 990, type: 'triangle', start: now, duration: 0.2, gain: 0.4, rate: pitch });
          break;
        case 'win':
          [523.25, 659.25, 783.99, 1046.5].forEach((freq, index) => {
            this.tone(ctx, {
              freq,
              type: 'triangle',
              start: now + index * 0.085,
              duration: 0.16,
              gain: 0.38,
              rate: pitch,
            });
          });
          break;
        case 'lose':
          [392, 329.63, 261.63].forEach((freq, index) => {
            this.tone(ctx, {
              freq,
              type: 'sine',
              start: now + index * 0.11,
              duration: 0.18,
              gain: 0.34,
              rate: pitch,
            });
          });
          break;
        default:
          break;
      }
    } catch {
      // 合成失败也绝不打扰玩家
    }
  }

  dispose(): void {
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    if (!ctx || ctx.state === 'closed') return;
    try {
      void ctx.close().catch(() => undefined);
    } catch {
      // ignore
    }
  }

  private tone(ctx: AudioContext, options: ToneOptions): void {
    const rate = options.rate ?? 1;
    const start = Math.max(ctx.currentTime, options.start);
    const end = start + Math.max(0.02, options.duration);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = options.type;
    osc.frequency.setValueAtTime(Math.max(20, options.freq * rate), start);
    if (options.endFreq !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, options.endFreq * rate), end);
    }

    const peak = Math.max(0.0001, options.gain);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gain);
    gain.connect(this.master ?? ctx.destination);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}
