/**
 * The v4 journal schemas (`persistedToolJournalSchema`)
 * were test-pinned but had zero production callers — both `session-loader.ts`
 * loader paths bare-cast raw `tool_execution_*` entries to `FileEntry`. This
 * pins the load-boundary enforcement added to close that gap: both loader
 * paths (`parseSessionContent`'s non-streaming path and
 * `loadEntriesFromFileStream`'s streaming path) must safeParse the projected
 * journal payload and fail closed, never silently drop or misread a record.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	JournalRecordValidationError,
	loadEntriesFromFileStream,
	parseSessionContent,
	SessionJournalTooNewError,
} from "@oh-my-pi/pi-coding-agent/session/session-loader";

const ISO = "2026-06-29T12:00:00.000Z";
const HEADER = { type: "session", version: 4, id: "s1", timestamp: ISO, cwd: "/tmp" };

const minimalCall = {
	toolCallId: "call-0000000001",
	toolName: "bash",
	title: "Run echo",
	kind: "execute" as const,
};
const minimalStartedPresentation = { version: 1 as const, facts: [] };
const minimalToolPresentation = { version: 1 as const, facts: [], attachments: [] };
const minimalSucceededOutcome = { kind: "succeeded" as const };
const minimalModelProjection = { version: 1 as const, content: [] };

function validStartedEntry(id: string, parentId: string | null) {
	return {
		type: "tool_execution_started",
		id,
		parentId,
		timestamp: ISO,
		recordVersion: 1,
		executionId: "exec-0000000001",
		call: minimalCall,
		presentation: minimalStartedPresentation,
	};
}

function validSettledEntry(id: string, parentId: string | null) {
	return {
		type: "tool_execution_settled",
		id,
		parentId,
		timestamp: ISO,
		recordVersion: 1,
		executionId: "exec-0000000001",
		outcome: minimalSucceededOutcome,
		presentation: minimalToolPresentation,
		modelProjection: minimalModelProjection,
	};
}

function jsonlContent(entries: unknown[]): string {
	return `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`;
}

const preV4Header = { type: "session", version: 3, id: "s1", timestamp: ISO, cwd: "/tmp" };
const preV4Message = {
	type: "message",
	id: "m1",
	parentId: null,
	timestamp: ISO,
	message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 },
};

describe("session-loader tool journal load-boundary validation (non-streaming path)", () => {
	it("loads a valid v4 session with started+settled journal entries", () => {
		const content = jsonlContent([HEADER, validStartedEntry("a", null), validSettledEntry("b", "a")]);
		const result = parseSessionContent(content);
		expect(result.entries.map(e => e.type)).toEqual(["session", "tool_execution_started", "tool_execution_settled"]);
	});

	it("throws SessionJournalTooNewError for an unknown future recordVersion", () => {
		const bad = { ...validStartedEntry("a", null), recordVersion: 2 };
		const content = jsonlContent([HEADER, bad]);
		expect(() => parseSessionContent(content)).toThrow(SessionJournalTooNewError);
	});

	it("throws SessionJournalTooNewError for an unknown future nested presentation version", () => {
		const bad = { ...validStartedEntry("a", null), presentation: { ...minimalStartedPresentation, version: 2 } };
		const content = jsonlContent([HEADER, bad]);
		expect(() => parseSessionContent(content)).toThrow(SessionJournalTooNewError);
	});

	it("throws JournalRecordValidationError for a malformed started record, naming executionId and issue paths", () => {
		const bad = { ...validStartedEntry("a", null), call: { ...minimalCall, toolCallId: 123 } };
		const content = jsonlContent([HEADER, bad]);
		try {
			parseSessionContent(content);
			throw new Error("expected parseSessionContent to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(JournalRecordValidationError);
			const validationErr = err as JournalRecordValidationError;
			expect(validationErr.executionId).toBe("exec-0000000001");
			expect(validationErr.issuePaths).toEqual(["call.toolCallId"]);
		}
	});

	it("throws JournalRecordValidationError for a malformed settled record", () => {
		const bad = { ...validSettledEntry("a", null), outcome: { kind: "unknown_kind" } };
		const content = jsonlContent([HEADER, bad]);
		expect(() => parseSessionContent(content)).toThrow(JournalRecordValidationError);
	});

	it("leaves pre-v4 sessions (no tool_execution_* entries) unaffected", () => {
		const content = jsonlContent([preV4Header, preV4Message]);
		const result = parseSessionContent(content);
		expect(result.entries.map(e => e.type)).toEqual(["session", "message"]);
	});
});

describe("session-loader tool journal load-boundary validation (streaming path)", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) {
			fs.rmSync(dir, { recursive: true, force: true });
			dir = undefined;
		}
	});

	function writeTemp(content: string): string {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-journal-validation-test-"));
		const file = path.join(dir, "session.jsonl");
		fs.writeFileSync(file, content);
		return file;
	}

	it("loads a valid v4 session with started+settled journal entries", async () => {
		const file = writeTemp(jsonlContent([HEADER, validStartedEntry("a", null), validSettledEntry("b", "a")]));
		const result = await loadEntriesFromFileStream(file);
		expect(result.entries.map(e => e.type)).toEqual(["session", "tool_execution_started", "tool_execution_settled"]);
	});

	it("throws SessionJournalTooNewError for an unknown future recordVersion", async () => {
		const bad = { ...validStartedEntry("a", null), recordVersion: 2 };
		const file = writeTemp(jsonlContent([HEADER, bad]));
		await expect(loadEntriesFromFileStream(file)).rejects.toThrow(SessionJournalTooNewError);
	});

	it("throws JournalRecordValidationError for a malformed started record", async () => {
		const bad = { ...validStartedEntry("a", null), call: { ...minimalCall, toolCallId: 123 } };
		const file = writeTemp(jsonlContent([HEADER, bad]));
		try {
			await loadEntriesFromFileStream(file);
			throw new Error("expected loadEntriesFromFileStream to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(JournalRecordValidationError);
			const validationErr = err as JournalRecordValidationError;
			expect(validationErr.executionId).toBe("exec-0000000001");
			expect(validationErr.issuePaths.length).toBeGreaterThan(0);
		}
	});

	it("throws JournalRecordValidationError for a malformed settled record", async () => {
		const bad = { ...validSettledEntry("a", null), outcome: { kind: "unknown_kind" } };
		const file = writeTemp(jsonlContent([HEADER, bad]));
		await expect(loadEntriesFromFileStream(file)).rejects.toThrow(JournalRecordValidationError);
	});

	it("leaves pre-v4 sessions (no tool_execution_* entries) unaffected", async () => {
		const file = writeTemp(jsonlContent([preV4Header, preV4Message]));
		const result = await loadEntriesFromFileStream(file);
		expect(result.entries.map(e => e.type)).toEqual(["session", "message"]);
	});
});
