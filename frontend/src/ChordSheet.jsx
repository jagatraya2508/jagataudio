import React, { useMemo } from 'react';

const NOTES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const NOTE_INDEX = {
  C: 0, 'B#': 0,
  'C#': 1, Db: 1,
  D: 2,
  'D#': 3, Eb: 3,
  E: 4, Fb: 4,
  'E#': 5, F: 5,
  'F#': 6, Gb: 6,
  G: 7,
  'G#': 8, Ab: 8,
  A: 9,
  'A#': 10, Bb: 10,
  B: 11, Cb: 11,
};

const CHORD_TOKEN_RE = /^[A-G](?:#|b|♯|♭)?(?:maj|min|mmaj|dim|aug|sus|add|m|M)?(?:sus\d*|add\d*|maj\d*|dim\d*|m\d*|\d+)*(?:[b#]\d+)*(?:\([^)]+\))?(?:\/[A-G](?:#|b|♯|♭)?)?$/;
const NOTE_IN_CHORD_RE = /[A-G](?:#|b|♯|♭)?/g;
const CH_TAG_RE = /\[ch\]([\s\S]*?)\[\/ch\]/gi;
const SECTION_RE = /^\[(?!ch\b|\/?tab\b)[^\]]+\]$/i;

function normalizeNoteGlyph(note) {
  return note.replace('♯', '#').replace('♭', 'b');
}

function isNoChord(token) {
  const t = token.replace(/\./g, '').toUpperCase();
  return t === 'NC' || t === 'N/C';
}

function isChordToken(token) {
  if (!token) return false;
  if (token === '|' || token === '||' || token === '/r' || token === '%') return false;
  if (isNoChord(token)) return true;
  return CHORD_TOKEN_RE.test(token);
}

function transposeNote(note, semitones, preferFlats) {
  const key = normalizeNoteGlyph(note);
  const idx = NOTE_INDEX[key];
  if (idx == null) return note;
  const names = preferFlats ? NOTES_FLAT : NOTES_SHARP;
  return names[(idx + semitones + 120) % 12];
}

function transposeChordName(chord, semitones, preferFlats = false) {
  if (!semitones || isNoChord(chord)) return chord;
  let i = 0;
  return chord.replace(NOTE_IN_CHORD_RE, (m) => {
    i += 1;
    // Root + optional bass after slash
    if (i <= 2) return transposeNote(m, semitones, preferFlats);
    return m;
  });
}

function stripTabTags(text) {
  return String(text || '')
    .replace(/\[\/?tab\]/gi, '')
    .replace(/\r\n/g, '\n');
}

function isTabStaffLine(line) {
  const t = line.trim();
  if (!t) return false;
  if (/^[eEBGDA]\s*\|/.test(t)) return true;
  if (/^[eEBGDA]\|-/.test(t)) return true;
  const dashes = (t.match(/-/g) || []).length;
  return dashes >= 8 && /[0-9xX|]/.test(t) && !/[a-z]{3,}/i.test(t.replace(/^[eEBGDA]\s*/, ''));
}

function hasChTags(line) {
  return /\[ch\]/i.test(line);
}

function parseChTaggedLine(line) {
  const chords = [];
  let visible = '';
  const re = new RegExp(CH_TAG_RE.source, 'gi');
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    visible += line.slice(last, m.index);
    const name = (m[1] || '').trim();
    if (name) chords.push({ name, col: visible.length });
    visible += name;
    last = m.index + m[0].length;
  }
  visible += line.slice(last);
  return { chords, visible };
}

function parseAsciiChordLine(line) {
  const chords = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(line))) {
    const tok = m[0];
    if (tok === '|' || tok === '||') {
      chords.push({ name: '|', col: m.index, bar: true });
      continue;
    }
    if (isChordToken(tok) || isNoChord(tok)) {
      chords.push({ name: tok, col: m.index });
    }
  }
  return chords;
}

function isAsciiChordLine(line) {
  const trimmed = line.trim();
  if (!trimmed || hasChTags(line) || isTabStaffLine(line)) return false;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  let chordish = 0;
  let words = 0;
  for (const tok of tokens) {
    if (tok === '|' || tok === '||' || tok === ':' || tok === '-') continue;
    if (isChordToken(tok) || isNoChord(tok)) chordish += 1;
    else if (/^[A-Za-z]{3,}/.test(tok) && !isChordToken(tok)) words += 1;
  }
  if (chordish === 0) return false;
  if (words >= 3) return false;
  return chordish >= Math.max(1, tokens.length * 0.45);
}

function parseBlocks(raw) {
  const text = stripTabTags(raw);
  const lines = text.split('\n');
  const blocks = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      blocks.push({ type: 'blank' });
      continue;
    }
    if (SECTION_RE.test(trimmed)) {
      blocks.push({ type: 'section', text: trimmed });
      continue;
    }
    if (isTabStaffLine(line)) {
      blocks.push({ type: 'tab', text: line.replace(/\s+$/, '') });
      continue;
    }
    if (hasChTags(line)) {
      const parsed = parseChTaggedLine(line);
      blocks.push({ type: 'chords', chords: parsed.chords, pad: parsed.visible });
      continue;
    }
    if (isAsciiChordLine(line)) {
      blocks.push({ type: 'chords', chords: parseAsciiChordLine(line), pad: line });
      continue;
    }
    blocks.push({ type: 'lyrics', text: line.replace(/\s+$/, '') });
  }
  return blocks;
}

function groupBlocks(blocks) {
  const out = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const cur = blocks[i];
    if (cur.type === 'chords' && blocks[i + 1]?.type === 'lyrics') {
      out.push({ type: 'pair', chords: cur.chords, lyrics: blocks[i + 1].text });
      i += 1;
    } else {
      out.push(cur);
    }
  }
  return out;
}

function ChordPills({ chords, transpose, preferFlats }) {
  if (!chords?.length) return <div className="ug-chords" />;
  return (
    <div className="ug-chords">
      {chords.map((c, i) => (
        <span
          key={`${c.col}-${i}`}
          className={c.bar ? 'ug-bar' : 'ug-chord'}
          style={{ left: `${Math.max(0, c.col)}ch` }}
        >
          {c.bar ? '|' : transposeChordName(c.name, transpose, preferFlats)}
        </span>
      ))}
    </div>
  );
}

export default function ChordSheet({ content, transpose = 0, fontPx = 15 }) {
  const grouped = useMemo(() => groupBlocks(parseBlocks(content)), [content]);
  const preferFlats = transpose < 0;

  if (!content?.trim()) {
    return <p className="mp3-lyrics-empty">Chord belum tersedia.</p>;
  }

  return (
    <div className="ug-sheet" style={{ fontSize: `${fontPx}px` }}>
      {grouped.map((block, i) => {
        if (block.type === 'blank') {
          return <div key={i} className="ug-blank" />;
        }
        if (block.type === 'section') {
          return (
            <div key={i} className="ug-section">{block.text}</div>
          );
        }
        if (block.type === 'tab') {
          return (
            <pre key={i} className="ug-tab-line">{block.text}</pre>
          );
        }
        if (block.type === 'pair') {
          return (
            <div key={i} className="ug-pair">
              <ChordPills chords={block.chords} transpose={transpose} preferFlats={preferFlats} />
              <div className="ug-lyrics">{block.lyrics}</div>
            </div>
          );
        }
        if (block.type === 'chords') {
          return (
            <div key={i} className="ug-pair ug-pair-chords-only">
              <ChordPills chords={block.chords} transpose={transpose} preferFlats={preferFlats} />
            </div>
          );
        }
        if (block.type === 'lyrics') {
          return (
            <div key={i} className="ug-lyrics ug-lyrics-solo">{block.text}</div>
          );
        }
        return null;
      })}
    </div>
  );
}
