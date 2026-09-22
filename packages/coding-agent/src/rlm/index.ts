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
	RlmPeek,
	RlmRecord,
	RlmReconcileResult,
	RlmStub,
	RlmTrajectoryEntry,
	RlmUsageReconcile,
} from "./store";
export { promptContainsCorpus, QUERY_SLICE, rlmQuery } from "./query";
export type { RlmCompleter, RlmCompleterOptions, RlmQueryResult } from "./query";
export {
	disposeRlmStore,
	getContextEngine,
	getRlmStore,
	resetRlmStoresForTest,
	rlmEnabled,
	rlmIsExclusiveEngine,
	rlmSessionKey,
	rlmSpillBytes,
	rlmSubModel,
	systemPromptWithRlmGuide,
} from "./session";
export type { ContextEngine, RlmSessionHost } from "./session";
export { appendRlmRuntimeGuide, RLM_RUNTIME_GUIDE, rlmGuideIsAppendOnly } from "./guide";
export { wrapToolWithRlmSpill } from "./wrap";
