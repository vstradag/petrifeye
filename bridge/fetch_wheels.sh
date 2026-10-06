#!/bin/bash
# Builds the offline-install zip for the GitHub Releases page: every package in
# requirements.lock.txt, downloaded into bridge/wheels/ and zipped as
#   bridge/petrifeye-offline-packages-macos-arm64.zip
# Upload that zip to a release. Someone setting up a Mac with no internet
# unzips it into bridge/, and Setup PetrifEye.command installs from it.
# Neither the folder nor the zip goes in git (~190 MB).
#
# Wheels are built per Python version and per Mac chip, so this fetches for
# Apple Silicon, macOS 14+, Python 3.12 and 3.13 — the two the setup script
# recommends installing. A Mac that differs (Intel, older macOS, Python 3.10
# or 3.11) gets no match; the setup script then falls back to the online
# install. To add one, append it to PYTHONS / PLATFORM below and rerun.

set -eu
cd "$(dirname "$0")"

PYTHONS="3.12 3.13"
PLATFORM="macosx_14_0_arm64"
ZIP="petrifeye-offline-packages-macos-arm64.zip"
# The bridge venv's pip if there is one: stock `python3` is 3.9 with an old
# pip. Which Python runs pip doesn't matter — --python-version decides.
VENV="${MEDUSA_VENV:-$HOME/dev/medusa-bridge-venv}"
if [ -x "$VENV/bin/python" ]; then
  PIP="${PIP:-$VENV/bin/python -m pip}"
else
  PIP="${PIP:-python3 -m pip}"
fi

# From empty: wheels left over from an older lock would otherwise ride along
# in the zip forever.
rm -rf wheels "$ZIP"
mkdir wheels
for v in $PYTHONS; do
  echo "fetching for Python $v ($PLATFORM)…"
  $PIP download --quiet --only-binary=:all: \
    --platform "$PLATFORM" --python-version "$v" --implementation cp \
    -d wheels -r requirements.lock.txt
done
# The lock travels inside the zip, so the setup script installs exactly the
# versions these wheels are, even after the repo's lock has moved on.
cp requirements.lock.txt wheels/
zip -qr "$ZIP" wheels
echo "done: $(ls wheels/*.whl | wc -l | tr -d ' ') packages -> bridge/$ZIP ($(du -h "$ZIP" | cut -f1))"
