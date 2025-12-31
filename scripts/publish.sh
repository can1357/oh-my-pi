#!/usr/bin/env bash
set -e

# Publish all @oh-my-pi packages
# Usage: ./scripts/publish.sh [--dry-run]

DRY_RUN=""
if [[ "$1" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
  echo "🔍 Dry run mode - no packages will be published"
fi

echo "📦 Publishing @oh-my-pi packages..."
echo ""

# Build first
echo "🔨 Building CLI..."
bun run build

# Publish CLI
echo ""
echo "📤 Publishing @oh-my-pi/cli..."
npm publish --access public $DRY_RUN

# Publish plugins
echo ""
echo "📤 Publishing @oh-my-pi/subagents..."
cd plugins/subagents && npm publish --access public $DRY_RUN && cd ../..

echo ""
echo "📤 Publishing @oh-my-pi/metal-theme..."
cd plugins/metal-theme && npm publish --access public $DRY_RUN && cd ../..

echo ""
echo "✅ All packages published!"
