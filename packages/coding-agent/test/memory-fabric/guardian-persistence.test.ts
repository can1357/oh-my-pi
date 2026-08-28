import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	GuardianRetrievalPort,
	GuardianRetrievalQuery,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/guardian/integration";
import type { GuardianPersistence } from "@oh-my-pi/pi-coding-agent/memory-fabric/persistence/guardian-persistence";
import { createGuardianPersistence } from "@oh-my-pi/pi-coding-agent/memory-fabric/persistence/guardian-persistence";

function stubPort(): GuardianRetrievalPort {
	return {
		retrieve: async () => [],
		getWorkingState: async () => null,
		composeContext: async () => ({ text: "", recordIds: [], tokenCount: 0 }),
	};
}

function stubQuery(): GuardianRetrievalQuery {
	return {
		scope: { projectId: "proj-a", sessionId: "sess-1" },
		text: "anything",
		intent: "implementation",
		files: [],
		symbols: [],
		errors: [],
		limit: 5,
	};
}

describe("createGuardianPersistence", () => {
	let dir: string;
	let persistence: GuardianPersistence;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-guardian-persist-"));
		persistence = createGuardianPersistence({ directory: dir, scope: { projectId: "proj-a" } });
	});

	afterEach(() => {
		persistence.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("reports null working state for a session with nothing recorded", async () => {
		const port = persistence.extendPort(stubPort());
		expect(await port.getWorkingState("sess-1")).toBeNull();
	});

	it("surfaces the durable working state through the port", async () => {
		persistence.workingStateFor("sess-1").setObjective("finish the lane");
		persistence.workingStateFor("sess-1").addConstraint("no barrels");

		const port = persistence.extendPort(stubPort());
		const state = await port.getWorkingState("sess-1");
		expect(state).toEqual({ objective: "finish the lane", constraints: ["no barrels"] });
	});

	it("omits empty fields from the guardian working state", async () => {
		persistence.workingStateFor("sess-1").addConstraint("only a constraint");

		const port = persistence.extendPort(stubPort());
		const state = await port.getWorkingState("sess-1");
		expect(state).toEqual({ constraints: ["only a constraint"] });
	});

	it("isolates working state between sessions", async () => {
		persistence.workingStateFor("sess-1").setObjective("session one");

		const port = persistence.extendPort(stubPort());
		expect(await port.getWorkingState("sess-2")).toBeNull();
	});

	it("creates a checkpoint of the current session state and journals it", async () => {
		persistence.workingStateFor("sess-1").setObjective("checkpoint me");

		const port = persistence.extendPort(stubPort());
		const checkpointId = await port.createCheckpoint?.("sess-1", "compaction");
		expect(checkpointId).toBeDefined();

		const snapshot = persistence.checkpointStore.load(checkpointId ?? "");
		expect(snapshot?.state.objective).toBe("checkpoint me");
		expect(snapshot?.label).toBe("compaction");

		const journalled = persistence.journal.query({ type: "checkpoint-created" });
		expect(journalled).toHaveLength(1);
		expect(journalled[0]?.recordId).toBe(checkpointId);
	});

	it("journals queued maintenance", async () => {
		const port = persistence.extendPort(stubPort());
		await port.queueMaintenance?.("sess-1", "index rebuild");

		const events = persistence.journal.query({ type: "maintenance-queued" });
		expect(events).toHaveLength(1);
		expect(events[0]?.payload).toEqual({ sessionId: "sess-1", reason: "index rebuild" });
	});

	it("delegates retrieval to the base port untouched", async () => {
		let called = 0;
		const base = stubPort();
		base.retrieve = async () => {
			called += 1;
			return [];
		};

		const port = persistence.extendPort(base);
		await port.retrieve(stubQuery());
		expect(called).toBe(1);
	});

	it("dispose is idempotent", () => {
		persistence.workingStateFor("sess-1").setObjective("x");
		persistence.dispose();
		persistence.dispose();
	});
});
