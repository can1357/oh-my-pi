/**
 * RPC command handlers for `tools.approvalRules` (contract item 5).
 *
 * add_approval_rule / list_approval_rules / remove_approval_rule operate on the
 * session settings key through a minimal store so rpc-mode stays thin and the
 * pure logic is unit-testable without an AgentSession. The store's `write`
 * funnels into the existing settings write path, which persists the change.
 */
import { type ApprovalRule, normalizeApprovalRule, normalizeApprovalRules } from "../../tools/approval-rules";

/** Minimal persistence seam over the `tools.approvalRules` session setting. */
export interface RpcApprovalRuleStore {
	/** Raw `tools.approvalRules` value (untrusted; normalized on read). */
	read(): unknown;
	/** Persist a normalized, ordered rule list. */
	write(rules: ApprovalRule[]): void;
}

export type RpcApprovalRuleAddResult = { ok: true; rules: ApprovalRule[] } | { ok: false; error: string };
export type RpcApprovalRuleRemoveResult = { ok: true; rules: ApprovalRule[] } | { ok: false; error: string };

function currentRules(store: RpcApprovalRuleStore): ApprovalRule[] {
	return normalizeApprovalRules(store.read());
}

/** Validate and append a rule; returns the full normalized list. */
export function addRpcApprovalRule(store: RpcApprovalRuleStore, ruleInput: unknown): RpcApprovalRuleAddResult {
	const rule = normalizeApprovalRule(ruleInput);
	if (!rule) {
		return {
			ok: false,
			error: 'Invalid approval rule. Expected an object with a non-empty `tool` string and an `approval` of "allow", "deny", or "prompt".',
		};
	}
	const rules = [...currentRules(store), rule];
	store.write(rules);
	return { ok: true, rules };
}

/** Return the current normalized rule list. */
export function listRpcApprovalRules(store: RpcApprovalRuleStore): { rules: ApprovalRule[] } {
	return { rules: currentRules(store) };
}

/** Remove the rule at `index` (0-based); errors when out of range. */
export function removeRpcApprovalRule(store: RpcApprovalRuleStore, indexInput: unknown): RpcApprovalRuleRemoveResult {
	if (typeof indexInput !== "number" || !Number.isInteger(indexInput)) {
		return { ok: false, error: `Approval rule index must be an integer, got: ${String(indexInput)}` };
	}
	const rules = currentRules(store);
	if (indexInput < 0 || indexInput >= rules.length) {
		return {
			ok: false,
			error: `Approval rule index out of range: ${indexInput} (${rules.length} rule(s) configured)`,
		};
	}
	const next = rules.filter((_, index) => index !== indexInput);
	store.write(next);
	return { ok: true, rules: next };
}
