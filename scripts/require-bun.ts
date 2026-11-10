#!/usr/bin/env bun

import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");

/** Inputs to the version guard. Each field defaults to the running environment. */
export interface BunVersionCheck {
	/** Version of the running Bun executable. Defaults to `Bun.version`. */
	foundVersion?: string;
	/** Minimum Bun version this repository supports. Defaults to the root `packageManager` minimum. */
	requiredVersion?: string;
	/** Path of the running Bun executable. Defaults to `process.execPath`. */
	executablePath?: string;
}

/** Numeric component-wise compare ("1.4.10" > "1.4.4"); a missing component counts as `.0`. */
function compareVersions(left: string, right: string): number {
	const parts = (version: string) => version.split(".").map(part => Number.parseInt(part, 10) || 0);
	const leftParts = parts(left);
	const rightParts = parts(right);
	for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i++) {
		const delta = (leftParts[i] ?? 0) - (rightParts[i] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}

/**
 * The minimum Bun version named by the root `packageManager` field
 * (`bun@>=1.4.4` → `1.4.4`). The root field is the repo-wide source of truth:
 * it is what `bun` itself and every lockfile-consuming tool read.
 */
function readMinimumBunVersion(): string {
	const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
		packageManager?: string;
	};
	const spec = manifest.packageManager ? /^bun@(.+)$/.exec(manifest.packageManager)?.[1] : undefined;
	const minimum = spec?.replace(/^[~^>=<\s]+/, "");
	if (!minimum || !/^\d+(\.\d+)*$/.test(minimum)) {
		throw new Error(
			`Cannot read a minimum Bun version from packageManager ${JSON.stringify(manifest.packageManager)}`,
		);
	}
	return minimum;
}

/**
 * Fail unless the running Bun meets the repository minimum. The message names
 * the found version, the required version, and the executable path — the three
 * facts needed to act — because the failure this guard replaces was opaque:
 * under Bun 1.3.x, `bun check` is not a built-in, so it recursed into the
 * package `check` script and died with exit 23 far from the cause.
 */
export function requireBunVersion(check: BunVersionCheck = {}): void {
	const foundVersion = check.foundVersion ?? Bun.version;
	const requiredVersion = check.requiredVersion ?? readMinimumBunVersion();
	const executablePath = check.executablePath ?? process.execPath;
	if (compareVersions(foundVersion, requiredVersion) >= 0) {
		return;
	}
	throw new Error(
		`Bun ${foundVersion} at ${executablePath} is older than the minimum this repository requires ` +
			`(${requiredVersion}, root package.json "packageManager"). Older Bun versions also lack the built-in ` +
			`check command, so \`bun check\` recursed into the package \`check\` script and failed with exit 23. ` +
			`Upgrade Bun (\`bun upgrade\`) to >= ${requiredVersion} and re-run.`,
	);
}

if (import.meta.main) {
	try {
		requireBunVersion();
	} catch (err) {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	}
}
