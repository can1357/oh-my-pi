/**
 * A resumed session's subagent transcripts (`<artifacts>/<Id>.jsonl`) live in
 * the session storage: files under `session.storage: file`, rows under
 * `session.storage: sql`, where the artifacts directory holds only tool
 * artifacts. The id allocator must reserve every id whose transcript the
 * storage holds; handing one out again makes the new subagent append into the
 * old subagent's transcript.
 */
import { SQL } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { AgentOutputManager } from "@oh-my-pi/pi-coding-agent/task/output-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const previous = defaultSessionStorage();
const clients: SQL[] = [];

afterEach(async () => {
	setDefaultSessionStorage(previous);
	for (const client of clients.splice(0)) await client.end();
});

const backends: Array<[string, () => Promise<SessionStorage>]> = [
	["file", async () => new FileSessionStorage()],
	[
		"sql",
		async () => {
			const client = new SQL("sqlite::memory:");
			clients.push(client);
			return SqlSessionStorage.create({ client });
		},
	],
];

describe("AgentOutputManager on resume", () => {
	it.each(backends)("never reuses an id whose transcript the %s storage holds", async (_name, open) => {
		using tmp = TempDir.createSync("@omp-output-manager-storage-");
		const storage = await open();
		setDefaultSessionStorage(storage);
		const artifactsDir = tmp.join("session");
		await storage.writeText(path.join(artifactsDir, "Anna.jsonl"), '{"type":"session","id":"anna"}\n');
		// A result markdown is a local artifact in every mode.
		await Bun.write(path.join(artifactsDir, "Bob.md"), "prior result");

		const manager = new AgentOutputManager(() => artifactsDir);

		expect(await manager.allocate("Anna")).toBe("Anna-2");
		expect(await manager.allocate("Bob")).toBe("Bob-2");
		expect(await manager.allocate("Carol")).toBe("Carol");
	});
});
