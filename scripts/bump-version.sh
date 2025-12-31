#!/usr/bin/env bash
set -e

# Bump version across all packages
# Usage: ./scripts/bump-version.sh <version>
# Example: ./scripts/bump-version.sh 1.0.0

if [[ -z "$1" ]]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 1.0.0"
  exit 1
fi

VERSION="$1"

echo "📦 Bumping all packages to v$VERSION..."

# Update root package.json
echo "  Updating package.json..."
bun --eval "
const pkg = require('./package.json');
pkg.version = '$VERSION';
require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, '\t') + '\n');
"

# Update all plugin package.json files
for plugin_dir in plugins/*/; do
  if [[ -f "${plugin_dir}package.json" ]]; then
    plugin_name=$(basename "$plugin_dir")
    echo "  Updating plugins/${plugin_name}/package.json..."
    bun --eval "
const pkg = require('./${plugin_dir}package.json');
pkg.version = '$VERSION';
require('fs').writeFileSync('${plugin_dir}package.json', JSON.stringify(pkg, null, 2) + '\n');
"
  fi
done

# Update version in CLI
echo "  Updating src/cli.ts version..."
sed -i "s/\.version(\"[^\"]*\")/.version(\"$VERSION\")/" src/cli.ts

echo ""
echo "✅ All packages bumped to v$VERSION"
echo ""
echo "Next steps:"
echo "  1. git add -A && git commit -m 'chore: bump version to $VERSION'"
echo "  2. git tag v$VERSION"
echo "  3. git push && git push --tags"
