/**
 * The install-time tools-changed reconcile must be AWAITED before
 * `createAgentSession` hands the session back.
 *
 * A non-UI/SDK session runs MCP discovery long before its `AgentSession`
 * exists, so `setOnToolsChanged` installs late and reconciles against whatever
 * the manager currently holds. That reconcile calls
 * `session.refreshMCPTools()`, which rebinds the tool registry AND rebuilds the
 * system prompt — both asynchronous. Discarding its promise lets
 * `createAgentSession` return while the rebind is still in flight, so the very
 * first prompt goes out carrying the pre-recovery roster and the pre-recovery
 * system prompt. The listener firing is not the contract; the session being
 * reconciled by the time it is exposed is.
 *
 * Ordering is driven deterministically rather than by wall clock. An inline
 * extension factory binds inside `createAgentSession` AFTER the blocking MCP
 * discovery has installed the process-global manager and BEFORE the session's
 * `setOnToolsChanged` call, which is exactly the window a real empty-toolset
 * recovery lands in. Driving the heal from there with `refreshServerTools` —
 * the same re-list the recovery loop performs, with no listener installed —
 * reproduces the window with no sleeps and no reliance on the retry backoff.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { warmupToolName } from "./fixtures/warmup-empty-tools-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "warmup-empty-tools-mcp.ts");
const SERVER_NAME = "warmup";
const HEALED_TOOL_NAME = `mcp__${SERVER_NAME}_${warmupToolName(0)}`;
const HEALED_ROUTE = `xd://${HEALED_TOOL_NAME}`;

describe("MCP tools-changed install-time reconcile", () => {
	let tempDir: string;
	let listLog: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	// Discovery resolves user-level MCP config through the process-global agent
	// directory. Redirect both that path and os.homedir() so the session
	// connects only to the fixture and never spawns the developer's real MCP
	// servers.
	//
	// Held for ONE test, not for the describe block: `setAgentDir` rewrites the
	// shared resolver and `process.env.PI_CODING_AGENT_DIR`, so a block-scoped
	// override is visible to every other suite running in the same Bun process —
	// and points them at a directory this file deletes on teardown. Restoring
	// per test keeps the window to the test that needs it.
	let originalAgentDir: string;
	let isolatedHome: string;
	let isolatedAgentDir: string;
	let previousInstance: MCPManager | undefined;

	beforeEach(async () => {
		isolatedHome = path.join(os.tmpdir(), `omp-mcp-install-reconcile-home-${Snowflake.next()}`);
		isolatedAgentDir = path.join(isolatedHome, ".omp", "agent");
		fs.mkdirSync(isolatedAgentDir, { recursive: true });
		originalAgentDir = getAgentDir();
		setAgentDir(isolatedAgentDir);
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
		previousInstance = MCPManager.instance();
		tempDir = path.join(os.tmpdir(), `omp-mcp-install-reconcile-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		listLog = path.join(tempDir, "lists.log");
		fs.writeFileSync(listLog, "");
		spyOn(os, "homedir").mockReturnValue(isolatedHome);
		// First `tools/list` is a successful `{"tools":[]}` (a warming gateway),
		// the next advertises the real tool — so discovery builds the session
		// from an empty roster and the heal must arrive afterwards.
		fs.writeFileSync(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					[SERVER_NAME]: {
						type: "stdio",
						command: process.execPath,
						args: [FIXTURE_PATH],
						env: { OMP_TEST_TOOLS_PER_LIST: "0,1", OMP_TEST_LIST_LOG: listLog },
					},
				},
			}),
		);
	});

	afterEach(() => {
		MCPManager.setInstance(previousInstance);
		authStorage.close();
		setAgentDir(originalAgentDir);
		removeSyncWithRetries(isolatedHome);
		removeSyncWithRetries(tempDir);
		mock.restore();
	});

	it("exposes the healed MCP roster and system prompt to the first prompt", async () => {
		let healedToolCount: number | undefined;
		const { session, mcpManager } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			preloadedCustomToolPaths: [],
			enableMCP: true,
			// Blocking discovery, so the empty first listing is what the session
			// is constructed from.
			hasUI: false,
			extensions: [
				async () => {
					// Binds after discovery installed the manager and before the
					// session installs its tools-changed listener. Drive the heal
					// here so it lands inside that window every run.
					const manager = MCPManager.instance();
					if (!manager) throw new Error("expected MCP discovery to install the process-global manager");
					await manager.refreshServerTools(SERVER_NAME);
					healedToolCount = manager.getTools().filter(tool => tool.mcpServerName === SERVER_NAME).length;
				},
			],
		});
		try {
			// Precondition: the manager healed while no listener was installed,
			// so the install-time reconcile is the only thing that can carry the
			// new roster into the session.
			expect(healedToolCount).toBe(1);
			expect(mcpManager?.getTools().map(tool => tool.name)).toContain(HEALED_TOOL_NAME);

			// The contract, asserted with no intervening await: the session is
			// already reconciled at the instant it is handed back, so the first
			// prompt cannot see the pre-recovery roster or prompt.
			expect(session.getToolByName(HEALED_TOOL_NAME)).toBeDefined();
			expect(session.systemPrompt.join("\n")).toContain(HEALED_ROUTE);
		} finally {
			await session.dispose();
			await mcpManager?.disconnectAll();
		}
	}, 30_000);

	it("stays reconciled when a listing completes during Code Mode startup", async () => {
		// One step past the install-time window. `setOnToolsChanged` closes its
		// collection window when its own firing settles, but `createAgentSession`
		// then awaits `session.initializeCodeMode()` — and a connection-time
		// `tools/list` that ANSWERS in that window fires the handler from a
		// callsite that discards the promise (`void this.#fireToolsChanged()`).
		// The session could then be handed back, and a first prompt admitted,
		// while that rebind was still running.
		//
		// A listing still IN FLIGHT is deliberately not waited on — that would
		// re-gate startup on the slowest server (issue #2100) — so the fixture
		// drives the answered-but-unsettled state, which is what the window closes.
		const rebindStarted = Promise.withResolvers<void>();
		const releaseRebind = Promise.withResolvers<void>();
		let rebindSettled = false;
		const refreshMCPTools = AgentSession.prototype.refreshMCPTools;
		const refreshSpy = spyOn(AgentSession.prototype, "refreshMCPTools").mockImplementation(async function (
			this: AgentSession,
			tools: Parameters<typeof refreshMCPTools>[0],
		) {
			const healing = tools.some(tool => tool.name === HEALED_TOOL_NAME);
			if (!healing) return refreshMCPTools.call(this, tools);
			// Held open so "the drain awaited this" and "the drain raced it" are
			// distinguishable without any sleep.
			rebindStarted.resolve();
			await releaseRebind.promise;
			await refreshMCPTools.call(this, tools);
			rebindSettled = true;
		});

		const initializeCodeMode = AgentSession.prototype.initializeCodeMode;
		const codeModeSpy = spyOn(AgentSession.prototype, "initializeCodeMode").mockImplementation(
			async function (this: AgentSession) {
				await initializeCodeMode.call(this);
				const manager = MCPManager.instance();
				if (!manager) throw new Error("expected the process-global MCP manager");
				void manager.refreshServerTools(SERVER_NAME);
				// The listing has answered and its handler is running; nothing awaits it.
				await rebindStarted.promise;
				releaseRebind.resolve();
			},
		);

		try {
			const { session, mcpManager } = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({}),
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableLsp: false,
				skipPythonPreflight: true,
				preloadedCustomToolPaths: [],
				enableMCP: true,
				hasUI: false,
			});
			try {
				// The contract, with no intervening await: the discarded rebind has
				// already settled by the time the session is exposed.
				expect(rebindSettled).toBe(true);
				expect(session.getToolByName(HEALED_TOOL_NAME)).toBeDefined();
			} finally {
				await session.dispose();
				await mcpManager?.disconnectAll();
			}
		} finally {
			releaseRebind.resolve();
			codeModeSpy.mockRestore();
			refreshSpy.mockRestore();
		}
	}, 30_000);

	it("does not stall a mid-session toolset change on the install-time reconcile", async () => {
		// The install-time reconcile is the only firing the SDK awaits. The
		// ongoing notifications must stay exactly as they were, so a server that
		// changes its toolset mid-session still rebinds without waiting on — or
		// deadlocking against — session startup. Refresh again after the session
		// is live and confirm the manager and session both track the change.
		const { session, mcpManager } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			skipPythonPreflight: true,
			preloadedCustomToolPaths: [],
			enableMCP: true,
			hasUI: false,
		});
		try {
			if (!mcpManager) throw new Error("expected the session to own an MCP manager");
			// A mid-session re-list resolves on its own; `refreshServerTools`
			// awaits the tools-changed handler, so its resolution already means
			// the session rebound.
			await mcpManager.refreshServerTools(SERVER_NAME);

			expect(mcpManager.getTools().map(tool => tool.name)).toContain(HEALED_TOOL_NAME);
			expect(session.getToolByName(HEALED_TOOL_NAME)).toBeDefined();
		} finally {
			await session.dispose();
			await mcpManager?.disconnectAll();
		}
	}, 30_000);
});
