/**
 * Operator-facing context rollback: `/undo [n]`, `/revert`, `/redo`.
 *
 * Covers the branch/rewind semantics of AgentSession.userUndo/userUndoTo/
 * userRedo and the two content-leak invariants (in-context report and branch
 * summary must stay free of dropped-prompt text; the prompt list lives in
 * branch details, which never renders into context).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const SECRET_A = "MARKER-ALPHA-7";
const SECRET_B = "MARKER-BRAVO-3";
const SECRET_C = "MARKER-CHARLIE-9";

function userMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantMessage(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic",
		provider: "anthropic",
		model: "test-model",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
		},
		timestamp: Date.now(),
	};
}

function contextText(session: AgentSession): string {
	return session
		.buildDisplaySessionContext()
		.messages.map(message => {
			if (!("content" in message)) return "";
			const { content } = message;
			if (typeof content === "string") return content;
			return Array.isArray(content)
				? content.flatMap(part => (part.type === "text" ? [part.text] : [])).join(" ")
				: "";
		})
		.join("\n");
}

describe("AgentSession user undo/redo", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	async function makeSession(): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, `auth-${authStorages.length}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		sessionManager = SessionManager.inMemory();
		return new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
		});
	}

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-user-undo-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	async function seedThreeTurns(): Promise<void> {
		// Three user turns with distinctive secrets + assistant replies, the
		// way a real conversation would be persisted (no model streaming
		// needed — undo operates on persisted entries).
		sessionManager.appendMessage(userMessage(`Remember ${SECRET_A}`));
		sessionManager.appendMessage(assistantMessage("OK A"));
		sessionManager.appendMessage(userMessage(`Remember ${SECRET_B}`));
		sessionManager.appendMessage(assistantMessage("OK B"));
		sessionManager.appendMessage(userMessage(`Remember ${SECRET_C}`));
		sessionManager.appendMessage(assistantMessage("OK C"));
	}

	it("undo drops the last turn from the active context", async () => {
		session = await makeSession();
		await seedThreeTurns();

		const result = session.userUndo();
		expect(result.ok).toBe(true);
		expect(result.droppedTurns).toBe(1);

		const text = contextText(session);
		expect(text).toContain(SECRET_A);
		expect(text).toContain(SECRET_B);
		expect(text).not.toContain(SECRET_C);
		expect(text).not.toContain("OK C");
	});

	it("undo N drops the last N turns", async () => {
		session = await makeSession();
		await seedThreeTurns();

		const result = session.userUndo(2);
		expect(result.ok).toBe(true);
		expect(result.droppedTurns).toBe(2);

		const text = contextText(session);
		expect(text).toContain(SECRET_A);
		expect(text).not.toContain(SECRET_B);
		expect(text).not.toContain(SECRET_C);
	});

	it("dropped turns survive off-branch in the session tree", async () => {
		session = await makeSession();
		await seedThreeTurns();
		const preUndoEntries = sessionManager.getEntries().length;

		session.userUndo();

		// Journal is append-only: the dropped entries still exist physically.
		expect(sessionManager.getEntries().length).toBeGreaterThan(preUndoEntries);
		const anyText = sessionManager
			.getEntries()
			.map(entry =>
				entry.type === "message" && "content" in entry.message ? JSON.stringify(entry.message.content) : "",
			)
			.join("");
		expect(anyText).toContain(SECRET_C);
	});

	it("undo leaves no dropped-prompt text in the context (report leak invariant)", async () => {
		session = await makeSession();
		await seedThreeTurns();

		session.userUndo(3);

		const text = contextText(session);
		expect(text).not.toContain(SECRET_A);
		expect(text).not.toContain(SECRET_B);
		expect(text).not.toContain(SECRET_C);
	});

	it("undo is silent: empty summary, no report message, details intact", async () => {
		session = await makeSession();
		await seedThreeTurns();

		session.userUndo(1);

		// No undo-report custom message on the branch — silent contract.
		const reportEntries = sessionManager
			.getBranch()
			.filter(entry => entry.type === "custom_message" && JSON.stringify(entry).includes("rewound"));
		expect(reportEntries.length).toBe(0);

		const branchEntries = sessionManager.getBranch().filter(entry => entry.type === "branch_summary") as Array<{
			summary: string;
			details?: { droppedPrompts?: string; kind?: string; steps?: number; undoOf?: string | null };
		}>;
		expect(branchEntries.length).toBe(1);
		const marker = branchEntries[0]!;
		// The summary is EMPTY — session-context.ts renders branch summaries
		// only when non-empty, so nothing about the undo reaches the model.
		expect(marker.summary).toBe("");
		// The prompt list lives in details, which never renders.
		expect(marker.details?.kind).toBe("user-undo");
		expect(marker.details?.steps).toBe(1);
		expect(marker.details?.droppedPrompts).toContain(SECRET_C);
		expect(typeof marker.details?.undoOf).toBe("string");
	});

	it("redo restores the turns dropped by undo", async () => {
		session = await makeSession();
		await seedThreeTurns();

		session.userUndo(1);
		const redo = session.userRedo();
		expect(redo.ok).toBe(true);

		const text = contextText(session);
		expect(text).toContain(SECRET_A);
		expect(text).toContain(SECRET_B);
		expect(text).toContain(SECRET_C);
	});

	it("redo refuses once turns were appended after the undo (no silent abandonment)", async () => {
		session = await makeSession();
		await seedThreeTurns();

		session.userUndo(1);
		// Operator continues: plain appended turns create no branch summary,
		// so the undo marker is still the last branch_summary on the path —
		// redo must refuse instead of branching away the new conversation.
		sessionManager.appendMessage(userMessage("Post-undo continuation"));
		sessionManager.appendMessage(assistantMessage("Fresh answer"));

		const redo = session.userRedo();
		expect(redo.ok).toBe(false);
		expect(redo.error).toContain("appended after the /undo");

		const text = contextText(session);
		expect(text).toContain("Post-undo continuation");
		expect(text).not.toContain(SECRET_C);
	});

	it("a user-invoked skill prompt counts as a user turn for /undo and /revert", async () => {
		session = await makeSession();
		sessionManager.appendMessage(userMessage(`Remember ${SECRET_A}`));
		sessionManager.appendMessage(assistantMessage("OK A"));
		sessionManager.appendMessage({
			role: "custom",
			customType: "skill-prompt",
			content: [{ type: "text", text: `Run ${SECRET_B} now` }],
			display: false,
			attribution: "user",
			timestamp: Date.now(),
		});
		sessionManager.appendMessage(assistantMessage("OK skill"));

		const turns = session.getUserTurns();
		expect(turns.length).toBe(2);
		expect(turns[1]!.preview).toContain(SECRET_B);

		const undo = session.userUndo(1);
		expect(undo.ok).toBe(true);
		expect(undo.droppedTurns).toBe(1);
		const text = contextText(session);
		expect(text).toContain(SECRET_A);
		expect(text).not.toContain(SECRET_B);

		const branchEntries = sessionManager.getEntries().filter(entry => entry.type === "branch_summary");
		const marker = branchEntries.at(-1) as { details?: { droppedPrompts?: string } };
		expect(marker.details?.droppedPrompts).toContain(SECRET_B);
	});

	it("undo and redo leave live todo state untouched", async () => {
		session = await makeSession();
		const phases = [
			{
				name: "work",
				tasks: [
					{ content: "already done", status: "completed" as const },
					{ content: "still open", status: "pending" as const },
				],
			},
		];
		session.setTodoPhases(phases);
		await seedThreeTurns();

		const undo = session.userUndo(1);
		expect(undo.ok).toBe(true);
		expect(session.getTodoPhases()).toEqual(phases);

		const redo = session.userRedo();
		expect(redo.ok).toBe(true);
		expect(session.getTodoPhases()).toEqual(phases);
	});

	it("redo fails when no undo branch marker is on the active path", async () => {
		session = await makeSession();
		await seedThreeTurns();

		const redo = session.userRedo();
		expect(redo.ok).toBe(false);
		expect(redo.error).toBeDefined();
	});

	it("revert-to-entry drops everything after the chosen turn (partial revert)", async () => {
		session = await makeSession();
		await seedThreeTurns();

		const turns = session.getUserTurns();
		expect(turns.length).toBe(3);
		expect(turns[0]!.preview).toContain(SECRET_A);

		const result = session.userUndoTo(turns[1]!.entryId);
		expect(result.ok).toBe(true);
		expect(result.droppedTurns).toBe(2);

		const text = contextText(session);
		expect(text).toContain(SECRET_A);
		expect(text).not.toContain(SECRET_B);
		expect(text).not.toContain(SECRET_C);
	});

	it("revert to the first turn empties the conversation context", async () => {
		session = await makeSession();
		await seedThreeTurns();

		const turns = session.getUserTurns();
		const result = session.userUndoTo(turns[0]!.entryId);
		expect(result.ok).toBe(true);
		expect(result.droppedTurns).toBe(3);

		const text = contextText(session);
		expect(text).not.toContain(SECRET_A);
		expect(text).not.toContain(SECRET_B);
		expect(text).not.toContain(SECRET_C);
	});

	it("revert to an unknown entry fails cleanly", async () => {
		session = await makeSession();
		await seedThreeTurns();

		const result = session.userUndoTo("does-not-exist");
		expect(result.ok).toBe(false);
		expect(result.error).toBeDefined();
	});

	it("undo with no user turns reports unavailable", async () => {
		session = await makeSession();
		const result = session.userUndo();
		expect(result.ok).toBe(false);
		expect(result.error).toBeDefined();
	});

	it("getUserTurns lists active-path user turns oldest-first with previews", async () => {
		session = await makeSession();
		await seedThreeTurns();

		const turns = session.getUserTurns();
		expect(turns.length).toBe(3);
		expect(turns[0]!.preview).toContain(SECRET_A);
		expect(turns[1]!.preview).toContain(SECRET_B);
		expect(turns[2]!.preview).toContain(SECRET_C);

		session.userUndo(1);
		const after = session.getUserTurns();
		expect(after.length).toBe(2);
		expect(after[1]!.preview).toContain(SECRET_B);
	});
});
