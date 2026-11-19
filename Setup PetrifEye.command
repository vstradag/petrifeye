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

# A double-clickable shortcut on the Desktop, so after the first run nobody has
# to dig the project folder out again:
#   PetrifEye.command  -> Start PetrifEye.command
# One is enough: every experience asks at its start whether to find the screen
# by the AprilTags or by the purple frame. (A second, PetrifEye Frame, only
# changed which answer was offered first; Frame PetrifEye.command still does
# that, from the project folder.)
# Not a symlink: Start finds the project from its own path, which through a
# link would be the Desktop. It is a tiny script that runs the real one.
# Rewritten on every setup, so running Setup from a moved project re-points
# it. Opt out with MEDUSA_NO_SHORTCUT=1.
SHORTCUT_MARK='# Shortcut made by Setup PetrifEye.command. Safe to delete.'
one_shortcut() {   # $1 shortcut name, $2 launcher in the project
  local link="$DESK/$1"
  local target
  target="$(pwd)/$2"
  {
    printf '#!/bin/bash\n'
    printf '%s\n' "$SHORTCUT_MARK"
    printf 'TARGET=%q\n' "$target"
    printf '%s\n' \
      'if [ -f "$TARGET" ]; then exec bash "$TARGET"; fi' \
      'echo "PetrifEye is no longer at:"' \
      'echo "  $TARGET"' \
      'echo "Open the project where it is now and double-click Setup PetrifEye.command"' \
      'echo "there - that puts a working shortcut back on the Desktop."' \
      'read -r -p "Press return to close."'
  } > "$link" && chmod +x "$link" \
    && say "Desktop shortcut:  $link"
}

desktop_shortcut() {
  [ -z "${MEDUSA_NO_SHORTCUT:-}" ] || return 0
  DESK="${MEDUSA_DESKTOP:-$HOME/Desktop}"
  [ -d "$DESK" ] || return 0
  one_shortcut "PetrifEye.command" "Start PetrifEye.command"
  say "  each experience asks whether to use the AprilTags or the purple frame"
  # The second shortcut earlier versions made. Removed only when it is ours —
  # it carries the mark — never a file of the same name someone made.
  local old="$DESK/PetrifEye Frame.command"
  if [ -f "$old" ] && grep -qxF "$SHORTCUT_MARK" "$old"; then
    rm -f "$old" && say "Removed the old shortcut:  $old"
  fi
}

# A project downloaded as a zip in a browser is QUARANTINED: macOS then
# refuses to open each unsigned .command by double-click until it has been
# allowed one by one. Getting this script open was that once; lifting the
# flag from the rest of the project here means Start, Frame and Record open
# normally from now on. A git clone carries no flag, so this does nothing.
unquarantine() {
  # Listed rather than probed with `xattr -p`, which fails as soon as ONE file
  # lacks the flag; and the delete's exit status is ignored for the same reason.
  if xattr -lr . 2>/dev/null | grep -q com.apple.quarantine; then
    xattr -dr com.apple.quarantine . 2>/dev/null
    say "Lifted the download quarantine from the project folder."
  fi
}

# What the bridge needs, proved by importing it — the one list that decides
# whether an environment is complete, and checks a fresh one. A package added
# to requirements.txt goes here too, or a computer set up before it was added
# counts as "already set up" and never gets it (bleak, for the instax printer,
# was the first to slip through that way).
# CORE is what the eye tracking needs; the rest only the instax printing.
CORE='
import sys
assert sys.version_info >= (3, 10)
import aiohttp, numpy, cv2
from pupil_labs.realtime_api import Device, receive_gaze_data, receive_video_frames
from pupil_labs.real_time_screen_gaze.gaze_mapper import GazeMapper
'
NEEDS="$CORE
import PIL, bleak, bleak.backends.corebluetooth.scanner
"
works() { "$1" -c "$NEEDS" 2>/dev/null; }

# Offline first, when bridge/wheels/ was brought along (the Releases zip,
# built by bridge/fetch_wheels.sh): the exact versions of a known-good
# environment, with pip barred from the network. The zip carries its own copy
# of the lock file, so wheels and versions can't drift apart even if the
# repo's lock has moved on since. Wheels are per Python version and chip, and
# an older zip may lack a newer package, so this can fall short — then the
# normal online install, rather than giving up.
LOCK="bridge/wheels/requirements.lock.txt"
[ -f "$LOCK" ] || LOCK="bridge/requirements.lock.txt"
install_reqs() {
  if ls bridge/wheels/*.whl >/dev/null 2>&1; then
    say "found bridge/wheels — installing offline…"
    if "$VENV/bin/python" -m pip install --quiet --no-index \
         --find-links bridge/wheels -r "$LOCK" && works "$VENV/bin/python"; then
      return 0
    fi
    say ""
    say "The offline packages don't cover this Mac/Python — trying online instead."
    say ""
  fi
  # pip itself first: the pip bundled with an older interpreter can fail to
  # resolve current wheels at all.
  "$VENV/bin/python" -m pip install --quiet --upgrade pip || true
  "$VENV/bin/python" -m pip install -r "$REQS"
}

# The instax printer prints over Bluetooth, and macOS asks once whether the
# app running the piece (Terminal) may use it. Asked here, while someone is
# setting up, rather than in the middle of an exhibition. Never fatal: only
# the instax printing needs it.
bluetooth_check() {
  [ -z "${MEDUSA_NO_BLUETOOTH:-}" ] || return 0
  say ""
  say "The instax printer prints over Bluetooth. Checking that macOS allows it —"
  say "if macOS asks whether Terminal may use Bluetooth, click Allow."
  local out rc
  out="$("$VENV/bin/python" -I bridge/instax.py bluetooth 2>/dev/null)"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    say "  $out"
  elif [ "$rc" -eq 134 ] || [ "$rc" -eq 6 ]; then
    say "  macOS does not let the app running this setup use Bluetooth."
    say "  Start the piece from Terminal (the Desktop shortcut does) and allow it there."
  else
    say "  ${out:-the Bluetooth check failed}"
    say "  Only printing on the instax needs Bluetooth; everything else works without it."
  fi
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
# Only now, inside what is certainly the project folder.
unquarantine

# The venv must not live inside the project when the project is in Google
# Drive: Drive serves those files through a virtual filesystem, and when it
# stalls an `import` blocks FOREVER instead of failing — indistinguishable
# from the bridge hanging. Refuse rather than build something that will
# mystify someone later.
# Matched by where sync clients serve files from, not by a word anywhere in
# the path — that also refused ordinary folders with "Drive" in their name.
case "$VENV/" in
  "$HOME/Library/CloudStorage/"*|*"/Library/Mobile Documents/"*|"$HOME/Dropbox/"*|"$HOME/Dropbox ("*|\
  "/Volumes/GoogleDrive/"*|*"/Google Drive/"*)
    say "REFUSING: that path is inside a synced folder (Drive/Dropbox/iCloud)."
    say "An import from there can hang forever instead of failing."
    say "Use a local path, e.g.  MEDUSA_VENV=\$HOME/dev/medusa-bridge-venv"
    exit 1 ;;
esac

# --- is it already set up? ------------------------------------------------
if [ -x "$VENV/bin/python" ]; then
  if works "$VENV/bin/python"; then
    say "Already set up — $("$VENV/bin/python" --version 2>&1) with everything it needs."
    bluetooth_check
    say ""
    say "Start the piece with:"
    say "  \"$(pwd)/Start PetrifEye.command\""
    say "or:"
    say "  $VENV/bin/python bridge/start_multiplayer.py"
    say ""
    desktop_shortcut
    exit 0
  fi
  # A working environment that only lacks what was added since it was made
  # (an update) gets just that, in a minute, instead of a rebuild.
  if "$VENV/bin/python" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    say "The environment is missing packages added since it was made — adding them…"
    say ""
    if install_reqs && works "$VENV/bin/python"; then
      say ""
      say "Added — $("$VENV/bin/python" --version 2>&1) with everything it needs."
      bluetooth_check
      say ""
      desktop_shortcut
      exit 0
    fi
    # Never throw away an environment that still runs the piece: offline, a
    # rebuild could not be reinstalled, and the venue would be left with none.
    if "$VENV/bin/python" -c "$CORE" 2>/dev/null; then
      say ""
      say "Could not add them (no internet?). The environment is kept as it is:"
      say "everything works except printing on the instax. Run this again online."
      exit 1
    fi
    say ""
    say "Adding them did not work, and the environment is broken — rebuilding it."
  else
    say "An environment exists but is too old — rebuilding it."
  fi
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
if ! install_reqs; then
  say ""
  rule
  say "The dependency install FAILED — read the error above."
  say "Nothing will run until it succeeds; do not try to start the piece yet."
  exit 1
fi

# --- prove it, rather than assume ----------------------------------------
say ""
say "checking the imports the bridge actually needs…"
if ! "$VENV/bin/python" -c "$NEEDS
print('  all good:', 'aiohttp', aiohttp.__version__, '| cv2', cv2.__version__, '| bleak', __import__('importlib.metadata').metadata.version('bleak'))"
then
  say ""
  say "Installed, but the imports failed — the bridge will not run. Error above."
  exit 1
fi
bluetooth_check

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
