import { describe, expect, it } from "bun:test";
import { type ActivityEvidence, buildActivityTimeline } from "../src";

function evidence(
	id: string,
	source: ActivityEvidence["source"],
	signal: ActivityEvidence["signal"],
	strength: ActivityEvidence["strength"],
	startedAt: string,
	endedAt: string,
): ActivityEvidence {
	return {
		id,
		source,
		sourceEventId: id,
		window: { startedAt, endedAt },
		recordedAt: endedAt,
		activityCategory: "coding",
		strength,
		signal,
		confidence: "medium",
		confidenceReason: `${source} evidence`,
		evidenceRefs: [],
	};
}

describe("activity timeline aggregation", () => {
	it("unions overlapping source intervals without upgrading screen activity to a human-work claim", () => {
		const timeline = buildActivityTimeline({
			window: { startedAt: "2026-07-13T14:00:00.000Z", endedAt: "2026-07-13T15:00:00.000Z" },
			evidence: [
				evidence(
					"gopk",
					"gopk_clips",
					"screen_active",
					"corroborating",
					"2026-07-13T14:10:00.000Z",
					"2026-07-13T14:45:00.000Z",
				),
				evidence("omp", "omp", "agent_runtime", "primary", "2026-07-13T14:15:00.000Z", "2026-07-13T14:30:00.000Z"),
				evidence("git", "git", "human_active", "primary", "2026-07-13T14:20:00.000Z", "2026-07-13T14:40:00.000Z"),
			],
		});

		expect(timeline.totals).toEqual({
			humanActiveEstimateMs: 1_200_000,
			agentRuntimeMs: 300_000,
			screenCorroborationMs: 600_000,
			unknownMs: 1_500_000,
		});
		expect(timeline.segments.map(segment => segment.classification)).toEqual([
			"unknown",
			"screen_corroboration",
			"agent_runtime",
			"human_active_estimate",
			"human_active_estimate",
			"screen_corroboration",
			"unknown",
		]);
		const screenSegments = timeline.segments.filter(segment => segment.classification === "screen_corroboration");
		expect(screenSegments.every(segment => segment.confidence !== "high")).toBe(true);
		expect(screenSegments[0]?.confidenceReason).toContain("does not establish user attention");
	});

	it("does not treat overlapping events from one journal source as independent corroboration", () => {
		const timeline = buildActivityTimeline({
			window: { startedAt: "2026-07-13T14:00:00.000Z", endedAt: "2026-07-13T14:10:00.000Z" },
			evidence: [
				evidence(
					"omp-a",
					"omp",
					"agent_runtime",
					"primary",
					"2026-07-13T14:00:00.000Z",
					"2026-07-13T14:05:00.000Z",
				),
				evidence(
					"omp-b",
					"omp",
					"agent_runtime",
					"primary",
					"2026-07-13T14:00:00.000Z",
					"2026-07-13T14:05:00.000Z",
				),
			],
		});
		const activeSegment = timeline.segments.find(segment => segment.classification === "agent_runtime");
		expect(activeSegment?.confidence).toBe("medium");
	});
});
