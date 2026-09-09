/**
 * Real package-manager seam for `omp.rename` migrations.
 *
 * The unit tests in test/update-cli.test.ts prove the orchestration order of
 * migrateRenamedInstall with injected steps; these fixtures prove the two
 * empirical assumptions that orchestration stands on, against the actual
 * package managers in isolated temp prefixes:
 *
 * - npm refuses to overwrite a bin owned by another package (EEXIST) and
 *   `--force` takes ownership of it — and `npm uninstall -g <old>` deletes
 *   the shared bin even though it points at the new package, so the repair
 *   reinstall inside migrateRenamedInstall is the NORMAL npm path, not an
 *   edge case.
 * - bun clobbers the bin on install without force, and `bun remove -g <old>`
 *   re-links the bin to the surviving package.
 *
 * Each scenario runs the full install-new/remove-old/verify transaction and
 * asserts the resulting launcher executes the NEW version.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import {
	type InstalledVersionVerification,
	migrateRenamedInstall,
	type ReleaseInfo,
	type RenameMigrationSteps,
} from "../../src/cli/update-cli";
import { initTheme } from "../../src/modes/theme/theme";

const OLD_PKG = "omp-rename-fixture-old";
const NEW_PKG = "omp-rename-fixture-new";
const OLD_VERSION = "1.0.0";
const NEW_VERSION = "2.0.0";
let fixtureDir: TempDir;
let oldDir: string;
let newDir: string;

// printVerifiedVersion renders theme glyphs; the update command initializes
// the theme before calling into update-cli, so the tests must too. Keep one
// process-wide log spy so the package-manager scenarios can run concurrently.
beforeAll(async () => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	await initTheme();
	fixtureDir = await TempDir.create("@omp-rename-itest-");
	({ oldDir, newDir } = await makeFixtures(fixtureDir.path()));
});

afterAll(async () => {
	vi.restoreAllMocks();
	await fixtureDir.remove();
});

/** Two shared, read-only packages that expose the same `omp` bin. */
async function makeFixtures(root: string): Promise<{ oldDir: string; newDir: string }> {
	const mkpkg = async (name: string, version: string): Promise<string> => {
		const dir = path.join(root, name);
		await Bun.write(path.join(dir, "package.json"), JSON.stringify({ name, version, bin: { omp: "cli.js" } }));
		const cli = path.join(dir, "cli.js");
		await Bun.write(cli, `#!/usr/bin/env bun\nconsole.log("omp/${version}");\n`);
		await fs.chmod(cli, 0o755);
		return dir;
	};
	return { oldDir: await mkpkg(OLD_PKG, OLD_VERSION), newDir: await mkpkg(NEW_PKG, NEW_VERSION) };
}

/** Run the installed launcher and parse its reported version, mirroring verifyBinaryAtPath. */
async function verifyLauncher(binDir: string, expectedVersion: string): Promise<InstalledVersionVerification> {
	const launcher = path.join(binDir, "omp");
	const result = await $`${launcher}`.quiet().nothrow();
	if (result.exitCode !== 0) return { ok: false, path: launcher };
	const actual = result.text().match(/\/(\d+\.\d+\.\d+)/)?.[1];
	return { ok: actual === expectedVersion, actual, path: launcher };
}

const RELEASE: ReleaseInfo = {
	tag: `v${NEW_VERSION}`,
	version: NEW_VERSION,
	packages: { pkg: NEW_PKG, natives: "@oh-my-pi/pi-natives" },
};

describe.skipIf(process.platform === "win32" || !$which("npm"))("rename migration over real npm", () => {
	it.concurrent("takes bin ownership with --force, survives the uninstall deleting the bin, and lands on the new version", async () => {
		const root = fixtureDir.path();
		const prefix = path.join(root, "npm-prefix");
		const binDir = path.join(prefix, "bin");
		const env = {
			...process.env,
			npm_config_cache: path.join(root, "npm-cache"),
			npm_config_update_notifier: "false",
			npm_config_fund: "false",
			npm_config_audit: "false",
		};

		const seed = await $`npm install -g --prefix ${prefix} ${oldDir}`.env(env).quiet().nothrow();
		expect(seed.exitCode).toBe(0);

		// The load-bearing precondition for --force: while the old package owns
		// the bin, a plain install of the new package fails instead of clobbering.
		const plain = await $`npm install -g --prefix ${prefix} ${newDir}`.env(env).quiet().nothrow();
		expect(plain.exitCode).not.toBe(0);
		expect(await verifyLauncher(binDir, OLD_VERSION)).toMatchObject({ ok: true, actual: OLD_VERSION });

		const verifications: InstalledVersionVerification[] = [];
		const steps: RenameMigrationSteps = {
			async install() {
				return (await $`npm install -g --force --prefix ${prefix} ${newDir}`.env(env).quiet().nothrow()).exitCode;
			},
			async removeOld() {
				return (await $`npm uninstall -g --prefix ${prefix} ${OLD_PKG}`.env(env).quiet().nothrow()).exitCode;
			},
			async verify() {
				const result = await verifyLauncher(binDir, NEW_VERSION);
				verifications.push(result);
				return result;
			},
		};
		await migrateRenamedInstall(RELEASE, steps);

		expect(verifications.map(result => ({ ok: result.ok, actual: result.actual }))).toEqual([
			{ ok: false, actual: undefined },
			{ ok: true, actual: NEW_VERSION },
		]);
		const globalPackages = await fs.readdir(path.join(prefix, "lib", "node_modules"));
		expect(globalPackages).toContain(NEW_PKG);
		expect(globalPackages).not.toContain(OLD_PKG);
	}, 120_000);
});

describe.skipIf(process.platform === "win32")("rename migration over real bun", () => {
	it.concurrent("clobbers the old bin on install, survives removing the old package, and lands on the new version", async () => {
		const root = fixtureDir.path();
		const binDir = path.join(root, "bun-bin");
		await fs.mkdir(binDir, { recursive: true });
		const env = {
			...process.env,
			BUN_INSTALL_GLOBAL_DIR: path.join(root, "bun-global"),
			BUN_INSTALL_BIN: binDir,
		};

		const seed = await $`bun add -g file:${oldDir}`.env(env).quiet().nothrow();
		expect(seed.exitCode).toBe(0);
		expect(await verifyLauncher(binDir, OLD_VERSION)).toMatchObject({ ok: true, actual: OLD_VERSION });

		const verifications: InstalledVersionVerification[] = [];
		const steps: RenameMigrationSteps = {
			async install() {
				return (await $`bun add -g file:${newDir}`.env(env).quiet().nothrow()).exitCode;
			},
			async removeOld() {
				return (await $`bun remove -g ${OLD_PKG}`.env(env).quiet().nothrow()).exitCode;
			},
			async verify() {
				const result = await verifyLauncher(binDir, NEW_VERSION);
				verifications.push(result);
				return result;
			},
		};
		await migrateRenamedInstall(RELEASE, steps);

		expect(verifications.map(result => ({ ok: result.ok, actual: result.actual }))).toEqual([
			{ ok: true, actual: NEW_VERSION },
		]);
		const globalManifest = await Bun.file(path.join(root, "bun-global", "package.json")).json();
		expect(Object.keys(globalManifest.dependencies ?? {})).toEqual([NEW_PKG]);
	}, 120_000);
});
