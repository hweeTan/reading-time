# ReadingTime

**ReadingTime** is a desktop application for **Vietnamese text-to-speech**. It turns long-form text into natural-sounding audio you can listen to while working, studying, or relaxing. The UI is built with **Electron** and **React**; synthesis runs through a bundled **Python** worker that drives the speech model locally on your machine.

## What it does

- **Synthesize** — Paste or drop text, pick a voice and reading style, then generate WAV (or similar) output to a folder you choose. Long text is split into chunks, synthesized, and stitched with smooth transitions.
- **Job queue** — Run multiple synthesis jobs and track their progress from one place.
- **Dictionary** — Define custom word pronunciations so names, technical terms, or unusual spellings read the way you want.
- **Model setup** — First launch can download and verify the **VieNeu-TTS-v2** weights from Hugging Face so everything works offline after setup.
- **Playback** — Preview and play generated audio from inside the app.

Voices and bilingual (Vietnamese–English) behavior come from the underlying model; see the model page for details on presets and capabilities.

## Development

Prerequisites: **Node.js** (with **pnpm**), **Python 3**, and enough disk space for the model.

1. **Electron app (UI + desktop shell)** — from `electron/`:

   ```bash
   cd electron
   pnpm install
   pnpm run dev:setup   # prepares Python bundle + TTS worker; then starts Vite + Electron
   ```

   For day-to-day UI work after the bundle exists:

   ```bash
   pnpm run dev
   ```

2. **Python / CLI** — install dependencies from the repo root (see `requirements.txt` and `requirements-app.txt` for document import extras).

The release pipeline and `scripts/prepare-bundle.sh` pin **`vieneu`** and related wheels so packaged builds stay reproducible.

## Model credits

This project uses **[VieNeu-TTS-v2](https://huggingface.co/pnnbao-ump/VieNeu-TTS-v2)** by **Phạm Nguyễn Ngọc Bảo** (published on Hugging Face as `pnnbao-ump/VieNeu-TTS-v2`). It is a next-generation Vietnamese TTS model aimed at natural speech, podcasts, and Vietnamese–English code-switching, with optional voice cloning in the upstream project.

- **Model card:** [https://huggingface.co/pnnbao-ump/VieNeu-TTS-v2](https://huggingface.co/pnnbao-ump/VieNeu-TTS-v2)  
- **License:** Apache 2.0 (as stated on the model card)

If you use outputs or derivatives in research, cite the model as recommended on the Hugging Face model page.

---

ReadingTime is an independent app that **bundles and calls** the public VieNeu-TTS-v2 assets; it is not affiliated with the model author beyond using the released weights and SDK under the published license.
