import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { discoverExtensionPaths } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// A plugin's `bin` directories go on PATH under the plugin's configured
// location, never its realpath. A plugins root that is a symlink (a dotfiles
// link, a versioned deployment's `current`, a marketplace install re-pointed
// at a new cache directory on upgrade) can be moved to a new target and the
// old target removed while a session runs; the session and its children keep
// the PATH they got, so a realpath entry would leave them without the
// plugin's commands.
//
// Each case is a project whose `.omp/plugins` holds the plugins, loaded the
// way a session loads them; the user's own plugins load too, so assertions
// look only at PATH entries inside the case's temp root.

const tempRoots: string[] = [];
let savedPath: string | undefined;

beforeEach(() => {
	savedPath = process.env.PATH;
});

afterEach(async () => {
	process.env.PATH = savedPath;
	clearClaudePluginRootsCache();
	for (const root of tempRoots.splice(0)) {
		await removeWithRetries(root);
	}
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await Bun.write(filePath, `${JSON.stringify(value)}\n`);
}

/** A plugin package with one executable `<command>` in `bin/`. */
async function writeBinPlugin(dir: string, name: string, command: string): Promise<void> {
	await fs.mkdir(path.join(dir, "bin"), { recursive: true });
	await writeJson(path.join(dir, "package.json"), { name, version: "1.0.0", omp: { bin: ["bin"] } });
	const script = path.join(dir, "bin", command);
	await Bun.write(script, `#!/bin/sh\necho "${command} ran"\n`);
	await fs.chmod(script, 0o755);
}

async function makeRoot(): Promise<{ root: string; project: string }> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-bin-")));
	tempRoots.push(root);
	const project = path.join(root, "project");
	await fs.mkdir(path.join(project, ".omp"), { recursive: true });
	return { root, project };
}

/** Load the project's plugins as a session does; return what landed inside `root`, in order. */
async function loadPlugins(project: string, root: string): Promise<{ pathEntries: string[]; extensions: string[] }> {
	const extensions = await discoverExtensionPaths([], project, undefined, {
		ambient: true,
		includeAmbientHooks: false,
	});
	return {
		pathEntries: (process.env.PATH ?? "").split(path.delimiter).filter(entry => entry.startsWith(root)),
		extensions: extensions.filter(entry => entry.startsWith(root)),
	};
}

async function loadAndReadPath(project: string, root: string): Promise<string[]> {
	return (await loadPlugins(project, root)).pathEntries;
}

test.skipIf(process.platform === "win32")(
	"a plugin under a symlinked plugins root keeps its command on PATH after the link moves and the old target is removed",
	async () => {
		const { root, project } = await makeRoot();
		// <project>/.omp/plugins -> <root>/deploy/current/plugins, current -> v1
		const v1Plugins = path.join(root, "deploy", "v1", "plugins");
		await writeBinPlugin(path.join(v1Plugins, "node_modules", "bin-plugin"), "bin-plugin", "omp-bin-plugin-probe");
		await writeJson(path.join(v1Plugins, "package.json"), { dependencies: { "bin-plugin": "1.0.0" } });
		await fs.symlink("v1", path.join(root, "deploy", "current"));
		await fs.symlink(path.join(root, "deploy", "current", "plugins"), path.join(project, ".omp", "plugins"));

		expect(await loadAndReadPath(project, root)).toEqual([
			path.join(project, ".omp", "plugins", "node_modules", "bin-plugin", "bin"),
		]);

		// Publish v2 the way a versioned deployment does: re-point `current`, remove v1.
		await fs.cp(path.join(root, "deploy", "v1"), path.join(root, "deploy", "v2"), { recursive: true });
		await fs.symlink("v2", path.join(root, "deploy", "current.next"));
		await fs.rename(path.join(root, "deploy", "current.next"), path.join(root, "deploy", "current"));
		await fs.rm(path.join(root, "deploy", "v1"), { recursive: true });

		const run = Bun.spawnSync(["sh", "-c", "omp-bin-plugin-probe"], { env: { PATH: process.env.PATH } });
		expect(run.stdout.toString()).toBe("omp-bin-plugin-probe ran\n");
		expect(run.exitCode).toBe(0);
	},
);

test.skipIf(process.platform === "win32")(
	"two names for one plugin directory load one extension and put one entry on PATH, under the first name",
	async () => {
		const { root, project } = await makeRoot();
		const pluginsDir = path.join(project, ".omp", "plugins");
		const nodeModules = path.join(pluginsDir, "node_modules");
		const alpha = path.join(nodeModules, "alpha");
		await writeBinPlugin(alpha, "alpha", "omp-alpha-probe");
		await Bun.write(path.join(alpha, "ext.js"), "export default function () {}\n");
		await writeJson(path.join(alpha, "package.json"), {
			name: "alpha",
			version: "1.0.0",
			omp: { bin: ["bin"], extensions: ["ext.js"] },
		});
		// `omp plugin link` of the same directory under a second name.
		await fs.symlink(alpha, path.join(nodeModules, "beta"));
		await writeJson(path.join(pluginsDir, "package.json"), { dependencies: { alpha: "1.0.0" } });
		await writeJson(path.join(pluginsDir, "omp-plugins.lock.json"), {
			plugins: { beta: { version: "1.0.0", enabled: true, enabledFeatures: null } },
			settings: {},
		});

		expect(await loadPlugins(project, root)).toEqual({
			pathEntries: [path.join(alpha, "bin")],
			extensions: [path.join(alpha, "ext.js")],
		});
	},
);

test.skipIf(process.platform === "win32")(
	"an inherited PATH entry naming the realpath does not stand in for the configured path",
	async () => {
		const { root, project } = await makeRoot();
		const realPlugins = path.join(root, "deploy", "v1", "plugins");
		await writeBinPlugin(path.join(realPlugins, "node_modules", "gamma"), "gamma", "omp-gamma-probe");
		await writeJson(path.join(realPlugins, "package.json"), { dependencies: { gamma: "1.0.0" } });
		await fs.symlink(realPlugins, path.join(project, ".omp", "plugins"));
		// What a process started by an older session inherits: the realpath entry.
		const realBin = path.join(realPlugins, "node_modules", "gamma", "bin");
		process.env.PATH = [realBin, savedPath ?? ""].join(path.delimiter);

		expect(await loadAndReadPath(project, root)).toEqual([
			path.join(project, ".omp", "plugins", "node_modules", "gamma", "bin"),
			realBin,
		]);
	},
);

test("a configured bin directory already on PATH is not added again", async () => {
	const { root, project } = await makeRoot();
	const pluginsDir = path.join(project, ".omp", "plugins");
	await writeBinPlugin(path.join(pluginsDir, "node_modules", "delta"), "delta", "omp-delta-probe");
	await writeJson(path.join(pluginsDir, "package.json"), { dependencies: { delta: "1.0.0" } });

	await loadAndReadPath(project, root);
	clearClaudePluginRootsCache();

	expect(await loadAndReadPath(project, root)).toEqual([path.join(pluginsDir, "node_modules", "delta", "bin")]);
});

test("a bin entry that is not a directory adds nothing", async () => {
	const { root, project } = await makeRoot();
	const pluginsDir = path.join(project, ".omp", "plugins");
	const pluginDir = path.join(pluginsDir, "node_modules", "epsilon");
	await fs.mkdir(pluginDir, { recursive: true });
	await Bun.write(path.join(pluginDir, "cli.sh"), "#!/bin/sh\n");
	await writeJson(path.join(pluginDir, "package.json"), {
		name: "epsilon",
		version: "1.0.0",
		omp: { bin: ["missing", "cli.sh"] },
	});
	await writeJson(path.join(pluginsDir, "package.json"), { dependencies: { epsilon: "1.0.0" } });

	expect(await loadAndReadPath(project, root)).toEqual([]);
});
