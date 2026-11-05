/**
 * The Agent Hub activity feed tails each subagent transcript through the
 * session storage. Under `session.storage: sql` the transcript is a row with
 * no file behind it; an index that stats and slices the filesystem finds no
 * transcript and the feed stays empty.
 */
import { SQL } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AgentActivityIndex } from "../src/activity";

function assistantLine(id: string, timestamp: number, text: string): string {
	return JSON.stringify({ type: "message", id, timestamp, message: { timestamp, role: "assistant", content: text } });
}

describe("AgentActivityIndex storage", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	for (const kind of ["file", "sql"] as const) {
		it(`syncs a subagent transcript held by ${kind} storage and tails its appended entries`, async () => {
			const previous = defaultSessionStorage();
			let storage: SessionStorage = new FileSessionStorage();
			if (kind === "sql") {
				const client = new SQL("sqlite::memory:");
				storage = await SqlSessionStorage.create({ client });
				cleanups.push(() => client.end());
			}
			setDefaultSessionStorage(storage);
			cleanups.push(() => setDefaultSessionStorage(previous));
			const dir = TempDir.createSync("@omp-activity-storage-");
			cleanups.push(() => dir.removeSync());
			const sessionFile = dir.join("main", "Worker.jsonl");
			await storage.writeText(sessionFile, `${assistantLine("r1", 1_000, "First stored result")}\n`);
			const activity = new AgentActivityIndex();

			await activity.sync("Worker", sessionFile);
			expect(activity.query().map(row => row.summary)).toEqual(["First stored result"]);

			const writer = storage.openWriter(sessionFile, { flags: "a" });
			await writer.append(`${assistantLine("r2", 2_000, "Appended stored result")}\n`);
			await writer.close();
			await activity.sync("Worker", sessionFile);
			expect(activity.query().map(row => row.entryId)).toEqual(["r1", "r2"]);
		});
	}
});
