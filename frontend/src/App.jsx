import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as Tone from 'tone';
import { Upload, Play, Pause, Loader2, Volume2, VolumeX, Music, Settings2, Guitar, Mic2, Drum, Sparkles, RefreshCw, Download, FileText, User, Lock, LogOut, Shield, Trash2, Pencil, Plus, X, Mail, MonitorPlay, Search, ChevronUp, ChevronDown, RotateCcw, Mic, KeyRound, Copy, CheckCircle, AlertTriangle, Clock, Sliders, FolderOpen, SkipBack, SkipForward, ListMusic, ArrowLeft, Scissors, Square, Circle, Layers, Shuffle, Repeat } from 'lucide-react';
import DawStudio from './DawStudio';
import './index.css';

// Production (JagatAudio.exe): API & UI one origin → ikut port otomatis.
// Dev (Vite): backend default 8000 (atau VITE_API_PORT).
const API_BASE_URL = import.meta.env.DEV
  ? `http://${window.location.hostname}:${import.meta.env.VITE_API_PORT || 8000}`
  : '';

const isVideoFile = (name) => /\.(mp4|mov|avi|mkv|webm)$/i.test(name || '');

/** Standard 10-band graphic EQ center frequencies (Hz) */
const EQ_BAND_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_BAND_LABELS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
const flatEqBands = () => EQ_BAND_FREQS.map(() => 0);

/** Konfigurasi Granular Synthesis untuk pitch-shift & tempo-stretch halus tanpa pengulangan (stutter-free).
 *  Grain size 80ms dengan 40ms crossfade memastikan peregangan tempo dan pitch berjalan mulus. */
const grainSizeForPitch = (semitones) => {
  const abs = Math.abs(Number(semitones) || 0);
  return Math.max(0.06, Math.min(0.12, 0.08 + abs * 0.003));
};
const GRAIN_OVERLAP = 0.04;

const LRC_TIME_TAG = /\[(\d{1,2}):(\d{2})(?:[\.:](\d{1,3}))?\]/g;

function parseLrcTimestamp(minStr, secStr, fracStr) {
  const min = parseInt(minStr, 10);
  const sec = parseInt(secStr, 10);
  let frac = 0;
  if (fracStr) {
    if (fracStr.length <= 2) {
      frac = parseInt(fracStr.padEnd(2, '0'), 10) / 100;
    } else {
      frac = parseInt(fracStr.slice(0, 3), 10) / 1000;
    }
  }
  return min * 60 + sec + frac;
}

function parseLrcLineSegments(line) {
  const segments = [];
  const tags = [...line.matchAll(LRC_TIME_TAG)];
  if (tags.length === 0) return segments;

  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    const time = parseLrcTimestamp(tag[1], tag[2], tag[3]);
    const textStart = tag.index + tag[0].length;
    const textEnd = i + 1 < tags.length ? tags[i + 1].index : line.length;
    const text = line.slice(textStart, textEnd).replace(/\[[a-z]+:[^\]]*\]/gi, '').trim();
    if (text) segments.push({ time, text });
  }
  return segments;
}

function parseLrc(text) {
  let offsetMs = 0;
  const displayLines = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const offsetMatch = line.match(/^\[offset:\s*([+-]?\d+)\]/i);
    if (offsetMatch) {
      offsetMs = parseInt(offsetMatch[1], 10);
      continue;
    }
    if (/^\[(?:ti|ar|al|by|length|re|ve|au|la|tool|key|bpm|language):[^\]]*\]/i.test(line)) continue;

    const segments = parseLrcLineSegments(line);
    if (segments.length === 0) continue;

    const fullText = segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
    displayLines.push({
      time: segments[0].time,
      text: fullText,
      words: segments.length > 1 ? segments : undefined,
    });
  }

  displayLines.sort((a, b) => a.time - b.time);

  const deduped = displayLines.filter((l, i) => (
    i === 0 || l.time !== displayLines[i - 1].time || l.text !== displayLines[i - 1].text
  ));

  for (let i = 0; i < deduped.length; i++) {
    const nextTime = i < deduped.length - 1 ? deduped[i + 1].time : null;
    deduped[i].endTime = nextTime != null ? nextTime : deduped[i].time + 6;
  }

  return { lines: deduped, offset: offsetMs };
}

function audioToLyricTimeline(currentTime, offsetMs = 0, speedPct = 100) {
  return (currentTime + offsetMs / 1000) * (speedPct / 100);
}

/** Lirik maju sedikit lebih dulu agar tidak terasa "kejar" vokal. */
const LYRIC_LOOKAHEAD_SEC = 0.2;

/** Inverse of audioToLyricTimeline — lyric line time → media seconds for burn-in. */
function lyricTimelineToMedia(lyricTime, offsetMs = 0, speedPct = 100) {
  const speed = (Number(speedPct) || 100) / 100;
  return lyricTime / speed - (Number(offsetMs) || 0) / 1000;
}

function buildKaraokeVideoCues(lines, offsetMs = 0, speedPct = 100) {
  if (!lines?.length) return [];
  // Harus inverse persis dari getLyricSyncState (termasuk lookahead).
  // Jangan kurangi LOOKAHEAD di domain media — salah jika speed ≠ 100%.
  return lines
    .map((line) => {
      const start = Math.max(
        0,
        lyricTimelineToMedia(line.time - LYRIC_LOOKAHEAD_SEC, offsetMs, speedPct)
      );
      const endRaw = line.endTime != null
        ? lyricTimelineToMedia(line.endTime - LYRIC_LOOKAHEAD_SEC, offsetMs, speedPct)
        : start + 5;
      const end = Math.max(start + 0.35, endRaw);
      return { start, end, text: (line.text || '').trim() };
    })
    .filter((c) => c.text);
}

function lineHasUsableWordTimings(line) {
  const words = line?.words;
  if (!words || words.length < 2) return false;
  let gapSum = 0;
  let gaps = 0;
  for (let i = 1; i < words.length; i++) {
    const g = words[i].time - words[i - 1].time;
    if (g > 0) {
      gapSum += g;
      gaps += 1;
    }
  }
  if (!gaps) return false;
  // Gap terlalu kecil = word-sync "kejar-kejaran", tampilkan per baris saja
  return (gapSum / gaps) >= 0.14;
}

function getLyricSyncState(lines, currentTime, offsetMs = 0, speedPct = 100) {
  if (!lines?.length) {
    return { activeIndex: -1, progress: 0, activeWordIndex: -1, wordProgress: 0 };
  }

  const t = audioToLyricTimeline(currentTime, offsetMs, speedPct) + LYRIC_LOOKAHEAD_SEC;

  let active = -1;
  let lo = 0;
  let hi = lines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t) {
      active = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  let progress = 0;
  let activeWordIndex = -1;
  let wordProgress = 0;

  if (active >= 0) {
    const line = lines[active];
    const start = line.time;
    const end = line.endTime ?? (active < lines.length - 1 ? lines[active + 1].time : start + 6);
    const span = end - start;
    // Span sangat pendek → progress melonjak; ratakan agar tidak "balapan"
    progress = span > 0.05 ? Math.min(1, Math.max(0, (t - start) / span)) : 0;

    if (lineHasUsableWordTimings(line)) {
      let wordIdx = -1;
      for (let w = 0; w < line.words.length; w++) {
        if (line.words[w].time <= t) wordIdx = w;
        else break;
      }
      activeWordIndex = wordIdx;
      if (wordIdx >= 0) {
        const wStart = line.words[wordIdx].time;
        const wEnd = wordIdx < line.words.length - 1
          ? line.words[wordIdx + 1].time
          : end;
        wordProgress = wEnd > wStart ? Math.min(1, Math.max(0, (t - wStart) / (wEnd - wStart))) : progress;
      }
    }
  }

  return { activeIndex: active, progress, activeWordIndex, wordProgress };
}

function getActiveLyricIndex(lines, currentTime, offsetMs = 0, speedPct = 100) {
  return getLyricSyncState(lines, currentTime, offsetMs, speedPct).activeIndex;
}

function parseTrackName(trackName) {
  const parts = trackName.trim().split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  }
  return { artist: '', title: trackName.trim() };
}

function formatDurationSec(sec) {
  if (!sec || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const INSTRUMENTS = [
  { id: 'vocals', label: 'Vokal', icon: Mic2, color: '#ff477e' },
  { id: 'drums', label: 'Drum', icon: Drum, color: '#ff9f1c' },
  { id: 'bass', label: 'Bass', icon: Music, color: '#2ec4b6' },
  { id: 'guitar', label: 'Gitar', icon: Guitar, color: '#3a86ff' },
  { id: 'piano', label: 'Piano', icon: Music, color: '#8338ec' },
  { id: 'other', label: 'Lainnya', icon: Settings2, color: '#9d4edd' }
];

const MIC_ECHO_TIME = 0.22;
const MIC_ECHO_FEEDBACK = 0.28;
const MIC_ECHO_WET_MAX = 0.45;
const MIC_REVERB_WET_MAX = 0.55;
const MIC_CHORUS_WET_MAX = 0.7;
const MIC_CRUSH_WET_MAX = 0.65;

/** Preset Voice Effect khusus mic karaoke (monitor + rekaman). */
const MIC_VOICE_PRESETS = {
  off: {
    label: 'Natural',
    reverb: 0,
    echoOn: false,
    echo: 0,
    pitch: 0,
    chorus: 0,
    crush: 0,
    filter: 'none',
  },
  hall: {
    label: 'Hall',
    reverb: 50,
    echoOn: true,
    echo: 18,
    pitch: 0,
    chorus: 0,
    crush: 0,
    filter: 'none',
  },
  echo: {
    label: 'Echo',
    reverb: 12,
    echoOn: true,
    echo: 60,
    pitch: 0,
    chorus: 0,
    crush: 0,
    filter: 'none',
  },
  radio: {
    label: 'Radio',
    reverb: 8,
    echoOn: false,
    echo: 0,
    pitch: 0,
    chorus: 0,
    crush: 0,
    filter: 'radio',
  },
  robot: {
    label: 'Robot',
    reverb: 22,
    echoOn: true,
    echo: 25,
    pitch: 0,
    chorus: 35,
    crush: 60,
    filter: 'robot',
  },
  chipmunk: {
    label: 'Chipmunk',
    reverb: 18,
    echoOn: true,
    echo: 15,
    pitch: 6,
    chorus: 10,
    crush: 0,
    filter: 'none',
  },
  deep: {
    label: 'Deep',
    reverb: 22,
    echoOn: true,
    echo: 12,
    pitch: -5,
    chorus: 15,
    crush: 0,
    filter: 'none',
  },
  thick: {
    label: 'Thick',
    reverb: 28,
    echoOn: true,
    echo: 22,
    pitch: 0,
    chorus: 55,
    crush: 0,
    filter: 'none',
  },
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function hzToMidi(hz) {
  return 69 + 12 * Math.log2(hz / 440);
}

function midiToNoteName(midi) {
  if (!Number.isFinite(midi)) return '--';
  const rounded = Math.round(midi);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${name}${octave}`;
}

/** Autocorrelation pitch detect (80–900 Hz). Returns Hz or null. */
function detectPitchHz(wave, sampleRate) {
  if (!wave || wave.length < 64) return null;
  let rms = 0;
  for (let i = 0; i < wave.length; i += 1) rms += wave[i] * wave[i];
  rms = Math.sqrt(rms / wave.length);
  if (rms < 0.01) return null;

  const minLag = Math.floor(sampleRate / 900);
  const maxLag = Math.min(Math.floor(sampleRate / 80), wave.length - 1);
  if (maxLag <= minLag) return null;

  let bestLag = -1;
  let bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let corr = 0;
    let normA = 0;
    let normB = 0;
    const n = wave.length - lag;
    for (let i = 0; i < n; i += 1) {
      const a = wave[i];
      const b = wave[i + lag];
      corr += a * b;
      normA += a * a;
      normB += b * b;
    }
    const denom = Math.sqrt(normA * normB) || 1;
    const score = corr / denom;
    if (score > bestCorr) {
      bestCorr = score;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || bestCorr < 0.85) return null;
  return sampleRate / bestLag;
}

/** Diff in cents, wrapped to nearest octave (-600..+600). Positive = mic higher. */
function pitchDiffCents(micHz, refHz) {
  if (!micHz || !refHz) return null;
  let cents = 1200 * Math.log2(micHz / refHz);
  while (cents > 600) cents -= 1200;
  while (cents < -600) cents += 1200;
  return cents;
}

function parseNumericInput(raw, { min, max, allowInf = false, infValue = min } = {}) {
  const text = String(raw ?? '').trim().replace(/\s*(dB|LUFS)\s*$/i, '').replace(',', '.');
  if (!text) return null;
  if (allowInf && (/^-?(∞|inf|infinity)$/i.test(text) || text === '-')) return infValue;
  const parsed = parseFloat(text.replace(/^\+/, ''));
  if (Number.isNaN(parsed)) return null;
  let next = parsed;
  if (typeof min === 'number') next = Math.max(min, next);
  if (typeof max === 'number') next = Math.min(max, next);
  return Math.round(next);
}

function EditableValue({
  value,
  onCommit,
  min,
  max,
  unit = '',
  formatDisplay,
  formatEdit,
  parseInput,
  className = '',
  style,
  title = 'Ketik nilai lalu Enter',
  ariaLabel,
  allowInf = false,
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const skipBlurRef = useRef(false);

  const display = formatDisplay
    ? formatDisplay(value)
    : `${value > 0 ? '+' : ''}${value}`;

  const commit = (raw) => {
    const next = parseInput
      ? parseInput(raw)
      : parseNumericInput(raw, { min, max, allowInf, infValue: min });
    if (next == null) {
      setEditing(false);
      setText('');
      return;
    }
    onCommit(next);
    setEditing(false);
    setText('');
  };

  return (
    <span className={`editable-value ${className}`.trim()} style={style}>
      <input
        type="text"
        inputMode="decimal"
        className="editable-value-input"
        title={title}
        aria-label={ariaLabel}
        value={editing ? text : display}
        onFocus={(e) => {
          const editText = formatEdit
            ? formatEdit(value)
            : (allowInf && value <= min ? String(min) : String(value).replace(/^\+/, ''));
          setEditing(true);
          setText(editText);
          e.target.select();
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          if (skipBlurRef.current) {
            skipBlurRef.current = false;
            setEditing(false);
            setText('');
            return;
          }
          commit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            skipBlurRef.current = true;
            setEditing(false);
            setText('');
            e.currentTarget.blur();
          }
        }}
      />
      {unit ? <span className="editable-value-unit">{unit}</span> : null}
    </span>
  );
}

function App() {
  // Tab navigation
  const [activeTab, setActiveTab] = useState('stems'); // 'stems' | 'yt2mp3' | 'playlist' | 'style' | 'daw'
  
  // Gear Detector States
  const [styleFile, setStyleFile] = useState(null);
  const [gearArtistInput, setGearArtistInput] = useState('');
  const [styleLoading, setStyleLoading] = useState(false);
  const [styleResult, setStyleResult] = useState(null);
  const [styleError, setStyleError] = useState('');
  const [styleProgressText, setStyleProgressText] = useState('');
  const [stylePreviewUrl, setStylePreviewUrl] = useState(null);
  const [styleProjects, setStyleProjects] = useState([]);
  const [styleProjectsLoading, setStyleProjectsLoading] = useState(false);
  const [deletingStyleProjectId, setDeletingStyleProjectId] = useState(null);
  const [styleHomeMode, setStyleHomeMode] = useState('convert'); // 'convert' | 'history'
  const [editingStyleProjectId, setEditingStyleProjectId] = useState(null);
  const [styleProjectNameDraft, setStyleProjectNameDraft] = useState('');

  const fetchStyleProjectsRef = useRef(null);

  const handleStyleConvert = async () => {
    if (!styleFile) {
      setStyleError('Pilih file audio terlebih dahulu.');
      return;
    }
    setStyleLoading(true);
    setStyleError('');
    setStyleResult(null);
    setStyleProgressText('Menganalisis profil gelombang suara...');

    const formData = new FormData();
    formData.append('file', styleFile);
    formData.append('artist_title', gearArtistInput);

    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API_BASE_URL}/api/detect-gear`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });
      
      if (!response.ok) {
        throw new Error('Gagal menganalisis lagu');
      }

      const data = await response.json();
      setStyleResult(data.result);
      setStyleLoading(false);
      fetchStyleProjectsRef.current?.();

    } catch (err) {
      console.error(err);
      setStyleError(err.message || 'Terjadi kesalahan saat memproses.');
      setStyleLoading(false);
    }
  };

  const [file, setFile] = useState(null);
  const [status, setStatus] = useState('idle'); // idle, selected, uploading, processing, ready, error
  const [progressText, setProgressText] = useState('');
  const [fileId, setFileId] = useState(null);
  
  // Audio state
  const [isPlaying, setIsPlaying] = useState(false);
  const [players, setPlayers] = useState({});
  const [volumes, setVolumes] = useState({});
  const [volumeDbEdit, setVolumeDbEdit] = useState({ id: null, text: '' });
  const volumeDbSkipBlurRef = useRef(false);
  const [mutes, setMutes] = useState({});
  const [pans, setPans] = useState({});
  const [pitch, setPitch] = useState(0); // -12 to 12 semitones
  const [tempo, setTempo] = useState(1); // 0.5 to 2.0 playback rate
  const [stemCurrentTime, setStemCurrentTime] = useState(0);
  const [stemDuration, setStemDuration] = useState(0);
  const [stemTrackName, setStemTrackName] = useState('');
  const [stemOriginalName, setStemOriginalName] = useState(null);
  const stemVideoRef = useRef(null);
  const [stemLyrics, setStemLyrics] = useState(null);
  const [stemLyricsLoading, setStemLyricsLoading] = useState(false);
  const [stemLyricsStatus, setStemLyricsStatus] = useState('');
  const [stemLyricsNotFound, setStemLyricsNotFound] = useState(false);
  const [stemActiveLyricIndex, setStemActiveLyricIndex] = useState(-1);
  const [stemLyricProgress, setStemLyricProgress] = useState(0);
  const [stemLyricWordIndex, setStemLyricWordIndex] = useState(-1);
  const [stemLyricsOffsetMs, setStemLyricsOffsetMs] = useState(0);
  const [stemLyricsSpeedPct, setStemLyricsSpeedPct] = useState(100);
  const [stemLyricsManualOpen, setStemLyricsManualOpen] = useState(false);
  const [stemLyricsSearchArtist, setStemLyricsSearchArtist] = useState('');
  const [stemLyricsSearchTitle, setStemLyricsSearchTitle] = useState('');
  const [stemLyricsSearchResults, setStemLyricsSearchResults] = useState([]);
  const [stemLyricsSearchLoading, setStemLyricsSearchLoading] = useState(false);
  const [stemLyricsSearchDone, setStemLyricsSearchDone] = useState(false);
  const [stemLyricsSelectLoading, setStemLyricsSelectLoading] = useState(null);
  const stemActiveLyricRef = useRef(null);
  const stemLyricSyncRef = useRef({ activeIndex: -1, progress: 0, activeWordIndex: -1 });

  // Audio Enhancer / Mastering state
  const [eqLow, setEqLow] = useState(0);   // -12 to 12 dB
  const [eqMid, setEqMid] = useState(0);   // -12 to 12 dB
  const [eqHigh, setEqHigh] = useState(0);  // -12 to 12 dB
  const [eqBands, setEqBands] = useState(flatEqBands); // 10-band graphic EQ (-12..12 dB)
  const [compressorEnabled, setCompressorEnabled] = useState(false);
  const [vocalLevelerEnabled, setVocalLevelerEnabled] = useState(false);
  const [vocalLevelerTarget, setVocalLevelerTarget] = useState(-28.0);
  const [vocalDeEsserAmount, setVocalDeEsserAmount] = useState(0);
  const [vocalGateEnabled, setVocalGateEnabled] = useState(false);
  const [limiterEnabled, setLimiterEnabled] = useState(true);
  const [normalizeEnabled, setNormalizeEnabled] = useState(false);
  const [denoiseEnabled, setDenoiseEnabled] = useState(false);
  const [reverbEnabled, setReverbEnabled] = useState(false);
  const [delayEnabled, setDelayEnabled] = useState(false);
  const [warmthEnabled, setWarmthEnabled] = useState(false);
  const [widenerEnabled, setWidenerEnabled] = useState(false);
  const [masterVolume, setMasterVolume] = useState(0); // -60 to 12 dB
  const STEM_MAKEUP_DB = 6; // compensates quieter Demucs stems when Normalize ON
  const REVERB_WET = 0.22;
  const DELAY_WET = 0.16;
  
  // Audio Trimming state
  const [trimEnabled, setTrimEnabled] = useState(false);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(null); // null = full length
  
  // Original audio and progress states
  const [originalUrl, setOriginalUrl] = useState(null);
  const [originalPlaying, setOriginalPlaying] = useState(false);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [progress, setProgress] = useState(0);
  const [eta, setEta] = useState('');
  const [isExporting, setIsExporting] = useState(false);

  // Karaoke mic recording
  const [micReady, setMicReady] = useState(false);
  const [micError, setMicError] = useState('');
  const [micVolume, setMicVolume] = useState(0); // dB
  const [micVoicePreset, setMicVoicePreset] = useState('off');
  const [micEchoEnabled, setMicEchoEnabled] = useState(false);
  const [micEchoAmount, setMicEchoAmount] = useState(35); // 0–100%
  const [micReverbAmount, setMicReverbAmount] = useState(0); // 0–100%
  const [micChorusAmount, setMicChorusAmount] = useState(0); // 0–100%
  const [micPitch, setMicPitch] = useState(0); // semitones
  const [micCrushAmount, setMicCrushAmount] = useState(0); // 0–100% robot
  const [micFilterMode, setMicFilterMode] = useState('none'); // none | radio | robot
  const [isRecordingKaraoke, setIsRecordingKaraoke] = useState(false);
  const [recordedKaraokeUrl, setRecordedKaraokeUrl] = useState(null);
  const [recordedKaraokeName, setRecordedKaraokeName] = useState('');
  const [isSavingRecording, setIsSavingRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  // Delay musik ke file rekaman agar sejajar dengan latency mic (ms)
  const [recordLatencyMs, setRecordLatencyMs] = useState(120);
  // Pitch coach: bandingkan nada mic vs stem vokal
  const [pitchCoachStatus, setPitchCoachStatus] = useState('idle'); // idle|quiet|ok|high|low
  const [pitchCoachCents, setPitchCoachCents] = useState(0);
  const [pitchCoachMicNote, setPitchCoachMicNote] = useState('--');
  const [pitchCoachVocalNote, setPitchCoachVocalNote] = useState('--');

  const [savedProjects, setSavedProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [deletingProjectId, setDeletingProjectId] = useState(null);
  const [stemHomeMode, setStemHomeMode] = useState('upload'); // 'upload' | 'projects'
  const [editingProjectNameId, setEditingProjectNameId] = useState(null);
  const [projectNameDraft, setProjectNameDraft] = useState('');
  const [editingStemProjectName, setEditingStemProjectName] = useState(false);
  const [stemProjectNameDraft, setStemProjectNameDraft] = useState('');
  const saveSettingsTimeoutRef = useRef(null);
  const skipSettingsSaveRef = useRef(false);

  const [showSearchModal, setShowSearchModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchingTab, setIsSearchingTab] = useState(false);
  const [searchResult, setSearchResult] = useState(null);
  // Auth State
  const [token, setToken] = useState('portable-mode-token');

  const fetchStyleProjects = useCallback(async () => {
    if (!token) return;
    setStyleProjectsLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/gear-projects`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setStyleProjects(data.projects || []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setStyleProjectsLoading(false);
    }
  }, [token]);
  fetchStyleProjectsRef.current = fetchStyleProjects;
  const [username, setUsername] = useState('admin');
  const [isAdmin, setIsAdmin] = useState(true);
  const [isLoginMode, setIsLoginMode] = useState(true);
  const [authForm, setAuthForm] = useState({ username: '', email: '', password: '' });
  const [authError, setAuthError] = useState('');
  const [isAuthLoading, setIsAuthLoading] = useState(false);

  // Admin Panel State
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [userList, setUserList] = useState([]);
  const [editingUser, setEditingUser] = useState(null);
  const [editForm, setEditForm] = useState({ username: '', password: '', is_admin: false });
  const [addForm, setAddForm] = useState({ username: '', password: '', is_admin: false });
  const [showAddForm, setShowAddForm] = useState(false);
  const [adminMsg, setAdminMsg] = useState('');

  // YouTube to MP3 State
  const [yt2mp3Url, setYt2mp3Url] = useState('');
  const [yt2mp3SearchResults, setYt2mp3SearchResults] = useState([]);
  const [yt2mp3IsSearching, setYt2mp3IsSearching] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [yt2mp3Status, setYt2mp3Status] = useState('idle'); // idle, preparing, downloading, done, error
  const [yt2mp3Progress, setYt2mp3Progress] = useState(0);
  const [yt2mp3JobId, setYt2mp3JobId] = useState(null);
  const [yt2mp3Error, setYt2mp3Error] = useState('');
  const [yt2mp3Title, setYt2mp3Title] = useState('');
  const [yt2mp3MediaType, setYt2mp3MediaType] = useState('mp3'); // mp3 | mp4

  // Preview/Test Play state
  const [yt2mp3PreviewIdx, setYt2mp3PreviewIdx] = useState(-1); // index of result being previewed
  const [yt2mp3PreviewLoading, setYt2mp3PreviewLoading] = useState(false);
  const [yt2mp3PreviewPlaying, setYt2mp3PreviewPlaying] = useState(false);
  const [yt2mp3PreviewTime, setYt2mp3PreviewTime] = useState(0);
  const [yt2mp3PreviewDuration, setYt2mp3PreviewDuration] = useState(0);
  const yt2mp3PreviewAudioRef = useRef(null);

  // MP3 folder playlist
  const [mp3Playlist, setMp3Playlist] = useState([]);
  const [mp3FolderName, setMp3FolderName] = useState('');
  const [mp3CurrentIndex, setMp3CurrentIndex] = useState(-1);
  const [mp3IsPlaying, setMp3IsPlaying] = useState(false);
  const [mp3CurrentTime, setMp3CurrentTime] = useState(0);
  const [mp3Duration, setMp3Duration] = useState(0);
  const [mp3ActiveLyricIndex, setMp3ActiveLyricIndex] = useState(-1);
  const [mp3LyricProgress, setMp3LyricProgress] = useState(0);
  const [mp3LyricWordIndex, setMp3LyricWordIndex] = useState(-1);
  const [mp3LyricsSyncByTrack, setMp3LyricsSyncByTrack] = useState({});
  const [mp3LyricsManualOpen, setMp3LyricsManualOpen] = useState(false);
  const [mp3LyricsSearchArtist, setMp3LyricsSearchArtist] = useState('');
  const [mp3LyricsSearchTitle, setMp3LyricsSearchTitle] = useState('');
  const [mp3LyricsSearchResults, setMp3LyricsSearchResults] = useState([]);
  const [mp3LyricsSearchLoading, setMp3LyricsSearchLoading] = useState(false);
  const [mp3LyricsSelectLoading, setMp3LyricsSelectLoading] = useState(null);
  const [mp3LyricsSearchDone, setMp3LyricsSearchDone] = useState(false);
  const [mp3Pitch, setMp3Pitch] = useState(0);
  const [mp3LyricsLoading, setMp3LyricsLoading] = useState(false);
  const [mp3LyricsStatus, setMp3LyricsStatus] = useState('');
  const [mp3KaraokeExporting, setMp3KaraokeExporting] = useState(false);
  const [mp3KaraokeSyncOpen, setMp3KaraokeSyncOpen] = useState(false);
  const [mp3KaraokeBurnTrimMs, setMp3KaraokeBurnTrimMs] = useState(0);
  const [mp3SaveFeedback, setMp3SaveFeedback] = useState(null); // { type: 'loading'|'success'|'error', message }
  const [mp3SavingLyrics, setMp3SavingLyrics] = useState(false);
  const [mp3TrackLoading, setMp3TrackLoading] = useState(false);
  const [mp3Shuffle, setMp3Shuffle] = useState(false);
  const [mp3Repeat, setMp3Repeat] = useState('all'); // 'all' | 'one' | 'off'
  const mp3AudioRef = useRef(null);
  const mp3FolderInputRef = useRef(null);
  const mp3FileInputRef = useRef(null);
  const mp3PlaylistUrlsRef = useRef([]);
  const mp3ActiveLyricRef = useRef(null);
  const mp3LyricSyncRef = useRef({ activeIndex: -1, progress: 0, activeWordIndex: -1, wordProgress: 0 });
  const mp3LyricsSyncMetaRef = useRef({ lines: null, offsetMs: 0, speedPct: 100 });
  const mp3FolderHandleRef = useRef(null);
  const mp3LoadedTrackRef = useRef(-1);
  const mp3RetriedLyricsRef = useRef(null);
  const mp3PitchPlayerRef = useRef(null);
  const mp3BufferCacheRef = useRef(new Map()); // url -> AudioBuffer
  const mp3PitchBusyRef = useRef(false);
  const mp3PitchRef = useRef(0);
  const [mp3FolderWritable, setMp3FolderWritable] = useState(false);

  useEffect(() => { mp3PitchRef.current = mp3Pitch; }, [mp3Pitch]);

  const getMp3TrackSync = useCallback((trackId) => (
    mp3LyricsSyncByTrack[trackId] || { offsetMs: 0, speedPct: 100 }
  ), [mp3LyricsSyncByTrack]);

  const setMp3TrackSync = useCallback((trackId, partial) => {
    setMp3LyricsSyncByTrack(prev => ({
      ...prev,
      [trackId]: { offsetMs: 0, speedPct: 100, ...prev[trackId], ...partial },
    }));
  }, []);

  const stopMp3PitchPlayer = useCallback(() => {
    const player = mp3PitchPlayerRef.current;
    if (!player) return;
    try { player.stop(); } catch { /* ignore */ }
    try { player.dispose(); } catch { /* ignore */ }
    mp3PitchPlayerRef.current = null;
  }, []);

  const syncMp3PitchPlayerToMedia = useCallback((shouldPlay) => {
    const media = mp3AudioRef.current;
    const player = mp3PitchPlayerRef.current;
    if (!media || !player || !player.buffer?.loaded) return;
    const dur = player.buffer.duration || 0;
    const offset = Math.max(0, Math.min(media.currentTime || 0, Math.max(0, dur - 0.05)));
    try { player.stop(); } catch { /* ignore */ }
    if (shouldPlay) {
      try {
        player.start(Tone.now() + 0.02, offset);
      } catch (e) {
        console.warn('pitch player start failed', e);
      }
    }
  }, []);

  const decodeMp3TrackBuffer = async (track) => {
    const cached = mp3BufferCacheRef.current.get(track.url);
    if (cached) return cached;
    const res = await fetch(track.url);
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    const arr = await res.arrayBuffer();
    const rawCtx = Tone.getContext().rawContext;
    const buffer = await rawCtx.decodeAudioData(arr.slice(0));
    // Batasi cache agar hemat memori
    if (mp3BufferCacheRef.current.size >= 4) {
      const oldest = mp3BufferCacheRef.current.keys().next().value;
      mp3BufferCacheRef.current.delete(oldest);
    }
    mp3BufferCacheRef.current.set(track.url, buffer);
    return buffer;
  };

  /** Pitch playlist via GrainPlayer.detune (seperti stem). Media di-mute; video tetap sync. */
  const applyMp3PlaylistPitch = async (semitones, { announce = true, track: trackOverride = null } = {}) => {
    const media = mp3AudioRef.current;
    const track = trackOverride || (mp3CurrentIndex >= 0 ? mp3Playlist[mp3CurrentIndex] : null);
    if (!media || !track) throw new Error('no track');

    await Tone.start();
    if (Tone.getContext().state !== 'running') {
      await Tone.getContext().resume();
    }

    const pitch = Number(semitones) || 0;

    if (pitch === 0) {
      stopMp3PitchPlayer();
      media.muted = false;
      try { media.playbackRate = 1; } catch { /* ignore */ }
      if (announce) setMp3LyricsStatus('');
      return;
    }

    if (announce) setMp3LyricsStatus('Menyiapkan tangga nada...');
    const buffer = await decodeMp3TrackBuffer(track);
    const wasPlaying = !media.paused;
    const offset = Math.max(0, Math.min(media.currentTime || 0, Math.max(0, buffer.duration - 0.05)));

    stopMp3PitchPlayer();

    const player = new Tone.GrainPlayer({
      url: buffer,
      loop: false,
      detune: pitch * 100,
      grainSize: grainSizeForPitch(pitch),
      overlap: GRAIN_OVERLAP,
    }).toDestination();

    if (!player.buffer.loaded) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 15000);
        const done = () => { clearTimeout(t); resolve(); };
        player.buffer.onload = done;
        if (player.buffer.loaded) done();
      });
    }
    if (!player.buffer.loaded) {
      try { player.dispose(); } catch { /* ignore */ }
      throw new Error('buffer not loaded');
    }

    mp3PitchPlayerRef.current = player;
    media.muted = true;
    try { media.playbackRate = 1; } catch { /* ignore */ }

    if (wasPlaying) {
      try { player.start(Tone.now() + 0.03, offset); } catch (e) { console.warn(e); }
      try {
        if (media.paused) await media.play();
      } catch { /* ignore */ }
    }

    if (announce) {
      setMp3LyricsStatus(`Tangga nada: ${pitch > 0 ? '+' : ''}${pitch} semitone`);
    }
  };

  const changeMp3Pitch = async (delta) => {
    if (mp3CurrentIndex < 0) {
      setMp3LyricsStatus('Putar lagu dulu sebelum mengubah tangga nada.');
      return;
    }
    if (mp3PitchBusyRef.current) return;
    const prev = mp3Pitch;
    const next = Math.max(-12, Math.min(12, mp3Pitch + delta));
    if (next === prev) return;

    mp3PitchBusyRef.current = true;
    setMp3Pitch(next);
    try {
      const existing = mp3PitchPlayerRef.current;
      if (existing && next !== 0 && existing.buffer?.loaded) {
        existing.detune = next * 100;
        existing.grainSize = grainSizeForPitch(next);
        setMp3LyricsStatus(`Tangga nada: ${next > 0 ? '+' : ''}${next} semitone`);
      } else {
        await applyMp3PlaylistPitch(next);
      }
    } catch (e) {
      console.error(e);
      setMp3Pitch(prev);
      setMp3LyricsStatus('Gagal mengubah nada. Coba lagi saat lagu diputar.');
      try { await applyMp3PlaylistPitch(prev, { announce: false }); } catch { /* ignore */ }
    } finally {
      mp3PitchBusyRef.current = false;
    }
  };

  const resetMp3Pitch = async () => {
    if (mp3Pitch === 0 || mp3PitchBusyRef.current) return;
    mp3PitchBusyRef.current = true;
    const prev = mp3Pitch;
    setMp3Pitch(0);
    try {
      await applyMp3PlaylistPitch(0);
    } catch (e) {
      console.error(e);
      setMp3Pitch(prev);
    } finally {
      mp3PitchBusyRef.current = false;
    }
  };

  const [ytUrl, setYtUrl] = useState('');
  const [ytVideoId, setYtVideoId] = useState(null); // internal ID from backend
  const [ytYoutubeId, setYtYoutubeId] = useState(null); // actual YouTube video ID
  const [ytStatus, setYtStatus] = useState('idle'); // idle, preparing, downloading, separating, ready, error
  const [ytTitle, setYtTitle] = useState('');
  const [ytThumbnail, setYtThumbnail] = useState('');
  const [ytDuration, setYtDuration] = useState(0);
  const [ytProgress, setYtProgress] = useState(0);
  const [ytPitch, setYtPitch] = useState(0); // -12 to 12 semitones
  const [ytIsPlaying, setYtIsPlaying] = useState(false);
  const [ytCurrentTime, setYtCurrentTime] = useState(0);
  const [ytAudioDuration, setYtAudioDuration] = useState(0);
  const [ytMode, setYtMode] = useState('quick'); // 'quick' or 'full'
  const [ytKaraokeReady, setYtKaraokeReady] = useState(false);
  const [ytUseKaraoke, setYtUseKaraoke] = useState(false);
  const [ytError, setYtError] = useState('');

  // License State
  const [licenseStatus, setLicenseStatus] = useState('checking'); // 'checking', 'valid', 'invalid'
  const [licenseInfo, setLicenseInfo] = useState(null);
  const [hardwareId, setHardwareId] = useState('');
  const [licenseMessage, setLicenseMessage] = useState('');
  const [licenseMessageType, setLicenseMessageType] = useState(''); // 'success', 'error', 'warning'
  const [isActivating, setIsActivating] = useState(false);
  const [hwidCopied, setHwidCopied] = useState(false);
  const [showLicenseDetails, setShowLicenseDetails] = useState(false);
  // YouTube Audio refs
  const ytAudioRef = useRef(null);
  const ytAudioContextRef = useRef(null);
  const ytSourceNodeRef = useRef(null);
  const ytPitchShifterRef = useRef(null);
  const ytPlayerRef = useRef(null); // YouTube iframe API player
  const ytIframeRef = useRef(null);

  const playersRef = useRef({});
  const volumeNodesRef = useRef({});
  const preFxNodesRef = useRef({});
  const pannerNodesRef = useRef({});
  const masterEqRef = useRef(null);
  const masterEqBandsRef = useRef([]);
  const masterDenoiseHpRef = useRef(null);
  const masterDenoiseLpRef = useRef(null);
  const masterCompressorRef = useRef(null);
  const vocalGateRef = useRef(null);
  const vocalLevelerRef = useRef(null);
  const vocalDeEsserRef = useRef(null);
  const masterPitchShiftRef = useRef(null);
  const masterDelayRef = useRef(null);
  const masterReverbRef = useRef(null);
  const vocalReverbSendRef = useRef(null);
  const vocalDelaySendRef = useRef(null);
  const masterWarmthRef = useRef(null);
  const masterWidenerRef = useRef(null);
  const masterMakeupRef = useRef(null);
  const masterLimiterRef = useRef(null);
  const masterOutRef = useRef(null);
  const recordDestRef = useRef(null);
  const recordCompDelayRef = useRef(null);
  const micRef = useRef(null);
  const micVolRef = useRef(null);
  const micEchoRef = useRef(null);
  const micFxRef = useRef(null); // pitch, filters, crush, chorus, reverb
  const micPitchAnalyserRef = useRef(null);
  const vocalPitchAnalyserRef = useRef(null);
  const pitchCoachRafRef = useRef(null);
  const pitchCoachSmoothRef = useRef(0);
  const pitchCoachActiveRef = useRef(false);
  const mediaRecorderRef = useRef(null);
  const recordChunksRef = useRef([]);
  const recordingTimerRef = useRef(null);
  const recordedBlobRef = useRef(null);
  const ytAnimFrameRef = useRef(null);
  const originalAudioRef = useRef(null);

  const clearMp3Playlist = useCallback(() => {
    stopMp3PitchPlayer();
    mp3BufferCacheRef.current.clear();
    mp3PlaylistUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
    mp3PlaylistUrlsRef.current = [];
    if (mp3AudioRef.current) {
      mp3AudioRef.current.pause();
      mp3AudioRef.current.muted = false;
      mp3AudioRef.current.removeAttribute('src');
      mp3AudioRef.current.load();
    }
    setMp3Playlist([]);
    setMp3FolderName('');
    setMp3CurrentIndex(-1);
    setMp3IsPlaying(false);
    setMp3CurrentTime(0);
    setMp3Duration(0);
    setMp3ActiveLyricIndex(-1);
    setMp3LyricsStatus('');
    setMp3SaveFeedback(null);
    setMp3SavingLyrics(false);
    setMp3Pitch(0);
    mp3FolderHandleRef.current = null;
    setMp3FolderWritable(false);
    mp3LoadedTrackRef.current = -1;
    setMp3TrackLoading(false);
  }, [stopMp3PitchPlayer]);

  const applyLyricsToTrack = (index, data) => {
    const parsed = data.format === 'lrc' ? parseLrc(data.content) : null;
    const lyrics = parsed
      ? {
        type: 'lrc',
        lines: parsed.lines,
        offset: parsed.offset,
        source: data.from_cache ? 'cache' : 'online',
        raw: data.content,
      }
      : {
        type: 'plain',
        text: data.content,
        source: data.from_cache ? 'cache' : 'online',
        raw: data.content,
      };
    const searched = data.search_artist && data.search_title
      ? `${data.search_artist} — ${data.search_title}`
      : (data.search_title || '');
    const savedNote = data.from_cache ? 'Lirik dimuat dari cache lokal.' : 'Lirik dipilih dan disimpan.';
    setMp3LyricsStatus(searched ? `${searched}. ${savedNote}` : savedNote);
    setMp3Playlist(prev => {
      const track = prev[index];
      if (mp3FolderHandleRef.current && data.content && track) {
        saveLyricsToMp3Folder(track, data.content, data.format || 'lrc', { showFeedback: true, autoSave: true });
      }
      return prev.map((t, i) => (
        i === index ? { ...t, lyrics, lyricsLoading: false, lyricsNotFound: false } : t
      ));
    });
  };

  const lyricsFileNameForTrack = (track, fmt = 'lrc') => {
    const base = (track.fileName || track.name).replace(/\.mp3$/i, '');
    return fmt === 'plain' ? `${base}.txt` : `${base}.lrc`;
  };

  const setMp3SaveFeedbackState = (type, message, extra = {}) => {
    setMp3SaveFeedback({ type, message, ...extra });
    if (type === 'loading') {
      setMp3SavingLyrics(true);
    } else {
      setMp3SavingLyrics(false);
    }
  };

  const revealFileInExplorer = async (filePath) => {
    if (!filePath) return;
    try {
      const res = await fetch(`${API_BASE_URL}/reveal-in-explorer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ path: filePath }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || 'Gagal membuka folder');
      }
    } catch (e) {
      console.error(e);
      setMp3SaveFeedbackState('error', e.message || 'Gagal membuka folder file');
    }
  };

  const saveLyricsToMp3Folder = async (track, content, fmt, { showFeedback = true, autoSave = false } = {}) => {
    const handle = mp3FolderHandleRef.current;
    if (!handle || !track || !content) {
      if (showFeedback) {
        setMp3SaveFeedbackState('error', 'Tidak ada konten lirik untuk disimpan.');
      }
      return false;
    }

    const fileName = lyricsFileNameForTrack(track, fmt);
    if (showFeedback) {
      setMp3SaveFeedbackState('loading', autoSave ? `Menyimpan otomatis: ${fileName}...` : `Menyimpan lirik ke folder MP3...`);
    }

    try {
      const fileHandle = await handle.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
      if (showFeedback) {
        setMp3SaveFeedbackState(
          'success',
          autoSave ? `Lirik otomatis tersimpan: ${fileName}` : `Lirik berhasil disimpan: ${fileName}`
        );
      }
      return true;
    } catch (e) {
      console.error(e);
      const msg = e?.name === 'NotAllowedError'
        ? 'Gagal simpan: izin tulis ditolak. Pilih folder lagi dengan Chrome/Edge.'
        : 'Gagal menyimpan lirik ke folder MP3. Coba pilih folder lagi.';
      if (showFeedback) {
        setMp3SaveFeedbackState('error', msg);
      }
      return false;
    }
  };

  const saveOrDownloadLyrics = async (index) => {
    const track = mp3Playlist[index];
    if (!track?.lyrics) return;

    setMp3SaveFeedback(null);
    setMp3SavingLyrics(true);

    let content = track.lyrics.raw;
    let fmt = track.lyrics.type === 'plain' ? 'plain' : 'lrc';

    if (!content) {
      try {
        const res = await fetch(
          `${API_BASE_URL}/lyrics/download?track_name=${encodeURIComponent(track.name)}`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        if (res.ok) {
          content = await res.text();
        }
      } catch (e) {
        console.error(e);
      }
    }

    if (!content && track.lyrics.type === 'plain') {
      content = track.lyrics.text;
    }

    if (!content) {
      setMp3SaveFeedbackState('error', 'Gagal simpan: konten lirik tidak tersedia.');
      return;
    }

    if (mp3FolderHandleRef.current) {
      await saveLyricsToMp3Folder(track, content, fmt, { showFeedback: true });
      return;
    }

    try {
      const fileName = lyricsFileNameForTrack(track, fmt);
      const blob = new Blob([content], { type: fmt === 'lrc' ? 'application/lrc' : 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      setMp3SaveFeedbackState('success', `File lirik diunduh: ${fileName}`);
    } catch (e) {
      console.error(e);
      setMp3SaveFeedbackState('error', 'Gagal mengunduh file lirik.');
    }
  };

  const openKaraokeVideoSync = (index) => {
    const track = mp3Playlist[index];
    if (!track) return;
    if (!isVideoFile(track.fileName || track.name)) {
      setMp3SaveFeedbackState('error', 'Video karaoke hanya untuk file MP4/video.');
      return;
    }
    if (track.lyrics?.type !== 'lrc' || !track.lyrics?.lines?.length) {
      setMp3SaveFeedbackState('error', 'Butuh lirik ber-timestamp (.lrc) untuk membuat video karaoke.');
      return;
    }
    setMp3KaraokeBurnTrimMs(0);
    setMp3KaraokeSyncOpen(true);
  };

  const exportKaraokeVideo = async (index) => {
    const track = mp3Playlist[index];
    if (!track) return;

    if (!isVideoFile(track.fileName || track.name)) {
      setMp3SaveFeedbackState('error', 'Video karaoke hanya untuk file MP4/video.');
      return;
    }
    if (track.lyrics?.type !== 'lrc' || !track.lyrics?.lines?.length) {
      setMp3SaveFeedbackState('error', 'Butuh lirik ber-timestamp (.lrc) untuk membuat video karaoke.');
      return;
    }

    // Selalu ambil sync terbaru dari panel + koreksi khusus burn-in
    const sync = getMp3TrackSync(track.id);
    const effectiveOffset = (sync.offsetMs || 0) - (track.lyrics.offset || 0) + (mp3KaraokeBurnTrimMs || 0);
    // Speed ≠ 100% sering bikin lirik "ngacol" di video — pakai 100 kecuali user sengaja set
    const speedPct = sync.speedPct || 100;
    const cues = buildKaraokeVideoCues(track.lyrics.lines, effectiveOffset, speedPct);
    if (!cues.length) {
      setMp3SaveFeedbackState('error', 'Tidak ada baris lirik yang bisa di-bakar ke video.');
      return;
    }

    setMp3KaraokeSyncOpen(false);
    setMp3KaraokeExporting(true);
    setMp3SaveFeedbackState('loading', 'Membuat video karaoke... (lalu pilih nama & folder)');

    try {
      const videoBlob = await fetch(track.url).then((r) => {
        if (!r.ok) throw new Error('Gagal membaca file video');
        return r.blob();
      });

      const form = new FormData();
      form.append('video', videoBlob, track.fileName || `${track.name}.mp4`);
      form.append('cues_json', JSON.stringify(cues));
      // Pitch di video karaoke dimatikan — rubberband bisa bikin audio/lirik drift
      form.append('pitch', '0');
      form.append('display_name', track.name || 'karaoke');

      const res = await fetch(`${API_BASE_URL}/playlist/karaoke-video`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = await res.json().catch(() => ({}));

      if (data.cancelled || data.status === 'cancelled') {
        setMp3SaveFeedback(null);
        setMp3SavingLyrics(false);
        return;
      }
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.message || data.detail || 'Gagal membuat video karaoke');
      }

      const outName = data.filename || `${track.name} karaoke.mp4`;
      const warn = data.warning ? ` (${data.warning})` : '';
      const revealPath = data.saved_path || '';
      setMp3SaveFeedbackState(
        'success',
        `Video karaoke tersimpan: ${outName}${warn} — klik untuk buka folder & highlight file`,
        { revealPath }
      );

      if (revealPath) {
        void revealFileInExplorer(revealPath);
      }
    } catch (e) {
      console.error(e);
      setMp3SaveFeedbackState('error', e.message || 'Gagal membuat video karaoke');
    } finally {
      setMp3KaraokeExporting(false);
    }
  };

  const removeMp3Track = (index, e) => {
    e.stopPropagation();
    const track = mp3Playlist[index];
    if (!track) return;

    mp3BufferCacheRef.current.delete(track.url);
    URL.revokeObjectURL(track.url);
    mp3PlaylistUrlsRef.current = mp3PlaylistUrlsRef.current.filter(u => u !== track.url);

    const nextPlaylist = mp3Playlist.filter((_, i) => i !== index);
    if (nextPlaylist.length === 0) {
      stopMp3PitchPlayer();
      if (mp3AudioRef.current) {
        mp3AudioRef.current.pause();
        mp3AudioRef.current.muted = false;
        mp3AudioRef.current.removeAttribute('src');
        mp3AudioRef.current.load();
      }
      setMp3Playlist([]);
      setMp3CurrentIndex(-1);
      setMp3IsPlaying(false);
      setMp3CurrentTime(0);
      setMp3Duration(0);
      setMp3ActiveLyricIndex(-1);
      setMp3LyricsStatus('');
      setMp3SaveFeedback(null);
      setMp3SavingLyrics(false);
      setMp3Pitch(0);
      mp3LoadedTrackRef.current = -1;
      setMp3TrackLoading(false);
      return;
    }

    let nextIndex = mp3CurrentIndex;
    if (index === mp3CurrentIndex) {
      stopMp3PitchPlayer();
      if (mp3AudioRef.current) {
        mp3AudioRef.current.pause();
        mp3AudioRef.current.muted = false;
        mp3AudioRef.current.removeAttribute('src');
        mp3AudioRef.current.load();
      }
      setMp3IsPlaying(false);
      setMp3CurrentTime(0);
      setMp3Duration(0);
      setMp3ActiveLyricIndex(-1);
      nextIndex = -1;
    } else if (index < mp3CurrentIndex) {
      nextIndex = mp3CurrentIndex - 1;
    }

    setMp3Playlist(nextPlaylist);
    setMp3CurrentIndex(nextIndex);
  };

  const fetchLyricsForTrack = async (index, duration, { refresh = false } = {}) => {
    const track = mp3Playlist[index];
    if (!track || track.lyricsLoading) return;
    if (track.lyrics && !refresh) return;

    if (refresh) {
      setMp3Playlist(prev => prev.map((t, i) => (
        i === index ? { ...t, lyrics: null, lyricsNotFound: false } : t
      )));
    }

    setMp3Playlist(prev => prev.map((t, i) => (
      i === index ? { ...t, lyricsLoading: true, lyricsNotFound: false } : t
    )));
    setMp3LyricsLoading(true);
    setMp3LyricsStatus(refresh ? 'Mencari ulang lirik ber-timestamp...' : 'Mencari lirik dari internet...');

    try {
      const res = await fetch(`${API_BASE_URL}/lyrics/fetch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          track_name: track.name,
          duration: duration > 0 ? Math.round(duration) : undefined,
          refresh,
        }),
      });
      const data = await res.json();
      if (res.ok && data.found && data.content) {
        applyLyricsToTrack(index, data);
      } else {
        setMp3Playlist(prev => prev.map((t, i) => (
          i === index ? { ...t, lyricsLoading: false, lyricsNotFound: true } : t
        )));
        const searched = data.search_artist && data.search_title
          ? `${data.search_artist} — ${data.search_title}`
          : track.name;
        setMp3LyricsStatus(searched ? `Tidak ditemukan untuk: ${searched}` : '');
      }
    } catch (e) {
      console.error(e);
      setMp3Playlist(prev => prev.map((t, i) => (
        i === index ? { ...t, lyricsLoading: false } : t
      )));
      setMp3LyricsStatus('');
    } finally {
      setMp3LyricsLoading(false);
    }
  };

  const openManualLyricsSearch = () => {
    const track = mp3CurrentIndex >= 0 ? mp3Playlist[mp3CurrentIndex] : null;
    if (track) {
      const { artist, title } = parseTrackName(track.name);
      setMp3LyricsSearchArtist(artist);
      setMp3LyricsSearchTitle(title);
    }
    setMp3LyricsSearchResults([]);
    setMp3LyricsSearchDone(false);
    setMp3LyricsManualOpen(true);
  };

  const searchManualLyrics = async () => {
    if (!mp3LyricsSearchTitle.trim() && !mp3LyricsSearchArtist.trim()) return;
    setMp3LyricsSearchLoading(true);
    setMp3LyricsSearchResults([]);
    setMp3LyricsSearchDone(false);
    try {
      const res = await fetch(`${API_BASE_URL}/lyrics/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          artist: mp3LyricsSearchArtist.trim(),
          title: mp3LyricsSearchTitle.trim(),
          duration: mp3Duration > 0 ? Math.round(mp3Duration) : undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setMp3LyricsSearchResults(data.results || []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setMp3LyricsSearchLoading(false);
      setMp3LyricsSearchDone(true);
    }
  };

  const selectManualLyric = async (lrclibId) => {
    const track = mp3CurrentIndex >= 0 ? mp3Playlist[mp3CurrentIndex] : null;
    if (!track) return;
    setMp3LyricsSelectLoading(lrclibId);
    try {
      const res = await fetch(`${API_BASE_URL}/lyrics/select`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          track_name: track.name,
          lrclib_id: lrclibId,
        }),
      });
      const data = await res.json();
      if (res.ok && data.found && data.content) {
        applyLyricsToTrack(mp3CurrentIndex, { ...data, from_cache: false });
        setMp3TrackSync(track.id, { offsetMs: 0, speedPct: 100 });
        setMp3LyricsManualOpen(false);
      } else {
        setMp3LyricsStatus('Gagal memuat lirik yang dipilih.');
      }
    } catch (e) {
      console.error(e);
      setMp3LyricsStatus('Gagal memuat lirik yang dipilih.');
    } finally {
      setMp3LyricsSelectLoading(null);
    }
  };

  const loadPlaylistFromFiles = async (allFiles, folderName, dirHandle = null) => {
    const mp3Files = allFiles
      .filter(f => f.name.match(/\.(mp3|mp4|m4a|wav)$/i))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    stopMp3PitchPlayer();
    mp3BufferCacheRef.current.clear();
    setMp3Pitch(0);
    mp3PlaylistUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
    mp3PlaylistUrlsRef.current = [];
    if (mp3AudioRef.current) {
      mp3AudioRef.current.pause();
      mp3AudioRef.current.muted = false;
      mp3AudioRef.current.removeAttribute('src');
      mp3AudioRef.current.load();
    }

    if (mp3Files.length === 0) {
      alert('Tidak ada file Media (MP3/MP4/M4A/WAV) di folder yang dipilih.');
      return;
    }

    mp3FolderHandleRef.current = dirHandle;
    setMp3FolderWritable(!!dirHandle);

    const lrcMap = new Map();
    const txtMap = new Map();
    allFiles.forEach(f => {
      const base = f.name.replace(/\.(lrc|txt)$/i, '').toLowerCase();
      if (f.name.toLowerCase().endsWith('.lrc')) lrcMap.set(base, f);
      if (f.name.toLowerCase().endsWith('.txt')) txtMap.set(base, f);
    });

    const tracks = await Promise.all(mp3Files.map(async (file, i) => {
      const url = URL.createObjectURL(file);
      mp3PlaylistUrlsRef.current.push(url);
      const baseName = file.name.replace(/\.(mp3|mp4|m4a|wav)$/i, '');
      const baseKey = baseName.toLowerCase();
      let lyrics = null;

      const lrcFile = lrcMap.get(baseKey);
      const txtFile = txtMap.get(baseKey);
      if (lrcFile) {
        try {
          const raw = await lrcFile.text();
          const parsed = parseLrc(raw);
          if (parsed.lines.length) {
            lyrics = { type: 'lrc', lines: parsed.lines, offset: parsed.offset, raw };
          }
        } catch { /* skip */ }
      } else if (txtFile) {
        try {
          const raw = (await txtFile.text()).trim();
          if (raw) lyrics = { type: 'plain', text: raw, raw };
        } catch { /* skip */ }
      }

      return { id: `${baseName}-${i}`, name: baseName, fileName: file.name, url, lyrics };
    }));

    setMp3FolderName(folderName);
    setMp3Playlist(tracks);
    setMp3CurrentIndex(-1);
    setMp3ActiveLyricIndex(-1);
    setMp3IsPlaying(false);
    setMp3CurrentTime(0);
    setMp3Duration(0);
    setMp3LyricsStatus('');
    setMp3SaveFeedback(null);
    setMp3SavingLyrics(false);
    mp3LoadedTrackRef.current = -1;
    setMp3TrackLoading(false);
  };

  const SKIP_DIR_NAMES = new Set([
    'node_modules', '.git', '.svn', '__pycache__', '$recycle.bin',
    'system volume information', 'windows', 'appdata', 'application data',
  ]);

  const collectFilesFromDirectory = async (dirHandle, depth = 0) => {
    const files = [];
    // Batasi kedalaman agar scan Downloads besar tidak hang
    const maxDepth = 4;
    try {
      for await (const entry of dirHandle.values()) {
        try {
          if (entry.kind === 'file') {
            files.push(await entry.getFile());
          } else if (entry.kind === 'directory' && depth < maxDepth) {
            const name = (entry.name || '').toLowerCase();
            if (name.startsWith('.') || SKIP_DIR_NAMES.has(name)) continue;
            files.push(...await collectFilesFromDirectory(entry, depth + 1));
          }
        } catch (entryErr) {
          // File cloud/placeholder atau izin terbatas — lanjut entri lain
          console.warn('Skip entry:', entry?.name, entryErr);
        }
      }
    } catch (e) {
      console.warn('Scan folder gagal sebagian:', dirHandle?.name, e);
    }
    return files;
  };

  const ensureFolderWritable = async (dirHandle) => {
    if (!dirHandle) return false;
    try {
      const opts = { mode: 'readwrite' };
      if ((await dirHandle.queryPermission(opts)) === 'granted') return true;
      if ((await dirHandle.requestPermission(opts)) === 'granted') return true;
    } catch (e) {
      console.warn('Folder tidak bisa ditulis (lirik hanya bisa diunduh):', e);
    }
    return false;
  };

  const pickMp3Folder = async () => {
    if ('showDirectoryPicker' in window) {
      try {
        // mode 'read' dulu — Downloads sering ditolak jika langsung readwrite
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        setMp3LyricsStatus('Memindai folder media...');
        const allFiles = await collectFilesFromDirectory(handle);
        const mediaCount = allFiles.filter((f) => f.name.match(/\.(mp3|mp4|m4a|wav)$/i)).length;
        if (mediaCount === 0) {
          setMp3LyricsStatus('');
          alert(
            'Tidak ada file Media (MP3/MP4/M4A/WAV) di folder ini (termasuk subfolder).\n\n' +
            'Tips: pastikan file ada di folder yang dipilih, bukan hanya di shortcut/cloud yang belum diunduh.'
          );
          return;
        }
        const writable = await ensureFolderWritable(handle);
        await loadPlaylistFromFiles(allFiles, handle.name, handle);
        setMp3FolderWritable(writable);
        if (!writable) {
          setMp3LyricsStatus('Playlist siap. Folder ini tidak bisa ditulis — lirik bisa diunduh manual.');
        } else {
          setMp3LyricsStatus('');
        }
      } catch (e) {
        if (e.name === 'AbortError') return;
        console.error(e);
        alert('Gagal membaca folder: ' + (e.message || e.name || 'unknown') +
          '\n\nCoba pilih folder lagi, atau pilih subfolder yang berisi file media.');
      }
      return;
    }
    mp3FolderInputRef.current?.click();
  };

  const handleMp3FolderSelect = async (e) => {
    const allFiles = Array.from(e.target.files || []);
    const folderName = allFiles[0]?.webkitRelativePath?.split('/')[0] || 'Folder MP3';
    mp3FolderHandleRef.current = null;
    setMp3FolderWritable(false);
    await loadPlaylistFromFiles(allFiles, folderName, null);
    e.target.value = '';
  };

  const pickMp3Files = async () => {
    if ('showOpenFilePicker' in window) {
      try {
        const handles = await window.showOpenFilePicker({
          multiple: true,
          types: [
            {
              description: 'File Media Audio & Video',
              accept: {
                'audio/*': ['.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.webm'],
                'video/*': ['.mp4', '.webm']
              }
            }
          ]
        });
        if (!handles || handles.length === 0) return;
        const files = await Promise.all(handles.map((h) => h.getFile()));
        const label = files.length === 1 ? files[0].name : `${files.length} File Media`;
        mp3FolderHandleRef.current = null;
        setMp3FolderWritable(false);
        await loadPlaylistFromFiles(files, label, null);
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
        console.error('showOpenFilePicker error:', e);
      }
    }
    mp3FileInputRef.current?.click();
  };

  const handleMp3FileSelect = async (e) => {
    const allFiles = Array.from(e.target.files || []);
    if (allFiles.length === 0) return;
    const label = allFiles.length === 1 ? allFiles[0].name : `${allFiles.length} File Media`;
    mp3FolderHandleRef.current = null;
    setMp3FolderWritable(false);
    await loadPlaylistFromFiles(allFiles, label, null);
    e.target.value = '';
  };

  useEffect(() => {
    mp3ActiveLyricRef.current?.scrollIntoView({ behavior: 'auto', block: 'center' });
  }, [mp3ActiveLyricIndex, mp3CurrentIndex]);

  useEffect(() => {
    return () => clearMp3Playlist();
  }, [clearMp3Playlist]);

  useEffect(() => {
    const track = mp3CurrentIndex >= 0 ? mp3Playlist[mp3CurrentIndex] : null;
    if (track?.lyrics?.type === 'lrc') {
      const sync = getMp3TrackSync(track.id);
      mp3LyricsSyncMetaRef.current = {
        lines: track.lyrics.lines,
        offsetMs: sync.offsetMs - (track.lyrics.offset || 0),
        speedPct: sync.speedPct,
      };
    } else {
      mp3LyricsSyncMetaRef.current = { lines: null, offsetMs: 0, speedPct: 100 };
    }
  }, [mp3CurrentIndex, mp3Playlist, mp3LyricsSyncByTrack, getMp3TrackSync]);

  const syncMp3LyricsToTime = useCallback((time) => {
    const { lines, offsetMs, speedPct } = mp3LyricsSyncMetaRef.current;
    if (!lines?.length) return;

    const { activeIndex, progress, activeWordIndex, wordProgress } = getLyricSyncState(
      lines, time, offsetMs, speedPct
    );
    const prev = mp3LyricSyncRef.current;

    // Hysteresis: jangan mundur 1 baris karena jitter waktu (kecuali seek jelas)
    let stableIndex = activeIndex;
    const lastT = mp3LyricSyncRef.current._lastTime;
    const seekingBack = typeof lastT === 'number' && time < lastT - 0.35;
    if (
      !seekingBack
      && prev.activeIndex >= 0
      && activeIndex >= 0
      && activeIndex === prev.activeIndex - 1
    ) {
      stableIndex = prev.activeIndex;
    }
    mp3LyricSyncRef.current._lastTime = time;

    if (prev.activeIndex !== stableIndex) {
      mp3LyricSyncRef.current = {
        ...mp3LyricSyncRef.current,
        activeIndex: stableIndex,
        progress: stableIndex === activeIndex ? progress : prev.progress,
        activeWordIndex: stableIndex === activeIndex ? activeWordIndex : -1,
        wordProgress,
      };
      setMp3ActiveLyricIndex(stableIndex);
      setMp3LyricProgress(stableIndex === activeIndex ? progress : 0);
      setMp3LyricWordIndex(stableIndex === activeIndex ? activeWordIndex : -1);
    } else {
      let changed = false;
      if (Math.abs(prev.progress - progress) >= 0.02) {
        changed = true;
        setMp3LyricProgress(progress);
      }
      if (prev.activeWordIndex !== activeWordIndex) {
        changed = true;
        setMp3LyricWordIndex(activeWordIndex);
      }
      if (changed) {
        mp3LyricSyncRef.current = {
          ...mp3LyricSyncRef.current,
          activeIndex: stableIndex,
          progress,
          activeWordIndex,
          wordProgress,
        };
      }
    }
  }, []);

  const syncLyricLineToNow = useCallback((lineIndex) => {
    const track = mp3CurrentIndex >= 0 ? mp3Playlist[mp3CurrentIndex] : null;
    const line = track?.lyrics?.lines?.[lineIndex];
    if (!track || !line) return;

    const t = mp3AudioRef.current?.currentTime ?? mp3CurrentTime;
    const sync = getMp3TrackSync(track.id);
    const speed = sync.speedPct / 100;
    // Samakan dengan rumus preview: effective = slider - lyrics.offset
    const effectiveMs = Math.round((line.time / speed - t) * 1000);
    const storeMs = effectiveMs + (track.lyrics.offset || 0);

    setMp3TrackSync(track.id, { offsetMs: storeMs });
    mp3LyricsSyncMetaRef.current = {
      lines: track.lyrics.lines,
      offsetMs: effectiveMs,
      speedPct: sync.speedPct,
    };
    syncMp3LyricsToTime(t);
  }, [mp3CurrentIndex, mp3Playlist, mp3CurrentTime, getMp3TrackSync, setMp3TrackSync, syncMp3LyricsToTime]);

  useEffect(() => {
    if (!mp3IsPlaying) return undefined;

    let rafId = 0;
    const tick = () => {
      const audio = mp3AudioRef.current;
      if (audio && !audio.paused) {
        const t = audio.currentTime;
        setMp3CurrentTime(t);
        syncMp3LyricsToTime(t);
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [mp3IsPlaying, syncMp3LyricsToTime]);

  const handleMp3TimeUpdate = () => {
    const t = mp3AudioRef.current?.currentTime || 0;
    if (!mp3IsPlaying) {
      setMp3CurrentTime(t);
      syncMp3LyricsToTime(t);
    }
  };

  const scheduleLyricsFetch = (index, duration) => {
    const track = mp3Playlist[index];
    if (track && !track.lyrics && !track.lyricsLoading) {
      window.setTimeout(() => fetchLyricsForTrack(index, duration), 300);
    }
  };

  const playMp3Track = (index, autoPlay = true) => {
    if (index < 0 || index >= mp3Playlist.length || !mp3AudioRef.current) return;
    const track = mp3Playlist[index];
    const audio = mp3AudioRef.current;

    // Ganti lagu: hentikan GrainPlayer pitch, unmute media dulu
    stopMp3PitchPlayer();
    audio.muted = false;

    setMp3CurrentIndex(index);
    setMp3ActiveLyricIndex(-1);
    setMp3LyricProgress(0);
    setMp3LyricWordIndex(-1);
    mp3LyricSyncRef.current = { activeIndex: -1, progress: 0, activeWordIndex: -1, wordProgress: 0 };
    setMp3LyricsStatus('');
    setMp3SaveFeedback(null);
    setMp3SavingLyrics(false);
    mp3RetriedLyricsRef.current = null;

    const reapplyPitchIfNeeded = async () => {
      const pitch = mp3PitchRef.current;
      if (!pitch) return;
      try {
        await applyMp3PlaylistPitch(pitch, { announce: true, track });
      } catch (e) {
        console.warn('reapply pitch failed', e);
      }
    };

    const onPlaySuccess = () => {
      setMp3IsPlaying(true);
      setMp3TrackLoading(false);
      scheduleLyricsFetch(index, audio.duration || 0);
      void reapplyPitchIfNeeded();
    };

    const onPlayFail = (err) => {
      console.error('MP3 play error:', err);
      // AbortError means a new load() interrupted play — not a real failure
      if (err?.name === 'AbortError') return;

      // NotAllowedError = browser autoplay policy — show status hint
      if (err?.name === 'NotAllowedError') {
        setMp3LyricsStatus('Klik tombol play untuk memutar lagu ini.');
        setMp3IsPlaying(false);
        setMp3TrackLoading(false);
        return;
      }

      setMp3IsPlaying(false);
      setMp3TrackLoading(false);
      setMp3LyricsStatus(`Gagal memutar lagu "${track.name}". File mungkin rusak atau format tidak didukung.`);
    };

    // Same track already loaded — play/resume immediately (still in user click gesture)
    if (mp3LoadedTrackRef.current === index && audio.src) {
      if (autoPlay) {
        setMp3TrackLoading(true);
        audio.currentTime = 0;
        audio.play().then(onPlaySuccess).catch(onPlayFail);
      }
      if (!track.lyrics && !track.lyricsLoading) {
        scheduleLyricsFetch(index, audio.duration || 0);
      }
      return;
    }

    setMp3IsPlaying(false);
    setMp3TrackLoading(autoPlay);
    mp3LoadedTrackRef.current = index;

    // Clean up any previous canplay listeners
    audio.removeAttribute('data-canplay-retry');

    audio.src = track.url;
    audio.load();

    if (autoPlay) {
      // Try playing immediately (synchronous in click handler for autoplay policy)
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise.then(onPlaySuccess).catch((err) => {
          // If play() fails because audio isn't ready yet, wait for canplay and retry
          if (err?.name === 'AbortError' || (err?.name === 'NotAllowedError' && audio.readyState < 2)) {
            // Use a one-time canplay listener to retry
            const retryOnCanPlay = () => {
              audio.removeEventListener('canplay', retryOnCanPlay);
              audio.removeEventListener('error', onErrorCleanup);
              // Only retry if this is still the active track
              if (mp3LoadedTrackRef.current === index) {
                audio.play().then(onPlaySuccess).catch(onPlayFail);
              }
            };
            const onErrorCleanup = () => {
              audio.removeEventListener('canplay', retryOnCanPlay);
              audio.removeEventListener('error', onErrorCleanup);
              const mediaErr = audio.error;
              console.error('Audio load error during retry:', mediaErr);
              setMp3IsPlaying(false);
              setMp3TrackLoading(false);
              setMp3LyricsStatus(`Gagal memuat lagu "${track.name}". File mungkin rusak atau format tidak didukung.`);
            };
            audio.addEventListener('canplay', retryOnCanPlay, { once: true });
            audio.addEventListener('error', onErrorCleanup, { once: true });
          } else {
            onPlayFail(err);
          }
        });
      }
    } else {
      setMp3TrackLoading(false);
    }
  };

  const toggleMp3Play = () => {
    if (!mp3AudioRef.current || mp3Playlist.length === 0) return;
    if (mp3CurrentIndex === -1) {
      playMp3Track(0);
      return;
    }
    if (mp3IsPlaying) {
      mp3AudioRef.current.pause();
      syncMp3PitchPlayerToMedia(false);
      setMp3IsPlaying(false);
    } else {
      mp3AudioRef.current.play()
        .then(() => {
          setMp3IsPlaying(true);
          if (mp3PitchPlayerRef.current) {
            syncMp3PitchPlayerToMedia(true);
          } else if (mp3PitchRef.current) {
            void applyMp3PlaylistPitch(mp3PitchRef.current, {
              track: mp3Playlist[mp3CurrentIndex],
            });
          }
        })
        .catch(() => setMp3IsPlaying(false));
    }
  };

  const playMp3Next = () => {
    if (mp3Playlist.length === 0) return;
    if (mp3Repeat === 'one' && mp3CurrentIndex >= 0) {
      playMp3Track(mp3CurrentIndex);
      return;
    }
    if (mp3Shuffle && mp3Playlist.length > 1) {
      let nextIdx;
      do {
        nextIdx = Math.floor(Math.random() * mp3Playlist.length);
      } while (nextIdx === mp3CurrentIndex && mp3Playlist.length > 1);
      playMp3Track(nextIdx);
      return;
    }
    const next = mp3CurrentIndex < mp3Playlist.length - 1 ? mp3CurrentIndex + 1 : (mp3Repeat === 'off' ? -1 : 0);
    if (next >= 0) playMp3Track(next);
    else setMp3IsPlaying(false);
  };

  const playMp3Prev = () => {
    if (mp3Playlist.length === 0) return;
    if (mp3AudioRef.current && mp3AudioRef.current.currentTime > 3) {
      mp3AudioRef.current.currentTime = 0;
      if (mp3PitchPlayerRef.current) {
        syncMp3PitchPlayerToMedia(!mp3AudioRef.current.paused);
      }
      return;
    }
    if (mp3Shuffle && mp3Playlist.length > 1) {
      let prevIdx;
      do {
        prevIdx = Math.floor(Math.random() * mp3Playlist.length);
      } while (prevIdx === mp3CurrentIndex && mp3Playlist.length > 1);
      playMp3Track(prevIdx);
      return;
    }
    const prev = mp3CurrentIndex > 0 ? mp3CurrentIndex - 1 : mp3Playlist.length - 1;
    playMp3Track(prev);
  };

  const disposeMicFxNodes = () => {
    const fx = micFxRef.current;
    if (fx) {
      Object.values(fx).forEach((node) => {
        try { node?.dispose?.(); } catch { /* ignore */ }
      });
    }
    micFxRef.current = null;
    micEchoRef.current = null;
  };

  const stopPitchCoachLoop = () => {
    pitchCoachActiveRef.current = false;
    if (pitchCoachRafRef.current) {
      cancelAnimationFrame(pitchCoachRafRef.current);
      pitchCoachRafRef.current = null;
    }
  };

  const resetPitchCoachUi = () => {
    setPitchCoachStatus('idle');
    setPitchCoachCents(0);
    setPitchCoachMicNote('--');
    setPitchCoachVocalNote('--');
    pitchCoachSmoothRef.current = 0;
  };

  const disposeVocalPitchAnalyser = () => {
    try { vocalPitchAnalyserRef.current?.dispose?.(); } catch { /* ignore */ }
    vocalPitchAnalyserRef.current = null;
  };

  const disposeMicPitchAnalyser = () => {
    try { micPitchAnalyserRef.current?.dispose?.(); } catch { /* ignore */ }
    micPitchAnalyserRef.current = null;
  };

  const ensureVocalPitchAnalyser = () => {
    if (vocalPitchAnalyserRef.current) return vocalPitchAnalyserRef.current;
    const pre = preFxNodesRef.current?.vocals;
    if (!pre) return null;
    const analyser = new Tone.Analyser('waveform', 2048);
    pre.connect(analyser);
    vocalPitchAnalyserRef.current = analyser;
    return analyser;
  };

  const runPitchCoachFrame = () => {
    pitchCoachRafRef.current = null;
    if (!pitchCoachActiveRef.current) return;

    const micAn = micPitchAnalyserRef.current;
    const vocalAn = ensureVocalPitchAnalyser();
    if (!micAn || !vocalAn) {
      setPitchCoachStatus('idle');
      pitchCoachRafRef.current = requestAnimationFrame(runPitchCoachFrame);
      return;
    }

    const sr = Tone.getContext().sampleRate || 44100;
    const micHz = detectPitchHz(micAn.getValue(), sr);
    const vocalHz = detectPitchHz(vocalAn.getValue(), sr);

    if (!micHz && !vocalHz) {
      setPitchCoachStatus('quiet');
      setPitchCoachMicNote('--');
      setPitchCoachVocalNote('--');
    } else if (!micHz) {
      setPitchCoachStatus('quiet');
      setPitchCoachMicNote('--');
      setPitchCoachVocalNote(vocalHz ? midiToNoteName(hzToMidi(vocalHz)) : '--');
    } else if (!vocalHz) {
      setPitchCoachStatus('quiet');
      setPitchCoachMicNote(midiToNoteName(hzToMidi(micHz)));
      setPitchCoachVocalNote('--');
    } else {
      const cents = pitchDiffCents(micHz, vocalHz);
      const smooth = pitchCoachSmoothRef.current * 0.72 + cents * 0.28;
      pitchCoachSmoothRef.current = smooth;
      setPitchCoachCents(smooth);
      setPitchCoachMicNote(midiToNoteName(hzToMidi(micHz)));
      setPitchCoachVocalNote(midiToNoteName(hzToMidi(vocalHz)));
      if (Math.abs(smooth) <= 35) setPitchCoachStatus('ok');
      else if (smooth > 35) setPitchCoachStatus('high');
      else setPitchCoachStatus('low');
    }

    if (pitchCoachActiveRef.current) {
      pitchCoachRafRef.current = requestAnimationFrame(runPitchCoachFrame);
    }
  };

  const startPitchCoachLoop = () => {
    if (!micPitchAnalyserRef.current) return;
    stopPitchCoachLoop();
    pitchCoachActiveRef.current = true;
    ensureVocalPitchAnalyser();
    pitchCoachRafRef.current = requestAnimationFrame(runPitchCoachFrame);
  };

  const disposeMic = () => {
    stopPitchCoachLoop();
    resetPitchCoachUi();
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    } catch { /* ignore */ }
    mediaRecorderRef.current = null;
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    try { micRef.current?.close(); } catch { /* ignore */ }
    try { micRef.current?.disconnect(); } catch { /* ignore */ }
    try { micRef.current?.dispose(); } catch { /* ignore */ }
    disposeMicFxNodes();
    disposeMicPitchAnalyser();
    try { micVolRef.current?.dispose(); } catch { /* ignore */ }
    micRef.current = null;
    micVolRef.current = null;
    setMicReady(false);
    setIsRecordingKaraoke(false);
  };

  const disposeMasterChain = () => {
    disposeMic();
    if (masterEqRef.current) { masterEqRef.current.dispose(); masterEqRef.current = null; }
    masterEqBandsRef.current.forEach((f) => { try { f.dispose(); } catch { /* ignore */ } });
    masterEqBandsRef.current = [];
    if (masterDenoiseHpRef.current) { masterDenoiseHpRef.current.dispose(); masterDenoiseHpRef.current = null; }
    if (masterDenoiseLpRef.current) { masterDenoiseLpRef.current.dispose(); masterDenoiseLpRef.current = null; }
    if (masterCompressorRef.current) { masterCompressorRef.current.dispose(); masterCompressorRef.current = null; }
    masterPitchShiftRef.current = null; // pitch now via GrainPlayer.detune (no master PitchShift)
    if (masterDelayRef.current) { masterDelayRef.current.dispose(); masterDelayRef.current = null; }
    if (masterReverbRef.current) { masterReverbRef.current.dispose(); masterReverbRef.current = null; }
    if (vocalReverbSendRef.current) { vocalReverbSendRef.current.dispose(); vocalReverbSendRef.current = null; }
    if (vocalDelaySendRef.current) { vocalDelaySendRef.current.dispose(); vocalDelaySendRef.current = null; }
    if (vocalGateRef.current) { vocalGateRef.current.dispose(); vocalGateRef.current = null; }
    if (vocalLevelerRef.current) { vocalLevelerRef.current.dispose(); vocalLevelerRef.current = null; }
    if (vocalDeEsserRef.current) { vocalDeEsserRef.current.dispose(); vocalDeEsserRef.current = null; }
    if (masterWarmthRef.current) { masterWarmthRef.current.dispose(); masterWarmthRef.current = null; }
    if (masterWidenerRef.current) { masterWidenerRef.current.dispose(); masterWidenerRef.current = null; }
    if (masterMakeupRef.current) { masterMakeupRef.current.dispose(); masterMakeupRef.current = null; }
    if (masterLimiterRef.current) { masterLimiterRef.current.dispose(); masterLimiterRef.current = null; }
    if (recordCompDelayRef.current) { recordCompDelayRef.current.dispose(); recordCompDelayRef.current = null; }
    if (masterOutRef.current) { masterOutRef.current.dispose(); masterOutRef.current = null; }
    recordDestRef.current = null;
  };

  useEffect(() => {
    return () => {
      Object.values(playersRef.current).forEach(p => { try { p.dispose(); } catch {} });
      Object.values(volumeNodesRef.current).forEach(v => { try { v.dispose(); } catch {} });
      disposeVocalPitchAnalyser();
      Object.values(preFxNodesRef.current).forEach(g => { try { g.dispose(); } catch {} });
      disposeMasterChain();
    };
  }, []);

  // Check license on app load
  useEffect(() => {
    checkLicenseStatus();
  }, []);

  const checkLicenseStatus = async () => {
    setLicenseStatus('checking');
    try {
      const res = await fetch(`${API_BASE_URL}/license/status`);
      const data = await res.json();
      
      if (data.licensed) {
        setLicenseStatus('valid');
        setLicenseInfo({ ...(data.info || {}), app_version: data.app_version });
      } else {
        setLicenseStatus('invalid');
        setLicenseMessage(data.message || 'Lisensi tidak valid');
      }
      
      if (data.hardware_id) {
        setHardwareId(data.hardware_id);
      }
    } catch (e) {
      console.error('License check failed:', e);
      // If backend is not running yet, try again in 2 seconds
      setTimeout(checkLicenseStatus, 2000);
    }
  };

  const handleLicenseActivate = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (!file.name.endsWith('.lic')) {
      setLicenseMessage('File harus berformat .lic');
      setLicenseMessageType('error');
      return;
    }
    
    setIsActivating(true);
    setLicenseMessage('');
    
    try {
      const formData = new FormData();
      formData.append('file', file);
      
      const res = await fetch(`${API_BASE_URL}/license/activate`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      
      if (res.ok && data.status === 'success') {
        setLicenseMessage(data.message);
        setLicenseMessageType('success');
        setLicenseInfo(data.info);
        // Re-check license after short delay
        setTimeout(() => {
          setLicenseStatus('valid');
        }, 1500);
      } else {
        setLicenseMessage(data.message || 'Aktivasi gagal');
        setLicenseMessageType('error');
      }
    } catch (err) {
      setLicenseMessage('Gagal mengaktifkan lisensi. Pastikan server berjalan.');
      setLicenseMessageType('error');
    } finally {
      setIsActivating(false);
      // Reset file input
      e.target.value = '';
    }
  };

  const copyHardwareId = () => {
    navigator.clipboard.writeText(hardwareId).then(() => {
      setHwidCopied(true);
      setTimeout(() => setHwidCopied(false), 2000);
    });
  };

  const formatLicenseType = (type) => {
    const map = {
      '1hari': '1 Hari',
      '1minggu': '1 Minggu',
      '7hari': '1 Minggu',
      '14hari': '14 Hari',
      '1m': '1 Bulan',
      '1bulan': '1 Bulan',
      '2m': '2 Bulan',
      '2bulan': '2 Bulan',
      '3m': '3 Bulan',
      '6m': '6 Bulan',
      '1y': '1 Tahun',
      '3bulan': '3 Bulan',
      '6bulan': '6 Bulan',
      '1tahun': '1 Tahun',
    };
    return map[type] || type;
  };

  const formatDate = (isoDate) => {
    if (!isoDate) return '-';
    return new Date(isoDate).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  };

  useEffect(() => {
    return () => {
      if (originalUrl) {
        URL.revokeObjectURL(originalUrl);
      }
    };
  }, [originalUrl]);

  useEffect(() => {
    let animationFrameId;
    const updateProgress = () => {
      if (Tone.Transport.state === 'started') {
        const currentTime = Tone.Transport.seconds;
        const effectiveEnd = trimEnabled && trimEnd != null ? trimEnd : stemDuration;
        if (effectiveEnd > 0 && currentTime >= effectiveEnd) {
          Tone.Transport.stop();
          setIsPlaying(false);
          const resetTo = trimEnabled ? trimStart : 0;
          Tone.Transport.seconds = resetTo;
          setStemCurrentTime(resetTo);
          if (stemVideoRef.current) {
            stemVideoRef.current.pause();
            stemVideoRef.current.currentTime = resetTo;
          }
        } else {
          setStemCurrentTime(currentTime);
          syncStemLyricsToTime(currentTime);
          animationFrameId = requestAnimationFrame(updateProgress);
        }
      }
    };
    if (isPlaying) {
      animationFrameId = requestAnimationFrame(updateProgress);
    }
    return () => cancelAnimationFrame(animationFrameId);
  }, [isPlaying, stemDuration, trimEnabled, trimStart, trimEnd, stemLyrics, stemLyricsOffsetMs, stemLyricsSpeedPct]);

  const resetStemLyrics = () => {
    setStemLyrics(null);
    setStemLyricsLoading(false);
    setStemLyricsStatus('');
    setStemLyricsNotFound(false);
    setStemActiveLyricIndex(-1);
    setStemLyricProgress(0);
    setStemLyricWordIndex(-1);
    setStemLyricsOffsetMs(0);
    setStemLyricsSpeedPct(100);
    setStemLyricsManualOpen(false);
    setStemLyricsSearchResults([]);
    stemLyricSyncRef.current = { activeIndex: -1, progress: 0, activeWordIndex: -1 };
  };

  const applyStemLyrics = (data) => {
    const parsed = data.format === 'lrc' ? parseLrc(data.content) : null;
    const lyrics = parsed
      ? { type: 'lrc', lines: parsed.lines, offset: parsed.offset, raw: data.content }
      : { type: 'plain', text: data.content, raw: data.content };
    setStemLyrics(lyrics);
    setStemLyricsNotFound(false);
    const searched = data.search_artist && data.search_title
      ? `${data.search_artist} — ${data.search_title}`
      : (data.search_title || stemTrackName);
    setStemLyricsStatus(searched ? `Lirik: ${searched}` : 'Lirik dimuat.');
  };

  const syncStemLyricsToTime = (currentTime) => {
    if (stemLyrics?.type !== 'lrc' || !stemLyrics.lines?.length) return;
    const effectiveTime = currentTime;
    const offsetMs = stemLyricsOffsetMs - (stemLyrics.offset || 0);
    const { activeIndex, progress, activeWordIndex } = getLyricSyncState(
      stemLyrics.lines, effectiveTime, offsetMs, stemLyricsSpeedPct
    );
    const prev = stemLyricSyncRef.current;
    if (prev.activeIndex !== activeIndex) {
      stemLyricSyncRef.current = { activeIndex, progress, activeWordIndex };
      setStemActiveLyricIndex(activeIndex);
      setStemLyricProgress(progress);
      setStemLyricWordIndex(activeWordIndex);
    } else if (Math.abs(prev.progress - progress) >= 0.012 || prev.activeWordIndex !== activeWordIndex) {
      stemLyricSyncRef.current = { activeIndex, progress, activeWordIndex };
      setStemLyricProgress(progress);
      setStemLyricWordIndex(activeWordIndex);
    }
  };

  const fetchStemLyrics = async (trackName, duration, { refresh = false } = {}) => {
    if (!trackName) return;
    if (stemLyrics && !refresh) return;

    setStemLyricsLoading(true);
    setStemLyricsStatus(refresh ? 'Mencari ulang lirik...' : 'Mencari lirik...');
    if (refresh) {
      setStemLyrics(null);
      setStemLyricsNotFound(false);
    }

    try {
      const res = await fetch(`${API_BASE_URL}/lyrics/fetch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          track_name: trackName,
          duration: duration > 0 ? Math.round(duration) : undefined,
          refresh,
        }),
      });
      const data = await res.json();
      if (res.ok && data.found && data.content) {
        applyStemLyrics(data);
      } else {
        setStemLyricsNotFound(true);
        const searched = data.search_artist && data.search_title
          ? `${data.search_artist} — ${data.search_title}`
          : trackName;
        setStemLyricsStatus(searched ? `Lirik tidak ditemukan: ${searched}` : 'Lirik tidak ditemukan.');
      }
    } catch (e) {
      console.error(e);
      setStemLyricsStatus('Gagal memuat lirik.');
    } finally {
      setStemLyricsLoading(false);
    }
  };

  const openStemManualLyricsSearch = () => {
    const { artist, title } = parseTrackName(stemTrackName);
    setStemLyricsSearchArtist(artist);
    setStemLyricsSearchTitle(title);
    setStemLyricsSearchResults([]);
    setStemLyricsSearchDone(false);
    setStemLyricsManualOpen(true);
  };

  const searchStemManualLyrics = async () => {
    if (!stemLyricsSearchTitle.trim() && !stemLyricsSearchArtist.trim()) return;
    setStemLyricsSearchLoading(true);
    setStemLyricsSearchResults([]);
    setStemLyricsSearchDone(false);
    try {
      const res = await fetch(`${API_BASE_URL}/lyrics/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          artist: stemLyricsSearchArtist.trim(),
          title: stemLyricsSearchTitle.trim(),
          duration: stemDuration > 0 ? Math.round(stemDuration) : undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) setStemLyricsSearchResults(data.results || []);
    } catch (e) {
      console.error(e);
    } finally {
      setStemLyricsSearchLoading(false);
      setStemLyricsSearchDone(true);
    }
  };

  const selectStemManualLyric = async (lrclibId) => {
    if (!stemTrackName) return;
    setStemLyricsSelectLoading(lrclibId);
    try {
      const res = await fetch(`${API_BASE_URL}/lyrics/select`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ track_name: stemTrackName, lrclib_id: lrclibId }),
      });
      const data = await res.json();
      if (res.ok && data.found && data.content) {
        applyStemLyrics(data);
        setStemLyricsOffsetMs(0);
        setStemLyricsSpeedPct(100);
        setStemLyricsManualOpen(false);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setStemLyricsSelectLoading(null);
    }
  };

  const syncStemLyricLineToNow = (lineIndex) => {
    const line = stemLyrics?.lines?.[lineIndex];
    if (!line) return;
    const speed = stemLyricsSpeedPct / 100;
    const effectiveMs = Math.round((line.time / speed - stemCurrentTime) * 1000);
    setStemLyricsOffsetMs(effectiveMs + (stemLyrics.offset || 0));
    syncStemLyricsToTime(stemCurrentTime);
  };

  useEffect(() => {
    syncStemLyricsToTime(stemCurrentTime);
  }, [stemCurrentTime, stemLyrics, stemLyricsOffsetMs, stemLyricsSpeedPct]);

  useEffect(() => {
    stemActiveLyricRef.current?.scrollIntoView({ behavior: 'auto', block: 'center' });
  }, [stemActiveLyricIndex]);

  useEffect(() => {
    let interval;
    if (status === 'processing' && fileId) {
      interval = setInterval(async () => {
        try {
          const res = await fetch(`${API_BASE_URL}/status/${fileId}`);
          const data = await res.json();
          if (data.progress !== undefined) {
            setProgress(data.progress);
          }
          if (data.eta !== undefined) {
            setEta(data.eta);
          }
          if (data.status === 'done') {
            setStatus('loading_audio');
            setProgressText('Memuat file audio ke browser...');
            clearInterval(interval);
            loadAudioStems(fileId);
          } else if (data.status === 'error') {
            setStatus('error');
            setProgressText('Terjadi kesalahan saat memisahkan audio.');
            clearInterval(interval);
          }
        } catch (e) {
          console.error(e);
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [status, fileId]);


  // YouTube to MP3 polling
  useEffect(() => {
    let interval;
    if (yt2mp3Status === 'downloading' && yt2mp3JobId) {
      interval = setInterval(async () => {
        try {
          const res = await fetch(`${API_BASE_URL}/youtube-to-mp3/status/${yt2mp3JobId}`);
          const data = await res.json();
          if (data.progress !== undefined) setYt2mp3Progress(data.progress);
          if (data.title) setYt2mp3Title(data.title);
          if (data.media_type === 'mp4' || data.media_type === 'mp3') {
            setYt2mp3MediaType(data.media_type);
          }
          
          if (data.status === 'done') {
            setYt2mp3Status('done');
            setYt2mp3Progress(100);
            clearInterval(interval);
          } else if (data.status === 'error') {
            setYt2mp3Status('error');
            setYt2mp3Error(data.error || 'Terjadi kesalahan');
            clearInterval(interval);
          }
        } catch (e) {
          console.error(e);
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [yt2mp3Status, yt2mp3JobId]);

  // Preview/Test Play handler
  const yt2mp3PreviewUrlRef = useRef(''); // cache the proxy URL for resume
  const handlePreviewPlay = useCallback(async (idx) => {
    const audio = yt2mp3PreviewAudioRef.current;
    if (!audio) return;

    // If same item clicked while playing → pause
    if (yt2mp3PreviewIdx === idx && yt2mp3PreviewPlaying) {
      audio.pause();
      setYt2mp3PreviewPlaying(false);
      return;
    }
    // If same item clicked while paused → resume
    if (yt2mp3PreviewIdx === idx && !yt2mp3PreviewPlaying && yt2mp3PreviewUrlRef.current) {
      // If audio ended or currentTime is near end, restart from beginning
      if (audio.ended || (audio.duration && audio.currentTime >= audio.duration - 0.5)) {
        audio.currentTime = 0;
      }
      try {
        await audio.play();
        setYt2mp3PreviewPlaying(true);
      } catch {
        // Stream may have expired — reload from cached URL
        audio.src = yt2mp3PreviewUrlRef.current;
        audio.load();
        try {
          await audio.play();
          setYt2mp3PreviewPlaying(true);
        } catch (e2) {
          console.error('Preview resume failed:', e2);
        }
      }
      return;
    }

    // New item: stop current, fetch stream, play
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    yt2mp3PreviewUrlRef.current = '';
    setYt2mp3PreviewIdx(idx);
    setYt2mp3PreviewLoading(true);
    setYt2mp3PreviewPlaying(false);
    setYt2mp3PreviewTime(0);
    setYt2mp3PreviewDuration(0);

    const result = yt2mp3SearchResults[idx];
    if (!result) { setYt2mp3PreviewLoading(false); return; }

    try {
      const res = await fetch(`${API_BASE_URL}/youtube-to-mp3/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ url: result.url })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('Preview error:', err.detail);
        setYt2mp3PreviewLoading(false);
        return;
      }
      const data = await res.json();
      // Use proxy stream to avoid CORS
      const proxyUrl = `${API_BASE_URL}/youtube-to-mp3/preview-stream?url=${encodeURIComponent(data.stream_url)}`;
      yt2mp3PreviewUrlRef.current = proxyUrl;
      audio.src = proxyUrl;
      audio.load();
      await audio.play();
      setYt2mp3PreviewPlaying(true);
    } catch (e) {
      console.error('Preview play error:', e);
    }
    setYt2mp3PreviewLoading(false);
  }, [yt2mp3PreviewIdx, yt2mp3PreviewPlaying, yt2mp3SearchResults, token]);

  // Stop preview when status changes (e.g. user starts downloading)
  useEffect(() => {
    const audio = yt2mp3PreviewAudioRef.current;
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    yt2mp3PreviewUrlRef.current = '';
    setYt2mp3PreviewIdx(-1);
    setYt2mp3PreviewPlaying(false);
    setYt2mp3PreviewTime(0);
    setYt2mp3PreviewDuration(0);
  }, [yt2mp3Status]);

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthError('');
    setIsAuthLoading(true);
    
    try {
      if (isLoginMode) {
        const loginUsername = authForm.username.trim();
        const loginPassword = authForm.password;
        const formData = new URLSearchParams();
        formData.append('username', loginUsername);
        formData.append('password', loginPassword);
        
        const res = await fetch(`${API_BASE_URL}/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formData
        });
        const data = await res.json();
        
        if (res.ok) {
          const loggedInUsername = data.username || loginUsername;
          setToken(data.access_token);
          setUsername(loggedInUsername);
          setIsAdmin(data.is_admin || false);
          localStorage.setItem('token', data.access_token);
          localStorage.setItem('username', loggedInUsername);
          localStorage.setItem('isAdmin', data.is_admin ? 'true' : 'false');
          setAuthError('');
        } else if (res.status === 403 && data.detail === 'LICENSE_REQUIRED') {
          setAuthError(data.message || 'Aktivasi lisensi diperlukan sebelum login.');
        } else {
          setAuthError(data.detail || 'Login gagal. Periksa username dan password.');
        }
      } else {
        const res = await fetch(`${API_BASE_URL}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(authForm)
        });
        const data = await res.json();
        
        if (res.ok) {
          setIsLoginMode(true);
          setAuthError('Registrasi sukses. Silakan login.');
        } else {
          setAuthError(data.detail || 'Registration failed');
        }
      }
    } catch (err) {
      setAuthError('Terjadi kesalahan jaringan.');
    } finally {
      setIsAuthLoading(false);
    }
  };

  const handleLogout = (sessionExpired = false) => {
    setToken(null);
    setUsername(null);
    setIsAdmin(false);
    setShowAdminPanel(false);
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    localStorage.removeItem('isAdmin');
    setFile(null);
    setStatus('idle');
    if (Tone.Transport.state === 'started') Tone.Transport.stop();
    if (sessionExpired) {
      setIsLoginMode(true);
      setAuthError('Sesi login habis. Silakan login kembali.');
    }
  };

  const handleUnauthorized = () => {
    handleLogout(true);
  };

  useEffect(() => {
    const storedToken = localStorage.getItem('token');
    if (!storedToken) return;

    fetch(`${API_BASE_URL}/me`, {
      headers: { Authorization: `Bearer ${storedToken}` },
    })
      .then((res) => {
        if (res.status === 401) handleUnauthorized();
      })
      .catch(() => {});
  }, []);

  // Admin functions
  const fetchUsers = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/admin/users`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setUserList(data);
      }
    } catch (e) { console.error(e); }
  };

  const handleAddUser = async (e) => {
    e.preventDefault();
    setAdminMsg('');
    try {
      const res = await fetch(`${API_BASE_URL}/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(addForm)
      });
      const data = await res.json();
      if (res.ok) {
        setAdminMsg('User berhasil ditambahkan!');
        setAddForm({ username: '', password: '', is_admin: false });
        setShowAddForm(false);
        fetchUsers();
      } else {
        setAdminMsg(data.detail || 'Gagal menambahkan user');
      }
    } catch (e) { setAdminMsg('Kesalahan jaringan'); }
  };

  const handleEditUser = async (userId) => {
    setAdminMsg('');
    const payload = {};
    if (editForm.username) payload.username = editForm.username;
    if (editForm.password) payload.password = editForm.password;
    if (editForm.is_admin !== undefined) payload.is_admin = editForm.is_admin;
    try {
      const res = await fetch(`${API_BASE_URL}/admin/users/${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        setAdminMsg('User berhasil diperbarui!');
        setEditingUser(null);
        fetchUsers();
      } else {
        setAdminMsg(data.detail || 'Gagal memperbarui user');
      }
    } catch (e) { setAdminMsg('Kesalahan jaringan'); }
  };

  const handleDeleteUser = async (userId, uname) => {
    if (!confirm(`Yakin ingin menghapus user "${uname}"?`)) return;
    setAdminMsg('');
    try {
      const res = await fetch(`${API_BASE_URL}/admin/users/${userId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setAdminMsg('User berhasil dihapus!');
        fetchUsers();
      } else {
        setAdminMsg(data.detail || 'Gagal menghapus user');
      }
    } catch (e) { setAdminMsg('Kesalahan jaringan'); }
  };

  const handleFileSelect = (e) => {
    const selectedFile = e.target.files[0];
    if (!selectedFile) return;
    
    setFile(selectedFile);
    const trackName = selectedFile.name.replace(/\.[^/.]+$/, '');
    setStemTrackName(trackName);
    resetStemLyrics();
    const url = URL.createObjectURL(selectedFile);
    setOriginalUrl(url);
    setStatus('selected');
    setOriginalPlaying(false);
    setAudioCurrentTime(0);
    setAudioDuration(0);
  };

  const startSeparation = async () => {
    if (!file) return;
    
    try {
      await Tone.start();
    } catch (e) {
      console.warn('Tone.start failed', e);
    }
    
    if (originalAudioRef.current) {
      originalAudioRef.current.pause();
    }
    setOriginalPlaying(false);
    
    resetStemLyrics();
    setStatus('uploading');
    setProgressText('Mengunggah file...');
    setProgress(0);
    setEta('Menghitung...');
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
      const uploadRes = await fetch(`${API_BASE_URL}/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });
      const uploadData = await uploadRes.json();
      
      setStatus('processing');
      setProgressText('AI sedang memisahkan instrumen...');
      setFileId(uploadData.file_id);
      const projectName = (stemTrackName || uploadData.display_name || file?.name?.replace(/\.[^/.]+$/, '')).trim();
      if (projectName) {
        setStemTrackName(projectName);
        await saveProjectName(uploadData.file_id, projectName);
      }
      
      await fetch(`${API_BASE_URL}/separate/${uploadData.file_id}`, { 
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
    } catch (err) {
      console.error(err);
      setStatus('error');
      setProgressText('Gagal mengunggah file.');
    }
  };
  
  const handleSearchOnlineTab = async () => {
    if (!searchQuery.trim()) return;
    setIsSearchingTab(true);
    setSearchResult(null);
    try {
      const res = await fetch(`${API_BASE_URL}/tabs/search_online`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ query: searchQuery })
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Gagal mencari tabulatur');
      
      setSearchResult(data);
    } catch (e) {
      alert("Error: " + e.message);
    } finally {
      setIsSearchingTab(false);
    }
  };

  const handleOpenSearchModal = () => {
    if (file && file.name) {
      // Remove extension and populate the search query
      const defaultQuery = file.name.replace(/\.[^/.]+$/, "");
      setSearchQuery(defaultQuery);
    } else {
      setSearchQuery('');
    }
    setSearchResult(null);
    setShowSearchModal(true);
  };

  const handleDownloadOnlineTab = () => {
    if (!searchResult || !searchResult.content) return;
    const blob = new Blob([searchResult.content], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Tab_Online_${searchQuery}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setShowSearchModal(false);
    setSearchResult(null);
  };


  const formatTime = (secs) => {
    if (isNaN(secs)) return '00:00';
    const minutes = Math.floor(secs / 60);
    const seconds = Math.floor(secs % 60);
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const formatProjectDate = (iso) => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return '';
    }
  };

  const fetchSavedProjects = useCallback(async () => {
    if (!token) return;
    setProjectsLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/projects`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setSavedProjects(data.projects || []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setProjectsLoading(false);
    }
  }, [token]);

  const applyProjectSettings = (settings) => {
    if (!settings) return;

    const volMap = settings.volumes || {};
    const muteMap = settings.mutes || {};
    const panMap = settings.pans || {};

    INSTRUMENTS.forEach(({ id }) => {
      const vol = volMap[id] ?? 0;
      const muted = !!muteMap[id];
      if (volumeNodesRef.current[id]) {
        volumeNodesRef.current[id].volume.value = vol;
        volumeNodesRef.current[id].mute = muted;
      }
    });

    const nextVols = {};
    const nextMutes = {};
    const nextPans = {};
    INSTRUMENTS.forEach(({ id }) => {
      nextVols[id] = volMap[id] ?? 0;
      nextMutes[id] = !!muteMap[id];
      const panVal = panMap[id] ?? 0;
      nextPans[id] = panVal;
      if (pannerNodesRef.current[id]) {
        pannerNodesRef.current[id].pan.value = panVal / 100;
      }
    });
    setVolumes(nextVols);
    setMutes(nextMutes);
    setPans(nextPans);

    const nextPitch = settings.pitch ?? 0;
    const nextTempo = settings.tempo ?? 1;
    setPitch(nextPitch);
    setTempo(nextTempo);
    const cents = nextPitch * 100;
    const gs = grainSizeForPitch(nextPitch);
    Object.values(playersRef.current).forEach((p) => {
      if (!p) return;
      if (p.playbackRate !== undefined) p.playbackRate = nextTempo;
      if (p.detune !== undefined) p.detune = cents;
      if ('grainSize' in p) p.grainSize = gs;
    });
    if (stemVideoRef.current) stemVideoRef.current.playbackRate = nextTempo;

    const low = settings.eq_low ?? 0;
    const mid = settings.eq_mid ?? 0;
    const high = settings.eq_high ?? 0;
    setEqLow(low);
    setEqMid(mid);
    setEqHigh(high);
    if (masterEqRef.current) {
      masterEqRef.current.low.value = low;
      masterEqRef.current.mid.value = mid;
      masterEqRef.current.high.value = high;
    }

    const bandsRaw = Array.isArray(settings.eq_bands) ? settings.eq_bands : [];
    const bands = EQ_BAND_FREQS.map((_, i) => {
      const v = Number(bandsRaw[i]);
      return Number.isFinite(v) ? Math.max(-12, Math.min(12, v)) : 0;
    });
    setEqBands(bands);
    if (masterEqBandsRef.current) {
      masterEqBandsRef.current.forEach((f, i) => {
        if (f?.gain) f.gain.value = bands[i] ?? 0;
      });
    }
    
    const comp = !!settings.compressor_enabled;
    setCompressorEnabled(comp);
    
    const vLev = !!settings.vocal_leveler_enabled;
    setVocalLevelerEnabled(vLev);
    const vLevTgt = settings.vocal_leveler_target ?? -28.0;
    setVocalLevelerTarget(vLevTgt);
    const vDeEss = settings.vocal_deesser_amount ?? 0;
    setVocalDeEsserAmount(vDeEss);

    if (masterCompressorRef.current) {
      masterCompressorRef.current.threshold.value = comp ? -15 : 0;
      masterCompressorRef.current.ratio.value = comp ? 2.5 : 1;
    }
    
    if (vocalLevelerRef.current) {
      vocalLevelerRef.current.threshold.value = vLev ? vLevTgt : 0;
      vocalLevelerRef.current.ratio.value = vLev ? 4 : 1;
    }
    if (vocalDeEsserRef.current) {
      vocalDeEsserRef.current.gain.value = vDeEss > 0 ? -vDeEss : 0;
    }

    const lim = settings.limiter_enabled !== false;
    setLimiterEnabled(lim);
    if (masterLimiterRef.current) {
      masterLimiterRef.current.threshold.value = lim ? -1 : 0;
    }

    const norm = settings.normalize_enabled !== false;
    setNormalizeEnabled(norm);
    if (masterMakeupRef.current) {
      masterMakeupRef.current.volume.value = norm ? STEM_MAKEUP_DB : 0;
    }

    const denoise = !!settings.denoise_enabled;
    setDenoiseEnabled(denoise);
    if (masterDenoiseHpRef.current && masterDenoiseLpRef.current) {
      masterDenoiseHpRef.current.frequency.value = denoise ? 90 : 20;
      masterDenoiseLpRef.current.frequency.value = denoise ? 12000 : 20000;
    }

    const reverbOn = !!settings.reverb_enabled;
    setReverbEnabled(reverbOn);
    if (vocalReverbSendRef.current) {
      vocalReverbSendRef.current.gain.value = reverbOn ? REVERB_WET : 0;
    }

    const delayOn = !!settings.delay_enabled;
    setDelayEnabled(delayOn);
    if (vocalDelaySendRef.current) {
      vocalDelaySendRef.current.gain.value = delayOn ? DELAY_WET : 0;
    }

    const mVol = settings.master_volume ?? 0;
    setMasterVolume(mVol);
    Tone.Destination.volume.value = mVol;

    setStemLyricsOffsetMs(settings.stem_lyrics_offset_ms ?? 0);
    setStemLyricsSpeedPct(settings.stem_lyrics_speed_pct ?? 100);
  };

  const saveProjectName = async (projectId, name) => {
    const trimmed = (name || '').trim();
    if (!trimmed || !token || !projectId) return false;
    try {
      const res = await fetch(`${API_BASE_URL}/projects/${projectId}/name`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ display_name: trimmed }),
      });
      if (!res.ok) throw new Error('Gagal menyimpan nama proyek');
      if (fileId === projectId) setStemTrackName(trimmed);
      setSavedProjects((prev) => prev.map((p) => (
        p.file_id === projectId ? { ...p, display_name: trimmed } : p
      )));
      return true;
    } catch (e) {
      console.error(e);
      alert(e.message || 'Gagal menyimpan nama proyek');
      return false;
    }
  };

  const saveProjectSettings = useCallback(async () => {
    if (!fileId || !token || status !== 'ready' || skipSettingsSaveRef.current) return;
    try {
      await fetch(`${API_BASE_URL}/projects/${fileId}/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          volumes,
          mutes,
          pans,
          pitch,
          tempo,
          eq_low: eqLow,
          eq_mid: eqMid,
          eq_high: eqHigh,
          eq_bands: eqBands,
          compressor_enabled: compressorEnabled,
          vocal_leveler_enabled: vocalLevelerEnabled,
          vocal_leveler_target: vocalLevelerTarget,
          vocal_deesser_amount: vocalDeEsserAmount,
          master_volume: masterVolume,
          limiter_enabled: limiterEnabled,
          normalize_enabled: normalizeEnabled,
          denoise_enabled: denoiseEnabled,
          reverb_enabled: reverbEnabled,
          delay_enabled: delayEnabled,
          stem_lyrics_offset_ms: stemLyricsOffsetMs,
          stem_lyrics_speed_pct: stemLyricsSpeedPct,
        }),
      });
    } catch (e) {
      console.error(e);
    }
  }, [
    fileId, token, status, volumes, mutes, pans, pitch, tempo,
    eqLow, eqMid, eqHigh, eqBands, compressorEnabled,
    vocalLevelerEnabled, vocalLevelerTarget, vocalDeEsserAmount,
    masterVolume, limiterEnabled, normalizeEnabled,
    denoiseEnabled, reverbEnabled, delayEnabled,
    stemLyricsOffsetMs, stemLyricsSpeedPct,
  ]);

  const resetStemStudio = (homeMode = 'upload') => {
    Tone.Transport.stop();
    Tone.Transport.seconds = 0;
    setIsPlaying(false);
    Object.values(playersRef.current).forEach((p) => { try { p.dispose(); } catch {} });
    Object.values(volumeNodesRef.current).forEach((v) => { try { v.dispose(); } catch {} });
    Object.values(pannerNodesRef.current).forEach((p) => { try { p.dispose(); } catch {} });
    disposeVocalPitchAnalyser();
    disposeMasterChain();
    playersRef.current = {};
    volumeNodesRef.current = {};
    pannerNodesRef.current = {};
    setPlayers({});
    setPans({});
    setTrimEnabled(false);
    setTrimStart(0);
    setTrimEnd(null);
    setFile(null);
    setOriginalUrl(null);
    setFileId(null);
    setStemTrackName('');
    resetStemLyrics();
    setEditingStemProjectName(false);
    setEditingProjectNameId(null);
    if (recordedKaraokeUrl) URL.revokeObjectURL(recordedKaraokeUrl);
    setRecordedKaraokeUrl(null);
    setRecordedKaraokeName('');
    recordedBlobRef.current = null;
    setMicError('');
    setRecordingSeconds(0);
    setStatus('idle');
    setProgressText('');
    setStemHomeMode(homeMode);
    fetchSavedProjects();
  };

  const loadAudioStems = async (id, options = {}) => {
    let { displayName = null, originalName = null, settings = null } = options;
    
    if (!originalName) {
      try {
        const res = await fetch(`${API_BASE_URL}/projects/${id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          originalName = data.original_name || null;
        }
      } catch (e) {
        console.error("Failed to fetch project meta for originalName", e);
      }
    }
    setStemOriginalName(originalName);
    try {
      await Tone.start();

      Object.values(playersRef.current).forEach(p => { try { p.dispose(); } catch {} });
      Object.values(volumeNodesRef.current).forEach(v => { try { v.dispose(); } catch {} });
      Object.values(pannerNodesRef.current).forEach(p => { try { p.dispose(); } catch {} });
      disposeVocalPitchAnalyser();
      disposeMasterChain();

      const masterEq = new Tone.EQ3(0, 0, 0);
      // 10-band graphic EQ (≈1-octave peaking bands)
      const graphicEqBands = EQ_BAND_FREQS.map((freq, i) => new Tone.BiquadFilter({
        type: 'peaking',
        frequency: freq,
        Q: Math.SQRT2,
        gain: eqBands[i] ?? 0,
      }));
      const denoiseHp = new Tone.Filter({ type: 'highpass', frequency: denoiseEnabled ? 90 : 20, Q: 0.7 });
      const denoiseLp = new Tone.Filter({ type: 'lowpass', frequency: denoiseEnabled ? 12000 : 20000, Q: 0.7 });
      const masterCompressor = new Tone.Compressor({ threshold: 0, ratio: 1, attack: 0.01, release: 0.1 });
      
      const vLevTgt = settings?.vocal_leveler_target ?? -28.0;
      const vLevEnabled = settings?.vocal_leveler_enabled ?? false;
      const vDeEssAmt = settings?.vocal_deesser_amount ?? 0;
      
      const vocalGate = new Tone.Gate({
        threshold: vocalGateEnabled ? -35 : -100,
        attack: 0.1,
        release: 0.3
      });
      const vocalLeveler = new Tone.Compressor({ 
        threshold: vLevEnabled ? vLevTgt : 0, 
        ratio: vLevEnabled ? 4 : 1, 
        attack: 0.1, 
        release: 0.5 
      });
      const vocalDeEsser = new Tone.BiquadFilter({ 
        type: 'peaking', 
        frequency: 7000, 
        Q: 2, 
        gain: vDeEssAmt > 0 ? -vDeEssAmt : 0 
      });

      const masterDelay = new Tone.FeedbackDelay({
        delayTime: 0.2,
        feedback: 0.22,
        wet: 1, // selalu 100% wet, kontrol on/off via send gain
      });
      const masterReverb = new Tone.Reverb({ decay: 2.4, preDelay: 0.02, wet: 1 });
      await masterReverb.generate();
      
      // Send gains: mengontrol seberapa banyak sinyal vokal dikirim ke efek
      const vocalReverbSend = new Tone.Gain(reverbEnabled ? REVERB_WET : 0);
      const vocalDelaySend = new Tone.Gain(delayEnabled ? DELAY_WET : 0);
      vocalReverbSend.connect(masterReverb);
      vocalDelaySend.connect(masterDelay);
      
      const masterWarmth = new Tone.Distortion({
        distortion: 0.1,
        oversample: '2x',
        wet: warmthEnabled ? 0.15 : 0
      });
      const masterWidener = new Tone.StereoWidener({
        width: widenerEnabled ? 0.6 : 0
      });

      const masterMakeup = new Tone.Volume(normalizeEnabled ? STEM_MAKEUP_DB : 0);
      const masterLimiter = new Tone.Limiter(limiterEnabled ? -1 : 0);
      const masterOut = new Tone.Gain(1);

      // Routing Aux Return → Master
      masterDelay.connect(masterMakeup);
      masterReverb.connect(masterMakeup);
      // Speakers: undelayed. Recorder: music delayed to match mic input latency.
      const recordCompDelay = new Tone.Delay({ delayTime: 0, maxDelay: 0.5 });
      const recordDest = Tone.getContext().createMediaStreamDestination();
      // Pitch is applied per-stem via GrainPlayer.detune (keeps chords/vocals coherent).
      masterEq.chain(
        ...graphicEqBands,
        denoiseHp,
        denoiseLp,
        masterCompressor,
        masterWarmth,
        masterWidener,
        masterMakeup,
        masterLimiter,
        masterOut
      );
      masterOut.connect(Tone.Destination);
      masterOut.connect(recordCompDelay);
      recordCompDelay.connect(recordDest);
      masterEqRef.current = masterEq;
      masterEqBandsRef.current = graphicEqBands;
      masterDenoiseHpRef.current = denoiseHp;
      masterDenoiseLpRef.current = denoiseLp;
      masterCompressorRef.current = masterCompressor;
      vocalGateRef.current = vocalGate;
      vocalLevelerRef.current = vocalLeveler;
      vocalDeEsserRef.current = vocalDeEsser;
      masterDelayRef.current = masterDelay;
      masterReverbRef.current = masterReverb;
      vocalReverbSendRef.current = vocalReverbSend;
      vocalDelaySendRef.current = vocalDelaySend;
      masterWarmthRef.current = masterWarmth;
      masterWidenerRef.current = masterWidener;
      masterMakeupRef.current = masterMakeup;
      masterLimiterRef.current = masterLimiter;
      masterOutRef.current = masterOut;
      recordCompDelayRef.current = recordCompDelay;
      recordDestRef.current = recordDest;

      const newPlayers = {};
      const newVolumes = {};
      const newPreFxs = {};
      const newPanners = {};
      const initVols = {};
      const initMutes = {};
      const initPans = {};
      let loadedCount = 0;

      const loadPitch = settings?.pitch ?? pitch;
      const loadTempo = settings?.tempo ?? tempo;

      const loadPromises = INSTRUMENTS.map((inst) => {
        const url = `${API_BASE_URL}/audio/${id}/${inst.id}.mp3`;
        const panNode = new Tone.Panner(0).connect(masterEq);
        const volNode = new Tone.Volume(0).connect(panNode);
        
        // Aux Sends khusus Vokal (hanya sinyal basah/gema)
        if (inst.id === 'vocals') {
          volNode.connect(vocalReverbSend);
          volNode.connect(vocalDelaySend);
        }

        const preFxNode = new Tone.Gain(1);
        
        if (inst.id === 'vocals') {
          preFxNode.connect(vocalGate);
          vocalGate.connect(vocalLeveler);
          vocalLeveler.connect(vocalDeEsser);
          vocalDeEsser.connect(volNode);
        } else {
          preFxNode.connect(volNode);
        }

        return new Promise((resolve, reject) => {
          const chainSource = new Tone.GrainPlayer({
            url,
            playbackRate: loadTempo,
            detune: loadPitch * 100,
            grainSize: grainSizeForPitch(loadPitch),
            overlap: GRAIN_OVERLAP,
            onload: () => {
              loadedCount += 1;
              setProgressText(`Memuat ${inst.label}... (${loadedCount}/${INSTRUMENTS.length})`);
              resolve();
            },
            onerror: (err) => reject(new Error(`Gagal memuat ${inst.label}: ${err?.message || 'file tidak ditemukan'}`)),
          });
          
          chainSource.connect(preFxNode);
          chainSource.sync().start(0);
          
          newPlayers[inst.id] = chainSource;
          newVolumes[inst.id] = volNode;
          newPreFxs[inst.id] = preFxNode;
          newPanners[inst.id] = panNode;
          initVols[inst.id] = 0;
          initMutes[inst.id] = false;
          initPans[inst.id] = 0;
        });
      });

      await Promise.all(loadPromises);

      playersRef.current = newPlayers;
      volumeNodesRef.current = newVolumes;
      preFxNodesRef.current = newPreFxs;
      pannerNodesRef.current = newPanners;

      setPlayers(newPlayers);
      setVolumes(initVols);
      setMutes(initMutes);
      setPans(initPans);

      if (settings) {
        applyProjectSettings(settings);
      } else {
        setEqLow(0);
        setEqMid(0);
        setEqHigh(0);
        setEqBands(flatEqBands());
        masterEqBandsRef.current.forEach((f) => { if (f?.gain) f.gain.value = 0; });
        setCompressorEnabled(false);
        setVocalLevelerEnabled(false);
        setVocalLevelerTarget(-28.0);
        setVocalDeEsserAmount(0);
        setLimiterEnabled(true);
        setNormalizeEnabled(false);
        setDenoiseEnabled(false);
        setReverbEnabled(false);
        setDelayEnabled(false);
        if (masterMakeupRef.current) masterMakeupRef.current.volume.value = STEM_MAKEUP_DB;
        if (masterLimiterRef.current) masterLimiterRef.current.threshold.value = -1;
        if (masterDenoiseHpRef.current) masterDenoiseHpRef.current.frequency.value = 20;
        if (masterDenoiseLpRef.current) masterDenoiseLpRef.current.frequency.value = 20000;
        if (masterReverbRef.current) masterReverbRef.current.wet.value = 0;
        if (masterDelayRef.current) masterDelayRef.current.wet.value = 0;
        Tone.Destination.volume.value = masterVolume;
      }

      if (newPlayers[INSTRUMENTS[0].id]?.buffer) {
        const dur = newPlayers[INSTRUMENTS[0].id].buffer.duration;
        setStemDuration(dur);
        const name = displayName || file?.name?.replace(/\.[^/.]+$/, '') || stemTrackName;
        if (name) {
          setStemTrackName(name);
          fetchStemLyrics(name, dur);
        }
      } else {
        setStemDuration(0);
      }
      setStemCurrentTime(0);
      Tone.Transport.seconds = 0;

      setStatus('ready');
      setProgressText('');
      fetchSavedProjects();
    } catch (e) {
      console.error(e);
      setStatus('error');
      setProgressText(e?.message || 'Gagal memuat audio.');
    }
  };

  const openSavedProject = async (project) => {
    try {
      await Tone.start();
    } catch (e) {
      console.warn('Tone.start failed', e);
    }

    Tone.Transport.stop();
    setIsPlaying(false);
    Object.values(playersRef.current).forEach((p) => { try { p.dispose(); } catch {} });
    Object.values(volumeNodesRef.current).forEach((v) => { try { v.dispose(); } catch {} });
    disposeMasterChain();

    resetStemLyrics();
    setFile(null);
    setOriginalUrl(null);
    setFileId(project.file_id);
    setStemTrackName(project.display_name || project.file_id);
    setStatus('loading_audio');
    setProgressText('Memuat proyek tersimpan...');

    let settings = project.settings;
    if (!settings) {
      try {
        const res = await fetch(`${API_BASE_URL}/projects/${project.file_id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          settings = data.settings;
          if (data.display_name) setStemTrackName(data.display_name);
        }
      } catch (e) {
        console.error(e);
      }
    }

    skipSettingsSaveRef.current = true;
    await loadAudioStems(project.file_id, {
      displayName: project.display_name,
      originalName: project.original_name,
      settings,
    });
    setTimeout(() => {
      skipSettingsSaveRef.current = false;
    }, 1200);
  };

  const deleteSavedProject = async (projectId) => {
    if (!window.confirm('Hapus proyek ini? Stem dan pengaturan mixer ikut terhapus.')) return;
    setDeletingProjectId(projectId);
    try {
      const res = await fetch(`${API_BASE_URL}/projects/${projectId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Gagal menghapus proyek');
      if (fileId === projectId) resetStemStudio();
      else fetchSavedProjects();
    } catch (e) {
      alert(e.message || 'Gagal menghapus proyek');
    } finally {
      setDeletingProjectId(null);
    }
  };

  useEffect(() => {
    if (token && activeTab === 'stems') {
      fetchSavedProjects();
    }
  }, [token, activeTab, fetchSavedProjects]);

  // --- Style Project Functions ---

  const renameStyleProject = async (jobId, name) => {
    const trimmed = (name || '').trim();
    if (!trimmed || !token || !jobId) return false;
    try {
      const res = await fetch(`${API_BASE_URL}/api/gear-projects/${jobId}/name`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ display_name: trimmed }),
      });
      if (!res.ok) throw new Error('Gagal menyimpan nama proyek');
      setStyleProjects((prev) => prev.map((p) =>
        p.job_id === jobId ? { ...p, display_name: trimmed } : p
      ));
      return true;
    } catch (e) {
      console.error(e);
      alert(e.message || 'Gagal menyimpan nama proyek');
      return false;
    }
  };

  const deleteStyleProject = async (jobId) => {
    if (!window.confirm('Hapus riwayat analisis gear ini?')) return;
    setDeletingStyleProjectId(jobId);
    try {
      const res = await fetch(`${API_BASE_URL}/api/gear-projects/${jobId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Gagal menghapus proyek');
      setStyleProjects((prev) => prev.filter((p) => p.job_id !== jobId));
      // If the deleted project is currently being played, clear the result
      if (styleResult && styleResult.url && styleResult.url.includes(jobId)) {
        setStyleResult(null);
      }
    } catch (e) {
      alert(e.message || 'Gagal menghapus proyek');
    } finally {
      setDeletingStyleProjectId(null);
    }
  };

  const openStyleProject = (project) => {
    if (project.result) {
      setStyleResult(project.result);
    } else {
      setStyleResult({
        url: `${API_BASE_URL}${project.result_url}`,
        name: project.filename || project.display_name,
      });
    }
    setStyleHomeMode('convert');
  };

  useEffect(() => {
    if (token && activeTab === 'style') {
      fetchStyleProjects();
    }
  }, [token, activeTab, fetchStyleProjects]);

  useEffect(() => {
    if (status !== 'ready' || !fileId) return undefined;
    if (skipSettingsSaveRef.current) return undefined;
    clearTimeout(saveSettingsTimeoutRef.current);
    saveSettingsTimeoutRef.current = setTimeout(() => saveProjectSettings(), 800);
    return () => clearTimeout(saveSettingsTimeoutRef.current);
  }, [
    status, fileId, volumes, mutes, pans, pitch, tempo,
    eqLow, eqMid, eqHigh, eqBands, compressorEnabled,
    vocalLevelerEnabled, vocalLevelerTarget, vocalDeEsserAmount,
    masterVolume, limiterEnabled, normalizeEnabled,
    denoiseEnabled, reverbEnabled, delayEnabled,
    stemLyricsOffsetMs, stemLyricsSpeedPct,
    saveProjectSettings,
  ]);

  const togglePlay = async () => {
    if (Tone.Transport.state !== 'started') {
      await Tone.start();
      // If trim is enabled and current position is outside trim range, seek to start
      if (trimEnabled && trimStart > 0) {
        const cur = Tone.Transport.seconds;
        const end = trimEnd != null ? trimEnd : stemDuration;
        if (cur < trimStart || cur >= end) {
          Tone.Transport.seconds = trimStart;
          setStemCurrentTime(trimStart);
          if (stemVideoRef.current) stemVideoRef.current.currentTime = trimStart;
        }
      }
      Tone.Transport.start();
      setIsPlaying(true);
      if (stemVideoRef.current) stemVideoRef.current.play().catch(e => console.error("Video play error:", e));
      if (micReady) startPitchCoachLoop();
    } else {
      Tone.Transport.pause();
      setIsPlaying(false);
      if (stemVideoRef.current) stemVideoRef.current.pause();
      if (!isRecordingKaraoke) {
        stopPitchCoachLoop();
        resetPitchCoachUi();
      }
    }
  };

  const handleVolumeChange = (instId, value) => {
    setVolumes(prev => ({ ...prev, [instId]: value }));
    if (!mutes[instId] && volumeNodesRef.current[instId]) {
      volumeNodesRef.current[instId].volume.value = value;
    }
  };

  const formatVolumeDb = (db) => {
    const v = Number.isFinite(db) ? db : 0;
    if (v <= -60) return '-∞';
    return `${v > 0 ? '+' : ''}${Math.round(v)}`;
  };

  const commitVolumeDb = (instId, text) => {
    const raw = String(text ?? '').trim().replace(/\s*dB\s*$/i, '').replace(',', '.');
    let next;
    if (/^-?(∞|inf|infinity)$/i.test(raw) || raw === '-') {
      next = -60;
    } else {
      const parsed = parseFloat(raw.replace(/^\+/, ''));
      if (Number.isNaN(parsed)) {
        setVolumeDbEdit({ id: null, text: '' });
        return;
      }
      next = Math.max(-60, Math.min(12, Math.round(parsed)));
    }
    handleVolumeChange(instId, next);
    setVolumeDbEdit({ id: null, text: '' });
  };

  const handlePanChange = (instId, value) => {
    setPans(prev => ({ ...prev, [instId]: value }));
    if (pannerNodesRef.current[instId]) {
      pannerNodesRef.current[instId].pan.value = value / 100; // Tone.Panner uses -1 to 1
    }
  };

  const toggleMute = (instId) => {
    setMutes(prev => {
      const isMuted = !prev[instId];
      if (volumeNodesRef.current[instId]) {
        volumeNodesRef.current[instId].mute = isMuted;
      }
      return { ...prev, [instId]: isMuted };
    });
  };

  // Pitch sekarang real-time: cukup ubah properti detune & grainSize tanpa rebuild.
  const handlePitchChange = (e) => {
    const val = parseFloat(e.target.value);
    setPitch(val);
    const cents = val * 100;
    const gs = grainSizeForPitch(val);
    Object.values(playersRef.current).forEach((p) => {
      if (!p) return;
      if (p.detune !== undefined) p.detune = cents;
      if ('grainSize' in p) p.grainSize = gs;
    });
  };

  const handleTempoChange = (e) => {
    const val = parseFloat(e.target.value);
    setTempo(val);
    Object.values(playersRef.current).forEach(p => {
      if (p && p.playbackRate !== undefined) {
        p.playbackRate = val;
      }
    });
    if (stemVideoRef.current) stemVideoRef.current.playbackRate = val;
  };

  const handleSeekStem = (e) => {
    const newTime = parseFloat(e.target.value);
    setStemCurrentTime(newTime);
    Tone.Transport.seconds = newTime;
    syncStemLyricsToTime(newTime);
    if (stemVideoRef.current) stemVideoRef.current.currentTime = newTime;
  };

  // Audio Enhancer handlers
  const handleEqLowChange = (val) => {
    setEqLow(val);
    if (masterEqRef.current) masterEqRef.current.low.value = val;
  };
  const handleEqMidChange = (val) => {
    setEqMid(val);
    if (masterEqRef.current) masterEqRef.current.mid.value = val;
  };
  const handleEqHighChange = (val) => {
    setEqHigh(val);
    if (masterEqRef.current) masterEqRef.current.high.value = val;
  };
  const handleEqBandChange = (index, val) => {
    setEqBands((prev) => {
      const next = [...prev];
      next[index] = val;
      return next;
    });
    const node = masterEqBandsRef.current[index];
    if (node?.gain) node.gain.value = val;
  };
  const handleEqBandsReset = () => {
    const flat = flatEqBands();
    setEqBands(flat);
    masterEqBandsRef.current.forEach((f) => { if (f?.gain) f.gain.value = 0; });
  };
  
  const handleAutoEq = () => {
    // Kurva "Hi-Fi / Clarity" standar mastering (Smile Curve)
    const magicCurve = [2, 3, 1, -1, -2, 0, 1, 2, 3, 2];
    setEqBands(magicCurve);
    magicCurve.forEach((val, i) => {
      const node = masterEqBandsRef.current[i];
      if (node?.gain) node.gain.value = val;
    });
  };
  const handleMasterVolumeChange = (val) => {
    setMasterVolume(val);
    Tone.Destination.volume.value = val;
  };
  const handleCompressorToggle = () => {
    setCompressorEnabled(prev => {
      const next = !prev;
      if (masterCompressorRef.current) {
        masterCompressorRef.current.threshold.value = next ? -15 : 0;
        masterCompressorRef.current.ratio.value = next ? 2.5 : 1;
      }
      return next;
    });
  };

  const toggleVocalLeveler = () => {
    setVocalLevelerEnabled(prev => {
      const next = !prev;
      if (vocalLevelerRef.current) {
        vocalLevelerRef.current.threshold.value = next ? vocalLevelerTarget : 0;
        vocalLevelerRef.current.ratio.value = next ? 4 : 1;
      }
      return next;
    });
  };

  const handleVocalLevelerTargetChange = (e) => {
    const val = parseFloat(e.target.value);
    setVocalLevelerTarget(val);
    if (vocalLevelerRef.current && vocalLevelerEnabled) {
      vocalLevelerRef.current.threshold.value = val;
    }
  };

  const handleVocalDeEsserChange = (e) => {
    const val = parseFloat(e.target.value);
    setVocalDeEsserAmount(val);
    if (vocalDeEsserRef.current) {
      vocalDeEsserRef.current.gain.value = val > 0 ? -val : 0;
    }
  };

  const handleAutoVocalProcessing = () => {
    setVocalLevelerEnabled(true);
    setVocalGateEnabled(true);
    setVocalLevelerTarget(-20.0);
    setVocalDeEsserAmount(5);
    
    if (vocalGateRef.current) {
      vocalGateRef.current.threshold = -35;
    }
    if (vocalLevelerRef.current) {
      vocalLevelerRef.current.threshold.value = -20;
      vocalLevelerRef.current.ratio.value = 4;
    }
    if (vocalDeEsserRef.current) {
      vocalDeEsserRef.current.gain.value = -5;
    }
  };

  const handleAutoBalance = () => {
    // Vokal tetap 0 dB (volume asli), instrumen pengiring diturunkan
    // agar vokal menonjol dengan jelas di atas musik.
    const targetVolumes = { vocals: 0, drums: -2, bass: -3, guitar: -4, piano: -4, other: -5 };
    const targetPans = { vocals: 0, drums: 0, bass: 0, guitar: -15, piano: 15, other: 25 };

    INSTRUMENTS.forEach(inst => {
      const vol = targetVolumes[inst.id] ?? -3;
      handleVolumeChange(inst.id, vol);
      
      const pan = targetPans[inst.id] ?? 0;
      handlePanChange(inst.id, pan);
    });
  };

  const handleLimiterToggle = () => {
    setLimiterEnabled(prev => {
      const next = !prev;
      if (masterLimiterRef.current) {
        masterLimiterRef.current.threshold.value = next ? -1 : 0;
      }
      return next;
    });
  };
  const handleNormalizeToggle = () => {
    setNormalizeEnabled(prev => {
      const next = !prev;
      if (masterMakeupRef.current) {
        masterMakeupRef.current.volume.value = next ? STEM_MAKEUP_DB : 0;
      }
      return next;
    });
  };
  const handleDenoiseToggle = () => {
    setDenoiseEnabled(prev => {
      const next = !prev;
      if (masterDenoiseHpRef.current && masterDenoiseLpRef.current) {
        masterDenoiseHpRef.current.frequency.value = next ? 90 : 20;
        masterDenoiseLpRef.current.frequency.value = next ? 12000 : 20000;
      }
      return next;
    });
  };
  const handleReverbToggle = () => {
    setReverbEnabled(prev => {
      const next = !prev;
      if (vocalReverbSendRef.current) {
        vocalReverbSendRef.current.gain.value = next ? REVERB_WET : 0;
      }
      return next;
    });
  };
  const handleDelayToggle = () => {
    setDelayEnabled(prev => {
      const next = !prev;
      if (vocalDelaySendRef.current) {
        vocalDelaySendRef.current.gain.value = next ? DELAY_WET : 0;
      }
      return next;
    });
  };
  const handleVocalGateToggle = () => {
    setVocalGateEnabled(prev => {
      const next = !prev;
      if (vocalGateRef.current) {
        vocalGateRef.current.threshold = next ? -35 : -100;
      }
      return next;
    });
  };
  const handleWarmthToggle = () => {
    setWarmthEnabled(prev => {
      const next = !prev;
      if (masterWarmthRef.current) {
        masterWarmthRef.current.wet.value = next ? 0.15 : 0;
      }
      return next;
    });
  };
  const handleWidenerToggle = () => {
    setWidenerEnabled(prev => {
      const next = !prev;
      if (masterWidenerRef.current) {
        masterWidenerRef.current.width.value = next ? 0.6 : 0;
      }
      return next;
    });
  };

  const stopKaraokeRecording = () => {
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    } catch (e) {
      console.error(e);
    }
    mediaRecorderRef.current = null;
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    setIsRecordingKaraoke(false);
    if (Tone.Transport.state === 'started') {
      Tone.Transport.pause();
      if (stemVideoRef.current) stemVideoRef.current.pause();
      setIsPlaying(false);
    }
    stopPitchCoachLoop();
    resetPitchCoachUi();
  };

  const estimateMicLatencyMs = () => {
    try {
      const ctx = Tone.getContext().rawContext;
      const baseMs = (ctx.baseLatency || 0) * 1000;
      const outMs = (ctx.outputLatency || 0) * 1000;
      // Input buffer + OS/driver cushion (voice biasanya tertinggal tanpa kompensasi)
      return Math.round(Math.min(300, Math.max(80, baseMs + outMs + 100)));
    } catch {
      return 140;
    }
  };

  const applyRecordLatencyCompensation = (ms) => {
    const clamped = Math.min(300, Math.max(0, ms));
    if (recordCompDelayRef.current) {
      recordCompDelayRef.current.delayTime.value = clamped / 1000;
    }
  };

  const enableMic = async () => {
    setMicError('');
    try {
      await Tone.start();
      if (!recordDestRef.current || !masterOutRef.current) {
        setMicError('Buka proyek studio dulu sebelum mengaktifkan mic.');
        return;
      }
      if (micRef.current) {
        setMicReady(true);
        if (Tone.Transport.state === 'started') startPitchCoachLoop();
        return;
      }
      const mic = new Tone.UserMedia();
      // Low-latency constraints: AEC/NS sering menambah delay & membuat vokal tertinggal
      await mic.open({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      });
      const micVol = new Tone.Volume(micVolume);
      const micPitchNode = new Tone.PitchShift({
        pitch: micPitch,
        windowSize: 0.08,
        delayTime: 0.03,
        feedback: 0,
        wet: Math.abs(micPitch) > 0.05 ? 1 : 0,
      });
      const micHp = new Tone.Filter({ type: 'highpass', frequency: 40, Q: 0.7 });
      const micLp = new Tone.Filter({ type: 'lowpass', frequency: 18000, Q: 0.7 });
      const micCrush = new Tone.BitCrusher({
        bits: 4,
        wet: (micCrushAmount / 100) * MIC_CRUSH_WET_MAX,
      });
      const micChorus = new Tone.Chorus({
        frequency: 1.6,
        delayTime: 3.5,
        depth: 0.55,
        wet: (micChorusAmount / 100) * MIC_CHORUS_WET_MAX,
      }).start();
      const micEcho = new Tone.FeedbackDelay({
        delayTime: MIC_ECHO_TIME,
        feedback: MIC_ECHO_FEEDBACK,
        wet: micEchoEnabled ? (micEchoAmount / 100) * MIC_ECHO_WET_MAX : 0,
      });
      const micReverb = new Tone.Freeverb({
        roomSize: 0.75,
        dampening: 3500,
        wet: (micReverbAmount / 100) * MIC_REVERB_WET_MAX,
      });

      mic.connect(micVol);
      micVol.connect(micPitchNode);
      micPitchNode.connect(micHp);
      micHp.connect(micLp);
      micLp.connect(micCrush);
      micCrush.connect(micChorus);
      micChorus.connect(micEcho);
      micEcho.connect(micReverb);
      // Monitor + rekaman lewat FX chain
      micReverb.connect(Tone.Destination);
      micReverb.connect(recordDestRef.current);

      // Pitch coach: analisa mic mentah (sebelum FX) vs stem vokal
      const micPitchAnalyser = new Tone.Analyser('waveform', 2048);
      mic.connect(micPitchAnalyser);
      micPitchAnalyserRef.current = micPitchAnalyser;

      micRef.current = mic;
      micVolRef.current = micVol;
      micEchoRef.current = micEcho;
      micFxRef.current = {
        pitch: micPitchNode,
        hp: micHp,
        lp: micLp,
        crush: micCrush,
        chorus: micChorus,
        echo: micEcho,
        reverb: micReverb,
      };
      applyMicVoiceFx({
        echoOn: micEchoEnabled,
        echo: micEchoAmount,
        reverb: micReverbAmount,
        chorus: micChorusAmount,
        pitch: micPitch,
        crush: micCrushAmount,
        filter: micFilterMode,
      });
      const estimated = estimateMicLatencyMs();
      setRecordLatencyMs(estimated);
      applyRecordLatencyCompensation(estimated);
      setMicReady(true);
      if (Tone.Transport.state === 'started') startPitchCoachLoop();
    } catch (e) {
      console.error(e);
      setMicError('Gagal mengakses microphone. Izinkan akses mic di browser/OS.');
      setMicReady(false);
    }
  };

  const disableMic = () => {
    if (isRecordingKaraoke) stopKaraokeRecording();
    stopPitchCoachLoop();
    resetPitchCoachUi();
    try { micRef.current?.close(); } catch { /* ignore */ }
    try { micRef.current?.disconnect(); } catch { /* ignore */ }
    try { micRef.current?.dispose(); } catch { /* ignore */ }
    disposeMicFxNodes();
    disposeMicPitchAnalyser();
    try { micVolRef.current?.dispose(); } catch { /* ignore */ }
    micRef.current = null;
    micVolRef.current = null;
    setMicReady(false);
  };

  const handleMicVolumeChange = (val) => {
    setMicVolume(val);
    if (micVolRef.current) micVolRef.current.volume.value = val;
  };

  const applyMicVoiceFx = ({
    echoOn = micEchoEnabled,
    echo = micEchoAmount,
    reverb = micReverbAmount,
    chorus = micChorusAmount,
    pitch = micPitch,
    crush = micCrushAmount,
    filter = micFilterMode,
  } = {}) => {
    const fx = micFxRef.current;
    if (!fx) return;

    if (fx.echo) {
      fx.echo.wet.value = echoOn ? (echo / 100) * MIC_ECHO_WET_MAX : 0;
    }
    if (fx.reverb) {
      fx.reverb.wet.value = (reverb / 100) * MIC_REVERB_WET_MAX;
    }
    if (fx.chorus) {
      fx.chorus.wet.value = (chorus / 100) * MIC_CHORUS_WET_MAX;
    }
    if (fx.crush) {
      const bits = crush > 70 ? 3 : crush > 35 ? 4 : 5;
      if (fx.crush.bits?.value !== undefined) fx.crush.bits.value = bits;
      else fx.crush.bits = bits;
      fx.crush.wet.value = (crush / 100) * MIC_CRUSH_WET_MAX;
    }
    if (fx.pitch) {
      fx.pitch.pitch = pitch;
      fx.pitch.wet.value = Math.abs(pitch) > 0.05 ? 1 : 0;
    }
    if (fx.hp && fx.lp) {
      if (filter === 'radio') {
        fx.hp.frequency.value = 650;
        fx.lp.frequency.value = 2800;
      } else if (filter === 'robot') {
        fx.hp.frequency.value = 220;
        fx.lp.frequency.value = 4200;
      } else {
        fx.hp.frequency.value = 40;
        fx.lp.frequency.value = 18000;
      }
    }
  };

  const applyMicVoicePreset = (presetId) => {
    const preset = MIC_VOICE_PRESETS[presetId];
    if (!preset) return;
    setMicVoicePreset(presetId);
    setMicEchoEnabled(preset.echoOn);
    setMicEchoAmount(preset.echo);
    setMicReverbAmount(preset.reverb);
    setMicChorusAmount(preset.chorus);
    setMicPitch(preset.pitch);
    setMicCrushAmount(preset.crush);
    setMicFilterMode(preset.filter);
    applyMicVoiceFx({
      echoOn: preset.echoOn,
      echo: preset.echo,
      reverb: preset.reverb,
      chorus: preset.chorus,
      pitch: preset.pitch,
      crush: preset.crush,
      filter: preset.filter,
    });
  };

  const markMicVoiceCustom = () => {
    if (micVoicePreset !== 'custom') setMicVoicePreset('custom');
  };

  const handleMicEchoToggle = () => {
    setMicEchoEnabled((prev) => {
      const next = !prev;
      markMicVoiceCustom();
      applyMicVoiceFx({ echoOn: next, echo: micEchoAmount });
      return next;
    });
  };

  const handleMicEchoAmountChange = (val) => {
    setMicEchoAmount(val);
    markMicVoiceCustom();
    applyMicVoiceFx({ echoOn: micEchoEnabled || val > 0, echo: val });
    if (val > 0 && !micEchoEnabled) setMicEchoEnabled(true);
  };

  const handleMicReverbAmountChange = (val) => {
    setMicReverbAmount(val);
    markMicVoiceCustom();
    applyMicVoiceFx({ reverb: val });
  };

  const handleMicChorusAmountChange = (val) => {
    setMicChorusAmount(val);
    markMicVoiceCustom();
    applyMicVoiceFx({ chorus: val });
  };

  const handleMicPitchChange = (val) => {
    setMicPitch(val);
    markMicVoiceCustom();
    applyMicVoiceFx({ pitch: val });
  };

  const handleMicCrushAmountChange = (val) => {
    setMicCrushAmount(val);
    markMicVoiceCustom();
    applyMicVoiceFx({ crush: val });
  };

  const handleRecordLatencyChange = (ms) => {
    setRecordLatencyMs(ms);
    applyRecordLatencyCompensation(ms);
  };

  const startKaraokeRecording = async () => {
    setMicError('');
    try {
      await Tone.start();
      if (!micRef.current) await enableMic();
      if (!recordDestRef.current) {
        setMicError('Bus rekaman belum siap.');
        return;
      }
      // Pastikan kompensasi delay aktif sebelum MediaRecorder jalan
      applyRecordLatencyCompensation(recordLatencyMs);
      if (recordedKaraokeUrl) {
        URL.revokeObjectURL(recordedKaraokeUrl);
        setRecordedKaraokeUrl(null);
      }
      recordedBlobRef.current = null;
      recordChunksRef.current = [];

      const stream = recordDestRef.current.stream;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || 'audio/webm';
        const blob = new Blob(recordChunksRef.current, { type });
        recordedBlobRef.current = blob;
        const url = URL.createObjectURL(blob);
        setRecordedKaraokeUrl(url);
        const base = (stemTrackName || 'karaoke').replace(/[^\w\s\-().]/g, '').trim() || 'karaoke';
        setRecordedKaraokeName(`${base} karaoke.webm`);
      };
      recorder.start(250);
      setIsRecordingKaraoke(true);
      setRecordingSeconds(0);
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds((s) => s + 1);
      }, 1000);
      startPitchCoachLoop();

      // Mulai playback dari awal / trim start
      if (Tone.Transport.state !== 'started') {
        const startAt = trimEnabled ? trimStart : 0;
        Tone.Transport.seconds = startAt;
        setStemCurrentTime(startAt);
        if (stemVideoRef.current) stemVideoRef.current.currentTime = startAt;
        await Tone.Transport.start();
        if (stemVideoRef.current) stemVideoRef.current.play().catch(() => {});
        setIsPlaying(true);
      }
    } catch (e) {
      console.error(e);
      setMicError('Gagal mulai rekaman: ' + (e.message || 'unknown'));
      setIsRecordingKaraoke(false);
    }
  };

  const downloadRecordedKaraokeLocal = () => {
    if (!recordedKaraokeUrl) return;
    const a = document.createElement('a');
    a.href = recordedKaraokeUrl;
    a.download = recordedKaraokeName || 'karaoke-recording.webm';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const exportRecordedKaraokeMp3 = async () => {
    if (!recordedBlobRef.current) {
      setMicError('Belum ada rekaman untuk diekspor.');
      return;
    }
    setIsSavingRecording(true);
    setMicError('');
    try {
      const form = new FormData();
      const base = (stemTrackName || 'karaoke').replace(/[^\w\s\-().]/g, '').trim() || 'karaoke';
      form.append('file', recordedBlobRef.current, `${base} karaoke.webm`);
      form.append('display_name', base);
      const res = await fetch(`${API_BASE_URL}/karaoke/recording`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const data = await res.json();
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.message || data.detail || 'Gagal mengekspor rekaman');
      }
      const a = document.createElement('a');
      a.href = `${API_BASE_URL}${data.download_url}`;
      a.download = data.filename || `${base} karaoke.mp3`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      console.error(e);
      setMicError(e.message || 'Gagal export MP3 rekaman');
    } finally {
      setIsSavingRecording(false);
    }
  };

  const exportMix = async () => {
    if (!fileId) return;
    setIsExporting(true);
    
    try {
      const response = await fetch(`${API_BASE_URL}/export/${fileId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          volumes: volumes,
          mutes: mutes,
          pans: pans,
          pitch: pitch,
          tempo: tempo,
          eq_low: eqLow,
          eq_mid: eqMid,
          eq_high: eqHigh,
          eq_bands: eqBands,
          compressor_enabled: compressorEnabled,
          vocal_leveler_enabled: vocalLevelerEnabled,
          vocal_leveler_target: vocalLevelerTarget,
          vocal_deesser_amount: vocalDeEsserAmount,
          master_volume: masterVolume,
          limiter_enabled: limiterEnabled,
          normalize_enabled: normalizeEnabled,
          denoise_enabled: denoiseEnabled,
          reverb_enabled: reverbEnabled,
          delay_enabled: delayEnabled,
          trim_start: trimEnabled ? trimStart : 0,
          trim_end: trimEnabled ? trimEnd : null,
          export_video: isVideoFile(stemOriginalName || file?.name),
        })
      });
      
      const data = await response.json();
      if (data.status === 'success' && data.download_url) {
        const isVideoExport = isVideoFile(stemOriginalName || file?.name);
        const exportName = data.filename || `${(stemTrackName || 'export').replace(/\.[^.]+$/i, '')} edit.${isVideoExport ? 'mp4' : 'mp3'}`;
        const a = document.createElement('a');
        a.href = `${API_BASE_URL}${data.download_url}`;
        a.download = exportName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } else {
        alert("Gagal mengekspor: " + (data.message || "Unknown error"));
      }
    } catch (e) {
      console.error(e);
      alert("Terjadi kesalahan saat mengekspor audio.");
    } finally {
      setIsExporting(false);
    }
  };

  // ============================================
  // YOUTUBE KARAOKE FUNCTIONS
  // ============================================

  const handleYtPrepare = async () => {
    if (!ytUrl.trim()) return;
    setYtStatus('preparing');
    setYtProgress(0);
    setYtError('');
    setYtTitle('');
    setYtThumbnail('');
    setYtKaraokeReady(false);
    setYtUseKaraoke(false);
    
    try {
      const res = await fetch(`${API_BASE_URL}/youtube/prepare`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ url: ytUrl, mode: ytMode })
      });
      const data = await res.json();
      
      if (res.ok) {
        setYtVideoId(data.video_id);
        setYtStatus('downloading');
        // Start polling
        pollYtStatus(data.video_id);
      } else {
        setYtStatus('error');
        setYtError(data.detail || 'Gagal memproses URL');
      }
    } catch (e) {
      setYtStatus('error');
      setYtError('Kesalahan jaringan');
    }
  };

  const pollYtStatus = (videoId) => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/youtube/status/${videoId}`);
        const data = await res.json();
        
        if (data.title) setYtTitle(data.title);
        if (data.thumbnail) setYtThumbnail(data.thumbnail);
        if (data.duration) setYtDuration(data.duration);
        if (data.youtube_id) setYtYoutubeId(data.youtube_id);
        if (data.progress !== undefined) setYtProgress(data.progress);
        
        if (data.status === 'separating') {
          setYtStatus('separating');
        } else if (data.status === 'downloading') {
          setYtStatus('downloading');
        }
        
        if (data.status === 'done') {
          clearInterval(interval);
          setYtStatus('ready');
          setYtProgress(100);
          if (data.karaoke_ready) {
            setYtKaraokeReady(true);
            setYtUseKaraoke(true);
          }
          // Setup audio with pitch shifting
          setupYtAudio(videoId, data.karaoke_ready);
        } else if (data.status === 'error') {
          clearInterval(interval);
          setYtStatus('error');
          setYtError(data.error || 'Terjadi kesalahan');
        }
      } catch (e) {
        console.error(e);
      }
    }, 1000);
  };

  const setupYtAudio = async (videoId, hasKaraoke) => {
    try {
      const audioUrl = `${API_BASE_URL}/youtube/audio/${videoId}${hasKaraoke ? '?karaoke=true' : ''}`;
      
      // Create audio element
      if (ytAudioRef.current) {
        ytAudioRef.current.pause();
        ytAudioRef.current = null;
      }
      
      const audio = new Audio();
      audio.crossOrigin = 'anonymous';
      audio.src = audioUrl;
      audio.preload = 'auto';
      
      // Setup Web Audio API for pitch shifting
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      
      audio.addEventListener('canplaythrough', () => {
        const source = audioContext.createMediaElementSource(audio);
        
        // Simple pitch shift using playback detune
        // We'll use the audio element's playbackRate combined with a compensation
        source.connect(audioContext.destination);
        
        ytAudioRef.current = audio;
        ytAudioContextRef.current = audioContext;
        ytSourceNodeRef.current = source;
        
        setYtAudioDuration(audio.duration || 0);
      }, { once: true });

      audio.addEventListener('loadedmetadata', () => {
        setYtAudioDuration(audio.duration || 0);
      });

      audio.addEventListener('ended', () => {
        setYtIsPlaying(false);
        setYtCurrentTime(0);
      });
      
      audio.load();
    } catch (e) {
      console.error('Error setting up YouTube audio:', e);
    }
  };

  const toggleYtPlay = () => {
    if (!ytAudioRef.current) return;
    
    if (ytAudioContextRef.current?.state === 'suspended') {
      ytAudioContextRef.current.resume();
    }
    
    if (ytIsPlaying) {
      ytAudioRef.current.pause();
      setYtIsPlaying(false);
    } else {
      ytAudioRef.current.play();
      setYtIsPlaying(true);
    }
  };

  // Update YouTube audio current time
  useEffect(() => {
    let animId;
    const update = () => {
      if (ytAudioRef.current && ytIsPlaying) {
        setYtCurrentTime(ytAudioRef.current.currentTime);
        animId = requestAnimationFrame(update);
      }
    };
    if (ytIsPlaying) {
      animId = requestAnimationFrame(update);
    }
    return () => cancelAnimationFrame(animId);
  }, [ytIsPlaying]);

  const handleYtSeek = (e) => {
    const newTime = parseFloat(e.target.value);
    setYtCurrentTime(newTime);
    if (ytAudioRef.current) {
      ytAudioRef.current.currentTime = newTime;
    }
  };

  const handleYtPitchChange = (newPitch) => {
    const clamped = Math.max(-12, Math.min(12, newPitch));
    setYtPitch(clamped);
    
    if (ytAudioRef.current) {
      // Use preservesPitch = false with playbackRate to shift pitch
      // Semitone to rate: rate = 2^(semitones/12)
      // But this also changes tempo. To compensate, we'd need a proper pitch shifter.
      // For simplicity, we use the Web Audio API approach:
      // We detune the audio context output.
      // Unfortunately MediaElementSource doesn't support detune directly.
      // Best approach: use playbackRate = 2^(pitch/12) which changes pitch but also tempo.
      // This is the most reliable cross-browser method.
      const rate = Math.pow(2, clamped / 12);
      ytAudioRef.current.preservesPitch = false;
      ytAudioRef.current.playbackRate = rate;
    }
  };

  const switchYtAudioSource = async (useKaraoke) => {
    if (!ytVideoId) return;
    const wasPlaying = ytIsPlaying;
    const currentTime = ytAudioRef.current?.currentTime || 0;
    
    if (ytAudioRef.current) {
      ytAudioRef.current.pause();
    }
    
    setYtUseKaraoke(useKaraoke);
    
    const audioUrl = `${API_BASE_URL}/youtube/audio/${ytVideoId}${useKaraoke ? '?karaoke=true' : ''}`;
    
    if (ytAudioRef.current) {
      ytAudioRef.current.src = audioUrl;
      ytAudioRef.current.load();
      ytAudioRef.current.addEventListener('canplaythrough', () => {
        ytAudioRef.current.currentTime = currentTime;
        // Reapply pitch
        const rate = Math.pow(2, ytPitch / 12);
        ytAudioRef.current.preservesPitch = false;
        ytAudioRef.current.playbackRate = rate;
        if (wasPlaying) {
          ytAudioRef.current.play();
          setYtIsPlaying(true);
        }
      }, { once: true });
    }
  };

  const resetYtKaraoke = () => {
    if (ytAudioRef.current) {
      ytAudioRef.current.pause();
      ytAudioRef.current = null;
    }
    if (ytAudioContextRef.current) {
      ytAudioContextRef.current.close();
      ytAudioContextRef.current = null;
    }
    setYtUrl('');
    setYtVideoId(null);
    setYtYoutubeId(null);
    setYtStatus('idle');
    setYtTitle('');
    setYtThumbnail('');
    setYtDuration(0);
    setYtProgress(0);
    setYtPitch(0);
    setYtIsPlaying(false);
    setYtCurrentTime(0);
    setYtAudioDuration(0);
    setYtKaraokeReady(false);
    setYtUseKaraoke(false);
    setYtError('');
  };

  // ============================================
  // RENDER: LICENSE GATE
  // ============================================

  if (licenseStatus === 'checking') {
    return (
      <div className="app-container">
        <div className="background-glow"></div>
        <header className="header">
          <div><h1>Jagat <span>Audio</span></h1><p>AI Stem Separation & Karaoke</p></div>
        </header>
      {token && !showAdminPanel && (
        <nav className="tab-navigation">
          <button
            className={`tab-btn ${activeTab === 'stems' ? 'active' : ''}`}
            onClick={() => setActiveTab('stems')}
          >
            <Music size={18} /> Stem Separator
          </button>
          <button
            className={`tab-btn ${activeTab === 'yt2mp3' ? 'active' : ''}`}
            onClick={() => setActiveTab('yt2mp3')}
          >
            <Download size={18} /> Web Audio Converter
          </button>
          <button
            className={`tab-btn ${activeTab === 'style' ? 'active' : ''}`}
            onClick={() => setActiveTab('style')}
          >
            <Sparkles size={18} /> AI Partitur
          </button>
          <button
            className={`tab-btn ${activeTab === 'daw' ? 'active' : ''}`}
            onClick={() => setActiveTab('daw')}
          >
            <Layers size={18} /> DAW Studio
          </button>
          <button
            className={`tab-btn ${activeTab === 'playlist' ? 'active' : ''}`}
            onClick={() => setActiveTab('playlist')}
          >
            <ListMusic size={18} /> Media Playlist
          </button>
        </nav>
      )}

        <main className="main-content">
          <div className="license-loading">
            <Loader2 size={48} className="spinner" />
            <p>Memeriksa lisensi...</p>
          </div>
        </main>
      </div>
    );
  }

  if (licenseStatus === 'invalid') {
    return (
      <div className="app-container">
        <div className="background-glow"></div>
        <header className="header">
          <div><h1>Jagat <span>Audio</span></h1><p>AI Stem Separation & Karaoke</p></div>
        </header>
      {token && !showAdminPanel && (
        <nav className="tab-navigation">
          <button
            className={`tab-btn ${activeTab === 'stems' ? 'active' : ''}`}
            onClick={() => setActiveTab('stems')}
          >
            <Music size={18} /> Stem Separator
          </button>
          <button
            className={`tab-btn ${activeTab === 'yt2mp3' ? 'active' : ''}`}
            onClick={() => setActiveTab('yt2mp3')}
          >
            <Download size={18} /> Web Audio Converter
          </button>
          <button
            className={`tab-btn ${activeTab === 'style' ? 'active' : ''}`}
            onClick={() => setActiveTab('style')}
          >
            <Sparkles size={18} /> Guitar Gear Detector
          </button>
          <button
            className={`tab-btn ${activeTab === 'daw' ? 'active' : ''}`}
            onClick={() => setActiveTab('daw')}
          >
            <Layers size={18} /> DAW Studio
          </button>
          <button
            className={`tab-btn ${activeTab === 'playlist' ? 'active' : ''}`}
            onClick={() => setActiveTab('playlist')}
          >
            <ListMusic size={18} /> Media Playlist
          </button>
        </nav>
      )}

        <main className="main-content">
          <div className="license-gate">
            <div className="license-card">
              <div className="license-shield-icon">
                <KeyRound size={36} color="#c4a7ff" />
              </div>
              <h2>Aktivasi Lisensi Diperlukan</h2>
              <p className="license-subtitle">
                Aplikasi ini memerlukan lisensi yang valid untuk digunakan. 
                Hubungi admin untuk mendapatkan file lisensi.
              </p>

              {/* Hardware ID */}
              <div className="hwid-section">
                <div className="hwid-label">
                  <Shield size={14} /> Hardware ID Anda
                </div>
                <div className="hwid-value" onClick={copyHardwareId} title="Klik untuk menyalin">
                  {hardwareId || 'Memuat...'}
                </div>
                <div className={`hwid-copy-hint ${hwidCopied ? 'hwid-copied' : ''}`}>
                  {hwidCopied ? '✓ Tersalin ke clipboard!' : '📋 Klik untuk menyalin Hardware ID'}
                </div>
              </div>

              {/* Upload License */}
              <div className="license-upload-section">
                {isActivating ? (
                  <div className="license-activating">
                    <Loader2 size={20} className="spinner" />
                    <span>Mengaktifkan lisensi...</span>
                  </div>
                ) : (
                  <div className="license-upload-area">
                    <Upload size={32} className="license-upload-icon" />
                    <h4>Upload File Lisensi (.lic)</h4>
                    <p>Seret file atau klik untuk memilih</p>
                    <input
                      type="file"
                      accept=".lic"
                      onChange={handleLicenseActivate}
                    />
                  </div>
                )}
              </div>

              {/* Status Message */}
              {licenseMessage && (
                <div className={`license-message ${licenseMessageType}`}>
                  {licenseMessageType === 'success' && <CheckCircle size={18} />}
                  {licenseMessageType === 'error' && <AlertTriangle size={18} />}
                  {licenseMessageType === 'warning' && <AlertTriangle size={18} />}
                  {licenseMessage}
                </div>
              )}
            </div>

            {/* Instructions */}
            <div className="license-steps">
              <h4>Cara Mendapatkan Lisensi</h4>
              <ol>
                <li>Salin <strong>Hardware ID</strong> di atas (klik untuk copy)</li>
                <li>Kirim Hardware ID ke admin/penjual JagatAudio</li>
                <li>Admin akan membuat file lisensi (<code>.lic</code>) untuk Anda</li>
                <li>Upload file lisensi di area upload di atas</li>
                <li>Aplikasi akan aktif secara otomatis!</li>
              </ol>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // ============================================
  // RENDER: MAIN APP (Licensed)
  // ============================================

  const isStemVideo = isVideoFile(stemOriginalName || file?.name);
  const isStudioFullPage = (activeTab === 'stems' && status === 'ready') || activeTab === 'daw';

  return (
    <div className={`app-container${isStudioFullPage ? ' app-container--studio-full' : ''}`}>
      <div className="background-glow"></div>
      
      <header className="header">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', width: '100%', maxWidth: '1000px' }}>
          <div>
            <h1>Jagat <span>Audio</span></h1>
            <p>AI Stem Separation & Karaoke{licenseInfo?.app_version ? ` • v${licenseInfo.app_version}` : ''}</p>
          </div>
        </div>
      </header>

      {/* License info — hidden by default; user can expand when needed */}
      {licenseInfo && (
        <div className="license-info-toggle-wrap">
          {!showLicenseDetails ? (
            <button
              type="button"
              className="license-info-toggle-btn"
              onClick={() => setShowLicenseDetails(true)}
              title="Lihat info"
            >
              <KeyRound size={16} />
              Info
              <ChevronDown size={16} />
            </button>
          ) : (
            <div className="license-info-card" style={{ maxWidth: '500px', width: '100%', marginBottom: '0.5rem', padding: '0.8rem 1.2rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <CheckCircle size={16} color="#2ec4b6" />
                  <span className="license-active-badge">Lisensi Aktif</span>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    {formatLicenseType(licenseInfo.license_type)}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.8rem' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: licenseInfo.days_remaining <= 30 ? '#ff9f1c' : 'var(--text-secondary)' }}>
                    <Clock size={14} color={licenseInfo.days_remaining <= 30 ? '#ff9f1c' : '#2ec4b6'} />
                    Sisa {licenseInfo.days_remaining} hari • Exp: {formatDate(licenseInfo.expiry_date)}
                  </span>
                  <button
                    type="button"
                    className="license-info-toggle-btn license-info-toggle-btn--inline"
                    onClick={() => setShowLicenseDetails(false)}
                    title="Sembunyikan info"
                  >
                    Sembunyikan
                    <ChevronUp size={16} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}


      {token && !showAdminPanel && (
        <div className={`tab-navigation-row${isStudioFullPage ? ' tab-navigation-row--studio' : ''}`}>
          {isStudioFullPage && (
            <button type="button" className="stem-menu-back-btn" onClick={() => resetStemStudio('upload')}>
              <ArrowLeft size={18} /> Menu Utama
            </button>
          )}
          <nav className="tab-navigation">
          <button
            className={`tab-btn ${activeTab === 'stems' ? 'active' : ''}`}
            onClick={() => setActiveTab('stems')}
          >
            <Music size={18} /> Stem Separator
          </button>
          <button
            className={`tab-btn ${activeTab === 'yt2mp3' ? 'active' : ''}`}
            onClick={() => setActiveTab('yt2mp3')}
          >
            <Download size={18} /> Web Audio Converter
          </button>
          <button
            className={`tab-btn ${activeTab === 'style' ? 'active' : ''}`}
            onClick={() => setActiveTab('style')}
          >
            <Sparkles size={18} /> Guitar Gear Detector
          </button>
          <button
            className={`tab-btn ${activeTab === 'daw' ? 'active' : ''}`}
            onClick={() => setActiveTab('daw')}
          >
            <Layers size={18} /> DAW Studio
          </button>
          <button
            className={`tab-btn ${activeTab === 'playlist' ? 'active' : ''}`}
            onClick={() => setActiveTab('playlist')}
          >
            <ListMusic size={18} /> Media Playlist
          </button>
        </nav>
        </div>
      )}

      <main className={`main-content${isStudioFullPage ? ' main-content--studio-full' : ''}`}>
        {showAdminPanel && isAdmin ? (
          <div className="admin-panel glass-panel animate-fade-in">
            <div className="admin-panel-header">
              <h2><Shield size={24} /> Manajemen User</h2>
              <button className="close-admin-btn" onClick={() => setShowAdminPanel(false)}><X size={20} /></button>
            </div>
            
            {adminMsg && <div className={`auth-message ${adminMsg.includes('berhasil') ? 'success' : 'error'}`}>{adminMsg}</div>}
            
            <div className="admin-toolbar">
              <button className="add-user-btn" onClick={() => { setShowAddForm(!showAddForm); setAdminMsg(''); }}>
                <Plus size={16} /> Tambah User
              </button>
            </div>
            
            {showAddForm && (
              <form className="admin-add-form" onSubmit={handleAddUser}>
                <input type="text" placeholder="Username" value={addForm.username} onChange={e => setAddForm({...addForm, username: e.target.value})} required />
                <input type="password" placeholder="Password" value={addForm.password} onChange={e => setAddForm({...addForm, password: e.target.value})} required />
                <label className="admin-checkbox">
                  <input type="checkbox" checked={addForm.is_admin} onChange={e => setAddForm({...addForm, is_admin: e.target.checked})} />
                  Admin
                </label>
                <button type="submit" className="auth-submit-btn" style={{padding: '0.6rem'}}>Simpan</button>
              </form>
            )}
            
            <div className="user-table">
              <div className="user-table-header">
                <span>ID</span>
                <span>Username</span>
                <span>Role</span>
                <span>Aksi</span>
              </div>
              {userList.map(u => (
                <div className="user-table-row" key={u.id}>
                  {editingUser === u.id ? (
                    <>
                      <span>{u.id}</span>
                      <input type="text" defaultValue={u.username} onChange={e => setEditForm({...editForm, username: e.target.value})} className="edit-input" />
                      <label className="admin-checkbox">
                        <input type="checkbox" defaultChecked={!!u.is_admin} onChange={e => setEditForm({...editForm, is_admin: e.target.checked})} />
                        Admin
                      </label>
                      <div className="row-actions">
                        <button className="save-btn" onClick={() => handleEditUser(u.id)}>Simpan</button>
                        <button className="cancel-edit-btn" onClick={() => setEditingUser(null)}>Batal</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <span>{u.id}</span>
                      <span>{u.username}</span>
                      <span className={u.is_admin ? 'role-admin' : 'role-user'}>{u.is_admin ? 'Admin' : 'User'}</span>
                      <div className="row-actions">
                        <button className="edit-btn" onClick={() => { setEditingUser(u.id); setEditForm({ username: u.username, password: '', is_admin: !!u.is_admin }); }}>
                          <Pencil size={14} />
                        </button>
                        <button className="delete-btn" onClick={() => handleDeleteUser(u.id, u.username)}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : !token ? (
          <div className="auth-card glass-panel animate-fade-in">
            <h2>{isLoginMode ? 'Masuk ke Akun Anda' : 'Daftar Akun Baru'}</h2>
            <p className="auth-subtitle">
              {isLoginMode ? 'Silakan login untuk mulai memisahkan audio.' : 'Buat akun untuk menggunakan fitur AI.'}
            </p>
            
            <form onSubmit={handleAuth} className="auth-form">
              <div className="input-group">
                <User className="input-icon" size={20} />
                <input 
                  type="text" 
                  placeholder="Username" 
                  value={authForm.username}
                  onChange={(e) => setAuthForm({...authForm, username: e.target.value})}
                  required
                />
              </div>
              {!isLoginMode && (
                <div className="input-group">
                  <Mail className="input-icon" size={20} />
                  <input 
                    type="email" 
                    placeholder="Email" 
                    value={authForm.email}
                    onChange={(e) => setAuthForm({...authForm, email: e.target.value})}
                    required
                  />
                </div>
              )}
              <div className="input-group">
                <Lock className="input-icon" size={20} />
                <input 
                  type="password" 
                  placeholder="Password" 
                  value={authForm.password}
                  onChange={(e) => setAuthForm({...authForm, password: e.target.value})}
                  required
                />
              </div>
              
              {authError && <div className={`auth-message ${authError.includes('sukses') ? 'success' : 'error'}`}>{authError}</div>}
              
              <button type="submit" className="auth-submit-btn" disabled={isAuthLoading}>
                {isAuthLoading ? <Loader2 size={20} className="spinner" /> : (isLoginMode ? 'Sign In' : 'Sign Up')}
              </button>
            </form>
            
            <p className="auth-toggle">
              {isLoginMode ? 'Belum punya akun? ' : 'Sudah punya akun? '}
              <button type="button" onClick={() => {setIsLoginMode(!isLoginMode); setAuthError('');}}>
                {isLoginMode ? 'Daftar Sekarang' : 'Login di Sini'}
              </button>
            </p>
          </div>
        ) : activeTab === 'stems' ? (
          <>
            {status === 'idle' && (
          <div className="stem-home-layout">
          <div className="stem-home-tabs">
            <button
              type="button"
              className={`stem-home-tab ${stemHomeMode === 'upload' ? 'active' : ''}`}
              onClick={() => setStemHomeMode('upload')}
            >
              <Upload size={18} /> Upload Baru
            </button>
            <button
              type="button"
              className={`stem-home-tab ${stemHomeMode === 'projects' ? 'active' : ''}`}
              onClick={() => setStemHomeMode('projects')}
            >
              <FolderOpen size={18} /> Proyek Tersimpan
              {savedProjects.length > 0 && (
                <span className="stem-home-tab-badge">{savedProjects.length}</span>
              )}
            </button>
          </div>

          {stemHomeMode === 'upload' ? (
          <div className="upload-card">
            <div className="upload-area">
              <Upload size={48} className="upload-icon" />
              <h3>Unggah Lagu atau Video</h3>
              <p>Format MP3, WAV, dan Video (MP4) didukung. File akan diproses dengan AI Demucs.</p>
              <label className="upload-btn">
                Pilih File
                <input 
                  type="file" 
                  accept="audio/mp3,audio/mpeg,audio/wav,video/mp4,video/quicktime,video/x-msvideo,video/webm,.mp3,.wav,.mp4,.mov,.avi,.mkv,.webm" 
                  onChange={handleFileSelect} 
                  hidden 
                />
              </label>
            </div>
          </div>
          ) : (
          <div className="saved-projects-card glass-panel">
            <div className="saved-projects-header">
              <div>
                <h3><FolderOpen size={22} style={{ verticalAlign: 'middle', marginRight: '8px' }} />Proyek Tersimpan</h3>
                <p>Klik nama lagu untuk buka mixer — tanpa pemisahan ulang.</p>
              </div>
              <button type="button" className="saved-projects-refresh" onClick={fetchSavedProjects} disabled={projectsLoading} title="Muat ulang daftar">
                <RefreshCw size={18} className={projectsLoading ? 'spinner' : ''} />
              </button>
            </div>

            {projectsLoading && savedProjects.length === 0 ? (
              <div className="saved-projects-empty"><Loader2 size={28} className="spinner" /> Memuat proyek...</div>
            ) : savedProjects.length === 0 ? (
              <div className="saved-projects-empty">
                Belum ada proyek tersimpan.
                <button type="button" className="upload-projects-btn upload-projects-btn--compact" onClick={() => setStemHomeMode('upload')}>
                  <Upload size={16} /> Upload lagu baru
                </button>
              </div>
            ) : (
              <ul className="saved-projects-list">
                {savedProjects.map((project) => (
                  <li key={project.file_id} className="saved-project-item">
                    {editingProjectNameId === project.file_id ? (
                      <form
                        className="saved-project-rename-form"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const ok = await saveProjectName(project.file_id, projectNameDraft);
                          if (ok) setEditingProjectNameId(null);
                        }}
                      >
                        <input
                          type="text"
                          className="saved-project-rename-input"
                          value={projectNameDraft}
                          onChange={(e) => setProjectNameDraft(e.target.value)}
                          maxLength={120}
                          autoFocus
                          placeholder="Nama proyek"
                        />
                        <button type="submit" className="saved-project-rename-save" title="Simpan nama">
                          <CheckCircle size={16} />
                        </button>
                        <button
                          type="button"
                          className="saved-project-rename-cancel"
                          onClick={() => setEditingProjectNameId(null)}
                          title="Batal"
                        >
                          <X size={16} />
                        </button>
                      </form>
                    ) : (
                      <>
                        <button type="button" className="saved-project-open" onClick={() => openSavedProject(project)}>
                          <Music size={20} />
                          <div className="saved-project-info">
                            <strong>{project.display_name || project.file_id}</strong>
                            <span>{formatProjectDate(project.separated_at || project.created_at)}</span>
                          </div>
                        </button>
                        <button
                          type="button"
                          className="saved-project-edit"
                          onClick={() => {
                            setEditingProjectNameId(project.file_id);
                            setProjectNameDraft(project.display_name || project.file_id);
                          }}
                          title="Ubah nama proyek"
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          type="button"
                          className="saved-project-delete"
                          onClick={() => deleteSavedProject(project.file_id)}
                          disabled={deletingProjectId === project.file_id}
                          title="Hapus proyek"
                        >
                          {deletingProjectId === project.file_id ? <Loader2 size={16} className="spinner" /> : <Trash2 size={16} />}
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          )}
          </div>
        )}

        {status === 'selected' && (
          <div className="preview-card glass-panel animate-fade-in">
            <div className="preview-header">
              <Music size={40} className="preview-icon" />
              <div className="file-info">
                <h3>{file?.name}</h3>
                <p>{(file?.size / (1024 * 1024)).toFixed(2)} MB</p>
              </div>
            </div>

            <div className="original-player">
              {isVideoFile(file?.name) ? (
                <div style={{ marginBottom: '1rem', textAlign: 'center' }}>
                  <video
                    ref={originalAudioRef}
                    src={originalUrl}
                    onTimeUpdate={() => setAudioCurrentTime(originalAudioRef.current?.currentTime || 0)}
                    onLoadedMetadata={() => setAudioDuration(originalAudioRef.current?.duration || 0)}
                    onEnded={() => setOriginalPlaying(false)}
                    style={{ width: '100%', maxHeight: '300px', borderRadius: '12px', backgroundColor: '#000' }}
                  />
                </div>
              ) : (
                <audio
                  ref={originalAudioRef}
                  src={originalUrl}
                  onTimeUpdate={() => setAudioCurrentTime(originalAudioRef.current?.currentTime || 0)}
                  onLoadedMetadata={() => setAudioDuration(originalAudioRef.current?.duration || 0)}
                  onEnded={() => setOriginalPlaying(false)}
                />
              )}
              
              <button 
                className="original-play-btn" 
                onClick={() => {
                  if (originalPlaying) {
                    originalAudioRef.current?.pause();
                    setOriginalPlaying(false);
                  } else {
                    originalAudioRef.current?.play();
                    setOriginalPlaying(true);
                  }
                }}
              >
                {originalPlaying ? <Pause size={20} /> : <Play size={20} />}
              </button>

              <div className="original-timeline">
                <span className="time-display">{formatTime(audioCurrentTime)}</span>
                <input 
                  type="range" 
                  min="0" 
                  max={audioDuration || 100} 
                  step="0.1"
                  value={audioCurrentTime} 
                  onChange={(e) => {
                    const newTime = parseFloat(e.target.value);
                    setAudioCurrentTime(newTime);
                    if (originalAudioRef.current) {
                      originalAudioRef.current.currentTime = newTime;
                    }
                  }} 
                  className="original-slider" 
                />
                <span className="time-display">{formatTime(audioDuration)}</span>
              </div>
            </div>

            <div className="project-name-field">
              <label htmlFor="project-display-name">Nama Proyek</label>
              <input
                id="project-display-name"
                type="text"
                className="project-name-input"
                value={stemTrackName}
                onChange={(e) => setStemTrackName(e.target.value)}
                maxLength={120}
                placeholder="Contoh: Bon Jovi - Its My Life"
              />
              <p className="project-name-hint">Nama ini disimpan otomatis ke daftar Proyek Tersimpan.</p>
            </div>

            <div className="preview-actions">
              <button className="cancel-btn" onClick={() => {
                if (originalAudioRef.current) {
                  originalAudioRef.current.pause();
                }
                setFile(null);
                setOriginalUrl(null);
                setStatus('idle');
              }}>
                <RefreshCw size={16} /> Pilih Ulang
              </button>
              
              <button className="process-btn" onClick={startSeparation}>
                <Sparkles size={18} /> Mulai Pemisahan
              </button>
              


              <button 
                className="process-btn" 
                style={{ backgroundColor: '#ff9f1c', marginLeft: '10px' }} 
                onClick={handleOpenSearchModal}
              >
                <Search size={18} /> Cari Tab Online
              </button>
            </div>
          </div>
        )}

        {(status === 'uploading' || status === 'processing' || status === 'loading_audio') && (
          <div className="loading-card glass-panel">
            <Loader2 size={48} className="spinner" />
            
            {status === 'uploading' && (
              <>
                <h3>Mengunggah Lagu...</h3>
                <p className="progress-text">{progressText}</p>
              </>
            )}

            {status === 'processing' && (
              <>
                <h3>Memisahkan Audio</h3>
                <p className="progress-text">Teknologi Demucs HT Demucs 6-Stems sedang berjalan.</p>
                
                <div className="progress-section">
                  <div className="progress-info">
                    <span className="progress-percent">{progress}% Selesai</span>
                    <span className="progress-eta">Sisa waktu: {eta}</span>
                  </div>
                  <div className="progress-bar-container">
                    <div 
                      className="progress-bar-fill" 
                      style={{ width: `${progress}%` }}
                    ></div>
                  </div>
                  {progress >= 100 && (
                    <div style={{ marginTop: '15px', color: '#ff9f1c', fontWeight: 'bold', textAlign: 'center', animation: 'pulse 1.5s infinite' }}>
                      Mohon Tunggu Sampai Proses Selesai...
                    </div>
                  )}
                </div>

                <div className="processing-steps">
                  <div className={`step ${progress >= 10 ? 'active' : ''}`}>1. Inisialisasi Model AI Demucs (6 Stems)</div>
                  <div className={`step ${progress >= 30 ? 'active' : ''}`}>2. Mengurai Frekuensi Audio</div>
                  <div className={`step ${progress >= 60 ? 'active' : ''}`}>3. Memisahkan Vokal, Drum, Bass & Gitar</div>
                  <div className={`step ${progress >= 90 ? 'active' : ''}`}>4. Mengekstrak Piano & Instrumen Lainnya</div>
                </div>
              </>
            )}
            


            {status === 'loading_audio' && (
              <>
                <h3>Memuat Hasil Pemisahan...</h3>
                <p className="progress-text">{progressText}</p>
              </>
            )}
          </div>
        )}

        {status === 'error' && (
          <div className="upload-card" style={{ borderColor: '#ff477e' }}>
            <h3 style={{ color: '#ff477e' }}>Gagal Memproses</h3>
            <p>{progressText}</p>
            <button className="upload-btn" onClick={() => { setStatus('idle'); setProgressText(''); }}>Coba Lagi</button>
          </div>
        )}

        {status === 'ready' && (
          <div className="stem-studio-layout">
          <div className="studio-container">
            {stemOriginalName && /\.(mp4|mov|avi|mkv|webm)$/i.test(stemOriginalName) && (
              <div className="video-container glass-panel" style={{ marginBottom: '1.5rem', textAlign: 'center', padding: '1rem' }}>
                <video 
                  ref={stemVideoRef} 
                  src={`${API_BASE_URL}/media/${fileId}`} 
                  muted 
                  playsInline
                  style={{ width: '100%', maxHeight: '400px', borderRadius: '12px', backgroundColor: '#000' }}
                />
              </div>
            )}
            <div className="master-controls glass-panel">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%' }}>
                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button className={`play-btn ${isPlaying ? 'playing' : ''}`} onClick={togglePlay}>
                      {isPlaying ? <Pause size={32} /> : <Play size={32} />}
                    </button>
                    <button className="process-btn" onClick={exportMix} disabled={isExporting} style={{ padding: '0.8rem 1.5rem', borderRadius: '12px' }}>
                      {isExporting ? <Loader2 size={20} className="spinner" /> : <Download size={20} />}
                      <span style={{ marginLeft: '8px' }}>{isExporting ? 'Mengekspor...' : (isStemVideo ? 'Export MP4' : 'Export Media')}</span>
                    </button>
                    <button 
                      className={`process-btn trim-toggle-btn ${trimEnabled ? 'active' : ''}`}
                      onClick={() => {
                        const next = !trimEnabled;
                        setTrimEnabled(next);
                        if (next && trimEnd == null && stemDuration > 0) {
                          setTrimEnd(stemDuration);
                        }
                      }}
                      style={{ 
                        padding: '0.8rem 1.5rem', borderRadius: '12px',
                        background: trimEnabled ? 'linear-gradient(135deg, #ff477e, #ff9f1c)' : undefined,
                      }}
                    >
                      <Scissors size={20} />
                      <span style={{ marginLeft: '8px' }}>{trimEnabled ? 'Trim ON' : 'Potong Lagu'}</span>
                    </button>
                  </div>
                  <div className="global-sliders" style={{ margin: 0 }}>
                    <div className="slider-group">
                      <label>Pitch: {pitch > 0 ? '+' : ''}{pitch} Semitones</label>
                      <input type="range" min="-12" max="12" step="1" value={pitch} onChange={handlePitchChange} className="accent-slider" />
                    </div>
                    
                    <div className="slider-group">
                      <label>Tempo: {Math.round(tempo * 100)}%</label>
                      <input type="range" min="0.5" max="1.5" step="0.05" value={tempo} onChange={handleTempoChange} className="accent-slider" />
                    </div>
                  </div>
                </div>

                <div className="original-timeline" style={{ marginTop: '0.5rem' }}>
                  <span className="time-display">{formatTime(stemCurrentTime)}</span>
                  <input 
                    type="range" 
                    min="0" 
                    max={stemDuration || 100} 
                    step="0.1"
                    value={stemCurrentTime} 
                    onChange={handleSeekStem} 
                    className="original-slider" 
                  />
                  <span className="time-display">{formatTime(stemDuration)}</span>
                </div>

                {/* Karaoke Mic Recording */}
                <div className="karaoke-record-panel">
                  <div className="karaoke-record-header">
                    <Mic size={18} color={isRecordingKaraoke ? '#ff477e' : '#c4a7ff'} />
                    <strong>Rekaman Karaoke</strong>
                    {isRecordingKaraoke && (
                      <span className="karaoke-record-live">
                        <Circle size={10} fill="#ff477e" color="#ff477e" /> REC {formatTime(recordingSeconds)}
                      </span>
                    )}
                  </div>
                  <p className="karaoke-record-hint">
                    Aktifkan mic, mute channel Vokal, lalu rekam. Pakai headset agar tidak feedback.
                    Jika vokal di export masih tertinggal, naikkan <strong>Sync delay</strong>.
                  </p>
                  <div className="karaoke-record-controls">
                    {!micReady ? (
                      <button type="button" className="process-btn karaoke-mic-btn" onClick={enableMic}>
                        <Mic size={18} />
                        <span>Aktifkan Mic</span>
                      </button>
                    ) : (
                      <button type="button" className="process-btn karaoke-mic-btn active" onClick={disableMic}>
                        <Mic size={18} />
                        <span>Mic ON</span>
                      </button>
                    )}
                    <div className="karaoke-mic-vol">
                      <label>Mic Vol</label>
                      <input
                        type="range"
                        min="-24"
                        max="12"
                        step="1"
                        value={micVolume}
                        disabled={!micReady}
                        onChange={(e) => handleMicVolumeChange(parseFloat(e.target.value))}
                        className="accent-slider"
                      />
                      <span>{micVolume > 0 ? '+' : ''}{micVolume} dB</span>
                    </div>
                    <div className="karaoke-mic-vol">
                      <label>Sync delay</label>
                      <input
                        type="range"
                        min="0"
                        max="300"
                        step="10"
                        value={recordLatencyMs}
                        onChange={(e) => handleRecordLatencyChange(parseFloat(e.target.value))}
                        className="accent-slider"
                        title="Geser naik jika vokal tertinggal di hasil rekaman"
                      />
                      <span>{recordLatencyMs} ms</span>
                    </div>
                    {!isRecordingKaraoke ? (
                      <button
                        type="button"
                        className="process-btn karaoke-rec-btn"
                        onClick={startKaraokeRecording}
                        disabled={status !== 'ready'}
                      >
                        <Circle size={16} fill="#ff477e" color="#ff477e" />
                        <span>Mulai Rekam</span>
                      </button>
                    ) : (
                      <button type="button" className="process-btn karaoke-stop-btn" onClick={stopKaraokeRecording}>
                        <Square size={16} fill="#fff" />
                        <span>Stop</span>
                      </button>
                    )}
                  </div>

                  <div className={`karaoke-pitch-coach ${micReady ? '' : 'disabled'}`}>
                    <div className="karaoke-pitch-coach-header">
                      <Music size={16} color="#2ec4b6" />
                      <strong>Pitch Coach</strong>
                      <span className={`karaoke-pitch-status karaoke-pitch-status--${pitchCoachStatus}`}>
                        {pitchCoachStatus === 'ok' && 'Pas ✓'}
                        {pitchCoachStatus === 'high' && 'Terlalu tinggi ↑'}
                        {pitchCoachStatus === 'low' && 'Terlalu rendah ↓'}
                        {pitchCoachStatus === 'quiet' && 'Nyanyikan / putar lagu'}
                        {pitchCoachStatus === 'idle' && (micReady ? 'Putar lagu untuk mulai' : 'Aktifkan mic dulu')}
                      </span>
                    </div>
                    <div className="karaoke-pitch-meter" aria-hidden="true">
                      <div className="karaoke-pitch-meter-track">
                        <div className="karaoke-pitch-meter-center" />
                        <div
                          className={`karaoke-pitch-meter-needle karaoke-pitch-meter-needle--${pitchCoachStatus}`}
                          style={{
                            left: `${Math.min(100, Math.max(0, 50 + (pitchCoachCents / 600) * 50))}%`,
                          }}
                        />
                      </div>
                      <div className="karaoke-pitch-meter-labels">
                        <span>Rendah</span>
                        <span>Pas</span>
                        <span>Tinggi</span>
                      </div>
                    </div>
                    <div className="karaoke-pitch-notes">
                      <span>Mic: <strong>{pitchCoachMicNote}</strong></span>
                      <span>
                        {pitchCoachStatus === 'ok' || pitchCoachStatus === 'high' || pitchCoachStatus === 'low'
                          ? `${pitchCoachCents >= 0 ? '+' : ''}${(pitchCoachCents / 100).toFixed(1)} semitone`
                          : '—'}
                      </span>
                      <span>Vokal: <strong>{pitchCoachVocalNote}</strong></span>
                    </div>
                    <p className="karaoke-pitch-hint">
                      Bandingkan nada mic dengan stem vokal (oktaf diabaikan). Mute vokal tetap bisa — analisa dari sinyal internal.
                    </p>
                  </div>

                  <div className={`karaoke-voice-fx ${micReady ? '' : 'disabled'}`}>
                    <div className="karaoke-voice-fx-header">
                      <Sparkles size={16} color="#c4a7ff" />
                      <strong>Voice Effect</strong>
                      <span className="karaoke-voice-fx-badge">
                        {micVoicePreset === 'custom'
                          ? 'Custom'
                          : (MIC_VOICE_PRESETS[micVoicePreset]?.label || 'Natural')}
                      </span>
                    </div>
                    <p className="karaoke-voice-fx-hint">
                      Efek hanya untuk suara mic (monitor + rekaman). Pitch besar bisa menambah latency.
                    </p>
                    <div className="karaoke-voice-presets">
                      {Object.entries(MIC_VOICE_PRESETS).map(([id, preset]) => (
                        <button
                          key={id}
                          type="button"
                          className={`karaoke-voice-preset-btn ${micVoicePreset === id ? 'active' : ''}`}
                          disabled={!micReady}
                          onClick={() => applyMicVoicePreset(id)}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                    <div className="karaoke-voice-sliders">
                      <div className="karaoke-mic-vol">
                        <label>Reverb</label>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          step="5"
                          value={micReverbAmount}
                          disabled={!micReady}
                          onChange={(e) => handleMicReverbAmountChange(parseFloat(e.target.value))}
                          className="accent-slider"
                        />
                        <span>{micReverbAmount}%</span>
                      </div>
                      <div className="karaoke-mic-vol">
                        <label>Echo</label>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          step="5"
                          value={micEchoAmount}
                          disabled={!micReady}
                          onChange={(e) => handleMicEchoAmountChange(parseFloat(e.target.value))}
                          className="accent-slider"
                        />
                        <span>{micEchoEnabled || micEchoAmount > 0 ? `${micEchoAmount}%` : 'OFF'}</span>
                      </div>
                      <div className="karaoke-mic-vol">
                        <label>Chorus</label>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          step="5"
                          value={micChorusAmount}
                          disabled={!micReady}
                          onChange={(e) => handleMicChorusAmountChange(parseFloat(e.target.value))}
                          className="accent-slider"
                        />
                        <span>{micChorusAmount}%</span>
                      </div>
                      <div className="karaoke-mic-vol">
                        <label>Pitch</label>
                        <input
                          type="range"
                          min="-8"
                          max="8"
                          step="1"
                          value={micPitch}
                          disabled={!micReady}
                          onChange={(e) => handleMicPitchChange(parseFloat(e.target.value))}
                          className="accent-slider"
                        />
                        <span>{micPitch > 0 ? `+${micPitch}` : micPitch}</span>
                      </div>
                      <div className="karaoke-mic-vol">
                        <label>Robot</label>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          step="5"
                          value={micCrushAmount}
                          disabled={!micReady}
                          onChange={(e) => handleMicCrushAmountChange(parseFloat(e.target.value))}
                          className="accent-slider"
                        />
                        <span>{micCrushAmount > 0 ? `${micCrushAmount}%` : 'OFF'}</span>
                      </div>
                      <div className="karaoke-voice-echo-toggle">
                        <button
                          type="button"
                          className={`karaoke-echo-btn ${micEchoEnabled ? 'active' : ''}`}
                          onClick={handleMicEchoToggle}
                          disabled={!micReady}
                          title="Nyala/mati echo mic"
                        >
                          Echo {micEchoEnabled ? 'ON' : 'OFF'}
                        </button>
                        <button
                          type="button"
                          className={`karaoke-echo-btn ${micFilterMode === 'radio' ? 'active' : ''}`}
                          disabled={!micReady}
                          onClick={() => {
                            const next = micFilterMode === 'radio' ? 'none' : 'radio';
                            setMicFilterMode(next);
                            markMicVoiceCustom();
                            applyMicVoiceFx({ filter: next });
                          }}
                          title="Efek radio/telephone"
                        >
                          Radio {micFilterMode === 'radio' ? 'ON' : 'OFF'}
                        </button>
                      </div>
                    </div>
                  </div>
                  {micError && <p className="karaoke-record-error">{micError}</p>}
                  {recordedKaraokeUrl && (
                    <div className="karaoke-record-result">
                      <audio src={recordedKaraokeUrl} controls style={{ width: '100%' }} />
                      <div className="karaoke-record-actions">
                        <button type="button" className="process-btn" onClick={downloadRecordedKaraokeLocal}>
                          <Download size={16} />
                          <span>Unduh WebM</span>
                        </button>
                        <button
                          type="button"
                          className="process-btn"
                          onClick={exportRecordedKaraokeMp3}
                          disabled={isSavingRecording}
                        >
                          {isSavingRecording ? <Loader2 size={16} className="spinner" /> : <Download size={16} />}
                          <span>{isSavingRecording ? 'Mengonversi...' : 'Export MP3'}</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Trim Controls Panel */}
                {trimEnabled && stemDuration > 0 && (
                  <div className="trim-controls glass-panel">
                    <div className="trim-header">
                      <Scissors size={16} color="#ff477e" />
                      <span>Potong Lagu</span>
                      <button 
                        className="trim-reset-btn"
                        onClick={() => { setTrimStart(0); setTrimEnd(stemDuration); }}
                        title="Reset ke full"
                      >
                        <RotateCcw size={14} /> Reset
                      </button>
                    </div>
                    <div className="trim-range-container">
                      <div 
                        className="trim-highlight"
                        style={{
                          left: `${(trimStart / stemDuration) * 100}%`,
                          width: `${(((trimEnd ?? stemDuration) - trimStart) / stemDuration) * 100}%`,
                        }}
                      />
                      <input
                        type="range"
                        min="0"
                        max={stemDuration}
                        step="0.1"
                        value={trimStart}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          if (v < (trimEnd ?? stemDuration)) setTrimStart(v);
                        }}
                        className="trim-range-slider trim-start"
                      />
                      <input
                        type="range"
                        min="0"
                        max={stemDuration}
                        step="0.1"
                        value={trimEnd ?? stemDuration}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          if (v > trimStart) setTrimEnd(v);
                        }}
                        className="trim-range-slider trim-end"
                      />
                    </div>
                    <div className="trim-time-inputs">
                      <div className="trim-time-field">
                        <label>Mulai</label>
                        <input
                          type="text"
                          value={formatTime(trimStart)}
                          onChange={(e) => {
                            const parts = e.target.value.split(':');
                            if (parts.length === 2) {
                              const secs = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
                              if (!isNaN(secs) && secs >= 0 && secs < (trimEnd ?? stemDuration)) setTrimStart(secs);
                            }
                          }}
                          className="trim-time-input"
                        />
                      </div>
                      <div className="trim-duration-label">
                        Durasi: {formatTime((trimEnd ?? stemDuration) - trimStart)}
                      </div>
                      <div className="trim-time-field">
                        <label>Akhir</label>
                        <input
                          type="text"
                          value={formatTime(trimEnd ?? stemDuration)}
                          onChange={(e) => {
                            const parts = e.target.value.split(':');
                            if (parts.length === 2) {
                              const secs = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
                              if (!isNaN(secs) && secs > trimStart && secs <= stemDuration) setTrimEnd(secs);
                            }
                          }}
                          className="trim-time-input"
                        />
                      </div>
                    </div>
                    <button 
                      className="process-btn trim-export-btn"
                      onClick={exportMix}
                      disabled={isExporting}
                      style={{ 
                        width: '100%', marginTop: '0.75rem', padding: '0.7rem',
                        borderRadius: '10px',
                        background: 'linear-gradient(135deg, #ff477e, #ff9f1c)',
                        fontWeight: 700,
                      }}
                    >
                      {isExporting ? <Loader2 size={18} className="spinner" /> : <Download size={18} />}
                      <span style={{ marginLeft: '8px' }}>
                        {isExporting ? 'Mengekspor...' : `Simpan Potongan (${formatTime(trimStart)} - ${formatTime(trimEnd ?? stemDuration)})`}
                      </span>
                    </button>
                  </div>
                )}

              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '2rem', marginBottom: '1.2rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <ListMusic size={22} color="var(--text-primary)" />
                <h3 style={{ margin: 0, fontSize: '1.2rem', color: 'var(--text-primary)' }}>Mixer Instrumen</h3>
              </div>
              <button 
                onClick={handleAutoBalance}
                title="Atur volume & pan instrumen secara otomatis agar seimbang"
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                  padding: '0.5rem 1rem', borderRadius: '8px', border: 'none',
                  background: 'linear-gradient(135deg, #06d6a0, #118ab2)', color: '#fff',
                  cursor: 'pointer', fontSize: '0.85rem', fontWeight: 700,
                  boxShadow: '0 4px 15px rgba(6, 214, 160, 0.3)',
                  transition: 'transform 0.2s'
                }}
                onMouseOver={(e) => { e.currentTarget.style.transform = 'scale(1.05)'; }}
                onMouseOut={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
              >
                <Sparkles size={16} /> Auto Balance
              </button>
            </div>

            <div className="mixer-grid">
              {INSTRUMENTS.map(inst => (
                <div className="mixer-channel glass-panel" key={inst.id} style={{ '--theme-color': inst.color }}>
                  <div className="channel-header">
                    <inst.icon size={24} color={inst.color} />
                    <h4>{inst.label}</h4>
                  </div>
                  
                  <div className="slider-container">
                    <input 
                      type="range" 
                      min="-60" 
                      max="12" 
                      step="1" 
                      value={volumes[inst.id]} 
                      onChange={(e) => handleVolumeChange(inst.id, parseFloat(e.target.value))}
                      className="vertical-slider"
                      orient="vertical"
                    />
                  </div>

                  <div className="channel-db-label" style={{ color: inst.color }}>
                    <input
                      type="text"
                      inputMode="decimal"
                      className="channel-db-input"
                      title="Ketik nilai dB lalu Enter"
                      aria-label={`${inst.label} volume dB`}
                      value={
                        volumeDbEdit.id === inst.id
                          ? volumeDbEdit.text
                          : formatVolumeDb(volumes[inst.id])
                      }
                      onFocus={(e) => {
                        const text = formatVolumeDb(volumes[inst.id]);
                        setVolumeDbEdit({ id: inst.id, text: text === '-∞' ? '-60' : text.replace(/^\+/, '') });
                        e.target.select();
                      }}
                      onChange={(e) => setVolumeDbEdit({ id: inst.id, text: e.target.value })}
                      onBlur={(e) => {
                        if (volumeDbSkipBlurRef.current) {
                          volumeDbSkipBlurRef.current = false;
                          setVolumeDbEdit({ id: null, text: '' });
                          return;
                        }
                        commitVolumeDb(inst.id, e.target.value);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.currentTarget.blur();
                        } else if (e.key === 'Escape') {
                          volumeDbSkipBlurRef.current = true;
                          setVolumeDbEdit({ id: null, text: '' });
                          e.currentTarget.blur();
                        }
                      }}
                    />
                    <span className="db-unit">dB</span>
                  </div>

                  <div className="channel-pan-control">
                    <span className="pan-label">L</span>
                    <input
                      type="range"
                      min="-100"
                      max="100"
                      step="1"
                      value={pans[inst.id] ?? 0}
                      onChange={(e) => handlePanChange(inst.id, parseInt(e.target.value))}
                      className="pan-slider"
                      style={{ '--theme-color': inst.color }}
                    />
                    <span className="pan-label">R</span>
                  </div>
                  <div className="pan-value-label" style={{ color: inst.color }}>
                    {(pans[inst.id] ?? 0) === 0 ? 'C' : (pans[inst.id] > 0 ? `R${pans[inst.id]}` : `L${Math.abs(pans[inst.id])}`)}
                  </div>
                  
                  <div className="channel-controls">
                    <button 
                      className={`mute-btn ${mutes[inst.id] ? 'muted' : ''}`}
                      onClick={() => toggleMute(inst.id)}
                    >
                      {mutes[inst.id] ? <VolumeX size={20} /> : <Volume2 size={20} />}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Audio Enhancer / Mastering Panel */}
            <div className="audio-enhancer glass-panel" style={{ marginTop: '1.5rem', padding: '1.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.2rem' }}>
                <Sliders size={22} color="#8338ec" />
                <h3 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--text-primary)' }}>Audio Enhancer</h3>
              </div>

              <div className="enhancer-controls" style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                {/* Quick EQ + Master */}
                <div style={{ display: 'flex', gap: '1.5rem', flex: '1 1 auto' }}>
                  {/* Bass */}
                  <div className="eq-slider-group" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.4rem', flex: 1 }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Bass</label>
                    <input 
                      type="range" min="-12" max="12" step="1" 
                      value={eqLow} 
                      onChange={(e) => handleEqLowChange(parseFloat(e.target.value))} 
                      className="accent-slider eq-slider"
                      style={{ '--slider-color': '#2ec4b6' }}
                    />
                    <EditableValue
                      value={eqLow}
                      min={-12}
                      max={12}
                      unit="dB"
                      onCommit={handleEqLowChange}
                      className="enhancer-db-value"
                      style={{ color: '#2ec4b6' }}
                      ariaLabel="Bass dB"
                    />
                  </div>
                  {/* Mid */}
                  <div className="eq-slider-group" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.4rem', flex: 1 }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Mid</label>
                    <input 
                      type="range" min="-12" max="12" step="1" 
                      value={eqMid} 
                      onChange={(e) => handleEqMidChange(parseFloat(e.target.value))} 
                      className="accent-slider eq-slider"
                      style={{ '--slider-color': '#ff9f1c' }}
                    />
                    <EditableValue
                      value={eqMid}
                      min={-12}
                      max={12}
                      unit="dB"
                      onCommit={handleEqMidChange}
                      className="enhancer-db-value"
                      style={{ color: '#ff9f1c' }}
                      ariaLabel="Mid dB"
                    />
                  </div>
                  {/* Treble */}
                  <div className="eq-slider-group" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.4rem', flex: 1 }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Treble</label>
                    <input 
                      type="range" min="-12" max="12" step="1" 
                      value={eqHigh} 
                      onChange={(e) => handleEqHighChange(parseFloat(e.target.value))} 
                      className="accent-slider eq-slider"
                      style={{ '--slider-color': '#3a86ff' }}
                    />
                    <EditableValue
                      value={eqHigh}
                      min={-12}
                      max={12}
                      unit="dB"
                      onCommit={handleEqHighChange}
                      className="enhancer-db-value"
                      style={{ color: '#3a86ff' }}
                      ariaLabel="Treble dB"
                    />
                  </div>
                  {/* Master Volume */}
                  <div className="eq-slider-group" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.4rem', flex: 1, borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: '1.5rem', marginLeft: '0.5rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Master Vol</label>
                    <input 
                      type="range" min="-60" max="12" step="1" 
                      value={masterVolume} 
                      onChange={(e) => handleMasterVolumeChange(parseFloat(e.target.value))} 
                      className="accent-slider eq-slider"
                      style={{ '--slider-color': '#f15bb5' }}
                    />
                    <EditableValue
                      value={masterVolume}
                      min={-60}
                      max={12}
                      unit="dB"
                      allowInf
                      formatDisplay={(v) => (v <= -60 ? '-∞' : `${v > 0 ? '+' : ''}${v}`)}
                      onCommit={handleMasterVolumeChange}
                      className="enhancer-db-value"
                      style={{ color: '#f15bb5' }}
                      ariaLabel="Master volume dB"
                    />
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  {/* Compressor Toggle */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Compressor</label>
                    <button 
                      onClick={handleCompressorToggle}
                      style={{
                        padding: '0.6rem 1.2rem',
                        borderRadius: '10px',
                        border: 'none',
                        cursor: 'pointer',
                        fontWeight: 700,
                        fontSize: '0.85rem',
                        transition: 'all 0.3s ease',
                        background: compressorEnabled 
                          ? 'linear-gradient(135deg, #8338ec, #ff477e)' 
                          : 'rgba(255,255,255,0.08)',
                        color: compressorEnabled ? '#fff' : 'var(--text-secondary)',
                        boxShadow: compressorEnabled ? '0 4px 15px rgba(131, 56, 236, 0.4)' : 'none'
                      }}
                    >
                      {compressorEnabled ? 'ON' : 'OFF'}
                    </button>
                  </div>
                  {/* Limiter Toggle */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Limiter</label>
                    <button 
                      onClick={handleLimiterToggle}
                      style={{
                        padding: '0.6rem 1.2rem',
                        borderRadius: '10px',
                        border: 'none',
                        cursor: 'pointer',
                        fontWeight: 700,
                        fontSize: '0.85rem',
                        transition: 'all 0.3s ease',
                        background: limiterEnabled 
                          ? 'linear-gradient(135deg, #2ec4b6, #3a86ff)' 
                          : 'rgba(255,255,255,0.08)',
                        color: limiterEnabled ? '#fff' : 'var(--text-secondary)',
                        boxShadow: limiterEnabled ? '0 4px 15px rgba(46, 196, 182, 0.35)' : 'none'
                      }}
                    >
                      {limiterEnabled ? 'ON' : 'OFF'}
                    </button>
                  </div>
                  {/* Normalize Toggle */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Normalize</label>
                    <button 
                      onClick={handleNormalizeToggle}
                      title="Naikkan volume stem agar lebih keras & konsisten"
                      style={{
                        padding: '0.6rem 1.2rem',
                        borderRadius: '10px',
                        border: 'none',
                        cursor: 'pointer',
                        fontWeight: 700,
                        fontSize: '0.85rem',
                        transition: 'all 0.3s ease',
                        background: normalizeEnabled 
                          ? 'linear-gradient(135deg, #ff9f1c, #ff477e)' 
                          : 'rgba(255,255,255,0.08)',
                        color: normalizeEnabled ? '#fff' : 'var(--text-secondary)',
                        boxShadow: normalizeEnabled ? '0 4px 15px rgba(255, 159, 28, 0.35)' : 'none'
                      }}
                    >
                      {normalizeEnabled ? 'ON' : 'OFF'}
                    </button>
                  </div>
                  {/* Denoise Toggle */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Denoise</label>
                    <button 
                      onClick={handleDenoiseToggle}
                      title="Bersihkan hiss/noise (cocok untuk rekaman / mic)"
                      style={{
                        padding: '0.6rem 1.2rem',
                        borderRadius: '10px',
                        border: 'none',
                        cursor: 'pointer',
                        fontWeight: 700,
                        fontSize: '0.85rem',
                        transition: 'all 0.3s ease',
                        background: denoiseEnabled 
                          ? 'linear-gradient(135deg, #06d6a0, #118ab2)' 
                          : 'rgba(255,255,255,0.08)',
                        color: denoiseEnabled ? '#fff' : 'var(--text-secondary)',
                        boxShadow: denoiseEnabled ? '0 4px 15px rgba(6, 214, 160, 0.35)' : 'none'
                      }}
                    >
                      {denoiseEnabled ? 'ON' : 'OFF'}
                    </button>
                  </div>
                  {/* Reverb Toggle */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Reverb</label>
                    <button 
                      onClick={handleReverbToggle}
                      title="Ruang karaoke ringan untuk vokal/instrumen"
                      style={{
                        padding: '0.6rem 1.2rem',
                        borderRadius: '10px',
                        border: 'none',
                        cursor: 'pointer',
                        fontWeight: 700,
                        fontSize: '0.85rem',
                        transition: 'all 0.3s ease',
                        background: reverbEnabled 
                          ? 'linear-gradient(135deg, #9b5de5, #f15bb5)' 
                          : 'rgba(255,255,255,0.08)',
                        color: reverbEnabled ? '#fff' : 'var(--text-secondary)',
                        boxShadow: reverbEnabled ? '0 4px 15px rgba(155, 93, 229, 0.35)' : 'none'
                      }}
                    >
                      {reverbEnabled ? 'ON' : 'OFF'}
                    </button>
                  </div>
                  {/* Delay Toggle */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Delay</label>
                    <button 
                      onClick={handleDelayToggle}
                      title="Echo ringan untuk efek karaoke"
                      style={{
                        padding: '0.6rem 1.2rem',
                        borderRadius: '10px',
                        border: 'none',
                        cursor: 'pointer',
                        fontWeight: 700,
                        fontSize: '0.85rem',
                        transition: 'all 0.3s ease',
                        background: delayEnabled 
                          ? 'linear-gradient(135deg, #00bbf9, #00f5d4)' 
                          : 'rgba(255,255,255,0.08)',
                        color: delayEnabled ? '#fff' : 'var(--text-secondary)',
                        boxShadow: delayEnabled ? '0 4px 15px rgba(0, 187, 249, 0.35)' : 'none'
                      }}
                    >
                      {delayEnabled ? 'ON' : 'OFF'}
                    </button>
                  </div>
                  {/* Analog Warmth Toggle */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Warmth</label>
                    <button 
                      onClick={handleWarmthToggle}
                      title="Saturasi analog (Tape/Tube) untuk menebalkan suara"
                      style={{
                        padding: '0.6rem 1.2rem',
                        borderRadius: '10px',
                        border: 'none',
                        cursor: 'pointer',
                        fontWeight: 700,
                        fontSize: '0.85rem',
                        transition: 'all 0.3s ease',
                        background: warmthEnabled 
                          ? 'linear-gradient(135deg, #f94144, #f3722c)' 
                          : 'rgba(255,255,255,0.08)',
                        color: warmthEnabled ? '#fff' : 'var(--text-secondary)',
                        boxShadow: warmthEnabled ? '0 4px 15px rgba(249, 65, 68, 0.35)' : 'none'
                      }}
                    >
                      {warmthEnabled ? 'ON' : 'OFF'}
                    </button>
                  </div>
                  {/* Stereo Widener Toggle */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Widener</label>
                    <button 
                      onClick={handleWidenerToggle}
                      title="Perlebar dimensi stereo agar lebih megah"
                      style={{
                        padding: '0.6rem 1.2rem',
                        borderRadius: '10px',
                        border: 'none',
                        cursor: 'pointer',
                        fontWeight: 700,
                        fontSize: '0.85rem',
                        transition: 'all 0.3s ease',
                        background: widenerEnabled 
                          ? 'linear-gradient(135deg, #4cc9f0, #4361ee)' 
                          : 'rgba(255,255,255,0.08)',
                        color: widenerEnabled ? '#fff' : 'var(--text-secondary)',
                        boxShadow: widenerEnabled ? '0 4px 15px rgba(67, 97, 238, 0.35)' : 'none'
                      }}
                    >
                      {widenerEnabled ? 'ON' : 'OFF'}
                    </button>
                  </div>
                </div>
              </div>

              {/* 10-band Graphic EQ */}
              <div className="graphic-eq-section">
                <div className="graphic-eq-header">
                  <span className="graphic-eq-title">Graphic EQ · 10 Band</span>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button type="button" className="graphic-eq-reset" onClick={handleAutoEq} title="Terapkan preset mastering (Clarity & Hi-Fi)" style={{ color: '#00bbf9', borderColor: 'rgba(0, 187, 249, 0.3)', background: 'rgba(0, 187, 249, 0.05)' }}>
                      <Sparkles size={14} /> Auto Magic
                    </button>
                    <button type="button" className="graphic-eq-reset" onClick={handleEqBandsReset} title="Reset semua band ke 0 dB">
                      <RotateCcw size={14} /> Reset
                    </button>
                  </div>
                </div>
                <div className="graphic-eq">
                  {EQ_BAND_LABELS.map((label, i) => (
                    <div key={label} className="graphic-eq-band">
                      <EditableValue
                        value={eqBands[i]}
                        min={-12}
                        max={12}
                        onCommit={(val) => handleEqBandChange(i, val)}
                        className="graphic-eq-gain graphic-eq-gain-edit"
                        ariaLabel={`EQ ${label} Hz dB`}
                      />
                      <input
                        type="range"
                        min="-12"
                        max="12"
                        step="1"
                        value={eqBands[i]}
                        onChange={(e) => handleEqBandChange(i, parseFloat(e.target.value))}
                        className="graphic-eq-slider"
                        aria-label={`EQ ${label} Hz`}
                      />
                      <span className="graphic-eq-label">{label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Vocal Processing Panel */}
            <div className="audio-enhancer glass-panel" style={{ marginTop: '1.5rem', padding: '1.5rem', borderLeft: '4px solid #ff477e' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.2rem', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <Mic2 size={22} color="#ff477e" />
                  <h3 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--text-primary)' }}>Vocal Processing</h3>
                  <span style={{ fontSize: '0.75rem', backgroundColor: '#ff477e22', color: '#ff477e', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>Khusus Stem Vokal</span>
                </div>
                
                <button 
                  onClick={handleAutoVocalProcessing}
                  title="Terapkan preset standar industri secara otomatis"
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.4rem',
                    padding: '0.4rem 0.8rem', borderRadius: '6px', border: '1px solid #ff477e',
                    background: 'rgba(255, 71, 126, 0.1)', color: '#ff477e',
                    cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600,
                    transition: 'all 0.2s'
                  }}
                  onMouseOver={(e) => { e.currentTarget.style.background = '#ff477e'; e.currentTarget.style.color = '#fff'; }}
                  onMouseOut={(e) => { e.currentTarget.style.background = 'rgba(255, 71, 126, 0.1)'; e.currentTarget.style.color = '#ff477e'; }}
                >
                  <Sparkles size={14} /> Auto Magic
                </button>
              </div>

              <div className="enhancer-controls" style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                
                {/* Noise Gate Toggle */}
                <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', background: 'rgba(255,255,255,0.03)', padding: '1rem', borderRadius: '12px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Noise Gate</label>
                    <button 
                      onClick={handleVocalGateToggle}
                      title="Matikan suara mic secara otomatis saat tidak ada vokal"
                      style={{
                        padding: '0.6rem 1.2rem',
                        borderRadius: '10px',
                        border: 'none',
                        cursor: 'pointer',
                        fontWeight: 700,
                        fontSize: '0.85rem',
                        transition: 'all 0.3s ease',
                        background: vocalGateEnabled 
                          ? 'linear-gradient(135deg, #118ab2, #06d6a0)' 
                          : 'rgba(255,255,255,0.08)',
                        color: vocalGateEnabled ? '#fff' : 'var(--text-secondary)',
                        boxShadow: vocalGateEnabled ? '0 4px 15px rgba(6, 214, 160, 0.4)' : 'none'
                      }}
                    >
                      {vocalGateEnabled ? 'ON' : 'OFF'}
                    </button>
                  </div>
                </div>

                {/* Vocal Leveler Toggle & Slider */}
                <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', background: 'rgba(255,255,255,0.03)', padding: '1rem', borderRadius: '12px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Leveler</label>
                    <button 
                      onClick={toggleVocalLeveler}
                      title="Ratakan dinamika volume vokal secara otomatis"
                      style={{
                        padding: '0.6rem 1.2rem',
                        borderRadius: '10px',
                        border: 'none',
                        cursor: 'pointer',
                        fontWeight: 700,
                        fontSize: '0.85rem',
                        transition: 'all 0.3s ease',
                        background: vocalLevelerEnabled 
                          ? 'linear-gradient(135deg, #ff477e, #ff9f1c)' 
                          : 'rgba(255,255,255,0.08)',
                        color: vocalLevelerEnabled ? '#fff' : 'var(--text-secondary)',
                        boxShadow: vocalLevelerEnabled ? '0 4px 15px rgba(255, 71, 126, 0.4)' : 'none'
                      }}
                    >
                      {vocalLevelerEnabled ? 'ON' : 'OFF'}
                    </button>
                  </div>

                  <div className="eq-slider-group" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.4rem', opacity: vocalLevelerEnabled ? 1 : 0.5, pointerEvents: vocalLevelerEnabled ? 'auto' : 'none' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Target</label>
                    <input 
                      type="range" min="-32" max="-10" step="1" 
                      value={vocalLevelerTarget} 
                      onChange={handleVocalLevelerTargetChange} 
                      className="accent-slider eq-slider"
                      style={{ '--slider-color': '#ff477e', height: '80px' }}
                    />
                    <EditableValue
                      value={vocalLevelerTarget}
                      min={-32}
                      max={-10}
                      unit="LUFS"
                      formatDisplay={(v) => String(v)}
                      onCommit={(val) => {
                        setVocalLevelerTarget(val);
                        if (vocalLevelerRef.current && vocalLevelerEnabled) {
                          vocalLevelerRef.current.threshold.value = val;
                        }
                      }}
                      className="enhancer-db-value"
                      style={{ color: '#ff477e' }}
                      ariaLabel="Vocal leveler target LUFS"
                    />
                  </div>
                </div>

                {/* De-Esser Slider */}
                <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', background: 'rgba(255,255,255,0.03)', padding: '1rem', borderRadius: '12px' }}>
                  <div className="eq-slider-group" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.4rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>De-Esser</label>
                    <input 
                      type="range" min="0" max="20" step="1" 
                      value={vocalDeEsserAmount} 
                      onChange={handleVocalDeEsserChange} 
                      className="accent-slider eq-slider"
                      style={{ '--slider-color': '#2ec4b6', height: '80px' }}
                    />
                    <EditableValue
                      value={vocalDeEsserAmount}
                      min={0}
                      max={20}
                      unit={vocalDeEsserAmount > 0 ? 'dB' : ''}
                      formatDisplay={(v) => (v > 0 ? `-${v}` : 'OFF')}
                      formatEdit={(v) => (v > 0 ? String(-v) : '0')}
                      parseInput={(raw) => {
                        const text = String(raw ?? '').trim();
                        if (!text || /^off$/i.test(text)) return 0;
                        const parsed = parseNumericInput(text, { min: -20, max: 20 });
                        if (parsed == null) return null;
                        return Math.min(20, Math.abs(parsed));
                      }}
                      onCommit={(val) => {
                        setVocalDeEsserAmount(val);
                        if (vocalDeEsserRef.current) {
                          vocalDeEsserRef.current.gain.value = val > 0 ? -val : 0;
                        }
                      }}
                      className="enhancer-db-value"
                      style={{ color: '#2ec4b6' }}
                      ariaLabel="De-Esser dB"
                    />
                  </div>
                </div>

              </div>
            </div>

          </div>

          <div className="mp3-lyrics-panel glass-panel stem-lyrics-panel">
            <h4><FileText size={18} /> Lirik Karaoke</h4>
            {stemTrackName && (
              editingStemProjectName ? (
                <form
                  className="stem-project-name-edit"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!fileId) return;
                    const ok = await saveProjectName(fileId, stemProjectNameDraft);
                    if (ok) {
                      setStemTrackName(stemProjectNameDraft.trim());
                      setEditingStemProjectName(false);
                    }
                  }}
                >
                  <input
                    type="text"
                    className="project-name-input"
                    value={stemProjectNameDraft}
                    onChange={(e) => setStemProjectNameDraft(e.target.value)}
                    maxLength={120}
                    autoFocus
                  />
                  <button type="submit" className="saved-project-rename-save" title="Simpan">
                    <CheckCircle size={14} />
                  </button>
                  <button
                    type="button"
                    className="saved-project-rename-cancel"
                    onClick={() => setEditingStemProjectName(false)}
                    title="Batal"
                  >
                    <X size={14} />
                  </button>
                </form>
              ) : (
                <div className="stem-lyrics-track-name-row">
                  <p className="stem-lyrics-track-name">{stemTrackName}</p>
                  {fileId && (
                    <button
                      type="button"
                      className="stem-project-name-edit-btn"
                      onClick={() => {
                        setStemProjectNameDraft(stemTrackName);
                        setEditingStemProjectName(true);
                      }}
                      title="Ubah nama proyek"
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                </div>
              )
            )}
            <div className="mp3-lyrics-manual-toggle">
              <button
                type="button"
                className={stemLyricsManualOpen ? 'process-btn' : 'cancel-btn'}
                onClick={() => (stemLyricsManualOpen ? setStemLyricsManualOpen(false) : openStemManualLyricsSearch())}
              >
                <Search size={14} />
                {stemLyricsManualOpen ? ' Tutup pencarian' : ' Cari Lirik Manual'}
              </button>
            </div>
            {stemLyricsManualOpen && (
              <div className="mp3-lyrics-manual">
                <div className="mp3-lyrics-manual-form">
                  <input
                    type="text"
                    placeholder="Penyanyi"
                    value={stemLyricsSearchArtist}
                    onChange={(e) => setStemLyricsSearchArtist(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && searchStemManualLyrics()}
                  />
                  <input
                    type="text"
                    placeholder="Judul lagu"
                    value={stemLyricsSearchTitle}
                    onChange={(e) => setStemLyricsSearchTitle(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && searchStemManualLyrics()}
                  />
                  <button type="button" className="process-btn" disabled={stemLyricsSearchLoading} onClick={searchStemManualLyrics}>
                    {stemLyricsSearchLoading ? <Loader2 size={14} className="spinner" /> : <Search size={14} />}
                    {stemLyricsSearchLoading ? ' Mencari...' : ' Cari'}
                  </button>
                </div>
                {stemLyricsSearchResults.length > 0 && (
                  <ul className="mp3-lyrics-search-results">
                    {stemLyricsSearchResults.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          className="mp3-lyrics-search-item"
                          disabled={stemLyricsSelectLoading === item.id}
                          onClick={() => selectStemManualLyric(item.id)}
                        >
                          <span className="mp3-lyrics-search-item-main">
                            <strong>{item.artist}</strong> — {item.title}
                          </span>
                          <span className="mp3-lyrics-search-item-meta">
                            {item.has_sync && <span className="mp3-lyrics-badge sync">LRC</span>}
                            {item.synced_lines > 0 && (
                              <span className="mp3-lyrics-badge lines">{item.synced_lines} baris</span>
                            )}
                            {item.duration > 0 && <span>{formatDurationSec(item.duration)}</span>}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {stemLyricsSearchDone && !stemLyricsSearchLoading && stemLyricsSearchResults.length === 0 && (
                  <p className="mp3-lyrics-manual-hint">Tidak ada hasil.</p>
                )}
              </div>
            )}
            {stemLyricsLoading && (
              <div className="mp3-lyrics-loading">
                <Loader2 size={24} className="spinner" />
                <p>{stemLyricsStatus || 'Memuat lirik...'}</p>
              </div>
            )}
            {!stemLyricsLoading && stemLyricsStatus && (
              <p className="mp3-lyrics-status">{stemLyricsStatus}</p>
            )}
            {stemLyrics?.type === 'lrc' && (
              <>
                <div className="mp3-lyrics-sync-control">
                  <label htmlFor="stem-lyrics-offset">
                    <Clock size={14} /> Geser waktu
                    <span className="mp3-lyrics-offset-value">
                      {stemLyricsOffsetMs > 0 ? '+' : ''}{(stemLyricsOffsetMs / 1000).toFixed(1)} dtk
                    </span>
                  </label>
                  <input
                    id="stem-lyrics-offset"
                    type="range"
                    min="-120000"
                    max="120000"
                    step="100"
                    value={Math.max(-120000, Math.min(120000, stemLyricsOffsetMs))}
                    onChange={(e) => setStemLyricsOffsetMs(parseInt(e.target.value, 10))}
                  />
                  <label htmlFor="stem-lyrics-speed" className="mp3-lyrics-speed-label">
                    <Sliders size={14} /> Kecepatan lirik
                    <span className="mp3-lyrics-offset-value">{stemLyricsSpeedPct}%</span>
                  </label>
                  <input
                    id="stem-lyrics-speed"
                    type="range"
                    min="92"
                    max="108"
                    step="1"
                    value={stemLyricsSpeedPct}
                    onChange={(e) => setStemLyricsSpeedPct(parseInt(e.target.value, 10))}
                  />
                  <p className="mp3-lyrics-sync-hint">Double-klik baris yang sedang dinyanyikan. Tempo {Math.round(tempo * 100)}% sudah dihitung otomatis. Hindari ubah kecepatan kecuali awal & akhir sama-sama meleset.</p>
                  <button
                    type="button"
                    className="cancel-btn mp3-lyrics-sync-now-btn"
                    onClick={() => syncStemLyricLineToNow(stemActiveLyricIndex >= 0 ? stemActiveLyricIndex : 0)}
                  >
                    <RotateCcw size={14} /> Baris ini = sekarang
                  </button>
                </div>
                <div className="mp3-lyrics-lines">
                  {stemLyrics.lines.map((line, i) => {
                    let lineState = 'upcoming';
                    if (i < stemActiveLyricIndex) lineState = 'past';
                    else if (i === stemActiveLyricIndex) lineState = 'active';
                    return (
                      <p
                        key={i}
                        ref={i === stemActiveLyricIndex ? stemActiveLyricRef : null}
                        className={`mp3-lyric-line mp3-lyric-line-${lineState}`}
                        style={lineState === 'active' ? { '--lyric-progress': stemLyricProgress } : undefined}
                        onDoubleClick={() => syncStemLyricLineToNow(i)}
                        title="Double-klik saat baris ini dinyanyikan"
                      >
                        {lineState === 'active' && lineHasUsableWordTimings(line) ? (
                          line.words.map((w, wi) => (
                            <span
                              key={wi}
                              className={`mp3-lyric-word${
                                wi < stemLyricWordIndex ? ' sung' : wi === stemLyricWordIndex ? ' active-word' : ''
                              }`}
                            >
                              {w.text}{wi < line.words.length - 1 ? ' ' : ''}
                            </span>
                          ))
                        ) : line.text}
                      </p>
                    );
                  })}
                </div>
              </>
            )}
            {stemLyrics?.type === 'plain' && (
              <>
                <p className="mp3-lyrics-plain-warn">Lirik tanpa timestamp — tidak bisa sinkron karaoke.</p>
                <pre className="mp3-lyrics-plain">{stemLyrics.text}</pre>
              </>
            )}
            {!stemLyrics && !stemLyricsLoading && stemLyricsNotFound && (
              <div className="mp3-lyrics-empty">
                <p>Lirik tidak ditemukan otomatis.</p>
                <button
                  type="button"
                  className="process-btn mp3-lyrics-retry-btn"
                  onClick={() => fetchStemLyrics(stemTrackName, stemDuration, { refresh: true })}
                >
                  <RefreshCw size={16} /> Cari Lagi
                </button>
              </div>
            )}
            {!stemLyrics && !stemLyricsLoading && !stemLyricsNotFound && (
              <div className="mp3-lyrics-empty">
                <p>Putar lagu — lirik akan dimuat otomatis.</p>
              </div>
            )}
          </div>

          </div>
        )}
          </>
        ) : activeTab === 'yt2mp3' ? (
          <div className="yt2mp3-container animate-fade-in">
            {yt2mp3Status === 'idle' && (
              <div className="yt-input-card glass-panel">
                <div className="yt-input-header">
                  <Download size={48} className="yt-icon" />
                  <h3>Web Audio Converter</h3>
                  <p>
                    {yt2mp3MediaType === 'mp4'
                      ? 'Cari / paste link YouTube untuk unduh video lagu / music video (MP4).'
                      : 'Paste link YouTube untuk mengunduh audio (MP3) dengan cepat.'}
                  </p>
                </div>
                <div className="yt2mp3-media-toggle" role="group" aria-label="Jenis unduhan">
                  <button
                    type="button"
                    className={`yt2mp3-media-btn ${yt2mp3MediaType === 'mp3' ? 'active' : ''}`}
                    onClick={() => { setYt2mp3MediaType('mp3'); setYt2mp3SearchResults([]); setYt2mp3Error(''); }}
                  >
                    <Music size={16} /> Audio MP3
                  </button>
                  <button
                    type="button"
                    className={`yt2mp3-media-btn ${yt2mp3MediaType === 'mp4' ? 'active' : ''}`}
                    onClick={() => { setYt2mp3MediaType('mp4'); setYt2mp3SearchResults([]); setYt2mp3Error(''); }}
                  >
                    <MonitorPlay size={16} /> Video Klip MP4
                  </button>
                </div>
                <div className="yt-url-input" style={{ display: 'flex', gap: '0.5rem', position: 'relative', width: '100%' }}>
                  <div style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
                    <input
                      type="text"
                      placeholder={yt2mp3MediaType === 'mp4'
                        ? 'Paste link ATAU ketik judul video klip... (contoh: Coldplay Yellow official video)'
                        : 'Paste link ATAU ketik judul lagu... (contoh: Coldplay Yellow)'}
                      value={yt2mp3Url}
                      onChange={(e) => setYt2mp3Url(e.target.value)}
                      style={{ flex: 1, paddingRight: '40px' }}
                    />
                    <button 
                      onClick={() => {
                        if (!('webkitSpeechRecognition' in window)) {
                          alert("Browser Anda tidak mendukung pencarian suara. Gunakan Google Chrome.");
                          return;
                        }
                        const recognition = new window.webkitSpeechRecognition();
                        recognition.lang = 'id-ID';
                        recognition.interimResults = true; // Aktifkan pengetikan real-time
                        
                        recognition.onstart = () => {
                          setIsVoiceActive(true);
                          setYt2mp3Url(""); // Kosongkan saat mulai bicara
                        };
                        
                        recognition.onresult = (event) => {
                          let interimTranscript = '';
                          for (let i = event.resultIndex; i < event.results.length; ++i) {
                            if (event.results[i].isFinal) {
                              setYt2mp3Url(event.results[i][0].transcript);
                            } else {
                              interimTranscript += event.results[i][0].transcript;
                              setYt2mp3Url(interimTranscript); // Tampilkan sementara
                            }
                          }
                        };
                        
                        recognition.onend = () => {
                          setIsVoiceActive(false);
                        };
                        
                        recognition.onerror = () => {
                          setIsVoiceActive(false);
                        };
                        
                        recognition.start();
                      }}
                      style={{ 
                        position: 'absolute', right: '10px', 
                        background: isVoiceActive ? 'rgba(255, 71, 126, 0.2)' : 'transparent', 
                        border: 'none', 
                        color: isVoiceActive ? '#fff' : '#ff477e', 
                        cursor: 'pointer', 
                        padding: '5px',
                        borderRadius: '50%',
                        transition: 'all 0.3s ease',
                        boxShadow: isVoiceActive ? '0 0 10px rgba(255, 71, 126, 0.5)' : 'none'
                      }}
                      title="Gunakan Suara"
                    >
                      <Mic size={20} />
                    </button>
                  </div>
                  <button className="yt-search-btn" style={{ flexShrink: 0 }} onClick={async () => {
                    if(!yt2mp3Url.trim()) return;
                    setYt2mp3IsSearching(true);
                    setYt2mp3SearchResults([]);
                    setYt2mp3Error('');
                    try {
                      const res = await fetch(`${API_BASE_URL}/youtube-to-mp3/search`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                        body: JSON.stringify({ query: yt2mp3Url, media_type: yt2mp3MediaType })
                      });
                      const data = await res.json();
                      if(res.ok) {
                        setYt2mp3SearchResults(data.results || []);
                      } else if (res.status === 401) {
                        handleUnauthorized();
                        setYt2mp3Error('Sesi login habis. Silakan login kembali.');
                      } else {
                        setYt2mp3Error(data.detail || 'Gagal mencari');
                      }
                    } catch(e) { setYt2mp3Error('Kesalahan jaringan saat mencari'); }
                    setYt2mp3IsSearching(false);
                  }} disabled={!yt2mp3Url.trim() || yt2mp3IsSearching}>
                    {yt2mp3IsSearching ? <Loader2 size={20} className="spinner" /> : <Search size={20} />} {yt2mp3MediaType === 'mp4' ? 'Cari Video' : 'Cari Lagu'}
                  </button>
                </div>
                {yt2mp3Error && <div className="auth-message error">{yt2mp3Error}</div>}
                
                {yt2mp3SearchResults.length > 0 && (
                  <div className="search-results-container" style={{ marginTop: '1.5rem', textAlign: 'left' }}>
                    <h4 style={{ marginBottom: '1rem', color: '#fff' }}>Hasil Pencarian:</h4>
                    {/* Hidden audio element for preview */}
                    <audio
                      ref={yt2mp3PreviewAudioRef}
                      preload="auto"
                      onTimeUpdate={(e) => setYt2mp3PreviewTime(e.target.currentTime)}
                      onLoadedMetadata={(e) => setYt2mp3PreviewDuration(e.target.duration)}
                      onEnded={(e) => { e.target.currentTime = 0; setYt2mp3PreviewPlaying(false); setYt2mp3PreviewTime(0); }}
                      onError={() => { setYt2mp3PreviewPlaying(false); setYt2mp3PreviewLoading(false); }}
                      style={{ display: 'none' }}
                    />
                    <div className="search-results-list" style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                      {yt2mp3SearchResults.map((result, idx) => {
                        const isActive = yt2mp3PreviewIdx === idx;
                        const isPlaying = isActive && yt2mp3PreviewPlaying;
                        const isLoading = isActive && yt2mp3PreviewLoading;
                        const progress = isActive && yt2mp3PreviewDuration > 0
                          ? (yt2mp3PreviewTime / yt2mp3PreviewDuration) * 100
                          : 0;
                        const fmtTime = (t) => {
                          if (!t || !isFinite(t)) return '0:00';
                          const m = Math.floor(t / 60);
                          const s = Math.floor(t % 60);
                          return `${m}:${s.toString().padStart(2, '0')}`;
                        };
                        return (
                        <div key={idx} className={`search-result-item${isActive ? ' preview-active' : ''}`}>
                          {/* Top row: play button + info + download */}
                          <div className="search-result-top-row">
                            {/* Preview Play Button */}
                            <button
                              className={`preview-play-btn${isLoading ? ' loading' : ''}${isPlaying ? ' playing' : ''}`}
                              onClick={() => handlePreviewPlay(idx)}
                              title={isPlaying ? 'Pause Preview' : 'Test Play'}
                              disabled={isLoading}
                            >
                              {isLoading ? (
                                <Loader2 size={20} className="spinner" />
                              ) : isPlaying ? (
                                <Pause size={20} />
                              ) : (
                                <Play size={20} style={{ marginLeft: '2px' }} />
                              )}
                            </button>
                            <div className="result-info" style={{ flex: 1, marginLeft: '0.8rem', marginRight: '0.8rem', overflow: 'hidden' }}>
                              <div style={{ fontWeight: 'bold', color: '#fff', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{result.title}</div>
                              <div style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)', marginTop: '4px', display: 'flex', gap: '1rem', alignItems: 'center' }}>
                                <span><Clock size={12} style={{ verticalAlign: 'middle', marginRight: '4px' }}/> {result.duration ? Math.floor(result.duration / 60) + ':' + (result.duration % 60).toString().padStart(2, '0') : '--:--'}</span>
                                <span style={{ color: result.source === 'SoundCloud' ? '#ff9f1c' : '#ff477e' }}>{result.source}</span>
                              </div>
                            </div>
                            <button className="process-btn" style={{ flexShrink: 0, width: 'auto', minWidth: '90px', padding: '0.5rem 1rem', fontSize: '0.9rem', display: 'flex', justifyContent: 'center', alignItems: 'center' }} onClick={async () => {
                              // Stop preview if playing
                              if (yt2mp3PreviewAudioRef.current) { yt2mp3PreviewAudioRef.current.pause(); yt2mp3PreviewAudioRef.current.removeAttribute('src'); yt2mp3PreviewAudioRef.current.load(); }
                              yt2mp3PreviewUrlRef.current = '';
                              setYt2mp3PreviewPlaying(false);
                              setYt2mp3PreviewIdx(-1);
                              setYt2mp3Status('preparing');
                              setYt2mp3Error('');
                              setYt2mp3Progress(0);
                              try {
                                const res = await fetch(`${API_BASE_URL}/youtube-to-mp3/prepare`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                                  body: JSON.stringify({ url: result.url, media_type: yt2mp3MediaType })
                                });
                                const data = await res.json();
                                if(res.ok) {
                                  setYt2mp3JobId(data.job_id);
                                  if (data.media_type) setYt2mp3MediaType(data.media_type);
                                  setYt2mp3Status('downloading');
                                } else {
                                  setYt2mp3Status('error'); setYt2mp3Error(data.detail || 'Gagal memproses');
                                }
                              } catch(e) { setYt2mp3Status('error'); setYt2mp3Error('Kesalahan jaringan'); }
                            }}>
                              <Download size={16} style={{ marginRight: '4px' }} /> Unduh {yt2mp3MediaType === 'mp4' ? 'MP4' : 'MP3'}
                            </button>
                          </div>
                          {/* Expanded player controls when active */}
                          {isActive && (yt2mp3PreviewUrlRef.current || isLoading) && (
                            <div className="preview-player-controls">
                              {/* Seekable progress bar */}
                              <div
                                className="preview-seekbar"
                                onClick={(e) => {
                                  const audio = yt2mp3PreviewAudioRef.current;
                                  if (!audio || !yt2mp3PreviewDuration) return;
                                  const rect = e.currentTarget.getBoundingClientRect();
                                  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                                  audio.currentTime = pct * yt2mp3PreviewDuration;
                                  setYt2mp3PreviewTime(audio.currentTime);
                                }}
                                title="Klik untuk geser posisi"
                              >
                                <div className="preview-seekbar-fill" style={{ width: `${progress}%` }}>
                                  <div className="preview-seekbar-thumb" />
                                </div>
                              </div>
                              {/* Time + Controls row */}
                              <div className="preview-controls-row">
                                <span className="preview-time">{fmtTime(yt2mp3PreviewTime)}</span>
                                <div className="preview-btns-group">
                                  {/* Back to start */}
                                  <button
                                    className="preview-ctrl-btn"
                                    title="Kembali ke awal"
                                    onClick={() => {
                                      const audio = yt2mp3PreviewAudioRef.current;
                                      if (audio) { audio.currentTime = 0; setYt2mp3PreviewTime(0); }
                                    }}
                                  >
                                    <RotateCcw size={15} />
                                  </button>
                                  {/* Skip back 10s */}
                                  <button
                                    className="preview-ctrl-btn"
                                    title="Mundur 10 detik"
                                    onClick={() => {
                                      const audio = yt2mp3PreviewAudioRef.current;
                                      if (audio) { audio.currentTime = Math.max(0, audio.currentTime - 10); setYt2mp3PreviewTime(audio.currentTime); }
                                    }}
                                  >
                                    <SkipBack size={15} />
                                  </button>
                                  {/* Play/Pause center */}
                                  <button
                                    className={`preview-ctrl-btn center${isPlaying ? ' playing' : ''}`}
                                    onClick={() => handlePreviewPlay(idx)}
                                    disabled={isLoading}
                                  >
                                    {isLoading ? (
                                      <Loader2 size={16} className="spinner" />
                                    ) : isPlaying ? (
                                      <Pause size={16} />
                                    ) : (
                                      <Play size={16} style={{ marginLeft: '1px' }} />
                                    )}
                                  </button>
                                  {/* Skip forward 10s */}
                                  <button
                                    className="preview-ctrl-btn"
                                    title="Maju 10 detik"
                                    onClick={() => {
                                      const audio = yt2mp3PreviewAudioRef.current;
                                      if (audio && yt2mp3PreviewDuration) { audio.currentTime = Math.min(yt2mp3PreviewDuration, audio.currentTime + 10); setYt2mp3PreviewTime(audio.currentTime); }
                                    }}
                                  >
                                    <SkipForward size={15} />
                                  </button>
                                </div>
                                <span className="preview-time">{fmtTime(yt2mp3PreviewDuration)}</span>
                              </div>
                            </div>
                          )}
                        </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
            {(yt2mp3Status === 'preparing' || yt2mp3Status === 'downloading') && (
              <div className="loading-card glass-panel">
                <Loader2 size={48} className="spinner" />
                <h3>{yt2mp3Status === 'preparing' ? 'Mempersiapkan...' : (yt2mp3MediaType === 'mp4' ? 'Mengunduh Video...' : 'Mengunduh Audio...')}</h3>
                <div className="progress-section">
                  <div className="progress-info">
                    <span className="progress-percent">{yt2mp3Progress}%</span>
                    <span className="progress-eta">Mengunduh dari web...</span>
                  </div>
                  <div className="progress-bar-container">
                    <div className="progress-bar-fill" style={{ width: `${yt2mp3Progress}%` }}></div>
                  </div>
                </div>
                <button className="cancel-btn" style={{ maxWidth: '200px', margin: '1rem auto 0' }} onClick={() => { setYt2mp3Status('idle'); setYt2mp3Url(''); }}>
                  <X size={16} /> Batal
                </button>
              </div>
            )}
            {yt2mp3Status === 'done' && (
              <div className="upload-card" style={{ borderColor: '#2ec4b6' }}>
                <CheckCircle size={48} color="#2ec4b6" style={{ marginBottom: '1rem' }} />
                <h3 style={{ color: '#2ec4b6' }}>{yt2mp3MediaType === 'mp4' ? 'Video Siap Diunduh!' : 'Audio Siap Diunduh!'}</h3>
                <p>{yt2mp3Title}</p>
                <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', marginTop: '1rem' }}>
                  <a href={`${API_BASE_URL}/youtube-to-mp3/download/${yt2mp3JobId}`} className="process-btn" style={{ textDecoration: 'none', padding: '0.8rem 1.5rem' }} download>
                    <Download size={18} /> Simpan {yt2mp3MediaType === 'mp4' ? 'MP4' : 'MP3'}
                  </a>
                  <button className="cancel-btn" onClick={() => { setYt2mp3Status('idle'); setYt2mp3Url(''); }}>
                    <RefreshCw size={16} /> Unduh Lainnya
                  </button>
                </div>
              </div>
            )}
            {yt2mp3Status === 'error' && (
              <div className="upload-card" style={{ borderColor: '#ff477e' }}>
                <h3 style={{ color: '#ff477e' }}>Gagal Mengunduh</h3>
                <p>{yt2mp3Error}</p>
                <button className="upload-btn" onClick={() => setYt2mp3Status('idle')}>Coba Lagi</button>
              </div>
            )}
          </div>
        ) : activeTab === 'style' ? (
          <div className="style-container animate-fade-in">
            {/* Sub-tabs: Konversi Baru / Riwayat Konversi */}
            <div className="style-home-tabs">
              <button
                type="button"
                className={`style-home-tab ${styleHomeMode === 'convert' ? 'active' : ''}`}
                onClick={() => setStyleHomeMode('convert')}
              >
                <Sparkles size={18} /> Analisis Baru
              </button>
              <button
                type="button"
                className={`style-home-tab ${styleHomeMode === 'history' ? 'active' : ''}`}
                onClick={() => setStyleHomeMode('history')}
              >
                <Clock size={18} /> Riwayat Analisis
                {styleProjects.length > 0 && (
                  <span className="style-home-tab-badge">{styleProjects.length}</span>
                )}
              </button>
            </div>

            {styleHomeMode === 'convert' ? (
            <div className="yt-input-card glass-panel" style={{ textAlign: 'center' }}>
              <div className="yt-input-header">
                <Sparkles size={48} className="yt-icon" style={{ color: '#ec4899' }} />
                <h3>AI Guitar Gear Detector</h3>
                <p>Kenali profil tone gitar, tebakan Amplifier, dan Efek/Pedal dari lagu favorit Anda.</p>
              </div>
              
              <div style={{ display: 'flex', gap: '15px', justifyContent: 'center', alignItems: 'center', margin: '20px auto', maxWidth: '650px', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  placeholder="Opsional: Masukkan Nama Artis / Judul Lagu (Membantu akurasi AI)"
                  value={gearArtistInput}
                  onChange={(e) => setGearArtistInput(e.target.value)}
                  style={{ 
                    flex: '1', 
                    minWidth: '300px', 
                    padding: '12px 20px', 
                    borderRadius: '8px', 
                    border: '1px solid rgba(255,255,255,0.2)', 
                    background: 'rgba(0,0,0,0.3)', 
                    color: 'white',
                    fontSize: '0.95rem'
                  }}
                />
                
                <input
                  type="file"
                  accept="audio/*"
                  id="style-upload"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files[0];
                    setStyleFile(f);
                    if (stylePreviewUrl) URL.revokeObjectURL(stylePreviewUrl);
                    setStylePreviewUrl(f ? URL.createObjectURL(f) : null);
                  }}
                />
                <label htmlFor="style-upload" className="upload-btn" style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 24px', borderRadius: '8px', background: 'rgba(255,255,255,0.1)', whiteSpace: 'nowrap', fontWeight: '500' }}>
                  <Upload size={18} />
                  {styleFile ? styleFile.name : 'Pilih File Audio'}
                </label>
              </div>

              {stylePreviewUrl && (
                <div className="style-preview-player">
                  <div className="style-preview-label"><Play size={14} /> Preview Lagu Asli</div>
                  <audio controls src={stylePreviewUrl} style={{ width: '100%', maxWidth: '400px' }}></audio>
                </div>
              )}

              <button
                className="process-btn"
                onClick={handleStyleConvert}
                disabled={!styleFile || styleLoading}
                style={{ width: '100%', maxWidth: '300px', margin: '0 auto', display: 'block' }}
              >
                {styleLoading ? <Loader2 size={18} className="spinner" /> : <Sparkles size={18} />}
                {styleLoading ? (styleProgressText || 'Memproses...') : 'Mulai Analisis Tone'}
              </button>

              {styleError && <div className="error-message" style={{ marginTop: '15px' }}>{styleError}</div>}

              {styleResult && (
                <div className="gear-result-card glass-panel" style={{ marginTop: '30px', padding: '20px', textAlign: 'left' }}>
                  <h4 style={{ color: '#fff', marginBottom: '15px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '10px' }}>
                    <Sparkles size={20} style={{verticalAlign:'middle', marginRight:'8px', color:'#ec4899'}} />
                    Hasil Deteksi Gear
                  </h4>
                  <div style={{ background: 'rgba(236,72,153,0.15)', color: '#ec4899', padding: '5px 10px', borderRadius: '6px', display: 'inline-block', marginBottom: '15px', fontWeight: 'bold' }}>
                    Akurasi / Confidence: {styleResult.confidence}%
                  </div>
                  
                  <div className="gear-info-grid">
                    <div className="gear-item">
                      <span className="gear-label">Tipe Tone:</span>
                      <strong className="gear-value tone-highlight">{styleResult.tone}</strong>
                    </div>
                    
                    <div className="gear-item">
                      <span className="gear-label">Detail Gitar:</span>
                      <strong className="gear-value">{styleResult.guitar?.model || styleResult.guitar}</strong>
                      {styleResult.guitar?.pickups && <div style={{ fontSize: '0.85rem', color: '#cbd5e0', marginTop: '5px' }}>Pickups: {styleResult.guitar.pickups}</div>}
                      {styleResult.guitar?.strings && <div style={{ fontSize: '0.85rem', color: '#cbd5e0' }}>Strings: {styleResult.guitar.strings}</div>}
                    </div>
                    
                    <div className="gear-item">
                      <span className="gear-label">Amplifier (Amp):</span>
                      <strong className="gear-value amp-highlight">{styleResult.amp?.head || styleResult.amp}</strong>
                      {styleResult.amp?.cabinet && <div style={{ fontSize: '0.85rem', color: '#cbd5e0', marginTop: '5px' }}>Cab: {styleResult.amp.cabinet}</div>}
                      {styleResult.amp?.settings && <div style={{ fontSize: '0.85rem', color: '#cbd5e0' }}>Set: {styleResult.amp.settings}</div>}
                    </div>
                    
                    <div className="gear-item">
                      <span className="gear-label">Efek & Pedal:</span>
                      {typeof styleResult.pedal === 'object' && styleResult.pedal !== null ? (
                        <ul style={{ margin: '5px 0 0 15px', padding: 0, fontSize: '0.9rem', color: '#cbd5e0' }}>
                          {Object.entries(styleResult.pedal).map(([key, val]) => (
                            <li key={key} style={{marginBottom:'3px'}}><strong style={{textTransform:'capitalize'}}>{key}:</strong> <span className="pedal-highlight">{val}</span></li>
                          ))}
                        </ul>
                      ) : (
                        <strong className="gear-value pedal-highlight">{styleResult.pedal}</strong>
                      )}
                    </div>
                  </div>
                  <div className="gear-description" style={{ marginTop: '20px', padding: '15px', background: 'rgba(0,0,0,0.3)', borderRadius: '8px', lineHeight: '1.6' }}>
                    <p>{styleResult.description}</p>
                    {styleResult.alternative && (
                      <div style={{ marginTop: '15px', paddingTop: '15px', borderTop: '1px dashed rgba(255,255,255,0.2)' }}>
                        <h4 style={{ color: '#ff477e', marginBottom: '8px', fontSize: '0.95rem' }}>Alternatif Gear Lain:</h4>
                        <p style={{ fontSize: '0.9rem', color: '#ccc' }}>{styleResult.alternative}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            ) : (
            /* Riwayat Konversi */
            <div className="saved-projects-card glass-panel style-history-card">
              <div className="saved-projects-header">
                <div>
                  <h3><Clock size={22} style={{ verticalAlign: 'middle', marginRight: '8px' }} />Riwayat Analisis Gear</h3>
                  <p>Daftar lagu yang pernah dianalisis gearnya.</p>
                </div>
                <button type="button" className="saved-projects-refresh" onClick={fetchStyleProjects} disabled={styleProjectsLoading} title="Muat ulang daftar">
                  <RefreshCw size={18} className={styleProjectsLoading ? 'spinner' : ''} />
                </button>
              </div>

              {styleProjectsLoading && styleProjects.length === 0 ? (
                <div className="saved-projects-empty"><Loader2 size={28} className="spinner" /> Memuat riwayat...</div>
              ) : styleProjects.length === 0 ? (
                <div className="saved-projects-empty">
                  Belum ada riwayat analisis gear.
                  <button type="button" className="upload-projects-btn upload-projects-btn--compact" onClick={() => setStyleHomeMode('convert')}>
                    <Sparkles size={16} /> Analisis lagu baru
                  </button>
                </div>
              ) : (
                <ul className="saved-projects-list">
                  {styleProjects.map((project) => (
                    <li key={project.job_id} className="saved-project-item">
                      {editingStyleProjectId === project.job_id ? (
                        <form
                          className="saved-project-rename-form"
                          onSubmit={async (e) => {
                            e.preventDefault();
                            const ok = await renameStyleProject(project.job_id, styleProjectNameDraft);
                            if (ok) setEditingStyleProjectId(null);
                          }}
                        >
                          <input
                            type="text"
                            className="saved-project-rename-input"
                            value={styleProjectNameDraft}
                            onChange={(e) => setStyleProjectNameDraft(e.target.value)}
                            maxLength={120}
                            autoFocus
                            placeholder="Nama proyek"
                          />
                          <button type="submit" className="saved-project-rename-save" title="Simpan nama">
                            <CheckCircle size={16} />
                          </button>
                          <button
                            type="button"
                            className="saved-project-rename-cancel"
                            onClick={() => setEditingStyleProjectId(null)}
                            title="Batal"
                          >
                            <X size={16} />
                          </button>
                        </form>
                      ) : (
                        <>
                          <button type="button" className="saved-project-open" onClick={() => openStyleProject(project)}>
                            <Sparkles size={20} />
                            <div className="saved-project-info">
                              <strong>{project.display_name || project.job_id}</strong>
                              <span>
                                <span className={`style-badge style-badge--${project.style}`}>
                                  {project.style === 'dj' ? '🎧 DJ' : '🎸 Rock'}
                                </span>
                                {' · '}
                                {formatProjectDate(project.created_at)}
                              </span>
                            </div>
                          </button>
                          <button
                            type="button"
                            className="saved-project-edit"
                            onClick={() => {
                              setEditingStyleProjectId(project.job_id);
                              setStyleProjectNameDraft(project.display_name || project.job_id);
                            }}
                            title="Ubah nama proyek"
                          >
                            <Pencil size={16} />
                          </button>
                          <button
                            type="button"
                            className="saved-project-delete"
                            onClick={() => deleteStyleProject(project.job_id)}
                            disabled={deletingStyleProjectId === project.job_id}
                            title="Hapus proyek"
                          >
                            {deletingStyleProjectId === project.job_id ? <Loader2 size={16} className="spinner" /> : <Trash2 size={16} />}
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            )}
          </div>
        ) : activeTab === 'playlist' ? (
          <div className="playlist-container animate-fade-in">
            <div className="mp3-playlist-card glass-panel">
              <div className="mp3-playlist-header">
                <ListMusic size={40} className="yt-icon" />
                <div>
                  <h3>Media Playlist (MP3 & MP4)</h3>
                  <p>Pilih folder berisi file media, buat playlist, lalu putar.</p>
                </div>
              </div>

              <div className="mp3-folder-info glass-panel">
                <p><strong>💡 2 Cara Memilih Media:</strong></p>
                <p>• <strong>Pilih 1 Folder Penuh:</strong> Memindai seluruh folder beserta subfolder. <em>(Saat dialog terbuka Windows menyembunyikan file di dalamnya, itu normal — cukup klik Select Folder).</em></p>
                <p>• <strong>Pilih File Media:</strong> Menampilkan daftar file langsung di dialog Windows. Anda bisa memilih <strong>1 lagu</strong>, menahan <strong>Ctrl</strong> untuk memilih <strong>beberapa lagu acak</strong>, atau menahan <strong>Shift</strong> untuk memilih <strong>rentang lagu (from song to song)</strong>.</p>
              </div>

              <input
                ref={mp3FolderInputRef}
                type="file"
                webkitdirectory=""
                multiple
                hidden
                onChange={handleMp3FolderSelect}
              />

              <input
                ref={mp3FileInputRef}
                type="file"
                multiple
                accept="audio/*,video/*,.mp3,.mp4,.m4a,.wav,.ogg,.flac,.aac,.webm"
                hidden
                onChange={handleMp3FileSelect}
              />

              <div className="mp3-playlist-actions">
                <button className="process-btn" onClick={pickMp3Folder} title="Pilih 1 folder penuh untuk dimasukkan ke playlist">
                  <FolderOpen size={18} /> Pilih 1 Folder Penuh
                </button>
                <button className="process-btn secondary-brand" onClick={pickMp3Files} title="Pilih 1 lagu, beberapa lagu acak (Ctrl), atau rentang lagu (Shift)">
                  <Music size={18} /> Pilih File Media (1 / Acak / Rentang)
                </button>
                {mp3Playlist.length > 0 && (
                  <button className="cancel-btn" onClick={clearMp3Playlist}>
                    <X size={16} /> Hapus Playlist
                  </button>
                )}
              </div>

              <p className="mp3-lyrics-hint">
                Tip: pilih folder dengan <strong>Chrome/Edge</strong> agar lirik bisa disimpan langsung ke folder MP3.
                {mp3FolderWritable && <span className="mp3-folder-writable"> ✓ Folder siap menyimpan lirik</span>}
              </p>

              {mp3FolderName && (
                <p className="mp3-folder-label">
                  <FolderOpen size={14} /> {mp3FolderName} — {mp3Playlist.length} lagu
                </p>
              )}

              {mp3Playlist.length > 0 && (
                <div className="mp3-playlist-layout">
                  <div className="mp3-playlist-side">
                    <video
                      ref={mp3AudioRef}
                      preload="metadata"
                      className={`media-video-player ${mp3Playlist[mp3CurrentIndex]?.fileName?.match(/\.mp4$/i) ? 'visible' : 'hidden'}`}
                      onTimeUpdate={handleMp3TimeUpdate}
                      onLoadedMetadata={() => {
                        const dur = mp3AudioRef.current?.duration || 0;
                        setMp3Duration(dur);
                        if (mp3CurrentIndex >= 0 && dur > 0) {
                          const track = mp3Playlist[mp3CurrentIndex];
                          if (track?.lyricsNotFound && mp3RetriedLyricsRef.current !== mp3CurrentIndex) {
                            mp3RetriedLyricsRef.current = mp3CurrentIndex;
                            fetchLyricsForTrack(mp3CurrentIndex, dur);
                          }
                        }
                      }}
                      onEnded={playMp3Next}
                      onPlay={() => {
                        setMp3IsPlaying(true);
                        setMp3TrackLoading(false);
                        if (mp3PitchPlayerRef.current) {
                          syncMp3PitchPlayerToMedia(true);
                        }
                      }}
                      onPause={() => {
                        setMp3IsPlaying(false);
                        syncMp3PitchPlayerToMedia(false);
                      }}
                      onError={() => {
                        const mediaErr = mp3AudioRef.current?.error;
                        console.error('Media load error:', mediaErr);
                        setMp3IsPlaying(false);
                        setMp3TrackLoading(false);
                        const trackName = mp3CurrentIndex >= 0 ? mp3Playlist[mp3CurrentIndex]?.name : '';
                        const errCode = mediaErr?.code;
                        let errMsg = `Gagal memuat "${trackName}".`;
                        if (errCode === 3) errMsg += ' File media rusak atau encoding tidak didukung.';
                        else if (errCode === 4) errMsg += ' Format file tidak didukung oleh browser.';
                        else errMsg += ' Periksa apakah file media valid.';
                        setMp3LyricsStatus(errMsg);
                      }}
                    />

                    <div className="mp3-player-controls">
                      <button
                        type="button"
                        className={`mp3-nav-btn ${mp3Shuffle ? 'active-toggle' : ''}`}
                        onClick={() => setMp3Shuffle(!mp3Shuffle)}
                        title={mp3Shuffle ? 'Mode Acak / Shuffle: AKTIF' : 'Mode Acak / Shuffle: NONAKTIF'}
                      >
                        <Shuffle size={18} />
                      </button>
                      <button className="mp3-nav-btn" onClick={playMp3Prev} title="Sebelumnya">
                        <SkipBack size={20} />
                      </button>
                      <button className={`play-btn ${mp3IsPlaying ? 'playing' : ''}`} onClick={toggleMp3Play}>
                        {mp3TrackLoading ? <Loader2 size={28} className="spinner" /> : mp3IsPlaying ? <Pause size={28} /> : <Play size={28} />}
                      </button>
                      <button className="mp3-nav-btn" onClick={playMp3Next} title="Berikutnya">
                        <SkipForward size={20} />
                      </button>
                      <button
                        type="button"
                        className={`mp3-nav-btn ${mp3Repeat !== 'off' ? 'active-toggle' : ''}`}
                        style={{ position: 'relative' }}
                        onClick={() => setMp3Repeat(r => r === 'all' ? 'one' : r === 'one' ? 'off' : 'all')}
                        title={`Mode Ulang: ${mp3Repeat === 'all' ? 'Ulang Semua' : mp3Repeat === 'one' ? 'Ulang 1 Lagu Ini Saja' : 'Mati (Berhenti di Akhir)'}`}
                      >
                        <Repeat size={18} />
                        {mp3Repeat === 'one' && (
                          <span style={{ position: 'absolute', bottom: '3px', right: '5px', fontSize: '9px', fontWeight: 800, lineHeight: 1 }}>1</span>
                        )}
                      </button>
                      <div className="mp3-now-playing">
                        {mp3CurrentIndex >= 0 ? mp3Playlist[mp3CurrentIndex]?.name : 'Pilih lagu untuk diputar'}
                      </div>
                    </div>

                    <div className="mp3-seek-bar">
                      <span className="mp3-time">{formatTime(mp3CurrentTime)}</span>
                      <input
                        type="range"
                        min="0"
                        max={mp3Duration || 0}
                        step="0.1"
                        value={mp3CurrentTime}
                        onChange={(e) => {
                          const t = parseFloat(e.target.value);
                          setMp3CurrentTime(t);
                          if (mp3AudioRef.current) mp3AudioRef.current.currentTime = t;
                          syncMp3LyricsToTime(t);
                          if (mp3PitchPlayerRef.current) {
                            syncMp3PitchPlayerToMedia(!mp3AudioRef.current?.paused);
                          }
                        }}
                      />
                      <span className="mp3-time">{formatTime(mp3Duration)}</span>
                    </div>

                    <ul className="mp3-track-list">
                      {mp3Playlist.map((track, idx) => (
                        <li
                          key={track.id}
                          className={`mp3-track-item ${idx === mp3CurrentIndex ? 'active' : ''}`}
                          onClick={() => playMp3Track(idx)}
                        >
                          <span className="mp3-track-num">{idx + 1}</span>
                          <span className="mp3-track-name">{track.name}</span>
                          {track.lyrics && <FileText size={13} className="mp3-track-lyrics-icon" title="Ada lirik" />}
                          {idx === mp3CurrentIndex && mp3IsPlaying && (
                            <Music size={14} className="mp3-track-playing-icon" />
                          )}
                          <button
                            type="button"
                            className="mp3-track-delete-btn"
                            title="Hapus dari playlist"
                            onClick={(e) => removeMp3Track(idx, e)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="mp3-lyrics-panel glass-panel">
                    <h4><FileText size={18} /> Lirik</h4>
                    {mp3CurrentIndex >= 0 && (
                      <div className="mp3-lyrics-manual-toggle">
                        <button
                          type="button"
                          className={mp3LyricsManualOpen ? 'process-btn' : 'cancel-btn'}
                          onClick={() => (mp3LyricsManualOpen ? setMp3LyricsManualOpen(false) : openManualLyricsSearch())}
                        >
                          <Search size={14} />
                          {mp3LyricsManualOpen ? ' Tutup pencarian' : ' Cari Lirik Manual'}
                        </button>
                      </div>
                    )}
                    {mp3LyricsManualOpen && mp3CurrentIndex >= 0 && (
                      <div className="mp3-lyrics-manual">
                        <p className="mp3-lyrics-manual-desc">
                          Lirik salah atau lagu orang lain? Cari penyanyi &amp; judul yang benar, lalu pilih dari daftar.
                        </p>
                        <div className="mp3-lyrics-manual-form">
                          <input
                            type="text"
                            placeholder="Penyanyi (mis. Avenged Sevenfold)"
                            value={mp3LyricsSearchArtist}
                            onChange={(e) => setMp3LyricsSearchArtist(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && searchManualLyrics()}
                          />
                          <input
                            type="text"
                            placeholder="Judul lagu (mis. Nightmare)"
                            value={mp3LyricsSearchTitle}
                            onChange={(e) => setMp3LyricsSearchTitle(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && searchManualLyrics()}
                          />
                          <button
                            type="button"
                            className="process-btn"
                            disabled={mp3LyricsSearchLoading}
                            onClick={searchManualLyrics}
                          >
                            {mp3LyricsSearchLoading ? <Loader2 size={14} className="spinner" /> : <Search size={14} />}
                            {mp3LyricsSearchLoading ? ' Mencari...' : ' Cari'}
                          </button>
                        </div>
                        {mp3LyricsSearchResults.length > 0 && (
                          <ul className="mp3-lyrics-search-results">
                            {mp3LyricsSearchResults.map((item) => (
                              <li key={item.id}>
                                <button
                                  type="button"
                                  className="mp3-lyrics-search-item"
                                  disabled={mp3LyricsSelectLoading === item.id}
                                  onClick={() => selectManualLyric(item.id)}
                                >
                                  <span className="mp3-lyrics-search-item-main">
                                    <strong>{item.artist}</strong> — {item.title}
                                  </span>
                                  <span className="mp3-lyrics-search-item-meta">
                                    {item.has_sync && <span className="mp3-lyrics-badge sync">LRC</span>}
                                    {!item.has_sync && item.has_plain && <span className="mp3-lyrics-badge plain">Teks</span>}
                                    {item.synced_lines > 0 && (
                                      <span className="mp3-lyrics-badge lines">{item.synced_lines} baris</span>
                                    )}
                                    {item.duration > 0 && <span>{formatDurationSec(item.duration)}</span>}
                                    {mp3LyricsSelectLoading === item.id && <Loader2 size={12} className="spinner" />}
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        {mp3LyricsSearchDone && !mp3LyricsSearchLoading && mp3LyricsSearchResults.length === 0 && (
                          <p className="mp3-lyrics-manual-hint">Tidak ada hasil. Coba penyanyi/judul lain.</p>
                        )}
                      </div>
                    )}
                    {mp3LyricsLoading && (
                      <div className="mp3-lyrics-loading">
                        <Loader2 size={24} className="spinner" />
                        <p>{mp3LyricsStatus || 'Memuat lirik...'}</p>
                      </div>
                    )}
                    {!mp3LyricsLoading && mp3LyricsStatus && mp3CurrentIndex >= 0 && mp3Playlist[mp3CurrentIndex]?.lyrics && (
                      <p className="mp3-lyrics-status">{mp3LyricsStatus}</p>
                    )}
                    {mp3CurrentIndex >= 0 && mp3Playlist[mp3CurrentIndex]?.lyrics?.type === 'lrc' && (() => {
                      const currentTrack = mp3Playlist[mp3CurrentIndex];
                      const trackSync = getMp3TrackSync(currentTrack.id);
                      return (
                      <>
                        <div className="mp3-lyrics-sync-control">
                          <label htmlFor="mp3-lyrics-offset">
                            <Clock size={14} /> Geser waktu
                            <span className="mp3-lyrics-offset-value">
                              {trackSync.offsetMs > 0 ? '+' : ''}{(trackSync.offsetMs / 1000).toFixed(1)} dtk
                            </span>
                          </label>
                          <input
                            id="mp3-lyrics-offset"
                            type="range"
                            min="-120000"
                            max="120000"
                            step="100"
                            value={Math.max(-120000, Math.min(120000, trackSync.offsetMs))}
                            onChange={(e) => {
                              const offsetMs = parseInt(e.target.value, 10);
                              setMp3TrackSync(currentTrack.id, { offsetMs });
                              mp3LyricsSyncMetaRef.current = {
                                lines: currentTrack.lyrics.lines,
                                offsetMs: offsetMs - (currentTrack.lyrics.offset || 0),
                                speedPct: trackSync.speedPct,
                              };
                              syncMp3LyricsToTime(mp3AudioRef.current?.currentTime ?? mp3CurrentTime);
                            }}
                          />
                          <label htmlFor="mp3-lyrics-speed" className="mp3-lyrics-speed-label">
                            <Sliders size={14} /> Kecepatan lirik
                            <span className="mp3-lyrics-offset-value">{trackSync.speedPct}%</span>
                          </label>
                          <input
                            id="mp3-lyrics-speed"
                            type="range"
                            min="92"
                            max="108"
                            step="1"
                            value={trackSync.speedPct}
                            onChange={(e) => {
                              const speedPct = parseInt(e.target.value, 10);
                              setMp3TrackSync(currentTrack.id, { speedPct });
                              mp3LyricsSyncMetaRef.current = {
                                lines: currentTrack.lyrics.lines,
                                offsetMs: trackSync.offsetMs - (currentTrack.lyrics.offset || 0),
                                speedPct,
                              };
                              syncMp3LyricsToTime(mp3AudioRef.current?.currentTime ?? mp3CurrentTime);
                            }}
                          />
                          <p className="mp3-lyrics-sync-hint">
                            Double-klik baris yang sedang dinyanyikan untuk sinkronkan. Pakai kecepatan hanya jika awal & akhir sama-sama meleset (bisa bikin kejar-kejaran).
                          </p>
                          <button
                            type="button"
                            className="cancel-btn mp3-lyrics-sync-now-btn"
                            onClick={() => syncLyricLineToNow(mp3ActiveLyricIndex >= 0 ? mp3ActiveLyricIndex : 0)}
                          >
                            <RotateCcw size={14} /> Baris ini = sekarang
                          </button>
                          <button
                            type="button"
                            className="cancel-btn mp3-lyrics-refetch-btn"
                            disabled={mp3LyricsLoading}
                            onClick={() => fetchLyricsForTrack(mp3CurrentIndex, mp3Duration, { refresh: true })}
                          >
                            <RefreshCw size={14} /> Cari lirik LRC lain
                          </button>
                        </div>
                        <div className="mp3-lyrics-lines">
                          {currentTrack.lyrics.lines.map((line, i) => {
                            let lineState = 'upcoming';
                            if (i < mp3ActiveLyricIndex) lineState = 'past';
                            else if (i === mp3ActiveLyricIndex) lineState = 'active';
                            return (
                              <p
                                key={i}
                                ref={i === mp3ActiveLyricIndex ? mp3ActiveLyricRef : null}
                                className={`mp3-lyric-line mp3-lyric-line-${lineState}`}
                                style={lineState === 'active' ? { '--lyric-progress': mp3LyricProgress } : undefined}
                                onDoubleClick={() => syncLyricLineToNow(i)}
                                title="Double-klik saat baris ini dinyanyikan"
                              >
                                {lineState === 'active' && lineHasUsableWordTimings(line) ? (
                                  line.words.map((w, wi) => (
                                    <span
                                      key={wi}
                                      className={`mp3-lyric-word${
                                        wi < mp3LyricWordIndex ? ' sung' : wi === mp3LyricWordIndex ? ' active-word' : ''
                                      }`}
                                    >
                                      {w.text}{wi < line.words.length - 1 ? ' ' : ''}
                                    </span>
                                  ))
                                ) : line.text}
                              </p>
                            );
                          })}
                        </div>
                      </>
                      );
                    })()}
                    {mp3CurrentIndex >= 0 && mp3Playlist[mp3CurrentIndex]?.lyrics?.type === 'plain' && (
                      <>
                        <p className="mp3-lyrics-plain-warn">Lirik tanpa timestamp — tidak bisa sinkron karaoke.</p>
                        <pre className="mp3-lyrics-plain">{mp3Playlist[mp3CurrentIndex].lyrics.text}</pre>
                        <button
                          type="button"
                          className="process-btn mp3-lyrics-retry-btn"
                          disabled={mp3LyricsLoading}
                          onClick={() => fetchLyricsForTrack(mp3CurrentIndex, mp3Duration, { refresh: true })}
                        >
                          <RefreshCw size={16} /> Cari versi ber-timestamp (.lrc)
                        </button>
                      </>
                    )}
                    {mp3CurrentIndex >= 0 && (
                      <div className="mp3-lyrics-audio-tools">
                        <div className="mp3-pitch-tools">
                          <span className="mp3-pitch-label">Tangga nada</span>
                          <button
                            type="button"
                            className="mp3-pitch-btn"
                            onClick={async () => {
                              try { await Tone.start(); } catch { /* ignore */ }
                              await changeMp3Pitch(-1);
                            }}
                            disabled={mp3Pitch <= -12}
                            title="Turunkan 1 semitone"
                          >
                            <ChevronDown size={18} />
                          </button>
                          <span className="mp3-pitch-value">
                            {mp3Pitch > 0 ? '+' : ''}{mp3Pitch}
                          </span>
                          <button
                            type="button"
                            className="mp3-pitch-btn"
                            onClick={async () => {
                              try { await Tone.start(); } catch { /* ignore */ }
                              await changeMp3Pitch(1);
                            }}
                            disabled={mp3Pitch >= 12}
                            title="Naikkan 1 semitone"
                          >
                            <ChevronUp size={18} />
                          </button>
                          {mp3Pitch !== 0 && (
                            <button
                              type="button"
                              className="mp3-pitch-reset"
                              onClick={async () => {
                                try { await Tone.start(); } catch { /* ignore */ }
                                await resetMp3Pitch();
                              }}
                              title="Reset nada"
                            >
                              <RotateCcw size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    {mp3SaveFeedback && (
                      <div
                        className={`mp3-save-feedback mp3-save-feedback-${mp3SaveFeedback.type}${mp3SaveFeedback.revealPath ? ' mp3-save-feedback-clickable' : ''}`}
                        role={mp3SaveFeedback.revealPath ? 'button' : 'status'}
                        tabIndex={mp3SaveFeedback.revealPath ? 0 : undefined}
                        aria-live="polite"
                        title={mp3SaveFeedback.revealPath ? 'Klik untuk buka folder dan highlight file' : undefined}
                        onClick={() => {
                          if (mp3SaveFeedback.revealPath) {
                            void revealFileInExplorer(mp3SaveFeedback.revealPath);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (!mp3SaveFeedback.revealPath) return;
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            void revealFileInExplorer(mp3SaveFeedback.revealPath);
                          }
                        }}
                      >
                        {mp3SaveFeedback.type === 'loading' && <Loader2 size={16} className="spinner" />}
                        {mp3SaveFeedback.type === 'success' && <CheckCircle size={16} />}
                        {mp3SaveFeedback.type === 'error' && <AlertTriangle size={16} />}
                        <span>{mp3SaveFeedback.message}</span>
                        {mp3SaveFeedback.revealPath && <FolderOpen size={16} className="mp3-save-feedback-folder-icon" />}
                      </div>
                    )}
                    {mp3CurrentIndex >= 0 && mp3Playlist[mp3CurrentIndex]?.lyrics && (
                      <div className="mp3-lyrics-actions">
                        <button
                          className="cancel-btn mp3-lyrics-download-btn"
                          onClick={() => saveOrDownloadLyrics(mp3CurrentIndex)}
                          disabled={mp3SavingLyrics || mp3KaraokeExporting}
                        >
                          {mp3SavingLyrics ? <Loader2 size={14} className="spinner" /> : <Download size={14} />}
                          {mp3SavingLyrics
                            ? ' Menyimpan...'
                            : mp3FolderWritable
                              ? ' Simpan Lirik ke Folder MP3'
                              : ' Unduh File Lirik (.lrc)'}
                        </button>
                        {isVideoFile(mp3Playlist[mp3CurrentIndex]?.fileName || mp3Playlist[mp3CurrentIndex]?.name)
                          && mp3Playlist[mp3CurrentIndex]?.lyrics?.type === 'lrc' && (
                          <button
                            type="button"
                            className="process-btn mp3-karaoke-video-btn"
                            onClick={() => openKaraokeVideoSync(mp3CurrentIndex)}
                            disabled={mp3KaraokeExporting || mp3SavingLyrics}
                            title="Bakar lirik ke video (bisa koreksi sync dulu)"
                          >
                            {mp3KaraokeExporting ? <Loader2 size={14} className="spinner" /> : <MonitorPlay size={14} />}
                            {mp3KaraokeExporting ? ' Membuat video...' : ' Buat Video Karaoke'}
                          </button>
                        )}
                      </div>
                    )}
                    {mp3KaraokeSyncOpen && mp3CurrentIndex >= 0 && (() => {
                      const kTrack = mp3Playlist[mp3CurrentIndex];
                      const kSync = getMp3TrackSync(kTrack.id);
                      const panelOffsetSec = ((kSync.offsetMs || 0) / 1000).toFixed(1);
                      return (
                        <div className="mp3-karaoke-sync-modal" role="dialog" aria-modal="true" aria-labelledby="karaoke-sync-title">
                          <div className="mp3-karaoke-sync-card">
                            <h5 id="karaoke-sync-title"><MonitorPlay size={18} /> Sinkronkan Video Karaoke</h5>
                            <p className="mp3-karaoke-sync-desc">
                              Pastikan lirik sudah pas di panel kiri/atas, lalu koreksi tipis di sini jika perlu.
                              Sync panel saat ini: <strong>{Number(panelOffsetSec) > 0 ? '+' : ''}{panelOffsetSec} dtk</strong>
                              {kSync.speedPct !== 100 ? `, kecepatan ${kSync.speedPct}%` : ''}.
                            </p>
                            <label className="mp3-karaoke-sync-label" htmlFor="karaoke-burn-trim">
                              Koreksi lirik di video
                              <span>{mp3KaraokeBurnTrimMs > 0 ? '+' : ''}{(mp3KaraokeBurnTrimMs / 1000).toFixed(2)} dtk</span>
                            </label>
                            <input
                              id="karaoke-burn-trim"
                              type="range"
                              min="-3000"
                              max="3000"
                              step="50"
                              value={mp3KaraokeBurnTrimMs}
                              onChange={(e) => setMp3KaraokeBurnTrimMs(parseInt(e.target.value, 10))}
                            />
                            <p className="mp3-karaoke-sync-hint">
                              Geser ke kanan jika lirik di video muncul terlalu cepat; ke kiri jika terlalu lambat.
                              Double-klik baris di panel lirik dulu agar dasar sync-nya benar.
                            </p>
                            <div className="mp3-karaoke-sync-actions">
                              <button
                                type="button"
                                className="cancel-btn"
                                disabled={mp3KaraokeExporting}
                                onClick={() => setMp3KaraokeSyncOpen(false)}
                              >
                                Batal
                              </button>
                              <button
                                type="button"
                                className="process-btn"
                                disabled={mp3KaraokeExporting}
                                onClick={() => exportKaraokeVideo(mp3CurrentIndex)}
                              >
                                {mp3KaraokeExporting ? <Loader2 size={14} className="spinner" /> : <MonitorPlay size={14} />}
                                {mp3KaraokeExporting ? ' Membuat...' : ' Lanjut Buat Video'}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                    {mp3CurrentIndex >= 0 && !mp3Playlist[mp3CurrentIndex]?.lyrics && !mp3LyricsLoading && (
                      <div className="mp3-lyrics-empty">
                        {mp3Playlist[mp3CurrentIndex]?.lyricsNotFound ? (
                          <>
                            <p>Lirik tidak ditemukan di internet.</p>
                            <p>Tambahkan file <strong>{mp3Playlist[mp3CurrentIndex].name}.lrc</strong> di folder MP3.</p>
                            <button
                              className="process-btn mp3-lyrics-retry-btn"
                              onClick={() => fetchLyricsForTrack(mp3CurrentIndex, mp3Duration, { refresh: true })}
                            >
                              <RefreshCw size={16} /> Cari Lagi
                            </button>
                          </>
                        ) : (
                          <p>{mp3Playlist[mp3CurrentIndex]?.lyricsLoading ? 'Memuat lirik...' : (mp3LyricsStatus || 'Memuat lagu...')}</p>
                        )}
                      </div>
                    )}
                    {mp3CurrentIndex === -1 && (
                      <div className="mp3-lyrics-empty">
                        <p>Pilih lagu dari playlist untuk melihat lirik.</p>
                      </div>
                    )}
                  </div>
                </div>
              )}


            </div>
          </div>
        ) : activeTab === 'daw' ? (
          <DawStudio token={token} apiBase={API_BASE_URL} onClose={() => setActiveTab('stems')} />
        ) : null}

        {showSearchModal && (
          <div className="modal-overlay">
            <div className="modal-content glass-panel" style={{ maxWidth: '500px', width: '100%' }}>
              <div className="modal-header">
                <h2>Cari Tabulatur Online</h2>
                <button className="close-btn" onClick={() => setShowSearchModal(false)}><X size={24} /></button>
              </div>
              
              <div style={{ padding: '20px' }}>
                {!searchResult ? (
                  <>
                    <p style={{ color: 'var(--text-secondary)', marginBottom: '15px' }}>
                      Sistem akan mencari tabulatur/chord asli buatan manusia dari internet.
                    </p>
                    <input
                      type="text"
                      placeholder="Contoh: Peterpan Mungkin Nanti"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="auth-input"
                      style={{ 
                        width: '100%', 
                        marginBottom: '20px', 
                        padding: '15px 20px', 
                        fontSize: '1.1rem',
                        borderRadius: '10px'
                      }}
                    />
                    
                    <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                      <button 
                        className="cancel-btn"
                        onClick={() => setShowSearchModal(false)}
                      >
                        Batal
                      </button>
                      <button 
                        className="process-btn"
                        style={{ backgroundColor: '#ff9f1c', flex: 1, padding: '10px' }}
                        onClick={handleSearchOnlineTab}
                        disabled={!searchQuery.trim() || isSearchingTab}
                      >
                        {isSearchingTab ? <><Loader2 size={18} className="spinner" /> Mencari...</> : <><Search size={18} /> Cari Sekarang</>}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="search-result-container" style={{ textAlign: 'left' }}>
                    <div style={{ marginBottom: '15px', padding: '15px', backgroundColor: 'rgba(255, 255, 255, 0.05)', borderRadius: '8px' }}>
                      <h4 style={{ color: '#2ec4b6', marginBottom: '10px' }}>Berhasil Ditemukan!</h4>
                      <p><strong>Sumber:</strong> <a href={searchResult.source} target="_blank" rel="noreferrer" style={{ color: '#3a86ff' }}>Ultimate-Guitar</a></p>
                      <p><strong>Tipe:</strong> {searchResult.type}</p>
                      <p><strong>Rating:</strong> {searchResult.rating} / 5</p>
                    </div>
                    
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <button 
                        className="cancel-btn"
                        onClick={() => setSearchResult(null)}
                      >
                        Kembali
                      </button>
                      <button 
                        className="process-btn"
                        style={{ backgroundColor: '#2ec4b6', flex: 1 }}
                        onClick={handleDownloadOnlineTab}
                      >
                        <Download size={18} /> Unduh File Txt
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
