import { createRequire } from "node:module";

const VERSION_SENTINEL_RE = /^__piNativesV(\d+)_(\d+)_(\d+)$/;

/** Return the sole release version advertised by a native addon's exports. */
export function nativeVersionFromExports(exports: readonly string[]): string | undefined {
	const versions = exports
		.map(name => VERSION_SENTINEL_RE.exec(name))
		.filter((match): match is RegExpExecArray => match !== null)
		.map(match => `${match[1]}.${match[2]}.${match[3]}`);
	return versions.length === 1 ? versions[0] : undefined;
}

if (import.meta.main) {
	const addonPath = process.argv[2];
	if (!addonPath) throw new Error("Usage: bun scripts/install-tests/native-version.ts <addon-path>");
	const require = createRequire(import.meta.url);
	const bindings = require(addonPath) as Record<string, unknown>;
	const version = nativeVersionFromExports(Object.keys(bindings));
	if (!version) throw new Error(`Native addon has no unique release version sentinel: ${addonPath}`);
	process.stdout.write(version);
}
