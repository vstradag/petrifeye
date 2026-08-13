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
import json
import os
import signal
import socket
import subprocess
import sys
from contextlib import closing

BASE_PORT = 8443
HERE = os.path.dirname(os.path.abspath(__file__))
PYTHON = os.path.join(HERE, ".venv", "bin", "python")
BRIDGE = os.path.join(HERE, "neon_bridge.py")


def local_ip():
    with closing(socket.socket(socket.AF_INET, socket.SOCK_DGRAM)) as s:
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        except OSError:
            return None


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
    return {
        "ip": host,
        "name": phone.get("device_name", "?"),
        "battery": phone.get("battery_level"),
        # None means no glasses plugged into that phone — it will never
        # produce gaze, so it is worth saying so before a bridge starts.
        "glasses": hw.get("serial"),
    }


async def discover():
    """Sweep the local /24 for Companion devices."""
    import aiohttp

    me = local_ip()
    if not me or me.startswith("127."):
        print("no usable network interface", file=sys.stderr)
        return []
    prefix = me.rsplit(".", 1)[0]
    print(f"this machine is {me} — scanning {prefix}.0/24 for Neon Companions…")

    hosts = [f"{prefix}.{i}" for i in range(1, 255) if f"{prefix}.{i}" != me]
    open_hosts = [h for h in await asyncio.gather(*(_port_open(h) for h in hosts)) if h]
    if not open_hosts:
        return []

    async with aiohttp.ClientSession() as s:
        found = await asyncio.gather(*(_identify(s, h) for h in open_hosts))
    return [d for d in found if d]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-a", "--address", nargs="+", metavar="IP",
                    help="phone IPs, in player order. Skips discovery.")
    ap.add_argument("--players", type=int,
                    help="refuse to start unless exactly this many are found")
    ap.add_argument("--base-port", type=int, default=BASE_PORT)
    args = ap.parse_args()

    if args.address:
        devices = [{"ip": ip, "name": f"(given) {ip}", "battery": None, "glasses": "?"}
                   for ip in args.address]
    else:
        devices = asyncio.run(discover())

    if not devices:
        print("\nNo Neon Companion found on this network.\n"
              "  · The Mac and the phones must be on the SAME network.\n"
              "  · Campus networks (eduroam) isolate devices from each other and\n"
              "    will never work — use a phone hotspot or a dedicated router.\n"
              "  · Or pass IPs directly:  --address <ip1> <ip2>", file=sys.stderr)
        return 1

    print(f"\nfound {len(devices)} device(s):")
    for i, d in enumerate(devices):
        warn = "" if d["glasses"] else "   <-- NO GLASSES ATTACHED, will not stream gaze"
        batt = f", battery {d['battery']}%" if d.get("battery") is not None else ""
        print(f"  P{i + 1}  {d['ip']}  {d['name']}{batt}{warn}")

    if args.players and len(devices) != args.players:
        print(f"\nexpected {args.players}, found {len(devices)} — not starting.",
              file=sys.stderr)
        return 1

    if not os.path.exists(PYTHON):
        print(f"\nvenv missing at {PYTHON}", file=sys.stderr)
        return 1

    procs = []
    print()
    for i, d in enumerate(devices):
        port = args.base_port + i
        log = f"/tmp/bridge-p{i + 1}.log"
        cmd = [PYTHON, BRIDGE, "--port", str(port), "--address", d["ip"]]
        with open(log, "w") as fh:
            procs.append((i + 1, port, d["ip"], subprocess.Popen(cmd, stdout=fh, stderr=fh)))
        print(f"P{i + 1} -> port {port}  ({d['ip']})   log: {log}")

    print(f"\nopen https://localhost:{args.base_port}/games/medusa-multiplayer.html")
    print("ctrl-c to stop all bridges\n")

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
