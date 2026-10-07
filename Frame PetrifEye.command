#!/bin/bash
# Double-clickable: the piece with NO AprilTags on screen. The screen is
# located by the thin bright frame drawn around its edge instead
# (EXPERIMENTAL — see bridge/frame_detector.py).
#
# If gaze misbehaves, quit (ctrl-c) and use Start PetrifEye.command, which
# uses the tags as always. To compare the two on real data, use
# Record PetrifEye.command instead: tags AND frame, with a recording.
#
# Extra options pass through, e.g. a thicker or differently coloured frame:
#   "Frame PetrifEye.command" --frame-px 14 --frame-color '#00ffff'

cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
exec bash "Start PetrifEye.command" --surface-source frame "$@"
