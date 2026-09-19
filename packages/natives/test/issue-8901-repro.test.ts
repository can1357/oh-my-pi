/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/8901.
 *
 * When the core `@oh-my-pi/pi-natives` package runs from bun's global install
 * cache — the case for out-of-tree consumers such as a custom tool importing
 * `@oh-my-pi/pi-tui`, or the `omp stats` worker — the platform leaf package is
 * laid out as a *version-pinned sibling* of the core package:
 *
 *   <cache>/@oh-my-pi/pi-natives@<ver>@@@N/            (core, no .node)
 *   <cache>/@oh-my-pi/pi-natives-<tag>@<ver>@@@N/      (leaf, holds the .node)
 *
 * Neither is under an enclosing `node_modules`, so node's resolution walk
 * (`createRequire(...).resolve("@oh-my-pi/pi-natives-<tag>/package.json")`)
 * cannot find the leaf and `resolveLeafPackageDir` returned `null`. The leaf
 * candidate then dropped out of the loader search list and the addon failed to
 * load even though it was installed and complete.
 *
 * `findScopedLeafPackageDir` is the fallback: it scans the core package's scope
 * directory for the sibling leaf that actually holds the addon.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findScopedLeafPackageDir } from "../native/loader-state.js";

const PLATFORM_TAG = "linux-x64";
const VERSION = "17.3.7";
const ADDON = `pi_natives.${PLATFORM_TAG}.node`;

const tmpDirs: string[] = [];

/**
 * Build a bun-cache-style scope directory: a core package plus zero or more
 * leaf siblings, none under an enclosing `node_modules`. Returns the core
 * package directory (what the loader passes as `corePackageDir`).
 */
function buildScope(leaves: Array<{ dirName: string; addonFiles: string[] }>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-8901-"));
	tmpDirs.push(root);
	const scope = path.join(root, "@oh-my-pi");
	const coreDir = path.join(scope, `pi-natives@${VERSION}@@@1`);
	fs.mkdirSync(path.join(coreDir, "native"), { recursive: true });
	fs.writeFileSync(
		path.join(coreDir, "package.json"),
		JSON.stringify({ name: "@oh-my-pi/pi-natives", version: VERSION }),
	);
	for (const leaf of leaves) {
		const leafDir = path.join(scope, leaf.dirName);
		fs.mkdirSync(leafDir, { recursive: true });
		for (const file of leaf.addonFiles) fs.writeFileSync(path.join(leafDir, file), "DUMMY");
	}
	return coreDir;
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("issue 8901: leaf resolution from the bun install cache", () => {
	it("finds the version-pinned sibling leaf that holds the addon", () => {
		const corePackageDir = buildScope([
			{ dirName: `pi-natives-${PLATFORM_TAG}@${VERSION}@@@1`, addonFiles: [ADDON] },
		]);
		const found = findScopedLeafPackageDir({
			platformTag: PLATFORM_TAG,
			packageVersion: VERSION,
			addonFilenames: [ADDON],
			corePackageDir,
		});
		expect(found).toBe(path.join(path.dirname(corePackageDir), `pi-natives-${PLATFORM_TAG}@${VERSION}@@@1`));
	});

	it("also resolves the plain (node_modules) sibling directory name", () => {
		const corePackageDir = buildScope([{ dirName: `pi-natives-${PLATFORM_TAG}`, addonFiles: [ADDON] }]);
		const found = findScopedLeafPackageDir({
			platformTag: PLATFORM_TAG,
			packageVersion: VERSION,
			addonFilenames: [ADDON],
			corePackageDir,
		});
		expect(found).toBe(path.join(path.dirname(corePackageDir), `pi-natives-${PLATFORM_TAG}`));
	});

	it("prefers the version-matching sibling over a stale cached release", () => {
		const stale = `pi-natives-${PLATFORM_TAG}@17.3.5@@@1`;
		const current = `pi-natives-${PLATFORM_TAG}@${VERSION}@@@1`;
		const corePackageDir = buildScope([
			{ dirName: stale, addonFiles: [ADDON] },
			{ dirName: current, addonFiles: [ADDON] },
		]);
		const found = findScopedLeafPackageDir({
			platformTag: PLATFORM_TAG,
			packageVersion: VERSION,
			addonFilenames: [ADDON],
			corePackageDir,
		});
		expect(found).toBe(path.join(path.dirname(corePackageDir), current));
	});

	it("matches an addon under a variant filename (x64 leaves ship baseline/modern)", () => {
		const baseline = `pi_natives.${PLATFORM_TAG}-baseline.node`;
		const corePackageDir = buildScope([
			{ dirName: `pi-natives-${PLATFORM_TAG}@${VERSION}@@@1`, addonFiles: [baseline] },
		]);
		const found = findScopedLeafPackageDir({
			platformTag: PLATFORM_TAG,
			packageVersion: VERSION,
			addonFilenames: [`pi_natives.${PLATFORM_TAG}-modern.node`, baseline, ADDON],
			corePackageDir,
		});
		expect(found).toBe(path.join(path.dirname(corePackageDir), `pi-natives-${PLATFORM_TAG}@${VERSION}@@@1`));
	});

	it("ignores a sibling for a different platform tag", () => {
		const corePackageDir = buildScope([
			{ dirName: `pi-natives-darwin-arm64@${VERSION}@@@1`, addonFiles: ["pi_natives.darwin-arm64.node"] },
		]);
		const found = findScopedLeafPackageDir({
			platformTag: PLATFORM_TAG,
			packageVersion: VERSION,
			addonFilenames: [ADDON],
			corePackageDir,
		});
		expect(found).toBeNull();
	});

	it("returns null when the matching sibling exists but holds no addon", () => {
		const corePackageDir = buildScope([
			{ dirName: `pi-natives-${PLATFORM_TAG}@${VERSION}@@@1`, addonFiles: ["README.md"] },
		]);
		const found = findScopedLeafPackageDir({
			platformTag: PLATFORM_TAG,
			packageVersion: VERSION,
			addonFilenames: [ADDON],
			corePackageDir,
		});
		expect(found).toBeNull();
	});
});
