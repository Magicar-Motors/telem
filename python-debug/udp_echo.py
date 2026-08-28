#!/usr/bin/env python3
"""Ground-station side: receive the Jetson's probe packets and echo them back.

Reports the *uplink* (Jetson -> here) view of the link: how many packets
arrived, how many went missing, how many arrived out of order, and the
inter-arrival jitter. The sender computes RTT from the echoes.

    python3 udp_echo.py --port 9100

Clocks are never compared across hosts, so nothing here needs NTP.
"""

import argparse
import signal
import socket
import sys
import time

from udp_common import percentile, unpack


class UplinkStats(object):
    def __init__(self, expected_interval):
        self.expected_interval = expected_interval
        self.first_seq = None
        self.max_seq = -1
        self.received = 0
        self.duplicates = 0
        self.reordered = 0
        self.bytes_in = 0
        self.seen = set()
        self.ipdv = []          # |arrival delta - expected|, ms
        self.last_arrival = None
        self.started = None
        # since the last periodic report
        self.win_received = 0
        self.win_max_seq = -1
        self.win_first_seq = None

    def record(self, seq, nbytes, now):
        if self.started is None:
            self.started = now
            self.first_seq = seq
        if seq in self.seen:
            self.duplicates += 1
            return
        self.seen.add(seq)
        if seq < self.max_seq:
            self.reordered += 1
        self.max_seq = max(self.max_seq, seq)
        self.received += 1
        self.bytes_in += nbytes

        if self.last_arrival is not None:
            delta = now - self.last_arrival
            self.ipdv.append(abs(delta - self.expected_interval) * 1000.0)
        self.last_arrival = now

        if self.win_first_seq is None:
            self.win_first_seq = seq
        self.win_received += 1
        self.win_max_seq = max(self.win_max_seq, seq)

    def window(self):
        """(received, expected, loss_pct) since the last call; then reset."""
        if self.win_first_seq is None:
            return 0, 0, 0.0
        expected = self.win_max_seq - self.win_first_seq + 1
        recv = self.win_received
        loss = 100.0 * (expected - recv) / expected if expected > 0 else 0.0
        self.win_received = 0
        self.win_max_seq = -1
        self.win_first_seq = None
        return recv, expected, loss

    def expected_total(self):
        if self.first_seq is None:
            return 0
        return self.max_seq - self.first_seq + 1


def _raise_interrupt(signum, frame):
    raise KeyboardInterrupt


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="0.0.0.0", help="bind address (default: all)")
    ap.add_argument("--port", type=int, default=9100, help="bind port (default: 9100)")
    ap.add_argument("--rate", type=float, default=25.0,
                    help="expected sender rate in Hz, used for jitter (default: 25)")
    ap.add_argument("--report", type=float, default=1.0,
                    help="seconds between progress lines (default: 1)")
    ap.add_argument("--no-echo", action="store_true",
                    help="receive only; the sender will then see 100%% RTT loss")
    ap.add_argument("--rcvbuf", type=int, default=1 << 20,
                    help="SO_RCVBUF in bytes (default: 1 MiB)")
    args = ap.parse_args()

    # Print the summary on `kill` too, not just ctrl-c.
    signal.signal(signal.SIGTERM, _raise_interrupt)

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, args.rcvbuf)
    except OSError:
        pass
    sock.bind((args.host, args.port))
    sock.settimeout(0.5)

    print("listening on %s:%d  (echo %s)"
          % (args.host, args.port, "off" if args.no_echo else "on"))
    print("waiting for packets... ctrl-c to stop\n")

    stats = UplinkStats(1.0 / args.rate)
    peer = None
    next_report = None
    foreign = 0

    try:
        while True:
            try:
                data, addr = sock.recvfrom(65535)
            except socket.timeout:
                if next_report is not None and time.monotonic() >= next_report:
                    report(stats, next_report)
                    next_report += args.report
                continue

            now = time.monotonic()
            parsed = unpack(data)
            if parsed is None:
                foreign += 1
                continue
            seq, t_send, echo_size = parsed

            if addr != peer:
                if peer is not None:
                    print("peer changed: %s -> %s" % (peer[0], addr[0]))
                else:
                    print("first packet from %s:%d (%d bytes)" % (addr[0], addr[1], len(data)))
                peer = addr
                next_report = now + args.report

            stats.record(seq, len(data), now)

            if not args.no_echo:
                # Echo exactly the size the sender asked for: the header (which
                # carries its timestamp) plus padding, truncated or extended.
                if echo_size <= len(data):
                    reply = data[:echo_size]
                else:
                    reply = data + b"\x00" * (echo_size - len(data))
                try:
                    sock.sendto(reply, addr)
                except OSError as exc:
                    print("echo failed: %s" % exc, file=sys.stderr)

            if now >= next_report:
                report(stats, now)
                next_report += args.report
    except KeyboardInterrupt:
        print("")
    finally:
        summary(stats, foreign)
        sock.close()


def report(stats, now):
    recv, expected, loss = stats.window()
    if expected == 0:
        print("  ... no packets in window")
        return
    print("  rx %4d/%4d  loss %5.1f%%   total rx %d  lost %d"
          % (recv, expected, loss, stats.received,
             stats.expected_total() - stats.received))


def summary(stats, foreign):
    print("\n=== uplink (jetson -> here) ===")
    if stats.received == 0:
        print("no probe packets received.")
        if foreign:
            print("(%d non-probe datagrams arrived on this port)" % foreign)
        return
    expected = stats.expected_total()
    lost = expected - stats.received
    elapsed = (stats.last_arrival - stats.started) or 1e-9
    print("packets received : %d" % stats.received)
    print("packets expected : %d  (seq %d..%d)"
          % (expected, stats.first_seq, stats.max_seq))
    print("packets lost     : %d  (%.2f%%)" % (lost, 100.0 * lost / expected))
    print("duplicates       : %d" % stats.duplicates)
    print("out of order     : %d" % stats.reordered)
    print("effective rate   : %.2f Hz  (%.2f Mbit/s)"
          % (stats.received / elapsed, stats.bytes_in * 8.0 / elapsed / 1e6))
    if stats.ipdv:
        j = sorted(stats.ipdv)
        print("arrival jitter   : p50 %.1f ms  p95 %.1f ms  max %.1f ms"
              % (percentile(j, 50), percentile(j, 95), j[-1]))
    if foreign:
        print("non-probe datagrams: %d" % foreign)


if __name__ == "__main__":
    main()
