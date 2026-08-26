"""A small raw-CDP driver for a Chrome that is already running.

Why not Playwright: the app registers a service worker, and Playwright asserts
on service-worker targets it does not own, so a worker left registered by an
earlier page blocks `connect_over_cdp` for the whole browser. Raw CDP holds no
such opinion, and `Target.createBrowserContext` hands back a throwaway
incognito profile, so every run starts with an empty HTTP cache and no worker
of its own.

Standard library only. The WebSocket half lives in `ws.py` rather than pulling
in `websocket-client`, because a test tool is a poor reason for a public repo
to grow a dependency.

    from tests.visual.driver import Chrome, Tab

    chrome = Chrome()
    tab = Tab(chrome, "http://127.0.0.1:8097/#temp")
    tab.wait("window.WX && WX.map")
    tab.shot("/tmp/out.png")
    tab.close(); chrome.close()
"""
from __future__ import annotations

import base64
import json
import os
import time
import urllib.request

from tests.visual import ws


class BrowserUnavailable(RuntimeError):
    """No debuggable Chrome answered on the port."""


def chrome_port() -> int:
    return int(os.environ.get("BROWSE_CHROME_PORT", "9224"))


def available(port: int | None = None, timeout: float = 2.0) -> bool:
    """True when a debuggable Chrome answers. Used to skip, not to fail."""
    port = port or chrome_port()
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=timeout)
        return True
    except Exception:
        return False


class Chrome:
    """One websocket to the browser endpoint. Not thread-safe by design: the
    request/response loop below assumes a single caller."""

    def __init__(self, port: int | None = None, timeout: int = 60):
        port = port or chrome_port()
        try:
            info = json.load(urllib.request.urlopen(
                f"http://127.0.0.1:{port}/json/version", timeout=10))
        except Exception as exc:
            raise BrowserUnavailable(f"no debuggable Chrome on port {port}: {exc}") from exc
        self.ws = ws.create_connection(
            info["webSocketDebuggerUrl"], timeout=timeout, suppress_origin=True)
        self._id = 0
        self.events: list[dict] = []

    def call(self, method: str, params: dict | None = None,
             session: str | None = None, timeout: int = 60) -> dict:
        self._id += 1
        msg: dict = {"id": self._id, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        self.ws.send(json.dumps(msg))
        end = time.time() + timeout
        while time.time() < end:
            m = json.loads(self.ws.recv())
            if m.get("id") == self._id:
                if "error" in m:
                    raise RuntimeError(f"{method}: {m['error']}")
                return m.get("result", {})
            # Everything else on this socket is an event for some session. Keep
            # a bounded tail so a caller can look at console output afterwards.
            self.events.append(m)
            del self.events[:-500]
        raise TimeoutError(method)

    def close(self) -> None:
        try:
            self.ws.close()
        except Exception:
            pass

    def __enter__(self) -> "Chrome":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


class Tab:
    """A page in its own throwaway browser context, at a fixed size."""

    def __init__(self, chrome: Chrome, url: str, width: int = 1280, height: int = 800,
                 scale: int = 1, mobile: bool = False):
        self.c = chrome
        self.console: list[str] = []
        self.bcid = chrome.call("Target.createBrowserContext",
                                {"disposeOnDetach": False})["browserContextId"]
        self.tid = chrome.call("Target.createTarget",
                               {"url": "about:blank", "browserContextId": self.bcid,
                                "width": width, "height": height})["targetId"]
        self.sid = chrome.call("Target.attachToTarget",
                               {"targetId": self.tid, "flatten": True})["sessionId"]
        chrome.call("Page.enable", session=self.sid)
        chrome.call("Runtime.enable", session=self.sid)
        chrome.call("Emulation.setDeviceMetricsOverride",
                    {"width": width, "height": height, "deviceScaleFactor": scale,
                     "mobile": mobile}, session=self.sid)
        chrome.call("Page.navigate", {"url": url}, session=self.sid)

    def eval(self, expression: str, await_promise: bool = False, timeout: int = 90):
        """Run an expression in the page. This is `Runtime.evaluate` over CDP,
        which is the entire point of a browser driver: the expressions come
        from this repo's own test code and the page is our own local server.
        Nothing here is reachable from user input or from the network."""
        r = self.c.call("Runtime.evaluate",
                        {"expression": expression, "awaitPromise": await_promise,
                         "returnByValue": True, "allowUnsafeEvalBlockedByCSP": True},
                        session=self.sid, timeout=timeout)
        if "exceptionDetails" in r:
            raise RuntimeError(json.dumps(r["exceptionDetails"])[:400])
        return r["result"].get("value")

    def wait(self, expression: str, timeout: float = 90, gap: float = 0.4) -> bool:
        """Poll a JS expression until it is truthy. Exceptions while the page is
        still loading are expected, not failures."""
        end = time.time() + timeout
        last = ""
        while time.time() < end:
            try:
                if self.eval(f"!!({expression})"):
                    return True
            except Exception as exc:
                last = str(exc)[:200]
            time.sleep(gap)
        raise TimeoutError(f"{expression} (last error: {last})" if last else expression)

    def shot(self, path: str, fmt: str = "png", quality: int | None = None) -> None:
        p: dict = {"format": fmt, "captureBeyondViewport": False}
        if quality is not None:
            p["quality"] = quality
        data = self.c.call("Page.captureScreenshot", p, session=self.sid)["data"]
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))

    def close(self) -> None:
        for method, params in (("Target.closeTarget", {"targetId": self.tid}),
                               ("Target.disposeBrowserContext", {"browserContextId": self.bcid})):
            try:
                self.c.call(method, params)
            except Exception:
                pass

    def __enter__(self) -> "Tab":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
