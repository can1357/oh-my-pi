import type { GatewayErrorDisposition } from "./gateway";

/** Orchestration actions a classified gateway failure may trigger. */
export interface FailureAction {
	refreshCredential?: boolean;
	trySiblingCredential?: boolean;
	retryTarget?: boolean;
	fallbackTarget?: boolean;
	cooldownCredential?: boolean;
	penalizeTargetHealth?: boolean;
}

const EMPTY_ACTION: FailureAction = {};

const SIBLING_CREDENTIAL_ACTION: FailureAction = {
	trySiblingCredential: true,
	cooldownCredential: true,
};

const FALLBACK_TARGET_ACTION: FailureAction = {
	fallbackTarget: true,
	penalizeTargetHealth: true,
};

const RETRY_AND_FALLBACK_TARGET_ACTION: FailureAction = {
	retryTarget: true,
	fallbackTarget: true,
	penalizeTargetHealth: true,
};

const ACTION_FOR_DISPOSITION: Record<GatewayErrorDisposition, FailureAction> = {
	cancelled: EMPTY_ACTION,
	request_terminal: EMPTY_ACTION,
	policy_terminal: EMPTY_ACTION,
	gateway_terminal: EMPTY_ACTION,
	credential_permanent: EMPTY_ACTION,
	credential_quota: SIBLING_CREDENTIAL_ACTION,
	credential_transient: SIBLING_CREDENTIAL_ACTION,
	provider_transient: RETRY_AND_FALLBACK_TARGET_ACTION,
	provider_unavailable: FALLBACK_TARGET_ACTION,
	model_unavailable: FALLBACK_TARGET_ACTION,
	context_overflow: FALLBACK_TARGET_ACTION,
};

/** Map a gateway error disposition to retry / failover / cooldown actions. */
export function actionForDisposition(d: GatewayErrorDisposition): FailureAction {
	return ACTION_FOR_DISPOSITION[d];
}
