import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initLoaderContext, prepareNativeVersionDir } from "../native/loader-state.js";
import packageJson from "../package.json" with { type: "json" };

const ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"PI_NATIVES_DIR",
	"XDG_DATA_HOME",
	"PI_NATIVE_VARIANT",
	"__PI_NATIVE_VARIANT_CACHE",
] as const;

describe("native addon directory override", () => {
	let tempRoot = "";
	let home = "";
	let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(async () => {
		originalEnv = {};
		for (const key of ENV_KEYS) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-natives-dir-"));
		home = path.join(tempRoot, "home");
		await fs.mkdir(home);
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.PI_NATIVE_VARIANT = "baseline";
		vi.spyOn(os, "homedir").mockReturnValue(home);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("places the versioned cache outside a fresh HOME and takes precedence over initialized XDG", async () => {
		const shared = path.join(tempRoot, "shared");
		const xdgData = path.join(tempRoot, "data");
		await fs.mkdir(path.join(xdgData, "omp"), { recursive: true });
		process.env.PI_NATIVES_DIR = ` ${shared} `;

		const ctx = initLoaderContext({ isCompiledBinary: true });
		prepareNativeVersionDir(ctx.versionedDir);

		expect(ctx.versionedDir).toBe(path.join(shared, packageJson.version));
		process.env.XDG_DATA_HOME = xdgData;
		expect(initLoaderContext({ isCompiledBinary: true }).versionedDir).toBe(ctx.versionedDir);
		expect(await fs.readdir(shared)).toEqual([packageJson.version]);
		expect(await fs.readdir(home)).toEqual([]);
		expect(await fs.readdir(path.join(xdgData, "omp"))).toEqual([]);
	});

	it("expands home-relative overrides before appending the package version", () => {
		process.env.PI_NATIVES_DIR = "~";
		expect(initLoaderContext({ isCompiledBinary: true }).versionedDir).toBe(path.join(home, packageJson.version));

		process.env.PI_NATIVES_DIR = " ~/unused/../shared ";
		expect(initLoaderContext({ isCompiledBinary: true }).versionedDir).toBe(
			path.join(home, "shared", packageJson.version),
		);
	});

	it.each([
		["empty", ""],
		["whitespace", " \t "],
		["relative", "relative/natives"],
	])("falls back to XDG when the override is %s", async (_label, override) => {
		const xdgData = path.join(tempRoot, "data");
		await fs.mkdir(path.join(xdgData, "omp"), { recursive: true });
		process.env.XDG_DATA_HOME = xdgData;
		process.env.PI_NATIVES_DIR = override;

		expect(initLoaderContext({ isCompiledBinary: true }).versionedDir).toBe(
			path.join(xdgData, "omp", "natives", packageJson.version),
		);
	});
});
