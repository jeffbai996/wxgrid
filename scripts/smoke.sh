#!/usr/bin/env bash
# Post-deploy smoke against a running instance: the things a visit does in
# its first five seconds, end to end. Exit non-zero on the first failure.
# Usage: scripts/smoke.sh [base-url]   (default http://localhost:8097)
set -u
BASE="${1:-http://localhost:8097}"
LAT="${SMOKE_LAT:-49.28}"; LON="${SMOKE_LON:-(-123.12)}"; LON="${LON//[()]/}"
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
MODELS=$(curl -sf --max-time 20 "$BASE/api/models") || fail "/api/models"
MODEL=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); m=[x for x in d['models'] if x['runs']][0]; print(m['key'])" "$MODELS")
RUN=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); m=[x for x in d['models'] if x['key']=='$MODEL'][0]; print(m['runs'][0]['run'])" "$MODELS")
STEP=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); m=[x for x in d['models'] if x['key']=='$MODEL'][0]; print(m['runs'][0]['steps'][1])" "$MODELS")
P=$(curl -sf --max-time 60 "$BASE/api/point?lat=$LAT&lon=$LON&model=$MODEL&run=$RUN") || fail "/api/point"
python3 -c "import json,sys; d=json.loads(sys.argv[1]); assert d.get('available') and d['series'], d" "$P" || fail "point body"
curl -sf --max-time 60 -o /dev/null "$BASE/api/layer/$MODEL/$RUN/$STEP/wind.png" || fail "/api/layer"
# the card stream: the first line must be the point and must not carry an error
S=$(curl -sN --max-time 60 "$BASE/api/card?lat=$LAT&lon=$LON&model=$MODEL&run=$RUN" | head -n 1)
python3 - "$S" <<'PY' || fail "card stream"
import json, sys
first = json.loads(sys.argv[1])
assert first.get("kind") == "point" and "error" not in first and first["data"]["available"], first.get("error", first.get("kind"))
PY
echo "SMOKE OK: $MODEL $RUN point+layer+card"
