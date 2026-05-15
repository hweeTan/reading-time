"""Download and verify VieNeu TTS model files (Hugging Face Hub cache)."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Callable

BACKBONE_REPO = os.getenv("VIENEU_MODEL", "pnnbao-ump/VieNeu-TTS-v2")
CODEC_REPO = os.getenv("VIENEU_CODEC", "neuphonic/neucodec-onnx-decoder-int8")
MANIFEST_NAME = "models-installed.json"

EventCallback = Callable[[dict[str, Any]], None]


def models_root() -> Path:
    home = os.getenv("TTS_MODELS_HOME")
    if home:
        return Path(home)
    return Path.home() / ".vieneu-tts" / "models"


def hub_cache() -> Path:
    return models_root() / "hub"


def manifest_path() -> Path:
    return models_root() / MANIFEST_NAME


def _repo_cache_dir(repo_id: str) -> Path:
    return hub_cache() / ("models--" + repo_id.replace("/", "--"))


def clear_hf_offline_env() -> None:
    """Ensure Hub clients can reach the network when needed (download, metadata)."""
    os.environ.pop("HF_HUB_OFFLINE", None)
    os.environ.pop("TRANSFORMERS_OFFLINE", None)


def apply_hf_env() -> None:
    """Point Hugging Face at app model storage."""
    root = models_root()
    root.mkdir(parents=True, exist_ok=True)
    cache = hub_cache()
    cache.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HOME"] = str(root)
    os.environ["HUGGINGFACE_HUB_CACHE"] = str(cache)
    # Do not set HF_HUB_OFFLINE: llama-cpp and Vieneu still query Hub metadata
    # even when weights are cached locally; offline mode breaks that with a hard error.
    clear_hf_offline_env()


def _backbone_ready() -> bool:
    repo_dir = _repo_cache_dir(BACKBONE_REPO)
    if not repo_dir.is_dir():
        return False
    has_gguf = any(repo_dir.rglob("*.gguf"))
    has_voices = any(repo_dir.rglob("voices.json"))
    return has_gguf and has_voices


def _codec_ready() -> bool:
    repo_dir = _repo_cache_dir(CODEC_REPO)
    if not repo_dir.is_dir():
        return False
    return any(repo_dir.rglob("*.onnx")) or any(repo_dir.rglob("*.json"))


def is_models_installed() -> bool:
    ready = _backbone_ready() and _codec_ready()
    if ready:
        return True
    mp = manifest_path()
    if mp.is_file():
        try:
            mp.unlink()
        except OSError:
            pass
    return False


def models_status() -> dict[str, Any]:
    root = models_root()
    return {
        "installed": is_models_installed(),
        "path": str(root),
        "hubPath": str(hub_cache()),
        "backboneRepo": BACKBONE_REPO,
        "codecRepo": CODEC_REPO,
        "backboneReady": _backbone_ready(),
        "codecReady": _codec_ready(),
    }


def _write_manifest() -> None:
    manifest_path().write_text(
        json.dumps(
            {
                "ok": True,
                "backbone": BACKBONE_REPO,
                "codec": CODEC_REPO,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def download_models(on_event: EventCallback | None = None) -> None:
    """Download backbone + codec into the app hub cache."""

    def emit(event: dict[str, Any]) -> None:
        if on_event:
            on_event(event)

    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:
        raise ImportError(
            "huggingface_hub is required for model download. "
            "Install with: pip install huggingface_hub"
        ) from exc

    apply_hf_env()
    clear_hf_offline_env()

    cache = hub_cache()
    phases = [
        ("backbone", BACKBONE_REPO),
        ("codec", CODEC_REPO),
    ]

    emit(
        {
            "type": "model_download_started",
            "totalPhases": len(phases),
            "path": str(models_root()),
        }
    )

    for index, (phase, repo_id) in enumerate(phases):
        emit(
            {
                "type": "model_download_phase",
                "phase": phase,
                "repo": repo_id,
                "phaseIndex": index,
                "totalPhases": len(phases),
            }
        )
        snapshot_download(
            repo_id=repo_id,
            cache_dir=str(cache),
            local_files_only=False,
        )
        emit(
            {
                "type": "model_download_progress",
                "phase": phase,
                "percent": (index + 1) / len(phases),
                "message": f"Finished {phase}",
            }
        )

    if not (_backbone_ready() and _codec_ready()):
        raise RuntimeError(
            "Download finished but model files are missing. Check your connection and try again."
        )

    _write_manifest()
    apply_hf_env()
    emit({"type": "model_download_complete", "path": str(models_root())})
