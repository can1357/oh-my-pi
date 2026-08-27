import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { IrcBus, type IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type CoordinationDetails, HubTool, isIrcEnabled } from "@oh-my-pi/pi-coding-agent/tools/hub";

interface FakeSession {
	session: AgentSession;
	/** Messages delivered into this session via deliverIrcMessage. */
	delivered: IrcMessage[];
	/** Display-only relay observations emitted on this session. */
	relayed: CustomMessage[];
	/** Outcome the fake reports (busy vs idle recipient). */
	setOutcome: (outcome: "injected" | "woken") => void;
	/** Cause the next deliverIrcMessage call to throw. */
	setError: (error: Error) => void;
	/** Side effect run on delivery (e.g. reply via the bus). */
	onDeliver: (fn: (msg: IrcMessage) => void) => void;
}

function makeFakeSession(): FakeSession {
	let outcome: "injected" | "woken" = "injected";
	let nextError: Error | null = null;
	let deliverHook: ((msg: IrcMessage) => void) | undefined;
	const delivered: IrcMessage[] = [];
	const relayed: CustomMessage[] = [];
	const session = {
		isStreaming: true,
		deliverIrcMessage: async (msg: IrcMessage) => {
			if (nextError) {
				const err = nextError;
				nextError = null;
				throw err;
			}
			delivered.push(msg);
			deliverHook?.(msg);
			return outcome;
		},
		emitIrcRelayObservation: (record: CustomMessage) => {
			relayed.push(record);
		},
	};
	return {
		session: session as unknown as AgentSession,
		delivered,
		relayed,
		setOutcome: value => {
			outcome = value;
		},
		setError: error => {
			nextError = error;
		},
		onDeliver: fn => {
			deliverHook = fn;
		},
	};
}

function makeToolSession(registry: AgentRegistry, agentId: string): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		agentRegistry: registry,
		getAgentId: () => agentId,
	};
}

function createRealSession(overrides: Partial<Record<SettingPath, unknown>> = {}): {
	session: AgentSession;
	sessionManager: SessionManager;
} {
	const sessionManager = SessionManager.inMemory("/tmp");
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				systemPrompt: ["system prompt"],
				messages: [],
				tools: [],
			},
		}),
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false, ...overrides }),
		modelRegistry: {} as never,
	});
	return { session, sessionManager };
}

describe("IRC", () => {
	let registry: AgentRegistry;
	let bus: IrcBus;

	const sessions: AgentSession[] = [];
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		bus = IrcBus.global();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	describe("IrcBus", () => {
		it("send delivers to a live recipient and reports the session outcome", async () => {
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			sub.setOutcome("injected");
			const injected = await bus.send({ from: "0-Main", to: "0-Sub", body: "ping" });
			expect(injected).toEqual({ to: "0-Sub", outcome: "injected" });

			sub.setOutcome("woken");
			const woken = await bus.send({ from: "0-Main", to: "0-Sub", body: "ping again" });
			expect(woken.outcome).toBe("woken");

			expect(sub.delivered.map(msg => msg.body)).toEqual(["ping", "ping again"]);
			expect(sub.delivered[0]?.from).toBe("0-Main");
			expect(sub.delivered[0]?.id).toBeTruthy();
			expect(bus.unreadCount("0-Sub")).toBe(0);
		});

		it("relays only subagent-to-subagent traffic to the main UI", async () => {
			const main = makeFakeSession();
			registry.register({ id: "Main", displayName: "main", kind: "main", session: main.session });
			const a = makeFakeSession();
			registry.register({ id: "0-A", displayName: "task", kind: "sub", session: a.session });
			const b = makeFakeSession();
			registry.register({ id: "0-B", displayName: "task", kind: "sub", session: b.session });

			await bus.send({ from: "Main", to: "0-A", body: "outbound from main" });
			await bus.send({ from: "0-A", to: "Main", body: "inbound to main" });
			await bus.send({ from: "0-A", to: "0-B", body: "sibling note" });

			expect(main.relayed).toHaveLength(1);
			expect(main.relayed[0]?.details).toEqual({ from: "0-A", to: "0-B", body: "sibling note" });
		});

		it("send to an unknown or aborted agent fails", async () => {
			const unknown = await bus.send({ from: "0-Main", to: "0-Ghost", body: "hello?" });
			expect(unknown.outcome).toBe("failed");

			const sub = makeFakeSession();
			registry.register({ id: "0-Dead", displayName: "task", kind: "sub", session: sub.session });
			registry.setStatus("0-Dead", "aborted");
			const aborted = await bus.send({ from: "0-Main", to: "0-Dead", body: "hello?" });
			expect(aborted.outcome).toBe("failed");
		});

		it("send surfaces recipient delivery errors as failed", async () => {
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });
			sub.setError(new Error("boom"));
			const receipt = await bus.send({ from: "0-Main", to: "0-Sub", body: "ping" });
			expect(receipt).toEqual({ to: "0-Sub", outcome: "failed", error: "boom" });
			expect(bus.unreadCount("0-Sub")).toBe(1);
		});

		it("send revives a parked recipient through the lifecycle manager", async () => {
			const sub = makeFakeSession();
			sub.setOutcome("woken");
			registry.register({ id: "0-Parked", displayName: "task", kind: "sub", session: null, status: "parked" });
			AgentLifecycleManager.global().adopt("0-Parked", {
				idleTtlMs: 0,
				revive: async () => sub.session,
			});

			const receipt = await bus.send({ from: "0-Main", to: "0-Parked", body: "wake up" });
			expect(receipt.outcome).toBe("revived");
			expect(sub.delivered.map(msg => msg.body)).toEqual(["wake up"]);
			expect(registry.get("0-Parked")?.status).toBe("idle");
		});

		it("send fails cleanly when a parked recipient has no reviver", async () => {
			registry.register({ id: "0-Parked", displayName: "task", kind: "sub", session: null, status: "parked" });
			AgentLifecycleManager.global().adopt("0-Parked", { idleTtlMs: 0 });
			const receipt = await bus.send({ from: "0-Main", to: "0-Parked", body: "wake up" });
			expect(receipt.outcome).toBe("failed");
			expect(receipt.error).toBeTruthy();
		});

		it("custom-registry bus delivers live without gating on global park state for the same id", async () => {
			// Global lifecycle has this id adopted + mid-park; a bus on a separate
			// registry must NOT consult that unrelated state for its live recipient.
			const globalStub = makeFakeSession();
			registry.register({
				id: "0-Sub",
				displayName: "task",
				kind: "sub",
				session: globalStub.session,
				sessionFile: "/tmp/0-Sub.jsonl",
				status: "idle",
			});
			const { promise: neverDispose } = Promise.withResolvers<void>();
			globalStub.session.dispose = (async () => {
				await neverDispose;
			}) as AgentSession["dispose"];
			AgentLifecycleManager.global().adopt("0-Sub", { idleTtlMs: 0 });
			void AgentLifecycleManager.global().park("0-Sub");
			expect(AgentLifecycleManager.global().has("0-Sub")).toBe(true);

			const customRegistry = new AgentRegistry();
			const customBus = new IrcBus(customRegistry);
			const live = makeFakeSession();
			live.setOutcome("injected");
			customRegistry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: live.session });

			const receipt = await customBus.send({ from: "0-Main", to: "0-Sub", body: "hi" });

			expect(receipt).toEqual({ to: "0-Sub", outcome: "injected" });
			expect(live.delivered.map(msg => msg.body)).toEqual(["hi"]);
			expect(globalStub.delivered).toEqual([]);
		});

		it("send during pre-detach park keeps the live session and does not revive", async () => {
			const { promise: disposeGate, resolve: resolveDispose } = Promise.withResolvers<void>();
			let disposeCalls = 0;
			const delivered: IrcMessage[] = [];
			const session = {
				deliverIrcMessage: async (msg: IrcMessage) => {
					delivered.push(msg);
					return "injected" as const;
				},
				emitIrcRelayObservation: () => {},
				dispose: async () => {
					disposeCalls++;
					await disposeGate;
				},
			} as unknown as AgentSession;
			registry.register({
				id: "0-Parking",
				displayName: "task",
				kind: "sub",
				session,
				sessionFile: "/tmp/0-Parking.jsonl",
				status: "idle",
			});
			let reviverRuns = 0;
			AgentLifecycleManager.global().adopt("0-Parking", {
				idleTtlMs: 0,
				revive: async () => {
					reviverRuns++;
					return session;
				},
			});

			const parking = AgentLifecycleManager.global().park("0-Parking");
			// Same tick: cancel window still open — send must keep the live session.
			const receipt = await bus.send({ from: "0-Main", to: "0-Parking", body: "stay alive" });
			await parking;

			expect(receipt.outcome).toBe("injected");
			expect(delivered.map(msg => msg.body)).toEqual(["stay alive"]);
			expect(disposeCalls).toBe(0);
			expect(reviverRuns).toBe(0);
			expect(registry.get("0-Parking")?.session).toBe(session);
			expect(registry.get("0-Parking")?.status).toBe("idle");
			expect(bus.unreadCount("0-Parking")).toBe(0);
			resolveDispose();
		});

		it("send after park detaches waits for dispose, revives, and delivers once", async () => {
			const { promise: disposeGate, resolve: resolveDispose } = Promise.withResolvers<void>();
			let disposeCalls = 0;
			const oldSession = {
				deliverIrcMessage: async () => {
					throw new Error("dying session must not receive mail");
				},
				emitIrcRelayObservation: () => {},
				dispose: async () => {
					disposeCalls++;
					await disposeGate;
				},
			} as unknown as AgentSession;
			const revived = makeFakeSession();
			revived.setOutcome("woken");
			registry.register({
				id: "0-Parking",
				displayName: "task",
				kind: "sub",
				session: oldSession,
				sessionFile: "/tmp/0-Parking.jsonl",
				status: "idle",
			});
			let reviverRuns = 0;
			AgentLifecycleManager.global().adopt("0-Parking", {
				idleTtlMs: 0,
				revive: async () => {
					reviverRuns++;
					return revived.session;
				},
			});

			const parking = AgentLifecycleManager.global().park("0-Parking");
			// Pass the cancel window so park detaches before send.
			await Promise.resolve();
			await Promise.resolve();
			expect(registry.get("0-Parking")?.status).toBe("parked");
			expect(registry.get("0-Parking")?.session).toBeNull();
			expect(disposeCalls).toBe(1);

			const sendPromise = bus.send({ from: "0-Main", to: "0-Parking", body: "after park" });
			let sendSettled = false;
			void sendPromise.then(() => {
				sendSettled = true;
			});
			await Promise.resolve();
			await Promise.resolve();
			// Blocked on dispose — must not inject into the dying session or buffer.
			expect(sendSettled).toBe(false);
			expect(reviverRuns).toBe(0);
			expect(bus.unreadCount("0-Parking")).toBe(0);

			resolveDispose();
			const receipt = await sendPromise;
			await parking;

			expect(receipt.outcome).toBe("revived");
			expect(revived.delivered.map(msg => msg.body)).toEqual(["after park"]);
			expect(reviverRuns).toBe(1);
			expect(registry.get("0-Parking")?.session).toBe(revived.session);
			expect(bus.unreadCount("0-Parking")).toBe(0);
		});

		it("multiple concurrent sends during park coalesce revive and all deliver", async () => {
			const { promise: disposeGate, resolve: resolveDispose } = Promise.withResolvers<void>();
			const oldSession = {
				deliverIrcMessage: async () => {
					throw new Error("dying session must not receive mail");
				},
				emitIrcRelayObservation: () => {},
				dispose: async () => {
					await disposeGate;
				},
			} as unknown as AgentSession;
			const revived = makeFakeSession();
			revived.setOutcome("injected");
			registry.register({
				id: "0-Parking",
				displayName: "task",
				kind: "sub",
				session: oldSession,
				sessionFile: "/tmp/0-Parking.jsonl",
				status: "idle",
			});
			let reviverRuns = 0;
			AgentLifecycleManager.global().adopt("0-Parking", {
				idleTtlMs: 0,
				revive: async () => {
					reviverRuns++;
					return revived.session;
				},
			});

			const parking = AgentLifecycleManager.global().park("0-Parking");
			await Promise.resolve();
			await Promise.resolve();

			const sends = Promise.all([
				bus.send({ from: "0-Main", to: "0-Parking", body: "one" }),
				bus.send({ from: "0-Main", to: "0-Parking", body: "two" }),
				bus.send({ from: "0-Main", to: "0-Parking", body: "three" }),
			]);
			resolveDispose();
			const receipts = await sends;
			await parking;

			expect(reviverRuns).toBe(1);
			expect(receipts.every(r => r.outcome === "revived")).toBe(true);
			expect(revived.delivered.map(msg => msg.body).sort()).toEqual(["one", "three", "two"]);
			expect(bus.unreadCount("0-Parking")).toBe(0);
		});

		it("wait consumes a matching send instead of delivering it to the session", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			const waiting = bus.wait("0-Main", { from: "0-Sub" }, 1000);
			const receipt = await bus.send({ from: "0-Sub", to: "0-Main", body: "pong" });
			expect(receipt.outcome).toBe("injected");

			const msg = await waiting;
			expect(msg?.body).toBe("pong");
			// The waiter consumed the message: no session delivery, no inbox copy.
			expect(main.delivered).toEqual([]);
			expect(bus.unreadCount("0-Main")).toBe(0);
		});

		it("wait from-filter ignores messages from other senders", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const a = makeFakeSession();
			registry.register({ id: "0-A", displayName: "task", kind: "sub", session: a.session });
			const b = makeFakeSession();
			registry.register({ id: "0-B", displayName: "task", kind: "sub", session: b.session });

			const waiting = bus.wait("0-Main", { from: "0-B" }, 1000);
			await bus.send({ from: "0-A", to: "0-Main", body: "not for the waiter" });
			// The non-matching message fell through to normal delivery.
			expect(main.delivered.map(msg => msg.body)).toEqual(["not for the waiter"]);

			await bus.send({ from: "0-B", to: "0-Main", body: "for the waiter" });
			const msg = await waiting;
			expect(msg?.from).toBe("0-B");
			expect(msg?.body).toBe("for the waiter");
		});

		it("wait returns null on timeout and rejects on abort", async () => {
			// Genuine 5ms wall-clock timeout: this deliberately exercises the
			// bus's real timer path; nothing else races it.
			expect(await bus.wait("0-Main", {}, 5)).toBeNull();

			const controller = new AbortController();
			const waiting = bus.wait("0-Main", {}, 1000, controller.signal);
			controller.abort(new Error("cancelled"));
			await expect(waiting).rejects.toThrow("cancelled");
		});

		it("wait drains an already-pending mailbox message first", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			main.setError(new Error("temporarily unavailable"));
			const receipt = await bus.send({ from: "0-Sub", to: "0-Main", body: "earlier" });
			expect(receipt.outcome).toBe("failed");
			expect(bus.unreadCount("0-Main")).toBe(1);

			// Resolves from the mailbox synchronously; the timeout never fires.
			const msg = await bus.wait("0-Main", { from: "0-Sub" }, 5);
			expect(msg?.body).toBe("earlier");
			expect(bus.unreadCount("0-Main")).toBe(0);
		});

		it("inbox peeks or drains pending messages", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			main.setError(new Error("down one"));
			await bus.send({ from: "0-Sub", to: "0-Main", body: "one" });
			main.setError(new Error("down two"));
			await bus.send({ from: "0-Sub", to: "0-Main", body: "two" });

			const peeked = bus.inbox("0-Main", { peek: true });
			expect(peeked.map(msg => msg.body)).toEqual(["one", "two"]);
			expect(bus.unreadCount("0-Main")).toBe(2);

			const drained = bus.inbox("0-Main");
			expect(drained.map(msg => msg.body)).toEqual(["one", "two"]);
			expect(bus.unreadCount("0-Main")).toBe(0);
			expect(bus.inbox("0-Main")).toEqual([]);
		});

		it("wait does not leak the waiter after timeout or abort", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			// Timed-out waiter is removed: a later send goes to normal delivery.
			expect(await bus.wait("0-Main", {}, 5)).toBeNull();
			const afterTimeout = await bus.send({ from: "0-Sub", to: "0-Main", body: "after timeout" });
			expect(afterTimeout.outcome).toBe("injected");
			expect(main.delivered.map(msg => msg.body)).toEqual(["after timeout"]);
			expect(bus.unreadCount("0-Main")).toBe(0);

			// Aborted waiter is removed too: the dead waiter never consumes mail.
			const controller = new AbortController();
			const waiting = bus.wait("0-Main", {}, 1000, controller.signal);
			controller.abort(new Error("cancelled"));
			await expect(waiting).rejects.toThrow("cancelled");
			await bus.send({ from: "0-Sub", to: "0-Main", body: "after abort" });
			expect(main.delivered.map(msg => msg.body)).toEqual(["after timeout", "after abort"]);
			expect(bus.unreadCount("0-Main")).toBe(0);
		});

		it("resolves waiters in FIFO order", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			const first = bus.wait("0-Main", {}, 1000);
			const second = bus.wait("0-Main", {}, 1000);
			await bus.send({ from: "0-Sub", to: "0-Main", body: "one" });
			await bus.send({ from: "0-Sub", to: "0-Main", body: "two" });

			expect((await first)?.body).toBe("one");
			expect((await second)?.body).toBe("two");
			// Both messages were consumed by waiters, none reached the session.
			expect(main.delivered).toEqual([]);
			expect(bus.unreadCount("0-Main")).toBe(0);
		});

		it("mailbox drops the oldest message beyond the 100-message cap", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			for (let i = 0; i <= 100; i++) {
				main.setError(new Error(`down ${i}`));
				await bus.send({ from: "0-Sub", to: "0-Main", body: `msg-${i}` });
			}

			expect(bus.unreadCount("0-Main")).toBe(100);
			const pending = bus.inbox("0-Main", { peek: true });
			expect(pending[0]?.body).toBe("msg-1");
			expect(pending[pending.length - 1]?.body).toBe("msg-100");
		});

		it("send surfaces the reviver's error message when revival fails", async () => {
			registry.register({ id: "0-Parked", displayName: "task", kind: "sub", session: null, status: "parked" });
			AgentLifecycleManager.global().adopt("0-Parked", {
				idleTtlMs: 0,
				revive: async () => {
					throw new Error("revive exploded");
				},
			});

			const receipt = await bus.send({ from: "0-Main", to: "0-Parked", body: "wake up" });
			expect(receipt).toEqual({ to: "0-Parked", outcome: "failed", error: "revive exploded" });
			// Failed revival never enqueues: the message is lost, not buffered.
			expect(bus.unreadCount("0-Parked")).toBe(0);
		});

		it("wait with liveness aborts when the last running sender becomes idle after commitment", async () => {
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session, status: "running" });

			const waiting = bus.wait("0-Main", {}, 1000, undefined, { liveness: { registry, senderId: "0-Main" } });
			registry.setStatus("0-Sub", "idle");

			await expect(waiting).rejects.toThrow("no running peers remain");
		});

		it("wait with liveness aborts when a specific sender becomes idle after commitment", async () => {
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session, status: "running" });

			const waiting = bus.wait("0-Main", { from: "0-Sub" }, 1000, undefined, {
				liveness: { registry, senderId: "0-Main" },
			});
			registry.setStatus("0-Sub", "idle");

			await expect(waiting).rejects.toThrow('agent "0-Sub" is not running');
		});
	});

	describe("HubTool", () => {
		it("isIrcEnabled returns false for a top-level session that cannot spawn tasks", () => {
			const settings = Settings.isolated();
			// Depth 0 with spawning gated off: no peers exist or can be created.
			settings.set("task.maxRecursionDepth", 0);
			expect(isIrcEnabled(settings, 0)).toBe(false);
		});

		it("isIrcEnabled returns true while the task tool is available", () => {
			const settings = Settings.isolated();
			// Default task.maxRecursionDepth (2) at depth 0: task can spawn, and a
			// finished subagent must stay reachable.
			expect(isIrcEnabled(settings, 0)).toBe(true);
		});

		it("isIrcEnabled returns true for a subagent even at the recursion-depth cap", () => {
			const settings = Settings.isolated();
			// A leaf subagent cannot spawn, but its parent (and siblings) exist.
			settings.set("task.maxRecursionDepth", 2);
			expect(isIrcEnabled(settings, 2)).toBe(true);
		});

		it("returns an error result for messaging ops on a session without registry/agentId", async () => {
			const session: ToolSession = {
				cwd: "/tmp",
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated(),
			};
			const tool = new HubTool(session);
			const result = await tool.execute("call", { op: "list" });
			expect(result.isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("Peer messaging is unavailable");
		});

		it("only marks passive wait operations interruptible", () => {
			const session: ToolSession = {
				cwd: "/tmp",
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated(),
				agentRegistry: registry,
				getAgentId: () => "0-Main",
			};
			const tool = new HubTool(session);
			if (typeof tool.interruptible !== "function") throw new Error("Hub interruptibility must resolve per call");
			expect(tool.interruptible({ op: "wait" })).toBe(true);
			expect(tool.interruptible({ op: "logs", follow: true })).toBe(true);
			expect(tool.interruptible({ op: "logs" })).toBe(false);
			expect(tool.interruptible({ op: "start" })).toBe(false);
			expect(tool.interruptible({ op: "send", await: true })).toBe(false);
		});

		it("op=list defaults to live peers and reports parked counts without parked names", async () => {
			const sub = makeFakeSession();
			registry.register({
				id: "0-AuthLoader",
				displayName: "task",
				kind: "sub",
				parentId: "0-Main",
				session: sub.session,
			});
			registry.register({ id: "0-Parked", displayName: "task", kind: "sub", session: null, status: "parked" });
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			sub.setError(new Error("temporarily unavailable"));
			await bus.send({ from: "0-Main", to: "0-AuthLoader", body: "unread one" });

			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "list" });
			const details = result.details as CoordinationDetails | undefined;
			expect(details?.op).toBe("list");
			expect(details?.peers).toMatchObject([
				{ id: "0-AuthLoader", status: "running", parentId: "0-Main", unread: 1 },
			]);
			expect(details?.peers?.some(peer => peer.id === "0-Parked")).toBe(false);
			expect(details?.counts).toEqual({
				running: 1,
				idle: 0,
				parked: 1,
				shown: 1,
				truncated: 0,
			});
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain('status="parked"');
			expect(text).not.toContain("0-Parked");
		});

		it("op=list hides advisor-kind refs from the peer roster", async () => {
			const sub = makeFakeSession();
			registry.register({ id: "0-Worker", displayName: "task", kind: "sub", session: sub.session });
			registry.register({
				id: "0-Main/advisor",
				displayName: "advisor",
				kind: "advisor",
				session: null,
				status: "parked",
			});

			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "list" });
			const details = result.details as CoordinationDetails | undefined;
			const peerIds = details?.peers?.map(peer => peer.id) ?? [];
			expect(peerIds).toContain("0-Worker");
			expect(peerIds).not.toContain("0-Main/advisor");
		});

		it("op=send returns receipts immediately without waiting for a reply", async () => {
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "send", to: "0-Sub", message: "ping" });
			const details = result.details as CoordinationDetails | undefined;
			expect(result.isError).toBeFalsy();
			expect(details?.receipts).toEqual([{ to: "0-Sub", outcome: "injected" }]);
			expect(details?.waited).toBeUndefined();
			expect(sub.delivered.map(msg => msg.body)).toEqual(["ping"]);
		});

		it("op=send to=all fans out to live peers and reports per-recipient receipts", async () => {
			const a = makeFakeSession();
			registry.register({ id: "0-A", displayName: "task", kind: "sub", session: a.session });
			const b = makeFakeSession();
			b.setError(new Error("kaput"));
			registry.register({ id: "0-B", displayName: "task", kind: "sub", session: b.session });
			registry.register({ id: "0-Parked", displayName: "task", kind: "sub", session: null, status: "parked" });

			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "send", to: "all", message: "anyone there?" });
			const details = result.details as CoordinationDetails | undefined;
			// Broadcast skips parked agents; one failure does not block the other delivery.
			expect(details?.receipts).toEqual([
				{ to: "0-A", outcome: "injected" },
				{ to: "0-B", outcome: "failed", error: "kaput" },
			]);
			expect(a.delivered.map(msg => msg.body)).toEqual(["anyone there?"]);
		});

		it("op=send to=all does not relay sibling legs when the broadcast also reaches main", async () => {
			const main = makeFakeSession();
			registry.register({ id: "Main", displayName: "main", kind: "main", session: main.session });
			const b = makeFakeSession();
			registry.register({ id: "0-B", displayName: "task", kind: "sub", session: b.session });
			registry.register({ id: "0-A", displayName: "task", kind: "sub", session: makeFakeSession().session });

			const tool = new HubTool(makeToolSession(registry, "0-A"));
			await tool.execute("call-1", { op: "send", to: "all", message: "anyone there?" });

			// Main receives the broadcast directly (its own incoming card) ...
			expect(main.delivered.map(msg => msg.body)).toEqual(["anyone there?"]);
			// ... so the 0-A → 0-B sibling leg must NOT also be relayed to main: it
			// would render the identical body a second time.
			expect(main.relayed).toEqual([]);
			expect(b.delivered.map(msg => msg.body)).toEqual(["anyone there?"]);
		});

		it("op=send await=true round-trips the recipient's reply", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const sub = makeFakeSession();
			// Recipient starts idle: send wakes it, and its immediate reply must
			// still reach the pre-armed await waiter — proving `send await:true`
			// never arms the liveness auto-cancel that op:"wait" uses.
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session, status: "idle" });
			sub.onDeliver(msg => {
				// Reply synchronously during delivery: the tool has already parked
				// a future-only waiter, so the immediate reply is handed directly
				// to await:true instead of being double-buffered as unread mail.
				void bus.send({ from: "0-Sub", to: msg.from, body: "pong", replyTo: msg.id });
			});

			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "send", to: "0-Sub", message: "ping", await: true });
			const details = result.details as CoordinationDetails | undefined;
			expect(details?.waited?.body).toBe("pong");
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("pong");
		});

		it("op=send await=true ignores buffered stale mail and waits for a future reply", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });
			main.setError(new Error("temporarily unavailable"));
			await bus.send({ from: "0-Sub", to: "0-Main", body: "old buffered reply" });
			sub.onDeliver(msg => {
				void bus.send({ from: "0-Sub", to: msg.from, body: "fresh reply", replyTo: msg.id });
			});

			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "send", to: "0-Sub", message: "ping", await: true });
			const details = result.details as CoordinationDetails | undefined;
			expect(details?.waited?.body).toBe("fresh reply");
			expect(bus.inbox("0-Main").map(msg => msg.body)).toEqual(["old buffered reply"]);
		});

		it("op=send await=true reports a clean timeout when no reply arrives", async () => {
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", {
				op: "send",
				to: "0-Sub",
				message: "ping",
				// Real 5ms timeout — exercises the timeout path; no reply ever arrives.
				await: true,
				timeoutMs: 5,
			});
			expect(result.isError).toBeFalsy();
			const details = result.details as CoordinationDetails | undefined;
			expect(details?.waited).toBeNull();
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("No reply from 0-Sub");
		});

		it("op=send await=true preserves the delivery receipt when the wait is interrupted", async () => {
			// Regression: the tool is marked interruptible so `job poll` / `irc wait` return
			// early on incoming messages, but `send await:true` also runs the reply wait under
			// the same signal. If the abort lands after the message was delivered, the tool
			// must surface a successful receipt so the agent loop keeps the tool as "sent"
			// and does not report it as skipped — which would prompt a duplicate resend.
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });

			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const controller = new AbortController();
			// Abort once delivery reaches the peer, mimicking a steering / IRC interrupt
			// landing between the send resolving and the reply arriving.
			sub.onDeliver(() => controller.abort(new Error("mock interrupt")));

			const result = await tool.execute(
				"call-1",
				{ op: "send", to: "0-Sub", message: "ping", await: true, timeoutMs: 30_000 },
				controller.signal,
			);

			expect(result.isError).toBeFalsy();
			expect(sub.delivered.map(msg => msg.body)).toEqual(["ping"]);
			const details = result.details as CoordinationDetails | undefined;
			expect(details?.receipts?.[0]?.outcome).toBe("injected");
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("Send delivered");
			expect(text).toContain("interrupted");
		});

		it("op=send rejects await with to=all and self-sends", async () => {
			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const broadcast = await tool.execute("call-1", { op: "send", to: "all", message: "x", await: true });
			expect(broadcast.isError).toBe(true);
			const self = await tool.execute("call-2", { op: "send", to: "0-Main", message: "x" });
			expect(self.isError).toBe(true);
			const selfText = self.content[0]?.type === "text" ? self.content[0].text : "";
			expect(selfText).toContain("Cannot send a message to yourself.");
		});

		it("op=send returns a failed receipt for unknown targets", async () => {
			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "send", to: "0-Ghost", message: "ping" });
			expect(result.isError).toBe(true);
			const details = result.details as CoordinationDetails | undefined;
			expect(details?.receipts?.[0]?.outcome).toBe("failed");
		});

		it("op=wait returns a clean non-error timeout result", async () => {
			const fake = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "sub", kind: "sub", session: fake.session, status: "running" });
			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "wait", timeoutMs: 5 });
			expect(result.isError).toBeFalsy();
			const details = result.details as CoordinationDetails | undefined;
			expect(details?.waited).toBeNull();
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("No message");
		});

		it("op=wait returns a clean result if no active agents exist", async () => {
			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "wait", timeoutMs: 5 });
			expect(result.isError).toBeFalsy();
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("No running background jobs to wait for.");
		});

		it("op=wait returns an error if the requested specific 'from' agent is not active", async () => {
			registry.register({ id: "0-Sub", displayName: "sub", kind: "sub", session: null, status: "parked" });
			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const result = await tool.execute("call-1", { op: "wait", from: "0-Sub", timeoutMs: 5 });
			expect(result.isError).toBe(true);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain('agent "0-Sub" is not running');
		});

		it("op=wait consumes a pending IRC aside before honoring a queued interrupt abort", async () => {
			const { session } = createRealSession();
			sessions.push(session);
			Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
			registry.register({ id: "0-Running", displayName: "task", kind: "sub", session });

			const delivery = await session.deliverIrcMessage({
				id: "msg-wait-pending",
				from: "0-Main",
				to: "0-Running",
				body: "queued interrupt note",
				ts: Date.now(),
			});
			expect(delivery).toBe("injected");

			const tool = new HubTool(makeToolSession(registry, "0-Running"));
			const controller = new AbortController();
			controller.abort(new Error("queued IRC interrupt"));
			const result = await tool.execute("call-1", { op: "wait", timeoutMs: 30_000 }, controller.signal);

			expect(result.isError).toBeFalsy();
			const details = result.details as CoordinationDetails | undefined;
			expect(details?.waited).toMatchObject({
				id: "msg-wait-pending",
				from: "0-Main",
				to: "0-Running",
				body: "queued interrupt note",
			});
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("queued interrupt note");

			const empty = await tool.execute("call-2", { op: "inbox" });
			const emptyDetails = empty.details as CoordinationDetails | undefined;
			expect(emptyDetails?.inbox).toEqual([]);
		});

		it("op=inbox drains IRC asides that arrived while the caller was running", async () => {
			const { session } = createRealSession();
			sessions.push(session);
			Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
			registry.register({ id: "0-Running", displayName: "task", kind: "sub", session });

			const delivery = await session.deliverIrcMessage({
				id: "msg-running",
				from: "0-Main",
				to: "0-Running",
				body: "parallel note",
				ts: Date.now(),
			});
			expect(delivery).toBe("injected");

			const tool = new HubTool(makeToolSession(registry, "0-Running"));
			const result = await tool.execute("call-1", { op: "inbox" });
			const details = result.details as CoordinationDetails | undefined;
			expect(details?.inbox?.map((msg: IrcMessage) => msg.body)).toEqual(["parallel note"]);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("parallel note");
		});

		it("op=inbox peek surfaces a pending IRC aside and prevents it auto-injecting", async () => {
			const { session } = createRealSession();
			sessions.push(session);
			Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
			registry.register({ id: "0-Running", displayName: "task", kind: "sub", session });

			await session.deliverIrcMessage({
				id: "msg-peek",
				from: "0-Main",
				to: "0-Running",
				body: "peeked note",
				ts: Date.now(),
			});

			const tool = new HubTool(makeToolSession(registry, "0-Running"));
			const peeked = await tool.execute("call-1", { op: "inbox", peek: true });
			const peekedDetails = peeked.details as CoordinationDetails | undefined;
			expect(peekedDetails?.inbox?.map((msg: IrcMessage) => msg.body)).toEqual(["peeked note"]);

			// The peek surfaced the body via the tool result, so the aside-channel
			// copy must NOT also be auto-injected at the next step: a second drain
			// returns nothing (the pending aside was consumed out of the
			const second = await tool.execute("call-2", { op: "inbox" });
			const secondDetails = second.details as CoordinationDetails | undefined;
			expect(secondDetails?.inbox).toEqual([]);
		});

		it("op=inbox drains the caller's mailbox", async () => {
			const main = makeFakeSession();
			registry.register({ id: "0-Main", displayName: "main", kind: "main", session: main.session });
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });
			main.setError(new Error("temporarily unavailable"));
			await bus.send({ from: "0-Sub", to: "0-Main", body: "fyi" });

			const tool = new HubTool(makeToolSession(registry, "0-Main"));
			const peeked = await tool.execute("call-1", { op: "inbox", peek: true });
			const peekedDetails = peeked.details as CoordinationDetails | undefined;
			expect(peekedDetails?.inbox?.map((msg: IrcMessage) => msg.body)).toEqual(["fyi"]);
			const drained = await tool.execute("call-2", { op: "inbox" });
			const drainedDetails = drained.details as CoordinationDetails | undefined;
			expect(drainedDetails?.inbox?.map((msg: IrcMessage) => msg.body)).toEqual(["fyi"]);
			const empty = await tool.execute("call-3", { op: "inbox" });
			const emptyDetails = empty.details as CoordinationDetails | undefined;
			expect(emptyDetails?.inbox).toEqual([]);
		});
	});

	describe("AgentSession.deliverIrcMessage", () => {
		it("wakes an idle session with a real turn and emits the irc_message event", async () => {
			const { session } = createRealSession();
			sessions.push(session);
			const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
			const ircEvent = new Promise<AgentSessionEvent>(resolve => {
				session.subscribe(event => {
					if (event.type === "irc_message") resolve(event);
				});
			});

			const outcome = await session.deliverIrcMessage({
				id: "msg-1",
				from: "0-Peer",
				to: "0-Me",
				body: "wake up",
				ts: Date.now(),
			});
			expect(outcome).toBe("woken");
			expect(promptSpy).toHaveBeenCalledTimes(1);
			// The idle wake routes through #wakeForIrc, which batches records into one prompt —
			// even a lone incoming message is delivered as a one-element array.
			const prompted = (promptSpy.mock.calls[0]![0] as unknown as CustomMessage[])[0];
			expect(prompted).toMatchObject({ role: "custom", customType: "irc:incoming" });
			expect(prompted.details).toMatchObject({ id: "msg-1", from: "0-Peer", message: "wake up" });

			const event = await ircEvent;
			expect(event.type).toBe("irc_message");
		});

		it("queues peer IRC as an interrupt while a turn is streaming", async () => {
			const { session } = createRealSession();
			sessions.push(session);
			const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
			Object.defineProperty(session, "isStreaming", { value: true, configurable: true });

			const outcome = await session.deliverIrcMessage({
				id: "msg-2",
				from: "0-Peer",
				to: "0-Me",
				body: "mid-turn note",
				ts: Date.now(),
			});
			expect(outcome).toBe("injected");
			expect(promptSpy).not.toHaveBeenCalled();
			expect(await session.agent.hasIrcInterrupts?.()).toBe(true);
		});

		it("queues parent IRC as steering while a subagent turn is streaming", async () => {
			const { session } = createRealSession();
			sessions.push(session);
			const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
			Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
			registry.register({ id: "0-Child", displayName: "task", kind: "sub", parentId: "Main", session });

			const outcome = await session.deliverIrcMessage({
				id: "msg-parent",
				from: "Main",
				to: "0-Child",
				body: "change approach",
				ts: Date.now(),
			});
			const queued = session.agent.peekSteeringQueue();
			expect(outcome).toBe("injected");
			expect(promptSpy).not.toHaveBeenCalled();
			expect(session.agent.hasIrcInterrupts?.()).toBe(false);
			expect(queued).toHaveLength(1);
			const parentSteer = queued[0];
			expect(parentSteer?.role).toBe("user");
			if (parentSteer?.role !== "user") throw new Error("expected queued parent IRC steer");
			expect(parentSteer.content).toContain("change approach");
		});

		it("auto-replies via an ephemeral side turn when the sender awaits and async execution is disabled", async () => {
			const { session } = createRealSession({ "async.enabled": false });
			sessions.push(session);
			registry.register({ id: "Main", displayName: "main", kind: "main", session });
			const sub = makeFakeSession();
			registry.register({ id: "0-Sub", displayName: "task", kind: "sub", session: sub.session });
			Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
			const ephemeralSpy = vi
				.spyOn(session, "runEphemeralTurn")
				.mockResolvedValue({ replyText: "auto answer", assistantMessage: {} as never });
			const autoReplyEvent = new Promise<CustomMessage>(resolve => {
				session.subscribe(event => {
					if (event.type === "irc_message" && event.message.customType === "irc:autoreply") {
						resolve(event.message);
					}
				});
			});

			// The sender parks a waiter (the `await: true` path), then sends with
			// the expectsReply hint — exactly what the irc tool does.
			const waiting = bus.wait("0-Sub", { from: "Main" }, 1000);
			const receipt = await bus.send(
				{ from: "0-Sub", to: "Main", body: "which PR did you mean?" },
				{ expectsReply: true },
			);
			expect(receipt).toEqual({ to: "Main", outcome: "injected" });

			// The side-channel reply resolves the sender's waiter as a real bus
			// message threaded to the original send.
			const reply = await waiting;
			expect(reply?.from).toBe("Main");
			expect(reply?.body).toBe("auto answer");
			expect(reply?.replyTo).toBeTruthy();
			expect(ephemeralSpy.mock.calls[0]?.[0]?.promptText).toContain("which PR did you mean?");

			// The recipient records what was said on its behalf.
			const record = await autoReplyEvent;
			expect(record.details).toMatchObject({ to: "0-Sub", body: "auto answer" });
		});

		it("does not auto-reply when async execution is enabled or the sender does not await", async () => {
			const enabled = createRealSession({ "async.enabled": true });
			sessions.push(enabled.session);
			registry.register({ id: "Main", displayName: "main", kind: "main", session: enabled.session });
			Object.defineProperty(enabled.session, "isStreaming", { value: true, configurable: true });
			const enabledSpy = vi
				.spyOn(enabled.session, "runEphemeralTurn")
				.mockResolvedValue({ replyText: "nope", assistantMessage: {} as never });
			const awaited = await bus.send({ from: "0-Sub", to: "Main", body: "q?" }, { expectsReply: true });
			expect(awaited.outcome).toBe("injected");
			expect(enabledSpy).not.toHaveBeenCalled();

			const disabled = createRealSession({ "async.enabled": false });
			sessions.push(disabled.session);
			registry.register({ id: "Main2", displayName: "main", kind: "main", session: disabled.session });
			Object.defineProperty(disabled.session, "isStreaming", { value: true, configurable: true });
			const disabledSpy = vi
				.spyOn(disabled.session, "runEphemeralTurn")
				.mockResolvedValue({ replyText: "nope", assistantMessage: {} as never });
			const fireAndForget = await bus.send({ from: "0-Sub", to: "Main2", body: "fyi" });
			expect(fireAndForget.outcome).toBe("injected");
			expect(disabledSpy).not.toHaveBeenCalled();
		});
	});
});
