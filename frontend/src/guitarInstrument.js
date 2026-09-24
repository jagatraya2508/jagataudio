import * as Tone from 'tone';

const TONE_PRESETS = {
  acoustic: {
    dampening: 4000,
    resonance: 0.88,
    attackNoise: 0.45,
    volume: -2,
    reverbWet: 0.12,
    dist: 0,
    filter: 4200,
    bodyGain: -10,
  },
  clean: {
    dampening: 3600,
    resonance: 0.84,
    attackNoise: 0.5,
    volume: -2,
    reverbWet: 0.08,
    dist: 0,
    filter: 4000,
    bodyGain: -9,
  },
  crunch: {
    dampening: 2600,
    resonance: 0.78,
    attackNoise: 0.55,
    volume: -3,
    reverbWet: 0.05,
    dist: 0.18,
    filter: 2800,
    bodyGain: -11,
  },
  distortion: {
    dampening: 2200,
    resonance: 0.72,
    attackNoise: 0.6,
    volume: -4,
    reverbWet: 0.04,
    dist: 0.32,
    filter: 2300,
    bodyGain: -12,
  },
};

/**
 * Guitar instrument: plucked string + a little body, then compress/limit so it isn't tiny.
 */
export function createGuitarPluckInstrument(tone = 'acoustic') {
  const p = TONE_PRESETS[tone] || TONE_PRESETS.acoustic;
  const filter = new Tone.Filter({ type: 'lowpass', frequency: p.filter, Q: 0.35 });
  const compressor = new Tone.Compressor({
    threshold: -16,
    ratio: 3.5,
    attack: 0.008,
    release: 0.1,
    knee: 6,
  });
  const limiter = new Tone.Limiter(-1.2);
  const volume = new Tone.Volume(p.volume);
  const freeverb = new Tone.Freeverb({ roomSize: 0.35, dampening: 2400, wet: p.reverbWet });

  const body = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.006, decay: 0.2, sustain: 0.04, release: 0.16 },
  });
  body.maxPolyphony = 8;
  body.volume.value = p.bodyGain;

  const voiceCount = 8;
  const voices = [];
  for (let i = 0; i < voiceCount; i++) {
    const pluck = new Tone.PluckSynth({
      attackNoise: p.attackNoise,
      dampening: p.dampening,
      resonance: p.resonance,
    });
    pluck.connect(filter);
    voices.push(pluck);
  }

  body.connect(filter);

  let head = filter;
  if (p.dist > 0) {
    const drive = new Tone.Distortion(p.dist);
    drive.wet.value = 0.35;
    filter.connect(drive);
    head = drive;
  }
  head.connect(compressor);
  compressor.connect(freeverb);
  freeverb.connect(limiter);
  limiter.connect(volume);

  let roundRobin = 0;
  const extras = [filter, compressor, limiter, volume, freeverb, body];
  if (head !== filter) extras.push(head);

  return {
    maxPolyphony: voiceCount,
    volume,
    triggerAttackRelease(pitch, duration, time, velocity) {
      const vel = Math.max(0.35, Math.min(1, Number(velocity) || 0.8));
      const hold = Math.max(0.12, Math.min(Number(duration) || 0.28, 0.45));
      const voice = voices[roundRobin++ % voiceCount];
      try { voice.triggerAttack(pitch, time, vel); } catch (_) { /* ignore */ }
      try { body.triggerAttackRelease(pitch, hold, time, vel * 0.55); } catch (_) { /* ignore */ }
    },
    releaseAll() {
      try { body.releaseAll(); } catch (_) { /* ignore */ }
    },
    connect(node) {
      volume.connect(node);
      return this;
    },
    disconnect() {
      try { volume.disconnect(); } catch (_) { /* ignore */ }
    },
    dispose() {
      voices.forEach((v) => { try { v.dispose(); } catch (_) { /* ignore */ } });
      extras.forEach((x) => { try { x.dispose(); } catch (_) { /* ignore */ } });
    },
  };
}

export function normalizeAudioBuffer(buffer, peak = 0.88) {
  if (!buffer) return buffer;
  let max = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]));
  }
  if (max < 0.0008) return buffer;
  const gain = peak / max;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) data[i] *= gain;
  }
  return buffer;
}
