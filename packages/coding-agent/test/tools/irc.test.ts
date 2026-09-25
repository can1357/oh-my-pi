import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { type IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { IrcBridge } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

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
}

function makeFakeSession(): FakeSession {
	let outcome: "injected" | "woken" = "injected";
	let nextError: Error | null = null;
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
	};
}

function createRealSession(overrides: Record<string, unknown> = {}): {
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
		vi.useRealTimers();
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
			expect(bus.take("0-Sub")).toBeUndefined();
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
			expect((await bus.wait("0-Sub", {}, 5))?.body).toBe("ping");
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
			expect(bus.take("0-Parking")).toBeUndefined();
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
			expect(bus.take("0-Parking")).toBeUndefined();

			resolveDispose();
			const receipt = await sendPromise;
			await parking;

			expect(receipt.outcome).toBe("revived");
			expect(revived.delivered.map(msg => msg.body)).toEqual(["after park"]);
			expect(reviverRuns).toBe(1);
			expect(registry.get("0-Parking")?.session).toBe(revived.session);
			expect(bus.take("0-Parking")).toBeUndefined();
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
			expect(bus.take("0-Parking")).toBeUndefined();
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
			expect(bus.take("0-Main")).toBeUndefined();
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

			// Resolves from the mailbox synchronously; the timeout never fires.
			const msg = await bus.wait("0-Main", { from: "0-Sub" }, 5);
			expect(msg?.body).toBe("earlier");
			expect(bus.take("0-Main")).toBeUndefined();
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
			expect(bus.take("0-Main")).toBeUndefined();

			// Aborted waiter is removed too: the dead waiter never consumes mail.
			const controller = new AbortController();
			const waiting = bus.wait("0-Main", {}, 1000, controller.signal);
			controller.abort(new Error("cancelled"));
			await expect(waiting).rejects.toThrow("cancelled");
			await bus.send({ from: "0-Sub", to: "0-Main", body: "after abort" });
			expect(main.delivered.map(msg => msg.body)).toEqual(["after timeout", "after abort"]);
			expect(bus.take("0-Main")).toBeUndefined();
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
			expect(bus.take("0-Main")).toBeUndefined();
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

			expect(bus.take("0-Main")?.body).toBe("msg-1");
			for (let i = 2; i < 100; i++) bus.take("0-Main");
			expect(bus.take("0-Main")?.body).toBe("msg-100");
			expect(bus.take("0-Main")).toBeUndefined();
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
			expect(bus.take("0-Parked")).toBeUndefined();
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
		it("defers an idle wake while a pooled yield contract is installed", async () => {
			const { session } = createRealSession();
			sessions.push(session);
			vi.spyOn(session, "refreshBaseSystemPrompt").mockResolvedValue(undefined);
			const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
			let observations = 0;
			session.setIrcWakeTurnObserver(() => () => {
				observations++;
			});
			await session.setWorkPoolYieldItems([{ id: "pool#1", index: 1 }]);
			const queueDeferredWake = vi.spyOn(IrcBridge.prototype, "queueDeferredWake");
			queueDeferredWake.mockClear();
			const outcome = await session.deliverIrcMessage({
				id: "msg-pooled",
				from: "0-Peer",
				to: "0-Me",
				body: "status?",
				ts: Date.now(),
			});
			expect(outcome).toBe("woken");
			for (let i = 0; i < 10; i++) await Promise.resolve();
			// An ordinary wake under pooled items would emit keyed yields against
			// another turn's items, so no turn starts while the contract is pooled.
			expect(promptSpy).not.toHaveBeenCalled();
			// The deferral must not re-arm itself through the idle drain: the
			// records stay parked until the contract clears instead of chaining
			// wake observers indefinitely.
			// Yield the event loop repeatedly: a re-armed chain would schedule more
			// parking calls per turn of the loop, while fixed code schedules
			// nothing further, so extra yields cannot flake this assertion.
			for (let i = 0; i < 20; i++) {
				const { promise, resolve } = Promise.withResolvers<void>();
				setImmediate(resolve);
				await promise;
			}
			expect(queueDeferredWake).toHaveBeenCalledTimes(1);
			// No turn ran, so the wake observer must never have attached: otherwise
			// it would finalize the next turn's output as this wake's reply.
			expect(observations).toBe(0);
			// Clearing publishes the ordinary contract; the resume drain must turn
			// the parked record into a monitored wake with no later message.
			promptSpy.mockClear();
			await session.setWorkPoolYieldItems([]);
			for (let i = 0; i < 10; i++) await Promise.resolve();
			for (let i = 0; i < 20; i++) {
				const { promise, resolve } = Promise.withResolvers<void>();
				setImmediate(resolve);
				await promise;
			}
			expect(promptSpy).toHaveBeenCalled();
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
	});
});
