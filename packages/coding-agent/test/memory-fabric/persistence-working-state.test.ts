import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PersistenceScope } from "@oh-my-pi/pi-coding-agent/memory-fabric/persistence/types";
import { createEmptyWorkingState, scopeKey } from "@oh-my-pi/pi-coding-agent/memory-fabric/persistence/types";
import { WorkingStateStore } from "@oh-my-pi/pi-coding-agent/memory-fabric/persistence/working-state-store";

const SCOPE: PersistenceScope = { projectId: "proj-a", sessionId: "sess-1" };

describe("WorkingStateStore", () => {
	let dir: string;
	let store: WorkingStateStore;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-working-state-"));
		store = new WorkingStateStore({ dbPath: path.join(dir, "state.sqlite"), scope: SCOPE });
	});

	afterEach(() => {
		store.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("returns a fresh empty state when nothing was persisted", () => {
		const state = store.getCurrent();
		expect(state.objective).toBe("");
		expect(state.constraints).toEqual([]);
		expect(state.filesTouched).toEqual([]);
	});

	it("does not share array instances between fresh states", () => {
		const first = createEmptyWorkingState();
		first.filesTouched.push("a.ts");
		expect(createEmptyWorkingState().filesTouched).toEqual([]);
	});

	it("persists updates across store instances", () => {
		store.setObjective("ship the persistence lane");
		store.addFileTouched("src/a.ts");
		store.close();

		store = new WorkingStateStore({ dbPath: path.join(dir, "state.sqlite"), scope: SCOPE });
		const state = store.getCurrent();
		expect(state.objective).toBe("ship the persistence lane");
		expect(state.filesTouched).toEqual(["src/a.ts"]);
	});

	it("deduplicates files, constraints, and errors", () => {
		store.addFileTouched("src/a.ts");
		store.addFileTouched("src/a.ts");
		store.addConstraint("no barrels");
		store.addConstraint("no barrels");
		store.addUnresolvedError("TS2307");
		store.addUnresolvedError("TS2307");

		const state = store.getCurrent();
		expect(state.filesTouched).toEqual(["src/a.ts"]);
		expect(state.constraints).toEqual(["no barrels"]);
		expect(state.unresolvedErrors).toEqual(["TS2307"]);
	});

	it("keeps pending operations as a multiset and removes all matches on completion", () => {
		store.addPendingOperation("bun test");
		store.addPendingOperation("bun test");
		expect(store.getCurrent().pendingOperations).toEqual(["bun test", "bun test"]);

		store.completeOperation("bun test");
		expect(store.getCurrent().pendingOperations).toEqual([]);
	});

	it("resolves errors without touching unrelated ones", () => {
		store.addUnresolvedError("TS2307");
		store.addUnresolvedError("TS2459");
		store.resolveError("TS2307");
		expect(store.getCurrent().unresolvedErrors).toEqual(["TS2459"]);
	});

	it("resets the current step when the plan changes", () => {
		store.setActivePlan("plan v1");
		store.setCurrentStep("step 3");
		store.setActivePlan("plan v2");

		const state = store.getCurrent();
		expect(state.activePlan).toBe("plan v2");
		expect(state.currentStep).toBe("");
	});

	it("isolates scopes: an unset field is its own scope, not a wildcard", () => {
		const branchScope: PersistenceScope = { projectId: "proj-a", sessionId: "sess-1", branchId: "feat/x" };
		const branchStore = new WorkingStateStore({ dbPath: path.join(dir, "state.sqlite"), scope: branchScope });
		try {
			store.setObjective("scopeless objective");
			expect(branchStore.getCurrent().objective).toBe("");
			expect(scopeKey(SCOPE)).not.toBe(scopeKey(branchScope));
		} finally {
			branchStore.close();
		}
	});

	it("replace overwrites the whole state", () => {
		store.setObjective("old");
		store.addFileTouched("src/old.ts");

		const replaced = store.replace({
			objective: "restored",
			constraints: ["from checkpoint"],
			activePlan: "",
			currentStep: "",
			filesTouched: [],
			pendingOperations: [],
			unresolvedErrors: [],
			lastVerifiedTestState: "",
		});
		expect(replaced.objective).toBe("restored");

		const state = store.getCurrent();
		expect(state.objective).toBe("restored");
		expect(state.constraints).toEqual(["from checkpoint"]);
		expect(state.filesTouched).toEqual([]);
	});

	it("advances updatedAt on every mutation", () => {
		const before = store.setObjective("first");
		expect(before.updatedAt).not.toBe("");
		const after = store.setObjective("second");
		expect(after.updatedAt >= before.updatedAt).toBe(true);
	});
});
