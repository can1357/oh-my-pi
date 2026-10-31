import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { discoverCustomToolPaths, loadCustomTools } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/loader";
import { discoverAndLoadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { __closeExtensionParseCacheForTests } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { getAgentDir, getPluginsDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

// A plugin's `bin` directories go on PATH under the plugin's installed path,
// never its realpath, before any of its modules evaluates. A plugins root that
// is a symlink (a dotfiles link, a versioned deployment's `current`, a
// marketplace install re-pointed at a new cache directory on upgrade) can be
// moved to a new target and the old target removed while a session runs; the
// session and its children keep the PATH they got, so a realpath entry would
// leave them without the plugin's commands.
//
// Each case loads plugins the way a session does, from an isolated home whose
// `.omp/plugins` it builds, starting from a known PATH.

const BASE_PATH = ["/usr/bin", "/bin"].join(path.delimiter);
const xdgVars = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;

describe.skipIf(process.platform === "win32")("plugin bin directories on PATH", () => {
	const originalAgentDir = getAgentDir();
	const originalXdg = new Map<string, string | undefined>();
	let originalPath: string | undefined;
	let root = "";
	let home = "";
	let cwd = "";
	let pluginsDir = "";

	beforeEach(async () => {
		originalPath = process.env.PATH;
		process.env.PATH = BASE_PATH;
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-bin-")));
		home = path.join(root, "home");
		cwd = path.join(root, "cwd");
		await fs.mkdir(path.join(home, ".omp"), { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		for (const key of xdgVars) {
			originalXdg.set(key, process.env[key]);
			delete process.env[key];
		}
		spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(path.join(home, ".omp", "agent"));
		pluginsDir = getPluginsDir();
		if (pluginsDir !== path.join(home, ".omp", "plugins")) {
			throw new Error(`plugin isolation failed: getPluginsDir() resolved to ${pluginsDir}`);
		}
	});

	afterEach(async () => {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		spyOn(os, "homedir").mockRestore();
		for (const [key, value] of originalXdg) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		originalXdg.clear();
		setAgentDir(originalAgentDir);
		clearClaudePluginRootsCache();
		__closeExtensionParseCacheForTests();
		await removeWithRetries(root);
	});

	async function writeJson(filePath: string, value: unknown): Promise<void> {
		await Bun.write(filePath, `${JSON.stringify(value)}\n`);
	}

	/**
	 * A plugin package with an executable `<name>-probe` in `bin/`. Its module
	 * runs the probe when it evaluates and records what it printed, so a case can
	 * tell whether PATH held the directory before the module loaded.
	 */
	async function writeBinPlugin(dir: string, name: string, manifest: Record<string, unknown>): Promise<void> {
		await fs.mkdir(path.join(dir, "bin"), { recursive: true });
		const probe = path.join(dir, "bin", `${name}-probe`);
		await Bun.write(probe, `#!/bin/sh\necho "${name} ran"\n`);
		await fs.chmod(probe, 0o755);
		await Bun.write(
			path.join(dir, "module.js"),
			`const run = Bun.spawnSync(["sh", "-c", ${JSON.stringify(`${name}-probe`)}], { env: { PATH: process.env.PATH } });
globalThis[${JSON.stringify(`__ompBinProbe_${name}`)}] = run.stdout.toString();
export default function () {}
`,
		);
		await writeJson(path.join(dir, "package.json"), { name, version: "1.0.0", omp: { bin: ["bin"], ...manifest } });
	}

	function probeAtLoad(name: string): unknown {
		return (globalThis as Record<string, unknown>)[`__ompBinProbe_${name}`];
	}

	async function declare(dependencies: string[], linked: string[] = []): Promise<void> {
		await writeJson(path.join(pluginsDir, "package.json"), {
			dependencies: Object.fromEntries(dependencies.map(name => [name, "1.0.0"])),
		});
		if (linked.length > 0) {
			await writeJson(path.join(pluginsDir, "omp-plugins.lock.json"), {
				plugins: Object.fromEntries(
					linked.map(name => [name, { version: "1.0.0", enabled: true, enabledFeatures: null }]),
				),
				settings: {},
			});
		}
	}

	test("a plugin under a symlinked plugins root keeps its command after the link moves and the old target is removed", async () => {
		// ~/.omp/plugins -> <root>/deploy/current/plugins, current -> v1
		const v1Plugins = path.join(root, "deploy", "v1", "plugins");
		await writeBinPlugin(path.join(v1Plugins, "node_modules", "rotating"), "rotating", { extensions: ["module.js"] });
		await writeJson(path.join(v1Plugins, "package.json"), { dependencies: { rotating: "1.0.0" } });
		await fs.symlink("v1", path.join(root, "deploy", "current"));
		await fs.symlink(path.join(root, "deploy", "current", "plugins"), pluginsDir);

		const result = await discoverAndLoadExtensions([], cwd);

		expect(result.errors).toEqual([]);
		expect(probeAtLoad("rotating")).toBe("rotating ran\n");
		const installedBin = path.join(pluginsDir, "node_modules", "rotating", "bin");
		expect(process.env.PATH).toBe([installedBin, BASE_PATH].join(path.delimiter));

		// Publish v2 the way a versioned deployment does: re-point `current`, remove v1.
		await fs.cp(path.join(root, "deploy", "v1"), path.join(root, "deploy", "v2"), { recursive: true });
		await fs.symlink("v2", path.join(root, "deploy", "current.next"));
		await fs.rename(path.join(root, "deploy", "current.next"), path.join(root, "deploy", "current"));
		await fs.rm(path.join(root, "deploy", "v1"), { recursive: true });

		const run = Bun.spawnSync(["sh", "-c", "rotating-probe"], { env: { PATH: process.env.PATH } });
		expect(run.stdout.toString()).toBe("rotating ran\n");
		expect(run.exitCode).toBe(0);
	});

	test("a plugin tool module finds the plugin's command on PATH when it evaluates", async () => {
		const realPlugins = path.join(root, "deploy", "v1", "plugins");
		await writeBinPlugin(path.join(realPlugins, "node_modules", "tooling"), "tooling", { tools: "module.js" });
		await writeJson(path.join(realPlugins, "package.json"), { dependencies: { tooling: "1.0.0" } });
		await fs.symlink(realPlugins, pluginsDir);

		await loadCustomTools(await discoverCustomToolPaths([], cwd), cwd, []);

		expect(probeAtLoad("tooling")).toBe("tooling ran\n");
		expect(process.env.PATH).toBe(
			[path.join(pluginsDir, "node_modules", "tooling", "bin"), BASE_PATH].join(path.delimiter),
		);
	});

	test("two names for one plugin directory load one extension and put one entry on PATH, under the first name", async () => {
		const alpha = path.join(pluginsDir, "node_modules", "alpha");
		await writeBinPlugin(alpha, "alpha", { extensions: ["module.js"] });
		// `omp plugin link` of the same directory under a second name.
		await fs.symlink(alpha, path.join(pluginsDir, "node_modules", "beta"));
		await declare(["alpha"], ["beta"]);

		const result = await discoverAndLoadExtensions([], cwd);

		expect(result.extensions.map(extension => extension.path)).toEqual([path.join(alpha, "module.js")]);
		expect(process.env.PATH).toBe([path.join(alpha, "bin"), BASE_PATH].join(path.delimiter));
	});

	test("an inherited PATH entry naming the realpath does not stand in for the installed path", async () => {
		const realPlugins = path.join(root, "deploy", "v1", "plugins");
		await writeBinPlugin(path.join(realPlugins, "node_modules", "gamma"), "gamma", { extensions: ["module.js"] });
		await writeJson(path.join(realPlugins, "package.json"), { dependencies: { gamma: "1.0.0" } });
		await fs.symlink(realPlugins, pluginsDir);
		// What a process started by an older session inherits: the realpath entry.
		const realBin = path.join(realPlugins, "node_modules", "gamma", "bin");
		process.env.PATH = [realBin, BASE_PATH].join(path.delimiter);

		await discoverAndLoadExtensions([], cwd);

		expect(process.env.PATH).toBe(
			[path.join(pluginsDir, "node_modules", "gamma", "bin"), realBin, BASE_PATH].join(path.delimiter),
		);
	});

	test("an installed bin directory already on PATH is not added again", async () => {
		await writeBinPlugin(path.join(pluginsDir, "node_modules", "delta"), "delta", { extensions: ["module.js"] });
		await declare(["delta"]);

		await discoverAndLoadExtensions([], cwd);
		clearClaudePluginRootsCache();
		await discoverAndLoadExtensions([], cwd);

		expect(process.env.PATH).toBe(
			[path.join(pluginsDir, "node_modules", "delta", "bin"), BASE_PATH].join(path.delimiter),
		);
	});

	test("a bin entry that is not a directory adds nothing", async () => {
		const pluginDir = path.join(pluginsDir, "node_modules", "epsilon");
		await fs.mkdir(pluginDir, { recursive: true });
		await Bun.write(path.join(pluginDir, "cli.sh"), "#!/bin/sh\n");
		await writeJson(path.join(pluginDir, "package.json"), {
			name: "epsilon",
			version: "1.0.0",
			omp: { bin: ["missing", "cli.sh"] },
		});
		await declare(["epsilon"]);

		await discoverAndLoadExtensions([], cwd);

		expect(process.env.PATH).toBe(BASE_PATH);
	});

	test("empty PATH entries survive, and an unset PATH gets only the plugin's directories", async () => {
		await writeBinPlugin(path.join(pluginsDir, "node_modules", "zeta"), "zeta", {});
		await declare(["zeta"]);
		const bin = path.join(pluginsDir, "node_modules", "zeta", "bin");
		const d = path.delimiter;

		const outcomes: Array<[string | undefined, string | undefined]> = [];
		for (const inherited of ["", `${d}/usr/bin${d}`, undefined]) {
			if (inherited === undefined) delete process.env.PATH;
			else process.env.PATH = inherited;
			clearClaudePluginRootsCache();
			await discoverAndLoadExtensions([], cwd);
			outcomes.push([inherited, process.env.PATH]);
		}

		expect(outcomes).toEqual([
			["", `${bin}${d}`],
			[`${d}/usr/bin${d}`, `${bin}${d}${d}/usr/bin${d}`],
			[undefined, bin],
		]);
	});
});
