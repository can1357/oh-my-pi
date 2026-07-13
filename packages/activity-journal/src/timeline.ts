import type {
	ActivityConfidence,
	ActivityEvidence,
	ActivityTimeline,
	ActivityTimelineSegment,
	ActivityWindow,
	TimelineClassification,
} from "./types";

export interface ActivityTimelineRequest {
	readonly window: ActivityWindow;
	readonly evidence: readonly ActivityEvidence[];
}

/**
 * Splits a requested window at evidence boundaries. Each resulting segment is
 * exclusive, so simultaneous sources never inflate the reported duration.
 */
export function buildActivityTimeline(request: ActivityTimelineRequest): ActivityTimeline {
	const window = toMillis(request.window);
	const evidence = request.evidence.filter(item => overlaps(toMillis(item.window), window));
	const boundaries = new Set<number>([window.start, window.end]);
	for (const item of evidence) {
		const itemWindow = toMillis(item.window);
		boundaries.add(Math.max(window.start, itemWindow.start));
		boundaries.add(Math.min(window.end, itemWindow.end));
	}
	const sorted = [...boundaries].sort((left, right) => left - right);
	const segments: ActivityTimelineSegment[] = [];
	const totals = {
		humanActiveEstimateMs: 0,
		agentRuntimeMs: 0,
		screenCorroborationMs: 0,
		unknownMs: 0,
	};

	for (let index = 0; index < sorted.length - 1; index++) {
		const start = sorted[index];
		const end = sorted[index + 1];
		if (start === undefined || end === undefined || end <= start) continue;
		const active = evidence.filter(item => {
			const itemWindow = toMillis(item.window);
			return itemWindow.start <= start && itemWindow.end >= end;
		});
		const segment = summarizeSegment(start, end, active);
		segments.push(segment);
		const duration = end - start;
		switch (segment.classification) {
			case "human_active_estimate":
				totals.humanActiveEstimateMs += duration;
				break;
			case "agent_runtime":
				totals.agentRuntimeMs += duration;
				break;
			case "screen_corroboration":
				totals.screenCorroborationMs += duration;
				break;
			case "unknown":
				totals.unknownMs += duration;
				break;
		}
	}

	return { window: request.window, segments, totals };
}

function summarizeSegment(start: number, end: number, evidence: readonly ActivityEvidence[]): ActivityTimelineSegment {
	const classification = classify(evidence);
	const sources = unique(evidence.map(item => item.source));
	const evidenceIds = evidence.map(item => item.id).sort();
	const categories = unique(evidence.map(item => item.activityCategory));
	return {
		window: { startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString() },
		classification,
		confidence: confidenceFor(classification, evidence),
		confidenceReason: reasonFor(classification, evidence),
		activityCategories: categories,
		sources,
		evidenceIds,
	};
}

function classify(evidence: readonly ActivityEvidence[]): TimelineClassification {
	if (evidence.some(item => item.signal === "human_active")) return "human_active_estimate";
	if (evidence.some(item => item.signal === "agent_runtime")) return "agent_runtime";
	if (evidence.some(item => item.signal === "screen_active")) return "screen_corroboration";
	return "unknown";
}

function confidenceFor(
	classification: TimelineClassification,
	evidence: readonly ActivityEvidence[],
): ActivityConfidence {
	if (classification === "unknown") return "low";
	const highest = evidence.reduce<ActivityConfidence>(
		(current, item) => higherConfidence(current, item.confidence),
		"low",
	);
	if (classification === "screen_corroboration") return highest === "high" ? "medium" : highest;
	const primarySources = unique(evidence.filter(item => item.strength === "primary").map(item => item.source));
	if (primarySources.length >= 2) return "high";
	return highest;
}

function reasonFor(classification: TimelineClassification, evidence: readonly ActivityEvidence[]): string {
	if (classification === "unknown") return "No evidence was recorded for this interval.";
	const sourceList = unique(evidence.map(item => item.source)).join(", ");
	if (classification === "screen_corroboration") {
		return `Redacted gopk evidence corroborates screen activity from ${sourceList}; it does not establish user attention.`;
	}
	if (classification === "agent_runtime") return `Agent journal evidence was active from ${sourceList}.`;
	return `Primary local activity evidence was active from ${sourceList}.`;
}

function toMillis(window: ActivityWindow): { start: number; end: number } {
	const start = Date.parse(window.startedAt);
	const end = Date.parse(window.endedAt);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
		throw new Error("activity window must have valid ascending timestamps");
	return { start, end };
}

function overlaps(left: { start: number; end: number }, right: { start: number; end: number }): boolean {
	return left.start < right.end && right.start < left.end;
}

function higherConfidence(left: ActivityConfidence, right: ActivityConfidence): ActivityConfidence {
	const rank = { low: 0, medium: 1, high: 2 } as const;
	return rank[right] > rank[left] ? right : left;
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}
