#!/usr/bin/env bash
set -euo pipefail

mkdir -p node_modules/@hitmux
if [ ! -e node_modules/@hitmux/hitmux-context-engine-core ]; then
    ln -s ../../packages/core node_modules/@hitmux/hitmux-context-engine-core
fi

out_dir="/opt/hitmux-context-engine/benchmark/results/test-hce-full-$(date +%Y%m%d-%H%M%S)"

pnpm build:core
pnpm --dir packages/mcp exec tsx ../../benchmark/run-test-hce-search-quality.ts \
    --run \
    --rerun-all \
    --out-dir "$out_dir"
