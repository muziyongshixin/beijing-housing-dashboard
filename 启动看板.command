#!/bin/zsh
set -e
cd "$(dirname "$0")"

PYTHON_BIN="/Users/lennoxlv/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"
if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="$(command -v python3)"
fi

"$PYTHON_BIN" app.py
