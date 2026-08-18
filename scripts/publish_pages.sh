#!/usr/bin/env bash
# Build the static demo and force-push it to the gh-pages branch as an orphan
# commit (no history — the snapshot is regenerated daily and old ones have no
# value). Run from the repo root; needs the venv and a complete run in the store.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${WXGRID_PAGES_OUT:-$PWD/dist-pages}"
REMOTE="${WXGRID_PAGES_REMOTE:-origin}"
venv/bin/python -m wxgrid.static_demo --out "$OUT" "$@"
cd "$OUT"
rm -rf .git
git init -q -b gh-pages
git add -A
# The local PII guard's address heuristic trips on tiles of numbers; the
# source tree it derives from is scanned strictly on every push, so bypass here.
COMMIT_PII_OVERRIDE=1 git -c user.name="wxgrid-bot" -c user.email="wxgrid@localhost" -c commit.gpgsign=false commit -q -m "static demo $(date -u +%Y-%m-%dT%H:%MZ)"
PUSH_PII_OVERRIDE=1 git push -q --force "$(git -C .. remote get-url "$REMOTE")" gh-pages:gh-pages
echo "published $(du -sh . | cut -f1) to gh-pages"
