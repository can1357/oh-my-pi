import type { GatewayErrorClassification, GatewayErrorDisposition } from "../error/gateway";
import type { CompiledRoute } from "./route-graph";
import type { StreamCommitState } from "./stream-commit-gate";

export type ConductorAction =
	| { type: "dispatch"; targetModelId: string }
	| { type: "sibling_credential" }
	| { type: "fallback_target"; targetModelId: string }
	| { type: "terminal" };

export interface ExecutionState {
	routeId: string;
	generation: number;
	attemptedTargets: ReadonlySet<string>;
	retryCount: number;
	fallbackCount: number;
	committed: boolean;
	currentTarget: string;
}

/**
 * Frozen Wave B CompiledRoute fields. RouteRegistry may still be the Wave A
 * shim (no `targets` / `fallbacks`); callers and tests supply them.
 */
type ConductorRoute = CompiledRoute & {
	targets: readonly string[];
	fallbacks: Readonly<Partial<Record<GatewayErrorDisposition, readonly string[]>>>;
};

function firstUnused(ids: readonly string[] | undefined, attempted: ReadonlySet<string>): string | undefined {
	if (!ids) return undefined;
	for (const id of ids) {
		if (!attempted.has(id)) return id;
	}
	return undefined;
}

/**
 * Pure next-action picker. Does not select accounts or perform I/O.
 * Cross-model failover is forbidden once the stream has left `probing`.
 */
export function decideAttempt(args: {
	route: CompiledRoute;
	state: ExecutionState;
	classification?: GatewayErrorClassification;
	commitState: StreamCommitState;
}): ConductorAction {
	const { state, classification, commitState } = args;
	const route = args.route as ConductorRoute;

	if (commitState !== "probing" || state.committed) {
		return { type: "terminal" };
	}

	if (!classification) {
		const next = firstUnused(route.targets, state.attemptedTargets);
		return next === undefined ? { type: "terminal" } : { type: "dispatch", targetModelId: next };
	}

	const { disposition } = classification;
	switch (disposition) {
		case "cancelled":
		case "request_terminal":
		case "policy_terminal":
		case "gateway_terminal":
		case "credential_permanent":
			return { type: "terminal" };
		case "credential_quota":
		case "credential_transient":
			return { type: "sibling_credential" };
		case "provider_transient":
		case "provider_unavailable":
		case "model_unavailable":
		case "context_overflow": {
			const next = firstUnused(route.fallbacks[disposition], state.attemptedTargets);
			return next === undefined ? { type: "terminal" } : { type: "fallback_target", targetModelId: next };
		}
		default: {
			const _never: never = disposition;
			return _never;
		}
	}
}
