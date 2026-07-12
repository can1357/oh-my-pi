/**
 * RemoteJobV1 — versioned durable job record for ephemeral remote workspace runs.
 *
 * Every field that changes over the job lifetime lives on this record and is
 * persisted transactionally. The state machine enforces valid transitions.
 */

import { createHash, randomUUID } from "node:crypto";

export const REMOTE_JOB_VERSION = "ompk.remote-job/v1" as const;

// ── State machine ────────────────────────────────────────────────────────────

export type JobState =
	| "queued"
	| "authorizing"
	| "clarification_required"
	| "planning"
	| "plan_auditing"
	| "provisioning"
	| "cloning"
	| "installing"
	| "running_agent"
	| "validating"
	| "publishing"
	| "checkpointing_result"
	| "cleaning"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "timed_out"
	| "cleanup_failed";

export type TerminalJobState = "succeeded" | "failed" | "cancelled" | "timed_out" | "cleanup_failed";

export const TERMINAL_STATES = new Set<JobState>(["succeeded", "failed", "cancelled", "timed_out", "cleanup_failed"]);

/** Valid state → next-states map. Transitions not listed here are rejected. */
export const VALID_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = Object.freeze({
	queued: ["authorizing", "cancelled"],
	authorizing: ["clarification_required", "planning", "failed", "cancelled"],
	clarification_required: ["planning", "cancelled", "failed"],
	planning: ["plan_auditing", "failed", "cancelled"],
	plan_auditing: ["provisioning", "planning", "failed", "cancelled"],
	provisioning: ["cloning", "failed", "cancelled"],
	cloning: ["installing", "failed", "cancelled"],
	installing: ["running_agent", "failed", "cancelled"],
	running_agent: ["validating", "failed", "cancelled", "timed_out"],
	validating: ["publishing", "checkpointing_result", "failed", "cancelled"],
	publishing: ["checkpointing_result", "failed", "cancelled"],
	checkpointing_result: ["cleaning", "failed", "cancelled"],
	cleaning: ["succeeded", "failed", "cancelled", "timed_out", "cleanup_failed"],
	succeeded: [],
	failed: ["cleaning"],
	cancelled: ["cleaning"],
	timed_out: ["cleaning"],
	cleanup_failed: [],
});

export function isValidTransition(from: JobState, to: JobState): boolean {
	return (VALID_TRANSITIONS[from] as readonly JobState[]).includes(to);
}

export function isTerminal(state: JobState): boolean {
	return TERMINAL_STATES.has(state);
}

// ── Job source ────────────────────────────────────────────────────────────────

export type ResultMode = "none" | "patch" | "branch" | "draft_pull_request";

export interface JobSource {
	readonly repoUrl: string;
	readonly ref: string;
	readonly resolvedCommit?: string;
}

export interface JobTask {
	readonly prompt: string;
	readonly agentName?: string;
	readonly modelRole?: string;
	readonly validationCommands: readonly string[];
	readonly resultMode: ResultMode;
}

export interface JobLimits {
	readonly timeoutMs: number;
	readonly maxTokens?: number;
	readonly maxCostUsd?: number;
}

export interface JobPlanning {
	readonly taskContractId?: string;
	readonly taskContractDigest?: string;
	readonly reasoningPlanId?: string;
	readonly reasoningPlanDigest?: string;
}

// ── Resource inventory ────────────────────────────────────────────────────────

export type ResourceKind =
	| "container"
	| "volume"
	| "network"
	| "tmpfs_secret"
	| "port_proxy"
	| "process"
	| "branch"
	| "credential_lease";

export interface ResourceRecord {
	readonly kind: ResourceKind;
	readonly id: string;
	readonly label: string;
	readonly createdAt: string;
	cleanedAt?: string;
}

// ── State transition event ────────────────────────────────────────────────────

export interface JobTransitionEvent {
	readonly from: JobState;
	readonly to: JobState;
	readonly timestamp: string;
	readonly actor: "orchestrator" | "worker" | "user" | "reaper";
	readonly reason: string;
}

// ── Cleanup proof ─────────────────────────────────────────────────────────────

export interface CleanupProof {
	readonly verifiedAt: string;
	readonly containerGone: boolean;
	readonly volumeGone: boolean;
	readonly networkGone: boolean;
	readonly workspaceDirGone: boolean;
	readonly credentialRevoked: boolean;
	readonly notes?: string;
}

// ── Artifact record ───────────────────────────────────────────────────────────

export interface ArtifactRecord {
	readonly type: string;
	readonly digest: string;
	readonly sizeBytes: number;
	readonly createdAt: string;
	readonly storageUri: string;
	readonly sensitivityClass: "public" | "internal" | "confidential";
	readonly redactionStatus: "clean" | "redacted";
}

// ── Full job record ───────────────────────────────────────────────────────────

export interface RemoteJobV1 {
	readonly version: typeof REMOTE_JOB_VERSION;
	readonly id: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	state: JobState;
	revision: number;
	readonly source: JobSource;
	readonly task: JobTask;
	readonly limits: JobLimits;
	planning: JobPlanning;
	readonly backendId: string;
	workerId?: string;
	readonly transitions: JobTransitionEvent[];
	readonly resources: ResourceRecord[];
	readonly artifacts: ArtifactRecord[];
	cleanupProof?: CleanupProof;
	/** Intended terminal result when cleanup itself could not be verified. */
	outcomeState?: Exclude<TerminalJobState, "cleanup_failed">;
	failureReason?: string;
	validationExitCode?: number;
	agentExitCode?: number;
	resultRef?: string;
}

function normalizeRepositoryUrl(value: string): string {
	let repository: URL;
	try {
		repository = new URL(value);
	} catch {
		throw new Error("Repository URL must be an absolute credential-free HTTPS URL");
	}
	if (
		repository.protocol !== "https:" ||
		!repository.hostname ||
		repository.username ||
		repository.password ||
		repository.search ||
		repository.hash
	) {
		throw new Error("Repository URL must be a credential-free HTTPS URL without query or fragment");
	}
	return repository.toString();
}

export function computeJobId(source: JobSource, createdAt: string): string {
	const payload = `${source.repoUrl}\0${source.ref}\0${createdAt}\0${randomUUID()}`;
	return `job-${createHash("sha256").update(payload).digest("hex").slice(0, 16)}`;
}

export function createJob(input: {
	readonly source: JobSource;
	readonly task: JobTask;
	readonly limits: JobLimits;
	readonly backendId: string;
}): RemoteJobV1 {
	const now = new Date().toISOString();
	const source = Object.freeze({ ...input.source, repoUrl: normalizeRepositoryUrl(input.source.repoUrl) });
	const id = computeJobId(source, now);
	return {
		version: REMOTE_JOB_VERSION,
		id,
		createdAt: now,
		updatedAt: now,
		state: "queued",
		revision: 0,
		source,
		task: Object.freeze({ ...input.task }),
		limits: Object.freeze({ ...input.limits }),
		planning: Object.freeze({}),
		backendId: input.backendId,
		transitions: [],
		resources: [],
		artifacts: [],
	};
}
