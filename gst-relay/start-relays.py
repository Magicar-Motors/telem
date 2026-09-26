#!/usr/bin/env python3
"""Forward the car's SRT payloads to local and LAN UDP viewers."""
import argparse
import ipaddress
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import time

FEEDS = (("pedal", 9000, 10000), ("driver", 9001, 10001),
         ("mic", 9002, 10002), ("front", 9003, 10003))


def laptop_ip(value):
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError as error:
        raise argparse.ArgumentTypeError("Enter the second laptop's LAN IPv4 address.") from error
    if address.is_multicast or address.is_unspecified or str(address) == "255.255.255.255":
        raise argparse.ArgumentTypeError("Use a unicast laptop address.")
    return str(address)


def source_host(value):
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.-]*", value):
        raise argparse.ArgumentTypeError("Use a hostname or IPv4 address, without a port or URL.")
    return value


def latency_ms(value):
    try:
        number = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("Latency must be an integer in milliseconds.") from error
    if not 0 <= number <= 60000:
        raise argparse.ArgumentTypeError("Latency must be between 0 and 60000 ms.")
    return number


def pipeline(launcher, args, source_port, output_port):
    clients = [f"127.0.0.1:{output_port}"]
    if args.laptop_ip != "127.0.0.1":
        clients.append(f"{args.laptop_ip}:{output_port}")
    return [launcher, "-q", "srtsrc",
            f"uri=srt://{args.source_host}:{source_port}?mode=caller",
            f"latency={args.latency_ms}", "!", "multiudpsink",
            "clients=" + ",".join(clients), "sync=false", "async=false"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("laptop_ip", type=laptop_ip)
    parser.add_argument("--source-host", type=source_host, default="gearados-nx")
    parser.add_argument("--latency-ms", type=latency_ms, default=100,
                        help="SRT receive request in ms (default: 100; sender minimum still applies)")
    parser.add_argument("--dry-run", action="store_true", help="print pipelines without starting them")
    args = parser.parse_args()
    launcher = shutil.which("gst-launch-1.0")
    if args.dry_run:
        for role, source, output in FEEDS:
            print(f"{role}: {shlex.join(pipeline(launcher or 'gst-launch-1.0', args, source, output))}")
        return
    inspector = shutil.which("gst-inspect-1.0")
    if not launcher or not inspector:
        parser.exit(1, "GStreamer is missing. Install it with: brew install gstreamer\n")
    for plugin in ("srtsrc", "multiudpsink"):
        check = subprocess.run([inspector, plugin], stdout=subprocess.DEVNULL,
                               stderr=subprocess.PIPE, text=True)
        if check.returncode:
            parser.exit(1, f"GStreamer plugin {plugin} is unavailable:\n{check.stderr}")

    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    logs = Path(__file__).resolve().parent / "logs"
    logs.mkdir(exist_ok=True)
    children = {}
    retry_at = {}
    print(f"SRT source: {args.source_host}; UDP destinations: localhost and {args.laptop_ip}", flush=True)
    for role, _, output in FEEDS:
        print(f"  {role:6} OBS input on either laptop: udp://0.0.0.0:{output}", flush=True)
    print(f"Logs: {logs}\nCtrl-C stops all four relays. Failed feeds retry every 2 seconds.", flush=True)
    try:
        while not stopping:
            now = time.monotonic()
            for role, source, output in FEEDS:
                if stopping:
                    break
                child = children.get(role)
                if child is not None:
                    code = child.poll()
                    if code is None:
                        continue
                    del children[role]
                    retry_at[role] = now + 2
                    print(f"{role}: exited ({code}); retrying in 2s. See {logs / (role + '.log')}", flush=True)
                if now < retry_at.get(role, 0):
                    continue
                with (logs / f"{role}.log").open("a") as log:
                    log.write(f"\n--- starting {role} at {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
                    log.flush()
                    children[role] = subprocess.Popen(
                        pipeline(launcher, args, source, output), stdin=subprocess.DEVNULL,
                        stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                print(f"{role}: relay process started (PID {children[role].pid})", flush=True)
            time.sleep(0.2)
    finally:
        for child in children.values():
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        deadline = time.monotonic() + 5
        for child in children.values():
            try:
                child.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()
        print("All relays stopped.", flush=True)


if __name__ == "__main__":
    main()
