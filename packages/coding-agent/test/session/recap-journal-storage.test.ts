/**
 * The idle recap journal under each session store. A session journals its recaps in history.db, which the
 * archive prelude's `recaps()` view and a resumed session's recap line read, whichever store keeps the session:
 * file storage and `SqlSessionStorage` on SQLite. File storage is the control. An in-memory session journals none.
 * A session `createAgentSession` roots in an agent dir of its own journals in that dir's history.db, never in the
 * process agent dir's.
 *
 * PostgreSQL and MySQL take the same class-check branch; upstream's SQL tests intentionally use no live database
 * (or environment database URL) in CI, so the SQLite row is the regression test for this condition.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ArchiveRecap } from "@oh-my-pi/pi-coding-agent/archive/archive";
import { createArchivePrelude } from "@oh-my-pi/pi-coding-agent/archive/prelude-definition";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { __resetDirsFromEnvForTests, getHistoryDbPath, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const RECAP = "Fixed the login form validation; its tests pass.";
let root: string;
let sqliteClient: SQL | undefined;
/** `setAgentDir` clears both profile variables and the active profile, so each test restores all three. */
let originalEnv: Record<"PI_CODING_AGENT_DIR" | "OMP_PROFILE" | "PI_PROFILE", string | undefined>;

beforeEach(() => {
	originalEnv = {
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		OMP_PROFILE: process.env.OMP_PROFILE,
		PI_PROFILE: process.env.PI_PROFILE,
	};
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-recap-journal-"));
	HistoryStorage.close();
	closeSessionIndex();
	setAgentDir(path.join(root, "agent"));
});

afterEach(async () => {
	try {
		HistoryStorage.close();
		closeSessionIndex();
		await sqliteClient?.end();
	} finally {
		sqliteClient = undefined;
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
		removeSyncWithRetries(root);
	}
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

/** Recaps of `sessionId` in the history.db at `dbPath`, read from the file itself, oldest first. */
function recapsIn(dbPath: string, sessionId: string): string[] {
	closeSessionIndex();
	if (!fs.existsSync(dbPath)) return [];
	const db = new Database(dbPath, { readonly: true });
	try {
		const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_recaps'").get();
		if (!table) return [];
		return db
			.query<{ recap: string }, [string]>("SELECT recap FROM session_recaps WHERE session_id = ? ORDER BY id")
			.all(sessionId)
			.map(row => row.recap);
	} finally {
		db.close();
	}
}

/** The recaps `archive.recaps()` lists to an eval cell of a session at `cwd` kept by `sessionManager`. */
async function archiveRecaps(cwd: string, sessionManager?: ToolSession["sessionManager"]): Promise<string[]> {
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		sessionManager,
	};
	const result = await createArchivePrelude(session).invoke(
		{ action: "recaps" },
		{ session, toolCallId: "recap-journal" },
	);
	return (result.details as ArchiveRecap[]).map(recap => recap.text);
}

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
			await manager.close();
			const journal = recapsIn(getHistoryDbPath(), manager.getSessionId());
			const listed = await archiveRecaps(cwd);
			expect({ journal, listed }).toEqual({ journal: [RECAP], listed: [RECAP] });
		});
	}

	it("journals no recap of an in-memory session, even on a file store", async () => {
		const manager = SessionManager.inMemory(root, new FileSessionStorage());
		addTurn(manager);
		manager.recordRecap(RECAP);
		expect(recapsIn(getHistoryDbPath(), manager.getSessionId())).toEqual([]);
		await manager.close();
	});

	it("journals no recap of a session kept in a memory store", async () => {
		const manager = SessionManager.create(root, path.join(root, "sessions"), new MemorySessionStorage());
		addTurn(manager);
		await manager.flush();
		manager.recordRecap(RECAP);
		expect(recapsIn(getHistoryDbPath(), manager.getSessionId())).toEqual([]);
		await manager.close();
	});
});

/** An SDK session `createAgentSession` roots in `<root>/scoped-agent`, kept by `storage`, with one turn on disk. */
async function scopedSession(storage: SessionStorage) {
	const agentDir = path.join(root, "scoped-agent");
	const cwd = path.join(root, "app");
	fs.mkdirSync(cwd, { recursive: true });
	const sessionManager = SessionManager.create(
		cwd,
		SessionManager.getDefaultSessionDir(cwd, agentDir, storage),
		storage,
	);
	const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
	authStorage.keys.setRuntime("managed-primary", "test-key");
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		sessionManager,
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, path.join(root, "models.yml")),
		settings: Settings.isolated({ "compaction.enabled": false }),
		model: buildModel({
			id: "recap-journal-model",
			name: "Recap Journal Model",
			api: "openai-completions",
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		}),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	addTurn(sessionManager);
	await sessionManager.flush();
	const dispose = async () => {
		try {
			await session.dispose();
		} finally {
			authStorage.close();
		}
	};
	return { agentDir, cwd, session, sessionManager, dispose };
}

describe("the idle recap journal of a session with an agent dir of its own", () => {
	for (const store of STORES) {
		it(`journals in that agent dir's history.db, not the process agent dir's, under ${store.name}`, async () => {
			const { agentDir, cwd, session, sessionManager, dispose } = await scopedSession(await store.open());
			const sessionId = sessionManager.getSessionId();
			let listed: string[];
			let listedByDefault: string[];
			try {
				sessionManager.recordRecap(RECAP);
				listed = await archiveRecaps(cwd, session.sessionManager);
				listedByDefault = await archiveRecaps(cwd);
			} finally {
				await dispose();
			}
			expect({
				own: recapsIn(getHistoryDbPath(agentDir), sessionId),
				listed,
				default: recapsIn(getHistoryDbPath(), sessionId),
				listedByDefault,
			}).toEqual({ own: [RECAP], listed: [RECAP], default: [], listedByDefault: [] });
		});

		it(`drops a deleted session's recaps from that agent dir's history.db under ${store.name}`, async () => {
			const { agentDir, sessionManager, dispose } = await scopedSession(await store.open());
			const sessionId = sessionManager.getSessionId();
			const sessionFile = sessionManager.getSessionFile();
			let beforeDelete: string[];
			try {
				sessionManager.recordRecap(RECAP);
				beforeDelete = recapsIn(getHistoryDbPath(agentDir), sessionId);
				// `/delete`: move to a new session, then drop the one it left.
				await sessionManager.newSession({ drop: true });
				if (sessionFile) await sessionManager.dropSession(sessionFile);
			} finally {
				await dispose();
			}
			expect({
				sessionFile: typeof sessionFile,
				beforeDelete,
				afterDelete: recapsIn(getHistoryDbPath(agentDir), sessionId),
			}).toEqual({ sessionFile: "string", beforeDelete: [RECAP], afterDelete: [] });
		});
	}
});
