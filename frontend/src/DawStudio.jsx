/**
 * DawStudio.jsx
 * ─────────────
 * Full-featured DAW component for Jagat Audio.
 * Inspired by Studio One — multi-track timeline, mixer, effects, transport.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import DawAudioEngine, { TRACK_COLORS, audioBufferToWav } from './DawAudioEngine';
import {
  Play, Pause, Square, Circle,
  Plus, Trash2, X, Volume2,
  Sliders, Download, Upload, FolderOpen, Save,
  Music, Repeat, ChevronUp, ChevronDown,
  Scissors, MousePointer2, Eraser, ZoomIn, ZoomOut,
  Undo2, Redo2, Loader2, Copy, ArrowLeft,
  Layers, Bell, Drum, Sparkles, ShieldAlert, Radio,
  Activity, SlidersHorizontal, Maximize2, Minimize2,
  Gauge, Zap, Check, RotateCcw, VolumeX, Flame, Headphones, RefreshCw,
} from 'lucide-react';
import { generateDrumLoop, DRUM_PRESETS } from './DrumGenerator';
import { generateBassLoop } from './BassGenerator';
import { TRACK_MIXING_PRESETS, MASTERING_PRESETS } from './mixingPresets';
import * as Tone from 'tone';
import './daw.css';

// ─── Constants ───────────────────────────────────────────────────

const RULER_HEIGHT      = 32;
const DEFAULT_TRACK_H   = 148;
const MIN_TRACK_H       = 130;
const MAX_TRACK_H       = 240;
const MIN_ZOOM          = 1;    // px per second
const MAX_ZOOM          = 400;
const DEFAULT_ZOOM      = 20;
const RESIZE_HANDLE_W   = 12;   // px for region left/right resize grip
const WAVEFORM_COLOR_ALPHA = 0.65;

const SNAP_OPTIONS = [
  { label: 'Bar',  value: 'bar'  },
  { label: '1/2',  value: '1/2'  },
  { label: '1/4',  value: '1/4'  },
  { label: '1/8',  value: '1/8'  },
  { label: '1/16', value: '1/16' },
  { label: 'Off',  value: 'off'  },
];

// ─── Helpers ─────────────────────────────────────────────────────

let _idCounter = 0;
function uid(prefix = 'id') { return `${prefix}_${Date.now()}_${++_idCounter}`; }

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
}

function formatBarsBeats(sec, bpm, timeSig) {
  const beatSec = 60 / bpm;
  const beats = sec / beatSec;
  const beatsPerBar = timeSig[0];
  const bar  = Math.floor(beats / beatsPerBar) + 1;
  const beat = Math.floor(beats % beatsPerBar) + 1;
  return `${bar}.${beat}`;
}

function snapTime(time, bpm, timeSig, snapValue) {
  if (snapValue === 'off') return time;
  const beatSec = 60 / bpm;
  let grid;
  switch (snapValue) {
    case 'bar':  grid = beatSec * timeSig[0]; break;
    case '1/2':  grid = beatSec * 2; break;
    case '1/4':  grid = beatSec; break;
    case '1/8':  grid = beatSec / 2; break;
    case '1/16': grid = beatSec / 4; break;
    default:     grid = beatSec; break;
  }
  return Math.round(time / grid) * grid;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function hexToRgba(hex, alpha) {
  if (!hex || typeof hex !== 'string' || hex.length < 7) {
    return `rgba(58,134,255,${alpha})`;
  }
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if ([r, g, b].some(n => Number.isNaN(n))) return `rgba(58,134,255,${alpha})`;
  return `rgba(${r},${g},${b},${alpha})`;
}

function createDefaultTrack(index) {
  return {
    id: uid('track'),
    name: `Track ${index + 1}`,
    color: TRACK_COLORS[index % TRACK_COLORS.length],
    volume: 0,
    pan: 0,
    mute: false,
    solo: false,
    armed: false,
    monitor: true,
    inputId: 'default',
    regions: [],
    effects: {
      gate:       { enabled: false, threshold: -45 },
      lowCut:     { enabled: false, frequency: 80 },
      saturation: { enabled: false, drive: 0.25, warmth: 0.6 },
      guitar:     { enabled: false, mode: 'clean', drive: 0.5 },
      eq:         { low: 0, mid: 0, high: 0 },
      compressor: { enabled: false, threshold: -20, ratio: 4, attack: 0.005, release: 0.2 },
      chorus:     { enabled: false, wet: 0.35, depth: 0.6, rate: 1.5 },
      reverb:     { enabled: false, wet: 0.25, decay: 1.8 },
      delay:      { enabled: false, wet: 0.2, feedback: 0.3 },
    },
  };
}

function createRegion(audioId, startTime, duration, name, offset = 0) {
  return {
    id: uid('region'),
    audioId,
    name,
    startTime,
    duration,
    offset,
    gain: 0,
    fadeIn: 0,
    fadeOut: 0,
  };
}

// ─── Rotary Knob Component ─────────────────────────────────────
function RotaryKnob({ value, min, max, step = 0.01, onChange, onChangeEnd, label, color = 'var(--daw-accent)', formatValue, size = 34 }) {
  const ref = useRef(null);
  const dragRef = useRef(null);

  const range = max - min;
  const normalised = clamp((value - min) / range, 0, 1);

  // Arc geometry
  const cx = size / 2, cy = size / 2;
  const r = size / 2 - 4.5;
  const startAngle = 225;  // degrees from top, clockwise
  const endAngle = -45;
  const totalSweep = 270;  // degrees

  const angleRad = (deg) => ((deg - 90) * Math.PI) / 180;
  const arcPoint = (angle) => ({
    x: cx + r * Math.cos(angleRad(angle)),
    y: cy + r * Math.sin(angleRad(angle)),
  });

  // Track arc (background)
  const describeArc = (start, end) => {
    const s = arcPoint(start);
    const e = arcPoint(end);
    const sweep = start - end;
    const largeArc = Math.abs(sweep) > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 0 ${e.x} ${e.y}`;
  };

  const valueAngle = startAngle - normalised * totalSweep;
  const indicatorR = r - 2.5;
  const indEnd = {
    x: cx + indicatorR * Math.cos(angleRad(valueAngle)),
    y: cy + indicatorR * Math.sin(angleRad(valueAngle)),
  };
  const indStart = {
    x: cx + (indicatorR * 0.4) * Math.cos(angleRad(valueAngle)),
    y: cy + (indicatorR * 0.4) * Math.sin(angleRad(valueAngle)),
  };

  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startValue: value };
    const handleMouseMove = (e2) => {
      const dy = dragRef.current.startY - e2.clientY;
      const sensitivity = range / 150;
      let newVal = dragRef.current.startValue + dy * sensitivity;
      if (step >= 1) newVal = Math.round(newVal / step) * step;
      else newVal = Math.round(newVal / step) * step;
      newVal = clamp(newVal, min, max);
      onChange(newVal);
    };
    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (onChangeEnd) onChangeEnd();
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [value, min, max, step, range, onChange, onChangeEnd]);

  const displayValue = formatValue ? formatValue(value) : (Number.isInteger(step) ? value.toFixed(0) : value.toFixed(1));

  return (
    <div className="daw-knob-group">
      {label && <span className="daw-knob-label">{label}</span>}
      <div className="daw-knob-wrapper" style={{ width: size, height: size }} onMouseDown={handleMouseDown} ref={ref} title={`${label || 'Knob'}: ${displayValue}`}>
        <svg className="daw-knob-svg" viewBox={`0 0 ${size} ${size}`}>
          {/* Track arc */}
          <path d={describeArc(startAngle, endAngle)} className="daw-knob-track-arc" />
          {/* Value arc */}
          <path d={describeArc(startAngle, valueAngle)} className="daw-knob-value-arc" style={{ stroke: color }} />
          {/* Center detent / center notch indicator for Pan */}
          {min < 0 && max > 0 && (
            <circle cx={cx} cy={cy - r} r={0.8} fill="rgba(255,255,255,0.4)" />
          )}
          {/* Knob Outer Bevel */}
          <circle cx={cx} cy={cy} r={r - 2} fill="#181a2e" stroke="rgba(255,255,255,0.12)" strokeWidth="0.75" />
          {/* Knob Inner Body */}
          <circle cx={cx} cy={cy} r={r - 3.5} className="daw-knob-body" />
          {/* Indicator line */}
          <line x1={indStart.x} y1={indStart.y} x2={indEnd.x} y2={indEnd.y} className="daw-knob-indicator" />
        </svg>
      </div>
      <span className="daw-knob-value-text">{displayValue}</span>
    </div>
  );
}


// ─── Component ───────────────────────────────────────────────────

function DawStudio({ token, apiBase = '', onClose }) {
  // ============ STATE ============

  // Project
  const [projectId, setProjectId]       = useState(null);
  const [projectName, setProjectName]   = useState('Untitled Project');
  const [editingName, setEditingName]   = useState(false);
  const [tracks, setTracks]             = useState(() => [createDefaultTrack(0), createDefaultTrack(1)]);
  const [bpm, setBpm]                   = useState(120);
  const [timeSignature, setTimeSignature] = useState([4, 4]);

  // Audio library
  const [audioLib, setAudioLib] = useState({}); // audioId → { name, duration, peaks }

  // Transport
  const [isPlaying, setIsPlaying]       = useState(false);
  const [isRecording, setIsRecording]   = useState(false);
  const [cursorPos, setCursorPos]       = useState(0);  // project-time cursor
  const [loopEnabled, setLoopEnabled]   = useState(false);
  const [loopStart, setLoopStart]       = useState(0);
  const [loopEnd, setLoopEnd]           = useState(16);
  const [metronomeOn, setMetronomeOn]   = useState(false);

  // View
  const [zoom, setZoom]                 = useState(DEFAULT_ZOOM);
  const [scrollX, setScrollX]           = useState(0);
  const [scrollY, setScrollY]           = useState(0);
  const [trackHeight, setTrackHeight]   = useState(DEFAULT_TRACK_H);
  const [selectedTool, setSelectedTool] = useState('pointer');
  const [selectedIds, setSelectedIds]   = useState(new Set());
  const [snapEnabled, setSnapEnabled]   = useState(true);
  const [snapValue, setSnapValue]       = useState('1/4');

  // Mixer
  const [mixerOpen, setMixerOpen]       = useState(false);
  const [fxTrackId, setFxTrackId]       = useState(null);

  // Master
  const [masterVol, setMasterVol]       = useState(0);
  const [limiterOn, setLimiterOn]       = useState(true);

  // Inputs
  const [audioInputDevices, setAudioInputDevices] = useState([]);
  const [inputMeterLevels, setInputMeterLevels] = useState({});
  const [inputPermissionError, setInputPermissionError] = useState(null);

  // Undo / Redo
  const [history, setHistory]           = useState([]);
  const [historyIdx, setHistoryIdx]     = useState(-1);

  // UI
  const [showHome, setShowHome]         = useState(true);
  const [savedProjects, setSavedProjects] = useState([]);
  const [projLoading, setProjLoading]   = useState(false);
  const [isDragOver, setIsDragOver]     = useState(false);
  const [meterLevels, setMeterLevels]   = useState({});
  const [toast, setToast]               = useState(null);
  const [exporting, setExporting]       = useState(false);
  const [exportFormat, setExportFormat] = useState('wav'); // 'wav' or 'mp3'
  const [contextMenu, setContextMenu]   = useState(null);
  const [trackContextMenu, setTrackContextMenu] = useState(null);
  const [pendingDropFiles, setPendingDropFiles] = useState(null); // { files: File[], time: number }
  const [headersWidth, setHeadersWidth] = useState(250);

  // Full Mastering Suite State
  const [masterSuite, setMasterSuite] = useState({
    eq: { low: 0, mid: 0, high: 0, subCut: true },
    compressor: { enabled: false, threshold: -14, ratio: 2.5, attack: 0.03, release: 0.2 },
    width: 1.0,
    isMono: false,
    limiter: { enabled: true, ceiling: -0.5 },
  });
  const [showMasterModal, setShowMasterModal] = useState(false);
  const [activeFxTab, setActiveFxTab] = useState('tone'); // 'prep', 'tone', 'dynamics', 'space'

  // Drum Generator State
  const [showDrumModal, setShowDrumModal] = useState(false);
  const [drumMode, setDrumMode] = useState('preset'); // 'preset' or 'manual'
  const [drumGenre, setDrumGenre] = useState('rock');
  const [drumKit, setDrumKit] = useState('acoustic');
  const [drumFill, setDrumFill] = useState('none');
  const [drumOutput, setDrumOutput] = useState('mixdown');
  const [drumSwing, setDrumSwing] = useState(0);
  const [drumBars, setDrumBars] = useState(4);
  const [drumGrid, setDrumGrid] = useState({
    kick: [...DRUM_PRESETS['rock'].kick],
    snare: [...DRUM_PRESETS['rock'].snare],
    hihat: [...DRUM_PRESETS['rock'].hihat],
  });
  const [isGeneratingDrum, setIsGeneratingDrum] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const previewPlayerRef = useRef(null);

  // Bass Generator State
  const [showBassModal, setShowBassModal] = useState(false);
  const [bassKey, setBassKey] = useState('C');
  const [bassScale, setBassScale] = useState('minor');
  const [bassPattern, setBassPattern] = useState('offbeat');
  const [isGeneratingBass, setIsGeneratingBass] = useState(false);

  // Refs
  const engineRef        = useRef(null);
  const canvasRef        = useRef(null);
  const containerRef     = useRef(null);
  const trackHeadersRef  = useRef(null);
  const fileInputRef     = useRef(null);
  const rafRef           = useRef(null);
  const meterRafRef      = useRef(null);
  const dragRef          = useRef(null); // drag state object
  const tracksRef        = useRef(tracks);
  tracksRef.current      = tracks;
  const cursorRef        = useRef(cursorPos);
  cursorRef.current      = cursorPos;

  // ============ TOAST ============

  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // ============ ENGINE INIT ============

  useEffect(() => {
    async function fetchDevices() {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices.filter(d => d.kind === 'audioinput');
        setAudioInputDevices(inputs);
        setInputPermissionError(null);
      } catch (err) {
        console.error('Failed to enumerate devices or get permission:', err);
        setInputPermissionError('Izin mikrofon/soundcard ditolak. Izinkan akses di browser, lalu refresh.');
      }
    }
    fetchDevices();
    navigator.mediaDevices.addEventListener('devicechange', fetchDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', fetchDevices);
  }, []);

  useEffect(() => {
    const engine = new DawAudioEngine();
    engineRef.current = engine;
    engine.onPlayheadUpdate = (pos) => {
      setCursorPos(pos);
    };
    return () => { engine.dispose(); };
  }, []);

  // Sync track nodes with engine
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    try {
      for (const t of tracks) {
        if (!engine.trackNodes.has(t.id)) engine.createTrackNode(t.id);
        if (engine.trackNodes.has(t.id)) {
          engine.setTrackVolume(t.id, t.volume);
          engine.setTrackPan(t.id, t.pan);
          engine.setTrackMute(t.id, t.mute);
          engine.setTrackEffects(t.id, t.effects);
        }
      }
      engine.updateSoloState(tracks);
      for (const id of engine.trackNodes.keys()) {
        if (!tracks.find(t => t.id === id)) engine.removeTrackNode(id);
      }
    } catch (err) {
      console.error('Track sync error:', err);
    }
  }, [tracks]);

  // Sync master & mastering suite
  useEffect(() => { engineRef.current?.setMasterVolume(masterVol); }, [masterVol]);
  useEffect(() => { engineRef.current?.setMasterLimiter(limiterOn); }, [limiterOn]);
  useEffect(() => { engineRef.current?.setMasterSuite(masterSuite); }, [masterSuite]);
  useEffect(() => { engineRef.current?.setMetronomeEnabled(metronomeOn, bpm); }, [metronomeOn, bpm]);

  // ============ UNDO / REDO ============

  const pushUndo = useCallback((newTracks) => {
    setHistory(prev => {
      const next = prev.slice(0, historyIdx + 1);
      next.push(JSON.parse(JSON.stringify(newTracks)));
      if (next.length > 80) next.shift();
      return next;
    });
    setHistoryIdx(prev => Math.min(prev + 1, 79));
  }, [historyIdx]);

  const undo = useCallback(() => {
    if (historyIdx <= 0) return;
    const prev = history[historyIdx - 1];
    if (prev) { setTracks(JSON.parse(JSON.stringify(prev))); setHistoryIdx(i => i - 1); }
  }, [history, historyIdx]);

  const redo = useCallback(() => {
    if (historyIdx >= history.length - 1) return;
    const next = history[historyIdx + 1];
    if (next) { setTracks(JSON.parse(JSON.stringify(next))); setHistoryIdx(i => i + 1); }
  }, [history, historyIdx]);

  // ============ AUTO-GAIN STAGING ============

  const handleAutoGainStaging = useCallback(() => {
    if (!tracks || tracks.length === 0) return;
    const headroomOffset = tracks.length > 8 ? -4.0 : (tracks.length > 4 ? -2.0 : 0);
    const updated = tracks.map((t) => {
      let targetVol = 0 + headroomOffset;
      const lowerName = (t.name || '').toLowerCase();
      if (lowerName.includes('kick') || lowerName.includes('bass')) {
        targetVol = -2.5 + headroomOffset;
      } else if (lowerName.includes('snare') || lowerName.includes('vocal') || lowerName.includes('lead')) {
        targetVol = -1.5 + headroomOffset;
      } else if (lowerName.includes('hat') || lowerName.includes('perk') || lowerName.includes('shaker')) {
        targetVol = -5.0 + headroomOffset;
      } else if (lowerName.includes('pad') || lowerName.includes('synth') || lowerName.includes('reverb')) {
        targetVol = -6.0 + headroomOffset;
      }
      return { ...t, volume: Math.round(targetVol * 2) / 2 };
    });
    setTracks(updated);
    pushUndo(updated);
    showToast('⚡ Auto-Gain Staging Diterapkan! Level fader seimbang & headroom aman.', 'success');
  }, [tracks, pushUndo, showToast]);

  // ============ TRACK MANAGEMENT ============

  const addTrack = useCallback(() => {
    setTracks(prev => {
      const t = [...prev, createDefaultTrack(prev.length)];
      pushUndo(t);
      return t;
    });
  }, [pushUndo]);

  const removeTrack = useCallback((trackId) => {
    setTracks(prev => {
      const t = prev.filter(t => t.id !== trackId);
      pushUndo(t);
      return t;
    });
    if (fxTrackId === trackId) setFxTrackId(null);
  }, [pushUndo, fxTrackId]);

  const moveTrack = useCallback((trackId, direction) => {
    setTracks(prev => {
      const idx = prev.findIndex(t => t.id === trackId);
      if (idx < 0) return prev;
      if (direction === 'up' && idx > 0) {
        const next = [...prev];
        [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
        pushUndo(next);
        return next;
      }
      if (direction === 'down' && idx < prev.length - 1) {
        const next = [...prev];
        [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
        pushUndo(next);
        return next;
      }
      return prev;
    });
  }, [pushUndo]);

  const updateTrack = useCallback((trackId, updates) => {
    setTracks(prev => prev.map(t => t.id === trackId ? { ...t, ...updates } : t));
  }, []);

  const updateTrackPush = useCallback((trackId, updates) => {
    setTracks(prev => {
      const t = prev.map(t => t.id === trackId ? { ...t, ...updates } : t);
      pushUndo(t);
      return t;
    });
  }, [pushUndo]);

  const refreshAudioInputs = useCallback(async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput');
      setAudioInputDevices(inputs);
      setInputPermissionError(null);
      showToast(inputs.length ? `${inputs.length} input soundcard terdeteksi` : 'Tidak ada input audio', 'info');
    } catch (err) {
      setInputPermissionError('Gagal akses soundcard. Cek izin browser & kabel USB.');
      showToast('Gagal akses input audio', 'error');
    }
  }, [showToast]);

  const armTrack = useCallback(async (trackId) => {
    const engine = engineRef.current;
    if (!engine) return;
    const track = tracksRef.current.find(t => t.id === trackId);
    if (!track) return;

    const nextArmed = !track.armed;
    if (!nextArmed) {
      engine.stopInputMonitor(trackId);
      updateTrack(trackId, { armed: false });
      showToast('Track disarm — input ditutup', 'info');
      return;
    }

    try {
      await engine.init();
      if (!engine.trackNodes.has(trackId)) engine.createTrackNode(trackId);
      await engine.startInputMonitor(trackId, track.inputId || 'default');
      engine.setInputMonitorAudible(trackId, track.monitor !== false);
      engine.setTrackVolume(trackId, track.volume);
      engine.setTrackPan(trackId, track.pan);
      engine.setTrackEffects(trackId, track.effects);
      updateTrack(trackId, { armed: true, monitor: track.monitor !== false });
      showToast(
        'Track armed ✓ Mainkan alat musik. Monitor (🎧) untuk mendengar, lalu tekan Record.',
        'success'
      );
    } catch (err) {
      console.error(err);
      engine.stopInputMonitor(trackId);
      updateTrack(trackId, { armed: false });
      showToast('Gagal buka input. Pilih soundcard yang benar & izinkan akses mic.', 'error');
    }
  }, [updateTrack, showToast]);

  const setTrackInputDevice = useCallback(async (trackId, inputId) => {
    updateTrack(trackId, { inputId });
    const track = tracksRef.current.find(t => t.id === trackId);
    const engine = engineRef.current;
    if (!engine || !track?.armed) return;
    try {
      await engine.startInputMonitor(trackId, inputId);
      engine.setInputMonitorAudible(trackId, track.monitor !== false);
      showToast('Input diganti — monitor aktif ulang', 'info');
    } catch (err) {
      console.error(err);
      showToast('Gagal ganti input device', 'error');
    }
  }, [updateTrack, showToast]);

  const toggleTrackMonitor = useCallback((trackId) => {
    const track = tracksRef.current.find(t => t.id === trackId);
    if (!track) return;
    const next = !(track.monitor !== false);
    updateTrack(trackId, { monitor: next });
    engineRef.current?.setInputMonitorAudible(trackId, next);
    showToast(next
      ? 'Monitor ON — alat musik terdengar di speaker/headphone'
      : 'Monitor OFF — tetap bisa rekam (hindari feedback mic)',
    'info');
  }, [updateTrack, showToast]);

  // ============ AUDIO IMPORT ============

  const importAudioFiles = useCallback(async (files, targetTrackId, dropTime = 0) => {
    const engine = engineRef.current;
    if (!engine) return;
    await engine.init();

    for (const file of files) {
      if (!file.type.startsWith('audio/') && !file.name.match(/\.(mp3|wav|ogg|flac|aac|m4a|webm)$/i)) continue;

      try {
        const result = await engine.loadAudioFile(file);
        setAudioLib(prev => ({
          ...prev,
          [result.audioId]: { name: result.name, duration: result.duration, peaks: result.peaks },
        }));

        const region = createRegion(result.audioId, dropTime, result.duration, result.name);

        setTracks(prev => {
          let trackId = targetTrackId;
          if (!trackId || !prev.find(t => t.id === trackId)) {
            // If no target track, add to first track or create new
            if (prev.length === 0) {
              const newTrack = createDefaultTrack(0);
              newTrack.regions = [region];
              const t = [newTrack];
              pushUndo(t);
              return t;
            }
            trackId = prev[0].id;
          }
          const t = prev.map(t => {
            if (t.id === trackId) {
              return { ...t, regions: [...(t.regions || []), region] };
            }
            return t;
          });
          pushUndo(t);
          return t;
        });

        dropTime += result.duration;
      } catch (err) {
        console.error('Import error:', err);
        showToast(`Gagal import: ${file.name}`, 'error');
      }
    }
  }, [pushUndo, showToast]);

  // ============ TRANSPORT ============

  const handlePlay = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    await engine.init();
    // Ensure track nodes exist (they may have failed to create before init)
    const currentTracks = tracksRef.current;
    for (const t of currentTracks) {
      if (!engine.trackNodes.has(t.id)) engine.createTrackNode(t.id);
      if (engine.trackNodes.has(t.id)) {
        engine.setTrackVolume(t.id, t.volume);
        engine.setTrackPan(t.id, t.pan);
        engine.setTrackMute(t.id, t.mute);
        engine.setTrackEffects(t.id, t.effects);
      }
    }
    engine.updateSoloState(currentTracks);
    if (isPlaying) {
      engine.stop();
      setIsPlaying(false);
    } else {
      engine.play(cursorRef.current, currentTracks, {
        loopEnabled, loopStart, loopEnd, bpm,
      });
      setIsPlaying(true);
    }
  }, [isPlaying, loopEnabled, loopStart, loopEnd, bpm]);

  const handleStop = useCallback(() => {
    const engine = engineRef.current;
    if (engine) {
      engine.stopRecording();
      engine.stop();
    }
    setIsRecording(false);
    setIsPlaying(false);
    setCursorPos(0);
  }, []);

  const handleRecord = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    await engine.init();
    // Ensure track nodes exist
    const currentTracks = tracksRef.current;
    for (const t of currentTracks) {
      if (!engine.trackNodes.has(t.id)) engine.createTrackNode(t.id);
      if (engine.trackNodes.has(t.id)) {
        engine.setTrackVolume(t.id, t.volume);
        engine.setTrackPan(t.id, t.pan);
        engine.setTrackMute(t.id, t.mute);
        engine.setTrackEffects(t.id, t.effects);
      }
    }
    engine.updateSoloState(currentTracks);

    if (isRecording) {
      engine.stopRecording();
      engine.stop();
      setIsRecording(false);
      setIsPlaying(false);
      showToast('Record selesai', 'success');
    } else {
      // Find armed tracks — hanya track yang di-Arm yang direkam
      const armedTracks = currentTracks.filter(t => t.armed);
      if (armedTracks.length === 0) {
        showToast('Arm (●) dulu track yang mau direkam. Track lain tetap diputar sebagai iringan.', 'error');
        return;
      }
      const recStart = cursorRef.current;
      const armedIds = armedTracks.map(t => t.id);
      engine.onRecordingDone = async (trackId, blob) => {
        try {
          const file = new File([blob], `Recording_${Date.now()}.webm`, { type: blob.type || 'audio/webm' });
          await importAudioFiles([file], trackId, recStart);
          showToast('Overdub masuk ke track!', 'success');
        } catch (e) { console.error(e); }
      };

      const armedTracksData = armedTracks.map(t => ({ trackId: t.id, inputId: t.inputId }));
      try {
        await engine.startRecording(armedTracksData);
        // Play semua track SEBAGAI IRINGAN, kecuali track yang sedang di-record
        engine.play(recStart, currentTracks, {
          loopEnabled, loopStart, loopEnd, bpm,
          skipTrackIds: armedIds,
        });
        setIsRecording(true);
        setIsPlaying(true);
        const names = armedTracks.map(t => t.name).join(', ');
        showToast(`REC: ${names} — track lain diputar sebagai iringan`, 'success');
      } catch (err) {
        console.error(err);
        engine.stopRecording();
        showToast('Gagal mulai rekam. Cek soundcard & Arm track lagi.', 'error');
      }
    }
  }, [isRecording, loopEnabled, loopStart, loopEnd, bpm, importAudioFiles, showToast]);

  const seekTo = useCallback((pos) => {
    const engine = engineRef.current;
    setCursorPos(pos);
    if (isPlaying && engine) {
      engine.seekTo(pos, tracksRef.current, { loopEnabled, loopStart, loopEnd, bpm });
    }
  }, [isPlaying, loopEnabled, loopStart, loopEnd, bpm]);

  // ============ METER LEVELS ============

  useEffect(() => {
    if (!isPlaying) { setMeterLevels({}); return; }
    let active = true;
    const engine = engineRef.current;
    const tick = () => {
      if (!active || !engine) return;
      const ids = tracksRef.current.map(t => t.id);
      setMeterLevels(engine.getAllMeterLevels(ids));
      meterRafRef.current = requestAnimationFrame(tick);
    };
    meterRafRef.current = requestAnimationFrame(tick);
    return () => { active = false; cancelAnimationFrame(meterRafRef.current); };
  }, [isPlaying]);

  // Live input meter saat track armed (alat musik / mic)
  useEffect(() => {
    const anyArmed = tracks.some(t => t.armed);
    if (!anyArmed) {
      setInputMeterLevels({});
      return;
    }
    let active = true;
    let rafId = 0;
    const engine = engineRef.current;
    const tick = () => {
      if (!active || !engine) return;
      const next = {};
      for (const t of tracksRef.current) {
        if (t.armed) next[t.id] = engine.getInputMonitorLevel(t.id);
      }
      setInputMeterLevels(next);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => { active = false; cancelAnimationFrame(rafId); };
  }, [tracks]);

  // ============ EXPORT ============

  const handleExport = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    await engine.init();
    setExporting(true);
    try {
      // Calculate project duration
      let maxEnd = 0;
      for (const t of tracksRef.current) {
        for (const r of t.regions) {
          const end = r.startTime + r.duration;
          if (end > maxEnd) maxEnd = end;
        }
      }
      if (maxEnd <= 0) { showToast('Tidak ada audio untuk di-export', 'error'); setExporting(false); return; }
      maxEnd += 0.5; // small padding

      const rendered = await engine.bounce(tracksRef.current, maxEnd, {
        masterVolume: masterVol,
        masterSuite,
      });
      const wavBlob = audioBufferToWav(rendered);

      if (exportFormat === 'mp3') {
        // Send to backend for MP3 conversion
        const formData = new FormData();
        formData.append('file', wavBlob, 'mix.wav');
        
        const response = await fetch(`${apiBase}/api/daw/export_mp3`, {
          method: 'POST',
          headers: token ? { 'Authorization': `Bearer ${token}` } : {},
          body: formData
        });

        if (!response.ok) throw new Error('Gagal convert ke MP3 di server');
        
        const mp3Blob = await response.blob();
        const url = URL.createObjectURL(mp3Blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${projectName || 'mix'}.mp3`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        // Direct WAV export
        const url = URL.createObjectURL(wavBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${projectName || 'mix'}.wav`;
        a.click();
        URL.revokeObjectURL(url);
      }
      showToast('Export berhasil!', 'success');
    } catch (err) {
      console.error('Export error:', err);
      showToast('Gagal export: ' + err.message, 'error');
    }
    setExporting(false);
  }, [projectName, showToast, exportFormat, apiBase, token, masterVol, masterSuite]);

  // ============ DRUM GENERATOR ============

  const handleGenerateDrum = useCallback(async () => {
    if (isPreviewing && previewPlayerRef.current) {
      previewPlayerRef.current.stop();
      previewPlayerRef.current.dispose();
      previewPlayerRef.current = null;
      setIsPreviewing(false);
    }
    
    setIsGeneratingDrum(true);
    try {
      if (engineRef.current) await engineRef.current.init(); // Ensure Tone is initialized
      
      const resultBuffer = await generateDrumLoop({
        bpm,
        bars: drumBars,
        genre: 'custom',
        customGrid: drumGrid,
        kit: drumKit,
        fill: drumFill,
        splitTracks: drumOutput === 'stems',
        swing: drumSwing
      });
      
      if (drumOutput === 'stems') {
        const loadedStems = [];
        for (const [instName, buf] of Object.entries(resultBuffer)) {
          const nativeBuffer = buf.get ? buf.get() : buf;
          const wavBlob = audioBufferToWav(nativeBuffer);
          const file = new File([wavBlob], `Drum_${instName}_${bpm}bpm.wav`, { type: 'audio/wav' });
          const result = await engineRef.current.loadAudioFile(file);
          loadedStems.push({ instName, ...result });
        }
        
        setAudioLib(prev => {
          const next = { ...prev };
          loadedStems.forEach(s => {
            next[s.audioId] = { name: s.name, duration: s.duration, peaks: s.peaks };
          });
          return next;
        });

        setTracks(prev => {
          const newTracks = loadedStems.map((s, idx) => {
            const trk = createDefaultTrack(prev.length + idx);
            trk.name = `Drum ${s.instName}`;
            trk.regions = [createRegion(s.audioId, cursorRef.current, s.duration, s.name)];
            return trk;
          });
          const t = [...prev, ...newTracks];
          pushUndo(t);
          return t;
        });
      } else {
        const nativeBuffer = resultBuffer.get ? resultBuffer.get() : resultBuffer;
        const wavBlob = audioBufferToWav(nativeBuffer);
        const file = new File([wavBlob], `Drum_${drumMode === 'preset' ? drumGenre : 'custom'}_${bpm}bpm.wav`, { type: 'audio/wav' });
        await importAudioFiles([file], null, cursorRef.current);
      }
      
      setShowDrumModal(false);
      showToast('Drum berhasil digenerate!', 'success');
    } catch (err) {
      console.error(err);
      showToast('Gagal: ' + (err.message || err), 'error');
    }
    setIsGeneratingDrum(false);
  }, [bpm, drumBars, drumGenre, drumKit, drumFill, drumOutput, drumGrid, drumSwing, importAudioFiles, showToast, pushUndo, isPreviewing]);

  const handlePreviewDrum = useCallback(async () => {
    if (isPreviewing) {
      if (previewPlayerRef.current) {
        previewPlayerRef.current.stop();
        previewPlayerRef.current.dispose();
        previewPlayerRef.current = null;
      }
      setIsPreviewing(false);
      return;
    }
    
    try {
      if (engineRef.current) await engineRef.current.init();
      const resultBuffer = await generateDrumLoop({
        bpm,
        bars: 2, // Preview 2 bars to hear swing and fill context
        genre: 'custom',
        customGrid: drumGrid,
        kit: drumKit,
        fill: drumFill,
        splitTracks: false,
        swing: drumSwing
      });
      
      const toneBuffer = new Tone.ToneAudioBuffer(resultBuffer);
      const player = new Tone.Player(toneBuffer).toDestination();
      player.loop = true;
      player.start();
      
      previewPlayerRef.current = player;
      setIsPreviewing(true);
    } catch (err) {
      console.error('Preview error:', err);
      showToast('Gagal preview: ' + (err.message || err), 'error');
      setIsPreviewing(false);
    }
  }, [bpm, drumKit, drumFill, drumGrid, drumSwing, isPreviewing, showToast]);

  const handleGenerateBass = useCallback(async () => {
    setIsGeneratingBass(true);
    try {
      const file = await generateBassLoop({
        bpm,
        bars: drumBars, // Reusing drumBars for simplicity
        key: bassKey,
        scale: bassScale,
        pattern: bassPattern
      });
      await importAudioFiles([file], null, cursorRef.current);
      setShowBassModal(false);
      showToast('Bass berhasil digenerate!', 'success');
    } catch (err) {
      console.error(err);
      showToast('Gagal generate bass: ' + (err.message || err), 'error');
    }
    setIsGeneratingBass(false);
  }, [bpm, drumBars, bassKey, bassScale, bassPattern, importAudioFiles, showToast]);

  // ============ PROJECT SAVE / LOAD ============

  const saveProject = useCallback(async () => {
    try {
      const data = {
        name: projectName,
        bpm,
        timeSignature,
        tracks: tracksRef.current,
        masterVolume: masterVol,
        masterLimiterEnabled: limiterOn,
        masterSuite,
      };
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const url = projectId
        ? `${apiBase}/api/daw/projects/${projectId}`
        : `${apiBase}/api/daw/projects`;
      const method = projectId ? 'PUT' : 'POST';
      const resp = await fetch(url, { method, headers, body: JSON.stringify(data) });
      if (!resp.ok) throw new Error('save failed');
      const result = await resp.json();
      if (!projectId) setProjectId(result.id);
      showToast('Project tersimpan!', 'success');
    } catch (err) {
      console.error(err);
      showToast('Gagal menyimpan project', 'error');
    }
  }, [projectId, projectName, bpm, timeSignature, masterVol, limiterOn, masterSuite, token, apiBase, showToast]);

  const loadProject = useCallback(async (id) => {
    try {
      const headers = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const resp = await fetch(`${apiBase}/api/daw/projects/${id}`, { headers });
      if (!resp.ok) throw new Error('load failed');
      const data = await resp.json();
      setProjectId(id);
      setProjectName(data.name || 'Untitled');
      setBpm(data.bpm || 120);
      setTimeSignature(data.timeSignature || [4, 4]);
      setTracks(data.tracks || [createDefaultTrack(0)]);
      setMasterVol(data.masterVolume ?? 0);
      setLimiterOn(data.masterLimiterEnabled ?? true);
      if (data.masterSuite) setMasterSuite(data.masterSuite);
      setCursorPos(0);
      setShowHome(false);
      showToast('Project dimuat!', 'success');
    } catch (err) {
      console.error(err);
      showToast('Gagal memuat project', 'error');
    }
  }, [token, apiBase, showToast]);

  const fetchProjects = useCallback(async () => {
    try {
      setProjLoading(true);
      const headers = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const resp = await fetch(`${apiBase}/api/daw/projects`, { headers });
      if (resp.ok) setSavedProjects(await resp.json());
    } catch (_) { /* ignore */ }
    setProjLoading(false);
  }, [token, apiBase]);

  const deleteProject = useCallback(async (id) => {
    try {
      const headers = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      await fetch(`${apiBase}/api/daw/projects/${id}`, { method: 'DELETE', headers });
      setSavedProjects(prev => prev.filter(p => p.id !== id));
      showToast('Project dihapus', 'success');
    } catch (err) {
      showToast('Gagal menghapus', 'error');
    }
  }, [token, apiBase, showToast]);

  useEffect(() => { if (showHome) fetchProjects(); }, [showHome, fetchProjects]);

  // ============ KEYBOARD SHORTCUTS ============

  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (showHome) return;

      if (e.code === 'Space') { e.preventDefault(); handlePlay(); }
      else if (e.code === 'Enter' || (e.code === 'Digit0' && !e.ctrlKey)) { e.preventDefault(); handleStop(); }
      else if (e.code === 'KeyR' && !e.ctrlKey) { e.preventDefault(); handleRecord(); }
      else if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((e.code === 'KeyZ' && (e.ctrlKey || e.metaKey) && e.shiftKey) || (e.code === 'KeyY' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); redo(); }
      else if (e.code === 'Delete' || e.code === 'Backspace') {
        e.preventDefault();
        // Delete selected regions
        if (selectedIds.size > 0) {
          setTracks(prev => {
            const t = prev.map(track => ({
              ...track,
              regions: track.regions.filter(r => !selectedIds.has(r.id)),
            }));
            pushUndo(t);
            return t;
          });
          setSelectedIds(new Set());
        }
      }
      else if (e.code === 'KeyA' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        // Select all regions
        const allIds = new Set();
        tracksRef.current.forEach(t => t.regions.forEach(r => allIds.add(r.id)));
        setSelectedIds(allIds);
      }
      else if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveProject();
      }
      // Tool shortcuts
      else if (e.code === 'KeyV' && !e.ctrlKey) setSelectedTool('pointer');
      else if (e.code === 'KeyC' && !e.ctrlKey) setSelectedTool('split');
      else if (e.code === 'KeyE' && !e.ctrlKey) setSelectedTool('eraser');
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showHome, handlePlay, handleStop, handleRecord, undo, redo, selectedIds, pushUndo, saveProject]);

  // ============ CANVAS RENDERING ============

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    canvas.width  = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width  = w + 'px';
    canvas.style.height = h + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const currentTracks = tracksRef.current;
    const beatSec = 60 / bpm;
    const barSec  = beatSec * timeSignature[0];

    // ── Background ──
    ctx.fillStyle = '#0d0f1a';
    ctx.fillRect(0, 0, w, h);

    // ── Track lanes ──
    // Track lane rendering
    for (let i = 0; i < currentTracks.length; i++) {
      const y = RULER_HEIGHT + i * trackHeight - scrollY;
      if (y + trackHeight < RULER_HEIGHT || y > h) continue;
      ctx.fillStyle = i % 2 === 0 ? '#141728' : '#111422';
      ctx.fillRect(0, Math.max(RULER_HEIGHT, y), w, trackHeight - (y < RULER_HEIGHT ? RULER_HEIGHT - y : 0));
      // Track divider line
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.moveTo(0, y + trackHeight);
      ctx.lineTo(w, y + trackHeight);
      ctx.stroke();
    }

    // ── Grid lines ──
    const startTime = scrollX / zoom;
    const endTime   = (scrollX + w) / zoom;

    // Sub-beat lines (1/8 or 1/16)
    if (zoom > 40) {
      const subDiv = zoom > 120 ? beatSec / 4 : beatSec / 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 0.5;
      let t = Math.floor(startTime / subDiv) * subDiv;
      while (t <= endTime) {
        const x = Math.round(t * zoom - scrollX);
        ctx.beginPath(); ctx.moveTo(x, RULER_HEIGHT); ctx.lineTo(x, h); ctx.stroke();
        t += subDiv;
      }
    }

    // Beat lines
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 0.5;
    {
      let t = Math.floor(startTime / beatSec) * beatSec;
      while (t <= endTime) {
        const x = Math.round(t * zoom - scrollX);
        ctx.beginPath(); ctx.moveTo(x, RULER_HEIGHT); ctx.lineTo(x, h); ctx.stroke();
        t += beatSec;
      }
    }

    // Bar lines
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    {
      let t = Math.floor(startTime / barSec) * barSec;
      while (t <= endTime) {
        const x = Math.round(t * zoom - scrollX);
        ctx.beginPath(); ctx.moveTo(x, RULER_HEIGHT); ctx.lineTo(x, h); ctx.stroke();
        t += barSec;
      }
    }

    // ── Loop region ──
    if (loopEnabled) {
      const lx1 = loopStart * zoom - scrollX;
      const lx2 = loopEnd * zoom - scrollX;
      ctx.fillStyle = 'rgba(58,134,255,0.08)';
      ctx.fillRect(lx1, RULER_HEIGHT, lx2 - lx1, h - RULER_HEIGHT);
      ctx.strokeStyle = 'rgba(58,134,255,0.4)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(lx1, RULER_HEIGHT); ctx.lineTo(lx1, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(lx2, RULER_HEIGHT); ctx.lineTo(lx2, h); ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── Regions ──
    for (let ti = 0; ti < currentTracks.length; ti++) {
      const track = currentTracks[ti];
      const trackY = RULER_HEIGHT + ti * trackHeight - scrollY;
      if (trackY + trackHeight < RULER_HEIGHT || trackY > h) continue;

      for (const region of (track.regions || [])) {
        const rx = region.startTime * zoom - scrollX;
        const rw = Math.max(1, region.duration * zoom);
        if (rx + rw < 0 || rx > w) continue;

        const ry = trackY + 2;
        const rh = trackHeight - 4;
        const selected = selectedIds.has(region.id);
        const color = track.color || '#3a86ff';

        // Region body
        ctx.save();
        ctx.beginPath();
        const radius = 4;
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(rx, ry, rw, rh, radius);
        } else {
          ctx.rect(rx, ry, rw, rh);
        }
        ctx.clip();

        // Background fill
        ctx.fillStyle = hexToRgba(color, 0.18);
        ctx.fillRect(rx, ry, rw, rh);

        // Waveform (downsample to visible pixels to avoid UI freeze on long clips)
        const peaks = audioLib[region.audioId]?.peaks;
        if (peaks && peaks.length > 0) {
          const totalAudioDuration = audioLib[region.audioId]?.duration || 1;
          const offsetFraction = (region.offset || 0) / totalAudioDuration;
          const durationFraction = region.duration / totalAudioDuration;
          const startIdx = Math.floor(offsetFraction * peaks.length);
          const endIdx   = Math.floor((offsetFraction + durationFraction) * peaks.length);
          const visiblePeaks = peaks.slice(Math.max(0, startIdx), Math.max(startIdx + 1, endIdx));

          if (visiblePeaks.length > 0) {
            const centerY = ry + rh / 2;
            const gainFactor = Math.pow(10, (region.gain || 0) / 20);
            const amp = (rh / 2) * 0.85 * gainFactor;
            ctx.fillStyle = hexToRgba(color, WAVEFORM_COLOR_ALPHA);
            ctx.beginPath();
            const drawW = Math.min(Math.ceil(rw), Math.ceil(w - rx + 2));
            const step = Math.max(1, Math.floor(drawW / 2000));
            // Top half
            for (let i = 0; i < drawW; i += step) {
              const pi = Math.floor((i / rw) * visiblePeaks.length);
              const p = visiblePeaks[Math.min(pi, visiblePeaks.length - 1)];
              const py = centerY - (p?.max ?? 0) * amp;
              if (i === 0) ctx.moveTo(rx + i, py);
              else ctx.lineTo(rx + i, py);
            }
            // Bottom half (reverse)
            for (let i = drawW - 1; i >= 0; i -= step) {
              const pi = Math.floor((i / rw) * visiblePeaks.length);
              const p = visiblePeaks[Math.min(pi, visiblePeaks.length - 1)];
              const py = centerY - (p?.min ?? 0) * amp;
              ctx.lineTo(rx + i, py);
            }
            ctx.closePath();
            ctx.fill();
          }
        }

        // Region name
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.font = '600 10px Inter, system-ui, sans-serif';
        const label = region.name || 'Audio';
        const maxTextW = rw - 8;
        if (maxTextW > 20) {
          ctx.fillText(label, rx + 5, ry + 13, maxTextW);
        }

        ctx.restore();

        // Selection border
        if (selected) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') ctx.roundRect(rx, ry, rw, rh, radius);
          else ctx.rect(rx, ry, rw, rh);
          ctx.stroke();
        } else {
          ctx.strokeStyle = hexToRgba(color, 0.4);
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') ctx.roundRect(rx, ry, rw, rh, radius);
          else ctx.rect(rx, ry, rw, rh);
          ctx.stroke();
        }

        // Resize handles — always visible on all regions
        {
          const handleW = 5;
          const handleH = Math.min(rh - 8, 28);
          const handleY = ry + (rh - handleH) / 2;
          const handleAlpha = selected ? 0.85 : 0.4;
          const handleColor = selected ? '#fff' : hexToRgba(color, 0.9);

          // Left handle
          ctx.fillStyle = handleColor;
          ctx.globalAlpha = handleAlpha;
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') ctx.roundRect(rx + 1, handleY, handleW, handleH, 2);
          else ctx.rect(rx + 1, handleY, handleW, handleH);
          ctx.fill();

          // Right handle
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') ctx.roundRect(rx + rw - handleW - 1, handleY, handleW, handleH, 2);
          else ctx.rect(rx + rw - handleW - 1, handleY, handleW, handleH);
          ctx.fill();

          ctx.globalAlpha = 1;
        }

        // Gain handle (top-center)
        {
          const handleSize = 8;
          const handleX = rx + rw / 2 - handleSize / 2;
          const handleY = ry;
          ctx.fillStyle = selected ? '#fff' : hexToRgba(color, 0.9);
          ctx.beginPath();
          ctx.rect(handleX, handleY, handleSize, handleSize);
          ctx.fill();
          
          // Show dB value when dragging
          if (dragRef.current?.type === 'gain' && dragRef.current?.regionId === region.id) {
            ctx.fillStyle = '#fff';
            ctx.font = '600 11px Inter, sans-serif';
            const dBText = `${(region.gain || 0) > 0 ? '+' : ''}${(region.gain || 0).toFixed(1)} dB`;
            ctx.fillText(dBText, handleX + 12, handleY + 9);
          }
        }
      }
    }

    // ── Playhead ──
    const phx = Math.round(cursorRef.current * zoom - scrollX) + 0.5;
    if (phx >= 0 && phx <= w) {
      ctx.strokeStyle = '#ff3366';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(phx, 0);
      ctx.lineTo(phx, h);
      ctx.stroke();

      // Playhead triangle on ruler
      ctx.fillStyle = '#ff3366';
      ctx.beginPath();
      ctx.moveTo(phx - 6, 0);
      ctx.lineTo(phx + 6, 0);
      ctx.lineTo(phx, 10);
      ctx.closePath();
      ctx.fill();
    }

    // ── Ruler ──
    ctx.fillStyle = '#141730';
    ctx.fillRect(0, 0, w, RULER_HEIGHT);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_HEIGHT);
    ctx.lineTo(w, RULER_HEIGHT);
    ctx.stroke();

    // Ruler bar numbers
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '600 10px JetBrains Mono, Fira Code, monospace';
    {
      let t = Math.floor(startTime / barSec) * barSec;
      let barNum = Math.floor(t / barSec) + 1;
      while (t <= endTime) {
        const x = t * zoom - scrollX;
        ctx.fillText(String(barNum), x + 4, 14);
        // Tick mark
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.beginPath(); ctx.moveTo(x, RULER_HEIGHT - 6); ctx.lineTo(x, RULER_HEIGHT); ctx.stroke();

        // Beat ticks
        if (zoom > 20) {
          for (let b = 1; b < timeSignature[0]; b++) {
            const bx = (t + b * beatSec) * zoom - scrollX;
            ctx.strokeStyle = 'rgba(255,255,255,0.1)';
            ctx.beginPath(); ctx.moveTo(bx, RULER_HEIGHT - 3); ctx.lineTo(bx, RULER_HEIGHT); ctx.stroke();
          }
        }

        // Time text at wider zoom
        if (zoom > 30) {
          ctx.fillStyle = 'rgba(255,255,255,0.25)';
          ctx.font = '500 8px JetBrains Mono, monospace';
          ctx.fillText(formatTime(t), x + 4, 24);
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.font = '600 10px JetBrains Mono, Fira Code, monospace';
        }

        t += barSec;
        barNum++;
      }
    }

    // Loop markers on ruler
    if (loopEnabled) {
      const lx1 = loopStart * zoom - scrollX;
      const lx2 = loopEnd * zoom - scrollX;
      ctx.fillStyle = 'rgba(58,134,255,0.2)';
      ctx.fillRect(lx1, 0, lx2 - lx1, RULER_HEIGHT);
    }

    // Re-draw playhead top over ruler
    if (phx >= 0 && phx <= w) {
      ctx.fillStyle = '#ff3366';
      ctx.beginPath();
      ctx.moveTo(phx - 6, 0);
      ctx.lineTo(phx + 6, 0);
      ctx.lineTo(phx, 10);
      ctx.closePath();
      ctx.fill();
    }

  }, [bpm, timeSignature, trackHeight, scrollX, scrollY, zoom, audioLib, selectedIds, loopEnabled, loopStart, loopEnd]);

  // Canvas render loop
  useEffect(() => {
    let active = true;
    const loop = () => {
      if (!active) return;
      renderCanvas();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { active = false; cancelAnimationFrame(rafRef.current); };
  }, [renderCanvas]);

  // Sync track header scroll with canvas scroll
  useEffect(() => {
    if (trackHeadersRef.current) trackHeadersRef.current.scrollTop = scrollY;
  }, [scrollY]);

  // ============ MOUSE INTERACTIONS ============

  const getTimeFromX = useCallback((clientX) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.max(0, (clientX - rect.left + scrollX) / zoom);
  }, [scrollX, zoom]);

  const getTrackIndexFromY = useCallback((clientY) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return -1;
    const y = clientY - rect.top - RULER_HEIGHT + scrollY;
    if (y < 0) return -1;
    return Math.floor(y / trackHeight);
  }, [scrollY, trackHeight]);

  const findRegionAt = useCallback((clientX, clientY) => {
    const time = getTimeFromX(clientX);
    const ti   = getTrackIndexFromY(clientY);
    const currentTracks = tracksRef.current;
    if (ti < 0 || ti >= currentTracks.length) return null;
    const track = currentTracks[ti];
    for (let ri = track.regions.length - 1; ri >= 0; ri--) {
      const r = track.regions[ri];
      if (time >= r.startTime && time <= r.startTime + r.duration) {
        const rect = canvasRef.current.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        const rx = r.startTime * zoom - scrollX;
        const rw = r.duration * zoom;
        const ry = RULER_HEIGHT + ti * trackHeight - scrollY + 2;

        let edge = null;
        
        // Gain handle detection
        const handleSize = 16;
        const handleX = rx + rw / 2 - handleSize / 2;
        const handleY = ry - 4;
        
        if (x >= handleX && x <= handleX + handleSize && y >= handleY && y <= handleY + handleSize + 4) {
          edge = 'gain';
        } else if (x - rx < RESIZE_HANDLE_W) edge = 'left';
        else if (rx + rw - x < RESIZE_HANDLE_W) edge = 'right';
        return { region: r, trackIndex: ti, trackId: track.id, edge };
      }
    }
    return null;
  }, [getTimeFromX, getTrackIndexFromY, zoom, scrollX]);

  const handleCanvasMouseDown = useCallback((e) => {
    if (e.button === 2) return; // right click handled separately
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const y = e.clientY - rect.top;
    const time = getTimeFromX(e.clientX);

    setContextMenu(null);

    // Click on ruler → seek
    if (y < RULER_HEIGHT) {
      const snapped = snapEnabled ? snapTime(time, bpm, timeSignature, snapValue) : time;
      seekTo(snapped);
      // Start drag for loop range
      dragRef.current = { type: 'ruler', startTime: snapped };
      return;
    }

    const hit = findRegionAt(e.clientX, e.clientY);

    if (selectedTool === 'eraser') {
      if (hit) {
        setTracks(prev => {
          const t = prev.map(track => ({
            ...track,
            regions: track.regions.filter(r => r.id !== hit.region.id),
          }));
          pushUndo(t);
          return t;
        });
      }
      return;
    }

    if (selectedTool === 'split') {
      if (hit) {
        const splitTime = snapEnabled ? snapTime(time, bpm, timeSignature, snapValue) : time;
        const r = hit.region;
        const relSplit = splitTime - r.startTime;
        if (relSplit > 0.01 && relSplit < r.duration - 0.01) {
          const r1 = { ...r, id: uid('region'), duration: relSplit };
          const r2 = { ...r, id: uid('region'), startTime: splitTime, offset: (r.offset || 0) + relSplit, duration: r.duration - relSplit };
          setTracks(prev => {
            const t = prev.map(track => {
              if (track.id !== hit.trackId) return track;
              return { ...track, regions: track.regions.map(reg => reg.id === r.id ? r1 : reg).concat(r2) };
            });
            pushUndo(t);
            return t;
          });
        }
      }
      return;
    }

    // Pointer tool
    if (hit) {
      const r = hit.region;
      if (!e.shiftKey && !selectedIds.has(r.id)) setSelectedIds(new Set([r.id]));
      else if (e.shiftKey) setSelectedIds(prev => { const s = new Set(prev); if (s.has(r.id)) s.delete(r.id); else s.add(r.id); return s; });
      else if (!selectedIds.has(r.id)) setSelectedIds(new Set([r.id]));

      if (hit.edge === 'left' || hit.edge === 'right') {
        dragRef.current = { type: 'resize', regionId: r.id, trackId: hit.trackId, edge: hit.edge, origStart: r.startTime, origDuration: r.duration, origOffset: r.offset || 0, startX: e.clientX };
      } else if (hit.edge === 'gain') {
        dragRef.current = { type: 'gain', regionId: r.id, trackId: hit.trackId, origGain: r.gain || 0, startY: e.clientY };
      } else {
        dragRef.current = { type: 'move', regionId: r.id, trackId: hit.trackId, origStart: r.startTime, origTrackIdx: hit.trackIndex, startX: e.clientX, startY: e.clientY, moved: false };
      }
    } else {
      setSelectedIds(new Set());
      // Click on empty → set cursor
      const snapped = snapEnabled ? snapTime(time, bpm, timeSignature, snapValue) : time;
      if (!isPlaying) setCursorPos(snapped);
    }
  }, [selectedTool, snapEnabled, snapValue, bpm, timeSignature, getTimeFromX, findRegionAt, seekTo, isPlaying, selectedIds, pushUndo]);

  const handleCanvasMouseMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d) {
      // Update cursor based on tool / hover
      const hit = findRegionAt(e.clientX, e.clientY);
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (selectedTool === 'split') canvas.style.cursor = 'crosshair';
      else if (selectedTool === 'eraser') canvas.style.cursor = 'pointer';
      else if (hit?.edge === 'gain') canvas.style.cursor = 'ns-resize';
      else if (hit?.edge) canvas.style.cursor = 'col-resize';
      else if (hit) canvas.style.cursor = 'grab';
      else canvas.style.cursor = 'default';
      return;
    }

    if (d.type === 'ruler') {
      const time = getTimeFromX(e.clientX);
      const snapped = snapEnabled ? snapTime(time, bpm, timeSignature, snapValue) : time;
      seekTo(snapped);
      return;
    }

    if (d.type === 'gain') {
      const dy = d.startY - e.clientY;
      const sensitivity = 0.2; // 0.2 dB per pixel
      const newGain = clamp(d.origGain + dy * sensitivity, -60, 24);
      
      d.moved = true;
      canvasRef.current.style.cursor = 'ns-resize';

      setTracks(prev => prev.map(t => {
        if (t.id !== d.trackId) return t;
        return {
          ...t,
          regions: t.regions.map(r => r.id === d.regionId ? { ...r, gain: newGain } : r)
        };
      }));

      if (engineRef.current) {
        engineRef.current.setRegionGainRealtime(d.regionId, newGain);
      }
      return;
    }

    if (d.type === 'move') {
      const dx = e.clientX - d.startX;
      const dt = dx / zoom;
      let newStart = d.origStart + dt;
      if (snapEnabled) newStart = snapTime(newStart, bpm, timeSignature, snapValue);
      newStart = Math.max(0, newStart);

      const newTrackIdx = getTrackIndexFromY(e.clientY);

      d.moved = true;
      canvasRef.current.style.cursor = 'grabbing';

      setTracks(prev => {
        let currentTrackIdx = -1;
        let regionToMove = null;
        for (let i = 0; i < prev.length; i++) {
          const r = prev[i].regions.find(reg => reg.id === d.regionId);
          if (r) {
            currentTrackIdx = i;
            regionToMove = r;
            break;
          }
        }

        if (!regionToMove) return prev;

        const targetIdx = clamp(newTrackIdx, 0, prev.length - 1);

        if (currentTrackIdx === targetIdx) {
          return prev.map((t, i) => {
            if (i !== currentTrackIdx) return t;
            return { ...t, regions: t.regions.map(r => r.id === d.regionId ? { ...r, startTime: newStart } : r) };
          });
        } else {
          return prev.map((t, i) => {
            if (i === currentTrackIdx) return { ...t, regions: t.regions.filter(r => r.id !== d.regionId) };
            if (i === targetIdx) return { ...t, regions: [...t.regions, { ...regionToMove, startTime: newStart }] };
            return t;
          });
        }
      });
    }

    if (d.type === 'resize') {
      const dx = e.clientX - d.startX;
      const dt = dx / zoom;

      setTracks(prev => prev.map(t => {
        if (t.id !== d.trackId) return t;
        return {
          ...t,
          regions: t.regions.map(r => {
            if (r.id !== d.regionId) return r;
            if (d.edge === 'right') {
              let newDur = d.origDuration + dt;
              const maxDur = (audioLib[r.audioId]?.duration || 999) - (r.offset || 0);
              newDur = clamp(newDur, 0.05, maxDur);
              if (snapEnabled) newDur = snapTime(r.startTime + newDur, bpm, timeSignature, snapValue) - r.startTime;
              return { ...r, duration: Math.max(0.05, newDur) };
            } else {
              let newStart = d.origStart + dt;
              if (snapEnabled) newStart = snapTime(newStart, bpm, timeSignature, snapValue);
              newStart = Math.max(0, newStart);
              const delta = newStart - d.origStart;
              const newDur = d.origDuration - delta;
              const newOffset = d.origOffset + delta;
              if (newDur < 0.05 || newOffset < 0) return r;
              return { ...r, startTime: newStart, duration: newDur, offset: newOffset };
            }
          }),
        };
      }));
    }
  }, [findRegionAt, selectedTool, getTimeFromX, getTrackIndexFromY, snapEnabled, snapValue, bpm, timeSignature, zoom, audioLib, seekTo]);

  const handleCanvasMouseUp = useCallback(() => {
    const d = dragRef.current;
    if (d && (d.type === 'move' || d.type === 'resize') && d.moved !== false) {
      pushUndo(tracksRef.current);
    }
    dragRef.current = null;
    if (canvasRef.current) canvasRef.current.style.cursor = 'default';
  }, [pushUndo]);

  const handleCanvasWheel = useCallback((e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Zoom
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setZoom(prev => clamp(prev * delta, MIN_ZOOM, MAX_ZOOM));
    } else if (e.shiftKey) {
      // Vertical scroll
      setScrollY(prev => Math.max(0, prev + e.deltaY));
    } else {
      // Horizontal scroll
      setScrollX(prev => Math.max(0, prev + e.deltaY));
    }
  }, []);

  const handleCanvasContextMenu = useCallback((e) => {
    e.preventDefault();
    const hit = findRegionAt(e.clientX, e.clientY);
    if (hit) {
      setSelectedIds(new Set([hit.region.id]));
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        regionId: hit.region.id,
        trackId: hit.trackId,
      });
    }
  }, [findRegionAt]);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  useEffect(() => {
    if (!trackContextMenu) return;
    const handler = () => setTrackContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [trackContextMenu]);

  // ============ DRAG & DROP ============

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => setIsDragOver(false), []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter(
      f => f.type.startsWith('audio/') || f.name.match(/\.(mp3|wav|ogg|flac|aac|m4a|webm)$/i)
    );
    if (files.length === 0) return;
    const time = getTimeFromX(e.clientX);
    const snapped = snapEnabled ? snapTime(time, bpm, timeSignature, snapValue) : time;
    // Show track picker dialog
    setPendingDropFiles({ files, time: snapped });
  }, [getTimeFromX, snapEnabled, snapValue, bpm, timeSignature]);

  const confirmDropToTrack = useCallback((trackId) => {
    if (!pendingDropFiles) return;
    importAudioFiles(pendingDropFiles.files, trackId, pendingDropFiles.time);
    setPendingDropFiles(null);
  }, [pendingDropFiles, importAudioFiles]);

  const confirmDropNewTrack = useCallback(() => {
    if (!pendingDropFiles) return;
    // Create new track and import there
    const newTrack = createDefaultTrack(tracksRef.current.length);
    setTracks(prev => {
      const t = [...prev, newTrack];
      pushUndo(t);
      return t;
    });
    // Import after state update
    setTimeout(() => {
      importAudioFiles(pendingDropFiles.files, newTrack.id, pendingDropFiles.time);
    }, 50);
    setPendingDropFiles(null);
  }, [pendingDropFiles, importAudioFiles, pushUndo]);

  const startHeaderResize = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = headersWidth;

    const onMove = (e2) => {
      const w = clamp(startW + (e2.clientX - startX), 120, 500);
      setHeadersWidth(w);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [headersWidth]);

  // ============ CONTEXT MENU ACTIONS ============

  const ctxSplit = useCallback(() => {
    if (!contextMenu) return;
    const pos = cursorRef.current;
    setTracks(prev => {
      const t = prev.map(track => {
        if (track.id !== contextMenu.trackId) return track;
        const r = track.regions.find(r => r.id === contextMenu.regionId);
        if (!r) return track;
        const rel = pos - r.startTime;
        if (rel <= 0.01 || rel >= r.duration - 0.01) return track;
        const r1 = { ...r, id: uid('region'), duration: rel };
        const r2 = { ...r, id: uid('region'), startTime: pos, offset: (r.offset || 0) + rel, duration: r.duration - rel };
        return { ...track, regions: track.regions.filter(rr => rr.id !== r.id).concat(r1, r2) };
      });
      pushUndo(t);
      return t;
    });
    setContextMenu(null);
  }, [contextMenu, pushUndo]);

  const ctxDuplicate = useCallback(() => {
    if (!contextMenu) return;
    setTracks(prev => {
      const t = prev.map(track => {
        if (track.id !== contextMenu.trackId) return track;
        const r = track.regions.find(r => r.id === contextMenu.regionId);
        if (!r) return track;
        const copy = { ...r, id: uid('region'), startTime: r.startTime + r.duration };
        return { ...track, regions: [...track.regions, copy] };
      });
      pushUndo(t);
      return t;
    });
    setContextMenu(null);
  }, [contextMenu, pushUndo]);

  const ctxDelete = useCallback(() => {
    if (!contextMenu) return;
    setTracks(prev => {
      const t = prev.map(track => ({
        ...track,
        regions: track.regions.filter(r => r.id !== contextMenu.regionId),
      }));
      pushUndo(t);
      return t;
    });
    setSelectedIds(prev => { const s = new Set(prev); s.delete(contextMenu.regionId); return s; });
    setContextMenu(null);
  }, [contextMenu, pushUndo]);

  const ctxDuplicateTrack = useCallback(() => {
    if (!trackContextMenu) return;
    setTracks(prev => {
      const idx = prev.findIndex(t => t.id === trackContextMenu.trackId);
      if (idx === -1) return prev;
      const t = prev[idx];
      const newTrack = {
        ...t,
        id: uid('track'),
        name: t.name + ' (Copy)',
        regions: t.regions.map(r => ({ ...r, id: uid('region') }))
      };
      const next = [...prev];
      next.splice(idx + 1, 0, newTrack);
      pushUndo(next);
      return next;
    });
    setTrackContextMenu(null);
  }, [trackContextMenu, pushUndo]);

  // ============ NEW PROJECT ============

  const newProject = useCallback(() => {
    const engine = engineRef.current;
    if (engine) engine.stop();
    setIsPlaying(false);
    setIsRecording(false);
    setProjectId(null);
    setProjectName('Untitled Project');
    setTracks([createDefaultTrack(0), createDefaultTrack(1)]);
    setAudioLib({});
    setCursorPos(0);
    setBpm(120);
    setTimeSignature([4, 4]);
    setMasterVol(0);
    setLimiterOn(true);
    setSelectedIds(new Set());
    setHistory([]);
    setHistoryIdx(-1);
    setScrollX(0);
    setScrollY(0);
    setShowHome(false);
  }, []);

  // ============ RENDER — HOME ============

  if (showHome) {
    return (
      <div className="daw-studio">
        <div className="daw-home">
          <div className="daw-home-hero">
            <h2>🎹 DAW Studio</h2>
            <p>Multi-track recording, arrangement, mixing & mastering — terinspirasi dari Studio One. Drag & drop audio, edit region, tambah efek, dan export mix Anda.</p>
          </div>
          <div className="daw-home-actions">
            <button className="daw-home-btn primary" onClick={newProject}>
              <Plus size={20} /> Project Baru
            </button>
            <label className="daw-home-btn secondary" style={{ cursor: 'pointer' }}>
              <Upload size={20} /> Import Audio
              <input
                type="file"
                accept="audio/*,.mp3,.wav,.ogg,.flac,.aac,.m4a"
                multiple
                hidden
                onChange={(e) => {
                  const files = Array.from(e.target.files);
                  newProject();
                  importAudioFiles(files, null, 0);
                  e.target.value = '';
                }}
              />
            </label>
            {onClose && (
              <button className="daw-home-btn secondary" onClick={onClose}>
                ← Kembali ke Menu
              </button>
            )}
          </div>

          {savedProjects.length > 0 && (
            <div className="daw-home-projects">
              <h3><FolderOpen size={18} /> Project Tersimpan</h3>
              {savedProjects.map(p => (
                <div key={p.id} className="daw-project-item" onClick={() => loadProject(p.id)}>
                  <div className="daw-project-item-info">
                    <div className="daw-project-item-name">{p.name || 'Untitled'}</div>
                    <div className="daw-project-item-meta">
                      {p.bpm || 120} BPM · {p.trackCount || '?'} tracks · {p.modified ? new Date(p.modified).toLocaleDateString('id-ID') : ''}
                    </div>
                  </div>
                  <div className="daw-project-item-actions">
                    <button onClick={(e) => { e.stopPropagation(); deleteProject(p.id); }} title="Hapus">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {projLoading && <Loader2 size={24} className="spinner" />}
        </div>
      </div>
    );
  }

  // ============ RENDER — STUDIO ============

  // Render studio UI

  return (
    <div className="daw-studio">
      {/* ── Transport Bar ── */}
      <div className="daw-transport">
        <div className="daw-transport-group">
          {onClose && (
            <button
              className="daw-action-btn"
              onClick={onClose}
              title="Kembali ke Menu Utama"
              style={{
                fontSize: '0.7rem',
                padding: '4px 12px',
                gap: 5,
                background: 'linear-gradient(135deg, #ff8c00, #e65100)',
                border: '1px solid #ff9800',
                color: '#fff',
                fontWeight: 700,
                borderRadius: 6,
                textShadow: '0 1px 2px rgba(0,0,0,0.3)',
              }}
            >
              <ArrowLeft size={14} /> Menu Utama
            </button>
          )}
          <button className="daw-transport-btn" onClick={() => { setShowHome(true); handleStop(); }} title="DAW Home / Open Project">
            <FolderOpen size={16} />
          </button>
        </div>

        <div className="daw-transport-group">
          <button className="daw-transport-btn" onClick={handleStop} title="Stop (Enter)">
            <Square size={16} fill="currentColor" />
          </button>
          <button className={`daw-transport-btn play-btn`} onClick={handlePlay} title="Play / Pause (Space)">
            {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
          </button>
          <button className={`daw-transport-btn record-btn ${isRecording ? 'active' : ''}`} onClick={handleRecord} title="Record (R)">
            <Circle size={16} fill={isRecording ? 'currentColor' : 'none'} />
          </button>
        </div>

        <div className="daw-transport-group">
          <button className={`daw-transport-btn ${loopEnabled ? 'active' : ''}`} onClick={() => setLoopEnabled(v => !v)} title="Loop">
            <Repeat size={16} />
          </button>
          <button className={`daw-transport-btn ${metronomeOn ? 'active' : ''}`} onClick={() => setMetronomeOn(v => !v)} title="Metronome">
            <Bell size={16} />
          </button>
          <button className={`daw-transport-btn`} onClick={() => setShowDrumModal(true)} title="Generate Drum Loop">
            <Drum size={16} />
          </button>
          <button className={`daw-transport-btn`} onClick={() => setShowBassModal(true)} title="Generate Bassline" style={{ fontWeight: 800, fontSize: '0.8rem' }}>
            ~
          </button>
        </div>

        <div className="daw-transport-group">
          <div className="daw-transport-bpm">
            <label>BPM</label>
            <input
              type="number"
              value={bpm}
              min={20}
              max={300}
              onChange={e => setBpm(clamp(Number(e.target.value) || 120, 20, 300))}
            />
          </div>
          <div className="daw-transport-timesig">
            {timeSignature[0]}/{timeSignature[1]}
          </div>
        </div>

        <div className="daw-transport-position">
          {formatTime(cursorPos)}
        </div>

        <div className="daw-transport-spacer" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <span style={{
            fontFamily: '"Outfit", "Inter", sans-serif',
            fontSize: '1.65rem',
            fontWeight: 800,
            color: '#ffffff',
            letterSpacing: '3px',
            textTransform: 'uppercase',
            userSelect: 'none',
            display: 'inline-block',
            filter: 'drop-shadow(0 2px 8px rgba(131, 56, 236, 0.4))'
          }}>
            JAGAT{' '}
            <span style={{
              background: 'linear-gradient(135deg, #8338ec 0%, #ff477e 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              display: 'inline-block'
            }}>
              DAW
            </span>
          </span>
        </div>

        {editingName ? (
          <input
            className="daw-transport-project-input"
            value={projectName}
            autoFocus
            onChange={e => setProjectName(e.target.value)}
            onBlur={() => setEditingName(false)}
            onKeyDown={e => { if (e.key === 'Enter') setEditingName(false); }}
          />
        ) : (
          <div className="daw-transport-project-name" onClick={() => setEditingName(true)}>
            {projectName}
          </div>
        )}

        <div className="daw-transport-group">
          <button className="daw-action-btn accent" onClick={saveProject} title="Save (Ctrl+S)">
            <Save size={14} /> Simpan
          </button>
          <button className="daw-action-btn" onClick={() => { setShowHome(true); handleStop(); }} title="Buka Project">
            <FolderOpen size={14} /> Open
          </button>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <button 
              className="daw-action-btn" 
              onClick={handleExport} 
              title={`Export as ${exportFormat.toUpperCase()}`} 
              disabled={exporting}
              style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0, borderRight: 'none' }}
            >
              {exporting ? <Loader2 size={14} className="spinner" /> : <Download size={14} />} Export
            </button>
            <select
              className="daw-snap-select"
              value={exportFormat}
              onChange={e => setExportFormat(e.target.value)}
              disabled={exporting}
              style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, height: '26px' }}
            >
              <option value="wav">WAV</option>
              <option value="mp3">MP3</option>
            </select>
          </div>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="daw-toolbar">
        <button className={`daw-tool-btn ${selectedTool === 'pointer' ? 'active' : ''}`} onClick={() => setSelectedTool('pointer')} title="Pointer (V)">
          <MousePointer2 size={14} /> Pointer
        </button>
        <button className={`daw-tool-btn ${selectedTool === 'split' ? 'active' : ''}`} onClick={() => setSelectedTool('split')} title="Split (C)">
          <Scissors size={14} /> Split
        </button>
        <button className={`daw-tool-btn ${selectedTool === 'eraser' ? 'active' : ''}`} onClick={() => setSelectedTool('eraser')} title="Eraser (E)">
          <Eraser size={14} /> Eraser
        </button>

        <div className="daw-toolbar-divider" />

        <button className="daw-tool-btn" onClick={undo} title="Undo (Ctrl+Z)"><Undo2 size={14} /></button>
        <button className="daw-tool-btn" onClick={redo} title="Redo (Ctrl+Shift+Z)"><Redo2 size={14} /></button>

        <div className="daw-toolbar-divider" />

        <span className="daw-toolbar-label">Snap</span>
        <button
          className={`daw-tool-btn ${snapEnabled ? 'active' : ''}`}
          onClick={() => setSnapEnabled(v => !v)}
          title="Toggle Snap"
          style={{ padding: '0 6px' }}
        >
          <Layers size={13} />
        </button>
        <select
          className="daw-snap-select"
          value={snapValue}
          onChange={e => setSnapValue(e.target.value)}
        >
          {SNAP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <div className="daw-zoom-group">
          <ZoomOut size={14} style={{ color: 'var(--daw-text-dim)' }} />
          <input
            type="range"
            className="daw-zoom-slider"
            min={0}
            max={100}
            value={Math.log(zoom / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM) * 100}
            onChange={e => {
              const val = Number(e.target.value);
              const newZoom = MIN_ZOOM * Math.exp((val / 100) * Math.log(MAX_ZOOM / MIN_ZOOM));
              setZoom(newZoom);
            }}
          />
          <ZoomIn size={14} style={{ color: 'var(--daw-text-dim)' }} />

          <div className="daw-toolbar-divider" />
          <span className="daw-toolbar-label">Height</span>
          <input
            type="range"
            className="daw-zoom-slider"
            style={{ width: 60 }}
            min={MIN_TRACK_H}
            max={MAX_TRACK_H}
            value={trackHeight}
            onChange={e => setTrackHeight(Number(e.target.value))}
          />
        </div>
      </div>

      {/* ── Main workspace ── */}
      <div className="daw-workspace">
        {/* Track headers */}
        <div className="daw-track-headers" ref={trackHeadersRef} style={{ width: headersWidth, minWidth: headersWidth, maxWidth: headersWidth }}>
          <div className="daw-track-header-ruler">Tracks</div>
          {tracks.map((track) => (
            <div
              key={track.id}
              className="daw-track-header"
              style={{ height: trackHeight, '--track-color': track.color }}
              onContextMenu={(e) => {
                e.preventDefault();
                setTrackContextMenu({ x: e.clientX, y: e.clientY, trackId: track.id });
              }}
            >
              <div className="daw-track-header-top">
                <input
                  className="daw-track-name"
                  value={track.name}
                  onChange={e => updateTrack(track.id, { name: e.target.value })}
                  spellCheck={false}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 2 }}>
                  <button
                    className="daw-track-ctrl-btn"
                    onClick={() => moveTrack(track.id, 'up')}
                    title="Pindah ke atas"
                    style={{ width: 22, height: 16, fontSize: '0.6rem', padding: 0 }}
                  >▲</button>
                  <button
                    className="daw-track-ctrl-btn"
                    onClick={() => moveTrack(track.id, 'down')}
                    title="Pindah ke bawah"
                    style={{ width: 22, height: 16, fontSize: '0.6rem', padding: 0 }}
                  >▼</button>
                </div>
                <button
                  className="daw-track-ctrl-btn"
                  onClick={() => removeTrack(track.id)}
                  title="Hapus track"
                  style={{ color: 'var(--daw-text-dim)', width: 28, height: 26 }}
                >
                  <X size={14} />
                </button>
              </div>
              <div className="daw-track-header-controls">
                <button
                  className={`daw-track-ctrl-btn ${track.mute ? 'mute-active' : ''}`}
                  onClick={() => updateTrackPush(track.id, { mute: !track.mute })}
                  title="Mute"
                >M</button>
                <button
                  className={`daw-track-ctrl-btn ${track.solo ? 'solo-active' : ''}`}
                  onClick={() => updateTrackPush(track.id, { solo: !track.solo })}
                  title="Solo"
                >S</button>
                <button
                  className={`daw-track-ctrl-btn ${track.armed ? 'arm-active' : ''}`}
                  onClick={() => armTrack(track.id)}
                  title="Arm Record — siap rekam dari soundcard/alat musik"
                >●</button>
                <button
                  className={`daw-track-ctrl-btn ${track.armed && track.monitor !== false ? 'monitor-active' : ''}`}
                  onClick={() => toggleTrackMonitor(track.id)}
                  disabled={!track.armed}
                  title={track.monitor !== false ? 'Monitor ON (dengar input)' : 'Monitor OFF'}
                >
                  <Headphones size={14} />
                </button>
                <button
                  className="daw-track-ctrl-btn"
                  onClick={() => setFxTrackId(fxTrackId === track.id ? null : track.id)}
                  title="Effects"
                  style={fxTrackId === track.id ? { color: 'var(--daw-accent)', borderColor: 'var(--daw-accent)' } : {}}
                >
                  <Sliders size={14} />
                </button>
              </div>
              <div className="daw-track-volume-row">
                <Volume2 size={14} style={{ color: 'var(--daw-text-dim)', flexShrink: 0 }} />
                <input
                  type="range"
                  className="daw-track-vol-slider"
                  min={-60}
                  max={12}
                  step={0.5}
                  value={track.volume}
                  onChange={e => updateTrack(track.id, { volume: Number(e.target.value) })}
                  onMouseUp={() => pushUndo(tracksRef.current)}
                  style={{ '--track-color': track.color }}
                />
                <span className="daw-track-vol-label">{track.volume > 0 ? '+' : ''}{track.volume.toFixed(1)}</span>
                <input
                  type="range"
                  className="daw-track-pan-slider"
                  min={-1}
                  max={1}
                  step={0.05}
                  value={track.pan}
                  onChange={e => updateTrack(track.id, { pan: Number(e.target.value) })}
                  onMouseUp={() => pushUndo(tracksRef.current)}
                  title={`Pan: ${track.pan > 0 ? 'R' : track.pan < 0 ? 'L' : 'C'} ${Math.abs(Math.round(track.pan * 100))}%`}
                />
              </div>
              <div className="daw-track-input-row">
                <select
                  className="daw-track-input-select"
                  value={track.inputId || 'default'}
                  onChange={e => setTrackInputDevice(track.id, e.target.value)}
                  title="Pilih input soundcard / interface untuk alat musik atau mic"
                >
                  <option value="default">Input Default (System)</option>
                  {audioInputDevices.map(d => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Input ${d.deviceId.slice(0, 6)}…`}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="daw-track-input-refresh"
                  onClick={refreshAudioInputs}
                  title="Refresh daftar soundcard"
                >
                  <RefreshCw size={13} />
                </button>
              </div>
              {track.armed && (
                <div className="daw-track-input-meter" title="Level input live">
                  <div
                    className="daw-track-input-meter-fill"
                    style={{
                      width: `${Math.max(0, Math.min(100, ((inputMeterLevels[track.id] ?? -100) + 60) / 60 * 100))}%`,
                    }}
                  />
                </div>
              )}
              {inputPermissionError && track === tracks[0] && (
                <div className="daw-track-input-hint">{inputPermissionError}</div>
              )}
            </div>
          ))}
          <button className="daw-add-track-btn" onClick={addTrack}>
            <Plus size={16} /> Tambah Track
          </button>
        </div>

        {/* Resizer */}
        <div className="daw-headers-resizer" onMouseDown={startHeaderResize} />

        {/* Timeline canvas */}
        <div
          className="daw-timeline-wrapper"
          ref={containerRef}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <canvas
            ref={canvasRef}
            className="daw-timeline-canvas"
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
            onWheel={handleCanvasWheel}
            onContextMenu={handleCanvasContextMenu}
          />
          {isDragOver && (
            <div className="daw-timeline-drop-overlay">
              <Upload size={32} /> Drop audio files here
            </div>
          )}
          {tracks.length > 0 && tracks.every(t => (t.regions?.length || 0) === 0) && !isDragOver && (
            <div className="daw-empty-timeline">
              <Music size={48} />
              <p>Drag & drop file audio ke sini, atau klik tombol Import</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Mixer Toggle ── */}
      <button
        type="button"
        className={`daw-mixer-toggle ${mixerOpen ? 'is-open' : ''}`}
        onClick={() => setMixerOpen(v => !v)}
        title={mixerOpen ? 'Tutup mixer' : 'Buka Studio Mixer & Mastering'}
      >
        <Sliders size={16} />
        <span>{mixerOpen ? 'Tutup Mixer' : 'Buka Studio Mixer & Mastering'}</span>
        {mixerOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
      </button>

      {/* ── Mixer Panel ── */}
      {mixerOpen && (
        <div className="daw-mixer-container">
          {/* Mixer Top Toolbar */}
          <div className="daw-mixer-topbar">
            <div className="daw-mixer-topbar-left">
              <span className="daw-mixer-topbar-title">🎛️ STUDIO MIXING CONSOLE</span>
              <span className="daw-mixer-topbar-badge">{tracks.length} Channels</span>
            </div>
            <div className="daw-mixer-topbar-actions">
              <button
                className="daw-mixer-topbar-btn auto-gain"
                onClick={handleAutoGainStaging}
                title="Auto Gain Staging: Menyeimbangkan fader seluruh track agar headroom master aman (-18dB target)"
              >
                <Zap size={13} />
                <span>⚡ Auto-Gain Staging</span>
              </button>
              <button
                className={`daw-mixer-topbar-btn master-suite ${masterSuite.compressor.enabled || masterSuite.limiter.enabled ? 'active' : ''}`}
                onClick={() => setShowMasterModal(true)}
                title="Buka Master Bus Mastering Suite"
              >
                <Sparkles size={13} />
                <span>🎛️ Master Suite (MST FX)</span>
              </button>
            </div>
          </div>

          <div className="daw-mixer">
            {tracks.map((track, trackIdx) => {
              const level = meterLevels[track.id] ?? -100;
              const meterH = Math.max(0, Math.min(100, ((level + 60) / 60) * 100));
              const isClipping = level >= 0;
              const fx = track.effects || {};
              const activeFxCount = [
                fx.gate?.enabled,
                fx.lowCut?.enabled,
                fx.saturation?.enabled,
                fx.guitar?.enabled,
                fx.compressor?.enabled,
                fx.chorus?.enabled,
                fx.delay?.enabled,
                fx.reverb?.enabled,
              ].filter(Boolean).length;

              return (
                <div key={track.id} className="daw-mixer-channel">
                  {/* Header: Track Index & Color Accent */}
                  <div className="daw-mixer-header">
                    <span className="daw-mixer-ch-num">{String(trackIdx + 1).padStart(2, '0')}</span>
                    <div className="daw-mixer-channel-color" style={{ background: track.color, boxShadow: `0 0 8px ${track.color}88` }} />
                  </div>

                  {/* Track Name */}
                  <div className="daw-mixer-channel-label" title={track.name}>{track.name}</div>

                  {/* Knobs Row: Pan */}
                  <div className="daw-mixer-knobs-row">
                    <RotaryKnob
                      label="PAN"
                      value={track.pan}
                      min={-1}
                      max={1}
                      step={0.05}
                      color="#06d6a0"
                      onChange={v => updateTrack(track.id, { pan: v })}
                      onChangeEnd={() => pushUndo(tracksRef.current)}
                      formatValue={v => v === 0 ? 'C' : v < 0 ? `L${Math.round(Math.abs(v) * 100)}` : `R${Math.round(v * 100)}`}
                      size={32}
                    />
                  </div>

                  {/* Fader Area with dB Scale & VU Meter */}
                  <div className="daw-mixer-fader-area">
                    <div className="daw-mixer-scale">
                      <span className="scale-mark" style={{ top: '8.3%' }}>+6</span>
                      <span className="scale-mark zero" style={{ top: '16.6%' }}>0</span>
                      <span className="scale-mark" style={{ top: '25%' }}>-6</span>
                      <span className="scale-mark" style={{ top: '33.3%' }}>-12</span>
                      <span className="scale-mark" style={{ top: '50%' }}>-24</span>
                      <span className="scale-mark" style={{ top: '83.3%' }}>-48</span>
                      <span className="scale-mark" style={{ top: '96%' }}>-∞</span>
                    </div>

                    <div className="daw-mixer-fader-slot">
                      <input
                        type="range"
                        className="daw-mixer-fader"
                        min={-60}
                        max={12}
                        step={0.5}
                        value={track.volume}
                        onChange={e => updateTrack(track.id, { volume: Number(e.target.value) })}
                        onMouseUp={() => pushUndo(tracksRef.current)}
                      />
                    </div>

                    <div className="daw-mixer-meter-column">
                      <div className={`daw-mixer-clip-led ${isClipping ? 'active' : ''}`} title="Peak / Clip Indicator" />
                      <div className="daw-mixer-meter">
                        <div className="daw-mixer-meter-fill" style={{ height: `${meterH}%` }} />
                        <div className="daw-mixer-meter-segments" />
                      </div>
                    </div>
                  </div>

                  {/* Digital dB Display */}
                  <div className="daw-mixer-db-label">
                    <span className="db-value">{track.volume > 0 ? '+' : ''}{track.volume.toFixed(1)}</span>
                    <span className="db-unit">dB</span>
                  </div>

                  {/* Controls (Mute / Solo) */}
                  <div className="daw-mixer-channel-controls">
                    <button
                      className={`daw-mixer-ctrl-btn mute-btn ${track.mute ? 'm-active' : ''}`}
                      onClick={() => updateTrackPush(track.id, { mute: !track.mute })}
                      title="Mute Track"
                    >
                      <span className="btn-led" />
                      M
                    </button>
                    <button
                      className={`daw-mixer-ctrl-btn solo-btn ${track.solo ? 's-active' : ''}`}
                      onClick={() => updateTrackPush(track.id, { solo: !track.solo })}
                      title="Solo Track"
                    >
                      <span className="btn-led" />
                      S
                    </button>
                  </div>

                  {/* EQ / FX Button */}
                  <button
                    className={`daw-mixer-fx-btn ${fxTrackId === track.id ? 'active' : ''} ${activeFxCount > 0 ? 'has-fx' : ''}`}
                    onClick={() => setFxTrackId(fxTrackId === track.id ? null : track.id)}
                    title="Buka Channel FX & Presets Rack"
                  >
                    <Sliders size={12} style={{ marginRight: '3px' }} />
                    <span>FX</span>
                    {activeFxCount > 0 && <span className="daw-fx-active-badge">{activeFxCount}</span>}
                  </button>
                </div>
              );
            })}

            {/* Master Channel */}
            {(() => {
              const masterLevel = meterLevels._master ?? -100;
              const masterMeterH = Math.max(0, Math.min(100, ((masterLevel + 60) / 60) * 100));
              const masterClipping = masterLevel >= 0;
              return (
                <div className="daw-mixer-channel master">
                  <div className="daw-mixer-header">
                    <span className="daw-mixer-ch-num master-num">MST</span>
                    <div className="daw-mixer-channel-color" style={{ background: 'linear-gradient(90deg, #8338ec, #ff477e)', boxShadow: '0 0 10px rgba(255, 71, 126, 0.6)' }} />
                  </div>

                  <div className="daw-mixer-channel-label master-label">MAIN OUT</div>

                  <div className="daw-mixer-knobs-row">
                    <RotaryKnob
                      label="TRIM"
                      value={masterVol}
                      min={-60}
                      max={12}
                      step={0.5}
                      color="#ff477e"
                      onChange={v => setMasterVol(v)}
                      formatValue={v => `${v > 0 ? '+' : ''}${v.toFixed(0)}`}
                      size={34}
                    />
                  </div>

                  <div className="daw-mixer-fader-area">
                    <div className="daw-mixer-scale">
                      <span className="scale-mark" style={{ top: '8.3%' }}>+6</span>
                      <span className="scale-mark zero" style={{ top: '16.6%' }}>0</span>
                      <span className="scale-mark" style={{ top: '25%' }}>-6</span>
                      <span className="scale-mark" style={{ top: '33.3%' }}>-12</span>
                      <span className="scale-mark" style={{ top: '50%' }}>-24</span>
                      <span className="scale-mark" style={{ top: '83.3%' }}>-48</span>
                      <span className="scale-mark" style={{ top: '96%' }}>-∞</span>
                    </div>

                    <div className="daw-mixer-fader-slot master-slot">
                      <input
                        type="range"
                        className="daw-mixer-fader master-fader"
                        min={-60}
                        max={12}
                        step={0.5}
                        value={masterVol}
                        onChange={e => setMasterVol(Number(e.target.value))}
                      />
                    </div>

                    <div className="daw-mixer-meter-column master-meter-col">
                      <div className={`daw-mixer-clip-led ${masterClipping ? 'active' : ''}`} title="Master Peak / Clip Indicator" />
                      <div className="daw-mixer-meter master-meter">
                        <div className="daw-mixer-meter-fill master-fill" style={{ height: `${masterMeterH}%` }} />
                        <div className="daw-mixer-meter-segments" />
                      </div>
                    </div>
                  </div>

                  <div className="daw-mixer-db-label master-db">
                    <span className="db-value">{masterVol > 0 ? '+' : ''}{masterVol.toFixed(1)}</span>
                    <span className="db-unit">dB</span>
                  </div>

                  {/* Master Controls: Limiter Toggle */}
                  <div className="daw-mixer-channel-controls">
                    <button
                      className={`daw-mixer-ctrl-btn limiter-btn ${limiterOn ? 's-active' : ''}`}
                      onClick={() => setLimiterOn(v => !v)}
                      title="Master Brickwall Limiter Fast Toggle"
                      style={{ width: '100%' }}
                    >
                      <span className="btn-led" />
                      LIMITER
                    </button>
                  </div>

                  {/* Master Suite Modal Trigger Button */}
                  <button
                    className="daw-mixer-fx-btn active master-suite-btn"
                    onClick={() => setShowMasterModal(true)}
                    title="Buka Master Mastering Suite (EQ, Glue Compressor, Stereo Width, Brickwall Limiter)"
                  >
                    <Sparkles size={11} style={{ marginRight: 3 }} />
                    <span>MST SUITE</span>
                  </button>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* ── Effects Rack Panel ── */}
      {fxTrackId && (() => {
        const track = tracks.find(t => t.id === fxTrackId);
        if (!track) return null;
        const fx = track.effects || {};
        const setFx = (section, updates) => {
          updateTrackPush(fxTrackId, {
            effects: { ...fx, [section]: { ...(fx[section] || {}), ...updates } },
          });
        };

        const handleApplyPreset = (presetEffects) => {
          updateTrackPush(fxTrackId, {
            effects: JSON.parse(JSON.stringify(presetEffects)),
          });
          showToast('⚡ Preset mixing berhasil dimuat!', 'success');
        };

        return (
          <div className="daw-fx-panel">
            {/* Header */}
            <div className="daw-fx-header">
              <div className="daw-fx-header-left">
                <span className="daw-fx-header-color" style={{ background: track.color }} />
                <span className="daw-fx-header-title">PRO FX RACK — {track.name}</span>
              </div>
              <button className="close-btn" onClick={() => setFxTrackId(null)}><X size={14} /></button>
            </div>

            {/* Quick Presets Dropdown */}
            <div className="daw-fx-preset-bar">
              <span className="daw-fx-preset-label">⚡ Instan Preset:</span>
              <select
                className="daw-fx-preset-select"
                defaultValue=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  const [cat, pId] = e.target.value.split(':::');
                  const foundCat = TRACK_MIXING_PRESETS.find(c => c.category === cat);
                  const foundPreset = foundCat?.presets.find(p => p.id === pId);
                  if (foundPreset) handleApplyPreset(foundPreset.effects);
                  e.target.value = '';
                }}
              >
                <option value="" disabled>Pilih Preset Mixing Vokal / Instrumen...</option>
                {TRACK_MIXING_PRESETS.map(cat => (
                  <optgroup key={cat.category} label={`── ${cat.category} ──`}>
                    {cat.presets.map(p => (
                      <option key={p.id} value={`${cat.category}:::${p.id}`}>
                        {p.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            {/* Tab Navigation */}
            <div className="daw-fx-tabs">
              <button
                className={`daw-fx-tab-btn ${activeFxTab === 'prep' ? 'active' : ''}`}
                onClick={() => setActiveFxTab('prep')}
              >
                🛡️ Filter & Gate
              </button>
              <button
                className={`daw-fx-tab-btn ${activeFxTab === 'tone' ? 'active' : ''}`}
                onClick={() => setActiveFxTab('tone')}
              >
                🎙️ Tone & Drive
              </button>
              <button
                className={`daw-fx-tab-btn ${activeFxTab === 'dynamics' ? 'active' : ''}`}
                onClick={() => setActiveFxTab('dynamics')}
              >
                🎚️ Dinamika
              </button>
              <button
                className={`daw-fx-tab-btn ${activeFxTab === 'space' ? 'active' : ''}`}
                onClick={() => setActiveFxTab('space')}
              >
                🌌 Space & Width
              </button>
            </div>

            {/* Tab Content */}
            <div className="daw-fx-tab-body">
              {/* TAB 1: PREP & FILTER */}
              {activeFxTab === 'prep' && (
                <>
                  {/* NOISE GATE */}
                  <div className="daw-fx-section">
                    <div className="daw-fx-section-header">
                      <div className="daw-fx-section-title-wrap">
                        <ShieldAlert size={14} style={{ color: '#06d6a0' }} />
                        <span className="daw-fx-section-title">Noise Gate (Pembersih Noise)</span>
                      </div>
                      <div className={`daw-fx-toggle ${fx.gate?.enabled ? 'on' : ''}`} onClick={() => setFx('gate', { enabled: !fx.gate?.enabled })} />
                    </div>
                    <div className="daw-fx-row">
                      <label>Threshold</label>
                      <input
                        type="range"
                        className="daw-fx-slider"
                        min={-90}
                        max={-10}
                        step={1}
                        value={fx.gate?.threshold ?? -45}
                        onChange={e => setFx('gate', { threshold: Number(e.target.value) })}
                      />
                      <span className="daw-fx-value">{fx.gate?.threshold ?? -45} dB</span>
                    </div>
                  </div>

                  {/* LOW CUT / HPF */}
                  <div className="daw-fx-section">
                    <div className="daw-fx-section-header">
                      <div className="daw-fx-section-title-wrap">
                        <Activity size={14} style={{ color: '#118ab2' }} />
                        <span className="daw-fx-section-title">Low-Cut / HPF Filter (Potong Bass Bocor)</span>
                      </div>
                      <div className={`daw-fx-toggle ${fx.lowCut?.enabled ? 'on' : ''}`} onClick={() => setFx('lowCut', { enabled: !fx.lowCut?.enabled })} />
                    </div>
                    <div className="daw-fx-row">
                      <label>Cutoff Freq</label>
                      <input
                        type="range"
                        className="daw-fx-slider"
                        min={20}
                        max={400}
                        step={5}
                        value={fx.lowCut?.frequency ?? 80}
                        onChange={e => setFx('lowCut', { frequency: Number(e.target.value) })}
                      />
                      <span className="daw-fx-value">{fx.lowCut?.frequency ?? 80} Hz</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                      <button className="daw-fx-mini-btn" onClick={() => setFx('lowCut', { enabled: true, frequency: 80 })}>Vokal (80Hz)</button>
                      <button className="daw-fx-mini-btn" onClick={() => setFx('lowCut', { enabled: true, frequency: 120 })}>Gitar/Akustik (120Hz)</button>
                      <button className="daw-fx-mini-btn" onClick={() => setFx('lowCut', { enabled: true, frequency: 35 })}>Kick/Sub (35Hz)</button>
                    </div>
                  </div>
                </>
              )}

              {/* TAB 2: TONE & SATURATION */}
              {activeFxTab === 'tone' && (
                <>
                  {/* EQ 3-BAND */}
                  <div className="daw-fx-section">
                    <div className="daw-fx-section-header">
                      <div className="daw-fx-section-title-wrap">
                        <SlidersHorizontal size={14} style={{ color: '#ffd166' }} />
                        <span className="daw-fx-section-title">EQ 3-Band Parametric</span>
                      </div>
                    </div>
                    {['low', 'mid', 'high'].map(band => (
                      <div className="daw-fx-row" key={band}>
                        <label>{band === 'low' ? 'Low (Bass)' : band === 'mid' ? 'Mid (Vokal)' : 'High (Air/Treble)'}</label>
                        <input
                          type="range"
                          className="daw-fx-slider"
                          min={-18}
                          max={18}
                          step={0.5}
                          value={fx.eq?.[band] ?? 0}
                          onChange={e => setFx('eq', { [band]: Number(e.target.value) })}
                        />
                        <span className="daw-fx-value">{(fx.eq?.[band] ?? 0) > 0 ? '+' : ''}{(fx.eq?.[band] ?? 0).toFixed(1)} dB</span>
                      </div>
                    ))}
                  </div>

                  {/* TAPE SATURATION */}
                  <div className="daw-fx-section">
                    <div className="daw-fx-section-header">
                      <div className="daw-fx-section-title-wrap">
                        <Flame size={14} style={{ color: '#ff477e' }} />
                        <span className="daw-fx-section-title">Analog Tape Saturation (Kehangatan)</span>
                      </div>
                      <div className={`daw-fx-toggle ${fx.saturation?.enabled ? 'on' : ''}`} onClick={() => setFx('saturation', { enabled: !fx.saturation?.enabled })} />
                    </div>
                    <div className="daw-fx-row">
                      <label>Drive (Harmonics)</label>
                      <input
                        type="range"
                        className="daw-fx-slider"
                        min={0}
                        max={1}
                        step={0.01}
                        value={fx.saturation?.drive ?? 0.25}
                        onChange={e => setFx('saturation', { drive: Number(e.target.value) })}
                      />
                      <span className="daw-fx-value">{Math.round((fx.saturation?.drive ?? 0.25) * 100)}%</span>
                    </div>
                    <div className="daw-fx-row">
                      <label>Warmth (Ketebalan)</label>
                      <input
                        type="range"
                        className="daw-fx-slider"
                        min={0}
                        max={1}
                        step={0.01}
                        value={fx.saturation?.warmth ?? 0.6}
                        onChange={e => setFx('saturation', { warmth: Number(e.target.value) })}
                      />
                      <span className="daw-fx-value">{Math.round((fx.saturation?.warmth ?? 0.6) * 100)}%</span>
                    </div>
                  </div>

                  {/* GUITAR AMP SIMULATOR */}
                  <div className="daw-fx-section">
                    <div className="daw-fx-section-header">
                      <div className="daw-fx-section-title-wrap">
                        <Radio size={14} style={{ color: '#8338ec' }} />
                        <span className="daw-fx-section-title">Guitar Amp Cabinet Simulator</span>
                      </div>
                      <div className={`daw-fx-toggle ${fx.guitar?.enabled ? 'on' : ''}`} onClick={() => setFx('guitar', { enabled: !fx.guitar?.enabled })} />
                    </div>
                    <div className="daw-fx-row">
                      <label>Mode</label>
                      <select
                        value={fx.guitar?.mode || 'clean'}
                        onChange={e => setFx('guitar', { mode: e.target.value })}
                        className="daw-fx-select"
                      >
                        <option value="clean">Clean Tube Amp</option>
                        <option value="overdrive">Crunch Overdrive</option>
                        <option value="distortion">Heavy Lead Distortion</option>
                      </select>
                    </div>
                    <div className="daw-fx-row">
                      <label>Drive</label>
                      <input
                        type="range"
                        className="daw-fx-slider"
                        min={0}
                        max={1}
                        step={0.01}
                        value={fx.guitar?.drive ?? 0.5}
                        onChange={e => setFx('guitar', { drive: Number(e.target.value) })}
                      />
                      <span className="daw-fx-value">{Math.round((fx.guitar?.drive ?? 0.5) * 100)}%</span>
                    </div>
                  </div>
                </>
              )}

              {/* TAB 3: DYNAMICS / COMPRESSOR */}
              {activeFxTab === 'dynamics' && (
                <div className="daw-fx-section">
                  <div className="daw-fx-section-header">
                    <div className="daw-fx-section-title-wrap">
                      <Gauge size={14} style={{ color: '#06d6a0' }} />
                      <span className="daw-fx-section-title">Studio Dynamics Compressor</span>
                    </div>
                    <div className={`daw-fx-toggle ${fx.compressor?.enabled ? 'on' : ''}`} onClick={() => setFx('compressor', { enabled: !fx.compressor?.enabled })} />
                  </div>
                  <div className="daw-fx-row">
                    <label>Threshold</label>
                    <input
                      type="range"
                      className="daw-fx-slider"
                      min={-60}
                      max={0}
                      step={1}
                      value={fx.compressor?.threshold ?? -20}
                      onChange={e => setFx('compressor', { threshold: Number(e.target.value) })}
                    />
                    <span className="daw-fx-value">{fx.compressor?.threshold ?? -20} dB</span>
                  </div>
                  <div className="daw-fx-row">
                    <label>Ratio</label>
                    <input
                      type="range"
                      className="daw-fx-slider"
                      min={1}
                      max={20}
                      step={0.5}
                      value={fx.compressor?.ratio ?? 4}
                      onChange={e => setFx('compressor', { ratio: Number(e.target.value) })}
                    />
                    <span className="daw-fx-value">{(fx.compressor?.ratio ?? 4).toFixed(1)}:1</span>
                  </div>
                  <div className="daw-fx-row">
                    <label>Attack</label>
                    <input
                      type="range"
                      className="daw-fx-slider"
                      min={0.001}
                      max={0.5}
                      step={0.001}
                      value={fx.compressor?.attack ?? 0.005}
                      onChange={e => setFx('compressor', { attack: Number(e.target.value) })}
                    />
                    <span className="daw-fx-value">{((fx.compressor?.attack ?? 0.005) * 1000).toFixed(0)} ms</span>
                  </div>
                  <div className="daw-fx-row">
                    <label>Release</label>
                    <input
                      type="range"
                      className="daw-fx-slider"
                      min={0.01}
                      max={2}
                      step={0.01}
                      value={fx.compressor?.release ?? 0.2}
                      onChange={e => setFx('compressor', { release: Number(e.target.value) })}
                    />
                    <span className="daw-fx-value">{((fx.compressor?.release ?? 0.2) * 1000).toFixed(0)} ms</span>
                  </div>
                </div>
              )}

              {/* TAB 4: SPACE & CHORUS */}
              {activeFxTab === 'space' && (
                <>
                  {/* STEREO CHORUS */}
                  <div className="daw-fx-section">
                    <div className="daw-fx-section-header">
                      <div className="daw-fx-section-title-wrap">
                        <Repeat size={14} style={{ color: '#06d6a0' }} />
                        <span className="daw-fx-section-title">Stereo Chorus / Doubler</span>
                      </div>
                      <div className={`daw-fx-toggle ${fx.chorus?.enabled ? 'on' : ''}`} onClick={() => setFx('chorus', { enabled: !fx.chorus?.enabled })} />
                    </div>
                    <div className="daw-fx-row">
                      <label>Wet / Mix</label>
                      <input
                        type="range"
                        className="daw-fx-slider"
                        min={0}
                        max={1}
                        step={0.01}
                        value={fx.chorus?.wet ?? 0.35}
                        onChange={e => setFx('chorus', { wet: Number(e.target.value) })}
                      />
                      <span className="daw-fx-value">{Math.round((fx.chorus?.wet ?? 0.35) * 100)}%</span>
                    </div>
                    <div className="daw-fx-row">
                      <label>Depth (Lebar)</label>
                      <input
                        type="range"
                        className="daw-fx-slider"
                        min={0}
                        max={1}
                        step={0.01}
                        value={fx.chorus?.depth ?? 0.6}
                        onChange={e => setFx('chorus', { depth: Number(e.target.value) })}
                      />
                      <span className="daw-fx-value">{Math.round((fx.chorus?.depth ?? 0.6) * 100)}%</span>
                    </div>
                  </div>

                  {/* FEEDBACK DELAY */}
                  <div className="daw-fx-section">
                    <div className="daw-fx-section-header">
                      <div className="daw-fx-section-title-wrap">
                        <Activity size={14} style={{ color: '#118ab2' }} />
                        <span className="daw-fx-section-title">Echo / Feedback Delay</span>
                      </div>
                      <div className={`daw-fx-toggle ${fx.delay?.enabled ? 'on' : ''}`} onClick={() => setFx('delay', { enabled: !fx.delay?.enabled })} />
                    </div>
                    <div className="daw-fx-row">
                      <label>Wet / Mix</label>
                      <input
                        type="range"
                        className="daw-fx-slider"
                        min={0}
                        max={1}
                        step={0.01}
                        value={fx.delay?.wet ?? 0.2}
                        onChange={e => setFx('delay', { wet: Number(e.target.value) })}
                      />
                      <span className="daw-fx-value">{Math.round((fx.delay?.wet ?? 0.2) * 100)}%</span>
                    </div>
                    <div className="daw-fx-row">
                      <label>Feedback</label>
                      <input
                        type="range"
                        className="daw-fx-slider"
                        min={0}
                        max={0.95}
                        step={0.01}
                        value={fx.delay?.feedback ?? 0.3}
                        onChange={e => setFx('delay', { feedback: Number(e.target.value) })}
                      />
                      <span className="daw-fx-value">{Math.round((fx.delay?.feedback ?? 0.3) * 100)}%</span>
                    </div>
                  </div>

                  {/* REVERB */}
                  <div className="daw-fx-section">
                    <div className="daw-fx-section-header">
                      <div className="daw-fx-section-title-wrap">
                        <Music size={14} style={{ color: '#ff477e' }} />
                        <span className="daw-fx-section-title">Studio Hall Reverb</span>
                      </div>
                      <div className={`daw-fx-toggle ${fx.reverb?.enabled ? 'on' : ''}`} onClick={() => setFx('reverb', { enabled: !fx.reverb?.enabled })} />
                    </div>
                    <div className="daw-fx-row">
                      <label>Wet / Mix</label>
                      <input
                        type="range"
                        className="daw-fx-slider"
                        min={0}
                        max={1}
                        step={0.01}
                        value={fx.reverb?.wet ?? 0.25}
                        onChange={e => setFx('reverb', { wet: Number(e.target.value) })}
                      />
                      <span className="daw-fx-value">{Math.round((fx.reverb?.wet ?? 0.25) * 100)}%</span>
                    </div>
                    <div className="daw-fx-row">
                      <label>Decay Time</label>
                      <input
                        type="range"
                        className="daw-fx-slider"
                        min={0.1}
                        max={8}
                        step={0.1}
                        value={fx.reverb?.decay ?? 1.8}
                        onChange={e => setFx('reverb', { decay: Number(e.target.value) })}
                      />
                      <span className="daw-fx-value">{(fx.reverb?.decay ?? 1.8).toFixed(1)}s</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* ── Master Bus Mastering Suite Modal ── */}
      {showMasterModal && (
        <div className="daw-modal-overlay" onClick={() => setShowMasterModal(false)}>
          <div className="daw-master-modal" onClick={e => e.stopPropagation()}>
            <div className="daw-master-modal-header">
              <div className="header-title-group">
                <Sparkles size={20} className="glow-icon" />
                <h3>MASTER BUS MASTERING SUITE</h3>
                <span className="master-badge">Final Mix Polish</span>
              </div>
              <button className="close-btn" onClick={() => setShowMasterModal(false)}>
                <X size={16} />
              </button>
            </div>

            {/* Mastering Preset Selector */}
            <div className="daw-master-preset-bar">
              <span className="preset-label">⚡ Pilih Target Mastering:</span>
              <div className="preset-buttons-grid">
                {MASTERING_PRESETS.map(p => (
                  <button
                    key={p.id}
                    className="daw-master-preset-btn"
                    onClick={() => {
                      setMasterSuite(JSON.parse(JSON.stringify(p.suite)));
                      showToast(`Master Preset '${p.name}' Diterapkan!`, 'success');
                    }}
                  >
                    <span className="p-name">{p.name}</span>
                    <span className="p-desc">{p.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* 4 Core Mastering Modules */}
            <div className="daw-master-modules-grid">
              {/* MODULE 1: Master Glue Compressor */}
              <div className="daw-master-module">
                <div className="module-header">
                  <div className="module-title">
                    <Gauge size={15} style={{ color: '#06d6a0' }} />
                    <span>Master Bus Glue Compressor</span>
                  </div>
                  <div
                    className={`daw-fx-toggle ${masterSuite.compressor.enabled ? 'on' : ''}`}
                    onClick={() => setMasterSuite(prev => ({
                      ...prev,
                      compressor: { ...prev.compressor, enabled: !prev.compressor.enabled }
                    }))}
                  />
                </div>
                <div className="module-content">
                  <div className="daw-fx-row">
                    <label>Threshold</label>
                    <input
                      type="range"
                      className="daw-fx-slider"
                      min={-36}
                      max={0}
                      step={0.5}
                      value={masterSuite.compressor.threshold}
                      onChange={e => setMasterSuite(prev => ({
                        ...prev,
                        compressor: { ...prev.compressor, threshold: Number(e.target.value) }
                      }))}
                    />
                    <span className="daw-fx-value">{masterSuite.compressor.threshold} dB</span>
                  </div>
                  <div className="daw-fx-row">
                    <label>Ratio</label>
                    <input
                      type="range"
                      className="daw-fx-slider"
                      min={1.2}
                      max={6}
                      step={0.1}
                      value={masterSuite.compressor.ratio}
                      onChange={e => setMasterSuite(prev => ({
                        ...prev,
                        compressor: { ...prev.compressor, ratio: Number(e.target.value) }
                      }))}
                    />
                    <span className="daw-fx-value">{masterSuite.compressor.ratio.toFixed(1)}:1</span>
                  </div>
                  <div className="daw-fx-row">
                    <label>Attack</label>
                    <input
                      type="range"
                      className="daw-fx-slider"
                      min={0.005}
                      max={0.1}
                      step={0.005}
                      value={masterSuite.compressor.attack}
                      onChange={e => setMasterSuite(prev => ({
                        ...prev,
                        compressor: { ...prev.compressor, attack: Number(e.target.value) }
                      }))}
                    />
                    <span className="daw-fx-value">{(masterSuite.compressor.attack * 1000).toFixed(0)} ms</span>
                  </div>
                  <div className="daw-fx-row">
                    <label>Release</label>
                    <input
                      type="range"
                      className="daw-fx-slider"
                      min={0.05}
                      max={1.0}
                      step={0.05}
                      value={masterSuite.compressor.release}
                      onChange={e => setMasterSuite(prev => ({
                        ...prev,
                        compressor: { ...prev.compressor, release: Number(e.target.value) }
                      }))}
                    />
                    <span className="daw-fx-value">{(masterSuite.compressor.release * 1000).toFixed(0)} ms</span>
                  </div>
                </div>
              </div>

              {/* MODULE 2: Master Precision Linear EQ */}
              <div className="daw-master-module">
                <div className="module-header">
                  <div className="module-title">
                    <SlidersHorizontal size={15} style={{ color: '#ffd166' }} />
                    <span>Master Precision Linear EQ</span>
                  </div>
                  <button
                    className={`daw-fx-subcut-btn ${masterSuite.eq.subCut ? 'active' : ''}`}
                    onClick={() => setMasterSuite(prev => ({
                      ...prev,
                      eq: { ...prev.eq, subCut: !prev.eq.subCut }
                    }))}
                    title="Sub-Cut Filter: Memotong frekuensi di bawah 30Hz agar speaker tidak rumble"
                  >
                    30Hz Sub-Cut {masterSuite.eq.subCut ? 'ON' : 'OFF'}
                  </button>
                </div>
                <div className="module-content">
                  <div className="daw-fx-row">
                    <label>Low (Bass Punch)</label>
                    <input
                      type="range"
                      className="daw-fx-slider"
                      min={-8}
                      max={8}
                      step={0.2}
                      value={masterSuite.eq.low}
                      onChange={e => setMasterSuite(prev => ({
                        ...prev,
                        eq: { ...prev.eq, low: Number(e.target.value) }
                      }))}
                    />
                    <span className="daw-fx-value">{masterSuite.eq.low > 0 ? '+' : ''}{masterSuite.eq.low.toFixed(1)} dB</span>
                  </div>
                  <div className="daw-fx-row">
                    <label>Mid (Clarity)</label>
                    <input
                      type="range"
                      className="daw-fx-slider"
                      min={-8}
                      max={8}
                      step={0.2}
                      value={masterSuite.eq.mid}
                      onChange={e => setMasterSuite(prev => ({
                        ...prev,
                        eq: { ...prev.eq, mid: Number(e.target.value) }
                      }))}
                    />
                    <span className="daw-fx-value">{masterSuite.eq.mid > 0 ? '+' : ''}{masterSuite.eq.mid.toFixed(1)} dB</span>
                  </div>
                  <div className="daw-fx-row">
                    <label>High (Air & Shimmer)</label>
                    <input
                      type="range"
                      className="daw-fx-slider"
                      min={-8}
                      max={8}
                      step={0.2}
                      value={masterSuite.eq.high}
                      onChange={e => setMasterSuite(prev => ({
                        ...prev,
                        eq: { ...prev.eq, high: Number(e.target.value) }
                      }))}
                    />
                    <span className="daw-fx-value">{masterSuite.eq.high > 0 ? '+' : ''}{masterSuite.eq.high.toFixed(1)} dB</span>
                  </div>
                </div>
              </div>

              {/* MODULE 3: Stereo Imager & Mono Compatibility */}
              <div className="daw-master-module">
                <div className="module-header">
                  <div className="module-title">
                    <Repeat size={15} style={{ color: '#118ab2' }} />
                    <span>Stereo Imager & Mono Check</span>
                  </div>
                  <button
                    className={`daw-fx-mono-btn ${masterSuite.isMono ? 'active' : ''}`}
                    onClick={() => setMasterSuite(prev => ({
                      ...prev,
                      isMono: !prev.isMono
                    }))}
                    title="Uji kompatibilitas mono pada speaker smartphone & TikTok"
                  >
                    {masterSuite.isMono ? '🔊 MONO CHECK: ON' : '🎧 STEREO MODE'}
                  </button>
                </div>
                <div className="module-content">
                  <div className="daw-fx-row">
                    <label>Stereo Width</label>
                    <input
                      type="range"
                      className="daw-fx-slider"
                      min={0}
                      max={1.5}
                      step={0.05}
                      disabled={masterSuite.isMono}
                      value={masterSuite.width}
                      onChange={e => setMasterSuite(prev => ({
                        ...prev,
                        width: Number(e.target.value)
                      }))}
                    />
                    <span className="daw-fx-value">{masterSuite.isMono ? '0%' : `${Math.round(masterSuite.width * 100)}%`}</span>
                  </div>
                  <p className="daw-master-hint">
                    💡 Tip: 100% = Normal Stereo, di atas 100% = lebih lebar, 0% = Mono.
                    Nilai ekstrem bisa menipiskan suara tengah (vokal/bass).
                  </p>
                </div>
              </div>

              {/* MODULE 4: Brickwall Limiter */}
              <div className="daw-master-module">
                <div className="module-header">
                  <div className="module-title">
                    <ShieldAlert size={15} style={{ color: '#ff477e' }} />
                    <span>Master Brickwall Limiter (Anti-Clip)</span>
                  </div>
                  <div
                    className={`daw-fx-toggle ${masterSuite.limiter.enabled ? 'on' : ''}`}
                    onClick={() => {
                      const newEnabled = !masterSuite.limiter.enabled;
                      setLimiterOn(newEnabled);
                      setMasterSuite(prev => ({
                        ...prev,
                        limiter: { ...prev.limiter, enabled: newEnabled }
                      }));
                    }}
                  />
                </div>
                <div className="module-content">
                  <div className="daw-fx-row">
                    <label>Output Ceiling</label>
                    <input
                      type="range"
                      className="daw-fx-slider"
                      min={-4.0}
                      max={0.0}
                      step={0.1}
                      value={masterSuite.limiter.ceiling}
                      onChange={e => setMasterSuite(prev => ({
                        ...prev,
                        limiter: { ...prev.limiter, ceiling: Number(e.target.value) }
                      }))}
                    />
                    <span className="daw-fx-value">{masterSuite.limiter.ceiling.toFixed(1)} dB</span>
                  </div>
                  <p className="daw-master-hint">
                    🛡️ Menjaga output audio tidak pernah pecah / distorsi melewati 0 dBFS.
                  </p>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="daw-master-modal-footer">
              <button
                className="daw-master-reset-btn"
                onClick={() => {
                  setMasterSuite({
                    eq: { low: 0, mid: 0, high: 0, subCut: true },
                    compressor: { enabled: false, threshold: -14, ratio: 2.5, attack: 0.03, release: 0.2 },
                    width: 1.0,
                    isMono: false,
                    limiter: { enabled: true, ceiling: -0.5 },
                  });
                  showToast('Master Suite di-reset ke Flat!', 'info');
                }}
              >
                <RotateCcw size={13} /> Reset ke Flat
              </button>
              <button
                className="daw-master-done-btn"
                onClick={() => setShowMasterModal(false)}
              >
                <Check size={14} /> Terapkan & Tutup
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ── Track Picker Modal (Drop Audio) ── */}
      {pendingDropFiles && (
        <div className="daw-modal-overlay" onClick={() => setPendingDropFiles(null)}>
          <div className="daw-modal" onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 8px', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Music size={18} /> Pilih Track Tujuan
            </h3>
            <p style={{ margin: '0 0 12px', fontSize: '0.72rem', color: 'var(--daw-text-dim)' }}>
              {pendingDropFiles.files.length} file audio — masuk ke track mana?
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
              {tracks.map((track, i) => (
                <button
                  key={track.id}
                  className="daw-modal-track-btn"
                  onClick={() => confirmDropToTrack(track.id)}
                >
                  <span className="daw-modal-track-color" style={{ background: track.color }} />
                  <span className="daw-modal-track-name">{track.name}</span>
                  <span className="daw-modal-track-idx">Track {i + 1}</span>
                </button>
              ))}
              <button
                className="daw-modal-track-btn new"
                onClick={confirmDropNewTrack}
              >
                <Plus size={14} /> Buat Track Baru
              </button>
            </div>
            <button 
              className="daw-modal-cancel"
              onClick={() => setPendingDropFiles(null)}
            >Batal</button>
          </div>
        </div>
      )}

      {/* ── Drum Generator Modal ── */}
      {showDrumModal && (
        <div className="daw-overlay">
          <div className="daw-modal" style={{ maxWidth: 500 }}>
            <h2>Generate Drum Loop & Simulator</h2>
            
            <div style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
              <div className="daw-modal-field" style={{ flex: 1, marginBottom: 0 }}>
                <label>Genre / Style</label>
                <select className="daw-select" value={drumGenre} onChange={e => {
                  const g = e.target.value;
                  setDrumGenre(g);
                  if (DRUM_PRESETS[g]) {
                    setDrumGrid({
                      kick: [...DRUM_PRESETS[g].kick],
                      snare: [...DRUM_PRESETS[g].snare],
                      hihat: [...DRUM_PRESETS[g].hihat]
                    });
                  }
                }}>
                  {Object.keys(DRUM_PRESETS).map(k => (
                    <option key={k} value={k}>{DRUM_PRESETS[k].name}</option>
                  ))}
                </select>
              </div>
              <div className="daw-modal-field" style={{ flex: 1, marginBottom: 0 }}>
                <label>Drum Kit</label>
                <select className="daw-select" value={drumKit} onChange={e => setDrumKit(e.target.value)}>
                  <option value="acoustic">Standard Acoustic</option>
                  <option value="808">Analog 808</option>
                  <option value="909">Electric 909</option>
                  <option value="lofi">Lo-Fi Vintage</option>
                </select>
              </div>
            </div>

            {/* 16-Step Visualizer / Simulator */}
            <div style={{ marginBottom: 20, background: 'var(--daw-surface-2)', padding: 12, borderRadius: 8, border: '1px solid var(--daw-border)' }}>
                {['hihat', 'snare', 'kick'].map(inst => (
                  <div key={inst} style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                    <div style={{ width: 50, color: 'var(--daw-text-dim)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>{inst}</div>
                    <div style={{ display: 'flex', gap: 3, flex: 1 }}>
                      {drumGrid[inst].map((val, i) => (
                        <div 
                          key={i} 
                          onClick={() => setDrumGrid(prev => {
                            const n = {...prev};
                            n[inst] = [...n[inst]];
                            n[inst][i] = n[inst][i] ? 0 : 1;
                            return n;
                          })}
                          style={{
                            flex: 1, height: 26, background: val ? 'var(--daw-accent)' : 'var(--daw-surface-3)',
                            border: `1px solid ${val ? 'transparent' : (i % 4 === 0 ? 'var(--daw-border-bright)' : 'var(--daw-border)')}`,
                            borderRadius: 3,
                            cursor: 'pointer',
                            opacity: val ? 1 : 0.6,
                            transition: 'all 0.1s'
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>

            <div style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
              <div className="daw-modal-field" style={{ flex: 1, marginBottom: 0 }}>
                <label>Durasi (Bars)</label>
                <select className="daw-select" value={drumBars} onChange={e => setDrumBars(Number(e.target.value))}>
                  <option value={2}>2 Bars</option>
                  <option value={4}>4 Bars</option>
                  <option value={8}>8 Bars</option>
                  <option value={16}>16 Bars</option>
                </select>
              </div>
              <div className="daw-modal-field" style={{ flex: 1, marginBottom: 0 }}>
                <label>Drum Fill (Akhir Loop)</label>
                <select className="daw-select" value={drumFill} onChange={e => setDrumFill(e.target.value)}>
                  <option value="none">Tanpa Fill</option>
                  <option value="snare_roll">Snare Roll 16th</option>
                  <option value="classic_tom">Classic Tom Fill</option>
                  <option value="trap_hat">Trap Hat Roll</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
              <div className="daw-modal-field" style={{ flex: 1, marginBottom: 0 }}>
                <label>Output Format</label>
                <select className="daw-select" value={drumOutput} onChange={e => setDrumOutput(e.target.value)}>
                  <option value="mixdown">Single Track (Mixdown)</option>
                  <option value="stems">Separate Tracks (Multitrack Stems)</option>
                </select>
              </div>
              <div className="daw-modal-field" style={{ flex: 1, marginBottom: 0 }}>
                <label>Swing / Humanize</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <input type="range" className="daw-fx-slider" min={0} max={0.6} step={0.05} value={drumSwing} onChange={e => setDrumSwing(Number(e.target.value))} style={{ flex: 1 }} />
                  <span className="daw-fx-value" style={{ width: 40 }}>{Math.round(drumSwing * 100)}%</span>
                </div>
              </div>
            </div>
            
            <p style={{ fontSize: '0.8rem', color: 'var(--daw-text-dim)', marginBottom: 0, marginTop: 12, lineHeight: 1.5 }}>
              Ketukan disesuaikan dengan Tempo Project <strong>{bpm} BPM</strong>.<br/>
              {drumOutput === 'stems' ? 'Sistem akan membuat 4 Track baru secara otomatis.' : 'Loop akan disisipkan di posisi kursor.'}
            </p>

            <div className="daw-modal-actions">
              <button 
                className={`daw-action-btn ${isPreviewing ? 'active' : ''}`} 
                onClick={handlePreviewDrum}
                style={{ flex: 1, backgroundColor: isPreviewing ? 'var(--daw-accent)' : 'var(--daw-surface-2)', color: isPreviewing ? '#fff' : 'inherit' }}
              >
                {isPreviewing ? '⏹ Stop Preview' : '▶️ Preview Play'}
              </button>
            </div>

            <div className="daw-modal-actions" style={{ marginTop: 10 }}>
              <button className="daw-modal-cancel" onClick={() => {
                if (isPreviewing && previewPlayerRef.current) {
                  previewPlayerRef.current.stop();
                  previewPlayerRef.current = null;
                  setIsPreviewing(false);
                }
                setShowDrumModal(false);
              }}>Batal</button>
              <button 
                className="daw-modal-confirm" 
                onClick={handleGenerateDrum}
                disabled={isGeneratingDrum}
              >
                {isGeneratingDrum ? 'Generating...' : 'Generate & Import'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Bass Generator Modal ── */}
      {showBassModal && (
        <div className="daw-overlay">
          <div className="daw-modal" style={{ maxWidth: 500 }}>
            <h2>Generate Bassline</h2>
            
            <div style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
              <div className="daw-modal-field" style={{ flex: 1, marginBottom: 0 }}>
                <label>Nada Dasar (Key)</label>
                <select className="daw-select" value={bassKey} onChange={e => setBassKey(e.target.value)}>
                  {['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].map(k => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
              </div>
              <div className="daw-modal-field" style={{ flex: 1, marginBottom: 0 }}>
                <label>Skala (Scale)</label>
                <select className="daw-select" value={bassScale} onChange={e => setBassScale(e.target.value)}>
                  <option value="minor">Minor</option>
                  <option value="major">Major</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
              <div className="daw-modal-field" style={{ flex: 1, marginBottom: 0 }}>
                <label>Pola (Pattern)</label>
                <select className="daw-select" value={bassPattern} onChange={e => setBassPattern(e.target.value)}>
                  <option value="offbeat">Offbeat (House/Techno)</option>
                  <option value="rolling">Rolling (Trance/Psy)</option>
                  <option value="groove">Funky Groove</option>
                </select>
              </div>
            </div>
            
            <p style={{ fontSize: '0.8rem', color: 'var(--daw-text-dim)', marginBottom: 0, marginTop: 12, lineHeight: 1.5 }}>
              Bass akan dirender dalam {drumBars} Bars mengikuti tempo <strong>{bpm} BPM</strong>.
            </p>

            <div className="daw-modal-actions">
              <button className="daw-modal-cancel" onClick={() => setShowBassModal(false)}>Batal</button>
              <button 
                className="daw-modal-confirm" 
                onClick={handleGenerateBass}
                disabled={isGeneratingBass}
              >
                {isGeneratingBass ? 'Generating...' : 'Generate & Import'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Context Menu ── */}
      {contextMenu && (
        <div className="daw-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button className="daw-context-menu-item" onClick={ctxSplit}>
            <Scissors size={14} /> Split di Playhead
          </button>
          <button className="daw-context-menu-item" onClick={ctxDuplicate}>
            <Copy size={14} /> Duplicate
          </button>
          <div className="daw-context-menu-separator" />
          <button className="daw-context-menu-item danger" onClick={ctxDelete}>
            <Trash2 size={14} /> Hapus
          </button>
        </div>
      )}

      {/* ── Track Context Menu ── */}
      {trackContextMenu && (
        <div className="daw-context-menu" style={{ left: trackContextMenu.x, top: trackContextMenu.y }}>
          <button className="daw-context-menu-item" onClick={() => { updateTrackPush(trackContextMenu.trackId, { mute: true }); setTrackContextMenu(null); }}>
            Disable Track (Mute)
          </button>
          <button className="daw-context-menu-item" onClick={ctxDuplicateTrack}>
            <Copy size={14} /> Duplicate Track (Complete)
          </button>
          <div className="daw-context-menu-separator" />
          <button className="daw-context-menu-item danger" onClick={() => { removeTrack(trackContextMenu.trackId); setTrackContextMenu(null); }}>
            <Trash2 size={14} /> Remove Track
          </button>
          <div className="daw-context-menu-separator" />
          <button className="daw-context-menu-item" onClick={() => { addTrack(); setTrackContextMenu(null); }}>
            <Plus size={14} /> Add Tracks
          </button>
        </div>
      )}

      {/* ── Toast ── */}
      {toast && <div className={`daw-toast ${toast.type}`}>{toast.msg}</div>}

      {/* ── Export Overlay ── */}
      {exporting && (
        <div className="daw-overlay">
          <Loader2 size={32} className="spinner" />
          <p>Exporting mixdown...</p>
        </div>
      )}

      {/* Hidden file input for import */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.mp3,.wav,.ogg,.flac,.aac,.m4a"
        multiple
        hidden
        onChange={e => {
          importAudioFiles(Array.from(e.target.files), null, cursorPos);
          e.target.value = '';
        }}
      />
    </div>
  );
}

// ─── Error Boundary ──────────────────────────────────────────────
class DawErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    this.setState({ errorInfo });
    console.error('DawStudio Error:', error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100vh', background: '#0d0f1a', color: '#e0e4f0', fontFamily: 'Inter, system-ui, sans-serif',
          gap: '16px', padding: '40px',
        }}>
          <div style={{ fontSize: '2rem' }}>⚠️</div>
          <h2 style={{ margin: 0, color: '#ff477e' }}>DAW Studio Error</h2>
          <p style={{ color: '#94a3b8', maxWidth: '500px', textAlign: 'center' }}>
            Terjadi kesalahan pada DAW Studio. Klik tombol di bawah untuk memulai ulang.
          </p>
          <pre style={{
            background: '#171a2e', padding: '12px 16px', borderRadius: '8px', fontSize: '0.75rem',
            color: '#f87171', maxWidth: '600px', overflow: 'auto', maxHeight: '120px',
            border: '1px solid rgba(255,255,255,0.1)',
          }}>
            {this.state.error?.toString()}
          </pre>
          <button
            onClick={() => this.setState({ hasError: false, error: null, errorInfo: null })}
            style={{
              padding: '10px 24px', background: 'linear-gradient(135deg, #8338ec, #ff477e)',
              color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer',
              fontWeight: 700, fontSize: '0.9rem',
            }}
          >
            🔄 Muat Ulang DAW
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function DawStudioWithErrorBoundary(props) {
  return (
    <DawErrorBoundary>
      <DawStudio {...props} />
    </DawErrorBoundary>
  );
}

export default DawStudioWithErrorBoundary;
