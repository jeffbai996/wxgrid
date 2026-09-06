"""Read-only field benchmark or decoded-RGB comparison with a Git revision.

Run under a memory/CPU cap. The normal mode encodes one live field in a fresh
process. --verify-models checks the listed models, one field at a time, using
both encoders. It does not populate the render cache or alter model data.
"""
import argparse
import ast
import gc
import hashlib
import io
import json
from pathlib import Path
import resource
import subprocess
import time

import numpy as np
from PIL import Image
from wxgrid import api, render, store


def legacy_encoder(ref):
    source = subprocess.check_output(["git", "show", f"{ref}:wxgrid/render.py"], text=True)
    function = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == "encode_field")
    namespace = dict(vars(render))
    exec(compile(ast.Module(body=[function], type_ignores=[]), "<legacy encoder>", "exec"), namespace)
    return namespace["encode_field"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="hrrr")
    parser.add_argument("--run", default="latest")
    parser.add_argument("--layer", default="wind")
    parser.add_argument("--legacy-ref")
    parser.add_argument("--verify-models", nargs="+")
    args = parser.parse_args()
    old = legacy_encoder(args.legacy_ref) if args.legacy_ref else None
    if args.verify_models and old is None:
        parser.error("--verify-models requires --legacy-ref")
    for model in args.verify_models or [args.model]:
        run = store.list_runs(model)[0] if args.run == "latest" else args.run
        reader = api._reader(model, run)
        for layer in ("wind", "feels", "rh") if args.verify_models else [args.layer]:
            field = render.DISPLAY[layer](api.field_for(reader, layer, None, reader.steps[0]))
            encode = render.encode_field if args.verify_models or old is None else old
            start = time.perf_counter()
            blob = encode(field, layer, fmt="webp")
            elapsed = time.perf_counter() - start
            rss = next(line.split()[1] for line in Path("/proc/self/status").read_text().splitlines() if line.startswith("VmRSS:"))
            result = {"model": model, "run": run, "layer": layer, "seconds": round(elapsed, 4),
                      "rss_mib": round(int(rss)/1024, 1), "peak_mib": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024, 1),
                      "bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest()}
            if args.verify_models:
                reference = old(field, layer, fmt="webp")
                with Image.open(io.BytesIO(reference)) as before, Image.open(io.BytesIO(blob)) as after:
                    np.testing.assert_array_equal(np.asarray(before), np.asarray(after))
                result.update(decoded_pixels_equal=True, legacy_bytes=len(reference))
                del reference
            print(json.dumps(result), flush=True)
            del field, blob
            gc.collect()


if __name__ == "__main__":
    main()
