"""Shared packet format for the UDP link probe.

Wire layout (big-endian), padded with 0x00 out to the requested size:

    magic     4s   b"MGKP"
    seq       I    monotonically increasing, starts at 0
    t_send    d    sender's perf_counter() at send time (only the sender reads it)
    echo_size I    how many bytes the echo server should send back

The timestamp round-trips untouched, so RTT is (perf_counter() - t_send) on the
sender. No clock sync between the two hosts is needed or assumed.
"""

import struct

MAGIC = b"MGKP"
HEADER = struct.Struct("!4sIdI")
HEADER_SIZE = HEADER.size  # 20

MIN_SIZE = HEADER_SIZE


def pack(seq, t_send, echo_size, size):
    if size < MIN_SIZE:
        raise ValueError("packet size must be >= %d bytes" % MIN_SIZE)
    head = HEADER.pack(MAGIC, seq, t_send, echo_size)
    return head + b"\x00" * (size - HEADER_SIZE)


def unpack(data):
    """Return (seq, t_send, echo_size) or None if this isn't one of ours."""
    if len(data) < HEADER_SIZE:
        return None
    magic, seq, t_send, echo_size = HEADER.unpack(data[:HEADER_SIZE])
    if magic != MAGIC:
        return None
    return seq, t_send, echo_size


def percentile(sorted_values, pct):
    """Nearest-rank percentile over an already-sorted list."""
    if not sorted_values:
        return float("nan")
    k = int(round((pct / 100.0) * len(sorted_values) + 0.5)) - 1
    k = max(0, min(len(sorted_values) - 1, k))
    return sorted_values[k]
