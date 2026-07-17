import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as Tone from 'tone';
import { Upload, Play, Pause, Loader2, Volume2, VolumeX, Music, Settings2, Guitar, Mic2, Drum, Sparkles, RefreshCw, Download, FileText, User, Lock, LogOut, Shield, Trash2, Pencil, Plus, X, Mail, MonitorPlay, Search, ChevronUp, ChevronDown, RotateCcw, Mic, KeyRound, Copy, CheckCircle, AlertTriangle, Clock, Sliders, FolderOpen, SkipBack, SkipForward, ListMusic, ArrowLeft, Scissors, Video } from 'lucide-react';
import './index.css';

const API_BASE_URL = `http://${window.location.hostname}:8000`;

const isVideoFile = (name) => /\.(mp4|mov|avi|mkv|webm)$/i.test(name || '');

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

function getLyricSyncState(lines, currentTime, offsetMs = 0, speedPct = 100) {
  if (!lines?.length) {
    return { activeIndex: -1, progress: 0, activeWordIndex: -1, wordProgress: 0 };
  }

  const t = audioToLyricTimeline(currentTime, offsetMs, speedPct);

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
    progress = end > start ? Math.min(1, Math.max(0, (t - start) / (end - start))) : 0;

    if (line.words?.length > 1) {
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

function createMp3AudioEngine(audioElement) {
  const toneCtx = Tone.getContext();
  const raw = toneCtx.rawContext;

  const source = toneCtx.createMediaElementSource(audioElement);
  const master = raw.createGain();
  master.gain.value = 1;
  master.connect(raw.destination);

  const pitchShift = new Tone.PitchShift({
    pitch: 0,
    windowSize: 0.08,
    delayTime: 0.03,
    feedback: 0,
    wet: 1,
  });
  Tone.connect(source, pitchShift);
  Tone.connect(pitchShift, master);

  return {
    setPitch(semitones) {
      pitchShift.pitch = semitones;
    },
    dispose() {
      try { pitchShift.disconnect(); pitchShift.dispose(); } catch { /* ignore */ }
      master.disconnect();
    },
  };
}

const INSTRUMENTS = [
  { id: 'vocals', label: 'Vokal', icon: Mic2, color: '#ff477e' },
  { id: 'drums', label: 'Drum', icon: Drum, color: '#ff9f1c' },
  { id: 'bass', label: 'Bass', icon: Music, color: '#2ec4b6' },
  { id: 'guitar', label: 'Gitar', icon: Guitar, color: '#3a86ff' },
  { id: 'piano', label: 'Piano', icon: Music, color: '#8338ec' },
  { id: 'other', label: 'Lainnya', icon: Settings2, color: '#9d4edd' }
];

function App() {
  // Tab navigation
  const [activeTab, setActiveTab] = useState('stems'); // 'stems' or 'karaoke'

  const [file, setFile] = useState(null);
  const [status, setStatus] = useState('idle'); // idle, selected, uploading, processing, ready, error
  const [progressText, setProgressText] = useState('');
  const [fileId, setFileId] = useState(null);
  
  // Audio state
  const [isPlaying, setIsPlaying] = useState(false);
  const [players, setPlayers] = useState({});
  const [volumes, setVolumes] = useState({});
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
  const [compressorEnabled, setCompressorEnabled] = useState(false);
  const [masterVolume, setMasterVolume] = useState(0); // -60 to 6 dB
  
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
  const [mp3SaveFeedback, setMp3SaveFeedback] = useState(null); // { type: 'loading'|'success'|'error', message }
  const [mp3SavingLyrics, setMp3SavingLyrics] = useState(false);
  const [mp3TrackLoading, setMp3TrackLoading] = useState(false);
  const mp3AudioRef = useRef(null);
  const mp3FolderInputRef = useRef(null);
  const mp3PlaylistUrlsRef = useRef([]);
  const mp3ActiveLyricRef = useRef(null);
  const mp3LyricSyncRef = useRef({ activeIndex: -1, progress: 0, activeWordIndex: -1, wordProgress: 0 });
  const mp3LyricsSyncMetaRef = useRef({ lines: null, offsetMs: 0, speedPct: 100 });
  const mp3FolderHandleRef = useRef(null);
  const mp3LoadedTrackRef = useRef(-1);
  const mp3RetriedLyricsRef = useRef(null);
  const mp3EngineRef = useRef(null);
  const [mp3FolderWritable, setMp3FolderWritable] = useState(false);

  const getMp3TrackSync = useCallback((trackId) => (
    mp3LyricsSyncByTrack[trackId] || { offsetMs: 0, speedPct: 100 }
  ), [mp3LyricsSyncByTrack]);

  const setMp3TrackSync = useCallback((trackId, partial) => {
    setMp3LyricsSyncByTrack(prev => ({
      ...prev,
      [trackId]: { offsetMs: 0, speedPct: 100, ...prev[trackId], ...partial },
    }));
  }, []);

  const ensureMp3Engine = async () => {
    if (mp3EngineRef.current) return mp3EngineRef.current;
    if (!mp3AudioRef.current) return null;
    try {
      const toneStart = Tone.start();
      const engine = createMp3AudioEngine(mp3AudioRef.current);
      mp3EngineRef.current = engine;
      await toneStart;
      if (Tone.getContext().state !== 'running') {
        await Tone.getContext().resume();
      }
      return engine;
    } catch (e) {
      mp3EngineRef.current = null;
      console.error('MP3 audio engine init failed:', e);
      return null;
    }
  };

  const resumeMp3AfterEngineInit = async () => {
    const audio = mp3AudioRef.current;
    if (!audio || audio.paused) return;
    try {
      await audio.play();
      setMp3IsPlaying(true);
    } catch {
      setMp3IsPlaying(false);
    }
  };

  const changeMp3Pitch = async (delta) => {
    if (mp3CurrentIndex < 0) {
      setMp3LyricsStatus('Putar lagu dulu sebelum mengubah tangga nada.');
      return;
    }
    const prev = mp3Pitch;
    const next = Math.max(-12, Math.min(12, mp3Pitch + delta));
    if (next === prev) return;

    setMp3Pitch(next);
    setMp3LyricsStatus(next === 0 ? '' : `Tangga nada: ${next > 0 ? '+' : ''}${next} semitone`);

    try {
      const engine = await ensureMp3Engine();
      if (!engine) throw new Error('engine init failed');
      engine.setPitch(next);
      await resumeMp3AfterEngineInit();
    } catch (e) {
      console.error(e);
      setMp3Pitch(prev);
      setMp3LyricsStatus('Gagal mengubah nada. Putar lagu lalu coba lagi.');
    }
  };

  const resetMp3Pitch = async () => {
    const prev = mp3Pitch;
    if (prev === 0) return;
    setMp3Pitch(0);
    setMp3LyricsStatus('');
    try {
      if (mp3EngineRef.current) {
        mp3EngineRef.current.setPitch(0);
      }
      await resumeMp3AfterEngineInit();
    } catch (e) {
      console.error(e);
      setMp3Pitch(prev);
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
  // YouTube Audio refs
  const ytAudioRef = useRef(null);
  const ytAudioContextRef = useRef(null);
  const ytSourceNodeRef = useRef(null);
  const ytPitchShifterRef = useRef(null);
  const ytPlayerRef = useRef(null); // YouTube iframe API player
  const ytIframeRef = useRef(null);

  const playersRef = useRef({});
  const volumeNodesRef = useRef({});
  const pannerNodesRef = useRef({});
  const masterEqRef = useRef(null);
  const masterCompressorRef = useRef(null);
  const masterPitchShiftRef = useRef(null);
  const masterLimiterRef = useRef(null);
  const ytAnimFrameRef = useRef(null);
  const originalAudioRef = useRef(null);

  const clearMp3Playlist = useCallback(() => {
    mp3PlaylistUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
    mp3PlaylistUrlsRef.current = [];
    if (mp3AudioRef.current) {
      mp3AudioRef.current.pause();
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
    mp3FolderHandleRef.current = null;
    setMp3FolderWritable(false);
    mp3LoadedTrackRef.current = -1;
    setMp3TrackLoading(false);
  }, []);

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

  const setMp3SaveFeedbackState = (type, message) => {
    setMp3SaveFeedback({ type, message });
    if (type === 'loading') {
      setMp3SavingLyrics(true);
    } else {
      setMp3SavingLyrics(false);
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

  const removeMp3Track = (index, e) => {
    e.stopPropagation();
    const track = mp3Playlist[index];
    if (!track) return;

    URL.revokeObjectURL(track.url);
    mp3PlaylistUrlsRef.current = mp3PlaylistUrlsRef.current.filter(u => u !== track.url);

    const nextPlaylist = mp3Playlist.filter((_, i) => i !== index);
    if (nextPlaylist.length === 0) {
      if (mp3AudioRef.current) {
        mp3AudioRef.current.pause();
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
      mp3LoadedTrackRef.current = -1;
      setMp3TrackLoading(false);
      return;
    }

    let nextIndex = mp3CurrentIndex;
    if (index === mp3CurrentIndex) {
      if (mp3AudioRef.current) {
        mp3AudioRef.current.pause();
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

    mp3PlaylistUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
    mp3PlaylistUrlsRef.current = [];
    if (mp3AudioRef.current) {
      mp3AudioRef.current.pause();
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

  const collectFilesFromDirectory = async (dirHandle) => {
    const files = [];
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'file') {
        files.push(await entry.getFile());
      } else if (entry.kind === 'directory') {
        files.push(...await collectFilesFromDirectory(entry));
      }
    }
    return files;
  };

  const pickMp3Folder = async () => {
    if ('showDirectoryPicker' in window) {
      try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        const allFiles = await collectFilesFromDirectory(handle);
        await loadPlaylistFromFiles(allFiles, handle.name, handle);
      } catch (e) {
        if (e.name !== 'AbortError') console.error(e);
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

  useEffect(() => {
    mp3ActiveLyricRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    if (prev.activeIndex !== activeIndex) {
      mp3LyricSyncRef.current = { activeIndex, progress, activeWordIndex, wordProgress };
      setMp3ActiveLyricIndex(activeIndex);
      setMp3LyricProgress(progress);
      setMp3LyricWordIndex(activeWordIndex);
    } else {
      let changed = false;
      if (Math.abs(prev.progress - progress) >= 0.012) {
        changed = true;
        setMp3LyricProgress(progress);
      }
      if (prev.activeWordIndex !== activeWordIndex) {
        changed = true;
        setMp3LyricWordIndex(activeWordIndex);
      }
      if (changed) {
        mp3LyricSyncRef.current = { activeIndex, progress, activeWordIndex, wordProgress };
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
    const newOffset = Math.round((line.time / speed - t) * 1000);

    setMp3TrackSync(track.id, { offsetMs: newOffset });
    mp3LyricsSyncMetaRef.current = {
      lines: track.lyrics.lines,
      offsetMs: newOffset - (track.lyrics.offset || 0),
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

    setMp3CurrentIndex(index);
    setMp3ActiveLyricIndex(-1);
    setMp3LyricProgress(0);
    setMp3LyricWordIndex(-1);
    mp3LyricSyncRef.current = { activeIndex: -1, progress: 0, activeWordIndex: -1, wordProgress: 0 };
    setMp3LyricsStatus('');
    setMp3SaveFeedback(null);
    setMp3SavingLyrics(false);
    mp3RetriedLyricsRef.current = null;

    const applyEngineState = () => {
      const engine = mp3EngineRef.current;
      if (!engine) return;
      engine.setPitch(mp3Pitch);
    };

    const onPlaySuccess = () => {
      setMp3IsPlaying(true);
      setMp3TrackLoading(false);
      scheduleLyricsFetch(index, audio.duration || 0);
      applyEngineState();
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
      setMp3IsPlaying(false);
    } else {
      mp3AudioRef.current.play().then(() => setMp3IsPlaying(true)).catch(() => setMp3IsPlaying(false));
    }
  };

  const playMp3Next = () => {
    if (mp3Playlist.length === 0) return;
    const next = mp3CurrentIndex < mp3Playlist.length - 1 ? mp3CurrentIndex + 1 : 0;
    playMp3Track(next);
  };

  const playMp3Prev = () => {
    if (mp3Playlist.length === 0) return;
    if (mp3AudioRef.current && mp3AudioRef.current.currentTime > 3) {
      mp3AudioRef.current.currentTime = 0;
      return;
    }
    const prev = mp3CurrentIndex > 0 ? mp3CurrentIndex - 1 : mp3Playlist.length - 1;
    playMp3Track(prev);
  };

  useEffect(() => {
    return () => {
      Object.values(playersRef.current).forEach(p => p.dispose());
      Object.values(volumeNodesRef.current).forEach(v => v.dispose());
      if (masterEqRef.current) masterEqRef.current.dispose();
      if (masterCompressorRef.current) masterCompressorRef.current.dispose();
      if (masterLimiterRef.current) masterLimiterRef.current.dispose();
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
    const map = { '3m': '3 Bulan', '6m': '6 Bulan', '1y': '1 Tahun', '3bulan': '3 Bulan', '6bulan': '6 Bulan', '1tahun': '1 Tahun' };
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
        } else {
           setStemCurrentTime(currentTime);
           animationFrameId = requestAnimationFrame(updateProgress);
        }
      }
    };
    if (isPlaying) {
      animationFrameId = requestAnimationFrame(updateProgress);
    }
    return () => cancelAnimationFrame(animationFrameId);
  }, [isPlaying, stemDuration, trimEnabled, trimStart, trimEnd]);

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

  const syncStemLyricsToTime = (transportTime) => {
    if (stemLyrics?.type !== 'lrc' || !stemLyrics.lines?.length) return;
    const effectiveTime = transportTime * tempo;
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
    const effectiveTime = stemCurrentTime * tempo;
    const speed = stemLyricsSpeedPct / 100;
    setStemLyricsOffsetMs(Math.round((line.time / speed - effectiveTime) * 1000));
    syncStemLyricsToTime(stemCurrentTime);
  };

  useEffect(() => {
    syncStemLyricsToTime(stemCurrentTime);
  }, [stemCurrentTime, tempo, stemLyrics, stemLyricsOffsetMs, stemLyricsSpeedPct]);

  useEffect(() => {
    stemActiveLyricRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    Object.values(playersRef.current).forEach((p) => {
      if (p?.detune !== undefined) p.detune = nextPitch * 100;
      if (p?.playbackRate !== undefined) p.playbackRate = nextTempo;
    });

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

    const comp = !!settings.compressor_enabled;
    setCompressorEnabled(comp);
    if (masterCompressorRef.current) {
      masterCompressorRef.current.threshold.value = comp ? -15 : 0;
      masterCompressorRef.current.ratio.value = comp ? 2.5 : 1;
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
          compressor_enabled: compressorEnabled,
          master_volume: masterVolume,
          stem_lyrics_offset_ms: stemLyricsOffsetMs,
          stem_lyrics_speed_pct: stemLyricsSpeedPct,
        }),
      });
    } catch (e) {
      console.error(e);
    }
  }, [
    fileId, token, status, volumes, mutes, pans, pitch, tempo,
    eqLow, eqMid, eqHigh, compressorEnabled, masterVolume, stemLyricsOffsetMs, stemLyricsSpeedPct,
  ]);

  const resetStemStudio = (homeMode = 'upload') => {
    Tone.Transport.stop();
    Tone.Transport.seconds = 0;
    setIsPlaying(false);
    Object.values(playersRef.current).forEach((p) => p.dispose());
    Object.values(volumeNodesRef.current).forEach((v) => v.dispose());
    Object.values(pannerNodesRef.current).forEach((p) => { try { p.dispose(); } catch {} });
    if (masterEqRef.current) {
      masterEqRef.current.dispose();
      masterEqRef.current = null;
    }
    if (masterCompressorRef.current) {
      masterCompressorRef.current.dispose();
      masterCompressorRef.current = null;
    }
    if (masterLimiterRef.current) {
      masterLimiterRef.current.dispose();
      masterLimiterRef.current = null;
    }
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

      Object.values(playersRef.current).forEach(p => p.dispose());
      Object.values(volumeNodesRef.current).forEach(v => v.dispose());
      Object.values(pannerNodesRef.current).forEach(p => { try { p.dispose(); } catch {} });
      if (masterEqRef.current) { masterEqRef.current.dispose(); masterEqRef.current = null; }
      if (masterCompressorRef.current) { masterCompressorRef.current.dispose(); masterCompressorRef.current = null; }
      if (masterPitchShiftRef.current) { masterPitchShiftRef.current.dispose(); masterPitchShiftRef.current = null; }
      if (masterLimiterRef.current) { masterLimiterRef.current.dispose(); masterLimiterRef.current = null; }

      const masterEq = new Tone.EQ3(0, 0, 0);
      const masterCompressor = new Tone.Compressor({ threshold: 0, ratio: 1, attack: 0.01, release: 0.1 });
      const masterPitchShift = new Tone.PitchShift({ pitch: pitch, windowSize: 0.1, delayTime: 0, feedback: 0 });
      const masterLimiter = new Tone.Limiter(-1);
      masterEq.chain(masterCompressor, masterPitchShift, masterLimiter, Tone.Destination);
      masterEqRef.current = masterEq;
      masterCompressorRef.current = masterCompressor;
      masterPitchShiftRef.current = masterPitchShift;
      masterLimiterRef.current = masterLimiter;

      const newPlayers = {};
      const newVolumes = {};
      const newPanners = {};
      const initVols = {};
      const initMutes = {};
      const initPans = {};
      let loadedCount = 0;

      const loadPromises = INSTRUMENTS.map((inst) => {
        const url = `${API_BASE_URL}/audio/${id}/${inst.id}.mp3`;
        const panNode = new Tone.Panner(0).connect(masterEq);
        const volNode = new Tone.Volume(0).connect(panNode);

        return new Promise((resolve, reject) => {
          const player = new Tone.Player({
            url,
            onload: () => {
              loadedCount += 1;
              setProgressText(`Memuat ${inst.label}... (${loadedCount}/${INSTRUMENTS.length})`);
              resolve();
            },
            onerror: (err) => reject(new Error(`Gagal memuat ${inst.label}: ${err?.message || 'file tidak ditemukan'}`)),
          });

          player.connect(volNode);
          player.sync().start(0);

          newPlayers[inst.id] = player;
          newVolumes[inst.id] = volNode;
          newPanners[inst.id] = panNode;
          initVols[inst.id] = 0;
          initMutes[inst.id] = false;
          initPans[inst.id] = 0;
        });
      });

      await Promise.all(loadPromises);

      playersRef.current = newPlayers;
      volumeNodesRef.current = newVolumes;
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
        setCompressorEnabled(false);
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
    Object.values(playersRef.current).forEach((p) => p.dispose());
    Object.values(volumeNodesRef.current).forEach((v) => v.dispose());
    if (masterEqRef.current) {
      masterEqRef.current.dispose();
      masterEqRef.current = null;
    }
    if (masterCompressorRef.current) {
      masterCompressorRef.current.dispose();
      masterCompressorRef.current = null;
    }
    if (masterLimiterRef.current) {
      masterLimiterRef.current.dispose();
      masterLimiterRef.current = null;
    }

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

  useEffect(() => {
    if (status !== 'ready' || !fileId) return undefined;
    if (skipSettingsSaveRef.current) return undefined;
    clearTimeout(saveSettingsTimeoutRef.current);
    saveSettingsTimeoutRef.current = setTimeout(() => saveProjectSettings(), 800);
    return () => clearTimeout(saveSettingsTimeoutRef.current);
  }, [
    status, fileId, volumes, mutes, pans, pitch, tempo,
    eqLow, eqMid, eqHigh, compressorEnabled, stemLyricsOffsetMs, stemLyricsSpeedPct,
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
    } else {
      Tone.Transport.pause();
      setIsPlaying(false);
      if (stemVideoRef.current) stemVideoRef.current.pause();
    }
  };

  const handleVolumeChange = (instId, value) => {
    setVolumes(prev => ({ ...prev, [instId]: value }));
    if (!mutes[instId] && volumeNodesRef.current[instId]) {
      volumeNodesRef.current[instId].volume.value = value;
    }
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

  const handlePitchChange = (e) => {
    const val = parseFloat(e.target.value);
    setPitch(val);
    if (masterPitchShiftRef.current) {
      masterPitchShiftRef.current.pitch = val;
    }
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
          compressor_enabled: compressorEnabled,
          trim_start: trimEnabled ? trimStart : 0,
          trim_end: trimEnabled ? trimEnd : null,
          export_video: activeTab === 'karaoke',
        })
      });
      
      const data = await response.json();
      if (data.status === 'success' && data.download_url) {
        const exportName = data.filename || `${(stemTrackName || 'export').replace(/\.mp3$/i, '')} edit.mp3`;
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
            className={`tab-btn ${activeTab === 'karaoke' ? 'active' : ''}`}
            onClick={() => setActiveTab('karaoke')}
          >
            <Video size={18} /> Video Karaoke
          </button>
          <button
            className={`tab-btn ${activeTab === 'yt2mp3' ? 'active' : ''}`}
            onClick={() => setActiveTab('yt2mp3')}
          >
            <Download size={18} /> Web Audio Converter
          </button>
          <button
            className={`tab-btn ${activeTab === 'playlist' ? 'active' : ''}`}
            onClick={() => setActiveTab('playlist')}
          >
            <ListMusic size={18} /> MP3 Playlist
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
            className={`tab-btn ${activeTab === 'karaoke' ? 'active' : ''}`}
            onClick={() => setActiveTab('karaoke')}
          >
            <Video size={18} /> Video Karaoke
          </button>
          <button
            className={`tab-btn ${activeTab === 'yt2mp3' ? 'active' : ''}`}
            onClick={() => setActiveTab('yt2mp3')}
          >
            <Download size={18} /> Web Audio Converter
          </button>
          <button
            className={`tab-btn ${activeTab === 'playlist' ? 'active' : ''}`}
            onClick={() => setActiveTab('playlist')}
          >
            <ListMusic size={18} /> MP3 Playlist
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

  const isStudioFullPage = (activeTab === 'stems' || activeTab === 'karaoke') && status === 'ready';

  return (
    <div className={`app-container${isStudioFullPage ? ' app-container--studio-full' : ''}`}>
      <div className="background-glow"></div>
      
      <header className="header">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', width: '100%', maxWidth: '1000px' }}>
          {token && (
            <div className="user-profile" style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
              {isAdmin && (
                <button className="admin-btn" onClick={() => { setShowAdminPanel(!showAdminPanel); if (!showAdminPanel) fetchUsers(); }}>
                  <Shield size={16} /> Admin
                </button>
              )}
              <span className="welcome-text">Hai, {username}</span>
              {/* <button className="logout-btn" onClick={handleLogout}>
                <LogOut size={16} /> Keluar
              </button> */}
            </div>
          )}
          <div>
            <h1>Jagat <span>Audio</span></h1>
            <p>AI Stem Separation & Karaoke{licenseInfo?.app_version ? ` • v${licenseInfo.app_version}` : ''}</p>
          </div>
        </div>
      </header>

      {/* License Info Bar */}
      {licenseInfo && (
        <div className="license-info-card" style={{ maxWidth: '500px', width: '100%', marginBottom: '1rem', padding: '0.8rem 1.2rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <CheckCircle size={16} color="#2ec4b6" />
              <span className="license-active-badge">Lisensi Aktif</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {formatLicenseType(licenseInfo.license_type)}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem' }}>
              <Clock size={14} color={licenseInfo.days_remaining <= 30 ? '#ff9f1c' : '#2ec4b6'} />
              <span style={{ color: licenseInfo.days_remaining <= 30 ? '#ff9f1c' : 'var(--text-secondary)' }}>
                Sisa {licenseInfo.days_remaining} hari • Exp: {formatDate(licenseInfo.expiry_date)}
              </span>
            </div>
          </div>
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
            className={`tab-btn ${activeTab === 'karaoke' ? 'active' : ''}`}
            onClick={() => setActiveTab('karaoke')}
          >
            <Video size={18} /> Video Karaoke
          </button>
          <button
            className={`tab-btn ${activeTab === 'yt2mp3' ? 'active' : ''}`}
            onClick={() => setActiveTab('yt2mp3')}
          >
            <Download size={18} /> Web Audio Converter
          </button>
          <button
            className={`tab-btn ${activeTab === 'playlist' ? 'active' : ''}`}
            onClick={() => setActiveTab('playlist')}
          >
            <ListMusic size={18} /> MP3 Playlist
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
        ) : (activeTab === 'stems' || activeTab === 'karaoke') ? (
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
              <h3>Unggah {activeTab === 'karaoke' ? 'Video Karaoke' : 'Lagu Anda'}</h3>
              <p>Format {activeTab === 'karaoke' ? 'Video (MP4)' : 'MP3 dan WAV'} didukung. File akan diproses dengan AI Demucs.</p>
              <label className="upload-btn">
                Pilih File
                <input 
                  type="file" 
                  accept={activeTab === 'karaoke' ? "video/mp4,video/quicktime,video/x-msvideo,video/webm" : "audio/mp3,audio/wav"} 
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
                {savedProjects
                  .filter((project) => activeTab === 'karaoke' ? isVideoFile(project.original_name) : !isVideoFile(project.original_name))
                  .map((project) => (
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
                <h3>Memisahkan Audio dengan AI</h3>
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
                      <span style={{ marginLeft: '8px' }}>{isExporting ? 'Mengekspor...' : (activeTab === 'karaoke' ? 'Export MP4' : 'Export MP3')}</span>
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
                    {volumes[inst.id] <= -60 ? '-∞' : (volumes[inst.id] > 0 ? '+' : '') + Math.round(volumes[inst.id])} <span className="db-unit">dB</span>
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
                {/* EQ Sliders */}
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
                    <span style={{ fontSize: '0.8rem', color: '#2ec4b6', fontWeight: 700, minWidth: '40px', textAlign: 'center' }}>{eqLow > 0 ? '+' : ''}{eqLow} dB</span>
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
                    <span style={{ fontSize: '0.8rem', color: '#ff9f1c', fontWeight: 700, minWidth: '40px', textAlign: 'center' }}>{eqMid > 0 ? '+' : ''}{eqMid} dB</span>
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
                    <span style={{ fontSize: '0.8rem', color: '#3a86ff', fontWeight: 700, minWidth: '40px', textAlign: 'center' }}>{eqHigh > 0 ? '+' : ''}{eqHigh} dB</span>
                  </div>
                  {/* Master Volume */}
                  <div className="eq-slider-group" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.4rem', flex: 1, borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: '1.5rem', marginLeft: '0.5rem' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Master Vol</label>
                    <input 
                      type="range" min="-60" max="6" step="1" 
                      value={masterVolume} 
                      onChange={(e) => handleMasterVolumeChange(parseFloat(e.target.value))} 
                      className="accent-slider eq-slider"
                      style={{ '--slider-color': '#f15bb5' }}
                    />
                    <span style={{ fontSize: '0.8rem', color: '#f15bb5', fontWeight: 700, minWidth: '40px', textAlign: 'center' }}>{masterVolume <= -60 ? '-∞' : (masterVolume > 0 ? '+' : '') + masterVolume} dB</span>
                  </div>
                </div>

                {/* Compressor Toggle */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                  <label style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600 }}>Compressor</label>
                  <button 
                    onClick={handleCompressorToggle}
                    style={{
                      padding: '0.6rem 1.4rem',
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
                    min="-5000"
                    max="5000"
                    step="50"
                    value={stemLyricsOffsetMs}
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
                  <p className="mp3-lyrics-sync-hint">Double-klik baris yang sedang dinyanyikan. Tempo {Math.round(tempo * 100)}% sudah dihitung otomatis.</p>
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
                        {lineState === 'active' && line.words?.length > 1 ? (
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
                  <p>Paste link YouTube untuk mengunduh audio dengan cepat.</p>
                </div>
                <div className="yt-url-input" style={{ display: 'flex', gap: '0.5rem', position: 'relative', width: '100%' }}>
                  <div style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
                    <input
                      type="text"
                      placeholder="Paste link ATAU ketik judul lagu... (contoh: Coldplay Yellow)"
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
                        body: JSON.stringify({ query: yt2mp3Url })
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
                    {yt2mp3IsSearching ? <Loader2 size={20} className="spinner" /> : <Search size={20} />} Cari Lagu
                  </button>
                </div>
                {yt2mp3Error && <div className="auth-message error">{yt2mp3Error}</div>}
                
                {yt2mp3SearchResults.length > 0 && (
                  <div className="search-results-container" style={{ marginTop: '1.5rem', textAlign: 'left' }}>
                    <h4 style={{ marginBottom: '1rem', color: '#fff' }}>Hasil Pencarian:</h4>
                    <div className="search-results-list" style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                      {yt2mp3SearchResults.map((result, idx) => (
                        <div key={idx} className="search-result-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.05)', padding: '1rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)' }}>
                          <div className="result-info" style={{ flex: 1, marginRight: '1rem', overflow: 'hidden' }}>
                            <div style={{ fontWeight: 'bold', color: '#fff', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{result.title}</div>
                            <div style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)', marginTop: '4px', display: 'flex', gap: '1rem' }}>
                              <span><Clock size={12} style={{ verticalAlign: 'middle', marginRight: '4px' }}/> {result.duration ? Math.floor(result.duration / 60) + ':' + (result.duration % 60).toString().padStart(2, '0') : '--:--'}</span>
                              <span style={{ color: result.source === 'SoundCloud' ? '#ff9f1c' : '#ff477e' }}>{result.source}</span>
                            </div>
                          </div>
                          <button className="process-btn" style={{ flexShrink: 0, width: 'auto', minWidth: '90px', padding: '0.5rem 1rem', fontSize: '0.9rem', display: 'flex', justifyContent: 'center', alignItems: 'center' }} onClick={async () => {
                            setYt2mp3Status('preparing');
                            setYt2mp3Error('');
                            setYt2mp3Progress(0);
                            try {
                              const res = await fetch(`${API_BASE_URL}/youtube-to-mp3/prepare`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                                body: JSON.stringify({ url: result.url })
                              });
                              const data = await res.json();
                              if(res.ok) {
                                setYt2mp3JobId(data.job_id);
                                setYt2mp3Status('downloading');
                              } else {
                                setYt2mp3Status('error'); setYt2mp3Error(data.detail || 'Gagal memproses');
                              }
                            } catch(e) { setYt2mp3Status('error'); setYt2mp3Error('Kesalahan jaringan'); }
                          }}>
                            <Download size={16} style={{ marginRight: '4px' }} /> Unduh
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {(yt2mp3Status === 'preparing' || yt2mp3Status === 'downloading') && (
              <div className="loading-card glass-panel">
                <Loader2 size={48} className="spinner" />
                <h3>{yt2mp3Status === 'preparing' ? 'Mempersiapkan...' : 'Mengunduh Audio...'}</h3>
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
                <h3 style={{ color: '#2ec4b6' }}>Audio Siap Diunduh!</h3>
                <p>{yt2mp3Title}</p>
                <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', marginTop: '1rem' }}>
                  <a href={`${API_BASE_URL}/youtube-to-mp3/download/${yt2mp3JobId}`} className="process-btn" style={{ textDecoration: 'none', padding: '0.8rem 1.5rem' }} download>
                    <Download size={18} /> Simpan MP3
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
                <p><strong>Catatan:</strong> Saat memilih folder, Windows/Chrome <em>tidak menampilkan file media</em> di dialog — itu normal.</p>
                <p>Buka folder tempat file media Anda berada (misalnya <code>Downloads\01</code>), lalu klik <strong>Select Folder</strong>. Daftar lagu/video akan muncul di aplikasi setelah folder dipilih.</p>
              </div>

              <input
                ref={mp3FolderInputRef}
                type="file"
                webkitdirectory=""
                multiple
                hidden
                onChange={handleMp3FolderSelect}
              />

              <div className="mp3-playlist-actions">
                <button className="process-btn" onClick={pickMp3Folder}>
                  <FolderOpen size={18} /> Pilih Folder Media
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
                      onPlay={() => { setMp3IsPlaying(true); setMp3TrackLoading(false); }}
                      onPause={() => setMp3IsPlaying(false)}
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
                      <button className="mp3-nav-btn" onClick={playMp3Prev} title="Sebelumnya">
                        <SkipBack size={20} />
                      </button>
                      <button className={`play-btn ${mp3IsPlaying ? 'playing' : ''}`} onClick={toggleMp3Play}>
                        {mp3TrackLoading ? <Loader2 size={28} className="spinner" /> : mp3IsPlaying ? <Pause size={28} /> : <Play size={28} />}
                      </button>
                      <button className="mp3-nav-btn" onClick={playMp3Next} title="Berikutnya">
                        <SkipForward size={20} />
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
                            min="-5000"
                            max="5000"
                            step="50"
                            value={trackSync.offsetMs}
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
                            Double-klik baris yang sedang dinyanyikan untuk sinkronkan. Gunakan kecepatan jika awal/akhir lagu meleset.
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
                                {lineState === 'active' && line.words?.length > 1 ? (
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
                            onClick={() => { void Tone.start(); changeMp3Pitch(-1); }}
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
                            onClick={() => { void Tone.start(); changeMp3Pitch(1); }}
                            disabled={mp3Pitch >= 12}
                            title="Naikkan 1 semitone"
                          >
                            <ChevronUp size={18} />
                          </button>
                          {mp3Pitch !== 0 && (
                            <button
                              type="button"
                              className="mp3-pitch-reset"
                              onClick={() => { void Tone.start(); resetMp3Pitch(); }}
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
                        className={`mp3-save-feedback mp3-save-feedback-${mp3SaveFeedback.type}`}
                        role="status"
                        aria-live="polite"
                      >
                        {mp3SaveFeedback.type === 'loading' && <Loader2 size={16} className="spinner" />}
                        {mp3SaveFeedback.type === 'success' && <CheckCircle size={16} />}
                        {mp3SaveFeedback.type === 'error' && <AlertTriangle size={16} />}
                        <span>{mp3SaveFeedback.message}</span>
                      </div>
                    )}
                    {mp3CurrentIndex >= 0 && mp3Playlist[mp3CurrentIndex]?.lyrics && (
                      <button
                        className="cancel-btn mp3-lyrics-download-btn"
                        onClick={() => saveOrDownloadLyrics(mp3CurrentIndex)}
                        disabled={mp3SavingLyrics}
                      >
                        {mp3SavingLyrics ? <Loader2 size={14} className="spinner" /> : <Download size={14} />}
                        {mp3SavingLyrics
                          ? ' Menyimpan...'
                          : mp3FolderWritable
                            ? ' Simpan Lirik ke Folder MP3'
                            : ' Unduh File Lirik (.lrc)'}
                      </button>
                    )}
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
