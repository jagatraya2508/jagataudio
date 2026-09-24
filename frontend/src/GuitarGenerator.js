/**
 * GuitarGenerator.js
 * ──────────────────
 * Client-side guitar synthesis using Tone.js OfflineContext.
 * Generates guitar loops with various patterns and tone presets.
 * 
 * Patterns: Power Chord, Arpeggio, Strumming, Fingerpicking, Palm Mute, Lead Melody
 * Tones: Clean, Crunch, Distortion, Acoustic
 */

import * as Tone from 'tone';
import { audioBufferToWav } from './DawAudioEngine';
import { createGuitarPluckInstrument, normalizeAudioBuffer } from './guitarInstrument';

// ─── Scale & Note Helpers ─────────────────────────────────────────

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const SCALES = {
  minor:           [0, 2, 3, 5, 7, 8, 10],
  major:           [0, 2, 4, 5, 7, 9, 11],
  minor_pentatonic:[0, 3, 5, 7, 10],
  major_pentatonic:[0, 2, 4, 7, 9],
  blues:           [0, 3, 5, 6, 7, 10],
  dorian:          [0, 2, 3, 5, 7, 9, 10],
  mixolydian:      [0, 2, 4, 5, 7, 9, 10],
};

function noteToFreq(note, octave) {
  const idx = NOTES.indexOf(note);
  if (idx < 0) return 440;
  const midiNote = (octave + 1) * 12 + idx;
  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

function getScaleNote(root, scaleName, degree, octave = 3) {
  const rootIndex = NOTES.indexOf(root.toUpperCase());
  const intervals = SCALES[scaleName] || SCALES.minor;
  const interval = intervals[((degree % intervals.length) + intervals.length) % intervals.length];
  const octOffset = Math.floor(degree / intervals.length);
  const totalIndex = rootIndex + interval;
  const finalOctave = octave + octOffset + Math.floor(totalIndex / 12);
  const finalNote = NOTES[totalIndex % 12];
  return { note: finalNote, octave: finalOctave, freq: noteToFreq(finalNote, finalOctave) };
}

function clampGuitarFreq(freq) {
  let f = Number(freq);
  if (!Number.isFinite(f) || f <= 0) return 110;
  while (f < 82) f *= 2;
  while (f > 494) f /= 2;
  return f;
}

function getChordFreqs(root, scaleName, degree, octave = 3) {
  const root_n = getScaleNote(root, scaleName, degree, octave);
  const third  = getScaleNote(root, scaleName, degree + 2, octave);
  const fifth  = getScaleNote(root, scaleName, degree + 4, octave);
  return [root_n.freq, third.freq, fifth.freq].map(clampGuitarFreq);
}

function getPowerChordFreqs(root, scaleName, degree, octave = 2) {
  const root_n = getScaleNote(root, scaleName, degree, octave);
  const fifth  = getScaleNote(root, scaleName, degree + 4, octave);
  return [root_n.freq, fifth.freq, root_n.freq * 2].map(clampGuitarFreq);
}

function getStrumFreqs(root, scaleName, degree, octave = 3) {
  const r = getScaleNote(root, scaleName, degree, 2);
  const third = getScaleNote(root, scaleName, degree + 2, 3);
  const fifth = getScaleNote(root, scaleName, degree + 4, 3);
  return [r.freq, fifth.freq, third.freq, r.freq * 2].map(clampGuitarFreq);
}

// ─── Guitar Patterns ──────────────────────────────────────────────

export const GUITAR_PATTERNS = {
  power_chord: {
    name: 'Power Chord',
    desc: 'Heavy power chords, great for rock/metal',
  },
  arpeggio: {
    name: 'Arpeggio',
    desc: 'Broken chord notes played sequentially',
  },
  strumming: {
    name: 'Strumming',
    desc: 'Rhythmic chord strumming pattern',
  },
  fingerpicking: {
    name: 'Fingerpicking',
    desc: 'Delicate fingerpicked pattern (Travis picking style)',
  },
  palm_mute: {
    name: 'Palm Mute',
    desc: 'Muted percussive chugging pattern',
  },
  lead_melody: {
    name: 'Lead Melody',
    desc: 'Auto-generated melodic lead line from scale',
  },
};

export const GUITAR_TONES = {
  clean: {
    name: 'Clean',
    desc: 'Crystal clear clean tone',
    oscillatorType: 'triangle',
    distortion: 0,
    filterFreq: 4000,
    reverbWet: 0.15,
    chorusWet: 0.2,
    attack: 0.005,
    decay: 0.3,
    sustain: 0.4,
    release: 0.5,
  },
  crunch: {
    name: 'Crunch',
    desc: 'Slightly overdriven blues/rock tone',
    oscillatorType: 'sawtooth',
    distortion: 25,
    filterFreq: 3500,
    reverbWet: 0.12,
    chorusWet: 0,
    attack: 0.003,
    decay: 0.25,
    sustain: 0.35,
    release: 0.4,
  },
  distortion: {
    name: 'Distortion',
    desc: 'Heavy distorted tone for metal/hard rock',
    oscillatorType: 'sawtooth',
    distortion: 60,
    filterFreq: 3000,
    reverbWet: 0.08,
    chorusWet: 0,
    attack: 0.002,
    decay: 0.2,
    sustain: 0.5,
    release: 0.3,
  },
  acoustic: {
    name: 'Acoustic',
    desc: 'Warm acoustic guitar simulation',
    oscillatorType: 'triangle',
    distortion: 0,
    filterFreq: 5000,
    reverbWet: 0.25,
    chorusWet: 0.1,
    attack: 0.002,
    decay: 0.4,
    sustain: 0.2,
    release: 0.6,
  },
};

// ─── Main Generator ───────────────────────────────────────────────

export async function generateGuitarLoop({
  bpm = 120,
  bars = 4,
  key = 'E',
  scale = 'minor',
  pattern = 'power_chord',
  tone = 'clean',
  output = 'audio',
}) {
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const duration = barSec * bars;
  
  const notesOutput = [];

  // Chord progression (I - IV - V - I or I - VI - IV - V)
  const progressions = {
    minor: [0, 5, 3, 4],  // i - VI - iv - v
    major: [0, 3, 4, 0],  // I - IV - V - I
    minor_pentatonic: [0, 3, 5, 4],
    major_pentatonic: [0, 3, 4, 0],
    blues: [0, 3, 4, 0],
    dorian: [0, 3, 4, 0],
    mixolydian: [0, 3, 4, 6],
  };
  const chordProg = progressions[scale] || progressions.minor;

  function scheduleNote(freq, time, noteDuration, velocity = 0.8) {
    notesOutput.push({
      id: `guitar_${Math.random().toString(36).substr(2, 9)}`,
      pitch: Tone.Frequency(clampGuitarFreq(freq)).toNote(),
      startTime: time,
      duration: noteDuration,
      velocity: Math.max(0.5, Math.min(1, velocity)),
      muted: false
    });
  }

  function scheduleChord(freqs, time, noteDuration, velocity = 0.88, strum = 0.002) {
    freqs.forEach((f, i) => {
      scheduleNote(f, time + i * strum, noteDuration, Math.max(0.55, velocity - i * 0.04));
    });
  }

  if (pattern === 'power_chord') {
    for (let bar = 0; bar < bars; bar++) {
      const barOffset = bar * barSec;
      const chordDegree = chordProg[bar % chordProg.length];
      const freqs = getPowerChordFreqs(key, scale, chordDegree, 2);
      scheduleChord(freqs, barOffset, beatSec * 1.7, 0.95, 0);
      scheduleChord(freqs, barOffset + beatSec * 2, beatSec * 1.55, 0.9, 0);
    }
  } else if (pattern === 'arpeggio') {
    const stepDuration = beatSec / 2;
    for (let bar = 0; bar < bars; bar++) {
      const barOffset = bar * barSec;
      const chordDegree = chordProg[bar % chordProg.length];
      const chordFreqs = getStrumFreqs(key, scale, chordDegree);
      for (let step = 0; step < 8; step++) {
        scheduleNote(chordFreqs[step % chordFreqs.length], barOffset + step * stepDuration, stepDuration * 1.1, step % 4 === 0 ? 0.9 : 0.72);
      }
    }
  } else if (pattern === 'strumming') {
    const stepDuration = beatSec / 4;
    const strumPattern = [
      { step: 0,  dur: 3, vel: 0.95 },
      { step: 4,  dur: 2, vel: 0.82 },
      { step: 8,  dur: 3, vel: 0.9 },
      { step: 12, dur: 2, vel: 0.8 },
    ];
    for (let bar = 0; bar < bars; bar++) {
      const barOffset = bar * barSec;
      const chordDegree = chordProg[bar % chordProg.length];
      const downFreqs = getStrumFreqs(key, scale, chordDegree);
      strumPattern.forEach(({ step, dur, vel }) => {
        scheduleChord(downFreqs, barOffset + step * stepDuration, dur * stepDuration, vel, 0.002);
      });
    }
  } else if (pattern === 'fingerpicking') {
    for (let bar = 0; bar < bars; bar++) {
      const barOffset = bar * barSec;
      const voicing = getStrumFreqs(key, scale, chordProg[bar % chordProg.length]);
      const bass = voicing[0];
      const treble = voicing.slice(1);
      for (let beat = 0; beat < 4; beat++) {
        const beatTime = barOffset + beat * beatSec;
        scheduleNote(bass, beatTime, beatSec * 0.9, 0.9);
        scheduleNote(treble[beat % treble.length], beatTime + beatSec * 0.5, beatSec * 0.45, 0.75);
      }
    }
  } else if (pattern === 'palm_mute') {
    const stepDuration = beatSec / 2;
    for (let bar = 0; bar < bars; bar++) {
      const freqs = getPowerChordFreqs(key, scale, chordProg[bar % chordProg.length], 2).slice(0, 2);
      for (let step = 0; step < 8; step++) {
        scheduleChord(freqs, bar * barSec + step * stepDuration, stepDuration * 0.42, step % 2 === 0 ? 0.92 : 0.72, 0);
      }
    }
  } else if (pattern === 'lead_melody') {
    const degrees = [0, 2, 4, 2, 3, 2, 0, 4];
    for (let bar = 0; bar < bars; bar++) {
      for (let i = 0; i < 8; i++) {
        const info = getScaleNote(key, scale, degrees[i], 4);
        const long = i === 0 || i === 4;
        scheduleNote(info.freq, bar * barSec + i * (beatSec / 2), beatSec * (long ? 0.9 : 0.4), long ? 0.92 : 0.75);
      }
    }
  }

  if (output === 'midi') {
    return notesOutput;
  }

  return renderGuitarNotesToFile(notesOutput, duration, tone, key, scale, pattern, bpm);
}

export async function renderGuitarNotesToFile(
  notes,
  duration,
  tone = 'acoustic',
  key = 'C',
  scale = 'minor',
  pattern = 'strumming',
  bpm = 120,
) {
  const safeDur = Math.max(0.5, Number(duration) || 1);
  const rendered = await Tone.Offline(() => {
    const inst = createGuitarPluckInstrument(tone);
    inst.connect(Tone.getDestination());
    for (const n of notes || []) {
      if (!n?.pitch || n.muted) continue;
      inst.triggerAttackRelease(n.pitch, n.duration, n.startTime || 0, n.velocity);
    }
  }, safeDur);

  const nativeBuffer = rendered.get ? rendered.get() : rendered;
  normalizeAudioBuffer(nativeBuffer, 0.9);
  const wavBlob = audioBufferToWav(nativeBuffer);
  return new File(
    [wavBlob],
    `Guitar_${key}_${scale}_${pattern}_${tone}_${bpm}bpm.wav`,
    { type: 'audio/wav' }
  );
}
