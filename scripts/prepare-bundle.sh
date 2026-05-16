#!/usr/bin/env bash
# Create bundle/python venv and bundle/tts sources for electron-builder.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/bundle-venv.sh
. "$ROOT/scripts/bundle-venv.sh"
BUNDLE_PY="$ROOT/bundle/python"
BUNDLE_TTS="$ROOT/bundle/tts"
VIENEU_VERSION="${VIENEU_VERSION:-2.7.0}"

echo "==> Preparing Python bundle at $BUNDLE_PY"

if bundle_is_windows; then
  bash "$ROOT/scripts/prepare-bundle-windows.sh"
  echo "==> Copying TTS worker sources to $BUNDLE_TTS"
  rm -rf "$BUNDLE_TTS"
  mkdir -p "$BUNDLE_TTS"
  for f in tts_worker.py tts_engine.py text_prep.py model_manager.py document_import.py speak_dictionary.json; do
    cp "$ROOT/$f" "$BUNDLE_TTS/"
  done
  echo "==> Bundle ready ($(du -sh "$BUNDLE_PY" | cut -f1) python, $(du -sh "$BUNDLE_TTS" | cut -f1) tts)"
  exit 0
fi

rm -rf "$BUNDLE_PY"
# --copies: default macOS venvs symlink python3 to an absolute system path; that
# symlink is useless inside a shipped .app on another machine (Electron checks
# fail and the worker never starts). Copied interpreters stay under bundle/python.
PYTHON_FOR_VENV="python3"
if [[ "$(uname -s)" == "Darwin" ]]; then
  for candidate in "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3"; do
    if [[ -x "$candidate" ]] && "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)'; then
      PYTHON_FOR_VENV="$candidate"
      echo "==> Using framework Python 3.12 for venv: $PYTHON_FOR_VENV"
      break
    fi
  done
fi
"$PYTHON_FOR_VENV" -m venv --copies "$BUNDLE_PY"
bundle_activate "$BUNDLE_PY"
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

if [[ "$(uname -s)" == "Darwin" ]]; then
  # install_name_tool invalidates Mach-O signatures; sign before running python3
  # (relocate verify, trim) or macOS 15 CI kills the interpreter with SIGKILL.
  bash "$ROOT/scripts/relocate-bundle-python.sh" "$BUNDLE_PY"
  bash "$ROOT/scripts/sign-bundle-python.sh" "$BUNDLE_PY"
  bash "$ROOT/scripts/trim-bundle-python.sh" "$BUNDLE_PY"
  bash "$ROOT/scripts/sign-bundle-python.sh" "$BUNDLE_PY"
fi

echo "==> Copying TTS worker sources to $BUNDLE_TTS"
rm -rf "$BUNDLE_TTS"
mkdir -p "$BUNDLE_TTS"
for f in tts_worker.py tts_engine.py text_prep.py model_manager.py document_import.py speak_dictionary.json; do
  cp "$ROOT/$f" "$BUNDLE_TTS/"
done

echo "==> Bundle ready ($(du -sh "$BUNDLE_PY" | cut -f1) python, $(du -sh "$BUNDLE_TTS" | cut -f1) tts)"
