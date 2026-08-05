export const ACTIVITY_SOURCES = ["omp", "codex", "claude_code", "git", "terminal", "gopk_clips"] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

export const ACTIVITY_CATEGORIES = ["coding", "research", "writing", "meeting", "idle", "unknown"] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export type ActivityConfidence = "low" | "medium" | "high";
export type EvidenceStrength = "primary" | "corroborating";
export type ActivitySignal = "human_active" | "agent_runtime" | "screen_active";
export type EvidenceReferenceKind = "session" | "commit" | "terminal" | "clip" | "keyframe" | "transcript";

export interface ActivityWindow {
	readonly startedAt: string;
	readonly endedAt: string;
}

export interface EvidenceReference {
	readonly id: string;
	readonly kind: EvidenceReferenceKind;
	readonly hash?: string;
	readonly localPointer?: string;
}

export interface RawClipReference {
	readonly localPointer: string;
	readonly expiresAt: string;
	readonly deletedAt?: string;
}

/** Persisted evidence contains redacted derivatives and references, never raw media bytes. */
export interface ActivityEvidence {
	readonly id: string;
	readonly source: ActivitySource;
	readonly sourceEventId: string;
	readonly window: ActivityWindow;
	readonly recordedAt: string;
	readonly projectId?: string;
	readonly workspaceId?: string;
	readonly application?: { readonly id: string; readonly category: string };
	readonly activityCategory: ActivityCategory;
	readonly strength: EvidenceStrength;
	readonly signal: ActivitySignal;
	readonly confidence: ActivityConfidence;
	readonly confidenceReason: string;
	readonly redactedDigest?: string;
	readonly ocrSnippet?: string;
	readonly evidenceRefs: readonly EvidenceReference[];
	readonly rawClip?: RawClipReference;
}

export type TimelineClassification = "human_active_estimate" | "agent_runtime" | "screen_corroboration" | "unknown";

export interface ActivityTimelineSegment {
	readonly window: ActivityWindow;
	readonly classification: TimelineClassification;
	readonly confidence: ActivityConfidence;
	readonly confidenceReason: string;
	readonly activityCategories: readonly ActivityCategory[];
	readonly sources: readonly ActivitySource[];
	readonly evidenceIds: readonly string[];
}

export interface ActivityTimeline {
	readonly window: ActivityWindow;
	readonly segments: readonly ActivityTimelineSegment[];
	readonly totals: {
		readonly humanActiveEstimateMs: number;
		readonly agentRuntimeMs: number;
		readonly screenCorroborationMs: number;
		readonly unknownMs: number;
	};
}
