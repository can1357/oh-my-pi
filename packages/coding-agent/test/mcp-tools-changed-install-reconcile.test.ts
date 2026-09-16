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

/** Poll a predicate that has no event to gate on (transport-internal state). */
async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitUntil timed out");
		await Bun.sleep(5);
	}
}
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

	// `drain()` returning is NOT the window being finished. Its final emptiness
	// check is followed by a microtask boundary, and a listing callback already
	// queued behind it runs in that gap — appending its asynchronous rebind to
	// the sink that an unconditional `close()` then discarded. The caller
	// resumed with that rebind still pending, so `createAgentSession` could hand
	// back a session whose roster was still being rewritten.
	//
	// The contract that closes it: a close must REFUSE while the sink still
	// holds a firing, so the caller drains again instead of dropping it. Driven
	// with a real firing through the public API — the handler parks, so the
	// firing is provably unsettled at the moment the close is attempted.
	//
	// RED (pre-fix): `close()` returned void and deleted the sink unconditionally,
	// so a pending firing was discarded.
	it("refuses to close a reconcile window that still holds a pending firing", async () => {
		const manager = new MCPManager(tempDir);
		try {
			await manager.connectServers(
				{
					[SERVER_NAME]: {
						type: "stdio",
						command: process.execPath,
						args: [FIXTURE_PATH],
						env: { OMP_TEST_TOOLS_PER_LIST: "0,1", OMP_TEST_LIST_LOG: listLog },
					},
				},
				{},
			);

			// Parks every firing raised after installation, so one can be observed
			// mid-flight rather than inferred from timing.
			const gate = Promise.withResolvers<void>();
			const secondFiring = Promise.withResolvers<void>();
			let fired = 0;
			await manager.setOnToolsChanged(async () => {
				fired++;
				if (fired > 1) {
					secondFiring.resolve();
					await gate.promise;
				}
			});

			const sink = manager.openToolsChangedReconcile();
			const refresh = manager.refreshServerTools(SERVER_NAME);
			// Event-gated on the firing itself: a real stdio `tools/list` round trip
			// takes more than a microtask, so waiting a fixed number of turns would
			// be a race. Once this resolves the handler is parked on the gate, so
			// the firing is provably unsettled.
			await secondFiring.promise;
			await Bun.sleep(0);

			// The pending firing blocks the close instead of being discarded.
			expect(sink.close()).toBe(false);

			gate.resolve();
			await sink.drain();
			// Drained, so the close now succeeds — this is what ends the caller's
			// drain/close loop.
			expect(sink.close()).toBe(true);
			await refresh;
		} finally {
			// A stdio fixture shutting down mid-teardown surfaces a retryable
			// transport close; it says nothing about the contract under test.
			try {
				await manager.disconnectAll();
			} catch {
				// ignored: teardown noise, not a contract failure
			}
		}
	}, 30_000);

	// A `/mcp refresh` issued after the connection is in `#connections` but while
	// its initial `tools/list` is still in `#pendingToolLoads` does NOT coalesce:
	// the refresh single-flight keys on `#pendingToolRefresh` only, so two lists
	// run concurrently. If the refresh answers FIRST, the delayed initial
	// response replaced the live registry with its older catalog — and being
	// non-empty it schedules no empty-toolset recovery, so the session stayed on
	// the obsolete roster for good.
	//
	// The interleaving is scripted by the fixture, not hoped for: the FIRST
	// listing (the initial load, advertising one tool) is delayed well past the
	// second (the refresh, advertising two), so the older response provably lands
	// after the newer one was applied.
	//
	// RED (pre-fix): the late initial response overwrote the refresh's roster, so
	// the second tool disappeared.
	it("refuses an initial tool load that answers after an overlapping refresh applied", async () => {
		const manager = new MCPManager(tempDir);
		const secondToolName = `mcp__${SERVER_NAME}_${warmupToolName(1)}`;
		try {
			// List 1 -> 1 tool, delayed 750ms. List 2 -> 2 tools, immediate.
			const connected = manager.connectServers(
				{
					[SERVER_NAME]: {
						type: "stdio",
						command: process.execPath,
						args: [FIXTURE_PATH],
						env: {
							OMP_TEST_TOOLS_PER_LIST: "1,2",
							OMP_TEST_LIST_DELAY_MS: "750,0",
							OMP_TEST_LIST_LOG: listLog,
						},
					},
				},
				{},
			);

			// The refresh is issued while the initial load is still pending — the
			// window the single-flight does not cover. `"connected"` is exactly that
			// state: the connection is in `#connections` (so `refreshServerTools`
			// will actually list rather than return early) while its initial
			// `tools/list` is still in `#pendingToolLoads`.
			await waitUntil(() => manager.getConnectionStatus(SERVER_NAME) === "connected");
			const refresh = manager.refreshServerTools(SERVER_NAME).catch(() => {});

			await Promise.allSettled([connected, refresh]);
			// Give the delayed first response time to land and be refused.
			// The delayed first response lands after both calls above settled; give
			// it room to arrive and be refused.
			await Bun.sleep(1500);

			// The refresh's newer, larger catalog stands.
			expect(manager.getTools().map(tool => tool.name)).toContain(secondToolName);
		} finally {
			try {
				await manager.disconnectAll();
			} catch {
				// ignored: teardown noise, not a contract failure
			}
		}
	}, 30_000);

	// Sibling of the case above, on the OTHER consumer. There the initial list is
	// still pending at the startup cutoff, so only the background handler ever
	// applies it. When both responses land INSIDE the 250ms startup race the
	// fulfilled task is also processed by `connectServers`' foreground loop,
	// which applied it unconditionally and restored the roster the background
	// handler had just refused.
	it("refuses a superseded initial load that fulfills inside the startup race", async () => {
		const manager = new MCPManager(tempDir);
		const secondToolName = `mcp__${SERVER_NAME}_${warmupToolName(1)}`;
		try {
			// List 1 -> 1 tool, delayed just enough to answer SECOND while still
			// fulfilling before the startup cutoff. List 2 -> 2 tools, immediate.
			const connected = manager.connectServers(
				{
					[SERVER_NAME]: {
						type: "stdio",
						command: process.execPath,
						args: [FIXTURE_PATH],
						env: {
							OMP_TEST_TOOLS_PER_LIST: "1,2",
							OMP_TEST_LIST_DELAY_MS: "120,0",
							OMP_TEST_LIST_LOG: listLog,
						},
					},
				},
				{},
			);

			await waitUntil(() => manager.getConnectionStatus(SERVER_NAME) === "connected");
			const refresh = manager.refreshServerTools(SERVER_NAME).catch(() => {});

			await Promise.allSettled([connected, refresh]);
			await Bun.sleep(500);

			// RED (pre-fix): the foreground apply reinstated list 1's single tool.
			expect(manager.getTools().map(tool => tool.name)).toContain(secondToolName);
		} finally {
			try {
				await manager.disconnectAll();
			} catch {
				// ignored: teardown noise, not a contract failure
			}
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
