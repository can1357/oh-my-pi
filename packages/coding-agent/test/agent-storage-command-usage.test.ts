import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentStorage command usage", () => {
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		AgentStorage.resetInstance();
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {}
			tempDir = undefined;
		}
	});

	it("accumulates per-command counts and survives a reopen", async () => {
		tempDir = TempDir.createSync("@omp-agent-storage-cmd-");
		const dbPath = path.join(tempDir.path(), "agent.db");
		const storage = await AgentStorage.open(dbPath);

		storage.recordCommandUsage("model");
		storage.recordCommandUsage("model");
		storage.recordCommandUsage("skill:review");
		expect(storage.listCommandUsage()).toEqual({ model: 2, "skill:review": 1 });

		// Counts are a cross-session contract: a fresh handle must see them.
		AgentStorage.resetInstance();
		const reopened = await AgentStorage.open(dbPath);
		expect(reopened.listCommandUsage()).toEqual({ model: 2, "skill:review": 1 });
		reopened.recordCommandUsage("model");
		expect(reopened.listCommandUsage().model).toBe(3);
	});
});
