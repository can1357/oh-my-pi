import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { toolExecutionId } from "@oh-my-pi/pi-agent-core/presentation";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionTeardown } from "@oh-my-pi/pi-coding-agent/modes/session-teardown";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	collectPendingToolCalls,
	createInterruptedTurnAbortMessage,
	describePendingToolCalls,
	SESSION_EXIT_CUSTOM_TYPE,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
	type ToolExecutionStartData,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

const pendingAssistant: AssistantMessage = {
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: "toolu_repro",
			name: "bash",
			arguments: { command: "bun run check:ts" },
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "mock",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: Date.now(),
};

describe("session exit diagnostics", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	it("records a durable tool start marker and shutdown diagnostic before a pending result exists", async () => {
		tempDir = TempDir.createSync("@pi-session-exit-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		agent.emitExternalEvent({ type: "message_end", message: pendingAssistant });
		await Promise.resolve();
		agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
		});
		await Promise.resolve();

		const marker = sessionManager
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === TOOL_EXECUTION_START_CUSTOM_TYPE);
		if (marker?.type !== "custom") throw new Error("Expected tool execution start marker");
		expect(marker.data).toMatchObject({
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
		});

		const pending = collectPendingToolCalls(sessionManager.getBranch());
		expect(pending).toMatchObject([
			{
				toolCallId: "toolu_repro",
				toolName: "bash",
				args: { command: "bun run check:ts" },
			},
		]);
		expect(describePendingToolCalls(sessionManager.getBranch())).toContain("bun run check:ts");

		await session.dispose();
		session = undefined;
		// dispose() released the in-memory transcript; the exit marker's contract
		// is durability, so assert against the persisted file.
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const reopened = await SessionManager.open(sessionFile, tempDir.path());
		const exitEntry = reopened
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
		await reopened.close();
		if (exitEntry?.type !== "custom") throw new Error("Expected session exit marker");
		expect(exitEntry.data).toMatchObject({
			reason: "dispose",
			kind: "normal",
			pendingToolCalls: [
				{
					toolCallId: "toolu_repro",
					toolName: "bash",
					args: { command: "bun run check:ts" },
				},
			],
		});
	});

	it("signal teardown persists the postmortem reason, not the generic dispose", async () => {
		tempDir = TempDir.createSync("@pi-session-exit-signal-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		const activeSession = session;

		// The assistant message persists through an async queue; the tool start
		// marker is appended synchronously and is what makes the session durable
		// enough for #recordSessionExit to write the exit entry (same setup as
		// the plain-dispose test above).
		agent.emitExternalEvent({ type: "message_end", message: pendingAssistant });
		await Promise.resolve();
		agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
		});
		await Promise.resolve();

		// Mirror InteractiveMode.init(): the postmortem "session-teardown"
		// callback runs FIRST on SIGTERM/SIGHUP/uncaughtException (reverse
		// registration order) and calls dispose(). Without reason threading,
		// #doDispose would persist the generic "dispose"/"normal" and cancel the
		// reason-specific agent-session recorder — losing the real trigger.
		const teardown = createSessionTeardown({
			getDraftText: () => "",
			beginDispose: () => activeSession.beginDispose(),
			saveDraft: async () => {},
			disposeSession: reason => activeSession.dispose({ reason }),
		});

		await teardown(postmortem.Reason.SIGTERM);
		session = undefined;

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const reopened = await SessionManager.open(sessionFile, tempDir.path());
		const exitEntry = reopened
			.getEntries()
			.find(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
		await reopened.close();
		if (exitEntry?.type !== "custom") throw new Error("Expected session exit marker");
		expect(exitEntry.data).toMatchObject({
			reason: "sigterm",
			kind: "signal",
		});
	});

	it("does not materialize an empty session just to write an exit marker", async () => {
		tempDir = TempDir.createSync("@pi-empty-session-exit-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent session file path");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		await session.dispose();
		session = undefined;

		expect(fs.existsSync(sessionFile)).toBe(false);
		expect(
			sessionManager
				.getEntries()
				.some(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE),
		).toBe(false);
	});

	it("treats assistant tool calls as pending even when stopReason is not toolUse", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ ...pendingAssistant, stopReason: "stop" });

		expect(collectPendingToolCalls(sessionManager.getBranch())).toMatchObject([
			{
				toolCallId: "toolu_repro",
				toolName: "bash",
				args: { command: "bun run check:ts" },
			},
		]);
		expect(describePendingToolCalls(sessionManager.getBranch())).toContain("bun run check:ts");
	});

	it("sources a pending presentation_events call's diagnostic from its v4 journal when the started record exists", () => {
		const sessionManager = SessionManager.inMemory();
		const journalToolCallId = "toolu_journal_9K2M";
		sessionManager.appendMessage({
			...pendingAssistant,
			content: [
				{
					type: "toolCall",
					id: journalToolCallId,
					name: "bash",
					arguments: { command: "STALE_ASSISTANT_ARG_9K2M" },
				},
			],
		});
		// The journal's `started` record carries a different tool name and raw
		// input than the assistant part above — proves the diagnostic is sourced
		// from the journal fold, not the assistant message/legacy marker.
		sessionManager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: toolExecutionId("exec-journal-9K2M"),
			call: {
				toolCallId: journalToolCallId,
				toolName: "bash_journal_sourced",
				title: "run JOURNAL_TITLE_9K2M",
				kind: "execute",
				rawInput: { command: "JOURNAL_RAW_INPUT_9K2M" },
			},
			presentation: { version: 1, facts: [] },
		});
		sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: journalToolCallId,
			toolName: "bash",
			args: { command: "STALE_ASSISTANT_ARG_9K2M" },
			startedAt: "2026-01-02T00:00:00.000Z",
		} satisfies ToolExecutionStartData);

		expect(collectPendingToolCalls(sessionManager.getBranch())).toMatchObject([
			{
				toolCallId: journalToolCallId,
				toolName: "bash_journal_sourced",
				args: { command: "JOURNAL_RAW_INPUT_9K2M" },
			},
		]);
	});

	it("sources the diagnostic from the journal even when its started record is written before the assistant message (write-order race)", () => {
		// AgentSession's real event handling can append the v4 journal `started`
		// entry (and the legacy marker) to the branch before the matching
		// assistant message's own persistence lands: `#recordToolExecutionStart`/
		// `#trackToolPresentation` write synchronously, ahead of their own
		// extension-delivery await, while the assistant message's persistence
		// is gated behind ITS OWN extension-delivery await plus a
		// cross-message-end serialization queue. This test builds that exact
		// branch order directly (journal entry appended first) to prove
		// `collectPendingToolCalls` does not depend on the assistant-message
		// having landed already.
		const sessionManager = SessionManager.inMemory();
		const raceToolCallId = "toolu_race_4P8L";
		sessionManager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: toolExecutionId("exec-race-4P8L"),
			call: {
				toolCallId: raceToolCallId,
				toolName: "bash_race_sourced",
				title: "run RACE_TITLE_4P8L",
				kind: "execute",
				rawInput: { command: "RACE_RAW_INPUT_4P8L" },
			},
			presentation: { version: 1, facts: [] },
		});
		sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: raceToolCallId,
			toolName: "bash",
			args: { command: "STALE_RACE_ASSISTANT_ARG_4P8L" },
			startedAt: "2026-01-03T00:00:00.000Z",
		} satisfies ToolExecutionStartData);
		sessionManager.appendMessage({
			...pendingAssistant,
			content: [
				{
					type: "toolCall",
					id: raceToolCallId,
					name: "bash",
					arguments: { command: "STALE_RACE_ASSISTANT_ARG_4P8L" },
				},
			],
		});

		expect(collectPendingToolCalls(sessionManager.getBranch())).toMatchObject([
			{
				toolCallId: raceToolCallId,
				toolName: "bash_race_sourced",
				args: { command: "RACE_RAW_INPUT_4P8L" },
			},
		]);
	});

	it("does not attribute an earlier journaled occurrence's descriptor to a pending tail occurrence of a recycled id with no journal coverage of its own", () => {
		// Mixed per-call protocol selection on a recycled toolCallId: occurrence A
		// runs on presentation_events (journaled, fully resolved), occurrence B
		// reuses the same id later but runs on legacy_snapshot (never journaled)
		// and is the one left pending. An unbounded journal scan would still find
		// A's `started` record — the only one that exists for this id — and must
		// NOT misattribute it to B; B's own legacy-marker values must survive.
		const recycledId = "toolu_recycled_mix_7K2N";
		const sessionManager = SessionManager.inMemory();

		// Occurrence A: journaled via presentation_events, fully resolved.
		sessionManager.appendMessage({
			...pendingAssistant,
			content: [
				{ type: "toolCall", id: recycledId, name: "bash", arguments: { command: "FIRST_OCCURRENCE_ARG_7K2N" } },
			],
		});
		sessionManager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: toolExecutionId("exec-mix-first-7K2N"),
			call: {
				toolCallId: recycledId,
				toolName: "bash_first_occurrence",
				title: "run FIRST_TITLE_7K2N",
				kind: "execute",
				rawInput: { command: "FIRST_RAW_INPUT_7K2N" },
			},
			presentation: { version: 1, facts: [] },
		});
		sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: recycledId,
			toolName: "bash",
			args: { command: "FIRST_OCCURRENCE_ARG_7K2N" },
			startedAt: "2026-02-01T00:00:00.000Z",
		} satisfies ToolExecutionStartData);
		sessionManager.appendToolExecutionSettled({
			recordVersion: 1,
			executionId: toolExecutionId("exec-mix-first-7K2N"),
			outcome: { kind: "succeeded" },
			presentation: { version: 1, facts: [], attachments: [] },
			modelProjection: { version: 1, content: [{ type: "text", text: "FIRST_OCCURRENCE_RESULT_7K2N" }] },
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: recycledId,
			toolName: "bash",
			content: [{ type: "text", text: "FIRST_OCCURRENCE_RESULT_7K2N" }],
			isError: false,
			timestamp: Date.now(),
		});

		// Occurrence B: the tail, same recycled id, legacy_snapshot — never journaled.
		sessionManager.appendMessage({
			...pendingAssistant,
			content: [
				{ type: "toolCall", id: recycledId, name: "bash", arguments: { command: "SECOND_OCCURRENCE_ARG_7K2N" } },
			],
		});
		sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: recycledId,
			toolName: "bash",
			args: { command: "SECOND_OCCURRENCE_ARG_7K2N" },
			startedAt: "2026-02-02T00:00:00.000Z",
			intent: "SECOND_OCCURRENCE_INTENT_7K2N",
		} satisfies ToolExecutionStartData);

		expect(collectPendingToolCalls(sessionManager.getBranch())).toMatchObject([
			{
				toolCallId: recycledId,
				toolName: "bash",
				args: { command: "SECOND_OCCURRENCE_ARG_7K2N" },
				startedAt: "2026-02-02T00:00:00.000Z",
				intent: "SECOND_OCCURRENCE_INTENT_7K2N",
			},
		]);
	});

	it("does not misattribute an earlier occurrence's journal descriptor when the pending tail occurrence's own assistant message has not yet persisted", () => {
		// A stricter variant of the mixed-protocol race above: occurrence A is
		// fully persisted AND journaled (marker + v4 started/settled). Occurrence
		// B reuses the same recycled toolCallId on legacy_snapshot; ITS marker is
		// present (written synchronously by `#recordToolExecutionStart`,
		// independent of message persistence), but B's own assistant message has
		// NOT reached disk yet — a `message_end` persistence lag, this time
		// landing between the marker and the transcript
		// rather than between the marker and the journal. A transcript-content-
		// based occurrence count would undercount B (0, since its assistant
		// message is absent) and wrongly see A's marker-count(1) == A's
		// journal-count(1) as "total" coverage, misattributing A's descriptor to
		// B. The marker-based count sees both markers (2) against A's lone
		// journal entry (1) — a mismatch — and correctly falls back to B's own
		// marker values.
		const recycledId = "toolu_recycled_lag_3W9V";
		const sessionManager = SessionManager.inMemory();

		// Occurrence A: fully persisted and journaled.
		sessionManager.appendMessage({
			...pendingAssistant,
			content: [{ type: "toolCall", id: recycledId, name: "bash", arguments: { command: "LAG_FIRST_ARG_3W9V" } }],
		});
		sessionManager.appendToolExecutionStarted({
			recordVersion: 1,
			executionId: toolExecutionId("exec-lag-first-3W9V"),
			call: {
				toolCallId: recycledId,
				toolName: "bash_lag_first_occurrence",
				title: "run LAG_FIRST_TITLE_3W9V",
				kind: "execute",
				rawInput: { command: "LAG_FIRST_RAW_INPUT_3W9V" },
			},
			presentation: { version: 1, facts: [] },
		});
		sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: recycledId,
			toolName: "bash",
			args: { command: "LAG_FIRST_ARG_3W9V" },
			startedAt: "2026-03-01T00:00:00.000Z",
		} satisfies ToolExecutionStartData);
		sessionManager.appendToolExecutionSettled({
			recordVersion: 1,
			executionId: toolExecutionId("exec-lag-first-3W9V"),
			outcome: { kind: "succeeded" },
			presentation: { version: 1, facts: [], attachments: [] },
			modelProjection: { version: 1, content: [{ type: "text", text: "LAG_FIRST_RESULT_3W9V" }] },
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: recycledId,
			toolName: "bash",
			content: [{ type: "text", text: "LAG_FIRST_RESULT_3W9V" }],
			isError: false,
			timestamp: Date.now(),
		});

		// Occurrence B: the tail, same recycled id, legacy_snapshot. Its marker
		// is present, but — unlike every other test in this file — its assistant
		// message is deliberately NOT appended, modeling the exact persistence
		// lag `#createMessageEndPersistenceSlot`'s extension-gated write can
		// leave behind at the moment a signal/dispose handler calls
		// `collectPendingToolCalls`.
		sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: recycledId,
			toolName: "bash",
			args: { command: "LAG_SECOND_ARG_3W9V" },
			startedAt: "2026-03-02T00:00:00.000Z",
			intent: "LAG_SECOND_INTENT_3W9V",
		} satisfies ToolExecutionStartData);

		expect(collectPendingToolCalls(sessionManager.getBranch())).toMatchObject([
			{
				toolCallId: recycledId,
				toolName: "bash",
				args: { command: "LAG_SECOND_ARG_3W9V" },
				startedAt: "2026-03-02T00:00:00.000Z",
				intent: "LAG_SECOND_INTENT_3W9V",
			},
		]);
	});

	it("falls back to the legacy marker scan for a legacy_snapshot call with no journal record", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
			startedAt: "2026-01-01T00:00:00.000Z",
			intent: "LEGACY_FALLBACK_INTENT_5Q3W",
		} satisfies ToolExecutionStartData);

		expect(collectPendingToolCalls(sessionManager.getBranch())).toMatchObject([
			{
				toolCallId: "toolu_repro",
				toolName: "bash",
				args: { command: "bun run check:ts" },
				startedAt: "2026-01-01T00:00:00.000Z",
				intent: "LEGACY_FALLBACK_INTENT_5Q3W",
			},
		]);
	});

	it("clears the pending warning once the matching tool result is recorded", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: "toolu_repro",
			toolName: "bash",
			args: { command: "bun run check:ts" },
			startedAt: new Date().toISOString(),
		} satisfies ToolExecutionStartData);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_repro",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.now(),
		});

		expect(collectPendingToolCalls(sessionManager.getBranch())).toEqual([]);
		expect(describePendingToolCalls(sessionManager.getBranch())).toBeUndefined();
	});

	it("reconstructs an abnormal process-exit tail as one terminal aborted assistant message", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_repro",
			toolName: "bash",
			content: [{ type: "text", text: "partial result stays in history" }],
			isError: false,
			timestamp: Date.now(),
		});
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		const recovered = createInterruptedTurnAbortMessage(sessionManager.getBranch());
		expect(recovered).toMatchObject({
			role: "assistant",
			content: [],
			api: pendingAssistant.api,
			provider: pendingAssistant.provider,
			model: pendingAssistant.model,
			stopReason: "aborted",
		});
		expect(recovered?.errorMessage).toContain("process exited");

		sessionManager.appendMessage(recovered!);
		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toBeUndefined();
		expect(
			sessionManager
				.buildSessionContext()
				.messages.some(
					message =>
						message.role === "toolResult" &&
						message.content.some(part => part.type === "text" && part.text === "partial result stays in history"),
				),
		).toBe(true);
	});

	it("reconstructs a normal exit that reports pending tool calls", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "manual exit",
			kind: "normal",
			recordedAt: "2026-07-11T02:20:08.800Z",
			pendingToolCalls: [{ toolCallId: "toolu_repro", toolName: "bash" }],
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
		});
	});

	it("ignores malformed pending tool diagnostics on normal exits", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "manual exit",
			kind: "normal",
			recordedAt: "2026-07-11T02:20:08.800Z",
			pendingToolCalls: "not an array",
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toBeUndefined();
	});

	it("reconstructs an interrupted assistant tool-call tail", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage(pendingAssistant);
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toMatchObject({
			role: "assistant",
			content: [],
			api: pendingAssistant.api,
			provider: pendingAssistant.provider,
			model: pendingAssistant.model,
			stopReason: "aborted",
		});
	});

	it("reconstructs tool-call content even when stopReason is stop", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage({ ...pendingAssistant, stopReason: "stop" });
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
		});
	});

	it("does not reconstruct a failed tool turn already closed by synthetic results", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendMessage({ ...pendingAssistant, stopReason: "error" });
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_repro",
			toolName: "bash",
			content: [{ type: "text", text: "Tool execution stopped after model failure." }],
			isError: true,
			timestamp: Date.now(),
		});
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		expect(createInterruptedTurnAbortMessage(sessionManager.getBranch())).toBeUndefined();
	});

	it("reconstructs a first user-message tail with selected model metadata", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		expect(
			createInterruptedTurnAbortMessage(sessionManager.getBranch(), {
				api: pendingAssistant.api,
				provider: pendingAssistant.provider,
				model: pendingAssistant.model,
			}),
		).toMatchObject({
			role: "assistant",
			api: pendingAssistant.api,
			provider: pendingAssistant.provider,
			model: pendingAssistant.model,
			stopReason: "aborted",
		});
	});

	it("does not reconstruct clean, completed, or superseded exits", () => {
		const normalExit = SessionManager.inMemory();
		normalExit.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		normalExit.appendMessage(pendingAssistant);
		normalExit.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "dispose",
			kind: "normal",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		const completedTurn = SessionManager.inMemory();
		completedTurn.appendMessage({ role: "user", content: "inspect the file", timestamp: Date.now() });
		completedTurn.appendMessage({
			...pendingAssistant,
			content: [{ type: "text", text: "done" }],
			stopReason: "stop",
		});
		completedTurn.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});

		const supersededExit = SessionManager.inMemory();
		supersededExit.appendMessage({ role: "user", content: "first turn", timestamp: Date.now() });
		supersededExit.appendMessage(pendingAssistant);
		supersededExit.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});
		supersededExit.appendMessage({ role: "user", content: "new turn", timestamp: Date.now() });

		expect(createInterruptedTurnAbortMessage(normalExit.getBranch())).toBeUndefined();
		expect(createInterruptedTurnAbortMessage(completedTurn.getBranch())).toBeUndefined();
		expect(createInterruptedTurnAbortMessage(supersededExit.getBranch())).toBeUndefined();
	});
});
