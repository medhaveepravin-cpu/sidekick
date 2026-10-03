// Wires everything together: mic input -> pitch detection -> key + chord ->
// band, plus the live pitch ribbon. Browser-only (Tone.js, Web Audio, canvas).

import { detectPitchYIN, freqToMidi, freqToPitchClass, NOTE_NAMES } from './pitch.js';
import {
  createKeyTracker,
  chooseChord,
  voiceChordSpread,
  keyName,
  chordName,
  GUITAR_RANGE,
} from './theory.js';
import { Band } from './band.js';

const ANALYSIS_SIZE = 2048;
const MIN_FREQ = 70;
const MAX_FREQ = 1200;

// Strum patterns. Each event is a position within the chord step (0..1), a
// direction (D down / U up), and a relative velocity. `hold` = pad only.
const STRUM_PATTERNS = {
  down: [{ at: 0, dir: 'D', vel: 1 }],
  downup: [
    { at: 0, dir: 'D', vel: 1 },
    { at: 0.5, dir: 'U', vel: 0.7 },
  ],
  folk: [
    { at: 0, dir: 'D', vel: 1 },
    { at: 0.5, dir: 'D', vel: 0.85 },
    { at: 0.625, dir: 'U', vel: 0.6 },
    { at: 0.875, dir: 'U', vel: 0.6 },
  ],
  island: [
    { at: 0.25, dir: 'U', vel: 0.6 },
    { at: 0.5, dir: 'D', vel: 0.95 },
    { at: 0.75, dir: 'U', vel: 0.6 },
  ],
  hold: [],
};

const els = {
  start: document.getElementById('start'),
  status: document.getElementById('status'),
  keyLabel: document.getElementById('key'),
  keyLock: document.getElementById('key-lock'),
  chord: document.getElementById('chord'),
  strum: document.getElementById('strum'),
  chordRate: document.getElementById('chord-rate'),
  tempo: document.getElementById('tempo'),
  tempoLabel: document.getElementById('tempo-label'),
  tap: document.getElementById('tap'),
  guitarMix: document.getElementById('guitar-mix'),
  bassMix: document.getElementById('bass-mix'),
  drumMix: document.getElementById('drum-mix'),
  padMix: document.getElementById('pad-mix'),
  canvas: document.getElementById('ribbon'),
};

const state = {
  running: false,
  band: null,
  analyser: null,
  sampleRate: 44100,
  buffer: new Float32Array(ANALYSIS_SIZE),
  keyTracker: createKeyTracker(),
  key: null,
  chord: null,
  barHistogram: new Array(12).fill(0),
  liveMidi: null,
  trail: [],
  tapTimes: [],
  chordRepeatId: null,
  drumRepeatId: null,
};

// --- mic + transport ------------------------------------------------------

async function start() {
  await Tone.start();
  const ctx = Tone.getContext().rawContext;
  state.sampleRate = ctx.sampleRate;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = ANALYSIS_SIZE;
  source.connect(analyser);
  state.analyser = analyser;

  state.band = new Band();
  applyMix();

  Tone.Transport.bpm.value = Number(els.tempo.value);
  scheduleChords();
  state.drumRepeatId = Tone.Transport.scheduleRepeat(onDrumBar, '1m');
  Tone.Transport.start();

  state.running = true;
  els.start.textContent = 'Stop';
  els.status.textContent = 'Listening — wear headphones so the band stays out of the mic.';
  requestAnimationFrame(analyseFrame);
}

function stop() {
  state.running = false;
  if (state.band) state.band.releasePad(Tone.now());
  Tone.Transport.stop();
  Tone.Transport.cancel();
  state.chordRepeatId = null;
  state.drumRepeatId = null;
  if (state.band) state.band.dispose();
  state.band = null;
  state.chord = null;
  els.start.textContent = 'Start';
  els.status.textContent = 'Stopped.';
}

// Chord/strum/pad run on the selected subdivision; drums keep their own bar.
function scheduleChords() {
  if (state.chordRepeatId != null) Tone.Transport.clear(state.chordRepeatId);
  state.chordRepeatId = Tone.Transport.scheduleRepeat(onChordStep, els.chordRate.value);
}

function stepBeats() {
  return els.chordRate.value === '2n' ? 2 : 4;
}

// One chord step: turn the notes sung over the step into a key + chord, strum
// it with the chosen pattern, drop a bass note, and (re)voice the pad only when
// the chord actually changes so it sustains across steps.
function onChordStep(time) {
  const hist = state.barHistogram;
  state.barHistogram = new Array(12).fill(0);
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return;

  let key = state.keyTracker.update(hist);
  if (els.keyLock.value !== 'auto') key = parseLockedKey(els.keyLock.value);
  state.key = key;

  const prev = state.chord;
  const chord = chooseChord(hist, key, { prev, repeatPenalty: 0.5 });
  const changed = !prev || prev.root !== chord.root || prev.quality !== chord.quality;
  state.chord = chord;

  const beatSeconds = 60 / Tone.Transport.bpm.value;
  const stepSeconds = beatSeconds * stepBeats();
  const voicing = voiceChordSpread(chord, { range: GUITAR_RANGE, maxVoices: 5 });

  for (const e of STRUM_PATTERNS[els.strum.value] || []) {
    state.band.strum(voicing, time + e.at * stepSeconds, { direction: e.dir, velocity: e.vel });
  }
  state.band.playBass(voicing[0], time, stepSeconds * 0.9);

  if (changed) {
    const padVoicing = voiceChordSpread(chord, { range: { low: 52, high: 76 }, maxVoices: 4 });
    state.band.setPad(padVoicing, time);
  }

  els.keyLabel.textContent = keyName(key);
  els.chord.textContent = chordName(chord);
}

function onDrumBar(time) {
  if (!state.band) return;
  const barSeconds = (60 / Tone.Transport.bpm.value) * 4;
  state.band.playBeat(time, barSeconds);
}

// --- analysis loop --------------------------------------------------------

function analyseFrame() {
  if (!state.running) return;
  state.analyser.getFloatTimeDomainData(state.buffer);

  const freq = detectPitchYIN(state.buffer, state.sampleRate);
  if (freq && freq >= MIN_FREQ && freq <= MAX_FREQ && isVoiced(state.buffer)) {
    const midi = freqToMidi(freq);
    state.liveMidi = state.liveMidi == null ? midi : state.liveMidi * 0.6 + midi * 0.4;
    state.barHistogram[freqToPitchClass(freq)] += 1;
    state.trail.push(midi);
  } else {
    state.liveMidi = null;
    state.trail.push(null);
  }
  if (state.trail.length > 240) state.trail.shift();

  drawRibbon();
  requestAnimationFrame(analyseFrame);
}

function isVoiced(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length) > 0.01;
}

// --- ribbon rendering -----------------------------------------------------

function drawRibbon() {
  const canvas = els.canvas;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const lowMidi = 48;
  const highMidi = 84;
  const toY = (m) => h - ((m - lowMidi) / (highMidi - lowMidi)) * h;

  const scalePcs = state.key ? scaleOf(state.key) : null;
  for (let m = lowMidi; m <= highMidi; m++) {
    const pc = ((m % 12) + 12) % 12;
    const inScale = scalePcs ? scalePcs.has(pc) : false;
    const isTonic = state.key && pc === state.key.tonic;
    ctx.strokeStyle = isTonic
      ? 'rgba(120, 220, 170, 0.55)'
      : inScale
        ? 'rgba(255,255,255,0.14)'
        : 'rgba(255,255,255,0.05)';
    ctx.lineWidth = isTonic ? 2 : 1;
    const y = toY(m);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(130, 200, 255, 0.9)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  let penDown = false;
  const n = state.trail.length;
  state.trail.forEach((m, i) => {
    if (m == null) {
      penDown = false;
      return;
    }
    const x = (i / Math.max(1, n - 1)) * w;
    const y = toY(m);
    if (!penDown) {
      ctx.moveTo(x, y);
      penDown = true;
    } else ctx.lineTo(x, y);
  });
  ctx.stroke();

  if (state.liveMidi != null) {
    const y = toY(state.liveMidi);
    ctx.fillStyle = 'rgb(130, 200, 255)';
    ctx.beginPath();
    ctx.arc(w - 8, y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function scaleOf(key) {
  const major = [0, 2, 4, 5, 7, 9, 11];
  const minor = [0, 2, 3, 5, 7, 8, 10];
  const base = key.mode === 'major' ? major : minor;
  return new Set(base.map((d) => (key.tonic + d) % 12));
}

// --- controls -------------------------------------------------------------

function parseLockedKey(value) {
  const [name, mode] = value.split(':');
  return { tonic: NOTE_NAMES.indexOf(name), mode };
}

function applyMix() {
  if (!state.band) return;
  state.band.setMix({
    guitar: Number(els.guitarMix.value),
    bass: Number(els.bassMix.value),
    drums: Number(els.drumMix.value),
    pad: Number(els.padMix.value),
  });
}

function tapTempo() {
  const now = performance.now();
  state.tapTimes = state.tapTimes.filter((t) => now - t < 2500);
  state.tapTimes.push(now);
  if (state.tapTimes.length >= 2) {
    const spans = [];
    for (let i = 1; i < state.tapTimes.length; i++) spans.push(state.tapTimes[i] - state.tapTimes[i - 1]);
    const avg = spans.reduce((a, b) => a + b, 0) / spans.length;
    const bpm = Math.round(60000 / avg);
    if (bpm >= 40 && bpm <= 220) {
      els.tempo.value = String(bpm);
      onTempoChange();
    }
  }
}

function onTempoChange() {
  els.tempoLabel.textContent = `${els.tempo.value} BPM`;
  if (state.running) Tone.Transport.bpm.value = Number(els.tempo.value);
}

// --- init -----------------------------------------------------------------

els.start.addEventListener('click', () => {
  if (state.running) stop();
  else start().catch((err) => (els.status.textContent = `Error: ${err.message}`));
});
els.tempo.addEventListener('input', onTempoChange);
els.tap.addEventListener('click', tapTempo);
els.chordRate.addEventListener('change', () => {
  if (state.running) scheduleChords();
});
[els.guitarMix, els.bassMix, els.drumMix, els.padMix].forEach((s) =>
  s.addEventListener('input', applyMix),
);
window.addEventListener('resize', drawRibbon);
window.addEventListener('load', drawRibbon);
onTempoChange();
drawRibbon();
