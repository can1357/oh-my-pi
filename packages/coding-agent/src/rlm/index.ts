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
} from "./session";
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
