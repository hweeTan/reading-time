#!/usr/bin/env bash
# Windows: copy the full Python install into bundle/python (relocatable tree).
# A venv keeps base_prefix on the build host (hostedtoolcache), which breaks verify
# and packaged runs on other machines.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/bundle-venv.sh
. "$ROOT/scripts/bundle-venv.sh"
BUNDLE_PY="$ROOT/bundle/python"
VIENEU_VERSION="${VIENEU_VERSION:-2.7.0}"

PYTHON_FOR_COPY="${PYTHON_FOR_COPY:-python3}"
BASE_PREFIX="$("$PYTHON_FOR_COPY" -c "import sys; print(sys.base_prefix)")"

echo "==> Preparing Windows Python bundle at $BUNDLE_PY"
echo "==> Copying Python runtime from $BASE_PREFIX"
rm -rf "$BUNDLE_PY"
mkdir -p "$BUNDLE_PY"
shopt -s dotglob 2>/dev/null || true
cp -R "$BASE_PREFIX"/* "$BUNDLE_PY/"
shopt -u dotglob 2>/dev/null || true

# Shipped layout expects Scripts/python.exe (see electron/main.cjs).
PY="$(bundle_python_exe "$BUNDLE_PY")"
if [[ ! -x "$PY" ]]; then
  if [[ ! -x "$BUNDLE_PY/python.exe" ]]; then
    echo "prepare-bundle-windows: no python.exe under $BUNDLE_PY" >&2
    exit 1
  fi
  mkdir -p "$BUNDLE_PY/Scripts"
  cp "$BUNDLE_PY/python.exe" "$BUNDLE_PY/Scripts/python.exe"
  PY="$BUNDLE_PY/Scripts/python.exe"
fi

# Standalone copy must not keep a venv config pointing at the build host.
rm -f "$BUNDLE_PY/pyvenv.cfg"

"$PY" -m pip install -U pip wheel

echo "==> Installing vieneu==${VIENEU_VERSION} (--no-deps)"
"$PY" -m pip install "vieneu==${VIENEU_VERSION}" --no-deps

echo "==> Installing minimal worker dependencies"
"$PY" -m pip install -r "$ROOT/requirements-bundle.txt"

bash "$ROOT/scripts/prune-bundle.sh"

echo "==> Windows Python bundle ready ($(du -sh "$BUNDLE_PY" | cut -f1))"
