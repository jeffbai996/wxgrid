"""Opt-in boundary snapshots, never a sampler, worker or time-series cache."""
from contextvars import ContextVar
import json
import logging
import os
from pathlib import Path
import time

log = logging.getLogger("wxgrid.ingest")
current = ContextVar("ingest_phase", default=None)


def snapshot():
    out = {}
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            name, _, value = line.partition(":")
            if name in ("VmRSS", "VmHWM"):
                out[{"VmRSS": "rss_bytes", "VmHWM": "lifetime_peak_rss_bytes"}[name]] = int(value.split()[0]) * 1024
        for line in Path("/proc/self/io").read_text().splitlines():
            name, value = line.split(":", 1)
            if name in ("read_bytes", "write_bytes"):
                out[name] = int(value)
        relative = next(line[3:] for line in Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::"))
        root = Path("/sys/fs/cgroup") / relative.lstrip("/")
        for name in ("memory.current", "memory.peak", "memory.swap.current", "memory.swap.peak"):
            try:
                out["cgroup_" + name.replace(".", "_") + "_bytes"] = int((root / name).read_text())
            except (OSError, ValueError):
                pass
    except (OSError, ValueError, StopIteration, IndexError):
        pass
    return out


class Phase:
    def __init__(self, model, run, name):
        self.enabled = os.getenv("WXGRID_PHASE_METRICS", "0") == "1"
        self.identity = dict(model=model, run=run, phase=name)
        self.count = self.skipped = 0
        self.gate_seconds = 0.0
        self.sampled_peak = 0

    def __enter__(self):
        if self.enabled:
            self.started = self.last_log = time.monotonic()
            self.cpu = os.times()
            self.before = snapshot()
            self.token = current.set(self)
            self.emit("start")
        return self

    def tick(self, *, skipped=False):
        self.skipped += int(skipped)
        self.count += int(not skipped)
        if self.enabled and time.monotonic() - self.last_log >= 60:
            self.emit("progress")

    def emit(self, status):
        # Diagnostics must never make an otherwise good run fail.
        try:
            now, cpu, state = time.monotonic(), os.times(), snapshot()
            self.sampled_peak = max(self.sampled_peak, state.get("rss_bytes", 0))
            for key in ("read_bytes", "write_bytes"):
                if key in state and key in self.before:
                    state[key + "_delta"] = max(0, state.pop(key) - self.before[key])
            log.info("phase %s", json.dumps({**self.identity, **state, "status": status,
                     "wall_s": round(now - self.started, 3), "user_s": round(cpu.user - self.cpu.user, 3),
                     "system_s": round(cpu.system - self.cpu.system, 3), "gate_wait_s": round(self.gate_seconds, 3),
                     "completed": self.count, "cache_skips": self.skipped,
                     "logged_boundary_peak_rss_bytes": self.sampled_peak}, sort_keys=True))
            self.last_log = now
        except Exception:
            pass

    def __exit__(self, kind, value, traceback):
        if self.enabled:
            self.emit("ok" if kind is None else "deferred" if kind.__name__ == "FetchDeferred" else "error")
            current.reset(self.token)
