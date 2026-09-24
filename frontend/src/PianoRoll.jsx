import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Square, X, Trash2, ZoomIn, ZoomOut, Scissors, MousePointer2, PenTool, Maximize2, Minimize2 } from 'lucide-react';
import * as Tone from 'tone';
import './daw.css';

// Tuts piano standar
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const OCTAVES = [6, 5, 4, 3, 2, 1]; // Dari atas ke bawah
const DEFAULT_KEY_HEIGHT = 20;

function getAllKeys() {
  const keys = [];
  for (const oct of OCTAVES) {
    for (let i = NOTES.length - 1; i >= 0; i--) {
      keys.push(`${NOTES[i]}${oct}`);
    }
  }
  return keys;
}
const ALL_KEYS = getAllKeys();

function isBlackKey(note) {
  return note.includes('#');
}

const SCALES = {
  'Major': [0, 2, 4, 5, 7, 9, 11],
  'Natural Minor': [0, 2, 3, 5, 7, 8, 10],
  'Harmonic Minor': [0, 2, 3, 5, 7, 8, 11],
  'Melodic Minor': [0, 2, 3, 5, 7, 9, 11],
  'Major Pentatonic': [0, 2, 4, 7, 9],
  'Minor Pentatonic': [0, 3, 5, 7, 10],
  'Dorian': [0, 2, 3, 5, 7, 9, 10],
  'Phrygian': [0, 1, 3, 5, 7, 8, 10],
  'Lydian': [0, 2, 4, 6, 7, 9, 11],
  'Mixolydian': [0, 2, 4, 5, 7, 9, 10],
  'Locrian': [0, 1, 3, 5, 6, 8, 10],
  'Chromatic': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
};

function getScaleNotes(root, scaleName) {
  if (scaleName === 'None') return [];
  const rootIdx = NOTES.indexOf(root);
  if (rootIdx < 0) return [];
  const intervals = SCALES[scaleName] || [];
  return intervals.map(interval => NOTES[(rootIdx + interval) % 12]);
}

let _noteIdCounter = 0;
function uid(prefix = 'n') { return `${prefix}_${Date.now()}_${++_noteIdCounter}`; }

function snapTime(time, bpm, snapValue) {
  if (snapValue === 'off') return time;
  const beatSec = 60 / bpm;
  let grid = beatSec;
  switch (snapValue) {
    case '1/2':  grid = beatSec * 2; break;
    case '1/4':  grid = beatSec; break;
    case '1/8':  grid = beatSec / 2; break;
    case '1/16': grid = beatSec / 4; break;
    case '1/32': grid = beatSec / 8; break;
    default:     grid = beatSec; break;
  }
  return Math.round(time / grid) * grid;
}

export default function PianoRoll({ region, trackId, onClose, onChange, engineRef, bpm, onPlay, onStop, isPlaying }) {
  const [notes, setNotes] = useState(region.notes || []);
  const [history, setHistory] = useState([region.notes || []]);
  const [historyIndex, setHistoryIndex] = useState(0);
  
  const [zoomX, setZoomX] = useState(100); // px per second
  const [keyHeight, setKeyHeight] = useState(DEFAULT_KEY_HEIGHT);
  
  const [scrollX, setScrollX] = useState(0);
  const [scrollY, setScrollY] = useState(0);
  const [snapValue, setSnapValue] = useState('1/16');
  const [selectedNoteIds, setSelectedNoteIds] = useState(new Set());
  const [tool, setTool] = useState('pointer'); // pointer, pencil, eraser
  
  const [scaleRoot, setScaleRoot] = useState('C');
  const [scaleType, setScaleType] = useState('None');
  const [clipboard, setClipboard] = useState([]);
  
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [modalPos, setModalPos] = useState({ x: 0, y: 0 });
  const modalDragState = useRef(null);

  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const playheadElRef = useRef(null);
  const zoomXRef = useRef(zoomX);
  zoomXRef.current = zoomX;
  const isDragging = useRef(false);
  const dragState = useRef(null);
  
  const [marqueeStart, setMarqueeStart] = useState(null);
  const [marqueeCurrent, setMarqueeCurrent] = useState(null);

  const stateRef = useRef();
  stateRef.current = {
    notes,
    history,
    historyIndex,
    clipboard,
    selectedNoteIds,
    scrollX,
    zoomX,
    bpm,
    snapValue,
    scaleRoot,
    scaleType,
    region
  };

  // Auto scroll ke C4 saat pertama buka
  useEffect(() => {
    if (containerRef.current) {
      const c4Index = ALL_KEYS.indexOf('C4');
      if (c4Index >= 0) {
        containerRef.current.scrollTop = Math.max(0, (c4Index - 10) * keyHeight);
      }
    }
  }, []);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = playheadElRef.current;
      const engine = engineRef?.current;
      if (el && engine && typeof engine.getCurrentPosition === 'function') {
        const x = (engine.getCurrentPosition() - (region.startTime || 0)) * zoomXRef.current;
        el.style.transform = `translateX(${x}px)`;
        el.style.opacity = x < -2 ? '0' : '1';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engineRef, region.startTime]);

  const saveHistory = (newNotes) => {
    const { history, historyIndex, region } = stateRef.current;
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newNotes);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
    onChange({ ...region, notes: newNotes });
  };

  const updateNotes = (newNotes, save = true) => {
    setNotes(newNotes);
    if (save) saveHistory(newNotes);
  };

  const playPreview = async (pitch) => {
    try { await Tone.start(); } catch (e) {}
    const engine = engineRef.current;
    if (engine && typeof engine.previewNote === 'function') {
      engine.previewNote(pitch, trackId);
    } else {
      try {
        const synth = new Tone.PolySynth(Tone.Synth).toDestination();
        synth.volume.value = -12;
        synth.triggerAttackRelease(pitch, '8n');
      } catch(e) {}
    }
  };

  const handleKeyMouseDown = (pitch) => {
    playPreview(pitch);
  };

  const getPosFromEvent = (e) => {
    if (!canvasRef.current) return { time: 0, pitchIndex: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    let time = x / zoomX;
    let pitchIndex = Math.floor(y / keyHeight);
    if (pitchIndex < 0) pitchIndex = 0;
    if (pitchIndex >= ALL_KEYS.length) pitchIndex = ALL_KEYS.length - 1;
    
    return { x, y, time, pitchIndex };
  };

  const handleCanvasMouseDown = (e) => {
    e.preventDefault();
    const { x, y, time, pitchIndex } = getPosFromEvent(e);
    const pitch = ALL_KEYS[pitchIndex];
    const snappedTime = snapTime(time, bpm, snapValue);

    const clickedNote = notes.find(n => {
      const nPitchIdx = ALL_KEYS.indexOf(n.pitch);
      if (nPitchIdx !== pitchIndex) return false;
      return time >= n.startTime && time <= n.startTime + n.duration;
    });

    if (tool === 'eraser') {
      if (clickedNote) {
        updateNotes(notes.filter(n => n.id !== clickedNote.id));
      }
      return;
    }

    if (tool === 'pencil') {
      if (!clickedNote) {
        const defaultDur = snapTime(0.5, bpm, snapValue) || (60/bpm)/4;
        const newNote = {
          id: uid(),
          pitch,
          startTime: snappedTime,
          duration: defaultDur,
          velocity: 0.8,
          muted: false
        };
        const newNotes = [...notes, newNote];
        setNotes(newNotes);
        playPreview(pitch);
        
        isDragging.current = true;
        dragState.current = {
          type: 'resizeRight',
          note: newNote,
          startX: e.clientX,
          initialDuration: defaultDur,
          isNew: true
        };
      }
      return;
    }

    if (tool === 'pointer') {
      if (clickedNote) {
        if (e.shiftKey) {
          const newSel = new Set(selectedNoteIds);
          if (newSel.has(clickedNote.id)) newSel.delete(clickedNote.id);
          else newSel.add(clickedNote.id);
          setSelectedNoteIds(newSel);
          return;
        }
        
        if (!selectedNoteIds.has(clickedNote.id)) {
          setSelectedNoteIds(new Set([clickedNote.id]));
        }

        const noteEndX = (clickedNote.startTime + clickedNote.duration) * zoomX;
        const rect = canvasRef.current.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        
        if (Math.abs(mouseX - noteEndX) < 8) {
          isDragging.current = true;
          dragState.current = {
            type: 'resizeRight',
            note: clickedNote,
            startX: e.clientX,
            initialDuration: clickedNote.duration
          };
        } else {
          isDragging.current = true;
          const selectedNotesData = Array.from(selectedNoteIds.has(clickedNote.id) ? selectedNoteIds : [clickedNote.id]).map(id => {
            const n = notes.find(nx => nx.id === id);
            return { id, initialStartTime: n.startTime, initialPitchIndex: ALL_KEYS.indexOf(n.pitch) };
          });
          
          dragState.current = {
            type: 'move',
            notesData: selectedNotesData,
            startX: e.clientX,
            startY: e.clientY
          };
          playPreview(clickedNote.pitch);
        }
      } else {
        if (!e.shiftKey) setSelectedNoteIds(new Set());
        isDragging.current = true;
        
        const rect = canvasRef.current.getBoundingClientRect();
        const startX = e.clientX - rect.left;
        const startY = e.clientY - rect.top;
        setMarqueeStart({ x: startX, y: startY });
        setMarqueeCurrent({ x: startX, y: startY });
        dragState.current = { type: 'marquee', initialSelection: e.shiftKey ? Array.from(selectedNoteIds) : [] };
      }
    }
  };

  const handleCanvasMouseMove = (e) => {
    if (!isDragging.current || !dragState.current) return;
    
    if (dragState.current.type === 'marquee') {
      const rect = canvasRef.current.getBoundingClientRect();
      let curX = e.clientX - rect.left;
      let curY = e.clientY - rect.top;
      
      curX = Math.max(0, Math.min(canvasRef.current.clientWidth, curX));
      curY = Math.max(0, Math.min(canvasRef.current.clientHeight, curY));
      setMarqueeCurrent({ x: curX, y: curY });
      
      const x1 = Math.min(marqueeStart.x, curX);
      const x2 = Math.max(marqueeStart.x, curX);
      const y1 = Math.min(marqueeStart.y, curY);
      const y2 = Math.max(marqueeStart.y, curY);
      
      const newSel = new Set(dragState.current.initialSelection);
      notes.forEach(n => {
        const nx1 = n.startTime * zoomX;
        const nx2 = nx1 + n.duration * zoomX;
        const ny1 = ALL_KEYS.indexOf(n.pitch) * keyHeight;
        const ny2 = ny1 + keyHeight;
        
        if (nx1 < x2 && nx2 > x1 && ny1 < y2 && ny2 > y1) {
          newSel.add(n.id);
        } else if (!dragState.current.initialSelection.includes(n.id)) {
          newSel.delete(n.id);
        }
      });
      setSelectedNoteIds(newSel);
      return;
    }

    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - (dragState.current.startY || 0);
    const dTime = dx / zoomX;
    
    if (dragState.current.type === 'resizeRight') {
      let newDuration = dragState.current.initialDuration + dTime;
      if (newDuration < 0.05) newDuration = 0.05;
      const snappedDur = snapTime(newDuration, bpm, snapValue);
      setNotes(prev => prev.map(n => 
        n.id === dragState.current.note.id ? { ...n, duration: Math.max(0.01, snappedDur) } : n
      ));
    } else if (dragState.current.type === 'move') {
      let dPitch = Math.round(dy / keyHeight);
      
      setNotes(prev => prev.map(n => {
        const dData = dragState.current.notesData.find(d => d.id === n.id);
        if (dData) {
          let newTime = dData.initialStartTime + dTime;
          if (newTime < 0) newTime = 0;
          const snappedTime = snapTime(newTime, bpm, snapValue);
          
          let newPitchIdx = dData.initialPitchIndex + dPitch;
          newPitchIdx = Math.max(0, Math.min(ALL_KEYS.length - 1, newPitchIdx));
          return { ...n, startTime: snappedTime, pitch: ALL_KEYS[newPitchIdx] };
        }
        return n;
      }));
    }
  };

  const handleCanvasMouseUp = () => {
    if (isDragging.current) {
      isDragging.current = false;
      if (dragState.current?.type === 'marquee') {
        setMarqueeStart(null);
        setMarqueeCurrent(null);
      } else {
        saveHistory(notes);
      }
      dragState.current = null;
    }
  };

  useEffect(() => {
    const handleGlobalMouseMove = (e) => {
      if (modalDragState.current?.isDragging) {
        const dx = e.clientX - modalDragState.current.startX;
        const dy = e.clientY - modalDragState.current.startY;
        setModalPos({
          x: modalDragState.current.initialX + dx,
          y: modalDragState.current.initialY + dy
        });
      }
    };

    const handleGlobalMouseUpLocal = () => {
      if (modalDragState.current?.isDragging) {
        modalDragState.current.isDragging = false;
      }
      handleCanvasMouseUp();
    };

    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const { notes, history, historyIndex, clipboard, selectedNoteIds, region, bpm, snapValue, scrollX, zoomX } = stateRef.current;

      if (e.ctrlKey || e.metaKey) {
        switch(e.key.toLowerCase()) {
          case 'z':
            if (e.shiftKey) {
              if (historyIndex < history.length - 1) {
                const nextNotes = history[historyIndex + 1];
                setNotes(nextNotes);
                onChange({ ...region, notes: nextNotes });
                setHistoryIndex(historyIndex + 1);
              }
            } else {
              if (historyIndex > 0) {
                const prevNotes = history[historyIndex - 1];
                setNotes(prevNotes);
                onChange({ ...region, notes: prevNotes });
                setHistoryIndex(historyIndex - 1);
              }
            }
            break;
          case 'y':
            if (historyIndex < history.length - 1) {
              const nextNotes = history[historyIndex + 1];
              setNotes(nextNotes);
              onChange({ ...region, notes: nextNotes });
              setHistoryIndex(historyIndex + 1);
            }
            break;
          case 'c':
            const copiedNotes = notes.filter(n => selectedNoteIds.has(n.id));
            if (copiedNotes.length > 0) setClipboard(copiedNotes);
            break;
          case 'v':
            if (clipboard.length > 0) {
              const minTime = Math.min(...clipboard.map(n => n.startTime));
              let pasteTime = snapTime(scrollX / zoomX, bpm, snapValue);
              const newNotes = clipboard.map(n => ({
                ...n,
                id: uid(),
                startTime: n.startTime - minTime + pasteTime
              }));
              const finalNotes = [...notes, ...newNotes];
              setNotes(finalNotes);
              saveHistory(finalNotes);
              setSelectedNoteIds(new Set(newNotes.map(n => n.id)));
            }
            break;
          case 'd':
            e.preventDefault();
            const dupNotes = notes.filter(n => selectedNoteIds.has(n.id));
            if (dupNotes.length > 0) {
              const maxTime = Math.max(...dupNotes.map(n => n.startTime + n.duration));
              const minTime = Math.min(...dupNotes.map(n => n.startTime));
              const offset = maxTime - minTime;
              const newNotes = dupNotes.map(n => ({
                ...n,
                id: uid(),
                startTime: n.startTime + offset
              }));
              const finalNotes = [...notes, ...newNotes];
              setNotes(finalNotes);
              saveHistory(finalNotes);
              setSelectedNoteIds(new Set(newNotes.map(n => n.id)));
            }
            break;
          case 'a':
            e.preventDefault();
            setSelectedNoteIds(new Set(notes.map(n => n.id)));
            break;
        }
      } else {
        switch(e.key) {
          case 'Delete':
          case 'Backspace':
            if (selectedNoteIds.size > 0) {
              const newNotes = notes.filter(n => !selectedNoteIds.has(n.id));
              setNotes(newNotes);
              saveHistory(newNotes);
              setSelectedNoteIds(new Set());
            }
            break;
          case 'm':
          case 'M':
            if (selectedNoteIds.size > 0) {
              const anyUnmuted = notes.some(n => selectedNoteIds.has(n.id) && !n.muted);
              const newNotes = notes.map(n => selectedNoteIds.has(n.id) ? { ...n, muted: anyUnmuted } : n);
              setNotes(newNotes);
              saveHistory(newNotes);
            }
            break;
          case 'ArrowUp':
          case 'ArrowDown':
            e.preventDefault();
            if (selectedNoteIds.size > 0) {
              const shift = e.key === 'ArrowUp' ? -1 : 1;
              const step = e.shiftKey ? shift * 12 : shift;
              const newNotes = notes.map(n => {
                if (selectedNoteIds.has(n.id)) {
                  let pitchIdx = ALL_KEYS.indexOf(n.pitch);
                  pitchIdx = Math.max(0, Math.min(ALL_KEYS.length - 1, pitchIdx + step));
                  return { ...n, pitch: ALL_KEYS[pitchIdx] };
                }
                return n;
              });
              setNotes(newNotes);
              saveHistory(newNotes);
            }
            break;
        }
      }
    };

    window.addEventListener('mousemove', handleGlobalMouseMove);
    window.addEventListener('mouseup', handleGlobalMouseUpLocal);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUpLocal);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []); // Run once, reads from stateRef

  const handleToolbarMouseDown = (e) => {
    if (isFullscreen) return;
    if (e.target.closest('button') || e.target.closest('select')) return;
    
    modalDragState.current = {
      isDragging: true,
      startX: e.clientX,
      startY: e.clientY,
      initialX: modalPos.x,
      initialY: modalPos.y
    };
  };

  const activeScaleNotes = getScaleNotes(scaleRoot, scaleType);

  const handleTimeQuantize = () => {
    if (selectedNoteIds.size === 0) return;
    const newNotes = notes.map(n => {
      if (selectedNoteIds.has(n.id)) {
        return { ...n, startTime: snapTime(n.startTime, bpm, snapValue) };
      }
      return n;
    });
    updateNotes(newNotes);
  };

  const handleScaleQuantize = () => {
    if (selectedNoteIds.size === 0 || scaleType === 'None') return;
    
    const newNotes = notes.map(n => {
      if (selectedNoteIds.has(n.id)) {
        const noteClass = n.pitch.replace(/\d/, '');
        if (!activeScaleNotes.includes(noteClass)) {
          let pitchIdx = ALL_KEYS.indexOf(n.pitch);
          let upIdx = pitchIdx;
          let downIdx = pitchIdx;
          let newPitch = n.pitch;
          
          while (upIdx >= 0 || downIdx < ALL_KEYS.length) {
            if (upIdx >= 0) {
              const p = ALL_KEYS[upIdx];
              if (activeScaleNotes.includes(p.replace(/\d/, ''))) { newPitch = p; break; }
              upIdx--;
            }
            if (downIdx < ALL_KEYS.length) {
              const p = ALL_KEYS[downIdx];
              if (activeScaleNotes.includes(p.replace(/\d/, ''))) { newPitch = p; break; }
              downIdx++;
            }
          }
          return { ...n, pitch: newPitch };
        }
      }
      return n;
    });
    updateNotes(newNotes);
  };

  const handleVelocityChange = (e) => {
    const val = parseFloat(e.target.value);
    if (selectedNoteIds.size > 0) {
      const newNotes = notes.map(n => selectedNoteIds.has(n.id) ? { ...n, velocity: val } : n);
      setNotes(newNotes);
    }
  };

  const handleVelocityMouseUp = () => {
    if (selectedNoteIds.size > 0) {
      saveHistory(notes);
    }
  };

  const selectedVelocity = selectedNoteIds.size > 0 
    ? notes.find(n => n.id === Array.from(selectedNoteIds)[0])?.velocity ?? 0.8
    : 0.8;

  const renderGrid = () => {
    const lines = [];
    const beatSec = 60 / bpm;
    const displayDuration = Math.max(region.duration || 0, beatSec * 16); 
    const totalBeats = Math.ceil(displayDuration / beatSec);

    for (let i = 0; i <= totalBeats * 4; i++) {
      const isBeat = i % 4 === 0;
      const x = i * (beatSec / 4) * zoomX;
      lines.push(
        <div key={`v-${i}`} className="pr-grid-v" style={{ 
          left: x, 
          backgroundColor: isBeat ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.06)' 
        }} />
      );
    }
    return lines;
  };

  const renderKeys = () => {
    return ALL_KEYS.map((pitch, idx) => {
      const isBlack = isBlackKey(pitch);
      const noteClass = pitch.replace(/\d/, '');
      const inScale = scaleType !== 'None' && activeScaleNotes.includes(noteClass);
      
      return (
        <div 
          key={pitch} 
          className={`pr-key ${isBlack ? 'black' : 'white'} ${inScale ? 'in-scale' : ''}`}
          style={{
            height: keyHeight,
            ...(inScale 
              ? (isBlack ? { background: 'linear-gradient(180deg, #3d5b8c 0%, #2b4066 100%)' } : { backgroundColor: '#cce0ff' }) 
              : {})
          }}
          onMouseDown={() => handleKeyMouseDown(pitch)}
        >
          <span>{pitch.includes('C') && !pitch.includes('#') ? pitch : ''}</span>
        </div>
      );
    });
  };

  const renderNotes = () => {
    return notes.map(note => {
      const pitchIdx = ALL_KEYS.indexOf(note.pitch);
      if (pitchIdx < 0) return null;
      
      const x = note.startTime * zoomX;
      const y = pitchIdx * keyHeight;
      const w = note.duration * zoomX;
      const isSelected = selectedNoteIds.has(note.id);
      
      const opacity = note.muted ? 0.3 : (0.5 + (note.velocity || 0.8) * 0.5);

      return (
        <div
          key={note.id}
          className={`pr-note ${isSelected ? 'selected' : ''}`}
          style={{ 
            left: x, 
            top: y, 
            width: w, 
            height: keyHeight - 1,
            opacity: opacity,
            filter: note.muted ? 'grayscale(100%)' : 'none'
          }}
        >
          <div className="pr-note-handle" />
        </div>
      );
    });
  };

  return (
    <div className="daw-modal-overlay">
      <div 
        className="daw-modal piano-roll-modal" 
        style={{ 
          minWidth: isFullscreen ? '100vw' : '90vw', 
          maxWidth: isFullscreen ? '100vw' : '90vw', 
          height: isFullscreen ? '100vh' : '85vh', 
          padding: 0, 
          display: 'flex', 
          flexDirection: 'column', 
          overflow: 'hidden',
          transform: isFullscreen ? 'none' : `translate(${modalPos.x}px, ${modalPos.y}px)`,
          transition: modalDragState.current?.isDragging ? 'none' : 'width 0.2s, height 0.2s',
          borderRadius: isFullscreen ? 0 : undefined
        }}
      >
        <div className="daw-modal-content" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
          
          {/* Toolbar */}
        <div 
          className="pr-toolbar" 
          onMouseDown={handleToolbarMouseDown}
          style={{ 
            flexShrink: 0, 
            borderBottom: '1px solid rgba(255,255,255,0.1)', 
            padding: '10px 16px', 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center', 
            backgroundColor: '#181a2e',
            cursor: isFullscreen ? 'default' : 'grab'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <h3 style={{ margin: 0, fontSize: '1rem', color: '#fff' }}>Piano Roll - {region.name}</h3>
            
            <div className="daw-toolbar-group" style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              <button 
                type="button"
                className={`daw-tool-btn ${isPlaying ? 'active' : ''}`} 
                onClick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (isPlaying) {
                    onStop?.();
                    return;
                  }
                  try { await Tone.start(); } catch (_) {}
                  const engine = engineRef?.current;
                  if (engine && typeof engine.previewRegionNotes === 'function') {
                    await engine.previewRegionNotes(stateRef.current.notes || notes, {
                      regionStart: Number(region.startTime) || 0,
                      audioId: region.audioId || null,
                    });
                  }
                  onPlay?.();
                }}
                title={isPlaying ? "Stop" : "Play"}
              >
                {isPlaying ? <Square size={16} /> : <Play size={16} />}
              </button>
            </div>
            
            <div className="daw-toolbar-group" style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              <button className={`daw-tool-btn ${tool === 'pointer' ? 'active' : ''}`} onClick={() => setTool('pointer')} title="Select/Move">
                <MousePointer2 size={16} />
              </button>
              <button className={`daw-tool-btn ${tool === 'pencil' ? 'active' : ''}`} onClick={() => setTool('pencil')} title="Draw Notes">
                <PenTool size={16} />
              </button>
              <button className={`daw-tool-btn ${tool === 'eraser' ? 'active' : ''}`} onClick={() => setTool('eraser')} title="Erase Notes">
                <Trash2 size={16} />
              </button>
            </div>

            <div className="daw-toolbar-group" style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              <button className="daw-tool-btn" onClick={() => setZoomX(z => Math.min(400, z + 20))} title="Zoom In"><ZoomIn size={16}/></button>
              <button className="daw-tool-btn" onClick={() => setZoomX(z => Math.max(20, z - 20))}><ZoomOut size={16}/></button>
              <div className="daw-toolbar-divider" />
              <button className="daw-tool-btn" onClick={() => setKeyHeight(k => Math.min(40, k + 2))} title="Zoom In Vertical">⇕+</button>
              <button className="daw-tool-btn" onClick={() => setKeyHeight(k => Math.max(10, k - 2))} title="Zoom Out Vertical">⇕-</button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="daw-close-btn" style={{ padding: 4 }} onClick={() => setIsFullscreen(!isFullscreen)}>
              {isFullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
            </button>
            <button className="daw-close-btn" onClick={onClose}><X size={20} /></button>
          </div>
        </div>

        {/* Main Workspace */}
        <div className="pr-workspace" style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          
          {/* Left Inspector Sidebar */}
          <div className="pr-inspector" style={{ width: 140, flexShrink: 0, backgroundColor: '#151722', borderRight: '1px solid #111', display: 'flex', flexDirection: 'column', padding: '12px 10px', gap: '24px' }}>
            
            <div className="pr-inspector-section">
              <label style={{ fontSize: '0.65rem', color: '#8b8b9e', fontWeight: 600, textTransform: 'uppercase', marginBottom: 8, display: 'block' }}>Time Quantize</label>
              <select className="daw-select" style={{ width: '100%', marginBottom: 8, fontSize: '0.75rem', padding: '4px 6px' }} value={snapValue} onChange={e => setSnapValue(e.target.value)}>
                <option value="off">Off</option>
                <option value="1/4">1/4 Note</option>
                <option value="1/8">1/8 Note</option>
                <option value="1/16">1/16 Note</option>
                <option value="1/32">1/32 Note</option>
              </select>
              <button className="daw-home-btn secondary" style={{ width: '100%', padding: '4px 8px', fontSize: '0.75rem', borderRadius: 4 }} onClick={handleTimeQuantize}>Quantize (Q)</button>
            </div>

            <div className="pr-inspector-section">
              <label style={{ fontSize: '0.65rem', color: '#8b8b9e', fontWeight: 600, textTransform: 'uppercase', marginBottom: 8, display: 'block' }}>Scale Quantize</label>
              <div style={{ display: 'flex', gap: '4px', marginBottom: 8 }}>
                <select className="daw-select" style={{ width: '40%', fontSize: '0.75rem', padding: '4px' }} value={scaleRoot} onChange={e => setScaleRoot(e.target.value)}>
                  {NOTES.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <select className="daw-select" style={{ width: '60%', fontSize: '0.75rem', padding: '4px' }} value={scaleType} onChange={e => setScaleType(e.target.value)}>
                  <option value="None">None</option>
                  {Object.keys(SCALES).map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <button className="daw-home-btn secondary" style={{ width: '100%', padding: '4px 8px', fontSize: '0.75rem', borderRadius: 4 }} onClick={handleScaleQuantize}>Apply Scale</button>
            </div>
            
            <div className="pr-inspector-section">
              <label style={{ fontSize: '0.65rem', color: '#8b8b9e', fontWeight: 600, textTransform: 'uppercase', marginBottom: 8, display: 'block' }}>Velocity</label>
              <input type="range" min="0" max="1" step="0.01" style={{ width: '100%', cursor: 'ew-resize' }} value={selectedVelocity} onChange={handleVelocityChange} onMouseUp={handleVelocityMouseUp} />
            </div>

          </div>

          {/* Piano Keys Sidebar */}
          <div className="pr-keys-sidebar" style={{ width: 60, overflowY: 'hidden', flexShrink: 0, borderRight: '1px solid #111', backgroundColor: '#fff', zIndex: 10 }}>
            <div style={{ transform: `translateY(${-scrollY}px)` }}>
              {renderKeys()}
            </div>
          </div>

          {/* Grid Area */}
          <div 
            className="pr-grid-container" 
            ref={containerRef}
            style={{ flex: 1, overflow: 'auto', backgroundColor: '#1a1c29', position: 'relative' }}
            onScroll={(e) => {
              setScrollY(e.target.scrollTop);
              setScrollX(e.target.scrollLeft);
            }}
          >
            <div 
              ref={canvasRef}
              className="pr-canvas" 
              style={{ 
                width: Math.max(800, (region.duration || 60) * zoomX + 200),
                height: ALL_KEYS.length * keyHeight,
                position: 'relative',
                cursor: tool === 'pencil' ? 'crosshair' : tool === 'eraser' ? 'no-drop' : 'default'
              }}
              onMouseDown={handleCanvasMouseDown}
              onMouseMove={handleCanvasMouseMove}
            >
              {/* Horizontal Lines (Pitches) */}
              {ALL_KEYS.map((pitch, idx) => {
                const isBlack = isBlackKey(pitch);
                const noteClass = pitch.replace(/\d/, '');
                const inScale = scaleType !== 'None' && activeScaleNotes.includes(noteClass);
                
                return (
                  <div key={idx} className="pr-grid-h" style={{ 
                    top: idx * keyHeight, 
                    height: keyHeight,
                    backgroundColor: inScale 
                       ? (isBlack ? 'rgba(58, 134, 255, 0.25)' : 'rgba(58, 134, 255, 0.1)') 
                       : (isBlack ? 'rgba(0, 0, 0, 0.4)' : 'rgba(255, 255, 255, 0.01)'),
                    borderBottom: '1px solid rgba(255,255,255,0.08)',
                    position: 'absolute',
                    width: '100%',
                    left: 0
                  }} />
                )
              })}
              
              {renderGrid()}
              {renderNotes()}
              <div
                ref={playheadElRef}
                className="pr-playhead"
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 2,
                  backgroundColor: '#ff4d6d',
                  boxShadow: '0 0 8px rgba(255, 77, 109, 0.7)',
                  pointerEvents: 'none',
                  zIndex: 50,
                  opacity: 0,
                  willChange: 'transform'
                }}
              />
              
              {/* Marquee Selection Box */}
              {marqueeStart && marqueeCurrent && (
                <div style={{
                  position: 'absolute',
                  left: Math.min(marqueeStart.x, marqueeCurrent.x),
                  top: Math.min(marqueeStart.y, marqueeCurrent.y),
                  width: Math.abs(marqueeCurrent.x - marqueeStart.x),
                  height: Math.abs(marqueeCurrent.y - marqueeStart.y),
                  backgroundColor: 'rgba(131, 56, 236, 0.2)',
                  border: '1px solid rgba(131, 56, 236, 0.5)',
                  pointerEvents: 'none',
                  zIndex: 100
                }} />
              )}
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
