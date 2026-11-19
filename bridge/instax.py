"""
INSTAX Link WIDE over Bluetooth LE, straight from the bridge.

The printer is meant to print from Fujifilm's phone app, which made LIVE
GAZE's cards a chore: save the picture, send it to a phone, pick it in the
app, print. It speaks a small packet protocol over one GATT service, and
the community has documented it (javl/InstaxBLE, MIT, and paorin/InstaxLink,
which was tested on the Link WIDE; neither is used as code here). So the
bridge talks to it itself: the page hands it a card, the card is on film a
minute later, and the INSTAX app is never opened.

Only ONE device can be connected at a time, so the INSTAX app (on this Mac
or a phone) must be closed or disconnected, or the printer is not found.
The printer turns itself off when idle; switch it on before printing.

Packets, both ways:
    'Ab' (to the printer) or 'aB' (from it), length (u16, the whole packet),
    function and operation (two bytes), [replies: a result code], payload,
    checksum (255 - sum of every other byte, mod 256).
A packet goes out in pieces of at most 182 bytes, and the printer answers
every request once; the next request waits for that answer.

Printing a JPEG of 1260 x 840 dots:
    DOWNLOAD_START (type JPEG, size)  -> the frame size (900 on the WIDE)
    DOWNLOAD_DATA (index, frame) ...  each frame padded to the frame size
    DOWNLOAD_END
    PRINT_IMAGE                       -> about how many seconds it takes
    then PRINTER_FUNCTION_INFO until it no longer says "processing".

From a terminal (the bridge's venv; macOS asks once for Bluetooth access
for the app it runs in, Terminal for the launcher):
    python bridge/instax.py status
    python bridge/instax.py print card.png [--dry-run]
--dry-run sends the whole picture but not the final print command, so the
transfer can be tested without using film.
"""

import asyncio
import json
import io
import logging
import struct
import time

log = logging.getLogger("instax")

SERVICE = "70954782-2d83-473d-9e5f-81e1d02d5273"
WRITE = "70954783-2d83-473d-9e5f-81e1d02d5273"
NOTIFY = "70954784-2d83-473d-9e5f-81e1d02d5273"

# (function, operation)
SUPPORT_FUNCTION_INFO = (0x00, 0x02)
DOWNLOAD_START = (0x10, 0x00)
DOWNLOAD_DATA = (0x10, 0x01)
DOWNLOAD_END = (0x10, 0x02)
DOWNLOAD_CANCEL = (0x10, 0x03)
PRINT_IMAGE = (0x10, 0x80)

IMAGE_SUPPORT_INFO, BATTERY_INFO, PRINTER_FUNCTION_INFO = 0, 1, 2

# The film of the Link WIDE: what the printer is sent, and the part of it
# the film's frame leaves visible (12 dots hidden at each short side, 32 at
# each long one, as paorin/InstaxLink measured on the WIDE).
WIDE = {"w": 1260, "h": 840, "visible": (12, 32, 1248, 808)}

RESULT = {
    0: "ok", 1: "the printer is busy", 127: "the printer is still working",
    128: "the printer does not support this", 129: "the printer refused the request",
    130: "the printer was asked out of order", 133: "the printer timed out",
    144: "the printer's battery is too low", 145: "the printer has no battery",
    146: "the printer's battery is too hot", 147: "the printer's battery will not charge",
    176: "the film cover is open", 177: "there is no film in the printer",
    178: "the film pack is empty", 179: "the printer could not read the picture",
    180: "the film is jammed", 181: "the print failed",
    192: "the printer's memory is full", 194: "the printer is already printing",
    240: "the printer's software failed", 241: "the printer's hardware failed",
    242: "the printer's mechanism failed",
}
# PRINTER_FUNCTION_INFO's "result of the last print request".
PRINT_STATE = {0: "done", 1: "the film cover is open", 2: "there is no film in the printer",
               127: "printing", 240: "the printer reports an error"}

PIECE = 182          # bytes per BLE write: what the printer is known to take
TARGET_BYTES = 200_000


class InstaxError(Exception):
    """Something to show the person at the printer, in plain words."""


def packet(op, payload=b""):
    body = b"Ab" + struct.pack(">H", 7 + len(payload)) + bytes(op) + payload
    return body + bytes([(255 - (sum(body) & 255)) & 255])


def card_jpeg(data, max_bytes, size=(WIDE["w"], WIDE["h"])):
    """Any picture -> a JPEG the printer takes: its exact size (fitted on
    white if the picture is another shape), as good a quality as fits."""
    from PIL import Image
    im = Image.open(io.BytesIO(data))
    im.load()
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        flat = Image.new("RGB", im.size, "white")
        flat.paste(im, mask=im.getchannel("A"))
        im = flat
    im = im.convert("RGB")
    if im.size != size:
        s = min(size[0] / im.width, size[1] / im.height)
        fitted = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))),
                           Image.Resampling.LANCZOS)
        im = Image.new("RGB", size, "white")
        im.paste(fitted, ((size[0] - fitted.width) // 2, (size[1] - fitted.height) // 2))
    # The printer takes up to ~330 KB, but it acknowledges every 900-byte
    # frame, so the transfer runs at about 5 KB/s: a 334 KB card took 68 s to
    # send. Film shows no difference above quality ~80, so aim for TARGET
    # (about 40 s). Fine text keeps its colour edges without chroma
    # subsampling; give that up first, then quality.
    tries = [(0, q) for q in (92, 90, 87, 85, 82, 80)] + \
            [(2, q) for q in (92, 90, 87, 85, 82, 80, 75, 70, 65, 60, 50)]
    for limit in (min(max_bytes, TARGET_BYTES), max_bytes):
        for subsampling, q in tries:
            out = io.BytesIO()
            im.save(out, "JPEG", quality=q, subsampling=subsampling, optimize=True)
            if out.tell() <= limit:
                return out.getvalue(), q
    raise InstaxError("the picture is too detailed to fit the printer's limit")


class InstaxLink:
    """One connection to the printer. Use `async with InstaxLink() as p:`."""

    def __init__(self, name_prefix="INSTAX-", timeout=12.0):
        self.name_prefix = name_prefix.upper()
        self.timeout = timeout
        self.client = None
        self.name = None
        self._buf = bytearray()
        self._waiting = None          # (op, future)
        self._lock = asyncio.Lock()
        self.piece = PIECE

    # ------------------------------------------------------------ connection
    async def __aenter__(self):
        await self.connect()
        return self

    async def __aexit__(self, *exc):
        await self.disconnect()

    @property
    def connected(self):
        return bool(self.client and self.client.is_connected)

    async def connect(self):
        try:
            from bleak import BleakClient, BleakScanner
        except ImportError:
            raise InstaxError("the bridge is missing bleak: run "
                              "~/dev/medusa-bridge-venv/bin/pip install -r bridge/requirements.txt")

        def is_printer(dev, adv):
            name = (adv.local_name or dev.name or "").upper()
            # The printer shows up twice; the "(IOS)" one is the BLE side.
            return name.startswith(self.name_prefix) and "(ANDROID)" not in name

        try:
            dev = await BleakScanner.find_device_by_filter(is_printer, timeout=self.timeout)
        except Exception as e:      # Bluetooth off, or no permission for it
            raise InstaxError(f"Bluetooth is not available to the bridge ({e}); turn Bluetooth "
                              "on, and allow it for Terminal in System Settings > Privacy & "
                              "Security > Bluetooth")
        if dev is None:
            raise InstaxError("the instax printer was not found: switch it on, and close the "
                              "INSTAX Link WIDE app on this Mac and on any phone (it takes "
                              "one connection at a time)")
        self.name = (dev.name or "").strip() or "INSTAX"
        self.client = BleakClient(dev, timeout=20.0)
        try:
            await self.client.connect()
            await self.client.start_notify(NOTIFY, self._on_notify)
        except Exception as e:
            await self.disconnect()
            raise InstaxError(f"could not connect to {self.name}: {e}")
        try:
            ch = self.client.services.get_characteristic(WRITE)
            if ch is not None and ch.max_write_without_response_size:
                self.piece = max(20, min(PIECE, ch.max_write_without_response_size))
        except Exception:
            pass
        log.info("instax: connected to %s (pieces of %d bytes)", self.name, self.piece)

    async def disconnect(self):
        c, self.client = self.client, None
        if c is not None:
            try:
                await c.disconnect()
            except Exception:
                pass

    # -------------------------------------------------------------- requests
    def _on_notify(self, _char, data):
        self._buf.extend(data)
        while len(self._buf) >= 4:
            if self._buf[:2] != b"aB":
                log.warning("instax: dropped %d unexpected bytes", len(self._buf))
                self._buf.clear()
                return
            n = struct.unpack_from(">H", self._buf, 2)[0]
            if n < 8 or len(self._buf) < n:
                if n < 8:
                    self._buf.clear()
                return
            pkt, self._buf = bytes(self._buf[:n]), self._buf[n:]
            if sum(pkt) & 255 != 255:
                log.warning("instax: reply with a bad checksum")
                continue
            op, code, payload = (pkt[4], pkt[5]), pkt[6], pkt[7:-1]
            if self._waiting and self._waiting[0] == op and not self._waiting[1].done():
                self._waiting[1].set_result((code, payload))

    async def request(self, op, payload=b"", timeout=10.0, ok=(0,)):
        """Send one request and wait for its reply -> its payload."""
        if not self.connected:
            raise InstaxError("the printer disconnected")
        async with self._lock:
            fut = asyncio.get_running_loop().create_future()
            self._waiting = (tuple(op), fut)
            data = packet(op, payload)
            try:
                for i in range(0, len(data), self.piece):
                    await self.client.write_gatt_char(WRITE, data[i:i + self.piece], response=False)
                code, reply = await asyncio.wait_for(fut, timeout)
            except asyncio.TimeoutError:
                raise InstaxError("the printer stopped answering")
            except InstaxError:
                raise
            except Exception as e:
                raise InstaxError(f"lost the printer: {e}")
            finally:
                self._waiting = None
        if code not in ok:
            raise InstaxError(RESULT.get(code, f"the printer answered with error {code}"))
        return code, reply

    async def _info(self, kind):
        _, r = await self.request(SUPPORT_FUNCTION_INFO, bytes([kind]))
        if not r or r[0] != kind:
            raise InstaxError("the printer sent an unexpected answer")
        return r[1:]

    async def status(self):
        """-> {name, width, height, max_bytes, film, battery, charging, cover_open, state}"""
        img = await self._info(IMAGE_SUPPORT_INFO)
        w, h, _ptype, _popt, max_bytes = struct.unpack_from(">HHBBI", img)
        bat = await self._info(BATTERY_INFO)
        st = await self._info(PRINTER_FUNCTION_INFO)
        film, flags, result, wait = st[0], st[1], st[2], st[3]
        return {
            "name": self.name, "width": w, "height": h, "max_bytes": max_bytes,
            "film": film & 15, "battery": bat[1] if len(bat) > 1 else None,
            "charging": bool(film & 0x80), "cover_open": bool(flags & 1),
            "state": PRINT_STATE.get(result, f"state {result}"), "wait_s": wait,
        }

    async def print_jpeg(self, jpeg, progress=None, dry_run=False):
        """Send a JPEG and print it. progress(stage, fraction, detail)."""
        def tell(stage, frac, detail=None):
            if progress:
                progress(stage, frac, detail)

        st = await self.status()
        if st["cover_open"]:
            raise InstaxError("the film cover is open")
        if st["film"] <= 0 and not dry_run:
            raise InstaxError("there is no film in the printer (or the pack is used up)")
        if (st["width"], st["height"]) != (WIDE["w"], WIDE["h"]):
            raise InstaxError(f"this is not a Link WIDE: it takes {st['width']} x {st['height']}")
        if len(jpeg) > st["max_bytes"]:
            raise InstaxError(f"the picture is {len(jpeg)} bytes; the printer takes {st['max_bytes']}")

        _, r = await self.request(DOWNLOAD_START, struct.pack(">BBBBI", 2, 0, 0, 0, len(jpeg)))
        frame = struct.unpack_from(">I", r)[0] if len(r) >= 4 else 900
        frames = [jpeg[i:i + frame] for i in range(0, len(jpeg), frame)]
        try:
            for i, f in enumerate(frames):
                await self.request(DOWNLOAD_DATA, struct.pack(">I", i) + f.ljust(frame, b"\0"))
                tell("sending", (i + 1) / len(frames))
            await self.request(DOWNLOAD_END)
        except Exception:
            try:
                await self.request(DOWNLOAD_CANCEL, timeout=3.0, ok=(0, 1, 127, 130))
            except Exception:
                pass
            raise
        if dry_run:
            await self.request(DOWNLOAD_CANCEL, timeout=5.0, ok=(0, 1, 127, 130))
            tell("done", 1.0, "dry run: sent, not printed")
            return {"printed": False, "film": st["film"]}

        _, r = await self.request(PRINT_IMAGE, timeout=20.0)
        eta = r[0] if r else 15
        tell("printing", 0.0, eta)
        t0 = time.monotonic()
        state = "printing"
        while time.monotonic() - t0 < eta + 90:
            await asyncio.sleep(1.0)
            code, s = await self.request(SUPPORT_FUNCTION_INFO, bytes([PRINTER_FUNCTION_INFO]),
                                         ok=(0, 1, 127))
            if code != 0 or len(s) < 4 or s[0] != PRINTER_FUNCTION_INFO:
                continue                      # busy: ask again
            state = PRINT_STATE.get(s[3], f"state {s[3]}")
            tell("printing", min(0.99, (time.monotonic() - t0) / max(eta, 1)), eta)
            if state != "printing":
                break
        if state != "done":
            raise InstaxError(state if state != "printing" else "the print did not finish in time")
        st = await self.status()
        tell("done", 1.0)
        return {"printed": True, "film": st["film"]}


# ------------------------------------------------------------------ the queue
HELPER_ABORTED = (
    "macOS stopped Bluetooth for the app the bridge was started from. Start the "
    "launcher from Terminal and allow Bluetooth when macOS asks (or in System "
    "Settings > Privacy & Security > Bluetooth)")


class InstaxQueue:
    """The bridge's print queue: one card at a time, in the order sent, each
    job's progress kept for the page to show.

    Every printer conversation runs in a helper process (this file, run as a
    script) rather than in the bridge. macOS kills any process that touches
    Bluetooth on behalf of an app that never declared it would — not with an
    error, with SIGABRT — and the bridge must never die mid-session because
    of a print. A helper that dies is just a failed print with a reason."""

    def __init__(self, python=None):
        import sys
        self.python = python or sys.executable
        self.jobs = []                # newest last, a few kept
        self.last_status = None
        self.last_error = None
        self.checked_at = 0.0
        self._next = 1
        self._queue = asyncio.Queue()
        self._worker = None
        self._use = asyncio.Lock()

    async def _helper(self, args, on_event=None, timeout=240):
        """Run the helper -> its last event; raises InstaxError on failure."""
        from pathlib import Path
        proc = await asyncio.create_subprocess_exec(
            self.python, "-I", str(Path(__file__).resolve()), *args, "--events",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        last = None
        try:
            async def read():
                nonlocal last
                async for line in proc.stdout:
                    try:
                        ev = json.loads(line)
                    except ValueError:
                        continue
                    last = ev
                    if on_event:
                        on_event(ev)
            await asyncio.wait_for(read(), timeout)
            await proc.wait()
        except asyncio.TimeoutError:
            proc.kill()
            raise InstaxError("the printer stopped answering")
        if proc.returncode in (-6, 134):
            raise InstaxError(HELPER_ABORTED)
        if last and last.get("event") == "error":
            raise InstaxError(last.get("message") or "the print failed")
        if proc.returncode != 0 or not last:
            err = (await proc.stderr.read()).decode(errors="replace").strip().splitlines()
            raise InstaxError(err[-1] if err else f"the printer helper failed ({proc.returncode})")
        return last

    async def status(self):
        async with self._use:
            got = {}

            def on_event(ev):
                if ev.get("event") == "status":
                    got.update(ev["status"])
            try:
                await self._helper(["status"], on_event, timeout=60)
                self.last_status = {**got, "at": time.time()}
                self.last_error = None
            except InstaxError as e:
                self.last_error = str(e)
            self.checked_at = time.time()
        return self.snapshot()

    def add(self, data, name, dry_run=False):
        import tempfile
        fd, path = tempfile.mkstemp(prefix="live-gaze-instax-", suffix=".img")
        with open(fd, "wb") as f:
            f.write(data)
        job = {"id": self._next, "name": name, "state": "queued", "progress": 0.0,
               "detail": None, "error": None, "film": None, "dry_run": dry_run,
               "added": time.time(), "_path": path}
        self._next += 1
        self.jobs.append(job)
        del self.jobs[:-20]
        self._queue.put_nowait(job)
        if self._worker is None or self._worker.done():
            self._worker = asyncio.get_running_loop().create_task(self._run())
        return job["id"]

    async def _run(self):
        import os
        while True:
            job = await self._queue.get()

            def on_event(ev, job=job):
                if ev.get("event") == "status":
                    self.last_status = {**ev["status"], "at": time.time()}
                elif ev.get("event") == "progress":
                    job["state"], job["progress"] = ev["stage"], ev["fraction"]
                    job["detail"] = ev.get("detail")

            async with self._use:
                path = job.pop("_path")
                try:
                    job["state"] = "connecting"
                    log.info("instax: %s%s", job["name"], " (dry run)" if job["dry_run"] else "")
                    ev = await self._helper(["print", path] + (["--dry-run"] if job["dry_run"] else []),
                                            on_event)
                    job["state"], job["progress"], job["film"] = "done", 1.0, ev.get("film")
                    if self.last_status is not None and ev.get("film") is not None:
                        self.last_status = {**self.last_status, "film": ev["film"], "at": time.time()}
                    self.last_error = None
                    log.info("instax: %s %s, %s film(s) left", job["name"],
                             "sent (dry run)" if job["dry_run"] else "printed", ev.get("film"))
                except Exception as e:
                    job["state"], job["error"] = "failed", str(e)
                    self.last_error = str(e)
                    log.warning("instax: %s failed: %s", job["name"], e)
                finally:
                    try:
                        os.unlink(path)
                    except OSError:
                        pass

    def snapshot(self):
        return {
            "printer": self.last_status, "error": self.last_error, "checked_at": self.checked_at,
            "busy": any(j["state"] not in ("done", "failed") for j in self.jobs),
            "jobs": [{k: v for k, v in j.items() if not k.startswith("_")} for j in self.jobs],
        }


# ------------------------------------------------------------------ terminal
async def _cli():
    import argparse
    import sys
    ap = argparse.ArgumentParser(description="INSTAX Link WIDE over Bluetooth LE")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, help_ in (("status", "film left, battery, state"), ("print", "print a PNG or JPEG")):
        s = sub.add_parser(name, help=help_)
        if name == "print":
            s.add_argument("image")
            s.add_argument("--dry-run", action="store_true", help="send it but do not print")
        s.add_argument("--events", action="store_true", help="JSON lines, for the bridge")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S",
                        stream=sys.stderr)

    def emit(event, **kw):
        if args.events:
            print(json.dumps({"event": event, **kw}), flush=True)
        elif event == "progress":
            print(f"  {kw['stage']} {int(kw['fraction'] * 100)}%"
                  + (f" ({kw['detail']})" if kw.get("detail") is not None else ""), flush=True)
        elif event == "error":
            print(f"instax: {kw['message']}", file=sys.stderr)
        else:
            print(json.dumps(kw, indent=2), flush=True)

    try:
        async with InstaxLink() as p:
            st = await p.status()
            emit("status", status=st)
            if args.cmd == "print":
                with open(args.image, "rb") as f:
                    jpeg, q = card_jpeg(f.read(), st["max_bytes"])
                log.info("sending %d bytes (JPEG quality %d)", len(jpeg), q)
                last = [None]

                def show(stage, frac, detail=None):
                    step = (stage, int(frac * 20))
                    if step != last[0]:
                        last[0] = step
                        emit("progress", stage=stage, fraction=round(frac, 3), detail=detail)
                res = await p.print_jpeg(jpeg, show, dry_run=args.dry_run)
                emit("done", **res, bytes=len(jpeg), quality=q)
            else:
                emit("done", film=st["film"])
    except InstaxError as e:
        emit("error", message=str(e))
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(_cli())
