import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentStorage usage counters", () => {
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		AgentStorage.close();
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {}
			tempDir = undefined;
		}
	});

	it("accumulates per-name counts per kind and survives a reopen", async () => {
		tempDir = TempDir.createSync("@omp-agent-storage-cmd-");
		const dbPath = path.join(tempDir.path(), "agent.db");
		const storage = await AgentStorage.open(dbPath);

		storage.recordUsage("command", "model");
		storage.recordUsage("command", "model");
		storage.recordUsage("command", "skill:review");
		storage.recordUsage("hint", "agents");
		// Kinds are separate namespaces: hint gestures never skew command ranking.
		expect(storage.listUsage("command")).toEqual({ model: 2, "skill:review": 1 });
		expect(storage.listUsage("hint")).toEqual({ agents: 1 });

		// Counts are a cross-session contract: a fresh handle must see them.
		AgentStorage.close();
		const reopened = await AgentStorage.open(dbPath);
		expect(reopened.listUsage("command")).toEqual({ model: 2, "skill:review": 1 });
		reopened.recordUsage("command", "model");
		expect(reopened.listUsage("command").model).toBe(3);
		expect(reopened.listUsage("hint")).toEqual({ agents: 1 });
	});
});
