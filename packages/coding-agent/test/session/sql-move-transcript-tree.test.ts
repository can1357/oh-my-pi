/**
 * Moving a session under `session.storage: sql` moves the rows its artifacts
 * directory keys — subagent transcripts and the unsent prompt draft — and on a
 * failure leaves the whole tree where it was. A directory move carries none of
 * these rows, so they were stranded at the old key (the draft) or split across
 * both places (children moved before the one that failed).
 */
import { SQL } from "bun";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { listTranscriptTree } from "@oh-my-pi/pi-coding-agent/session/session-transcript-tree";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getSessionsDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const clients: SQL[] = [];
let tempDir: TempDir | undefined;
let settingsState: SettingsTestState | undefined;

beforeEach(() => {
	settingsState = beginSettingsTest();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const client of clients.splice(0)) await client.end();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	tempDir?.removeSync();
	tempDir = undefined;
});

function transcript(id: string): string {
	return `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-01T00:00:00.000Z", cwd: "/p" })}\n`;
}

async function seed() {
	tempDir = TempDir.createSync("@omp-sql-move-");
	setAgentDir(tempDir.join("agent"));
	const client = new SQL(`sqlite:${tempDir.join("sessions.db")}`);
	clients.push(client);
	const storage = await SqlSessionStorage.create({ client });
	const cwd = tempDir.join("from");
	const manager = SessionManager.create(cwd, path.join(getSessionsDir(), "--from--"), storage);
	manager.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "answer" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	await manager.flush();
	const artifactsDir = manager.getSessionFile()!.slice(0, -".jsonl".length);
	await storage.writeText(path.join(artifactsDir, "A.jsonl"), transcript("a"));
	await storage.writeText(path.join(artifactsDir, "B.jsonl"), transcript("b"));
	await manager.saveDraft("unsent user work");
	await storage.drain();
	/** A second client of the same database, as another omp process holds. */
	const peer = async (): Promise<SqlSessionStorage> => {
		const other = new SQL(`sqlite:${tempDir!.join("sessions.db")}`);
		clients.push(other);
		return SqlSessionStorage.create({ client: other });
	};
	return { storage, manager, artifactsDir, to: tempDir.join("to"), peer };
}

describe("moving a SQL-stored session", () => {
	test("carries its subagent transcripts and its unsent draft", async () => {
		const { manager, to } = await seed();

		await manager.moveTo(to);

		const moved = manager.getSessionFile()!.slice(0, -".jsonl".length);
		expect((await listTranscriptTree(manager.getStorage(), moved)).map(file => path.basename(file)).sort()).toEqual([
			"A.jsonl",
			"B.jsonl",
		]);
		expect(await manager.consumeDraft()).toBe("unsent user work");
		await manager.close();
	});

	test("leaves every child where it was when one child's move fails", async () => {
		const { storage, manager, artifactsDir, to } = await seed();
		const source = manager.getSessionFile()!;
		const renameNoReplace = storage.renameNoReplace.bind(storage);
		vi.spyOn(storage, "renameNoReplace").mockImplementation(async (from: string, dest: string) => {
			if (path.basename(from) === "B.jsonl") throw new Error("database rejected child B");
			return renameNoReplace(from, dest);
		});

		await expect(manager.moveTo(to)).rejects.toThrow("database rejected child B");

		expect(manager.getSessionFile()).toBe(source);
		expect((await listTranscriptTree(storage, artifactsDir)).map(file => path.basename(file)).sort()).toEqual([
			"A.jsonl",
			"B.jsonl",
		]);
		await manager.close();
	});
});

describe("a SQL-stored session's tree with another client writing", () => {
	test("a move carries a child another client committed", async () => {
		const { manager, artifactsDir, to, peer } = await seed();
		const other = await peer();
		await other.writeText(path.join(artifactsDir, "Late.jsonl"), transcript("late"));
		await other.drain();

		await manager.moveTo(to);

		const moved = manager.getSessionFile()!.slice(0, -".jsonl".length);
		expect((await listTranscriptTree(manager.getStorage(), moved)).map(file => path.basename(file))).toContain(
			"Late.jsonl",
		);
		await manager.close();
	});

	test("deleting the session removes a child another client committed", async () => {
		const { storage, manager, artifactsDir, peer } = await seed();
		const file = manager.getSessionFile()!;
		await manager.close();
		const other = await peer();
		await other.writeText(path.join(artifactsDir, "Late.jsonl"), transcript("late"));
		await other.drain();

		await storage.deleteSessionWithArtifacts(file);
		await storage.drain();

		const fresh = await peer();
		expect(await listTranscriptTree(fresh, artifactsDir)).toEqual([]);
		expect(await fresh.exists(path.join(artifactsDir, "draft.txt"))).toBe(false);
	});

	test("a fork carries the unsent draft", async () => {
		const { storage, manager } = await seed();
		const fork = await SessionManager.forkFrom(manager.getSessionFile()!, tempDir!.join("fork"), undefined, storage);
		expect(await fork.consumeDraft()).toBe("unsent user work");
		await fork.close();
		await manager.close();
	});
});
