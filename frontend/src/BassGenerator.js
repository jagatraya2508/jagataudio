import * as Tone from 'tone';
import { audioBufferToWav } from './DawAudioEngine';

export const BASS_PATTERNS = {
  offbeat:    { name: 'Offbeat (House/Techno)', desc: 'Plays on the "and" of each beat' },
  rolling:    { name: 'Rolling (Trance/Psy)', desc: 'Rapid 16th notes between kicks' },
  groove:     { name: 'Funky Groove', desc: 'Syncopated funk-style groove' },
  walking:    { name: 'Walking Bass (Jazz)', desc: 'Stepwise movement through scale degrees' },
  slap:       { name: 'Slap Funk', desc: 'Percussive slap-style with ghost notes' },
  root_fifth: { name: 'Root-Fifth (Rock/Country)', desc: 'Classic alternating root and fifth' },
  octave:     { name: 'Octave Bass', desc: 'Pumping octave jumps (Disco/Dance)' },
};

export const BASS_SYNTH_TYPES = {
  sawtooth: { name: 'Sawtooth (Classic)', desc: 'Rich harmonics, classic bass synth' },
  sine:     { name: 'Sine (Deep Sub)', desc: 'Pure deep sub-bass tone' },
  square:   { name: 'Square (Synth)', desc: 'Hollow, retro synth bass tone' },
};

export async function generateBassLoop({ bpm = 120, bars = 4, key = 'C', scale = 'minor', pattern = 'offbeat', synthType = 'sawtooth', output = 'audio' }) {
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const duration = barSec * bars;
  
  const notesOutput = []; // Store MIDI notes
  
  // Scales definition (Relative to root)
  const SCALES = {
    minor: [0, 2, 3, 5, 7, 8, 10],
    major: [0, 2, 4, 5, 7, 9, 11],
    minor_pentatonic: [0, 3, 5, 7, 10],
    major_pentatonic: [0, 2, 4, 7, 9],
    blues: [0, 3, 5, 6, 7, 10],
  };
  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function getNote(root, scaleName, degree, octave = 2) {
    const rootIndex = NOTES.indexOf(root.toUpperCase());
    const intervals = SCALES[scaleName] || SCALES.minor;
    const interval = intervals[((degree % intervals.length) + intervals.length) % intervals.length];
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
    let velocity = 0.8;

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
      if (stepInBar === 0)  { noteToPlay = getNote(key, scale, 0, 2); velocity = 0.9; }
      if (stepInBar === 3)  { noteToPlay = getNote(key, scale, 0, 2); velocity = 0.6; }
      if (stepInBar === 6)  { noteToPlay = getNote(key, scale, 2, 2); velocity = 0.75; }
      if (stepInBar === 9)  { noteToPlay = getNote(key, scale, 0, 2); velocity = 0.65; }
      if (stepInBar === 12) { noteToPlay = getNote(key, scale, 4, 2); velocity = 0.8; }
      if (stepInBar === 14) { noteToPlay = getNote(key, scale, 3, 2); velocity = 0.55; }
    } else if (pattern === 'walking') {
      // Walking bass: stepwise motion through scale, one note per beat
      if (stepInBar % 4 === 0) {
        const beat = stepInBar / 4;
        // Walk through scale degrees with some musical logic
        const walkDegrees = [0, 1, 2, 3, 4, 3, 2, 1]; // up and down
        const degree = walkDegrees[(barIdx * 4 + beat) % walkDegrees.length];
        noteToPlay = getNote(key, scale, degree, 2);
        length = '4n';
        velocity = beat === 0 ? 0.9 : 0.7;
      }
    } else if (pattern === 'slap') {
      // Slap funk: percussive hits with ghost notes
      // Strong hits on 1 and 3, ghost notes between
      if (stepInBar === 0) {
        noteToPlay = getNote(key, scale, 0, 2);
        length = '8n';
        velocity = 1.0;
      } else if (stepInBar === 3) {
        noteToPlay = getNote(key, scale, 0, 2);
        length = '16n';
        velocity = 0.35; // ghost note
      } else if (stepInBar === 6) {
        noteToPlay = getNote(key, scale, 4, 2); // pop on the fifth
        length = '16n';
        velocity = 0.85;
      } else if (stepInBar === 8) {
        noteToPlay = getNote(key, scale, 0, 2);
        length = '8n';
        velocity = 0.9;
      } else if (stepInBar === 10) {
        noteToPlay = getNote(key, scale, 0, 2);
        length = '16n';
        velocity = 0.3; // ghost
      } else if (stepInBar === 13) {
        noteToPlay = getNote(key, scale, 3, 2);
        length = '16n';
        velocity = 0.75;
      } else if (stepInBar === 15) {
        noteToPlay = getNote(key, scale, 4, 2);
        length = '16n';
        velocity = 0.4; // ghost pickup
      }
    } else if (pattern === 'root_fifth') {
      // Root-Fifth alternation: classic country/rock bass
      if (stepInBar === 0) {
        noteToPlay = getNote(key, scale, 0, 2); // Root
        length = '4n';
        velocity = 0.9;
      } else if (stepInBar === 4) {
        noteToPlay = getNote(key, scale, 4, 2); // Fifth
        length = '4n';
        velocity = 0.7;
      } else if (stepInBar === 8) {
        noteToPlay = getNote(key, scale, 0, 2); // Root
        length = '4n';
        velocity = 0.85;
      } else if (stepInBar === 12) {
        noteToPlay = getNote(key, scale, 4, 2); // Fifth
        length = '4n';
        velocity = 0.7;
      }
    } else if (pattern === 'octave') {
      // Octave bass: pumping disco/dance
      if (stepInBar % 4 === 0) {
        // Low octave on downbeats
        noteToPlay = getNote(key, scale, 0, 1);
        length = '8n';
        velocity = 0.9;
      } else if (stepInBar % 4 === 2) {
        // High octave on upbeats
        noteToPlay = getNote(key, scale, 0, 2);
        length = '8n';
        velocity = 0.65;
      }
    }

    if (noteToPlay) {
      // Convert Tone.js string duration ('16n', '8n', etc) to seconds based on bpm
      let durSec = beatSec / 4; // default 16n
      if (length === '8n') durSec = beatSec / 2;
      if (length === '4n') durSec = beatSec;
      
      notesOutput.push({
        id: `bass_${Math.random().toString(36).substr(2, 9)}`,
        pitch: noteToPlay,
        startTime: time,
        duration: durSec,
        velocity: velocity,
        muted: false
      });
    }
  }

  if (output === 'midi') {
    return notesOutput;
  }

  // Audio rendering setup (only if output !== 'midi')
  const sampleRate = 44100;
  const ctx = new Tone.OfflineContext(2, duration, sampleRate);
  
  const synthConfigs = {
    sawtooth: { oscillator: { type: 'sawtooth' }, envelope: { attack: 0.01, decay: 0.3, sustain: 0.1, release: 0.4 }, filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0, release: 0.2, baseFrequency: 100, octaves: 3 }, filter: { type: 'lowpass', rolloff: -24, Q: 1 } },
    sine: { oscillator: { type: 'sine' }, envelope: { attack: 0.005, decay: 0.4, sustain: 0.3, release: 0.5 }, filterEnvelope: { attack: 0.01, decay: 0.3, sustain: 0.1, release: 0.3, baseFrequency: 60, octaves: 2 }, filter: { type: 'lowpass', rolloff: -12, Q: 0.5 } },
    square: { oscillator: { type: 'square' }, envelope: { attack: 0.008, decay: 0.25, sustain: 0.15, release: 0.35 }, filterEnvelope: { attack: 0.01, decay: 0.15, sustain: 0, release: 0.2, baseFrequency: 120, octaves: 2.5 }, filter: { type: 'lowpass', rolloff: -24, Q: 1.5 } },
  };
  const bassSynth = new Tone.MonoSynth(synthConfigs[synthType] || synthConfigs.sawtooth).toDestination();

  // Play notes in offline context
  for (const n of notesOutput) {
    bassSynth.triggerAttackRelease(n.pitch, n.duration, n.startTime, n.velocity);
  }

  const resultBuffer = await ctx.render();
  const nativeBuffer = resultBuffer.get ? resultBuffer.get() : resultBuffer;
  const wavBlob = audioBufferToWav(nativeBuffer);
  return new File([wavBlob], `Bass_${key}_${scale}_${pattern}_${synthType}_${bpm}bpm.wav`, { type: 'audio/wav' });
}
