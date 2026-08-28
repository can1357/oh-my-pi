import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeSessionStore } from "../src/session/claude-session-store";
import { CodexSessionStore } from "../src/session/codex-session-store";
import { persistForeignSession } from "../src/session/foreign-session-import";
import type { ForeignSessionInfo } from "../src/session/foreign-session-store";
import { buildSessionContext } from "../src/session/session-context";
import { SessionManager } from "../src/session/session-manager";
import { FileSessionStorage } from "../src/session/session-storage";

let tempRoot: string;
let originalClaudeConfigDir: string | undefined;

beforeEach(async () => {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-foreign-sessions-"));
	originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
	delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (originalClaudeConfigDir === undefined) {
		delete process.env.CLAUDE_CONFIG_DIR;
	} else {
		process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
	}
	await fs.rm(tempRoot, { recursive: true, force: true });
});

async function writeJsonl(filePath: string, records: Record<string, unknown>[]): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
}

async function createClaudeFixture(): Promise<{ info: ForeignSessionInfo; store: ClaudeSessionStore }> {
	const root = path.join(tempRoot, ".claude");
	const cwd = path.join(tempRoot, "project-with-hyphen");
	const id = "11111111-1111-4111-8111-111111111111";
	const projectDirectory = cwd.replaceAll(path.sep, "-");
	const sessionPath = path.join(root, "projects", projectDirectory, `${id}.jsonl`);
	await writeJsonl(path.join(root, "history.jsonl"), [
		{ sessionId: id, timestamp: 1_767_225_600_000, display: "First prompt", project: cwd },
		{ sessionId: id, timestamp: 1_767_225_603_000, display: "Second prompt", project: cwd },
	]);
	await writeJsonl(sessionPath, [
		{
			type: "user",
			uuid: "claude-user",
			parentUuid: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
			message: { content: "First prompt" },
		},
		{
			type: "assistant",
			uuid: "claude-assistant",
			parentUuid: "claude-user",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: {
				id: "msg_claude",
				model: "claude-sonnet-4-5",
				stop_reason: "tool_use",
				usage: { input_tokens: 10, output_tokens: 5 },
				content: [
					{ type: "thinking", thinking: "Inspect the file", signature: "sig" },
					{ type: "text", text: "I will inspect it." },
					{ type: "tool_use", id: "tool-claude", name: "read", input: { path: "file.ts" } },
				],
			},
		},
		{
			type: "user",
			uuid: "claude-result",
			parentUuid: "claude-assistant",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				content: [{ type: "tool_result", tool_use_id: "tool-claude", content: "file contents" }],
			},
		},
		{ type: "custom-title", customTitle: "Imported Claude", timestamp: "2026-01-01T00:00:03.000Z" },
	]);
	const store = new ClaudeSessionStore(root);
	const info = (await store.list())[0];
	if (!info) throw new Error("Claude fixture was not listed");
	return { info, store };
}

describe("ClaudeSessionStore", () => {
	it("uses current history metadata and converts linked messages in memory", async () => {
		const { info, store } = await createClaudeFixture();

		expect(info.firstMessage).toBe("First prompt");
		expect(info.messageCount).toBe(2);
		expect(info.cwd).toBe(path.join(tempRoot, "project-with-hyphen"));
		const manager = await store.load(info);
		expect(manager.getSessionFile()).toBeUndefined();
		expect(manager.getSessionName()).toBe("Imported Claude");
		const entries = manager.getEntries();
		const messages = entries.filter(entry => entry.type === "message");
		expect(messages.map(entry => entry.message.role)).toEqual(["user", "assistant", "toolResult"]);
		const assistant = messages.find(entry => entry.message.role === "assistant");
		if (assistant?.message.role !== "assistant") throw new Error("Missing imported Claude assistant");
		const call = assistant.message.content.find(block => block.type === "toolCall");
		expect(call).toMatchObject({ id: "tool-claude", name: "read", arguments: { path: "file.ts" } });
		const result = messages.find(entry => entry.message.role === "toolResult");
		if (result?.message.role !== "toolResult") throw new Error("Missing imported Claude tool result");
		expect(result.message.toolCallId).toBe("tool-claude");
		expect(
			entries.some(entry => entry.type === "model_change" && entry.model === "anthropic/claude-sonnet-4-5"),
		).toBe(true);
		expect(messages[0]?.timestamp).toBe("2026-01-01T00:00:00.000Z");
	});

	it("recognizes legacy history keys and .projects storage", async () => {
		const root = path.join(tempRoot, ".claude");
		const cwd = path.join(tempRoot, "legacy");
		const id = "22222222-2222-4222-8222-222222222222";
		const sessionPath = path.join(root, ".projects", cwd.replaceAll(path.sep, "-"), `${id}.jsonl`);
		await writeJsonl(path.join(root, "history.jsonl"), [
			{ session_id: id, ts: 1_735_689_600_000, text: "Legacy prompt" },
		]);
		await writeJsonl(sessionPath, [
			{
				type: "user",
				uuid: "legacy-user",
				parentUuid: null,
				timestamp: "2025-01-01T00:00:00.000Z",
				cwd,
				message: { content: "Legacy prompt" },
			},
		]);

		const sessions = await new ClaudeSessionStore(root).list();

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.firstMessage).toBe("Legacy prompt");
		expect(sessions[0]?.created.toISOString()).toBe("2025-01-01T00:00:00.000Z");
	});

	it("defaults to CLAUDE_CONFIG_DIR and reads its colocated project registry", async () => {
		const root = path.join(tempRoot, "relocated-claude");
		const cwd = path.join(tempRoot, "project-with-hyphen");
		const id = "22222222-2222-4222-8222-333333333333";
		const encoded = cwd.replaceAll(path.sep, "-");
		process.env.CLAUDE_CONFIG_DIR = root;
		await Bun.write(path.join(root, ".claude.json"), JSON.stringify({ projects: { [cwd]: {} } }));
		await writeJsonl(path.join(root, "projects", encoded, `${id}.jsonl`), [
			{
				type: "user",
				uuid: "relocated-user",
				parentUuid: null,
				timestamp: "2025-01-01T00:00:00.000Z",
				message: { content: "Relocated prompt" },
			},
		]);

		const sessions = await new ClaudeSessionStore().list();

		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.cwd).toBe(cwd);
		expect(sessions[0]?.path).toBe(path.join(root, "projects", encoded, `${id}.jsonl`));
	});
});

describe("CodexSessionStore", () => {
	it("lists current indexed sessions without opening rollout files", async () => {
		const root = path.join(tempRoot, ".codex");
		await fs.mkdir(root, { recursive: true });
		const database = new Database(path.join(root, "state_5.sqlite"));
		try {
			database.run(
				"CREATE TABLE threads (id TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, cwd TEXT, title TEXT, first_user_message TEXT)",
			);
			database.run("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)", [
				"33333333-3333-4333-8333-333333333333",
				"sessions/missing.jsonl",
				1_767_225_600,
				1_767_225_660,
				path.join(tempRoot, "codex-project"),
				"Indexed Codex",
				"Indexed prompt",
			]);
		} finally {
			database.close();
		}

		const sessions = await new CodexSessionStore(root).list();

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			id: "33333333-3333-4333-8333-333333333333",
			title: "Indexed Codex",
			firstMessage: "Indexed prompt",
		});
		expect(sessions[0]?.modified.toISOString()).toBe("2026-01-01T00:01:00.000Z");
	});

	it("lists and converts legacy rollouts with complete tool linkage", async () => {
		const root = path.join(tempRoot, ".codex");
		const cwd = path.join(tempRoot, "codex-project");
		const id = "44444444-4444-4444-8444-444444444444";
		const sessionPath = path.join(root, ".sessions", "2025", "01", "01", `rollout-${id}.jsonl`);
		await writeJsonl(path.join(root, "session_index.jsonl"), [
			{ id, thread_name: "Legacy Codex", updated_at: "2025-01-01T00:00:12.000Z" },
		]);
		const replacementHistory = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Retained context" }] },
			{ type: "compaction", encrypted_content: "encrypted-compaction" },
		];
		await writeJsonl(sessionPath, [
			{ type: "session_meta", timestamp: "2025-01-01T00:00:00.000Z", payload: { id, cwd } },
			{ type: "turn_context", timestamp: "2025-01-01T00:00:01.000Z", payload: { model: "gpt-5.3-codex" } },
			{
				type: "response_item",
				timestamp: "2025-01-01T00:00:02.000Z",
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect" }] },
			},
			{
				type: "response_item",
				timestamp: "2025-01-01T00:00:03.000Z",
				payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Plan" }] },
			},
			{
				type: "response_item",
				timestamp: "2025-01-01T00:00:04.000Z",
				payload: { type: "function_call", call_id: "call-codex", name: "read", arguments: '{"path":"file.ts"}' },
			},
			{
				type: "response_item",
				timestamp: "2025-01-01T00:00:05.000Z",
				payload: { type: "function_call_output", call_id: "call-codex", output: "file contents" },
			},
			{
				type: "compacted",
				timestamp: "2025-01-01T00:00:06.000Z",
				payload: { message: "", replacement_history: replacementHistory },
			},
			{ type: "turn_context", timestamp: "2025-01-01T00:00:07.000Z", payload: { model: "gpt-5.3-codex" } },
			{
				type: "response_item",
				timestamp: "2025-01-01T00:00:08.000Z",
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
			},
			{
				type: "event_msg",
				timestamp: "2025-01-01T00:00:09.000Z",
				payload: { type: "web_search_end", call_id: "call-web", query: "docs", action: { query: "docs" } },
			},
			{
				type: "response_item",
				timestamp: "2025-01-01T00:00:10.000Z",
				payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] },
			},
			{
				type: "event_msg",
				timestamp: "2025-01-01T00:00:11.000Z",
				payload: { type: "thread_name_updated", thread_name: "Imported Codex" },
			},
		]);
		const store = new CodexSessionStore(root);
		const info = (await store.list())[0];
		if (!info) throw new Error("Codex fixture was not listed");

		const manager = await store.load(info);

		expect(info.title).toBe("Legacy Codex");
		expect(manager.getSessionFile()).toBeUndefined();
		expect(manager.getSessionName()).toBe("Imported Codex");
		const entries = manager.getEntries();
		expect(entries.some(entry => entry.type === "model_change" && entry.model === "openai-codex/gpt-5.3-codex")).toBe(
			true,
		);
		const compaction = entries.find(entry => entry.type === "compaction");
		if (compaction?.type !== "compaction") throw new Error("Missing imported Codex compaction");
		expect(compaction.firstKeptEntryId).toBe(compaction.id);
		expect(compaction.preserveData).toEqual({
			openaiRemoteCompaction: {
				provider: "openai-codex",
				replacementHistory,
				compactionItem: replacementHistory[1],
			},
		});
		const activeContext = buildSessionContext(entries);
		expect(activeContext.messages.map(message => message.role)).toEqual([
			"compactionSummary",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(activeContext.messages[1]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "Continue" }],
		});
		const activeSummary = activeContext.messages[0];
		if (activeSummary?.role !== "compactionSummary") throw new Error("Missing active Codex compaction context");
		expect(activeSummary.providerPayload).toEqual({
			type: "openaiResponsesHistory",
			provider: "openai-codex",
			items: replacementHistory,
		});
		const transcript = buildSessionContext(entries, undefined, undefined, { transcript: true });
		expect(transcript.messages.map(message => message.role)).toEqual([
			"user",
			"assistant",
			"assistant",
			"toolResult",
			"compactionSummary",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(transcript.messages[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "Inspect" }],
		});
		const calls = new Set<string>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) if (block.type === "toolCall") calls.add(block.id);
		}
		let resultCount = 0;
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
			resultCount += 1;
			expect(calls.has(entry.message.toolCallId)).toBe(true);
		}
		expect(calls).toEqual(new Set(["call-codex", "call-web"]));
		expect(resultCount).toBe(2);
	});
});

describe("foreign session persistence", () => {
	it("writes a fresh OMP identity with source provenance", async () => {
		const { info, store } = await createClaudeFixture();
		const sessionDir = path.join(tempRoot, "omp-sessions");

		const persisted = await persistForeignSession(store, info, { sessionDir, suppressBreadcrumb: true });
		const sessionFile = persisted.getSessionFile();
		if (!sessionFile) throw new Error("Imported session was not persisted");
		await persisted.close();
		const reopened = await SessionManager.open(sessionFile, sessionDir, new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		try {
			expect(reopened.getSessionId()).not.toBe(info.id);
			expect(reopened.getSessionName()).toBe("Imported Claude");
			const provenance = reopened
				.getEntries()
				.find(entry => entry.type === "custom" && entry.customType === "foreign_session_import");
			expect(provenance).toMatchObject({
				data: { source: "claude", sourceId: info.id, sourcePath: info.path, sourceCwd: info.cwd },
			});
		} finally {
			await reopened.close();
		}
	});
});
