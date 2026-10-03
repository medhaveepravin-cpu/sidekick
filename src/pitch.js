// Monophonic pitch detection with the YIN algorithm.
// Pure functions, no DOM or audio APIs, so this module runs in Node for tests.

export const NOTE_NAMES = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
];

// Estimate the fundamental frequency (Hz) of a buffer of PCM samples, or null
// when the signal is too noisy / unvoiced to trust.
//
// buffer     Float32Array of time-domain samples in [-1, 1]
// sampleRate samples per second of that buffer
// threshold  YIN absolute threshold; lower is stricter (fewer false positives)
export function detectPitchYIN(buffer, sampleRate, { threshold = 0.1 } = {}) {
  const halfN = Math.floor(buffer.length / 2);
  if (halfN < 2) return null;

  const yin = new Float32Array(halfN);

  // 1. Difference function.
  for (let tau = 0; tau < halfN; tau++) {
    let sum = 0;
    for (let i = 0; i < halfN; i++) {
      const delta = buffer[i] - buffer[i + tau];
      sum += delta * delta;
    }
    yin[tau] = sum;
  }

  // 2. Cumulative mean normalized difference.
  yin[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < halfN; tau++) {
    runningSum += yin[tau];
    yin[tau] = runningSum === 0 ? 1 : (yin[tau] * tau) / runningSum;
  }

  // 3. Absolute threshold: first dip below the threshold, following it down to
  //    its local minimum.
  let tauEstimate = -1;
  for (let tau = 2; tau < halfN; tau++) {
    if (yin[tau] < threshold) {
      while (tau + 1 < halfN && yin[tau + 1] < yin[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }
  if (tauEstimate === -1) return null;

  // 4. Parabolic interpolation around the dip for sub-sample precision.
  const x0 = tauEstimate > 0 ? tauEstimate - 1 : tauEstimate;
  const x2 = tauEstimate + 1 < halfN ? tauEstimate + 1 : tauEstimate;
  let betterTau = tauEstimate;
  if (x0 !== tauEstimate && x2 !== tauEstimate) {
    const s0 = yin[x0];
    const s1 = yin[tauEstimate];
    const s2 = yin[x2];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) betterTau = tauEstimate + (s2 - s0) / denom;
  }

  if (betterTau <= 0) return null;
  return sampleRate / betterTau;
}

// Continuous MIDI note number for a frequency (A4 = 69 = 440 Hz).
export function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// Pitch class 0..11 (C..B) for a rounded MIDI note.
export function midiToPitchClass(midi) {
  return ((Math.round(midi) % 12) + 12) % 12;
}

export function freqToPitchClass(freq) {
  return midiToPitchClass(freqToMidi(freq));
}

// Human-readable note name with octave, e.g. "A4".
export function freqToNoteName(freq) {
  const m = Math.round(freqToMidi(freq));
  return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

// How far (in cents) a frequency sits from the nearest equal-tempered note.
export function centsOff(freq) {
  const midi = freqToMidi(freq);
  return Math.round((midi - Math.round(midi)) * 100);
}
