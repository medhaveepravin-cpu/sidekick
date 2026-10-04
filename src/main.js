// Wires everything together: mic input -> pitch detection -> key + chord ->
// band, plus the live pitch ribbon. Browser-only (Tone.js, Web Audio, canvas).
//
// Timing runs on a single eighth-note clock (8 ticks per bar). Strum patterns
// are 8-slot arrays. The chord can be committed on the bar, each half bar, or
// the moment a confident change is detected ("tight" follow mode).

import { detectPitchYIN, freqToMidi, freqToPitchClass, NOTE_NAMES } from './pitch.js';
import {
  createKeyTracker,
  chooseChord,
  voiceChordSpread,
  keyName,
  chordName,
} from './theory.js';
import { Band } from './band.js';

const ANALYSIS_SIZE = 2048;
const MIN_FREQ = 70;
const MAX_FREQ = 1200;
const RECENT_DECAY = 0.6; // per tick, ~1-beat memory for the tight follow mode

// Strum patterns as 8 eighth-note slots; null = no strum on that eighth.
const D = (vel) => ({ dir: 'D', vel });
const U = (vel) => ({ dir: 'U', vel });
const STRUM_PATTERNS = {
  down: [D(1), null, null, null, D(0.9), null, null, null],
  downup: [D(1), U(0.6), D(0.9), U(0.6), D(1), U(0.6), D(0.9), U(0.6)],
  folk: [D(1), null, D(0.85), U(0.6), null, U(0.6), D(0.9), U(0.6)],
  island: [null, U(0.6), D(0.95), U(0.6), null, U(0.6), D(0.95), U(0.6)],
  hold: [null, null, null, null, null, null, null, null],
};

const VOICING_STYLES = {
  open: { range: { low: 40, high: 74 }, maxVoices: 6, spread: 0.03 },
  barre: { range: { low: 52, high: 76 }, maxVoices: 5, spread: 0.016 },
};

const els = {
  start: document.getElementById('start'),
  status: document.getElementById('status'),
  keyLabel: document.getElementById('key'),
  keyLock: document.getElementById('key-lock'),
  chord: document.getElementById('chord'),
  strum: document.getElementById('strum'),
  chordRate: document.getElementById('chord-rate'),
  style: document.getElementById('style'),
  capo: document.getElementById('capo'),
  sevenths: document.getElementById('sevenths'),
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
  strumVoicing: [], // what the guitar plays (style + capo applied)
  padVoicing: [],
  bassRoot: 48,
  strumSpread: 0.03,
  barHistogram: new Array(12).fill(0), // accumulates over a bar, for key
  recent: new Array(12).fill(0), // decaying window, for chord detection
  liveMidi: null,
  trail: [],
  tapTimes: [],
  tickId: null,
  tickInBar: 0,
  tickCount: 0,
  lastChangeTick: -99,
  strummedThisTick: false,
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

  state.tickInBar = 0;
  state.tickCount = 0;
  state.lastChangeTick = -99;
  Tone.Transport.bpm.value = Number(els.tempo.value);
  state.tickId = Tone.Transport.scheduleRepeat(onTick, '8n');
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
  state.tickId = null;
  if (state.band) state.band.dispose();
  state.band = null;
  state.chord = null;
  els.start.textContent = 'Start';
  els.status.textContent = 'Stopped.';
}

// --- the clock ------------------------------------------------------------

function onTick(time) {
  const tick = state.tickInBar;
  state.strummedThisTick = false;

  // Decay the rolling window so the tight follow mode reacts to recent singing.
  for (let i = 0; i < 12; i++) state.recent[i] *= RECENT_DECAY;

  // Update the key once per bar from the whole-bar histogram.
  if (tick === 0) updateKey();

  // Decide whether a chord may be committed on this tick.
  const mode = els.chordRate.value; // '1m' | '2n' | 'follow'
  if (state.key) {
    const cand = chooseChord(state.recent, state.key, {
      prev: state.chord,
      repeatPenalty: 0.5,
      sevenths: els.sevenths.checked,
    });
    const changed =
      !state.chord || state.chord.root !== cand.root || state.chord.quality !== cand.quality;

    if (mode === 'follow') {
      const dwellOk = state.tickCount - state.lastChangeTick >= 2;
      if ((changed && dwellOk && confident(cand)) || !state.chord) {
        commitChord(cand, time, changed || !state.chord);
      }
    } else {
      const onGrid = mode === '2n' ? tick === 0 || tick === 4 : tick === 0;
      if (onGrid) commitChord(cand, time, changed);
    }
  }

  // Strum pattern (skip if a change already accent-strummed this tick).
  if (!state.strummedThisTick && state.chord) {
    const ev = (STRUM_PATTERNS[els.strum.value] || [])[tick];
    if (ev) strumNow(time, ev.dir, ev.vel);
  }

  // Bass on beats 1 & 3, drums every eighth.
  if ((tick === 0 || tick === 4) && state.chord) state.band.playBass(state.bassRoot, time, '2n');
  state.band.drumTick(tick, time);

  state.tickInBar = (tick + 1) % 8;
  state.tickCount++;
}

function updateKey() {
  const total = state.barHistogram.reduce((a, b) => a + b, 0);
  if (total > 0) {
    let key = state.keyTracker.update(state.barHistogram);
    if (els.keyLock.value !== 'auto') key = parseLockedKey(els.keyLock.value);
    state.key = key;
    els.keyLabel.textContent = keyName(key);
  }
  state.barHistogram = new Array(12).fill(0);
}

// Does the recent window actually outline this chord well enough to switch?
function confident(chord) {
  const total = state.recent.reduce((a, b) => a + b, 0);
  if (total < 3) return false;
  const covered = chord.notes.reduce((s, pc) => s + state.recent[pc], 0);
  return covered / total >= 0.45;
}

function commitChord(chord, time, changed) {
  state.chord = chord;
  computeVoicings(chord);
  els.chord.textContent = chordName(chord);
  if (changed) {
    state.band.setPad(state.padVoicing, time);
    state.lastChangeTick = state.tickCount;
    // In tight mode a change can land off the strum grid — accent it so it's heard.
    if (els.chordRate.value === 'follow') {
      state.band.strum(state.strumVoicing, time, {
        direction: 'D',
        velocity: 1,
        spread: state.strumSpread,
      });
      state.strummedThisTick = true;
    }
  }
}

function computeVoicings(chord) {
  const cfg = VOICING_STYLES[els.style.value] || VOICING_STYLES.open;
  state.strumSpread = cfg.spread;
  const base = voiceChordSpread(chord, { range: cfg.range, maxVoices: cfg.maxVoices });
  state.bassRoot = base[0]; // bass ignores the capo
  const capo = Number(els.capo.value) || 0;
  state.strumVoicing = base.map((m) => m + capo);
  state.padVoicing = voiceChordSpread(chord, { range: { low: 52, high: 76 }, maxVoices: 4 });
}

function strumNow(time, dir, vel) {
  state.band.strum(state.strumVoicing, time, {
    direction: dir,
    velocity: vel,
    spread: state.strumSpread,
  });
}

// --- analysis loop --------------------------------------------------------

function analyseFrame() {
  if (!state.running) return;
  state.analyser.getFloatTimeDomainData(state.buffer);

  const freq = detectPitchYIN(state.buffer, state.sampleRate);
  if (freq && freq >= MIN_FREQ && freq <= MAX_FREQ && isVoiced(state.buffer)) {
    const midi = freqToMidi(freq);
    state.liveMidi = state.liveMidi == null ? midi : state.liveMidi * 0.6 + midi * 0.4;
    const pc = freqToPitchClass(freq);
    state.barHistogram[pc] += 1;
    state.recent[pc] += 1;
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
[els.guitarMix, els.bassMix, els.drumMix, els.padMix].forEach((s) =>
  s.addEventListener('input', applyMix),
);
window.addEventListener('resize', drawRibbon);
window.addEventListener('load', drawRibbon);
onTempoChange();
drawRibbon();
