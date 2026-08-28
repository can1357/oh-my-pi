import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CheckpointStore } from "@oh-my-pi/pi-coding-agent/memory-fabric/persistence/checkpoint-store";
import type { PersistenceScope, WorkingState } from "@oh-my-pi/pi-coding-agent/memory-fabric/persistence/types";
import { createEmptyWorkingState, hashContent } from "@oh-my-pi/pi-coding-agent/memory-fabric/persistence/types";

const SCOPE: PersistenceScope = { projectId: "proj-a" };

function stateWithObjective(objective: string): WorkingState {
	return { ...createEmptyWorkingState(), objective };
}

describe("CheckpointStore", () => {
	let dir: string;
	let store: CheckpointStore;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-checkpoint-"));
		store = new CheckpointStore({ directory: dir, scope: SCOPE });
	});

	afterEach(() => {
		store.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("creates and loads a checkpoint by id", () => {
		const snapshot = store.create(stateWithObjective("ship it"), "sess-1", "compaction");
		const loaded = store.load(snapshot.checkpointId);
		expect(loaded).not.toBeNull();
		expect(loaded?.label).toBe("compaction");
		expect(loaded?.state.objective).toBe("ship it");
		expect(loaded?.contentHash).toBe(snapshot.contentHash);
	});

	it("returns null for an unknown checkpoint id", () => {
		expect(store.load("cp-missing")).toBeNull();
	});

	it("snapshots by value: mutating the source state later does not change the checkpoint", () => {
		const state = stateWithObjective("original");
		state.filesTouched.push("src/a.ts");
		const snapshot = store.create(state, "sess-1", "manual");

		state.objective = "mutated";
		state.filesTouched.push("src/b.ts");

		const loaded = store.load(snapshot.checkpointId);
		expect(loaded?.state.objective).toBe("original");
		expect(loaded?.state.filesTouched).toEqual(["src/a.ts"]);
	});

	it("returns the latest checkpoint for a session", () => {
		store.create(stateWithObjective("first"), "sess-1", "a");
		store.create(stateWithObjective("other session"), "sess-2", "b");
		const last = store.create(stateWithObjective("second"), "sess-1", "c");

		const latest = store.latestForSession("sess-1");
		expect(latest?.checkpointId).toBe(last.checkpointId);
		expect(latest?.state.objective).toBe("second");
	});

	it("returns null when a session has no checkpoints", () => {
		expect(store.latestForSession("sess-none")).toBeNull();
	});

	it("accumulates JSONL mirror lines instead of replacing them", () => {
		// Regression: an earlier design staged each backup line in a temp file
		// and renamed it over the mirror, destroying all previous lines.
		store.create(stateWithObjective("one"), "sess-1", "a");
		store.create(stateWithObjective("two"), "sess-1", "b");
		store.create(stateWithObjective("three"), "sess-1", "c");

		const mirror = fs.readFileSync(path.join(dir, "proj-a_checkpoints.jsonl"), "utf8");
		const lines = mirror.split("\n").filter(line => line.length > 0);
		expect(lines).toHaveLength(3);
		const objectives = lines.map(line => (JSON.parse(line) as { state: WorkingState }).state.objective);
		expect(objectives).toEqual(["one", "two", "three"]);
	});

	it("uses a collision-resistant content hash", () => {
		const snapshot = store.create(stateWithObjective("hash me"), "sess-1", "a");
		expect(snapshot.contentHash).toBe(hashContent(snapshot.state));
		expect(snapshot.contentHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("prunes old checkpoints but keeps the newest and the JSONL history", () => {
		for (let index = 0; index < 5; index += 1) {
			store.create(stateWithObjective(`state ${index}`), "sess-1", `label ${index}`);
		}
		const removed = store.prune(2);
		expect(removed).toBe(3);
		expect(store.list(10)).toHaveLength(2);

		const mirror = fs.readFileSync(path.join(dir, "proj-a_checkpoints.jsonl"), "utf8");
		expect(mirror.split("\n").filter(line => line.length > 0)).toHaveLength(5);
	});

	it("lists newest first", () => {
		store.create(stateWithObjective("older"), "sess-1", "a");
		const newest = store.create(stateWithObjective("newer"), "sess-1", "b");
		const listed = store.list(10);
		expect(listed[0]?.checkpointId).toBe(newest.checkpointId);
	});

	it("survives reopening the store", () => {
		const snapshot = store.create(stateWithObjective("durable"), "sess-1", "a");
		store.close();
		store = new CheckpointStore({ directory: dir, scope: SCOPE });
		expect(store.load(snapshot.checkpointId)?.state.objective).toBe("durable");
	});
});
