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
from contextlib import closing

BASE_PORT = 8443
HERE = os.path.dirname(os.path.abspath(__file__))
PYTHON = os.path.join(HERE, ".venv", "bin", "python")
BRIDGE = os.path.join(HERE, "neon_bridge.py")


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
        if not net.is_private or net.num_addresses > 1024:
            # Huge subnets are campus-style networks, which isolate clients
            # and cannot work anyway; not worth a multi-thousand-host sweep.
            continue
        nets.append((addr, net))
    return nets


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
    for addr, net in nets:
        print(f"scanning {net} (this machine is {addr} there)…")
        hosts += [str(h) for h in net.hosts() if str(h) not in mine]

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
    args = ap.parse_args()

    if args.address:
        devices = [{"ip": ip, "name": "(given)", "battery": None, "gaze_ok": True}
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
        warn = "" if d.get("gaze_ok") else "   <-- gaze sensor not connected"
        batt = f", battery {d['battery']}%" if d.get("battery") is not None else ""
        frame = f", {d['frame']}" if d.get("frame") else ""
        print(f"  P{i + 1}  {d['ip']}  {d['name']}{batt}{frame}{warn}")

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
