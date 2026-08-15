#!/usr/bin/env python3
"""
Forced alignment for the pre-rendered answer bank.

Reads a job list on stdin, writes phone and word spans on stdout. Knows nothing
about the manifest, the kiosk, or where files live — `scripts/align-answers.mjs`
owns all of that and this owns the acoustics, so the two can be reasoned about
separately.

    echo '{"jobs":[{"id":"x","audio":"x.mp3","text":"hello"}]}' | python3 align.py

Why forced alignment at all, given `audio/estimate.ts` already places characters
against the energy curve: an estimate says *roughly when* the text got spoken, and
a forced aligner says *what sound is happening at 3.47 seconds*. The mouth needs
the second one. Every consonant the spectrum cannot see — the lips meeting on an
/m/, the tongue between the teeth on a /θ/, the difference between "bit" and
"pit" — is knowable here and nowhere else in this pipeline.

Two backends, one output shape:

  pocketsphinx  Default. An HMM-GMM aligner with a bundled 16kHz US English
                acoustic model, installed by pip and nothing else. Alignment is
                the easy case for this class of model — the words are known, so
                it is a constrained Viterbi pass rather than recognition — which
                is why a 30MB package is enough to do it properly.

  textgrid      Import from someone else's aligner. MFA (Montreal Forced
                Aligner) is the one worth the trouble: its published boundary
                error is under 15ms against hand-labelled corpora, where this
                model is nearer 25–30ms, and it takes speaker adaptation. Point
                `--textgrid-dir` at its output and the rest of the pipeline
                neither knows nor cares which produced the numbers.

Output times are seconds on the clip's own clock, and every clip is covered
end to end — silence included, as explicit `SIL` phones. A gap would leave the
mouth to the analyser, which cannot tell a closed mouth from a pause, and the
one thing worse than a mistimed shape is a jaw that hangs open through silence.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import tempfile

# Phones the acoustic models emit for "nothing is being said". Normalised to one
# name so the kiosk has a single silence phone to map rather than a list to keep
# in step with whichever aligner produced the file.
SILENCE_PHONES = {"SIL", "SP", "SPN", "NSN", "+SPN+", "", "sil", "sp", "spn", ""}
SILENCE_WORDS = {"<sil>", "<s>", "</s>", "[NOISE]", "[SPEECH]", "<eps>", ""}

TARGET_RATE = 16000


def fail(message: str) -> None:
    print(json.dumps({"error": message}))
    sys.exit(1)


# ── Text ─────────────────────────────────────────────────────────────────────


def normalise(text: str) -> list[str]:
    """
    The spoken words, as the dictionary spells them.

    Hyphens and dashes split rather than join: "push-to-talk" is three words to
    an aligner and one to a copywriter. Apostrophes stay, because "don't" and
    "i'm" are dictionary entries in their own right and splitting them produces
    two words that are not.
    """
    lowered = text.lower().replace("—", " ").replace("–", " ").replace("-", " ")
    words = re.findall(r"[a-z']+", lowered)
    return [w for w in (w.strip("'") for w in words) if w]


def read_lexicon(path: str | None) -> dict[str, list[str]]:
    """
    Pronunciation overrides, as `word  P H O N E S` lines.

    Exists for the words no general dictionary can be expected to have — which in
    practice means the client's own name, and is exactly the word a visitor hears
    most often. Getting "Enubot" wrong is the most visible possible failure of
    this whole pipeline.

    A word may appear on more than one line. Those become alternate
    pronunciations, and the aligner picks whichever actually matches the
    recording — which is a better way to settle "is it EE-noo or EN-yoo" than
    anybody's opinion, because the answer is whatever the voice said.
    """
    if not path or not os.path.exists(path):
        return {}
    entries: dict[str, list[str]] = {}
    with open(path, encoding="utf8") as handle:
        for line in handle:
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            word, _, phones = line.partition(" ")
            if word and phones.strip():
                entries.setdefault(word.lower(), []).append(" ".join(phones.split()))
    return entries


# ── Audio ────────────────────────────────────────────────────────────────────


def load_pcm(path: str):
    """Mono 16kHz signed 16-bit, which is what every model here expects."""
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly

    data, rate = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if rate != TARGET_RATE:
        divisor = math.gcd(int(rate), TARGET_RATE)
        mono = resample_poly(mono, TARGET_RATE // divisor, int(rate) // divisor)
    clipped = np.clip(mono * 32767.0, -32768, 32767).astype("<i2")
    return clipped.tobytes(), len(clipped) / TARGET_RATE


# ── pocketsphinx backend ─────────────────────────────────────────────────────


def build_dictionary(extra: dict[str, list[str]], base: str) -> str | None:
    """
    The stock dictionary plus the overrides, written somewhere temporary.

    Copied rather than appended to in place: the base file lives inside the
    installed package, and a bake step that edits its own dependencies is a bake
    step that behaves differently on the second machine that runs it.
    """
    if not extra:
        return None
    handle = tempfile.NamedTemporaryFile("w", suffix=".dict", delete=False, encoding="utf8")
    with open(base, encoding="utf8") as source:
        handle.write(source.read())
    for word, pronunciations in sorted(extra.items()):
        # `word(2)` is how this format spells a second pronunciation of the same
        # word; the decoder scores both and keeps whichever fits the audio.
        for index, phones in enumerate(pronunciations):
            suffix = "" if index == 0 else f"({index + 1})"
            handle.write(f"{word}{suffix} {phones}\n")
    handle.close()
    return handle.name


def align_pocketsphinx(
    jobs: list[dict], lexicon: dict[str, list[str]]
) -> tuple[list[dict], list[str]]:
    try:
        from pocketsphinx import Config, Decoder
    except ImportError:
        fail(
            "pocketsphinx is not installed. Install the aligner's dependencies:\n"
            "    pip install -r scripts/align/requirements.txt"
        )

    base_dict = Config()["dict"]
    known: set[str] = set()
    with open(base_dict, encoding="utf8") as handle:
        for line in handle:
            first = line.split(None, 1)
            if first:
                known.add(first[0].split("(")[0])
    known |= set(lexicon)

    dict_path = build_dictionary(lexicon, base_dict)
    results: list[dict] = []
    problems: list[str] = []

    for job in jobs:
        words = normalise(job["text"])
        missing = sorted({w for w in words if w not in known})
        if missing:
            problems.append(
                f'"{job["id"]}" — the aligner has no pronunciation for '
                f'{", ".join(missing)}. Add them to content/lexicon.txt.'
            )
            continue

        try:
            pcm, duration = load_pcm(job["audio"])
        except Exception as error:  # noqa: BLE001 — reported, not raised
            problems.append(f'"{job["id"]}" — could not read {job["audio"]}: {error}')
            continue

        decoder = Decoder(
            lm=None,
            loglevel="ERROR",
            # Wide beams, because this is alignment and not recognition. The
            # defaults are tuned to keep a live decoder cheap by pruning unlikely
            # paths; here the path is already known and the only thing pruning
            # can do is fail. A long answer with a breath in it will exhaust the
            # default beam mid-utterance and abandon the whole alignment.
            beam="1e-100",
            pbeam="1e-100",
            wbeam="1e-80",
            **({"dict": dict_path} if dict_path else {}),
        )
        decoder.set_align_text(" ".join(words))

        # Two passes, and both are needed. The first resolves the word sequence
        # against the audio; `set_alignment` then re-arms the decoder with that
        # result fixed, and the second pass subdivides it into phones.
        #
        # Note where the `set_alignment` sits. Calling it again after the second
        # pass re-arms the decoder a third time and throws the phone boundaries
        # away — the file still parses, every phone in a word just claims the
        # whole word's span, and the mouth holds one shape per word.
        try:
            decoder.start_utt()
            decoder.process_raw(pcm, full_utt=True)
            decoder.end_utt()
            decoder.set_alignment()
            decoder.start_utt()
            decoder.process_raw(pcm, full_utt=True)
            decoder.end_utt()
            alignment = decoder.get_alignment()
        except RuntimeError as error:
            # One answer failing must not cost the other ten theirs. The usual
            # cause is a recording that does not say what the script says.
            problems.append(f'"{job["id"]}" — alignment failed: {error}')
            continue

        if alignment is None:
            problems.append(f'"{job["id"]}" — the aligner produced no alignment.')
            continue

        word_spans: list[dict] = []
        phone_spans: list[dict] = []
        for word in alignment:
            # Frames are centiseconds in this model — 100 per second.
            start, end = word.start / 100.0, (word.start + word.duration) / 100.0
            if word.name not in SILENCE_WORDS:
                word_spans.append({"w": word.name.split("(")[0], "start": start, "end": end})
            for phone in word:
                name = phone.name.split("(")[0]
                phone_spans.append(
                    {
                        "p": "SIL" if name in SILENCE_PHONES else name,
                        "start": phone.start / 100.0,
                        "end": (phone.start + phone.duration) / 100.0,
                    }
                )

        results.append(
            {
                "id": job["id"],
                "durationSeconds": duration,
                "aligner": "pocketsphinx/en-us",
                "alphabet": "arpabet",
                "words": word_spans,
                "phones": phone_spans,
            }
        )

    if dict_path:
        os.unlink(dict_path)
    return results, problems


# ── MFA backend ──────────────────────────────────────────────────────────────


def resolve_dictionary(name: str) -> str | None:
    """
    A dictionary name as a path on disk, so overrides can be merged into it.

    MFA takes either, and downloads pretrained ones to a fixed place, so a name
    can be turned back into a file. Returns None when it cannot be, which is not
    fatal — it only means `content/lexicon.txt` has nowhere to go.
    """
    if os.path.exists(name):
        return name
    root = os.environ.get("MFA_ROOT_DIR") or os.path.join(
        os.path.expanduser("~"), "Documents", "MFA"
    )
    candidate = os.path.join(root, "pretrained_models", "dictionary", f"{name}.dict")
    return candidate if os.path.exists(candidate) else None


def probability_columns(body: str) -> str:
    """
    The numeric columns an MFA dictionary carries, as a tab-separated prefix.

    MFA's pretrained dictionaries are *probabilistic*: between the word and its
    phones sit a pronunciation probability and three silence corrections, all
    trained. An override written without them parses as a word whose first phone
    is "0.99", which is not a phone — so MFA drops the entry, the word is
    silently out of vocabulary, and it aligns to `spn`. On the mouth that reads
    as the robot's own name being mimed.

    Returns neutral values in whatever shape the file is already using, or an
    empty string for the plain two-column form.
    """
    for line in body.splitlines():
        fields = line.strip().split("\t")
        if len(fields) < 2 or not line.strip():
            continue
        numeric = 0
        for field in fields[1:]:
            try:
                float(field)
            except ValueError:
                break
            numeric += 1
        # Neutral: this pronunciation is the certain one, silence after it is a
        # coin toss, and neither neighbour is corrected for.
        neutral = ["1.0", "0.5", "1.0", "1.0"][:numeric]
        return "".join(f"{value}\t" for value in neutral)
    return ""


def phone_inventory(body: str, columns: int) -> set[str]:
    """Every phone symbol the dictionary actually uses."""
    inventory: set[str] = set()
    for line in body.splitlines():
        fields = line.strip().split("\t")
        if len(fields) < 2:
            continue
        inventory.update(fields[-1].split())
        # Some dictionaries put the whole pronunciation in one trailing field and
        # some space-separate from the word; take both readings rather than
        # guessing which file this is.
        if columns == 0:
            inventory.update(line.split()[1:])
    return inventory


def adapt_phones(phones: str, inventory: set[str]) -> str:
    """
    An override's phones, spelled the way this dictionary spells them.

    `content/lexicon.txt` is written in plain ARPAbet so it survives a change of
    aligner, and MFA's English dictionary marks stress on every vowel — `AA1`,
    not `AA`. An entry using the wrong one is not rejected loudly; the phone is
    simply unknown, so the entry is dropped and the word goes back to being out
    of vocabulary with nothing said about it.

    Primary stress lands on the first vowel and the rest go unstressed, which is
    right for a two-syllable name and near enough everywhere else — stress moves
    a vowel's quality, not the mouth shape it maps to.
    """
    if not inventory:
        return phones

    adapted: list[str] = []
    stressed = False
    for phone in phones.split():
        if phone in inventory:
            adapted.append(phone)
            continue
        marks = ["1", "0", "2"] if not stressed else ["0", "2", "1"]
        replacement = next((phone + mark for mark in marks if phone + mark in inventory), None)
        if replacement is None:
            adapted.append(phone)
            continue
        adapted.append(replacement)
        stressed = True
    return " ".join(adapted)


def unspoken_words(result: dict) -> list[str]:
    """
    Words the aligner covered with nothing but silence.

    The failure this catches is specific and quiet: an aligner that cannot look a
    word up does not stop, it substitutes a "spoken noise" model and carries on,
    and the output is a well-formed file in which one word is a pause. Since the
    word is invariably the client's own name, it is worth a hard failure.
    """
    missing: list[str] = []
    for word in result.get("words", []):
        spoken = [
            phone
            for phone in result["phones"]
            if phone["p"] != "SIL"
            and phone["end"] > word["start"] + 1e-6
            and phone["start"] < word["end"] - 1e-6
        ]
        if not spoken:
            missing.append(word["w"])
    return missing


def align_mfa(
    jobs: list[dict], lexicon: dict[str, list[str]], spec: dict
) -> tuple[list[dict], list[str]]:
    """
    Shell out to Montreal Forced Aligner over a corpus built from the jobs.

    One `mfa align` for the whole bank rather than one per answer: MFA spends
    most of a short run starting up, and eleven start-ups is most of a minute
    bought for nothing.
    """
    import shutil
    import subprocess

    import soundfile as sf

    binary = spec.get("mfaBin") or "mfa"
    if shutil.which(binary) is None:
        fail(
            f"'{binary}' is not on PATH. Montreal Forced Aligner installs through conda:\n"
            "    conda create -n mfa -c conda-forge montreal-forced-aligner\n"
            "    conda activate mfa\n"
            "    mfa model download acoustic english_us_arpa\n"
            "    mfa model download dictionary english_us_arpa"
        )

    acoustic = spec.get("acousticModel") or "english_us_arpa"
    dictionary = spec.get("dictionaryModel") or "english_us_arpa"
    problems: list[str] = []

    work = tempfile.mkdtemp(prefix="enubot-mfa-")
    corpus = os.path.join(work, "corpus")
    output = os.path.join(work, "aligned")
    os.makedirs(corpus, exist_ok=True)

    durations: dict[str, float] = {}
    staged: list[dict] = []
    for job in jobs:
        try:
            pcm, duration = load_pcm(job["audio"])
        except Exception as error:  # noqa: BLE001 — reported, not raised
            problems.append(f'"{job["id"]}" — could not read {job["audio"]}: {error}')
            continue

        import numpy as np

        samples = np.frombuffer(pcm, dtype="<i2")
        sf.write(os.path.join(corpus, f"{job['id']}.wav"), samples, TARGET_RATE, subtype="PCM_16")
        with open(os.path.join(corpus, f"{job['id']}.lab"), "w", encoding="utf8") as handle:
            handle.write(" ".join(normalise(job["text"])))
        durations[job["id"]] = duration
        staged.append(job)

    if not staged:
        return [], problems

    # Overrides go in by merging them into a copy of the dictionary, because MFA
    # takes exactly one and would otherwise send every unknown word through its
    # G2P model — which guesses, and guesses worst on invented names.
    dict_arg = dictionary
    resolved = resolve_dictionary(dictionary)
    if lexicon:
        if resolved is None:
            problems.append(
                f"content/lexicon.txt was ignored: could not find '{dictionary}' as a file to "
                "merge it into. Pass --mfa-dictionary with a path to apply overrides."
            )
        else:
            merged = os.path.join(work, "dictionary.dict")
            with open(resolved, encoding="utf8") as source:
                body = source.read()
            columns = probability_columns(body)
            inventory = phone_inventory(body, columns.count("\t"))
            with open(merged, "w", encoding="utf8") as handle:
                handle.write(body)
                # A dictionary whose last line has no newline would otherwise
                # swallow the first override into it, and the word would go back
                # to being unknown with nothing said about it.
                if body and not body.endswith("\n"):
                    handle.write("\n")
                for word, pronunciations in sorted(lexicon.items()):
                    for phones in pronunciations:
                        handle.write(f"{word}\t{columns}{adapt_phones(phones, inventory)}\n")
            dict_arg = merged

    command = [
        binary,
        "align",
        "--clean",
        "--quiet",
        "--single_speaker",
        # Boundaries refined below the 10ms frame step. A frame at 60fps is 16ms,
        # so this is the difference between a plosive landing on the right frame
        # and the one after it.
        "--fine_tune",
        "--output_format",
        "long_textgrid",
        corpus,
        dict_arg,
        acoustic,
        output,
    ]
    completed = subprocess.run(command, capture_output=True, text=True)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip().splitlines()
        fail("mfa align failed:\n    " + "\n    ".join(detail[-8:]))

    # MFA groups output by speaker when it finds speakers, so the TextGrids are
    # not reliably at the top level.
    found: dict[str, str] = {}
    for directory, _, files in os.walk(output):
        for name in files:
            if name.endswith(".TextGrid"):
                found[name[: -len(".TextGrid")]] = os.path.join(directory, name)

    results, import_problems = align_textgrid(
        staged, output, paths=found, durations=durations
    )
    return results, problems + import_problems


# ── TextGrid backend ─────────────────────────────────────────────────────────

_NUMBER = re.compile(r"[-+]?\d*\.?\d+")
_QUOTED = re.compile(r'"((?:[^"]|"")*)"')


def parse_textgrid(text: str) -> dict[str, list[tuple[float, float, str]]]:
    """
    Interval tiers out of a Praat TextGrid, which is what MFA writes.

    Handles both the long format MFA emits by default and the short format Praat
    can save, by ignoring the structure and reading the fields in order: an
    interval is two numbers and a quoted label, and a tier is a quoted name
    followed by its intervals. That is loose, and deliberately so — the strict
    reading is a grammar for a format whose only producer here is one tool.
    """
    tiers: dict[str, list[tuple[float, float, str]]] = {}
    lines = [line.strip() for line in text.splitlines()]

    current: str | None = None
    pending: list[float] = []
    seen_class = False

    for line in lines:
        if line.startswith("class ") or '"IntervalTier"' in line or '"TextTier"' in line:
            seen_class = True
            pending = []
            current = None
            continue

        quoted = _QUOTED.search(line)
        if quoted is not None:
            label = quoted.group(1).replace('""', '"')
            if seen_class and current is None:
                current = label
                tiers.setdefault(current, [])
                seen_class = False
                pending = []
            elif current is not None and len(pending) >= 2:
                tiers[current].append((pending[-2], pending[-1], label))
                pending = []
            continue

        # `intervals: size = 42` is a count, not a boundary; the interval lines
        # that follow are what carry the numbers we want.
        if "size" in line or "number" in line:
            continue
        found = _NUMBER.findall(line)
        if found:
            pending.extend(float(value) for value in found)

    return tiers


def align_textgrid(
    jobs: list[dict],
    directory: str,
    paths: dict[str, str] | None = None,
    durations: dict[str, float] | None = None,
) -> tuple[list[dict], list[str]]:
    results: list[dict] = []
    problems: list[str] = []

    for job in jobs:
        path = (paths or {}).get(job["id"]) or os.path.join(directory, f"{job['id']}.TextGrid")
        if not os.path.exists(path):
            problems.append(f'"{job["id"]}" — no TextGrid at {path}.')
            continue

        with open(path, encoding="utf8") as handle:
            tiers = parse_textgrid(handle.read())

        def pick(*names: str) -> list[tuple[float, float, str]]:
            for key, value in tiers.items():
                if key.lower() in names:
                    return value
            return []

        phones = pick("phones", "phone")
        words = pick("words", "word")
        if not phones:
            problems.append(f'"{job["id"]}" — {path} has no phone tier.')
            continue

        duration = (durations or {}).get(job["id"])
        if duration is None:
            try:
                _, duration = load_pcm(job["audio"])
            except Exception:  # noqa: BLE001 — the TextGrid is the authority here
                duration = max(end for _, end, _ in phones)

        results.append(
            {
                "id": job["id"],
                "durationSeconds": duration,
                "aligner": "mfa" if paths else "textgrid",
                "alphabet": "arpabet",
                "words": [
                    {"w": label.lower(), "start": start, "end": end}
                    for start, end, label in words
                    if label.strip() and label not in SILENCE_WORDS
                ],
                "phones": [
                    {
                        "p": "SIL" if label.strip() in SILENCE_PHONES else label.strip(),
                        "start": start,
                        "end": end,
                    }
                    for start, end, label in phones
                ],
            }
        )

    return results, problems


# ── Run ──────────────────────────────────────────────────────────────────────


def main() -> None:
    try:
        spec = json.loads(sys.stdin.read())
    except json.JSONDecodeError as error:
        fail(f"could not read the job list: {error}")

    jobs = spec.get("jobs") or []
    backend = spec.get("backend", "pocketsphinx")
    lexicon = read_lexicon(spec.get("lexicon"))

    if backend == "textgrid":
        directory = spec.get("textgridDir")
        if not directory:
            fail("backend 'textgrid' needs a textgridDir.")
        results, problems = align_textgrid(jobs, directory)
    elif backend == "mfa":
        results, problems = align_mfa(jobs, lexicon, spec)
    elif backend == "pocketsphinx":
        results, problems = align_pocketsphinx(jobs, lexicon)
    else:
        fail(f"unknown backend '{backend}'.")

    # Applied to every backend rather than inside one, because "the word was
    # silently unknown" is a way any aligner can fail and the cost of missing it
    # is the same whichever did.
    kept = []
    for result in results:
        missing = unspoken_words(result)
        if missing:
            problems.append(
                f'"{result["id"]}" — {", ".join(sorted(set(missing)))} aligned to silence, '
                "which means the aligner had no pronunciation for them. "
                "Add them to content/lexicon.txt."
            )
            continue
        kept.append(result)

    print(json.dumps({"results": kept, "problems": problems}))


if __name__ == "__main__":
    main()
