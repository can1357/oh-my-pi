import { authorizeCapture, type CaptureRequest, type ConsentRecord } from "@pk-nerdsaver-ai/pi-context-policy";
import type { ActivityLedger } from "./ledger";
import type {
	ActivityCategory,
	ActivityConfidence,
	ActivityEvidence,
	EvidenceReference,
	RawClipReference,
} from "./types";

export interface GopkClipAnalysis {
	readonly clipId: string;
	readonly sourceEventId?: string;
	readonly window: { readonly startedAt: string; readonly endedAt: string };
	readonly application: { readonly id: string; readonly category: string };
	readonly redaction: {
		readonly status: "redacted" | "unverified" | "blocked";
		readonly completedAt: string;
	};
	readonly redactedDigest?: string;
	readonly activityCategory: ActivityCategory;
	readonly confidence: ActivityConfidence;
	readonly confidenceReason: string;
	readonly clipHash: string;
	readonly keyframeHash?: string;
	readonly localPointer: string;
	readonly rawClip?: { readonly localPointer: string; readonly expiresAt: string };
}

export interface GopkClipIngestionPolicy {
	readonly enabled: boolean;
	readonly allowedApplicationIds: readonly string[];
	readonly deniedApplicationIds: readonly string[];
	readonly maximumRawClipRetentionMs: number;
}

export interface GopkClipIngestionRequest {
	readonly capture: Omit<CaptureRequest, "applicationId" | "persistent">;
	readonly consent: ConsentRecord | undefined;
	readonly policy: GopkClipIngestionPolicy;
	readonly analysis: GopkClipAnalysis;
	readonly ingestedAt: string;
	readonly ledger: ActivityLedger;
}

export type GopkClipIngestionResult =
	| { readonly status: "stored" | "duplicate"; readonly evidence: ActivityEvidence }
	| { readonly status: "rejected"; readonly reason: string; readonly rawClipToDelete?: string };

/**
 * Accepts only already-redacted, local gopk derivatives. The adapter has no
 * raw-media parameter and never invokes remote OCR, transcription, or models.
 */
export function ingestGopkClip(request: GopkClipIngestionRequest): GopkClipIngestionResult {
	const rejection = validate(request);
	if (rejection) {
		return {
			status: "rejected",
			reason: rejection,
			rawClipToDelete: request.analysis.rawClip?.localPointer,
		};
	}

	const evidence = toActivityEvidence(request);
	return { status: request.ledger.record(evidence) ? "stored" : "duplicate", evidence };
}

function validate(request: GopkClipIngestionRequest): string | undefined {
	const { analysis, policy } = request;
	if (!policy.enabled) return "gopk clip capture is disabled";
	if (policy.deniedApplicationIds.includes(analysis.application.id)) return "application is denied by capture policy";
	if (policy.allowedApplicationIds.length > 0 && !policy.allowedApplicationIds.includes(analysis.application.id)) {
		return "application is outside the capture allowlist";
	}
	if (analysis.redaction.status !== "redacted") return "clip redaction was not completed";
	if (!isLocalPointer(analysis.localPointer)) return "clip evidence pointer must remain local";
	if (!isValidWindow(analysis.window.startedAt, analysis.window.endedAt)) return "clip window is invalid";
	if (!analysis.clipHash.trim()) return "clip hash is required";
	if (analysis.rawClip) {
		if (!isLocalPointer(analysis.rawClip.localPointer)) return "raw clip pointer must remain local";
		if (!isRawRetentionValid(analysis, policy.maximumRawClipRetentionMs)) return "raw clip retention exceeds policy";
	}
	const admission = authorizeCapture(
		{ ...request.capture, applicationId: analysis.application.id, persistent: true },
		request.consent,
	);
	return admission.allowed ? undefined : (admission.reason ?? "persistent capture was denied");
}

function toActivityEvidence(request: GopkClipIngestionRequest): ActivityEvidence {
	const { analysis, ingestedAt } = request;
	const evidenceRefs: EvidenceReference[] = [
		{
			id: analysis.clipId,
			kind: "clip",
			hash: analysis.clipHash,
			localPointer: analysis.localPointer,
		},
	];
	if (analysis.keyframeHash)
		evidenceRefs.push({ id: `${analysis.clipId}:keyframe`, kind: "keyframe", hash: analysis.keyframeHash });
	const rawClip: RawClipReference | undefined = analysis.rawClip
		? { localPointer: analysis.rawClip.localPointer, expiresAt: analysis.rawClip.expiresAt }
		: undefined;
	return {
		id: `gopk_clips:${analysis.clipId}`,
		source: "gopk_clips",
		sourceEventId: analysis.sourceEventId ?? analysis.clipId,
		window: analysis.window,
		recordedAt: ingestedAt,
		...(request.capture.projectId ? { projectId: request.capture.projectId } : {}),
		application: analysis.application,
		activityCategory: analysis.activityCategory,
		strength: "corroborating",
		signal: "screen_active",
		confidence: capScreenConfidence(analysis.confidence),
		confidenceReason: `Gopk clip corroborates screen activity only: ${analysis.confidenceReason}`,
		redactedDigest: analysis.redactedDigest,
		evidenceRefs,
		...(rawClip ? { rawClip } : {}),
	};
}

function capScreenConfidence(confidence: ActivityConfidence): ActivityConfidence {
	return confidence === "high" ? "medium" : confidence;
}

function isValidWindow(startedAt: string, endedAt: string): boolean {
	const start = Date.parse(startedAt);
	const end = Date.parse(endedAt);
	return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

function isRawRetentionValid(analysis: GopkClipAnalysis, maximumRawClipRetentionMs: number): boolean {
	if (!Number.isSafeInteger(maximumRawClipRetentionMs) || maximumRawClipRetentionMs <= 0) return false;
	const end = Date.parse(analysis.window.endedAt);
	const expiresAt = Date.parse(analysis.rawClip?.expiresAt ?? "");
	return Number.isFinite(expiresAt) && expiresAt > end && expiresAt - end <= maximumRawClipRetentionMs;
}

function isLocalPointer(pointer: string): boolean {
	if (!pointer.trim()) return false;
	if (/^[a-z]:[\\/]/i.test(pointer)) return true;
	if (pointer.startsWith("file://")) return true;
	// A single leading slash only: "//host/share" is a UNC network path on Windows.
	return pointer.startsWith("/") && !pointer.startsWith("//");
}
