"""Session recorder: scene video + everything needed to judge a tracker offline.

Started with `neon_bridge.py --record [DIR]`. Each bridge writes its own
folder, <DIR>/<date-time>-port<N>/:

    scene.mp4      the scene camera, every frame the bridge decoded
    frames.jsonl   one line per frame in scene.mp4, same order: timestamps,
                   the AprilTags detected, and where each screen was located
                   (the tag-based answer a marker-free method is scored
                   against), plus the on-screen layout (tags and frame)
    gaze.jsonl     every gaze sample, in scene-camera pixels
    camera.json    the scene camera's intrinsics and distortion
    meta.json      how the bridge was started, and a summary at the end

Why record at all: whether the screen can be found WITHOUT tags (a drawn
frame, the screen's own brightness, its content) can only be judged against
the real room, the real content and real head movement. Recorded with the tags
still on, every frame carries its own ground truth, so each candidate method
can be measured offline, repeatedly, without touching the live piece.

Encoding happens on a worker thread. The event loop only hands frames over,
so recording cannot slow gaze down; if the encoder falls behind, frames are
dropped (and counted in meta.json) rather than queued without bound. A frame's
metadata line is written by the same thread as its pixels, so the two files
can never disagree about which frame is which.

Rule for every method called from the bridge: NEVER raise. A recording
problem may cost data; it must not cost tracking. (In testing, an unsaveable
serial number in camera.json took the whole device connection down.)
"""
import json
import logging
import os
import queue
import subprocess
import threading
import time
from datetime import datetime
from enum import Enum
from pathlib import Path

import numpy as np

log = logging.getLogger("neon")

# ~2s of scene video. Beyond that the encoder is not keeping up and holding
# more would only grow memory: 1600x1200 BGR is 5.8MB a frame.
QUEUE_FRAMES = 60


def _clean(o):
    """Make the tracker's objects JSON-safe, recursively.

    Needed beyond a json `default=`: the surface tracker keys its marker
    corners by a CornerId ENUM, and json refuses non-string keys outright —
    that took the whole writer thread down in testing.
    """
    if isinstance(o, dict):
        return {(k.name if isinstance(k, Enum) else str(k)) if not isinstance(k, str) else k:
                _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, set)):
        return [_clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, np.generic):
        return o.item()
    if isinstance(o, Enum):
        return o.name
    if isinstance(o, (bytes, bytearray)):
        # The device serial in the calibration comes back as bytes.
        return o.decode("utf-8", "replace").rstrip("\x00")
    if hasattr(o, "as_dict"):
        return _clean(o.as_dict())
    if o is None or isinstance(o, (str, int, float, bool)):
        return o
    return str(o)


def _jsonable(o):
    return _clean(o)


def _dumps(obj):
    return json.dumps(_clean(obj), separators=(",", ":"))


def _git_commit():
    try:
        return subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=os.path.dirname(os.path.abspath(__file__)),
            capture_output=True, text=True, timeout=5,
        ).stdout.strip() or None
    except Exception:
        return None


class Recorder:
    def __init__(self, root, port, settings):
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        self.dir = Path(root).expanduser() / f"{stamp}-port{port}"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.meta = {
            "started": datetime.now().isoformat(timespec="seconds"),
            "port": port,
            "commit": _git_commit(),
            "settings": settings,
        }
        self._write_meta()
        self._gaze = open(self.dir / "gaze.jsonl", "w", buffering=1 << 16)
        self._q = queue.Queue(maxsize=QUEUE_FRAMES)
        self._dropped = 0
        self._written = 0
        self._gaze_count = 0
        self._camera_saved = False
        self._thread = threading.Thread(target=self._run, name="recorder", daemon=True)
        self._thread.start()
        log.info("recording to %s", self.dir)

    # ------------------------------------------------------------ event loop
    def camera(self, calib):
        """Save the scene camera model once (it doesn't change per device)."""
        if self._camera_saved:
            return
        # Indexed the same way GazeMapper reads it (a numpy record).
        try:
            data = {
                "scene_camera_matrix": np.asarray(calib["scene_camera_matrix"]).reshape(3, 3),
                "scene_distortion_coefficients": np.asarray(
                    calib["scene_distortion_coefficients"]).reshape(-1),
            }
        except Exception as exc:  # noqa: BLE001 - a recording without intrinsics is still useful
            log.warning("recorder: could not read the camera calibration: %s", exc)
            return
        try:
            data["serial"] = calib["serial"]
        except Exception:
            pass
        try:
            (self.dir / "camera.json").write_text(_dumps(data))
            self._camera_saved = True
        except Exception as exc:  # noqa: BLE001
            log.warning("recorder: could not save camera.json: %s", exc)

    def scene(self, bgr, info):
        """Hand one decoded scene frame (BGR ndarray) and its metadata over."""
        if not self._thread.is_alive():
            self._dropped += 1
            return
        try:
            self._q.put_nowait((bgr, info))
        except queue.Full:
            self._dropped += 1
            if self._dropped in (1, 10, 100) or self._dropped % 1000 == 0:
                log.warning("recorder: encoder behind — %d scene frames dropped", self._dropped)

    def gaze(self, datum):
        try:
            self._gaze.write(_dumps({
                "t": getattr(datum, "timestamp_unix_seconds", None),
                "x": float(datum.x),
                "y": float(datum.y),
                "worn": bool(getattr(datum, "worn", True)),
            }) + "\n")
            self._gaze_count += 1
        except Exception:  # noqa: BLE001 - a recording must never stop gaze
            pass

    def close(self):
        # Never a plain put(): if the worker had died, the queue would stay
        # full and shutdown would wait forever.
        while self._thread.is_alive():
            try:
                self._q.put(None, timeout=0.5)
                break
            except queue.Full:
                continue
        self._thread.join(timeout=30)
        try:
            self._gaze.close()
        except Exception:
            pass
        self.meta.update({
            "ended": datetime.now().isoformat(timespec="seconds"),
            "scene_frames_written": self._written,
            "scene_frames_dropped": self._dropped,
            "gaze_samples": self._gaze_count,
        })
        self._write_meta()
        log.info("recording closed: %d frames (%d dropped), %d gaze samples — %s",
                 self._written, self._dropped, self._gaze_count, self.dir)

    def _write_meta(self):
        (self.dir / "meta.json").write_text(json.dumps(self.meta, indent=2, default=_jsonable))

    # ---------------------------------------------------------------- worker
    def _open_video(self, w, h):
        import av
        out = av.open(str(self.dir / "scene.mp4"), "w")
        # Hardware H.264 first: ~5x real time on Apple Silicon and nearly free
        # for the CPU the bridge needs for tag detection. libx264 otherwise.
        for codec, opts in (("h264_videotoolbox", {"b": "12M", "realtime": "1"}),
                            ("libx264", {"crf": "20", "preset": "veryfast"})):
            try:
                stream = out.add_stream(codec, rate=30)
                stream.width, stream.height = w, h
                stream.pix_fmt = "yuv420p"
                stream.options = opts
                stream.codec_context.open()
                log.info("recorder: encoding with %s", codec)
                self.meta["encoder"] = codec
                return out, stream
            except Exception as exc:  # noqa: BLE001
                log.info("recorder: %s unavailable (%s)", codec, exc)
                out.close()
                out = av.open(str(self.dir / "scene.mp4"), "w")
        raise RuntimeError("no usable H.264 encoder")

    def _run(self):
        import av
        out = stream = None
        frames = open(self.dir / "frames.jsonl", "w", buffering=1 << 16)
        t0 = None
        try:
            while True:
                item = self._q.get()
                if item is None:
                    break
                bgr, info = item
                if out is None:
                    h, w = bgr.shape[:2]
                    out, stream = self._open_video(w, h)
                    self.meta["scene_size"] = [w, h]
                vf = av.VideoFrame.from_ndarray(bgr, format="bgr24")
                # Numbered 0,1,2… at a nominal 30fps. Real capture times (and
                # so any gaps from a weak network) are in frames.jsonl — custom
                # millisecond timestamps upset the hardware encoder's muxing.
                t = info.get("t") or time.time()
                if t0 is None:
                    t0 = t
                vf.pts = self._written
                for pkt in stream.encode(vf):
                    out.mux(pkt)
                info["i"] = self._written
                info["t_rel"] = round(t - t0, 4)
                try:
                    line = _dumps(info)
                except Exception as exc:  # noqa: BLE001
                    # Still ONE line for this frame, so frames.jsonl and
                    # scene.mp4 stay aligned line-for-frame.
                    line = _dumps({"i": info["i"], "t": info.get("t"),
                                   "t_rel": info["t_rel"], "error": repr(exc)})
                frames.write(line + "\n")
                self._written += 1
        except Exception:  # noqa: BLE001 - never take the bridge down with us
            log.exception("recorder: stopped after an error")
        finally:
            try:
                if stream is not None:
                    for pkt in stream.encode():
                        out.mux(pkt)
                if out is not None:
                    out.close()
            except Exception:
                log.exception("recorder: could not finalise scene.mp4")
            frames.close()
