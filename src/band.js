// The backing band: a plucked acoustic guitar (polyphonic, so a strum rings as
// a chord), a bass, a drum kit, and a sustaining pad that holds the chord
// between changes. Browser-only (depends on the global `Tone` from the CDN).

import { midiToFreq } from './pitch.js';

const MIDI_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiToToneNote(midi) {
  return MIDI_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

// Round-robin bank of PluckSynth voices. PluckSynth is monophonic on its own,
// so a strum needs several voices ringing at once to sound like a chord.
class PluckBank {
  constructor(voices, opts) {
    this.voices = Array.from({ length: voices }, () => new Tone.PluckSynth(opts));
    this.out = new Tone.Gain(1);
    this.voices.forEach((v) => v.connect(this.out));
    this.i = 0;
  }
  connect(dest) {
    this.out.connect(dest);
    return this;
  }
  pluck(note, time, velocity = 1) {
    const v = this.voices[this.i % this.voices.length];
    this.i++;
    v.triggerAttack(note, time, velocity);
  }
  dispose() {
    this.voices.forEach((v) => v.dispose());
    this.out.dispose();
  }
}

// A small bank of sustaining synth voices for the pad layer.
class PadBank {
  constructor(voices, opts) {
    this.voices = Array.from({ length: voices }, () => new Tone.Synth(opts));
    this.out = new Tone.Gain(1);
    this.voices.forEach((v) => v.connect(this.out));
  }
  connect(dest) {
    this.out.connect(dest);
    return this;
  }
  set(midiNotes, time) {
    this.voices.forEach((v) => v.triggerRelease(time));
    midiNotes.slice(0, this.voices.length).forEach((m, i) => {
      this.voices[i].triggerAttack(midiToToneNote(m), time + 0.005);
    });
  }
  release(time) {
    this.voices.forEach((v) => v.triggerRelease(time));
  }
  dispose() {
    this.voices.forEach((v) => v.dispose());
    this.out.dispose();
  }
}

export class Band {
  constructor() {
    // Acoustic-ish guitar: 8 pluck voices so overlapping strums all ring.
    this.guitar = new PluckBank(8, { attackNoise: 0.9, dampening: 3000, resonance: 0.95 });
    this.guitarGain = new Tone.Gain(0.9).toDestination();
    this.guitar.connect(this.guitarGain);

    // Bass.
    this.bass = new Tone.MonoSynth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.02, decay: 0.2, sustain: 0.6, release: 0.4 },
      filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.4, baseFrequency: 120 },
    });
    this.bassGain = new Tone.Gain(0.7).toDestination();
    this.bass.connect(this.bassGain);

    // Pad: soft triangle voices with a slow envelope that hold a chord.
    this.pad = new PadBank(4, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.5, decay: 0.3, sustain: 0.85, release: 1.6 },
    });
    this.padGain = new Tone.Gain(0.25).toDestination();
    this.pad.connect(this.padGain);

    // Drums.
    this.kick = new Tone.MembraneSynth({ octaves: 4, pitchDecay: 0.05 });
    this.snare = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.2, sustain: 0 },
    });
    this.hat = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.05, sustain: 0 },
    });
    this.hat.volume.value = -18;
    this.drumGain = new Tone.Gain(0.45).toDestination();
    this.kick.connect(this.drumGain);
    this.snare.connect(this.drumGain);
    const hatFilter = new Tone.Filter(8000, 'highpass');
    this.hat.chain(hatFilter, this.drumGain);
  }

  setMix({ guitar, bass, drums, pad }) {
    if (guitar != null) this.guitarGain.gain.rampTo(guitar, 0.1);
    if (bass != null) this.bassGain.gain.rampTo(bass, 0.1);
    if (drums != null) this.drumGain.gain.rampTo(drums, 0.1);
    if (pad != null) this.padGain.gain.rampTo(pad, 0.1);
  }

  // Strum a voiced chord. Direction 'D' goes low->high, 'U' high->low.
  strum(midiNotes, time, { direction = 'D', spread = 0.022, velocity = 1 } = {}) {
    const order = direction === 'U' ? [...midiNotes].reverse() : midiNotes;
    order.forEach((m, i) => this.guitar.pluck(midiToToneNote(m), time + i * spread, velocity));
  }

  playBass(rootMidi, time, duration = '4n') {
    this.bass.triggerAttackRelease(midiToFreq(rootMidi - 24), duration, time);
  }

  // Hold a chord on the pad until the next setPad / releasePad.
  setPad(midiNotes, time) {
    this.pad.set(midiNotes, time);
  }

  releasePad(time) {
    this.pad.release(time);
  }

  // A steady backbeat for one bar of 4/4.
  playBeat(time, barSeconds) {
    const step = barSeconds / 4;
    this.kick.triggerAttackRelease('C1', '8n', time);
    this.kick.triggerAttackRelease('C1', '8n', time + step * 2);
    this.snare.triggerAttackRelease('8n', time + step);
    this.snare.triggerAttackRelease('8n', time + step * 3);
    for (let i = 0; i < 8; i++) {
      this.hat.triggerAttackRelease('16n', time + (step / 2) * i);
    }
  }

  dispose() {
    [this.guitar, this.bass, this.pad, this.kick, this.snare, this.hat].forEach((n) =>
      n.dispose(),
    );
  }
}
