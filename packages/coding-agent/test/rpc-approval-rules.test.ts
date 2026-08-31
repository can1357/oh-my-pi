import { describe, expect, it } from "bun:test";
import {
	addRpcApprovalRule,
	listRpcApprovalRules,
	type RpcApprovalRuleStore,
	removeRpcApprovalRule,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-approval-rules";
import type { ApprovalRule } from "@oh-my-pi/pi-coding-agent/tools/approval-rules";

/**
 * In-memory stand-in for the `tools.approvalRules` session setting. Mirrors
 * `Settings.isolated`: `read()` returns whatever was written (or seeded to
 * simulate a hand-edited config file), `write()` stores the persisted value.
 */
function createStore(seed: unknown = []): RpcApprovalRuleStore & { current: () => unknown } {
	let raw: unknown = seed;
	return {
		read: () => raw,
		write: (rules: ApprovalRule[]) => {
			raw = rules;
		},
		current: () => raw,
	};
}

describe("RPC approval-rule commands (round trip)", () => {
	it("add → list → remove returns the persisted normalized list", () => {
		const store = createStore();
		const added = addRpcApprovalRule(store, {
			tool: "bash",
			match: "rm -rf /*",
			approval: "deny",
			reason: "destructive",
		});
		expect(added.ok).toBe(true);
		if (!added.ok) return;
		expect(added.rules).toEqual([{ tool: "bash", match: "rm -rf /*", approval: "deny", reason: "destructive" }]);
		// The write path persists the exact list.
		expect(store.current()).toEqual(added.rules);

		const second = addRpcApprovalRule(store, { tool: "write", approval: "allow" });
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(store.current()).toHaveLength(2);

		expect(listRpcApprovalRules(store).rules).toEqual(second.rules);

		const removed = removeRpcApprovalRule(store, 0);
		expect(removed.ok).toBe(true);
		if (!removed.ok) return;
		expect(removed.rules).toEqual([{ tool: "write", approval: "allow" }]);
		expect(store.current()).toEqual(removed.rules);
	});

	it("rejects invalid rule inputs without mutating the store", () => {
		const store = createStore();
		const badApproval = addRpcApprovalRule(store, { tool: "bash", approval: "maybe" });
		expect(badApproval).toMatchObject({ ok: false });
		if (badApproval.ok) return;
		expect(badApproval.error).toContain("approval");
		expect(store.current()).toEqual([]);

		const missingTool = addRpcApprovalRule(store, { approval: "deny" });
		expect(missingTool.ok).toBe(false);
		expect(store.current()).toEqual([]);
	});

	it("normalizes the input before persisting", () => {
		const store = createStore();
		const result = addRpcApprovalRule(store, { tool: "  bash  ", match: "  rm   -rf *  ", approval: "prompt" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(store.current()).toEqual([{ tool: "bash", match: "rm -rf *", approval: "prompt" }]);
	});

	it("removing by index rejects non-integers and out-of-range indices", () => {
		const store = createStore([{ tool: "bash", approval: "allow" }]);
		expect(removeRpcApprovalRule(store, "x")).toMatchObject({ ok: false });
		expect(removeRpcApprovalRule(store, 1.5)).toMatchObject({ ok: false });
		const outOfRange = removeRpcApprovalRule(store, 3);
		expect(outOfRange.ok).toBe(false);
		if (!outOfRange.ok) expect(outOfRange.error).toContain("out of range");
		// Failed removals leave the persisted list untouched.
		expect(store.current()).toEqual([{ tool: "bash", approval: "allow" }]);
	});

	it("lists only valid rules when the store holds hand-edited junk", () => {
		const store = createStore([
			{ tool: "bash", match: "git *", approval: "allow" },
			{ tool: "write", approval: "bogus" },
			"not an object",
		]);
		expect(listRpcApprovalRules(store).rules).toEqual([{ tool: "bash", match: "git *", approval: "allow" }]);
	});

	it("round-trips through dedup of a rule list persisted by an earlier add", () => {
		const store = createStore();
		const first = addRpcApprovalRule(store, { tool: "grep", approval: "allow" });
		if (!first.ok) throw new Error("expected add to succeed");
		const second = addRpcApprovalRule(store, { tool: "glob", approval: "deny" });
		if (!second.ok) throw new Error("expected add to succeed");
		// A fresh store seeded with the persisted list sees the same rules.
		const reloaded = createStore(store.current());
		expect(listRpcApprovalRules(reloaded).rules).toEqual([
			{ tool: "grep", approval: "allow" },
			{ tool: "glob", approval: "deny" },
		]);
	});
});
