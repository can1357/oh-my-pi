import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readJsonl, removeWithRetries } from "@oh-my-pi/pi-utils";
import { runCase } from "./plugin-bin-path.harness";
import type { RunnerScenario } from "./plugin-bin-path.runner";

// A plugin's `bin` directories go on PATH under the plugin's installed path,
// never its realpath, before any of its modules evaluates. A plugins root that
// is a symlink (a dotfiles link, a versioned deployment's `current`, a
// marketplace install re-pointed at a new cache directory on upgrade) can be
// moved to a new target and the old target removed while a session runs; the
// session and its children keep the PATH they got, so a realpath entry would
// leave them without the plugin's commands.
//
// Each case builds a home and loads plugins by one route in a child process
// (plugin-bin-path.runner.ts through runCase, or this tree's CLI in RPC mode)
// whose environment holds only HOME, TMPDIR and the case's PATH: the
// process's own directory state, nothing patched here.

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");
const BASE_PATH = ["/usr/bin", "/bin"].join(path.delimiter);
// A child process imports the coding agent from cold, about 6 s here.
setDefaultTimeout(120_000);

interface RpcFrame {
	type?: string;
	id?: string;
	success?: boolean;
	data?: unknown;
}

/** Whether each command ran in one session shell, before and after the plugins root moved. */
interface RotationOutcome {
	/** `<name>-probe`, before the move. */
	ranBefore: boolean;
	/** `<name>-probe` again, after the move: the shell already ran it. */
	afterMove: boolean;
	/** `<name>-fresh`, after the move: the shell never ran it. */
	neverRun: boolean;
	/** `hash -r`, then `<name>-probe`. */
	afterHashReset: boolean;
}

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

	/**
	 * Run one route in a child process whose environment holds only HOME, TMPDIR,
	 * this PATH and `extraEnv`.
	 */
	async function run(
		scenario: Omit<RunnerScenario, "cwd">,
		PATH: string = BASE_PATH,
		extraEnv: Record<string, string> = {},
	) {
		const result = await runCase({ ...scenario, cwd }, { HOME: home, TMPDIR: os.tmpdir(), PATH, ...extraEnv });
		expect(result.pluginsDir).toBe(pluginsDir);
		return result;
	}

	/**
	 * An omp session started from this tree's CLI in RPC mode, in a process whose
	 * environment holds only HOME, TMPDIR, this PATH and a placeholder API key (a
	 * model must resolve for the session to start; no prompt is sent).
	 */
	async function startRpcSession(PATH: string) {
		const child = Bun.spawn([process.execPath, CLI, "--mode", "rpc", "--no-session"], {
			cwd,
			env: { HOME: home, TMPDIR: os.tmpdir(), PATH, TERM: "dumb", ANTHROPIC_API_KEY: "plugin-bin-path-unused" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = new Response(child.stderr).text();
		const frames = readJsonl<RpcFrame>(child.stdout);
		async function next(match: (frame: RpcFrame) => boolean): Promise<RpcFrame> {
			for (;;) {
				const { value, done } = await frames.next();
				if (done) throw new Error(`omp exited ${await child.exited}: ${await stderr}`);
				if (match(value)) return value;
			}
		}
		let requests = 0;
		const session = {
			/** Run a command through the session's own shell, as `!` and the RPC `bash` command do. */
			async bash(command: string): Promise<{ output: string; exitCode: number | undefined }> {
				const id = `bash-${++requests}`;
				child.stdin.write(`${JSON.stringify({ id, type: "bash", command })}\n`);
				await child.stdin.flush();
				const response = await next(frame => frame.type === "response" && frame.id === id);
				if (response.success !== true) throw new Error(`bash failed: ${JSON.stringify(response)}`);
				return response.data as { output: string; exitCode: number | undefined };
			},
			async close(): Promise<void> {
				child.kill();
				await child.exited;
			},
		};
		try {
			await next(frame => frame.type === "ready");
		} catch (error) {
			await session.close();
			throw error;
		}
		return session;
	}

	async function writeJson(filePath: string, value: unknown): Promise<void> {
		await Bun.write(filePath, `${JSON.stringify(value)}\n`);
	}

	/**
	 * A plugin package with an executable `<name>-probe` in `bin/`, an extension
	 * (`ext.js`) and a tool (`tool.js`). Each module runs the probe when it
	 * evaluates, records what it printed, and throws when the probe is not on
	 * PATH, as a plugin that needs its own command at import does: a case can
	 * tell whether PATH held the directory before the module loaded, and the
	 * module fails to load when it did not.
	 */
	async function writeBinPlugin(dir: string, name: string, manifest: Record<string, unknown>): Promise<void> {
		await fs.mkdir(path.join(dir, "bin"), { recursive: true });
		const probe = path.join(dir, "bin", `${name}-probe`);
		await Bun.write(probe, `#!/bin/sh\necho "${name} ran"\n`);
		await fs.chmod(probe, 0o755);
		const runProbe = `const run = Bun.spawnSync(["/bin/sh", "-c", ${JSON.stringify(`${name}-probe`)}], { env: { PATH: process.env.PATH } });
globalThis[${JSON.stringify(`__ompBinProbe_${name}`)}] = run.stdout.toString();
if (run.exitCode !== 0) throw new Error(${JSON.stringify(`${name}-probe is not on PATH when the module evaluates`)});
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

	async function declare(dependencies: string[], linked: string[] = [], plugins: string = pluginsDir): Promise<void> {
		await writeJson(path.join(plugins, "package.json"), {
			dependencies: Object.fromEntries(dependencies.map(name => [name, "1.0.0"])),
		});
		if (linked.length > 0) {
			await writeJson(path.join(plugins, "omp-plugins.lock.json"), {
				plugins: Object.fromEntries(
					linked.map(name => [name, { version: "1.0.0", enabled: true, enabledFeatures: null }]),
				),
				settings: {},
			});
		}
	}

	const binOf = (name: string) => path.join(pluginsDir, "node_modules", name, "bin");

	/**
	 * Install one plugin the way a versioned deployment does:
	 * `~/.omp/plugins -> <root>/deploy/current/plugins`, `current -> v1`. The
	 * plugin's `bin/` also holds `<name>-fresh`, a second command a case can
	 * leave unrun. Returns the realpath of the plugin's `bin/`, the entry a
	 * module building its PATH from `import.meta.url` would add.
	 */
	async function deploy(name: string, manifest: Record<string, unknown>): Promise<string> {
		const deployDir = path.join(root, "deploy");
		await fs.rm(deployDir, { recursive: true, force: true });
		const v1Plugins = path.join(deployDir, "v1", "plugins");
		const pluginDir = path.join(v1Plugins, "node_modules", name);
		await writeBinPlugin(pluginDir, name, manifest);
		const fresh = path.join(pluginDir, "bin", `${name}-fresh`);
		await Bun.write(fresh, `#!/bin/sh\necho "${name} ran"\n`);
		await fs.chmod(fresh, 0o755);
		await declare([name], [], v1Plugins);
		await fs.symlink("v1", path.join(deployDir, "current"));
		await fs.rm(pluginsDir, { force: true });
		await fs.symlink(path.join(deployDir, "current", "plugins"), pluginsDir);
		return path.join(pluginDir, "bin");
	}

	/** Publish v2 the way a versioned deployment does: copy, re-point `current`, remove v1. */
	async function moveDeployment(): Promise<void> {
		const deployDir = path.join(root, "deploy");
		await fs.cp(path.join(deployDir, "v1"), path.join(deployDir, "v2"), { recursive: true });
		await fs.symlink("v2", path.join(deployDir, "current.next"));
		await fs.rename(path.join(deployDir, "current.next"), path.join(deployDir, "current"));
		await fs.rm(path.join(deployDir, "v1"), { recursive: true });
	}

	/** In one session started with `PATH`: run the probe, move the deployment, then try each command. */
	async function rotationOutcome(name: string, PATH: string): Promise<RotationOutcome> {
		const session = await startRpcSession(PATH);
		try {
			const runs = async (command: string) => {
				const { output, exitCode } = await session.bash(command);
				return exitCode === 0 && output.trim() === `${name} ran`;
			};
			const ranBefore = await runs(`${name}-probe`);
			await moveDeployment();
			return {
				ranBefore,
				afterMove: await runs(`${name}-probe`),
				neverRun: await runs(`${name}-fresh`),
				afterHashReset: await runs(`hash -r; ${name}-probe`),
			};
		} finally {
			await session.close();
		}
	}

	test("a session's shell runs a command from the plugin's manifest `bin` directory, before and after the plugins root moves", async () => {
		const installedBin = binOf("rotating");
		await deploy("rotating", { extensions: ["ext.js"] });

		const session = await startRpcSession(BASE_PATH);
		try {
			const before = await session.bash("rotating-probe");
			const shellPath = (await session.bash('printf "%s" "$PATH"')).output;
			await moveDeployment();
			const after = await session.bash("rotating-probe");

			expect(before).toMatchObject({ output: "rotating ran\n", exitCode: 0 });
			expect(shellPath.split(path.delimiter)[0]).toBe(installedBin);
			expect(after).toMatchObject({ output: "rotating ran\n", exitCode: 0 });
		} finally {
			await session.close();
		}
	});

	test("a manifest `bin` given as one string is one directory", async () => {
		await writeBinPlugin(path.join(pluginsDir, "node_modules", "single"), "single", {
			bin: "bin",
			extensions: ["ext.js"],
		});
		await declare(["single"]);

		const result = await run({ route: "session" });

		expect(result.errors).toEqual([]);
		expect(result.PATH).toBe([binOf("single"), BASE_PATH].join(path.delimiter));
	});

	test("a PATH entry that goes stale on its own loses the command whether or not the shell ran it, and the installed path omp adds keeps both", async () => {
		// What a process started by a session whose plugin put its realpath on
		// PATH inherits; the plugin itself declares no `bin`.
		const realBin = await deploy("stale", { bin: [] });
		const staleAlone = await rotationOutcome("stale", [realBin, BASE_PATH].join(path.delimiter));

		// The same inherited PATH, with the plugin declaring its `bin`.
		await deploy("stale", {});
		const withInstalled = await rotationOutcome("stale", [realBin, BASE_PATH].join(path.delimiter));

		expect(staleAlone).toEqual({ ranBefore: true, afterMove: false, neverRun: false, afterHashReset: false });
		expect(withInstalled).toEqual({ ranBefore: true, afterMove: true, neverRun: true, afterHashReset: true });
	});

	test("with a valid entry later on PATH the shell's command hash decides and `hash -r` recovers; omp's installed path goes ahead of the stale one", async () => {
		const installedBin = binOf("later");
		const realBin = await deploy("later", { bin: [] });
		const validLater = await rotationOutcome("later", [realBin, installedBin, BASE_PATH].join(path.delimiter));

		// The plugin declares its `bin`; one session inherits only the realpath
		// entry, one inherits the realpath entry ahead of the installed path.
		await deploy("later", {});
		const staleInherited = await rotationOutcome("later", [realBin, BASE_PATH].join(path.delimiter));
		await deploy("later", {});
		const bothInherited = await rotationOutcome("later", [realBin, installedBin, BASE_PATH].join(path.delimiter));

		expect(validLater).toEqual({ ranBefore: true, afterMove: false, neverRun: true, afterHashReset: true });
		expect(staleInherited).toEqual({ ranBefore: true, afterMove: true, neverRun: true, afterHashReset: true });
		expect(bothInherited).toEqual({ ranBefore: true, afterMove: true, neverRun: true, afterHashReset: true });
	});

	test("a plugin tool module finds the plugin's command on PATH when it evaluates, and loads", async () => {
		const realPlugins = path.join(root, "deploy", "v1", "plugins");
		await writeBinPlugin(path.join(realPlugins, "node_modules", "tooling"), "tooling", { tools: "tool.js" });
		await writeJson(path.join(realPlugins, "package.json"), { dependencies: { tooling: "1.0.0" } });
		await fs.symlink(realPlugins, pluginsDir);

		const result = await run({ route: "tools" });

		expect(result.toolErrors).toEqual([]);
		expect(result.tools).toEqual(["tooling_probe"]);
		expect(result.probes).toEqual({ tooling: "tooling ran\n" });
		expect(result.PATH).toBe([binOf("tooling"), BASE_PATH].join(path.delimiter));
	});

	test("an SDK session imports a plugin's tool with the plugin's command on PATH, and its shell runs the command", async () => {
		// Tools only: no extension discovery runs ahead of the tool import.
		await writeBinPlugin(path.join(pluginsDir, "node_modules", "sdktool"), "sdktool", { tools: "tool.js" });
		await declare(["sdktool"]);

		const result = await run({ route: "sdk", commands: ["sdktool-probe"] });

		expect(result.tools).toContain("sdktool_probe");
		expect(result.probes).toEqual({ sdktool: "sdktool ran\n" });
		expect(result.shell).toEqual([{ output: "sdktool ran\n", exitCode: 0 }]);
	});

	test("an SDK session imports a tool from a plugin's conventional `tools/` directory with the plugin's command on PATH", async () => {
		// The manifest names no tool: the module is found by the `tools/` scan alone.
		const pluginDir = path.join(pluginsDir, "node_modules", "convtool");
		await writeBinPlugin(pluginDir, "convtool", {});
		await fs.mkdir(path.join(pluginDir, "tools"), { recursive: true });
		await fs.rename(path.join(pluginDir, "tool.js"), path.join(pluginDir, "tools", "convtool.js"));
		await declare(["convtool"]);

		const result = await run({ route: "sdk", commands: ["convtool-probe"] });

		expect(result.tools).toContain("convtool_probe");
		expect(result.probes).toEqual({ convtool: "convtool ran\n" });
		expect(result.shell).toEqual([{ output: "convtool ran\n", exitCode: 0 }]);
	});

	test("an ACP session imports a plugin's tool with the plugin's command on PATH", async () => {
		await writeBinPlugin(path.join(pluginsDir, "node_modules", "acptool"), "acptool", { tools: "tool.js" });
		await declare(["acptool"]);

		const result = await run({ route: "acp" });

		expect(result.tools).toContain("acptool_probe");
		expect(result.probes).toEqual({ acptool: "acptool ran\n" });
	});

	test("an SDK caller passing both preload lists built by either selector gets the plugin's command before the modules import", async () => {
		await writeBinPlugin(path.join(pluginsDir, "node_modules", "preload"), "preload", {
			extensions: ["ext.js"],
			tools: "tool.js",
		});
		await declare(["preload"]);

		// One selector per process, so neither can supply the other's PATH entry.
		const extensions = await run({ route: "preloaded", selector: "extensions" });
		const tools = await run({ route: "preloaded", selector: "tools" });

		expect(extensions.selected).toEqual([path.join(pluginsDir, "node_modules", "preload", "ext.js")]);
		expect(extensions.errors).toEqual([]);
		expect(extensions.probes).toEqual({ preload: "preload ran\n" });
		expect(tools.selected).toEqual([path.join(pluginsDir, "node_modules", "preload", "tool.js")]);
		expect(tools.tools).toContain("preload_probe");
		expect(tools.probes).toEqual({ preload: "preload ran\n" });
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

	test("a subagent in another project gets its parent's plugins and adds none of its own project's", async () => {
		await writeBinPlugin(path.join(pluginsDir, "node_modules", "parentplug"), "parentplug", { tools: "tool.js" });
		await declare(["parentplug"]);
		// The child's project installs a plugin of its own.
		const childCwd = path.join(root, "child-project");
		const projectPlugins = path.join(childCwd, ".omp", "plugins");
		await writeBinPlugin(path.join(projectPlugins, "node_modules", "childplug"), "childplug", {
			extensions: ["ext.js"],
		});
		await declare(["childplug"], [], projectPlugins);

		const result = await run({ route: "subagent", childCwd, commands: ["parentplug-probe", "childplug-probe"] });

		expect(result.parentPATH).toBe([binOf("parentplug"), BASE_PATH].join(path.delimiter));
		expect(result.PATH).toBe(result.parentPATH);
		expect(result.tools).toContain("parentplug_probe");
		expect(result.probes).toEqual({ parentplug: "parentplug ran\n" });
		// The child's own shell: the parent's plugin command runs, the child project's does not.
		expect(result.shell[0]).toEqual({ output: "parentplug ran\n", exitCode: 0 });
		expect(result.shell[1]?.exitCode).toBe(127);
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
		// What a process started by an older session inherits: the realpath entry.
		const realBin = await deploy("gamma", { extensions: ["ext.js"] });

		const result = await run({ route: "session" }, [realBin, BASE_PATH].join(path.delimiter));
		await moveDeployment();
		const after = Bun.spawnSync(["/bin/sh", "-c", "gamma-probe"], { env: { PATH: result.PATH ?? "" } });

		expect(result.PATH).toBe([binOf("gamma"), realBin, BASE_PATH].join(path.delimiter));
		expect(after.stdout.toString()).toBe("gamma ran\n");
		expect(after.exitCode).toBe(0);
	});

	test("an installed bin directory already on PATH is not added again", async () => {
		await writeBinPlugin(path.join(pluginsDir, "node_modules", "delta"), "delta", { extensions: ["ext.js"] });
		await declare(["delta"]);

		const result = await run({ route: "twice" });

		expect(result.errors).toEqual([]);
		expect(result.probes).toEqual({ delta: "delta ran\n" });
		expect(result.PATH).toBe([binOf("delta"), BASE_PATH].join(path.delimiter));
	});

	test("a plugin command outranks the user's of the same name, unless the user lists the installed path behind their own directory", async () => {
		await writeBinPlugin(path.join(pluginsDir, "node_modules", "order"), "order", { extensions: ["ext.js"] });
		await declare(["order"]);
		// The user's own `order-probe`, in a directory already on PATH.
		const userBin = path.join(root, "userbin");
		await fs.mkdir(userBin, { recursive: true });
		await Bun.write(path.join(userBin, "order-probe"), '#!/bin/sh\necho "user ran"\n');
		await fs.chmod(path.join(userBin, "order-probe"), 0o755);

		const userFirst = [userBin, BASE_PATH].join(path.delimiter);
		const pluginWins = await run({ route: "session" }, userFirst);
		const listed = [userBin, binOf("order"), BASE_PATH].join(path.delimiter);
		const userWins = await run({ route: "session" }, listed);

		expect(pluginWins.probes).toEqual({ order: "order ran\n" });
		expect(pluginWins.PATH).toBe([binOf("order"), userFirst].join(path.delimiter));
		expect(userWins.probes).toEqual({ order: "user ran\n" });
		expect(userWins.PATH).toBe(listed);
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
		await writeBinPlugin(path.join(pluginsDir, "node_modules", "zeta"), "zeta", { extensions: ["ext.js"] });
		await declare(["zeta"]);
		const bin = binOf("zeta");
		const d = path.delimiter;

		// Each row: the inherited PATH, the PATH omp leaves, and what the plugin's command printed at import.
		const outcomes: Array<[string | undefined, string | null, string | undefined]> = [];
		for (const inherited of ["", `${d}/usr/bin${d}`, undefined]) {
			const result = await run({ route: "session", unsetPath: inherited === undefined }, inherited ?? BASE_PATH);
			outcomes.push([inherited, result.PATH, result.probes.zeta]);
		}

		expect(outcomes).toEqual([
			["", `${bin}${d}`, "zeta ran\n"],
			[`${d}/usr/bin${d}`, `${bin}${d}${d}/usr/bin${d}`, "zeta ran\n"],
			[undefined, bin, "zeta ran\n"],
		]);
	});

	test("an explicit-only session adds the directories of the plugins whose tools it loads, and no other plugin's", async () => {
		await writeBinPlugin(path.join(pluginsDir, "node_modules", "ambient"), "ambient", { extensions: ["ext.js"] });
		// `--no-extensions` still loads installed plugins' tools.
		await writeBinPlugin(path.join(pluginsDir, "node_modules", "ambienttool"), "ambienttool", { tools: "tool.js" });
		await declare(["ambient", "ambienttool"]);
		const explicit = path.join(root, "explicit.js");
		await Bun.write(explicit, "export default function () {}\n");

		const result = await run({
			route: "explicitSession",
			explicitPath: explicit,
			commands: ["ambienttool-probe", "ambient-probe"],
		});

		expect(result.extensions).toEqual([explicit]);
		expect(result.errors).toEqual([]);
		expect(result.tools).toContain("ambienttool_probe");
		expect(result.probes).toEqual({ ambienttool: "ambienttool ran\n" });
		expect(result.PATH).toBe([binOf("ambienttool"), BASE_PATH].join(path.delimiter));
		// The session's shell: the tool plugin's command runs, the extension-only plugin's does not.
		expect(result.shell[0]).toEqual({ output: "ambienttool ran\n", exitCode: 0 });
		expect(result.shell[1]?.exitCode).toBe(127);
	});

	test("a case leaves the process that runs it with its PATH, and with the agent directory it had before a profile", async () => {
		await writeBinPlugin(path.join(pluginsDir, "node_modules", "isolated"), "isolated", { extensions: ["ext.js"] });
		await declare(["isolated"]);
		// A test process that started with an agent directory of its own and has
		// a named profile active when it runs the case.
		const priorAgentDir = path.join(root, "prior-agent");

		const result = await run(
			{ route: "isolation", inner: { route: "session" }, commands: ["isolated-probe"] },
			BASE_PATH,
			{
				PI_CODING_AGENT_DIR: priorAgentDir,
			},
		);

		expect(result.inner?.probes).toEqual({ isolated: "isolated ran\n" });
		expect(result.inner?.PATH).toBe([binOf("isolated"), BASE_PATH].join(path.delimiter));
		// The calling process: the case's command is not on its PATH, and its agent directory is its own.
		expect(result.shell).toEqual([{ output: "", exitCode: 127 }]);
		expect(result.PATH).toBe(BASE_PATH);
		expect(result.agentDir).toBe(priorAgentDir);
	});
});
