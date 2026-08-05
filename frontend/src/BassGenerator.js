import * as Tone from 'tone';
import { audioBufferToWav } from './DawAudioEngine';

export async function generateBassLoop({ bpm = 120, bars = 4, key = 'C', scale = 'minor', pattern = 'offbeat' }) {
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const duration = barSec * bars;
  const sampleRate = 44100;

  const ctx = new Tone.OfflineContext(2, duration, sampleRate);

  // Bass Synth Setup
  const bassSynth = new Tone.MonoSynth({
    oscillator: { type: 'sawtooth' },
    envelope: { attack: 0.01, decay: 0.3, sustain: 0.1, release: 0.4 },
    filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0, release: 0.2, baseFrequency: 100, octaves: 3 },
    filter: { type: 'lowpass', rolloff: -24, Q: 1 }
  }).toDestination();

  // Scales definition (Relative to root)
  const SCALES = {
    minor: [0, 2, 3, 5, 7, 8, 10],
    major: [0, 2, 4, 5, 7, 9, 11]
  };
  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function getNote(root, scaleName, degree, octave = 2) {
    const rootIndex = NOTES.indexOf(root.toUpperCase());
    const intervals = SCALES[scaleName] || SCALES.minor;
    const interval = intervals[degree % intervals.length];
    const octOffset = Math.floor(degree / intervals.length);
    const totalIndex = rootIndex + interval;
    const finalOctave = octave + octOffset + Math.floor(totalIndex / 12);
    const finalNote = NOTES[totalIndex % 12];
    return `${finalNote}${finalOctave}`;
  }

  // Generate sequence based on pattern
  const stepDuration = beatSec / 4; // 16th notes
  const totalSteps = Math.floor(duration / stepDuration);

  for (let i = 0; i < totalSteps; i++) {
    const time = i * stepDuration;
    const stepInBar = i % 16;
    const barIdx = Math.floor(i / 16);

    let noteToPlay = null;
    let length = '16n';

    if (pattern === 'offbeat') {
      // Plays on the "and" of the beat (step 2, 6, 10, 14)
      if (stepInBar === 2 || stepInBar === 6 || stepInBar === 10 || stepInBar === 14) {
        noteToPlay = getNote(key, scale, 0, 2);
        length = '8n';
      }
    } else if (pattern === 'rolling') {
      // Trance/Psy rolling bass (16th notes except kick)
      if (stepInBar % 4 !== 0) {
        noteToPlay = getNote(key, scale, 0, 2);
      }
    } else if (pattern === 'groove') {
      // Funky groove
      if (stepInBar === 0) noteToPlay = getNote(key, scale, 0, 2); // Root
      if (stepInBar === 3) noteToPlay = getNote(key, scale, 0, 2);
      if (stepInBar === 6) noteToPlay = getNote(key, scale, 2, 2); // Third
      if (stepInBar === 9) noteToPlay = getNote(key, scale, 0, 2);
      if (stepInBar === 12) noteToPlay = getNote(key, scale, 4, 2); // Fifth
      if (stepInBar === 14) noteToPlay = getNote(key, scale, 3, 2); // Fourth
    }

    if (noteToPlay) {
      bassSynth.triggerAttackRelease(noteToPlay, length, time);
    }
  }

  const resultBuffer = await ctx.render();
  const nativeBuffer = resultBuffer.get ? resultBuffer.get() : resultBuffer;
  const wavBlob = audioBufferToWav(nativeBuffer);
  return new File([wavBlob], `Bass_${key}_${scale}_${pattern}_${bpm}bpm.wav`, { type: 'audio/wav' });
}
