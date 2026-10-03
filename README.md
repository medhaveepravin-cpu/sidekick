# Sidekick

A backing band that follows your voice, in the browser. You sing or hum, it
finds your key, and it plays a plucked guitar, bass, drums and a sustaining pad
underneath — so you can cover a song without holding an instrument.

<!-- TODO: add a 30-second demo GIF of you singing a cover with it, right here. -->

## How it works

- **Pitch** — [`src/pitch.js`](src/pitch.js) runs the YIN algorithm on mic audio
  to track the fundamental of your voice.
- **Theory** — [`src/theory.js`](src/theory.js) builds a pitch-class histogram
  over each step, estimates your key (Krumhansl–Kessler profiles, with hysteresis
  so it doesn't flicker between relative major/minor), picks a diatonic chord,
  and voices it as a strummable guitar chord.
- **Band** — [`src/band.js`](src/band.js) plays the chord as a polyphonic guitar
  strum, plus bass, drums and a sustaining pad, with [Tone.js](https://tonejs.github.io/).
- **Glue** — [`src/main.js`](src/main.js) handles the mic, the chord loop, the
  strum patterns, the transport, and the live pitch ribbon.

The band chooses each chord from the notes you just sang, so it trails you a
little — like an accompanist catching the change a touch late. Two things hide
that lag: the **pad** sustains the current chord through the gap, and the
**Change** control can update chords every ½ bar instead of every bar.

## Run it locally

```bash
npm start          # serves the folder at http://localhost:8000 (needs Python 3)
```

Then open <http://localhost:8000>, press **Start**, and allow the mic. Opening
`index.html` directly from the filesystem won't work — the mic needs a served
page.

> **Wear headphones.** Otherwise the band leaks into the mic and corrupts the
> key detection.

## Test

```bash
npm test           # 12 Node tests for pitch detection and theory logic
```

These cover the parts that run outside the browser. The mic, Tone.js, canvas
and layout are not unit-tested — check those by ear and eye.

## Using it

- **Key detection:** sing a melody you know and confirm the detected key. If it
  confuses relative major and minor, pick the key by hand from the **Key**
  dropdown.
- **Strum:** pick a pattern — Down, Down-Up, Folk, Island/offbeat, or Hold (pad
  only, no strum).
- **Change:** how often the chord can change — every bar, or every ½ bar for a
  snappier follow.
- **Tempo:** drag the slider or hit **Tap** a few times in time.
- **Mix:** guitar / bass / drums / pad sliders start at `0.9 / 0.7 / 0.45 / 0.25`
  — a guess; adjust to taste. Raise the pad for more sustain.

## Known limits

- Tempo is manual (slider or tap tempo).
- Triads only — no sevenths.
- Latency suits singing along, not tight instrument-style response.

## Roadmap

- Tempo that follows the singer, from note onsets.
- A paste-a-chord-chart mode.
- A vocal looper with automatic in-key harmonies.
- MIDI export of the chords played.
- An installable phone app (PWA).

## Deploy (GitHub Pages)

```bash
git remote add origin <your-repo-url>
git push -u origin main
```

Then enable Pages: **Settings → Pages → `main` / `root`**. It's a static site,
so no build step is needed.

## License

MIT
