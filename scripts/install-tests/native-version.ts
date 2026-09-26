import { createRequire } from "node:module";

const VERSION_SENTINEL_RE = /^__piNativesV(\d+)_(\d+)_(\d+)$/;

/**
 * Return the release version a native addon reports: its post-link stamp via
 * `__piNativesBuildVersion()`, else the sole legacy `__piNativesV*` export.
 */
export function nativeVersionFromBindings(bindings: Record<string, unknown>): string | undefined {
	const report = bindings.__piNativesBuildVersion;
	if (typeof report === "function") {
		const version: unknown = report();
		return typeof version === "string" && version.length > 0 ? version : undefined;
	}
	const versions = Object.keys(bindings)
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
	const version = nativeVersionFromBindings(bindings);
	if (!version) throw new Error(`Native addon reports no unique release version: ${addonPath}`);
	process.stdout.write(version);
}
