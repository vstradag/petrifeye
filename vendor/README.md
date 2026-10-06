# Vendored dependencies

## kaplay.js — v3001.0.19
[KAPLAY](https://kaplayjs.com/) (MIT), the maintained successor to Kaboom.js.
Powers the platformer in `games/`.

Vendored rather than loaded from a CDN on purpose: this runs as an
installation, and a game that dies because a CDN is unreachable is not
acceptable. Update with:

    curl -L -o vendor/kaplay.js \
      https://cdn.jsdelivr.net/npm/kaplay@<version>/dist/kaplay.js

Exposes `window.kaplay`.

## p5.min.js — v1.11.3
[p5.js](https://p5js.org/) (LGPL-2.1). Draws every game page except the
platformer. Vendored for the same reason as kaplay. Update with:

    curl -L -o vendor/p5.min.js \
      https://cdn.jsdelivr.net/npm/p5@<version>/lib/p5.min.js

## webgazer.js — Brown copy, Last-Modified 2026-02-24
[WebGazer.js](https://webgazer.cs.brown.edu/) (GPLv3; LGPLv3 for companies
valued under $1M). Webcam eye tracking. Taken from the Brown site the pages
used to load it from (unversioned there; npm's latest at the time was 3.5.3).
It still downloads its MediaPipe face-mesh model at runtime — see
`faceMeshSolutionPath` in `shared/gaze/webgazer-source.js`. Update with:

    curl -L -o vendor/webgazer.js https://webgazer.cs.brown.edu/webgazer.js

## mediapipe/face_mesh/ — @mediapipe/face_mesh 0.4.1633559619
[MediaPipe Face Mesh](https://www.npmjs.com/package/@mediapipe/face_mesh)
(Apache-2.0). The model WebGazer runs at startup; `webgazer-source.js` points
`faceMeshSolutionPath` here. The version MUST match the face_mesh code
bundled inside webgazer.js — check with
`grep -oE "16[0-9]{8}" vendor/webgazer.js` — so if you update webgazer.js,
re-check this. Update with:

    V=0.4.1633559619
    for f in face_mesh.binarypb face_mesh.js \
             face_mesh_solution_packed_assets.data \
             face_mesh_solution_packed_assets_loader.js \
             face_mesh_solution_simd_wasm_bin.data \
             face_mesh_solution_simd_wasm_bin.js \
             face_mesh_solution_simd_wasm_bin.wasm \
             face_mesh_solution_wasm_bin.js \
             face_mesh_solution_wasm_bin.wasm package.json; do
      curl -L -o vendor/mediapipe/face_mesh/$f \
        https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@$V/$f
    done
