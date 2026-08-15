# Forced alignment for the mouth

**Status: shipped 2026-08-15.** Every answer in the bank is aligned, the phone
tracks are committed, and `driver: 'cached'` drives the mouth from them.

This is the answer to the two standing complaints about the mouth — that it lags,
and that it does not articulate enough. Both were symptoms of the same thing: the
runtime never actually knew what sound was happening. It inferred, twice, in two
different ways, and paid for the uncertainty in latency and in shapes it refused
to commit to.

---

## 1. What was there before

| Source | Knows | Blind to | Runs on |
|---|---|---|---|
| Band-ratio analyser (`audio/lipsync.ts`) | vowel openness and rounding, `SS` / `CH` | every quiet consonant — the lips on /m/, the tongue on /θ/, /t/, /k/ | every audio source |
| Character alignment (`audio/alignment.ts`) | which consonants the *spelling* implies | vowels; anything English orthography lies about | only vendors that ship per-character times |
| Energy-anchored estimate (`audio/estimate.ts`) | roughly when in the clip the text got spoken | what any of it actually was | audio whose script is known |

Neither of the first two was wrong to exist, and both stay. But note what the
table says about the shipping configuration: the cached bank is pre-rendered MP3s
that carry no timings, so on the driver that actually runs at the booth the mouth
was the analyser alone, and the analyser cannot see a consonant.

Two costs followed from that, and they are exactly the two complaints:

**The delay.** The analyser is *reactive*. Sound has to arrive, be transformed,
clear the attack smoothing, and survive a 130ms `minVisemeSeconds` hold before
the mouth moves. Every one of those is a lag, and none can be tuned away — the
hold in particular exists because the source is unreliable, and shortening it
just trades lateness for flicker.

**The articulation.** `minVisemeSeconds: 0.13` caps the mouth at about 7 shape
changes a second, and the analyser only has 7 shapes to choose from. Real speech
runs through 12–14 phones a second. Most of the articulation was being thrown
away before it reached the face — deliberately, because the source could not be
trusted to be right about it.

---

## 2. What a forced aligner is

Given **audio** and **the words in it**, a forced aligner runs an acoustic model
constrained to that exact word sequence and reports where each word and each
phone starts and ends.

It is not recognition. It never has to decide *what* was said, only *when* — which
is why it is dramatically more accurate than transcription, and why it needs the
script. That constraint is the whole reason it fits here: the answer bank is
pre-rendered from `content/qa.json`, so the script is known exactly.

The output is a measurement, not a better guess. That is the difference that
matters — every downstream decision that was hedging can stop hedging.

### The three that were on the table

**Montreal Forced Aligner (MFA)** — the standard tool, Kaldi-based HMM-GMM,
actively developed, installs through conda. Word *and* phone boundaries, trained
acoustic models and pronunciation dictionaries for English and about eighty other
languages, and speaker adaptation. Published mean boundary error under 15ms on
hand-labelled corpora, which as of the 2026 benchmarks is still ahead of the
neural aligners — the classical architecture has not been beaten at this
particular job. Cost: a conda environment and a ~100MB model download.

**Gentle** — a Kaldi aligner wrapped in a Docker image and an HTTP endpoint,
built to be forgiving about transcripts that do not quite match the audio. Easy
to run, gives word and phone timings. It is also essentially unmaintained; the
Docker image is the practical way to use it. Worth knowing about mainly for the
robustness: if a recording and its script have drifted apart, Gentle degrades
where a strict aligner fails.

**whisper-timestamped / WhisperX** — a different thing wearing similar clothes.
These take Whisper's transcription and recover *word*-level timestamps, either
from cross-attention (whisper-timestamped) or a second forced-alignment pass
(WhisperX). Their advantage is that they do not need the script. Their
disadvantage is decisive here: they give **words, not phones**, and their word
boundaries are measurably looser than MFA's. A mouth needs phones. Word times
would be a real improvement for *gesture* timing, and no help at all for visemes.

Two others were considered and rejected. **Rhubarb Lip Sync** is a single binary
that goes straight from audio to mouth shapes — genuinely the easiest option, and
it emits the 6–9 Preston Blair shapes, which would be a downgrade from the
15-shape OVR set already drawn in `face/adapters/procedural.ts`. **torchaudio /
wav2vec2 CTC alignment** works well and pulls in a multi-gigabyte dependency for a
bake step that runs eleven times.

---

## 3. What we did

**MFA is the primary backend, PocketSphinx is the fallback, and the artifact
format is neither's.**

```bash
npm run bake:visemes                    # PocketSphinx — pip install and nothing else
npm run bake:visemes -- --backend mfa   # MFA — better, needs conda
```

PocketSphinx is there so the bake runs anywhere with one `pip install` — it is the
same class of aligner as MFA (HMM-GMM, constrained Viterbi) with a much smaller
model, and it bundles its own English acoustic model and CMUdict. What that costs
is real and was measured on this bank: it agrees with MFA to about 10ms median on
word starts, and it **failed outright on one of the eleven answers** — its
state-alignment pass gave up mid-clip on `wifi.mp3`, which MFA aligned without
complaint. The bake reports that per answer and keeps the other ten, so the
fallback degrades rather than blocking. The committed tracks are MFA's.

Both write the same file, `apps/kiosk/public/fallback/<id>.phones.json`:

```json
{
  "version": 1,
  "aligner": "mfa",
  "alphabet": "arpabet",
  "durationSeconds": 6.923,
  "words":  [{ "w": "i'm", "start": 0.05, "end": 0.23 }],
  "phones": [{ "p": "AY1", "start": 0.05, "end": 0.16 },
             { "p": "M",   "start": 0.16, "end": 0.23 }]
}
```

Three decisions are worth defending:

**The sidecar holds phones, not visemes.** The phone→shape mapping is a *look*
decision that wants tuning against the face; the alignment is a measurement that
costs a Python environment to reproduce. Keeping them apart means the mapping can
be changed in `audio/visemes.ts` and reloaded, with no re-alignment.

**The sidecars are committed.** Same reasoning as `manifest.json`, one step
further: they are what the app reads, and re-deriving them needs Python, the
audio, and a model download. A clone, a Vercel build and the kiosk itself need
none of that. Only re-rendering the bank does.

**The bake fails loudly on an unknown word.** Every aligner, asked to align a word
it has no pronunciation for, substitutes a "spoken noise" model and carries on —
producing a well-formed file in which one word is a pause. The word is invariably
the client's own name. `content/lexicon.txt` is where pronunciations go, and the
bake refuses to write a track in which any word aligned to silence.

### Pronunciations, settled by the recording

`content/lexicon.txt` allows a word to have more than one pronunciation, and the
aligner scores them all against the audio and keeps the one that fits. "Enubot"
went in as both *EE-noo-bot* and *EN-yoo-bot*; the recording picked the second.
When the real voice is rendered the file is re-run and the answer re-settles
itself.

### How the runtime uses it

`audio/visemes.ts` turns phone spans into shape spans and `LipSync` queries it
first, ahead of the spelling and the analyser. Four things happen inside that are
not just a lookup:

- **Diphthongs split.** `OW` is a glide from `oh` to `ou`, and drawing only its
  first target is why "no" and "gnaw" looked the same. Each gets its two shapes,
  inside its own measured span.
- **/h/ inherits.** It has no shape of its own — "he" and "who" have nothing in
  common at the lips — so it takes the shape of whatever follows.
- **Short silences are deleted, short shapes are grown forward.** An aligner marks
  the stop closure before a /t/ as 20ms of silence; that is part of the consonant,
  not a pause, and rendering it shuts the mouth mid-word. A real 15ms /p/, on the
  other hand, is grown to two frames so it cannot fall between them — forwards
  only, because a consonant that starts early lands on the wrong vowel.
- **No rate limiting.** `minVisemeSeconds` does not apply. It exists to stop
  unreliable sources flickering, and these boundaries are measurements.

### The latency term that was missing

`AudioBus.playbackSeconds` reports where the *mixer* is. The visitor's ears are
behind it by the device's output buffer — 32ms in the browser this was measured
in, more through Bluetooth or a TV's audio return. The mouth's lead now subtracts
`AudioBus.outputLatencySeconds`, so the shape lands on the sound that is actually
being heard rather than the one that has been scheduled.

This makes the timed path *later*, not earlier, and it is a correctness fix rather
than a fix for the lag complaint — the lag is fixed by the source being predictive
instead of reactive.

---

## 4. What it bought

Measured over the eleven committed answers, through the real `VisemeTrack`:

| | shape changes/sec | distinct shapes used |
|---|---|---|
| Analyser alone (what shipped) | ~6 | 7 at most, in practice fewer |
| Energy-anchored estimate | 6.9 | 11 |
| **Measured phones** | **9.8** | **13.6 of 15** |

The rate rising above the old 5–8 target is the point, not a regression: that
target was a proxy for "not jittery" and was enforced by a hold that could not
tell a real articulation from a classifier flip. Every one of these 9.8 changes
is a boundary someone's mouth actually crossed.

`apps/kiosk/src/audio/__tests__/bank-visemes.test.ts` holds the committed bank to
that, so a re-render that is never re-aligned fails the suite rather than quietly
mumbling at the booth.

---

## 5. Re-rendering the bank

The alignment is only as current as the audio. When the real voice lands:

```bash
# 1. render the MP3s from content/qa.json, then:
npm run bake:visemes    # phone tracks — needs Python, see scripts/align/requirements.txt
npm run bake:gestures   # gesture cues, now timed from the word boundaries above
npm run check:cache     # proves the manifest still says what qa.json says
npm test                # proves the new tracks actually articulate
```

`phonesStamp` in the manifest tracks the answer text and the audio size, so a
re-render invalidates its own alignment and the bake picks it up. Stale phone
times are worse than none — they are confidently wrong at every syllable — which
is why that stamp exists and why the check is in the test suite.

---

## 6. What this does not cover

**The live path.** Route A (ElevenLabs Agents) streams audio as it is generated;
there is no audio to align in advance, so the spelling heuristic in
`audio/alignment.ts` remains the best available there, and it is still a heuristic.
The obvious next step is grapheme-to-phoneme in the browser — a CMUdict-derived
lexicon with a letter-to-sound fallback — distributing each word's phones across
the character times the vendor already sends. That converts the guess from "which
consonant does this letter imply" to "which consonant does this word contain",
which is most of the remaining gap, and it needs no vendor support.

**Non-English.** The models here are US English. MFA ships pretrained models for
about eighty languages and the sidecar format is alphabet-tagged, so this is a
model download rather than a rewrite — but nothing in the mapping tables has been
tested against another language's phone set.

## Sources

- [Montreal Forced Aligner](https://github.com/MontrealCorpusTools/Montreal-Forced-Aligner)
  and its [user guide](https://montreal-forced-aligner.readthedocs.io/en/stable/user_guide/index.html)
- [MFA and the state of speech-to-text alignment in 2026](https://arxiv.org/abs/2606.18466) —
  the benchmark behind the "under 15ms, still ahead of the neural aligners" claim
- [Gentle](https://hub.docker.com/r/lowerquality/gentle)
- [WhisperX word-timestamp accuracy against MFA](https://github.com/m-bain/whisperX/issues/1247)
