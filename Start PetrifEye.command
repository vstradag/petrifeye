#!/bin/bash
# Double-clickable launcher. Finder runs .command files in Terminal, so this
# is the "one click" entry point: find a working Python, install what is
# missing, discover any Neon glasses on the network, start one bridge each,
# and open the browser.
#
# Deliberately a plain shell script rather than an .app for now: it is
# readable, it survives being copied around, and every step prints what it
# is doing. An .app wrapper can call this same file later without changing
# any of the logic.

set -o pipefail

# Finder starts .command files in the user's HOME, not next to the script, so
# every path here has to be derived from the script's own location.
CODE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HOME/dev/medusa-bridge-venv"

cd "$CODE" || { echo "Cannot find $CODE"; read -r -p "Press return to close."; exit 1; }

printf '\n\033[1mPETRIFEYE\033[0m\n\n'

# --- find a Python that works -------------------------------------------
# "Works" means it can import the heavy deps WITHOUT HANGING. A venv stored
# in Google Drive stalls forever on `import numpy` when Drive's file provider
# is unhappy — it does not error, it simply never returns — so each candidate
# gets a hard time limit rather than being trusted. macOS has no `timeout`,
# hence perl's alarm.
probe() {
  perl -e 'alarm 25; exec @ARGV' "$1" -c 'import numpy, aiohttp, cv2' >/dev/null 2>&1
}

PY=""
for cand in "$MEDUSA_PYTHON" "$VENV/bin/python" "$CODE/bridge/.venv/bin/python"; do
  [ -n "$cand" ] && [ -x "$cand" ] || continue
  printf 'checking %s ... ' "$cand"
  if probe "$cand"; then
    echo "ok"; PY="$cand"; break
  else
    echo "unusable (missing deps, or hanging on a cloud-synced folder)"
  fi
done

# --- first run: build the environment ------------------------------------
if [ -z "$PY" ]; then
  echo
  echo "No working Python environment yet. Setting one up in:"
  echo "  $VENV"
  echo "(Outside the project folder on purpose — a venv inside a cloud-synced"
  echo " folder hangs on import.)"
  echo
  command -v python3 >/dev/null 2>&1 || {
    echo "python3 is not installed. Install it from https://python.org and run this again."
    read -r -p "Press return to close."; exit 1; }

  python3 -m venv "$VENV" || { read -r -p "venv failed. Press return to close."; exit 1; }
  "$VENV/bin/pip" install --quiet --upgrade pip
  echo "Installing dependencies (a few minutes the first time)..."
  "$VENV/bin/pip" install --quiet -r "$CODE/bridge/requirements.txt" || {
    read -r -p "Install failed. Press return to close."; exit 1; }
  PY="$VENV/bin/python"
  echo "Done."
fi

echo
export MEDUSA_PYTHON="$PY"

# --- discover devices, start bridges, open the browser -------------------
# start_multiplayer.py does the real work and blocks until ctrl-c, shutting
# its bridges down on the way out.
"$PY" bridge/start_multiplayer.py "$@"
STATUS=$?

# Terminal windows opened by Finder close on exit and take the error with
# them, so hold the window open if anything went wrong.
if [ $STATUS -ne 0 ]; then
  echo
  echo "Exited with status $STATUS (see the messages above)."
  read -r -p "Press return to close."
fi
