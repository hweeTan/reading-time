#!/usr/bin/env bash
# Re-sign Mach-O files after install_name_tool / strip (invalidates embedded signatures).
# Without this, dyld reports: code signature invalid ... Python.framework/.../Python
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/bundle-venv.sh
. "$ROOT/scripts/bundle-venv.sh"
BUNDLE_PY="${1:-$ROOT/bundle/python}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "==> sign-bundle-python: skipped (not macOS)"
  exit 0
fi

if [[ ! -x "$BUNDLE_PY/bin/python3" ]]; then
  echo "sign-bundle-python: missing $BUNDLE_PY/bin/python3" >&2
  exit 1
fi

if ! command -v codesign >/dev/null 2>&1; then
  echo "sign-bundle-python: codesign not found" >&2
  exit 1
fi

echo "==> Ad-hoc signing Mach-O files in $BUNDLE_PY"

sign_macho() {
  local f="$1"
  file "$f" 2>/dev/null | grep -q 'Mach-O' || return 0
  codesign --force --sign - --timestamp=none "$f" 2>/dev/null || \
    codesign --force --sign - "$f"
}

# Sign libraries and extensions first (inner dependencies).
while IFS= read -r -d '' f; do
  sign_macho "$f"
done < <(find "$BUNDLE_PY" -type f \( -name '*.dylib' -o -name '*.so' \) -print0 2>/dev/null)

# Embedded Python.framework dylib.
if [[ -d "$BUNDLE_PY/Frameworks/Python.framework/Versions" ]]; then
  while IFS= read -r -d '' f; do
    sign_macho "$f"
  done < <(find "$BUNDLE_PY/Frameworks/Python.framework/Versions" -type f -print0 2>/dev/null)
fi

if [[ -d "$BUNDLE_PY/lib" ]]; then
  while IFS= read -r -d '' f; do
    sign_macho "$f"
  done < <(find "$BUNDLE_PY/lib" -type f -print0 2>/dev/null)
fi

# Interpreter last.
sign_macho "$BUNDLE_PY/bin/python3"
for bin in "$BUNDLE_PY"/bin/python3.*; do
  [[ -f "$bin" ]] && sign_macho "$bin"
done

echo "==> Verifying signature and interpreter"
codesign --verify --verbose=2 "$BUNDLE_PY/bin/python3"
bundle_export_python_env "$BUNDLE_PY"
"$BUNDLE_PY/bin/python3" -c "
import encodings
import os
import pathlib
import sys

root = pathlib.Path(os.environ['BUNDLE_PY']).resolve()
if '/Library/Frameworks/Python.framework' in sys.prefix:
    raise SystemExit(f'prefix still on system framework: {sys.prefix!r}')
for name in ('prefix', 'base_prefix'):
    p = pathlib.Path(getattr(sys, name)).resolve()
    if not str(p).startswith(str(root)):
        raise SystemExit(f'{name}={p} is not under bundle {root}')
enc = pathlib.Path(encodings.__file__).resolve()
if not str(enc).startswith(str(root)):
    raise SystemExit(f'encodings not in bundle: {enc}')
print('  ok:', sys.version.split()[0], 'prefix', sys.prefix)
"

echo "==> sign-bundle-python OK"
