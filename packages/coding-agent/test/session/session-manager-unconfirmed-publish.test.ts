/**
 * A session on an indexed store (SQL, Redis) whose own publish is still
 * unconfirmed when its next write arrives: the store queues a publish and
 * confirms it later, so the next entry, flush or rewrite meets this
 * session's own queued body. Each caller below must keep every entry
 * without reporting a persistence failure.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { readStoredSession } from "../helpers/sql-session-storage";

type SqlClient = InstanceType<typeof SQL>;

const SESSION_TABLE = "omp_session_files";

function userMessage(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
}

function assistantMessage(text: string) {
	return {
		role: "assistant" as const,
		provider: "anthropic",
		model: "claude-opus-5-5",
		content: [{ type: "text" as const, text }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		api: "anthropic-messages" as const,
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/** The header and entries the manager holds, as the store should hold them. */
function transcript(manager: SessionManager): unknown[] {
	return JSON.parse(JSON.stringify([manager.getHeader(), ...manager.getEntries()])) as unknown[];
}

/** The stored session's header and entries, one per line after the title slot. */
function storedRecords(content: string | null): unknown[] {
	return (content ?? "")
		.split("\n")
		.slice(1)
		.filter(line => line.length > 0)
		.map(line => JSON.parse(line) as unknown);
}

/** What `promise` rejected with, or `undefined` when it resolved. */
function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(error: unknown) => error,
	);
}

async function withSqliteStorage(run: (storage: SqlSessionStorage, client: SqlClient) => Promise<void>): Promise<void> {
	const client = new SQL("sqlite::memory:");
	try {
		await run(await SqlSessionStorage.create({ client }), client);
	} finally {
		await client.end();
	}
}

function createWatchedSession(storage: SessionStorage, sessionDir: string) {
	const manager = SessionManager.create("/cwd", sessionDir, storage);
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("expected a session file");
	/** Everything `SessionManager.onPersistenceError` delivered, which every mode shows as a warning. */
	const failures: Error[] = [];
	manager.onPersistenceError(error => failures.push(error));
	return { manager, sessionFile, failures };
}

interface PrintModeRun {
	sessionFile: string;
	failures: Error[];
	/** What the exit record's `flushSync()` threw, which `AgentSession` logs as a failed exit record. */
	exitRecordError: unknown;
	expected: unknown[];
}

/**
 * The calls `omp -p` makes on a new session's manager, in order: the opening
 * entries wait behind the lazy gate, the reply is the first write, and
 * dispose appends the exit record and calls `flushSync()` right behind it.
 * `beforeSeal` stands for the awaits dispose makes between recording the
 * exit and sealing the manager.
 */
async function runPrintModeSession(
	storage: SessionStorage,
	sessionDir: string,
	beforeSeal: () => Promise<void>,
): Promise<PrintModeRun> {
	const { manager, sessionFile, failures } = createWatchedSession(storage, sessionDir);

	// AgentSession's opening entries and the prompt: behind the lazy gate.
	manager.appendModelChange("anthropic/claude-opus-5-5");
	manager.appendThinkingLevelChange("xhigh");
	manager.appendCustomEntry("experiments", { v: 1 });
	manager.appendMessage(userMessage("Reply with pong."));
	// The reply materializes the session: its first write.
	manager.appendMessage(assistantMessage("pong"));

	// AgentSession#recordSessionExit, at the start of dispose.
	let exitRecordError: unknown;
	try {
		manager.appendCustomEntry("session_exit", { reason: "dispose", kind: "normal" });
		manager.flushSync();
	} catch (error) {
		exitRecordError = error;
	}

	await beforeSeal();
	// The end of AgentSession#dispose.
	manager.seal();
	await manager.close();

	return { sessionFile, failures, exitRecordError, expected: transcript(manager) };
}

describe("a print-mode session's first write", () => {
	for (const [window, beforeSeal] of [
		["is still unconfirmed when dispose seals the manager", () => Promise.resolve()],
		["confirms before dispose seals the manager", (storage: SqlSessionStorage) => storage.drain()],
	] as const) {
		it(`stores every entry without a persistence failure on SQL storage when it ${window}`, async () => {
			await withSqliteStorage(async (storage, client) => {
				const run = await runPrintModeSession(storage, path.resolve("/sessions/proj"), () => beforeSeal(storage));

				expect(run.failures).toEqual([]);
				expect(run.exitRecordError).toBeUndefined();
				expect(storedRecords(await readStoredSession(client, SESSION_TABLE, run.sessionFile))).toEqual(
					run.expected,
				);
			});
		});
	}

	it("stores every entry without a persistence failure on file storage", async () => {
		using dir = TempDir.createSync("@omp-print-mode-first-write-");
		const run = await runPrintModeSession(new FileSessionStorage(), dir.path(), () => Promise.resolve());

		expect(run.failures).toEqual([]);
		expect(run.exitRecordError).toBeUndefined();
		expect(storedRecords(await Bun.file(run.sessionFile).text())).toEqual(run.expected);
	});
});

describe("a /btw branch's first write", () => {
	it("stores the branched question and answer without a persistence failure on SQL storage", async () => {
		await withSqliteStorage(async (storage, client) => {
			const { manager, failures } = createWatchedSession(storage, path.resolve("/sessions/proj"));
			manager.appendMessage(userMessage("ping"));
			manager.appendMessage(assistantMessage("pong"));

			// AgentSession#branchFromBtw: flush, branch at the leaf, then the /btw
			// question and answer with no await between them.
			await manager.flush();
			const leafId = manager.getLeafId();
			if (!leafId) throw new Error("expected a leaf");
			const branchFile = manager.createBranchedSession(leafId);
			if (!branchFile) throw new Error("expected a branch file");
			manager.appendMessage(userMessage("btw question"));
			manager.appendMessage(assistantMessage("btw answer"));
			const flushError = await rejectionOf(manager.flush());

			expect(failures).toEqual([]);
			expect(flushError).toBeUndefined();
			expect(storedRecords(await readStoredSession(client, SESSION_TABLE, branchFile))).toEqual(transcript(manager));
		});
	});
});

describe("ensureOnDisk() during a new session's first write", () => {
	it("stores the session without a persistence failure on SQL storage", async () => {
		await withSqliteStorage(async (storage, client) => {
			const { manager, sessionFile, failures } = createWatchedSession(storage, path.resolve("/sessions/proj"));
			manager.appendMessage(assistantMessage("pong"));
			const ensureError = await rejectionOf(manager.ensureOnDisk());
			const flushError = await rejectionOf(manager.flush());

			expect(failures).toEqual([]);
			expect(ensureError).toBeUndefined();
			expect(flushError).toBeUndefined();
			expect(storedRecords(await readStoredSession(client, SESSION_TABLE, sessionFile))).toEqual(
				transcript(manager),
			);
		});
	});
});
