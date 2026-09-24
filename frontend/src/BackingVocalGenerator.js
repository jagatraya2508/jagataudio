/**
 * BackingVocalGenerator.js
 * ────────────────────────
 * Client-side backing vocal / choir pad synthesis using OfflineAudioContext.
 * Generates warm vocal-like pads using formant filtering on oscillators.
 *
 * Styles: Choir Pad (oooh), Harmony Stack, Gospel Choir, Ambient Vocal Wash
 * Harmonies: Unison, 3rds, 5ths, Octave, Full (3rd+5th+Oct)
 */

import { audioBufferToWav } from './DawAudioEngine';

// ─── Constants ────────────────────────────────────────────────────

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor_pentatonic: [0, 3, 5, 7, 10],
  major_pentatonic: [0, 2, 4, 7, 9],
};

// Vowel Formant Frequencies (Hz) for vocal simulation
// Based on phonetic research for typical singing voice formants
const FORMANTS = {
  oo: [
    { freq: 300,  gain: 1.0,  Q: 12 },  // F1
    { freq: 870,  gain: 0.5,  Q: 14 },  // F2
    { freq: 2250, gain: 0.15, Q: 16 },  // F3
  ],
  ah: [
    { freq: 730,  gain: 1.0,  Q: 10 },
    { freq: 1090, gain: 0.7,  Q: 12 },
    { freq: 2440, gain: 0.2,  Q: 14 },
  ],
  ee: [
    { freq: 270,  gain: 1.0,  Q: 12 },
    { freq: 2300, gain: 0.4,  Q: 14 },
    { freq: 3000, gain: 0.15, Q: 16 },
  ],
  oh: [
    { freq: 570,  gain: 1.0,  Q: 11 },
    { freq: 840,  gain: 0.6,  Q: 13 },
    { freq: 2410, gain: 0.18, Q: 15 },
  ],
};

// ─── Vocal Styles ─────────────────────────────────────────────────

export const VOCAL_STYLES = {
  choir_pad: {
    name: 'Choir Pad (Oooh)',
    desc: 'Warm sustained choir pad with "oooh" vowel formants',
    vowel: 'oo',
    vibratoRate: 4.5,
    vibratoDepth: 3,
    attack: 0.8,
    release: 1.2,
    voices: 4,
    detuneSpread: 8,
  },
  harmony_stack: {
    name: 'Harmony Stack',
    desc: 'Layered harmony voices with "ah" vowel',
    vowel: 'ah',
    vibratoRate: 5.0,
    vibratoDepth: 4,
    attack: 0.4,
    release: 0.8,
    voices: 3,
    detuneSpread: 5,
  },
  gospel_choir: {
    name: 'Gospel Choir',
    desc: 'Full-bodied gospel-style choir with warm vibrato',
    vowel: 'oh',
    vibratoRate: 5.5,
    vibratoDepth: 6,
    attack: 0.3,
    release: 1.0,
    voices: 6,
    detuneSpread: 12,
  },
  ambient_wash: {
    name: 'Ambient Vocal Wash',
    desc: 'Ethereal breathy vocal texture',
    vowel: 'ee',
    vibratoRate: 3.0,
    vibratoDepth: 2,
    attack: 1.5,
    release: 2.0,
    voices: 5,
    detuneSpread: 15,
  },
};

export const VOCAL_HARMONIES = {
  unison:   { name: 'Unison',         intervals: [0] },
  thirds:   { name: '3rds',           intervals: [0, 2] },
  fifths:   { name: '5ths',           intervals: [0, 4] },
  octave:   { name: 'Octave',         intervals: [0, 7] },  // 7 scale degrees = octave
  full:     { name: 'Full (3rd+5th)', intervals: [0, 2, 4] },
  wide:     { name: 'Wide (Oct+5th)', intervals: [0, 4, 7] },
};

// ─── Helpers ──────────────────────────────────────────────────────

function noteToFreq(note, octave) {
  const idx = NOTES.indexOf(note);
  if (idx < 0) return 440;
  const midiNote = (octave + 1) * 12 + idx;
  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

function getScaleNote(root, scaleName, degree, octave = 4) {
  const rootIndex = NOTES.indexOf(root.toUpperCase());
  const intervals = SCALES[scaleName] || SCALES.minor;
  const interval = intervals[((degree % intervals.length) + intervals.length) % intervals.length];
  const octOffset = Math.floor(degree / intervals.length);
  const totalIndex = rootIndex + interval;
  const finalOctave = octave + octOffset + Math.floor(totalIndex / 12);
  const finalNote = NOTES[totalIndex % 12];
  return { note: finalNote, octave: finalOctave, freq: noteToFreq(finalNote, finalOctave) };
}

// ─── Main Generator ───────────────────────────────────────────────

export async function generateBackingVocal({
  bpm = 120,
  bars = 4,
  key = 'C',
  scale = 'minor',
  style = 'choir_pad',
  harmony = 'thirds',
}) {
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const duration = barSec * bars;
  const sampleRate = 44100;

  const styleParams = VOCAL_STYLES[style] || VOCAL_STYLES.choir_pad;
  const harmonyParams = VOCAL_HARMONIES[harmony] || VOCAL_HARMONIES.thirds;
  const formants = FORMANTS[styleParams.vowel] || FORMANTS.oo;

  const ctx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);

  // Master output
  const masterGain = ctx.createGain();
  masterGain.gain.value = 0.55;
  masterGain.connect(ctx.destination);

  // Reverb simulation (comb filter)
  const reverbGain = ctx.createGain();
  reverbGain.gain.value = 0.2;
  const reverbDelay = ctx.createDelay(0.5);
  reverbDelay.delayTime.value = 0.065;
  const reverbFeedback = ctx.createGain();
  reverbFeedback.gain.value = 0.4;
  const reverbFilter = ctx.createBiquadFilter();
  reverbFilter.type = 'lowpass';
  reverbFilter.frequency.value = 3000;

  reverbGain.connect(reverbDelay);
  reverbDelay.connect(reverbFeedback);
  reverbFeedback.connect(reverbFilter);
  reverbFilter.connect(reverbDelay); // feedback loop
  reverbFilter.connect(masterGain);

  // Additional reverb tap
  const reverbDelay2 = ctx.createDelay(0.5);
  reverbDelay2.delayTime.value = 0.097;
  const reverbFeedback2 = ctx.createGain();
  reverbFeedback2.gain.value = 0.3;
  const reverbFilter2 = ctx.createBiquadFilter();
  reverbFilter2.type = 'lowpass';
  reverbFilter2.frequency.value = 2500;

  reverbGain.connect(reverbDelay2);
  reverbDelay2.connect(reverbFeedback2);
  reverbFeedback2.connect(reverbFilter2);
  reverbFilter2.connect(reverbDelay2);
  reverbFilter2.connect(masterGain);

  // Chord progression
  const progressions = {
    minor: [0, 5, 3, 4],
    major: [0, 3, 4, 0],
    minor_pentatonic: [0, 2, 3, 4],
    major_pentatonic: [0, 2, 3, 0],
  };
  const chordProg = progressions[scale] || progressions.minor;

  // ─── Schedule Vocal Notes ────────────────────────────────────────

  function createVocalVoice(freq, startTime, noteDuration, detuneAmount = 0) {
    // Create a vocal formant voice: sawtooth → formant filters → output
    const voiceGain = ctx.createGain();

    // Breath noise layer
    const noiseSize = Math.ceil(noteDuration * sampleRate);
    const noiseBuffer = ctx.createBuffer(1, noiseSize, sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    for (let i = 0; i < noiseSize; i++) {
      noiseData[i] = (Math.random() * 2 - 1) * 0.02;
    }
    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 2500;
    noiseFilter.Q.value = 2;
    noiseSource.connect(noiseFilter);
    noiseFilter.connect(voiceGain);

    // Main oscillator (sawtooth for rich harmonics that formants can shape)
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, startTime);

    // Add detune for chorus effect
    if (detuneAmount !== 0) {
      osc.detune.setValueAtTime(detuneAmount, startTime);
    }

    // Vibrato LFO
    const vibratoLFO = ctx.createOscillator();
    vibratoLFO.type = 'sine';
    vibratoLFO.frequency.value = styleParams.vibratoRate;
    const vibratoGain = ctx.createGain();
    vibratoGain.gain.value = styleParams.vibratoDepth;
    vibratoLFO.connect(vibratoGain);
    vibratoGain.connect(osc.frequency);

    // Formant filter bank (parallel)
    const formantMixer = ctx.createGain();
    formantMixer.gain.value = 1.0 / formants.length;

    formants.forEach((f) => {
      const bpf = ctx.createBiquadFilter();
      bpf.type = 'bandpass';
      bpf.frequency.value = f.freq;
      bpf.Q.value = f.Q;
      const fGain = ctx.createGain();
      fGain.gain.value = f.gain;
      osc.connect(bpf);
      bpf.connect(fGain);
      fGain.connect(formantMixer);
    });

    formantMixer.connect(voiceGain);

    // Envelope
    const att = styleParams.attack;
    const rel = styleParams.release;
    const sustainLevel = 0.6;

    voiceGain.gain.setValueAtTime(0, startTime);
    voiceGain.gain.linearRampToValueAtTime(sustainLevel, startTime + Math.min(att, noteDuration * 0.4));

    const releaseStart = startTime + noteDuration - Math.min(rel, noteDuration * 0.5);
    voiceGain.gain.setValueAtTime(sustainLevel, releaseStart);
    voiceGain.gain.exponentialRampToValueAtTime(0.001, startTime + noteDuration);

    // Connect to master and reverb
    voiceGain.connect(masterGain);
    voiceGain.connect(reverbGain);

    // Start/stop
    osc.start(startTime);
    osc.stop(startTime + noteDuration + 0.1);
    vibratoLFO.start(startTime);
    vibratoLFO.stop(startTime + noteDuration + 0.1);
    noiseSource.start(startTime);
    noiseSource.stop(startTime + noteDuration + 0.05);
  }

  // Schedule notes per bar
  for (let bar = 0; bar < bars; bar++) {
    const barOffset = bar * barSec;
    const chordDegree = chordProg[bar % chordProg.length];

    // For each harmony interval
    harmonyParams.intervals.forEach((intervalDegree) => {
      const noteInfo = getScaleNote(key, scale, chordDegree + intervalDegree, 4);

      // Create multiple detuned voices for richness
      const numVoices = styleParams.voices;
      for (let v = 0; v < numVoices; v++) {
        const detune = (v - (numVoices - 1) / 2) * styleParams.detuneSpread;
        // Whole bar sustain with slight overlap
        const noteDuration = barSec * 0.95;
        createVocalVoice(noteInfo.freq, barOffset, noteDuration, detune);
      }
    });
  }

  // ─── Render ─────────────────────────────────────────────────────

  const renderedBuffer = await ctx.startRendering();

  // Soft limiting
  for (let ch = 0; ch < renderedBuffer.numberOfChannels; ch++) {
    const data = renderedBuffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      if (data[i] > 0.85 || data[i] < -0.85) {
        data[i] = Math.tanh(data[i]) * 0.9;
      }
    }
  }

  const wavBlob = audioBufferToWav(renderedBuffer);
  return new File(
    [wavBlob],
    `Vocal_${key}_${scale}_${style}_${harmony}_${bpm}bpm.wav`,
    { type: 'audio/wav' }
  );
}
