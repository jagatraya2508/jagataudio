import os
import numpy as np
import soundfile as sf
try:
    from pedalboard import Pedalboard, Distortion, Reverb, Chorus, Compressor, HighpassFilter, LowpassFilter
except ImportError:
    pass

def generate_kick(sr=44100, duration=0.5):
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    freq = np.exp(-t * 20) * 150 + 40
    kick = np.sin(2 * np.pi * freq * t)
    env = np.exp(-t * 5)
    return kick * env

def generate_snare(sr=44100, duration=0.5):
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    noise = np.random.normal(0, 1, len(t))
    env = np.exp(-t * 15)
    
    # simple sine for body
    freq = np.exp(-t * 10) * 200 + 100
    body = np.sin(2 * np.pi * freq * t) * np.exp(-t * 10)
    
    snare = (noise * 0.5 + body * 0.5) * env
    return snare

def generate_sawtooth(freq, sr=44100, duration=0.5):
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    return 2.0 * (t * freq - np.floor(0.5 + t * freq))

def generate_dj_beat(out_path):
    sr = 44100
    bpm = 128.0
    beat_dur = 60.0 / bpm
    
    kick = generate_kick(sr, beat_dur) * 1.2
    
    # 4 on the floor (4 beats)
    loop = np.tile(kick, 4)
    
    # Duplicate to make it 4 bars (16 beats)
    loop = np.tile(loop, 4)
    
    # Add a simple off-beat hi-hat (noise)
    t = np.linspace(0, beat_dur, int(sr * beat_dur), endpoint=False)
    hat = np.random.normal(0, 1, len(t)) * np.exp(-t * 30) * 0.2
    hat_offbeat = np.zeros_like(hat)
    half_beat = int(len(hat)/2)
    hat_offbeat[half_beat:half_beat+len(hat)//2] = hat[:len(hat)//2]
    
    hat_loop = np.tile(hat_offbeat, 16)
    
    mix = loop + hat_loop
    mix = np.clip(mix, -1.0, 1.0)
    
    sf.write(out_path, mix, sr)
    print(f"Generated {out_path} (BPM: {bpm})")

def generate_rock_beat(out_path):
    sr = 44100
    bpm = 120.0
    beat_dur = 60.0 / bpm
    
    kick = generate_kick(sr, beat_dur)
    snare = generate_snare(sr, beat_dur)
    
    # Rock beat: Kick on 1 and 3, Snare on 2 and 4
    zero = np.zeros_like(kick)
    bar = np.concatenate([kick, snare, kick, snare])
    drums = np.tile(bar, 4) # 4 bars
    
    # Rock guitar (Power chord E: E2(82.4Hz), B2(123.4Hz), E3(164.8Hz))
    # 8th notes strumming
    eighth_dur = beat_dur / 2
    e2 = generate_sawtooth(82.41, sr, eighth_dur)
    b2 = generate_sawtooth(123.47, sr, eighth_dur)
    e3 = generate_sawtooth(164.81, sr, eighth_dur)
    
    chord = (e2 + b2 + e3) / 3.0
    env = np.exp(-np.linspace(0, eighth_dur, len(chord)) * 2)
    chord = chord * env * 0.8
    
    guitar_bar = np.tile(chord, 8) # 8 eighths in a bar
    guitar = np.tile(guitar_bar, 4)
    
    # Apply pedalboard to guitar
    try:
        board = Pedalboard([
            HighpassFilter(cutoff_frequency_hz=100),
            Distortion(drive_db=30.0),
            Chorus(),
            Reverb(room_size=0.2)
        ])
        guitar = board(guitar, sr)
    except:
        pass
    
    # Ensure same length
    min_len = min(len(drums), len(guitar))
    mix = drums[:min_len] * 0.7 + guitar[:min_len] * 0.5
    mix = np.clip(mix, -1.0, 1.0)
    
    sf.write(out_path, mix, sr)
    print(f"Generated {out_path} (BPM: {bpm})")

if __name__ == "__main__":
    assets_dir = os.path.join(os.path.dirname(__file__), "assets")
    os.makedirs(assets_dir, exist_ok=True)
    
    generate_dj_beat(os.path.join(assets_dir, "dj_beat.wav"))
    generate_rock_beat(os.path.join(assets_dir, "rock_beat.wav"))
