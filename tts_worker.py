#!/usr/bin/env python3
"""
JSON-lines RPC worker for the Electron app.
stdin:  {"id": "...", "cmd": "...", ...}
stdout: {"id": "...", "ok": true, "data": ...}  or  {"event": "...", ...}
stderr: logs
"""

from __future__ import annotations

import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from queue import Queue

from document_import import SUPPORTED_EXTENSIONS, extract_text
from model_manager import apply_hf_env, download_models, is_models_installed, models_status
from tts_engine import PREVIEW_SAMPLE_TEXT, SynthesisConfig, TTSEngine

apply_hf_env()

_engine = TTSEngine()
_executor = ThreadPoolExecutor(max_workers=1)
_out_lock = threading.Lock()


def _require_models() -> None:
    if not is_models_installed():
        raise RuntimeError(
            "Speech models are not installed. Download them from the setup screen first."
        )


def _emit(obj: dict) -> None:
    with _out_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def _respond(req_id: str, data: dict | None = None, *, error: str | None = None) -> None:
    msg: dict = {"id": req_id}
    if error:
        msg["ok"] = False
        msg["error"] = error
    else:
        msg["ok"] = True
        msg["data"] = data or {}
    _emit(msg)


def _run_job(
    req_id: str,
    job_id: str,
    text: str,
    output_path: str | None,
    config: SynthesisConfig,
    *,
    save_output: bool,
) -> None:
    def on_event(event: dict) -> None:
        _emit({"event": event})

    try:
        path = Path(output_path) if output_path else None
        _engine.synthesize(
            job_id,
            text,
            path,
            config,
            on_event,
            save_output=save_output,
        )
        _respond(req_id, {"jobId": job_id, "status": "finished"})
    except Exception as exc:
        _respond(req_id, error=str(exc))


def _handle(req: dict) -> None:
    req_id = req.get("id", "")
    cmd = req.get("cmd", "")

    try:
        if cmd == "ping":
            _respond(req_id, {"pong": True})

        elif cmd == "check_models":
            _respond(req_id, models_status())

        elif cmd == "download_models":
            if is_models_installed():
                _respond(req_id, {**models_status(), "status": "already_installed"})
                return

            def on_event(event: dict) -> None:
                _emit({"event": event})

            _respond(req_id, {"status": "started"})

            def run_download() -> None:
                try:
                    download_models(on_event)
                    _respond(req_id, {**models_status(), "status": "complete"})
                except Exception as exc:
                    _emit(
                        {
                            "event": {
                                "type": "model_download_error",
                                "message": str(exc),
                            }
                        }
                    )
                    _respond(req_id, error=str(exc))

            _executor.submit(run_download)

        elif cmd == "list_voices":
            _require_models()
            _engine.ensure_model(lambda e: _emit({"event": e}))
            _respond(req_id, {"voices": _engine.list_voices()})

        elif cmd == "warmup":
            _require_models()

            def on_status(event: dict) -> None:
                _emit({"event": event})

            _engine.ensure_model(on_status)
            _respond(req_id, {"ready": True, "voices": _engine.list_voices()})

        elif cmd == "get_dictionary":
            _respond(
                req_id,
                {
                    "dictionary": _engine.get_dictionary(),
                    "userDictionary": _engine.get_user_dictionary(),
                },
            )

        elif cmd == "save_dictionary":
            entries = req.get("entries") or {}
            merged = _engine.save_dictionary(entries)
            _respond(req_id, {"dictionary": merged})

        elif cmd == "extract_text":
            path = Path(req["path"])
            if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
                raise ValueError(f"Unsupported type: {path.suffix}")
            text = extract_text(path)
            _respond(req_id, {"text": text, "path": str(path)})

        elif cmd == "preview_voice":
            _require_models()
            cfg = SynthesisConfig(
                voice_id=req.get("voiceId", "Doan"),
                emotion=req.get("emotion", "storytelling"),
                max_chunk_chars=int(req.get("maxChunkChars", 350)),
            )
            sample = req.get("text") or PREVIEW_SAMPLE_TEXT

            def on_status(event: dict) -> None:
                _emit({"event": event})

            _engine.ensure_model(on_status)
            data = _engine.preview_voice(cfg.voice_id, text=sample, config=cfg)
            _respond(req_id, data)

        elif cmd == "cancel_job":
            _engine.cancel_job(req["jobId"])
            _respond(req_id, {"jobId": req["jobId"]})

        elif cmd == "set_job_playback":
            _engine.set_job_playback(
                req["jobId"],
                playing=bool(req.get("playing", False)),
                playback_chunk=req.get("playbackChunkIndex"),
            )
            _respond(req_id, {"jobId": req["jobId"]})

        elif cmd == "set_job_synth_config":
            _engine.set_job_synth_config(
                req["jobId"],
                voice_id=req.get("voiceId"),
                emotion=req.get("emotion"),
            )
            _respond(req_id, {"jobId": req["jobId"]})

        elif cmd == "start_job":
            _require_models()
            job_id = req["jobId"]
            save_output = bool(req.get("saveOutput", True))
            output_path = req.get("outputPath")
            if save_output and not output_path:
                raise ValueError("outputPath is required when saveOutput is true")
            config = SynthesisConfig(
                voice_id=req.get("voiceId", "Doan"),
                emotion=req.get("emotion", "storytelling"),
                max_chunk_chars=int(req.get("maxChunkChars", 350)),
                chunk_silence_p=float(req.get("chunkSilenceP", 0.04)),
                chunk_crossfade_p=float(req.get("chunkCrossfadeP", 0.12)),
            )
            _respond(req_id, {"jobId": job_id, "status": "queued"})
            _executor.submit(
                _run_job,
                req_id,
                job_id,
                req["text"],
                output_path,
                config,
                save_output=save_output,
            )

        else:
            _respond(req_id, error=f"Unknown command: {cmd}")

    except Exception as exc:
        _respond(req_id, error=str(exc))


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            _emit({"ok": False, "error": f"Invalid JSON: {exc}"})
            continue
        threading.Thread(target=_handle, args=(req,), daemon=True).start()


if __name__ == "__main__":
    main()
