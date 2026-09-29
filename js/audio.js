/**
 * audio.js
 * ------------------------------------------------------------------
 * Procedural sound engine built on the Web Audio API — no audio files
 * are required. Every effect is synthesised on demand from
 * oscillators, filtered noise and envelopes.
 *
 *  AudioManager
 *    ├─ sfxBus   → effects (UI, tiles, rewards)
 *    ├─ musicBus → generative background music (lookahead scheduler)
 *    └─ master → compressor → destination
 *
 * Pitch is slightly randomised per play to avoid ear fatigue, and the
 * whole palette is transposed by the active level theme.
 */

import { clamp } from './utils.js';

const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.sfxEnabled = true;
    this.musicEnabled = true;
    this.themePitch = 0;       // semitone offset from theme
    this.rootNote = 57;        // music key (MIDI)
    this.intensity = 0;        // 0..1 — raises tempo/percussion as time runs out
    this.musicPlaying = false;
    this._lastPlayed = new Map();
    this._scheduler = null;
  }

  /* ---------------- Setup ---------------- */

  /** Builds the audio graph and pre-renders noise buffers. */
  async init(onProgress = () => {}) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { onProgress(1); return; }
    this.ctx = new Ctx({ latencyHint: 'interactive' });

    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.ratio.value = 4;
    this.master = this._gain(0.9, this.compressor);
    this.compressor.connect(this.ctx.destination);
    this.sfxBus = this._gain(0.8, this.master);
    this.musicBus = this._gain(0.0, this.master);
    this.musicVolume = 0.32;
    onProgress(0.4);

    // White-noise buffer shared by percussive/sparkle sounds.
    const len = this.ctx.sampleRate * 1.5;
    this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    onProgress(0.8);

    // A soft stereo-ish delay used as a cheap "reverb" tail.
    this.delay = this.ctx.createDelay(1);
    this.delay.delayTime.value = 0.18;
    this.delayFeedback = this._gain(0.28, this.delay);
    this.delay.connect(this.delayFeedback);
    this.delaySend = this._gain(0.22, this.delay);
    this.delay.connect(this.master);
    onProgress(1);
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  unlock() {
    if (!this.ctx || this.ctx.state === 'running') return;
    this.ctx.resume().catch(() => { /* ignore */ });
    // Some browsers only unlock on a later gesture — retry once on the next tap.
    const retry = () => { this.ctx.state !== 'running' && this.ctx.resume().catch(() => {}); };
    window.addEventListener('pointerdown', retry, { once: true });
  }

  suspend() { this.ctx?.state === 'running' && this.ctx.suspend(); }
  resume() { this.ctx?.state === 'suspended' && this.ctx.resume(); }

  setSfxEnabled(on) { this.sfxEnabled = on; }

  setMusicEnabled(on) {
    this.musicEnabled = on;
    if (on) this.startMusic(); else this.stopMusic();
  }

  /** Theme = level visual theme; transposes sfx and music. */
  setTheme(theme) {
    this.themePitch = theme?.pitch ?? 0;
    this.rootNote = theme?.rootNote ?? 57;
  }

  setIntensity(v) { this.intensity = clamp(v, 0, 1); }

  /** Lowers the music (e.g. when paused). */
  duck(on) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const target = this.musicEnabled && this.musicPlaying ? (on ? this.musicVolume * 0.35 : this.musicVolume) : 0;
    this.musicBus.gain.cancelScheduledValues(t);
    this.musicBus.gain.setTargetAtTime(target, t, 0.15);
  }

  /* ---------------- Low-level voices ---------------- */

  _gain(value, dest) {
    const g = this.ctx.createGain();
    g.gain.value = value;
    if (dest) g.connect(dest);
    return g;
  }

  /** Pitch multiplier: theme transpose + small random detune. */
  _pitch(random = 0.025) {
    return Math.pow(2, this.themePitch / 12) * (1 + (Math.random() * 2 - 1) * random);
  }

  /**
   * Oscillator voice with ADSR-ish envelope and optional filter + sweep.
   */
  _tone({ type = 'sine', freq = 440, freqEnd = null, start = 0, dur = 0.12, attack = 0.005,
    gain = 0.3, filter = null, q = 1, dest = this.sfxBus, send = 0, detune = 0 }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    osc.detune.value = detune;
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    let node = osc;
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = filter;
      f.Q.value = q;
      osc.connect(f);
      node = f;
    }
    node.connect(env);
    env.connect(dest);
    if (send) { const s = this._gain(send, this.delaySend); env.connect(s); }
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** Filtered noise burst. */
  _noise({ start = 0, dur = 0.1, gain = 0.2, freq = 4000, type = 'bandpass', q = 1, dest = this.sfxBus }) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + start;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(env); env.connect(dest);
    src.start(t0, Math.random() * 1.2);
    src.stop(t0 + dur + 0.05);
  }

  /* ---------------- Sound effects ---------------- */

  /**
   * Plays a named effect.
   * @param {string} name
   * @param {object} [opts] e.g. { step } for tick pitch, { index } for stars
   */
  play(name, opts = {}) {
    if (!this.ctx || !this.sfxEnabled || this.ctx.state !== 'running') return;
    // Throttle identical sounds fired within 35ms (except drag ticks).
    const now = performance.now();
    if (name !== 'tick' && now - (this._lastPlayed.get(name) || 0) < 35) return;
    this._lastPlayed.set(name, now);

    const fx = SOUNDS[name];
    if (fx) fx.call(this, this._pitch(), opts);
  }

  /* ---------------- Generative music ---------------- */

  startMusic() {
    if (!this.ctx || !this.musicEnabled || this.musicPlaying) return;
    this.musicPlaying = true;
    this._step = 0;
    this._nextTime = this.ctx.currentTime + 0.08;
    const t = this.ctx.currentTime;
    this.musicBus.gain.cancelScheduledValues(t);
    this.musicBus.gain.setTargetAtTime(this.musicVolume, t, 0.6);
    this._scheduler = setInterval(() => this._schedule(), 30);
  }

  stopMusic() {
    if (!this.ctx) return;
    this.musicPlaying = false;
    clearInterval(this._scheduler);
    this._scheduler = null;
    const t = this.ctx.currentTime;
    this.musicBus.gain.cancelScheduledValues(t);
    this.musicBus.gain.setTargetAtTime(0, t, 0.25);
  }

  /** Lookahead scheduler: queues 16th notes slightly ahead of time. */
  _schedule() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const bpm = 92 + this.intensity * 26;
    const sixteenth = 60 / bpm / 4;
    while (this._nextTime < this.ctx.currentTime + 0.12) {
      this._playStep(this._step, this._nextTime - this.ctx.currentTime);
      this._nextTime += sixteenth;
      this._step = (this._step + 1) % 256;
    }
  }

  _playStep(step, start) {
    // Progression i – VI – III – VII (minor key), one chord per bar.
    const CHORDS = [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]];
    const bar = Math.floor(step / 16) % 4;
    const s = step % 16;
    const chord = CHORDS[bar];
    const root = this.rootNote;
    const bus = this.musicBus;

    // Pad at the start of every bar
    if (s === 0) {
      chord.forEach((iv, i) => this._tone({
        type: 'sawtooth', freq: midiToFreq(root + iv), start, dur: 2.4, attack: 0.5,
        gain: 0.035, filter: 900, dest: bus, detune: i % 2 ? 7 : -7,
      }));
    }
    // Bass on beats
    if (s % 4 === 0) {
      this._tone({ type: 'triangle', freq: midiToFreq(root - 12 + chord[0]), start, dur: 0.35, gain: 0.12, dest: bus });
    }
    // Arpeggio on 8ths
    if (s % 2 === 0) {
      const pattern = [0, 1, 2, 1, 0, 2, 1, 2];
      const note = root + 12 + chord[pattern[(s / 2) % 8]] + (s >= 8 ? 12 : 0);
      this._tone({ type: 'triangle', freq: midiToFreq(note), start, dur: 0.22, gain: 0.045, filter: 3200, dest: bus, send: 0.4 });
    }
    // Percussion builds as time runs low
    if (this.intensity > 0.35 && s % 4 === 2) {
      this._noise({ start, dur: 0.05, gain: 0.05 * this.intensity, freq: 8000, type: 'highpass', dest: bus });
    }
    if (this.intensity > 0.7 && s % 8 === 0) {
      this._tone({ type: 'sine', freq: 120, freqEnd: 45, start, dur: 0.18, gain: 0.18, dest: bus });
    }
  }
}

/* ------------------------------------------------------------------
 * Effect definitions. `p` is the pitch multiplier for this play.
 * ------------------------------------------------------------------ */
const SOUNDS = {
  click(p) {
    this._tone({ type: 'triangle', freq: 880 * p, freqEnd: 620 * p, dur: 0.07, gain: 0.22 });
    this._noise({ dur: 0.02, gain: 0.05, freq: 6000 });
  },
  hover(p) {
    this._tone({ type: 'sine', freq: 1400 * p, dur: 0.04, gain: 0.05 });
  },
  back(p) {
    this._tone({ type: 'triangle', freq: 660 * p, freqEnd: 420 * p, dur: 0.1, gain: 0.2 });
  },
  select(p) {
    this._tone({ type: 'triangle', freq: 560 * p, dur: 0.07, gain: 0.2 });
    this._noise({ dur: 0.02, gain: 0.04, freq: 5000 });
  },
  tick(p, { step = 0 }) {
    const f = 620 * Math.pow(2, Math.min(step, 14) / 12) * p;
    this._tone({ type: 'sine', freq: f, dur: 0.05, gain: 0.12 });
  },
  correct(p) {
    [0, 4, 7, 12].forEach((iv, i) => this._tone({
      type: 'triangle', freq: 523.25 * Math.pow(2, iv / 12) * p, start: i * 0.055, dur: 0.22, gain: 0.18, send: 0.5,
    }));
  },
  wordComplete(p) {
    [19, 24].forEach((iv, i) => this._tone({
      type: 'sine', freq: 523.25 * Math.pow(2, iv / 12) * p, start: 0.2 + i * 0.07, dur: 0.4, gain: 0.08, send: 0.7,
    }));
    this._noise({ start: 0.18, dur: 0.35, gain: 0.05, freq: 9000, type: 'highpass' });
  },
  error() {
    const p = Math.pow(2, this.themePitch / 12);
    this._tone({ type: 'square', freq: 150 * p, freqEnd: 110 * p, dur: 0.2, gain: 0.07, filter: 700 });
    this._tone({ type: 'sine', freq: 155 * p, freqEnd: 112 * p, dur: 0.22, gain: 0.12 });
  },
  already(p) {
    this._tone({ type: 'sine', freq: 440 * p, dur: 0.08, gain: 0.1 });
    this._tone({ type: 'sine', freq: 440 * p, start: 0.1, dur: 0.08, gain: 0.08 });
  },
  hint(p) {
    [988, 1480, 1975].forEach((f, i) => this._tone({
      type: 'sine', freq: f * p, start: i * 0.08, dur: 0.6, gain: 0.09, send: 0.8,
    }));
  },
  pauseOpen(p) {
    this._tone({ type: 'sine', freq: 700 * p, freqEnd: 300 * p, dur: 0.18, gain: 0.18 });
  },
  pauseClose(p) {
    this._tone({ type: 'sine', freq: 300 * p, freqEnd: 700 * p, dur: 0.18, gain: 0.18 });
  },
  warn(p) {
    this._tone({ type: 'square', freq: 1046 * p, dur: 0.06, gain: 0.05, filter: 2500 });
  },
  levelStart(p) {
    this._tone({ type: 'sawtooth', freq: 220 * p, freqEnd: 880 * p, dur: 0.6, gain: 0.06, filter: 2000, send: 0.4 });
    this._noise({ dur: 0.6, gain: 0.04, freq: 1500, q: 0.7 });
  },
  levelComplete(p) {
    const chords = [[0, 4, 7], [5, 9, 12], [7, 11, 14], [12, 16, 19, 24]];
    chords.forEach((ch, i) => ch.forEach((iv) => this._tone({
      type: i === 3 ? 'triangle' : 'sawtooth', freq: 261.63 * Math.pow(2, iv / 12) * p,
      start: i * 0.2, dur: i === 3 ? 1.2 : 0.3, gain: 0.07, filter: 3000, send: 0.5,
    })));
  },
  levelFailed(p) {
    [0, -3, -7].forEach((iv, i) => this._tone({
      type: 'triangle', freq: 392 * Math.pow(2, iv / 12) * p, freqEnd: 392 * Math.pow(2, (iv - 1) / 12) * p,
      start: i * 0.22, dur: 0.4, gain: 0.16, filter: 1400,
    }));
  },
  confetti() {
    for (let i = 0; i < 8; i++) {
      this._noise({ start: i * 0.045 + Math.random() * 0.03, dur: 0.06, gain: 0.08, freq: 2500 + Math.random() * 5000, q: 3 });
    }
  },
  star(p, { index = 0 }) {
    const f = 784 * Math.pow(2, (index * 4) / 12) * p;
    this._tone({ type: 'sine', freq: f, dur: 0.5, gain: 0.16, send: 0.6 });
    this._tone({ type: 'triangle', freq: f * 2, dur: 0.25, gain: 0.05 });
  },
};
