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
