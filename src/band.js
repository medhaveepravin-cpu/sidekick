// The backing band: a plucked ukulele, an upright-ish bass, and a drum kit,
// built on Tone.js. Browser-only (depends on the global `Tone` from the CDN).

import { midiToFreq } from './pitch.js';

const MIDI_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiToToneNote(midi) {
  return MIDI_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

export class Band {
  constructor() {
    // Plucked ukulele: short, bright Karplus-strong-ish pluck.
    this.uke = new Tone.PluckSynth({
      attackNoise: 1.2,
      dampening: 4000,
      resonance: 0.9,
    });
    this.ukeGain = new Tone.Gain(0.9).toDestination();
    this.uke.connect(this.ukeGain);

    // Bass: a rounded mono synth an octave or two below.
    this.bass = new Tone.MonoSynth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.02, decay: 0.2, sustain: 0.6, release: 0.4 },
      filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.4, baseFrequency: 120 },
    });
    this.bassGain = new Tone.Gain(0.7).toDestination();
    this.bass.connect(this.bassGain);

    // Drums: kick (membrane), snare + hat (noise).
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

    this.currentChord = null;
  }

  setMix({ uke, bass, drums }) {
    if (uke != null) this.ukeGain.gain.rampTo(uke, 0.1);
    if (bass != null) this.bassGain.gain.rampTo(bass, 0.1);
    if (drums != null) this.drumGain.gain.rampTo(drums, 0.1);
  }

  // Strum a voiced chord (array of MIDI notes), slightly spread like a real strum.
  strum(midiNotes, time, strumSpread = 0.012) {
    midiNotes.forEach((m, i) => {
      this.uke.triggerAttack(midiToToneNote(m), time + i * strumSpread);
    });
  }

  // Play the root as a bass note, dropped two octaves.
  playBass(rootMidi, time, duration = '4n') {
    const freq = midiToFreq(rootMidi - 24);
    this.bass.triggerAttackRelease(freq, duration, time);
  }

  // A simple backbeat for one bar in 4/4, scheduled against `time`.
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

  // Play a whole bar: strum on the downbeat, bass on 1 and 3, drums throughout.
  playBar({ voicing, root }, time, barSeconds) {
    this.currentChord = { voicing, root };
    this.strum(voicing, time);
    this.playBass(root, time, barSeconds / 2);
    this.playBass(root, time + barSeconds / 2, barSeconds / 2);
    this.playBeat(time, barSeconds);
  }

  dispose() {
    [this.uke, this.bass, this.kick, this.snare, this.hat].forEach((n) => n.dispose());
  }
}
