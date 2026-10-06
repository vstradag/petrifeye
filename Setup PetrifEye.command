#!/bin/bash
# PetrifEye — one-time setup for the Neon bridge. Double-click this file.
#
# It exists because the manual steps have one trap that cost a whole setup
# session: macOS ships Python 3.9 as `python3`, and `python3 -m venv` therefore
# builds an environment too old for this project — pupil-labs-realtime-api 1.9
# needs 3.10+, and the bridge uses syntax 3.9 cannot parse. The failure looked
# like a bug in the code rather than the wrong interpreter. So this script picks
# an interpreter by asking each candidate its version instead of trusting a
# name, and says plainly what to install when none qualifies.
#
# Safe to run twice: an environment that already works is left alone.
#
# Override the location with MEDUSA_VENV=/some/path if you need to.

set -u
cd "$(dirname "$0")" || exit 1

VENV="${MEDUSA_VENV:-$HOME/dev/medusa-bridge-venv}"
REQS="bridge/requirements.txt"
MIN="3.10"

say() { printf '%s\n' "$*"; }
rule() { say "------------------------------------------------------------"; }

# A double-clickable PetrifEye.command on the Desktop, so after the first run
# nobody has to dig the project folder out again. Not a symlink: Start finds
# the project from its own path, which through a link would be the Desktop.
# This tiny script runs the real one instead. Rewritten on every setup, so
# running Setup from a moved project re-points it. Opt out with
# MEDUSA_NO_SHORTCUT=1.
desktop_shortcut() {
  [ -z "${MEDUSA_NO_SHORTCUT:-}" ] || return 0
  local desk="${MEDUSA_DESKTOP:-$HOME/Desktop}"
  [ -d "$desk" ] || return 0
  local link="$desk/PetrifEye.command"
  local start
  start="$(pwd)/Start PetrifEye.command"
  {
    printf '#!/bin/bash\n'
    printf '# Shortcut made by Setup PetrifEye.command. Safe to delete.\n'
    printf 'START=%q\n' "$start"
    printf '%s\n' \
      'if [ -f "$START" ]; then exec bash "$START"; fi' \
      'echo "PetrifEye is no longer at:"' \
      'echo "  $START"' \
      'echo "Open the project where it is now and double-click Setup PetrifEye.command"' \
      'echo "there - that puts a working shortcut back on the Desktop."' \
      'read -r -p "Press return to close."'
  } > "$link" && chmod +x "$link" \
    && say "Desktop shortcut:  $link  — double-click it to start PetrifEye."
}

say ""
say "PetrifEye setup"
rule
say "project      $(pwd)"
say "environment  $VENV"
say ""

# Checked before anything is built: if this file was copied out of the project
# (to the Desktop, say) the dependency list is not here, and the failure would
# otherwise arrive minutes later from pip, about a path nobody typed.
if [ ! -f "$REQS" ]; then
  say "Cannot find $REQS next to this script."
  say "Keep this file inside the petrifeye folder and run it from there."
  exit 1
fi

# The venv must not live inside the project when the project is in Google
# Drive: Drive serves those files through a virtual filesystem, and when it
# stalls an `import` blocks FOREVER instead of failing — indistinguishable
# from the bridge hanging. Refuse rather than build something that will
# mystify someone later.
case "$VENV" in
  *"CloudStorage"*|*"Google Drive"*|*"Dropbox"*|*"iCloud"*|*"Library/Mobile Documents"*)
    say "REFUSING: that path is inside a synced folder (Drive/Dropbox/iCloud)."
    say "An import from there can hang forever instead of failing."
    say "Use a local path, e.g.  MEDUSA_VENV=\$HOME/dev/medusa-bridge-venv"
    exit 1 ;;
esac

# --- is it already set up? ------------------------------------------------
if [ -x "$VENV/bin/python" ]; then
  if "$VENV/bin/python" - <<'PY' 2>/dev/null
import sys
assert sys.version_info >= (3, 10)
import aiohttp, numpy, cv2
from pupil_labs.realtime_api import Device
from pupil_labs.real_time_screen_gaze.gaze_mapper import GazeMapper
PY
  then
    say "Already set up — $("$VENV/bin/python" --version 2>&1) with everything it needs."
    say ""
    say "Start the piece with:"
    say "  \"$(pwd)/Start PetrifEye.command\""
    say "or:"
    say "  $VENV/bin/python bridge/start_multiplayer.py"
    say ""
    desktop_shortcut
    exit 0
  fi
  say "An environment exists but is incomplete or too old — rebuilding it."
  say ""
fi

# --- find an interpreter --------------------------------------------------
# Asked, never assumed: `python3` is 3.9 on a stock Mac, `python3.12` may not
# exist under that name, and a conda python answers to both. Newest first.
PY_BIN=""
for cand in \
  /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.11 \
  /usr/local/bin/python3.13 /usr/local/bin/python3.12 /usr/local/bin/python3.11 \
  /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 \
  /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 \
  /Library/Frameworks/Python.framework/Versions/3.11/bin/python3 \
  python3.13 python3.12 python3.11 python3.10 python3
do
  path="$(command -v "$cand" 2>/dev/null)" || continue
  [ -n "$path" ] || continue
  "$path" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null || continue
  PY_BIN="$path"
  break
done

if [ -z "$PY_BIN" ]; then
  say "No Python $MIN or newer found on this Mac."
  say "(\`python3\` here is $(python3 --version 2>&1 | awk '{print $2}'), which macOS ships and is too old.)"
  say ""
  say "Install one, then double-click this file again:"
  say ""
  say "  EASIEST — no Terminal needed:"
  say "    https://www.python.org/downloads/macos/"
  say "    download the latest 3.12 or 3.13 installer, open the .pkg, click through."
  say ""
  say "  OR, if you have Homebrew:"
  say "    brew install python@3.12"
  say ""
  exit 1
fi

say "using  $PY_BIN  ($("$PY_BIN" --version 2>&1 | awk '{print $2}'))"
say ""

# --- build it ------------------------------------------------------------
rm -rf "$VENV"
mkdir -p "$(dirname "$VENV")" || exit 1
"$PY_BIN" -m venv "$VENV" || { say ""; say "Could not create the environment at $VENV"; exit 1; }

say "installing dependencies (a few minutes the first time)…"
say ""
# Offline first, when bridge/wheels/ was brought along (the Releases zip,
# built by bridge/fetch_wheels.sh): the exact versions of a known-good
# environment, with pip barred from the network. The zip carries its own copy
# of the lock file, so wheels and versions can't drift apart even if the
# repo's lock has moved on since. Wheels are per Python version and chip, so
# this can miss on a Mac unlike the one that fetched them — then fall through
# to the normal online install rather than give up.
INSTALLED=""
LOCK="bridge/wheels/requirements.lock.txt"
[ -f "$LOCK" ] || LOCK="bridge/requirements.lock.txt"
if ls bridge/wheels/*.whl >/dev/null 2>&1; then
  say "found bridge/wheels — installing offline…"
  if "$VENV/bin/python" -m pip install --quiet --no-index \
       --find-links bridge/wheels -r "$LOCK"; then
    INSTALLED=1
  else
    say ""
    say "The offline packages don't fit this Mac/Python — trying online instead."
    say ""
  fi
fi
# pip itself first: the pip bundled with an older interpreter can fail to
# resolve current wheels at all.
[ -n "$INSTALLED" ] || "$VENV/bin/python" -m pip install --quiet --upgrade pip || true
if [ -z "$INSTALLED" ] && ! "$VENV/bin/python" -m pip install -r "$REQS"; then
  say ""
  rule
  say "The dependency install FAILED — read the error above."
  say "Nothing will run until it succeeds; do not try to start the piece yet."
  exit 1
fi

# --- prove it, rather than assume ----------------------------------------
say ""
say "checking the imports the bridge actually needs…"
if ! "$VENV/bin/python" - <<'PY'
import aiohttp, numpy, cv2
from pupil_labs.realtime_api import Device, receive_gaze_data, receive_video_frames
from pupil_labs.real_time_screen_gaze.gaze_mapper import GazeMapper
print("  all good:", "aiohttp", aiohttp.__version__, "| cv2", cv2.__version__)
PY
then
  say ""
  say "Installed, but the imports failed — the bridge will not run. Error above."
  exit 1
fi

rule
say "Done."
say ""
desktop_shortcut
say "Start the piece by double-clicking:  Start PetrifEye.command"
say "or from Terminal:"
say "  cd \"$(pwd)\""
say "  $VENV/bin/python bridge/start_multiplayer.py"
say ""
say "You may see an 'objc[...] Class AVFFrameReceiver is implemented in both'"
say "warning on startup. It is harmless — see bridge/requirements.txt."
say ""
