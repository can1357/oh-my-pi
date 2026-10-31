import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { RunnerResult, RunnerScenario } from "./plugin-bin-path.runner";

// A plugin's `bin` directories go on PATH under the plugin's installed path,
// never its realpath, before any of its modules evaluates. A plugins root that
// is a symlink (a dotfiles link, a versioned deployment's `current`, a
// marketplace install re-pointed at a new cache directory on upgrade) can be
// moved to a new target and the old target removed while a session runs; the
// session and its children keep the PATH they got, so a realpath entry would
// leave them without the plugin's commands.
//
// Each case builds a home and loads plugins by one route in a child process
// (plugin-bin-path.runner.ts) whose environment holds only HOME, TMPDIR and
// the case's PATH: the process's own directory state, nothing patched here.

const RUNNER = path.join(import.meta.dir, "plugin-bin-path.runner.ts");
const BASE_PATH = ["/usr/bin", "/bin"].join(path.delimiter);
// A child process imports the coding agent from cold, about 6 s here.
setDefaultTimeout(120_000);

describe.skipIf(process.platform === "win32")("plugin bin directories on PATH", () => {
	let root = "";
	let home = "";
	let cwd = "";
	let pluginsDir = "";

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-bin-")));
		home = path.join(root, "home");
		cwd = path.join(root, "cwd");
		pluginsDir = path.join(home, ".omp", "plugins");
		await fs.mkdir(path.join(home, ".omp"), { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
	});

	afterEach(async () => {
		await removeWithRetries(root);
	});

	/** Run one route in a child process whose environment holds only HOME, TMPDIR and this PATH. */
	async function run(scenario: Omit<RunnerScenario, "cwd">, PATH: string = BASE_PATH) {
		const env: Record<string, string> = { HOME: home, TMPDIR: os.tmpdir(), PATH };
		const child = Bun.spawn([process.execPath, RUNNER, JSON.stringify({ ...scenario, cwd })], {
			cwd: import.meta.dir,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (exitCode !== 0) throw new Error(`runner exited ${exitCode}: ${stderr}`);
		const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as RunnerResult;
		expect(result.pluginsDir).toBe(pluginsDir);
		return result;
	}

	async function writeJson(filePath: string, value: unknown): Promise<void> {
		await Bun.write(filePath, `${JSON.stringify(value)}\n`);
	}

	/**
	 * A plugin package with an executable `<name>-probe` in `bin/`, an extension
	 * (`ext.js`) and a tool (`tool.js`). Each module runs the probe when it
	 * evaluates and records what it printed, so a case can tell whether PATH held
	 * the directory before the module loaded.
	 */
	async function writeBinPlugin(dir: string, name: string, manifest: Record<string, unknown>): Promise<void> {
		await fs.mkdir(path.join(dir, "bin"), { recursive: true });
		const probe = path.join(dir, "bin", `${name}-probe`);
		await Bun.write(probe, `#!/bin/sh\necho "${name} ran"\n`);
		await fs.chmod(probe, 0o755);
		const runProbe = `const run = Bun.spawnSync(["sh", "-c", ${JSON.stringify(`${name}-probe`)}], { env: { PATH: process.env.PATH } });
globalThis[${JSON.stringify(`__ompBinProbe_${name}`)}] = run.stdout.toString();
`;
		await Bun.write(path.join(dir, "ext.js"), `${runProbe}export default function () {}\n`);
		await Bun.write(
			path.join(dir, "tool.js"),
			`${runProbe}export default function (pi) {
	return {
		name: ${JSON.stringify(`${name}_probe`)},
		label: ${JSON.stringify(name)},
		description: "Runs nothing; its module ran the probe.",
		parameters: pi.typebox.Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	};
}
`,
		);
		await writeJson(path.join(dir, "package.json"), { name, version: "1.0.0", omp: { bin: ["bin"], ...manifest } });
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

	const binOf = (name: string) => path.join(pluginsDir, "node_modules", name, "bin");

	test("a plugin under a symlinked plugins root keeps its command after the link moves and the old target is removed", async () => {
		// ~/.omp/plugins -> <root>/deploy/current/plugins, current -> v1
		const v1Plugins = path.join(root, "deploy", "v1", "plugins");
		await writeBinPlugin(path.join(v1Plugins, "node_modules", "rotating"), "rotating", { extensions: ["ext.js"] });
		await writeJson(path.join(v1Plugins, "package.json"), { dependencies: { rotating: "1.0.0" } });
		await fs.symlink("v1", path.join(root, "deploy", "current"));
		await fs.symlink(path.join(root, "deploy", "current", "plugins"), pluginsDir);

		const result = await run({ route: "session" });

		expect(result.errors).toEqual([]);
		expect(result.probes).toEqual({ rotating: "rotating ran\n" });
		expect(result.PATH).toBe([binOf("rotating"), BASE_PATH].join(path.delimiter));

		// Publish v2 the way a versioned deployment does: re-point `current`, remove v1.
		await fs.cp(path.join(root, "deploy", "v1"), path.join(root, "deploy", "v2"), { recursive: true });
		await fs.symlink("v2", path.join(root, "deploy", "current.next"));
		await fs.rename(path.join(root, "deploy", "current.next"), path.join(root, "deploy", "current"));
		await fs.rm(path.join(root, "deploy", "v1"), { recursive: true });

		const probe = Bun.spawnSync(["sh", "-c", "rotating-probe"], { env: { PATH: result.PATH ?? "" } });
		expect(probe.stdout.toString()).toBe("rotating ran\n");
		expect(probe.exitCode).toBe(0);
	});

	test("a plugin tool module finds the plugin's command on PATH when it evaluates, and loads", async () => {
		const realPlugins = path.join(root, "deploy", "v1", "plugins");
		await writeBinPlugin(path.join(realPlugins, "node_modules", "tooling"), "tooling", { tools: "tool.js" });
		await writeJson(path.join(realPlugins, "package.json"), { dependencies: { tooling: "1.0.0" } });
		await fs.symlink(realPlugins, pluginsDir);

		const result = await run({ route: "tools" });

		expect(result.toolErrors).toEqual([]);
		expect(result.tools).toContain("tooling_probe");
		expect(result.probes).toEqual({ tooling: "tooling ran\n" });
		expect(result.PATH).toBe([binOf("tooling"), BASE_PATH].join(path.delimiter));
	});

	test("an SDK caller that selects plugin paths itself gets the directories on PATH", async () => {
		await writeBinPlugin(path.join(pluginsDir, "node_modules", "preload"), "preload", {
			extensions: ["ext.js"],
			tools: "tool.js",
		});
		await declare(["preload"]);

		// What a caller passing preloadedExtensionPaths / preloadedCustomToolPaths selects.
		const result = await run({ route: "selectors" });

		expect(result.selected).toEqual([
			path.join(pluginsDir, "node_modules", "preload", "ext.js"),
			path.join(pluginsDir, "node_modules", "preload", "tool.js"),
		]);
		expect(result.PATH).toBe([binOf("preload"), BASE_PATH].join(path.delimiter));
	});

	test("install validation puts the candidate's directories on PATH before its extension evaluates", async () => {
		await writeJson(path.join(pluginsDir, "package.json"), { name: "omp-plugins", private: true, dependencies: {} });
		const source = path.join(root, "source", "candidate");
		await writeBinPlugin(source, "candidate", { extensions: ["ext.js"] });

		const result = await run({ route: "install", installSource: source, installName: "candidate" });

		expect(result.errors).toEqual([]);
		expect(result.probes).toEqual({ candidate: "candidate ran\n" });
		expect(result.PATH).toBe([binOf("candidate"), BASE_PATH].join(path.delimiter));
	});

	test("two names for one plugin directory load one extension and put one entry on PATH, under the first name", async () => {
		const alpha = path.join(pluginsDir, "node_modules", "alpha");
		await writeBinPlugin(alpha, "alpha", { extensions: ["ext.js"] });
		// `omp plugin link` of the same directory under a second name.
		await fs.symlink(alpha, path.join(pluginsDir, "node_modules", "beta"));
		await declare(["alpha"], ["beta"]);

		const result = await run({ route: "session" });

		expect(result.extensions).toEqual([path.join(alpha, "ext.js")]);
		expect(result.PATH).toBe([path.join(alpha, "bin"), BASE_PATH].join(path.delimiter));
	});

	test("an inherited PATH entry naming the realpath does not stand in for the installed path", async () => {
		const realPlugins = path.join(root, "deploy", "v1", "plugins");
		await writeBinPlugin(path.join(realPlugins, "node_modules", "gamma"), "gamma", { extensions: ["ext.js"] });
		await writeJson(path.join(realPlugins, "package.json"), { dependencies: { gamma: "1.0.0" } });
		await fs.symlink(realPlugins, pluginsDir);
		// What a process started by an older session inherits: the realpath entry.
		const realBin = path.join(realPlugins, "node_modules", "gamma", "bin");

		const result = await run({ route: "session" }, [realBin, BASE_PATH].join(path.delimiter));

		expect(result.PATH).toBe([binOf("gamma"), realBin, BASE_PATH].join(path.delimiter));
	});

	test("an installed bin directory already on PATH is not added again", async () => {
		await writeBinPlugin(path.join(pluginsDir, "node_modules", "delta"), "delta", { extensions: ["ext.js"] });
		await declare(["delta"]);

		const result = await run({ route: "twice" });

		expect(result.PATH).toBe([binOf("delta"), BASE_PATH].join(path.delimiter));
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

		expect((await run({ route: "session" })).PATH).toBe(BASE_PATH);
	});

	test("empty PATH entries survive, and an unset PATH gets only the plugin's directories", async () => {
		await writeBinPlugin(path.join(pluginsDir, "node_modules", "zeta"), "zeta", {});
		await declare(["zeta"]);
		const bin = binOf("zeta");
		const d = path.delimiter;

		const outcomes: Array<[string | undefined, string | null]> = [];
		for (const inherited of ["", `${d}/usr/bin${d}`, undefined]) {
			const result = await run({ route: "session", unsetPath: inherited === undefined }, inherited ?? BASE_PATH);
			outcomes.push([inherited, result.PATH]);
		}

		expect(outcomes).toEqual([
			["", `${bin}${d}`],
			[`${d}/usr/bin${d}`, `${bin}${d}${d}/usr/bin${d}`],
			[undefined, bin],
		]);
	});

	test("an explicit-only extension load adds no ambient plugin's directories", async () => {
		await writeBinPlugin(path.join(pluginsDir, "node_modules", "ambient"), "ambient", { extensions: ["ext.js"] });
		await declare(["ambient"]);
		const explicit = path.join(root, "explicit.js");
		await Bun.write(explicit, "export default function () {}\n");

		const result = await run({ route: "explicit", explicitPath: explicit });

		expect(result.extensions).toEqual([explicit]);
		expect(result.probes).toEqual({});
		expect(result.PATH).toBe(BASE_PATH);
	});
});
