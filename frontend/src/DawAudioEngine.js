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

// ─── Main class ──────────────────────────────────────────────────────

class DawAudioEngine {
  constructor() {
    /* master chain */
    this.masterGain       = null;
    this.masterEq         = null;
    this.masterCompressor = null;
    this.masterLimiter    = null;
    this.masterMeter      = null;

    /* per-track nodes:  Map<trackId, TrackNode> */
    this.trackNodes = new Map();

    /* decoded audio:  Map<audioId, { buffer: AudioBuffer, peaks: {min,max}[] }> */
    this.audioBuffers = new Map();

    /* active players during playback: Map<regionId, Tone.Player> */
    this.activePlayers = new Map();

    /* playback bookkeeping */
    this._playing         = false;
    this._startCtxTime    = 0;   // Tone.now() when play was pressed
    this._startProjTime   = 0;   // project-time offset when play was pressed
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
    this.masterLimiter    = new Tone.Limiter(-1);
    this.masterCompressor = new Tone.Compressor({ threshold: 0, ratio: 1, attack: 0.003, release: 0.25 });
    // Compressor has no .wet — bypass by setting threshold=0, ratio=1
    this.masterEq         = new Tone.EQ3(0, 0, 0);
    this.masterGain       = new Tone.Gain(1);

    this.masterGain.chain(
      this.masterEq,
      this.masterCompressor,
      this.masterLimiter,
      this.masterMeter,
      Tone.getDestination(),
    );

    /* click synth for metronome */
    this._metronome = new Tone.MembraneSynth({
      pitchDecay: 0.008,
      octaves: 2,
      envelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.04 },
    }).toDestination();
    this._metronome.volume.value = -6;

    this._initialized = true;
  }

  dispose() {
    this.stop();
    for (const [id] of this.trackNodes) this.removeTrackNode(id);
    this.masterGain?.dispose();
    this.masterEq?.dispose();
    this.masterCompressor?.dispose();
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

    const meter      = new Tone.Meter({ channels: 2, smoothing: 0.85 });
    const channel    = new Tone.Channel(0, 0);
    const eq         = new Tone.EQ3(0, 0, 0);
    const compressor = new Tone.Compressor({ threshold: 0, ratio: 1, attack: 0.003, release: 0.25 });
    // Compressor bypass: threshold=0, ratio=1 means no compression
    const delay      = new Tone.FeedbackDelay({ delayTime: '8n', feedback: 0.3, wet: 0 });
    const reverb     = new Tone.Reverb({ decay: 1.5, wet: 0 });
    reverb.generate().catch(() => {}); // Generate IR for reverb
    const guitarDist = new Tone.Distortion(0);
    guitarDist.wet.value = 0;
    const inputGain  = new Tone.Gain(1);

    inputGain.chain(guitarDist, eq, compressor, delay, reverb, channel, meter, this.masterGain);

    this.trackNodes.set(trackId, { inputGain, channel, guitarDist, eq, compressor, reverb, delay, meter, soloMuted: false });
  }

  removeTrackNode(trackId) {
    const n = this.trackNodes.get(trackId);
    if (!n) return;
    [n.inputGain, n.channel, n.guitarDist, n.eq, n.compressor, n.reverb, n.delay, n.meter].forEach(x => {
      try { x.disconnect(); } catch (e) { /* ignore */ }
      try { x.dispose(); } catch (e) { /* ignore */ }
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
    if (!n) return;

    // Guitar Amp
    if (effects.guitar) {
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

    // EQ (3-band, quick)
    if (effects.eq) {
      n.eq.low.value  = clamp(effects.eq.low  || 0, -12, 12);
      n.eq.mid.value  = clamp(effects.eq.mid  || 0, -12, 12);
      n.eq.high.value = clamp(effects.eq.high || 0, -12, 12);
    }
    // Compressor — no .wet property, use threshold/ratio to bypass
    if (effects.compressor) {
      if (effects.compressor.enabled) {
        n.compressor.threshold.value = clamp(effects.compressor.threshold ?? -24, -60, 0);
        n.compressor.ratio.value     = clamp(effects.compressor.ratio     ?? 4,   1, 20);
        n.compressor.attack.value    = clamp(effects.compressor.attack    ?? 0.003, 0, 1);
        n.compressor.release.value   = clamp(effects.compressor.release   ?? 0.25, 0.01, 2);
      } else {
        // Bypass: no compression
        n.compressor.threshold.value = 0;
        n.compressor.ratio.value     = 1;
      }
    }
    // Delay
    if (effects.delay) {
      n.delay.wet.value = effects.delay.enabled ? clamp(effects.delay.wet ?? 0.2, 0, 1) : 0;
      if (effects.delay.enabled) {
        n.delay.feedback.value = clamp(effects.delay.feedback ?? 0.3, 0, 0.95);
      }
    }
    // Reverb
    if (effects.reverb) {
      n.reverb.wet.value = effects.reverb.enabled ? clamp(effects.reverb.wet ?? 0.3, 0, 1) : 0;
    }
  }

  // ── Audio loading ───────────────────────────────────────────────

  async loadAudioFile(file) {
    await this.init();
    const audioId = 'audio_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const arrayBuffer = await file.arrayBuffer();
    const ctx = Tone.getContext().rawContext;
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    const peaks = extractPeaks(decoded, 4096);
    this.audioBuffers.set(audioId, { buffer: decoded, peaks });
    return { audioId, name: file.name, duration: decoded.duration, sampleRate: decoded.sampleRate, channels: decoded.numberOfChannels, peaks };
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

  play(position, tracks, { loopEnabled = false, loopStart = 0, loopEnd = 16, bpm = 120 } = {}) {
    this.stop();

    this._loopEnabled   = loopEnabled;
    this._loopStart     = loopStart;
    this._loopEnd       = loopEnd;
    this._startProjTime = position;
    this._startCtxTime  = Tone.now();
    this._playing       = true;

    this._scheduleAllRegions(position, tracks);

    if (this._metronomeOn) this._startMetronome(bpm, position);

    this._startPlayheadLoop(tracks, bpm);
  }

  stop() {
    this._playing = false;
    this._stopPlayheadLoop();
    this._stopAllPlayers();
    this._stopMetronome();
  }

  /** Restart playback from a new position (seek). */
  seekTo(position, tracks, opts) {
    const wasPlaying = this._playing;
    this.stop();
    this._startProjTime = position;
    if (wasPlaying) this.play(position, tracks, opts);
  }

  // -- internal scheduling --

  _scheduleAllRegions(fromPosition, tracks) {
    this._stopAllPlayers();

    for (const track of tracks) {
      const node = this.trackNodes.get(track.id);
      if (!node || track.mute || node.soloMuted) continue;

      for (const region of track.regions) {
        const audioData = this.audioBuffers.get(region.audioId);
        if (!audioData) continue;

        const regEnd = region.startTime + region.duration;
        if (regEnd <= fromPosition) continue; // already passed

        const toneBuffer = new Tone.ToneAudioBuffer(audioData.buffer);
        const player = new Tone.Player(toneBuffer);
        player.connect(node.inputGain);

        if (region.gain) player.volume.value = region.gain;

        if (region.startTime >= fromPosition) {
          const delay = region.startTime - fromPosition;
          try {
            player.start(Tone.now() + delay, region.offset || 0, region.duration);
          } catch (e) { /* buffer may not be ready */ }
        } else {
          const elapsed = fromPosition - region.startTime;
          const remaining = region.duration - elapsed;
          if (remaining > 0) {
            try {
              player.start(Tone.now(), (region.offset || 0) + elapsed, remaining);
            } catch (e) { /* ignore */ }
          }
        }

        this.activePlayers.set(region.id, player);
      }
    }
  }

  _stopAllPlayers() {
    for (const p of this.activePlayers.values()) {
      try { p.stop(); } catch (_) { /* ignore */ }
      try { p.dispose(); } catch (_) { /* ignore */ }
    }
    this.activePlayers.clear();
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
        this.play(this._loopStart, tracks, {
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

  // ── Master controls ─────────────────────────────────────────────

  setMasterVolume(db) {
    if (this.masterGain) this.masterGain.gain.value = dbToGain(clamp(db, -60, 12));
  }

  setMasterLimiter(enabled) {
    if (this.masterLimiter) this.masterLimiter.threshold.value = enabled ? -1 : 0;
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

  // ── Recording ───────────────────────────────────────────────────

  async startRecording(armedTracksData = []) {
    await this.init();
    this._mediaRecorders = {};
    this._recordChunks = {};
    this._recordStreams = {};

    let mimeType = 'audio/webm;codecs=opus';
    if (MediaRecorder.isTypeSupported('audio/wav')) mimeType = 'audio/wav';

    for (const trackData of armedTracksData) {
      const { trackId, inputId } = trackData;
      this._recordChunks[trackId] = [];

      try {
        const audioConstraints = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        };
        if (inputId && inputId !== 'default') {
          audioConstraints.deviceId = { exact: inputId };
        }

        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        this._recordStreams[trackId] = stream;

        const recorder = new MediaRecorder(stream, { mimeType });
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) this._recordChunks[trackId].push(e.data);
        };
        recorder.onstop = () => {
          const blob = new Blob(this._recordChunks[trackId], { type: mimeType });
          if (this.onRecordingDone) this.onRecordingDone(trackId, blob);
          this._recordStreams[trackId]?.getTracks().forEach(t => t.stop());
          delete this._recordStreams[trackId];
        };
        
        this._mediaRecorders[trackId] = recorder;
        recorder.start(100);
      } catch (err) {
        console.error(`Failed to start recording for track ${trackId}:`, err);
      }
    }
  }

  stopRecording() {
    for (const trackId in this._mediaRecorders) {
      const recorder = this._mediaRecorders[trackId];
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
      }
    }
    this._mediaRecorders = {};
  }

  // ── Bounce / Export ─────────────────────────────────────────────

  async bounce(tracks, durationSec) {
    const sampleRate = 44100;
    const offline = new OfflineAudioContext(2, Math.ceil(sampleRate * durationSec), sampleRate);

    for (const track of tracks) {
      if (track.mute) continue;

      const gainNode = offline.createGain();
      gainNode.gain.value = dbToGain(track.volume || 0);

      const panNode = offline.createStereoPanner();
      panNode.pan.value = clamp(track.pan || 0, -1, 1);

      gainNode.connect(panNode);
      panNode.connect(offline.destination);

      for (const region of track.regions) {
        const audioData = this.audioBuffers.get(region.audioId);
        if (!audioData) continue;

        const source = offline.createBufferSource();
        source.buffer = audioData.buffer;

        const regGain = offline.createGain();
        regGain.gain.value = dbToGain(region.gain || 0);
        source.connect(regGain);
        regGain.connect(gainNode);

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
