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

# Checked BEFORE anything else, because the way this file fails on an old
# Python is unreadable: `str | None` in a signature is evaluated when the
# function is defined, so 3.9 dies with "unsupported operand type(s) for |:
# 'type' and 'NoneType'" pointing at a line that has nothing wrong with it.
# pupil-labs-realtime-api needs >=3.10 anyway (1.5.0 was the last 3.9 build),
# and macOS still ships 3.9 as `python3` via the Command Line Tools — so a
# fresh Mac hits this on the first run.
if sys.version_info < (3, 10):
    sys.exit(
        f"This needs Python 3.10 or newer; you are running {sys.version.split()[0]}.\n"
        "macOS ships 3.9 as `python3`, so a venv made with it is too old.\n"
        "Install a current Python (python.org installer, or `brew install python@3.12`),\n"
        "then rebuild the venv with it:\n"
        "  python3.12 -m venv ~/dev/medusa-bridge-venv\n"
        "  ~/dev/medusa-bridge-venv/bin/pip install -r bridge/requirements.txt"
    )

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


async def scan_for_device(port: int, timeout: float = 0.35):
    """Find the Companion by sweeping the local /24 for its API port.

    mDNS is the documented way to discover the phone, but it fails often
    enough to matter: it is multicast, and plenty of networks drop that. On
    this project's own hotspot the bridge repeatedly failed to discover a
    phone whose port 8080 was wide open and pingable.

    This is a fallback, not a replacement — it only sweeps the machine's own
    /24, and only confirms a host by asking it for /api/status, so a random
    web server on :8080 can't be mistaken for a Neon.
    """
    import socket
    from contextlib import closing

    # Local address on the interface that reaches the outside world. No
    # traffic is actually sent by connect() on a UDP socket.
    with closing(socket.socket(socket.AF_INET, socket.SOCK_DGRAM)) as s:
        try:
            s.connect(("8.8.8.8", 80))
            local = s.getsockname()[0]
        except OSError:
            return None
    if not local or local.startswith("127."):
        return None
    prefix = local.rsplit(".", 1)[0]

    async def probe(host):
        try:
            fut = asyncio.open_connection(host, port)
            reader, writer = await asyncio.wait_for(fut, timeout=timeout)
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return host
        except Exception:
            return None

    hosts = [f"{prefix}.{i}" for i in range(1, 255) if f"{prefix}.{i}" != local]
    log.info("mDNS found nothing — sweeping %s.0/24 for port %d", prefix, port)
    open_hosts = [h for h in await asyncio.gather(*(probe(h) for h in hosts)) if h]

    # Confirm it really is a Companion before handing it to the device client.
    for host in open_hosts:
        try:
            import aiohttp
            async with aiohttp.ClientSession() as sess:
                async with sess.get(f"http://{host}:{port}/api/status",
                                    timeout=aiohttp.ClientTimeout(total=2)) as r:
                    if r.status == 200 and "Phone" in (await r.text()):
                        log.info("found Companion at %s", host)
                        return host
        except Exception:
            continue
    if open_hosts:
        log.info("hosts with :%d open but no Neon API: %s", port, ", ".join(open_hosts))
    return None


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

        # EXTRA SCREENS, for experiences that show several displays at once
        # (LIVE GAZE): key -> {"ids": [4 tag ids], "w": int, "h": int}.
        #
        # Each display must carry its own four tags. Two screens showing the
        # SAME four would be indistinguishable to the scene camera — it would
        # see eight tags with duplicate ids and solve nonsense — so a screen
        # registers the id set it draws, and gaze is reported per screen.
        #
        # The default screen, the one every other experience uses, is not in
        # here: it is `viewport` above with MARKER_IDS, so pages that know
        # nothing about this keep working untouched.
        self.screens: dict[str, dict] = {}
        self._screen_owner: dict = {}

    def add(self, ws):
        self.clients.add(ws)

    def set_screen(self, ws, key, ids, w, h):
        self.screens[key] = {"ids": list(ids), "w": int(w), "h": int(h)}
        self._screen_owner[key] = ws

    def drop_screens(self, ws):
        """Forget the screens a closing window owned, so surfaces don't pile up."""
        gone = [k for k, owner in self._screen_owner.items() if owner is ws]
        for key in gone:
            self.screens.pop(key, None)
            self._screen_owner.pop(key, None)
        return gone

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
                    dev_info = await network.wait_for_new_device(timeout_seconds=15)

                if dev_info is None:
                    # mDNS is multicast and plenty of networks drop it, so fall
                    # back to sweeping our own subnet before giving up.
                    found = await scan_for_device(port)
                    if found:
                        dev = Device(address=found, port=port)
                    else:
                        await hub.set_status(
                            "searching",
                            "no Companion found. On eduroam or another campus "
                            "network this will never work — devices are isolated "
                            "from each other. Use the phone's hotspot or a "
                            "dedicated router.",
                        )
                        await asyncio.sleep(3)
                        continue
                else:
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


DEFAULT_SCREEN = "main"


def build_surfaces(mapper, specs):
    """One mapper surface per screen. specs: key -> {"ids", "w", "h"}.

    Module level so it can be tested without a phone: the surfaces are the
    part that decides whether gaze lands on the right display at all.
    """
    out = {}
    if not mapper:
        return out
    # The library can only clear ALL surfaces, so every screen is re-added.
    mapper.clear_surfaces()
    for key, sp in specs.items():
        out[key] = {
            "obj": mapper.add_surface(marker_verts(sp["w"], sp["h"], sp["ids"]), (sp["w"], sp["h"])),
            "w": sp["w"], "h": sp["h"], "ids": list(sp["ids"]),
        }
    return out


def marker_verts(w: int, h: int, ids=None):
    """Corner points of the four on-screen AprilTags, in screen pixels.

    Describes the TAG, not the <img> that contains it: the PNG carries a
    white quiet border the detector needs, so the visible tag is inset
    within the element. Getting this wrong doesn't fail loudly — it silently
    skews every mapped coordinate by the border width.

    Corners are listed top-left first then clockwise, which is what
    add_surface() expects.
    """
    ids = list(ids or MARKER_IDS)
    s, m = IMG_SIZE, IMG_MARGIN
    inset = s * QUIET_RATIO   # 12px at the default size
    side = s - 2 * inset      # 96px
    origins = {
        ids[0]: (m, m),                  # top-left
        ids[1]: (w - m - s, m),          # top-right
        ids[2]: (w - m - s, h - m - s),  # bottom-right
        ids[3]: (m, h - m - s),          # bottom-left
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
    # ONE SURFACE PER SCREEN. Usually that is a single screen — the page's
    # viewport with the default tags — and everything behaves as before. LIVE
    # GAZE shows an image per display, each drawing its own four tags, and
    # registers one screen each; the mapper takes any number of surfaces and
    # reports gaze per surface, so the glasses can tell the displays apart.
    surfaces = {}          # key -> {"obj", "w", "h", "ids"}
    built = {"stamp": None}

    def screen_specs():
        vw, vh = hub.viewport or (screen_w, screen_h)
        specs = {DEFAULT_SCREEN: {"ids": list(MARKER_IDS), "w": vw, "h": vh}}
        for key, sp in hub.screens.items():
            specs[key] = {"ids": list(sp["ids"]), "w": sp["w"], "h": sp["h"]}
        return specs

    def current_surfaces():
        # Marker SIZE is part of the geometry, not just looks: marker_verts()
        # places the tag corners from it. If a page resizes its tags and this
        # keeps the old figure, the mapper solves against corners that are no
        # longer where the tags are — every coordinate skews, silently. So a
        # size change invalidates the surfaces exactly like a viewport change.
        specs = screen_specs()
        stamp = (IMG_SIZE, IMG_MARGIN, json.dumps(specs, sort_keys=True))
        if stamp != built["stamp"]:
            surfaces.clear()
            if mapper:
                # Rebuilding changes every surface uid, which makes a held
                # solve meaningless — drop it rather than map through stale keys.
                surfaces.update(build_surfaces(mapper, specs))
                held["locations"] = None
            built["stamp"] = stamp
            log.info("surfaces rebuilt (markers %dpx @ %dpx inset): %s", IMG_SIZE, IMG_MARGIN,
                     "; ".join(f"{k} {sp['w']}x{sp['h']} tags {sp['ids']}"
                               for k, sp in specs.items()))
        return surfaces

    def current_surface():
        """The default screen, for every caller that knows only one."""
        vw, vh = hub.viewport or (screen_w, screen_h)
        s = current_surfaces().get(DEFAULT_SCREEN)
        return (s["obj"], s["w"], s["h"]) if s else (None, vw, vh)

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
    # The same rule for the SCENE camera, which the gaze check cannot see.
    # A connection can come up with gaze and eye events streaming but the
    # scene stream never started — seen twice in one day, both times on the
    # first connection after a phone woke. Gaze kept arriving, so the gaze
    # watchdog was satisfied, and the bridge sat on "waiting for scene frames"
    # indefinitely while reporting itself healthy: no scene frames means no
    # surface, so not one gaze sample could be mapped. A healthy scene camera
    # sends ~30 frames a second, so 12s of silence is unambiguous; and
    # restarting cannot lose anything, since nothing was being mapped anyway.
    SCENE_RESTART_AFTER = 12.0
    state = {"last_gaze": 0.0, "last_scene": 0.0, "markers": -1, "reported": None,
             "per_screen": {}}
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

            # Only when a mapper exists: without one there is no scene stream
            # to wait for, and gaze goes out unmapped by design.
            scene_quiet_since = state["last_scene"] or began
            if mapper and live and (now - scene_quiet_since) > SCENE_RESTART_AFTER:
                log.info("gaze live but no scene frames for %.0fs — rebuilding the "
                         "device connection", now - scene_quiet_since)
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
                        # Per display, for experiences that show several.
                        screens=state["per_screen"] or None,
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

    # Last good surface solve, shared by both pumps.
    #
    # This is what lets gaze be mapped WITHOUT waiting for a scene frame.
    # Gaze used to be emitted from pump_scene, so its rate was the scene
    # camera's ~30fps and every sample queued behind H.264 decode plus
    # AprilTag detection on a 1600x1200 frame — tens of milliseconds of
    # latency on a signal that arrives at 200Hz, and growing whenever
    # detection ran slower than the frame interval.
    #
    # The two signals change at completely different speeds: the surface only
    # moves when the head does, gaze moves constantly. So the scene pump now
    # only maintains this homography, and the gaze pump maps through whatever
    # is currently cached.
    held = {"locations": None, "at": 0.0}
    hold_seconds = SURFACE_HOLD_MS / 1000.0

    # Emitting all 200Hz would flood the socket for no visible benefit — the
    # page renders at 60. This is still ~4x the old scene-locked rate.
    last_gaze_sent = 0.0
    GAZE_HZ = 120.0

    # Pupil diameter rides on the gaze stream (the datum is an
    # EyestateGazeData variant) whenever "Compute eye state" is enabled on the
    # phone. Forwarded separately from mapped gaze because the flower game
    # needs ONLY this — no markers, no surface, no calibration — so it must
    # not be coupled to the scene pump.
    last_pupil_sent = 0.0
    PUPIL_HZ = 30.0   # 200Hz raw is far more than any animation needs

    async def pump_gaze():
        nonlocal last_pupil_sent, last_gaze_sent
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
                    else:
                        # BOTH eyes gone (closed, or fully occluded): the
                        # tracker reports NaN/0 for each. Silence here is
                        # wrong — the page cannot tell "eyes shut" from
                        # "stream died" and just freezes on the last value.
                        # Closed eyes are a SIGNAL (ANEMONE snaps the flower
                        # shut on it), so say so explicitly, at the same
                        # cadence real samples would arrive.
                        await hub.send({
                            "type": "pupil",
                            "mm": None,
                            "closed": True,
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

                # Map and emit HERE, at the gaze stream's own rate, using the
                # most recent surface solve — rather than waiting for the next
                # scene frame to be decoded and searched for markers.
                now_g = time.monotonic()
                if now_g - last_gaze_sent < 1.0 / GAZE_HZ:
                    continue
                surfs = current_surfaces()
                if not surfs or not held["locations"]:
                    continue
                if now_g - held["at"] > hold_seconds:
                    continue  # solve too stale to trust

                mapper._surface_locations = dict(held["locations"])
                result = mapper.process_gaze(datum)
                if result is None:
                    continue
                worn = bool(getattr(datum, "worn", True))
                for key, s in surfs.items():
                    for surf_gaze in result.mapped_gaze.get(s["obj"].uid, []):
                        # With several displays, a sample is reported only to
                        # the screen it actually lands ON — otherwise every
                        # screen would draw a gaze point for someone looking
                        # at a different one. With a single screen the old
                        # behaviour stands: off-screen gaze is still sent, and
                        # the page decides what to do with it.
                        if len(surfs) > 1 and not getattr(surf_gaze, "is_on_aoi", True):
                            continue
                        last_gaze_sent = now_g
                        # MarkerMappedGaze.x/y are normalised 0..1 across the
                        # surface, origin BOTTOM-left; the page's is top-left.
                        await hub.send({
                            "type": "gaze",
                            "screen": key,
                            "x": float(surf_gaze.x) * s["w"],
                            "y": (1.0 - float(surf_gaze.y)) * s["h"],
                            "worn": worn,
                        })

    async def pump_scene():
        if mapper is None:
            return
        async for frame in receive_video_frames(scene_url, run_loop=True):
            # Recorded before anything can skip the frame: the watchdog needs
            # to know the camera is ALIVE, whether or not a surface exists yet.
            state["last_scene"] = time.monotonic()
            # No gaze datum or surface needed here any more: this pump's only
            # job is to keep `held` current. Waiting on a gaze sample before
            # locating the surface would also have meant the very first solve
            # could not happen until gaze was already flowing.
            if current_surface()[0] is None:
                continue

            # Split rather than process_frame(): scene and gaze are processed
            # separately so the cached surface can be re-injected between them.
            #
            # Pass the VideoFrame OBJECT, not a pixel array — process_scene
            # unwraps it itself (`frame.bgr_pixels`, else `frame.bgr_buffer()`).
            # Handing it `frame.bgr_buffer` gave OpenCV an un-called bound
            # method, surfacing as a baffling cvtColor "Bad argument".
            mapper.process_scene(frame)

            # Only record what we saw; the watchdog owns status reporting, so
            # marker churn can't fight it for the status line.
            # Counted PER SCREEN. A plain total would be wrong the moment a
            # second display is on: its four tags would inflate the first
            # screen's "4/4" while that screen might not be in view at all.
            # Detected markers carry a uid like "tag36h11:5".
            detected = getattr(mapper, "_detected_markers", None) or []
            seen_ids = set()
            for m in detected:
                uid = str(getattr(m, "uid", ""))
                if ":" in uid:
                    try:
                        seen_ids.add(int(uid.rsplit(":", 1)[1]))
                    except ValueError:
                        pass
            specs = screen_specs()
            if seen_ids or not detected:
                state["per_screen"] = {k: len(seen_ids & set(sp["ids"])) for k, sp in specs.items()}
                state["markers"] = state["per_screen"].get(DEFAULT_SCREEN, 0)
            else:
                # A library that names markers differently: fall back to the
                # old total rather than reporting a confident zero.
                state["per_screen"] = {}
                state["markers"] = len(detected)

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
            # Nothing else to do: this pump's only job is keeping `held`
            # current. The gaze pump does the mapping and the emitting, at
            # its own much higher rate.

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

    # NOT asyncio.gather: it propagates the first exception but leaves the
    # sibling coroutines running. When the watchdog raised StreamRestart, the
    # RTSP pumps survived and kept retrying forever inside run_loop=True, so
    # every reconnect cycle abandoned another pair of readers — 992 retry
    # attempts across 3 restarts in one session, all fighting for the same
    # ports. Own the tasks so they can actually be torn down.
    tasks = [
        asyncio.create_task(c, name=n)
        for n, c in (
            ("watchdog", watchdog()),
            ("gaze", pump_gaze()),
            ("scene", pump_scene()),
            ("blinks", pump_blinks()),
        )
    ]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
        for t in done:
            if not t.cancelled() and t.exception():
                raise t.exception()
    finally:
        for t in tasks:
            t.cancel()
        # Wait for the cancellations to land before returning, otherwise the
        # next connection attempt races the dying readers.
        await asyncio.gather(*tasks, return_exceptions=True)


# --------------------------------------------------------------------------
# Web server (static app + gaze socket, one origin)


@web.middleware
async def no_cache(request, handler):
    """Never let a browser hold on to a copy of the app.

    add_static() sends no Cache-Control at all, only Etag/Last-Modified, so
    Chrome is free to reuse a heuristically-cached copy WITHOUT revalidating.
    Only "/" was marked no-store, which meant the launcher was always fresh
    while every game page and every script under it could be minutes or hours
    stale — an edit lands on disk, the server serves it correctly, and the
    browser still shows the old one. Hard to spot because the served bytes
    are provably right.

    It matters beyond development too: an installation machine should run
    whatever is on disk after a restart, not whatever it cached last week.
    """
    try:
        response = await handler(request)
    except web.HTTPException as exc:
        exc.headers["Cache-Control"] = "no-store"
        raise
    # WebSocket responses have no mutable headers by this point.
    if not isinstance(response, web.WebSocketResponse):
        response.headers["Cache-Control"] = "no-store, must-revalidate"
    return response
# --------------------------------------------------------------------------
async def ws_handler(request):
    # Rebound live from the browser's marker-size control below.
    global IMG_SIZE
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
                elif payload.get("type") == "screen":
                    # A display registering itself: its own four tag ids and
                    # its own size. Several screens may be registered at once,
                    # by different windows, each mapped separately.
                    key = str(payload.get("key") or "")[:32]
                    ids = payload.get("ids") or []
                    w, h = int(payload.get("width", 0)), int(payload.get("height", 0))
                    ok = (key and isinstance(ids, list) and len(ids) == 4
                          and len(set(ids)) == 4
                          and all(isinstance(i, int) and 0 <= i < 587 for i in ids)
                          and 200 <= w <= 20000 and 200 <= h <= 20000)
                    if not ok:
                        log.info("ignoring malformed screen registration: %r", payload)
                    elif hub.screens.get(key) != {"ids": list(ids), "w": w, "h": h}:
                        hub.set_screen(ws, key, ids, w, h)
                        log.info("screen %r: %dx%d, tags %s", key, w, h, ids)
                    else:
                        hub.set_screen(ws, key, ids, w, h)   # refresh ownership
                elif payload.get("type") == "markerSize":
                    # The page has resized its tags; match it so marker_verts()
                    # keeps describing where the tags actually are. The surface
                    # rebuilds on the next current_surface() call, which also
                    # re-solves the homography.
                    #
                    # Bounded for the same reason the viewport is: a nonsense
                    # value here does not crash anything, it silently skews
                    # every mapped coordinate. Floor of 60px because the tag
                    # must still span ~25-30px in the scene image to be found
                    # at all; a smaller tag is not "less intrusive", it is
                    # undetectable.
                    s = int(payload.get("size", 0))
                    if 60 <= s <= 1200 and IMG_SIZE != s:
                        log.info("marker size %dpx -> %dpx (surface will rebuild)",
                                 IMG_SIZE, s)
                        IMG_SIZE = s
    finally:
        hub.discard(ws)
        # A closed window's screens must go with it, or their surfaces linger
        # and the mapper keeps solving for a display nobody is showing.
        gone = hub.drop_screens(ws)
        if gone:
            log.info("screens released: %s", ", ".join(gone))
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
    app = web.Application(middlewares=[no_cache])
    app.router.add_get("/gaze", ws_handler)
    app.router.add_get("/markers/layout.json", layout_handler)
    app.router.add_get("/markers/{mid}.png", markers_handler)

    async def index(_req):
        return web.FileResponse(ROOT / "index.html", headers={"Cache-Control": "no-store"})

    app.router.add_get("/", index)
    # Static last so it can't shadow /gaze or /markers.
    app.router.add_static("/", ROOT, show_index=False)
    return app


def make_self_signed(cert, key):
    """Generate a throwaway cert so a fresh clone can just run.

    Certificates are machine-specific and gitignored, so every new computer
    started with a hard stop telling it to install mkcert — which in turn wants
    Homebrew, which wants the Xcode tools. Three installs to serve a local page.

    macOS ships LibreSSL as /usr/bin/openssl and it handles this fine (tested on
    LibreSSL 3.3.6 and OpenSSL 3.0). The result is self-signed, so the browser
    shows one warning to click through — the same warning the README has always
    said to accept. mkcert remains worth it if you want no warning at all: put
    its files in .certs/ and this step is skipped.
    """
    import socket
    import subprocess
    from contextlib import closing

    CERT_DIR.mkdir(parents=True, exist_ok=True)
    # The LAN address is included so the page also loads from another device on
    # the network without a name mismatch on top of the self-signed warning.
    # Found the same way discovery does it — gethostbyname(gethostname()) is
    # unreliable on macOS and can block; a UDP connect() sends nothing and just
    # reports which local address would be used.
    names = ["DNS:localhost", "IP:127.0.0.1"]
    try:
        with closing(socket.socket(socket.AF_INET, socket.SOCK_DGRAM)) as s:
            s.connect(("8.8.8.8", 80))
            lan = s.getsockname()[0]
        if lan and not lan.startswith("127."):
            names.append(f"IP:{lan}")
    except OSError:
        pass
    for openssl in ("/usr/bin/openssl", "openssl"):
        try:
            subprocess.run(
                [openssl, "req", "-x509", "-newkey", "rsa:2048", "-sha256",
                 "-days", "825", "-nodes",
                 "-keyout", str(key), "-out", str(cert),
                 "-subj", "/CN=localhost",
                 "-addext", f"subjectAltName={','.join(names)}"],
                capture_output=True, timeout=120, check=True)
            log.info("generated a self-signed certificate in %s (%s)",
                     CERT_DIR, ", ".join(names))
            log.info("the browser will warn once — it is your own machine; click through")
            return True
        except FileNotFoundError:
            continue
        except Exception as e:
            log.warning("could not generate a certificate with %s: %s", openssl, e)
            return False
    return False


def ssl_context():
    cert, key = CERT_DIR / "cert.pem", CERT_DIR / "key.pem"
    if not cert.exists() or not key.exists():
        if not make_self_signed(cert, key):
            sys.exit(
                f"No TLS cert in {CERT_DIR}, and one could not be generated.\n"
                "Install mkcert and make one by hand:\n"
                "  brew install mkcert && mkcert -install\n"
                f"  mkdir -p {CERT_DIR}\n"
                f"  mkcert -key-file {CERT_DIR}/key.pem -cert-file {CERT_DIR}/cert.pem"
                " localhost 127.0.0.1 ::1"
            )
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
