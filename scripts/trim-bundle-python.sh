#!/usr/bin/env bash
# Shrink bundle/python after relocate (remove duplicate framework trees, strip, etc.).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/bundle-venv.sh
. "$ROOT/scripts/bundle-venv.sh"
BUNDLE_PY="${1:-$ROOT/bundle/python}"

if [[ ! -d "$BUNDLE_PY" ]]; then
  echo "trim-bundle-python: missing $BUNDLE_PY" >&2
  exit 1
fi

echo "==> Trimming bundle/python"

# Legacy layout from an earlier relocate; safe to drop (saves hundreds of MB).
if [[ -d "$BUNDLE_PY/base" ]]; then
  echo "  remove legacy bundle/python/base"
  rm -rf "$BUNDLE_PY/base"
fi

# Full Python.framework copies duplicate the venv stdlib (~1GB). Keep only the dylib layout.
if [[ -d "$BUNDLE_PY/Frameworks/Python.framework" ]]; then
  find "$BUNDLE_PY/Frameworks/Python.framework/Versions" -maxdepth 2 -type d -name 'python3.*' 2>/dev/null | while read -r d; do
    echo "  remove duplicate stdlib: $d"
    rm -rf "$d"
  done
  # Keep Resources/Python.app — venv bin/python3 posix_spawns it (see relocate-bundle-python.sh).
  for sub in include share bin Headers; do
    find "$BUNDLE_PY/Frameworks/Python.framework/Versions" -maxdepth 2 -type d -name "$sub" 2>/dev/null | while read -r d; do
      echo "  remove framework $sub: $d"
      rm -rf "$d"
    done
  done
fi

# Stdlib modules not needed by the TTS worker.
bundle_export_python_env "$BUNDLE_PY"
PY_VER="$("$BUNDLE_PY/bin/python3" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "3.12")"
for STDLIB in "$BUNDLE_PY/lib/python${PY_VER}"; do
  if [[ -d "$STDLIB" ]]; then
    for name in idlelib tkinter turtledemo test tests unittest venv ensurepip distutils lib2to3 pydoc_data __phello__ _pyrepl turtle pdb; do
      [[ -e "$STDLIB/$name" ]] && rm -rf "$STDLIB/$name"
    done
  fi
done

# onnxruntime: macOS CPU-only bundle does not need CUDA/ROCm/TensorRT provider libs.
SITE="$("$BUNDLE_PY/bin/python3" -c "import site; print(site.getsitepackages()[0])" 2>/dev/null || true)"
if [[ -n "$SITE" && -d "$SITE/onnxruntime" ]]; then
  find "$SITE/onnxruntime" -type f \( -name '*cuda*' -o -name '*rocm*' -o -name '*tensorrt*' -o -name '*dnnl*' \) -delete 2>/dev/null || true
fi

find "$BUNDLE_PY" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
find "$BUNDLE_PY" -type f -name '*.pyc' -delete 2>/dev/null || true
find "$BUNDLE_PY" -type f -name '*.pyo' -delete 2>/dev/null || true

if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "==> Stripping debug symbols from extension modules"
  while IFS= read -r -d '' f; do
    strip -x "$f" 2>/dev/null || true
  done < <(find "$BUNDLE_PY" \( -name '*.so' -o -name '*.dylib' \) -type f -print0 2>/dev/null)
fi

echo "==> Trim complete ($(du -sh "$BUNDLE_PY" | cut -f1))"
