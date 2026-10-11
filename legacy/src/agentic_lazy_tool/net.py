"""A quick check for an internet connection."""

import socket

# Public DNS servers: reachable by address, so the check does not depend on name lookup.
PROBES = [("1.1.1.1", 443), ("8.8.8.8", 443)]


def online(timeout: float = 1.0) -> bool:
    for address in PROBES:
        try:
            socket.create_connection(address, timeout).close()
            return True
        except OSError:
            continue
    return False
