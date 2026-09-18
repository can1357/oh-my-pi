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
export { parseRlmGrants, rlmSubcall } from "./subcall";
export type { RlmGrant } from "./subcall";
export { createRlmKernelBind, rlmHandleMeta, rlmKernelPrelude } from "./kernel-bind";
export type { RlmKernelBindApi } from "./kernel-bind";
export {
	getContextEngine,
	getRlmStore,
	resetRlmStoresForTest,
	rlmEnabled,
	rlmIsExclusiveEngine,
	rlmKernelBindEnabled,
	rlmSessionKey,
	rlmSpillBytes,
	rlmSubModel,
	systemPromptWithRlmGuide,
} from "./session";
export type { ContextEngine } from "./session";
export { appendRlmRuntimeGuide, RLM_RUNTIME_GUIDE, rlmGuideIsAppendOnly } from "./guide";
export { wrapToolWithRlmSpill } from "./wrap";
