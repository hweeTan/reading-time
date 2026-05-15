#!/usr/bin/env bash
# Remove packages not needed by the ReadingTime worker bundle.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE_PY="$ROOT/bundle/python"

if [[ ! -x "$BUNDLE_PY/bin/python3" ]]; then
  echo "prune-bundle: venv not found at $BUNDLE_PY" >&2
  exit 1
fi

# shellcheck disable=SC1091
source "$BUNDLE_PY/bin/activate"

ORPHANS=(
  gradio
  gradio_client
  pandas
  librosa
  numba
  llvmlite
  scikit-learn
  scipy
  perth
  fastapi
  uvicorn
  starlette
  audioread
  pooch
  soxr
  joblib
  lazy_loader
  decorator
  msgpack
  threadpoolctl
  pydub
  hf-gradio
  groovy
  safehttpx
  semantic-version
  tomlkit
  brotli
  orjson
)

echo "==> Uninstalling orphan packages (ignore errors if absent)"
for pkg in "${ORPHANS[@]}"; do
  python -m pip uninstall -y "$pkg" 2>/dev/null || true
done

echo "==> Removing pip/setuptools/wheel from bundle venv"
python -m pip uninstall -y pip setuptools wheel 2>/dev/null || true

SITE="$(python -c "import site; print(site.getsitepackages()[0])")"
echo "==> Stripping test dirs under $SITE"
find "$SITE" -type d -name tests -prune -exec rm -rf {} + 2>/dev/null || true
find "$SITE" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true

deactivate
echo "==> Prune complete ($(du -sh "$BUNDLE_PY" | cut -f1))"
