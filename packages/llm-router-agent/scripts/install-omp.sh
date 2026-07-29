#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-$PWD/.ompk/extensions/llm-router-agent-tooluse}"

npm --prefix "$ROOT" run build
mkdir -p "$TARGET"
cp "$ROOT/package.json" "$TARGET/package.json"
cp -R "$ROOT/dist" "$TARGET/dist"
cp -R "$ROOT/examples" "$TARGET/examples"
cp -R "$ROOT/docs" "$TARGET/docs"

echo "Installed LLM Router Agent Tool-Use extension to $TARGET"
echo "Restart OMP or run /reload-plugins if available."
