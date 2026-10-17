#!/usr/bin/env bun

/**
 * Fail closed when the running Bun predates the repo's declared floor.
 *
 * `bun --check` only type-checks on Bun >= 1.4.3. On older builds the flag is
 * unknown, so Bun prints its top-level help and exits 0 — every `check:types`
 * script would report success without checking a single file. Each package runs
 * this guard as its `precheck:types` hook, so a runtime below the floor is a
 * hard error instead of a silently green gate.
 */

import * as path from "node:path";

const REPO_ROOT = path.join(import.meta.dir, "..");

/** Version floor from the root `packageManager` field (`bun@>=1.4.3`, `bun@1.4.3`). */
export function bunFloor(packageManager: unknown): string | undefined {
	if (typeof packageManager !== "string" || !packageManager.startsWith("bun@")) return undefined;
	const floor = packageManager.slice("bun@".length).replace(/^[^0-9]*/, "");
	return floor.length > 0 ? floor : undefined;
}

/**
 * Whether `version` satisfies the `packageManager` floor. `undefined` floor
 * means the manifest does not pin Bun; a prerelease of the boundary sorts
 * below it, matching the `MIN_BUN_VERSION` startup guard in
 * packages/coding-agent/src/cli.ts.
 */
export function satisfiesBunFloor(version: string, packageManager: unknown): boolean {
	const floor = bunFloor(packageManager);
	if (floor === undefined) return true;
	return Bun.semver.order(version, floor) >= 0;
}

async function main(): Promise<void> {
	const manifest = (await Bun.file(path.join(REPO_ROOT, "package.json")).json()) as { packageManager?: unknown };
	const floor = bunFloor(manifest.packageManager);
	if (floor === undefined) {
		process.stderr.write("error: root package.json declares no bun version in packageManager\n");
		process.exit(1);
	}
	if (!satisfiesBunFloor(Bun.version, manifest.packageManager)) {
		process.stderr.write(
			`error: Bun >= ${floor} is required to type check (found v${Bun.version}). Please upgrade: bun upgrade\n`,
		);
		process.exit(1);
	}
}

if (import.meta.main) await main();
