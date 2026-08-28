import { describe, expect, it } from "bun:test";
import * as eventBus from "@oh-my-pi/pi-coding-agent/memory-fabric/guardian/event-bus";
import { GuardianObserveModeEngine } from "@oh-my-pi/pi-coding-agent/memory-fabric/guardian/observe-mode";

async function noopListener(): Promise<void> {
	await Promise.resolve();
}

/** Swap out console.error for the duration of `fn`, returning what it captured. */
async function captureConsoleError(fn: () => Promise<void>): Promise<string[]> {
	const captured: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		captured.push(args.map(String).join(" "));
	};
	try {
		await fn();
	} finally {
		console.error = original;
	}
	return captured;
}

describe("SessionEventBus", () => {
	it("delivers an event to a subscribed listener", async () => {
		const bus = new eventBus.SessionEventBus();
		const seen: string[] = [];

		bus.on("session-start", async event => {
			seen.push(event.sessionId);
		});
		bus.emit({
			type: "session-start",
			sessionId: "s1",
			projectId: "p1",
			timestamp: new Date().toISOString(),
		});
		await Bun.sleep(1);

		expect(seen).toEqual(["s1"]);
	});

	it("only delivers to listeners registered for the emitted type", async () => {
		const bus = new eventBus.SessionEventBus();
		let starts = 0;
		let stops = 0;

		bus.on("session-start", async () => {
			starts++;
		});
		bus.on("session-stop", async () => {
			stops++;
		});
		bus.emit({
			type: "session-stop",
			sessionId: "s1",
			reason: "completed",
			timestamp: new Date().toISOString(),
		});
		await Bun.sleep(1);

		expect(starts).toBe(0);
		expect(stops).toBe(1);
	});

	it("stops delivery once the unsubscribe handle is called", async () => {
		const bus = new eventBus.SessionEventBus();
		let calls = 0;

		const off = bus.on("idle", async () => {
			calls++;
		});
		expect(bus.listenerCount("idle")).toBe(1);

		off();
		expect(bus.listenerCount("idle")).toBe(0);

		bus.emit({ type: "idle", sessionId: "s1", idleDurationMs: 10, timestamp: new Date().toISOString() });
		await Bun.sleep(1);

		expect(calls).toBe(0);
	});

	it("delivers a `once` subscription exactly one time", async () => {
		const bus = new eventBus.SessionEventBus();
		let calls = 0;

		bus.once("idle", async () => {
			calls++;
		});
		const event = {
			type: "idle",
			sessionId: "s1",
			idleDurationMs: 10,
			timestamp: new Date().toISOString(),
		} as const;

		bus.emit(event);
		await Bun.sleep(1);
		bus.emit(event);
		await Bun.sleep(1);

		expect(calls).toBe(1);
		expect(bus.listenerCount("idle")).toBe(0);
	});

	it("isolates a rejecting listener so siblings still run and emit never throws", async () => {
		const bus = new eventBus.SessionEventBus();
		let sibling = 0;

		bus.on("idle", async () => {
			throw new Error("listener blew up");
		});
		bus.on("idle", async () => {
			sibling++;
		});

		const logged = await captureConsoleError(async () => {
			expect(() => {
				bus.emit({
					type: "idle",
					sessionId: "s1",
					idleDurationMs: 10,
					timestamp: new Date().toISOString(),
				});
			}).not.toThrow();
			await Bun.sleep(5);
		});

		expect(sibling).toBe(1);
		expect(logged.length).toBe(1);
		expect(logged[0] ?? "").toContain("idle");
	});

	it("emitting an event with no listeners is a no-op", () => {
		const bus = new eventBus.SessionEventBus();
		expect(() => {
			bus.emit({ type: "idle", sessionId: "s1", idleDurationMs: 1, timestamp: "t" });
		}).not.toThrow();
	});

	it("removeAllListeners clears one type or every type", async () => {
		const bus = new eventBus.SessionEventBus();
		bus.on("idle", noopListener);
		bus.on("resume", noopListener);

		bus.removeAllListeners("idle");
		expect(bus.listenerCount("idle")).toBe(0);
		expect(bus.listenerCount("resume")).toBe(1);

		bus.removeAllListeners();
		expect(bus.listenerCount("resume")).toBe(0);
	});
});

describe("extractEntitiesFromPrompt", () => {
	it("extracts file paths, including quoted ones", () => {
		const entities = eventBus.extractEntitiesFromPrompt('open src/main.ts and then "lib/util.js" please');
		expect(entities.files).toContain("src/main.ts");
		expect(entities.files).toContain("lib/util.js");
	});

	it("does not mistake a version number for a file path", () => {
		const entities = eventBus.extractEntitiesFromPrompt("we are pinned to 1.2.3 right now");
		expect(entities.files).not.toContain("1.2.3");
	});

	it("extracts camelCase, PascalCase and snake_case symbols", () => {
		const entities = eventBus.extractEntitiesFromPrompt("call parseConfig on MemoryFabric using max_retry_count");
		expect(entities.symbols).toContain("parseConfig");
		expect(entities.symbols).toContain("MemoryFabric");
		expect(entities.symbols).toContain("max_retry_count");
	});

	it("extracts error lines and truncates them to 200 characters", () => {
		const entities = eventBus.extractEntitiesFromPrompt(`Error: ${"x".repeat(400)}`);
		expect(entities.errors.length).toBe(1);
		expect(entities.errors[0]?.length).toBe(200);
	});

	it("extracts tool commands", () => {
		const entities = eventBus.extractEntitiesFromPrompt("please run bun test then git commit");
		expect(entities.commands).toContain("bun test");
		expect(entities.commands).toContain("git commit");
	});

	it("caps every result list", () => {
		const many = Array.from({ length: 60 }, (_, i) => `src/file${i}.ts`).join(" ");
		const entities = eventBus.extractEntitiesFromPrompt(many);
		expect(entities.files.length).toBeLessThanOrEqual(20);
	});

	it("is stateless across calls despite sharing global regexes", () => {
		const prompt = "open src/main.ts and run bun test on parseConfig";
		const first = eventBus.extractEntitiesFromPrompt(prompt);
		const second = eventBus.extractEntitiesFromPrompt(prompt);
		const third = eventBus.extractEntitiesFromPrompt(prompt);

		expect(second).toEqual(first);
		expect(third).toEqual(first);
		expect(first.files.length).toBeGreaterThan(0);
	});

	it("returns empty lists for an empty prompt", () => {
		const entities = eventBus.extractEntitiesFromPrompt("");
		expect(entities.files).toEqual([]);
		expect(entities.symbols).toEqual([]);
		expect(entities.errors).toEqual([]);
		expect(entities.taskNames).toEqual([]);
		expect(entities.commands).toEqual([]);
	});
});

describe("classifyIntent", () => {
	it("classifies each keyword family", () => {
		expect(eventBus.classifyIntent("what is the architecture here")).toBe("architecture");
		expect(eventBus.classifyIntent("this keeps failing with a crash")).toBe("debugging");
		expect(eventBus.classifyIntent("please implement the parser")).toBe("implementation");
		expect(eventBus.classifyIntent("run the unit tests")).toBe("testing");
		expect(eventBus.classifyIntent("check the setup")).toBe("configuration");
		expect(eventBus.classifyIntent("why was this done previously")).toBe("history");
		expect(eventBus.classifyIntent("I prefer tabs")).toBe("preference");
		expect(eventBus.classifyIntent("what are the steps")).toBe("procedure");
	});

	it("falls back to unknown when nothing matches", () => {
		expect(eventBus.classifyIntent("hello there")).toBe("unknown");
	});

	it("resolves ties in declaration order, most specific first", () => {
		// Contains both an architecture and an implementation keyword.
		expect(eventBus.classifyIntent("design and add a module")).toBe("architecture");
		// "write" belongs to implementation, which is checked before testing.
		expect(eventBus.classifyIntent("write a spec for it")).toBe("implementation");
	});

	it("is case insensitive", () => {
		expect(eventBus.classifyIntent("DEBUG THIS")).toBe("debugging");
	});
});

describe("GuardianObserveModeEngine", () => {
	it("defaults to observe mode", () => {
		expect(new GuardianObserveModeEngine().isObserveMode()).toBe(true);
	});

	it("suppresses user-visible interventions while still recording the intent", () => {
		const engine = new GuardianObserveModeEngine();

		const inject = engine.evaluateTurn(0.6, "relevant memory");
		expect(inject.intendedAction).toBe("INJECT_CONTEXT");
		expect(inject.effectiveAction).toBe("IGNORE");
		expect(inject.observedOnly).toBe(true);

		const warn = engine.evaluateTurn(0.8, "contradiction");
		expect(warn.intendedAction).toBe("WARN_AGENT");
		expect(warn.effectiveAction).toBe("IGNORE");
	});

	it("passes through actions the user cannot observe", () => {
		const engine = new GuardianObserveModeEngine();

		const silent = engine.evaluateTurn(0.4, "weak signal");
		expect(silent.intendedAction).toBe("RETRIEVE_SILENTLY");
		expect(silent.effectiveAction).toBe("RETRIEVE_SILENTLY");

		const ignored = engine.evaluateTurn(0.1, "noise");
		expect(ignored.intendedAction).toBe("IGNORE");
		expect(ignored.effectiveAction).toBe("IGNORE");
	});

	it("makes effective and intended agree once observe mode is off", () => {
		const engine = new GuardianObserveModeEngine({ observeMode: false });
		const result = engine.evaluateTurn(0.6, "relevant memory");

		expect(result.intendedAction).toBe("INJECT_CONTEXT");
		expect(result.effectiveAction).toBe("INJECT_CONTEXT");
		expect(result.observedOnly).toBe(false);
	});

	it("records one signal per evaluated turn and hands back a copy", () => {
		const engine = new GuardianObserveModeEngine();
		engine.evaluateTurn(0.6, "first");
		engine.evaluateTurn(0.2, "second");

		const signals = engine.getSignals();
		expect(signals.length).toBe(2);
		expect(signals[0]?.relevanceReason).toBe("first");

		signals.pop();
		expect(engine.getSignals().length).toBe(2);
	});

	it("refuses to tune on too little feedback", () => {
		const engine = new GuardianObserveModeEngine();
		for (let i = 0; i < 4; i++) {
			engine.evaluateTurn(0.6, `turn ${i}`);
		}
		for (const signal of engine.getSignals()) {
			engine.recordFeedback(signal.id, false);
		}

		const { oldThreshold, newThreshold } = engine.tuneThresholds();
		expect(oldThreshold).toBe(newThreshold);
	});

	it("raises the injection threshold when false positives dominate", () => {
		const engine = new GuardianObserveModeEngine();
		for (let i = 0; i < 6; i++) {
			engine.evaluateTurn(0.6, `turn ${i}`);
		}
		for (const signal of engine.getSignals()) {
			engine.recordFeedback(signal.id, false);
		}

		const { oldThreshold, newThreshold } = engine.tuneThresholds();
		expect(oldThreshold).toBeCloseTo(0.55, 10);
		expect(newThreshold).toBeCloseTo(0.6, 10);
	});

	it("lowers the injection threshold only when every rated signal was useful", () => {
		const engine = new GuardianObserveModeEngine();
		for (let i = 0; i < 6; i++) {
			engine.evaluateTurn(0.6, `turn ${i}`);
		}
		for (const signal of engine.getSignals()) {
			engine.recordFeedback(signal.id, true);
		}

		const { newThreshold } = engine.tuneThresholds();
		expect(newThreshold).toBeCloseTo(0.5, 10);
	});

	it("clamps the threshold at both ends", () => {
		const high = new GuardianObserveModeEngine({ minInjectScore: 0.85, minWarnScore: 0.99 });
		for (let i = 0; i < 6; i++) {
			high.evaluateTurn(0.9, `turn ${i}`);
		}
		for (const signal of high.getSignals()) {
			high.recordFeedback(signal.id, false);
		}
		expect(high.tuneThresholds().newThreshold).toBeCloseTo(0.85, 10);

		const low = new GuardianObserveModeEngine({ minInjectScore: 0.4 });
		for (let i = 0; i < 6; i++) {
			low.evaluateTurn(0.5, `turn ${i}`);
		}
		for (const signal of low.getSignals()) {
			low.recordFeedback(signal.id, true);
		}
		expect(low.tuneThresholds().newThreshold).toBeCloseTo(0.4, 10);
	});

	it("ignores feedback for an unknown signal id", () => {
		const engine = new GuardianObserveModeEngine();
		expect(() => {
			engine.recordFeedback("does-not-exist", true);
		}).not.toThrow();
	});

	it("can be flipped out of observe mode at runtime", () => {
		const engine = new GuardianObserveModeEngine();
		engine.setObserveMode(false);
		expect(engine.isObserveMode()).toBe(false);
		expect(engine.evaluateTurn(0.8, "x").effectiveAction).toBe("WARN_AGENT");
	});
});
