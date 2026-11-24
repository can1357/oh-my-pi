/** Command name for applying a staged action. */
export const RESOLVE_COMMAND_NAME = "resolve";

/** Command name for discarding a staged action. */
export const REJECT_COMMAND_NAME = "reject";

/** Command name for submitting a plan. */
export const PROPOSE_COMMAND_NAME = "propose";

/** Names of the staged-action commands. */
export type ResolutionCommandName =
	| typeof RESOLVE_COMMAND_NAME
	| typeof REJECT_COMMAND_NAME
	| typeof PROPOSE_COMMAND_NAME;

/** Resolution applied to a staged action. */
export type ResolveAction = "apply" | "discard";

/** Details payload carried on a resolve/reject result (and on its `ToolCommandDispatch.inner`). */
export interface ResolveDetails {
	action: ResolveAction;
	reason: string;
	sourceToolName?: string;
	label?: string;
	sourceResultDetails?: unknown;
}

/** Invoker input for queued pending-preview handlers. */
export interface ResolveInvocation {
	action: ResolveAction;
	reason: string;
}
