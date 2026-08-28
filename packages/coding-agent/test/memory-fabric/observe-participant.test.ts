import { describe, expect, it } from "bun:test";
import type { ContextItem } from "@oh-my-pi/pi-coding-agent/memory-fabric/context-hygiene/types";
import {
	InMemoryObservationSink,
	type ObservationResult,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/rollout/observe";
import { stageMayAlterContext } from "@oh-my-pi/pi-coding-agent/memory-fabric/rollout/types";
import {
	createObserveModeParticipant,
	defaultContextObserver,
	ObserveModeSessionParticipant,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/session-integration/observe-participant";
import type { BeforeModelEvent } from "@oh-my-pi/pi-coding-agent/memory-fabric/session-integration/types";

const FIXED = new Date("2026-01-01T00:00:00.000Z");
const clock = (): Date => FIXED;

function beforeModel(activeContextText?: string): BeforeModelEvent {
	const event: BeforeModelEvent = {
		type: "before_model",
		userText: "what changed in the build script?",
		metadata: {
			origin: "main-agent",
			correlationId: "corr-1",
			depth: 0,
			sequence: 1,
			timestamp: FIXED.getTime(),
		},
		scope: { projectId: "proj", sessionId: "sess", cwd: "/tmp/proj" },
		sequence: 1,
	};
	if (activeContextText !== undefined) event.activeContextText = activeContextText;
	return event;
}

const LONG_CONTEXT = "The build script lives in scripts/build.ts and runs on every push to main.";

describe("defaultContextObserver", () => {
	it("projects active context text into a single item", () => {
		const items = defaultContextObserver(beforeModel(LONG_CONTEXT));
		expect(items).toHaveLength(1);
		expect(items[0]?.id).toBe("session:active-context");
		expect(items[0]?.content).toBe(LONG_CONTEXT);
	});

	it("yields nothing for missing or blank context", () => {
		expect(defaultContextObserver(beforeModel())).toEqual([]);
		expect(defaultContextObserver(beforeModel(""))).toEqual([]);
		expect(defaultContextObserver(beforeModel("   \n\t "))).toEqual([]);
	});
});

describe("ObserveModeSessionParticipant — identity", () => {
	it("names itself and pins the non-altering rung", () => {
		const participant = new ObserveModeSessionParticipant();
		expect(participant.participantName).toBe("acf-observe");
		expect(participant.stage).toBe("observe");
		expect(stageMayAlterContext(participant.stage)).toBe(false);
	});

	it("is disabled by default", () => {
		expect(new ObserveModeSessionParticipant().enabled).toBe(false);
		expect(createObserveModeParticipant({ enabled: true }).enabled).toBe(true);
	});

	it("implements only prepareContext, leaving every other hook absent", () => {
		const participant = new ObserveModeSessionParticipant() as unknown as Record<string, unknown>;
		expect(typeof participant.prepareContext).toBe("function");
		for (const hook of ["onSessionStart", "onUserPrompt", "beforeToolCall", "afterToolCall", "checkpoint"]) {
			expect(participant[hook]).toBeUndefined();
		}
		expect(participant.onResume).toBeUndefined();
		expect(participant.stop).toBeUndefined();
	});
});

describe("ObserveModeSessionParticipant — inert when disabled", () => {
	it("does not run the gate and records nothing", async () => {
		const sink = new InMemoryObservationSink();
		const participant = createObserveModeParticipant({ sink, now: clock });
		const packet = await participant.prepareContext(beforeModel(LONG_CONTEXT));
		expect(packet).toBeNull();
		expect(sink.reports).toHaveLength(0);
		expect(participant.lastReport).toBeNull();
		expect(participant.observationCount).toBe(0);
	});
});

describe("ObserveModeSessionParticipant — measure only", () => {
	it("observes but always contributes null context", async () => {
		const sink = new InMemoryObservationSink();
		const participant = createObserveModeParticipant({ enabled: true, sink, now: clock });
		const packet = await participant.prepareContext(beforeModel(LONG_CONTEXT));
		expect(packet).toBeNull();
		expect(sink.reports).toHaveLength(1);
		expect(participant.observationCount).toBe(1);
		expect(participant.lastReport?.stage).toBe("observe");
		expect(participant.lastReport?.inputCount).toBe(1);
		expect(participant.lastReport?.generatedAt).toBe(FIXED.toISOString());
	});

	it("retains metrics only — no context content is pinned", async () => {
		const participant = createObserveModeParticipant({ enabled: true, now: clock });
		await participant.prepareContext(beforeModel(LONG_CONTEXT));
		const retained = JSON.stringify(participant.lastReport);
		expect(retained).not.toContain(LONG_CONTEXT);
		expect(participant.lastReport?.inputIds).toEqual(["session:active-context"]);
	});

	it("skips the gate entirely when there is no active context", async () => {
		const sink = new InMemoryObservationSink();
		const participant = createObserveModeParticipant({ enabled: true, sink, now: clock });
		expect(await participant.prepareContext(beforeModel())).toBeNull();
		expect(await participant.prepareContext(beforeModel("  "))).toBeNull();
		expect(sink.reports).toHaveLength(0);
		expect(participant.observationCount).toBe(0);
	});

	it("accepts a custom context projector", async () => {
		const items: ContextItem[] = [
			{ id: "a", content: "alpha alpha alpha" },
			{ id: "b", content: "beta beta beta" },
		];
		const participant = createObserveModeParticipant({
			enabled: true,
			now: clock,
			observer: () => items,
		});
		await participant.prepareContext(beforeModel());
		expect(participant.lastReport?.inputIds).toEqual(["a", "b"]);
	});

	it("hands the full observation to onObserve without retaining it", async () => {
		let seen: ObservationResult | null = null;
		const participant = createObserveModeParticipant({
			enabled: true,
			now: clock,
			onObserve: result => {
				seen = result;
			},
		});
		await participant.prepareContext(beforeModel(LONG_CONTEXT));
		expect(seen).not.toBeNull();
		expect((seen as unknown as ObservationResult).context).toHaveLength(1);
		expect((seen as unknown as ObservationResult).gate.mode).toBe("observe");
	});

	it("counts repeated observations", async () => {
		const participant = createObserveModeParticipant({ enabled: true, now: clock });
		await participant.prepareContext(beforeModel(LONG_CONTEXT));
		await participant.prepareContext(beforeModel(`${LONG_CONTEXT} And it caches artifacts.`));
		expect(participant.observationCount).toBe(2);
		participant.reset();
		expect(participant.observationCount).toBe(0);
		expect(participant.lastReport).toBeNull();
	});
});

describe("ObserveModeSessionParticipant — fail open", () => {
	it("returns null when the projector throws", async () => {
		const participant = createObserveModeParticipant({
			enabled: true,
			now: clock,
			observer: () => {
				throw new Error("projector down");
			},
		});
		expect(await participant.prepareContext(beforeModel(LONG_CONTEXT))).toBeNull();
		expect(participant.observationCount).toBe(0);
	});

	it("returns null when onObserve throws", async () => {
		const participant = createObserveModeParticipant({
			enabled: true,
			now: clock,
			onObserve: () => {
				throw new Error("callback down");
			},
		});
		expect(await participant.prepareContext(beforeModel(LONG_CONTEXT))).toBeNull();
		expect(participant.observationCount).toBe(1);
	});

	it("returns null when the sink throws", async () => {
		const participant = createObserveModeParticipant({
			enabled: true,
			now: clock,
			sink: {
				record(): void {
					throw new Error("sink down");
				},
			},
		});
		expect(await participant.prepareContext(beforeModel(LONG_CONTEXT))).toBeNull();
		expect(participant.observationCount).toBe(1);
	});
});
