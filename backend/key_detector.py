"""Estimate musical key from Demucs stems (bass + harmony)."""
from __future__ import annotations

import os
from typing import Optional

DETECTOR_VERSION = 3

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Kessler key profiles
MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

STEM_WEIGHTS = {
    "bass.mp3": 2.4,
    "piano.mp3": 1.6,
    "guitar.mp3": 1.3,
    "other.mp3": 0.55,
}

# Intro helps relative major/minor, but many songs start on the dominant (V).
WINDOWS = [
    (0.0, 28.0, 1.4),
    (24.0, 56.0, 1.0),
]

LOAD_SR = 22050
LOAD_MAX = 110.0


def _corr(a, b) -> float:
    import numpy as np
    if a is None or b is None:
        return 0.0
    if float(np.std(a)) < 1e-9 or float(np.std(b)) < 1e-9:
        return 0.0
    value = np.corrcoef(a, b)[0, 1]
    if value != value:  # NaN
        return 0.0
    return float(value)


def _load_audio(path: str):
    import librosa
    y, sr = librosa.load(path, sr=LOAD_SR, mono=True, duration=LOAD_MAX)
    if y is None or len(y) < LOAD_SR * 3:
        y, sr = librosa.load(path, sr=LOAD_SR, mono=True, duration=90.0)
    return y, sr


def _slice(y, sr, offset: float, duration: float):
    start = int(max(0.0, offset) * sr)
    if start >= len(y):
        return None
    end = len(y) if duration is None else min(len(y), start + int(duration * sr))
    if end - start < sr * 3:
        return None
    return y[start:end]


def _chroma_mean(y, sr, fmin=None):
    import librosa
    import numpy as np
    kwargs = {"y": y, "sr": sr, "hop_length": 2048, "n_chroma": 12}
    if fmin is not None:
        kwargs["fmin"] = fmin
    try:
        chroma = librosa.feature.chroma_cqt(**kwargs)
    except Exception:
        chroma = librosa.feature.chroma_stft(y=y, sr=sr, n_chroma=12, hop_length=2048)
    rms = librosa.feature.rms(y=y, hop_length=2048)[0]
    n = min(chroma.shape[1], rms.shape[0])
    if n == 0:
        return np.zeros(12, dtype=float)
    weights = rms[:n]
    weights = weights / (float(np.sum(weights)) + 1e-9)
    return chroma[:, :n] @ weights


def _score_chroma(combined):
    import numpy as np
    major = np.array(MAJOR_PROFILE, dtype=float)
    minor = np.array(MINOR_PROFILE, dtype=float)
    scores = {}
    for i in range(12):
        maj = _corr(combined, np.roll(major, i))
        minr = _corr(combined, np.roll(minor, i))
        scores[(NOTE_NAMES[i], "major")] = maj
        scores[(NOTE_NAMES[i], "minor")] = minr
    return scores


def _pick_from_scores(scores: dict):
    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    (key, scale), best = ranked[0]
    second = ranked[1][1] if len(ranked) > 1 else -1.0
    return key, scale, best, second, ranked


def _disambiguate_relative(scores: dict, intro_scores: Optional[dict]):
    """Prefer intro tonic when relative major/minor are close (KS often favors major)."""
    key, scale, best, second, ranked = _pick_from_scores(scores)
    idx = NOTE_NAMES.index(key)
    if scale == "major":
        rel_key, rel_scale = NOTE_NAMES[(idx + 9) % 12], "minor"
    else:
        rel_key, rel_scale = NOTE_NAMES[(idx + 3) % 12], "major"
    rel_score = scores.get((rel_key, rel_scale), -1.0)
    close = (best - rel_score) < 0.10 or rel_score >= best * 0.90

    intro_pref = None
    if intro_scores:
        intro_self = intro_scores.get((key, scale), -1.0)
        intro_rel = intro_scores.get((rel_key, rel_scale), -1.0)
        if intro_rel > intro_self + 0.025:
            intro_pref = (rel_key, rel_scale)
        elif intro_self > intro_rel + 0.025:
            intro_pref = (key, scale)

    # Relative minor of a "winning" major: keep minor if intro agrees, or scores are close
    # and the profile gap is the usual major bias.
    if scale == "major" and close:
        if intro_pref == (rel_key, rel_scale) or (
            intro_scores and intro_scores.get((rel_key, "minor"), -1.0) >= intro_scores.get((key, "major"), -1.0)
        ):
            key, scale = rel_key, rel_scale
            best = rel_score
    elif scale == "minor" and close and intro_pref == (rel_key, rel_scale):
        # Only flip minor -> relative major when intro clearly prefers the major tonic.
        if intro_scores.get((rel_key, "major"), -1.0) > intro_scores.get((key, "minor"), -1.0) + 0.08:
            key, scale = rel_key, rel_scale
            best = rel_score

    return key, scale, best, second


def _disambiguate_fifth(scores: dict, chroma, key: str, scale: str, best: float, second: float):
    """Flip dominant-key estimates to the tonic when b7 is stronger than the leading tone.

    G Mayor vs C Mayor is the usual case: lots of G (V) makes KS prefer G, but F > F#
    means the song is in C, not G.
    """
    if scale != "major" or chroma is None:
        return key, scale, best, second
    idx = NOTE_NAMES.index(key)
    sub_key = NOTE_NAMES[(idx + 5) % 12]
    sub_score = scores.get((sub_key, "major"), -1.0)
    close = (best - sub_score) < 0.20 or sub_score >= best * 0.78
    if not close:
        return key, scale, best, second

    leading = float(chroma[(idx + 11) % 12])  # F# if estimated G
    flat7 = float(chroma[(idx + 10) % 12])    # F if estimated G
    tonic = float(chroma[idx])
    sub_tonic = float(chroma[(idx + 5) % 12])
    if flat7 > leading * 1.04 and sub_tonic >= tonic * 0.72:
        return sub_key, "major", sub_score, best
    return key, scale, best, second


def detect_key_from_stem_dir(stem_dir: str) -> Optional[dict]:
    """Return {key, scale, label, confidence} or None if analysis fails."""
    import numpy as np

    if not stem_dir or not os.path.isdir(stem_dir):
        return None

    loaded_stems = []
    for name, weight in STEM_WEIGHTS.items():
        path = os.path.join(stem_dir, name)
        if not os.path.isfile(path) or os.path.getsize(path) < 2048:
            continue
        try:
            y, sr = _load_audio(path)
            if y is None or len(y) < sr:
                continue
            fmin = None
            if name == "bass.mp3":
                import librosa
                fmin = librosa.note_to_hz("E1")
            loaded_stems.append((name, weight, y, sr, fmin))
        except Exception as e:
            print(f"key_detector: skip {name}: {e}")

    if not loaded_stems:
        return None

    total_scores = {(NOTE_NAMES[i], mode): 0.0 for i in range(12) for mode in ("major", "minor")}
    weight_sum = 0.0
    intro_scores = None
    global_chroma = np.zeros(12, dtype=float)
    bass_chroma = np.zeros(12, dtype=float)

    for offset, duration, win_weight in WINDOWS:
        combined = np.zeros(12, dtype=float)
        used = 0
        for name, stem_weight, y, sr, fmin in loaded_stems:
            sl = _slice(y, sr, offset, duration)
            if sl is None:
                continue
            chroma = _chroma_mean(sl, sr, fmin=fmin)
            if name == "bass.mp3" and float(np.sum(chroma)) > 0:
                bass_chroma += chroma * win_weight
            combined += chroma * stem_weight
            used += 1
        if used == 0 or float(np.sum(combined)) <= 0:
            continue
        scores = _score_chroma(combined)
        if intro_scores is None:
            intro_scores = scores
        for pair, value in scores.items():
            total_scores[pair] += value * win_weight
        global_chroma += combined * win_weight
        weight_sum += win_weight

    if weight_sum <= 0:
        return None

    for pair in total_scores:
        total_scores[pair] /= weight_sum
    global_chroma /= weight_sum

    if float(np.sum(bass_chroma)) > 0:
        bass_pc = int(np.argmax(bass_chroma))
        total_scores[(NOTE_NAMES[bass_pc], "major")] += 0.04
        total_scores[(NOTE_NAMES[bass_pc], "minor")] += 0.05

    key, scale, best_corr, second = _disambiguate_relative(total_scores, intro_scores)
    key, scale, best_corr, second = _disambiguate_fifth(
        total_scores, global_chroma, key, scale, best_corr, second
    )
    confidence = max(0.0, min(1.0, (best_corr + 1.0) / 2.0))
    if best_corr - second < 0.02:
        confidence *= 0.85

    mode_label = "Mayor" if scale == "major" else "Minor"
    return {
        "key": key,
        "scale": scale,
        "label": f"{key} {mode_label}",
        "confidence": round(confidence, 3),
        "version": DETECTOR_VERSION,
    }


def detect_key_from_mix_file(path: str) -> Optional[dict]:
    """Fast key estimate from a mixed song snippet (playlist). Uses STFT, not CQT."""
    import numpy as np
    import librosa

    if not path or not os.path.isfile(path) or os.path.getsize(path) < 2048:
        return None
    try:
        y, sr = librosa.load(path, sr=11025, mono=True, duration=20.0)
    except Exception as e:
        print(f"key_detector: mix load failed: {e}")
        return None
    if y is None or len(y) < sr * 3:
        return None

    hop = 1024
    chroma = librosa.feature.chroma_stft(y=y, sr=sr, n_chroma=12, hop_length=hop)
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    n = min(chroma.shape[1], rms.shape[0])
    if n == 0:
        return None
    weights = rms[:n]
    weights = weights / (float(np.sum(weights)) + 1e-9)
    combined = chroma[:, :n] @ weights
    scores = _score_chroma(combined)

    intro_end = min(len(y), int(sr * 8))
    intro_scores = None
    if intro_end >= sr * 3:
        intro_chroma = librosa.feature.chroma_stft(y=y[:intro_end], sr=sr, n_chroma=12, hop_length=hop)
        intro_rms = librosa.feature.rms(y=y[:intro_end], hop_length=hop)[0]
        ni = min(intro_chroma.shape[1], intro_rms.shape[0])
        if ni > 0:
            iw = intro_rms[:ni]
            iw = iw / (float(np.sum(iw)) + 1e-9)
            intro_scores = _score_chroma(intro_chroma[:, :ni] @ iw)

    key, scale, best_corr, second = _disambiguate_relative(scores, intro_scores)
    key, scale, best_corr, second = _disambiguate_fifth(
        scores, combined, key, scale, best_corr, second
    )
    confidence = max(0.0, min(1.0, (best_corr + 1.0) / 2.0))
    if best_corr - second < 0.02:
        confidence *= 0.85

    mode_label = "Mayor" if scale == "major" else "Minor"
    return {
        "key": key,
        "scale": scale,
        "label": f"{key} {mode_label}",
        "confidence": round(confidence, 3),
        "version": DETECTOR_VERSION,
    }
