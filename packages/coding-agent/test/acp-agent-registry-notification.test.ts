import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentSideConnection } from "@oh-my-pi/pi-utils/acp";
import {
	AGENT_REGISTRY_NOTIFICATION,
	type AgentRegistrySnapshot,
	mirrorAgentRegistry,
	snapshotAgentRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/acp/agent-registry-notification";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface StubUsage {
	input: number;
	output: number;
	cacheWrite: number;
	cost: number;
}

function assistantMessage(usage: StubUsage): unknown {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		usage: {
			input: usage.input,
			output: usage.output,
			reasoningTokens: 0,
			cacheRead: 0,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.input + usage.output + usage.cacheWrite,
			cost: { total: usage.cost },
		},
	};
}

/** An assistant entry from a transcript that predates usage metadata. */
function legacyAssistantMessage(): unknown {
	return { role: "assistant", content: [{ type: "text", text: "from an older omp" }] };
}

/**
 * `live` opts the stub into the surface the snapshot reads off an attached
 * session. Without it `isDisposed` is undefined, which is how most of these
 * tests keep the session out of the model/metrics path.
 *
 * `child` is usage carried by a completed `task` result. The real
 * `getSessionStats()` folds that into its totals, so the stub does too: a
 * per-agent row must report `direct` alone.
 */
function sessionStub(
	sessionId: string,
	live?: {
		model?: { provider: string; id: string };
		direct?: StubUsage;
		child?: StubUsage;
		/** Prepend an entry with no `usage`, as a loaded or resumed transcript can hold. */
		legacy?: boolean;
	},
): AgentSession {
	const direct = live?.direct;
	const child = live?.child;
	const total = (usage: StubUsage | undefined): number =>
		usage === undefined ? 0 : usage.input + usage.output + usage.cacheWrite;
	const messages = (() => {
		if (direct === undefined) return live?.legacy ? [legacyAssistantMessage()] : undefined;
		return live?.legacy ? [legacyAssistantMessage(), assistantMessage(direct)] : [assistantMessage(direct)];
	})();
	return {
		sessionId,
		dispose: async () => {},
		isDisposed: live === undefined ? undefined : false,
		model: live?.model,
		agent: messages === undefined ? undefined : { state: { messages } },
		getSessionStats: () => ({
			tokens: { input: direct?.input ?? 0, output: direct?.output ?? 0, cacheWrite: direct?.cacheWrite ?? 0 },
			assistantMessages: direct === undefined ? 0 : 1,
			toolCalls: 0,
			cost: (direct?.cost ?? 0) + (child?.cost ?? 0),
			contextUsage: undefined,
			totalTokens: total(direct) + total(child),
		}),
	} as unknown as AgentSession;
}

/** Advance the fake clock past the debounce window and let the queued send settle. */
async function flush(): Promise<void> {
	vi.advanceTimersByTime(150);
	await Promise.resolve();
}

interface SentFrame {
	method: string;
	params: Record<string, unknown>;
}

/** Advance past the refresh interval, then past the debounce it schedules. */
async function flushRefresh(): Promise<void> {
	vi.advanceTimersByTime(2000);
	await Promise.resolve();
	vi.advanceTimersByTime(150);
	await Promise.resolve();
}

function capture(): { connection: Pick<AgentSideConnection, "extNotification">; sent: SentFrame[] } {
	const sent: SentFrame[] = [];
	const connection = {
		extNotification: async (method: string, params: Record<string, unknown>) => {
			sent.push({ method, params });
		},
	} as unknown as Pick<AgentSideConnection, "extNotification">;
	return { connection, sent };
}

/** The roster in the most recent frame; the assertions are all about what the client last saw. */
function agentsOf(sent: SentFrame[]): AgentRegistrySnapshot[] {
	return (sent.at(-1)?.params.agents ?? []) as AgentRegistrySnapshot[];
}

describe("ACP agent registry notification", () => {
	let registry: AgentRegistry;
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		registry = AgentRegistry.global();
	});
	afterEach(() => {
		vi.useRealTimers();
		AgentRegistry.resetGlobalForTests();
	});

	it("snapshots the roster with lineage by parent id and parent session id", () => {
		registry.register({
			id: "main",
			displayName: "main",
			kind: "main",
			session: sessionStub("s-main"),
		});
		registry.register({
			id: "sub-1",
			displayName: "GapChrome",
			kind: "sub",
			parentId: "main",
			session: sessionStub("s-sub-1"),
			sessionFile: "/tmp/s/GapChrome.jsonl",
			status: "running",
			activity: "measuring the chrome",
		});
		registry.register({
			id: "sub-2",
			displayName: "Parked",
			kind: "sub",
			parentId: "main",
			session: null,
			sessionFile: "/tmp/s/Parked.jsonl",
			status: "parked",
		});

		const byId = new Map(snapshotAgentRegistry(registry).map(agent => [agent.id, agent]));
		expect(byId.get("main")).toMatchObject({
			kind: "main",
			sessionId: "s-main",
			status: "running",
		});
		expect(byId.get("sub-1")).toMatchObject({
			kind: "sub",
			parentId: "main",
			parentSessionId: "s-main",
			sessionId: "s-sub-1",
			status: "running",
			taskTitle: "measuring the chrome",
		});
		// A parked child has no live session, so no session id is claimed for it.
		const parked = byId.get("sub-2");
		expect(parked).toMatchObject({
			kind: "sub",
			parentId: "main",
			parentSessionId: "s-main",
			status: "parked",
		});
		expect(parked?.sessionId).toBeUndefined();
		// Timestamps travel as ISO strings, which is what a JSON client can parse without a convention.
		expect(Number.isNaN(Date.parse(byId.get("sub-1")?.createdAt ?? ""))).toBe(false);
	});

	it("sends one debounced notification per burst of registry changes, and none after unsubscribe", async () => {
		const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
		const connection = {
			extNotification: async (method: string, params: Record<string, unknown>) => {
				sent.push({ method, params });
			},
		};
		vi.useFakeTimers();
		const stop = mirrorAgentRegistry(connection, registry);

		registry.register({
			id: "main",
			displayName: "main",
			kind: "main",
			session: sessionStub("s-main"),
		});
		registry.register({
			id: "a",
			displayName: "A",
			kind: "sub",
			parentId: "main",
			session: sessionStub("s-a"),
		});
		registry.register({
			id: "b",
			displayName: "B",
			kind: "sub",
			parentId: "main",
			session: sessionStub("s-b"),
		});
		await flush();

		expect(sent.length).toBe(1);
		expect(sent[0]?.method).toBe(AGENT_REGISTRY_NOTIFICATION);
		const agents = sent[0]?.params.agents as Array<{
			id: string;
			kind: string;
		}>;
		expect(agents.map(agent => agent.id).sort()).toEqual(["a", "b", "main"]);

		registry.setStatus("a", "idle");
		await flush();
		expect(sent.length).toBe(2);

		stop();
		registry.setStatus("b", "idle");
		await flush();
		expect(sent.length).toBe(2);
	});

	it("never advertises a session id a ref's own status says is gone", () => {
		registry.register({ id: "main", displayName: "main", kind: "main", session: sessionStub("s-main") });
		registry.register({
			id: "sub",
			displayName: "Sub",
			kind: "sub",
			parentId: "main",
			session: sessionStub("s-sub"),
		});
		// finalizeSubagentLifecycle parks the ref before disposal detaches its
		// session, so for that window the ref holds a session its status denies.
		registry.setStatus("sub", "parked");
		registry.setStatus("main", "parked");
		expect(registry.get("sub")?.session).not.toBeNull();

		const byId = new Map(snapshotAgentRegistry(registry).map(agent => [agent.id, agent]));
		expect(byId.get("sub")?.status).toBe("parked");
		expect(byId.get("sub")?.sessionId).toBeUndefined();
		expect(byId.get("sub")?.parentSessionId).toBeUndefined();
		expect(byId.get("main")?.sessionId).toBeUndefined();
	});

	it("publishes a session attached after the registration frame", async () => {
		const { connection, sent } = capture();
		vi.useFakeTimers();
		const stop = mirrorAgentRegistry(connection, registry);

		// createAgentSession pre-registers `running` with no session, then attaches
		// the live one once construction finishes.
		registry.register({ id: "sub", displayName: "Sub", kind: "sub", session: null });
		await flush();
		expect(agentsOf(sent).map(agent => agent.sessionId)).toEqual([undefined]);

		// attachSession emits nothing, and the trailing setStatus("running") is a
		// no-op on a ref registered as running: only the refresh carries this.
		expect(registry.attachSession("sub", sessionStub("s-sub"))).toBe(true);
		expect(registry.setStatus("sub", "running")).toBe(true);
		await flushRefresh();

		expect(agentsOf(sent).map(agent => agent.sessionId)).toEqual(["s-sub"]);
		stop();
	});

	it("publishes intent recorded after the first frame", async () => {
		const { connection, sent } = capture();
		vi.useFakeTimers();
		const stop = mirrorAgentRegistry(connection, registry);

		registry.register({ id: "sub", displayName: "Sub", kind: "sub", session: sessionStub("s-sub") });
		await flush();
		expect(agentsOf(sent)[0]?.taskTitle).toBeUndefined();

		// setActivity emits no registry event, by design, so the listener alone
		// would leave the client on the registration frame for the whole turn.
		registry.setActivity("sub", "measuring the chrome");
		await flushRefresh();

		expect(agentsOf(sent)[0]?.taskTitle).toBe("measuring the chrome");
		stop();
	});

	it("sends nothing while the roster is unchanged and releases the refresh when work ends", async () => {
		const { connection, sent } = capture();
		vi.useFakeTimers();
		const stop = mirrorAgentRegistry(connection, registry);

		registry.register({ id: "sub", displayName: "Sub", kind: "sub", session: sessionStub("s-sub") });
		await flush();
		expect(sent.length).toBe(1);

		// A refresh tick over a roster nobody touched has nothing to say.
		await flushRefresh();
		await flushRefresh();
		expect(sent.length).toBe(1);

		registry.setStatus("sub", "idle");
		await flush();
		const quiesced = sent.length;

		// Nothing runs now, so the refresh is released: a mutation that emits no
		// event stays invisible until some real event brings it along.
		expect(registry.attachSession("sub", sessionStub("s-late"))).toBe(true);
		await flushRefresh();
		await flushRefresh();
		expect(sent.length).toBe(quiesced);

		registry.setStatus("sub", "running");
		await flush();
		expect(agentsOf(sent)[0]?.sessionId).toBe("s-late");
		stop();
	});

	it("reports each agent's own usage from its session, and history only once detached", () => {
		const stale = {
			resolvedModel: "google/gemini-3-pro",
			metrics: { tokens: 99, requests: 1, tools: 0, cost: 9.99, durationMs: 5000 },
		};
		// A revived ref: its history describes the transcript it ran last time.
		registry.register({
			id: "revived",
			displayName: "Revived",
			kind: "sub",
			session: sessionStub("s-revived", {
				model: { provider: "anthropic", id: "claude-opus-5" },
				direct: { input: 4000, output: 200, cacheWrite: 0, cost: 0.12 },
				// This parent finished a `task` call, so its own stats carry the
				// child's usage; the child reports it on its own row.
				child: { input: 900_000, output: 1000, cacheWrite: 0, cost: 5.5 },
			}),
			history: stale,
		});
		// A freshly spawned subagent: no history at all until the executor writes one.
		registry.register({
			id: "fresh",
			displayName: "Fresh",
			kind: "sub",
			session: sessionStub("s-fresh", {
				model: { provider: "xai", id: "grok-5" },
				direct: { input: 8, output: 2, cacheWrite: 0, cost: 0.01 },
			}),
		});
		// A resumed transcript holding an entry from before usage metadata existed.
		// One of those must not cost the session its metrics entirely, which is
		// what an ACP root has instead of a history fallback.
		registry.register({
			id: "resumed",
			displayName: "Resumed",
			kind: "sub",
			session: sessionStub("s-resumed", {
				model: { provider: "openai", id: "gpt-6" },
				direct: { input: 30, output: 5, cacheWrite: 0, cost: 0.03 },
				legacy: true,
			}),
		});
		// Detached, so history is all there is, and it is the only case with a span.
		registry.register({
			id: "done",
			displayName: "Done",
			kind: "sub",
			session: null,
			status: "parked",
			history: stale,
		});

		const byId = new Map(snapshotAgentRegistry(registry).map(agent => [agent.id, agent]));
		expect(byId.get("revived")?.model).toBe("anthropic/claude-opus-5");
		// Its own 4200 tokens and $0.12, not the 901000 and $5.62 its stats total.
		expect(byId.get("revived")?.metrics).toEqual({ usedTokens: 4200, costAmount: 0.12 });
		expect(byId.get("fresh")?.model).toBe("xai/grok-5");
		expect(byId.get("fresh")?.metrics).toEqual({ usedTokens: 10, costAmount: 0.01 });
		// The usage-less entry is skipped, not fatal.
		expect(byId.get("resumed")?.metrics).toEqual({ usedTokens: 35, costAmount: 0.03 });
		expect(byId.get("done")?.model).toBe("google/gemini-3-pro");
		expect(byId.get("done")?.metrics).toEqual({ usedTokens: 99, costAmount: 9.99, durationMs: 5000 });
	});

	it("states a roster that predates the subscription, and stays silent when there is none", async () => {
		vi.useFakeTimers();
		const empty = capture();
		const stopEmpty = mirrorAgentRegistry(empty.connection, registry);
		await flush();
		expect(empty.sent.length).toBe(0);
		stopEmpty();

		// An embedder handing us a session it created itself: the ref exists
		// before we subscribe, nothing runs, and onChange cannot report it.
		registry.register({
			id: "main",
			displayName: "main",
			kind: "main",
			session: sessionStub("s-main"),
			status: "idle",
		});
		const { connection, sent } = capture();
		const stop = mirrorAgentRegistry(connection, registry);
		await flush();
		expect(agentsOf(sent).map(agent => agent.id)).toEqual(["main"]);

		// Nothing is running, so that frame must not have left an interval behind.
		await flushRefresh();
		await flushRefresh();
		expect(sent.length).toBe(1);
		stop();
	});

	it("resnapshots when an idle session changes its id or its model", async () => {
		const { connection, sent } = capture();
		let sessionId = "s-before";
		let model: { provider: string; id: string } = { provider: "anthropic", id: "claude-opus-5" };
		let onSessionChange: (() => void) | undefined;
		let onEvent: ((event: { type: string }) => void) | undefined;
		const session = {
			get sessionId() {
				return sessionId;
			},
			get model() {
				return model;
			},
			isStreaming: false,
			isDisposed: false,
			dispose: async () => {},
			subscribeRunState: () => () => {},
			registerSessionChangeCallback: (callback: () => void) => {
				onSessionChange = callback;
				return () => {
					onSessionChange = undefined;
				};
			},
			registerSessionIdentityChangeCallback: (callback: () => void) => {
				onSessionChange = callback;
				return () => {
					onSessionChange = undefined;
				};
			},
			subscribe: (listener: (event: { type: string }) => void) => {
				onEvent = listener;
				return () => {
					onEvent = undefined;
				};
			},
			agent: { state: { messages: [] } },
			getSessionStats: () => ({
				tokens: { input: 0, output: 0, cacheWrite: 0 },
				assistantMessages: 0,
				toolCalls: 0,
				cost: 0,
				contextUsage: undefined,
			}),
		} as unknown as AgentSession;
		registry.register({ id: "main", displayName: "main", kind: "main", session, status: "idle" });
		vi.useFakeTimers();
		const stop = mirrorAgentRegistry(connection, registry);
		await flush();
		expect(agentsOf(sent)[0]?.sessionId).toBe("s-before");
		expect(agentsOf(sent)[0]?.model).toBe("anthropic/claude-opus-5");

		// Adopting the session is what tells the registry to watch it, which is
		// what an ACP host does with every session it takes.
		expect(registry.syncOwnedSession(session)).toBe(true);
		// `newSession`, `fork`, `switchSession` and `/fresh` swap the id under an
		// idle ref: no registry mutation, and no refresh interval either since
		// nothing is running.
		sessionId = "s-after";
		onSessionChange?.();
		await flush();
		expect(agentsOf(sent)[0]?.sessionId).toBe("s-after");

		// `session/set_config_option` on an idle session, same shape.
		model = { provider: "openai", id: "gpt-6" };
		onEvent?.({ type: "model_changed" });
		await flush();
		expect(agentsOf(sent)[0]?.model).toBe("openai/gpt-6");

		// A streaming event is not a roster change and must not produce a frame.
		const settled = sent.length;
		onEvent?.({ type: "assistant_chunk" });
		await flush();
		expect(sent.length).toBe(settled);
		stop();
	});

	it("keeps a failing notification inside the mirror", async () => {
		// A closed or half-built connection throws on the way out. The send runs
		// from a timer, so an escape here is an unhandled exception in the host
		// process rather than a dropped roster frame.
		const connection = {
			extNotification: () => {
				throw new Error("transport closed");
			},
		} as unknown as Pick<AgentSideConnection, "extNotification">;
		vi.useFakeTimers();
		const stop = mirrorAgentRegistry(connection, registry);
		registry.register({ id: "sub", displayName: "Sub", kind: "sub", session: sessionStub("s-sub") });
		await flush();
		stop();
	});
});
