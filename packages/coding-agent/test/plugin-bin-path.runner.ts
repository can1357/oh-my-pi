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
import { createAcpSessionFactory } from "@oh-my-pi/pi-coding-agent/main";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getAgentDir, getPluginsDir, setProfile } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { runCase } from "./plugin-bin-path.harness";

export interface RunnerScenario {
	route:
		| "session"
		| "twice"
		| "tools"
		| "install"
		| "sdk"
		| "acp"
		| "preloaded"
		| "explicitSession"
		| "subagent"
		| "isolation";
	cwd: string;
	/** `explicitSession`: the one extension file to load. */
	explicitPath?: string;
	/** `install`: the package directory `bun install` would place under node_modules. */
	installSource?: string;
	installName?: string;
	/** `preloaded`: the one selector the SDK caller builds its preload lists with. */
	selector?: "extensions" | "tools";
	/** `subagent`: the child session's cwd. */
	childCwd?: string;
	/** `sdk`, `explicitSession`, `subagent` (the child): commands to run, in order, through the session's own shell. `isolation`: through `/bin/sh` in this process, after the inner case. */
	commands?: string[];
	/** `isolation`: the case this process runs through `runCase`, in its own cwd. */
	inner?: Omit<RunnerScenario, "cwd">;
	/** Remove PATH from this process before the route runs (Bun gives a process started without one a default). */
	unsetPath?: boolean;
}

export interface RunnerResult {
	PATH: string | null;
	/** `subagent`: PATH once the parent session exists, before the child is created. */
	parentPATH: string | null;
	pluginsDir: string;
	agentDir: string;
	extensions: string[];
	errors: string[];
	tools: string[];
	toolErrors: string[];
	selected: string[];
	probes: Record<string, string>;
	shell: Array<{ output: string; exitCode: number | undefined }>;
	/** `isolation`: what the inner case reported. */
	inner: RunnerResult | null;
}

/** A session as the SDK builds one by default, without the subsystems no case reads. */
function createSession(cwd: string, options: Partial<CreateAgentSessionOptions> = {}) {
	return createAgentSession({
		cwd,
		sessionManager: SessionManager.inMemory(),
		authStorage: createInMemoryAuthStorage(),
		enableLsp: false,
		enableMCP: false,
		skipPythonPreflight: true,
		...options,
	});
}

/** Run each command through the session's own shell, as `!` and the RPC `bash` command do. */
async function runInSessionShell(session: AgentSession, commands: readonly string[] = []) {
	const outcomes: RunnerResult["shell"] = [];
	for (const command of commands) {
		const { output, exitCode } = await session.executeBash(command);
		outcomes.push({ output, exitCode });
	}
	return outcomes;
}

async function runRoute(scenario: RunnerScenario): Promise<RunnerResult> {
	const result: RunnerResult = {
		PATH: null,
		parentPATH: null,
		pluginsDir: getPluginsDir(),
		agentDir: "",
		extensions: [],
		errors: [],
		tools: [],
		toolErrors: [],
		selected: [],
		probes: {},
		shell: [],
		inner: null,
	};
	const sessions: AgentSession[] = [];

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
		case "tools": {
			const loaded = await loadCustomTools(await discoverCustomToolPaths([], scenario.cwd), scenario.cwd, []);
			result.tools = loaded.tools.map(tool => tool.tool.name);
			result.toolErrors = loaded.errors.map(error => error.error);
			break;
		}
		case "sdk": {
			// createAgentSession with no preloads: the route the SDK and the CLI's
			// one-shot modes take, which imports custom tools before it discovers
			// extensions.
			const { session, extensionsResult } = await createSession(scenario.cwd);
			sessions.push(session);
			result.tools = session.getAllToolNames();
			result.errors = extensionsResult.errors.map(error => error.error);
			result.shell = await runInSessionShell(session, scenario.commands);
			break;
		}
		case "acp": {
			// What `omp --mode acp` does on `session/new`.
			const settings = await Settings.init({ cwd: scenario.cwd });
			const authStorage = createInMemoryAuthStorage();
			const createAcpSession = createAcpSessionFactory({
				baseOptions: { enableLsp: false, skipPythonPreflight: true },
				settings,
				authStorage,
				modelRegistry: new ModelRegistry(authStorage),
				parsedArgs: { invalidFlagValues: [] },
				rawArgs: [],
				createSession: createAgentSession,
			});
			const created = await createAcpSession(scenario.cwd);
			const session = "session" in created ? created.session : created;
			sessions.push(session);
			result.tools = session.getAllToolNames();
			break;
		}
		case "preloaded": {
			// An SDK caller that selects the installed plugins itself and passes
			// both preload lists, so the session discovers nothing. One selector
			// per process: the other list is empty.
			const extensionPaths =
				scenario.selector === "extensions" ? await getAllPluginExtensionPaths(scenario.cwd) : [];
			const toolPaths = scenario.selector === "tools" ? await getAllPluginToolPaths(scenario.cwd) : [];
			result.selected = [...extensionPaths, ...toolPaths];
			const { session, extensionsResult } = await createSession(scenario.cwd, {
				preloadedExtensionPaths: extensionPaths,
				preloadedCustomToolPaths: toolPaths.map(toolPath => ({ path: toolPath })),
			});
			sessions.push(session);
			result.tools = session.getAllToolNames();
			result.errors = extensionsResult.errors.map(error => error.error);
			break;
		}
		case "explicitSession": {
			// `omp --no-extensions -e <file>`.
			const { session, extensionsResult } = await createSession(scenario.cwd, {
				disableExtensionDiscovery: true,
				additionalExtensionPaths: [scenario.explicitPath ?? ""],
			});
			sessions.push(session);
			// Leave out the session's own inline extensions (`<inline-N>`): none is loaded from a path.
			result.extensions = extensionsResult.extensions
				.map(extension => extension.path)
				.filter(extensionPath => !extensionPath.startsWith("<inline"));
			result.errors = extensionsResult.errors.map(error => error.error);
			result.tools = session.getAllToolNames();
			result.shell = await runInSessionShell(session, scenario.commands);
			break;
		}
		case "subagent": {
			// The parent selects its cwd's plugins; a subagent working in another
			// cwd gets the parent's selection (task/executor.ts forwards these three
			// fields) and must not select its own cwd's plugins.
			const parent = await createSession(scenario.cwd);
			sessions.push(parent.session);
			result.parentPATH = process.env.PATH ?? null;
			const childCwd = scenario.childCwd ?? scenario.cwd;
			const child = await createSession(childCwd, {
				preloadedExtensionPaths: [...(parent.session.extensionPaths ?? [])],
				preloadedPreparedExtensions: parent.session.preparedExtensions,
				// The parent session's `customToolPaths`: what its tool discovery returned.
				preloadedCustomToolPaths: await discoverCustomToolPaths([], scenario.cwd),
			});
			sessions.push(child.session);
			result.tools = child.session.getAllToolNames();
			result.errors = child.extensionsResult.errors.map(error => error.error);
			result.shell = await runInSessionShell(child.session, scenario.commands);
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
		case "isolation": {
			// A process with directory and profile state of its own (its agent
			// directory from the environment, then a named profile) runs a case the
			// way the test file does, then leaves the profile: the agent directory it
			// started with comes back only if the case left its state alone.
			setProfile("plugin-bin-path");
			result.inner = await runCase(
				{ ...(scenario.inner ?? { route: "session" }), cwd: scenario.cwd },
				{ HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "", PATH: process.env.PATH ?? "" },
			);
			setProfile(undefined);
			for (const command of scenario.commands ?? []) {
				const run = Bun.spawnSync(["/bin/sh", "-c", command], { env: { PATH: process.env.PATH } });
				result.shell.push({ output: run.stdout.toString(), exitCode: run.exitCode });
			}
			break;
		}
	}

	result.PATH = process.env.PATH ?? null;
	result.agentDir = getAgentDir();
	for (const [key, value] of Object.entries(globalThis)) {
		if (key.startsWith("__ompBinProbe_") && typeof value === "string") result.probes[key.slice(14)] = value;
	}
	for (const session of sessions.reverse()) await session.dispose();
	return result;
}

const result = await runRoute(JSON.parse(process.argv[2] ?? "{}") as RunnerScenario);
await Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`);
// A disposed session can leave timers behind; the result is written.
process.exit(0);
