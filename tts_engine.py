"""VieNeu TTS engine for CLI and Electron worker."""

from __future__ import annotations

import base64
import io
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import numpy as np

from text_prep import (
    load_speak_dictionary,
    load_user_dictionary,
    prepare_chunk_for_tts,
    prepare_source_text,
    save_user_dictionary,
    split_for_synthesis,
    verify_text_coverage,
)

PROJECT_ROOT = Path(__file__).resolve().parent

MODEL_REPO = os.getenv("VIENEU_MODEL", "pnnbao-ump/VieNeu-TTS-v2")
EMOTION = os.getenv("VIENEU_EMOTION", "storytelling")
DEFAULT_VOICE_ID = os.getenv("VIENEU_VOICE", "Doan")
BACKBONE_DEVICE = os.getenv("VIENEU_DEVICE", "cpu")
MAX_CHUNK_CHARS = int(os.getenv("MAX_CHUNK_CHARS", "350"))
CHUNK_SILENCE_P = float(os.getenv("CHUNK_SILENCE_P", "0.04"))
CHUNK_CROSSFADE_P = float(os.getenv("CHUNK_CROSSFADE_P", "0.12"))
PREVIEW_SAMPLE_TEXT = (
    "Xin chào. Đây là giọng đọc mẫu để bạn nghe thử trước khi tạo file âm thanh."
)


@dataclass
class SynthesisConfig:
    voice_id: str = DEFAULT_VOICE_ID
    emotion: str = EMOTION
    max_chunk_chars: int = MAX_CHUNK_CHARS
    chunk_silence_p: float = CHUNK_SILENCE_P
    chunk_crossfade_p: float = CHUNK_CROSSFADE_P


STREAM_LOOKAHEAD_CHUNKS = 4


def emotion_to_tag(emotion: str) -> str | None:
    """Map UI emotion id to VieNeu emotion_tag (see vieneu.standard.VieNeuTTS)."""
    return "<|emotion_0|>" if emotion == "natural" else None


@dataclass
class JobState:
    job_id: str
    voice_id: str = DEFAULT_VOICE_ID
    emotion: str = EMOTION
    cancel: threading.Event = field(default_factory=threading.Event)
    throttled: bool = False
    paused: bool = False
    playback_chunk: int = 1
    regenerate_from: int | None = None
    lookahead: int = STREAM_LOOKAHEAD_CHUNKS
    _wake: threading.Condition = field(default_factory=threading.Condition)

    def set_playback(
        self, *, playing: bool, playback_chunk: int | None = None
    ) -> None:
        with self._wake:
            self.paused = not playing
            if playback_chunk is not None:
                self.playback_chunk = max(1, int(playback_chunk))
            self._wake.notify_all()

    def wait_for_chunk(self, chunk_index: int) -> bool:
        """Block until chunk_index may be synthesized, or cancel."""
        with self._wake:
            while True:
                if self.cancel.is_set():
                    return False
                if not self.throttled:
                    return True
                if not self.paused and chunk_index <= self.playback_chunk + self.lookahead:
                    return True
                self._wake.wait(timeout=0.25)


EventCallback = Callable[[dict[str, Any]], None]


class TTSEngine:
    def __init__(self) -> None:
        self._tts = None
        self._model_lock = threading.Lock()
        self._jobs: dict[str, JobState] = {}

    def ensure_model(self, on_status: EventCallback | None = None) -> None:
        if self._tts is not None:
            return
        with self._model_lock:
            if self._tts is not None:
                return
            if on_status:
                on_status({"type": "model_loading"})
            from vieneu import Vieneu

            self._tts = Vieneu(
                mode="standard",
                backbone_repo=MODEL_REPO,
                backbone_device=BACKBONE_DEVICE,
                emotion=EMOTION,
            )
            if on_status:
                on_status({"type": "model_ready"})

    def list_voices(self) -> list[dict[str, str]]:
        self.ensure_model()
        assert self._tts is not None
        return [
            {"id": vid, "description": desc}
            for desc, vid in self._tts.list_preset_voices()
        ]

    def get_dictionary(self) -> dict[str, str]:
        return load_speak_dictionary()

    def get_user_dictionary(self) -> dict[str, str]:
        return load_user_dictionary()

    def save_dictionary(self, user_entries: dict[str, str]) -> dict[str, str]:
        save_user_dictionary(user_entries)
        return load_speak_dictionary()

    def _resolve_voice(self, voice_id: str):
        self.ensure_model()
        assert self._tts is not None
        voices = self._tts.list_preset_voices()
        ids = {vid for _, vid in voices}
        if voice_id not in ids:
            available = ", ".join(vid for _, vid in voices)
            raise ValueError(f"Unknown voice '{voice_id}'. Available: {available}")
        return self._tts.get_preset_voice(voice_id)

    def _text_chunks(self, text: str, max_chars: int) -> tuple[list[str], list[str]]:
        source = prepare_source_text(text)
        chunks = split_for_synthesis(source, max_chars)
        warnings = verify_text_coverage(source, chunks)
        return chunks, warnings

    def _wav_to_b64(self, samples: np.ndarray, sample_rate: int) -> str:
        import soundfile as sf

        buf = io.BytesIO()
        sf.write(buf, np.asarray(samples, dtype=np.float32), sample_rate, format="WAV")
        return base64.b64encode(buf.getvalue()).decode("ascii")

    def preview_voice(
        self,
        voice_id: str,
        *,
        text: str | None = None,
        config: SynthesisConfig | None = None,
    ) -> dict[str, Any]:
        cfg = config or SynthesisConfig(voice_id=voice_id)
        self.ensure_model()
        voice = self._resolve_voice(cfg.voice_id)
        sample = text or PREVIEW_SAMPLE_TEXT
        chunk_kw = {
            "voice": voice,
            "max_chars": cfg.max_chunk_chars + 64,
            "skip_normalize": True,
            "silence_p": 0.0,
            "crossfade_p": 0.0,
        }
        assert self._tts is not None
        wav = np.asarray(
            self._tts.infer(
                prepare_chunk_for_tts(sample, self._tts.normalizer),
                **chunk_kw,
            ),
            dtype=np.float32,
        )
        return {
            "sampleRate": self._tts.sample_rate,
            "duration": len(wav) / self._tts.sample_rate,
            "audioWavBase64": self._wav_to_b64(wav, self._tts.sample_rate),
        }

    def cancel_job(self, job_id: str) -> None:
        job = self._jobs.get(job_id)
        if job:
            job.cancel.set()
            with job._wake:
                job._wake.notify_all()

    def set_job_playback(
        self,
        job_id: str,
        *,
        playing: bool,
        playback_chunk: int | None = None,
    ) -> None:
        job = self._jobs.get(job_id)
        if not job or not job.throttled:
            return
        job.set_playback(playing=playing, playback_chunk=playback_chunk)

    def set_job_synth_config(
        self,
        job_id: str,
        *,
        voice_id: str | None = None,
        emotion: str | None = None,
    ) -> None:
        job = self._jobs.get(job_id)
        if not job:
            return
        with job._wake:
            changed = False
            if voice_id is not None and voice_id != job.voice_id:
                job.voice_id = voice_id
                changed = True
            if emotion is not None and emotion != job.emotion:
                job.emotion = emotion
                changed = True
            if changed and job.throttled:
                job.regenerate_from = job.playback_chunk
            job._wake.notify_all()

    def _consume_regenerate(
        self,
        job: JobState,
        *,
        chunk_wavs: list[np.ndarray],
        sample_rate: int,
        on_event: EventCallback,
        job_id: str,
    ) -> tuple[list[np.ndarray], float, int | None]:
        """Truncate synthesized audio and return chunk index to re-synthesize."""
        with job._wake:
            from_idx = job.regenerate_from
            if from_idx is None:
                total = sum(len(w) / sample_rate for w in chunk_wavs)
                return chunk_wavs, total, None
            job.regenerate_from = None
        from_idx = max(1, int(from_idx))
        keep = from_idx - 1
        chunk_wavs = chunk_wavs[:keep]
        total = sum(len(w) / sample_rate for w in chunk_wavs)
        on_event(
            {
                "type": "chunks_truncated",
                "jobId": job_id,
                "fromChunkIndex": from_idx,
                "totalDuration": total,
            }
        )
        return chunk_wavs, total, from_idx

    def synthesize(
        self,
        job_id: str,
        text: str,
        output_path: Path | None,
        config: SynthesisConfig,
        on_event: EventCallback,
        *,
        save_output: bool = True,
    ) -> None:
        job = JobState(
            job_id=job_id,
            voice_id=config.voice_id,
            emotion=config.emotion,
            throttled=not save_output,
            paused=not save_output,
        )
        self._jobs[job_id] = job

        try:
            self.ensure_model(lambda e: on_event({**e, "jobId": job_id}))
            assert self._tts is not None
            text_chunks, warnings = self._text_chunks(text, config.max_chunk_chars)
            for w in warnings:
                on_event({"type": "warning", "jobId": job_id, "message": w})

            on_event(
                {
                    "type": "job_started",
                    "jobId": job_id,
                    "totalChunks": len(text_chunks),
                    "charCount": len(text),
                }
            )

            chunk_kw_base = {
                "max_chars": config.max_chunk_chars + 64,
                "skip_normalize": True,
                "silence_p": 0.0,
                "crossfade_p": 0.0,
            }
            chunk_wavs: list[np.ndarray] = []
            total_duration = 0.0
            sample_rate = self._tts.sample_rate
            idx = 1

            while idx <= len(text_chunks):
                chunk_wavs, total_duration, regen_idx = self._consume_regenerate(
                    job,
                    chunk_wavs=chunk_wavs,
                    sample_rate=sample_rate,
                    on_event=on_event,
                    job_id=job_id,
                )
                if regen_idx is not None:
                    idx = regen_idx
                    continue

                if not job.wait_for_chunk(idx):
                    on_event({"type": "job_cancelled", "jobId": job_id})
                    return

                chunk_wavs, total_duration, regen_idx = self._consume_regenerate(
                    job,
                    chunk_wavs=chunk_wavs,
                    sample_rate=sample_rate,
                    on_event=on_event,
                    job_id=job_id,
                )
                if regen_idx is not None:
                    idx = regen_idx
                    continue

                chunk_text = text_chunks[idx - 1]

                with job._wake:
                    voice_id = job.voice_id
                    emotion = job.emotion

                on_event(
                    {
                        "type": "chunk_started",
                        "jobId": job_id,
                        "chunkIndex": idx,
                        "totalChunks": len(text_chunks),
                        "charCount": len(chunk_text),
                        "voiceId": voice_id,
                        "emotion": emotion,
                    }
                )

                try:
                    voice = self._resolve_voice(voice_id)
                    wav = np.asarray(
                        self._tts.infer(
                            prepare_chunk_for_tts(chunk_text, self._tts.normalizer),
                            voice=voice,
                            emotion_tag=emotion_to_tag(emotion),
                            **chunk_kw_base,
                        ),
                        dtype=np.float32,
                    )
                except Exception as exc:
                    raise RuntimeError(
                        f"Chunk {idx}/{len(text_chunks)} failed: {exc}"
                    ) from exc

                with job._wake:
                    from_idx = job.regenerate_from
                    if from_idx is not None:
                        from_idx = max(1, int(from_idx))
                        job.regenerate_from = None
                        if from_idx <= idx:
                            chunk_wavs = chunk_wavs[: from_idx - 1]
                            total_duration = sum(
                                len(w) / sample_rate for w in chunk_wavs
                            )
                            on_event(
                                {
                                    "type": "chunks_truncated",
                                    "jobId": job_id,
                                    "fromChunkIndex": from_idx,
                                    "totalDuration": total_duration,
                                }
                            )
                            idx = from_idx
                            continue

                chunk_wavs.append(wav)
                chunk_seconds = len(wav) / sample_rate
                total_duration += chunk_seconds

                on_event(
                    {
                        "type": "chunk_audio",
                        "jobId": job_id,
                        "chunkIndex": idx,
                        "totalChunks": len(text_chunks),
                        "duration": chunk_seconds,
                        "totalDuration": total_duration,
                        "sampleRate": sample_rate,
                        "audioWavBase64": self._wav_to_b64(wav, sample_rate),
                    }
                )

                on_event(
                    {
                        "type": "chunk_done",
                        "jobId": job_id,
                        "chunkIndex": idx,
                        "totalChunks": len(text_chunks),
                        "duration": chunk_seconds,
                        "totalDuration": total_duration,
                    }
                )
                idx += 1

            if job.cancel.is_set():
                on_event({"type": "job_cancelled", "jobId": job_id})
                return

            if not chunk_wavs:
                raise ValueError("No audio generated (empty text?)")

            complete: dict[str, Any] = {
                "type": "job_complete",
                "jobId": job_id,
                "duration": total_duration,
            }
            if save_output:
                from vieneu_utils.core_utils import join_audio_chunks

                final_wav = join_audio_chunks(
                    chunk_wavs,
                    self._tts.sample_rate,
                    config.chunk_silence_p,
                    config.chunk_crossfade_p,
                )
                if output_path is None:
                    raise ValueError("output_path is required when save_output=True")
                output_path = Path(output_path)
                output_path.parent.mkdir(parents=True, exist_ok=True)
                self._tts.save(final_wav, str(output_path))
                complete["outputPath"] = str(output_path)

            on_event(complete)
        except Exception as exc:
            on_event(
                {
                    "type": "job_error",
                    "jobId": job_id,
                    "message": str(exc),
                }
            )
            raise
        finally:
            self._jobs.pop(job_id, None)
