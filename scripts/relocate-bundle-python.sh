#!/usr/bin/env bash
# Make bundle/python runnable on machines without the build host's Python install.
set -euo pipefail

BUNDLE_PY="${1:-$(cd "$(dirname "$0")/.." && pwd)/bundle/python}"
BUNDLE_PY="$(cd "$BUNDLE_PY" && pwd)"
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

PYVENV_HOME=""

write_pyvenv_cfg() {
  local version="${1:-3.12}"
  local home="${PYVENV_HOME:-$BUNDLE_PY}"
  cat >"$BUNDLE_PY/pyvenv.cfg" <<EOF
home = ${home}
include-system-site-packages = false
version = ${version}.0
executable = ${BUNDLE_PY}/bin/python3
command = ${BUNDLE_PY}/bin/python3 -m venv --copies
EOF
}

discover_base_prefix() {
  "$PY_BIN" -c 'import sys; print(sys.base_prefix)'
}

discover_version() {
  "$PY_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'
}

# Directories we never copy from the host stdlib (saves hundreds of MB).
stdlib_should_skip() {
  case "$1" in
    test|tests|idlelib|tkinter|turtledemo|unittest|venv|ensurepip|distutils|lib2to3|pydoc_data|__phello__|_pyrepl|turtle|pdb|site-packages|__pycache__)
      return 0
      ;;
  esac
  return 1
}

# Copy python3.12.zip when the base install provides it (python.org framework, etc.).
copy_stdlib_zip() {
  local src_prefix="$1"
  local copied=0
  for z in \
    "$src_prefix/lib/python${VERSION}.zip" \
    "$src_prefix/lib/python${VERSION/./}.zip"; do
    if [[ -f "$z" ]]; then
      cp -f "$z" "$BUNDLE_PY/lib/python${VERSION}.zip"
      echo "  copied stdlib zip $(basename "$z")"
      copied=1
      break
    fi
  done
  return "$((1 - copied))"
}

# Small, portable stdlib slice: zip (if any) + lib-dynload/encodings + other missing dirs.
sync_stdlib_into_venv() {
  local src_stdlib="$1"
  local venv_stdlib="$2"
  [[ -d "$src_stdlib" ]] || return 0
  mkdir -p "$venv_stdlib"
  for required in encodings lib-dynload; do
    if [[ -d "$src_stdlib/$required" ]]; then
      rm -rf "$venv_stdlib/$required"
      cp -R "$src_stdlib/$required" "$venv_stdlib/"
    fi
  done
  echo "  syncing missing stdlib modules (skipping tests/tkinter/idlelib, etc.)"
  for item in "$src_stdlib"/*; do
    [[ -e "$item" ]] || continue
    base="$(basename "$item")"
    stdlib_should_skip "$base" && continue
    [[ -e "$venv_stdlib/$base" ]] && continue
    cp -R "$item" "$venv_stdlib/"
  done
  find "$venv_stdlib" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
}

# When python3.12.zip is present, only native stdlib dirs need to exist on disk.
sync_stdlib_native_only() {
  local src_stdlib="$1"
  local venv_stdlib="$2"
  [[ -d "$src_stdlib" ]] || return 0
  mkdir -p "$venv_stdlib"
  for required in encodings lib-dynload; do
    if [[ -d "$src_stdlib/$required" ]]; then
      rm -rf "$venv_stdlib/$required"
      cp -R "$src_stdlib/$required" "$venv_stdlib/"
    fi
  done
}

interpreter_references_python_app() {
  is_macho "$PY_BIN" || return 1
  strings "$PY_BIN" 2>/dev/null | grep -q 'Python.app/Contents/MacOS/Python'
}

# venv --copies on python.org macOS is a stub that posix_spawns Python.app, which we
# do not ship (and trim removes). Use the framework CLI binary or embedded dylib.
install_framework_interpreter() {
  local root="$FRAMEWORK_ROOT/Versions/$VERSION"
  for candidate in "$root/bin/python${VERSION}" "$root/bin/python3"; do
    if [[ -x "$candidate" ]]; then
      cp -f "$candidate" "$PY_BIN"
      chmod +x "$PY_BIN"
      echo "  installed $(basename "$candidate") as bin/python3"
      return 0
    fi
  done
  if [[ -f "${DEST_FW}/Versions/${VERSION}/Python" ]]; then
    cp -f "${DEST_FW}/Versions/${VERSION}/Python" "$PY_BIN"
    chmod +x "$PY_BIN"
    echo "  installed embedded Python dylib as bin/python3"
    return 0
  fi
  echo "relocate-bundle-python: no framework interpreter under $root/bin" >&2
  return 1
}

# First Python.framework / libpython dependency from otool (may be absolute or @-relative).
find_otool_py_lib() {
  local dep
  while IFS= read -r dep; do
    dep="${dep//$'\t'/}"
    [[ -z "$dep" ]] && continue
    if [[ "$dep" == /usr/lib/* ]] || [[ "$dep" == /System/* ]]; then
      continue
    fi
    if [[ "$dep" == *Python.framework* ]] || [[ "$dep" == *libpython*.dylib* ]]; then
      echo "$dep"
      return 0
    fi
  done < <(otool -L "$PY_BIN" 2>/dev/null | tail -n +2 | awk '{print $1}')
  return 1
}

# Resolve @-prefixed install names that already point inside the bundle.
resolve_bundled_at_path() {
  local dep="$1"
  local root="${dep#@loader_path/}"
  root="${root#@executable_path/}"
  local   candidate="$BUNDLE_PY/bin/$root"
  if [[ -f "$candidate" ]]; then
    echo "$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")"
    return 0
  fi
  candidate="$BUNDLE_PY/$root"
  if [[ -f "$candidate" ]]; then
    echo "$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")"
    return 0
  fi
  return 1
}

PY_LIB=""
if PY_LIB="$(find_otool_py_lib)"; then
  :
else
  PY_LIB=""
fi

# Resolve @-relative install names to a real file path when possible.
if [[ -n "$PY_LIB" && "$PY_LIB" == @* ]]; then
  if resolved="$(resolve_bundled_at_path "$PY_LIB")"; then
    echo "==> relocate-bundle-python: resolved bundled dylib ($PY_LIB -> $resolved)"
    PY_LIB="$resolved"
  else
    echo "==> relocate-bundle-python: resolving @ install name via sys.base_prefix"
    PY_LIB=""
  fi
fi

BASE_PREFIX=""
if [[ -z "$PY_LIB" ]]; then
  BASE_PREFIX="$(discover_base_prefix)"
  echo "==> relocate-bundle-python: discovered base_prefix=$BASE_PREFIX"
  if [[ "$BASE_PREFIX" == *Python.framework* ]]; then
    FRAMEWORK_ROOT="${BASE_PREFIX%%/Versions/*}"
    VERSION="${BASE_PREFIX##*/Versions/}"
    VERSION="${VERSION%%/*}"
    PY_LIB="$BASE_PREFIX/Python"
    if [[ ! -f "$PY_LIB" ]]; then
      PY_LIB="$FRAMEWORK_ROOT/Versions/$VERSION/Python"
    fi
  elif compgen -G "$BASE_PREFIX/lib/libpython"*.dylib >/dev/null 2>&1; then
    PY_LIB="$(ls "$BASE_PREFIX/lib/libpython"*.dylib 2>/dev/null | head -1)"
  else
    echo "relocate-bundle-python: cannot locate Python dylib (otool empty, base_prefix=$BASE_PREFIX)" >&2
    exit 1
  fi
fi

# If otool gave an absolute framework path, derive FRAMEWORK_ROOT / VERSION early.
FRAMEWORK_ROOT=""
VERSION=""
DEST_FW=""
NEW_LIB=""

if [[ "$PY_LIB" == *Python.framework* ]]; then
  if [[ "$PY_LIB" == *"/Versions/"*"/Python" ]]; then
    FRAMEWORK_ROOT="${PY_LIB%%/Versions/*}"
    VERSION_DIR="${PY_LIB#"$FRAMEWORK_ROOT"/Versions/}"
    VERSION="${VERSION_DIR%%/*}"
  elif [[ -n "${BASE_PREFIX:-}" && "$BASE_PREFIX" == *Python.framework* ]]; then
    FRAMEWORK_ROOT="${BASE_PREFIX%%/Versions/*}"
    VERSION="${BASE_PREFIX##*/Versions/}"
    VERSION="${VERSION%%/*}"
    PY_LIB="$BASE_PREFIX/Python"
    [[ -f "$PY_LIB" ]] || PY_LIB="$FRAMEWORK_ROOT/Versions/$VERSION/Python"
  else
    echo "relocate-bundle-python: cannot parse framework path: $PY_LIB" >&2
    exit 1
  fi
elif [[ -z "${VERSION:-}" ]]; then
  VERSION="$(discover_version)"
fi

echo "==> Relocating bundle/python (dylib: $PY_LIB)"

if [[ "$PY_LIB" == *Python.framework* ]]; then
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

  FW_PREFIX="$FRAMEWORK_ROOT/Versions/$VERSION"
  FW_STDLIB="$FW_PREFIX/lib/python${VERSION}"
  VENV_STDLIB="$BUNDLE_PY/lib/python${VERSION}"
  mkdir -p "$BUNDLE_PY/lib"
  if copy_stdlib_zip "$FW_PREFIX"; then
    sync_stdlib_native_only "$FW_STDLIB" "$VENV_STDLIB"
  else
    sync_stdlib_into_venv "$FW_STDLIB" "$VENV_STDLIB"
  fi
  PYVENV_HOME="$BUNDLE_PY/Frameworks/Python.framework/Versions/$VERSION"
  install_framework_interpreter

elif [[ "$PY_LIB" == *libpython*.dylib ]]; then
  BASE_PREFIX="${BASE_PREFIX:-$(discover_base_prefix)}"
  if [[ "$BASE_PREFIX" == "$BUNDLE_PY"* ]]; then
    echo "relocate-bundle-python: refusing to copy stdlib from inside the bundle" >&2
    exit 1
  fi
  rm -rf "$BUNDLE_PY/base"
  mkdir -p "$BUNDLE_PY/lib"
  BASENAME="$(basename "$PY_LIB")"
  HOST_LIBPY="$BASE_PREFIX/lib/$BASENAME"
  dest_lib="$BUNDLE_PY/lib/$BASENAME"
  if [[ -f "$HOST_LIBPY" ]]; then
    if [[ "$(realpath "$HOST_LIBPY")" != "$(realpath "$dest_lib")" ]]; then
      cp -f "$HOST_LIBPY" "$dest_lib"
    fi
  elif [[ -f "$PY_LIB" ]]; then
    if [[ "$(realpath "$PY_LIB")" != "$(realpath "$dest_lib")" ]]; then
      cp -f "$PY_LIB" "$dest_lib"
    fi
  else
    echo "relocate-bundle-python: dylib not found at $PY_LIB or $HOST_LIBPY" >&2
    exit 1
  fi
  NEW_LIB="@loader_path/../lib/$BASENAME"
  PYVENV_HOME="$BUNDLE_PY"
  echo "  embedding portable stdlib from $BASE_PREFIX"
  mkdir -p "$BUNDLE_PY/lib"
  if copy_stdlib_zip "$BASE_PREFIX"; then
    sync_stdlib_native_only "$BASE_PREFIX/lib/python${VERSION}" "$BUNDLE_PY/lib/python${VERSION}"
  else
    echo "  warn: no python${VERSION}.zip on host; syncing selective stdlib (pyenv builds are larger)"
    sync_stdlib_into_venv "$BASE_PREFIX/lib/python${VERSION}" "$BUNDLE_PY/lib/python${VERSION}"
  fi
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

# Patch every absolute framework/libpython path that may still be referenced.
OLD_LIBS=()
if [[ -n "${FRAMEWORK_ROOT:-}" && -n "${VERSION:-}" ]]; then
  OLD_LIBS+=(
    "$FRAMEWORK_ROOT/Versions/$VERSION/Python"
    "/Library/Frameworks/Python.framework/Versions/$VERSION/Python"
  )
elif [[ "$PY_LIB" == *libpython*.dylib ]]; then
  OLD_LIBS+=("$PY_LIB")
  if [[ -n "${BASE_PREFIX:-}" ]]; then
    OLD_LIBS+=("$BASE_PREFIX/lib/$(basename "$PY_LIB")")
  fi
elif [[ "$PY_LIB" == /* ]]; then
  OLD_LIBS+=("$PY_LIB")
fi

for old in "${OLD_LIBS[@]}"; do
  [[ -n "$old" ]] || continue
  patch_tree "$old" "$NEW_LIB"
done

# Also patch the discovered PY_LIB if it differs from OLD_LIBS entries.
if [[ "$PY_LIB" == /* ]]; then
  patch_tree "$PY_LIB" "$NEW_LIB"
fi

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

write_pyvenv_cfg "${VERSION:-3.12}"

# Do not exec python3 here — install_name_tool breaks signatures until
# sign-bundle-python.sh runs (see prepare-bundle.sh). otool-only checks below.

if otool -L "$PY_BIN" 2>/dev/null | grep -q '/Library/Frameworks/Python.framework'; then
  echo "relocate-bundle-python: still links to system Python.framework" >&2
  otool -L "$PY_BIN" | head -6 >&2
  exit 1
fi

if strings "$PY_BIN" 2>/dev/null | grep -q '/Library/Frameworks/Python.framework'; then
  echo "relocate-bundle-python: bin/python3 still embeds /Library/Frameworks path strings" >&2
  strings "$PY_BIN" 2>/dev/null | grep '/Library/Frameworks/Python.framework' | head -3 >&2
  exit 1
fi

if [[ -n "${DEST_FW:-}" ]] && interpreter_references_python_app; then
  echo "relocate-bundle-python: bin/python3 still posix_spawns Python.app (not bundled)" >&2
  strings "$PY_BIN" 2>/dev/null | grep 'Python.app' | head -3 >&2
  exit 1
fi

echo "==> relocate-bundle-python OK ($(du -sh "$BUNDLE_PY" | cut -f1))"
