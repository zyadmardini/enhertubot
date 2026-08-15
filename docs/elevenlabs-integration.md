# ElevenLabs Agents — verified API surface and implementation plan

Written after the Week-3 spike (2026-08-12) so the integration can be picked up
cold. Everything here was checked against the live docs on that date, not
recalled — but the Agents API moves, so re-check anything load-bearing before
building on it. Links at the bottom.

**Decision: Route A (ElevenLabs Agents) ships, with an answer cache in front of
it.** Rationale and the dissent are in `ENGINEERING-PLAN.md` §7.

Current state: nothing is wired. `apps/kiosk/src/voice/adapters/elevenlabs-agents.ts`
throws, `POST /session` in the proxy returns 501, and the ElevenLabs workspace
has no agent in it. The kiosk runs on `driver: 'mock'` and is unblocked.

---

## 1. Spike verdict — the four gates

All four pass. Two pass differently than `ENGINEERING-PLAN.md` §3.5 assumed, and
the differences are the whole reason this file exists.

| Gate | Verdict | What actually happens |
|---|---|---|
| 1. Push-to-talk | Pass, with a workaround | No turn-commit message exists. Gate the *contents* of the audio stream instead — see §4. |
| 2. Gesture channel | Pass, via client tools | `client_tool_call`. Inline `[wave]` tags **do not work on Route A** — see §5. |
| 3. Lip-sync tap | Pass, better than planned | Raw PCM + per-character alignment in the same event — see §6. |
| 4. Prompt control | Pass, but don't use it | Session overrides exist and are the wrong tool here — see §7. |

**The honest caveat.** Gate 1 passes on the letter and not the spirit.
Turn-taking is the main thing the bundle sells, and Enubot has an arcade button —
a hardware turn signal. We are paying for a turn-taking model and then working
around it. That argument was made, considered, and Route A was chosen anyway on
the "less code inside an 80-hour budget" ground. If Route A starts costing more
code than it saves, that reasoning has expired — the exit is `assembled.ts`, and
§9 below lists what would have to change.

---

## 2. Connection

```
wss://api.elevenlabs.io/v1/convai/conversation?agent_id=<id>
```

Regional variants exist (`api.us.`, `api.eu.residency.`, `api.in.residency.`,
`api.sg.residency.`) — pick by venue if data residency ever comes up.

A private agent needs a signed URL, minted server-side so the key never reaches
the browser:

```
GET https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=<id>
     header: xi-api-key: <key>
  →  { "signed_url": "wss://…?agent_id=…&conversation_signature=…" }
```

Valid **15 minutes** — the conversation must be *initiated* inside that window,
but may then run longer. So mint per session, not at boot. That is what
`POST /session` in `apps/proxy/src/server.js` becomes.

There is also a WebRTC transport (`GET /v1/convai/conversation/token`, token
valid 10 minutes). Not chosen: WebSockets hand us raw PCM frames we can feed
straight to the `AudioBus`, which is the rule that protects lip-sync. Revisit
only if packet loss on venue wifi turns out to be the problem.

---

## 3. Message reference

Both directions, as verified. This is the part worth trusting over memory.

### Client → server

```jsonc
{ "type": "conversation_initiation_client_data",
  "conversation_config_override": {
    "agent":        { "first_message": "…", "language": "en", "prompt": { … } },
    "asr":          { "keywords": ["…"] },
    "tts":          { "model_id": "…", "voice_id": "…" },
    "conversation": { "text_only": false, "max_duration_seconds": 3600 } },
  "user_id": "…",
  "dynamic_variables": { } }

{ "type": "user_audio_chunk", "user_audio_chunk": "<base64>" }
{ "type": "user_message", "text": "…", "source_medium": "audio|text|image|file" }
{ "type": "user_activity" }
{ "type": "contextual_update", "text": "…", "context_id": "…" }
{ "type": "client_tool_result", "tool_call_id": "…", "result": "…", "is_error": false }
{ "type": "pong", "event_id": 123 }
```

Note what is **absent**: anything that says "the user has finished speaking."
That is gate 1's whole problem.

### Server → client

```jsonc
{ "type": "conversation_initiation_metadata",
  "conversation_initiation_metadata_event": {
    "conversation_id": "…",
    "agent_output_audio_format": "pcm_8000|pcm_16000|pcm_22050|pcm_24000|pcm_44100|pcm_48000|ulaw_8000",
    "user_input_audio_format":  "…same set…" } }

{ "type": "audio",
  "audio_event": {
    "audio_base_64": "<base64 raw PCM>",
    "event_id": 123,
    "alignment": { "chars": ["H","i"],
                   "char_start_times_ms": [0, 50],
                   "char_durations_ms":  [50, 50] },
    "is_final": false } }

{ "type": "user_transcript",  "user_transcription_event": { "user_transcript": "…", "event_id": 1 } }
{ "type": "agent_response",   "agent_response_event": { "agent_response": "…", "response_id": "…" } }
{ "type": "agent_response_correction",
                              "agent_response_correction_event": {
                                "original_agent_response": "…",
                                "corrected_agent_response": "…" } }
{ "type": "client_tool_call", "client_tool_call": { "tool_name": "…", "tool_call_id": "…",
                                                    "parameters": { }, "expects_response": true } }
{ "type": "interruption",     "interruption_event": { "event_id": 1 } }
{ "type": "ping",             "ping_event": { "event_id": 1, "ping_ms": 0 } }
{ "type": "vad_score",        "vad_score_event": { "vad_score": 0.95 } }
```

Answer every `ping` with a `pong` carrying the same `event_id`, or the socket
drops mid-event.

---

## 4. Push-to-talk (gate 1)

There is no turn-commit primitive. The technique that works:

**Keep the socket streaming continuously and gate the contents.** Send real mic
frames while the arcade button is held; send digital silence when it is not.
Their turn-taking model then sees a clean speech→silence transition and finalises
on its own, and hall noise never reaches their VAD at all.

Do not stop sending frames on release. A stream that goes absent is not the same
signal as a stream that goes quiet, and the turn model is trained on the latter.

Agent config that matters:

- **Turn eagerness: `eager`.** Options are `eager | normal | patient`.
- **`turn.turn_timeout`** — floor is **1 second**, ceiling 30. This is the
  extended-silence fallback, *not* the finalise path. If turns are landing at
  ~1s after release, the VAD gate is not working and this timeout is what is
  actually firing. That is the signal to stop tuning and reconsider Route B.
- **Interruptions: enabled.** Barge-in is a proposal promise.

Measure press-to-first-audio p95 from day one (the HUD already does this). The
budget is ~600–900ms. Anything consistently over ~1.2s means gate 1 failed in
practice whatever the docs say.

---

## 5. Gestures (gate 2)

**Inline `[wave]` tags do not work on Route A.** On Route B the parser strips
tags before text reaches TTS; on Route A the LLM output goes straight into their
TTS with no seam to strip anything, so the tags get spoken aloud.

Handled: `buildSystemPrompt()` in `apps/proxy/src/content.js` branches on
`ENUBOT_VOICE_ROUTE` (`assembled` | `elevenlabs-agents`), and an unrecognised
value throws at boot rather than quietly building the wrong prompt. **Default is
`assembled`** — leave it there until the adapter exists, because the mock driver
and `POST /chat` both parse inline tags. The live value is reported by `/health`
as `voiceRoute`, which is worth checking, since the failure mode is otherwise
only detectable by hearing Enubot say "wave" to a visitor.

Use a **client tool** instead:

```jsonc
// registered on the agent, non-blocking
{ "name": "play_gesture",
  "parameters": {
    "name":          "wave | point | shrug | nod | think",
    "before_phrase": "first few words of the clause the gesture belongs to" } }
```

Mark it **non-blocking** (`expects_response: false`) so the agent does not stall
waiting for a reply it has no use for.

`before_phrase` is what buys back exact timing. Look the phrase up in the
`alignment` table from §6, get a real audio time, and schedule it on the
`AudioBus` playback clock with the existing 200ms lead — identical to Route B.
**This retires the concession in `ENGINEERING-PLAN.md` §3.7** ("fire-on-event
with a fixed lead — document the trade, accept it"). Gesture timing is now the
same code on both routes.

Port change this requires — one variant in `apps/kiosk/src/voice/types.ts`:

```ts
| { type: 'gesture'; name: GestureName; atAudioSeconds?: number }
```

Today the scheduler is only reachable through `agent_text` tag parsing
(`EnubotRuntime.ts:194`). Route A needs a first-class path in rather than the
adapter faking tags back into the text stream.

---

## 6. Audio and lip-sync (gate 3)

`audio_base_64` is **raw PCM** at the rate in `agent_output_audio_format`. Two
consequences:

1. **`decodeAudioData` will not work.** Raw PCM has no container. Convert
   Int16 → Float32 by hand and write into `ctx.createBuffer(1, n, rate)`, then
   `bus.enqueue(buffer)`. Simpler and lower-latency than decoding MP3.
2. **Request `pcm_48000`** so it matches the `AudioContext` rate on the event
   machine and no resampling happens. Check `AudioBus.ctx.sampleRate` on the
   actual hardware first — if it comes up 44100, request `pcm_44100` instead.

**Use the raw WebSocket, not `@elevenlabs/client`.** The SDK owns its own
`AudioContext` and output element. That breaks `AudioBus` rule #1 on contact —
lip-sync and the gesture clock both read from our bus, and audio that never
touches it is audio the mouth cannot follow.

### The alignment block is characters, not phonemes

Worth stating plainly, because the earlier draft of this section overstated it.
`alignment` gives per-character start times and durations. It does **not** give
phonemes or visemes, and no realtime voice API does — Gemini Live and OpenAI
Realtime give strictly less (raw audio and a transcript, no timing at all). Azure
Neural TTS and Amazon Polly do ship visemes, but they are batch TTS, not a
conversational bundle. There is no vendor swap that makes this problem go away.

English spelling is a poor guide to vowel sound — "though", "through" and "tough"
share four letters and no vowel — so mapping every character to a mouth shape
would be worse than what the analyser already does.

**Built (2026-08-12): the two sources are layered instead.**

**Widened (2026-08-14): the shape vocabulary is now the Meta OVR 15-viseme set**
(`sil PP FF TH DD kk CH SS nn RR aa E ih oh ou`), chosen because it maps 1:1 onto
`XR_META_face_tracking_visemes`, onto ARKit-style blendshape rigs, and onto the
Rhubarb A–H sheet a 2D illustrator draws from — so the names survive a swap to a
sprite-sheet or 3D face.

| Source | Owns | Runs for |
|---|---|---|
| Measured phones (`VisemeTrack`) | **everything** — all fifteen shapes, from boundaries a forced aligner measured | any audio whose script is known, offline; the cached bank ships it |
| Character alignment (`AlignmentTrack`) | consonant articulations — `PP` (p/b/m), `FF` (f/v/ph), `TH`, `DD` (t/d), `nn` (n/l/ng), `kk` (hard c/k/g), `CH` (ch/sh/j/soft g), `RR`, `ou` (w) | Route A live audio only |
| Band-ratio analysis (`LipSync`) | vowels `aa E ih oh ou`, and the fricatives `SS` / `CH` | every audio source, and the floor under both of the above |

**Superseded in part (2026-08-15): the cached bank is now force-aligned.** The two
rows below the first are what remains where no measured track exists — the live
path, and any answer that has not been through `npm run bake:visemes`. See
`docs/forced-alignment.md`; the rest of this section describes the sources that
still carry those cases.

The split is where it is because consonants are the thing spectral analysis
genuinely cannot do: a bilabial /m/ and a pause are both near-silent, so the
analyser sees "summer" and "su—er" identically and the lips never meet — and a
/θ/ or a /d/ is quieter still. Vowels are loud and spectrally distinct, so it
handles those well already. `SS` and `CH` stay with the analyser on purpose: it
hears where the noise peaks (/ʃ/ about an octave below /s/) and so is not fooled
by the silent s in "island" or the /ʒ/ in "measure", which spelling cannot see.

Alignment is a **spelling heuristic**, and deliberately a conservative one. Soft c
is handed back to the analyser rather than guessed at, `gh` lays down nothing at
all (silent in "night", /f/ in "laugh" — drawing nothing on the rare one beats
drawing a hard velar on the common ones), and `kn`/`wr` drop their silent letter.
`lipSync.articulationDetail: 'closures'` reverts to the original lips-only
behaviour; `/lipsync.html` switches between the two on the same utterance, which
is the way to judge whether the wider set is better rather than merely busier.

The inspector plays **the answer bank** — the eleven MP3s the `cached` driver
serves — plus local babble. It does not call the proxy's `/tts-sample`; that
endpoint still exists and still works, it simply is not wired to a UI while the
voice is undecided. The bank now ships **measured phone tracks** (`phonesFile` on
every entry), so by default those clips show what a visitor actually gets today;
the timing dropdown switches back to the analyser and to both estimates on the
same clip, which is how to judge whether the aligner earned its place.

### Estimating alignment for audio that has none (2026-08-14)

`audio/estimate.ts` derives character timings from a clip whose script is known
and whose timings are not. Even spacing — the old `linearAlignment` — produces
the right shapes in roughly the wrong places: it drifts further with every word,
puts articulations inside pauses, and changes shape at a flat ~14 times a second
where speech does 5 to 8. `estimateAlignment` fixes the placement by weighting
characters by expected duration (a vowel is held, a plosive is a burst, a full
stop is a pause with no character in it) and then walking the clip's **cumulative
energy** rather than the clock, so a character advances when the audio does and
silence absorbs nothing.

Measured on `what-are-you`, over the same clip:

| alignment | shape changes/sec | distinct shapes used |
|---|---|---|
| none — analyser alone | 8.1 | 6 |
| even spacing | 10.2 | 13 |
| energy-anchored | 10.2 | 12 |
| energy-anchored, `minVisemeSeconds` 0.13 | **6.9** | **11** |

The last row is the shipping configuration. The rate drops into the range real
speech occupies without the articulation going with it — see `minVisemeSeconds`
in `enubot.config.ts` for the second half of that, a floor on how long any shape
is shown, with `PP` exempt because the lips meeting is too visible and too brief
to wait its turn.

`/lipsync.html` switches between all three on the same clip, and its timeline can
be dragged to scrub the recording frame by frame with the viseme shown under the
playhead — which is the only practical way to tell a wrong shape from a late one.

**This was an estimate, not alignment — and it has since been replaced.** A real
forced aligner runs an acoustic model and gives boundaries that are correct rather
than plausible. That bake now exists: `npm run bake:visemes` writes `phonesFile`
into the manifest, `CachedDriver` reads it, and the shipping numbers are 9.8
changes/sec across 13.6 of the fifteen shapes. See `docs/forced-alignment.md` for
why MFA over Gentle or whisper-timestamped, and what the live path still cannot
have. The estimate stays, in the inspector, as the thing to compare against.

Consequences worth knowing before touching it:

- `AudioBus.enqueue` **returns the playback-time offset** where the chunk starts.
  Alignment times are chunk-relative and chunks are scheduled back to back, so
  without that offset every chunk after the first drives the mouth with the
  previous chunk's syllables. Do not reconstruct the offset by hand.
- The track is **cleared on barge-in and at end of utterance**. The next answer
  restarts the playback clock at zero; stale spans land on unrelated syllables.
- **Cached answers keep working untouched.** No alignment means an empty track,
  which means pure analyser — the fallback §8's tiers 1 and 2 depend on.
- The mock driver emits **synthetic linear alignment**, so the articulation path,
  chunk offsetting and every consonant shape all exercise in dev with no account
  and no spend. `/faces.html` shows all fifteen visemes as a sheet, each at the
  aperture the runtime actually reaches for it.
- Tuning is `lipSync.articulationLeadSeconds` and `lipSync.minArticulationSeconds`
  in `enubot.config.ts`. The lead exists because both timed sources are predictive
  where the analyser is reactive, and the face adds ~30ms of blend plus a frame of
  lag. `AudioBus.outputLatencySeconds` is subtracted from it at query time — the
  speaker is behind the mixer by the device buffer, and that term pulls the other
  way.
- `lipSync.minVisemeSeconds` does **not** apply to the measured track, and
  `lipSync.minMeasuredSeconds` (two frames) is its much smaller counterpart. The
  first suppresses flicker from sources that guess; the second only stops a real
  15ms /p/ falling between two frames.

---

## 7. Prompt custody (gate 4)

`conversation_config_override.agent.prompt` works, and is the wrong tool. Using
it means the persona ships in the browser bundle, which is exactly what §3.9
forbids at a kiosk a visitor can open devtools on. It also widens what a tampered
client can change.

**Leave overrides disabled in the agent's security settings.** The prompt lives
in the agent config, server-side, and the proxy owns it:

- `loadContent()` and `POST /reload-content` assemble the prompt as they do now,
  then `PATCH /v1/convai/agents/:id` to push it.
- The morning-of hot-edit promise survives — it becomes a push instead of a
  re-assembly. Same guarantee, one more hop.
- Per-visitor variability, if it is ever needed, goes through
  `dynamic_variables` — which carry no IP and are safe to send from the browser.

---

## 8. The answer cache

The plan is cache-first, live-pipeline-on-miss. **There is a constraint here that
has to be designed around, not assumed away:** matching a question against
`qa.json` requires a transcript, and on Route A the STT lives inside the bundle.
There is no "match it locally and never touch the network" path unless we run our
own STT.

So the cache has three tiers, and only two of them are free:

| Tier | Trigger | Latency | Network | Spend |
|---|---|---|---|---|
| **Staff hotkeys** `1`–`n` | Human presses a key | ~100ms | none | none |
| **Transcript intercept** | `user_transcript` matches `qa.json` | ~400ms | STT only | conversation minute only |
| **Live pipeline** | No match | ~600–900ms | full | full |

**Tier 2 is the interesting one.** The transcript event arrives *before* the
agent starts answering. Match it against `qa.json` (question + variants, fuzzy);
on a hit, send `interrupt`, drop the agent turn, and play the pre-rendered MP3
through the same `AudioBus`. You still pay the conversation minute — it is
running either way — but you skip LLM and TTS entirely, and the answer is
identical every time, which is worth as much at a booth as the speed is.

Tier 1 is the true zero-network path and already exists in the plan as §3.10's
canned mode. It is what runs when `/health` fails.

**Tier 1 now also ships on its own** (2026-08-12), as `driver: 'cached'` in
`voice/adapters/cached.ts` — the default while STT and the LLM are deferred.
Three things about it are worth knowing before tiers 2 and 3 are built on top:

- It emits the same `DriverEvent`s as any other adapter, so the turn, the
  captions and the gestures are the live shapes rather than a special case. When
  the transcript intercept lands, it becomes a branch inside `#pick`.
- **It sends no `alignment`.** An MP3 carries no per-character timings, and
  inventing linear ones over real speech drives the closure track onto the wrong
  syllables — worse than the analyser alone. This is what the optional
  `alignment` field on the audio event was for; §6's timings are a Route A
  luxury and the mouth has to be good without them.
- The staff hotkeys go through the driver rather than straight at the bus, so
  they fire gestures too. Playing the file directly — which is what the fallback
  did — gets you a voice with a motionless body, because nothing ever parsed the
  answer text.

**Full offline matching would need local STT** (Whisper-tiny / Vosk in a worker).
That is a Route B–shaped capability, out of scope here, and worth reaching for
only if the venue wifi turns out to be genuinely unusable. Note it as the escape
hatch, do not build it on spec.

Pre-render all ten answers, not five. Re-render whenever `qa.json` answers change
— `npm run check:cache` is what fails the build when you don't;
a cached answer that contradicts the live one is worse than no cache.

---

## 9. Implementation checklist

In dependency order. Nothing here is started.

- [ ] **Create the agent.** Workspace is empty. Prompt from `content/`, voice
      chosen, `play_gesture` client tool registered non-blocking, turn eagerness
      `eager`, interruptions on, output `pcm_48000`, overrides **off**.
      Record the agent ID in `apps/proxy/.env` as `ELEVENLABS_AGENT_ID`.
- [ ] **`POST /session`** — `apps/proxy/src/server.js:154`, replace the 501 stub
      with the signed-URL mint from §2.
- [ ] **Agent prompt sync** — proxy PATCHes the agent on content load/reload (§7).
- [x] ~~**Route-branch the gesture instruction** in `buildSystemPrompt()`~~ — done
      2026-08-12. Flip `ENUBOT_VOICE_ROUTE=elevenlabs-agents` in the same change
      that starts pushing the prompt to the agent, not before (§5).
- [ ] **`gesture` variant** on `DriverEvent` + runtime path to the scheduler (§5).
- [ ] **`ElevenLabsAgentsDriver`** — socket, ping/pong, PTT gate, PCM→AudioBuffer,
      `client_tool_call`→gesture, `interruption`→`bus.stop()` + `scheduler.flush()`.
      Forward `audio_event.alignment` on the `audio` DriverEvent — the runtime and
      the articulation track are already wired for it, so this is the only
      remaining step to switch lip-sync from analyser-only to the hybrid (§6).
- [x] ~~**Hybrid lip-sync**~~ — done 2026-08-12. `AlignmentTrack` + `LipSync`
      overlay, `mm`/`ff` mouth shapes, mock alignment, 17 tests (§6).
- [x] ~~**Meta OVR 15-viseme set**~~ — done 2026-08-14. Articulation classifier
      (tongue as well as lips, with a `closures` fallback), 5-way vowel split,
      /ʃ/-vs-/s/ separation, and a mouth rebuilt with teeth, tongue and one
      filleted-corner path for every shape (§6).
- [ ] **Bake real alignment into the answer bank.** A forced-alignment pass beside
      `bake:gestures` writing `alignmentFile` per answer, which `CachedDriver`
      already reads. Retires `audio/estimate.ts` for the cached path and gives the
      no-network tier the same mouth as the live one (§6).
- [ ] **Wire `estimateAlignment` into `CachedDriver`** if the bake above is not
      happening soon. It is inspector-only today; the driver change is three lines
      and would give cached answers consonants they currently cannot have (§6).
- [ ] **Re-measure `lipSync.bands` against the real voice.** The three fricative
      numbers were fitted to the *dummy* answer bank on 2026-08-14 and the bank is
      due to be re-rendered. At the previous values `sibilantRatio` never fired at
      all and every /s/ was drawn as an open `aa`, so this is worth redoing
      deliberately rather than assuming it carries over. `/lipsync.html` plays the
      bank and reads the viseme out per frame; sibilants should land around 8–10%
      of voiced frames.
- [ ] **Answer cache tier 2** — transcript intercept + fuzzy match + MP3 playback.
- [ ] **Session lifecycle on gaze presence** — open on visitor detected, close on
      idle. Keeps the socket warm for instant PTT without metering an empty booth.
- [ ] **Pre-render ten answers**, wire hotkeys beyond 5.

### Exit criteria before this is called done

Press-to-first-audio p95 logged and under ~900ms; barge-in flushes both audio and
queued gestures; gestures land within ±100ms of their clause; wifi-pull mid-answer
drops to canned mode without a restart.

---

## 10. Cost

$0.08/min voice, **95% discount on silence over 10 seconds**, LLM billed
separately as passthrough. A booth conversation is mostly silence, so an open
session is cheap — but 8 hours × 60 minutes is still the wrong default, which is
why the session is gated on gaze presence.

Realistic booth day is 100–200 conversation-minutes: single-digit dollars against
the $500 allowance. **Cost is not the constraint on this project** — do not spend
design effort optimising it. Arm the spend cap and alerts on the provider
dashboard anyway (§3.9), because the failure mode being defended against is a
tampered kiosk, not the bill.

---

## Sources

Checked 2026-08-12.

- [Agent WebSockets](https://elevenlabs.io/docs/agents-platform/api-reference/agents-platform/websocket)
- [Client events](https://elevenlabs.io/docs/agents-platform/customization/events/client-events)
- [Client to server events](https://elevenlabs.io/docs/agents-platform/customization/events/client-to-server-events)
- [Agent authentication](https://elevenlabs.io/docs/eleven-agents/customization/authentication)
- [Conversation flow](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow)
- [Agents pricing](https://help.elevenlabs.io/hc/en-us/articles/29298065878929-How-much-does-ElevenAgents-cost)
