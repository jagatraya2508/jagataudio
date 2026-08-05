export const DRUM_PRESETS = {
  rock: {
    name: 'Rock',
    kick:  [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hihat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
  },
  pop: {
    name: 'Pop',
    kick:  [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hihat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  },
  pop_rock: {
    name: 'Pop Rock',
    kick:  [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hihat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
  },
  classic_rock: {
    name: 'Classic Rock',
    kick:  [1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hihat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
  },
  rnb: {
    name: 'R&B / Soul',
    kick:  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hihat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
  },
  funk: {
    name: 'Funk',
    kick:  [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0],
    hihat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  },
  metal: {
    name: 'Metal',
    kick:  [1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hihat: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  },
  blues: {
    name: 'Blues',
    kick:  [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hihat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
  },
  house: {
    name: 'EDM / House',
    kick:  [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hihat: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
  },
  hiphop: {
    name: 'Hip-Hop / Boombap',
    kick:  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hihat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  },
  reggaeton: {
    name: 'Reggaeton / Dembow',
    kick:  [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    snare: [0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0],
    hihat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
  },
  dnb: {
    name: 'Drum & Bass',
    kick:  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hihat: [1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0],
  },
  bossanova: {
    name: 'Bossa Nova',
    kick:  [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0],
    snare: [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0],
    hihat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  }
};

export const DRUM_FILLS = {
  none: { name: 'Tanpa Fill (None)' },
  snare_roll: {
    name: 'Snare Roll 16th',
    kick:  [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    snare: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    hihat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    tomH:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    tomM:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    tomL:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  classic_tom: {
    name: 'Classic Tom Fill',
    kick:  [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    snare: [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    hihat: [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    tomH:  [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0],
    tomM:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0],
    tomL:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  },
  trap_hat: {
    name: 'Trap Hat Roll',
    kick:  [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hihat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    tomH:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    tomM:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    tomL:  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  }
};

/**
 * Creates a distortion curve for analog warmth/clipping.
 */
function makeDistortionCurve(amount) {
  let k = typeof amount === 'number' ? amount : 50,
    n_samples = 44100,
    curve = new Float32Array(n_samples),
    deg = Math.PI / 180,
    i = 0,
    x;
  for ( ; i < n_samples; ++i ) {
    x = i * 2 / n_samples - 1;
    curve[i] = ( 3 + k ) * x * 20 * deg / ( Math.PI + k * Math.abs(x) );
  }
  return curve;
}

export async function generateDrumLoop({ bpm = 120, bars = 4, genre = 'rock', customGrid = null, kit = 'acoustic', fill = 'none', splitTracks = false, swing = 0 }) {
  const beatSec = 60 / bpm;
  const barSec = beatSec * 4;
  const duration = barSec * bars;
  const sampleRate = 44100;
  
  const basePattern = genre === 'custom' && customGrid ? customGrid : DRUM_PRESETS[genre] || DRUM_PRESETS['rock'];
  const fillPattern = DRUM_FILLS[fill] && fill !== 'none' ? DRUM_FILLS[fill] : null;
  const stepDuration = beatSec / 4;

  // Kit Parameters
  const params = {
    acoustic: {
      kick: { fStart: 120, fEnd: 50, fDrop: 0.05, decay: 0.3, gain: 1 },
      snare: { nHP: 1000, nDecay: 0.15, tFreq: 250, tDecay: 0.1, gain: 0.6 },
      hihat: { nBP: 8000, nHP: 6000, decay: 0.05, gain: 0.3 }
    },
    '808': {
      kick: { fStart: 100, fEnd: 45, fDrop: 0.08, decay: 0.8, gain: 1.2 },
      snare: { nHP: 2500, nDecay: 0.3, tFreq: 300, tDecay: 0.12, gain: 0.7 },
      hihat: { nBP: 10000, nHP: 8000, decay: 0.1, gain: 0.4 }
    },
    '909': {
      kick: { fStart: 160, fEnd: 50, fDrop: 0.04, decay: 0.4, gain: 1.1 },
      snare: { nHP: 1500, nDecay: 0.25, tFreq: 200, tDecay: 0.15, gain: 0.8 },
      hihat: { nBP: 7000, nHP: 5000, decay: 0.06, gain: 0.35 }
    },
    lofi: {
      kick: { fStart: 110, fEnd: 60, fDrop: 0.06, decay: 0.35, gain: 1.5 },
      snare: { nHP: 800, nDecay: 0.12, tFreq: 180, tDecay: 0.08, gain: 0.9 },
      hihat: { nBP: 5000, nHP: 4000, decay: 0.08, gain: 0.4 }
    }
  };

  const p = params[kit] || params['acoustic'];

  const renderPart = async (allowedInsts) => {
    const ctx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
    
    let kitOutput = ctx.destination;
    if (kit === 'lofi') {
      const lofiFilter = ctx.createBiquadFilter();
      lofiFilter.type = 'lowpass';
      lofiFilter.frequency.value = 3500;
      const bitcrusher = ctx.createWaveShaper();
      bitcrusher.curve = makeDistortionCurve(10);
      lofiFilter.connect(bitcrusher);
      bitcrusher.connect(ctx.destination);
      kitOutput = lofiFilter;
    } else if (kit === '808' || kit === '909') {
      const saturator = ctx.createWaveShaper();
      saturator.curve = makeDistortionCurve(20);
      saturator.connect(ctx.destination);
      kitOutput = saturator;
    }

    for (let bar = 0; bar < bars; bar++) {
      const barOffset = bar * barSec;
      const isLastBar = bar === bars - 1;
      const pattern = (isLastBar && fillPattern) ? fillPattern : basePattern;
      
      for (let step = 0; step < 16; step++) {
        let time = barOffset + (step * stepDuration);
        if (step % 2 !== 0) {
          time += stepDuration * swing; // Shift even 16th notes by swing percentage
        }
        
        if (allowedInsts.includes('kick') && pattern.kick && pattern.kick[step]) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(kitOutput);
          osc.frequency.setValueAtTime(p.kick.fStart, time);
          osc.frequency.exponentialRampToValueAtTime(p.kick.fEnd, time + p.kick.fDrop);
          gain.gain.setValueAtTime(0, time);
          gain.gain.linearRampToValueAtTime(p.kick.gain, time + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.001, time + p.kick.decay);
          osc.start(time);
          osc.stop(time + p.kick.decay + 0.1);
        }
        
        if (allowedInsts.includes('snare') && pattern.snare && pattern.snare[step]) {
          const noiseSize = sampleRate * 0.4;
          const noiseBuffer = ctx.createBuffer(1, noiseSize, sampleRate);
          const output = noiseBuffer.getChannelData(0);
          for (let i = 0; i < noiseSize; i++) output[i] = Math.random() * 2 - 1;
          const noise = ctx.createBufferSource();
          noise.buffer = noiseBuffer;
          const noiseFilter = ctx.createBiquadFilter();
          noiseFilter.type = kit === 'lofi' ? 'bandpass' : 'highpass';
          noiseFilter.frequency.value = p.snare.nHP;
          const noiseGain = ctx.createGain();
          noise.connect(noiseFilter);
          noiseFilter.connect(noiseGain);
          noiseGain.connect(kitOutput);
          
          let sGain = p.snare.gain;
          if (isLastBar && fill === 'snare_roll') {
             sGain = sGain * (0.5 + (step / 16) * 0.5);
          }
          noiseGain.gain.setValueAtTime(0, time);
          noiseGain.gain.linearRampToValueAtTime(sGain, time + 0.01);
          noiseGain.gain.exponentialRampToValueAtTime(0.001, time + p.snare.nDecay);
          noise.start(time);
          
          const osc = ctx.createOscillator();
          osc.type = kit === '909' ? 'sine' : 'triangle';
          const oscGain = ctx.createGain();
          osc.connect(oscGain);
          oscGain.connect(kitOutput);
          osc.frequency.setValueAtTime(p.snare.tFreq, time);
          if (kit === '808' || kit === '909') {
             osc.frequency.exponentialRampToValueAtTime(p.snare.tFreq * 0.5, time + p.snare.tDecay);
          }
          oscGain.gain.setValueAtTime(0, time);
          oscGain.gain.linearRampToValueAtTime(sGain * 0.8, time + 0.01);
          oscGain.gain.exponentialRampToValueAtTime(0.001, time + p.snare.tDecay);
          osc.start(time);
          osc.stop(time + p.snare.tDecay + 0.1);
        }
        
        if (allowedInsts.includes('hihat') && pattern.hihat && pattern.hihat[step]) {
          const triggerHihat = (t) => {
            const noiseSize = sampleRate * 0.2;
            const noiseBuffer = ctx.createBuffer(1, noiseSize, sampleRate);
            const output = noiseBuffer.getChannelData(0);
            for (let i = 0; i < noiseSize; i++) output[i] = Math.random() * 2 - 1;
            const noise = ctx.createBufferSource();
            noise.buffer = noiseBuffer;
            const bandpass = ctx.createBiquadFilter();
            bandpass.type = 'bandpass';
            bandpass.frequency.value = p.hihat.nBP;
            const highpass = ctx.createBiquadFilter();
            highpass.type = 'highpass';
            highpass.frequency.value = p.hihat.nHP;
            const gain = ctx.createGain();
            noise.connect(bandpass);
            bandpass.connect(highpass);
            highpass.connect(gain);
            gain.connect(kitOutput);
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(p.hihat.gain, t + 0.005);
            gain.gain.exponentialRampToValueAtTime(0.001, t + p.hihat.decay);
            noise.start(t);
          };
          triggerHihat(time);
          if (isLastBar && fill === 'trap_hat' && step % 4 >= 2) {
             triggerHihat(time + stepDuration / 2);
          }
        }

        if (allowedInsts.includes('toms')) {
          const triggerTom = (t, fStart, fEnd, decay) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(kitOutput);
            osc.frequency.setValueAtTime(fStart, t);
            osc.frequency.exponentialRampToValueAtTime(fEnd, t + 0.1);
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(p.kick.gain * 0.8, t + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.001, t + decay);
            osc.start(t);
            osc.stop(t + decay + 0.1);
          };
          if (pattern.tomH && pattern.tomH[step]) triggerTom(time, 200, 100, 0.3);
          if (pattern.tomM && pattern.tomM[step]) triggerTom(time, 150, 70, 0.4);
          if (pattern.tomL && pattern.tomL[step]) triggerTom(time, 100, 50, 0.6);
        }
      }
    }
    return await ctx.startRendering();
  };

  if (splitTracks) {
    const kickBuf = await renderPart(['kick']);
    const snareBuf = await renderPart(['snare']);
    const hihatBuf = await renderPart(['hihat']);
    const tomsBuf = await renderPart(['toms']);
    return {
      Kick: kickBuf,
      Snare: snareBuf,
      Hihat: hihatBuf,
      Toms: tomsBuf
    };
  } else {
    return await renderPart(['kick', 'snare', 'hihat', 'toms']);
  }
}
