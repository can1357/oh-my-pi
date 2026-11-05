import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getEnabledPlugins, getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import * as piUtils from "@oh-my-pi/pi-utils";
import { logger, removeWithRetries } from "@oh-my-pi/pi-utils";

// Issue #14518: a malformed or unreadable project plugin-overrides.json was
// swallowed by the loader's loadProjectOverrides, so the file silently acted
// as {} — project-disabled plugins re-enabled and project settings vanished
// without any diagnostic. The contract: a non-ENOENT failure MUST emit a
// structured warning carrying the offending path, while the {} fallback and
// ENOENT silence are preserved.

const tempRoots: string[] = [];

afterEach(async () => {
	clearClaudePluginRootsCache();
	for (const root of tempRoots.splice(0)) {
		await removeWithRetries(root);
	}
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await Bun.write(filePath, `${JSON.stringify(value)}\n`);
}

/** A plugins home with one declared, loadable plugin, plus a project cwd. */
async function plantRoot(prefix: string): Promise<{ home: string; cwd: string; pluginsDir: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempRoots.push(root);
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	const pluginsDir = path.join(home, ".omp", "plugins");
	await fs.mkdir(cwd, { recursive: true });

	const declaredDir = path.join(pluginsDir, "node_modules", "declared-plugin");
	await fs.mkdir(declaredDir, { recursive: true });
	await writeJson(path.join(declaredDir, "package.json"), {
		name: "declared-plugin",
		version: "1.0.0",
		omp: { extensions: ["ext.ts"] },
	});
	await writeJson(path.join(pluginsDir, "package.json"), { dependencies: { "declared-plugin": "1.0.0" } });
	await writeJson(path.join(pluginsDir, "omp-plugins.lock.json"), {
		plugins: { "declared-plugin": { version: "1.0.0", enabled: true, enabledFeatures: null } },
		settings: {},
	});
	return { home, cwd, pluginsDir };
}

async function writeOverrides(cwd: string, contents: string): Promise<string> {
	const overridesPath = path.join(cwd, ".omp", "plugin-overrides.json");
	await fs.mkdir(path.join(cwd, ".omp"), { recursive: true });
	await Bun.write(overridesPath, contents);
	return overridesPath;
}

/** First warn() call about plugin overrides, with its message and path detail. */
function overridesWarning(warn: {
	mock: { calls: Array<[message: string, details?: Record<string, unknown>]> };
}): { message: unknown; path: unknown } | undefined {
	for (const [message, details] of warn.mock.calls) {
		if (details === undefined) continue;
		const { path } = details;
		if (String(message).includes("plugin overrides")) return { message, path };
	}
	return undefined;
}

test("a malformed project plugin-overrides.json is diagnosed instead of silently vanishing", async () => {
	const { home, cwd } = await plantRoot("omp-plugin-overrides-malformed-");
	const overridesPath = await writeOverrides(cwd, "{ not valid json");

	const warn = spyOn(logger, "warn").mockImplementation(() => {});
	try {
		const plugins = await getEnabledPlugins(cwd, { home });
		// Fallback semantics preserved: overrides degrade to {} instead of
		// failing plugin collection.
		expect(plugins.map(plugin => plugin.name)).toEqual(["declared-plugin"]);
		// Contract: the dropped overrides MUST be reported with the path.
		const warning = overridesWarning(warn);
		expect(warning).toBeDefined();
		expect(String(warning?.message)).toContain("plugin overrides");
		expect(warning?.path).toBe(overridesPath);
	} finally {
		warn.mockRestore();
	}
});

test("getPluginSettings surfaces the same diagnostic for malformed project overrides", async () => {
	const { cwd, pluginsDir } = await plantRoot("omp-plugin-overrides-settings-");
	const overridesPath = await writeOverrides(cwd, "{ not valid json");

	const getPluginsLockfile = spyOn(piUtils, "getPluginsLockfile").mockReturnValue(
		path.join(pluginsDir, "omp-plugins.lock.json"),
	);
	const warn = spyOn(logger, "warn").mockImplementation(() => {});
	try {
		const settings = await getPluginSettings("declared-plugin", cwd);
		expect(settings).toEqual({});
		const warning = overridesWarning(warn);
		expect(warning).toBeDefined();
		expect(warning?.path).toBe(overridesPath);
	} finally {
		warn.mockRestore();
		getPluginsLockfile.mockRestore();
	}
});

test("a missing project plugin-overrides.json stays silent", async () => {
	const { home, cwd } = await plantRoot("omp-plugin-overrides-missing-");

	const warn = spyOn(logger, "warn").mockImplementation(() => {});
	try {
		const plugins = await getEnabledPlugins(cwd, { home });
		expect(plugins.map(plugin => plugin.name)).toEqual(["declared-plugin"]);
		expect(warn).not.toHaveBeenCalled();
	} finally {
		warn.mockRestore();
	}
});

test("a valid project plugin-overrides.json still disables its plugin", async () => {
	const { home, cwd } = await plantRoot("omp-plugin-overrides-valid-");
	await writeOverrides(cwd, JSON.stringify({ disabled: ["declared-plugin"] }));

	const plugins = await getEnabledPlugins(cwd, { home });
	expect(plugins.map(plugin => plugin.name)).toEqual([]);
});
