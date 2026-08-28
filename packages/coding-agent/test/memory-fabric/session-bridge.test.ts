import { describe, expect, it } from "bun:test";
import {
	DEFAULT_CHECKPOINT_DEADLINE_MS,
	DEFAULT_NORMAL_DEADLINE_MS,
	type MemoryLifecycleTelemetry,
	MemorySessionBridge,
	type MemorySessionBridgeOptions,
	type SequencedSessionEventBus,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/session-integration/bridge";
import type {
	AfterToolCallEvent,
	BeforeCompactionEvent,
	BeforeModelEvent,
	BeforeToolCallEvent,
	MemoryContextPacket,
	MemoryLifecycleEvent,
	MemorySessionScope,
	SessionStartEvent,
	SessionStopEvent,
	UserPromptEvent,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/session-integration/types";

const SCOPE: MemorySessionScope = { projectId: "proj", sessionId: "sess", cwd: "/repo" };

const PACKET: MemoryContextPacket = {
	id: "packet-1",
	text: "recalled",
	memoryIds: ["m1"],
	tokenEstimate: 12,
	createdAt: 0,
	latencyMs: 1,
};

type Listener = (event: MemoryLifecycleEvent) => Promise<void>;

/** A bus that records what it was given and can be made to fail. */
class FakeBus implements SequencedSessionEventBus {
	readonly events: MemoryLifecycleEvent[] = [];
	emitError: Error | null = null;
	#sequence = 0;
	readonly #listeners = new Set<Listener>();

	nextSequence(): number {
		return ++this.#sequence;
	}

	async emit(event: MemoryLifecycleEvent): Promise<void> {
		if (this.emitError) throw this.emitError;
		this.events.push(event);
		for (const listener of this.#listeners) await listener(event);
	}

	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	listenerCount(): number {
		return this.#listeners.size;
	}
}

function setup(overrides: Partial<MemorySessionBridgeOptions> = {}) {
	const bus = new FakeBus();
	const telemetry: MemoryLifecycleTelemetry[] = [];
	let ids = 0;
	const bridge = new MemorySessionBridge({
		scope: SCOPE,
		eventBus: bus,
		participant: {},
		newId: () => `id-${++ids}`,
		...overrides,
	});
	bridge.onTelemetry(record => telemetry.push(record));
	return { bridge, bus, telemetry };
}

/** A promise that never settles, for exercising the deadline. */
function never(): Promise<never> {
	return new Promise<never>(() => {});
}

describe("MemorySessionBridge event construction", () => {
	it("publishes one well-formed event per lifecycle call", async () => {
		const { bridge, bus } = setup();

		await bridge.sessionStart(true);
		await bridge.userPrompt("hello");
		await bridge.beforeModel("hello", "active");
		await bridge.beforeToolCall("write_file", { path: "a.ts" });
		await bridge.afterToolCall("write_file", { path: "a.ts" }, { ok: true }, true, 42);
		await bridge.beforeCompaction("token-pressure");
		await bridge.resume();
		await bridge.stop("completed");

		expect(bus.events.map(event => event.type)).toEqual([
			"session_start",
			"user_prompt",
			"before_model",
			"before_tool_call",
			"after_tool_call",
			"before_compaction",
			"session_resume",
			"session_stop",
		]);
	});

	it("stamps every event with the session scope", async () => {
		const { bridge, bus } = setup();

		await bridge.sessionStart(false);
		await bridge.stop("done");

		for (const event of bus.events) {
			expect(event.scope).toBe(SCOPE);
		}
	});

	it("draws a monotonic sequence from the bus and mirrors it onto the event", async () => {
		const { bridge, bus } = setup();

		await bridge.sessionStart(false);
		await bridge.userPrompt("hi");
		await bridge.stop("done");

		expect(bus.events.map(event => event.sequence)).toEqual([1, 2, 3]);
		for (const event of bus.events) {
			expect(event.metadata.sequence).toBe(event.sequence);
		}
	});

	it("attributes each event to the right origin", async () => {
		const { bridge, bus } = setup();

		await bridge.userPrompt("hi");
		await bridge.afterToolCall("read", {}, {}, true, 1);
		await bridge.beforeModel("hi");

		expect(bus.events.map(event => event.metadata.origin)).toEqual(["user", "tool", "main-agent"]);
	});

	it("carries the payload of each event", async () => {
		const { bridge, bus } = setup();

		await bridge.sessionStart(true);
		await bridge.userPrompt("what changed?");
		await bridge.beforeToolCall("bash", { cmd: "ls" });
		await bridge.afterToolCall("bash", { cmd: "ls" }, "a.ts\n", false, 7);
		await bridge.beforeCompaction("token-pressure");
		await bridge.stop("cancelled");

		expect((bus.events[0] as SessionStartEvent).resumed).toBe(true);
		expect((bus.events[1] as UserPromptEvent).text).toBe("what changed?");
		expect((bus.events[2] as BeforeToolCallEvent).toolName).toBe("bash");
		expect((bus.events[2] as BeforeToolCallEvent).input).toEqual({ cmd: "ls" });

		const after = bus.events[3] as AfterToolCallEvent;
		expect(after.input).toEqual({ cmd: "ls" });
		expect(after.output).toBe("a.ts\n");
		expect(after.success).toBe(false);
		expect(after.durationMs).toBe(7);

		expect((bus.events[4] as BeforeCompactionEvent).reason).toBe("token-pressure");
		expect((bus.events[5] as SessionStopEvent).reason).toBe("cancelled");
	});

	it("omits activeContextText entirely when none is supplied", async () => {
		const { bridge, bus } = setup();

		await bridge.beforeModel("hi");

		expect("activeContextText" in (bus.events[0] as BeforeModelEvent)).toBe(false);
	});

	it("includes activeContextText when supplied", async () => {
		const { bridge, bus } = setup();

		await bridge.beforeModel("hi", "the active context");

		expect((bus.events[0] as BeforeModelEvent).activeContextText).toBe("the active context");
	});

	it("uses the injected clock and id source", async () => {
		const { bridge, bus } = setup({ now: () => 4242 });

		await bridge.sessionStart(false);

		expect(bus.events[0].metadata.timestamp).toBe(4242);
		expect(bus.events[0].metadata.correlationId).toBe("id-1");
	});

	it("defaults depth to zero and omits the optional correlation fields", async () => {
		const { bridge, bus } = setup();

		await bridge.sessionStart(false);

		const metadata = bus.events[0].metadata;
		expect(metadata.depth).toBe(0);
		expect("causationId" in metadata).toBe(false);
		expect("turnId" in metadata).toBe(false);
		expect("toolCallId" in metadata).toBe(false);
	});

	it("threads caller-supplied envelope overrides onto the event", async () => {
		const { bridge, bus } = setup();

		await bridge.beforeToolCall(
			"write_file",
			{},
			{ correlationId: "corr", causationId: "cause", turnId: "turn", toolCallId: "call", depth: 2 },
		);

		const metadata = bus.events[0].metadata;
		expect(metadata.correlationId).toBe("corr");
		expect(metadata.causationId).toBe("cause");
		expect(metadata.turnId).toBe("turn");
		expect(metadata.toolCallId).toBe("call");
		expect(metadata.depth).toBe(2);
	});
});

describe("MemorySessionBridge participant dispatch", () => {
	it("invokes each hook with the event it published", async () => {
		const seen: string[] = [];
		const participant = {
			participantName: "recorder",
			onSessionStart: (event: SessionStartEvent) => {
				seen.push(event.type);
			},
			onUserPrompt: (event: UserPromptEvent) => {
				seen.push(event.type);
			},
			prepareContext: (event: BeforeModelEvent) => {
				seen.push(event.type);
				return null;
			},
			beforeToolCall: (event: BeforeToolCallEvent) => {
				seen.push(event.type);
				return null;
			},
			afterToolCall: (event: AfterToolCallEvent) => {
				seen.push(event.type);
			},
			checkpoint: (event: BeforeCompactionEvent) => {
				seen.push(event.type);
				return null;
			},
			onResume: () => {
				seen.push("session_resume");
			},
			stop: (event: SessionStopEvent) => {
				seen.push(event.type);
			},
		};
		const { bridge } = setup({ participant });

		await bridge.sessionStart(false);
		await bridge.userPrompt("hi");
		await bridge.beforeModel("hi");
		await bridge.beforeToolCall("t", {});
		await bridge.afterToolCall("t", {}, {}, true, 1);
		await bridge.beforeCompaction("r");
		await bridge.resume();
		await bridge.stop("done");

		expect(seen).toEqual([
			"session_start",
			"user_prompt",
			"before_model",
			"before_tool_call",
			"after_tool_call",
			"before_compaction",
			"session_resume",
			"session_stop",
		]);
	});

	it("returns what a value-producing hook produced", async () => {
		const { bridge } = setup({ participant: { prepareContext: () => PACKET } });

		expect(await bridge.beforeModel("hi")).toBe(PACKET);
	});

	it("awaits a hook that returns a promise", async () => {
		const participant = { prepareContext: async () => PACKET };
		const { bridge } = setup({ participant });

		expect(await bridge.beforeModel("hi")).toBe(PACKET);
	});

	it("falls back to the neutral value when the hook is absent", async () => {
		const { bridge } = setup({ participant: {} });

		expect(await bridge.beforeModel("hi")).toBeNull();
		expect(await bridge.beforeToolCall("t", {})).toBeNull();
		expect(await bridge.beforeCompaction("r")).toBeNull();
		expect(await bridge.sessionStart(false)).toBeUndefined();
	});

	it("still publishes the event when the hook is absent", async () => {
		const { bridge, bus } = setup({ participant: {} });

		await bridge.beforeModel("hi");

		expect(bus.events).toHaveLength(1);
	});

	it("treats an undefined result as the neutral value", async () => {
		const participant = { prepareContext: () => undefined as unknown as MemoryContextPacket | null };
		const { bridge } = setup({ participant });

		expect(await bridge.beforeModel("hi")).toBeNull();
	});
});

describe("MemorySessionBridge failure containment", () => {
	it("degrades to the neutral value when a hook rejects", async () => {
		const participant = {
			prepareContext: async () => {
				throw new Error("backend down");
			},
		};
		const { bridge, telemetry } = setup({ participant });

		expect(await bridge.beforeModel("hi")).toBeNull();
		expect(telemetry[0].outcome).toBe("failed");
	});

	it("contains a hook that throws synchronously", async () => {
		// The hook is invoked through a thunk, so a synchronous throw is caught
		// here rather than escaping past the deadline wrapper into the turn.
		const participant = {
			prepareContext: (): MemoryContextPacket | null => {
				throw new Error("sync boom");
			},
		};
		const { bridge, telemetry } = setup({ participant });

		expect(await bridge.beforeModel("hi")).toBeNull();
		expect(telemetry[0].outcome).toBe("failed");
	});

	it("degrades to the neutral value when a hook exceeds its deadline", async () => {
		const participant = { prepareContext: () => never() };
		const { bridge, telemetry } = setup({ participant, normalDeadlineMs: 5 });

		expect(await bridge.beforeModel("hi")).toBeNull();
		expect(telemetry[0].outcome).toBe("timeout");
	});

	it("reports a timeout distinctly from a failure", async () => {
		const slow = setup({ participant: { checkpoint: () => never() }, checkpointDeadlineMs: 5 });
		const broken = setup({
			participant: {
				checkpoint: () => {
					throw new Error("nope");
				},
			},
		});

		await slow.bridge.beforeCompaction("r");
		await broken.bridge.beforeCompaction("r");

		expect(slow.telemetry[0].outcome).toBe("timeout");
		expect(broken.telemetry[0].outcome).toBe("failed");
	});

	it("re-raises instead of degrading when failOpen is false", async () => {
		const participant = {
			prepareContext: () => {
				throw new Error("backend down");
			},
		};
		const { bridge } = setup({ participant, failOpen: false });

		await expect(bridge.beforeModel("hi")).rejects.toThrow("backend down");
	});

	it("still reports telemetry on the fail-closed path", async () => {
		const participant = {
			prepareContext: () => {
				throw new Error("backend down");
			},
		};
		const { bridge, telemetry } = setup({ participant, failOpen: false });

		await bridge.beforeModel("hi").catch(() => {});

		expect(telemetry).toHaveLength(1);
		expect(telemetry[0].outcome).toBe("failed");
	});

	it("survives a bus that throws on emit and still runs the hook", async () => {
		let ran = false;
		const participant = {
			onSessionStart: () => {
				ran = true;
			},
		};
		const { bridge, bus } = setup({ participant });
		bus.emitError = new Error("bus exploded");

		await bridge.sessionStart(false);

		expect(ran).toBe(true);
	});
});

describe("MemorySessionBridge deadlines", () => {
	it("gives checkpoints a longer budget than interactive hooks", () => {
		expect(DEFAULT_CHECKPOINT_DEADLINE_MS).toBeGreaterThan(DEFAULT_NORMAL_DEADLINE_MS);
	});

	it("holds a checkpoint to the checkpoint budget, not the interactive one", async () => {
		// The normal budget would have expired long ago; the checkpoint budget
		// is what governs here, so the slow capsule still lands.
		const participant = {
			checkpoint: async () => {
				await Bun.sleep(20);
				return { id: "c1", text: "capsule", createdAt: 0 };
			},
		};
		const { bridge } = setup({ participant, normalDeadlineMs: 1, checkpointDeadlineMs: 500 });

		const capsule = await bridge.beforeCompaction("token-pressure");

		expect(capsule?.id).toBe("c1");
	});
});

describe("MemorySessionBridge telemetry", () => {
	it("emits one record per hook, joined to the event by sequence", async () => {
		const { bridge, bus, telemetry } = setup();

		await bridge.sessionStart(false);
		await bridge.userPrompt("hi");

		expect(telemetry).toHaveLength(2);
		expect(telemetry.map(record => record.sequence)).toEqual(bus.events.map(event => event.sequence));
		expect(telemetry.map(record => record.hook)).toEqual(["session_start", "user_prompt"]);
		expect(telemetry.every(record => record.event === "memory.lifecycle")).toBe(true);
	});

	it("names the participant it drove", async () => {
		const { bridge, telemetry } = setup({ participant: { participantName: "guardian" } });

		await bridge.sessionStart(false);

		expect(telemetry[0].participant).toBe("guardian");
		expect(bridge.participantName).toBe("guardian");
	});

	it("falls back to a placeholder name for an anonymous participant", async () => {
		const { bridge, telemetry } = setup({ participant: {} });

		await bridge.sessionStart(false);

		expect(bridge.participantName).toBe("unknown");
		expect(telemetry[0].participant).toBe("unknown");
	});

	it("measures duration with the injected clock", async () => {
		let clock = 1000;
		const participant = {
			onSessionStart: () => {
				clock += 25;
			},
		};
		const { bridge, telemetry } = setup({ participant, now: () => clock });

		await bridge.sessionStart(false);

		expect(telemetry[0].durationMs).toBe(25);
	});

	it("propagates the correlation fields onto the telemetry record", async () => {
		const { bridge, telemetry } = setup();

		await bridge.beforeToolCall("t", {}, { correlationId: "corr", causationId: "cause", toolCallId: "call" });

		expect(telemetry[0].correlationId).toBe("corr");
		expect(telemetry[0].causationId).toBe("cause");
		expect(telemetry[0].toolCallId).toBe("call");
	});

	it("stops delivering once unsubscribed", async () => {
		const { bridge } = setup();
		const received: MemoryLifecycleTelemetry[] = [];
		const unsubscribe = bridge.onTelemetry(record => received.push(record));

		await bridge.sessionStart(false);
		unsubscribe();
		await bridge.stop("done");

		expect(received).toHaveLength(1);
	});

	it("isolates a throwing telemetry listener", async () => {
		const { bridge } = setup();
		const received: MemoryLifecycleTelemetry[] = [];
		bridge.onTelemetry(() => {
			throw new Error("listener exploded");
		});
		bridge.onTelemetry(record => received.push(record));

		await bridge.sessionStart(false);

		expect(received).toHaveLength(1);
	});
});
