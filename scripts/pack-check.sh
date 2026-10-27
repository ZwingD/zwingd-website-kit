#!/usr/bin/env bash
# Pack every published package, install the tarballs into a clean consumer
# outside the workspace, and import each entry point, plain and with the
# `development` condition (which webpack, Vite and so Next add in dev mode).
# Fails if a published export points at a file the package does not ship.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/packs" "$WORK/consumer"
for pkg in "$ROOT"/packages/*/; do
  [ -f "$pkg/package.json" ] || continue
  (cd "$pkg" && pnpm pack --pack-destination "$WORK/packs" >/dev/null)
done

cd "$WORK/consumer"
npm init -y >/dev/null
npm install --no-audit --no-fund --silent "$WORK"/packs/*.tgz >/dev/null

ENTRIES=("@zwingd-ce/website-kit" "@zwingd-ce/website-kit-node")
if ls "$WORK"/packs/zwingd-ce-website-kit-next-*.tgz >/dev/null 2>&1; then
  npm install --no-audit --no-fund --silent next@16 react@19 react-dom@19 >/dev/null
  ENTRIES+=("@zwingd-ce/website-kit-next")
fi

for entry in "${ENTRIES[@]}"; do
  for flags in "" "--conditions=development"; do
    node $flags --input-type=module -e "import * as m from '$entry'; if (Object.keys(m).length === 0) process.exit(1);"
    node $flags -e "const m = require('$entry'); if (Object.keys(m).length === 0) process.exit(1);"
    echo "ok: $entry ${flags:-(default)}"
  done
done
