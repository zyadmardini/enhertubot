# Assets

Binaries are delivered out-of-band and gitignored — keep the repo cloneable.

## Character model

Export from Blender as **one GLB with every clip embedded**, then optimise:

```bash
npx gltfjsx model.glb --transform
```

Drop the result at `apps/kiosk/public/models/enubot.glb`. The app probes for
that path on load; until it exists, the procedural placeholder robot stands in,
so scene, face, gaze and gesture work is never blocked on the rig.

Validate every re-export:

```bash
npm run validate:glb
```

Clip names are the artist↔code contract and must match exactly. There are two
tiers, and the difference is what may hold up a delivery.

**Required — validation fails without these:**

`idle` · `breathe` · `greeting_wave` · `talk_a` · `talk_b` · `talk_c` ·
`thinking` · `nod`

**Optional variants — ship them whenever they're ready:**

`idle_look_around` · `goodbye_wave` · `point_front` · `point_side` · `present` ·
`shrug` · `shake` · `nod_slow` · `thinking_chin` · `celebrate`

The app reads which clips the GLB actually contains and picks among the ones it
has for each cue, so a rig with only the required eight animates correctly — it
just repeats itself more. Every optional clip that lands makes the booth's tenth
visitor a little less likely to be watching a replay of its first.

Two are worth calling out. `point` and `shrug` currently fall back to `talk_a`
and `talk_c` — generic talking clips standing in for gestures they don't really
depict, and those substitutions disappear the moment the real clips exist.
`shake` has **no** fallback on purpose: the only clip close enough to substitute
is `nod`, and answering "no" with a nod is worse than standing still, so Enubot
does nothing at all until that one is delivered.

Budgets: ≤ 60k triangles, ≤ 2048px textures, single skinned mesh, ≤ 60 bones.
The head bone must be cleanly isolated in the hierarchy — gaze rotates it
procedurally, on top of whatever clip is playing.

## Head tracking model

MediaPipe needs two things vendored locally so the kiosk works with no network:

- `apps/kiosk/public/models/blaze_face_short_range.tflite`
- `apps/kiosk/public/mediapipe/wasm/` — copy from
  `node_modules/@mediapipe/tasks-vision/wasm/`

Missing either one is not fatal: tracking reports itself unavailable and Enubot
falls back to the idle scan, with one warning in the console.

## Pre-rendered answers (the cache)

These were a failure path. Since the Week-3 route decision they are the
**primary** answer path — see `docs/elevenlabs-integration.md` §8 — and on
`driver: 'cached'`, which is the current default, they are the *only* one.
Pre-render **all ten**, not the top five.

Two things make up the bank, and one of them is committed:

| | Where | Committed |
|---|---|---|
| The audio | `apps/kiosk/public/fallback/<id>.mp3` | No — gitignored |
| The index | `apps/kiosk/public/fallback/manifest.json` | **Yes** |

`<id>` is the `id` field from `content/qa.json` — `what-are-you.mp3`,
`keynote.mp3`, and so on. Name by id, never by index: `answer-3.mp3` silently
becomes the wrong answer the first time someone reorders the file, and that is a
failure you find at the booth.

The manifest is what the app actually reads. Each entry carries the id, the
hotkey, the question, the file name, and the answer text **with its inline
gesture tags** — the tags are what move the body, and the MP3 is a recording of
that same text with them stripped. It is committed because the audio next to it
is not: without it nothing in the repo records what should be there.

Answers play through the driver and therefore the same `AudioBus`, so the mouth
syncs and gestures fire with no network at all. That is the one path that needs
no transcript and therefore no vendor — it is what runs when `/health` fails.

Hotkeys `1`–`9` then `0` come from the `hotkey` field in the manifest. They used
to be a second list maintained by hand in `apps/kiosk/src/App.tsx`, which meant
renaming an id pointed a key at a 404 with nothing to say so; there is now one
source for the mapping and no list to keep in step.

### Gesture timing is baked, not guessed

After rendering, resolve each answer's inline tags to real audio times:

```bash
npm run bake:gestures
```

This writes a `cues` track into each manifest entry — the gesture and expression
names with the second they belong on. The app plays those exactly, instead of
estimating from "how many characters in, out of how many", which no real sentence
obeys: a pause before a punchline moves a gesture by a few hundred milliseconds,
which is the difference between a wave landing on "hello" and just after it.

Where the times come from, best first:

1. **`<id>.alignment.json` beside the MP3** — per-character timings captured when
   the audio was generated. Exact. This is the reason to keep the timestamped
   variant of whatever TTS renders the bank; the same file also feeds the
   lip-sync closure track, which is what makes the lips actually meet on an /m/
   rather than approximating it from the spectrum.
2. **Proportional across the measured duration** — a straight-line guess, no
   better than what the app already infers at runtime. Its value is that it puts
   a number in a file a human can then correct by ear.

**Hand-edited times are safe.** Re-baking skips any answer whose text and audio
are unchanged, tracked by `cuesStamp`. Editing an answer invalidates its stamp
and re-bakes it; `--force` re-bakes everything and discards hand tuning.

Tags may also be marked optional as `[nod?]`, which plays them about half the
time. Use it for filler beats — a nod of acknowledgement — so a visitor watching
the same answer twice doesn't see the identical performance.

### Keeping the cache honest

**Re-render whenever `qa.json` answers change.** A cached answer that contradicts
the live one is worse than having no cache: it is confidently, consistently
wrong, and nothing in the running app can detect it. Treat re-rendering as part
of the content edit, not as a separate chore — and then run:

```bash
npm run check:cache
```

which fails if an id is missing, if the audio is absent or truncated, if two
answers claim the same hotkey, or if the manifest text and `qa.json` have drifted
apart word-for-word. That last check is the one that matters: it is the only
thing standing between a one-word edit and a robot confidently reciting last
week's coffee time.

### The bank in the repo right now is dummy audio

Generated 2026-08-12 with Higgsfield `seed_audio`, voice **Benji**
(`e6f9b893-51b1-51d3-afe9-9e0482cb7ac1`), on placeholder copy for a fictional
"Enu Summit". It exists so the cached path, lip-sync and gesture timing could be
built and reviewed before either the real voice or the client's real answers
landed. Both of those are still outstanding, and **the whole bank gets re-rendered
when they arrive** — treat nothing in it as a voice decision.
