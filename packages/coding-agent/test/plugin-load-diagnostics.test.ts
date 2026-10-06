import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getEnabledPlugins, resolvePluginExtensionPaths } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { logger, removeWithRetries } from "@oh-my-pi/pi-utils";

const tempRoots: string[] = [];
const restore: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	clearClaudePluginRootsCache();
	// Cleanup needs the permissions back: a denied directory blocks its own removal.
	for (const target of restore.splice(0)) {
		await fs.chmod(target, 0o700).catch(() => {});
	}
	for (const root of tempRoots.splice(0)) {
		await removeWithRetries(root);
	}
});

/**
 * Silence the logger and return a reader for the `path` each warning named.
 * A plugin that loaded with fewer entries than it declared is otherwise
 * indistinguishable from one that declared fewer.
 */
function captureWarnedPaths(): () => string[] {
	const spy = vi.spyOn(logger, "warn").mockImplementation(() => {});
	return () =>
		spy.mock.calls
			.map(call => call[1])
			.map(details =>
				details !== null && typeof details === "object" ? (details as { path?: unknown }).path : undefined,
			)
			.filter((value): value is string => typeof value === "string");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await Bun.write(filePath, `${JSON.stringify(value)}\n`);
}

/** A plugins root holding one declared plugin whose extensions entry is `extensionsEntry`. */
async function plantRoot(
	prefix: string,
	extensionsEntry: string,
): Promise<{ home: string; cwd: string; pluginDir: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempRoots.push(root);
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	const pluginsDir = path.join(home, ".omp", "plugins");
	// Anchor the project registry lookup: without a local `.omp` it walks up the
	// filesystem and can collect a real project on a shared tmpdir.
	await fs.mkdir(path.join(cwd, ".omp"), { recursive: true });

	const pluginDir = path.join(pluginsDir, "node_modules", "declared-plugin");
	await fs.mkdir(pluginDir, { recursive: true });
	await writeJson(path.join(pluginDir, "package.json"), {
		name: "declared-plugin",
		version: "1.0.0",
		omp: { extensions: [extensionsEntry] },
	});

	await writeJson(path.join(pluginsDir, "package.json"), { dependencies: { "declared-plugin": "1.0.0" } });
	await writeJson(path.join(pluginsDir, "omp-plugins.lock.json"), {
		plugins: { "declared-plugin": { version: "1.0.0", enabled: true, enabledFeatures: null } },
		settings: {},
	});
	return { home, cwd, pluginDir };
}

/** The extension files the single planted plugin resolves to. */
async function extensionPathsOf(home: string, cwd: string): Promise<string[]> {
	const plugins = await getEnabledPlugins(cwd, { home });
	return plugins.flatMap(plugin => resolvePluginExtensionPaths(plugin));
}

// Regression: `loadProjectOverrides` skipped every error that was not ENOENT, so
// a hand-written `plugin-overrides.json` with one trailing comma applied nothing
// and said nothing. `disabled` is how a project pins a plugin off, so the plugin
// the project switched off came back on with no signal anywhere.
test("a malformed project plugin-overrides.json is reported instead of silently dropped", async () => {
	const { home, cwd } = await plantRoot("omp-plugin-bad-overrides-", "ext.ts");
	const overrides = path.join(cwd, ".omp", "plugin-overrides.json");
	await fs.mkdir(path.dirname(overrides), { recursive: true });
	await Bun.write(overrides, '{\n\t"disabled": ["declared-plugin"],\n}\n');

	const warnedPaths = captureWarnedPaths();
	const plugins = await getEnabledPlugins(cwd, { home });

	expect(warnedPaths()).toContain(overrides);
	// Reported, not fatal: an unusable override file must not stop the session.
	expect(plugins.map(plugin => plugin.name)).toEqual(["declared-plugin"]);
});

// Regression: the configured `-e` extension directory reports an unreadable
// manifest, and a plugin's own extensions directory reported nothing — so a
// plugin could load, appear enabled, and contribute nothing at all.
//
// This covers the `onReadError` wiring on the plugin options, via a JSON parse
// failure. The denial branch is the third test below.
test("a plugin extensions directory with a malformed package.json is reported", async () => {
	const { home, cwd, pluginDir } = await plantRoot("omp-plugin-bad-extmanifest-", "ext-dir");
	const extDir = path.join(pluginDir, "ext-dir");
	await fs.mkdir(extDir, { recursive: true });
	await Bun.write(path.join(extDir, "package.json"), '{\n\t"omp": { "extensions": ["a.ts"] },\n}\n');
	await Bun.write(path.join(extDir, "a.ts"), "export default {};\n");

	const warnedPaths = captureWarnedPaths();
	const files = await extensionPathsOf(home, cwd);

	expect(warnedPaths()).toContain(path.join(extDir, "package.json"));
	// The convention fallback still finds the module: reporting is not dropping.
	expect(files).toEqual([path.join(extDir, "a.ts")]);
});

// Regression: a plugin that resolves exactly what it declared has nothing wrong
// with it, so it must produce no warning at all. The reporting predicate draws
// the line at ENOENT, and a healthy install hits ENOENT constantly: no
// `index.ts`, no `package.json`, a `.d.ts` the scan must skip. If that line
// moves to EACCES this suite goes quiet while every install logs.
test("a plugin whose declared paths all resolve reports nothing", async () => {
	const { home, cwd, pluginDir } = await plantRoot("omp-plugin-clean-ext-", "ext-dir");
	const extDir = path.join(pluginDir, "ext-dir");
	await fs.mkdir(extDir, { recursive: true });
	// No package.json, so resolution falls through every ENOENT probe before it
	// finds the module: a missing index, a missing manifest, and the nested
	// node_modules directory all miss here, and none of it is a denial.
	await Bun.write(path.join(extDir, "a.ts"), "export default {};\n");
	await Bun.write(path.join(extDir, "types.d.ts"), "export {};\n");
	await fs.mkdir(path.join(extDir, "node_modules"), { recursive: true });

	const warnedPaths = captureWarnedPaths();
	const files = await extensionPathsOf(home, cwd);

	expect(files).toEqual([path.join(extDir, "a.ts")]);
	expect(warnedPaths()).toEqual([]);
});

// Same contract with no index file and no manifest anywhere: every probe misses,
// and a miss is not a denial.
test("a plugin extensions directory with nothing to resolve reports nothing", async () => {
	const { home, cwd, pluginDir } = await plantRoot("omp-plugin-empty-ext-", "ext-dir");
	const extDir = path.join(pluginDir, "ext-dir");
	await fs.mkdir(path.join(extDir, "sub", "nested"), { recursive: true });

	const warnedPaths = captureWarnedPaths();
	const files = await extensionPathsOf(home, cwd);

	expect(files).toEqual([]);
	expect(warnedPaths()).toEqual([]);
});

// Regression: a child the process may not stat inside a plugin's extensions
// directory was dropped by a bare `continue`. Mode r-- without x lists the
// entry and then denies the stat, which is the read-only-install shape.
// Only the denial needs mode bits enforced, which excludes root and Windows.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
	"an unreadable child inside a plugin extensions directory is reported",
	async () => {
		const { home, cwd, pluginDir } = await plantRoot("omp-plugin-denied-ext-", "ext-dir");
		const extDir = path.join(pluginDir, "ext-dir");
		await fs.mkdir(extDir, { recursive: true });
		await Bun.write(path.join(extDir, "mod.ts"), "export default {};\n");
		await fs.chmod(extDir, 0o444);
		restore.push(extDir);

		const warnedPaths = captureWarnedPaths();
		const files = await extensionPathsOf(home, cwd);

		expect(warnedPaths()).toContain(path.join(extDir, "mod.ts"));
		expect(files).toEqual([]);
	},
);
