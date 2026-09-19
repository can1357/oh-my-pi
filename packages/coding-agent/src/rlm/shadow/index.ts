export {
	registerZ0intBridgeTransport,
	getZ0intBridgeTransport,
} from "./bridge-transport";
export type { Z0intBridgeTransport } from "./bridge-transport";

export {
	WORKER_NEEDED_CAPABILITY,
	WORKER_NEEDED_FEATURE_SCHEMA,
	WORKER_NEEDED_CONTRACT,
	SHADOW_EXPERIMENT_ID,
	SHADOW_BACKEND_ID,
	buildWorkerNeededFeatureState,
	buildWorkerNeededDecisionRequest,
	actualPolicyToLabel,
	featureStateHash,
	shadowPairId,
	shadowTreatmentHash,
} from "./worker-needed-features";
export type {
	WorkerNeededLabel,
	WorkerNeededFeatureState,
	WorkerNeededDecisionRequest,
} from "./worker-needed-features";

export {
	createZ0intDeciderPredictor,
	createBridgeDeciderPredictor,
	createMockShadowPredictor,
	setShadowPredictorForTest,
	getShadowPredictor,
	requestShadowDeciderWarm,
} from "./decider-client";
export type { ShadowPrediction, ShadowPredictor } from "./decider-client";

export {
	enqueueShadowReplayCandidate,
	scoreReplayPriority,
	defaultReplayQueuePath,
} from "./replay-queue";
export type { ShadowReplayCandidate } from "./replay-queue";

export { launchShadowWorkerNeeded, runShadowWorkerNeeded } from "./worker-needed";
export type { LaunchShadowWorkerNeededInput, ShadowWorkerNeededHost, ShadowWorkerNeededResult } from "./worker-needed";

export {
	defaultWorkerNeededReplayRoot,
	freezeWorkerNeededReplaySnapshot,
	loadWorkerNeededReplaySnapshot,
	deriveVerifierFromEvidence,
	WORKER_NEEDED_REPLAY_EXPERIMENT,
	WORKER_NEEDED_REPLAY_SCHEMA,
} from "./replay-snapshot";
export type {
	WorkerNeededReplaySnapshot,
	ReplayVerifierSpec,
	WorkerNeededReplayManifest,
} from "./replay-snapshot";

export {
	runWorkerNeededPairedReplay,
	labelFromPairedArms,
	assessNonInferiority,
	verifyArmText,
	grantGroundedCompleter,
	evidencePacketCompleter,
} from "./paired-replay";
export type { PairedReplayResult, GoldLabel, ArmMetrics } from "./paired-replay";

export { loadReplayCandidatesSorted } from "./replay-queue";
