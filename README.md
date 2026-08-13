# PetrifEye

A "stone gaze" prototype: blob-eyes drift across a fur field, and staring
at one for a couple of seconds turns it to stone. Eye position is driven
by real webcam gaze tracking via [WebGazer.js](https://webgazer.cs.brown.edu/),
falling back to the mouse if the camera is unavailable or declined.

This folder is standalone — no dependency on anything outside it. Clone or
unzip just this directory and it runs.

**Live demo:** [box.cunicode.com/petrifeye](https://box.cunicode.com/petrifeye/)
(updated by manual zip upload, not auto-deployed from this repo — may lag
behind the latest commit).

## Running it locally

WebGazer requires a secure context (HTTPS) — plain `http://` won't work,
even on `localhost` in some browsers. A zero-dependency HTTPS static
server is included:

```bash
node serve-https.js        # defaults to port 8443
open https://localhost:8443/
```

You'll need a local TLS cert first. Easiest path is
[mkcert](https://github.com/FiloSottile/mkcert):

```bash
brew install mkcert          # or see the mkcert README for your OS
mkcert -install               # trusts a local CA in your system/browser
mkdir .certs
mkcert -key-file .certs/key.pem -cert-file .certs/cert.pem localhost 127.0.0.1 ::1
```

`.certs/` is gitignored — regenerate it locally, don't commit it. To test
from another device on the same LAN, regenerate the cert with that
device's target IP included (`mkcert ... 192.168.x.x`) and note that the
other device won't trust your machine's local CA — it'll show a cert
warning that's safe to click through.

## Two inputs: webcam or Pupil Labs Neon

The boot screen offers a choice of tracker.

- **webcam** — WebGazer, zero setup, needs the 9-point click calibration.
  Served by `serve-https.js` as before.
- **neon glasses** — Pupil Labs Neon. Calibration-free, far more accurate,
  but needs a local Python bridge running.

**Guided setup for Neon: open [`setup-neon.html`](setup-neon.html)** — an
eight-step wizard that walks through the hardware, the phone, the network,
and the bridge one step at a time, and can actually test the connection and
marker visibility rather than just asserting they work.

```bash
python3 -m venv bridge/.venv
bridge/.venv/bin/python -m pip install -r bridge/requirements.txt
bridge/.venv/bin/python bridge/neon_bridge.py --screen-width 1920 --screen-height 1080
```

Run the bridge *instead of* `serve-https.js` — it serves the app itself, on
the same port and cert. A venv keeps these (opencv, pupil-apriltags, PyAV)
out of your system/conda Python; `bridge/.venv/` is disposable, delete and
recreate it freely.

Because the bridge serves both the page and the gaze socket on the **same
origin**, clicking through Chrome's self-signed-certificate warning once
covers both. That matters: a WebSocket to an untrusted cert fails *silently*,
with no prompt to click.

### Why Neon needs a bridge at all

Three things make a direct browser↔glasses connection impossible, not merely
awkward:

1. **Gaze arrives over RTSP.** Browsers have no RTSP support of any kind.
2. **Neon reports scene-camera coordinates, not screen coordinates.** It is
   head-mounted — it knows where you are looking inside its own forward
   camera's field of view, not where that lands on a monitor. Converting
   requires locating the screen with **AprilTag markers** and solving a
   homography; Pupil Labs' implementation
   ([`real-time-screen-gaze`](https://github.com/pupil-labs/real-time-screen-gaze))
   is Python-only.
3. **Mixed content.** The page must be HTTPS for the webcam path, and the
   Companion API is plain HTTP on the LAN.

`bridge/neon_bridge.py` does all three and hands finished **screen pixels** to
the page over a WebSocket. Because the bridge also *serves* the page, that
socket is same-origin — no mixed-content problem and no second certificate to
trust. `shared/gaze/neon-source.js` is then just another `GazeSource`, and
`sketch.js` never learns any of this happened.

### Getting the tags off the artwork

The surface is re-solved from the AprilTags every scene frame, so they have to
be visible whenever gaze is being mapped — and they must stay high-contrast,
since dimming them to blend in destroys detection. Three ways to live with
that, via `--marker-mode`:

| Mode | Tags on screen | Accuracy | Use for |
|---|---|---|---|
| `always` (default) | permanently | best | calibration, tuning |
| `flash` | ~14% of the time | softer under head movement | screening if on-screen is unavoidable |
| `off` | never | best, if printed large | **finished installation** |

`flash` works because the bridge caches the last surface solve for
`--surface-hold-ms` (2.5s default), so gaze keeps mapping through the dark
phase; the tags only need to reappear before that cache expires. The cost is
that head movement during the dark phase isn't tracked, so the mapping drifts
until the next pulse. Tune with `--flash-on-ms` / `--flash-period-ms`.

**For the finished piece, print the tags and mount them around the monitor
bezel, then run `--marker-mode off`.** Nothing touches the artwork, the tags
can be far larger (which is what detection actually wants), and accuracy is
better than any on-screen option. Fetch them from `/markers/0.png` … `3.png`
and edit `marker_verts()` so the coordinates match where you physically put
them — note those may fall *outside* the screen bounds, which is fine.

`--surface-hold-ms` also helps in `always` mode: it rides out blinks, motion
blur and brief head turns that would otherwise freeze the pointer for a frame.

## Architecture — the part that matters for swapping trackers

The eye-tracking pipeline is deliberately isolated into two layers so
WebGazer can be replaced later without touching the rest of the app:

- **`shared/gaze/webgazer-source.js`** / **`neon-source.js`** — the two
  tracker adapters. Each registers itself into `window.GazeSources` under a
  key the boot screen offers; `gaze-controller` picks one at selection time.
  `webgazer-source.js` is the *only* file that touches the global `webgazer`
  object, and `neon-source.js` the only one that knows the bridge exists.
  Both implement the same small `GazeSource` interface:
  ```
  GazeSource.start(onSample) -> Promise<void>
    Resolves once the camera/model is ready. Calls onSample({x, y}) in
    page pixel coordinates each time a new prediction arrives.
  GazeSource.stop() -> void
  GazeSource.recordCalibrationClick(x, y) -> void   (optional)
  GazeSource.needsClickCalibration -> bool
    false skips the 9-point click grid (Neon is calibration-free) while
    still running the look-only validation sweep.
  ```
  To add a tracker: write a new file registering into `window.GazeSources`
  with this same shape and add it to `index.html`. Nothing else in the
  codebase needs to know — the Neon integration touched no sketch code.

- **`shared/gaze/gaze-controller.js`** — library-agnostic. Drives the
  walk-up boot cinematic (black boot screen → fullscreen → full-screen
  face scan → zoom into the eyes → docked feed + red-dot calibration →
  "gaze link established" → game), smooths the raw gaze signal
  (exponential smoothing, see `SMOOTHING` — WebGazer's raw output is
  noisy; heavier smoothing trades responsiveness for stability), and
  feeds samples into `Tracking.setExternalPointers()`.

- **`shared/tracking.js`** — the pointer abstraction the actual sketch
  reads from. `Tracking.getPointers()` returns `[{id, x, y}, ...]`
  regardless of whether the source is gaze, mouse, or something else.
  `sketch.js` never imports WebGazer or gaze-controller directly.

- **`shared/attention.js`** — `AttentionArbiter`, the winner-take-all
  focus resolver. See "Accuracy" below; this is the piece that makes a
  ~40px target reachable with a ~175px-accurate signal.

- **`shared/dwell.js`** — generic "how long has a pointer been on this
  target" tracker (`DwellTarget`), used for the stare-to-petrify timing.
  Not gaze-specific. `decayPerSec` controls how fast accumulated dwell
  drains once contact is lost (default `Infinity` = instant reset, right
  for a mouse; the sketch passes a finite value for gaze).

- **`shared/fur-field.js`** — the background fur rendering/physics.
  Decorative, no coupling to tracking.

- **`sketch.js`** — the actual scene (p5.js). Reads `Tracking.getPointers()`
  and `DwellTarget`, knows nothing about WebGazer.

## Accuracy — the central problem, and what's done about it

Consumer webcam gaze estimation is inherently far less precise than a
mouse. WebGazer's own published evaluation reports **~175px mean error /
4.17° visual angle**, notably worse vertically (~141px) than horizontally
(~73px), and it **drifts from ~5cm to ~10cm over 20 minutes** because it
has no head-pose model at all.

That number is the whole design constraint here: a blob body is 28–46px.
Requiring the estimate to land *inside* the blob asks for 4–6× more
precision than the tracker can deliver, and no amount of smoothing or
image tuning closes that gap.

**Why "read the eyes more sharply" doesn't help.** WebGazer's actual
feature extraction is `resizeEye(eye, 10, 6)` → grayscale →
`equalizeHistogram(...)`: each eye becomes a **10×6 = 60-pixel grayscale
thumbnail**, both eyes concatenated into a 120-dim vector, mapped to
screen coordinates by *linear ridge regression*. It already
histogram-equalizes, and a better camera or sharper image is discarded by
that downsample. The features are raw pixel intensities containing no
explicit iris position and no head pose — which is exactly why it holds
up right after calibration and falls apart when you shift in your seat.

So the accuracy work is in three layers, none of which is "tune the
image":

1. **Winner-take-all attention** (`shared/attention.js`). Rather than
   asking each blob "is the pointer inside me?", the arbiter asks the
   pointer "of everything nearby, which are you most likely looking at?"
   and awards exactly one. This turns an *absolute* accuracy problem into
   a *relative* one — the estimate only has to be nearer the intended
   blob than any other, which is a far easier bar with sparse targets.
   `switchMargin` makes the current pick sticky so jitter can't flicker
   the lock between two similar-distance blobs.

2. **Affine correction from a held-out validation sweep**
   (`gaze-controller.js`). A large share of WebGazer's error is
   *systematic* — wrong gain and constant offset, worse in Y than X — and
   a per-axis least-squares fit removes exactly that. The fit cannot come
   from the calibration clicks (the regression was just trained on them,
   so its residual there is ~0 and the fit would learn nothing), so after
   the click grid there's a short **look-only sweep over 5 fresh points**.
   That residual is real generalisation error, so it both fits the
   correction and produces the only honest accuracy number in the system
   — which is what the `±NNNPX` readout shows and what the sketch uses to
   size its assist radius. Guards reject a degenerate or implausible fit
   (non-positive or out-of-range gain, frozen tracker, <3 usable nodes)
   and keep identity rather than ship something inverted.

3. **Dwell decay instead of instant reset** (`shared/dwell.js`). A webcam
   estimate drops out for a frame or two constantly; zeroing progress on
   every blip means a visitor who stares steadily for 1.9 of the required
   2.0 seconds can never actually finish. Progress now drains at a finite
   rate, so brief noise is survivable while a deliberate look-away still
   releases the target in about a second.

`SMOOTHING` in `gaze-controller.js` (0.8) remains the lever for trading
shake against latency, but it is a lowpass filter, not an accuracy fix —
the ceiling underneath it is set by the 10×6 feature vector above.

### If you want to go further

The tracker itself is the remaining bottleneck, and the `GazeSource`
interface exists precisely so it can be replaced.
[WebEyeTrack](https://github.com/RedForestAi/WebEyeTrack) (MIT, npm
`webeyetrack`) is the strongest current candidate: 2.32cm on GazeCapture,
explicit head-pose modelling (only ~20% drift over 20min vs WebGazer's
49%), inference in a Web Worker so it stops competing with the p5 render
loop, and free blink detection. Its API maps almost 1:1 onto
`GazeSource` — `initialize()`→`start()`, `onGazeResults`→`onSample`,
`handleClick(x,y)`→`recordCalibrationClick(x,y)` — and its few-shot
personalization wants k≤9 samples, which the existing 3×3 grid already
provides. Caveat: it was v0.0.2 at time of writing, so keep
`webgazer-source.js` around as the fallback.

## Keyboard shortcuts (in the running scene)

| Key | Action |
|---|---|
| `f` | Toggle the fur background (off by default) |
| `m` | Pause to mouse control (camera stops, but the trained model is kept — instant resume with `e`) |
| `e` | Resume gaze control (or start fresh if it was never running) |
| `t` | (Re)start camera + calibration — full retrain |
| `s` | Toggle the eye-size/dwell/assist tuning panel |
| `r` | Reset all petrified blobs |

The **gaze assist** slider in that panel is the capture radius described
above. It's set automatically from the error measured during calibration
(`error × 1.1`, clamped to 90–320px) and can be overridden live. Lower it
for tighter, more deliberate targeting; raise it if visitors are
struggling to land on anything. It only applies to gaze — mouse control
stays pixel-exact, since a mouse doesn't need help.
