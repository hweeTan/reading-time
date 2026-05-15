import argparse
import os
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import numpy as np

from text_prep import (
    prepare_chunk_for_tts,
    prepare_source_text,
    split_for_synthesis,
    verify_text_coverage,
)

# VieNeu-TTS-v2: https://huggingface.co/pnnbao-ump/VieNeu-TTS-v2
MODEL_REPO = os.getenv("VIENEU_MODEL", "pnnbao-ump/VieNeu-TTS-v2")
EMOTION = os.getenv("VIENEU_EMOTION", "storytelling")  # storytelling | natural
VOICE_ID = os.getenv("VIENEU_VOICE", "Doan")
# GGUF uses llama-cpp (Metal via n_gpu_layers); "mps" here only triggers a torch import.
BACKBONE_DEVICE = os.getenv("VIENEU_DEVICE", "cpu")
# GGUF n_ctx=2048; >~400 chars/chunk often truncates generated speech at the end.
MAX_CHUNK_CHARS = int(os.getenv("MAX_CHUNK_CHARS", "350"))
CHUNK_SILENCE_P = float(os.getenv("CHUNK_SILENCE_P", "0.04"))
CHUNK_CROSSFADE_P = float(os.getenv("CHUNK_CROSSFADE_P", "0.12"))
SILENT_MODE = os.getenv("SILENT", os.getenv("SILENT_MODE", "0")).lower() in (
    "1",
    "true",
    "yes",
)
STREAM_PLAYBACK = os.getenv("STREAM_PLAYBACK", "1").lower() not in ("0", "false", "no")
PLAYBACK_START_SECONDS = float(os.getenv("PLAYBACK_START_SECONDS", "60"))

TEXT_FILE = Path(__file__).resolve().parent / "article2.txt"
OUTPUT_PATH = Path(__file__).resolve().parent / "output.wav"
SAMPLE_RATE = 24_000


def create_tts():
    from vieneu import Vieneu

    return Vieneu(
        mode="standard",
        backbone_repo=MODEL_REPO,
        backbone_device=BACKBONE_DEVICE,
        emotion=EMOTION,
    )


def _runtime_label(tts) -> str:
    voices = tts.list_preset_voices()
    voice_desc = next((d for d, vid in voices if vid == VOICE_ID), VOICE_ID)
    return (
        f"VieNeu-TTS-v2 | voice={VOICE_ID} ({voice_desc}) | "
        f"emotion={EMOTION} | device={BACKBONE_DEVICE} | "
        f"chunk≤{MAX_CHUNK_CHARS} chars"
    )


def _mono_samples(wav: np.ndarray) -> np.ndarray:
    return np.asarray(wav, dtype=np.float32).reshape(-1)


_afplay_lock = threading.Lock()
_afplay_process: subprocess.Popen[bytes] | None = None
_active_playback: "StreamPlayback | None" = None


def stop_audio_output() -> None:
    global _afplay_process

    with _afplay_lock:
        proc = _afplay_process
        _afplay_process = None
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()

    try:
        import sounddevice as sd

        sd.stop()
    except ImportError:
        pass


def _play_segment(
    samples: np.ndarray,
    sample_rate: int,
    stop_event: threading.Event,
) -> bool:
    if stop_event.is_set():
        return False

    samples = _mono_samples(samples)
    try:
        import sounddevice as sd

        sd.play(samples, sample_rate, blocking=False)
        while True:
            if stop_event.is_set():
                sd.stop()
                return False
            stream = sd.get_stream()
            if stream is None or not stream.active:
                break
            time.sleep(0.05)
        return not stop_event.is_set()
    except ImportError:
        pass

    import soundfile as sf

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        path = Path(tmp.name)
    try:
        sf.write(str(path), samples, sample_rate)
        if sys.platform != "darwin":
            raise RuntimeError(
                "Install sounddevice for playback: pip install sounddevice"
            )

        global _afplay_process
        with _afplay_lock:
            if stop_event.is_set():
                return False
            _afplay_process = subprocess.Popen(["afplay", str(path)])
            proc = _afplay_process

        while proc.poll() is None:
            if stop_event.is_set():
                stop_audio_output()
                return False
            time.sleep(0.05)

        with _afplay_lock:
            if _afplay_process is proc:
                _afplay_process = None
        return not stop_event.is_set()
    finally:
        path.unlink(missing_ok=True)


class StreamPlayback:
    def __init__(self, sample_rate: int, playback_start_seconds: float) -> None:
        self.sample_rate = sample_rate
        self.playback_start_seconds = playback_start_seconds
        self.stop_event = threading.Event()
        self.playback_started = threading.Event()
        self.queue: queue.Queue[np.ndarray | None] = queue.Queue()
        self.errors: list[BaseException] = []
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        global _active_playback
        _active_playback = self
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        stop_audio_output()
        self.queue.put(None)
        self.playback_started.set()

    def join(self, timeout: float | None = None) -> None:
        self.thread.join(timeout=timeout)

    def _run(self) -> None:
        try:
            self.playback_started.wait()
            if self.stop_event.is_set():
                return
            print(
                "Starting playback (generation continues in background)...",
                flush=True,
            )
            while not self.stop_event.is_set():
                segment = self.queue.get()
                if segment is None:
                    break
                if not _play_segment(segment, self.sample_rate, self.stop_event):
                    break
        except BaseException as exc:
            self.errors.append(exc)
        finally:
            global _active_playback
            if _active_playback is self:
                _active_playback = None


def _handle_shutdown(signum: int, _frame) -> None:
    print("\nStopping playback...", flush=True)
    if _active_playback is not None:
        _active_playback.stop()
    else:
        stop_audio_output()
    raise SystemExit(128 + signum)


def load_text(path: Path = TEXT_FILE) -> str:
    return path.read_text(encoding="utf-8").strip()


def _resolve_voice(tts):
    voices = tts.list_preset_voices()
    ids = {vid for _, vid in voices}
    if VOICE_ID in ids:
        return tts.get_preset_voice(VOICE_ID)
    print(f"Voice '{VOICE_ID}' not found. Available:", flush=True)
    for desc, vid in voices:
        print(f"  {vid}: {desc}", flush=True)
    raise ValueError(f"Unknown voice id: {VOICE_ID}")


def _infer_kwargs(voice) -> dict:
    return {
        "voice": voice,
        "max_chars": MAX_CHUNK_CHARS,
        "silence_p": CHUNK_SILENCE_P,
        "crossfade_p": CHUNK_CROSSFADE_P,
    }


def _single_chunk_infer_kwargs(voice) -> dict:
    """Per text chunk — joining happens after all chunks are synthesized."""
    return {
        "voice": voice,
        "max_chars": MAX_CHUNK_CHARS + 64,
        "skip_normalize": True,
        "silence_p": 0.0,
        "crossfade_p": 0.0,
    }


def _prepared_source(text: str) -> str:
    """Dictionary, decapitalize ALL CAPS words — normalize per chunk before infer."""
    return prepare_source_text(text)


def _text_chunks(tts, text: str) -> list[str]:
    source = _prepared_source(text)
    chunks = split_for_synthesis(source, MAX_CHUNK_CHARS)
    for warning in verify_text_coverage(source, chunks):
        print(f"Warning: {warning}", flush=True)
    return chunks


def _normalize_chunk(tts, chunk: str) -> str:
    return prepare_chunk_for_tts(chunk, tts.normalizer)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Synthesize article text to speech.")
    parser.add_argument(
        "--silent",
        action="store_true",
        help="Generate output.wav only; do not play audio",
    )
    parser.add_argument(
        "--text",
        type=Path,
        help=f"Input text file (default: {TEXT_FILE.name})",
    )
    return parser.parse_args(argv)


def _synthesize_chunks(tts, voice, text: str) -> tuple[list[np.ndarray], float]:
    """Synthesize all text chunks; returns waveforms and total duration in seconds."""
    text_chunks = _text_chunks(tts, text)
    print(
        f"Synthesis: {len(text_chunks)} chunks "
        f"(paragraph/sentence boundaries, ≤{MAX_CHUNK_CHARS} chars).",
        flush=True,
    )

    chunk_kw = _single_chunk_infer_kwargs(voice)
    chunk_wavs: list[np.ndarray] = []
    total_duration = 0.0

    for chunk_idx, chunk_text in enumerate(text_chunks, start=1):
        print(
            f"[chunk {chunk_idx}/{len(text_chunks)}] "
            f"synthesizing {len(chunk_text)} chars...",
            flush=True,
        )
        wav = np.asarray(
            tts.infer(_normalize_chunk(tts, chunk_text), **chunk_kw),
            dtype=np.float32,
        )
        chunk_wavs.append(wav)
        chunk_seconds = len(wav) / tts.sample_rate
        total_duration += chunk_seconds
        print(
            f"[chunk {chunk_idx}/{len(text_chunks)}] {chunk_seconds:.1f}s "
            f"(total {total_duration:.0f}s)",
            flush=True,
        )

    return chunk_wavs, total_duration


def _save_chunk_wavs(tts, chunk_wavs: list[np.ndarray], total_duration: float) -> None:
    from vieneu_utils.core_utils import join_audio_chunks

    if not chunk_wavs:
        return
    final_wav = join_audio_chunks(
        chunk_wavs,
        tts.sample_rate,
        CHUNK_SILENCE_P,
        CHUNK_CROSSFADE_P,
    )
    tts.save(final_wav, str(OUTPUT_PATH))
    print(f"Saved {total_duration:.1f}s of speech -> {OUTPUT_PATH}", flush=True)


def main() -> None:
    args = _parse_args()
    text_path = (args.text or TEXT_FILE).resolve()

    signal.signal(signal.SIGINT, _handle_shutdown)
    signal.signal(signal.SIGTERM, _handle_shutdown)

    text = load_text(text_path)

    silent = args.silent or SILENT_MODE
    stream_playback = STREAM_PLAYBACK and not silent

    print("Loading VieNeu-TTS-v2 (first run downloads models)...", flush=True)
    tts = create_tts()
    print(_runtime_label(tts), flush=True)
    if silent:
        print("Silent mode: generating audio only (no playback).", flush=True)
    voice = _resolve_voice(tts)
    run_synthesis(tts, voice, text, silent=silent, stream_playback=stream_playback)


def run_synthesis(
    tts,
    voice,
    text: str,
    *,
    silent: bool = False,
    stream_playback: bool = STREAM_PLAYBACK,
    playback_start_seconds: float = PLAYBACK_START_SECONDS,
) -> None:
    print(f"Synthesizing ~{len(text)} characters...", flush=True)

    if silent or not stream_playback:
        chunk_wavs, total_duration = _synthesize_chunks(tts, voice, text)
        _save_chunk_wavs(tts, chunk_wavs, total_duration)
        return

    playback = StreamPlayback(tts.sample_rate, playback_start_seconds)
    playback.start()
    print(
        f"Will start playback after ~{playback_start_seconds:.0f}s of audio is ready.",
        flush=True,
    )

    chunk_wavs: list[np.ndarray] = []
    total_duration = 0.0
    buffered_seconds = 0.0
    text_chunks = _text_chunks(tts, text)
    chunk_kw = _single_chunk_infer_kwargs(voice)

    try:
        for chunk_idx, chunk_text in enumerate(text_chunks, start=1):
            if playback.stop_event.is_set():
                break

            print(
                f"[chunk {chunk_idx}/{len(text_chunks)}] "
                f"synthesizing {len(chunk_text)} chars...",
                flush=True,
            )
            wav = np.asarray(
                tts.infer(_normalize_chunk(tts, chunk_text), **chunk_kw),
                dtype=np.float32,
            )
            chunk_wavs.append(wav)
            chunk_seconds = len(wav) / tts.sample_rate
            total_duration += chunk_seconds

            print(
                f"[chunk {chunk_idx}/{len(text_chunks)}] {chunk_seconds:.1f}s "
                f"(total {total_duration:.0f}s)",
                flush=True,
            )

            playback.queue.put(_mono_samples(wav))

            buffered_seconds += chunk_seconds
            if (
                not playback.playback_started.is_set()
                and buffered_seconds >= playback_start_seconds
            ):
                print(
                    f"Buffered {buffered_seconds:.0f}s — starting playback.",
                    flush=True,
                )
                playback.playback_started.set()

        if not playback.playback_started.is_set() and chunk_wavs:
            print("Starting playback.", flush=True)
            playback.playback_started.set()

        _save_chunk_wavs(tts, chunk_wavs, total_duration)
        if chunk_wavs:
            print("(Playback may still be running.)", flush=True)

        playback.queue.put(None)
        playback.thread.join()
        if playback.errors:
            raise playback.errors[0]
    except BaseException:
        print("Stopping playback due to error.", flush=True)
        playback.stop()
        playback.join(timeout=2.0)
        raise


if __name__ == "__main__":
    main()
