#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"
WORK_DIR="$(mktemp -d)"
TMP_WORK_DIR="$WORK_DIR/tmp"
mkdir -p "$TMP_WORK_DIR"
export TMPDIR="$TMP_WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

section() {
   echo ""
   echo "=== $1 ==="
}

smoke_cli() {
   local omp_bin="$1"
   local runtime_dir
   runtime_dir="$(mktemp -d "$WORK_DIR/compiled-runtime.XXXXXX")"
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$omp_bin" --version
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$omp_bin" --help >/dev/null
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$omp_bin" stats --summary >/dev/null
   # Spawns bundled workers and serves the stats dashboard once. Regression
   # probe for #1011/#1027 worker loading and for npm/compiled distributions
   # missing the dashboard assets that `stats --summary` never touches.
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$omp_bin" --smoke-test
}

find_tarball() {
   # Callers pass an unquoted glob, so the shell expands it before the call:
   # one match arrives as one existing-file argument; zero matches arrive as
   # the literal glob string (not a file); several matches arrive as several
   # arguments.
   if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
      echo "Expected exactly one tarball matching: $*" >&2
      exit 1
   fi

   echo "$1"
}

section "Binary install smoke"
bun --cwd=packages/natives run build
bun --cwd=packages/coding-agent run build

BINARY_DIR="$WORK_DIR/binary-bin"
mkdir -p "$BINARY_DIR"
cp packages/coding-agent/dist/omp "$BINARY_DIR/omp"
cp packages/coding-agent/dist/ompk "$BINARY_DIR/ompk"
smoke_cli "$BINARY_DIR/omp"
smoke_cli "$BINARY_DIR/ompk"

section "Source install smoke"
SOURCE_BUN_HOME="$WORK_DIR/bun-source"
(
   export BUN_INSTALL="$SOURCE_BUN_HOME"
   export PATH="$BUN_INSTALL/bin:$PATH"
   bun --cwd="$ROOT_DIR/packages/coding-agent" link
   smoke_cli "$BUN_INSTALL/bin/omp"
   smoke_cli "$BUN_INSTALL/bin/ompk"
)

section "Tarball install smoke"
TARBALL_DIR="$WORK_DIR/tarballs"
mkdir -p "$TARBALL_DIR"
host_tag="$(bun -e "process.stdout.write(\`\${process.platform}-\${process.arch}\`)")"

# Native addon split: the published core ships only the loader (no `.node`); the
# prebuilt binary lives in a per-platform leaf package pulled in as an optional
# dependency. Reproduce that exact published topology so this smoke proves the
# installed core resolves its addon through the leaf, not a bundled binary.

# 1. Generate + pack the host-platform leaf (carries the built `.node`).
bun --cwd=packages/natives run gen:npm --tag "$host_tag" >/dev/null
(
   cd "$ROOT_DIR/packages/natives/npm/$host_tag"
   bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null
)

# 2. Pack the core with its *published* manifest: the same rewrite release uses
#    drops `.node` from `files` and adds the leaf `optionalDependencies`. Always
#    restore the working-tree manifest so local runs aren't left mutated.
natives_pkg_backup="$WORK_DIR/natives-package.json.orig"
cp "$ROOT_DIR/packages/natives/package.json" "$natives_pkg_backup"
core_rc=0
{
   bun -e 'import { prepareNativeCorePackage } from "./scripts/ci-release-publish.ts"; await prepareNativeCorePackage("packages/natives", true);' &&
      (cd "$ROOT_DIR/packages/natives" && bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null)
} || core_rc=$?
cp "$natives_pkg_backup" "$ROOT_DIR/packages/natives/package.json"
[ "$core_rc" -eq 0 ] || exit "$core_rc"

# 3. Pack the remaining workspace packages (natives core and coding-agent
#    handled separately). `collab-web` is private but still packed here so its
#    prepack build and tarball file list stay release-safe.
for pkg in utils wire hashline catalog ai mnemopi snapcompact agent tui stats deep-research collab-web; do
   (
      cd "$ROOT_DIR/packages/$pkg"
      bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null
   )
done

# 4. Pack the coding agent with its *published* manifest: release swaps
#    `bin.omp` from `src/cli.ts` to the prepack bundle `dist/cli.js`. The repo
#    manifest keeps pointing at source so `bun link`/`install.sh --source`
#    work without a build, so the swap must be reproduced here for the smoke
#    to exercise the bundled worker-host entry the published package ships.
#    Always restore the working-tree manifest.
agent_pkg_backup="$WORK_DIR/coding-agent-package.json.orig"
cp "$ROOT_DIR/packages/coding-agent/package.json" "$agent_pkg_backup"
agent_rc=0
{
   bun -e 'import { applyPublishBin } from "./scripts/ci-release-publish.ts"; await applyPublishBin("packages/coding-agent", true);' &&
      (cd "$ROOT_DIR/packages/coding-agent" && bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null)
} || agent_rc=$?
cp "$agent_pkg_backup" "$ROOT_DIR/packages/coding-agent/package.json"
[ "$agent_rc" -eq 0 ] || exit "$agent_rc"

utils_tgz="$(find_tarball "$TARBALL_DIR"/pk-nerdsaver-ai-pi-utils-*.tgz)"
wire_tgz="$(find_tarball "$TARBALL_DIR"/pk-nerdsaver-ai-pi-wire-*.tgz)"
natives_tgz="$(find_tarball "$TARBALL_DIR"/pk-nerdsaver-ai-pi-natives-[0-9]*.tgz)"
natives_leaf_tgz="$(find_tarball "$TARBALL_DIR"/pk-nerdsaver-ai-pi-natives-"$host_tag"-*.tgz)"
hashline_tgz="$(find_tarball "$TARBALL_DIR"/pk-nerdsaver-ai-hashline-*.tgz)"
catalog_tgz="$(find_tarball "$TARBALL_DIR"/pk-nerdsaver-ai-pi-catalog-*.tgz)"
ai_tgz="$(find_tarball "$TARBALL_DIR"/pk-nerdsaver-ai-pi-ai-*.tgz)"
mnemopi_tgz="$(find_tarball "$TARBALL_DIR"/pk-nerdsaver-ai-pi-mnemopi-*.tgz)"
snapcompact_tgz="$(find_tarball "$TARBALL_DIR"/pk-nerdsaver-ai-snapcompact-*.tgz)"
agent_tgz="$(find_tarball "$TARBALL_DIR"/pk-nerdsaver-ai-pi-agent-core-*.tgz)"
tui_tgz="$(find_tarball "$TARBALL_DIR"/pk-nerdsaver-ai-pi-tui-*.tgz)"
stats_tgz="$(find_tarball "$TARBALL_DIR"/pk-nerdsaver-ai-omp-stats-*.tgz)"
deep_research_tgz="$(find_tarball "$TARBALL_DIR"/pk-nerdsaver-ai-pi-deep-research-*.tgz)"
coding_agent_tgz="$(find_tarball "$TARBALL_DIR"/pk-nerdsaver-ai-pi-coding-agent-*.tgz)"
collab_web_tgz="$(find_tarball "$TARBALL_DIR"/pk-nerdsaver-ai-collab-web-*.tgz)"

TARBALL_APP_DIR="$WORK_DIR/tarball-install"
mkdir -p "$TARBALL_APP_DIR"
(
   cd "$TARBALL_APP_DIR"
   bun init -y >/dev/null

   # Write overrides so bun resolves inter-package deps from tarballs, not the registry
   # (the version under test has not necessarily been published yet).
   node -e "
		const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8'));
		pkg.overrides = {
			'@pk-nerdsaver-ai/pi-utils': '$utils_tgz',
			'@pk-nerdsaver-ai/pi-wire': '$wire_tgz',
			'@pk-nerdsaver-ai/pi-natives': '$natives_tgz',
			'@pk-nerdsaver-ai/pi-natives-$host_tag': '$natives_leaf_tgz',
			'@pk-nerdsaver-ai/hashline': '$hashline_tgz',
			'@pk-nerdsaver-ai/pi-ai': '$ai_tgz',
			'@pk-nerdsaver-ai/pi-catalog': '$catalog_tgz',
			'@pk-nerdsaver-ai/pi-mnemopi': '$mnemopi_tgz',
			'@pk-nerdsaver-ai/snapcompact': '$snapcompact_tgz',
			'@pk-nerdsaver-ai/pi-agent-core': '$agent_tgz',
			'@pk-nerdsaver-ai/pi-tui': '$tui_tgz',
			'@pk-nerdsaver-ai/omp-stats': '$stats_tgz',
			'@pk-nerdsaver-ai/pi-deep-research': '$deep_research_tgz',
			'@pk-nerdsaver-ai/pi-coding-agent': '$coding_agent_tgz',
			'@pk-nerdsaver-ai/collab-web': '$collab_web_tgz'
		};
		require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));
	"

   bun add "$utils_tgz" "$wire_tgz" "$natives_tgz" "$hashline_tgz" "$catalog_tgz" "$ai_tgz" "$mnemopi_tgz" "$snapcompact_tgz" "$agent_tgz" "$tui_tgz" "$stats_tgz" "$deep_research_tgz" "$coding_agent_tgz" "$collab_web_tgz"
   # The platform leaf must arrive through the core's optionalDependencies +
   # override, not as a direct dependency — assert it landed before smoking so a
   # resolution regression is distinguishable from a runtime loader bug.
   leaf_dir="node_modules/@pk-nerdsaver-ai/pi-natives-$host_tag"
   [ -d "$leaf_dir" ] || {
      echo "Platform leaf package not installed: $leaf_dir"
      exit 1
   }
   # The tarball-installed wire package must expose the same protocol version
   # the workspace source defines — a hard-coded literal here just drifts.
   wire_proto="$(bun -e 'import { COLLAB_PROTO } from "@pk-nerdsaver-ai/pi-wire"; process.stdout.write(String(COLLAB_PROTO));')"
   expected_wire_proto="$(cd "$ROOT_DIR" && bun -e 'import { COLLAB_PROTO } from "@pk-nerdsaver-ai/pi-wire"; process.stdout.write(String(COLLAB_PROTO));')"
   [ -n "$expected_wire_proto" ] && [ "$wire_proto" = "$expected_wire_proto" ] || {
      echo "Unexpected @pk-nerdsaver-ai/pi-wire COLLAB_PROTO: $wire_proto (workspace defines: $expected_wire_proto)"
      exit 1
   }
   [ -f "node_modules/@pk-nerdsaver-ai/collab-web/dist/index.html" ] || {
      echo "Collab web tarball did not install built dist/index.html"
      exit 1
   }
   smoke_cli ./node_modules/.bin/omp
   smoke_cli ./node_modules/.bin/ompk
)

echo ""
echo "All install method smoke tests passed"
