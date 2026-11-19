/**
 * The loader opens each `.node` candidate with `process.dlopen`. Bun's
 * `require`, which it used before, cannot load a module from a path that
 * contains `?` (it reads the path cut at the `?`), so an addon under such a
 * `PI_NATIVES_DIR` or `HOME` failed with "Cannot find module". These rows load
 * the host addon through the real loader from a directory whose path holds each
 * character, in a child process per row (`loadNative` runs once per process).
 *
 * The child imports a copy of the loader's own files from a plain directory, so
 * no other candidate can stand in for the one under test: the only addon it can
 * find is the one in the directory the row names. `PI_COMPILED=1` gives the
 * compiled binary's candidate order, whose first candidates live under the
 * natives directory.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectHostAvx2Support, resolveLocalHostAddon } from "../../../scripts/host-detect";
import packageJson from "../package.json" with { type: "json" };

const packageDir = path.join(import.meta.dir, "..");
const hostAddonFilename = resolveLocalHostAddon({
	platform: process.platform,
	arch: process.arch,
	avx2: detectHostAvx2Support(),
}).filename;
const hostAddon = path.join(packageDir, "native", hostAddonFilename);
const variant = /-(modern|baseline)\.node$/.exec(hostAddonFilename)?.[1];

/** Windows file names cannot hold `?`, so the `?` rows run on other systems only. */
const QUESTION = process.platform === "win32" ? "" : "?";

/** A plain directory, then one per character that a path can hold. */
const CHARACTER_DIRS: readonly (readonly [label: string, dirname: string])[] = (
	[
		["plain", "plain"],
		["?", "q?x"],
		["#", "h#x"],
		["%", "p%x"],
		["a space", "s x"],
		["'", "a'x"],
	] as const
).filter(([, dirname]) => QUESTION || !dirname.includes("?"));

/** What the child prints: the load's outcome, from one `loadNative()` call. */
interface ProbeResult {
	ok: boolean;
	path?: string;
	/** Each export's name and `typeof`, sorted by name. */
	exports?: [name: string, type: string][];
	/** What the addon's `__piNativesBuildVersion()` returns. */
	stamp?: unknown;
	error?: string;
	/** With `PROBE_TWICE`, whether a second `loadNative()` returned the same object. */
	sameBindings?: boolean;
}

const PROBE = `
import * as loader from "./native/loader-state.js";
import { createRequire } from "node:module";

let result;
const shape = exports => Object.keys(exports).sort().map(name => [name, typeof exports[name]]);
const stamp = exports => exports.__piNativesBuildVersion?.();
try {
	if (process.env.PROBE_REQUIRE) {
		const exports = createRequire(import.meta.url)(process.env.PROBE_REQUIRE);
		result = { ok: true, exports: shape(exports), stamp: stamp(exports) };
	} else if (process.env.PROBE_OPEN) {
		const exports = loader.openNativeAddon(process.env.PROBE_OPEN);
		result = { ok: true, exports: shape(exports), stamp: stamp(exports) };
	} else {
		if (process.env.PROBE_EXTRACT) loader.extractEmbeddedAddons(JSON.parse(process.env.PROBE_EXTRACT));
		const bindings = loader.loadNative();
		result = { ok: true, path: loader.nativeAddonStatus()?.path, exports: shape(bindings) };
		if (process.env.PROBE_TWICE) result.sameBindings = loader.loadNative() === bindings;
	}
} catch (error) {
	result = { ok: false, error: error instanceof Error ? error.message : String(error) };
}
process.stdout.write(JSON.stringify(result));
process.exit(0);
`;

let root = "";
let loaderDir = "";
let frame = "";

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-path-chars-"));
	loaderDir = path.join(root, "loader");
	await fs.mkdir(path.join(loaderDir, "native"), { recursive: true });
	for (const file of ["loader-state.js", "embedded-addon.js", "version-sentinel.js"]) {
		await fs.copyFile(path.join(packageDir, "native", file), path.join(loaderDir, "native", file));
	}
	await fs.copyFile(path.join(packageDir, "package.json"), path.join(loaderDir, "package.json"));
	await Bun.write(path.join(loaderDir, "probe.ts"), PROBE);
	// The embedded addon's zstd frame, as a standalone binary carries it; a low
	// level keeps the test fast, and the loader reads any level.
	frame = path.join(root, `${hostAddonFilename}.zst`);
	await Bun.write(frame, Bun.zstdCompressSync(await Bun.file(hostAddon).bytes(), { level: 1 }));
});

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

async function probe(env: Record<string, string>): Promise<ProbeResult> {
	const childEnv: Record<string, string | undefined> = { ...process.env, PI_COMPILED: "1", ...env };
	for (const key of ["PI_NATIVES_DIR", "XDG_DATA_HOME", "__PI_NATIVE_VARIANT_CACHE"]) {
		if (!(key in env)) delete childEnv[key];
	}
	if (variant) childEnv.PI_NATIVE_VARIANT = variant;
	else delete childEnv.PI_NATIVE_VARIANT;
	const child = Bun.spawn([process.execPath, path.join(loaderDir, "probe.ts")], {
		cwd: loaderDir,
		env: childEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0 || !stdout) throw new Error(`probe exited ${code}: ${stderr}`);
	return JSON.parse(stdout) as ProbeResult;
}

describe("the addon loads from a directory whose path holds", () => {
	for (const [label, dirname] of CHARACTER_DIRS) {
		it(`${label}: a PI_NATIVES_DIR that holds the addon`, async () => {
			const nativesDir = path.join(root, `natives-${dirname}`);
			const addonPath = path.join(nativesDir, packageJson.version, hostAddonFilename);
			await fs.mkdir(path.dirname(addonPath), { recursive: true });
			await fs.copyFile(hostAddon, addonPath);
			try {
				const result = await probe({ PI_NATIVES_DIR: nativesDir, HOME: path.join(root, `home-of-${dirname}`) });
				expect(result).toMatchObject({ ok: true, path: addonPath });
			} finally {
				await fs.rm(nativesDir, { recursive: true, force: true });
			}
		}, 60_000);

		it(`${label}: a HOME the embedded addon is extracted under`, async () => {
			const home = path.join(root, `home-${dirname}`);
			const versionedDir = path.join(home, ".omp", "natives", packageJson.version);
			await fs.mkdir(versionedDir, { recursive: true });
			const size = (await fs.stat(hostAddon)).size;
			try {
				const result = await probe({
					HOME: home,
					PROBE_EXTRACT: JSON.stringify({
						files: [{ variant: variant ?? "default", filename: hostAddonFilename, size, zstdPath: frame }],
						targetDir: versionedDir,
					}),
				});
				expect(result).toMatchObject({ ok: true, path: path.join(versionedDir, hostAddonFilename) });
			} finally {
				await fs.rm(home, { recursive: true, force: true });
			}
		}, 60_000);
	}
});

describe("openNativeAddon", () => {
	it("gives the exports require gave: the same names, kinds and version stamp", async () => {
		const required = await probe({ PROBE_REQUIRE: hostAddon });
		const opened = await probe({ PROBE_OPEN: hostAddon });
		expect(required.ok).toBe(true);
		expect(opened).toEqual(required);
		expect(opened.exports?.length).toBeGreaterThan(0);
		expect(opened.exports).toContainEqual(["__piNativesBuildVersion", "function"]);
	}, 60_000);

	it("gives a second loadNative() the exports of the first, as require's cache did", async () => {
		const nativesDir = path.join(root, "natives-twice");
		const addonPath = path.join(nativesDir, packageJson.version, hostAddonFilename);
		await fs.mkdir(path.dirname(addonPath), { recursive: true });
		await fs.copyFile(hostAddon, addonPath);
		try {
			const result = await probe({
				PI_NATIVES_DIR: nativesDir,
				HOME: path.join(root, "home-of-twice"),
				PROBE_TWICE: "1",
			});
			expect(result).toMatchObject({ ok: true, path: addonPath, sameBindings: true });
		} finally {
			await fs.rm(nativesDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("fails with the file and dlopen's reason when the addon cannot be opened", async () => {
		// A `?` in the directory makes `require` fail before it reads the file,
		// with "Cannot find module"; `dlopen` reads it and rejects its content.
		const nativesDir = path.join(root, `natives-broken-q${QUESTION}x`);
		const addonPath = path.join(nativesDir, packageJson.version, hostAddonFilename);
		await fs.mkdir(path.dirname(addonPath), { recursive: true });
		await Bun.write(addonPath, "not an addon\n");
		try {
			const result = await probe({ PI_NATIVES_DIR: nativesDir, HOME: path.join(root, "home-of-broken") });
			expect(result.ok).toBe(false);
			const line = result.error?.split("\n").find(entry => entry.startsWith(`- ${addonPath}: `));
			expect(line).toBeDefined();
			const reason = line?.slice(`- ${addonPath}: `.length) ?? "";
			expect(reason.length).toBeGreaterThan(0);
			expect(reason).not.toContain("Cannot find module");
		} finally {
			await fs.rm(nativesDir, { recursive: true, force: true });
		}
	}, 60_000);
});
