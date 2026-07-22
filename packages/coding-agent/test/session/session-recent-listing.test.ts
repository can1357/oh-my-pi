import { describe, expect, it } from "bun:test";
import { getRecentSessions } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-listing";
import { MemorySessionStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-storage";

const SESSION_DIR = "/sessions/project";

function session(id: string, title: string): string {
	return `${JSON.stringify({
		type: "session",
		version: 3,
		id,
		cwd: "/project",
		title,
		timestamp: new Date().toISOString(),
	})}\n`;
}

describe("recent session listing", () => {
	it("returns the newest valid sessions and skips a corrupt newer candidate", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(`${SESSION_DIR}/old.jsonl`, session("old", "Older session"));
		await Bun.sleep(2);
		storage.writeTextSync(`${SESSION_DIR}/new.jsonl`, session("new", "Newest valid session"));
		await Bun.sleep(2);
		storage.writeTextSync(`${SESSION_DIR}/corrupt.jsonl`, "not a session\n");

		const recent = await getRecentSessions(SESSION_DIR, 1, storage);

		expect(recent).toHaveLength(1);
		expect(recent[0]?.path).toBe(`${SESSION_DIR}/new.jsonl`);
		expect(recent[0]?.name).toBe("Newest valid session");
	});
});
