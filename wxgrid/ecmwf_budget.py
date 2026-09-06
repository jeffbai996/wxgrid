"""Single-owner ECMWF retry policy; no timeout threads or resident workers.

Deadlines are cooperative at requests/stream boundaries. DNS and OS calls
cannot be forcibly cancelled here. SDK and multiurl retry loops are disabled.
"""
from email.utils import parsedate_to_datetime
import logging
import os
import random
import time

import requests

log = logging.getLogger(__name__)
TRANSIENT = {408, 429, 500, 502, 503, 504}


class FetchDeferred(RuntimeError):
    """Keep completed downloads and try this incomplete run again later."""


def retry_delay(value, fallback, now=None):
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        try:
            return max(0.0, parsedate_to_datetime(value).timestamp() - (time.time() if now is None else now))
        except (TypeError, ValueError, OverflowError):
            return fallback


def valid_grib(path):
    """Validate concatenated GRIB2 framing with bounded reads, not a decode."""
    try:
        size = path.stat().st_size
        with path.open("rb") as f:
            offset = 0
            while offset < size:
                f.seek(offset)
                head = f.read(16)
                if len(head) != 16 or head[:4] != b"GRIB" or head[7] != 2:
                    return False
                length = int.from_bytes(head[8:16], "big")
                if length < 20 or offset + length > size:
                    return False
                f.seek(offset + length - 4)
                if f.read(4) != b"7777":
                    return False
                offset += length
            return size > 0 and offset == size
    except OSError:
        return False


class DeadlineSession(requests.Session):
    deadline = 0.0

    def remaining(self):
        left = self.deadline - time.monotonic()
        if left <= 0:
            raise FetchDeferred("ECMWF transfer deadline exhausted")
        return left

    def request(self, method, url, **kwargs):
        left = self.remaining()
        kwargs["timeout"] = (min(10.0, left), min(30.0, left))
        # Even SDK index responses must pass through the checked iterator.
        kwargs["stream"] = True
        response = super().request(method, url, **kwargs)
        if response.status_code in TRANSIENT or response.status_code in (401, 403):
            response.raise_for_status()
        if method.upper() == "HEAD":
            response.close()
            return response
        original = response.iter_content

        def chunks(*args, **kw):
            try:
                self.remaining()
                for chunk in original(*args, **kw):
                    self.remaining()
                    yield chunk
            finally:
                response.close()
                del response.iter_content  # break the wrapper's reference cycle

        response.iter_content = chunks
        return response


class BoundedECMWF:
    def __init__(self, model, client=None):
        if client is None:
            from ecmwf.opendata import Client
            client = Client(source="ecmwf", model=model.ecmwf_model, resol="0p25",
                            maximum_retries=1, retry_after=0)
        self.client = client
        client.session.close()
        client.session = DeadlineSession()
        self.attempts = max(1, int(os.getenv("WXGRID_ECMWF_ATTEMPTS", "4")))
        self.seconds = max(1, float(os.getenv("WXGRID_ECMWF_TRANSFER_SECONDS", "300")))
        self.wait_left = max(0, float(os.getenv("WXGRID_ECMWF_RETRY_WAIT_SECONDS", "900")))
        log.info("ECMWF budget: attempts=%d transfer_s=%g retry_wait_s=%g", self.attempts, self.seconds, self.wait_left)

    def _run(self, method, kwargs, seconds):
        self.client.session.deadline = time.monotonic() + seconds
        for attempt in range(self.attempts):
            self.client.session.remaining()
            try:
                result = getattr(self.client, method)(**kwargs)
                self.client.session.remaining()
                return result
            except requests.RequestException as exc:
                response = exc.response
                status = response.status_code if response is not None else None
                header = response.headers.get("Retry-After") if response is not None else None
                if response is not None:
                    response.close()
                # Auth, TLS and other permanent failures should not occupy the
                # slot or publish a partially fetched model as complete.
                if isinstance(exc, requests.exceptions.SSLError) or (status is not None and status not in TRANSIENT):
                    raise FetchDeferred(f"ECMWF HTTP/transport failure ({status})") from exc
                delay = retry_delay(header, min(60, 5 * 2**attempt) + random.random())
                left = self.client.session.remaining()
                if attempt + 1 >= self.attempts or delay >= left or delay > self.wait_left:
                    raise FetchDeferred(f"ECMWF retry budget exhausted ({status})") from exc
                self.wait_left -= delay
                log.warning("ECMWF retry: attempt=%d status=%s wait_s=%.1f", attempt + 1, status, delay)
                time.sleep(delay)
        raise AssertionError("unreachable")

    def retrieve(self, **kwargs):
        return self._run("retrieve", kwargs, self.seconds)

    def latest(self, **kwargs):
        return self._run("latest", kwargs, min(60, self.seconds))
