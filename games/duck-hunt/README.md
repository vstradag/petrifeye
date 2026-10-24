# Duck Hunt — where it comes from

The game here is **DuckHunt-JS** by Matt Surabian, MIT licensed (see `LICENSE`):
<https://github.com/MattSurabian/DuckHunt-JS>, imported at commit
`5a28db7442ebc7dc8060342413df24c0319f4190`. The sprites and sound
(`sprites.*`, `audio.*`) are upstream's, unchanged.

`source/` is upstream's source with small changes, each marked `PetrifEye` in
a comment:

- **No click to shoot** (`clickToShoot: false`). The page shoots a specific duck
  with `game.shootDuck(duck)` once both players are looking at it, and reads
  where the ducks are with `game.duckTargets()` (screen pixels).
- **Starts when told** (`autoStart: false`, `begin()`), and **restarts in place**
  (`restart()`) — upstream's "play again" reloads the page, which would drop
  the bridges and the webcam calibration.
- **Nothing under the AprilTags**: the HUD moved from the corners to the middle
  of the top and bottom edges, the corner links are off (`links: false`), and a
  duck never picks a destination under a tag (`Stage.isBlocked`, fed by the page).
- **Slower ducks** (`pace`, 0.5 = half the original speed on every level, set
  live in the settings panel): two people have to find and follow the same duck
  by eye.
- The page owns the keyboard (`keys: false`); `?sim` no longer counts as a
  level-creator URL; audio is found relative to this folder (`assetBase`).

## Rebuilding

The built `duckhunt.js` and `chunks/` are committed, so running the piece needs
no Node. Only after editing `source/`:

```bash
cd games/duck-hunt/source
npm ci
npx webpack        # writes ../duckhunt.js and ../chunks/
```

`node_modules/` is gitignored. The level creator and the gulp sprite/audio
tooling from upstream were left out.
