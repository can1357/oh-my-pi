#!/bin/sh
# Rebuild this Mach-O and its cacheIdentity sibling after editing sidecar.swift.
set -euo pipefail
here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
src="$here/../../sidecar.swift"
out="$here/omp-apple-fm"
xcrun --sdk macosx swiftc -O -parse-as-library -target arm64-apple-macosx26.0 -o "$out" "$src"
cd "$here"
bun --eval 'import sidecarSource from "../../sidecar.swift" with { type: "text" };
const id = Bun.hash(`${sidecarSource}\0arm64-apple-macosx26.0`).toString(16);
await Bun.write("digest.txt", id + "\n");
'
