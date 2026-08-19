import { describe, expect, it } from "bun:test";
import {
	createOrchestrationTelemetrySink,
	ORCHESTRATION_TELEMETRY_CHANNEL,
	recordSpawnTelemetry,
} from "../../src/orchestration/orchestration-telemetry";
import { EventBus } from "../../src/utils/event-bus";

describe("orchestration telemetry", () => {
	it("records spawn events with stable shape", () => {
		const bus = new EventBus();
		const seen: unknown[] = [];
		bus.on(ORCHESTRATION_TELEMETRY_CHANNEL, data => seen.push(data));
		const sink = createOrchestrationTelemetrySink(bus);

		recordSpawnTelemetry(sink, {
			sessionId: "s1",
			correlationId: "corr-1",
			agentName: "explore",
			strategyFamily: "concurrency",
			workerMode: "explore",
			contextPolicy: "blind",
			routeLabel: "light",
		});

		expect(sink.events).toHaveLength(1);
		expect(sink.events[0]?.kind).toBe("spawn");
		expect(sink.events[0]?.strategyFamily).toBe("concurrency");
		expect(seen).toHaveLength(1);
	});

	it("carries privacy-safe routing metadata without assignment text", () => {
		const sink = createOrchestrationTelemetrySink();

		recordSpawnTelemetry(sink, {
			agentName: "task",
			metadata: Object.freeze({
				requestedDifficulty: "high",
				modelSelectionSource: "difficulty-profile",
				modelProfileName: undefined,
				modelRole: "slow",
				candidateSelectors: ["pi/slow"],
			}),
		});

		expect(sink.events).toHaveLength(1);
		const event = sink.events[0];
		expect(event?.metadata).toEqual({
			requestedDifficulty: "high",
			modelSelectionSource: "difficulty-profile",
			modelProfileName: undefined,
			modelRole: "slow",
			candidateSelectors: ["pi/slow"],
		});
		expect(JSON.stringify(event)).not.toContain("assignment");
	});
});
