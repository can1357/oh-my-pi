/**
 * Capability Approval Policy — controlled-write evaluator.
 *
 * Fine-grained approval rules based on capability mutability, risk level, and
 * workspace/external side effects, plus a factory that packages the policy as
 * a `CapabilityGate` for `planCapabilityBundle`.
 *
 * Discipline:
 *   - Read-only capabilities: auto-allowed (unless risk-flagged upstream).
 *   - Workspace-write capabilities: require approval unless the session write
 *     scope covers them or they are explicitly pre-authorized.
 *   - External-write and destructive capabilities: ALWAYS require user
 *     approval — pre-authorization and scope flags cannot bypass this.
 *   - Critical risk: ALWAYS requires approval — no override flag unlocks it.
 *   - Fail-safe: unknown mutability or hostile input defaults to mandatory
 *     approval (`workspace-write` / `medium` assumptions, never auto-allow).
 */

import type { CapabilityGate, GateContext, GateVerdict } from "./capability-planner-adapter";

export type CapabilityMutability = "read-only" | "workspace-write" | "external-write" | "destructive";

export type CapabilityRiskLevel = "low" | "medium" | "high" | "critical";

/**
 * The capability shape this policy evaluates. Kept local on purpose: the
 * graph layer deals in ids/edges and does not model mutability or risk, so
 * the policy owns its own input contract.
 */
export interface PolicyCapability {
	id?: string;
	mutability?: CapabilityMutability;
	risk?: CapabilityRiskLevel;
}

export interface ApprovalPolicyOptions {
	/**
	 * Allowed write scope for auto-approval. Default: "read-only".
	 * Note: "external-write" scope still only auto-allows up to
	 * workspace-write — external writes always require approval.
	 */
	allowedWriteScope?: "read-only" | "workspace-write" | "external-write";
	/** Explicit pre-authorized capability IDs for this session. */
	preAuthorizedIds?: ReadonlySet<string> | readonly string[];
	/**
	 * Allow HIGH risk without approval (default: false).
	 * Never applies to critical risk — critical always requires approval.
	 */
	allowHighRiskWithoutApproval?: boolean;
}

export interface PolicyEvaluationResult {
	capabilityId: string;
	requiresApproval: boolean;
	decision: "allow" | "needs-approval" | "deny";
	reason: string;
}

function isPreAuthorized(id: string, ids: ApprovalPolicyOptions["preAuthorizedIds"]): boolean {
	if (!ids) return false;
	// Both ReadonlySet<string> and readonly string[] are Iterable<string>;
	// iterating avoids union narrowing entirely (tsgo does not special-case
	// Array.isArray against readonly arrays).
	for (const authorized of ids) {
		if (authorized === id) return true;
	}
	return false;
}

/**
 * Evaluate approval policy for a single capability. Pure; never throws.
 */
export function evaluateCapabilityApproval(
	node: PolicyCapability,
	options: ApprovalPolicyOptions = {},
): PolicyEvaluationResult {
	const id = typeof node.id === "string" && node.id.length > 0 ? node.id : "unknown";
	const mutability: CapabilityMutability = node.mutability ?? "workspace-write";
	const risk: CapabilityRiskLevel = node.risk ?? "medium";

	// Hard floors first — no flag, scope, or pre-authorization bypasses these.
	if (mutability === "destructive") {
		return {
			capabilityId: id,
			requiresApproval: true,
			decision: "needs-approval",
			reason: `capability "${id}" is destructive and requires user approval`,
		};
	}

	if (mutability === "external-write") {
		return {
			capabilityId: id,
			requiresApproval: true,
			decision: "needs-approval",
			reason: `capability "${id}" performs external writes and requires user approval`,
		};
	}

	if (risk === "critical") {
		return {
			capabilityId: id,
			requiresApproval: true,
			decision: "needs-approval",
			reason: `capability "${id}" is flagged as critical risk`,
		};
	}

	// Session pre-authorization (only reachable for non-destructive,
	// non-external-write, non-critical capabilities).
	if (isPreAuthorized(id, options.preAuthorizedIds)) {
		return {
			capabilityId: id,
			requiresApproval: false,
			decision: "allow",
			reason: `capability "${id}" is explicitly pre-authorized for session`,
		};
	}

	if (risk === "high" && options.allowHighRiskWithoutApproval !== true) {
		return {
			capabilityId: id,
			requiresApproval: true,
			decision: "needs-approval",
			reason: `capability "${id}" is flagged as high risk`,
		};
	}

	if (mutability === "workspace-write") {
		if (options.allowedWriteScope === "workspace-write" || options.allowedWriteScope === "external-write") {
			return {
				capabilityId: id,
				requiresApproval: false,
				decision: "allow",
				reason: "workspace-write allowed by session write scope",
			};
		}
		return {
			capabilityId: id,
			requiresApproval: true,
			decision: "needs-approval",
			reason: "workspace-write requires approval under read-only scope",
		};
	}

	// read-only
	return {
		capabilityId: id,
		requiresApproval: false,
		decision: "allow",
		reason: "read-only capability allowed",
	};
}

/**
 * Build a `CapabilityGate` (compatible with `planCapabilityBundle`) that
 * evaluates approval policy for each planned capability.
 */
export function createWriteApprovalGate(
	nodesById: ReadonlyMap<string, PolicyCapability>,
	options: ApprovalPolicyOptions = {},
): CapabilityGate {
	return (id: string, ctx: GateContext): GateVerdict => {
		if (ctx.recommendedExclusion) {
			return {
				decision: "deny",
				reason: `capability "${id}" recommended for exclusion by fidelity policy`,
			};
		}

		if (ctx.riskFlagged) {
			return {
				decision: "needs-approval",
				reason: `capability "${id}" risk-flagged in planner context`,
			};
		}

		// Unknown capabilities fail safe: assumed workspace-write / medium risk.
		const node = nodesById.get(id) ?? { id };
		const evalResult = evaluateCapabilityApproval(node, options);

		return {
			decision: evalResult.decision,
			reason: evalResult.reason,
		};
	};
}

export interface UserConflictQuestion {
	id: string;
	question: string;
	options: Array<{ label: string; description: string }>;
	/** Index into `options`; omitted when the policy has no basis to recommend. */
	recommended?: number;
}

/**
 * Format a needs-user conflict decision into a structured question object
 * suitable for an interactive prompt. Purely presentational: it never picks a
 * side, so `recommended` is left unset.
 */
export function formatUserConflictQuestion(conflict: {
	a: string;
	b: string;
	type?: string;
	reason?: string;
}): UserConflictQuestion {
	return {
		id: `conflict_${conflict.a}_vs_${conflict.b}`,
		question: `Select which capability to use for this task (${conflict.a} vs ${conflict.b}):`,
		options: [
			{
				label: conflict.a,
				description: `Use capability "${conflict.a}" (disables conflicting "${conflict.b}")`,
			},
			{
				label: conflict.b,
				description: `Use capability "${conflict.b}" (disables conflicting "${conflict.a}")`,
			},
		],
	};
}
