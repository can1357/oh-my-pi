/**
 * The idle recap journal under each session store. A session journals its recaps in history.db, which the
 * archive prelude's `recaps()` view and a resumed session's recap line read, whichever store keeps the session:
 * file storage and `SqlSessionStorage` on SQLite. File storage is the control. An in-memory session journals none.
 *
 * PostgreSQL and MySQL take the same class-check branch; upstream's SQL tests intentionally use no live database
 * (or environment database URL) in CI, so the SQLite row is the regression test for this condition.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createArchivePrelude } from "@oh-my-pi/pi-coding-agent/archive/prelude-definition";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { closeSessionIndex, listSessionRecaps } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const RECAP = "Fixed the login form validation; its tests pass.";
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let root: string;
let sqliteClient: SQL | undefined;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-recap-journal-"));
	HistoryStorage.close();
	closeSessionIndex();
	setAgentDir(path.join(root, "agent"));
});

afterEach(async () => {
	HistoryStorage.close();
	closeSessionIndex();
	await sqliteClient?.end();
	sqliteClient = undefined;
	if (originalAgentDir) setAgentDir(originalAgentDir);
	else {
		setAgentDir(path.join(getConfigRootDir(), "agent"));
		delete process.env.PI_CODING_AGENT_DIR;
	}
	removeSyncWithRetries(root);
});

/** A `SqlSessionStorage` on a temporary SQLite database. */
async function sqliteStore(): Promise<SessionStorage> {
	sqliteClient = new SQL(`sqlite://${path.join(root, "s.db")}`);
	return SqlSessionStorage.create({ client: sqliteClient });
}

const STORES: ReadonlyArray<{ name: string; open: () => Promise<SessionStorage> }> = [
	{ name: "file storage", open: async () => new FileSessionStorage() },
	{ name: "SqlSessionStorage on SQLite", open: sqliteStore },
];

function addTurn(manager: SessionManager): void {
	manager.appendMessage({ role: "user", content: "fix the login form", timestamp: Date.now() });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Done." }],
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
}

const journaled = (manager: SessionManager): string[] =>
	listSessionRecaps({ sessionIds: [manager.getSessionId()] }).map(recap => recap.recap);

describe("the idle recap journal", () => {
	for (const store of STORES) {
		it(`journals a recap and lists it in archive.recaps() under ${store.name}`, async () => {
			const storage = await store.open();
			const cwd = path.join(root, "app");
			fs.mkdirSync(cwd, { recursive: true });
			const manager = SessionManager.create(cwd, undefined, storage);
			addTurn(manager);
			await manager.flush();
			manager.recordRecap(RECAP);
			const journal = journaled(manager);
			await manager.close();
			const session = { cwd, settings: Settings.isolated() } as unknown as ToolSession;
			const result = await createArchivePrelude(session).invoke({ action: "recaps" }, {
				session,
				toolCallId: "recap-journal",
			} as never);
			const listed = (result.details as Array<{ text: string }>).map(recap => recap.text);
			expect({ journal, listed }).toEqual({ journal: [RECAP], listed: [RECAP] });
		});
	}

	it("journals no recap of an in-memory session, even on a file store", async () => {
		const manager = SessionManager.inMemory(root, new FileSessionStorage());
		addTurn(manager);
		manager.recordRecap(RECAP);
		expect(journaled(manager)).toEqual([]);
		await manager.close();
	});

	it("journals no recap of a session kept in a memory store", async () => {
		const manager = SessionManager.create(root, path.join(root, "sessions"), new MemorySessionStorage());
		addTurn(manager);
		await manager.flush();
		manager.recordRecap(RECAP);
		expect(journaled(manager)).toEqual([]);
		await manager.close();
	});
});
