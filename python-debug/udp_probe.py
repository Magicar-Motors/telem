#!/usr/bin/env python3
"""Jetson side: send 1 KB UDP packets at 25 Hz and time the echoes.

    python3 udp_probe.py --host sudeshs-m1-macbook-pro

Reports round-trip time (min/p50/p95/p99/max/jitter) and round-trip loss.
The echo server prints the one-way uplink loss separately -- read both:
RTT loss counts a packet dropped in *either* direction, so
  uplink loss (from the echo server) vs RTT loss (here)
tells you which leg is dropping.

Single-threaded: the send schedule is absolute (no drift), and echoes are
drained with select() in the gaps between sends.
"""

import argparse
import select
import socket
import sys
import time

from udp_common import HEADER_SIZE, pack, percentile, unpack


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="sudeshs-m1-macbook-pro",
                    help="echo server host (default: sudeshs-m1-macbook-pro)")
    ap.add_argument("--port", type=int, default=9100, help="echo server port (default: 9100)")
    ap.add_argument("--size", type=int, default=1024, help="packet size in bytes (default: 1024)")
    ap.add_argument("--rate", type=float, default=25.0, help="packets per second (default: 25)")
    ap.add_argument("--duration", type=float, default=60.0,
                    help="seconds to run, 0 for unlimited (default: 60)")
    ap.add_argument("--echo-size", type=int, default=0,
                    help="bytes to echo back; 0 means same as --size. "
                         "Use a small value (e.g. 64) to isolate uplink congestion.")
    ap.add_argument("--report", type=float, default=1.0,
                    help="seconds between progress lines (default: 1)")
    ap.add_argument("--timeout", type=float, default=2.0,
                    help="an unechoed packet older than this counts as lost (default: 2)")
    ap.add_argument("--drain", type=float, default=2.0,
                    help="seconds to keep listening after the last send (default: 2)")
    args = ap.parse_args()

    if args.size < HEADER_SIZE:
        ap.error("--size must be at least %d bytes" % HEADER_SIZE)
    echo_size = args.echo_size or args.size
    if echo_size < HEADER_SIZE:
        ap.error("--echo-size must be at least %d bytes" % HEADER_SIZE)

    try:
        addr = socket.getaddrinfo(args.host, args.port, socket.AF_INET,
                                  socket.SOCK_DGRAM)[0][4]
    except socket.gaierror as exc:
        print("cannot resolve %s: %s" % (args.host, exc), file=sys.stderr)
        return 2

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setblocking(False)

    interval = 1.0 / args.rate
    print("probing %s:%d -- %d B at %.1f Hz (%.2f Mbit/s), echo %d B%s"
          % (addr[0], addr[1], args.size, args.rate,
             args.size * 8 * args.rate / 1e6, echo_size,
             ", %.0fs" % args.duration if args.duration else ", unlimited"))
    print("ctrl-c to stop early\n")

    inflight = {}       # seq -> t_send
    rtts = []           # ms
    rtt_by_seq = {}     # for jitter, in send order
    sent = 0
    echoed = 0
    late = 0            # echoes that arrived after we gave up on them
    win_rtts = []
    win_sent = 0
    win_echoed = 0
    send_errors = 0

    start = time.perf_counter()
    next_send = start
    next_report = start + args.report
    deadline = start + args.duration if args.duration else None
    interrupted = False

    try:
        while True:
            now = time.perf_counter()

            if deadline is not None and now >= deadline:
                break

            # --- send anything that's due (absolute schedule, no drift) ---
            while now >= next_send and (deadline is None or next_send < deadline):
                t_send = time.perf_counter()
                try:
                    sock.sendto(pack(sent, t_send, echo_size, args.size), addr)
                    inflight[sent] = t_send
                    sent += 1
                    win_sent += 1
                except OSError as exc:
                    send_errors += 1
                    if send_errors <= 3:
                        print("send failed: %s" % exc, file=sys.stderr)
                next_send += interval
                now = time.perf_counter()

            # --- forget packets we've waited long enough for (bounds memory;
            #     a later echo for one of them is counted as 'late') ---
            if inflight:
                cutoff = now - args.timeout
                stale = [s for s, t in inflight.items() if t < cutoff]
                for s in stale:
                    del inflight[s]

            # --- drain echoes until the next send is due ---
            wait = max(0.0, next_send - time.perf_counter())
            if next_report - time.perf_counter() < wait:
                wait = max(0.0, next_report - time.perf_counter())
            ready, _, _ = select.select([sock], [], [], wait)
            while ready:
                try:
                    data, _ = sock.recvfrom(65535)
                except (BlockingIOError, OSError):
                    break
                parsed = unpack(data)
                if parsed is not None:
                    seq, t_send, _ = parsed
                    if seq in inflight:
                        del inflight[seq]
                        rtt = (time.perf_counter() - t_send) * 1000.0
                        rtts.append(rtt)
                        rtt_by_seq[seq] = rtt
                        win_rtts.append(rtt)
                        echoed += 1
                        win_echoed += 1
                    else:
                        late += 1
                ready, _, _ = select.select([sock], [], [], 0)

            if time.perf_counter() >= next_report:
                progress(win_sent, win_echoed, win_rtts, sent, echoed)
                win_rtts = []
                win_sent = 0
                win_echoed = 0
                next_report += args.report
    except KeyboardInterrupt:
        interrupted = True
        print("")

    # Measure the send window only -- the drain below is not part of the run.
    elapsed = time.perf_counter() - start

    # --- drain: give the last packets in flight a chance to come home ---
    if args.drain > 0 and not interrupted:
        drain_until = time.perf_counter() + args.drain
        while time.perf_counter() < drain_until:
            ready, _, _ = select.select([sock], [], [],
                                        max(0.0, drain_until - time.perf_counter()))
            if not ready:
                break
            try:
                data, _ = sock.recvfrom(65535)
            except OSError:
                break
            parsed = unpack(data)
            if parsed is None:
                continue
            seq, t_send, _ = parsed
            if seq in inflight:
                del inflight[seq]
                rtt = (time.perf_counter() - t_send) * 1000.0
                rtts.append(rtt)
                rtt_by_seq[seq] = rtt
                echoed += 1
            else:
                late += 1

    sock.close()
    summary(sent, echoed, rtts, rtt_by_seq, late, send_errors, elapsed, args)
    return 0


def progress(win_sent, win_echoed, win_rtts, sent, echoed):
    if win_sent == 0:
        print("  ... idle")
        return
    loss = 100.0 * (win_sent - win_echoed) / win_sent
    if win_rtts:
        s = sorted(win_rtts)
        print("  tx %3d  rx %3d  loss %5.1f%%   rtt min %6.1f  p50 %6.1f  max %6.1f ms"
              % (win_sent, win_echoed, loss, s[0], percentile(s, 50), s[-1]))
    else:
        print("  tx %3d  rx %3d  loss %5.1f%%   rtt --  (total tx %d rx %d)"
              % (win_sent, win_echoed, loss, sent, echoed))


def summary(sent, echoed, rtts, rtt_by_seq, late, send_errors, elapsed, args):
    print("\n=== round trip (jetson -> ground -> jetson) ===")
    print("duration         : %.1f s" % elapsed)
    print("packets sent     : %d  (%.2f Hz actual)" % (sent, sent / elapsed if elapsed else 0))
    if send_errors:
        print("send errors      : %d" % send_errors)
    if sent == 0:
        return
    print("echoes received  : %d" % echoed)
    print("round-trip loss  : %d  (%.2f%%)"
          % (sent - echoed, 100.0 * (sent - echoed) / sent))
    if late:
        print("late echoes      : %d  (arrived after --timeout %.1fs)" % (late, args.timeout))

    if not rtts:
        print("\nno echoes came back. check that udp_echo.py is running on the")
        print("ground station and that UDP %d is reachable there." % args.port)
        return

    s = sorted(rtts)
    print("\nrtt min          : %.2f ms" % s[0])
    print("rtt p50          : %.2f ms" % percentile(s, 50))
    print("rtt p95          : %.2f ms" % percentile(s, 95))
    print("rtt p99          : %.2f ms" % percentile(s, 99))
    print("rtt max          : %.2f ms" % s[-1])
    print("rtt mean         : %.2f ms" % (sum(s) / len(s)))

    # RFC 3550 style jitter over consecutively-numbered packets
    seqs = sorted(rtt_by_seq)
    diffs = [abs(rtt_by_seq[b] - rtt_by_seq[a])
             for a, b in zip(seqs, seqs[1:]) if b == a + 1]
    if diffs:
        d = sorted(diffs)
        print("rtt jitter       : p50 %.2f ms  p95 %.2f ms  max %.2f ms"
              % (percentile(d, 50), percentile(d, 95), d[-1]))

    print("\ncompare 'round-trip loss' above with the 'packets lost' line printed")
    print("by udp_echo.py: uplink-only loss means the car's 5G upload is the")
    print("bottleneck, the remainder is the return leg.")


if __name__ == "__main__":
    sys.exit(main())
