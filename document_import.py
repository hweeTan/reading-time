"""Extract plain text from supported document formats."""

from __future__ import annotations

from pathlib import Path

from text_prep import strip_unwanted_characters

SUPPORTED_EXTENSIONS = {".txt", ".md", ".docx", ".pdf"}


def extract_text(path: Path) -> str:
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix in (".txt", ".md"):
        raw = path.read_text(encoding="utf-8").strip()
    elif suffix == ".docx":
        raw = _extract_docx(path)
    elif suffix == ".pdf":
        raw = _extract_pdf(path)
    else:
        raise ValueError(f"Unsupported file type: {suffix}. Use txt, md, docx, or pdf.")
    return strip_unwanted_characters(raw)


def _extract_docx(path: Path) -> str:
    try:
        from docx import Document
    except ImportError as exc:
        raise ImportError("Install python-docx: pip install python-docx") from exc

    doc = Document(str(path))
    parts = [p.text.strip() for p in doc.paragraphs if p.text.strip()]
    return "\n\n".join(parts).strip()


def _extract_pdf(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise ImportError("Install pypdf: pip install pypdf") from exc

    reader = PdfReader(str(path))
    parts: list[str] = []
    for page in reader.pages:
        text = page.extract_text()
        if text and text.strip():
            parts.append(text.strip())
    return "\n\n".join(parts).strip()
