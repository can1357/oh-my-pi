/**
 * Observe-only Decider shadow for `rlm.worker_needed`.
 *
 * Fire-and-forget: never awaits on the critical path, never changes worker execution.
 */
import type { OmpTokenomicsBridge } from "../tokenomics-bridge";
import type { WorkerModeAutoDecision, WorkerModePolicyInput } from "../worker-mode-policy";
import { classifyGrantComplexity } from "../worker-mode-policy";
import { getShadowPredictor, requestShadowDeciderWarm, type ShadowPrediction } from "./decider-client";
import { enqueueShadowReplayCandidate, scoreReplayPriority } from "./replay-queue";
import { freezeWorkerNeededReplaySnapshot } from "./replay-snapshot";
import {
	actualPolicyToLabel,
	buildWorkerNeededDecisionRequest,
	buildWorkerNeededFeatureState,
	featureStateHash,
	SHADOW_BACKEND_ID,
	SHADOW_EXPERIMENT_ID,
	shadowPairId,
	shadowTreatmentHash,
	WORKER_NEEDED_CAPABILITY,
	WORKER_NEEDED_CONTRACT,
	WORKER_NEEDED_FEATURE_SCHEMA,
	type WorkerNeededLabel,
} from "./worker-needed-features";

export interface ShadowWorkerNeededHost {
	getTokenomicsBridge?: () => OmpTokenomicsBridge | undefined;
	settings?: { get(path: string): unknown };
	getSessionId?: () => string | null | undefined;
	/** Optional Context Flow owner (AgentSession / flowOwner). */
	flowOwner?: object;
}

export interface LaunchShadowWorkerNeededInput {
	host: ShadowWorkerNeededHost;
	policyInput: WorkerModePolicyInput;
	useEvidencePacket: boolean;
	handle: string;
	/** Private granted evidence for WorkerNeededReplayV1 freeze (never Tokenomics). */
	grantedEvidence?: string;
	autoDecision?: WorkerModeAutoDecision | null;
	/** When set, context-flow shadow node is recorded. */
	onFlow?: (args: {
		prediction?: WorkerNeededLabel;
		confidence?: number;
		latencyMs: number;
		status: ShadowPrediction["status"];
		reason?: string;
		runtime?: ShadowPrediction["runtime"];
	}) => void;
	signal?: AbortSignal;
}

export interface ShadowWorkerNeededResult {
	launched: boolean;
	skippedReason?: string;
	/** Present only when awaited (tests). */
	prediction?: ShadowPrediction;
	actualPolicy?: Exclude<WorkerNeededLabel, "abstain">;
	disagreed?: boolean;
	traceId?: string;
	pairId?: string;
	enqueuedReplay?: boolean;
	replaySnapshotId?: string;
}

function shadowEnabled(host: ShadowWorkerNeededHost): boolean {
	const env = process.env.OMP_SHADOW_WORKER_NEEDED?.trim().toLowerCase();
	if (env === "0" || env === "false" || env === "off") return false;
	if (env === "1" || env === "true" || env === "on") return true;
	const setting = host.settings?.get("rlm.shadow.workerNeeded");
	return setting === true;
}

function shadowTimeoutMs(host: ShadowWorkerNeededHost): number {
	const raw = host.settings?.get("rlm.shadow.timeoutMs");
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
	const env = Number(process.env.OMP_SHADOW_TIMEOUT_MS);
	if (Number.isFinite(env) && env > 0) return env;
	// Warm resident Decider should answer in tens–hundreds of ms; keep fail-open.
	return 500;
}

/**
 * Awaitable core used by tests. Production callers use {@link launchShadowWorkerNeeded}.
 */
export async function runShadowWorkerNeeded(input: LaunchShadowWorkerNeededInput): Promise<ShadowWorkerNeededResult> {
	if (!shadowEnabled(input.host)) {
		return { launched: false, skippedReason: "shadow_disabled" };
	}
	const bridge = input.host.getTokenomicsBridge?.();
	if (!bridge?.enabled) {
		return { launched: false, skippedReason: "tokenomics_disabled" };
	}

	const { complexity } = classifyGrantComplexity(input.policyInput);
	const featureState = buildWorkerNeededFeatureState({
		policyInput: input.policyInput,
		complexity,
		autoDecision: input.autoDecision,
	});
	const request = buildWorkerNeededDecisionRequest(featureState);
	const featureHash = featureStateHash(featureState);
	const sessionId = input.host.getSessionId?.() ?? bridge.sessionId;
	const pairId = shadowPairId({ sessionId, handle: input.handle, featureHash });
	const actualPolicy = actualPolicyToLabel(input.useEvidencePacket);
	const timeoutMs = shadowTimeoutMs(input.host);
	// Background prewarm — never awaited on the hot path.
	requestShadowDeciderWarm();

	const prediction = await getShadowPredictor()(request, {
		signal: input.signal,
		timeoutMs,
	});

	input.onFlow?.({
		prediction: prediction.prediction,
		confidence: prediction.confidence,
		latencyMs: prediction.latencyMs,
		status: prediction.status,
		reason: prediction.reason,
		runtime: prediction.runtime,
	});

	const treatment = shadowTreatmentHash({
		backendId: prediction.backendId || SHADOW_BACKEND_ID,
		featureSchema: WORKER_NEEDED_FEATURE_SCHEMA,
		contract: WORKER_NEEDED_CONTRACT,
		device: prediction.device,
		revision: prediction.revision,
	});

	await bridge.emitShadowWorkerNeeded({
		pairId,
		taskSnapshotId: featureHash,
		armId: SHADOW_BACKEND_ID,
		treatmentHash: treatment,
		status:
			prediction.status === "unavailable" || prediction.status === "warming"
				? "unknown"
				: prediction.status,
		prediction: prediction.prediction,
		probabilities: prediction.probabilities,
		confidence: prediction.confidence,
		abstained: prediction.abstained,
		latencyMs: prediction.latencyMs,
		revision: prediction.revision,
		actualPolicy,
		featureSchema: WORKER_NEEDED_FEATURE_SCHEMA,
		grantedBytes: featureState.granted_bytes,
		complexityClass: featureState.complexity_class,
		errorClass: prediction.errorClass,
		reason: prediction.reason,
		runtime: prediction.runtime,
	});

	const disagreed =
		prediction.status === "ok" &&
		prediction.prediction !== undefined &&
		prediction.prediction !== "abstain" &&
		prediction.prediction !== actualPolicy;

	let enqueuedReplay = false;
	let replaySnapshotId: string | undefined;
	if (prediction.status === "ok" && (disagreed || (prediction.confidence ?? 1) < 0.75)) {
		const scored = scoreReplayPriority({
			disagrees: Boolean(disagreed),
			confidence: prediction.confidence,
			grantedBytes: featureState.granted_bytes,
			goldUnknown: true,
			expectedWorkerCost: Math.min(1, featureState.granted_bytes / 12_000),
			capabilityEvidenceGap: 0.85,
		});
		if (scored.priority > 0) {
			const evidence =
				input.grantedEvidence?.trim() ||
				input.policyInput.grantTextSample?.trim() ||
				"";
			if (evidence.length > 0) {
				try {
					const snap = await freezeWorkerNeededReplaySnapshot({
						pairId,
						traceId: bridge.traceId,
						sessionId: String(sessionId ?? bridge.sessionId),
						handle: input.handle,
						policyInput: input.policyInput,
						featureState,
						featureHash,
						grantedEvidence: evidence,
						shadowPrediction: prediction.prediction,
						actualPolicy,
						confidence: prediction.confidence,
						autoDecision: input.autoDecision,
						provenance: {
							selection_policy: "shadow_disagreement",
							shadow_backend_id: SHADOW_BACKEND_ID,
							feature_schema: WORKER_NEEDED_FEATURE_SCHEMA,
							contract: WORKER_NEEDED_CONTRACT,
						},
					});
					replaySnapshotId = snap.manifest.snapshot_id;
				} catch {
					/* fail-open: queue without snapshot */
				}
			}
			await enqueueShadowReplayCandidate({
				schema: "omp.shadow.replay_candidate.v1",
				ts: Date.now(),
				trace_id: bridge.traceId,
				pair_id: pairId,
				capability_id: WORKER_NEEDED_CAPABILITY,
				backend_id: SHADOW_BACKEND_ID,
				priority: scored.priority,
				reasons: scored.reasons,
				shadow_prediction: prediction.prediction,
				actual_policy: actualPolicy,
				confidence: prediction.confidence,
				replay_snapshot_id: replaySnapshotId,
				expected_worker_cost: Math.min(1, featureState.granted_bytes / 12_000),
				capability_evidence_gap: 0.85,
			});
			enqueuedReplay = true;
		}
	}

	return {
		launched: true,
		prediction,
		actualPolicy,
		disagreed,
		traceId: bridge.traceId,
		pairId,
		enqueuedReplay,
		replaySnapshotId,
	};
}

/**
 * Non-blocking launch. Never throws into the caller; never awaits on the hot path.
 */
export function launchShadowWorkerNeeded(input: LaunchShadowWorkerNeededInput): void {
	void runShadowWorkerNeeded(input).catch(() => {
		/* fail-open */
	});
}

export { SHADOW_EXPERIMENT_ID, WORKER_NEEDED_CAPABILITY, SHADOW_BACKEND_ID };
