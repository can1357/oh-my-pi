/**
 * Canonical memory record types.
 *
 * Single source of truth for the record shapes every fabric lane produces or
 * consumes. This module is deliberately lean: lane-specific vocabularies live
 * with their lanes (`adaptive-fidelity/types.ts` for budgets and expansion,
 * `persistence/types.ts` for durable state, `session-integration/types.ts`
 * for lifecycle events) and are not re-declared here.
 */

import { createHash, randomBytes } from "node:crypto";

/** Canonical record kinds, ordered roughly from raw to refined. */
export const MEMORY_RECORD_TYPES = [
	"evidence",
	"working-state",
	"episode",
	"fact",
	"decision",
	"procedure",
	"preference",
	"graph-assertion",
] as const;

export type MemoryRecordType = (typeof MEMORY_RECORD_TYPES)[number];

/** Verification ladder a record climbs (or falls down) over its life. */
export const MEMORY_VERIFICATIONS = [
	"observed",
	"user-confirmed",
	"model-proposed",
	"superseded",
	"contradicted",
	"archived",
] as const;

export type MemoryVerification = (typeof MEMORY_VERIFICATIONS)[number];

/** Sensitivity levels, from freely shareable to never-inject. */
export const MEMORY_SENSITIVITIES = ["public", "project", "private", "secret"] as const;

export type MemorySensitivity = (typeof MEMORY_SENSITIVITIES)[number];

/** Provenance pointer back to whatever produced a record. */
export interface SourceReference {
	/** Type of source. */
	type: "tool-result" | "user-message" | "assistant-message" | "file" | "git" | "test" | "graph" | "model" | "manual";
	/** Unique identifier of the source. */
	id: string;
	/** Optional location within the source (file:line, commit, etc.). */
	location?: string;
	/** Optional timestamp of the source. */
	timestamp?: string;
}

/** Freshness metadata driving decay and review scheduling. */
export interface MemoryFreshness {
	/** Last time this was observed/retrieved. */
	lastObservedAt: string;
	/** Last time this was verified against its source. */
	lastVerifiedAt?: string;
	/** Method of last verification. */
	verificationMethod?: "user" | "file" | "test" | "tool" | "graph" | "model";
	/** Fingerprint of the source at last verification. */
	sourceFingerprint?: string;
	/** Number of times retrieved. */
	retrievalCount: number;
	/** Number of times marked useful. */
	usefulCount: number;
	/** Number of times contradicted. */
	contradictedCount: number;
	/** Decay class for retention. */
	decayClass: "volatile" | "project" | "durable" | "permanent";
	/** Next scheduled review. */
	nextReviewAt?: string;
}

/** The canonical memory record every adapter produces and consumes. */
export interface MemoryRecord {
	/** Globally unique identifier. */
	id: string;
	/** Project identifier for isolation. */
	projectId: string;
	/** Worktree identifier (for multi-worktree projects). */
	worktreeId?: string;
	/** Git branch identifier. */
	branchId?: string;
	/** Session identifier. */
	sessionId?: string;
	/** Task identifier. */
	taskId?: string;
	/** Agent identifier. */
	agentId?: string;

	/** Canonical memory type. */
	type: MemoryRecordType;

	/** Human-readable content. */
	content: string;
	/** Structured data for programmatic access. */
	structured?: Record<string, unknown>;

	/** Source references for provenance. */
	sourceRefs: SourceReference[];

	/** Tags for categorization and retrieval. */
	tags: string[];

	/** Confidence score (0..1). */
	confidence: number;
	/** Importance score (0..1) for retention. */
	importance: number;
	/** Sensitivity level. */
	sensitivity: MemorySensitivity;

	/** Verification status. */
	verification: MemoryVerification;

	/** Validity interval. */
	validFrom: string;
	validUntil?: string;

	/** Creation timestamp. */
	createdAt: string;
	/** Last update timestamp. */
	updatedAt: string;
	/** Expiration timestamp for volatile records. */
	expiresAt?: string;

	/** IDs this record supersedes. */
	supersedes?: string[];

	/** Content hash for deduplication (SHA-256, hex). */
	contentHash: string;
	/** Schema version. */
	schemaVersion: number;

	/** Freshness metadata. */
	freshness?: MemoryFreshness;
}

/** Working state for the active task. */
export interface WorkingStateRecord extends MemoryRecord {
	type: "working-state";
	structured: {
		objective: string;
		constraints: string[];
		activePlan: string;
		currentStep: string;
		filesTouched: string[];
		pendingOperations: string[];
		unresolvedErrors: string[];
		lastVerifiedTestState: string;
	};
}

/** Episodic memory for a completed task/session. */
export interface EpisodeRecord extends MemoryRecord {
	type: "episode";
	structured: {
		taskIntent: string;
		approach: string;
		result: "success" | "partial" | "failure";
		failurePoints: string[];
		decisions: string[];
		toolsUsed: string[];
		lessons: string[];
		nextAction: string;
	};
}

/** Durable semantic fact. */
export interface FactRecord extends MemoryRecord {
	type: "fact";
	structured: {
		statement: string;
		domain: string;
		evidence: string[];
	};
}

/** Deliberate decision with alternatives. */
export interface DecisionRecord extends MemoryRecord {
	type: "decision";
	structured: {
		chosenSolution: string;
		rejectedAlternatives: string[];
		decisionMaker: string;
		effectiveScope: string;
		status: "proposed" | "accepted" | "superseded" | "revoked";
	};
}

/** Reusable procedure. */
export interface ProcedureRecord extends MemoryRecord {
	type: "procedure";
	structured: {
		preconditions: string[];
		steps: string[];
		expectedOutputs: string[];
		validationCommands: string[];
		failureRecovery: string[];
		successCount: number;
		lastSuccessfulDate: string;
	};
}

/** User/team preference. */
export interface PreferenceRecord extends MemoryRecord {
	type: "preference";
	structured: {
		preference: string;
		context: string;
		explicitlyConfirmed: boolean;
	};
}

/** Graph node or edge assertion. */
export interface GraphAssertionRecord extends MemoryRecord {
	type: "graph-assertion";
	structured: {
		subject: string;
		predicate: string;
		object: string;
		edgeType: "extracted" | "inferred" | "user-asserted" | "model-proposed";
	};
}

/** Raw immutable evidence. */
export interface EvidenceRecord extends MemoryRecord {
	type: "evidence";
	structured: {
		evidenceType:
			| "user-message"
			| "assistant-message"
			| "tool-result"
			| "file-snapshot"
			| "test-result"
			| "build-result"
			| "git-metadata"
			| "user-correction";
		payload: unknown;
	};
}

export function isEvidenceRecord(record: MemoryRecord): record is EvidenceRecord {
	return record.type === "evidence";
}

export function isWorkingStateRecord(record: MemoryRecord): record is WorkingStateRecord {
	return record.type === "working-state";
}

export function isEpisodeRecord(record: MemoryRecord): record is EpisodeRecord {
	return record.type === "episode";
}

export function isFactRecord(record: MemoryRecord): record is FactRecord {
	return record.type === "fact";
}

export function isDecisionRecord(record: MemoryRecord): record is DecisionRecord {
	return record.type === "decision";
}

export function isProcedureRecord(record: MemoryRecord): record is ProcedureRecord {
	return record.type === "procedure";
}

export function isPreferenceRecord(record: MemoryRecord): record is PreferenceRecord {
	return record.type === "preference";
}

export function isGraphAssertionRecord(record: MemoryRecord): record is GraphAssertionRecord {
	return record.type === "graph-assertion";
}

/** Inputs accepted by {@link createMemoryRecord}. */
export interface CreateMemoryRecordInput {
	id?: string;
	type: MemoryRecordType;
	projectId: string;
	worktreeId?: string;
	branchId?: string;
	sessionId?: string;
	taskId?: string;
	agentId?: string;
	content: string;
	structured?: Record<string, unknown>;
	sourceRefs: SourceReference[];
	tags?: string[];
	confidence?: number;
	importance?: number;
	sensitivity?: MemorySensitivity;
	verification?: MemoryVerification;
	validFrom?: string;
	validUntil?: string;
	expiresAt?: string;
	supersedes?: string[];
}

function clampUnit(value: number): number {
	if (Number.isNaN(value)) return 0;
	return Math.max(0, Math.min(1, value));
}

function generateRecordId(): string {
	return `mem_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
}

/**
 * SHA-256 content hash for deduplication. A cryptographic hash rather than a
 * rolling checksum: dedup compares hashes *instead of* content, so collisions
 * would silently merge unrelated memories.
 */
function hashRecordContent(content: string, structured: Record<string, unknown> | undefined): string {
	return createHash("sha256")
		.update(content)
		.update(JSON.stringify(structured ?? {}))
		.digest("hex");
}

/** Build a canonical record, filling defaults and computing the content hash. */
export function createMemoryRecord(input: CreateMemoryRecordInput): MemoryRecord {
	const now = new Date().toISOString();
	const record: MemoryRecord = {
		id: input.id ?? generateRecordId(),
		projectId: input.projectId,
		type: input.type,
		content: input.content,
		sourceRefs: input.sourceRefs,
		tags: input.tags ?? [],
		confidence: clampUnit(input.confidence ?? 0.5),
		importance: clampUnit(input.importance ?? 0.5),
		sensitivity: input.sensitivity ?? "project",
		verification: input.verification ?? "observed",
		validFrom: input.validFrom ?? now,
		createdAt: now,
		updatedAt: now,
		contentHash: hashRecordContent(input.content, input.structured),
		schemaVersion: 1,
	};
	if (input.worktreeId) record.worktreeId = input.worktreeId;
	if (input.branchId) record.branchId = input.branchId;
	if (input.sessionId) record.sessionId = input.sessionId;
	if (input.taskId) record.taskId = input.taskId;
	if (input.agentId) record.agentId = input.agentId;
	if (input.structured) record.structured = input.structured;
	if (input.validUntil) record.validUntil = input.validUntil;
	if (input.expiresAt) record.expiresAt = input.expiresAt;
	if (input.supersedes) record.supersedes = input.supersedes;
	return record;
}

const STRING_FIELDS = ["id", "projectId", "content", "validFrom", "createdAt", "updatedAt", "contentHash"] as const;

/** Structural validation for records arriving from storage or the wire. */
export function validateMemoryRecord(record: unknown): record is MemoryRecord {
	if (!record || typeof record !== "object") return false;
	const r = record as Record<string, unknown>;

	for (const field of STRING_FIELDS) {
		if (typeof r[field] !== "string") return false;
	}
	if (!(MEMORY_RECORD_TYPES as readonly string[]).includes(r.type as string)) return false;
	if (!Array.isArray(r.sourceRefs) || !Array.isArray(r.tags)) return false;
	if (typeof r.confidence !== "number" || typeof r.importance !== "number") return false;
	if (!(MEMORY_SENSITIVITIES as readonly string[]).includes(r.sensitivity as string)) return false;
	if (!(MEMORY_VERIFICATIONS as readonly string[]).includes(r.verification as string)) return false;
	if (typeof r.schemaVersion !== "number") return false;
	return true;
}

/** Configuration for the fabric composition root. */
export interface MemoryFabricConfig {
	/** Root directory for all memory storage. */
	memoryRoot: string;
	/** Enable proactive guardian features. */
	proactive: boolean;
	/** Guardian mode. */
	guardianMode: "active" | "observe" | "off";
	/** Redact secrets from stored memories. */
	redactSecrets: boolean;
	/** Automatically create checkpoints at intervals. */
	autoCheckpoint: boolean;
	/** Checkpoint interval in milliseconds. */
	checkpointIntervalMs: number;
}
