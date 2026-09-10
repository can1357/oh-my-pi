import * as fs from "node:fs";
import * as path from "node:path";
import { FileType, glob } from "@oh-my-pi/pi-natives";
import { logger, VERSION } from "@oh-my-pi/pi-utils";

/**
 * Client↔server build pairing identity.
 *
 * A daemon outlives the CLI processes that talk to it; without a build
 * identity in the handshake, an old daemon keeps serving new clients forever
 * and code changes silently never take effect. The stamp combines the package
 * VERSION (release upgrades) with a source epoch (dev iterations from a
 * source checkout, where VERSION does not change between edits).
 *
 * - Source runs (`bun src/cli.ts`): epoch = newest mtime across the
 *   workspace packages' TypeScript sources (native glob, mtime-sorted).
 * - Compiled/npm runs: epoch = mtime of the entry binary/bundle itself — a
 *   reinstall or upgrade rewrites it.
 *
 * Equal stamps = same build; anything else means the daemon should be
 * replaced (or flagged) by the connecting client.
 */

let cachedStamp: Promise<string> | undefined;

async function sourceEpochMs(entry: string): Promise<number> {
	const entryStat = fs.statSync(entry);
	if (!entry.endsWith(".ts")) return Math.trunc(entryStat.mtimeMs);
	// Source checkout: cli.ts lives at <root>/packages/coding-agent/src/cli.ts;
	// scan the workspace packages' sources for the newest modification. A .ts
	// entry OUTSIDE that layout (SDK embedding, ad-hoc scripts) must not glob a
	// random grandparent directory — fall back to the entry's own mtime.
	const packagesRoot = path.resolve(path.dirname(entry), "..", "..");
	if (path.basename(packagesRoot) !== "packages") return Math.trunc(entryStat.mtimeMs);
	let newest = Math.trunc(entryStat.mtimeMs);
	try {
		const result = await glob({
			pattern: "*/src/**/*.ts",
			path: packagesRoot,
			fileType: FileType.File,
			sortByMtime: true,
			maxResults: 1,
			timeoutMs: 5_000,
		});
		const first = result.matches[0];
		if (first?.mtime !== undefined) newest = Math.max(newest, Math.trunc(first.mtime));
	} catch (error) {
		logger.debug("daemon build stamp source scan failed", { error: String(error) });
	}
	return newest;
}

/** Stable per-build identity shared by client and daemon handshakes. */
export function daemonBuildStamp(): Promise<string> {
	cachedStamp ??= (async () => {
		// Explicit override: lets packagers pin a build identity and lets the
		// pairing smoke run a deliberately stale daemon without mutating any
		// workspace mtimes.
		const override = process.env.OMP_DAEMON_BUILD_STAMP?.trim();
		if (override) return override;
		let epoch = 0;
		try {
			epoch = await sourceEpochMs(Bun.main);
		} catch (error) {
			logger.debug("daemon build stamp entry stat failed", { error: String(error) });
		}
		return `${VERSION}+${epoch.toString(36)}`;
	})();
	return cachedStamp;
}

/** Test-only: reset the memoized stamp. */
export function __resetDaemonBuildStampForTests(): void {
	cachedStamp = undefined;
}
