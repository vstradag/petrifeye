#!/bin/bash
# PetrifEye — install, or update, with one line in Terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/vstradag/petrifeye/main/install.sh | bash
#
# Everything a fresh Mac lacks, in order, each step skipped when it is already
# done — so the same line installs the first time and updates afterwards:
#
#   1. Python 3.10+   reused if there is one; otherwise 3.12 from Homebrew (when
#                     Homebrew is there) or from python.org's signed installer,
#                     which asks for the Mac's password once
#   2. the project    into ~/petrifeye — a download, so no git or Apple
#                     developer tools are needed; a git checkout is pulled instead
#   3. the bridge     its Python environment and dependencies, checked by
#                     importing them, plus the Desktop shortcuts
#                     (Setup PetrifEye.command does this part, as it always has)
#   4. Chrome         offered if missing: the piece is set up and tested in it
#
# Options, as environment variables in front of `bash`:
#   PETRIFEYE_DIR=/path     install somewhere other than ~/petrifeye
#   MEDUSA_VENV=/path       the bridge environment (default ~/dev/medusa-bridge-venv)
#   PETRIFEYE_BRANCH=name   a branch other than main
#   PETRIFEYE_NO_START=1    do not offer to start it at the end
#   PETRIFEYE_YES=1         answer every question with its default (unattended)
#   PETRIFEYE_PYTHON_DRYRUN=1  fetch and verify the Python installer, do not run it
#   PETRIFEYE_NO_GIT=1      download the project even if git is available

set -u

REPO="vstradag/petrifeye"
BRANCH="${PETRIFEYE_BRANCH:-main}"
DEST="${PETRIFEYE_DIR:-$HOME/petrifeye}"
VENV="${MEDUSA_VENV:-$HOME/dev/medusa-bridge-venv}"
# The last 3.12 with a macOS installer — the same minor version as the
# environment the piece has been run on, for every Mac since macOS 11, Apple
# Silicon and Intel alike.
PY_VER="3.12.10"
PY_PKG_URL="https://www.python.org/ftp/python/$PY_VER/python-$PY_VER-macos11.pkg"
CHROME_DMG_URL="https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
say()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*"; exit 1; }

# Piped through `curl | bash`, this script IS standard input, so questions are
# read from the terminal itself. With no terminal, or PETRIFEYE_YES, the
# default answer is taken.
ask() {   # $1 question, $2 default y|n  → returns 0 for yes
  local def="$2" ans=""
  if [ -n "${PETRIFEYE_YES:-}" ] || ! [ -r /dev/tty ]; then ans="$def"
  else
    printf '\n%s [%s] ' "$1" "$([ "$def" = y ] && echo Y/n || echo y/N)" > /dev/tty
    read -r ans < /dev/tty || ans="$def"
    ans="${ans:-$def}"
  fi
  case "$ans" in [yY]*) return 0 ;; *) return 1 ;; esac
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/petrifeye-install.XXXXXX")" || die "Cannot make a temporary folder."
trap 'rm -rf "$TMP"' EXIT

printf '\n\033[1mPETRIF\033[31mEYE\033[0m\033[1m — install\033[0m\n'
say "project      $DEST"
say "environment  $VENV"

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. (The webcam-only version runs anywhere: see README.md.)"
say "this Mac     macOS $(sw_vers -productVersion), $(uname -m)"
curl -fsI --max-time 15 "https://github.com" >/dev/null 2>&1 || die "No internet connection. Installing needs one (running the piece afterwards does not)."

# Synced folders hang imports and corrupt environments (README: "Never put
# the venv inside a Google Drive / Dropbox / iCloud folder"). Matched by where
# sync clients actually serve files from — not by a word in the path, which
# also caught ordinary folders that merely had "Dropbox" or "Drive" in a name.
synced() {
  case "$1/" in
    "$HOME/Library/CloudStorage/"*|*"/Library/Mobile Documents/"*|"$HOME/Dropbox/"*|"$HOME/Dropbox ("*|\
    "/Volumes/GoogleDrive/"*|*"/Google Drive/"*) return 0 ;;
  esac
  return 1
}
for p in "$DEST" "$VENV"; do
  synced "$p" && die "$p is inside a synced folder (Drive/Dropbox/iCloud). Choose a local folder, e.g. PETRIFEYE_DIR=\$HOME/petrifeye"
done

# ------------------------------------------------------------------ Python
bold "1 · Python"
find_python() {
  local cand path
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
    # Asked, never assumed: macOS's own python3 is 3.9, too old. And asking
    # Apple's stub /usr/bin/python3 without the developer tools would open an
    # install dialog, so it only counts when the tools are actually there.
    if [ "$path" = /usr/bin/python3 ] && ! xcode-select -p >/dev/null 2>&1; then continue; fi
    "$path" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null || continue
    printf '%s' "$path"; return 0
  done
  return 1
}

if PY="$(find_python)"; then
  ok "Python $("$PY" --version 2>&1 | awk '{print $2}') — $PY"
else
  say "  No Python 3.10 or newer on this Mac (macOS's own is too old)."
  if command -v brew >/dev/null 2>&1; then
    say "  Installing Python 3.12 with Homebrew…"
    brew install python@3.12 || die "Homebrew could not install Python 3.12 (error above)."
  else
    say "  Installing Python $PY_VER from python.org — the official installer, ~45 MB."
    curl -fL --progress-bar -o "$TMP/python.pkg" "$PY_PKG_URL" || die "Could not download $PY_PKG_URL"
    # Only a package signed by the Python Software Foundation is installed.
    if ! pkgutil --check-signature "$TMP/python.pkg" 2>/dev/null | grep -q "Python Software Foundation"; then
      die "The downloaded Python installer is not signed by the Python Software Foundation — not installing it."
    fi
    ok "installer signed by the Python Software Foundation"
    if [ -n "${PETRIFEYE_PYTHON_DRYRUN:-}" ]; then
      die "PETRIFEYE_PYTHON_DRYRUN: verified, not installed. Stopping here."
    fi
    say "  macOS will ask for this Mac's password to install it (nothing is shown as you type)."
    sudo installer -pkg "$TMP/python.pkg" -target / || die "Python was not installed (error above)."
    # python.org's Python brings its own certificate bundle step; run it so
    # anything that fetches over HTTPS from Python works.
    CERTS="/Applications/Python 3.12/Install Certificates.command"
    [ -f "$CERTS" ] && bash "$CERTS" >/dev/null 2>&1 || true
  fi
  PY="$(find_python)" || die "Python was installed but cannot be found. Open a new Terminal window and run this line again."
  ok "Python $("$PY" --version 2>&1 | awk '{print $2}') — $PY"
fi

# ------------------------------------------------------------------ the project
bold "2 · The project"
has_git() {
  [ -z "${PETRIFEYE_NO_GIT:-}" ] || return 1
  # `git` on a Mac without the developer tools is a stub that opens an install
  # dialog — so it only counts when the tools are really there.
  xcode-select -p >/dev/null 2>&1 && git --version >/dev/null 2>&1
}

download_project() {   # → unpacked project in $TMP/src
  local zip="$TMP/petrifeye.zip"
  curl -fL --progress-bar -o "$zip" "https://codeload.github.com/$REPO/zip/refs/heads/$BRANCH" \
    || die "Could not download the project from GitHub."
  mkdir -p "$TMP/unzip" && unzip -q "$zip" -d "$TMP/unzip" || die "The download is damaged — run this line again."
  mv "$TMP/unzip"/*/ "$TMP/src" || die "Unexpected download layout."
}

if [ -d "$DEST/.git" ] && has_git; then
  say "  Updating the git checkout…"
  if git -C "$DEST" pull --ff-only --quiet; then ok "up to date: $(git -C "$DEST" log -1 --format='%h %s' | cut -c1-70)"
  else warn "could not update it (local changes?) — keeping the version that is there"; fi
elif [ -e "$DEST" ] && [ ! -f "$DEST/Setup PetrifEye.command" ]; then
  die "$DEST exists but is not PetrifEye. Move it away, or install elsewhere with PETRIFEYE_DIR=/path."
elif [ -d "$DEST" ]; then
  say "  Updating to the latest version…"
  [ -d "$DEST/.git" ] && warn "a git checkout, but git is not usable here — updating the files directly (git will show them as changed)"
  download_project
  # Replaced file by file. Kept: the local certificate, the offline packages
  # and anything else the piece made for itself in the folder.
  rsync -a --delete --exclude ".git/" --exclude ".certs/" --exclude "bridge/wheels/" --exclude "bridge/.venv/" \
    --exclude "games/magnetic-poetry/voice/_audition/" --exclude ".DS_Store" \
    "$TMP/src/" "$DEST/" || die "Could not update $DEST."
  ok "updated in $DEST"
elif has_git; then
  say "  Downloading with git…"
  git clone --quiet --branch "$BRANCH" "https://github.com/$REPO.git" "$DEST" || die "git clone failed (error above)."
  ok "in $DEST"
else
  say "  Downloading…"
  download_project
  mkdir -p "$(dirname "$DEST")" && mv "$TMP/src" "$DEST" || die "Could not create $DEST."
  ok "in $DEST"
fi
# Nothing downloaded with curl is quarantined, but a folder dragged in from a
# browser download may be — lift it so every .command opens with a double-click.
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
chmod +x "$DEST"/*.command 2>/dev/null || true

# ------------------------------------------------------------------ the bridge
bold "3 · The eye-tracker bridge"
# Setup chooses its interpreter the same way; pointing PATH at the one found
# above makes sure a Python installed a minute ago is seen.
PATH="$(dirname "$PY"):$PATH" MEDUSA_VENV="$VENV" bash "$DEST/Setup PetrifEye.command" \
  || die "Setup did not finish (error above). Run this line again; if it repeats, send the messages above."

# ------------------------------------------------------------------ Chrome
bold "4 · Browser"
if [ -d "/Applications/Google Chrome.app" ] || [ -d "$HOME/Applications/Google Chrome.app" ]; then
  ok "Google Chrome"
else
  say "  Google Chrome is not installed. The piece is set up and tested in Chrome"
  say "  (other browsers can refuse the local connection to the glasses)."
  if ask "  Install Google Chrome now?" y; then
    curl -fL --progress-bar -o "$TMP/chrome.dmg" "$CHROME_DMG_URL" || die "Could not download Chrome."
    MNT="$(hdiutil attach -nobrowse -noverify -readonly "$TMP/chrome.dmg" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)"
    [ -d "$MNT/Google Chrome.app" ] || die "The Chrome download did not contain Chrome."
    codesign --verify --deep --strict "$MNT/Google Chrome.app" 2>/dev/null \
      && codesign -dv "$MNT/Google Chrome.app" 2>&1 | grep -q "EQHXZ8M8AV" \
      || { hdiutil detach -quiet "$MNT"; die "That Chrome is not signed by Google — not installing it."; }
    APPS="/Applications"; [ -w "$APPS" ] || APPS="$HOME/Applications"; mkdir -p "$APPS"
    cp -R "$MNT/Google Chrome.app" "$APPS/" || { hdiutil detach -quiet "$MNT"; die "Could not copy Chrome to $APPS."; }
    hdiutil detach -quiet "$MNT"
    ok "Google Chrome, in $APPS"
  else
    warn "skipped — the piece will open in your default browser"
  fi
fi

# ------------------------------------------------------------------ done
bold "Done."
say "  Start it any time by double-clicking  PetrifEye  on the Desktop"
say "  (or  PetrifEye Frame  for no tags on screen)."
say "  To update later, run the same line again — or double-click"
say "  Update PetrifEye.command  in $DEST."
say ""
say "  Before starting with the glasses: phones and this Mac on the same Wi-Fi"
say "  (a hotspot, not eduroam), Neon Companion open with the glasses plugged in."
if [ -z "${PETRIFEYE_NO_START:-}" ] && ask "Start PetrifEye now?" n; then
  exec bash "$DEST/Start PetrifEye.command" < /dev/tty
fi
