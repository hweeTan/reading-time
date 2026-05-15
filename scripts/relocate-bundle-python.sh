#!/usr/bin/env bash
# Make bundle/python runnable on machines without the build host's Python install.
set -euo pipefail

BUNDLE_PY="${1:-$(cd "$(dirname "$0")/.." && pwd)/bundle/python}"
PY_BIN="$BUNDLE_PY/bin/python3"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "==> relocate-bundle-python: skipped (not macOS)"
  exit 0
fi

if [[ ! -x "$PY_BIN" ]]; then
  echo "relocate-bundle-python: missing $PY_BIN" >&2
  exit 1
fi

is_macho() {
  file "$1" 2>/dev/null | grep -q 'Mach-O'
}

PY_LIB=""
while IFS= read -r dep; do
  dep="${dep//$'\t'/}"
  [[ -z "$dep" ]] && continue
  if [[ "$dep" == /usr/lib/* ]] || [[ "$dep" == /System/* ]]; then
    continue
  fi
  if [[ "$dep" == *Python.framework* ]] || [[ "$dep" == *libpython*.dylib* ]]; then
    PY_LIB="$dep"
    break
  fi
done < <(otool -L "$PY_BIN" 2>/dev/null | tail -n +2 | awk '{print $1}')

if [[ -z "$PY_LIB" ]]; then
  echo "==> relocate-bundle-python: no external Python dylib (ok)"
  exit 0
fi

if [[ "$PY_LIB" == @* ]]; then
  echo "==> relocate-bundle-python: already relocatable ($PY_LIB)"
  exit 0
fi

echo "==> Relocating bundle/python (was: $PY_LIB)"

NEW_LIB=""
DEST_FW=""
VERSION=""
FRAMEWORK_ROOT=""

if [[ "$PY_LIB" == *Python.framework* ]]; then
  FRAMEWORK_ROOT="${PY_LIB%%/Versions/*}"
  VERSION_DIR="${PY_LIB#"$FRAMEWORK_ROOT"/Versions/}"
  VERSION="${VERSION_DIR%%/*}"
  if [[ ! -f "$PY_LIB" ]]; then
    echo "relocate-bundle-python: Python dylib not found at $PY_LIB" >&2
    exit 1
  fi
  DEST_FW="$BUNDLE_PY/Frameworks/Python.framework"
  rm -rf "$DEST_FW"
  mkdir -p "$DEST_FW/Versions/$VERSION"
  cp -f "$PY_LIB" "$DEST_FW/Versions/$VERSION/Python"
  ln -sf "$VERSION" "$DEST_FW/Versions/Current"
  ln -sf "Versions/Current/Python" "$DEST_FW/Python"
  NEW_LIB="@loader_path/../Frameworks/Python.framework/Versions/${VERSION}/Python"

  # Use the real interpreter — not the venv launcher that posix_spawns Python.app.
  REAL_PY="$FRAMEWORK_ROOT/Versions/$VERSION/Resources/Python.app/Contents/MacOS/Python"
  if [[ -x "$REAL_PY" ]]; then
    cp -f "$REAL_PY" "$PY_BIN"
    chmod +x "$PY_BIN"
    echo "  installed real interpreter at bin/python3"
  elif is_macho "$FRAMEWORK_ROOT/Versions/$VERSION/Python"; then
    cp -f "$FRAMEWORK_ROOT/Versions/$VERSION/Python" "$PY_BIN"
    chmod +x "$PY_BIN"
    echo "  installed framework Python dylib as bin/python3"
  fi

  SRC_LIB="$FRAMEWORK_ROOT/Versions/$VERSION/lib"
  if [[ -d "$SRC_LIB" ]]; then
    mkdir -p "$DEST_FW/Versions/$VERSION/lib"
    for f in "$SRC_LIB"/*; do
      [[ -f "$f" ]] || continue
      base="$(basename "$f")"
      [[ "$base" == python3.* ]] && continue
      cp -f "$f" "$DEST_FW/Versions/$VERSION/lib/$base"
    done
  fi

  FW_STDLIB="$FRAMEWORK_ROOT/Versions/$VERSION/lib/python${VERSION}"
  VENV_STDLIB="$BUNDLE_PY/lib/python${VERSION}"
  if [[ -d "$FW_STDLIB" && -d "$VENV_STDLIB" ]]; then
    echo "  syncing stdlib modules from framework"
    for item in "$FW_STDLIB"/*; do
      base="$(basename "$item")"
      [[ -e "$VENV_STDLIB/$base" ]] && continue
      cp -R "$item" "$VENV_STDLIB/"
    done
  fi
  if [[ ! -f "$BUNDLE_PY/lib/python${VERSION}.zip" ]]; then
    for z in \
      "$FRAMEWORK_ROOT/Versions/$VERSION/lib/python${VERSION}.zip" \
      "$FRAMEWORK_ROOT/Versions/$VERSION/lib/python${VERSION/./}.zip"; do
      if [[ -f "$z" ]]; then
        cp -f "$z" "$BUNDLE_PY/lib/python${VERSION}.zip"
        echo "  copied $(basename "$z")"
        break
      fi
    done
  fi

elif [[ "$PY_LIB" == *libpython*.dylib ]]; then
  mkdir -p "$BUNDLE_PY/lib"
  BASENAME="$(basename "$PY_LIB")"
  if [[ ! -f "$PY_LIB" ]]; then
    echo "relocate-bundle-python: dylib not found at $PY_LIB" >&2
    exit 1
  fi
  cp -f "$PY_LIB" "$BUNDLE_PY/lib/$BASENAME"
  NEW_LIB="@loader_path/../lib/$BASENAME"
else
  echo "relocate-bundle-python: unsupported dependency: $PY_LIB" >&2
  exit 1
fi

patch_macho() {
  local f="$1"
  local old="$2"
  local new="$3"
  is_macho "$f" || return 0
  if otool -L "$f" 2>/dev/null | grep -qF "$old"; then
    install_name_tool -change "$old" "$new" "$f"
  fi
}

patch_tree() {
  local old="$1"
  local new="$2"
  patch_macho "$PY_BIN" "$old" "$new"
  for bin in "$BUNDLE_PY"/bin/python3.*; do
    [[ -f "$bin" ]] && patch_macho "$bin" "$old" "$new"
  done
  if [[ -n "${DEST_FW:-}" ]]; then
    while IFS= read -r -d '' f; do
      patch_macho "$f" "$old" "$new"
    done < <(find "$DEST_FW" -type f -print0 2>/dev/null)
  fi
  while IFS= read -r -d '' f; do
    patch_macho "$f" "$old" "$new"
  done < <(find "$BUNDLE_PY" \( -name '*.so' -o -name '*.dylib' \) -type f -print0 2>/dev/null)
}

patch_tree "$PY_LIB" "$NEW_LIB"

if [[ -n "${DEST_FW:-}" && -n "${VERSION}" && -n "${FRAMEWORK_ROOT}" ]]; then
  FW_LIB="$FRAMEWORK_ROOT/Versions/$VERSION/lib"
  for lib in "$DEST_FW/Versions/$VERSION/lib/"*; do
    [[ -f "$lib" ]] || continue
    base="$(basename "$lib")"
    old_lib="$FW_LIB/$base"
    new_lib="@loader_path/../../Frameworks/Python.framework/Versions/${VERSION}/lib/$base"
    while IFS= read -r -d '' f; do
      patch_macho "$f" "$old_lib" "$new_lib"
    done < <(find "$BUNDLE_PY/lib/python"* -name '*.so' -type f -print0 2>/dev/null)
  done
fi

if [[ -n "${VERSION}" ]]; then
  cat >"$BUNDLE_PY/pyvenv.cfg" <<EOF
home = ${BUNDLE_PY}
include-system-site-packages = false
version = ${VERSION}.0
executable = ${BUNDLE_PY}/bin/python3
command = ${BUNDLE_PY}/bin/python3 -m venv --copies
EOF
fi

# Do not exec python3 here — install_name_tool breaks signatures until
# sign-bundle-python.sh runs (see prepare-bundle.sh). otool-only checks below.

if otool -L "$PY_BIN" | grep -q '/Library/Frameworks/Python.framework'; then
  echo "relocate-bundle-python: still links to system Python.framework" >&2
  otool -L "$PY_BIN" | head -6 >&2
  exit 1
fi

echo "==> relocate-bundle-python OK ($(du -sh "$BUNDLE_PY" | cut -f1))"
