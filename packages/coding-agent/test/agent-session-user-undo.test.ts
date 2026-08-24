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
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionFileLockError, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SessionTools } from "@oh-my-pi/pi-coding-agent/session/session-tools";
import { removeSyncWithRetries, Snowflake, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-wire";
import { TtsrManager } from "../src/export/ttsr";
import type { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { resolveLocalUrlToPath } from "../src/internal-urls";
import { getLatestTodoPhasesFromEntries } from "../src/tools/todo";

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
	let ttsrManager: TtsrManager;
	let mockModel: MockModel;
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	async function makeSession(ttsrSettings?: Record<string, unknown>): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		mockModel = mock;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, `auth-${authStorages.length}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		// Scoped to the test temp dir so local:// artifact URLs (plan files)
		// resolve inside the sandbox instead of the real session store.
		sessionManager = SessionManager.inMemory(tempDir);
		ttsrManager = new TtsrManager(ttsrSettings as never);
		return new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ttsrManager,
		});
	}

	beforeEach(() => {
		ttsrManager = new TtsrManager();
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

	async function makeFileBackedSession(sessionFileName: string): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		mockModel = mock;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, `auth-${sessionFileName}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		sessionManager = SessionManager.create(tempDir, tempDir);
		await sessionManager.setSessionFile(path.join(tempDir, sessionFileName));
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ttsrManager: new TtsrManager(),
		});
	}

	it("undo recomputes the plan-reference delivery flag from the branch", async () => {
		// File-backed (not in-memory): the local:// plan URL must resolve
		// through THIS session's artifacts dir — in-memory managers return a
		// null artifacts dir and fall back to the ambient agent registry.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		mockModel = mock;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth-plan-undo.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		sessionManager = SessionManager.create(tempDir, tempDir);
		const sessionFile = path.join(tempDir, "plan-undo.jsonl");
		await sessionManager.setSessionFile(sessionFile);
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ttsrManager: new TtsrManager(),
		});
		const planUrl = "local://approved-plan-undo.md";
		const resolved = resolveLocalUrlToPath(planUrl, {
			getArtifactsDir: () => sessionManager.getArtifactsDir(),
			getSessionId: () => sessionManager.getSessionId(),
		});
		fs.mkdirSync(path.dirname(resolved), { recursive: true });
		fs.writeFileSync(resolved, "# Approved Plan\n");

		// Turn A, then turn B whose span carries the delivered plan reference.
		sessionManager.appendMessage(userMessage(`Remember ${SECRET_A}`));
		sessionManager.appendMessage(assistantMessage("OK A"));
		sessionManager.appendMessage(userMessage(`Remember ${SECRET_B}`));
		sessionManager.appendMessage({
			role: "custom",
			customType: "plan-mode-reference",
			content: [{ type: "text", text: `Plan at ${planUrl}` }],
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
		sessionManager.appendMessage(assistantMessage("OK B"));
		session.setPlanReferencePath(planUrl);
		session.markPlanReferenceSent();

		const result = await session.userUndo();
		expect(result.ok).toBe(true);
		// The delivered reference left the branch with the turn.
		expect(
			sessionManager
				.getBranch()
				.some(
					entry =>
						entry.type === "message" &&
						(entry.message as { customType?: string }).customType === "plan-mode-reference",
				),
		).toBe(false);

		// The flag was reconciled from the branch: the next prompt re-injects
		// the approved plan reference instead of running without it.
		await session.sendUserMessage("next turn");
		const seen = mockModel.calls.at(-1)?.context.messages ?? [];
		const seenText = seen
			.map(message => {
				if (!("content" in message)) return "";
				return typeof message.content === "string"
					? message.content
					: Array.isArray(message.content)
						? message.content.map(part => (part.type === "text" ? part.text : "")).join(" ")
						: "";
			})
			.join("\n");
		expect(seenText).toContain(planUrl);
		await sessionManager.close();
	});

	it("undo drops the last turn from the active context", async () => {
		session = await makeSession();
		await seedThreeTurns();

		const result = await session.userUndo();
		expect(result.ok).toBe(true);
		expect(result.droppedTurns).toBe(1);

		const text = contextText(session);
		expect(text).toContain(SECRET_A);
		expect(text).toContain(SECRET_B);
		expect(text).not.toContain(SECRET_C);
		expect(text).not.toContain("OK C");
	});

	it("undo under append-lock contention completes the rollback in-memory", async () => {
		const sessionFile = path.join(tempDir, "contended-undo.jsonl");
		await makeFileBackedSession("contended-undo.jsonl");
		await seedThreeTurns();

		// Another writer holds the journal lock: the marker append throws
		// SessionFileLockError AFTER the branch switch applied in-memory.
		// The rollback must complete anyway (context rewound) — a
		// half-transition would run the next turn on pre-undo agent
		// messages while persisting beneath the undo branch.
		await sessionManager.rewriteEntries();
		const lock = tryAcquireFileLock(sessionFile);
		expect(lock?.acquired).toBe(true);
		try {
			const result = await session.userUndo();
			expect(result.ok).toBe(true);
		} finally {
			lock?.release();
		}
		const text = contextText(session);
		expect(text).toContain(SECRET_B);
		expect(text).not.toContain(SECRET_C);

		// The divergence flag routes the next append through a full
		// rewrite, so the deferred branch is durable afterwards.
		sessionManager.appendMessage(userMessage("after-contention"));
		const onDisk = fs.readFileSync(sessionFile, "utf8");
		expect(onDisk).toContain("user-undo");
		expect(onDisk).toContain("after-contention");
	});

	it("redo under append-lock contention completes the restore in-memory", async () => {
		const sessionFile = path.join(tempDir, "contended-redo.jsonl");
		await makeFileBackedSession("contended-redo.jsonl");
		await seedThreeTurns();
		expect((await session.userUndo()).ok).toBe(true);

		await sessionManager.rewriteEntries();
		const lock = tryAcquireFileLock(sessionFile);
		expect(lock?.acquired).toBe(true);
		try {
			const result = await session.userRedo();
			expect(result.ok).toBe(true);
		} finally {
			lock?.release();
		}
		expect(contextText(session)).toContain(SECRET_C);

		sessionManager.appendMessage(userMessage("after-contention"));
		const onDisk = fs.readFileSync(sessionFile, "utf8");
		expect(onDisk).toContain("user-redo");
		expect(onDisk).toContain("after-contention");
	});

	it("a contended undo still stages every re-journal entry in memory", async () => {
		const sessionFile = path.join(tempDir, "contended-staging.jsonl");
		await makeFileBackedSession("contended-staging.jsonl");
		await seedThreeTurns();
		const phases = [{ name: "work", tasks: [{ content: "one", status: "pending" as const }] }];
		session.setTodoPhases(phases);

		await sessionManager.rewriteEntries();
		const lock = tryAcquireFileLock(sessionFile);
		expect(lock?.acquired).toBe(true);
		try {
			expect((await session.userUndo()).ok).toBe(true);
		} finally {
			lock?.release();
		}
		// Per-call staging guards: under FULL contention every staging append
		// threw, yet each entry still landed in memory (the throw happens
		// after the in-memory insert) — a shared try would have stopped at
		// the first throw and dropped the todo snapshot from the promised
		// full rewrite entirely.
		sessionManager.appendMessage(userMessage("post"));
		const onDisk = fs.readFileSync(sessionFile, "utf8");
		const markerIdx = onDisk.indexOf("user-undo");
		expect(markerIdx).toBeGreaterThanOrEqual(0);
		expect(onDisk.indexOf("user_todo_edit", markerIdx)).toBeGreaterThan(markerIdx);
	});

	it("undo N drops the last N turns", async () => {
		session = await makeSession();
		await seedThreeTurns();

		const result = await session.userUndo(2);
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

		await session.userUndo();

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

		await session.userUndo(3);

		const text = contextText(session);
		expect(text).not.toContain(SECRET_A);
		expect(text).not.toContain(SECRET_B);
		expect(text).not.toContain(SECRET_C);
	});

	it("undo is silent: empty summary, no report message, details intact", async () => {
		session = await makeSession();
		await seedThreeTurns();

		await session.userUndo(1);

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

		await session.userUndo(1);
		const redo = await session.userRedo();
		expect(redo.ok).toBe(true);

		const text = contextText(session);
		expect(text).toContain(SECRET_A);
		expect(text).toContain(SECRET_B);
		expect(text).toContain(SECRET_C);
	});

	it("redo refuses once turns were appended after the undo (no silent abandonment)", async () => {
		session = await makeSession();
		await seedThreeTurns();

		await session.userUndo(1);
		// Operator continues: plain appended turns create no branch summary,
		// so the undo marker is still the last branch_summary on the path —
		// redo must refuse instead of branching away the new conversation.
		sessionManager.appendMessage(userMessage("Post-undo continuation"));
		sessionManager.appendMessage(assistantMessage("Fresh answer"));

		const redo = await session.userRedo();
		expect(redo.ok).toBe(false);
		expect(redo.error).toContain("appended after the /undo");

		const text = contextText(session);
		expect(text).toContain("Post-undo continuation");
		expect(text).not.toContain(SECRET_C);
	});

	it("model controls changed in the undone tail are re-recorded on the new branch", async () => {
		session = await makeSession();
		await seedThreeTurns();
		// Operator switched models mid-tail, then undoes past it: the live
		// model must be re-recorded after the marker so a reload resumes it
		// instead of the dropped entry's model.
		sessionManager.appendModelChange("openai/gpt-dropped", "default");
		sessionManager.appendMessage(userMessage(`One more ${SECRET_C}`));
		sessionManager.appendMessage(assistantMessage("OK tail"));

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);

		const branch = sessionManager.getBranch();
		const markerIdx = branch.findIndex(entry => entry.type === "branch_summary");
		const trailing = branch.slice(markerIdx + 1);
		expect(
			trailing.some(entry => entry.type === "model_change" && entry.model === "anthropic/claude-sonnet-4-5"),
		).toBe(true);
		expect(trailing.some(entry => entry.type === "model_change" && entry.model === "openai/gpt-dropped")).toBe(false);

		// Control entries after the marker do not block /redo.
		const redo = await session.userRedo();
		expect(redo.ok).toBe(true);
	});

	it("a tier cleared in live state is re-recorded as an explicit null after undo", async () => {
		session = await makeSession();
		await seedThreeTurns();
		// Kept region set a tier; the dropped tail cleared it; the live state
		// (null) must win and be recorded explicitly.
		sessionManager.appendServiceTierChange({ openai: "priority" });
		sessionManager.appendMessage(userMessage(`More ${SECRET_C}`));
		sessionManager.appendMessage(assistantMessage("OK tail"));

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);

		const branch = sessionManager.getBranch();
		const markerIdx = branch.findIndex(entry => entry.type === "branch_summary");
		const trailing = branch.slice(markerIdx + 1);
		const tierEntry = trailing.find(entry => entry.type === "service_tier_change") as
			| { serviceTier: unknown }
			| undefined;
		expect(tierEntry).toBeDefined();
		expect(tierEntry?.serviceTier).toBeNull();
	});

	it("undo snapshots live todo phases durably on the new branch", async () => {
		session = await makeSession();
		await seedThreeTurns();
		const phases = [{ name: "work", tasks: [{ content: "one", status: "pending" as const }] }];
		session.setTodoPhases(phases);

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		// Live phases untouched...
		expect(session.getTodoPhases()).toEqual(phases);
		// ...and a durable snapshot entry exists after the marker, so a reload
		// syncs back to the same phases instead of the off-branch tool result.
		const branch = sessionManager.getBranch();
		const markerIdx = branch.findIndex(entry => entry.type === "branch_summary");
		const snapshot = branch
			.slice(markerIdx + 1)
			.find(entry => entry.type === "custom" && entry.customType === "user_todo_edit") as
			| { data?: { phases?: Array<{ name: string; tasks: Array<{ content: string; status: string }> }> } }
			| undefined;
		expect(snapshot?.data?.phases).toEqual(phases);

		const redo = await session.userRedo();
		expect(redo.ok).toBe(true);
		expect(session.getTodoPhases()).toEqual(phases);
	});

	it("an emptied todo list is journaled as an explicit empty snapshot after undo", async () => {
		session = await makeSession();
		// Branch carries an older non-empty todo state (tool result or earlier
		// snapshot); the live list has since been cleared.
		sessionManager.appendCustomEntry("user_todo_edit", {
			phases: [{ name: "work", tasks: [{ content: "old", status: "pending" as const }] }],
		});
		await seedThreeTurns();
		session.setTodoPhases([]);

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		expect(session.getTodoPhases()).toEqual([]);

		const branch = sessionManager.getBranch();
		const markerIdx = branch.findIndex(entry => entry.type === "branch_summary");
		const snapshot = branch
			.slice(markerIdx + 1)
			.find(entry => entry.type === "custom" && entry.customType === "user_todo_edit") as
			| { data?: { phases?: unknown[] } }
			| undefined;
		expect(snapshot?.data?.phases).toEqual([]);
		// A reload syncing from the branch sees the empty state, not the older list.
		expect(getLatestTodoPhasesFromEntries(branch)).toEqual([]);
	});

	it("undo preserves the model role the session was switched through", async () => {
		session = await makeSession();
		await seedThreeTurns();
		sessionManager.appendMessage(userMessage(`More ${SECRET_C}`));
		sessionManager.appendMessage(assistantMessage("OK tail"));
		// Role switch lands inside the dropped tail.
		const smol = getBundledModel("anthropic", "claude-haiku-4-5")!;
		await session.setModel(smol, "smol");

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);

		expect(sessionManager.getLastModelChangeRole()).toBe("smol");
		const branch = sessionManager.getBranch();
		const markerIdx = branch.findIndex(entry => entry.type === "branch_summary");
		const roleEntry = branch.slice(markerIdx + 1).find(entry => entry.type === "model_change") as
			| { model?: string; role?: string }
			| undefined;
		expect(roleEntry?.model).toBe("anthropic/claude-haiku-4-5");
		expect(roleEntry?.role).toBe("smol");
	});

	it("undo re-journals the live mode so a reload keeps it", async () => {
		session = await makeSession();
		await seedThreeTurns();
		sessionManager.appendMessage(userMessage(`More ${SECRET_C}`));
		sessionManager.appendMessage(assistantMessage("OK tail"));
		// The mode transition lives in the dropped tail; the live process
		// keeps running in the mode, so it must be re-recorded.
		sessionManager.appendModeChange("plan", { planFilePath: "/tmp/plan.md" });

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);

		const branch = sessionManager.getBranch();
		const markerIdx = branch.findIndex(entry => entry.type === "branch_summary");
		const modeEntry = branch.slice(markerIdx + 1).find(entry => entry.type === "mode_change") as
			| { mode?: string; data?: Record<string, unknown> }
			| undefined;
		expect(modeEntry?.mode).toBe("plan");
		expect(modeEntry?.data?.planFilePath).toBe("/tmp/plan.md");
		expect(sessionManager.buildSessionContext().mode).toBe("plan");

		// The snapshot entry rides after the marker: redo still applies.
		const redo = await session.userRedo();
		expect(redo.ok).toBe(true);
	});

	it("a same-model role switch is re-journaled after undo, not flattened to default", async () => {
		session = await makeSession();
		await seedThreeTurns();
		sessionManager.appendMessage(userMessage(`More ${SECRET_C}`));
		sessionManager.appendMessage(assistantMessage("OK tail"));
		// Branch already carries the default-role model; the tail switches the
		// smol role to that same concrete model.
		sessionManager.appendModelChange("anthropic/claude-sonnet-4-5", "default");
		const same = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		await session.setModel(same, "smol");

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);

		expect(sessionManager.getLastModelChangeRole()).toBe("smol");
		const branch = sessionManager.getBranch();
		const markerIdx = branch.findIndex(entry => entry.type === "branch_summary");
		const roleEntry = branch.slice(markerIdx + 1).find(entry => entry.type === "model_change") as
			| { model?: string; role?: string }
			| undefined;
		expect(roleEntry?.model).toBe("anthropic/claude-sonnet-4-5");
		expect(roleEntry?.role).toBe("smol");
	});

	it("redo keeps the restored tail's model role", async () => {
		session = await makeSession();
		await seedThreeTurns();
		sessionManager.appendMessage(userMessage(`More ${SECRET_C}`));
		sessionManager.appendMessage(assistantMessage("OK tail"));
		const smol = getBundledModel("anthropic", "claude-haiku-4-5")!;
		await session.setModel(smol, "smol");

		expect((await session.userUndo(1)).ok).toBe(true);
		expect((await session.userRedo()).ok).toBe(true);

		// The restored tail's role entry is the last one; redo must not
		// re-journal the model under a default role.
		expect(sessionManager.getLastModelChangeRole()).toBe("smol");
	});

	it("undo re-journals the mode when only its payload changed in the tail", async () => {
		session = await makeSession();
		await seedThreeTurns();
		sessionManager.appendModeChange("plan", { planFilePath: "/tmp/plan-old.md" });
		sessionManager.appendMessage(userMessage(`More ${SECRET_C}`));
		sessionManager.appendMessage(assistantMessage("OK tail"));
		sessionManager.appendModeChange("plan", { planFilePath: "/tmp/plan-new.md" });

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);

		const branch = sessionManager.getBranch();
		const markerIdx = branch.findIndex(entry => entry.type === "branch_summary");
		const modeEntry = branch.slice(markerIdx + 1).find(entry => entry.type === "mode_change") as
			| { mode?: string; data?: Record<string, unknown> }
			| undefined;
		expect(modeEntry?.mode).toBe("plan");
		expect(modeEntry?.data?.planFilePath).toBe("/tmp/plan-new.md");
	});

	it("redo re-journals a mode entered after the undo", async () => {
		session = await makeSession();
		await seedThreeTurns();
		sessionManager.appendMessage(userMessage(`More ${SECRET_C}`));
		sessionManager.appendMessage(assistantMessage("OK tail"));

		expect((await session.userUndo(1)).ok).toBe(true);
		// Operator enters a mode AFTER the undo; the trailing mode_change is
		// tolerated, so redo proceeds — the live mode must come with it.
		sessionManager.appendModeChange("vibe", { previousTools: [] });

		expect((await session.userRedo()).ok).toBe(true);

		const branch = sessionManager.getBranch();
		const redoMarkerIdx = branch.findIndex(
			entry =>
				entry.type === "branch_summary" && (entry.details as { kind?: string } | undefined)?.kind === "user-redo",
		);
		expect(redoMarkerIdx).toBeGreaterThan(-1);
		const modeEntry = branch.slice(redoMarkerIdx + 1).find(entry => entry.type === "mode_change") as
			| { mode?: string }
			| undefined;
		expect(modeEntry?.mode).toBe("vibe");
		expect(sessionManager.buildSessionContext().mode).toBe("vibe");
	});

	it("undo reconciles TTSR injection records with the rewound branch", async () => {
		session = await makeSession();
		// Kept region injection stays; the tail injection goes off-branch.
		sessionManager.appendTtsrInjection(["kept-rule"]);
		await seedThreeTurns();
		sessionManager.appendMessage(userMessage(`More ${SECRET_C}`));
		sessionManager.appendMessage(assistantMessage("OK tail"));
		sessionManager.appendTtsrInjection(["dropped-rule"]);
		ttsrManager.markInjectedByNames(["kept-rule", "dropped-rule"]);
		expect(ttsrManager.getInjectedRuleNames().sort()).toEqual(["dropped-rule", "kept-rule"]);

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		// Records now mirror the rewound branch exactly: kept-rule survives,
		// dropped-rule can trigger again (same as a reload of this branch).
		expect(ttsrManager.getInjectedRuleNames()).toEqual(["kept-rule"]);

		const redo = await session.userRedo();
		expect(redo.ok).toBe(true);
		expect(ttsrManager.getInjectedRuleNames().sort()).toEqual(["dropped-rule", "kept-rule"]);
	});

	it("undo classifies a post-turn injection after its custom_message as post-turn", async () => {
		session = await makeSession();
		// Interrupt-mode delivery: assistant turn COMPLETED, then the steering
		// text persists as a custom_message and the injection record follows.
		// The custom_message must not keep the per-tool pre-turn-end
		// adjustment alive, or the restored position lands one turn too low
		// and an after-gap rule repeats one model turn early.
		sessionManager.appendMessage(userMessage(`Remember ${SECRET_A}`));
		sessionManager.appendMessage(assistantMessage("OK A"));
		sessionManager.appendCustomMessageEntry("ttsr-injection", [{ type: "text", text: "steering text" }], false, {
			rules: ["gap-rule"],
		});
		sessionManager.appendTtsrInjection(["gap-rule"]);
		sessionManager.appendMessage(userMessage(`More ${SECRET_C}`));
		sessionManager.appendMessage(assistantMessage("OK tail"));

		const positions = new Map<string, number>();
		const original = ttsrManager.restoreInjected.bind(ttsrManager);
		ttsrManager.restoreInjected = (names: string[], pos?: ReadonlyMap<string, number>) => {
			if (pos) for (const [name, value] of pos) positions.set(name, value);
			return original(names, pos);
		};

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		// One assistant turn precedes the injection on the rewound branch, and
		// the live counter had already advanced past it: position 1, not the
		// per-tool-adjusted 0.
		expect(positions.get("gap-rule")).toBe(1);
	});

	it("rollback rewinds the TTSR message counter with the branch", async () => {
		session = await makeSession();
		sessionManager.appendMessage(userMessage(`Remember ${SECRET_A}`));
		sessionManager.appendMessage(assistantMessage("OK A tool"));
		sessionManager.appendMessage(assistantMessage("OK A final"));
		sessionManager.appendTtsrInjection(["kept-rule"]);
		ttsrManager.markInjectedByNames(["kept-rule"]);
		sessionManager.appendMessage(userMessage(`Remember ${SECRET_B}`));
		sessionManager.appendMessage(assistantMessage("OK B"));
		// The live counter ran far past the branch: many turns have elapsed
		// since the injection, but most of them just got undone.
		for (let i = 0; i < 20; i++) ttsrManager.incrementMessageCount();

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		// Branch after undo keeps turn A's TWO model turns (a tool-using
		// prompt produces several turn_end events) — the counter rewinds in
		// model-turn units, not user-turn units.
		expect(ttsrManager.getMessageCount()).toBe(2);
	});

	it("rollback preserves TTSR gap timing for retained rules", async () => {
		const manager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "after-gap",
			repeatGap: 5,
		});
		expect(
			manager.addRule({
				name: "gap-rule",
				path: "/tmp/gap-rule.md",
				content: "body",
				condition: ["GAPMARK-\\d+"],
				_source: {
					provider: "test",
					providerName: "test",
					path: "/tmp/gap-rule.md",
					level: "user",
				},
			}),
		).toBe(true);
		const context = { source: "text" as const };
		let n = 0;
		const snapshot = () => `chunk GAPMARK-${n++}`;

		// Injected at message 3 of a gap of 5.
		manager.incrementMessageCount();
		manager.incrementMessageCount();
		manager.incrementMessageCount();
		manager.markInjectedByNames(["gap-rule"]);

		// The rewind reconcile: same rule still on the retained branch.
		manager.restoreInjected(["gap-rule"]);

		// Two more messages (count 5): with timing preserved the gap is 2 —
		// the rule must stay ineligible. A zeroed record would already
		// re-trigger here (gap 5).
		manager.incrementMessageCount();
		manager.incrementMessageCount();
		expect(manager.checkSnapshot(snapshot(), context)).toEqual([]);

		// Eligible again once the real gap (5 messages since injection) elapses.
		manager.incrementMessageCount();
		manager.incrementMessageCount();
		manager.incrementMessageCount();
		const matched = manager.checkSnapshot(snapshot(), context);
		expect(matched.map(rule => rule.name)).toEqual(["gap-rule"]);
	});

	it("a plan reference before a reset boundary does not count as delivered", async () => {
		await makeFileBackedSession("plan-boundary.jsonl");
		const planUrl = "local" + "://approved-plan-boundary.md";
		const resolved = resolveLocalUrlToPath(planUrl, {
			getArtifactsDir: () => sessionManager.getArtifactsDir() ?? tempDir,
			getSessionId: () => sessionManager.getSessionId(),
		});
		fs.mkdirSync(path.dirname(resolved), { recursive: true });
		fs.writeFileSync(resolved, "# Approved Plan\n");

		// Delivered reference inside turn A...
		sessionManager.appendMessage(userMessage(`Remember ${SECRET_A}`));
		sessionManager.appendMessage({
			role: "custom",
			customType: "plan-mode-reference",
			content: [{ type: "text", text: `Plan at ${planUrl}` }],
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
		sessionManager.appendMessage(assistantMessage("OK A"));
		// ...then /clear, then a later turn with no reference.
		sessionManager.appendResetBoundary();
		sessionManager.appendMessage(userMessage(`Remember ${SECRET_B}`));
		sessionManager.appendMessage(assistantMessage("OK B"));
		session.setPlanReferencePath(planUrl);
		session.markPlanReferenceSent();

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		// The only reference predates the boundary and is excluded from the
		// rebuilt context, so delivery is NOT marked and the next prompt
		// re-injects the plan.
		await session.sendUserMessage("next turn");
		const seen = mockModel.calls.at(-1)?.context.messages ?? [];
		const seenText = seen
			.map(message => {
				if (!("content" in message)) return "";
				return typeof message.content === "string"
					? message.content
					: Array.isArray(message.content)
						? message.content.map(part => (part.type === "text" ? part.text : "")).join(" ")
						: "";
			})
			.join("\n");
		expect(seenText).toContain(planUrl);
		await sessionManager.close();
	});

	it("redo restores TTSR timing from the branch, not zero", async () => {
		session = await makeSession({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "after-gap",
			repeatGap: 2,
		});
		ttsrManager.addRule({
			name: "redo-rule",
			path: "/tmp/redo-rule.md",
			content: "body",
			condition: ["REDOMARK"],
			_source: {
				provider: "test",
				providerName: "test",
				path: "/tmp/redo-rule.md",
				level: "user",
			},
		});
		// Turn A, then turn B carrying the injection.
		sessionManager.appendMessage(userMessage(`Remember ${SECRET_A}`));
		sessionManager.appendMessage(assistantMessage("OK A"));
		sessionManager.appendMessage(userMessage(`Remember ${SECRET_B}`));
		sessionManager.appendTtsrInjection(["redo-rule"]);
		sessionManager.appendMessage(assistantMessage("OK B"));

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		expect(ttsrManager.getInjectedRuleNames()).toEqual([]);

		const redo = await session.userRedo();
		expect(redo.ok).toBe(true);
		expect(ttsrManager.getInjectedRuleNames()).toEqual(["redo-rule"]);
		// Restored branch has 2 model turns and the injection sits at
		// position 1 (after A's reply, before B's): gap 1, the rule must NOT
		// be eligible yet. A zeroed record would give gap 2 and re-trigger.
		expect(ttsrManager.getMessageCount()).toBe(2);
		expect(ttsrManager.checkSnapshot("payload REDOMARK", { source: "text" })).toEqual([]);
	});

	it("per-tool ttsr injections restore pre-turn-end timing after undo", async () => {
		session = await makeSession({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "after-gap",
			repeatGap: 1,
		});
		ttsrManager.addRule({
			name: "per-tool-rule",
			path: "/tmp/per-tool-rule.md",
			content: "body",
			condition: ["PERTOOLMARK"],
			_source: {
				provider: "test",
				providerName: "test",
				path: "/tmp/per-tool-rule.md",
				level: "user",
			},
		});
		// Per-tool path: afterToolCall appends the injection entry AFTER the
		// assistant message that issued the call, before onTurnEnd advances
		// the live counter.
		sessionManager.appendMessage(userMessage("Remember A"));
		sessionManager.appendMessage(assistantMessage("OK A"));
		sessionManager.appendTtsrInjection(["per-tool-rule"]);
		sessionManager.appendMessage(userMessage("Remember B"));
		sessionManager.appendMessage(assistantMessage("OK B"));

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		expect(ttsrManager.getInjectedRuleNames()).toEqual(["per-tool-rule"]);
		// Restored branch: 1 assistant message, injection entry after it →
		// pre-turn-end position 0, counter 1, gap 1 ≥ repeatGap 1 → the
		// rule must be eligible right away. Counting the assistant message
		// itself (old behavior) put the position at 1 and made it wait one
		// extra model turn.
		expect(ttsrManager.getMessageCount()).toBe(1);
		expect(ttsrManager.checkSnapshot("payload PERTOOLMARK", { source: "text" }).length).toBeGreaterThan(0);
	});

	it("getUserTurns previews are sanitized and width-bounded", async () => {
		session = await makeSession();
		const wide = "漢".repeat(200);
		sessionManager.appendMessage(userMessage(`tab\there ${wide} \u001b[31mred\u001b[0m`));

		const turns = session.getUserTurns();
		expect(turns.length).toBe(1);
		const preview = turns[0]!.preview;
		expect(preview.includes("\t")).toBe(false);
		expect(preview.includes("\u001b")).toBe(false);
		expect(Bun.stringWidth(preview) <= 120).toBe(true);
	});

	it("getUserTurns reaches turns beyond the old fifty-turn window", async () => {
		session = await makeSession();
		for (let i = 0; i < 55; i++) {
			sessionManager.appendMessage(userMessage(`turn-${i}`));
		}
		const turns = session.getUserTurns();
		expect(turns.length).toBe(55);
		expect(turns[0]!.entryId).toBeDefined();
	});

	it("undo refuses while post-prompt work is pending", async () => {
		session = await makeSession();
		await seedThreeTurns();
		const { promise: pending, resolve: settle } = Promise.withResolvers<void>();
		session.trackPostPromptTaskForTests(pending);

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(false);
		expect(undo.error).toContain("post-prompt work");

		settle();
		// The tracked task removes itself in a .finally() microtask.
		await Bun.sleep(1);
		const after = await session.userUndo(1);
		expect(after.ok).toBe(true);
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

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		expect(undo.droppedTurns).toBe(1);
		const text = contextText(session);
		expect(text).toContain(SECRET_A);
		expect(text).not.toContain(SECRET_B);

		const branchEntries = sessionManager.getEntries().filter(entry => entry.type === "branch_summary");
		const marker = branchEntries.at(-1) as { details?: { droppedPrompts?: string } };
		expect(marker.details?.droppedPrompts).toContain(SECRET_B);
	});

	it("a persisted custom_message skill prompt counts as a user turn for /undo and /revert", async () => {
		session = await makeSession();
		sessionManager.appendMessage(userMessage(`Remember ${SECRET_A}`));
		sessionManager.appendMessage(assistantMessage("OK A"));
		// appendCustomMessageEntry is the persistence path real skill
		// invocations take (#persistMessageEnd): the journal entry is a
		// `custom_message` carrying customType/attribution directly, with no
		// message-role "custom" shape to match.
		sessionManager.appendCustomMessageEntry(
			"skill-prompt",
			[{ type: "text", text: `Run ${SECRET_B} now` }],
			false,
			undefined,
			"user",
		);
		sessionManager.appendMessage(assistantMessage("OK skill"));

		const turns = session.getUserTurns();
		expect(turns.length).toBe(2);
		expect(turns[1]!.preview).toContain(SECRET_B);

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		expect(undo.droppedTurns).toBe(1);
		const text = contextText(session);
		expect(text).toContain(SECRET_A);
		expect(text).not.toContain(SECRET_B);
	});

	it("undo rebuilds checkpoint state so a dropped-tail checkpoint cannot rewind it back", async () => {
		session = await makeSession();
		await seedThreeTurns();
		const droppedEntries = sessionManager.getBranch().slice(-2);
		const checkpointEntryId = droppedEntries[0]!.id;
		session.setCheckpointState({ checkpointMessageCount: 6, checkpointEntryId, startedAt: new Date().toISOString() });

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		// The kept branch carries no checkpoint entries, so rehydration from
		// the new branch clears the stale state instead of leaving it aimed
		// at an entry that just went off-branch.
		expect(session.getCheckpointState()).toBeUndefined();

		const redo = await session.userRedo();
		expect(redo.ok).toBe(true);
		expect(session.getCheckpointState()).toBeUndefined();
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

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		expect(session.getTodoPhases()).toEqual(phases);

		const redo = await session.userRedo();
		expect(redo.ok).toBe(true);
		expect(session.getTodoPhases()).toEqual(phases);
	});

	it("redo fails when no undo branch marker is on the active path", async () => {
		session = await makeSession();
		await seedThreeTurns();

		const redo = await session.userRedo();
		expect(redo.ok).toBe(false);
		expect(redo.error).toBeDefined();
	});

	it("undo and redo emit session_tree so journal-derived extensions resync", async () => {
		const treeEvents: Array<{ type: string; newLeafId?: string; oldLeafId?: string | null; summaryEntry?: unknown }> =
			[];
		const fakeRunner = {
			hasHandlers: (type: string) => type === "session_tree",
			emit: async (event: { type: string }) => {
				treeEvents.push(event);
				return {};
			},
		} as unknown as ExtensionRunner;
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		mockModel = mock;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth-tree-undo.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		sessionManager = SessionManager.create(tempDir, tempDir);
		await sessionManager.setSessionFile(path.join(tempDir, "tree-undo.jsonl"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ttsrManager: new TtsrManager(),
			extensionRunner: fakeRunner,
		});
		await seedThreeTurns();

		const preUndoLeaf = sessionManager.getLeafId();
		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		expect(treeEvents.length).toBe(1);
		const undoEvent = treeEvents[0]!;
		expect(undoEvent.type).toBe("session_tree");
		expect(undoEvent.oldLeafId).toBe(preUndoLeaf);
		expect(undoEvent.newLeafId).toBe(sessionManager.getLeafId() ?? undefined);
		const undoSummary = undoEvent.summaryEntry as { details?: { kind?: string } };
		expect(undoSummary.details?.kind).toBe("user-undo");

		const redo = await session.userRedo();
		expect(redo.ok).toBe(true);
		expect(treeEvents.length).toBe(2);
		const redoSummary = treeEvents[1]!.summaryEntry as { details?: { kind?: string } };
		expect(redoSummary.details?.kind).toBe("user-redo");
	});

	it("revert-to-entry drops everything after the chosen turn (partial revert)", async () => {
		session = await makeSession();
		await seedThreeTurns();

		const turns = session.getUserTurns();
		expect(turns.length).toBe(3);
		expect(turns[0]!.preview).toContain(SECRET_A);

		const result = await session.userUndoTo(turns[1]!.entryId);
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
		const result = await session.userUndoTo(turns[0]!.entryId);
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

		const result = await session.userUndoTo("does-not-exist");
		expect(result.ok).toBe(false);
		expect(result.error).toBeDefined();
	});

	it("undo with no user turns reports unavailable", async () => {
		session = await makeSession();
		const result = await session.userUndo();
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

		await session.userUndo(1);
		const after = session.getUserTurns();
		expect(after.length).toBe(2);
		expect(after[1]!.preview).toContain(SECRET_B);
	});

	it("dispose flushes a divergent journal before sealing", async () => {
		await makeFileBackedSession("dispose-flush.jsonl");
		await seedThreeTurns();
		const sessionFile = path.join(tempDir, "dispose-flush.jsonl");
		// Close any open writer fd so the append actually contends with the
		// journal lock instead of bypassing it.
		await sessionManager.rewriteEntries();

		const lock = tryAcquireFileLock(sessionFile);
		expect(lock?.acquired).toBe(true);
		try {
			expect(() => sessionManager.appendMessage(userMessage("locked-out"))).toThrow(SessionFileLockError);
		} finally {
			lock?.release();
		}
		expect(fs.readFileSync(sessionFile, "utf8")).not.toContain("locked-out");

		// Dispose seals the manager before close(); a sealed manager's atomic
		// rewrite is fenced off, so the flush must run BEFORE the seal or the
		// deferred entry never reaches disk.
		await session.dispose();
		expect(fs.readFileSync(sessionFile, "utf8")).toContain("locked-out");
	});

	it("undo rewinds past the turn's prompt-owned prelude messages", async () => {
		await makeFileBackedSession("prelude-undo.jsonl");
		const sessionFile = path.join(tempDir, "prelude-undo.jsonl");
		await seedThreeTurns();

		// A turn-owned prelude exactly as #promptWithMessage persists it:
		// custom_message entries immediately before the user message.
		sessionManager.appendCustomMessageEntry("ultrathink-notice", "hidden notice", false, undefined, "user");
		sessionManager.appendMessage(userMessage(`${SECRET_C}`));
		sessionManager.appendMessage(assistantMessage("OK C"));

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		// The hidden notice belonged to the undone turn: it must leave the
		// context with it, not linger as in-context residue.
		const onDisk = fs.readFileSync(sessionFile, "utf8");
		expect(onDisk).toContain("user-undo");
		const context = session.buildDisplaySessionContext();
		const noticeInContext = context.messages.some(
			message =>
				message.role === "custom" && (message as { customType?: string }).customType === "ultrathink-notice",
		);
		expect(noticeInContext).toBe(false);
	});

	it("a cancelling session_before_tree handler blocks undo and redo", async () => {
		const fakeRunner = {
			hasHandlers: (type: string) => type === "session_before_tree",
			emit: async () => ({ cancel: true }),
		} as unknown as ExtensionRunner;
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		mockModel = mock;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth-before-tree.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		sessionManager = SessionManager.create(tempDir, tempDir);
		await sessionManager.setSessionFile(path.join(tempDir, "before-tree.jsonl"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ttsrManager: new TtsrManager(),
			extensionRunner: fakeRunner,
		});
		await seedThreeTurns();

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(false);
		expect(undo.error).toContain("cancelled");
		// Nothing branched: the leaf is still the pre-attempt tip.
		expect(sessionManager.getBranch().at(-1)?.type).not.toBe("branch_summary");
	});

	it("undo keeps independent extension messages sent outside a turn", async () => {
		await makeFileBackedSession("extension-note-undo.jsonl");
		await seedThreeTurns();

		// An idle sendCustomMessage({ triggerTurn: false }) lands as a
		// custom_message immediately before the NEXT user turn, but it
		// predates the turn boundary and must survive /undo.
		sessionManager.appendCustomMessageEntry("extension-note", "independent notice", false, undefined, "agent");
		sessionManager.appendMessage(userMessage("fourth"));
		sessionManager.appendMessage(assistantMessage("OK fourth"));

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		const context = session.buildDisplaySessionContext();
		const noteInContext = context.messages.some(
			message => message.role === "custom" && (message as { customType?: string }).customType === "extension-note",
		);
		expect(noteInContext).toBe(true);
	});

	it("redo's session_before_tree preparation carries the real branch delta", async () => {
		const preparations: Array<{ targetId: string; commonAncestorId: string | null; entryCount: number }> = [];
		const fakeRunner = {
			hasHandlers: (type: string) => type === "session_before_tree",
			emit: async (event: {
				preparation?: { targetId: string; commonAncestorId: string | null; entriesToSummarize: unknown[] };
			}) => {
				if (event.preparation) {
					preparations.push({
						targetId: event.preparation.targetId,
						commonAncestorId: event.preparation.commonAncestorId,
						entryCount: event.preparation.entriesToSummarize.length,
					});
				}
				return {};
			},
		} as unknown as ExtensionRunner;
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		mockModel = mock;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth-redo-prep.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		sessionManager = SessionManager.create(tempDir, tempDir);
		await sessionManager.setSessionFile(path.join(tempDir, "redo-prep.jsonl"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ttsrManager: new TtsrManager(),
			extensionRunner: fakeRunner,
		});
		await seedThreeTurns();

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		const redo = await session.userRedo();
		expect(redo.ok).toBe(true);
		// The redo preparation (second event) must describe the entries being
		// abandoned (the undo marker plus trailing re-journaled controls),
		// not an empty delta.
		expect(preparations.length).toBe(2);
		expect(preparations[1]!.entryCount).toBeGreaterThan(0);
		expect(preparations[1]!.commonAncestorId).toBeDefined();
	});

	it("a contended undo still emits session_tree with the rollback marker", async () => {
		const treeEvents: Array<{ summaryEntry?: unknown }> = [];
		const fakeRunner = {
			hasHandlers: (type: string) => type === "session_tree",
			emit: async (event: { type: string; summaryEntry?: unknown }) => {
				treeEvents.push(event);
				return {};
			},
		} as unknown as ExtensionRunner;
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		mockModel = mock;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth-marker-recover.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		sessionManager = SessionManager.create(tempDir, tempDir);
		await sessionManager.setSessionFile(path.join(tempDir, "marker-recover.jsonl"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ttsrManager: new TtsrManager(),
			extensionRunner: fakeRunner,
		});
		await seedThreeTurns();
		await sessionManager.rewriteEntries();

		const lock = tryAcquireFileLock(path.join(tempDir, "marker-recover.jsonl"));
		expect(lock?.acquired).toBe(true);
		try {
			const undo = await session.userUndo(1);
			expect(undo.ok).toBe(true);
		} finally {
			lock?.release();
		}
		// The contended branchWithSummary threw before returning its id, but
		// the marker landed in memory: the event must still carry it.
		expect(treeEvents.length).toBe(1);
		const summary = treeEvents[0]!.summaryEntry as { details?: { kind?: string } } | undefined;
		expect(summary?.details?.kind).toBe("user-undo");
	});

	it("undo rewinds prelude entries carrying the persisted promptPrelude stamp", async () => {
		await makeFileBackedSession("prelude-stamp-undo.jsonl");
		await seedThreeTurns();

		// A plan-mode-context prelude stamped with persisted ownership —
		// exactly what #promptWithMessage now produces at persistence time —
		// belongs to the turn that follows it and must be rewound together
		// with that turn, even though its customType is not on the legacy
		// whitelist.
		sessionManager.appendCustomMessageEntry("plan-mode-context", "plan context A", false, {
			promptPrelude: true,
		});
		sessionManager.appendMessage(userMessage("fourth"));
		sessionManager.appendMessage(assistantMessage("OK fourth"));

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		const context = session.buildDisplaySessionContext();
		const preludeInContext = context.messages.some(
			message =>
				message.role === "custom" && (message as { customType?: string }).customType === "plan-mode-context",
		);
		expect(preludeInContext).toBe(false);
	});

	it("a root rollback preparation includes the first entry in the abandoned delta", async () => {
		const preparations: Array<{ targetId: string; commonAncestorId: string | null; entries: string[] }> = [];
		const fakeRunner = {
			hasHandlers: (type: string) => type === "session_before_tree",
			emit: async (event: {
				preparation?: { targetId: string; commonAncestorId: string | null; entriesToSummarize: { id: string }[] };
			}) => {
				if (event.preparation) {
					preparations.push({
						targetId: event.preparation.targetId,
						commonAncestorId: event.preparation.commonAncestorId,
						entries: event.preparation.entriesToSummarize.map(entry => entry.id),
					});
				}
				return {};
			},
		} as unknown as ExtensionRunner;
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		mockModel = mock;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, "auth-root-prep.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		sessionManager = SessionManager.create(tempDir, tempDir);
		await sessionManager.setSessionFile(path.join(tempDir, "root-prep.jsonl"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			ttsrManager: new TtsrManager(),
			extensionRunner: fakeRunner,
		});
		// Journal whose very first entry is a user turn: reverting to it
		// targets a point BEFORE that entry, so the anchor is null.
		await seedThreeTurns();
		const firstTurnId = sessionManager.getBranch()[0]!.id;
		expect(sessionManager.getBranch()[0]!.type).toBe("message");

		const revert = await session.userUndoTo(firstTurnId);
		expect(revert.ok).toBe(true);
		expect(preparations.length).toBe(1);
		expect(preparations[0]!.targetId).toBe("");
		// The whole old chain — first entry included — is abandoned, and
		// there is no common ancestor on the target branch.
		expect(preparations[0]!.commonAncestorId).toBeNull();
		expect(preparations[0]!.entries).toContain(firstTurnId);
	});

	it("undo and redo reconcile the announced-mount baseline for the replaced branch", async () => {
		await makeFileBackedSession("xdev-baseline.jsonl");
		await seedThreeTurns();
		// Journal an xdev mount notice on the branch being rolled back: after
		// the branch switch, the announced-mount baseline must re-seed from
		// the surviving transcript, not keep treating the notice as delivered.
		sessionManager.appendCustomMessageEntry("xdev-mount-notice", "mounted xd://demo", false, {
			added: ["demo"],
			removed: [],
			promptPrelude: true,
		});
		sessionManager.appendMessage(userMessage("fourth"));
		sessionManager.appendMessage(assistantMessage("OK fourth"));

		let reconciles = 0;
		const original = SessionTools.prototype.reconcileAnnouncedMounts;
		SessionTools.prototype.reconcileAnnouncedMounts = function (this: SessionTools) {
			reconciles++;
			return original.call(this);
		};
		try {
			const undo = await session.userUndo(1);
			expect(undo.ok).toBe(true);
			expect(reconciles).toBe(1);

			const redo = await session.userRedo();
			expect(redo.ok).toBe(true);
			expect(reconciles).toBe(2);
		} finally {
			SessionTools.prototype.reconcileAnnouncedMounts = original;
		}
	});

	it("reconcileAnnouncedMounts requeues rolled-back mount deltas", () => {
		const makeTools = (messages: unknown[], mountedNames: Iterable<string>) => {
			const toolRegistry = new Map();
			return new SessionTools(
				{
					model: () => undefined,
					agent: { state: { messages } },
					settings: Settings.isolated(),
				} as unknown as ConstructorParameters<typeof SessionTools>[0],
				{
					toolRegistry,
					xdev: {
						tools: toolRegistry,
						mountedNames: mountedNames instanceof Set ? mountedNames : new Set(mountedNames),
						builtInNames: new Set(),
					},
				} as unknown as ConstructorParameters<typeof SessionTools>[1],
			);
		};
		const notice = (details: { added: string[]; removed: string[] }) => ({
			role: "custom",
			customType: "xdev-mount-notice",
			content: "notice",
			display: false,
			details,
			attribution: "agent",
			timestamp: Date.now(),
		});

		// Rolled-back unmount: the surviving transcript still announces demo as
		// mounted, but the live mount set no longer has it — the removal must
		// be requeued so the next prompt re-delivers it.
		const unmounted = makeTools([notice({ added: ["demo"], removed: [] })], []);
		unmounted.reconcileAnnouncedMounts();
		const unmountNotice = unmounted.takePendingXdevMountNotice(true);
		expect(unmountNotice?.details?.removed).toContain("demo");

		// Rolled-back mount: the surviving transcript never learned about demo,
		// but the device is live — the mount must be requeued.
		const mounted = makeTools([], ["demo"]);
		mounted.reconcileAnnouncedMounts();
		const mountNotice = mounted.takePendingXdevMountNotice(true);
		expect(mountNotice?.details?.added).toContain("demo");

		// Same outcome when the transcript's last word was a removal notice:
		// the baseline (no demo announced) differs from the live set the same
		// way, so the requeue lands in pending.added rather than being treated
		// as a delivered unmount.
		const remounted = makeTools([notice({ added: [], removed: ["demo"] })], ["demo"]);
		remounted.reconcileAnnouncedMounts();
		const remountNotice = remounted.takePendingXdevMountNotice(true);
		expect(remountNotice?.details?.added).toContain("demo");

		// Consistent state: transcript matches live mounts — nothing requeued.
		const consistent = makeTools([notice({ added: ["demo"], removed: [] })], ["demo"]);
		consistent.reconcileAnnouncedMounts();
		expect(consistent.takePendingXdevMountNotice(true)).toBeUndefined();
		// Redo after undo: the undo requeued a mount for demo (the rewound
		// transcript lost the notice), then redo restored the notice — the
		// queued addition is now satisfied by the restored transcript and must
		// be cleared. Left in place it would later swallow a REAL removal: the
		// diff coalescing treats the queued add as an undelivered mount and
		// cancels the unmount the model should hear about.
		const redoMessages: unknown[] = [];
		const liveMounts = new Set(["demo"]);
		const redoCase = makeTools(redoMessages, liveMounts);
		redoCase.reconcileAnnouncedMounts();
		redoMessages.push(notice({ added: ["demo"], removed: [] }));
		redoCase.reconcileAnnouncedMounts();
		// The device later leaves: the restored transcript announced it, so a
		// removal notice must be delivered.
		liveMounts.delete("demo");
		redoCase.reconcileAnnouncedMounts();
		const removalNotice = redoCase.takePendingXdevMountNotice(true);
		expect(removalNotice?.details?.removed).toContain("demo");
	});

	it("collaborative guest prompts count as user turns for undo", async () => {
		await makeFileBackedSession("collab-guest-undo.jsonl");
		await seedThreeTurns();
		// Guest prompts persist as COLLAB_PROMPT_MESSAGE_TYPE custom_message
		// entries with user attribution (collab/host.ts promptCustomMessage).
		sessionManager.appendCustomMessageEntry(
			COLLAB_PROMPT_MESSAGE_TYPE,
			"guest asks a question",
			true,
			undefined,
			"user",
		);
		sessionManager.appendMessage(assistantMessage("OK guest"));

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		// Exactly the guest turn is dropped; the last LOCAL turn survives —
		// pre-fix the guest prompt was invisible to the turn walk, so the
		// anchor moved before the local turn and dropped both.
		const serialized = JSON.stringify(session.buildDisplaySessionContext().messages);
		expect(serialized).toContain(SECRET_C);
		expect(serialized).not.toContain("guest asks a question");
	});

	it("a guest-only journal still reports user turns", async () => {
		await makeFileBackedSession("collab-only-undo.jsonl");
		sessionManager.appendCustomMessageEntry(
			COLLAB_PROMPT_MESSAGE_TYPE,
			"first guest prompt",
			true,
			undefined,
			"user",
		);
		sessionManager.appendMessage(assistantMessage("OK one"));
		sessionManager.appendCustomMessageEntry(
			COLLAB_PROMPT_MESSAGE_TYPE,
			"second guest prompt",
			true,
			undefined,
			"user",
		);
		sessionManager.appendMessage(assistantMessage("OK two"));

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		expect(undo.droppedTurns).toBe(1);
		const serialized = JSON.stringify(session.buildDisplaySessionContext().messages);
		expect(serialized).toContain("first guest prompt");
		expect(serialized).not.toContain("second guest prompt");
	});
	it("agent-authored user-role messages are not user turns", async () => {
		await makeFileBackedSession("agent-steer-undo.jsonl");
		await seedThreeTurns();
		// Parent IRC steers / MCP notification batches ride the provider-facing
		// user role with agent attribution — internal context, not a turn.
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "internal steer notice" }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		sessionManager.appendMessage(assistantMessage("OK steer"));

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		// The operator's third turn is what got undone — the steer rode along
		// with it. Pre-fix the steer itself was the "turn", so SECRET_C stayed.
		const serialized = JSON.stringify(session.buildDisplaySessionContext().messages);
		expect(serialized).not.toContain(SECRET_C);
		expect(serialized).not.toContain("internal steer notice");
	});

	it("legacy unstamped prelude types rewind with their turn", async () => {
		await makeFileBackedSession("legacy-prelude-undo.jsonl");
		await seedThreeTurns();
		// A journal written before the promptPrelude stamp: plan-mode-reference
		// was already persisted immediately before its user turn.
		sessionManager.appendCustomMessageEntry("plan-mode-reference", "legacy plan reference", false);
		sessionManager.appendMessage(userMessage("fourth"));
		sessionManager.appendMessage(assistantMessage("OK fourth"));

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		const serialized = JSON.stringify(session.buildDisplaySessionContext().messages);
		expect(serialized).not.toContain("fourth");
		// display:false keeps the prelude out of the rendered context, so the
		// invariant lives on the branch: the anchor moved before the whole
		// prelude batch, leaving no stale plan reference on the active path.
		const preludeOnBranch = sessionManager
			.getBranch()
			.some(entry => entry.type === "custom_message" && entry.customType === "plan-mode-reference");
		expect(preludeOnBranch).toBe(false);
	});
	it("user-attributed custom prompts stamped userTurn count as turns", async () => {
		await makeFileBackedSession("ext-prompt-undo.jsonl");
		// An extension sendMessage({ customType, attribution: "user",
		// triggerTurn: true }) turn, persisted exactly as #promptWithMessage
		// now stamps it: details.userTurn on a user-attributed custom_message.
		sessionManager.appendCustomMessageEntry("my-prompt", "extension asks", true, { userTurn: true }, "user");
		sessionManager.appendMessage(assistantMessage("OK ext"));

		const undo = await session.userUndo(1);
		expect(undo.ok).toBe(true);
		expect(undo.droppedTurns).toBe(1);
		const serialized = JSON.stringify(session.buildDisplaySessionContext().messages);
		expect(serialized).not.toContain("extension asks");

		// Unstamped user-attributed custom context (deliverAs queue that never
		// triggered a turn) must NOT count as a turn: /undo 1 rewinds the
		// operator turn BEFORE it is... placed between turns, the note is
		// ordinary branch content and survives the rollback of the turn that
		// follows it.
		await makeFileBackedSession("ext-queue-undo.jsonl");
		sessionManager.appendMessage(userMessage(`Remember ${SECRET_A}`));
		sessionManager.appendMessage(assistantMessage("OK A"));
		sessionManager.appendCustomMessageEntry("my-note", "queued note", true, undefined, "user");
		sessionManager.appendMessage(userMessage(`Remember ${SECRET_B}`));
		sessionManager.appendMessage(assistantMessage("OK B"));
		const undoQueued = await session.userUndo(1);
		expect(undoQueued.ok).toBe(true);
		const queued = JSON.stringify(session.buildDisplaySessionContext().messages);
		expect(queued).not.toContain(SECRET_B);
		expect(queued).toContain("queued note");
	});
});
