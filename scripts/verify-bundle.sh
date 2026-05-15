#!/usr/bin/env bash
# Verify the worker bundle imports and optional RPC smoke; enforce size budget.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE_PY="$ROOT/bundle/python"
BUNDLE_TTS="$ROOT/bundle/tts"
PY="$BUNDLE_PY/bin/python3"
SIZE_BUDGET_MB="${BUNDLE_SIZE_BUDGET_MB:-400}"

if [[ ! -x "$PY" ]]; then
  echo "verify-bundle: python not found at $PY" >&2
  exit 1
fi

# Catch broken or host-absolute symlinks (would work on the build machine only).
export BUNDLE_PY
if ! "$PY" -c "
import os, sys
root = os.path.realpath(os.environ['BUNDLE_PY'])
exe = os.path.realpath(sys.executable)
if not (exe == root or exe.startswith(root + os.sep)):
    raise SystemExit(
        'Interpreter is not self-contained in the bundle. '
        f'Got {exe!r}, expected under {root!r}. '
        'Recreate the venv with: python3 -m venv --copies (see prepare-bundle.sh).'
    )
print(f'  ok: bundled interpreter {exe}')
"; then
  exit 1
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  if otool -L "$PY" 2>/dev/null | grep -q '/Library/Frameworks/Python.framework'; then
    echo "verify-bundle: python still links to system Python.framework — run scripts/relocate-bundle-python.sh" >&2
    exit 1
  fi
  if ! codesign --verify "$PY" 2>/dev/null; then
    echo "verify-bundle: python3 signature invalid — run scripts/sign-bundle-python.sh" >&2
    exit 1
  fi
  echo "  ok: codesign verify python3"
fi

if [[ ! -d "$BUNDLE_TTS" ]]; then
  echo "verify-bundle: TTS sources not found at $BUNDLE_TTS" >&2
  exit 1
fi

echo "==> Stdlib / encodings"
"$PY" -c "import encodings; import ssl; print('  ok: encodings, ssl')"

echo "==> Import probes"
TTS_PATH="$BUNDLE_TTS" "$PY" -c "
import importlib.util
import os
import sys

sys.path.insert(0, os.environ['TTS_PATH'])

required = [
    'numpy', 'soundfile', 'huggingface_hub', 'onnxruntime',
    'llama_cpp', 'sea_g2p', 'vieneu', 'vieneu_utils',
]
for name in required:
    if importlib.util.find_spec(name) is None:
        raise SystemExit(f'Missing required package: {name}')
    print(f'  ok: {name}')

forbidden = ['gradio', 'librosa', 'pandas', 'sklearn', 'scipy', 'numba']
for name in forbidden:
    if importlib.util.find_spec(name) is not None:
        raise SystemExit(f'Forbidden package still installed: {name}')
    print(f'  absent: {name}')

import document_import  # noqa: E402
import model_manager  # noqa: E402
import tts_engine  # noqa: E402
print('  ok: worker modules')
"

echo "==> Vieneu factory import"
"$PY" -c "from vieneu import Vieneu; print('  ok: Vieneu')"

MODELS_HOME="${TTS_MODELS_HOME:-$HOME/Library/Application Support/ReadingTime/models}"
if [[ -d "$MODELS_HOME/hub" ]] && compgen -G "$MODELS_HOME/hub/"* >/dev/null 2>&1; then
  echo "==> Worker RPC smoke (models at $MODELS_HOME)"
  export TTS_MODELS_HOME="$MODELS_HOME"
  (
    cd "$BUNDLE_TTS"
    printf '%s\n' '{"id":"1","cmd":"ping"}' '{"id":"2","cmd":"check_models"}' | \
      timeout 120 "$PY" tts_worker.py 2>/dev/null
  ) | grep -q '"ok"' && echo "  ok: worker responded" || \
    echo "  warn: worker smoke did not get ok response (models may be incomplete)"
else
  echo "==> Worker RPC smoke skipped (no models at $MODELS_HOME)"
fi

BYTES=$(du -sk "$BUNDLE_PY" | cut -f1)
MB=$((BYTES / 1024))
echo "==> Bundle size: ${MB} MB (budget: ${SIZE_BUDGET_MB} MB)"
echo "==> Largest paths under bundle/python:"
du -sh "$BUNDLE_PY"/* 2>/dev/null | sort -hr | head -8 || true
SITE="$("$PY" -c "import site; print(site.getsitepackages()[0])")"
du -sh "$SITE"/* 2>/dev/null | sort -hr | head -8 || true

if (( MB > SIZE_BUDGET_MB )); then
  echo "verify-bundle: size ${MB} MB exceeds budget ${SIZE_BUDGET_MB} MB" >&2
  exit 1
fi

echo "==> verify-bundle OK"
