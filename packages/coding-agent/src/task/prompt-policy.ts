import { type DelegationBias, resolveDelegationBias } from "@oh-my-pi/pi-catalog/compat/delegation";
import type { ToolSession } from "..";

/**
 * Delegation bias of the session's active model, for tool descriptions that
 * nudge toward subagents; `eager` before a model is bound.
 */
export function sessionDelegationBias(session: ToolSession): DelegationBias {
	const model = session.getActiveModel?.();
	return model ? resolveDelegationBias(model) : "eager";
}
