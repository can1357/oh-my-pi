/**
 * Build identity exchanged in the daemon hello/welcome: `VERSION+<stamp>`.
 *
 * Two installs of the same `VERSION` (a rebuilt binary, a source checkout with
 * a fresh native addon) must not be mistaken for one build, or a client would
 * keep talking to a daemon that lacks its natives. The stamp orders builds by
 * the modification time of the files that make them up, so the newer one wins
 * an `upgrade` and two different installs never ping-pong.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isCompiledBinary, logger, VERSION } from "@oh-my-pi/pi-utils";
import { resolveCliEntryCmd } from "../subprocess/worker-client";

let cached: string | undefined;

function buildFiles(): string[] {
	if (isCompiledBinary()) return [process.execPath];
	// The entry the daemon is spawned and re-exec'd with; client and daemon both resolve the same file.
	const files: string[] = [];
	const entry = resolveCliEntryCmd()[1];
	if (entry) files.push(entry);
	try {
		const nativeDir = path.dirname(Bun.resolveSync("@oh-my-pi/pi-natives", import.meta.dir));
		for (const name of fs.readdirSync(nativeDir)) {
			if (name.endsWith(".node")) files.push(path.join(nativeDir, name));
		}
	} catch (error) {
		logger.debug("Could not locate the native addon for the daemon build stamp", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return files;
}

/**
 * Integer stamp: newest mtime (ms) of the build's files, times 1000, plus their
 * total size modulo 1000, so ordering follows mtime and same-mtime rebuilds of
 * a different size still differ.
 */
function buildStamp(): number {
	let mtimeMs = 0;
	let size = 0;
	for (const file of buildFiles()) {
		const stat = fs.statSync(file, { throwIfNoEntry: false });
		if (!stat) continue;
		mtimeMs = Math.max(mtimeMs, Math.floor(stat.mtimeMs));
		size += stat.size;
	}
	return mtimeMs * 1000 + (size % 1000);
}

/** This process's build identity, `VERSION+<stamp>`; compare with `compareDaemonBuilds`. */
export function daemonBuildId(): string {
	cached ??= `${VERSION}+${buildStamp()}`;
	return cached;
}
