"""Just enough WebSocket to talk to Chrome's debugger, on the standard library.

`websocket-client` would do this in one import, but it is not a wxgrid
dependency and a test tool is a poor reason for a public repo to grow one. The
protocol surface a CDP client actually touches is small: a client handshake,
masked text frames out, unmasked frames in, and enough framing to reassemble a
screenshot that arrives in several megabytes of continuation frames.

Not a general implementation. It speaks to one peer, on the loopback interface,
that is known to behave.
"""
from __future__ import annotations

import base64
import os
import socket
import struct
import urllib.parse


class WSError(RuntimeError):
    pass


class WebSocket:
    """A text-frame connection to a ws:// endpoint."""

    def __init__(self, url: str, timeout: float = 60.0):
        u = urllib.parse.urlparse(url)
        if u.scheme != "ws":
            raise WSError(f"only ws:// is supported here, got {u.scheme!r}")
        self.sock = socket.create_connection((u.hostname, u.port or 80), timeout=timeout)
        self.sock.settimeout(timeout)
        self._buf = b""
        self._handshake(u)

    def _handshake(self, u) -> None:
        key = base64.b64encode(os.urandom(16)).decode()
        path = u.path or "/"
        if u.query:
            path += "?" + u.query
        req = (f"GET {path} HTTP/1.1\r\n"
               f"Host: {u.hostname}:{u.port or 80}\r\n"
               "Upgrade: websocket\r\n"
               "Connection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\n"
               "Sec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(req.encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WSError("connection closed during handshake")
            head += chunk
        header, _, rest = head.partition(b"\r\n\r\n")
        if b" 101 " not in header.split(b"\r\n")[0]:
            raise WSError(f"handshake refused: {header.split(chr(13).encode())[0][:120]!r}")
        self._buf = rest                       # frames may already have started

    # ── framing ───────────────────────────────────────────────────────────
    def _recv_exact(self, n: int) -> bytes:
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise WSError("connection closed")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _read_frame(self) -> tuple[int, bool, bytes]:
        b0, b1 = self._recv_exact(2)
        fin = bool(b0 & 0x80)
        opcode = b0 & 0x0F
        masked = bool(b1 & 0x80)
        length = b1 & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._recv_exact(8))[0]
        mask = self._recv_exact(4) if masked else b""
        payload = self._recv_exact(length)
        if masked:
            m = bytearray(payload)
            for i in range(len(m)):
                m[i] ^= mask[i & 3]
            payload = bytes(m)
        return opcode, fin, payload

    def send(self, text: str) -> None:
        """One masked text frame. Chrome accepts a whole message per frame."""
        data = text.encode()
        header = bytearray([0x81])             # FIN + text
        n = len(data)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        mask = os.urandom(4)
        header += mask
        payload = bytearray(data)
        for i in range(len(payload)):
            payload[i] ^= mask[i & 3]
        self.sock.sendall(bytes(header) + bytes(payload))

    def recv(self) -> str:
        """The next complete text message, reassembled across continuations."""
        chunks: list[bytes] = []
        while True:
            opcode, fin, payload = self._read_frame()
            if opcode == 0x8:                  # close
                raise WSError("peer closed the connection")
            if opcode == 0x9:                  # ping -> pong, same payload
                self._pong(payload)
                continue
            if opcode == 0xA:                  # pong
                continue
            chunks.append(payload)
            if fin:
                return b"".join(chunks).decode("utf-8", "replace")

    def _pong(self, payload: bytes) -> None:
        mask = os.urandom(4)
        m = bytearray(payload)
        for i in range(len(m)):
            m[i] ^= mask[i & 3]
        self.sock.sendall(bytes([0x8A, 0x80 | len(payload)]) + mask + bytes(m))

    def close(self) -> None:
        try:
            self.sock.sendall(bytes([0x88, 0x80]) + os.urandom(4))
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


def create_connection(url: str, timeout: float = 60.0, **_ignored) -> WebSocket:
    """Signature-compatible with the corner of websocket-client we used."""
    return WebSocket(url, timeout=timeout)
