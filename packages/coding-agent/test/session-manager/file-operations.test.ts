import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { findMostRecentSession, resolveResumableSession } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	getConfigRootDir,
	getSessionsDir,
	removeSyncWithRetries,
	resolveEquivalentPath,
	Snowflake,
	setAgentDir,
} from "@oh-my-pi/pi-utils";

const OLDER_MTIME = new Date("2000-01-01T00:00:00.000Z");
const NEWER_MTIME = new Date("2000-01-01T00:00:01.000Z");

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `session-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	it("loads valid session file", async () => {
		const file = path.join(tempDir, "valid.jsonl");
		fs.writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = await loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it("skips malformed lines but keeps valid ones", async () => {
		const file = path.join(tempDir, "mixed.jsonl");
		fs.writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = await loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
	});
});

describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `session-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	it("returns single valid session file", async () => {
		const file = path.join(tempDir, "session.jsonl");
		fs.writeFileSync(file, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		expect(await findMostRecentSession(tempDir)).toBe(file);
	});

	it("returns most recently modified session", async () => {
		const file1 = path.join(tempDir, "older.jsonl");
		const file2 = path.join(tempDir, "newer.jsonl");

		fs.writeFileSync(file1, '{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		fs.utimesSync(file1, OLDER_MTIME, OLDER_MTIME);
		fs.writeFileSync(file2, '{"type":"session","id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		fs.utimesSync(file2, NEWER_MTIME, NEWER_MTIME);

		expect(await findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = path.join(tempDir, "invalid.jsonl");
		const valid = path.join(tempDir, "valid.jsonl");

		fs.writeFileSync(invalid, '{"type":"not-session"}\n');
		fs.writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(await findMostRecentSession(tempDir)).toBe(valid);
	});
});

describe("resolveResumableSession", () => {
	let tempDir: string;
	let sessionDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `session-test-${Snowflake.next()}`);
		sessionDir = path.join(tempDir, "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	function writeSession(fileName: string, headerCwd: string, id: string = Snowflake.next()): string {
		const filePath = path.join(sessionDir, fileName);
		fs.writeFileSync(
			filePath,
			`${[
				JSON.stringify({ type: "session", id, timestamp: "2025-01-01T00:00:00Z", cwd: headerCwd }),
				JSON.stringify({
					type: "message",
					id: "msg-1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
			].join("\n")}\n`,
		);
		return id;
	}

	it("returns undefined when no local session matches", async () => {
		writeSession("2025-01-01_demo.jsonl", "/tmp/project", "demo1234");

		const match = await resolveResumableSession("missing", "/tmp/project", sessionDir);

		expect(match).toBeUndefined();
	});

	it("matches by session id prefix", async () => {
		const id = writeSession("2025-01-01_resume.jsonl", "/tmp/project", "resume1234");

		const match = await resolveResumableSession(id.slice(0, 6), "/tmp/project", sessionDir);

		expect(match?.scope).toBe("local");
		expect(match?.session.id).toBe(id);
	});

	it("matches legacy timestamped filename prefixes and id suffixes", async () => {
		writeSession("2025-02-03T04-05-06-789Z_legacyabcd.jsonl", "/tmp/project", "legacyabcd");

		const byFilePrefix = await resolveResumableSession("2025-02-03T04-05", "/tmp/project", sessionDir);
		expect(byFilePrefix?.session.id).toBe("legacyabcd");

		const byFileSuffix = await resolveResumableSession("legacy", "/tmp/project", sessionDir);
		expect(byFileSuffix?.session.id).toBe("legacyabcd");
	});

	it("keeps local matches resumable when header cwd differs", async () => {
		writeSession("2025-01-01_moved.jsonl", "/Users/old-user/project", "moved1234");

		const match = await resolveResumableSession("moved", "/Users/new-user/project", sessionDir);

		expect(match?.scope).toBe("local");
		expect(match?.session.path).toBe(path.join(sessionDir, "2025-01-01_moved.jsonl"));
	});
});

describe("SessionManager temp cwd session dirs", () => {
	let testAgentDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	function expectedTempSessionDirName(tempCwd: string): string {
		return `-tmp-${path.relative(os.tmpdir(), path.resolve(tempCwd)).replace(/[/\\:]/g, "-")}`;
	}

	function toLegacyAbsoluteSessionDirName(cwd: string): string {
		return `--${path
			.resolve(cwd)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-")}--`;
	}

	beforeEach(() => {
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-dir-test-"));
		setAgentDir(testAgentDir);
	});

	afterEach(() => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(testAgentDir);
	});

	it("stores temp-root cwd sessions under -tmp-prefixed directories", () => {
		const tempCwd = path.join(testAgentDir, `temp-cwd-${Snowflake.next()}`);
		fs.mkdirSync(tempCwd, { recursive: true });

		const session = SessionManager.create(tempCwd);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file path");

		expect(path.dirname(sessionFile)).toBe(path.join(getSessionsDir(), expectedTempSessionDirName(tempCwd)));
	});

	it("migrates legacy temp-root absolute session dirs to -tmp prefixes", () => {
		const tempCwd = path.join(testAgentDir, `legacy-cwd-${Snowflake.next()}`);
		fs.mkdirSync(tempCwd, { recursive: true });

		const legacyDir = path.join(getSessionsDir(), toLegacyAbsoluteSessionDirName(tempCwd));
		const markerFile = path.join(legacyDir, "carried.jsonl");
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(markerFile, "marker\n");

		const session = SessionManager.create(tempCwd);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file path");

		const expectedDir = path.join(getSessionsDir(), expectedTempSessionDirName(tempCwd));
		expect(fs.existsSync(legacyDir)).toBe(false);
		expect(path.dirname(sessionFile)).toBe(expectedDir);
		expect(fs.existsSync(path.join(expectedDir, "carried.jsonl"))).toBe(true);
	});

	it("migrates hashed-scheme session dirs back into legacy names", () => {
		const tempCwd = path.join(testAgentDir, `hashed-cwd-${Snowflake.next()}`);
		fs.mkdirSync(tempCwd, { recursive: true });

		// Reconstruct the 17.2.5-17.2.8 hashed dir name (reverted PR #7397).
		const canonicalCwd = resolveEquivalentPath(path.resolve(tempCwd));
		const normalized = canonicalCwd.replaceAll("\\", "/");
		const readable = path
			.basename(canonicalCwd)
			.replace(/[^a-zA-Z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(-80);
		const digest = Bun.SHA256.hash(normalized, "hex");
		const hashedDir = path.join(getSessionsDir(), `tmp-${readable || "project"}-${digest}`);
		fs.mkdirSync(hashedDir, { recursive: true });
		fs.writeFileSync(path.join(hashedDir, "stranded.jsonl"), "stranded\n");

		const session = SessionManager.create(tempCwd);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file path");

		const expectedDir = path.join(getSessionsDir(), expectedTempSessionDirName(tempCwd));
		expect(fs.existsSync(hashedDir)).toBe(false);
		expect(path.dirname(sessionFile)).toBe(expectedDir);
		expect(fs.existsSync(path.join(expectedDir, "stranded.jsonl"))).toBe(true);
	});
});

describe("SessionManager legacy session migration persistence", () => {
	let tempDir: string;
	let testAgentDir: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalTmuxPane = process.env.TMUX_PANE;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	function makeAssistantMessage() {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "legacy reply" }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-20250514",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};
	}

	function getHeader(entries: FileEntry[]): SessionHeader | undefined {
		return entries.find((entry): entry is SessionHeader => entry.type === "session");
	}

	beforeEach(() => {
		// Deterministic, non-TTY terminal id so the per-terminal breadcrumb
		// (written by newSession/continueRecent) is scoped to this test and
		// cannot leak across files in the same suite run. Without it, a real
		// terminal id (WT_SESSION/TMUX_PANE) points continueRecent at stale
		// breadcrumb state from earlier tests in this file.
		process.env.TMUX_PANE = "%legacy-migration-test";
		testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-manager-legacy-agent-"));
		setAgentDir(testAgentDir);
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-session-manager-legacy-"));
	});

	afterEach(() => {
		if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = originalTmuxPane;
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(tempDir);
		removeSyncWithRetries(testAgentDir);
	});

	it("keeps legacy migration in memory until later persisted activity rewrites the file", async () => {
		const sessionFile = path.join(tempDir, "legacy.jsonl");
		fs.writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({ type: "session", id: "legacy-session", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir }),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:02Z",
					message: makeAssistantMessage(),
				}),
			].join("\n")}\n`,
		);
		fs.utimesSync(sessionFile, OLDER_MTIME, OLDER_MTIME);
		const initialMtimeMs = fs.statSync(sessionFile).mtimeMs;

		const session = await SessionManager.open(sessionFile, tempDir);
		const migratedEntries = session.getEntries();

		expect(migratedEntries).toHaveLength(2);
		for (const entry of migratedEntries) {
			expect(entry.id).toBeDefined();
		}
		expect(migratedEntries[0]?.parentId).toBeNull();
		expect(migratedEntries[1]?.parentId).toBe(migratedEntries[0]?.id);

		await session.flush();
		expect(fs.statSync(sessionFile).mtimeMs).toBe(initialMtimeMs);

		session.appendMessage({ role: "user", content: "follow up", timestamp: Date.now() });
		await session.flush();

		const persistedEntries = await loadEntriesFromFile(sessionFile);
		const header = getHeader(persistedEntries);
		if (!header) throw new Error("Expected session header");

		expect(fs.statSync(sessionFile).mtimeMs).toBeGreaterThan(initialMtimeMs);
		expect(header.version).toBe(3);
		expect(persistedEntries).toHaveLength(4);
		for (const entry of persistedEntries.filter(entry => entry.type !== "session")) {
			expect(entry.id).toBeDefined();
		}
	});

	it("still rewrites immediately when explicitly requested", async () => {
		const sessionFile = path.join(tempDir, "legacy-rewrite.jsonl");
		fs.writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({ type: "session", id: "legacy-session", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir }),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
			].join("\n")}\n`,
		);
		fs.utimesSync(sessionFile, OLDER_MTIME, OLDER_MTIME);
		const initialMtimeMs = fs.statSync(sessionFile).mtimeMs;

		const session = await SessionManager.open(sessionFile, tempDir);
		await session.rewriteEntries();

		const persistedEntries = await loadEntriesFromFile(sessionFile);
		const header = getHeader(persistedEntries);
		if (!header) throw new Error("Expected session header");

		expect(fs.statSync(sessionFile).mtimeMs).toBeGreaterThan(initialMtimeMs);
		expect(header.version).toBe(3);
		expect(persistedEntries).toHaveLength(2);
		expect(persistedEntries[1]?.type).toBe("message");
		if (persistedEntries[1]?.type !== "message") throw new Error("Expected message entry");
		expect(persistedEntries[1].id).toBeDefined();
		expect(persistedEntries[1].parentId).toBeNull();
	});

	it("forces a deferred legacy rewrite when ensureOnDisk is requested", async () => {
		const sessionFile = path.join(tempDir, "legacy-ensure-on-disk.jsonl");
		fs.writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({ type: "session", id: "legacy-session", timestamp: "2025-01-01T00:00:00Z", cwd: tempDir }),
				JSON.stringify({
					type: "message",
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: "hello", timestamp: 1 },
				}),
			].join("\n")}\n`,
		);
		fs.utimesSync(sessionFile, OLDER_MTIME, OLDER_MTIME);
		const initialMtimeMs = fs.statSync(sessionFile).mtimeMs;

		const session = await SessionManager.open(sessionFile, tempDir);
		await session.ensureOnDisk();

		const persistedEntries = await loadEntriesFromFile(sessionFile);
		const header = getHeader(persistedEntries);
		if (!header) throw new Error("Expected session header");

		expect(fs.statSync(sessionFile).mtimeMs).toBeGreaterThan(initialMtimeMs);
		expect(header.version).toBe(3);
		expect(persistedEntries).toHaveLength(2);
		expect(persistedEntries[1]?.type).toBe("message");
		if (persistedEntries[1]?.type !== "message") throw new Error("Expected message entry");
		expect(persistedEntries[1].id).toBeDefined();
		expect(persistedEntries[1].parentId).toBeNull();
	});
	it("keeps an explicitly started session resumable after its first turn", async () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() - 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const previousSessionFile = session.getSessionFile();
		if (!previousSessionFile) throw new Error("Expected persisted session file");

		const freshSessionFile = await session.newSession();
		expect(freshSessionFile).toBeDefined();
		// The boundary itself is durable before the first turn; completed output
		// then keeps the same session at the head of restart selection (#5730).
		expect(fs.existsSync(freshSessionFile!)).toBe(true);
		session.appendMessage({ role: "user", content: "first message of fresh session", timestamp: Date.now() });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		expect(fs.existsSync(freshSessionFile!)).toBe(true);

		const resumed = await SessionManager.continueRecent(tempDir, tempDir);
		try {
			// The `/new` boundary is durable: once materialized, relaunch resumes
			// the fresh session, not the pre-`/new` transcript.
			expect(resumed.getSessionFile()).toBe(freshSessionFile);
		} finally {
			await resumed.close();
			await session.close();
		}
	});
});
