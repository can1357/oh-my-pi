import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type MCPLoadResult, MCPManager, type MCPStartupStatus } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { MCP_DISCOVERY_TURN_WAIT_MS } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// Contract: UI/RPC sessions (`hasUI`) defer MCP discovery off startup. A prompt that
// arrives while MCP servers are still connecting must not send its first request without
// their routes: every later request (and, on resume, the previous process) carries them,
// so a first request without them changes the system prompt bytes and misses the provider
// prompt cache. That covers servers still connecting after discovery's startup window too.
// The wait is bounded, paid by the first turn only, and ends at once on abort.
//
// When the turn stops waiting is observed at `before_agent_start`, which the turn emits
// right after the wait; the provider request follows a fake-time cooperative yield in the
// agent loop that would blur the deadline. Request contents are asserted at the provider.

const MCP_TOOL_NAME = "mcp__probe_lookup";
const MCP_ROUTE = `xd://${MCP_TOOL_NAME}`;
/** Margin around the deadline: Bun's fake clock fires a timer 1 ms before it is due. */
const DEADLINE_SLACK_MS = 5;
/**
 * Fake-time ceiling for driving a started turn to its request: the agent loop's cooperative
 * yield sleeps 20 ms, and a fake timer still pending when real timers return never fires.
 */
const SEND_MS = 1_000;
/** Real event-loop turns a released turn gets to finish its I/O while fake time stands still. */
const RELEASED_TURNS = 100_000;
type MCPTools = MCPLoadResult["tools"];

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Spins real event-loop turns (I/O included) without advancing fake timers. */
async function yieldUntil(done: () => boolean, turns = 1_000): Promise<void> {
	for (let turn = 0; turn < turns && !done(); turn++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

/** Advances fake time 1 ms at a time, running real I/O between steps, until `done` or `ms` elapse. */
async function stepUntil(done: () => boolean, ms: number): Promise<void> {
	for (let step = 0; step < ms && !done(); step++) {
		await yieldUntil(done, 20);
		if (!done()) vi.advanceTimersByTime(1);
	}
	await yieldUntil(done, 20);
}

/**
 * Runs the turn's real setup until it parks on its first fake timer, which is the bounded MCP
 * wait (the abort test proves it: aborting there releases the turn), or until it starts.
 */
function parkOnFirstTimer(started: () => boolean): Promise<void> {
	return yieldUntil(() => vi.getTimerCount() > 0 || started(), 100_000);
}

function probeTools(): MCPTools {
	const tool: MCPTools[number] = {
		name: MCP_TOOL_NAME,
		label: "probe/lookup",
		description: "Look a value up.",
		parameters: type({ q: "string" }),
		mcpServerName: "probe",
		mcpToolName: "lookup",
		async execute() {
			return { content: [{ type: "text", text: "found" }] };
		},
	};
	return [tool];
}

/**
 * Stands in for the manager's server connections: `discoverAndConnect` settles when the test
 * closes the startup window, and `getTools` serves whatever servers have connected so far.
 */
function fakeServers() {
	let connected: MCPTools = [];
	const discovery = Promise.withResolvers<MCPLoadResult>();
	vi.spyOn(MCPManager.prototype, "discoverAndConnect").mockImplementation(() => discovery.promise);
	vi.spyOn(MCPManager.prototype, "getTools").mockImplementation(() => connected);
	return {
		/** Closes discovery's startup window with `tools` connected. */
		closeStartupWindow(tools: MCPTools): void {
			connected = tools;
			discovery.resolve({
				tools,
				errors: new Map(),
				connectedServers: tools.length > 0 ? ["probe"] : [],
				exaApiKeys: [],
			});
		},
		/** A server that missed the startup window registers its tools. */
		connectLate(tools: MCPTools): void {
			connected = [...connected, ...tools];
		},
	};
}

async function createDeferredSession() {
	const servers = fakeServers();
	const root = TempDir.createSync("@pi-mcp-first-turn-");
	cleanups.push(() => root.removeSync());
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	cleanups.push(() => auth.close());
	const mock = createMockModel({ handler: { content: ["done"] } });
	let turnsStarted = 0;
	const { session } = await createAgentSession({
		cwd: root.path(),
		agentDir: root.path(),
		modelRegistry: new ModelRegistry(auth),
		model: mock,
		sessionManager: SessionManager.inMemory(root.path()),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		}),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableLsp: false,
		skipPythonPreflight: true,
		enableMCP: true,
		hasUI: true,
		extensions: [
			pi => {
				pi.on("before_agent_start", () => {
					turnsStarted++;
				});
			},
		],
	});
	cleanups.push(() => session.dispose());
	const systemPrompts: string[] = [];
	session.agent.streamFn = (model, context, options) => {
		systemPrompts.push((context.systemPrompt ?? []).join("\n"));
		return mock.stream(model, context, options);
	};
	return { session, servers, systemPrompts, turnsStarted: () => turnsStarted };
}

describe("createAgentSession deferred MCP discovery and the first turn", () => {
	it("holds the first turn until in-flight discovery lands so its request carries the MCP routes", async () => {
		const { session, servers, systemPrompts, turnsStarted } = await createDeferredSession();
		const started = () => turnsStarted() > 0;
		vi.useFakeTimers();
		const prompted = session.prompt("hello");
		await parkOnFirstTimer(started);
		// Without the wait the turn starts within this window, still lacking MCP.
		await stepUntil(started, MCP_DISCOVERY_TURN_WAIT_MS - DEADLINE_SLACK_MS);
		expect(turnsStarted()).toBe(0);
		servers.closeStartupWindow(probeTools());
		vi.useRealTimers();
		await prompted;
		expect(systemPrompts[0]).toContain(MCP_ROUTE);
	});

	it("holds the first turn for servers still connecting after discovery's startup window", async () => {
		const startup = Promise.withResolvers<MCPStartupStatus>();
		vi.spyOn(MCPManager.prototype, "waitForStartup").mockImplementation(() => startup.promise);
		const { session, servers, systemPrompts, turnsStarted } = await createDeferredSession();
		const started = () => turnsStarted() > 0;
		// Discovery returns while the probe server is still connecting.
		servers.closeStartupWindow([]);
		vi.useFakeTimers();
		const prompted = session.prompt("hello");
		await stepUntil(started, 100);
		expect(turnsStarted()).toBe(0);
		// The probe connects within the turn's budget; releasing the startup barrier starts the turn.
		servers.connectLate(probeTools());
		startup.resolve({ connected: ["probe"], pending: [], failed: [] });
		// Fake time stands still, so only the barrier release can start the turn.
		await yieldUntil(started, RELEASED_TURNS);
		expect(turnsStarted()).toBe(1);
		await stepUntil(() => systemPrompts.length > 0, SEND_MS);
		vi.useRealTimers();
		await prompted;
		expect(systemPrompts[0]).toContain(MCP_ROUTE);
	});

	it("publishes the tools discovery returned before waiting on slower servers", async () => {
		// A slower server never finishes connecting, so the startup barrier never releases.
		const { promise: neverReady } = Promise.withResolvers<MCPStartupStatus>();
		const barrierReached = Promise.withResolvers<void>();
		vi.spyOn(MCPManager.prototype, "waitForStartup").mockImplementation(() => {
			barrierReached.resolve();
			return neverReady;
		});
		const { session, servers } = await createDeferredSession();
		// Discovery's startup window closes with the probe's tools (e.g. its cached routes) available.
		servers.closeStartupWindow(probeTools());
		await barrierReached.promise;
		// A turn that runs out its wait builds from this prompt, so the routes must already be in it.
		expect(session.agent.state.systemPrompt.join("\n")).toContain(MCP_ROUTE);
	});

	it("starts the first turn at the deadline and does not hold later turns", async () => {
		const { session, systemPrompts, turnsStarted } = await createDeferredSession();
		const started = () => turnsStarted() > 0;
		vi.useFakeTimers();
		const first = session.prompt("first");
		await parkOnFirstTimer(started);
		await stepUntil(started, MCP_DISCOVERY_TURN_WAIT_MS - DEADLINE_SLACK_MS);
		expect(turnsStarted()).toBe(0);
		vi.advanceTimersByTime(2 * DEADLINE_SLACK_MS);
		await yieldUntil(started, RELEASED_TURNS);
		expect(turnsStarted()).toBe(1);
		await stepUntil(() => systemPrompts.length > 0, SEND_MS);
		vi.useRealTimers();
		await first;
		expect(systemPrompts).toHaveLength(1);
		expect(systemPrompts[0]).not.toContain(MCP_ROUTE);

		// Discovery is still connecting, but the first turn already paid the wait.
		vi.useFakeTimers();
		const second = session.prompt("second");
		// No fake time passes, so the turn starts only if it does not wait again.
		await yieldUntil(() => turnsStarted() > 1, RELEASED_TURNS);
		expect(turnsStarted()).toBe(2);
		await stepUntil(() => systemPrompts.length > 1, SEND_MS);
		vi.useRealTimers();
		await second;
	});

	it("ends the wait at once when the turn is aborted", async () => {
		const { session, systemPrompts, turnsStarted } = await createDeferredSession();
		vi.useFakeTimers();
		let settled = false;
		const prompted = session.prompt("hello").finally(() => {
			settled = true;
		});
		await parkOnFirstTimer(() => turnsStarted() > 0);
		const aborted = session.abort();
		// Fake time stands still, so only the abort can release the turn.
		await yieldUntil(() => settled);
		expect(settled).toBe(true);
		expect(turnsStarted()).toBe(0);
		vi.useRealTimers();
		await aborted;
		await prompted;
		expect(systemPrompts).toHaveLength(0);
	});
});
