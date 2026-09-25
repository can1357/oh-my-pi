/**
 * Regression tests for the branch-direction contract of
 * `SessionEntryIndex.pathTo()` (exposed via `SessionManager.getBranch()`).
 *
 * A botched merge once introduced a duplicated `branch.reverse()`, returning
 * branches leaf→root instead of root→leaf. Observable fallout:
 * `getLastModelChangeRole()` — which scans the branch from the end — returned
 * the OLDEST model_change role instead of the newest, breaking role cycling
 * and session model restore. These tests pin both the ordering contract and
 * the newest-role selection so a re-reversed branch fails loudly.
 */
import { describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("SessionManager branch ordering", () => {
	it("getBranch() returns entries root→leaf with the newest entry last", () => {
		const manager = SessionManager.inMemory();
		const firstId = manager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		const secondId = manager.appendModelChange("anthropic/claude-sonnet-4-6", "slow");

		const branch = manager.getBranch();
		const ids = branch.map(entry => entry.id);
		const firstIndex = ids.indexOf(firstId);
		const secondIndex = ids.indexOf(secondId);

		// Both entries are on the branch, in append order (root→leaf). Under a
		// leaf→root return these flip and the comparison fails.
		expect(firstIndex).toBeGreaterThanOrEqual(0);
		expect(secondIndex).toBeGreaterThanOrEqual(0);
		expect(firstIndex).toBeLessThan(secondIndex);

		// The most recently appended entry is the leaf, i.e. the LAST element.
		expect(ids[ids.length - 1]).toBe(secondId);

		// Parent-chain invariant: in root→leaf order every entry's parent is
		// exactly the preceding element. A reversed branch inverts the chain
		// (each parentId would point at the FOLLOWING element) and fails here.
		for (let i = 1; i < branch.length; i++) {
			expect(branch[i].parentId).toBe(branch[i - 1].id);
		}
	});

	it("miss-path results do not alias the branch cache", () => {
		const manager = SessionManager.inMemory();
		manager.appendModelChange("m/a", "default");
		manager.appendModelChange("m/b", "slow");
		// First call populates the cache AND returns the array: mutating it
		// must not corrupt subsequent hits.
		const first = manager.getBranch();
		const ids = first.map(entry => entry.id);
		first.reverse();
		first.splice(0, 1);
		const second = manager.getBranch();
		expect(second.map(entry => entry.id)).toEqual(ids);
	});

	it("stops a corrupt cyclic parent chain at the first repeated id", () => {
		const manager = SessionManager.inMemory();
		manager.appendModelChange("m/a", "default");
		const leaf = manager.appendModelChange("m/b", "slow");
		manager.appendModelChange("m/c", "smol");
		// Corrupt the leaf into a self-cycle through the shared entry ref.
		const branch = manager.getBranch();
		const leafEntry = branch.find(entry => entry.id === leaf)!;
		const savedParent = leafEntry.parentId;
		leafEntry.parentId = leafEntry.id;
		try {
			const cyclic = manager.getBranch(leaf);
			const ids = cyclic.map(entry => entry.id);
			// Each id exactly once — no [entry, entry] duplication that
			// would replay/account for an entry twice downstream.
			expect(new Set(ids).size).toBe(ids.length);
			expect(ids.filter(id => id === leaf)).toHaveLength(1);
		} finally {
			leafEntry.parentId = savedParent;
		}
	});

	it("getLastModelChangeRole() returns the newest model_change role on the branch", () => {
		const manager = SessionManager.inMemory();
		manager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		manager.appendModelChange("anthropic/claude-sonnet-4-6", "slow");

		// Newest role wins. A leaf→root branch makes the backwards scan hit the
		// OLDEST entry first and return "default" here.
		expect(manager.getLastModelChangeRole()).toBe("slow");

		// Third change with a role distinct from BOTH earlier ones, so the
		// assertion stays asymmetric: on a reversed branch the scan would find
		// "default" (the old root), never "smol".
		manager.appendModelChange("anthropic/claude-haiku-4-5", "smol");
		expect(manager.getLastModelChangeRole()).toBe("smol");
	});
});
