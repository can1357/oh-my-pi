#!/usr/bin/env bash
set -euo pipefail

RUN_ROOT="runs/autoresearch-mapreduce/latest"

bun scripts/autoresearch-mapreduce-bench.ts "$RUN_ROOT"
