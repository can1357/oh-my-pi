import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getEnabledPlugins, resolvePluginExtensionPaths } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import type { InstalledPlugin } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";

const tempRoots: string[] = [];
const restore: string[] = [];

afterEach(async () => {
	clearClaudePluginRootsCache();
	// Cleanup needs the manifests back: a 000 file blocks its own removal.
	for (const file of restore.splice(0)) {
		await fs.promises.chmod(file, 0o600).catch(() => {});
	}
	for (const root of tempRoots.splice(0)) {
		await removeWithRetries(root);
	}
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await Bun.write(filePath, `${JSON.stringify(value)}\n`);
}

/** A plugins root holding one declared, loadable plugin. */
async function plantRoot(prefix: string): Promise<{ home: string; cwd: string; manifest: string; pluginsDir: string }> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
	tempRoots.push(root);
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	const pluginsDir = path.join(home, ".omp", "plugins");
	await fs.promises.mkdir(cwd, { recursive: true });

	const declaredDir = path.join(pluginsDir, "node_modules", "declared-plugin");
	await fs.promises.mkdir(declaredDir, { recursive: true });
	await writeJson(path.join(declaredDir, "package.json"), {
		name: "declared-plugin",
		version: "1.0.0",
		omp: { extensions: ["ext.ts"] },
	});

	const manifest = path.join(pluginsDir, "package.json");
	await writeJson(manifest, { dependencies: { "declared-plugin": "1.0.0" } });
	await writeJson(path.join(pluginsDir, "omp-plugins.lock.json"), {
		plugins: { "declared-plugin": { version: "1.0.0", enabled: true, enabledFeatures: null } },
		settings: {},
	});
	return { home, cwd, manifest, pluginsDir };
}

// Regression: the plugins manifest is not always readable. A sandboxed run, a
// restrictive mode, or a manifest symlinked into a denied path all surface as
// EACCES/EPERM, and the loader rethrew them — aborting plugin tool-path
// collection and killing agent and subagent startup with a filesystem error
// far from its cause.
//
// The readable half is not gated: it is what keeps the skip from hiding a
// working plugin set, and it holds wherever the suite runs. Only the denial
// needs mode bits to be enforced, which excludes root and Windows.
test("a readable plugins root still loads its declared plugin", async () => {
	const readable = await plantRoot("omp-plugin-readable-");
	expect((await getEnabledPlugins(readable.cwd, { home: readable.home })).map(plugin => plugin.name)).toEqual([
		"declared-plugin",
	]);
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
	"an unreadable plugins root is skipped instead of failing plugin collection",
	async () => {
		const denied = await plantRoot("omp-plugin-denied-");
		await fs.promises.chmod(denied.manifest, 0o000);
		restore.push(denied.manifest);
		expect(await getEnabledPlugins(denied.cwd, { home: denied.home })).toEqual([]);
	},
);

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
	"an unreadable installed plugin is skipped while its siblings still load",
	async () => {
		// The root's own manifest and lockfile are readable here, so the guards
		// above have already passed: enumeration reads each plugin's manifest,
		// and one denied package.json used to abort the whole collection.
		const { home, cwd, pluginsDir } = await plantRoot("omp-plugin-sibling-");
		const otherDir = path.join(pluginsDir, "node_modules", "other-plugin");
		await fs.promises.mkdir(otherDir, { recursive: true });
		const otherManifest = path.join(otherDir, "package.json");
		await writeJson(otherManifest, {
			name: "other-plugin",
			version: "2.0.0",
			omp: { extensions: ["ext.ts"] },
		});
		await writeJson(path.join(pluginsDir, "package.json"), {
			dependencies: { "declared-plugin": "1.0.0", "other-plugin": "2.0.0" },
		});
		await fs.promises.chmod(otherManifest, 0o000);
		restore.push(otherManifest);

		expect((await getEnabledPlugins(cwd, { home })).map(plugin => plugin.name)).toEqual(["declared-plugin"]);
	},
);

/** A plugin whose `extensions` manifest entry names one file that exists. */
async function plantEntryPlugin(prefix: string, entry: string): Promise<InstalledPlugin> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
	tempRoots.push(root);
	await fs.promises.mkdir(path.join(root, "extensions"), { recursive: true });
	await Bun.write(path.join(root, "extensions", entry), "export default () => ({});\n");
	return {
		name: "entry-plugin",
		version: "1.0.0",
		path: root,
		manifest: { version: "1.0.0", extensions: ["extensions/" + entry] },
		enabledFeatures: null,
		enabled: true,
	};
}

// Regression: a declared manifest entry that cannot be STAT'd for permission
// reasons resolved to nothing at all. The plugin still loaded — its
// package.json was readable — so it contributed no extension module and no
// hook, and the process had no way to say so: no error, no notification, and
// no `Failed to load extension`, because nothing had failed. A plugin that
// registers nothing and a plugin that was never asked are indistinguishable
// from the outside, which is the whole cost this closes.
//
// The unreadable-root skips above this in the loader already warn for exactly
// this condition; the manifest-entry stat was the one place in the same file
// that swallowed it.
test("an unreadable manifest entry is skipped with a warning naming the entry", async () => {
	const plugin = await plantEntryPlugin("omp-plugin-entry-denied-", "ext.ts");
	const denied = path.join(plugin.path, "extensions", "ext.ts");
	const warn = spyOn(logger, "warn").mockImplementation(() => {});
	const realStatSync = fs.statSync.bind(fs);
	const statSpy = spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike, options?: fs.StatOptions) => {
		if (path.resolve(String(target)) === path.resolve(denied)) {
			throw Object.assign(new Error(`EACCES: permission denied, stat '${denied}'`), { code: "EACCES" });
		}
		return realStatSync(target as string, options as fs.StatSyncOptions);
	}) as typeof fs.statSync);
	try {
		// The skip itself is preserved — one unreadable entry must not take
		// down the siblings — so the observable difference is that it is now
		// said out loud, with the entry the user has to go look at.
		expect(resolvePluginExtensionPaths(plugin)).toEqual([]);
		const skips = warn.mock.calls.filter(([message]) => message === "plugins: skipping unreadable manifest entry");
		expect(skips).toHaveLength(1);
		expect(skips[0]?.[1]).toMatchObject({ path: denied });
	} finally {
		statSpy.mockRestore();
		warn.mockRestore();
	}
});

// A mode-denied directory fails one level deeper: the entry stat succeeds and
// the directory scan throws, which the resolver used to treat exactly like a
// missing entry. Unlike a file, this reproduces with a real chmod, so no
// stat spy is needed — but also no Windows or root, where modes don't bind.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
	"an unreadable manifest directory is skipped with a warning naming the entry",
	async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-plugin-entrydir-"));
		tempRoots.push(root);
		const dir = path.join(root, "extensions");
		await fs.promises.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, "index.ts"), "export default () => ({});\n");
		const plugin: InstalledPlugin = {
			name: "entrydir-plugin",
			version: "1.0.0",
			path: root,
			manifest: { version: "1.0.0", extensions: ["./extensions"] },
			enabledFeatures: null,
			enabled: true,
		};
		expect(resolvePluginExtensionPaths(plugin)).toEqual([path.join(dir, "index.ts")]);
		await fs.promises.chmod(dir, 0o000);
		restore.push(dir);
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			expect(resolvePluginExtensionPaths(plugin)).toEqual([]);
			const skips = warn.mock.calls.filter(([message]) => message === "plugins: skipping unreadable manifest entry");
			expect(skips).toHaveLength(1);
			expect(skips[0]?.[1]).toMatchObject({ path: dir });
		} finally {
			warn.mockRestore();
		}
	},
);

// A missing entry keeps its documented silence: `resolvePluginManifestEntries`
// reports it as a null resolvedPath for install-time validation to flag, so
// warning here as well would double-report every absent optional entry.
test("a missing manifest entry is still skipped quietly", async () => {
	const plugin = await plantEntryPlugin("omp-plugin-entry-missing-", "ext.ts");
	const warn = spyOn(logger, "warn").mockImplementation(() => {});
	try {
		expect(
			resolvePluginExtensionPaths({
				...plugin,
				manifest: { version: "1.0.0", extensions: ["extensions/absent.ts"] },
			}),
		).toEqual([]);
		expect(warn.mock.calls.filter(([message]) => message === "plugins: skipping unreadable manifest entry")).toEqual(
			[],
		);
	} finally {
		warn.mockRestore();
	}
});
