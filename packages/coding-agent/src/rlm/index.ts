export {
	formatHandle,
	maybeSpill,
	RLM_DEFAULT_SPILL_BYTES,
	RlmBudgetError,
	RlmStore,
	stubContainsFullPayload,
	stubFor,
} from "./store";
export type { RlmBudget, RlmHit, RlmPeek, RlmRecord, RlmStub, RlmTrajectoryEntry } from "./store";
export { promptContainsCorpus, QUERY_SLICE, rlmQuery } from "./query";
export type { RlmCompleter, RlmQueryResult } from "./query";
export {
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
export type { ContextEngine } from "./session";
export { appendRlmRuntimeGuide, RLM_RUNTIME_GUIDE, rlmGuideIsAppendOnly } from "./guide";
export { wrapToolWithRlmSpill } from "./wrap";
