#!/usr/bin/env bash
# Research-layer test suite: python3 stdlib unittest, fully offline.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec python3 -m unittest discover -s research/tests -v
