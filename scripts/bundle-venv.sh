#!/usr/bin/env bash
# Cross-platform paths for bundle/python venv (Unix bin/ vs Windows Scripts/).
# Source from other bundle scripts: . "$(dirname "$0")/bundle-venv.sh"

bundle_is_windows() {
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) return 0 ;;
  esac
  [[ "${OS:-}" == "Windows_NT" ]]
}

bundle_python_exe() {
  local bundle_py="$1"
  if [[ -x "$bundle_py/Scripts/python.exe" ]]; then
    echo "$bundle_py/Scripts/python.exe"
  elif [[ -x "$bundle_py/bin/python3" ]]; then
    echo "$bundle_py/bin/python3"
  else
    echo "$bundle_py/bin/python3"
  fi
}

bundle_python_bin_dir() {
  local bundle_py="$1"
  if [[ -d "$bundle_py/Scripts" ]]; then
    echo "$bundle_py/Scripts"
  else
    echo "$bundle_py/bin"
  fi
}

bundle_activate() {
  local bundle_py="$1"
  if [[ -f "$bundle_py/Scripts/activate" ]]; then
    # shellcheck disable=SC1091
    source "$bundle_py/Scripts/activate"
  elif [[ -f "$bundle_py/bin/activate" ]]; then
    # shellcheck disable=SC1091
    source "$bundle_py/bin/activate"
  else
    echo "bundle_activate: venv activate script not found under $bundle_py" >&2
    return 1
  fi
}
