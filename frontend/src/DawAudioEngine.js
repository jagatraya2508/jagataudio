/**
 * DawAudioEngine.js
 * ─────────────────
 * Core audio engine for the Jagat Audio DAW, built on Tone.js.
 *
 * Responsibilities:
 *  - Manage per-track audio graphs (EQ → Compressor → Delay → Reverb → Channel → Meter → Master)
 *  - Load, decode, and cache audio buffers
 *  - Schedule region playback with correct timing
 *  - Real-time metering (per-track & master)
 *  - Microphone recording
 *  - Offline bounce / export (WAV)
 *  - Metronome click
 */

import * as Tone from 'tone';
import { createGuitarPluckInstrument } from './guitarInstrument';

// ─── Track colour palette ────────────────────────────────────────────
export const TRACK_COLORS = [
  '#3a86ff', '#ff006e', '#8338ec', '#fb5607', '#ffbe0b',
  '#06d6a0', '#118ab2', '#ef476f', '#ffd166', '#26c6da',
  '#ab47bc', '#5c6bc0', '#66bb6a', '#ff7043', '#78909c',
];

// ─── Helpers ─────────────────────────────────────────────────────────
function dbToGain(db) {
  return Math.pow(10, db / 20);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function midiPlaybackVelocity(velocity) {
  const base = Number.isFinite(Number(velocity)) ? Number(velocity) : 0.8;
  // Chord generator previously split velocity across strings (~0.15–0.35).
  const boosted = base < 0.5 ? 0.38 + base * 1.35 : base;
  return clamp(boosted, 0.42, 1);
}

/** Encode an AudioBuffer as a 16-bit PCM WAV Blob. */
export function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate  = buffer.sampleRate;
  const length      = buffer.length;
  const bytesPerSample = 2;
  const blockAlign     = numChannels * bytesPerSample;
  const dataSize       = length * blockAlign;
  const headerSize     = 44;
  const arrayBuffer    = new ArrayBuffer(headerSize + dataSize);
  const view           = new DataView(arrayBuffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = clamp(channels[ch][i], -1, 1);
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

/** Extract min/max peak pairs from an AudioBuffer (mono mix).  */
export function extractPeaks(audioBuffer, numPeaks = 2048) {
  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0;
  const len = ch0.length;
  const step = Math.max(1, Math.floor(len / numPeaks));
  const peaks = [];
  for (let i = 0; i < len; i += step) {
    let min = 0, max = 0;
    const end = Math.min(i + step, len);
    for (let j = i; j < end; j++) {
      const v = (ch0[j] + ch1[j]) * 0.5;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks.push({ min, max });
  }
  return peaks;
}

const RECORDER_WORKLET = `
class JagatRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._on = false;
    this._l = [];
    this._r = [];
    this._count = 0;
    this._target = 4096;
    this.port.onmessage = (e) => {
      if (e.data === 'start') this._on = true;
      if (e.data === 'stop') {
        this._flush();
        this._on = false;
      }
    };
  }
  _flush() {
    if (this._count <= 0) return;
    const l = new Float32Array(this._count);
    const r = new Float32Array(this._count);
    let o = 0;
    for (let i = 0; i < this._l.length; i++) { l.set(this._l[i], o); o += this._l[i].length; }
    o = 0;
    for (let i = 0; i < this._r.length; i++) { r.set(this._r[i], o); o += this._r[i].length; }
    this.port.postMessage({ l, r }, [l.buffer, r.buffer]);
    this._l = [];
    this._r = [];
    this._count = 0;
  }
  process(inputs) {
    if (!this._on) return true;
    const chans = inputs[0];
    if (!chans || !chans[0] || chans[0].length === 0) return true;
    this._l.push(chans[0].slice());
    this._r.push((chans[1] || chans[0]).slice());
    this._count += chans[0].length;
    if (this._count >= this._target) this._flush();
    return true;
  }
}
registerProcessor('jagat-recorder', JagatRecorderProcessor);
`;

function isNativeAudioContext(c) {
  if (!c) return false;
  const name = c.constructor?.name || '';
  if (name === 'AudioContext' || name === 'webkitAudioContext' || name === 'OfflineAudioContext') return true;
  try {
    if (typeof AudioContext !== 'undefined' && c instanceof AudioContext) return true;
    if (typeof webkitAudioContext !== 'undefined' && c instanceof webkitAudioContext) return true;
  } catch (_) { /* ignore */ }
  return false;
}

function unwrapNativeContext(start) {
  let c = start;
  const seen = new Set();
  while (c && !seen.has(c)) {
    seen.add(c);
    if (isNativeAudioContext(c)) return c;
    c = c.rawContext || c._nativeAudioContext || c._context || c.context || null;
  }
  return null;
}

function getNativeAudioContext(preferred) {
  return unwrapNativeContext(preferred)
    || unwrapNativeContext(Tone.getContext())
    || unwrapNativeContext(Tone.getContext()?.rawContext)
    || Tone.getContext()?.rawContext;
}

function isolatedAudioStream(stream) {
  const tracks = stream?.getAudioTracks?.() || [];
  if (!tracks.length) return stream;
  return new MediaStream([tracks[0]]);
}

function isCommunicationsLabel(label) {
  return /communications/i.test(label || '');
}

function outputDeviceRank(label) {
  const l = (label || '').toLowerCase();
  if (isCommunicationsLabel(l)) return 100;
  if (/valeton|gp-?200/.test(l)) return 90;
  if (/usb/.test(l)) return 80;
  if (/hdmi|display/.test(l)) return 40;
  if (/realtek/.test(l)) return 0;
  if (/speaker|headphone|earphones|headset/.test(l) && !/usb|valeton/.test(l)) return 1;
  return 20;
}

function ensureRecorderWorklet(ctx) {
  if (!ctx?.audioWorklet?.addModule) return Promise.reject(new Error('no audioWorklet'));
  if (!ctx._jagatRecorderReady) {
    const blob = new Blob([RECORDER_WORKLET], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    ctx._jagatRecorderReady = ctx.audioWorklet.addModule(url).finally(() => {
      try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
    });
  }
  return ctx._jagatRecorderReady;
}

/** DC block, rumble filter, soft limit, and edge fades for a smoother take. */
export function polishRecordedBuffer(buffer) {
  if (!buffer || !buffer.length) return buffer;
  const sr = buffer.sampleRate;
  const fadeInN = Math.max(8, Math.round(sr * 0.012));
  const fadeOutN = Math.max(16, Math.round(sr * 0.022));
  const hpR = Math.exp(-2 * Math.PI * 38 / sr);

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    const n = d.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += d[i];
    mean /= Math.max(1, n);

    let prevX = 0;
    let prevY = 0;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const x = d[i] - mean;
      const y = hpR * (prevY + x - prevX);
      prevX = x;
      prevY = y;
      d[i] = y;
      const a = Math.abs(y);
      if (a > peak) peak = a;
    }

    let gain = 1;
    if (peak > 0.03 && peak < 0.42) gain = Math.min(1.8, 0.72 / peak);
    else if (peak > 0.97) gain = 0.89 / peak;

    for (let i = 0; i < n; i++) {
      let v = d[i] * gain;
      if (v > 0.82 || v < -0.82) v = Math.tanh(v * 1.12) * 0.94;
      if (i < fadeInN) {
        const t = i / fadeInN;
        v *= 0.5 - 0.5 * Math.cos(Math.PI * t);
      }
      const tail = n - 1 - i;
      if (tail < fadeOutN) {
        const t = tail / fadeOutN;
        v *= 0.5 - 0.5 * Math.cos(Math.PI * t);
      }
      d[i] = v;
    }
  }
  return buffer;
}

function trimAudioBufferStart(buffer, seconds) {
  if (!buffer || seconds <= 0) return buffer;
  const skip = Math.min(buffer.length - 64, Math.round(seconds * buffer.sampleRate));
  if (skip <= 0) return buffer;
  const len = buffer.length - skip;
  const next = typeof buffer.constructor === 'function' && buffer.numberOfChannels
    ? (typeof AudioBuffer !== 'undefined'
      ? new AudioBuffer({
          numberOfChannels: buffer.numberOfChannels,
          length: len,
          sampleRate: buffer.sampleRate,
        })
      : null)
    : null;
  const out = next || buffer;
  if (!next) return buffer;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    out.getChannelData(ch).set(buffer.getChannelData(ch).subarray(skip));
  }
  return out;
}

function getMonoMix(buffer) {
  const n = buffer.length;
  const chs = buffer.numberOfChannels;
  if (chs === 1) return buffer.getChannelData(0);
  const out = new Float32Array(n);
  const g = 1 / chs;
  for (let ch = 0; ch < chs; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < n; i++) out[i] += d[i] * g;
  }
  return out;
}

function copyToMonoBuffer(samples, sampleRate) {
  const out = new AudioBuffer({ numberOfChannels: 1, length: samples.length, sampleRate });
  out.getChannelData(0).set(samples);
  return out;
}

function normCorrAtLag(a, b, lag, win, step) {
  let num = 0;
  let ea = 0;
  let eb = 0;
  let c = 0;
  for (let i = 0; i < win; i += step) {
    const j = i + lag;
    if (j < 0 || j >= b.length) continue;
    const x = a[i];
    const y = b[j];
    num += x * y;
    ea += x * x;
    eb += y * y;
    c += 1;
  }
  if (c < 64 || ea < 1e-12 || eb < 1e-12) return 0;
  return num / Math.sqrt(ea * eb);
}

/** If USB stereo is "gitar | loopback", keep the instrument side only. */
function isolateInstrumentChannel(recorded, mixRef) {
  if (!recorded || recorded.numberOfChannels < 2 || !mixRef) return recorded;
  const mix = getMonoMix(mixRef);
  const left = recorded.getChannelData(0);
  const right = recorded.getChannelData(1);
  const sr = recorded.sampleRate;
  const win = Math.min(left.length, right.length, mix.length, Math.round(sr * 4));
  const lags = [0, Math.round(0.05 * sr), Math.round(0.12 * sr), Math.round(-0.05 * sr)];
  const peakNcc = (sig) => {
    let best = 0;
    for (const lag of lags) {
      const s = Math.abs(normCorrAtLag(sig, mix, lag, win, 8));
      if (s > best) best = s;
    }
    return best;
  };
  const nccL = peakNcc(left);
  const nccR = peakNcc(right);
  if (nccL > 0.32 && nccR + 0.16 < nccL) return copyToMonoBuffer(right, sr);
  if (nccR > 0.32 && nccL + 0.16 < nccR) return copyToMonoBuffer(left, sr);
  return recorded;
}

/** Hapus iringan yang bocor ke input (USB loopback) tanpa mematikan suara track lain. */
function mixMinusBleed(recorded, mixRef) {
  if (!recorded || !mixRef || recorded.length < 2048 || mixRef.length < 2048) return recorded;
  const recMono = getMonoMix(recorded);
  const mixMono = getMonoMix(mixRef);
  const sr = recorded.sampleRate;
  const maxLag = Math.round(0.38 * sr);
  const win = Math.min(recMono.length, mixMono.length, Math.round(sr * 6));
  const ds = 8;
  const recDs = new Float32Array(Math.floor(win / ds));
  const mixDs = new Float32Array(Math.floor(Math.min(mixMono.length, recMono.length) / ds));
  for (let i = 0; i < recDs.length; i++) recDs[i] = recMono[i * ds];
  for (let i = 0; i < mixDs.length; i++) mixDs[i] = mixMono[i * ds];
  const maxLagDs = Math.round(maxLag / ds);
  let bestLagDs = 0;
  let best = 0;
  for (let lag = -maxLagDs; lag <= maxLagDs; lag += 1) {
    const score = normCorrAtLag(recDs, mixDs, lag, recDs.length, 1);
    if (Math.abs(score) > Math.abs(best)) {
      best = score;
      bestLagDs = lag;
    }
  }
  let bestLag = bestLagDs * ds;
  for (let lag = bestLag - ds; lag <= bestLag + ds; lag += 1) {
    if (lag < -maxLag || lag > maxLag) continue;
    const score = normCorrAtLag(recMono, mixMono, lag, win, 4);
    if (Math.abs(score) > Math.abs(best)) {
      best = score;
      bestLag = lag;
    }
  }
  if (Math.abs(best) < 0.06) return recorded;

  let num = 0;
  let den = 0;
  const n = recMono.length;
  for (let i = 0; i < n; i += 1) {
    const j = i + bestLag;
    if (j < 0 || j >= mixMono.length) continue;
    num += recMono[i] * mixMono[j];
    den += mixMono[j] * mixMono[j];
  }
  if (den < 1e-8) return recorded;
  const k = clamp(num / den, -1.8, 1.8);
  if (Math.abs(k) < 0.04) return recorded;

  for (let ch = 0; ch < recorded.numberOfChannels; ch++) {
    const d = recorded.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const j = i + bestLag;
      const m = (j >= 0 && j < mixMono.length) ? mixMono[j] : 0;
      d[i] -= k * m;
    }
  }
  return recorded;
}

// ─── Main class ──────────────────────────────────────────────────────

class DawAudioEngine {
  constructor() {
    /* master chain */
    this.masterGain       = null;
    this.masterSubCut     = null;
    this.masterEq         = null;
    this.masterCompressor = null;
    this.masterWidener    = null;
    this.masterLimiter    = null;
    this.masterMeter      = null;
    this._masterIsMono    = false;
    this._masterWidth     = 1.0; // UI scale: 1.0 = normal stereo

    /* per-track nodes:  Map<trackId, TrackNode> */
    this.trackNodes = new Map();

    /* decoded audio:  Map<audioId, { buffer: AudioBuffer, peaks: {min,max}[] }> */
    this.audioBuffers = new Map();

    /* active players during playback: Map<regionId, Tone.Player> */
    this.activePlayers = new Map();
    this.trackSynths = new Map();

    /* playback bookkeeping */
    this._playing         = false;
    this._startCtxTime    = 0;   // Tone.now() when play was pressed
    this._startProjTime   = 0;   // project-time offset when play was pressed
    this._playNativeCtxTime = null;
    this._recordNativeCtxTime = null;
    this._recordUsedMediaRecorder = false;
    this._recPrep         = null;
    this._loopEnabled     = false;
    this._loopStart       = 0;
    this._loopEnd         = 16;
    this._rafId           = null;
    this.onPlayheadUpdate = null; // callback(projectTimeSeconds)
    this.onPlaybackStop   = null; // callback()

    /* recording */
    this._mediaRecorders  = {}; // trackId -> MediaRecorder
    this._recordChunks    = {}; // trackId -> Blob[]
    this._recordStreams   = {}; // trackId -> MediaStream
    this.onRecordingDone  = null; // callback(trackId, blob)

    /* live input monitor (instrument / mic → track) */
    this._inputMonitors   = new Map(); // trackId -> { mic, meter }

    /* playback output (hindari USB loopback ke input yang sama) */
    this._outputDeviceId  = '';
    this._restoreSinkId   = undefined;
    this._sinkLocked      = false;
    this._recordPlayDest  = null;
    this._backingCtx      = null;
    this._backingSource   = null;

    /* metronome */
    this._metronome       = null;
    this._metronomeEvents = [];
    this._metronomeOn     = false;

    this._initialized = false;
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  async init() {
    if (this._initialized) return;
    await Tone.start();

    this.masterMeter      = new Tone.Meter({ channels: 2, smoothing: 0.85 });
    this.masterLimiter    = new Tone.Limiter(-0.5);
    // Tone.StereoWidener: 0=mono, 0.5=normal, 1=all-side (kills center!). Start at 0.5.
    this.masterWidener    = new Tone.StereoWidener(0.5);
    this.masterCompressor = new Tone.Compressor({ threshold: 0, ratio: 1, attack: 0.03, release: 0.25 });
    this.masterEq         = new Tone.EQ3(0, 0, 0);
    this.masterSubCut     = new Tone.Filter({ type: 'highpass', frequency: 20, rolloff: -12 });
    this.masterGain       = new Tone.Gain(1);
    this.outputTap        = new Tone.Gain(1);
    this.speakerGate      = new Tone.Gain(1);

    this.masterGain.chain(
      this.masterSubCut,
      this.masterEq,
      this.masterCompressor,
      this.masterWidener,
      this.masterLimiter,
      this.masterMeter,
    );
    this.masterMeter.connect(this.outputTap);
    this.outputTap.connect(this.speakerGate);
    this.speakerGate.connect(Tone.getDestination());

    /* click synth for metronome — lewat outputTap supaya ikut di-mute dari GP-200 saat rekam */
    this._metronome = new Tone.MembraneSynth({
      pitchDecay: 0.008,
      octaves: 2,
      envelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.04 },
    });
    this._metronome.connect(this.outputTap);
    this._metronome.volume.value = -6;

    this._initialized = true;
  }

  dispose() {
    this.stop();
    this.stopRecording();
    this.stopAllInputMonitors();
    for (const [id] of this.trackNodes) this.removeTrackNode(id);
    this.masterGain?.dispose();
    this.outputTap?.dispose();
    this.speakerGate?.dispose();
    this.masterSubCut?.dispose();
    this.masterEq?.dispose();
    this.masterCompressor?.dispose();
    this.masterWidener?.dispose();
    this.masterLimiter?.dispose();
    this.masterMeter?.dispose();
    this._metronome?.dispose();
    this.audioBuffers.clear();
    this._initialized = false;
  }

  // ── Track node management ───────────────────────────────────────

  createTrackNode(trackId) {
    if (this.trackNodes.has(trackId)) return;
    if (!this.masterGain) return; // engine not initialized yet

    try {
      const meter      = new Tone.Meter({ channels: 2, smoothing: 0.85 });
      const channel    = new Tone.Channel(0, 0);
      const eq         = new Tone.EQ3(0, 0, 0);
      const compressor = new Tone.Compressor({ threshold: 0, ratio: 1, attack: 0.003, release: 0.25 });
      const pitchShift = new Tone.PitchShift({ pitch: 0, windowSize: 0.08, wet: 0 });
      const delay      = new Tone.FeedbackDelay({ delayTime: '8n', feedback: 0.3, wet: 0 });
      const reverb     = new Tone.Reverb({ decay: 1.5, wet: 0 });
      reverb.generate().catch(() => {}); // Generate IR for reverb
      const guitarDist = new Tone.Distortion(0);
      guitarDist.wet.value = 0;
      const saturation = new Tone.Distortion(0);
      saturation.wet.value = 0;
      const noiseGate  = new Tone.Gate({ threshold: -100, smoothing: 0.05 });
      const lowCut     = new Tone.Filter({ type: 'highpass', frequency: 20, rolloff: -12 });
      const chorus     = new Tone.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.7, wet: 0 });
      try { chorus.start(); } catch (_) {}
      const inputGain  = new Tone.Gain(1);
      const synth      = new Tone.PolySynth(Tone.Synth).connect(inputGain);

      // Gate di akhir prep — threshold -100 ≈ bypass (hampir semua sinyal lolos)
      // PitchShift ditempatkan setelah compressor, sebelum chorus (standar industri)
      inputGain.chain(
        noiseGate,
        lowCut,
        guitarDist,
        saturation,
        eq,
        compressor,
        pitchShift,
        chorus,
        delay,
        reverb,
        channel,
        meter,
        this.masterGain
      );

      this.trackNodes.set(trackId, {
        inputGain,
        noiseGate,
        lowCut,
        guitarDist,
        saturation,
        eq,
        compressor,
        pitchShift,
        chorus,
        reverb,
        delay,
        channel,
        meter,
        synth,
        soloMuted: false
      });
    } catch (err) {
      console.error('createTrackNode failed:', trackId, err);
    }
  }

  removeTrackNode(trackId) {
    const n = this.trackNodes.get(trackId);
    if (!n) return;
    if (n.midiParts) {
      n.midiParts.forEach(part => { try { part.dispose(); } catch(e){} });
    }
    this._disposeMidiInstrument(n);
    [n.inputGain, n.noiseGate, n.lowCut, n.guitarDist, n.saturation, n.eq, n.compressor, n.pitchShift, n.chorus, n.reverb, n.delay, n.channel, n.meter].forEach(x => {
      try { x?.disconnect?.(); } catch (e) { /* ignore */ }
      try { x?.dispose?.(); } catch (e) { /* ignore */ }
    });
    this.trackNodes.delete(trackId);
  }

  // ── Track property setters ──────────────────────────────────────

  setTrackVolume(trackId, db) {
    const n = this.trackNodes.get(trackId);
    if (n) n.channel.volume.value = clamp(db, -60, 12);
  }

  setTrackPan(trackId, pan) {
    const n = this.trackNodes.get(trackId);
    if (n) n.channel.pan.value = clamp(pan, -1, 1);
  }

  _disposeMidiInstrument(node) {
    if (!node) return;
    if (node.synth) {
      try { node.synth.releaseAll(); } catch (_) {}
      try { node.synth.dispose(); } catch (_) {}
      node.synth = null;
    }
    if (node.synthInserts) {
      node.synthInserts.forEach((unit) => {
        try { unit.dispose(); } catch (_) {}
      });
      node.synthInserts = [];
    }
  }

  _connectMidiInstrument(node, synth, inserts = []) {
    node.synth = synth;
    node.synthInserts = inserts;
    let head = synth;
    for (const unit of inserts) {
      head.connect(unit);
      head = unit;
    }
    const dest = node.inputGain || node.channel;
    head.connect(dest);
  }

  setupMidiInstrument(trackId, synthConfig) {
    const node = this.trackNodes.get(trackId);
    if (!node) return;

    const configStr = JSON.stringify({ rev: 7, ...(synthConfig || {}) });
    if (node._currentSynthConfig === configStr && node.synth) {
      return;
    }
    node._currentSynthConfig = configStr;
    this._disposeMidiInstrument(node);

    const kind = synthConfig?.type || 'keys';
    const tone = synthConfig?.tone || 'clean';

    try {
      if (kind === 'guitar') {
        this._setupGuitarInstrument(node, tone);
      } else if (kind === 'bass') {
        this._setupBassInstrument(node, tone);
      } else {
        const synth = new Tone.PolySynth(Tone.Synth, {
          oscillator: { type: 'triangle' },
          envelope: { attack: 0.008, decay: 0.18, sustain: 0.45, release: 0.28 },
        });
        synth.maxPolyphony = 64;
        synth.volume.value = -4;
        const filter = new Tone.Filter(4500, 'lowpass');
        const reverb = new Tone.Reverb({ decay: 1.4, wet: 0.12, preDelay: 0.01 });
        reverb.generate().catch(() => {});
        this._connectMidiInstrument(node, synth, [filter, reverb]);
      }
    } catch (e) {
      console.error('Tone.js Synth creation failed:', e);
      const fallback = new Tone.PolySynth(Tone.Synth);
      fallback.maxPolyphony = 64;
      fallback.volume.value = -4;
      this._connectMidiInstrument(node, fallback);
    }
  }

  _setupGuitarInstrument(node, tone) {
    const synth = createGuitarPluckInstrument(tone);
    this._connectMidiInstrument(node, synth, []);
  }

  _setupBassInstrument(node, tone) {
    const voices = {
      sawtooth: {
        oscillator: { type: 'fatsawtooth', spread: 8, count: 2 },
        envelope: { attack: 0.01, decay: 0.22, sustain: 0.55, release: 0.22 },
        filter: { type: 'lowpass', Q: 1.4, rolloff: -24 },
        filterEnvelope: { attack: 0.01, decay: 0.18, sustain: 0.25, release: 0.18, baseFrequency: 90, octaves: 2.4 },
      },
      sine: {
        oscillator: { type: 'sine' },
        envelope: { attack: 0.008, decay: 0.28, sustain: 0.6, release: 0.28 },
        filter: { type: 'lowpass', Q: 0.7, rolloff: -12 },
        filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.3, release: 0.2, baseFrequency: 70, octaves: 1.8 },
      },
      square: {
        oscillator: { type: 'fatsquare', spread: 10, count: 2 },
        envelope: { attack: 0.01, decay: 0.18, sustain: 0.5, release: 0.2 },
        filter: { type: 'lowpass', Q: 1.8, rolloff: -24 },
        filterEnvelope: { attack: 0.008, decay: 0.14, sustain: 0.2, release: 0.16, baseFrequency: 110, octaves: 2.2 },
      },
    };
    const synth = new Tone.PolySynth(Tone.MonoSynth, voices[tone] || voices.sawtooth);
    synth.maxPolyphony = 8;
    synth.volume.value = -4;
    const filter = new Tone.Filter(420, 'lowpass');
    const comp = new Tone.Compressor({ threshold: -18, ratio: 4, attack: 0.02, release: 0.16 });
    this._connectMidiInstrument(node, synth, [filter, comp]);
  }

  setTrackMute(trackId, muted) {
    const n = this.trackNodes.get(trackId);
    if (n) n.channel.mute = muted;
  }

  /** Call whenever solo state changes on any track. */
  updateSoloState(tracks) {
    const anySoloed = tracks.some(t => t.solo);
    for (const t of tracks) {
      const n = this.trackNodes.get(t.id);
      if (!n) continue;
      if (anySoloed) {
        n.soloMuted = !t.solo;
        n.channel.mute = t.mute || n.soloMuted;
      } else {
        n.soloMuted = false;
        n.channel.mute = t.mute;
      }
    }
  }

  setTrackReverb(trackId, wet) {
    const n = this.trackNodes.get(trackId);
    if (n) n.reverb.wet.value = clamp(wet, 0, 1);
  }

  setTrackDelay(trackId, wet) {
    const n = this.trackNodes.get(trackId);
    if (n) n.delay.wet.value = clamp(wet, 0, 1);
  }

  setTrackEffects(trackId, effects) {
    const n = this.trackNodes.get(trackId);
    if (!n || !effects) return;

    try {
      // 1. Noise Gate — Tone.Gate.threshold is a plain getter/setter (not .value)
      if (effects.gate && n.noiseGate) {
        n.noiseGate.threshold = effects.gate.enabled
          ? clamp(effects.gate.threshold ?? -45, -90, -10)
          : -100;
      }

      // 2. Low Cut / HPF Filter
      if (effects.lowCut && n.lowCut) {
        n.lowCut.frequency.value = effects.lowCut.enabled ? clamp(effects.lowCut.frequency ?? 80, 20, 500) : 20;
      }

      // 3. Analog Tape Saturation
      if (effects.saturation && n.saturation) {
        if (effects.saturation.enabled) {
          const drive = clamp(effects.saturation.drive ?? 0.3, 0, 1);
          n.saturation.distortion = drive * 0.6;
          n.saturation.wet.value = clamp(effects.saturation.warmth ?? 0.7, 0, 1);
        } else {
          n.saturation.wet.value = 0;
        }
      }

      // 4. Guitar Amp Simulator
      if (effects.guitar && n.guitarDist) {
        if (effects.guitar.enabled) {
          if (effects.guitar.mode === 'clean') {
            n.guitarDist.distortion = 0;
            n.guitarDist.wet.value = 0;
          } else if (effects.guitar.mode === 'overdrive') {
            n.guitarDist.distortion = clamp(effects.guitar.drive ?? 0.5, 0, 1) * 0.4;
            n.guitarDist.wet.value = 1;
          } else if (effects.guitar.mode === 'distortion') {
            n.guitarDist.distortion = clamp(effects.guitar.drive ?? 0.5, 0, 1) * 0.8 + 0.2;
            n.guitarDist.wet.value = 1;
          }
        } else {
          n.guitarDist.wet.value = 0;
        }
      }

      // 5. EQ (3-band)
      if (effects.eq && n.eq) {
        n.eq.low.value  = clamp(effects.eq.low  || 0, -18, 18);
        n.eq.mid.value  = clamp(effects.eq.mid  || 0, -18, 18);
        n.eq.high.value = clamp(effects.eq.high || 0, -18, 18);
      }

      // 6. Compressor
      if (effects.compressor && n.compressor) {
        if (effects.compressor.enabled) {
          n.compressor.threshold.value = clamp(effects.compressor.threshold ?? -24, -60, 0);
          n.compressor.ratio.value     = clamp(effects.compressor.ratio     ?? 4,   1, 20);
          n.compressor.attack.value    = clamp(effects.compressor.attack    ?? 0.003, 0.001, 1);
          n.compressor.release.value   = clamp(effects.compressor.release   ?? 0.25, 0.01, 2);
        } else {
          n.compressor.threshold.value = 0;
          n.compressor.ratio.value     = 1;
        }
      }

      // 7. Stereo Chorus / Doubler
      if (effects.chorus && n.chorus) {
        if (effects.chorus.enabled) {
          n.chorus.wet.value = clamp(effects.chorus.wet ?? 0.35, 0, 1);
          if (effects.chorus.depth !== undefined) n.chorus.depth = clamp(effects.chorus.depth, 0, 1);
          if (effects.chorus.rate !== undefined) n.chorus.frequency.value = clamp(effects.chorus.rate, 0.1, 10);
        } else {
          n.chorus.wet.value = 0;
        }
      }

      // 8. Delay
      if (effects.delay && n.delay) {
        n.delay.wet.value = effects.delay.enabled ? clamp(effects.delay.wet ?? 0.2, 0, 1) : 0;
        if (effects.delay.enabled) {
          n.delay.feedback.value = clamp(effects.delay.feedback ?? 0.3, 0, 0.95);
        }
      }

      // 9. Reverb
      if (effects.reverb && n.reverb) {
        n.reverb.wet.value = effects.reverb.enabled ? clamp(effects.reverb.wet ?? 0.3, 0, 1) : 0;
      }

      // 10. Pitch Shift / Transpose (Capo Digital)
      if (effects.pitchShift && n.pitchShift) {
        if (effects.pitchShift.enabled) {
          n.pitchShift.pitch = clamp(effects.pitchShift.pitch ?? 0, -12, 12);
          n.pitchShift.wet.value = clamp(effects.pitchShift.wet ?? 1, 0, 1);
          if (effects.pitchShift.windowSize !== undefined) {
            n.pitchShift.windowSize = clamp(effects.pitchShift.windowSize, 0.03, 0.15);
          }
        } else {
          n.pitchShift.wet.value = 0;
        }
      }
    } catch (err) {
      console.error('setTrackEffects failed:', trackId, err);
    }
  }

  /** Shortcut: set pitch shift semitones for a track in real-time. */
  setTrackPitchShift(trackId, semitones) {
    const n = this.trackNodes.get(trackId);
    if (n && n.pitchShift) {
      n.pitchShift.pitch = clamp(semitones, -12, 12);
      if (semitones !== 0) {
        n.pitchShift.wet.value = 1;
      }
    }
  }

  // ── Audio loading ───────────────────────────────────────────────

  async loadAudioFile(file) {
    await this.init();
    const audioId = 'audio_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const arrayBuffer = await file.arrayBuffer();
    const ctx = Tone.getContext().rawContext;
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const peaks = extractPeaks(decoded, 4096);
    this.audioBuffers.set(audioId, { buffer: decoded, peaks });
    return { audioId, name: file.name, duration: decoded.duration, sampleRate: decoded.sampleRate, channels: decoded.numberOfChannels, peaks };
  }

  async importAudioBuffer(audioBuffer, name = 'Recording') {
    await this.init();
    const audioId = 'audio_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const peaks = extractPeaks(audioBuffer, 4096);
    this.audioBuffers.set(audioId, { buffer: audioBuffer, peaks });
    return {
      audioId,
      name,
      duration: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      channels: audioBuffer.numberOfChannels,
      peaks,
    };
  }

  async loadAudioUrl(url, name) {
    await this.init();
    const audioId = 'audio_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const resp = await fetch(url);
    const arrayBuffer = await resp.arrayBuffer();
    const ctx = Tone.getContext().rawContext;
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    const peaks = extractPeaks(decoded, 4096);
    this.audioBuffers.set(audioId, { buffer: decoded, peaks });
    return { audioId, name: name || 'audio', duration: decoded.duration, sampleRate: decoded.sampleRate, channels: decoded.numberOfChannels, peaks };
  }

  removeAudioBuffer(audioId) {
    this.audioBuffers.delete(audioId);
  }

  getWaveformPeaks(audioId) {
    const d = this.audioBuffers.get(audioId);
    return d ? d.peaks : null;
  }

  getAudioDuration(audioId) {
    const d = this.audioBuffers.get(audioId);
    return d ? d.buffer.duration : 0;
  }

  // ── Playback ────────────────────────────────────────────────────
  // ── Playback ────────────────────────────────────────────────----

  getCurrentPosition() {
    if (!this._playing) return this._startProjTime;
    let pos = this._startProjTime + (Tone.now() - this._startCtxTime);
    if (this._loopEnabled && pos >= this._loopEnd) {
      const loopLen = this._loopEnd - this._loopStart;
      if (loopLen > 0) pos = this._loopStart + ((pos - this._loopStart) % loopLen);
    }
    return pos;
  }

  isCurrentlyPlaying() {
    return this._playing;
  }

  play(position, tracks, { loopEnabled = false, loopStart = 0, loopEnd = 16, bpm = 120, skipTrackIds = null } = {}) {
    this.stop();

    this._loopEnabled   = loopEnabled;
    this._loopStart     = loopStart;
    this._loopEnd       = loopEnd;
    this._startProjTime = position;
    this._startCtxTime  = Tone.now();
    this._playNativeCtxTime = getNativeAudioContext()?.currentTime ?? this._startCtxTime;
    this._playing       = true;
    this._playTracks    = tracks;
    this._skipTrackIds  = skipTrackIds ? new Set(skipTrackIds) : null;
    this._playOpts      = { loopEnabled, loopStart, loopEnd, bpm, skipTrackIds };

    const scheduleTime = Tone.now() + 0.05;
    this._scheduleAllRegions(position, tracks, this._skipTrackIds, scheduleTime);

    if (this._metronomeOn) this._startMetronome(bpm, position);

    this._startPlayheadLoop(tracks, bpm);
  }

  stop() {
    this._playing = false;
    this._stopPlayheadLoop();
    this._stopAllPlayers();
    this._stopRegionPreview();
    this._stopMetronome();
  }

  /** Restart playback from a new position (seek). */
  seekTo(position, tracks, opts) {
    const wasPlaying = this._playing;
    this.stop();
    this._startProjTime = position;
    if (wasPlaying) this.play(position, tracks, opts || this._playOpts || {});
  }

  // -- internal scheduling --

  _scheduleAllRegions(fromPosition, tracks, skipTrackIds, scheduleTime = null) {
    if (!scheduleTime) scheduleTime = Tone.now();
    this._stopAllPlayers();

    for (const track of tracks) {
      const node = this.trackNodes.get(track.id);
      if (!node || track.mute || node.soloMuted) continue;
      // Overdub: jangan putar region lama di track yang sedang di-record
      if (skipTrackIds && skipTrackIds.has(track.id)) continue;

      for (const region of (track.regions || [])) {
        if (region.type === 'midi') {
          const bakedAudio = region.audioId ? this.audioBuffers.get(region.audioId) : null;
          if (bakedAudio) {
            this._scheduleAudioRegion(node, region, fromPosition, scheduleTime);
            continue;
          }

          const regEnd = region.startTime + region.duration;
          if (regEnd <= fromPosition) continue;
          
          if (!node.synth) continue;

          for (const note of (region.notes || [])) {
            if (note.muted) continue;
            const absNoteStart = region.startTime + note.startTime;
            const rawDur = Number(note.duration);
            let dur = Number.isFinite(rawDur) && rawDur > 0 ? rawDur : 0.2;
            if (absNoteStart + dur <= fromPosition) continue;
            const vel = midiPlaybackVelocity(note.velocity);

            try {
              if (absNoteStart >= fromPosition) {
                const delay = absNoteStart - fromPosition;
                node.synth.triggerAttackRelease(note.pitch, dur, scheduleTime + delay, vel);
              } else {
                const elapsed = fromPosition - absNoteStart;
                const remaining = dur - elapsed;
                if (remaining > 0) {
                  node.synth.triggerAttackRelease(note.pitch, remaining, scheduleTime, vel);
                }
              }
            } catch (err) {}
          }
          continue;
        }

        this._scheduleAudioRegion(node, region, fromPosition, scheduleTime);
      }
    }
  }

  _scheduleAudioRegion(node, region, fromPosition, scheduleTime) {
    const audioData = this.audioBuffers.get(region.audioId);
    if (!audioData || !node) return;

    const regEnd = region.startTime + region.duration;
    if (regEnd <= fromPosition) return;

    const toneBuffer = new Tone.ToneAudioBuffer(audioData.buffer);
    const player = new Tone.Player(toneBuffer);
    player.connect(node.inputGain);

    if (region.gain) player.volume.value = region.gain;
    if (typeof player.fadeIn === 'number' || 'fadeIn' in player) {
      player.fadeIn = region.fadeIn || 0;
    }
    if (typeof player.fadeOut === 'number' || 'fadeOut' in player) {
      player.fadeOut = region.fadeOut || 0;
    }

    if (region.startTime >= fromPosition) {
      const delay = region.startTime - fromPosition;
      try {
        player.start(scheduleTime + delay, region.offset || 0, region.duration);
      } catch (e) {
        console.error('Player start failed:', region.name || region.id, e);
      }
    } else {
      const elapsed = fromPosition - region.startTime;
      const remaining = region.duration - elapsed;
      if (remaining > 0) {
        try {
          player.start(Tone.now(), (region.offset || 0) + elapsed, remaining);
        } catch (e) {
          console.error('Player start failed:', region.name || region.id, e);
        }
      }
    }

    this.activePlayers.set(region.id, player);
  }

  _stopAllPlayers() {
    for (const p of this.activePlayers.values()) {
      try { p.stop(); } catch (_) { /* ignore */ }
      try { p.dispose(); } catch (_) { /* ignore */ }
    }
    this.activePlayers.clear();

    for (const node of this.trackNodes.values()) {
      if (node.players) {
        node.players.forEach(p => {
          try { p.stop(); p.dispose(); } catch (e) { /* ignore */ }
        });
        node.players = [];
      }
      if (node.midiParts) {
        node.midiParts.forEach(part => { try { part.dispose(); } catch(e){} });
        node.midiParts = [];
      }
      if (node.synth) {
        try { node.synth.releaseAll(); } catch (_) {}
      }
    }
  }

  previewNote(pitch, trackId = null) {
    this._ensurePlaybackToSpeakers();
    const freq = this._pitchToFreq(pitch);
    const ctx = this._rawCtx();
    if (ctx && ctx.state === 'running') {
      this._nativeBeep(ctx, freq, ctx.currentTime, 0.18, 0.22);
    }
    try {
      const dest = this.outputTap || Tone.getDestination();
      if (!this._previewSynth) {
        this._previewSynth = new Tone.PolySynth(Tone.Synth, {
          oscillator: { type: 'triangle' },
          envelope: { attack: 0.005, decay: 0.18, sustain: 0.2, release: 0.12 },
        });
        this._previewSynth.maxPolyphony = 16;
        this._previewSynth.volume.value = -2;
        this._previewSynth.connect(dest);
      }
      this._previewSynth.triggerAttackRelease(pitch, '8n', Tone.now(), 0.9);
    } catch (_) {
      const node = trackId ? this.trackNodes.get(trackId) : null;
      try { node?.synth?.triggerAttackRelease(pitch, '8n', Tone.now(), 0.9); } catch (e) { /* ignore */ }
    }
  }

  _rawCtx() {
    return Tone.getContext()?.rawContext
      || Tone.getContext()?._nativeAudioContext
      || getNativeAudioContext();
  }

  _pitchToFreq(pitch) {
    try {
      const f = Tone.Frequency(pitch).toFrequency();
      return Number.isFinite(f) && f > 0 ? f : 261.63;
    } catch (_) {
      return 261.63;
    }
  }

  _nativeBeep(ctx, freq, when, dur, gainVal) {
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, when);
      const peak = Math.max(0.04, Math.min(0.28, gainVal));
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(peak, when + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + Math.max(0.05, dur));
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(when);
      osc.stop(when + Math.max(0.06, dur) + 0.04);
      this._nativePreviewNodes = this._nativePreviewNodes || [];
      this._nativePreviewNodes.push({ osc, gain });
    } catch (_) { /* ignore */ }
  }

  async previewRegionNotes(notes, { regionStart = 0, audioId = null } = {}) {
    await this.init();
    await this._ensureAudioRunning();
    this._ensurePlaybackToSpeakers();

    this._stopPlayheadLoop();
    this._stopAllPlayers();
    this._stopRegionPreview();
    this._stopMetronome();

    const dest = this.outputTap || this.masterGain || Tone.getDestination();
    const ctx = this._rawCtx();
    const list = Array.isArray(notes) ? notes.filter(n => n && !n.muted && n.pitch) : [];

    const baked = audioId ? this.audioBuffers.get(audioId) : null;
    let usedBaked = false;
    if (baked?.buffer) {
      try {
        const player = new Tone.Player(new Tone.ToneAudioBuffer(baked.buffer));
        player.connect(dest);
        player.volume.value = -1;
        player.start(Tone.now() + 0.02);
        this._regionPreviewPlayer = player;
        usedBaked = true;
      } catch (_) { /* fall through to notes */ }
    }

    if (!usedBaked && list.length) {
      try {
        const synth = new Tone.PolySynth(Tone.Synth, {
          oscillator: { type: 'triangle' },
          envelope: { attack: 0.005, decay: 0.22, sustain: 0.28, release: 0.14 },
        });
        synth.maxPolyphony = 48;
        synth.volume.value = -1;
        synth.connect(dest);
        this._regionPreviewSynth = synth;
        const t0 = Tone.now() + 0.03;
        for (const note of list) {
          const start = Math.max(0, Number(note.startTime) || 0);
          const dur = Math.max(0.08, Number(note.duration) || 0.22);
          const vel = Math.min(1, Math.max(0.55, Number(note.velocity) || 0.85));
          try { synth.triggerAttackRelease(note.pitch, dur, t0 + start, vel); } catch (_) {}
        }
      } catch (_) { /* ignore */ }

      if (ctx) {
        const base = (ctx.currentTime || 0) + 0.03;
        for (const note of list) {
          const start = Math.max(0, Number(note.startTime) || 0);
          const dur = Math.max(0.08, Number(note.duration) || 0.22);
          const vel = Math.min(1, Math.max(0.55, Number(note.velocity) || 0.85));
          this._nativeBeep(ctx, this._pitchToFreq(note.pitch), base + start, dur, 0.16 * vel);
        }
      }
    }

    this._playing = true;
    this._loopEnabled = false;
    this._startProjTime = regionStart;
    this._startCtxTime = Tone.now();
    this._startPlayheadLoop([], 120);
  }

  _stopRegionPreview() {
    if (this._regionPreviewSynth) {
      try { this._regionPreviewSynth.releaseAll(); } catch (_) {}
      try { this._regionPreviewSynth.dispose(); } catch (_) {}
      this._regionPreviewSynth = null;
    }
    if (this._regionPreviewPlayer) {
      try { this._regionPreviewPlayer.stop(); } catch (_) {}
      try { this._regionPreviewPlayer.dispose(); } catch (_) {}
      this._regionPreviewPlayer = null;
    }
    if (this._nativePreviewNodes?.length) {
      for (const n of this._nativePreviewNodes) {
        try { n.osc.stop(); } catch (_) {}
        try { n.osc.disconnect(); } catch (_) {}
        try { n.gain.disconnect(); } catch (_) {}
      }
      this._nativePreviewNodes = [];
    }
  }

  setRegionGainRealtime(regionId, gainDb) {
    const player = this.activePlayers.get(regionId);
    if (player && player.volume) {
      player.volume.rampTo(clamp(gainDb, -60, 24), 0.05);
    }
  }

  // -- playhead animation --

  _startPlayheadLoop(tracks, bpm) {
    const tick = () => {
      if (!this._playing) return;
      const pos = this.getCurrentPosition();

      // Check if we need to loop
      if (this._loopEnabled && pos >= this._loopEnd) {
        this.play(this._loopStart, tracks, this._playOpts || {
          loopEnabled: this._loopEnabled,
          loopStart:   this._loopStart,
          loopEnd:     this._loopEnd,
          bpm,
        });
        return;
      }

      if (this.onPlayheadUpdate) this.onPlayheadUpdate(pos);
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  _stopPlayheadLoop() {
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
  }

  // ── Metronome ───────────────────────────────────────────────────

  setMetronomeEnabled(on, bpm = 120) {
    this._metronomeOn = on;
    if (this._playing) {
      if (on) this._startMetronome(bpm, this.getCurrentPosition());
      else this._stopMetronome();
    }
  }

  _startMetronome(bpm, fromPosition) {
    this._stopMetronome();
    if (!this._metronome) return;
    const beatSec = 60 / bpm;
    // find next beat after fromPosition
    let nextBeat = Math.ceil(fromPosition / beatSec) * beatSec;
    const schedule = () => {
      if (!this._playing || !this._metronomeOn) return;
      const pos = this.getCurrentPosition();
      if (pos >= nextBeat - 0.02) {
        const note = (Math.round(nextBeat / beatSec) % 4 === 0) ? 'C3' : 'C4';
        try { this._metronome.triggerAttackRelease(note, '32n'); } catch (_) { /**/ }
        nextBeat += beatSec;
      }
      this._metronomeRaf = requestAnimationFrame(schedule);
    };
    this._metronomeRaf = requestAnimationFrame(schedule);
  }

  _stopMetronome() {
    if (this._metronomeRaf) { cancelAnimationFrame(this._metronomeRaf); this._metronomeRaf = null; }
  }

  // ── Master controls & Mastering Suite ─────────────────────────

  setMasterVolume(db) {
    if (this.masterGain) this.masterGain.gain.value = dbToGain(clamp(db, -60, 12));
  }

  setMasterLimiter(enabled, ceilingDb = -0.5) {
    if (this.masterLimiter) {
      this.masterLimiter.threshold.value = enabled ? clamp(ceilingDb, -6, 0) : 0;
    }
  }

  setMasterEq(eq) {
    if (!this.masterEq || !eq) return;
    this.masterEq.low.value  = clamp(eq.low || 0, -12, 12);
    this.masterEq.mid.value  = clamp(eq.mid || 0, -12, 12);
    this.masterEq.high.value = clamp(eq.high || 0, -12, 12);
    if (this.masterSubCut) {
      this.masterSubCut.frequency.value = eq.subCut ? 30 : 20;
    }
  }

  setMasterCompressor(comp) {
    if (!this.masterCompressor || !comp) return;
    if (comp.enabled) {
      this.masterCompressor.threshold.value = clamp(comp.threshold ?? -12, -40, 0);
      this.masterCompressor.ratio.value     = clamp(comp.ratio ?? 2.5, 1, 10);
      this.masterCompressor.attack.value    = clamp(comp.attack ?? 0.03, 0.001, 0.5);
      this.masterCompressor.release.value   = clamp(comp.release ?? 0.25, 0.05, 1.5);
    } else {
      this.masterCompressor.threshold.value = 0;
      this.masterCompressor.ratio.value     = 1;
    }
  }

  /**
   * Convert UI stereo-width (0=mono, 1=normal, 2=max wide) to Tone.StereoWidener
   * range (0=all mid, 0.5=normal, 1=all side).
   */
  _uiWidthToTone(uiWidth) {
    return clamp((uiWidth ?? 1) * 0.5, 0, 1);
  }

  setMasterStereoWidth(width = 1.0, isMono = false) {
    this._masterWidth = clamp(width, 0, 2);
    this._masterIsMono = isMono;
    if (this.masterWidener) {
      this.masterWidener.width.value = isMono ? 0 : this._uiWidthToTone(this._masterWidth);
    }
  }

  setMasterSuite(suite) {
    if (!suite) return;
    if (suite.eq) this.setMasterEq(suite.eq);
    if (suite.compressor) this.setMasterCompressor(suite.compressor);
    if (suite.width !== undefined || suite.isMono !== undefined) {
      this.setMasterStereoWidth(suite.width ?? this._masterWidth, suite.isMono ?? this._masterIsMono);
    }
    if (suite.limiter) {
      this.setMasterLimiter(suite.limiter.enabled ?? true, suite.limiter.ceiling ?? -0.5);
    }
  }

  // ── Metering ────────────────────────────────────────────────────

  getTrackMeterLevel(trackId) {
    const n = this.trackNodes.get(trackId);
    if (!n) return -100;
    const val = n.meter.getValue();
    return typeof val === 'number' ? val : (Array.isArray(val) ? Math.max(...val) : -100);
  }

  getMasterMeterLevel() {
    if (!this.masterMeter) return -100;
    const val = this.masterMeter.getValue();
    return typeof val === 'number' ? val : (Array.isArray(val) ? Math.max(...val) : -100);
  }

  getAllMeterLevels(trackIds) {
    const levels = {};
    for (const id of trackIds) levels[id] = this.getTrackMeterLevel(id);
    levels._master = this.getMasterMeterLevel();
    return levels;
  }

  // ── Input monitor (alat musik / mic → track) ────────────────────

  async startInputMonitor(trackId, inputId = 'default') {
    await this._ensureAudioRunning();
    await this.init();
    if (!this.trackNodes.has(trackId)) this.createTrackNode(trackId);
    const node = this.trackNodes.get(trackId);
    if (!node) throw new Error('Track node tidak tersedia');

    this.stopInputMonitor(trackId);

    const baseAudio = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2, min: 1 },
    };
    const constraints = { audio: { ...baseAudio } };
    if (inputId && inputId !== 'default') {
      constraints.audio.deviceId = { exact: inputId };
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (inputId && inputId !== 'default') {
        throw new Error('Gagal buka input yang dipilih. Pilih Line Valeton GP-200 (bukan Default/Communications), lalu Arm lagi.');
      }
      throw err;
    }

    const ctx = getNativeAudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const meter = new Tone.Meter({ smoothing: 0.65 });
    // Direct to master — jangan lewat delay/reverb track (itu yang bikin gema).
    const monitorGain = new Tone.Gain(0);

    try {
      source.connect(meter.input);
    } catch (_) {
      Tone.connect(source, meter);
    }
    meter.connect(monitorGain);
    if (this.masterGain) {
      monitorGain.connect(this.masterGain);
    }

    this._inputMonitors.set(trackId, {
      stream,
      source,
      meter,
      monitorGain,
      inputId: inputId || 'default',
      livePeaks: [],
      recording: false,
    });
    return true;
  }

  stopInputMonitor(trackId) {
    const m = this._inputMonitors.get(trackId);
    if (!m) return;
    this._stopLivePeakCapture(m);
    this._stopPcmCapture(m);
    try { m.source?.disconnect(); } catch (_) { /* ignore */ }
    try { m.meter?.disconnect(); } catch (_) { /* ignore */ }
    try { m.monitorGain?.disconnect(); } catch (_) { /* ignore */ }
    try { m.meter?.dispose(); } catch (_) { /* ignore */ }
    try { m.monitorGain?.dispose(); } catch (_) { /* ignore */ }
    try { m.stream?.getTracks().forEach(t => t.stop()); } catch (_) { /* ignore */ }
    this._inputMonitors.delete(trackId);
  }

  stopAllInputMonitors() {
    for (const id of [...this._inputMonitors.keys()]) this.stopInputMonitor(id);
  }

  setInputMonitorAudible(trackId, audible) {
    const m = this._inputMonitors.get(trackId);
    if (!m?.monitorGain) return;
    m.monitorGain.gain.value = audible ? 1 : 0;
  }

  isInputMonitorActive(trackId) {
    return this._inputMonitors.has(trackId);
  }

  getInputMonitorLevel(trackId) {
    const m = this._inputMonitors.get(trackId);
    if (!m?.meter) return -100;
    const val = m.meter.getValue();
    if (Array.isArray(val)) return Math.max(val[0] ?? -100, val[1] ?? -100);
    return typeof val === 'number' ? val : -100;
  }

  getInputMonitorStream(trackId) {
    const m = this._inputMonitors.get(trackId);
    return m?.stream || null;
  }

  getLiveRecordPeaks(trackId) {
    const m = this._inputMonitors.get(trackId);
    return m?.livePeaks || [];
  }

  _stopLivePeakCapture(m) {
    if (!m) return;
    m.recording = false;
    if (m.peakRaf) {
      cancelAnimationFrame(m.peakRaf);
      m.peakRaf = 0;
    }
    if (m.liveAnalyser) {
      try { m.source?.disconnect(m.liveAnalyser); } catch (_) { /* ignore */ }
      try { m.liveAnalyser.disconnect(); } catch (_) { /* ignore */ }
      m.liveAnalyser = null;
    }
  }

  _startLivePeakCapture(m) {
    this._stopLivePeakCapture(m);
    const ctx = Tone.getContext().rawContext;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    try { m.source.connect(analyser); } catch (_) { /* ignore */ }
    m.liveAnalyser = analyser;
    m.livePeaks = [];
    m.recording = true;
    const data = new Float32Array(analyser.fftSize);
    let frames = 0;
    const tick = () => {
      if (!m.recording) return;
      m.peakRaf = requestAnimationFrame(tick);
      frames += 1;
      if (frames % 3 !== 0) return;
      analyser.getFloatTimeDomainData(data);
      let min = 0;
      let max = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      m.livePeaks.push({ min, max });
    };
    m.peakRaf = requestAnimationFrame(tick);
  }

  async _decodeRecordBlob(blob) {
    if (!blob || blob.size < 64) return null;
    const ctx = Tone.getContext().rawContext;
    const arr = await blob.arrayBuffer();
    try {
      return await ctx.decodeAudioData(arr.slice(0));
    } catch (err) {
      console.error('decode recording failed', err);
      return null;
    }
  }

  async _ensureAudioRunning() {
    await Tone.start();
    const ctx = Tone.getContext();
    if (ctx.state !== 'running') {
      await ctx.resume();
    }
    const raw = ctx.rawContext;
    if (raw && raw.state !== 'running') {
      await raw.resume();
    }
  }

  async setOutputDevice(deviceId) {
    const id = deviceId && deviceId !== 'default' ? deviceId : '';
    this._outputDeviceId = id;
    if (!this._sinkLocked) await this.applyOutputSink(id);
    return true;
  }

  _sinkContexts() {
    const list = [];
    const add = (c) => {
      if (c && typeof c.setSinkId === 'function' && !list.includes(c)) list.push(c);
    };
    add(getNativeAudioContext());
    add(Tone.getContext()?.rawContext);
    add(Tone.getContext()?._nativeAudioContext);
    add(Tone.getDestination()?.context);
    return list;
  }

  async applyOutputSink(deviceId) {
    const id = deviceId && deviceId !== 'default' ? deviceId : '';
    let ok = false;
    for (const ctx of this._sinkContexts()) {
      try {
        await ctx.setSinkId(id);
        ok = true;
      } catch (err) {
        console.warn('setSinkId failed', err);
      }
    }
    return ok;
  }

  async _recordInputGroupIds(inputDeviceIds = []) {
    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (_) {
      devices = [];
    }
    const inputs = devices.filter(d => d.kind === 'audioinput');
    const recordGroupIds = new Set();
    const wantedIds = new Set((inputDeviceIds || []).filter(id => id && id !== 'default'));
    for (const d of inputs) {
      if (wantedIds.has(d.deviceId) && d.groupId) recordGroupIds.add(d.groupId);
    }
    for (const m of this._inputMonitors.values()) {
      const track = m?.stream?.getAudioTracks?.()[0];
      const settings = track?.getSettings?.() || {};
      if (settings.groupId) recordGroupIds.add(settings.groupId);
      if (settings.deviceId) {
        const match = inputs.find(d => d.deviceId === settings.deviceId);
        if (match?.groupId) recordGroupIds.add(match.groupId);
      }
    }
    return { devices, recordGroupIds };
  }

  _isUnsafeOutput(out, recordGroupIds = new Set()) {
    if (!out) return true;
    const l = (out.label || '').toLowerCase();
    if (isCommunicationsLabel(l)) return true;
    if (/valeton|gp-?200/.test(l)) return true;
    if (out.groupId && recordGroupIds.has(out.groupId)) return true;
    return false;
  }

  async _findSafeOutput(inputDeviceIds = []) {
    const { devices, recordGroupIds } = await this._recordInputGroupIds(inputDeviceIds);
    const outputs = devices.filter(d => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default');
    const safe = outputs
      .filter(o => !this._isUnsafeOutput(o, recordGroupIds))
      .sort((a, b) => outputDeviceRank(a.label) - outputDeviceRank(b.label));
    return safe[0] || null;
  }

  _disconnectSpeakers() {
    if (!this.speakerGate) return;
    try { this.speakerGate.disconnect(); } catch (_) { /* ignore */ }
    this.speakerGate.gain.value = 0;
  }

  _connectSpeakers() {
    if (!this.speakerGate) return;
    this.speakerGate.gain.value = 1;
    try { this.speakerGate.connect(Tone.getDestination()); } catch (_) { /* already connected */ }
  }

  _ensurePlaybackToSpeakers() {
    if (!this.outputTap || !this.speakerGate) return;
    try { this.outputTap.connect(this.speakerGate); } catch (_) { /* already connected */ }
    this._connectSpeakers();
  }

  _tapNativeNode() {
    const tap = this.outputTap;
    if (!tap) return null;
    return tap.output || tap;
  }

  async isolatePlaybackFromInputs() {
    // Seperti Studio One: iringan tetap ke output yang sama (GP-200 / headphone).
    this._ensurePlaybackToSpeakers();
    this._sinkLocked = false;
    this._restoreSinkId = undefined;
    return { soundcardMonitor: true };
  }

  async restorePlaybackOutput() {
    this._ensurePlaybackToSpeakers();
    this._sinkLocked = false;
    this._restoreSinkId = undefined;
    for (const m of this._inputMonitors.values()) {
      if (!m?.monitorGain || !this.masterGain) continue;
      try { m.monitorGain.disconnect(); } catch (_) { /* ignore */ }
      try { m.monitorGain.connect(this.masterGain); } catch (_) { /* ignore */ }
    }
  }

  // ── Recording ───────────────────────────────────────────────────

  _startMixReferenceCapture(ctx) {
    this._stopMixReferenceCapture();
    this._mixLeft = [];
    this._mixRight = [];
    this._lastMixBuffer = null;
    this._ensurePlaybackToSpeakers();
    if (!this.outputTap || !ctx || !isNativeAudioContext(ctx)) return;
    try {
      const recNode = new AudioWorkletNode(ctx, 'jagat-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      recNode.port.onmessage = (e) => {
        if (!e.data?.l) return;
        this._mixLeft.push(e.data.l);
        this._mixRight.push(e.data.r || e.data.l);
      };
      if (!ctx._jagatWorkletKeepAlive) {
        ctx._jagatWorkletKeepAlive = ctx.createMediaStreamDestination();
      }
      const tap = this._tapNativeNode();
      try {
        tap.connect(recNode);
      } catch (_) {
        try { this.outputTap.connect(recNode); } catch (err) { console.warn(err); }
      }
      recNode.connect(ctx._jagatWorkletKeepAlive);
      recNode.port.postMessage('start');
      this._mixRecNode = recNode;
      this._ensurePlaybackToSpeakers();
    } catch (err) {
      console.warn('mix reference capture failed', err);
      this._mixRecNode = null;
      this._ensurePlaybackToSpeakers();
    }
  }

  _stopMixReferenceCapture() {
    const rec = this._mixRecNode;
    this._mixRecNode = null;
    if (!rec) {
      this._ensurePlaybackToSpeakers();
      return;
    }
    try { rec.port.postMessage('stop'); } catch (_) { /* ignore */ }
    const tap = this._tapNativeNode();
    try { tap?.disconnect(rec); } catch (_) { /* ignore */ }
    try { rec.disconnect(); } catch (_) { /* ignore */ }
    this._ensurePlaybackToSpeakers();
  }

  _mixChunksToBuffer(ctx) {
    const leftChunks = this._mixLeft || [];
    const rightChunks = this._mixRight || [];
    const total = leftChunks.reduce((n, c) => n + c.length, 0);
    if (total < 64) return null;
    const sr = ctx?.sampleRate || getNativeAudioContext()?.sampleRate || 44100;
    const buffer = (ctx && typeof ctx.createBuffer === 'function')
      ? ctx.createBuffer(1, total, sr)
      : new AudioBuffer({ numberOfChannels: 1, length: total, sampleRate: sr });
    const dest = buffer.getChannelData(0);
    let offset = 0;
    for (let i = 0; i < leftChunks.length; i++) {
      const l = leftChunks[i];
      const r = rightChunks[i] || l;
      for (let s = 0; s < l.length; s++) dest[offset + s] = (l[s] + (r[s] ?? l[s])) * 0.5;
      offset += l.length;
    }
    this._mixLeft = [];
    this._mixRight = [];
    return buffer;
  }

  _finishRecordedBuffer(buffer, stream, mediaRecorder) {
    if (!buffer) return buffer;
    const liveMix = this._lastMixBuffer;
    if (liveMix) {
      buffer = isolateInstrumentChannel(buffer, liveMix);
      buffer = mixMinusBleed(buffer, liveMix);
      buffer = this._alignRecordedBuffer(buffer, stream, mediaRecorder);
    } else {
      buffer = this._alignRecordedBuffer(buffer, stream, mediaRecorder);
      const mix = this._renderBackingMix(buffer.sampleRate, buffer.duration);
      buffer = isolateInstrumentChannel(buffer, mix);
      buffer = mixMinusBleed(buffer, mix);
    }
    return polishRecordedBuffer(buffer);
  }

  _renderBackingMix(sampleRate, durationSec) {
    const tracks = this._playTracks || [];
    const skip = this._skipTrackIds || new Set();
    const start = this._startProjTime || 0;
    if (!tracks.length || durationSec < 0.05) return null;
    const length = Math.max(64, Math.ceil(durationSec * sampleRate));
    const dest = new Float32Array(length);
    let wrote = false;

    for (const track of tracks) {
      if (!track || skip.has(track.id) || track.mute) continue;
      const vol = dbToGain(clamp(track.volume ?? 0, -60, 12));
      if (vol < 0.0008) continue;
      for (const region of (track.regions || [])) {
        const audio = this.audioBuffers.get(region.audioId);
        const buf = audio?.buffer;
        if (!buf) continue;
        const ch0 = buf.getChannelData(0);
        const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
        const srcSr = buf.sampleRate;
        const mixStart = Math.max(region.startTime, start);
        const mixEnd = Math.min(region.startTime + region.duration, start + durationSec);
        if (mixEnd <= mixStart) continue;
        const i0 = Math.floor((mixStart - start) * sampleRate);
        const i1 = Math.min(length, Math.ceil((mixEnd - start) * sampleRate));
        for (let i = i0; i < i1; i++) {
          const t = start + i / sampleRate;
          const srcI = Math.floor(((region.offset || 0) + (t - region.startTime)) * srcSr);
          if (srcI < 0 || srcI >= ch0.length) continue;
          dest[i] += (ch0[srcI] + ch1[srcI]) * 0.5 * vol;
          wrote = true;
        }
      }
    }
    if (!wrote) return null;
    const out = new AudioBuffer({ numberOfChannels: 1, length, sampleRate });
    out.getChannelData(0).set(dest);
    return out;
  }

  _stopPcmCapture(m) {
    if (!m) return;
    try { m.recNode?.port.postMessage('stop'); } catch (_) { /* ignore */ }
    try { m.source?.disconnect(m.recNode); } catch (_) { /* ignore */ }
    try { m.recSplit?.disconnect(); } catch (_) { /* ignore */ }
    try { m.recNode?.disconnect(); } catch (_) { /* ignore */ }
    try { m.recSilent?.disconnect(); } catch (_) { /* ignore */ }
    m.recNode = null;
    m.recSplit = null;
    m.recSilent = null;
  }

  _pcmChunksToBuffer(m, ctx) {
    const leftChunks = m.pcmLeft || [];
    const rightChunks = m.pcmRight || [];
    const total = leftChunks.reduce((n, c) => n + c.length, 0);
    if (total < 64) return null;
    const stereo = rightChunks.length > 0;
    const sr = ctx?.sampleRate || getNativeAudioContext()?.sampleRate || 44100;
    const buffer = (ctx && typeof ctx.createBuffer === 'function')
      ? ctx.createBuffer(stereo ? 2 : 1, total, sr)
      : new AudioBuffer({ numberOfChannels: stereo ? 2 : 1, length: total, sampleRate: sr });
    const left = buffer.getChannelData(0);
    const right = stereo ? buffer.getChannelData(1) : null;
    let offset = 0;
    for (let i = 0; i < leftChunks.length; i++) {
      left.set(leftChunks[i], offset);
      if (right) right.set(rightChunks[i] || leftChunks[i], offset);
      offset += leftChunks[i].length;
    }
    return buffer;
  }

  getRoundTripLatencySec(stream = null, mediaRecorder = false) {
    const ctx = getNativeAudioContext();
    const sr = ctx?.sampleRate || 48000;
    const base = Number(ctx?.baseLatency) || 0;
    let out = Number(ctx?.outputLatency) || 0;
    if (out <= 0 && ctx && typeof ctx.getOutputTimestamp === 'function') {
      try {
        const ts = ctx.getOutputTimestamp();
        if (ts && typeof ts.contextTime === 'number') {
          const est = ctx.currentTime - ts.contextTime;
          if (est > 0 && est < 0.5) out = est;
        }
      } catch (_) { /* ignore */ }
    }
    let input = 0;
    try {
      const lat = stream?.getAudioTracks?.()[0]?.getSettings?.()?.latency;
      if (typeof lat === 'number' && lat > 0) input = lat;
    } catch (_) { /* ignore */ }
    if (input <= 0) input = base > 0 ? base : 0.012;
    if (out <= 0) out = base > 0 ? base : 0.02;

    const quantum = 256 / sr;
    const codec = mediaRecorder ? 0.035 : 0;
    const mismatchPad = this._sinkLocked ? 0.02 : 0;
    const reported = base + out + input + quantum + codec + mismatchPad;
    // Windows WASAPI shared mode often under-reports; keep a small floor.
    return clamp(Math.max(reported, 0.06), 0.035, 0.28);
  }

  getRecordCompensationSec() {
    const recT = this._recordNativeCtxTime;
    const playT = this._playNativeCtxTime;
    const preRoll = (typeof recT === 'number' && typeof playT === 'number')
      ? Math.max(0, playT - recT)
      : 0;
    return preRoll + this.getRoundTripLatencySec(null, this._recordUsedMediaRecorder);
  }

  _alignRecordedBuffer(buffer, stream, mediaRecorder) {
    if (!buffer) return buffer;
    const recT = this._recordNativeCtxTime;
    const playT = this._playNativeCtxTime;
    const preRoll = (typeof recT === 'number' && typeof playT === 'number')
      ? Math.max(0, playT - recT)
      : 0;
    const rtl = this.getRoundTripLatencySec(stream, mediaRecorder);
    return trimAudioBufferStart(buffer, preRoll + rtl);
  }

  async prepareRecording(armedTracksData = []) {
    await this._ensureAudioRunning();
    await this.init();
    this._mediaRecorders = {};
    this._recordChunks = {};
    this._recordingTrackIds = [];
    this._pcmTrackIds = [];
    this._recordUsedMediaRecorder = false;
    this._recordNativeCtxTime = null;
    this._lastMixBuffer = null;

    for (const [id] of this._inputMonitors) {
      this.setInputMonitorAudible(id, false);
    }
    for (const m of this._inputMonitors.values()) {
      try { m.monitorGain?.disconnect(); } catch (_) { /* ignore */ }
    }

    for (const trackData of armedTracksData) {
      const { trackId, inputId } = trackData;
      if (!this._inputMonitors.has(trackId)) {
        await this.startInputMonitor(trackId, inputId || 'default');
      }
      this.setInputMonitorAudible(trackId, false);
      const m = this._inputMonitors.get(trackId);
      try { m?.monitorGain?.disconnect(); } catch (_) { /* ignore */ }
    }

    const isolation = await this.isolatePlaybackFromInputs(
      (armedTracksData || []).map(t => t.inputId)
    );

    const nativeCtx = getNativeAudioContext();
    let workletOk = false;
    if (isNativeAudioContext(nativeCtx)) {
      try {
        await ensureRecorderWorklet(nativeCtx);
        workletOk = true;
      } catch (err) {
        console.warn('PCM worklet unavailable, fallback MediaRecorder', err);
      }
    }

    this._recPrep = { armedTracksData, isolation, nativeCtx, workletOk };
    return isolation;
  }

  beginCapture() {
    const prep = this._recPrep;
    if (!prep) throw new Error('Recording belum disiapkan');
    this._recPrep = null;
    const { armedTracksData, nativeCtx, workletOk } = prep;
    this._recordNativeCtxTime = getNativeAudioContext()?.currentTime ?? Tone.now();
    this._startMixReferenceCapture(nativeCtx);

    const startMediaRecorder = (trackId, m) => {
      const recStream = isolatedAudioStream(m.stream) || m.stream;
      let mimeType = '';
      if (typeof MediaRecorder !== 'undefined') {
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=pcm')) mimeType = 'audio/webm;codecs=pcm';
        else if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus';
        else if (MediaRecorder.isTypeSupported('audio/webm')) mimeType = 'audio/webm';
      }
      const recOpts = mimeType ? { mimeType, audioBitsPerSecond: 256000 } : { audioBitsPerSecond: 256000 };
      let recorder;
      try {
        recorder = new MediaRecorder(recStream, recOpts);
      } catch (_) {
        recorder = new MediaRecorder(recStream);
      }
      this._recordChunks[trackId] = [];
      this._recordUsedMediaRecorder = true;
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this._recordChunks[trackId].push(e.data);
      };
      recorder.onstop = async () => {
        this._stopLivePeakCapture(m);
        const chunks = this._recordChunks[trackId] || [];
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
        let buffer = await this._decodeRecordBlob(blob);
        if (buffer) buffer = this._finishRecordedBuffer(buffer, m.stream, true);
        if (this.onRecordingDone) this.onRecordingDone(trackId, buffer);
      };
      recorder.start();
      this._mediaRecorders[trackId] = recorder;
    };

    for (const trackData of armedTracksData) {
      const { trackId, inputId } = trackData;
      if (!this._inputMonitors.has(trackId)) {
        throw new Error('Input soundcard tidak aktif. Pilih Line Valeton, Arm (●), lalu Record.');
      }
      const m = this._inputMonitors.get(trackId);
      const liveTrack = m?.stream?.getAudioTracks?.()[0];
      if (!m?.stream || !liveTrack || liveTrack.readyState !== 'live') {
        throw new Error('Input soundcard tidak aktif. Pilih Line Valeton, Arm (●), lalu Record.');
      }

      this._recordingTrackIds.push(trackId);

      const nodeCtx = getNativeAudioContext(m.source?.context) || nativeCtx;
      if (workletOk && m.source && isNativeAudioContext(nodeCtx)) {
        try {
          m.pcmLeft = [];
          m.pcmRight = [];
          m.livePeaks = [];
          const recNode = new AudioWorkletNode(nodeCtx, 'jagat-recorder', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            channelCount: 2,
            channelCountMode: 'explicit',
            channelInterpretation: 'discrete',
          });
          recNode.port.onmessage = (e) => {
            if (!e.data?.l) return;
            m.pcmLeft.push(e.data.l);
            m.pcmRight.push(e.data.r || e.data.l);
            const l = e.data.l;
            const r = e.data.r || e.data.l;
            let min = 0;
            let max = 0;
            for (let i = 0; i < l.length; i += 16) {
              const v = (l[i] + (r[i] ?? l[i])) * 0.5;
              if (v < min) min = v;
              if (v > max) max = v;
            }
            m.livePeaks.push({ min, max });
          };
          if (!nodeCtx._jagatWorkletKeepAlive) {
            nodeCtx._jagatWorkletKeepAlive = nodeCtx.createMediaStreamDestination();
          }
          m.source.connect(recNode);
          recNode.connect(nodeCtx._jagatWorkletKeepAlive);
          recNode.port.postMessage('start');
          m.recNode = recNode;
          this._pcmTrackIds.push(trackId);
          continue;
        } catch (err) {
          console.warn('AudioWorkletNode failed, fallback MediaRecorder', err);
        }
      }

      this._startLivePeakCapture(m);
      startMediaRecorder(trackId, m);
    }
  }

  async startRecording(armedTracksData = []) {
    const isolation = await this.prepareRecording(armedTracksData);
    this.beginCapture();
    return isolation;
  }

  stopRecording() {
    this._recPrep = null;
    const ctx = getNativeAudioContext();
    this._stopMixReferenceCapture();
    this._lastMixBuffer = this._mixChunksToBuffer(ctx);

    const pcmIds = this._pcmTrackIds || [];
    this._pcmTrackIds = [];

    for (const trackId of pcmIds) {
      const m = this._inputMonitors.get(trackId);
      this._stopLivePeakCapture(m);
      this._stopPcmCapture(m);
      let buffer = this._pcmChunksToBuffer(m, ctx);
      if (buffer) buffer = this._finishRecordedBuffer(buffer, m?.stream, false);
      if (m) {
        m.pcmLeft = [];
        m.pcmRight = [];
      }
      if (this.onRecordingDone) this.onRecordingDone(trackId, buffer);
    }

    const recorders = this._mediaRecorders || {};
    this._mediaRecorders = {};
    this._recordingTrackIds = [];
    for (const trackId of Object.keys(recorders)) {
      const recorder = recorders[trackId];
      if (recorder && recorder.state !== 'inactive') {
        try { recorder.stop(); } catch (err) { console.error(err); }
      }
    }
    void this.restorePlaybackOutput();
  }

  // ── Bounce / Export ─────────────────────────────────────────────

  async bounce(tracks, durationSec, masterOpts = {}) {
    const sampleRate = 44100;
    const offline = new OfflineAudioContext(2, Math.ceil(sampleRate * durationSec), sampleRate);

    // Master bus nodes
    const masterGain = offline.createGain();
    const mVol = masterOpts.masterVolume ?? 0;
    masterGain.gain.value = dbToGain(clamp(mVol, -60, 12));

    const masterCompressor = offline.createDynamicsCompressor();
    const mSuite = masterOpts.masterSuite || {};
    if (mSuite.compressor?.enabled) {
      masterCompressor.threshold.value = clamp(mSuite.compressor.threshold ?? -12, -40, 0);
      masterCompressor.ratio.value = clamp(mSuite.compressor.ratio ?? 2.5, 1, 10);
      masterCompressor.attack.value = clamp(mSuite.compressor.attack ?? 0.03, 0.001, 0.5);
      masterCompressor.release.value = clamp(mSuite.compressor.release ?? 0.25, 0.05, 1.5);
    } else {
      masterCompressor.threshold.value = 0;
      masterCompressor.ratio.value = 1;
    }

    masterGain.connect(masterCompressor);
    masterCompressor.connect(offline.destination);

    for (const track of tracks) {
      if (track.mute) continue;

      const trackInGain = offline.createGain();
      let lastNode = trackInGain;

      // Track LowCut Filter
      if (track.effects?.lowCut?.enabled) {
        const hpFilter = offline.createBiquadFilter();
        hpFilter.type = 'highpass';
        hpFilter.frequency.value = clamp(track.effects.lowCut.frequency ?? 80, 20, 500);
        lastNode.connect(hpFilter);
        lastNode = hpFilter;
      }

      // Track 3-Band EQ
      if (track.effects?.eq) {
        const lowEq = offline.createBiquadFilter();
        lowEq.type = 'lowshelf';
        lowEq.frequency.value = 350;
        lowEq.gain.value = clamp(track.effects.eq.low || 0, -18, 18);

        const midEq = offline.createBiquadFilter();
        midEq.type = 'peaking';
        midEq.frequency.value = 1000;
        midEq.Q.value = 1.0;
        midEq.gain.value = clamp(track.effects.eq.mid || 0, -18, 18);

        const highEq = offline.createBiquadFilter();
        highEq.type = 'highshelf';
        highEq.frequency.value = 3000;
        highEq.gain.value = clamp(track.effects.eq.high || 0, -18, 18);

        lastNode.connect(lowEq);
        lowEq.connect(midEq);
        midEq.connect(highEq);
        lastNode = highEq;
      }

      // Track Compressor
      if (track.effects?.compressor?.enabled) {
        const trkComp = offline.createDynamicsCompressor();
        trkComp.threshold.value = clamp(track.effects.compressor.threshold ?? -24, -60, 0);
        trkComp.ratio.value = clamp(track.effects.compressor.ratio ?? 4, 1, 20);
        trkComp.attack.value = clamp(track.effects.compressor.attack ?? 0.003, 0.001, 1);
        trkComp.release.value = clamp(track.effects.compressor.release ?? 0.25, 0.01, 2);
        lastNode.connect(trkComp);
        lastNode = trkComp;
      }

      // Track Volume & Pan
      const gainNode = offline.createGain();
      gainNode.gain.value = dbToGain(track.volume || 0);

      const panNode = offline.createStereoPanner();
      panNode.pan.value = clamp(track.pan || 0, -1, 1);

      lastNode.connect(gainNode);
      gainNode.connect(panNode);
      panNode.connect(masterGain);

      for (const region of track.regions) {
        const audioData = this.audioBuffers.get(region.audioId);
        if (!audioData) continue;

        const source = offline.createBufferSource();
        source.buffer = audioData.buffer;

        // Pitch Shift / Transpose for offline bounce (use detune in cents: 100 cents = 1 semitone)
        if (track.effects?.pitchShift?.enabled && track.effects.pitchShift.pitch !== 0) {
          source.detune.value = (track.effects.pitchShift.pitch ?? 0) * 100;
        }

        const regGain = offline.createGain();
        regGain.gain.value = dbToGain(region.gain || 0);
        source.connect(regGain);
        regGain.connect(trackInGain);

        const startTime  = Math.max(0, region.startTime);
        const offset     = (region.offset || 0) + Math.max(0, -region.startTime);
        const durRemain  = region.duration - Math.max(0, -region.startTime);
        if (durRemain > 0) {
          source.start(startTime, offset, durRemain);
        }
      }
    }

    return offline.startRendering();
  }
}

export default DawAudioEngine;
