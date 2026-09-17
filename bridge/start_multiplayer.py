#!/usr/bin/env python3
"""Start one Neon bridge per pair of glasses, for multiplayer.

A bridge owns a single RTSP session to a single Companion device, so N
players need N bridges on N ports. Doing that by hand means finding each
phone's IP in its Companion app and keeping the port assignments straight;
this finds every Neon on the network and assigns ports itself.

    python bridge/start_multiplayer.py                    # discover everything
    python bridge/start_multiplayer.py -a 10.0.0.5 10.0.0.6   # explicit IPs
    python bridge/start_multiplayer.py --players 2        # require exactly 2

Player N is the bridge on port 8443+N, matching the PLAYERS table in
games/medusa-multiplayer.html.
"""
import argparse
import asyncio
import ipaddress
import json
import os
import signal
import socket
import subprocess
import sys
import time
import webbrowser
from contextlib import closing

BASE_PORT = 8443
HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(HERE, "neon_bridge.py")

# Candidate interpreters, best first. The local one leads deliberately: a
# venv living inside the Google Drive folder is a trap. Drive's file provider
# serves those files through a virtual filesystem, and when it stalls, an
# `import numpy` blocks FOREVER rather than failing — the process just hangs
# with no output and no error, which is indistinguishable from a bug in the
# bridge itself. That cost an hour once; it should never cost anything again.
PYTHON_CANDIDATES = [
    os.environ.get("MEDUSA_PYTHON"),
    os.path.expanduser("~/dev/medusa-bridge-venv/bin/python"),
    os.path.join(HERE, ".venv", "bin", "python"),
]


def find_python(verbose=True):
    """First interpreter that can actually import the bridge's heavy deps.

    Probed with a timeout rather than trusted, because the failure being
    guarded against is a HANG, not an ImportError — a stalled cloud mount
    never returns at all.
    """
    for cand in PYTHON_CANDIDATES:
        if not cand or not os.path.exists(cand):
            continue
        try:
            subprocess.run([cand, "-c", "import numpy, aiohttp, cv2"],
                           capture_output=True, timeout=25, check=True)
            if verbose:
                print(f"python: {cand}")
            return cand
        except subprocess.TimeoutExpired:
            print(f"python: {cand} HANGS on import — skipping.\n"
                  f"        (a venv on Google Drive does this when the file "
                  f"provider stalls)", file=sys.stderr)
        except subprocess.CalledProcessError:
            if verbose:
                print(f"python: {cand} missing deps — skipping", file=sys.stderr)
    return None


def classify(net):
    """Say whether a network can plausibly carry device-to-device traffic.

    Returns (verdict, reason). "no" means do not bother scanning: the
    failure will not look like a network problem, it will look like the
    phones being absent, which is the confusion this exists to prevent.
    """
    cgnat = ipaddress.ip_network("100.64.0.0/10")
    if net.subnet_of(cgnat):
        return ("no", "carrier-grade NAT (100.64.0.0/10) — a shared provider "
                      "network, clients cannot reach each other")
    if net.num_addresses > 4096:
        return ("no", f"{net.num_addresses:,} addresses — an institutional "
                      "network; these isolate clients from each other")
    if net.num_addresses > 1024:
        return ("maybe", f"{net.num_addresses:,} addresses — large enough that "
                         "client isolation is likely")
    return ("yes", "")


def local_networks():
    """Every private IPv4 network this machine is actually on.

    Deriving one address by opening a UDP socket to 8.8.8.8 only ever yields
    the DEFAULT-ROUTE interface. That is wrong here in the common case: the
    laptop keeps campus Wi-Fi as its default route for internet while the
    phones sit on a hotspot on a second interface, so the phones' subnet is
    never scanned and discovery reports "nothing found" while a bridge is
    happily streaming from that very subnet.

    Private ranges only — an interface can carry a public address, and
    sweeping public space is both useless and rude.
    """
    nets = []
    try:
        out = subprocess.run(["ifconfig"], capture_output=True, text=True,
                             timeout=5).stdout
    except Exception:
        out = ""

    for line in out.splitlines():
        line = line.strip()
        if not line.startswith("inet ") or "127.0.0.1" in line:
            continue
        parts = line.split()
        try:
            addr = parts[1]
            mask = parts[parts.index("netmask") + 1]
            bits = bin(int(mask, 16)).count("1") if mask.startswith("0x") else None
            if bits is None:
                continue
            net = ipaddress.ip_network(f"{addr}/{bits}", strict=False)
        except (ValueError, IndexError):
            continue
        # CGNAT (100.64/10) is NOT in ipaddress's is_private set, so it has to
        # be admitted here and judged by classify() — otherwise the interface
        # the machine is actually on gets silently skipped and the report says
        # "no network" rather than "this network cannot work".
        if not (net.is_private or net.subnet_of(ipaddress.ip_network("100.64.0.0/10"))):
            continue
        nets.append((addr, net))
    return nets


def port_open(host, port, timeout=0.4):
    """Blocking 'is anything listening yet' check, for the pre-browser wait."""
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sk:
        sk.settimeout(timeout)
        return sk.connect_ex((host, port)) == 0


def free_port(port):
    """Stop an old bridge still holding `port`, so a fresh one can bind.

    Without this the new bridge dies on "address already in use" — into a log
    file nobody is looking at — while the OLD bridge keeps serving the page,
    possibly paired with the wrong phone. It looks like a success and isn't.
    Only processes that are our own bridges are stopped; anything else on the
    port is reported and left alone.
    """
    if not port_open("127.0.0.1", port):
        return True
    pids = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                          capture_output=True, text=True).stdout.split()
    for pid in pids:
        cmd = subprocess.run(["ps", "-o", "command=", "-p", pid],
                             capture_output=True, text=True).stdout.strip()
        if "neon_bridge.py" not in cmd:
            print(f"port {port} is used by another program, not a bridge:\n  {cmd}",
                  file=sys.stderr)
            return False
        print(f"stopping an old bridge still running on port {port} (pid {pid})")
        try:
            os.kill(int(pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
    for _ in range(40):
        if not port_open("127.0.0.1", port):
            return True
        time.sleep(0.25)
    for pid in pids:
        try:
            os.kill(int(pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
    time.sleep(0.5)
    return not port_open("127.0.0.1", port)


async def _port_open(host, port=8080, timeout=0.4):
    try:
        _, w = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
        w.close()
        return host
    except Exception:
        return None


async def _identify(session, host):
    """Confirm a host is a Companion and pull its name/serial."""
    import aiohttp
    try:
        async with session.get(f"http://{host}:8080/api/status",
                               timeout=aiohttp.ClientTimeout(total=3)) as r:
            if r.status != 200:
                return None
            body = json.loads(await r.text()).get("result", [])
    except Exception:
        return None

    phone = next((x["data"] for x in body if x.get("model") == "Phone"), None)
    if not phone:
        return None
    hw = next((x["data"] for x in body if x.get("model") == "Hardware"), {})

    # Whether the gaze sensor is actually up. Do NOT infer this from
    # Hardware.glasses_serial: two phones that were both streaming gaze
    # perfectly well each reported -1 there, so it means "unknown", not
    # "absent", and warning on it is a false alarm.
    gaze_ok = any(
        x.get("model") == "Sensor"
        and x.get("data", {}).get("sensor") == "gaze"
        and x.get("data", {}).get("connected")
        for x in body
    )
    return {
        "ip": host,
        "name": phone.get("device_name", "?"),
        "battery": phone.get("battery_level"),
        "frame": hw.get("frame_name"),
        "gaze_ok": gaze_ok,
    }


async def discover():
    """Sweep every private subnet this machine is on for Companion devices."""
    import aiohttp

    nets = local_networks()
    if not nets:
        print("no usable private network interface", file=sys.stderr)
        return []

    mine = {addr for addr, _ in nets}
    hosts = []
    usable = 0
    for addr, net in nets:
        verdict, reason = classify(net)
        if verdict == "no":
            print(f"SKIPPING {net} ({addr}) — {reason}")
            continue
        if verdict == "maybe":
            print(f"warning: {net} — {reason}")
        usable += 1
        print(f"scanning {net} (this machine is {addr} there)…")
        hosts += [str(h) for h in net.hosts() if str(h) not in mine]

    if not usable:
        print("\nEvery network this machine is on is a managed/provider network.\n"
              "Being on the same Wi-Fi name is not enough — these deliberately\n"
              "stop devices reaching each other, so no amount of retrying will\n"
              "help. Turn on the Companion phone's hotspot and join it from\n"
              "this Mac (it shares mobile data, so you keep internet), or use a\n"
              "dedicated router — which needs no internet connection at all.",
              file=sys.stderr)
        # None, not [] — the caller's generic "check you're on the same
        # network" advice is wrong here and would only muddy a diagnosis
        # that is already certain.
        return None

    open_hosts = [h for h in await asyncio.gather(*(_port_open(h) for h in hosts)) if h]
    if not open_hosts:
        return []

    async with aiohttp.ClientSession() as s:
        found = await asyncio.gather(*(_identify(s, h) for h in open_hosts))
    # Sort by address so player order is stable between runs.
    return sorted((d for d in found if d),
                  key=lambda d: tuple(int(o) for o in d["ip"].split(".")))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-a", "--address", nargs="+", metavar="IP",
                    help="phone IPs, in player order. Skips discovery.")
    ap.add_argument("--players", type=int,
                    help="refuse to start unless exactly this many are found")
    ap.add_argument("--base-port", type=int, default=BASE_PORT)
    ap.add_argument("--no-browser", action="store_true",
                    help="start the bridges but do not open a browser")
    args = ap.parse_args()

    if args.address:
        devices = [{"ip": ip, "name": "(given)", "battery": None, "gaze_ok": True}
                   for ip in args.address]
    else:
        devices = asyncio.run(discover())

    # No glasses is NOT a reason to refuse. The bridge is also the web server:
    # without one, the app cannot even open for the webcam or the mouse. So
    # start a single bridge regardless. It keeps looking, and a pair of
    # glasses switched on later is picked up as P1.
    if not devices:
        if devices is not None:
            print("\nNo Neon Companion found on this network.\n"
                  "  · The Mac and the phones must be on the SAME network.\n"
                  "  · Campus networks (eduroam) isolate devices from each other and\n"
                  "    will never work — use a phone hotspot or a dedicated router.\n"
                  "  · Or pass IPs directly:  --address IP1 IP2", file=sys.stderr)
        if args.players:
            return 1    # a specific number of players was demanded
        print("\nStarting the app anyway, with no glasses: the webcam and the\n"
              "mouse work without them, and glasses switched on later are\n"
              "picked up as P1.")
        devices = []

    if devices:
        print(f"\nfound {len(devices)} device(s):")
    for i, d in enumerate(devices):
        warn = "" if d.get("gaze_ok") else "   <-- gaze sensor not connected"
        batt = f", battery {d['battery']}%" if d.get("battery") is not None else ""
        frame = f", {d['frame']}" if d.get("frame") else ""
        print(f"  P{i + 1}  {d['ip']}  {d['name']}{batt}{frame}{warn}")

    # Only enforced when the caller ASKED for a specific count. Left open,
    # the launcher adapts to whatever is switched on — which is the whole
    # point of a one-click start: you cannot know in advance how many pairs
    # of glasses are awake.
    if devices and args.players and len(devices) != args.players:
        print(f"\nexpected {args.players}, found {len(devices)} — not starting.",
              file=sys.stderr)
        return 1

    python = find_python()
    if not python:
        print("\nNo usable Python found. Tried:\n  " +
              "\n  ".join(c for c in PYTHON_CANDIDATES if c) +
              "\n\nCreate one with:\n"
              "  python3 -m venv ~/dev/medusa-bridge-venv\n"
              "  ~/dev/medusa-bridge-venv/bin/pip install -r bridge/requirements.txt",
              file=sys.stderr)
        return 1

    # One bridge per phone, each pinned to its own phone with --address: an
    # unpinned bridge takes the FIRST phone that answers, so two unpinned
    # bridges would both stream the same pair of glasses. With no phones,
    # one unpinned bridge, so the app is served and keeps looking.
    plan = [(i + 1, args.base_port + i, d["ip"]) for i, d in enumerate(devices)] \
        or [(1, args.base_port, None)]

    for _n, port, _ip in plan:
        if not free_port(port):
            return 1

    procs = []
    print()
    for n, port, ip in plan:
        log = f"/tmp/bridge-p{n}.log"
        cmd = [python, BRIDGE, "--port", str(port)] + (["--address", ip] if ip else [])
        with open(log, "w") as fh:
            procs.append((n, port, ip, subprocess.Popen(cmd, stdout=fh, stderr=fh)))
        print(f"P{n} -> port {port}  ({ip or 'no glasses yet — still looking'})   log: {log}")

    # Open the game MENU, not a particular game. With several experiences now
    # sharing the same bridges (MEDUSA, the analysis version, POLITICAL VISION)
    # guessing one from the device count would open the wrong one more often
    # than the right one; the menu is one click from all of them.
    url = f"https://localhost:{args.base_port}/"

    # Give the first bridge a moment to bind before pointing a browser at it,
    # or the page loads into a connection error and needs a manual reload.
    for _ in range(40):
        if port_open("127.0.0.1", args.base_port):
            break
        time.sleep(0.25)

    print(f"\nopening {url}")
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            print("  (could not open a browser — open that URL yourself)")
    print("\nThe browser will warn about the certificate: it is self-signed,")
    print("served by the bridge on your own machine. Click through it.")
    print("\nctrl-c to stop all bridges\n")

    def stop(*_):
        for _n, _p, _ip, proc in procs:
            proc.terminate()
        sys.exit(0)

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        for _n, _p, _ip, proc in procs:
            proc.wait()
    except KeyboardInterrupt:
        stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
