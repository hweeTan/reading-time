#!/usr/bin/env bash
# Cross-platform paths for bundle/python venv (Unix bin/ vs Windows Scripts/).
# Source from other bundle scripts: . "$(dirname "$0")/bundle-venv.sh"

bundle_is_windows() {
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) return 0 ;;
  esac
  [[ "${OS:-}" == "Windows_NT" ]]
}

bundle_is_windows_standalone() {
  bundle_is_windows && [[ ! -f "$1/pyvenv.cfg" ]]
}

# Root python.exe + PYTHONHOME (see bundle_export_python_env). Scripts/python.exe on
# GHA still resolves sys.prefix to hostedtoolcache when the host Python is on PATH.
bundle_python_exe() {
  local bundle_py="$1"
  if bundle_is_windows_standalone "$bundle_py" && [[ -x "$bundle_py/python.exe" ]]; then
    echo "$bundle_py/python.exe"
  elif [[ -x "$bundle_py/Scripts/python.exe" ]]; then
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

# python.org macOS venv launches Python.app; PYTHONHOME must point at the embedded
# framework version dir (stdlib), not /Library/Frameworks on the build machine.
bundle_darwin_framework_home() {
  local bundle_py="$1"
  local versions_dir="$bundle_py/Frameworks/Python.framework/Versions"
  local d
  [[ -d "$versions_dir" ]] || return 1
  for d in "$versions_dir"/*; do
    [[ -d "$d/lib" ]] || continue
    echo "$d"
    return 0
  done
  return 1
}

bundle_export_python_env() {
  local bundle_py="$1"
  export BUNDLE_PY="$bundle_py"
  if bundle_is_windows_standalone "$bundle_py"; then
    export PYTHONHOME="$bundle_py"
    unset VIRTUAL_ENV
    export PATH="$bundle_py:$bundle_py/Scripts:${PATH:-}"
    return
  fi
  if [[ "$(uname -s)" == "Darwin" ]]; then
    local fw_home=""
    if fw_home="$(bundle_darwin_framework_home "$bundle_py")"; then
      export PYTHONHOME="$fw_home"
    fi
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
