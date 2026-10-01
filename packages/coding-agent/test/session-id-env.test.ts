import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgShellPath } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAcpSessionFactory } from "@oh-my-pi/pi-coding-agent/main";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { publishProcessSessionId, SESSION_ID_ENV } from "@oh-my-pi/pi-coding-agent/session/session-env";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type {
	ClientBridge,
	ClientBridgeCreateTerminalParams,
	ClientBridgeTerminalHandle,
} from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

/** Force a deterministic non-interactive shell instead of the developer's rc. */
function usePlainShell(tempDir: TempDir): void {
	const shell = process.platform === "win32" ? (Bun.env.ComSpec ?? "cmd.exe") : "/bin/sh";
	cfgShellPath.set(Settings.instance, shell);
	vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
		shell,
		args: process.platform === "win32" ? ["/c"] : ["-c"],
		env: { PATH: Bun.env.PATH ?? "", HOME: tempDir.path(), SHELL: shell },
		prefix: undefined,
	});
}

describe("OMP_SESSION_ID in the system prompt", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-id-prompt-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-id-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
		delete process.env[SESSION_ID_ENV];
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	async function render(options: BuildSystemPromptOptions): Promise<string> {
		const built = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir },
			...options,
		});
		return built.systemPrompt.join("\n\n");
	}

	it("names the session's own id in the workstation block", async () => {
		const prompt = await render({ sessionId: "session-under-test" });
		expect(prompt).toContain("<workstation>");
		expect(prompt).toContain("Session: session-under-test");
	});

	// A published process value names somebody else's session (or an outer omp run
	// whose shell this is), and the model acts on the id it sees — resuming or
	// stamping a session that is not its own. Never render it without our own id.
	it("omits the session line when no session id is known", async () => {
		process.env[SESSION_ID_ENV] = "somebody-elses-session";
		try {
			const prompt = await render({});
			expect(prompt).toContain("<workstation>");
			expect(prompt).not.toContain("Session: ");
		} finally {
			delete process.env[SESSION_ID_ENV];
		}
	});
});

describe("OMP_SESSION_ID for spawned sessions", () => {
	let tempDir = "";
	let authDir = "";
	let modelRegistry: ModelRegistry;
	let sessions: AgentSession[] = [];
	let originalSessionId: string | undefined;

	/** Cheap session options: the two startup scans and MCP/LSP are irrelevant here. */
	function baseOptions(model: Model): CreateAgentSessionOptions {
		return {
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		};
	}

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-id-sdk-"));
		authDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-id-sdk-auth-"));
		originalSessionId = process.env[SESSION_ID_ENV];
		delete process.env[SESSION_ID_ENV];
		modelRegistry = new ModelRegistry(await discoverAuthStorage(authDir));
		sessions = [];
	});

	afterEach(async () => {
		await Promise.all(sessions.map(session => session.dispose()));
		if (originalSessionId === undefined) delete process.env[SESSION_ID_ENV];
		else process.env[SESSION_ID_ENV] = originalSessionId;
		fs.rmSync(tempDir, { recursive: true, force: true });
		fs.rmSync(authDir, { recursive: true, force: true });
		resetSettingsForTest();
	});

	it("publishes the owning session's id and gives a spawned session its own", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const owner = (await createAgentSession({ ...baseOptions(model), publishSessionIdEnv: true })).session;
		sessions.push(owner);
		expect(process.env[SESSION_ID_ENV]).toBe(owner.sessionId);
		expect(owner.systemPrompt.join("\n\n")).toContain(`Session: ${owner.sessionId}`);

		// A subagent shares `process.env` with its parent, so it must advertise (and
		// hand its own child processes) ITS id without repointing the shared value.
		const child = (await createAgentSession({ ...baseOptions(model), taskDepth: 1, parentTaskPrefix: "child" }))
			.session;
		sessions.push(child);
		expect(child.sessionId).not.toBe(owner.sessionId);
		expect(child.systemPrompt.join("\n\n")).toContain(`Session: ${child.sessionId}`);
		expect(process.env[SESSION_ID_ENV]).toBe(owner.sessionId);

		// A session nobody designated leaves the published value alone too.
		const sibling = (await createAgentSession(baseOptions(model))).session;
		sessions.push(sibling);
		expect(process.env[SESSION_ID_ENV]).toBe(owner.sessionId);
	});
});

describe("OMP_SESSION_ID in child shells", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let sessions: AgentSession[] = [];
	let originalSessionId: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@omp-session-id-env-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		sessions = [];
		originalSessionId = process.env[SESSION_ID_ENV];
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(sessions.map(session => session.dispose()));
		authStorage.close();
		tempDir.removeSync();
		if (originalSessionId === undefined) delete process.env[SESSION_ID_ENV];
		else process.env[SESSION_ID_ENV] = originalSessionId;
		resetSettingsForTest();
	});

	function createSession(): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
		sessions.push(session);
		return session;
	}

	it("carries the id of the session that ran the command, not the process one", async () => {
		usePlainShell(tempDir);
		// The process-wide value names a different session than either shell ran in.
		process.env[SESSION_ID_ENV] = "process-owned-session";
		const first = createSession();
		const second = createSession();
		expect(first.sessionId).not.toBe(second.sessionId);

		const read = async (session: AgentSession): Promise<string> => {
			const result = await session.executeBash(`printf "%s" "$${SESSION_ID_ENV}"`, undefined, {
				useUserShell: true,
			});
			return result.output.trim();
		};

		expect(await read(first)).toBe(first.sessionId);
		expect(await read(second)).toBe(second.sessionId);
	});

	it("carries the spawning session's id through every bash tool backend", async () => {
		usePlainShell(tempDir);
		// What the running CLI published: the child's shells must not inherit it.
		const owner = createSession();
		const child = createSession();
		publishProcessSessionId(owner.sessionId);
		expect(process.env[SESSION_ID_ENV]).toBe(owner.sessionId);

		const manager = new AsyncJobManager({});
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-1",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: "", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const createTerminal = vi.fn<(params: ClientBridgeCreateTerminalParams) => Promise<ClientBridgeTerminalHandle>>(
			async () => handle,
		);
		const makeToolSession = (clientBridge?: ClientBridge): ToolSession =>
			({
				cwd: tempDir.path(),
				hasUI: false,
				skills: [],
				settings: Settings.isolated({
					"async.enabled": true,
					"bash.autoBackground.enabled": false,
					"bashInterceptor.enabled": false,
				}),
				getSessionId: () => child.sessionId,
				getSessionFile: () => null,
				asyncJobManager: manager,
				...(clientBridge ? { getClientBridge: () => clientBridge } : {}),
			}) as unknown as ToolSession;
		const tool = new BashTool(makeToolSession());
		const outFile = path.join(tempDir.path(), "async-id.txt");
		const readId = `printf "%s" "$${SESSION_ID_ENV}"`;

		// Foreground execution reads the overlay from its own session, not the shell
		// it inherited.
		const foreground = await tool.execute("call-sync", { command: readId, cwd: tempDir.path() });
		const foregroundText = foreground.content.find(block => block.type === "text")?.text ?? "";
		expect(foregroundText).toContain(child.sessionId);
		expect(foregroundText).not.toContain(owner.sessionId);

		// An async job outlives the call that started it and runs on the job's own
		// signal, so it has to re-apply the overlay itself.
		await tool.execute("call-async", {
			command: `${readId} > "${outFile}"`,
			cwd: tempDir.path(),
			async: true,
		});
		await manager.waitForAll();
		expect(await Bun.file(outFile).text()).toBe(child.sessionId);

		// The client-terminal backend bypasses `executeBash` and takes its env from
		// the shared direnv preflight overlay, so that overlay carries the id too.
		const terminalTool = new BashTool(
			makeToolSession({ capabilities: { terminal: true }, createTerminal } as unknown as ClientBridge),
		);
		await terminalTool.execute("call-terminal", { command: readId, cwd: tempDir.path() });
		const terminalEnv = Object.fromEntries(
			(createTerminal.mock.calls[0]?.[0].env ?? []).map(({ name, value }) => [name, value]),
		);
		expect(terminalEnv[SESSION_ID_ENV]).toBe(child.sessionId);
	});
});

describe("OMP_SESSION_ID across ACP sessions", () => {
	let tempDir = "";
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessions: AgentSession[] = [];
	let originalSessionId: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-id-acp-"));
		originalSessionId = process.env[SESSION_ID_ENV];
		delete process.env[SESSION_ID_ENV];
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessions = [];
	});

	afterEach(async () => {
		await Promise.all(sessions.map(session => session.dispose()));
		authStorage.close();
		if (originalSessionId === undefined) delete process.env[SESSION_ID_ENV];
		else process.env[SESSION_ID_ENV] = originalSessionId;
		fs.rmSync(tempDir, { recursive: true, force: true });
		resetSettingsForTest();
	});

	it("lets the first session own the process value without later sessions repointing it", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		// ACP mode creates every session through this factory, so the process value can
		// only be claimed once: `session/new` #2 must not repoint what #1's child
		// processes (hooks, MCP servers, LSP servers) already read.
		const factory = createAcpSessionFactory({
			baseOptions: {
				cwd: tempDir,
				agentDir: tempDir,
				modelRegistry,
				settings: Settings.isolated(),
				model,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				rules: [],
				workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
				publishSessionIdEnv: true,
			},
			settings: Settings.isolated(),
			sessionDir: path.join(tempDir, "sessions"),
			authStorage,
			modelRegistry,
			parsedArgs: { invalidFlagValues: [] },
			rawArgs: [],
			createSession: options => createAgentSession(options),
		});

		const first = (await factory(tempDir)).session;
		sessions.push(first);
		expect(process.env[SESSION_ID_ENV]).toBe(first.sessionId);

		const second = (await factory(tempDir)).session;
		sessions.push(second);
		expect(second.sessionId).not.toBe(first.sessionId);
		expect(process.env[SESSION_ID_ENV]).toBe(first.sessionId);
		// The later session is not ignored, only demoted from the process slot: it
		// still advertises and hands its own children ITS id.
		expect(second.systemPrompt.join("\n\n")).toContain(`Session: ${second.sessionId}`);
	});
});
