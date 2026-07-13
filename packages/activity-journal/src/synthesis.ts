import type { ActivityTimeline, TimelineClassification } from "./types";

export interface ActivitySynthesisFact {
	readonly window: { readonly startedAt: string; readonly endedAt: string };
	readonly classification: Exclude<TimelineClassification, "unknown">;
	readonly confidence: "low" | "medium" | "high";
	readonly confidenceReason: string;
	readonly activityCategories: readonly string[];
	readonly sources: readonly string[];
	readonly evidenceIds: readonly string[];
}

/**
 * Produces the only model-safe activity view. It intentionally omits raw media,
 * local file pointers, hashes, and redacted text digests.
 */
export function createActivitySynthesisFacts(timeline: ActivityTimeline): readonly ActivitySynthesisFact[] {
	return timeline.segments.flatMap(segment => {
		if (segment.classification === "unknown") return [];
		return [
			{
				window: segment.window,
				classification: segment.classification,
				confidence: segment.confidence,
				confidenceReason: segment.confidenceReason,
				activityCategories: segment.activityCategories,
				sources: segment.sources,
				evidenceIds: segment.evidenceIds,
			},
		];
	});
}
