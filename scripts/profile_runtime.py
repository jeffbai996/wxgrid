"""Bounded, read-only runtime profile; no upstream requests or cache writes.

Run with PYTHONPATH pointing at the checkout being measured. Compare the
same --model/--run and allocator environment across revisions. Reports Linux
RSS and peak RSS separately; image digests guard output equivalence.
"""
import argparse
import gc
import hashlib
import json
from pathlib import Path
import resource
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--model", default="hrrr")
parser.add_argument("--run", required=True)
args = parser.parse_args()


def sample(stage, **extra):
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
    print(json.dumps({"stage": stage, "rss_mib": round(int(status["VmRSS"].split()[0]) / 1024, 1),
                      "peak_mib": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
                      "threads": int(status["Threads"]), **extra}), flush=True)


t = time.perf_counter()
from wxgrid import api, render
sample("import", seconds=round(time.perf_counter() - t, 4))
for i in range(2):
    t = time.perf_counter()
    catalog = api.api_models()
    sample("catalog", attempt=i, seconds=round(time.perf_counter() - t, 4),
           digest=hashlib.sha256(json.dumps(catalog, sort_keys=True).encode()).hexdigest(), readers=len(api._readers))
t = time.perf_counter()
r = api._reader(args.model, args.run)
sample("reader", seconds=round(time.perf_counter() - t, 4))
for step, fmt in zip(r.steps[:3], ("webp", "png", "webp")):
    t = time.perf_counter()
    field = render.DISPLAY["wind"](api.field_for(r, "wind", None, step))
    blob = render.encode_field(field, "wind", fmt=fmt)
    sample("render", step=step, fmt=fmt, seconds=round(time.perf_counter() - t, 4),
           size=len(blob), digest=hashlib.sha256(blob).hexdigest())
    del blob, field
    gc.collect()
    sample("after_gc", step=step)
