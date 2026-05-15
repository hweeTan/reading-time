#!/usr/bin/env bash
# Create bundle/python venv and bundle/tts sources for electron-builder.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE_PY="$ROOT/bundle/python"
BUNDLE_TTS="$ROOT/bundle/tts"
VIENEU_VERSION="${VIENEU_VERSION:-2.7.0}"

echo "==> Preparing Python bundle at $BUNDLE_PY"
rm -rf "$BUNDLE_PY"
python3 -m venv "$BUNDLE_PY"
# shellcheck disable=SC1091
source "$BUNDLE_PY/bin/activate"
python -m pip install -U pip wheel

echo "==> Installing vieneu==${VIENEU_VERSION} (--no-deps)"
python -m pip install "vieneu==${VIENEU_VERSION}" --no-deps

echo "==> Installing minimal worker dependencies"
python -m pip install -r "$ROOT/requirements-bundle.txt"

if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
  echo "==> Installing llama-cpp-python (Metal) for Apple Silicon"
  python -m pip install llama-cpp-python==0.3.16 \
    --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/metal/ \
    --force-reinstall --no-deps
elif [[ "$(uname -s)" == "Darwin" ]]; then
  echo "==> Reinstalling llama-cpp-python (macOS)"
  python -m pip install llama-cpp-python==0.3.16 --force-reinstall --no-deps
fi

deactivate

bash "$ROOT/scripts/prune-bundle.sh"

echo "==> Copying TTS worker sources to $BUNDLE_TTS"
rm -rf "$BUNDLE_TTS"
mkdir -p "$BUNDLE_TTS"
for f in tts_worker.py tts_engine.py text_prep.py model_manager.py document_import.py speak_dictionary.json; do
  cp "$ROOT/$f" "$BUNDLE_TTS/"
done

echo "==> Bundle ready ($(du -sh "$BUNDLE_PY" | cut -f1) python, $(du -sh "$BUNDLE_TTS" | cut -f1) tts)"
