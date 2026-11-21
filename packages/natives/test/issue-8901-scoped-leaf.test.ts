/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/8901.
 *
 * A release of `@oh-my-pi/pi-natives` run from bun's install cache has no
 * `node_modules` segment in its path. Its platform leaf sits beside it as a
 * version-pinned sibling:
 *
 *   <cache>/@oh-my-pi/pi-natives@<ver>@@@1/        core, manifest declares the leaf
 *   <cache>/@oh-my-pi/pi-natives-<tag>@<ver>@@@1/  leaf, holds the addon
 *
 * The loader must treat that copy as an installed release, so the leaf's addon
 * is among the candidates it opens. Each layout is written to a temporary
 * directory and the loader runs in a child process from there, so
 * `import.meta.url` is the layout's own path.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "issue-8901-"));
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

/**
 * The addon paths `initLoaderContext()` lists, read from the loader at `loaderPath` in a child process.
 * `--no-install` stops bun resolving the leaf from its global install cache (or downloading it), so the
 * leaf lookup misses here as it does for a cache copy.
 */
function loaderCandidates(loaderPath: string): string[] {
	const script = `const { initLoaderContext } = await import(${JSON.stringify(loaderPath)}); console.log(JSON.stringify(initLoaderContext().candidates));`;
	const child = Bun.spawnSync({
		cmd: [process.execPath, "--no-install", "-e", script],
		stdout: "pipe",
		stderr: "pipe",
	});
	if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
	return JSON.parse(new TextDecoder().decode(child.stdout)) as string[];
}

describe("issue 8901: platform leaf beside a bun-cache copy of the core package", () => {
	it("lists the leaf's addon among the candidates", () => {
		const root = tempRoot();
		const scope = path.join(root, "@oh-my-pi");
		const native = writePackage(path.join(scope, `pi-natives@${VERSION}@@@1`), {
			name: "@oh-my-pi/pi-natives",
			version: VERSION,
			optionalDependencies: { [LEAF_PACKAGE]: VERSION },
		});
		const leaf = path.join(scope, `pi-natives-${TAG}@${VERSION}@@@1`);
		writeLeaf(leaf);

		expect(loaderCandidates(path.join(native, "loader-state.js"))).toContain(path.join(leaf, ADDON));
	});

	it("ignores a foreign-version sibling when no leaf matches the running version", () => {
		const root = tempRoot();
		const scope = path.join(root, "@oh-my-pi");
		const native = writePackage(path.join(scope, `pi-natives@${VERSION}@@@1`), {
			name: "@oh-my-pi/pi-natives",
			version: VERSION,
			optionalDependencies: { [LEAF_PACKAGE]: VERSION },
		});
		const foreign = path.join(scope, `pi-natives-${TAG}@18.9.0@@@1`);
		writeLeaf(foreign);

		expect(loaderCandidates(path.join(native, "loader-state.js"))).not.toContain(path.join(foreign, ADDON));
	});

	it("still skips the leaf for a checkout, whose manifest declares none", () => {
		const root = tempRoot();
		const native = writePackage(path.join(root, "checkout", "packages", "natives"), {
			name: "@oh-my-pi/pi-natives",
			version: VERSION,
		});
		const leaf = path.join(root, "checkout", "node_modules", LEAF_PACKAGE);
		writeLeaf(leaf);

		expect(loaderCandidates(path.join(native, "loader-state.js"))).not.toContain(path.join(leaf, ADDON));
	});
});
