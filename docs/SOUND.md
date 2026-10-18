# Hydro — Sound

A gentle, living soundscape that reflects what is on screen, plus small UI
sounds. Quiet by default; it should sound like a meadow by a stream, never
like a game demanding attention. (DESIGN.md §6; the earlier "no sound for
now" decision is reversed.)

## 1. Pieces

```
 snapshots ──▶ SoundDirector ──(4×/s MixFrame)──▶ AudioEngine ──▶ speakers
 camera    ──▶  (audio/director.ts)                (audio/engine.ts)
                 uses audio/mix.ts (pure)          one AudioContext
 UI, toasts, fish jumps ─▶ audio/bus.ts ─▶ SoundSystem (audio/sound.ts)
```

- **`audio/mix.ts`** — pure functions, unit-tested in Node
  (`tests/audio/mix.test.ts`): the camera as a `View` (`toScreen` /
  `fromScreen` match the real orthographic camera), `summariseView`
  (samples a 20×20 grid over the screen: flowing water weighted by depth
  and speed, still deep water, fast water ≥ 1.2 m/s, marsh = shallow calm
  water on wet green ground, known land and its vegetation, plus the
  stereo centroid of each water kind; fogged cells are silent),
  `ambience` (layer gains), `entitySources` / `structureSources` /
  `turbineHum` (spot candidates) and the rate-limiting `SpotScheduler`.
- **`audio/director.ts`** — keeps what snapshots send only when it changes
  (buildings, structures, power, look, fog, plans), summarises the view
  at most 5× a second while the snapshot's pooled buffers are at hand,
  and produces one `MixFrame` (layer gains, pans, spot events) per tick.
  The crew digging is heard where plans are in view while the terrain
  changes.
- **`audio/engine.ts`** — the Web Audio graph on any `BaseAudioContext`
  (real time in the game, `OfflineAudioContext` for review). Every change
  is scheduled with `setTargetAtTime` ramps (τ 0.7 s for layers) and every
  voice starts from 0 with a 4–8 ms attack, so nothing clicks.
- **`audio/sound.ts`** — `SoundSystem`: settings, autoplay unlock, visibility,
  the 250 ms tick, the main game vs a welcome scene feed, lazy sample
  loading, recording and offline rendering for review.
- **`audio/bus.ts`** — a tiny hook so UI modules (achievement toasts, the
  stats bar's milestone sparkle, the welcome scenes) can ask for sounds
  without importing the system.

## 2. The mix

All levels are linear gains before the master volume (slider² — default
slider 0.6, i.e. gain 0.36) and a gentle safety compressor (−14 dB, 3:1,
soft knee) that should rarely act.

### Ambient layers (procedural)
Pink and brown noise buffers (5–7 s, seamlessly looped, deterministic),
filtered and slowly modulated by a smooth random LFO buffer. Three noise
sources feed all layers.

| Layer | Sound | Driven by | Level |
|---|---|---|---|
| river | brown noise 160–800 Hz body + a pink "babble" band around 1.3 kHz whose centre and level wobble | flowing water in view, `1−e^(−9f)`; × (1 − 0.55·zoom); panned to the water | 0.5 |
| lake | low lapping swells (1.6–3.4 s, quick rise, slow fall) + a faint wash | still deep water, `1−e^(−4f)`, a bit more with wind | 0.45 |
| rapids | broad rushing pink noise 300 Hz–4.2 kHz | fast water (weir spill, races, rapids) `1−e^(−14f)` | 0.32 |
| rain | high-passed hiss + soft drop ticks | the rain front at the view centre (fades over a third of its radius beyond the edge) | 0.3 |
| wind | a slowly sweeping band 200–650 Hz with gusts | 0.12 + 0.45·zoom + winter 0.2 + snow + rain + wind speed | 0.4 |
| crickets | two sine singers at 4.4/4.7 kHz gated by chirp patterns | summer (late spring a little), warm, green land, a little more towards evening | 0.022 |
| hum | 98 Hz triangle + 197 Hz sine, low-passed, slightly wobbling | running turbines near the centre, by log power | 0.05 |

Birds and frogs are densities that drive spot sounds (below):
- birds: `birdSeason(yearFrac)` (spring 1, high summer 0.75, early autumn
  0.1–0.45, none in winter) × known land × greenery, less in rain or
  zoomed out;
- frogs: marsh in view, warm, not in winter.

**Zoom.** `zoom` is 0 at a view height ≤ 10 cells and 1 at ≥ 240.
Close up the water detail dominates; far out it fades and the wind rises.
**Pause.** Ambience keeps breathing at 0.6× (birds and frogs at half rate);
all activity sounds stop. **Speed.** Activity rates scale with √speed,
at most 2×, and stay capped.

### Spot sounds
Sources: people building (hammer, 1–3 mallet taps), chopping (axe), working
(spade); cows, sheep, chicks; turning water wheels and mills (creak); the
crew digging under plans; fish jumps (splash, from `FishJumps.onSplash`);
birds (3–6.5 s slices of a recorded birdsong bed, faded in and out);
frogs (synthesised croaks).

Placement: pan = 0.75 × screen x; gain falls off from the screen centre
to 25 % at the edge, nothing beyond 1.25 screen radii, and × (14 /
viewHeight)^0.8 when zoomed out.

Rates (`SPOT_RULES`): per source, capped per kind and with a minimum gap,
plus a total token bucket of 2.2 spots/s, keeping the loudest when more
come up — a bustling village is a murmur of taps, not a din.

| kind | per source /s | cap /s | gap s | level |
|---|---|---|---|---|
| hammer | 0.5 | 1.4 | 0.25 | 0.5 |
| chop | 0.35 | 0.9 | 0.3 | 0.45 |
| dig | 0.3 | 0.9 | 0.3 | 0.4 |
| moo | 1/50 | 0.08 | 6 | 0.25 |
| baa | 1/35 | 0.12 | 4 | 0.3 |
| peep | 1/10 | 0.4 | 1 | 0.05 |
| creak | 1/5 × speed | 0.4 | 1.5 | 0.45 |
| splash | (events) | — | 0.4 | 0.22 |
| bird | 0.5 × density | 0.5 | 1.2 | 0.9 |
| frog | 0.7 × density | 0.7 | 0.5 | 0.1 |

At most 10 spot voices play at once.

### UI sounds (synthesised)
A soft wooden tock for buttons, a two-note tick for tools, a lower
two-note "thunk" when a plan is placed, a C-major bell arpeggio for an
achievement, a rising pentatonic bell phrase at a population milestone.
All peak below −20 dBFS at the default volume.

## 3. Behaviour
- **Start.** Default on, but the AudioContext is only created at the first
  pointer or key gesture (autoplay rules); the samples (~190 KB) are
  fetched then. Muted at that time: nothing is created until unmuted.
- **Menu.** "Sound on/off" and a volume slider at the top of the menu,
  persisted in `localStorage['hydro.sound']`.
- **Hidden tab / mute.** Fade out in ~0.2 s, then `suspend()` the context
  (no CPU); resume and fade in when back.
- **Welcome scenes and tool cards.** They feed their own snapshots and
  camera, so the panels have their own soft ambience (the river, the
  village, the rain); the main game's mix returns when they close.
- **Tests.** Off with `?test=1` unless `&sound=1`.
- **Performance.** One context; ~16 always-running sources and ~15 filters;
  the mixer runs 4× a second and the view summary 5× a second on 400
  samples, never per frame.

## 4. Assets and credits
All recorded sounds are CC0; see `public/audio/CREDITS.md`. Kenney's RPG
Audio and Impact Sounds (axe, creaks, mallet, spade), OpenGameArt: cow
(qubodup), sheep (AntumDeluge), birdsong (isaiah658). Mono MP3 (plays
everywhere, including Safari), ~190 KB in all, mostly the birdsong bed.
Everything else is synthesised.

Not yet: village chatter and children's voices (no CC0 recordings that
fit), music.

## 5. Review
`npm run sound-review` renders scenarios offline through the same graph
and writes WAVs, spectrograms and a loudness report (docs/TESTING.md
§5b). Last review (20 s each, seed 1, default volume):

(see below)
