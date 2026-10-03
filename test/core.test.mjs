import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectPitchYIN, freqToPitchClass } from '../src/pitch.js';
import {
  estimateKey,
  createKeyTracker,
  chooseChord,
  voiceChord,
  voiceChordSpread,
  diatonicTriads,
  UKE_RANGE,
  GUITAR_RANGE,
} from '../src/theory.js';

// --- helpers --------------------------------------------------------------

function sine(freq, { sampleRate = 44100, length = 2048 } = {}) {
  const buf = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    buf[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return buf;
}

// Build a 12-bin pitch-class histogram from a { pc: weight } map.
function hist(weights) {
  const h = new Array(12).fill(0);
  for (const [pc, w] of Object.entries(weights)) h[Number(pc)] = w;
  return h;
}

// A tonic-centred major histogram: scale tones present, tonic + dominant loud.
function majorHist(tonic) {
  const w = {};
  const degrees = { 0: 5, 2: 2, 4: 3.5, 5: 2.5, 7: 4.5, 9: 2.5, 11: 2 };
  for (const [deg, weight] of Object.entries(degrees)) {
    w[(tonic + Number(deg)) % 12] = weight;
  }
  return hist(w);
}

// A tonic-centred natural-minor histogram.
function minorHist(tonic) {
  const w = {};
  const degrees = { 0: 5, 2: 2, 3: 3.5, 5: 2.5, 7: 4.5, 8: 2.5, 10: 2 };
  for (const [deg, weight] of Object.entries(degrees)) {
    w[(tonic + Number(deg)) % 12] = weight;
  }
  return hist(w);
}

// --- pitch detection ------------------------------------------------------

test('YIN detects A4 (440 Hz)', () => {
  const f = detectPitchYIN(sine(440), 44100);
  assert.ok(f !== null);
  assert.ok(Math.abs(f - 440) / 440 < 0.01, `got ${f}`);
});

test('YIN detects A3 (220 Hz)', () => {
  const f = detectPitchYIN(sine(220), 44100);
  assert.ok(f !== null);
  assert.ok(Math.abs(f - 220) / 220 < 0.01, `got ${f}`);
});

test('YIN detects C5 (523.25 Hz)', () => {
  const f = detectPitchYIN(sine(523.25), 44100);
  assert.ok(f !== null);
  assert.ok(Math.abs(f - 523.25) / 523.25 < 0.01, `got ${f}`);
  assert.equal(freqToPitchClass(f), 0); // C
});

test('YIN returns null on silence', () => {
  const f = detectPitchYIN(new Float32Array(2048), 44100);
  assert.equal(f, null);
});

// --- key estimation -------------------------------------------------------

test('estimateKey finds C major', () => {
  const key = estimateKey(majorHist(0));
  assert.equal(key.tonic, 0);
  assert.equal(key.mode, 'major');
});

test('estimateKey finds A minor', () => {
  const key = estimateKey(minorHist(9));
  assert.equal(key.tonic, 9);
  assert.equal(key.mode, 'minor');
});

test('estimateKey finds a transposed key (G major)', () => {
  const key = estimateKey(majorHist(7));
  assert.equal(key.tonic, 7);
  assert.equal(key.mode, 'major');
});

// --- key hysteresis -------------------------------------------------------

test('key tracker holds the key against brief rival evidence', () => {
  const tracker = createKeyTracker({ margin: 0.05, hold: 3 });
  tracker.update(majorHist(0)); // establish C major
  tracker.update(majorHist(7)); // one bar of G major (count 1)
  const key = tracker.update(majorHist(7)); // two bars (count 2 < hold)
  assert.equal(key.tonic, 0);
  assert.equal(key.mode, 'major');
});

test('key tracker switches on sustained strong evidence', () => {
  const tracker = createKeyTracker({ margin: 0.05, hold: 3 });
  tracker.update(majorHist(0)); // establish C major
  tracker.update(majorHist(7));
  tracker.update(majorHist(7));
  const key = tracker.update(majorHist(7)); // third bar reaches hold
  assert.equal(key.tonic, 7);
  assert.equal(key.mode, 'major');
});

// --- chord choice ---------------------------------------------------------

test('chooseChord picks the tonic when I is outlined', () => {
  const key = { tonic: 0, mode: 'major' };
  const chord = chooseChord(hist({ 0: 5, 4: 4, 7: 4 }), key); // C E G
  assert.equal(chord.root, 0);
  assert.equal(chord.quality, 'maj');
});

test('chooseChord picks the dominant when V is outlined', () => {
  const key = { tonic: 0, mode: 'major' };
  const chord = chooseChord(hist({ 7: 5, 11: 4, 2: 4 }), key); // G B D
  assert.equal(chord.root, 7);
  assert.equal(chord.quality, 'maj');
});

// --- voicing --------------------------------------------------------------

test('voiceChord stays within the ukulele range', () => {
  const key = { tonic: 0, mode: 'major' };
  for (const chord of diatonicTriads(key)) {
    const notes = voiceChord(chord);
    assert.equal(notes.length, 3);
    for (const m of notes) {
      assert.ok(m >= UKE_RANGE.low && m <= UKE_RANGE.high, `note ${m} out of range`);
    }
    const pcs = new Set(notes.map((m) => ((m % 12) + 12) % 12));
    assert.deepEqual([...pcs].sort((a, b) => a - b), [...chord.notes].sort((a, b) => a - b));
  }
});

test('voiceChordSpread stacks within the guitar range and starts on the root', () => {
  const key = { tonic: 0, mode: 'major' };
  for (const chord of diatonicTriads(key)) {
    const notes = voiceChordSpread(chord, { maxVoices: 5 });
    assert.ok(notes.length >= 1 && notes.length <= 5);
    for (const m of notes) {
      assert.ok(m >= GUITAR_RANGE.low && m <= GUITAR_RANGE.high, `note ${m} out of range`);
    }
    // ascending
    for (let i = 1; i < notes.length; i++) assert.ok(notes[i] > notes[i - 1]);
    // bottom note is the chord root
    assert.equal(((notes[0] % 12) + 12) % 12, chord.root);
    // every note is a chord tone
    for (const m of notes) assert.ok(chord.notes.includes(((m % 12) + 12) % 12));
  }
});
