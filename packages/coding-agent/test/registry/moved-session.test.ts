import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, sessionJournalLiveness } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("a session this process runs after its journal moved", () => {
	it("still reads as the journal this process writes, not as a copy of it", async () => {
		using tempDir = TempDir.createSync("@omp-moved-session-");
		const root = tempDir.path();
		const [dirA, dirB, cwdA, cwdB] = ["a", "b", "cwd-a", "cwd-b"].map(name => path.join(root, name));
		for (const dir of [dirA, dirB, cwdA, cwdB]) fs.mkdirSync(dir, { recursive: true });

		const manager = SessionManager.create(cwdA, dirA, new FileSessionStorage());
		await manager.ensureOnDisk();
		manager.appendSessionInit({ systemPrompt: ["lane prompt"], task: "lane task", tools: ["read"] });
		manager.appendMessage({ role: "user", content: "earlier work", timestamp: Date.now() });
		await manager.flush();
		const before = manager.getSessionFile();
		if (!before) throw new Error("Expected a persisted session file");
		manager.claimForWriting();
		expect(sessionJournalLiveness(before)).toBe("here");

		// What `/move` and a relocated resume do: same session id, new path. The
		// writer claim must follow, or the roster scan reads the journal this
		// session writes as a copy of itself and never binds its name.
		await manager.moveTo(cwdB, dirB);
		const after = manager.getSessionFile();
		if (!after) throw new Error("Expected a session file after the move");

		expect(after).not.toBe(before);
		expect(sessionJournalLiveness(after)).toBe("here");
		await manager.close();
		expect(sessionJournalLiveness(after)).toBe("free");
	});
});
