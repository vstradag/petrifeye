#!/bin/bash
# Double-clickable: the piece exactly as Start PetrifEye.command runs it, plus
# a test recording, for working out whether the AprilTags can be replaced.
#
#   - an experimental bright frame is drawn around the screen edge, ALONGSIDE
#     the tags (the tags stay on: they are the reference the frame is scored
#     against)
#   - each bridge records the scene video, gaze, detected tags and screen
#     position into ~/petrifeye-recordings/<date-time>-port<N>/
#
# Play normally — look around, move your head, lean in and out, look away and
# back. A few minutes per experience is plenty. Stop with ctrl-c in this
# window (or close it); the recording is finalised on the way out.
#
# Recordings are ~90 MB a minute per pair of glasses. They stay on this Mac
# and are not part of the project folder or git.

cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
exec bash "Start PetrifEye.command" --record --frame-px 10 "$@"
