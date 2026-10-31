// Child process for plugin-bin-path.test.ts: loads plugins by one route in a
// process of its own, so HOME, PATH and the directory resolver are the
// process's real state, never global state a test patches and restores.
// Prints one JSON line describing what the route left behind.
import { discoverCustomToolPaths, loadCustomTools } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/loader";
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
	getAllPluginExtensionPaths,
	getAllPluginToolPaths,
	getEnabledPlugins,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/manager";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getPluginsDir } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface RunnerScenario {
	route: "session" | "twice" | "explicit" | "tools" | "selectors" | "install";
	cwd: string;
	/** `explicit`: the one extension file to load. */
	explicitPath?: string;
	/** `install`: the package directory `bun install` would place under node_modules. */
	installSource?: string;
	installName?: string;
	/** Remove PATH from this process before the route runs (Bun gives a process started without one a default). */
	unsetPath?: boolean;
}

export interface RunnerResult {
	PATH: string | null;
	pluginsDir: string;
	extensions: string[];
	errors: string[];
	tools: string[];
	toolErrors: string[];
	selected: string[];
	probes: Record<string, string>;
}

const scenario = JSON.parse(process.argv[2] ?? "{}") as RunnerScenario;
const result: RunnerResult = {
	PATH: null,
	pluginsDir: getPluginsDir(),
	extensions: [],
	errors: [],
	tools: [],
	toolErrors: [],
	selected: [],
	probes: {},
};

if (scenario.unsetPath) delete process.env.PATH;
switch (scenario.route) {
	case "session":
	case "twice": {
		let loaded = await discoverAndLoadExtensions([], scenario.cwd);
		if (scenario.route === "twice") {
			clearClaudePluginRootsCache();
			loaded = await discoverAndLoadExtensions([], scenario.cwd);
		}
		result.extensions = loaded.extensions.map(extension => extension.path);
		result.errors = loaded.errors.map(error => error.error);
		break;
	}
	case "explicit": {
		const loaded = await discoverAndLoadExtensions(
			[scenario.explicitPath ?? ""],
			scenario.cwd,
			undefined,
			undefined,
			{
				ambient: false,
			},
		);
		result.extensions = loaded.extensions.map(extension => extension.path);
		result.errors = loaded.errors.map(error => error.error);
		break;
	}
	case "tools": {
		const loaded = await loadCustomTools(await discoverCustomToolPaths([], scenario.cwd), scenario.cwd, []);
		result.tools = loaded.tools.map(tool => tool.tool.name);
		result.toolErrors = loaded.errors.map(error => error.error);
		break;
	}
	case "selectors": {
		result.selected = [
			...(await getAllPluginExtensionPaths(scenario.cwd)),
			...(await getAllPluginToolPaths(scenario.cwd)),
		];
		break;
	}
	case "install": {
		// Warm the enabled-plugin cache first: validation must use the candidate,
		// which the cache does not hold.
		await getEnabledPlugins(scenario.cwd);
		const name = scenario.installName ?? "";
		const source = scenario.installSource ?? "";
		const pluginsDir = getPluginsDir();
		const realSpawn = Bun.spawn;
		// `bun install <name>`: put the package where bun would, nothing else.
		Bun.spawn = ((cmd: string[], options?: Parameters<typeof Bun.spawn>[1]) => {
			if (cmd[1] !== "install") return realSpawn(cmd, options);
			const exited = (async () => {
				await fs.cp(source, path.join(pluginsDir, "node_modules", name), { recursive: true });
				const manifestPath = path.join(pluginsDir, "package.json");
				const manifest = (await Bun.file(manifestPath).json()) as { dependencies?: Record<string, string> };
				await Bun.write(
					manifestPath,
					JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, [name]: "1.0.0" } }),
				);
				return 0;
			})();
			return { pid: 1, stdout: new Response("").body, stderr: new Response("").body, exited };
		}) as typeof Bun.spawn;
		try {
			await new PluginManager(scenario.cwd).install(name);
		} catch (error) {
			result.errors.push(error instanceof Error ? error.message : String(error));
		} finally {
			Bun.spawn = realSpawn;
		}
		break;
	}
}

result.PATH = process.env.PATH ?? null;
for (const [key, value] of Object.entries(globalThis)) {
	if (key.startsWith("__ompBinProbe_") && typeof value === "string") result.probes[key.slice(14)] = value;
}
console.log(JSON.stringify(result));
