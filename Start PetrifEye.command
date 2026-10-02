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
VENV="${MEDUSA_VENV:-$HOME/dev/medusa-bridge-venv}"

cd "$CODE" || { echo "Cannot find $CODE"; read -r -p "Press return to close."; exit 1; }

printf '\n\033[1mPETRIFEYE\033[0m\n\n'

# --- find a Python that works -------------------------------------------
# "Works" means it can import the heavy deps WITHOUT HANGING. A venv stored
# in Google Drive stalls forever on `import numpy` when Drive's file provider
# is unhappy — it does not error, it simply never returns — so each candidate
# gets a hard time limit rather than being trusted. macOS has no `timeout`,
# hence perl's alarm.
# Wrapped in a subshell so the shell's own job-control notice is swallowed too:
# when the alarm fires, bash prints "Alarm clock: 14  perl -e ..." to the
# terminal itself, which reads like a crash to anyone running this for the
# first time. Redirecting only perl's output does not hide that line.
probe() {
  ( perl -e 'alarm 25; exec @ARGV' "$1" -c 'import numpy, aiohttp, cv2' ) >/dev/null 2>&1
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

# --- first run: hand over to the setup script ----------------------------
# Deliberately NOT building the environment here any more. This used to run
# `python3 -m venv` directly, and on a stock Mac `python3` is 3.9 — too old for
# pupil-labs-realtime-api 1.9 and for the bridge's own syntax — so the pip
# install failed and this script reported "Install failed", which blames the
# dependencies for what is really the wrong interpreter. Setup PetrifEye.command
# chooses an interpreter by asking each candidate its version, and says what to
# install when none qualifies. One place knows how to do this; this is not it.
if [ -z "$PY" ]; then
  SETUP="$CODE/Setup PetrifEye.command"
  echo
  echo "No working Python environment yet — running setup first."
  echo
  if [ ! -f "$SETUP" ]; then
    echo "Cannot find \"Setup PetrifEye.command\" next to this script."
    echo "Re-download the project, keeping both files together."
    read -r -p "Press return to close."; exit 1
  fi
  MEDUSA_VENV="$VENV" bash "$SETUP" || { read -r -p "Press return to close."; exit 1; }
  if probe "$VENV/bin/python"; then
    PY="$VENV/bin/python"
  else
    echo
    echo "Setup finished but the environment at $VENV still cannot import what"
    echo "the bridge needs. Run \"Setup PetrifEye.command\" on its own and read its output."
    read -r -p "Press return to close."; exit 1
  fi
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
