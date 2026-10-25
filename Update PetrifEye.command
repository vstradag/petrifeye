#!/bin/bash
# Double-clickable: bring PetrifEye up to date — the latest version from
# GitHub, and anything new it needs installed. The same as running the
# one-line installer again (install.sh, next to this file), for this folder.
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
PETRIFEYE_DIR="$(pwd)" bash ./install.sh
STATUS=$?
echo
[ $STATUS -eq 0 ] || echo "The update stopped (status $STATUS) — see the messages above."
read -r -p "Press return to close."
