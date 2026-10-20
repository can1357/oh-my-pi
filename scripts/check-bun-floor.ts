#!/usr/bin/env bun

/**
 * Fail closed when the running Bun predates the repo's declared floor.
 *
 * `bun --check` only type-checks on Bun >= 1.4.3. On older builds the flag is
 * unknown, so Bun prints its top-level help and exits 0 — every `check:types`
 * script would report success without checking a single file. Each package runs
 * this guard as its `precheck:types` hook, so a runtime below the floor is a
 * hard error instead of a silently green gate.
 *
 * The guard also owns the repo's version ordering for everyone else:
 * `--satisfies <version>` answers "would this runtime pass the gate?" with an
 * exit code, so the CI setup action (`.github/actions/bun-install/action.yml`)
 * asks the guard instead of comparing versions on its own.
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

const USAGE = "usage: check-bun-floor.ts [--satisfies <bun-version>]";

/** Exit code for a usage error (unknown flag, missing argument). */
const EXIT_USAGE = 2;

async function main(): Promise<void> {
	const manifest = (await Bun.file(path.join(REPO_ROOT, "package.json")).json()) as { packageManager?: unknown };
	const floor = bunFloor(manifest.packageManager);
	if (floor === undefined) {
		process.stderr.write("error: root package.json declares no bun version in packageManager\n");
		process.exit(1);
	}
	const args = process.argv.slice(2);
	if (args.length > 0) {
		// The exit code is the answer: 0 when the candidate runtime passes the
		// gate, 1 when it does not. Unknown flags fail loudly instead of
		// falling through to the gate check, which would answer for the
		// running Bun instead of the candidate.
		if (args.length === 2 && args[0] === "--satisfies") {
			process.exit(satisfiesBunFloor(args[1], manifest.packageManager) ? 0 : 1);
		}
		process.stderr.write(`error: unrecognized arguments: ${args.join(" ")}\n${USAGE}\n`);
		process.exit(EXIT_USAGE);
	}
	if (!satisfiesBunFloor(Bun.version, manifest.packageManager)) {
		process.stderr.write(
			`error: Bun >= ${floor} is required to type check (found v${Bun.version}). Please upgrade: bun upgrade\n`,
		);
		process.exit(1);
	}
}

if (import.meta.main) await main();
