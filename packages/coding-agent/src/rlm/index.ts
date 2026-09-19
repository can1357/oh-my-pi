export {
	formatHandle,
	maybeSpill,
	RLM_DEFAULT_SPILL_BYTES,
	RlmBudgetError,
	RlmStore,
	stubContainsFullPayload,
	stubFor,
} from "./store";
export type {
	RlmBudget,
	RlmHit,
	RlmMetrics,
	RlmPeek,
	RlmRecord,
	RlmReconcileResult,
	RlmStub,
	RlmTrajectoryEntry,
	RlmUsageReconcile,
} from "./store";

export {
	EVIDENCE_PACKET_V1_JSON_SCHEMA,
	EVIDENCE_WORKER_STATIC_SYSTEM,
	emptyEvidencePacket,
	evidencePacketByteSize,
	formatEvidencePacketForRoot,
	parseEvidencePacketV1,
	tryParseEvidencePacketJson,
} from "./evidence-packet";

export {
	EVIDENCE_PACKET_MAX_OUTPUT_BYTES,
	EVIDENCE_PACKET_V2_JSON_SCHEMA,
	EVIDENCE_WORKER_STATIC_SYSTEM as EVIDENCE_WORKER_V2_STATIC_SYSTEM,
	allPacketCitations,
	emptyEvidencePacketV2,
	evidencePacketByteSize as evidencePacketV2ByteSize,
	formatEvidencePacketForRoot as formatEvidencePacketV2ForRoot,
	parseEvidencePacketV2,
	tryParseEvidencePacketV2Json,
} from "./evidence-packet-v2";
export type {
	EvidenceAtomV2,
	EvidenceCitationV2,
	EvidenceClaimV2,
	EvidenceContradictionSideV2,
	EvidenceContradictionV2,
	EvidencePacketV2,
} from "./evidence-packet-v2";
export {
	rejectInvalidEvidencePacket,
	resolveCitationText,
	validateEvidencePacket,
} from "./evidence-validator";
export type { EvidenceValidationResult, EvidenceValidationViolation } from "./evidence-validator";
export type {
	EvidenceCitationV1,
	EvidenceClaimV1,
	EvidenceContradictionV1,
	EvidencePacketStatus,
	EvidencePacketV1,
	EvidenceRelevantRangeV1,
} from "./evidence-packet";
export { buildEvidenceWorkerContext, buildEvidenceWorkerRequest, rlmEvidenceQuery, tryDeterministicEvidencePacket } from "./evidence-query";
export type { EvidenceWorkerRequestInput, RlmEvidenceQueryResult } from "./evidence-query";
export {
	brokerResultUsageFields,
	extractWorkerUsageFromCompleter,
	resolveCompleterTotalTokens,
	workerUsageToQueryFields,
} from "./worker-usage";
export type { RlmWorkerUsage, RlmWorkerUsageFields, RlmWorkerUsageSource } from "./worker-usage";
export { runRlmWorkerCompletion } from "./worker-completion";
export type {
	RlmWorkerCompletionHost,
	RlmWorkerCompletionOptions,
	RlmWorkerCompletionResult,
} from "./worker-completion";
export { promptContainsCorpus, QUERY_SLICE, rlmQuery, workerContextContains } from "./query";
export type {
	RlmBrokerResult,
	RlmCompleter,
	RlmCompleterOptions,
	RlmQueryArgs,
	RlmQueryResult,
	RlmWorkerMessage,
} from "./query";

export {
	mergeRanges,
	parseGrantRanges,
	selectGrantsFromSearch,
} from "./select-grants";
export type {
	RlmGrantSelectPolicy,
	RlmGrantSelectResult,
	RlmSelectedHit,
} from "./select-grants";

export { parseRlmGrants, rlmSubcall } from "./subcall";
export type { RlmGrant } from "./view";
export {
	buildQueryWorkerContext,
	buildQueryWorkerRequest,
	buildSubcallWorkerContext,
	buildSubcallWorkerRequest,
	executeLeasedCompletion,
	RLM_WORKER_SYSTEM,
} from "./broker";
export type { QueryWorkerRequestInput, RlmTrajectoryRecord, RlmWorkerContext, SubcallWorkerRequestInput } from "./broker";
export { RlmLedger } from "./ledger";
export type {
	RlmLease,
	RlmLeaseStatus,
	RlmLedgerBegin,
	RlmLedgerReconcileResult,
	RlmLedgerUsage,
} from "./ledger";
export {
	assertWorkerMembrane,
	extractRlmHandleIds,
	serializeWorkerProviderPayload,
	validateWorkerMembrane,
	workerContextContainsHandle,
} from "./worker-membrane";
export type { WorkerMembraneValidation, WorkerMembraneViolation } from "./worker-membrane";
export { RlmRuntime } from "./runtime";
export type { RlmRuntimeOptions } from "./runtime";
export {
	formatViewExcerpts,
	resolveRlmView,
	RLM_VIEW_SLICE,
	viewCitations,
} from "./view";
export type { RlmResolvedGrant, RlmView } from "./view";
export { createRlmKernelBind, rlmHandleMeta, rlmKernelPrelude } from "./kernel-bind";
export { createRlmPrelude } from "./prelude";
export {
	disposeRlmRuntime,
	disposeRlmStore,
	getContextEngine,
	getRlmRuntime,
	getRlmStore,
	resetRlmStoresForTest,
	rlmEnabled,
	rlmIsExclusiveEngine,
	rlmKernelBindEnabled,
	rlmSessionKey,
	rlmSpillBytes,
	rlmWorkerMode,
	rlmWorkerModeOverride,
	rlmWorkerModeSetting,
} from "./session";
export {
	classifyGrantComplexity,
	complexityShortLabel,
	formatAutoGateFlowDecision,
	formatWorkerModeDecisionLine,
	resolveAutoWorkerMode,
	resolveEffectiveWorkerMode,
	workerModeInputFromSelection,
} from "./worker-mode-policy";
export type {
	GrantComplexityClass,
	RlmWorkerModeEffective,
	RlmWorkerModeOverride as RlmWorkerModeOverridePolicy,
	RlmWorkerModeSetting,
	WorkerModeAutoDecision,
	WorkerModePolicyInput,
} from "./worker-mode-policy";
export type { ContextEngine, RlmSessionHost } from "./session";
export { appendRlmRuntimeGuide, RLM_RUNTIME_GUIDE, rlmGuideIsAppendOnly } from "./guide";
export { wrapToolWithRlmSpill } from "./wrap";

export {
	RLM_ACCOUNTING_SCHEMA_VERSION,
	buildRlmSessionAccounting,
	collectRlmSessionAccounting,
	exportRlmExperimentRecord,
	formatRlmAccountingSummary,
} from "./accounting";
export type {
	AccountingSources,
	EvidenceQualityLabel,
	ExperimentRecordOptions,
	RlmOpsCounters,
	RlmSessionAccounting,
	TokenBucket,
} from "./accounting";

export {
	OmpTokenomicsBridge,
	createTokenomicsBridge,
	deriveContextPolicy,
} from "./tokenomics-bridge";
export type { ContextPolicy, ModelCallEmit, TokenomicsBridgeOptions } from "./tokenomics-bridge";

export {
	launchShadowWorkerNeeded,
	runShadowWorkerNeeded,
	createMockShadowPredictor,
	createBridgeDeciderPredictor,
	setShadowPredictorForTest,
	requestShadowDeciderWarm,
	registerZ0intBridgeTransport,
	getZ0intBridgeTransport,
	WORKER_NEEDED_CAPABILITY,
	SHADOW_EXPERIMENT_ID,
} from "./shadow";
export type { ShadowPrediction, ShadowWorkerNeededResult, Z0intBridgeTransport } from "./shadow";
export {
	freezeWorkerNeededReplaySnapshot,
	runWorkerNeededPairedReplay,
	labelFromPairedArms,
	loadReplayCandidatesSorted,
	WORKER_NEEDED_REPLAY_EXPERIMENT,
} from "./shadow";
export type { PairedReplayResult, WorkerNeededReplaySnapshot, GoldLabel } from "./shadow";

