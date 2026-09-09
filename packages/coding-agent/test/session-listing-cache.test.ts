import { describe, expect, it, spyOn } from "bun:test";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const SESSION_DIR = "/sessions/project";

function writeSession(storage: MemorySessionStorage, file: string, firstPrompt: string): void {
	storage.writeTextSync(
		file,
		[
			JSON.stringify({
				type: "session",
				id: "cache-id",
				cwd: "/repo",
				title: "Cached Title",
				timestamp: "2026-06-27T00:00:00.000Z",
			}),
			JSON.stringify({ type: "message", message: { role: "user", content: firstPrompt } }),
			"",
		].join("\n"),
	);
}

describe("session listing scan cache", () => {
	it("serves an unchanged file from cache without re-reading it", async () => {
		const storage = new MemorySessionStorage();
		const file = `${SESSION_DIR}/cached.jsonl`;
		writeSession(storage, file, "first prompt");
		const readSpy = spyOn(storage, "readTextSlices");

		const first = await listSessions(SESSION_DIR, storage);
		expect(first.map(s => s.id)).toEqual(["cache-id"]);
		expect(readSpy).toHaveBeenCalledTimes(1);

		const second = await listSessions(SESSION_DIR, storage);
		expect(readSpy).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
	});

	it("invalidates when the file's size changes", async () => {
		const storage = new MemorySessionStorage();
		const file = `${SESSION_DIR}/grows.jsonl`;
		writeSession(storage, file, "short");
		const readSpy = spyOn(storage, "readTextSlices");

		await listSessions(SESSION_DIR, storage);
		expect(readSpy).toHaveBeenCalledTimes(1);

		// Simulate the active session growing during streaming.
		writeSession(storage, file, "a much longer replacement prompt");
		const after = await listSessions(SESSION_DIR, storage);
		expect(readSpy).toHaveBeenCalledTimes(2);
		expect(after[0]?.firstMessage).toBe("a much longer replacement prompt");
	});

	it("invalidates when mtime changes even at identical size", async () => {
		const storage = new MemorySessionStorage();
		const file = `${SESSION_DIR}/retitle.jsonl`;
		writeSession(storage, file, "same-length");
		const readSpy = spyOn(storage, "readTextSlices");

		await listSessions(SESSION_DIR, storage);
		expect(readSpy).toHaveBeenCalledTimes(1);

		// Simulate updateSessionTitle's in-place slot rewrite: same byte length,
		// newer mtime (MemorySessionStorage stamps Date.now on write). Advance
		// the clock deterministically instead of sleeping.
		const nowSpy = spyOn(Date, "now").mockReturnValue(Date.now() + 10);
		try {
			writeSession(storage, file, "SAME-LENGTH");
		} finally {
			nowSpy.mockRestore();
		}
		const after = await listSessions(SESSION_DIR, storage);
		expect(readSpy).toHaveBeenCalledTimes(2);
		expect(after[0]?.firstMessage).toBe("SAME-LENGTH");
	});

	it("caches negative results for unparseable files", async () => {
		const storage = new MemorySessionStorage();
		const file = `${SESSION_DIR}/garbage.jsonl`;
		storage.writeTextSync(file, "not json at all\n");
		const readSpy = spyOn(storage, "readTextSlices");

		expect(await listSessions(SESSION_DIR, storage)).toEqual([]);
		expect(readSpy).toHaveBeenCalledTimes(1);
		expect(await listSessions(SESSION_DIR, storage)).toEqual([]);
		expect(readSpy).toHaveBeenCalledTimes(1);
	});
});
