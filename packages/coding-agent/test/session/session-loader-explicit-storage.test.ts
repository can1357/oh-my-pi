/**
 * A caller that passes a storage to the session loader reads from that
 * storage at every size. Above the streaming threshold the loader streams the
 * file instead of reading it whole, and that path once dropped the storage it
 * was given and read through the process default — under `session.storage:
 * sql`, a table that does not hold the file — loading zero entries.
 */
import { SQL } from "bun";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { loadSessionFile, visitEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

let previous: SessionStorage;
let client: SQL;

beforeEach(async () => {
	previous = defaultSessionStorage();
	client = new SQL("sqlite::memory:");
	setDefaultSessionStorage(await SqlSessionStorage.create({ client }));
});

afterEach(async () => {
	setDefaultSessionStorage(previous);
	await client.end();
});

const header = `${JSON.stringify({ type: "session", version: 3, id: "big", timestamp: "2026-11-01T00:00:00.000Z", cwd: "/tmp" })}\n`;
// Past the 8 MiB streaming threshold.
const bigRecord = `${JSON.stringify({
	type: "custom",
	id: "payload",
	parentId: null,
	timestamp: "2026-11-01T00:00:01.000Z",
	customType: "blob",
	data: "x".repeat(9 * 1024 * 1024),
})}\n`;

test("loadSessionFile streams a large file from the storage it was given", async () => {
	using dir = TempDir.createSync("@omp-loader-explicit-");
	const file = dir.join("session.jsonl");
	await Bun.write(file, header + bigRecord);
	const storage = new FileSessionStorage();

	const loaded = await loadSessionFile(file, storage);

	expect(loaded.entries.map(entry => entry.type)).toEqual(["session", "custom"]);
	expect(loaded.sourceSize).toBe(storage.statSync(file).size);
});

test("visitEntriesFromFile streams a large file from the storage it was given", async () => {
	using dir = TempDir.createSync("@omp-loader-explicit-visit-");
	const file = dir.join("session.jsonl");
	await Bun.write(file, header + bigRecord);
	const visited: string[] = [];

	await visitEntriesFromFile(file, entry => void visited.push(entry.type), new FileSessionStorage());

	expect(visited).toEqual(["session", "custom"]);
});
