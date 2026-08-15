# Enubot

Interactive character robot kiosk. A 3D-rigged body with a hand-built 2D
animated face, driven by real-time voice conversation, that turns its head to
look at whoever is standing in front of it.

Architecture, deliverables and week-by-week plan: **ENGINEERING-PLAN.md**
(in the OneDrive project folder alongside the client proposal).

---

## Run it

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. Hold **space** (or the on-screen button) to talk.
Add `?debug=1` for the HUD: fps, state, latency p50/p95, last gesture fired.

Out of the box the driver is `cached` — real pre-rendered speech, no STT, no LLM,
no network and no API spend. Press-to-talk walks the answer bank in order; keys
`1`–`9` and `0` play a specific answer. Everything downstream of the voice port
runs for real against it: state machine, captions, gestures, lip-sync, tracking.

`mock` is still there and is the driver with **no asset dependency at all** —
scripted turns with synthesised babble. Reach for it when the answer bank hasn't
been rendered, or when you want a turn whose text you can edit in one file.

To run the language model too:

```bash
cp apps/proxy/.env.example apps/proxy/.env   # add ANTHROPIC_API_KEY
npm start                                     # proxy + kiosk together
```

## Voice — where things stand

The route is decided: **ElevenLabs Agents, with an answer cache in front of it.**
The Week-3 spike passed all four gates on 2026-08-12, and two of them passed
differently enough to change the design.

**The cache ships; the live pipeline does not.** `voice/adapters/cached.ts` is
built and is the default driver. `voice/adapters/elevenlabs-agents.ts` still
throws, `POST /session` still returns 501, and the ElevenLabs workspace still has
no agent in it. STT and the LLM are a later feature; everything except live voice
runs on the cache today.

That build order is the one §8 asks for, and it is also the honest test of the
route choice: if most turns hit the cache, what sits behind it barely matters.
What the cached driver deliberately does *not* do is guess what the visitor said
— with no STT there is no transcript to match, so a press walks the bank. The
matching goes in `#pick` when STT lands and nothing else in the adapter moves.

**Read [`docs/elevenlabs-integration.md`](docs/elevenlabs-integration.md) before
writing any ElevenLabs code.** It carries the verified message reference, the
exact endpoints, and the implementation checklist in dependency order — plus the
three findings that are easy to get wrong from memory:

- There is **no turn-commit message**. Push-to-talk gates the *contents* of a
  continuous stream rather than starting and stopping it.
- **Inline `[wave]` tags don't work on Route A** — no seam before their TTS, so
  they get spoken aloud. Gestures go through a client tool instead. The prompt
  branches on `ENUBOT_VOICE_ROUTE`; leave it on `assembled` until the adapter
  exists, since the mock and `POST /chat` both parse inline tags.
- The audio is **raw PCM**, so `decodeAudioData` won't touch it — and it arrives
  with per-character timestamps that make exact gesture scheduling and true
  visemes nearly free.

## Layout

```
apps/kiosk/src/
  core/       state machine, gesture scheduler, gaze damping, presence,
              wave detection, greeting policy, latency
              pure TypeScript — no React, no vendor imports, all the tests
  voice/      ConversationDriver port + adapters/
  face/       FaceRenderer port + adapters/
  tracking/   VisionSource port + adapters/ + the inference worker
  audio/      AudioBus (one shared output chain), lip-sync analysis
  scene/      R3F canvas, robot, face plane, toon shading
  ui/         push-to-talk, captions, debug HUD, attract loop
  runtime/    the wiring that connects the three clocks
apps/proxy/   Node + Fastify. Holds every API key. Loopback only.
content/      persona.md, qa.json, redirects.md — hot-reloaded, no rebuild
docs/         elevenlabs-integration.md — verified API surface + checklist
scripts/      GLB validation, persona evals, event-day launcher
```

## Swapping tech

One rule makes the rest work: **the app core never imports a vendor.** Every
external capability sits behind a small interface; vendors are adapters. Trying
a different TTS, or the illustrated face instead of the procedural one, means
writing one adapter and changing one line in `apps/kiosk/enubot.config.ts`:

```ts
driver: 'cached',      // | 'mock' | 'elevenlabs-agents' | 'assembled'
face:   'procedural',  // | 'sprite'
vision: 'none',        // | 'mediapipe'
```

Two rules protect latency and security while experimenting:

1. **All audio flows through the shared `AudioBus`.** Adapters hand over decoded
   buffers; they never play audio themselves. Lip-sync and gesture timing both
   read from that one bus, so swapping TTS vendors can't desynchronise the mouth.
2. **No adapter ever holds an API key.** Adapters call the proxy; the proxy calls
   the vendor. Trying a new API means a route in the proxy, never a key in the
   browser bundle.

## Seeing you

Enubot follows the nearest visitor, notices when someone walks up, and waves back
at a wave. Off by default — run `npm run vision:assets` once, then set
`VITE_ENUBOT_VISION=mediapipe`.

**All inference is on-device.** No frame leaves the machine, nothing is recorded,
nothing is uploaded, and the models are vendored rather than fetched from a CDN
so the booth keeps seeing people when venue wifi drops. Worth a small sign — it's
a design property, not a disclaimer.

It runs on four clocks, deliberately decoupled:

| Clock | Rate | What runs |
| --- | --- | --- |
| Frame | 60fps | head + pupils, off the newest sample |
| Detection | 15Hz | face always, hands only when a wave could matter |
| Turn | seconds | state machine |
| Sentence | 1–3s | gestures, against audio playback position |

Inference lives in a worker (`tracking/worker/`) because MediaPipe's
`detectForVideo` runs *synchronously* on the calling thread — on the main thread
that's a multi-millisecond stall several times a second, landing inside a 16.6ms
frame budget, visible as a hitch in exactly the motion head tracking exists to
smooth. The main thread grabs a downscaled `ImageBitmap`, transfers it, and gets
back a plain object. One frame in flight at a time, so a slow machine lags
instead of queueing.

The hand pipeline costs several times what face detection does, so it is gated:
it runs only while a face is in frame, no turn is under way, and the last
greeting's cooldown has expired. An empty booth and a live conversation both cost
nothing but face detection.

Adapters observe; `core/` decides. `gaze.ts` handles the two moments that give
head tracking away — acquiring and losing a face — with a continuously running
idle scan, an attention weight that crossfades to it (fast to acquire, slow to
release) and a critically damped spring on the result, so there is no
discontinuity to smooth away in the first place. `presence.ts` refuses to trust
any single detection, `wave.ts` wants an open palm held up and swinging, and
`greeter.ts` decides whether to answer — and refuses far more often than it
agrees, because the failure mode on a busy floor is a robot that waves
constantly. All four are pure and unit-tested; none of them import MediaPipe.

## Cold start

The kiosk needs two downloads before it is worth showing anyone: 1.3MB of rigged
character and 1.3MB of pre-rendered answers. Both are fetched behind a boot
screen (`boot/`, `ui/BootScreen.tsx`), and the kiosk appears when both are in
memory — the model parsed, the whole bank decoded into `AudioBuffer`s.

Waiting is the point. Either half arriving late is a visible failure of its own
kind: a stand-in robot that swaps bodies while someone watches, or a press that
stands there in silence. Both used to happen, and the causes were ordering rather
than weight:

- **Nothing started until React had mounted.** The model was found by a HEAD
  probe, which cost a round trip to learn what the load itself reports, and only
  then came a lazy chunk and only then the GLB. `index.html` now preloads the GLB
  and the manifest, so both are moving while the bundle is still downloading —
  measured on a throttled link, the GLB's first byte moved at 90ms instead of
  1.2s.
- **The answer cache queued behind the camera.** `EnubotRuntime.start()` awaited
  `bus.unlock()` and then `vision.start()` before connecting the driver. The
  first does not resolve until the browser sees a user gesture; the second, on
  the booth build, is ~12MB of wasm and a camera permission prompt. On a
  deployment with `vision: 'mediapipe'` that put the entire voice download behind
  a dialog. Vision and voice now start together, and unlock is never awaited.
- **The warm was a heap.** Every clip was fetched on the same tick, which
  finishes the bank fast and starves the model — same link, bank at 1.8s and the
  robot not on screen until 6.5s. Warming three at a time in `qa.json` order
  gives bank at 3.8s and robot at 4.6s.

The boot screen has a hard 15-second backstop (`boot/useBoot.ts`). A loading bar
that never finishes is worse than a robot whose voice is still downloading, so a
slow venue connection shows the kiosk anyway and the press waits on its own clip
the way it used to.

`?debug=1` reports the warm as `voice cache` in the HUD. Anything other than
`ready` means a press would wait for a download.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Kiosk only (mock driver, no network needed) |
| `npm run dev:proxy` | Proxy only |
| `npm start` | Both, supervised together — the event-day launcher |
| `npm test` | Core unit tests (gestures, state machine, gaze, presence, wave, greeting) |
| `npm run typecheck` | Strict TypeScript, no emit |
| `npm run vision:assets` | Install the MediaPipe wasm + models into `public/`. Once per clone |
| `npm run validate:glb` | Assert the GLB has all eight clips, by exact name |
| `npm run check:cache` | Assert the pre-rendered answers still match `content/qa.json` |
| `npm run eval:persona` | Run the ten questions + adversarial set through the live prompt |

## Dev pages

With `npm run dev` running:

| URL | What it is |
| --- | --- |
| <http://127.0.0.1:5173/> | The kiosk |
| <http://127.0.0.1:5173/?debug=1> | Kiosk + HUD (fps, state, vision/attention, latency p50/p95) and `window.__enubot` |
| <http://127.0.0.1:5173/faces.html> | **Every face state side by side, live** |

The face sheet renders the same `ProceduralFace` the kiosk runs, so it can't drift
from what ships. Blinks and expression blends animate in real time, the gaze
sliders drive every cell at once, and **save PNG** exports the grid as one image
for client review. Reach for it whenever the face changes — "does it look
friendly" is the one question here no unit test can answer, so the substitute is
making the whole state space visible at once.

It is a dev tool. The dev server always serves it; a *build* takes `index.html`
as its only entry unless `VITE_ENUBOT_DEBUG_PAGES=1` is set, which adds this page
and `/lipsync.html`. `vercel.json` sets it, so the cloud preview has both and a
kiosk build has neither — a booth screen should not carry a page a visitor can
navigate to.

## Pinned versions, and why

`react` is pinned to `~19.2` rather than `^19`. `@react-three/fiber@9` declares
a peer range of `>=19 <19.3`, so a React 19.3 release would silently break the
scene on a fresh install. Re-check that range before widening the pin.

## Not in the repo

The GLB, the MediaPipe model and wasm, and the pre-rendered answer MP3s are all
gitignored and delivered out-of-band — see `assets/README.md`. None of them are
required to run the app; each one degrades to a working fallback (placeholder
robot, idle scan, no cached answers) rather than breaking the build.

The MP3s are the exception worth watching. They used to be a failure path; they
are now the *only* answer path, so on `driver: 'cached'` a missing bank is not a
degraded kiosk, it is a silent one. `apps/kiosk/public/fallback/manifest.json` is
committed precisely because the audio beside it is not: it is the only record in
the repo of what should be there, and `npm run check:cache` reads it.

The bank in the repo right now is **dummy audio** — a Higgsfield `seed_audio`
stand-in on placeholder copy for a fictional "Enu Summit", generated so the
cached path, lip-sync and gestures could be built and reviewed before the voice
and the client's real answers exist. Re-render the whole bank when either lands.

## Cloud preview (Vercel)

`vercel.json` deploys the kiosk front end only, as a static Vite build. The
proxy is deliberately not deployed: it holds every vendor key and is designed
for loopback on the kiosk machine, so putting it behind a public URL is a
different security posture and a different piece of work.

The deploy runs the same three assets the local kiosk does. The GLB and the
answer bank are committed (see `.gitignore` for why those two and nothing else),
and `npm run vision:assets` runs as part of the build, so the MediaPipe wasm and
models are in `dist/` without ever entering git. The build env therefore pins the
real configuration — `VITE_ENUBOT_DRIVER=cached`, `VITE_ENUBOT_VISION=mediapipe`
— not a degraded one.

`vercel.json` also sets the cache headers those assets need. The GLB, the MP3s
and the MediaPipe binaries get an hour of freshness and a day of
`stale-while-revalidate`, so a kiosk restart serves them out of cache instead of
revalidating 2.6MB one file at a time. `fallback/manifest.json` is deliberately
excluded and served `no-cache`: it is the index that says which answers exist and
what they say, and a stale index is the failure `npm run check:cache` exists to
catch. One conditional request per load keeps it honest.

`api/health.js` is the only server-side code deployed, and it holds no key. That
is not a compromise: `EnubotRuntime.#checkHealth` is the *only* proxy call the
client makes. Both live-voice drivers still throw on `connect()`, so /chat,
/tts-sample and /session have no caller — deploying them would put an
unauthenticated Anthropic relay on a public URL to serve zero traffic. They go up
when a driver needs them.

So the cloud build is as capable as the local one, because live voice is not
built anywhere yet. What runs: the real robot, the real answer bank with
lip-sync, camera presence, gaze and wave detection. What does not: STT, the LLM
turn, and streaming TTS — none of which exist locally either.

One difference worth knowing. The camera is the reason the venue build stays on
loopback: `localhost` is a secure context, so `getUserMedia` needs no
certificate. Vercel serves HTTPS, so the camera works there too — but it is a
public origin, and the browser will prompt every visitor.

## Working on Windows

Keep this repo outside OneDrive. `node_modules` under an OneDrive-synced folder
causes file locks, slow installs and watchers that miss changes. Docs and the
client proposal live in the OneDrive folder; the code lives here.
