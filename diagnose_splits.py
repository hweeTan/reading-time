#!/usr/bin/env python3
"""
Compare text-prep chunks vs VieNeu splitting and detect model audio truncation.

Usage:
  python diagnose_splits.py [path/to/text.txt]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from index import (
    MAX_CHUNK_CHARS,
    VOICE_ID,
    _normalize_chunk,
    _prepared_source,
    _resolve_voice,
    create_tts,
)
from text_prep import apply_speak_dictionary, split_for_synthesis, verify_text_coverage


def vieneu_chunks(text: str, max_chars: int) -> list[str]:
    from vieneu_utils.core_utils import split_text_into_chunks

    return split_text_into_chunks(text, max_chars=max_chars)


def ms_per_char_baseline(tts, voice, sample_chars: int = 120) -> float:
    """Estimate healthy ms/char from a short chunk."""
    sample = "Đây là câu thử nghiệm để đo tốc độ đọc của mô hình. " * 3
    sample = sample[:sample_chars]
    norm = _normalize_chunk(tts, sample)
    audio = tts.infer(
        norm,
        voice=voice,
        max_chars=len(norm) + 64,
        skip_normalize=True,
        silence_p=0.0,
        crossfade_p=0.0,
    )
    return (len(audio) / tts.sample_rate) * 1000 / max(len(norm), 1)


def diagnose(text_path: Path, *, max_chars: int, run_model: bool) -> int:
    raw = text_path.read_text(encoding="utf-8").strip()
    prepared = _prepared_source(raw)

    ours = split_for_synthesis(prepared, max_chars)
    theirs = vieneu_chunks(prepared, max_chars)

    print(f"File: {text_path} ({len(raw)} chars raw, {len(prepared)} after dictionary)")
    print(f"MAX_CHUNK_CHARS={max_chars}\n")

    print("=== Text prep (ours) ===")
    print(f"  chunks: {len(ours)}")
    for w in verify_text_coverage(prepared, ours):
        print(f"  WARNING: {w}")
    print(f"  min/avg/max len: {min(map(len, ours))}/{sum(map(len, ours)) // len(ours)}/{max(map(len, ours))}")

    print("\n=== VieNeu split_text_into_chunks ===")
    print(f"  chunks: {len(theirs)}")
    print(
        f"  min/avg/max len: {min(map(len, theirs))}/{sum(map(len, theirs)) // len(theirs)}/{max(map(len, theirs))}"
    )

    if len(ours) != len(theirs):
        print(f"\n  Chunk count differs by {abs(len(ours) - len(theirs))}")

    # Compare first divergence
    for i, (a, b) in enumerate(zip(ours, theirs), start=1):
        if a != b:
            print(f"\n  First differing chunk #{i}:")
            print(f"    ours ({len(a)}): {a[:100]}...")
            print(f"    vieneu ({len(b)}): {b[:100]}...")
            break
    else:
        if len(ours) == len(theirs):
            print("\n  All chunk texts match VieNeu splitter (on pre-normalized source).")

    if not run_model:
        print("\n(Pass --model to load VieNeu and check per-chunk audio truncation.)")
        return 0

    print("\n=== Model synthesis check ===")
    print("Loading VieNeu-TTS-v2...")
    tts = create_tts()
    voice = _resolve_voice(tts)
    baseline_ms = ms_per_char_baseline(tts, voice)
    print(f"Baseline ~{baseline_ms:.1f} ms/char (short reference chunk)\n")

    issues: list[str] = []
    print(f"{'#':>4} {'chars':>5} {'audio_s':>8} {'ms/ch':>7} {'ratio':>6}  note")
    print("-" * 60)

    for i, chunk in enumerate(ours, start=1):
        norm = _normalize_chunk(tts, chunk)
        try:
            audio = tts.infer(
                norm,
                voice=voice,
                max_chars=len(norm) + 64,
                skip_normalize=True,
                silence_p=0.0,
                crossfade_p=0.0,
            )
        except Exception as exc:
            print(f"{i:4d} {len(norm):5d}   ERROR  {exc}")
            issues.append(f"chunk {i}: infer failed: {exc}")
            continue

        audio_s = len(audio) / tts.sample_rate
        ms_ch = (audio_s * 1000) / max(len(norm), 1)
        ratio = ms_ch / baseline_ms if baseline_ms else 1.0

        note = ""
        if ratio < 0.65:
            note = "TRUNCATED? (model context limit)"
            issues.append(
                f"chunk {i}: {len(norm)} chars, {audio_s:.1f}s audio, "
                f"ratio={ratio:.2f} — likely model cut off speech"
            )
        elif ratio < 0.85:
            note = "short audio"
            issues.append(
                f"chunk {i}: ratio={ratio:.2f} — possibly partial synthesis"
            )

        print(f"{i:4d} {len(norm):5d} {audio_s:8.1f} {ms_ch:7.1f} {ratio:6.2f}  {note}")

    print()
    if issues:
        print(f"Found {len(issues)} potential model-side issue(s):")
        for line in issues:
            print(f"  - {line}")
        print(
            "\nIf many chunks show TRUNCATED, lower MAX_CHUNK_CHARS (e.g. 300–350)."
        )
        return 1

    print("No obvious model truncation detected vs baseline.")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "text_file",
        nargs="?",
        type=Path,
        default=Path(__file__).parent / "article2.txt",
    )
    parser.add_argument(
        "--max-chars",
        type=int,
        default=MAX_CHUNK_CHARS,
        help=f"Chunk size (default {MAX_CHUNK_CHARS})",
    )
    parser.add_argument(
        "--model",
        action="store_true",
        help="Load VieNeu and measure audio duration per chunk",
    )
    args = parser.parse_args()
    if not args.text_file.is_file():
        print(f"File not found: {args.text_file}", file=sys.stderr)
        sys.exit(2)
    sys.exit(diagnose(args.text_file, max_chars=args.max_chars, run_model=args.model))


if __name__ == "__main__":
    main()
