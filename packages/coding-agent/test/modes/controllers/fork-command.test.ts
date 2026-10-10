import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { classifyTerminalMultiplexer, type TerminalMultiplexer } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Settings } from "../../../src/config/settings";
import {
	createTerminalLauncher,
	terminalLaunchCapabilities,
	type TerminalLaunchMultiplexer,
	type TerminalLaunchPlacement,
	type TerminalLaunchRequest,
	type TerminalLaunchResult,
} from "../../../src/subprocess/terminal-launch";

let tempDirectory: string;
let sourceSessionFile: string;

beforeEach(async () => {
	tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fork-command-"));
	sourceSessionFile = path.join(tempDirectory, "current-session.jsonl");
	await Bun.write(sourceSessionFile, '{"type":"session"}\n');
});

afterEach(async () => {
	await fs.rm(tempDirectory, { recursive: true, force: true });
});

function createContext(
	options: {
		streaming?: boolean;
		confirmed?: boolean;
		sessionFile?: string;
		persisted?: boolean;
		environment?: () => NodeJS.ProcessEnv;
		classifyTerminalMultiplexer?: typeof classifyTerminalMultiplexer;
		activeProfile?: string | null;
		activeModel?: { provider: string; id: string };
		agentDir?: string;
		configFiles?: readonly string[];
		settings?: Pick<Settings, "getAgentDir" | "getConfigFiles">;
		cwd?: string;
		thinkingLevel?: ConfiguredThinkingLevel;
		argv?: string[];
		promptCacheKey?: string;
		launchWarning?: string;
	} = {},
) {
	const sessionFile = options.persisted === false ? undefined : (options.sessionFile ?? sourceSessionFile);
	const session = {
		isStreaming: options.streaming ?? false,
		fork: vi.fn(async () => true),
		sessionFile,
		sessionId: "parent-session-id",
		agent: { promptCacheKey: options.promptCacheKey },
		model: options.activeModel ?? { provider: "provider", id: "model" },
		configuredThinkingLevel: () => options.thinkingLevel,
	};
	const flush = vi.fn(async () => undefined);
	const sessionManager = {
		getCwd: vi.fn(() => options.cwd ?? "/workspace/project"),
		getSessionFile: vi.fn(() => sessionFile),
		flush,
	};
	const launchTerminal = vi.fn(async (request: TerminalLaunchRequest): Promise<TerminalLaunchResult> => ({
		multiplexer: request.multiplexer,
		placement: request.placement,
		...(options.launchWarning ? { warning: options.launchWarning } : {}),
	}));
	const showError = vi.fn();
	const showHookConfirm = vi.fn(async () => options.confirmed ?? false);
	const ctx = {
		session,
		sessionManager,
		settings: options.settings ?? {
			getAgentDir: () => options.agentDir ?? "/user/agent",
			getConfigFiles: () => options.configFiles ?? [],
		},
		loadingAnimation: undefined,
		statusContainer: { disposeChildren: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
		present: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError,
		showHookConfirm,
	} as unknown as InteractiveModeContext;
	const controller = new CommandController(ctx, {
		classifyTerminalMultiplexer: options.classifyTerminalMultiplexer ?? classifyTerminalMultiplexer,
		environment: options.environment ?? (() => ({ TMUX: "server,1,0", TMUX_PANE: "%1" })),
		launchTerminal,
		resolveCliEntryCmd: () => ["omp-entry"],
		getActiveProfile: () =>
			options.activeProfile === null ? undefined : (options.activeProfile ?? "active-profile"),
		argv: () => options.argv ?? ["--model", "provider/model", "prompt text"],
	});
	return { controller, ctx, session, sessionManager, flush, launchTerminal, showError, showHookConfirm };
}

function findPosixShellPlacement(): { multiplexer: TerminalLaunchMultiplexer; placement: TerminalLaunchPlacement } {
	for (const [multiplexer, capabilities] of Object.entries(terminalLaunchCapabilities) as Array<
		[TerminalMultiplexer, (typeof terminalLaunchCapabilities)[TerminalMultiplexer]]
	>) {
		if (!capabilities.supported) continue;
		for (const placement of ["pane", "window"] as const) {
			const capability = capabilities[placement];
			if (capability && "shellGrammar" in capability && capability.shellGrammar === "posix") {
				return { multiplexer: multiplexer as TerminalLaunchMultiplexer, placement };
			}
		}
	}
	throw new Error("expected a launch placement that declares POSIX shell grammar");
}

const POSIX_SHELL_PLACEMENT = findPosixShellPlacement();

describe("/fork terminal placement", () => {
	it("preflights unavailable launch capabilities before busy or persistence checks", async () => {
		const unsupported = Object.entries(terminalLaunchCapabilities).find(
			([, capabilities]) => !capabilities.supported,
		)?.[0] as TerminalMultiplexer | undefined;
		if (!unsupported) throw new Error("expected an unsupported multiplexer");
		for (const multiplexer of [null, unsupported]) {
			const { controller, ctx, launchTerminal, flush } = createContext({
				classifyTerminalMultiplexer: () => multiplexer,
				streaming: true,
				persisted: false,
			});
			await controller.handleForkCommand("pane");
			expect(ctx.showError).toHaveBeenCalledTimes(1);
			expect(ctx.showHookConfirm).not.toHaveBeenCalled();
			expect(launchTerminal).not.toHaveBeenCalled();
			expect(flush).not.toHaveBeenCalled();
		}
	});

	it("requires POSIX shell confirmation before flushing a placement that declares it", async () => {
		const { controller, ctx, flush, launchTerminal } = createContext({
			classifyTerminalMultiplexer: () => POSIX_SHELL_PLACEMENT.multiplexer,
		});
		await controller.handleForkCommand(POSIX_SHELL_PLACEMENT.placement);
		expect(ctx.showHookConfirm).toHaveBeenCalledTimes(1);
		expect(flush).not.toHaveBeenCalled();
		expect(launchTerminal).not.toHaveBeenCalled();
	});

	it("launches a placement with POSIX shell requirements after confirmation", async () => {
		const { controller, flush, launchTerminal, showHookConfirm } = createContext({
			classifyTerminalMultiplexer: () => POSIX_SHELL_PLACEMENT.multiplexer,
			confirmed: true,
		});
		await controller.handleForkCommand(POSIX_SHELL_PLACEMENT.placement);
		expect(showHookConfirm).toHaveBeenCalledTimes(1);
		expect(showHookConfirm.mock.invocationCallOrder[0]).toBeLessThan(flush.mock.invocationCallOrder[0]!);
		expect(flush.mock.invocationCallOrder[0]).toBeLessThan(launchTerminal.mock.invocationCallOrder[0]!);
		expect(launchTerminal.mock.calls[0]?.[0]).toHaveProperty("shellGrammar", "posix");
	});

	it("flushes and launches an absolute persisted source with the active profile", async () => {
		const { controller, launchTerminal, flush, ctx, session } = createContext();
		await controller.handleForkCommand("pane");
		expect(ctx.showHookConfirm).not.toHaveBeenCalled();
		expect(flush.mock.invocationCallOrder[0]).toBeLessThan(launchTerminal.mock.invocationCallOrder[0]!);
		const request = launchTerminal.mock.calls[0]?.[0];
		expect(request).toMatchObject({ multiplexer: "tmux", placement: "pane" });
		const command = request?.command ?? [];
		expect(command[0]).toBe("env");
		expect(command).toContain("PI_CODING_AGENT_DIR=/user/agent");
		expect(command).toContain("OMP_PROFILE=active-profile");
		expect(command).toContain("PI_PROFILE=active-profile");
		expect(command.slice(command.indexOf("omp-entry") + 1)).toEqual([
			"--profile",
			"active-profile",
			"--model",
			"provider/model",
			"--prompt-cache-key",
			"parent-session-id",
			"--fork",
			path.resolve(sourceSessionFile),
		]);
		expect(ctx.showStatus).toHaveBeenCalledTimes(1);
		expect(session.fork).not.toHaveBeenCalled();
	});

	it("reports a launcher warning instead of claiming a visible placement", async () => {
		const { controller, ctx } = createContext({ launchWarning: "it started in the background." });
		await controller.handleForkCommand("pane");
		expect(ctx.showStatus).not.toHaveBeenCalled();
		expect(ctx.showWarning).toHaveBeenCalledTimes(1);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	it("drops a startup --goal and pins the parent's prompt-cache key over a startup one", async () => {
		const { controller, launchTerminal } = createContext({
			promptCacheKey: "pinned-parent-key",
			argv: ["--goal", "ship the release", "--prompt-cache-key", "startup-key", "--no-tools"],
		});
		await controller.handleForkCommand("pane");
		const command = launchTerminal.mock.calls[0]?.[0].command ?? [];
		const appArgs = command.slice(command.indexOf("omp-entry") + 1);
		expect(appArgs).toContain("--no-tools");
		expect(appArgs).not.toContain("--goal");
		expect(appArgs).not.toContain("ship the release");
		expect(appArgs).not.toContain("startup-key");
		expect(appArgs.filter(arg => arg === "--prompt-cache-key")).toHaveLength(1);
		expect(appArgs[appArgs.indexOf("--prompt-cache-key") + 1]).toBe("pinned-parent-key");
	});

	it("unsets scope variables the parent lacks instead of exporting them empty", async () => {
		const sessionsDir = path.join(tempDirectory, "env sessions");
		const { controller, launchTerminal } = createContext({
			activeProfile: null,
			environment: () =>
				({ TMUX: "server,1,0", TMUX_PANE: "%1", PI_CODING_AGENT_SESSION_DIR: sessionsDir }) as NodeJS.ProcessEnv,
		});
		await controller.handleForkCommand("pane");
		const command = launchTerminal.mock.calls[0]?.[0].command ?? [];
		const envArgs = command.slice(0, command.indexOf("omp-entry"));
		for (const name of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OMP_PROFILE", "PI_PROFILE"]) {
			expect(envArgs[envArgs.indexOf(name) - 1]).toBe("-u");
			expect(envArgs.some(arg => arg.startsWith(`${name}=`))).toBe(false);
		}
		expect(envArgs).toContain(`PI_CODING_AGENT_SESSION_DIR=${sessionsDir}`);
		// `env` rejects `-u` after the first assignment.
		const lastUnset = envArgs.lastIndexOf("-u");
		const firstAssignment = envArgs.findIndex(arg => arg.includes("="));
		expect(lastUnset).toBeLessThan(firstAssignment);
	});

	it("replaces stale profile and session-source arguments with current values", async () => {
		const { ctx, launchTerminal } = createContext();
		const controller = new CommandController(ctx, {
			environment: () => ({ ZELLIJ: "session" }),
			launchTerminal,
			resolveCliEntryCmd: () => ["omp-entry"],
			getActiveProfile: () => "active-profile",
			argv: () => ["--profile", "launch-profile", "--fork", "stale-source", "prompt"],
		});
		await controller.handleForkCommand("window");
		const request = launchTerminal.mock.calls[0]?.[0];
		expect(request?.multiplexer).toBe("zellij");
		expect(request?.placement).toBe("window");
		const command = request?.command ?? [];
		expect(command.filter(arg => arg === "--profile")).toHaveLength(1);
		expect(command).toContain("active-profile");
		expect(command).not.toContain("launch-profile");
		expect(command.slice(-2)).toEqual(["--fork", path.resolve(sourceSessionFile)]);
	});

	it("uses the active model and effective config environment instead of startup values", async () => {
		const agentDir = path.join(tempDirectory, "custom agent");
		const dataDir = path.join(tempDirectory, "xdg data");
		const stateDir = path.join(tempDirectory, "xdg state");
		const cacheDir = path.join(tempDirectory, "xdg cache");
		const configFiles = path.join(tempDirectory, "config files.yml");
		const { controller, launchTerminal } = createContext({
			activeProfile: null,
			agentDir,
			configFiles: [configFiles],
			activeModel: { provider: "current-provider", id: "model-b" },
			environment: () =>
				({
					TMUX: "server,1,0",
					TMUX_PANE: "%1",
					OMP_PROFILE: "stale-server-profile",
					PI_PROFILE: "stale-server-profile",
					PI_CODING_AGENT_DIR: "/stale/server/agent",
					PI_CONFIG_FILES: configFiles,
					XDG_DATA_HOME: dataDir,
					XDG_STATE_HOME: stateDir,
					XDG_CACHE_HOME: cacheDir,
				}) as NodeJS.ProcessEnv,
			argv: [
				"--provider",
				"old-provider",
				"--model",
				"old-provider/model-a",
				"--profile",
				"old-profile",
				"--fork",
				"stale-session",
				"prompt",
			],
		});

		await controller.handleForkCommand("pane");

		const command = launchTerminal.mock.calls[0]?.[0].command ?? [];
		expect(command).toContain(`PI_CODING_AGENT_DIR=${agentDir}`);
		expect(command).toContain(`PI_CONFIG_FILES=${configFiles}`);
		expect(command).toContain(`XDG_DATA_HOME=${dataDir}`);
		expect(command).toContain(`XDG_STATE_HOME=${stateDir}`);
		expect(command).toContain(`XDG_CACHE_HOME=${cacheDir}`);
		expect(command).not.toContain("/stale/server/agent");
		expect(command).not.toContain("stale-server-profile");
		expect(command).not.toContain("old-profile");

		const appArgs = command.slice(command.indexOf("omp-entry") + 1);
		const modelIndex = appArgs.indexOf("--model");
		expect(appArgs[modelIndex + 1]).toBe("current-provider/model-b");
		expect(appArgs).not.toContain("old-provider");
		expect(appArgs).not.toContain("old-provider/model-a");
		expect(command.slice(-2)).toEqual(["--fork", path.resolve(sourceSessionFile)]);
	});

	it("launches after a cwd move with the original overlay and configured thinking selector", async () => {
		const oldCwd = path.join(tempDirectory, "old project");
		const newCwd = path.join(tempDirectory, "new project");
		const agentDir = path.join(tempDirectory, "agent");
		const overlayPath = path.join(oldCwd, "overlay.yml");
		await fs.mkdir(oldCwd, { recursive: true });
		await fs.mkdir(newCwd, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(overlayPath, "defaultThinkingLevel: high\n");
		const settings = await Settings.loadReadOnly({
			cwd: oldCwd,
			agentDir,
			configFiles: ["./overlay.yml"],
		});
		await settings.reloadForCwd(newCwd);

		const staleConfigPath = path.join(tempDirectory, "stale server overlay.yml");
		const secret = "environment-secret-not-forwarded";
		const { controller, launchTerminal } = createContext({
			settings,
			cwd: newCwd,
			activeProfile: null,
			thinkingLevel: "auto",
			environment: () =>
				({
					TMUX: "server,1,0",
					TMUX_PANE: "%1",
					PI_CONFIG_FILES: staleConfigPath,
					OPENAI_API_KEY: secret,
				}) as NodeJS.ProcessEnv,
			argv: ["--cwd", oldCwd, "--config", "./stale-startup-overlay.yml", "--thinking", "low", "prompt"],
		});

		await controller.handleForkCommand("pane");

		const request = launchTerminal.mock.calls[0]?.[0];
		expect(request?.cwd).toBe(newCwd);
		const command = request?.command ?? [];
		const configFilesEnv = command.find(arg => arg.startsWith("PI_CONFIG_FILES="));
		expect(configFilesEnv?.slice("PI_CONFIG_FILES=".length).split(path.delimiter)).toContain(overlayPath);
		expect(configFilesEnv).not.toContain(staleConfigPath);
		expect(command.join("\0")).not.toContain(secret);

		const appArgs = command.slice(command.indexOf("omp-entry") + 1);
		expect(appArgs).not.toContain("--cwd");
		expect(appArgs).not.toContain(oldCwd);
		expect(appArgs).not.toContain("--config");
		expect(appArgs).not.toContain("./stale-startup-overlay.yml");
		expect(appArgs.filter(arg => arg === "--thinking")).toHaveLength(1);
		expect(appArgs[appArgs.indexOf("--thinking") + 1]).toBe("auto");
		expect(appArgs).not.toContain("low");
	});

	it("refuses to expose a startup API key in the multiplexer command", async () => {
		const secret = "do-not-include-this-key";
		const { controller, flush, launchTerminal, showError } = createContext({
			argv: ["--model", "provider/model", "--api-key", secret, "prompt"],
		});
		await controller.handleForkCommand("pane");
		const error = showError.mock.calls[0]?.[0];
		expect(error).toContain("--api-key");
		expect(error).not.toContain(secret);
		expect(flush).not.toHaveBeenCalled();
		expect(launchTerminal).not.toHaveBeenCalled();
	});

	it("rejects placement forks without a persisted transcript", async () => {
		const { controller, ctx, launchTerminal, flush } = createContext({ persisted: false });
		await controller.handleForkCommand("window");
		expect(ctx.showError).toHaveBeenCalledTimes(1);
		expect(flush).not.toHaveBeenCalled();
		expect(launchTerminal).not.toHaveBeenCalled();
	});

	it("confirms a busy fork and launches without touching the running parent when accepted", async () => {
		const { controller, ctx, flush, launchTerminal, session } = createContext({ streaming: true, confirmed: true });
		await controller.handleForkCommand("window");
		expect(ctx.showHookConfirm).toHaveBeenCalledTimes(1);
		expect(flush.mock.invocationCallOrder[0]).toBeLessThan(launchTerminal.mock.invocationCallOrder[0]!);
		expect(launchTerminal).toHaveBeenCalledTimes(1);
		expect(session.fork).not.toHaveBeenCalled();
	});

	it("does not flush or launch a busy fork when confirmation is declined", async () => {
		const { controller, ctx, launchTerminal, flush } = createContext({ streaming: true, confirmed: false });
		await controller.handleForkCommand("pane");
		expect(ctx.showHookConfirm).toHaveBeenCalledTimes(1);
		expect(flush).not.toHaveBeenCalled();
		expect(launchTerminal).not.toHaveBeenCalled();
	});

	it("shows a multiplexer capability error from the real launcher", async () => {
		const { ctx } = createContext();
		const environment = () => ({ TMUX: "server,1,0" });
		const controller = new CommandController(ctx, {
			environment,
			launchTerminal: createTerminalLauncher({ environment }),
			resolveCliEntryCmd: () => ["omp-entry"],
			getActiveProfile: () => undefined,
			argv: () => [],
		});
		await controller.handleForkCommand("pane");
		expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("TMUX_PANE"));
	});
});
