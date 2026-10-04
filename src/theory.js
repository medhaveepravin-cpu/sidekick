// Key estimation, diatonic chord choice, and ukulele voicing.
// Pure functions, no DOM or audio APIs, so this module runs in Node for tests.

import { NOTE_NAMES } from './pitch.js';

// Krumhansl–Kessler key profiles (tonal hierarchy weights), index 0 = tonic.
const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]; // natural minor
const MAJOR_QUALITIES = ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'];
const MINOR_QUALITIES = ['min', 'dim', 'maj', 'min', 'min', 'maj', 'maj'];
// Seventh-chord qualities per scale degree.
const MAJOR_SEVENTHS = ['maj7', 'm7', 'm7', 'maj7', '7', 'm7', 'm7b5'];
const MINOR_SEVENTHS = ['m7', 'm7b5', 'maj7', 'm7', 'm7', 'maj7', '7'];

function mean(arr) {
  let s = 0;
  for (const x of arr) s += x;
  return s / arr.length;
}

// Pearson correlation between two length-12 vectors.
function correlate(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

// Rotate a tonic-relative profile so index `tonic` holds the profile's root.
function rotate(profile, tonic) {
  const out = new Array(12);
  for (let pc = 0; pc < 12; pc++) out[pc] = profile[(pc - tonic + 12) % 12];
  return out;
}

export function keyName(key) {
  return `${NOTE_NAMES[key.tonic]} ${key.mode}`;
}

// How well one specific key fits a histogram (correlation, -1..1).
export function scoreKey(histogram, key) {
  const profile = key.mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE;
  return correlate(histogram, rotate(profile, key.tonic));
}

// Best-fitting key for a 12-bin pitch-class histogram.
// Returns { tonic: 0..11, mode: 'major'|'minor', score }.
export function estimateKey(histogram) {
  let best = { tonic: 0, mode: 'major', score: -Infinity };
  for (let tonic = 0; tonic < 12; tonic++) {
    const sMaj = correlate(histogram, rotate(MAJOR_PROFILE, tonic));
    const sMin = correlate(histogram, rotate(MINOR_PROFILE, tonic));
    if (sMaj > best.score) best = { tonic, mode: 'major', score: sMaj };
    if (sMin > best.score) best = { tonic, mode: 'minor', score: sMin };
  }
  return best;
}

// Hysteresis wrapper around estimateKey: the detected key only changes once a
// rival key has beaten the current one by `margin` for `hold` updates in a row.
// This keeps the band from flickering between relative major/minor bar to bar.
export function createKeyTracker({ margin = 0.05, hold = 3 } = {}) {
  let current = null;
  let candidate = null;
  let count = 0;

  const sameKey = (a, b) => a && b && a.tonic === b.tonic && a.mode === b.mode;

  return {
    update(histogram) {
      const est = estimateKey(histogram);
      if (!current) {
        current = est;
        return current;
      }
      if (sameKey(est, current)) {
        candidate = null;
        count = 0;
        return current;
      }
      // Compare the rival and the incumbent against the *same* histogram.
      const currentFit = scoreKey(histogram, current);
      if (sameKey(est, candidate)) count++;
      else {
        candidate = est;
        count = 1;
      }
      if (est.score > currentFit + margin && count >= hold) {
        current = est;
        candidate = null;
        count = 0;
      }
      return current;
    },
    get() {
      return current;
    },
    reset() {
      current = null;
      candidate = null;
      count = 0;
    },
  };
}

// The seven diatonic triads of a key, each as pitch classes.
export function diatonicTriads(key) {
  const scale = key.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE;
  const quals = key.mode === 'major' ? MAJOR_QUALITIES : MINOR_QUALITIES;
  const triads = [];
  for (let d = 0; d < 7; d++) {
    const root = (key.tonic + scale[d]) % 12;
    const third = (key.tonic + scale[(d + 2) % 7]) % 12;
    const fifth = (key.tonic + scale[(d + 4) % 7]) % 12;
    triads.push({ degree: d, root, quality: quals[d], notes: [root, third, fifth] });
  }
  return triads;
}

// Extend a diatonic triad to its proper seventh chord for the key.
export function addSeventh(chord, key) {
  const scale = key.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE;
  const labels = key.mode === 'major' ? MAJOR_SEVENTHS : MINOR_SEVENTHS;
  const seventh = (key.tonic + scale[(chord.degree + 6) % 7]) % 12;
  return { ...chord, quality: labels[chord.degree], notes: [...chord.notes, seventh] };
}

// Pick the diatonic chord that best covers the pitch classes sung over a window.
// `prev` + `repeatPenalty` discourage sitting on one chord forever; `sevenths`
// extends the winner to a seventh chord.
export function chooseChord(histogram, key, { prev = null, repeatPenalty = 0, sevenths = false } = {}) {
  const triads = diatonicTriads(key);
  let best = null;
  let bestScore = -Infinity;
  for (const t of triads) {
    let score = t.notes.reduce((s, pc) => s + (histogram[pc] || 0), 0);
    score += 0.25 * (histogram[t.root] || 0); // bias toward matching the root
    if (prev && t.root === prev.root) score -= repeatPenalty;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return sevenths ? addSeventh(best, key) : best;
}

// Ukulele sounds roughly C4..C6; keep voicings inside that window.
export const UKE_RANGE = { low: 60, high: 84 };

// Acoustic guitar: low E2 up to around E5.
export const GUITAR_RANGE = { low: 40, high: 76 };

// Voice a triad as concrete MIDI notes inside a range, low to high (one per tone).
export function voiceChord(chord, { range = UKE_RANGE } = {}) {
  const notes = [];
  for (const pc of chord.notes) {
    let m = range.low + (((pc - range.low) % 12) + 12) % 12;
    if (m > range.high) m -= 12;
    if (m < range.low) m += 12;
    notes.push(m);
  }
  notes.sort((a, b) => a - b);
  return notes;
}

// A fuller, strummable voicing: the root low, then chord tones stacked upward
// (thirds, fifths, octave doublings) until we run out of range or voices.
export function voiceChordSpread(chord, { range = GUITAR_RANGE, maxVoices = 5 } = {}) {
  const tones = chord.notes; // [root, third, fifth] as pitch classes
  let root = range.low + ((((chord.root - range.low) % 12) + 12) % 12);
  if (root > range.high) root -= 12;
  const notes = [root];
  let m = root;
  let idx = 0;
  while (notes.length < maxVoices) {
    idx++;
    const pc = tones[idx % tones.length];
    let cand = m + ((((pc - m) % 12) + 12) % 12);
    if (cand <= m) cand += 12;
    if (cand > range.high) break;
    notes.push(cand);
    m = cand;
  }
  return notes;
}

export function chordName(chord) {
  const suffix = {
    maj: '',
    min: 'm',
    dim: 'dim',
    maj7: 'maj7',
    m7: 'm7',
    7: '7',
    m7b5: 'm7♭5',
  };
  return NOTE_NAMES[chord.root] + (suffix[chord.quality] ?? '');
}
