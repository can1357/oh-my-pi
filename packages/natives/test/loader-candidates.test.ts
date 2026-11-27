/**
 * Native loader candidate resolution, as pure helpers so it can be tested
 * host-agnostically. A Bun standalone binary cannot rely on
 * `process.env.PI_COMPILED` (`--define` substitutes the bare identifier, not
 * property accesses) or on CommonJS `__filename` bunfs markers (they keep the
 * build-host path), so compiled-binary detection is authoritative on the
 * embedded-addon module: the stub exports `null` outside `--compile` and is
 * regenerated to a populated object during the standalone build.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	detectCompiledBinary,
	getAddonFilenames,
	resolveLoaderCandidates,
	resolveRuntimeCandidates,
} from "../native/loader-state.js";

const VERSION = "19.0.1";
const TAG = `${process.platform}-${process.arch}`;
const LEAF_PACKAGE = `@oh-my-pi/pi-natives-${TAG}`;
const ADDON = `pi_natives.${TAG}.node`;
const LOADER_SOURCES = path.join(import.meta.dir, "..", "native");
const LOADER_MODULES = ["loader-state.js", "embedded-addon.js", "version-sentinel.js"];

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "natives-leaf-layout-"));
	roots.push(root);
	return root;
}

/** Writes a package directory holding the loader's modules and `manifest`; returns its `native/` directory. */
function writePackage(dir: string, manifest: Record<string, unknown>): string {
	const native = path.join(dir, "native");
	fs.mkdirSync(native, { recursive: true });
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
	for (const file of LOADER_MODULES) fs.copyFileSync(path.join(LOADER_SOURCES, file), path.join(native, file));
	return native;
}

function writeLeaf(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	// `require.resolve` finds a package only through its package.json, as it does for an installed leaf.
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: LEAF_PACKAGE, version: VERSION }));
	fs.writeFileSync(path.join(dir, ADDON), "");
}

/** The addon paths `initLoaderContext()` lists, from the loader copy at `loaderPath`. */
async function loaderCandidates(loaderPath: string): Promise<string[]> {
	const { initLoaderContext } = await import(loaderPath);
	return initLoaderContext().candidates;
}

describe("native loader candidate resolution", () => {
	it("detects compiled-binary mode from embedded-addon presence when env and url markers are absent", () => {
		// What a Bun standalone binary actually sees on linux-x64 / WSL:
		// - `process.env.PI_COMPILED` is undefined (the build flag does not substitute property accesses).
		// - `import.meta.url` points at `$bunfs` for bundled modules; the old CJS
		//   loader used `__filename`, which is NOT rewritten.
		// The embedded-addon module is the authoritative compiled-mode signal: it is `null` in
		// development (the stub) and a populated object in the standalone build (after
		// `embed:native` runs), and is bundled into the binary by `bun build --compile`.
		expect(
			detectCompiledBinary({
				embeddedAddon: {
					platformTag: "linux-x64",
					version: "14.5.2",
					files: [
						{
							variant: "modern",
							filename: "pi_natives.linux-x64-modern.node",
							size: 1,
							hash: "0000000000000001",
							zstdPath: "/$bunfs/root/pi_natives.linux-x64-modern-a1b2c3d4.node.zst",
						},
					],
				},
				env: {},
				importMetaUrl: "/home/u/build-host/packages/natives/native/index.js",
			}),
		).toBe(true);

		// Without an embedded-addon and without env/url markers, we are NOT compiled.
		expect(
			detectCompiledBinary({
				embeddedAddon: null,
				env: {},
				importMetaUrl: "/home/u/dev/packages/natives/native/index.js",
			}),
		).toBe(false);

		// Env override (e.g. user-set PI_COMPILED=1) still wins.
		expect(
			detectCompiledBinary({
				embeddedAddon: null,
				env: { PI_COMPILED: "1" },
				importMetaUrl: "/anywhere",
			}),
		).toBe(true);

		// `import.meta.url` bunfs marker still wins when present.
		expect(
			detectCompiledBinary({
				embeddedAddon: null,
				env: {},
				importMetaUrl: "file:///$bunfs/root/cli",
			}),
		).toBe(true);
	});

	it("places embedded-extracted candidates ahead of build-host candidates for linux-x64 standalone", () => {
		const versionedDir = "/home/u/.omp/natives/14.5.2";
		const userDataDir = "/home/u/.local/bin";
		const nativeDir = "/build-host/packages/natives/native";
		const execDir = "/home/u/.local/bin";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "linux-x64", arch: "x64", variant: "modern" }),
			isCompiledBinary: true,
			nativeDir,
			execDir,
			versionedDir,
			userDataDir,
		});

		const versionedModern = path.join(versionedDir, "pi_natives.linux-x64-modern.node");
		const versionedBaseline = path.join(versionedDir, "pi_natives.linux-x64-baseline.node");
		const userDataModern = path.join(userDataDir, "pi_natives.linux-x64-modern.node");
		const buildHostModern = path.join(nativeDir, "pi_natives.linux-x64-modern.node");

		// Versioned cache and user-data dir candidates must exist for compiled binaries —
		// these are where the embedded-addon extraction lands (~/.omp/natives/<v>) and where
		// `omp update` writes the standalone binary on linux (~/.local/bin).
		expect(candidates).toContain(versionedModern);
		expect(candidates).toContain(versionedBaseline);
		expect(candidates).toContain(userDataModern);

		// Order matters: embedded-extracted destinations must be probed before the
		// (potentially-missing) build-host nativeDir path from the bundled module location.
		expect(candidates.indexOf(versionedModern)).toBeLessThan(candidates.indexOf(buildHostModern));
	});

	it("prefers platform leaf package candidates ahead of core nativeDir candidates on npm installs", () => {
		const leafPackageDir = "/app/node_modules/@oh-my-pi/pi-natives-linux-x64";
		const nativeDir = "/app/node_modules/@oh-my-pi/pi-natives/native";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "linux-x64", arch: "x64", variant: "baseline" }),
			isCompiledBinary: false,
			leafPackageDir,
			nativeDir,
			execDir: "/app/node_modules/.bin",
			versionedDir: "/home/u/.omp/natives/15.5.15",
			userDataDir: "/home/u/.local/bin",
		});

		const leafBaseline = path.join(leafPackageDir, "pi_natives.linux-x64-baseline.node");
		const coreBaseline = path.join(nativeDir, "pi_natives.linux-x64-baseline.node");
		expect(candidates).toContain(leafBaseline);
		expect(candidates.indexOf(leafBaseline)).toBeLessThan(candidates.indexOf(coreBaseline));
	});

	it("keeps the development candidate list unchanged when no leaf package is installed", () => {
		const nativeDir = "/repo/packages/natives/native";
		const execDir = "/usr/bin";
		const addonFilenames = getAddonFilenames({ tag: "linux-x64", arch: "x64", variant: "baseline" });
		const candidates = resolveLoaderCandidates({
			addonFilenames,
			isCompiledBinary: false,
			nativeDir,
			execDir,
			versionedDir: "/home/u/.omp/natives/15.5.15",
			userDataDir: "/home/u/.local/bin",
		});

		expect(candidates).toEqual(
			addonFilenames.flatMap(filename => [path.join(nativeDir, filename), path.join(execDir, filename)]),
		);
	});

	it("never probes the shared version-directory paths when the binary embeds its own addon", () => {
		// A file there may come from any build of this version and passes the
		// release-version check, so falling back to it after a failed
		// extraction would load another build's addon.
		const versionedDir = "/home/u/.omp/natives/18.20.2";
		const shared = path.join(versionedDir, "pi_natives.linux-x64-modern.node");
		const userData = "/home/u/.local/bin/pi_natives.linux-x64-modern.node";
		const own = path.join(versionedDir, "embedded-aaaa", "pi_natives.linux-x64-modern.node");
		const ownBaseline = path.join(versionedDir, "embedded-bbbb", "pi_natives.linux-x64-baseline.node");
		const candidates = [shared, userData];

		expect(
			resolveRuntimeCandidates({
				candidates,
				versionedDir,
				hasEmbedded: true,
				embedded: [own, ownBaseline],
				staged: null,
			}),
		).toEqual([own, ownBaseline, userData]);
		// Extraction failed: only non-cache locations remain.
		expect(
			resolveRuntimeCandidates({ candidates, versionedDir, hasEmbedded: true, embedded: [], staged: null }),
		).toEqual([userData]);
		// Without an embedded addon the version directory is still a valid source.
		expect(
			resolveRuntimeCandidates({ candidates, versionedDir, hasEmbedded: false, embedded: [], staged: null }),
		).toEqual(candidates);
	});
});

/**
 * A release of `@oh-my-pi/pi-natives` run from bun's install cache has no
 * `node_modules` segment in its path. Its platform leaf sits beside it as a
 * version-pinned sibling:
 *
 *   <cache>/@oh-my-pi/pi-natives@<ver>@@@1/        core, manifest declares the leaf
 *   <cache>/@oh-my-pi/pi-natives-<tag>@<ver>@@@1/  leaf, holds the addon
 *
 * The loader must treat that copy as an installed release, so the leaf's addon
 * is among the candidates it opens. Each layout is written to its own temporary
 * directory and the loader copy there is imported, so `import.meta.url` is the
 * layout's own path.
 */
describe("platform leaf beside a bun-cache copy of the core package", () => {
	it("lists the leaf's addon among the candidates", async () => {
		const root = tempRoot();
		const scope = path.join(root, "@oh-my-pi");
		const native = writePackage(path.join(scope, `pi-natives@${VERSION}@@@1`), {
			name: "@oh-my-pi/pi-natives",
			version: VERSION,
			optionalDependencies: { [LEAF_PACKAGE]: VERSION },
		});
		const leaf = path.join(scope, `pi-natives-${TAG}@${VERSION}@@@1`);
		writeLeaf(leaf);

		expect(await loaderCandidates(path.join(native, "loader-state.js"))).toContain(path.join(leaf, ADDON));
	});

	it("ignores a foreign-version sibling when no leaf matches the running version", async () => {
		const root = tempRoot();
		const scope = path.join(root, "@oh-my-pi");
		const native = writePackage(path.join(scope, `pi-natives@${VERSION}@@@1`), {
			name: "@oh-my-pi/pi-natives",
			version: VERSION,
			optionalDependencies: { [LEAF_PACKAGE]: VERSION },
		});
		const foreign = path.join(scope, `pi-natives-${TAG}@18.9.0@@@1`);
		writeLeaf(foreign);

		expect(await loaderCandidates(path.join(native, "loader-state.js"))).not.toContain(path.join(foreign, ADDON));
	});

	it("still skips the leaf for a checkout, whose manifest declares none", async () => {
		const root = tempRoot();
		const native = writePackage(path.join(root, "checkout", "packages", "natives"), {
			name: "@oh-my-pi/pi-natives",
			version: VERSION,
		});
		const leaf = path.join(root, "checkout", "node_modules", LEAF_PACKAGE);
		writeLeaf(leaf);

		expect(await loaderCandidates(path.join(native, "loader-state.js"))).not.toContain(path.join(leaf, ADDON));
	});
});
