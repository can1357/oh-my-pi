import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getEnabledPlugins } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

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

// Regression: a package removed from the plugins package.json outside
// `omp plugin remove` leaves its lockfile entry and (because bun install
// never prunes undeclared directories) its node_modules tree behind. The
// loader must not load that orphan — doing so double-loads its extensions
// (every envoy message was delivered twice). Lockfile-only entries are
// legitimate only as symlinks (`omp plugin link`, marketplace runtime
// registration), which must keep loading.
test("stale lockfile-only directory plugin is skipped while declared and linked plugins load", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-stale-"));
	tempRoots.push(root);
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	const pluginsDir = path.join(home, ".omp", "plugins");
	const nodeModules = path.join(pluginsDir, "node_modules");
	await fs.mkdir(cwd, { recursive: true });

	// Declared dependency backed by a real directory: loads.
	const declaredDir = path.join(nodeModules, "declared-plugin");
	await fs.mkdir(declaredDir, { recursive: true });
	await writeJson(path.join(declaredDir, "package.json"), {
		name: "declared-plugin",
		version: "1.0.0",
		omp: { extensions: ["ext.ts"] },
	});

	// Lockfile-only entry backed by a real directory: the stale orphan; must be skipped.
	const staleDir = path.join(nodeModules, "stale-plugin");
	await fs.mkdir(staleDir, { recursive: true });
	await writeJson(path.join(staleDir, "package.json"), {
		name: "stale-plugin",
		version: "0.1.0",
		omp: { extensions: ["ext.ts"] },
	});

	// Lockfile-only entry backed by a symlink (omp plugin link): loads.
	const linkedSource = path.join(root, "linked-plugin-src");
	await fs.mkdir(linkedSource, { recursive: true });
	await writeJson(path.join(linkedSource, "package.json"), {
		name: "linked-plugin",
		version: "0.2.0",
		omp: { extensions: ["ext.ts"] },
	});
	await fs.symlink(linkedSource, path.join(nodeModules, "linked-plugin"));

	await writeJson(path.join(pluginsDir, "package.json"), {
		dependencies: { "declared-plugin": "1.0.0" },
	});
	await writeJson(path.join(pluginsDir, "omp-plugins.lock.json"), {
		plugins: {
			"declared-plugin": { version: "1.0.0", enabled: true, enabledFeatures: null },
			"stale-plugin": { version: "0.1.0", enabled: true, enabledFeatures: null },
			"linked-plugin": { version: "0.2.0", enabled: true, enabledFeatures: null },
		},
		settings: {},
	});

	const plugins = await getEnabledPlugins(cwd, { home });
	const names = plugins.map(plugin => plugin.name).sort();

	expect(names).toEqual(["declared-plugin", "linked-plugin"]);
});

test("manifest-less project roots retain lockfile-only directory plugins", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-project-plugin-"));
	tempRoots.push(root);
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	const pluginsDir = path.join(cwd, ".omp", "plugins");
	const installedDir = path.join(pluginsDir, "node_modules", "project-plugin");
	await fs.mkdir(installedDir, { recursive: true });
	await writeJson(path.join(installedDir, "package.json"), {
		name: "project-plugin",
		version: "1.0.0",
		omp: { extensions: ["ext.ts"] },
	});
	await writeJson(path.join(pluginsDir, "omp-plugins.lock.json"), {
		plugins: {
			"project-plugin": { version: "1.0.0", enabled: true, enabledFeatures: null },
		},
		settings: {},
	});

	const plugins = await getEnabledPlugins(cwd, { home });

	expect(plugins.map(plugin => [plugin.name, plugin.scope])).toContainEqual(["project-plugin", "project"]);
});
