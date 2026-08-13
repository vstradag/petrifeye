"""
Pupil Labs Neon -> PetrifEye bridge.

Runs on the same machine as the browser and does the three things the page
physically cannot:

  1. Speaks RTSP to the Neon Companion phone. Browsers have no RTSP support
     of any kind, so gaze can never reach the page directly.
  2. Turns SCENE-CAMERA gaze into SCREEN gaze. Neon is head-mounted: it
     reports where you're looking inside its forward camera's field of view.
     Locating the monitor inside that view needs AprilTag markers and a
     homography (pupil-labs' real-time-screen-gaze), which is Python-only.
  3. Serves the app itself over HTTPS. That is what makes the gaze WebSocket
     SAME-ORIGIN: an https:// page may not open ws:// or fetch http://, and
     the Companion API is plain HTTP on the LAN. Hosting the page here
     sidesteps mixed content entirely and reuses the cert already in .certs/.

Run it INSTEAD OF serve-https.js when you want Neon:

    python3 bridge/neon_bridge.py            # auto-discover the phone
    python3 bridge/neon_bridge.py --address 192.168.1.42

Then open https://localhost:8443/ and choose "neon glasses" on the boot
screen. Use serve-https.js as before if you only want the webcam path.
"""

import argparse
import asyncio
import json
import logging
import ssl
import sys
import time
import traceback
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

try:
    from aiohttp import web, WSMsgType
except ImportError:
    sys.exit("Missing deps. Run:  pip install -r bridge/requirements.txt")

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("neon")


class _Deduplicate(logging.Filter):
    """Collapses the library's RTSP reconnect storm.

    When the Companion app is asleep its stream ports are closed, and the
    realtime-api retries forever with no backoff — hundreds of identical
    lines per second, which buries every message that actually matters.
    Keep one line per distinct message per 5s.
    """

    def __init__(self, window=5.0):
        super().__init__()
        self.window = window
        self.seen: dict[str, float] = {}

    def filter(self, record):
        import time
        msg = record.getMessage()
        if not any(k in msg for k in ("RTSPConnectionError", "try loading stream", "Reconnecting")):
            return True
        now = time.monotonic()
        last = self.seen.get(msg, 0.0)
        if now - last < self.window:
            return False
        self.seen[msg] = now
        return True


for _h in logging.getLogger().handlers:
    _h.addFilter(_Deduplicate())


class _TracebackOnStreamError(logging.Filter):
    """Restores the stack trace aiortsp throws away.

    aiortsp's reader catches every stream exception and logs only
    `Error on stream: %r. Reconnecting...`, which tells you the exception type
    but not the line that raised it. That cost real debugging time chasing a
    `TypeError: can only concatenate str (not "bytes") to str` with nothing to
    locate it. If an exception is live, re-log it with its traceback.
    """

    def filter(self, record):
        if "Error on stream" in str(record.msg) and sys.exc_info()[0] is not None:
            log.error("stream exception detail:\n%s", traceback.format_exc())
        return True


logging.getLogger("aiortsp").addFilter(_TracebackOnStreamError())


def strip_audio(url: str) -> str:
    """Drop audio params from a sensor URL.

    The Companion app advertises the gaze stream as
    `rtsp://<ip>:8086/?camera=gaze&audioenable=on`. PetrifEye never uses
    audio, and negotiating an extra track costs phone CPU and bandwidth on a
    device that is already thermally marginal — the most common cause of
    Companion instability. Dropping it is worthwhile on its own; it may also
    sidestep a type bug in the audio path of the vendored aiortsp.
    """
    parts = urlsplit(url)
    if not parts.query:
        return url
    kept = [(k, v) for k, v in parse_qsl(parts.query) if k != "audioenable"]
    return urlunsplit(parts._replace(query=urlencode(kept)))

ROOT = Path(__file__).resolve().parent.parent
CERT_DIR = ROOT / ".certs"

# AprilTag ids drawn in the page's four corners. Any four distinct ids from
# the tag36h11 family work; these just have to match what markers.js renders.
MARKER_IDS = [0, 1, 2, 3]


class StreamRestart(Exception):
    """Raised by the watchdog to force a full device reconnect.

    Distinct from a network error so the retry path can report it as routine
    rather than as a fault.
    """


# --------------------------------------------------------------------------
# Client fan-out
# --------------------------------------------------------------------------
class Hub:
    """Tracks connected browsers and broadcasts to them."""

    def __init__(self):
        self.clients: set[web.WebSocketResponse] = set()
        self.state = {"type": "status", "state": "starting", "detail": "", "surfaceOk": False}
        # Set by the browser over the gaze socket. Guessing this from the
        # command line was a real accuracy bug: a Retina Mac reports a
        # 1512x982 CSS viewport while --screen-width defaulted to 1920x1080,
        # so every mapped coordinate was stretched ~1.27x horizontally, and
        # the surface was built from marker positions that didn't match where
        # the page actually drew them.
        self.viewport: tuple[int, int] | None = None

    def add(self, ws):
        self.clients.add(ws)

    def discard(self, ws):
        self.clients.discard(ws)

    async def send(self, payload):
        if not self.clients:
            return
        raw = json.dumps(payload)
        # Snapshot: a send failure mutates the set, and iterating it live
        # while removing would raise.
        for ws in list(self.clients):
            try:
                await ws.send_str(raw)
            except Exception:
                self.clients.discard(ws)

    async def set_status(self, state, detail="", **extra):
        self.state = {"type": "status", "state": state, "detail": detail, **extra}
        log.info("status: %s %s", state, detail)
        await self.send(self.state)


hub = Hub()


# --------------------------------------------------------------------------
# Neon
# --------------------------------------------------------------------------
async def neon_loop(address: str | None, port: int, screen_w: int, screen_h: int):
    """Connect to the glasses and stream screen-mapped gaze into the hub."""
    try:
        from pupil_labs.realtime_api import Device, Network, receive_gaze_data, receive_video_frames
    except ImportError:
        await hub.set_status("error", "pupil-labs-realtime-api not installed")
        return

    # NB: the distribution is called "real-time-screen-gaze" but it installs
    # into the shared pupil_labs namespace package, so the import path does
    # NOT match the pip name.
    try:
        from pupil_labs.real_time_screen_gaze.gaze_mapper import GazeMapper
    except ImportError:
        GazeMapper = None
        log.warning("real-time-screen-gaze missing — falling back to unmapped gaze")

    while True:
        try:
            if address:
                dev_info = None
                dev = Device(address=address, port=port)
            else:
                await hub.set_status("searching", "looking for the Companion device on this network")
                async with Network() as network:
                    dev_info = await network.wait_for_new_device(timeout_seconds=30)
                if dev_info is None:
                    await hub.set_status("searching", "no device found — retrying")
                    await asyncio.sleep(3)
                    continue
                dev = Device.from_discovered_device(dev_info)

            async with dev:
                status = await dev.get_status()
                name = getattr(status.phone, "device_name", "Companion")
                await hub.set_status("connected", f"{name} — starting streams")

                calib = await dev.get_calibration()
                mapper = GazeMapper(calib) if GazeMapper else None
                # The surface is built inside stream(), not here: its geometry
                # depends on the browser's reported viewport, which can arrive
                # (or change) after the device connects.

                gaze_sensor = status.direct_gaze_sensor()
                scene_sensor = status.direct_world_sensor()
                if not gaze_sensor or not gaze_sensor.connected:
                    await hub.set_status("error", "gaze sensor not connected — is the Neon plugged into the phone?")
                    await asyncio.sleep(3)
                    continue

                # Blinks drive "shoot" in the platformer. This stream is gated
                # by "Compute fixations" in the Companion app, so it is often
                # absent — treated as optional, and the browser is told so it
                # can fall back to the keyboard rather than silently ignoring
                # a control the player was told about.
                eye_events_sensor = status.direct_eye_events_sensor()
                if eye_events_sensor and eye_events_sensor.connected:
                    log.info("eye-events stream available — blink detection on")
                else:
                    log.info("no eye-events stream — blinks unavailable "
                             "(enable 'Compute fixations' in the Companion app)")

                await stream(gaze_sensor, scene_sensor, eye_events_sensor,
                             mapper, screen_w, screen_h)

        except asyncio.CancelledError:
            raise
        except StreamRestart:
            # Watchdog decided the streams were dead; loop round and rebuild
            # the session from scratch. Routine, so no error status.
            await hub.set_status("stalled", "reconnecting to the glasses…")
            await asyncio.sleep(1)
        except Exception as exc:  # noqa: BLE001 - surface anything to the browser
            # A Companion app that crashes and relaunches produces connection
            # errors constantly; those are routine here, not faults. Reporting
            # them as "error" made the browser show a terminal boot failure for
            # a phone that would be back in fifteen seconds, so only genuinely
            # unexpected failures get that treatment.
            transient = isinstance(exc, (OSError, asyncio.TimeoutError)) or type(
                exc
            ).__name__ in {
                "ClientConnectorError",
                "ConnectionTimeoutError",
                "ClientOSError",
                "ServerDisconnectedError",
                "ClientConnectionError",
            }
            if transient:
                log.info("phone unreachable (%s) — retrying", type(exc).__name__)
                await hub.set_status(
                    "stalled",
                    "phone not reachable — waiting for the Companion app to come back",
                )
            else:
                log.exception("neon loop failed")
                await hub.set_status("error", f"{type(exc).__name__}: {exc}")
            await asyncio.sleep(3)


# Geometry of the <img> elements markers.js places, in CSS pixels.
#
# The page no longer hardcodes these — markers.js fetches them from
# /markers/layout.json so there is exactly one source of truth. Previously
# both files carried their own copy and a mismatch didn't fail loudly, it
# just skewed every mapped coordinate.
#
# Default is deliberately large. A tag has to span roughly 25-30 pixels in
# the SCENE camera image to be detected, and the scene camera sees the whole
# room: a laptop screen might be a third of its width, so an on-screen tag
# shrinks by that factor again. 120px was marginal at desk distance and
# failed completely at an angle; 300 gives real headroom for both.
#
# Size buys detection RANGE and ANGLE tolerance. It does not help a marker
# that is outside the camera's view — raise --marker-margin for that, which
# moves the tags inward so all four fit in a smaller central region.
#
# For a finished installation, printing the tags and mounting them around the
# monitor bezel is better than either: they can be far larger and they don't
# sit on top of the artwork. See step 6 of the wizard.
IMG_SIZE = 300
IMG_MARGIN = 24

# How the page displays the tags.
#   "always" — permanently visible. Most accurate and most intrusive.
#   "flash"  — shown briefly, periodically. The surface solve is cached
#              between flashes (see SURFACE HOLD), so gaze keeps mapping while
#              they're hidden. Trades accuracy under head movement for a
#              near-clean screen.
#   "off"    — never drawn by the page. For markers PRINTED around the monitor
#              bezel, which is the right answer for a finished installation:
#              nothing at all on the artwork, and the tags can be far larger.
MARKER_MODE = "always"
FLASH_ON_MS = 260      # ~8 scene-camera frames at 30fps — enough to detect
FLASH_PERIOD_MS = 1800

# How long a cached surface solve stays usable after the markers vanish.
# Also covers ordinary dropouts (blink, motion blur, brief head turn) even in
# "always" mode, where it stops single bad frames from freezing the pointer.
SURFACE_HOLD_MS = 2500
# The served PNG is a 600px canvas holding a 480px tag centred in a white
# quiet zone, so the tag itself covers the middle 80% of the <img>.
QUIET_RATIO = 60 / 600


def marker_verts(w: int, h: int):
    """Corner points of the four on-screen AprilTags, in screen pixels.

    Describes the TAG, not the <img> that contains it: the PNG carries a
    white quiet border the detector needs, so the visible tag is inset
    within the element. Getting this wrong doesn't fail loudly — it silently
    skews every mapped coordinate by the border width.

    Corners are listed top-left first then clockwise, which is what
    add_surface() expects.
    """
    s, m = IMG_SIZE, IMG_MARGIN
    inset = s * QUIET_RATIO   # 12px at the default size
    side = s - 2 * inset      # 96px
    origins = {
        MARKER_IDS[0]: (m, m),                  # top-left
        MARKER_IDS[1]: (w - m - s, m),          # top-right
        MARKER_IDS[2]: (w - m - s, h - m - s),  # bottom-right
        MARKER_IDS[3]: (m, h - m - s),          # bottom-left
    }
    verts = {}
    for mid, (ox, oy) in origins.items():
        x, y = ox + inset, oy + inset
        verts[mid] = [(x, y), (x + side, y), (x + side, y + side), (x, y + side)]
    return verts


async def stream(gaze_sensor, scene_sensor, eye_events_sensor, mapper,
                 screen_w, screen_h):
    from pupil_labs.realtime_api import (
        receive_gaze_data, receive_video_frames, receive_eye_events_data,
    )

    blinks_on = bool(eye_events_sensor and eye_events_sensor.connected)

    # Surface geometry follows the browser's real viewport. Rebuilt whenever
    # it changes (first report, window resize, fullscreen toggle) so the
    # marker layout the mapper assumes always matches what the page draws.
    surf = {"w": None, "h": None, "obj": None}

    def current_surface():
        vw, vh = hub.viewport or (screen_w, screen_h)
        if surf["w"] != vw or surf["h"] != vh:
            if mapper:
                mapper.clear_surfaces()
                surf["obj"] = mapper.add_surface(marker_verts(vw, vh), (vw, vh))
            surf["w"], surf["h"] = vw, vh
            log.info("surface rebuilt for %dx%d (markers %dpx @ %dpx inset)",
                     vw, vh, IMG_SIZE, IMG_MARGIN)
        return surf["obj"], surf["w"], surf["h"]

    # Deliberately NOT announcing "streaming" yet. The RTSP connection is
    # opened lazily by the pumps below and can fail indefinitely (the phone
    # answers on the REST port while its stream ports are closed — which is
    # what a sleeping Companion app looks like). Claiming "streaming" here
    # made the browser and the setup wizard both report success while zero
    # data was flowing, which is worse than reporting nothing.
    await hub.set_status("connecting", "opening gaze stream…", surfaceOk=bool(mapper))

    # Liveness is judged by "did a gaze datum arrive recently", not by any
    # one-shot event. The Companion app crashes and restarts on its own, and
    # the realtime-api reconnects underneath us, so the bridge has to be able
    # to go stalled -> streaming as many times as the phone needs it to.
    STALE_AFTER = 2.0     # seconds without a datum before we call it stalled
    # After this long with no data, give up on these RTSP readers and let the
    # outer loop reconnect from scratch. The realtime-api retries the stream
    # URL forever on its own, which sounds robust but isn't: the sensor URLs
    # and the device session are fetched once, before streaming starts, so a
    # phone that reboots (new session, possibly new ports) is never picked up.
    # Left alone this sat "stalled" for five and a half hours while the phone
    # was healthy and reachable the whole time.
    RESTART_AFTER = 30.0
    state = {"last_gaze": 0.0, "markers": -1, "reported": None}
    began = time.monotonic()

    async def watchdog():
        while True:
            await asyncio.sleep(1.0)
            now = time.monotonic()
            live = state["last_gaze"] > 0 and (now - state["last_gaze"]) < STALE_AFTER

            quiet_since = state["last_gaze"] or began
            if not live and (now - quiet_since) > RESTART_AFTER:
                log.info("no gaze for %.0fs — rebuilding the device connection",
                         now - quiet_since)
                # Cancels the sibling pumps via gather, unwinding into
                # neon_loop's retry, which re-fetches status and sensor URLs.
                raise StreamRestart

            if live:
                m = state["markers"]
                if not mapper:
                    detail = "gaze live"
                elif m < 0:
                    detail = "gaze live — waiting for scene frames"
                elif m >= 4:
                    detail = "surface locked"
                elif m == 0:
                    detail = "no markers in view — look at the screen"
                else:
                    detail = f"{m}/4 markers visible"
                key = ("streaming", detail)
                if state["reported"] != key:
                    state["reported"] = key
                    await hub.set_status(
                        "streaming", detail,
                        surfaceOk=bool(mapper),
                        markersVisible=(m if mapper and m >= 0 else None),
                        blinkAvailable=blinks_on,
                    )
            else:
                if state["last_gaze"] == 0:
                    detail = ("no gaze data yet — is the Neon plugged in and the "
                              "Companion app open and awake?")
                else:
                    gone = int(now - state["last_gaze"])
                    detail = (f"gaze stream stopped {gone}s ago — the Companion app "
                              "may have crashed or the glasses unplugged. "
                              "Reconnecting automatically.")
                # 'stalled', not 'error': this is recoverable and the bridge is
                # still trying. Reporting a terminal error here is what made the
                # old build stay broken after the phone came back.
                key = ("stalled", detail)
                if state["reported"] != key:
                    state["reported"] = key
                    await hub.set_status("stalled", detail, surfaceOk=bool(mapper))

    gaze_url = strip_audio(gaze_sensor.url)
    scene_url = strip_audio(scene_sensor.url) if scene_sensor else None
    if gaze_url != gaze_sensor.url:
        log.info("gaze stream (audio stripped): %s", gaze_url)

    # Pupil diameter rides on the gaze stream (the datum is an
    # EyestateGazeData variant) whenever "Compute eye state" is enabled on the
    # phone. Forwarded separately from mapped gaze because the flower game
    # needs ONLY this — no markers, no surface, no calibration — so it must
    # not be coupled to the scene pump.
    last_pupil_sent = 0.0
    PUPIL_HZ = 30.0   # 200Hz raw is far more than any animation needs

    async def pump_gaze():
        nonlocal last_pupil_sent
        async for datum in receive_gaze_data(gaze_url, run_loop=True):
            state["last_gaze"] = time.monotonic()

            left = getattr(datum, "pupil_diameter_left", None)
            right = getattr(datum, "pupil_diameter_right", None)
            if left is not None or right is not None:
                now_p = time.monotonic()
                if now_p - last_pupil_sent >= 1.0 / PUPIL_HZ:
                    last_pupil_sent = now_p
                    vals = [v for v in (left, right) if v is not None and v == v and v > 0]
                    if vals:
                        await hub.send({
                            "type": "pupil",
                            "left": float(left) if left is not None else None,
                            "right": float(right) if right is not None else None,
                            # Mean of whatever is valid: one eye can drop out
                            # (blink, occlusion) and the animation shouldn't lurch.
                            "mm": sum(vals) / len(vals),
                            "worn": bool(getattr(datum, "worn", True)),
                        })
            # Unmapped fallback: treat scene-camera normalised position as a
            # direct screen fraction. Crude and only sane if the head stays
            # put, but it keeps the piece playable without markers.
            if mapper is None:
                _, vw, vh = current_surface()
                await hub.send({
                    "type": "gaze",
                    "x": float(datum.x) / 1600.0 * vw,
                    "y": float(datum.y) / 1200.0 * vh,
                    "worn": bool(getattr(datum, "worn", True)),
                })
            else:
                hub.latest_gaze = datum

    async def pump_scene():
        if mapper is None:
            return
        # Last successful surface solve, reused while the markers are not
        # visible (see SURFACE HOLD below).
        held = {"locations": None, "at": 0.0}
        hold_seconds = SURFACE_HOLD_MS / 1000.0
        async for frame in receive_video_frames(scene_url, run_loop=True):
            datum = getattr(hub, "latest_gaze", None)
            if datum is None:
                continue
            surface, screen_vw, screen_vh = current_surface()
            if surface is None:
                continue

            # Split rather than process_frame(): scene and gaze are processed
            # separately so a cached surface can be re-injected between them.
            #
            # Pass the VideoFrame OBJECT, not a pixel array — process_scene
            # unwraps it itself (`frame.bgr_pixels`, else `frame.bgr_buffer()`).
            # Handing it `frame.bgr_buffer` gave OpenCV an un-called bound
            # method, surfacing as a baffling cvtColor "Bad argument".
            mapper.process_scene(frame)

            # Only record what we saw; the watchdog owns status reporting, so
            # marker churn can't fight it for the status line.
            state["markers"] = len(getattr(mapper, "_detected_markers", None) or [])

            # SURFACE HOLD. Without this, one blink, head turn or motion-blurred
            # frame that loses the markers stops gaze dead for that frame — and
            # it is what makes hiding the markers possible at all: the last good
            # homography keeps mapping while they're off screen.
            #
            # Reaches into _surface_locations because the library offers no
            # public way to restore a previous solve. process_scene/process_gaze
            # are public, so splitting them is intended; guarded with getattr so
            # a library change degrades to "no hold" instead of crashing.
            locations = getattr(mapper, "_surface_locations", None)
            if locations is None:
                continue
            now = time.monotonic()
            if any(v is not None for v in locations.values()):
                held["locations"] = dict(locations)
                held["at"] = now
            elif held["locations"] and (now - held["at"]) <= hold_seconds:
                mapper._surface_locations = dict(held["locations"])
            else:
                continue  # nothing fresh and nothing recent enough to trust

            result = mapper.process_gaze(datum)
            if result is None:
                continue

            for surf_gaze in result.mapped_gaze.get(surface.uid, []):
                # MarkerMappedGaze.x/y are normalised 0..1 across the surface,
                # origin BOTTOM-left; the page's origin is top-left.
                await hub.send({
                    "type": "gaze",
                    "x": float(surf_gaze.x) * screen_vw,
                    "y": (1.0 - float(surf_gaze.y)) * screen_vh,
                    "worn": bool(getattr(datum, "worn", True)),
                })

    async def pump_blinks():
        if not blinks_on:
            return
        # The eye-events stream carries fixations too; only blinks matter here.
        async for ev in receive_eye_events_data(
            strip_audio(eye_events_sensor.url), run_loop=True
        ):
            if type(ev).__name__ != "BlinkEventData":
                continue
            await hub.send({"type": "blink"})

    await asyncio.gather(watchdog(), pump_gaze(), pump_scene(), pump_blinks())


# --------------------------------------------------------------------------
# Web server (static app + gaze socket, one origin)
# --------------------------------------------------------------------------
async def ws_handler(request):
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    hub.add(ws)
    log.info("browser connected (%d total)", len(hub.clients))
    await ws.send_str(json.dumps(hub.state))  # current state immediately
    try:
        async for msg in ws:
            if msg.type == WSMsgType.ERROR:
                break
            if msg.type == WSMsgType.TEXT:
                try:
                    payload = json.loads(msg.data)
                except ValueError:
                    continue
                if payload.get("type") == "viewport":
                    w, h = int(payload.get("width", 0)), int(payload.get("height", 0))
                    # Sanity bound: a bogus size would silently wreck the
                    # mapping, which is exactly the failure mode being fixed.
                    if 200 <= w <= 20000 and 200 <= h <= 20000:
                        if hub.viewport != (w, h):
                            log.info("browser viewport: %dx%d CSS px", w, h)
                        hub.viewport = (w, h)
    finally:
        hub.discard(ws)
        log.info("browser disconnected (%d left)", len(hub.clients))
    return ws


async def markers_handler(request):
    """Serves the AprilTag PNGs the page overlays in its corners."""
    try:
        from pupil_labs.real_time_screen_gaze import marker_generator
    except ImportError:
        raise web.HTTPNotFound(text="real-time-screen-gaze not installed")
    try:
        mid = int(request.match_info["mid"])
    except ValueError:
        raise web.HTTPBadRequest(text="marker id must be an integer")

    import io
    from PIL import Image
    import numpy as np

    # generate_marker returns the bare 8x8 tag36h11 bitmap. Upscale here with
    # NEAREST so the served PNG has hard bit edges: any smooth interpolation
    # (browser or PIL) blurs the boundaries enough to cost detection range.
    # A quiet white border is required too — the detector looks for a light
    # margin around the black frame and won't find tags that bleed to the
    # edge of their own image.
    pixels = np.asarray(marker_generator.generate_marker(marker_id=mid), dtype="uint8")
    img = Image.fromarray(pixels, mode="L").resize((480, 480), Image.NEAREST)
    quiet = Image.new("L", (600, 600), 255)
    quiet.paste(img, (60, 60))
    buf = io.BytesIO()
    quiet.save(buf, format="PNG")
    return web.Response(
        body=buf.getvalue(),
        content_type="image/png",
        headers={"Cache-Control": "no-store"},
    )


async def layout_handler(_req):
    """Marker geometry and display mode, so page and mapper cannot disagree."""
    return web.json_response(
        {
            "ids": MARKER_IDS,
            "size": IMG_SIZE,
            "margin": IMG_MARGIN,
            "mode": MARKER_MODE,
            "flashOnMs": FLASH_ON_MS,
            "flashPeriodMs": FLASH_PERIOD_MS,
        },
        headers={"Cache-Control": "no-store"},
    )


def build_app():
    app = web.Application()
    app.router.add_get("/gaze", ws_handler)
    app.router.add_get("/markers/layout.json", layout_handler)
    app.router.add_get("/markers/{mid}.png", markers_handler)

    async def index(_req):
        return web.FileResponse(ROOT / "index.html", headers={"Cache-Control": "no-store"})

    app.router.add_get("/", index)
    # Static last so it can't shadow /gaze or /markers.
    app.router.add_static("/", ROOT, show_index=False)
    return app


def ssl_context():
    cert, key = CERT_DIR / "cert.pem", CERT_DIR / "key.pem"
    if not cert.exists() or not key.exists():
        sys.exit(f"No TLS cert in {CERT_DIR}. See README (mkcert).")
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    return ctx


async def main():
    # Declared up front: Python requires the global statement before any use
    # of the name in the function, and the argparse defaults below read them.
    global IMG_SIZE, IMG_MARGIN, MARKER_MODE, FLASH_ON_MS, FLASH_PERIOD_MS
    global SURFACE_HOLD_MS

    ap = argparse.ArgumentParser(description="Pupil Labs Neon bridge for PetrifEye")
    ap.add_argument("--address", help="Companion phone IP (skips mDNS discovery)")
    ap.add_argument("--device-port", type=int, default=8080, help="Companion API port")
    ap.add_argument("--port", type=int, default=8443, help="HTTPS port to serve the app on")
    ap.add_argument("--screen-width", type=int, default=1920)
    ap.add_argument("--screen-height", type=int, default=1080)
    ap.add_argument(
        "--marker-size", type=int, default=IMG_SIZE,
        help="On-screen AprilTag size in CSS px. Raise it if markers aren't "
             "detected — the tag must span ~25-30px in the SCENE image.",
    )
    ap.add_argument("--marker-margin", type=int, default=IMG_MARGIN,
                    help="Inset of each marker from the screen edge, in CSS px.")
    ap.add_argument(
        "--marker-mode", choices=("always", "flash", "off"), default=MARKER_MODE,
        help="always: tags permanently on screen (most accurate). "
             "flash: brief periodic pulses, surface cached between them "
             "(much less intrusive, softer under head movement). "
             "off: page draws nothing — for tags PRINTED around the bezel.",
    )
    ap.add_argument("--flash-on-ms", type=int, default=FLASH_ON_MS)
    ap.add_argument("--flash-period-ms", type=int, default=FLASH_PERIOD_MS)
    ap.add_argument(
        "--surface-hold-ms", type=int, default=SURFACE_HOLD_MS,
        help="How long a surface solve stays usable after the tags vanish.",
    )
    args = ap.parse_args()

    # Applied globally so marker_verts() and /markers/layout.json agree.
    IMG_SIZE, IMG_MARGIN = args.marker_size, args.marker_margin
    MARKER_MODE = args.marker_mode
    FLASH_ON_MS, FLASH_PERIOD_MS = args.flash_on_ms, args.flash_period_ms
    SURFACE_HOLD_MS = args.surface_hold_ms
    log.info("markers: %dpx, %dpx inset, mode=%s (hold %dms)",
             IMG_SIZE, IMG_MARGIN, MARKER_MODE, SURFACE_HOLD_MS)
    if MARKER_MODE == "flash":
        duty = 100.0 * FLASH_ON_MS / max(FLASH_PERIOD_MS, 1)
        log.info("flash: %dms every %dms (visible %.0f%% of the time)",
                 FLASH_ON_MS, FLASH_PERIOD_MS, duty)

    runner = web.AppRunner(build_app())
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", args.port, ssl_context=ssl_context())
    await site.start()
    log.info("app + gaze socket on https://localhost:%d/", args.port)

    task = asyncio.create_task(
        neon_loop(args.address, args.device_port, args.screen_width, args.screen_height)
    )
    try:
        await asyncio.Event().wait()
    finally:
        task.cancel()
        await runner.cleanup()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
