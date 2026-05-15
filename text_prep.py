"""Text normalization and chunking for TTS (sentence/paragraph boundaries)."""

from __future__ import annotations

import json
import re
from pathlib import Path

# Longest keys first when applying replacements.
SPEAK_REPLACEMENTS: dict[str, str] = {
    "GS": "giáo sư",
    "gs": "giáo sư",
    "3///": "ba que",
    "///": "ba que",
    "facebook": "phây búc",
    "Facebook": "Phây búc",
    "→": ", ",
    "…": ".",
    "😂": "cười",
    "🤣": "cười",
    "😭": "khóc",
    "❤️": "trái tim",
    "❤": "trái tim",
    "👍": "tán thành",
    "🙏": "cảm ơn",
    "🔥": "cháy",
    "💯": "trăm điểm",
    "😀": "cười",
    "😁": "cười",
    "😅": "cười",
    "🥲": "cười mếu",
    "😡": "tức giận",
    "🤬": "chửi thề",
    "💀": "chết",
    "🤡": "thằng hề",
    "@": "a còng",
    "#": "thăng",
    "&": "và",
}

_DICTIONARY_PATH = Path(__file__).resolve().parent / "speak_dictionary.json"

RE_PARAGRAPH = re.compile(
    r"(?:\n\s*\n+|\s+•\s+•\s+•\s+|\s+—\s+(?=[‘'\"«]))"
)
RE_SENTENCE = re.compile(r"(?<=[.!?…])\s+")
RE_CLAUSE = re.compile(r"(?<=[,;:])\s+")
# "2. Title" / "tác giả1. Chủ" — protect before sentence split (normalizer turns "2." → "hai.")
RE_NUMBERED_LIST_SPACE = re.compile(r"(^|\s)(\d{1,3})\.\s+")
RE_NUMBERED_LIST_TIGHT = re.compile(r"([a-zA-Zà-ỹÀ-Ỹ])(\d{1,3})\.\s+")
# Orphan sentence after normalizer: "hai." "một." from broken list splits
RE_ORPHAN_NUM_SENTENCE = re.compile(
    r"^(một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười|\d+)\.?$",
    re.IGNORECASE,
)


def load_user_dictionary() -> dict[str, str]:
    if not _DICTIONARY_PATH.is_file():
        return {}
    extra = json.loads(_DICTIONARY_PATH.read_text(encoding="utf-8"))
    if not isinstance(extra, dict):
        raise ValueError(f"{_DICTIONARY_PATH} must be a JSON object")
    return {str(k): str(v) for k, v in extra.items()}


def load_speak_dictionary() -> dict[str, str]:
    merged = dict(SPEAK_REPLACEMENTS)
    merged.update(load_user_dictionary())
    return merged


def save_user_dictionary(entries: dict[str, str]) -> None:
    """Persist user overrides (built-in SPEAK_REPLACEMENTS are not written)."""
    cleaned = {str(k): str(v) for k, v in entries.items() if k and v is not None}
    _DICTIONARY_PATH.write_text(
        json.dumps(cleaned, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def apply_speak_dictionary(text: str, replacements: dict[str, str] | None = None) -> str:
    table = replacements or load_speak_dictionary()
    for src in sorted(table, key=len, reverse=True):
        text = text.replace(src, table[src])
    return text


def lowercase_all_caps(text: str, *, min_letters: int = 2) -> str:
    """
    Lowercase words written in all caps so the VieNeu normalizer does not
    treat them as abbreviations (e.g. NHỮNG → những, not letter-by-letter).
    Mixed-case tokens (Việt Nam, Phây búc) are left unchanged.
    """

    def repl(match: re.Match[str]) -> str:
        token = match.group(0)
        letters = [c for c in token if c.isalpha()]
        if len(letters) < min_letters:
            return token
        if all(c.isupper() for c in letters):
            return token.lower()
        return token

    return re.sub(r"[^\W\d_]+", repl, text, flags=re.UNICODE)


def strip_unwanted_characters(text: str) -> str:
    """Remove characters that should not be spoken (e.g. layout markers)."""
    return text.replace("\u25a0", "")  # ■ BLACK SQUARE


def prepare_source_text(text: str) -> str:
    """Strip artifacts, speak dictionary, decapitalize all-caps (before chunking)."""
    cleaned = strip_unwanted_characters(text)
    return lowercase_all_caps(apply_speak_dictionary(cleaned))


def _protect_numbered_lists(text: str) -> str:
    """Use (n) instead of n. so sentence splitter and normalizer stay aligned."""

    def repl_tight(m: re.Match[str]) -> str:
        return f"{m.group(1)} ({m.group(2)}) "

    def repl_space(m: re.Match[str]) -> str:
        prefix = m.group(1)
        return f"{prefix}({m.group(2)}) "

    text = RE_NUMBERED_LIST_SPACE.sub(repl_space, text)
    text = RE_NUMBERED_LIST_TIGHT.sub(repl_tight, text)
    return text


def _split_paragraphs(text: str) -> list[str]:
    parts = [p.strip() for p in RE_PARAGRAPH.split(text.strip()) if p.strip()]
    return parts or [text.strip()]


def _split_sentences(paragraph: str) -> list[str]:
    protected = _protect_numbered_lists(paragraph)
    parts = [s.strip() for s in RE_SENTENCE.split(protected) if s.strip()]
    return parts or [protected.strip()]


def _coalesce_orphan_units(units: list[str]) -> list[str]:
    """Merge 'hai.' / '2.' fragments into the following sentence."""
    if not units:
        return units

    merged: list[str] = []
    pending = ""

    for unit in units:
        unit = unit.strip()
        if not unit:
            continue
        if RE_ORPHAN_NUM_SENTENCE.fullmatch(unit) or unit == ".":
            pending = f"{pending} {unit}".strip() if pending else unit
            continue
        if pending:
            unit = f"{pending} {unit}".strip()
            pending = ""
        merged.append(unit)

    if pending and merged:
        merged[-1] = f"{merged[-1]} {pending}".strip()
    elif pending:
        merged.append(pending)

    return merged


def _split_clauses(sentence: str) -> list[str]:
    parts = [c.strip() for c in RE_CLAUSE.split(sentence.strip()) if c.strip()]
    return parts or [sentence.strip()]


def _split_words(fragment: str, max_chars: int) -> list[str]:
    words = fragment.split()
    if not words:
        return []
    chunks: list[str] = []
    current = words[0]
    for word in words[1:]:
        if len(current) + 1 + len(word) <= max_chars:
            current = f"{current} {word}"
        else:
            chunks.append(current)
            current = word
    chunks.append(current)
    return chunks


def _split_oversized(unit: str, max_chars: int) -> list[str]:
    unit = unit.strip()
    if len(unit) <= max_chars:
        return [unit] if unit else []

    clauses = _split_clauses(unit)
    if len(clauses) > 1:
        out: list[str] = []
        for part in clauses:
            out.extend(_split_oversized(part, max_chars) if len(part) > max_chars else [part])
        return out

    words = _split_words(unit, max_chars)
    if len(words) > 1:
        return words

    # Hard split long token; never drop trailing text.
    out: list[str] = []
    while len(unit) > max_chars:
        out.append(unit[:max_chars])
        unit = unit[max_chars:].strip()
    if unit:
        out.append(unit)
    return out


def _merge_units(units: list[str], max_chars: int) -> list[str]:
    chunks: list[str] = []
    buffer = ""

    for unit in units:
        unit = unit.strip()
        if not unit:
            continue

        if len(unit) > max_chars:
            if buffer:
                chunks.append(buffer)
                buffer = ""
            chunks.extend(_split_oversized(unit, max_chars))
            continue

        if buffer and len(buffer) + 1 + len(unit) > max_chars:
            chunks.append(buffer)
            buffer = unit
        else:
            buffer = f"{buffer} {unit}".strip() if buffer else unit

    if buffer:
        chunks.append(buffer)
    return chunks


def split_for_synthesis(text: str, max_chars: int) -> list[str]:
    """
    Split on paragraph/sentence boundaries before VieNeu normalization.
    Normalizer must run per chunk (see prepare_chunk_for_tts).
    """
    if not text or not text.strip():
        return []

    paragraphs = _split_paragraphs(text)
    units: list[str] = []
    for para in paragraphs:
        units.extend(_split_sentences(para))

    units = _coalesce_orphan_units(units)
    return _merge_units(units, max_chars)


def prepare_chunk_for_tts(chunk: str, normalizer) -> str:
    """Normalize one chunk after structural splitting."""
    return normalizer.normalize(chunk)


def verify_text_coverage(source: str, chunks: list[str]) -> list[str]:
    """Return warnings if chunk text does not preserve source content."""
    warnings: list[str] = []

    def compact(t: str) -> str:
        return re.sub(r"\s+", " ", t).strip()

    joined = compact(" ".join(chunks))
    src = compact(source)

    if len(joined) < len(src) * 0.98:
        warnings.append(
            f"Chunk text shorter than source ({len(joined)} vs {len(src)} chars); "
            "content may be missing."
        )

    tiny = [c for c in chunks if len(c.strip()) < 8]
    if tiny:
        warnings.append(
            f"{len(tiny)} very short chunk(s), e.g. {tiny[0][:40]!r} — check list/period splits."
        )

    return warnings
