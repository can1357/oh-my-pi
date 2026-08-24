import { describe, expect, it } from "bun:test";
import { toolExecutionId } from "@oh-my-pi/pi-agent-core/presentation";
import type {
	FileEntry,
	SessionHeader,
	ToolExecutionSettledEntry,
	ToolExecutionStartedEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import {
	migrateSessionEntries,
	migrateToCurrentVersion,
	SessionVersionTooNewError,
} from "@oh-my-pi/pi-coding-agent/session/session-migrations";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("migrateSessionEntries", () => {
	it("should add id/parentId to v1 entries", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{ type: "message", timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: "hi", timestamp: 1 } },
			{
				type: "message",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		// Header should have version set to current
		expect((entries[0] as any).version).toBe(4);

		// Entries should have id/parentId
		const msg1 = entries[1] as any;
		const msg2 = entries[2] as any;

		expect(msg1.id).toBeDefined();
		expect(msg1.id.length).toBe(8);
		expect(msg1.parentId).toBeNull();

		expect(msg2.id).toBeDefined();
		expect(msg2.id.length).toBe(8);
		expect(msg2.parentId).toBe(msg1.id);
	});

	it("should be idempotent (skip already migrated)", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", version: 2, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "abc12345",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{
				type: "message",
				id: "def67890",
				parentId: "abc12345",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		// IDs should be unchanged
		expect((entries[1] as any).id).toBe("abc12345");
		expect((entries[2] as any).id).toBe("def67890");
		expect((entries[2] as any).parentId).toBe("abc12345");
	});
});

describe("migrateToCurrentVersion — v4", () => {
	it("migrates a v3 file to v4 as a genuine no-op: legacy entries stay byte-identical, only the version stamp changes", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-v3", version: 3, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "msg0000a",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "MARKER_V3_USER_TURN_7F2A", timestamp: 1 },
			},
			{
				type: "message",
				id: "msg0000b",
				parentId: "msg0000a",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "MARKER_V3_ASSISTANT_REPLY_9K3D" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			},
		] as FileEntry[];
		const preMigrationNonHeader = entries.slice(1).map(e => JSON.stringify(e));

		const migrated = migrateToCurrentVersion(entries);

		expect(migrated).toBe(true);
		expect(entries).toHaveLength(3);
		expect((entries[0] as SessionHeader).version).toBe(4);
		// Nothing beyond the version stamp was invented or altered — v3→v4 cannot
		// backfill structure for old result messages.
		const postMigrationNonHeader = entries.slice(1).map(e => JSON.stringify(e));
		expect(postMigrationNonHeader).toEqual(preMigrationNonHeader);
	});

	it("fails closed on a session header newer than CURRENT_SESSION_VERSION instead of silently loading it", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-future", version: 5, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "msg0000c",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "MARKER_FUTURE_UNTOUCHED_4Q1Z", timestamp: 1 },
			},
		] as FileEntry[];
		const before = entries.map(e => JSON.stringify(e));

		expect(() => migrateToCurrentVersion(entries)).toThrow(SessionVersionTooNewError);
		// Rejection happens before any migration arm runs — the future entries
		// are never mutated on the way to being refused.
		expect(entries.map(e => JSON.stringify(e))).toEqual(before);
	});

	it("loads a v4 file with both journal entry types without migration, round-tripping through JSONL", async () => {
		const started: ToolExecutionStartedEntry = {
			type: "tool_execution_started",
			id: "tex00001",
			parentId: null,
			timestamp: "2025-01-01T00:00:01Z",
			recordVersion: 1,
			executionId: toolExecutionId("exec-0000000001"),
			call: {
				toolCallId: "call-0000000001",
				toolName: "bash",
				title: "Run MARKER_V4_TOOL_TITLE_8H5R",
				kind: "execute",
			},
			presentation: { version: 1, facts: [] },
		};
		const settled: ToolExecutionSettledEntry = {
			type: "tool_execution_settled",
			id: "tex00002",
			parentId: "tex00001",
			timestamp: "2025-01-01T00:00:02Z",
			recordVersion: 1,
			executionId: toolExecutionId("exec-0000000001"),
			outcome: { kind: "succeeded" },
			presentation: { version: 1, facts: [], attachments: [] },
			modelProjection: { version: 1, content: [] },
		};
		const header: FileEntry = {
			type: "session",
			version: 4,
			id: "sess-v4",
			timestamp: "2025-01-01T00:00:00Z",
			cwd: "/tmp",
		} as FileEntry;

		const tempDir = await TempDir.create();
		try {
			const filePath = tempDir.join("v4-journal-session.jsonl");
			const lines = [header, started, settled].map(e => JSON.stringify(e)).join("\n");
			await Bun.write(filePath, `${lines}\n`);

			const loaded = await loadEntriesFromFile(filePath);
			const migrated = migrateToCurrentVersion(loaded);

			expect(migrated).toBe(false); // already current — no migration needed
			expect((loaded[0] as SessionHeader).version).toBe(4);
			const loadedStarted = loaded[1] as ToolExecutionStartedEntry;
			const loadedSettled = loaded[2] as ToolExecutionSettledEntry;
			expect(loadedStarted.type).toBe("tool_execution_started");
			expect(loadedStarted.recordVersion).toBe(1);
			expect(loadedStarted.executionId).toBe(toolExecutionId("exec-0000000001"));
			expect(loadedStarted.call.title).toBe("Run MARKER_V4_TOOL_TITLE_8H5R");
			expect(loadedSettled.type).toBe("tool_execution_settled");
			expect(loadedSettled.outcome).toEqual({ kind: "succeeded" });
			expect(loadedSettled.modelProjection).toEqual({ version: 1, content: [] });
		} finally {
			await tempDir.remove();
		}
	});
});
