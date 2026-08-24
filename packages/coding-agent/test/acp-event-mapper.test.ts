import { beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentSideConnection, SessionNotification, ToolCallContent } from "@oh-my-pi/pi-utils/acp";

const arkSessionNotification = type({
	sessionId: "string",
	update: {
		sessionUpdate:
			"'agent_thought_chunk' | 'agent_message_chunk' | 'tool_call' | 'tool_call_update' | 'plan' | 'plan_update' | 'available_commands_update' | 'current_mode_update' | 'config_option_update' | 'session_info_update' | 'usage_update'",
	},
});

import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import {
	type AcpEventMapperOptions,
	buildToolCallStartUpdate,
	deliveredOverlap,
	mapAgentSessionEventToAcpSessionUpdates,
	normalizeReplayToolArguments,
} from "@oh-my-pi/pi-coding-agent/modes/acp/acp-event-mapper";
import {
	checkAcpUpdateInvariants,
	EvalSourceDeliveryAuditor,
} from "@oh-my-pi/pi-coding-agent/modes/acp/acp-update-invariants";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { formatOutputNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { frameTexts, producerFacts } from "./helpers/acp-producer-facts";
import { expectAcpStructure, expectAcpStructureRejects } from "./helpers/acp-schema";

/**
 * Every mapper call in this suite goes through here so the wire-level
 * invariants (`checkAcpUpdateInvariants`) are checked on the
 * frames this suite builds. The production chokepoint (`AcpAgent#sendUpdate`)
 * sits one layer above the mapper, so without this wrapper the bulk of ACP
 * frame coverage — every test that calls the mapper directly — validated only
 * against the ACP JSON schema, which by design says nothing about Zed's
 * renderer rules. That gap is how a `[terminal, text]` frame shipped before
 * the guard that rejects it existed.
 *
 * The capability context is the mapper's own options, so a test can never
 * assert one negotiation state while the check assumes another.
 *
 * Also runs `evalSourceAuditor` (rule 13) over the same frames: a per-frame
 * check has no notion of "the call this frame belongs to", so it cannot
 * catch a sequence that never once delivers an eval call's own source — the
 * bug class — it has a sibling in the eval-image fallback. Reset per test
 * in `beforeEach` below so ids reused across tests (`"tc-1"`, etc.) never
 * leak state between them.
 */
let evalSourceAuditor = new EvalSourceDeliveryAuditor();
beforeEach(() => {
	evalSourceAuditor = new EvalSourceDeliveryAuditor();
});

/**
 * `checkAcpUpdateInvariants`/`EvalSourceDeliveryAuditor` check frame *shape*
 * and the eval *source* respectively; neither has any notion of "did every
 * fact the producer recorded structurally survive onto this frame" — the
 * general form of the artifact-pointer/notice losses (rule 12/15). Running
 * `producerFacts`/`frameTexts` here, on every `tool_execution_end` this ~90
 * test suite builds, is what the matrix in `acp-producer-wire.test.ts`
 * cannot do by itself: that matrix's own fixtures are real producer results,
 * but no row produces both an image and a details-only fact, so the axis
 * this check exists for had zero coverage there. This suite's fixtures are
 * hand-fabricated, so they *can* combine any shape — the fact-delivery
 * check is only meaningful when a fixture actually declares a fact, which
 * is why the new regression tests
 * for this finding set `details.notice`/`errorMessage` explicitly instead of
 * relying on this generic check to invent one.
 */
function mapUpdates(
	event: AgentSessionEvent,
	sessionId: string,
	options: AcpEventMapperOptions = {},
): SessionNotification[] {
	if ("toolName" in event && "toolCallId" in event) {
		const args = "args" in event ? event.args : options.getToolArgs?.(event.toolCallId);
		evalSourceAuditor.expect(event.toolCallId, event.toolName, args);
	}
	const updates = mapAgentSessionEventToAcpSessionUpdates(event, sessionId, options);
	const context = { terminalMetaCapable: options.terminalMetaCapable === true };
	for (const update of updates) {
		expect(checkAcpUpdateInvariants(update, context)).toEqual([]);
		expect(evalSourceAuditor.observe(update)).toEqual([]);
	}
	if (event.type === "tool_execution_end") {
		const facts = producerFacts(event.result);
		if (facts.length > 0) {
			const texts = updates
				.flatMap(({ update }) => frameTexts(update as unknown as Record<string, unknown>))
				.join("\n");
			for (const fact of facts) {
				expect(texts).toContain(fact);
			}
		}
	}
	return updates;
}

function makeAssistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-20250514",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function getChunkMessageId(event: { update: object }): string | undefined {
	const update = event.update as { messageId?: string | null };
	return typeof update.messageId === "string" ? update.messageId : undefined;
}

function expectAcpNotifications(updates: SessionNotification[]): void {
	for (const update of updates) {
		expectAcpStructure(arkSessionNotification, update);
	}
}

const TEST_MODEL: Model = buildModel({
	id: "claude-sonnet-4-20250514",
	name: "Claude Sonnet",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

class ReplayTestSession {
	sessionManager: SessionManager;
	sessionId: string;
	model: Model | undefined = TEST_MODEL;
	thinkingLevel: string | undefined;
	customCommands: [] = [];
	skills: [] = [];
	extensionRunner = undefined;
	settings = { get: (_key: string) => false };

	constructor(cwd: string, sessionDir?: string) {
		this.sessionManager = SessionManager.create(cwd, sessionDir);
		this.sessionId = this.sessionManager.getSessionId();
	}

	getAvailableModels(): Model[] {
		return [TEST_MODEL];
	}

	getAvailableThinkingLevels(): ReadonlyArray<string> {
		return [];
	}

	getPlanModeState(): undefined {
		return undefined;
	}

	setClientBridge(_bridge: unknown): void {}

	subscribe(_listener: (event: AgentSessionEvent) => void): () => void {
		return () => {};
	}

	async refreshMCPTools(_tools: unknown): Promise<void> {}

	buildTranscriptSessionContext(options?: { keepDanglingToolCalls?: boolean; collapseCompactedHistory?: boolean }) {
		return this.sessionManager.buildSessionContext({ transcript: true, ...options });
	}
}

describe("ACP event mapper", () => {
	it("attaches a stable messageId to live assistant chunks", () => {
		const assistantMessage = makeAssistantMessage("chunk");
		const getMessageId = (message: unknown): string | undefined =>
			message === assistantMessage ? "a80f1ff7-4f0a-4e6b-9f09-c94857b62a4a" : undefined;

		const textUpdates = mapUpdates(
			{
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "text_delta", delta: "chunk" },
			} as AgentSessionEvent,
			"session-1",
			{ getMessageId },
		);
		const thoughtUpdates = mapUpdates(
			{
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "thinking_delta", delta: "plan" },
			} as AgentSessionEvent,
			"session-1",
			{ getMessageId },
		);

		expect(textUpdates).toHaveLength(1);
		expect(thoughtUpdates).toHaveLength(1);
		expectAcpNotifications([...textUpdates, ...thoughtUpdates]);
		expect(textUpdates[0] ? getChunkMessageId(textUpdates[0]) : undefined).toBe(
			"a80f1ff7-4f0a-4e6b-9f09-c94857b62a4a",
		);
		expect(thoughtUpdates[0] ? getChunkMessageId(thoughtUpdates[0]) : undefined).toBe(
			"a80f1ff7-4f0a-4e6b-9f09-c94857b62a4a",
		);
	});

	it("emits final assistant text when no text deltas were observed", () => {
		const assistantMessage = makeAssistantMessage("final response");
		const progress = { textEmitted: false, thoughtEmitted: false };

		const updates = mapUpdates(
			{
				type: "message_end",
				message: assistantMessage,
			} as AgentSessionEvent,
			"session-1",
			{ getMessageProgress: message => (message === assistantMessage ? progress : undefined) },
		);

		expect(updates).toEqual([
			{
				sessionId: "session-1",
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "final response" },
					messageId: undefined,
				},
			},
		]);
		expectAcpNotifications(updates);
		expect(progress.textEmitted).toBe(true);
	});

	it("does not duplicate final assistant text after streaming deltas", () => {
		const assistantMessage = makeAssistantMessage("streamed response");
		const progress = { textEmitted: false, thoughtEmitted: false };
		const options = {
			getMessageProgress: (message: unknown) => (message === assistantMessage ? progress : undefined),
		};

		const deltaUpdates = mapUpdates(
			{
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "text_delta", delta: "streamed response" },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const doneUpdates = mapUpdates(
			{
				type: "message_end",
				message: assistantMessage,
			} as AgentSessionEvent,
			"session-1",
			options,
		);

		expect(deltaUpdates).toHaveLength(1);
		expectAcpNotifications(deltaUpdates);
		expect(doneUpdates).toEqual([]);
	});

	it("shows the command as the title without duplicating it in content", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-command-start",
				toolName: "bash",
				args: { command: "npm run check" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { sessionUpdate: string; title: string; content?: unknown };
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.title).toBe("npm run check");
		expect("content" in update).toBe(false);
	});

	it("keeps internal Hub traffic off the ACP session stream", () => {
		const events: AgentSessionEvent[] = [
			{
				type: "tool_execution_start",
				toolCallId: "tc-hub-send",
				toolName: "hub",
				args: { op: "send", to: "Scout", message: "Private coordination" },
			},
			{
				type: "tool_execution_update",
				toolCallId: "tc-hub-send",
				toolName: "hub",
				args: { op: "send", to: "Scout", message: "Private coordination" },
				partialResult: { content: [{ type: "text", text: "delivering" }] },
			},
			{
				type: "tool_execution_end",
				toolCallId: "tc-hub-send",
				toolName: "hub",
				isError: false,
				result: { content: [{ type: "text", text: "delivered" }] },
			},
		] satisfies AgentSessionEvent[];

		const updates = events.flatMap(event =>
			mapUpdates(event, "session-1", {
				getToolArgs: () => ({ op: "send", to: "Scout", message: "Private coordination" }),
			}),
		);

		expect(updates).toEqual([]);
	});

	it("keeps xd-routed Hub traffic off the ACP session stream", () => {
		const args = {
			path: "xd://hub",
			content: JSON.stringify({ op: "inbox", from: "Scout" }),
		};
		const events = [
			{
				type: "tool_execution_start",
				toolCallId: "tc-xd-hub-inbox",
				toolName: "write",
				args,
			},
			{
				type: "tool_execution_end",
				toolCallId: "tc-xd-hub-inbox",
				toolName: "write",
				isError: false,
				result: { content: [{ type: "text", text: "Private reply" }] },
			},
		] satisfies AgentSessionEvent[];

		const updates = events.flatMap(event =>
			mapUpdates(event, "session-1", {
				getToolArgs: () => args,
			}),
		);

		expect(updates).toEqual([]);
	});

	it("keeps Hub process control visible over ACP", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-hub-process-send",
				toolName: "hub",
				args: { op: "send", name: "server", text: "ping" },
			},
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expect(updates[0]?.update).toEqual(
			expect.objectContaining({
				sessionUpdate: "tool_call",
				rawInput: { op: "send", name: "server", text: "ping" },
			}),
		);
	});

	it("keeps background job-wait results visible over ACP", () => {
		const events = [
			{
				type: "tool_execution_start",
				toolCallId: "tc-hub-job-wait",
				toolName: "hub",
				args: { op: "wait", ids: ["bash_a1b2c3"] },
			},
			{
				type: "tool_execution_end",
				toolCallId: "tc-hub-job-wait",
				toolName: "hub",
				isError: false,
				result: { content: [{ type: "text", text: "job output" }] },
			},
		] satisfies AgentSessionEvent[];

		const updates = events.flatMap(event =>
			mapUpdates(event, "session-1", {
				getToolArgs: () => ({ op: "wait", ids: ["bash_a1b2c3"] }),
			}),
		);

		expect(updates.map(update => update.update.sessionUpdate)).toEqual(["tool_call", "tool_call_update"]);
	});

	it("keeps a bare Hub wait visible so job deliveries reach ACP", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-hub-bare-wait",
				toolName: "hub",
				args: { op: "wait" },
			},
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expect(updates[0]?.update.sessionUpdate).toBe("tool_call");
	});

	it("hides a peer-scoped Hub wait from ACP", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-hub-peer-wait",
				toolName: "hub",
				args: { op: "wait", from: "Scout" },
			},
			"session-1",
		);

		expect(updates).toEqual([]);
	});

	it("uses raw command text for the title even when intent is generic", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-command-start-generic-intent",
				toolName: "bash",
				args: { command: "echo hi" },
				intent: "Running command",
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { title: string; content?: unknown };
		expect(update.title).toBe("echo hi");
		expect("content" in update).toBe(false);
	});

	it("preserves eval source when a new eval tool is started", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-eval-start",
				toolName: "eval",
				args: { language: "js", title: "sum", code: "return 1 + 1;" },
				intent: "sum",
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			title: string;
			kind?: string;
			status?: string;
			rawInput?: unknown;
			content?: Array<{ type: string; content?: { type: string; text?: string } }>;
		};
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.title).toBe("[js] sum");
		expect(update.kind).toBe("execute");
		expect(update.status).toBe("pending");
		expect(update.rawInput).toEqual({ language: "js", title: "sum", code: "return 1 + 1;" });
		expect(update.content).toContainEqual({
			type: "content",
			content: { type: "text", text: "[js] sum\nreturn 1 + 1;" },
		});
	});

	it("builds eval source content from valid cells only", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-eval-mixed-cells",
				toolName: "eval",
				args: {
					cells: [null, {}, { code: "" }, { code: "x" }, { language: "py", code: "y" }],
				},
				intent: "evaluating",
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			title: string;
			content?: Array<{ type: string; content?: { type: string; text?: string } }>;
		};
		expect(update.title).toBe("[?], [py]");
		expect(update.content).toEqual([{ type: "content", content: { type: "text", text: "[?]\nx\n[py]\ny" } }]);
	});

	it("limits eval source before emitting visible tool-call content, keeping the title short", () => {
		const source = "x".repeat(4_100);
		const updates = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-eval-long-source",
				toolName: "eval",
				args: { language: "js", code: source },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			title: string;
			content?: Array<{ type: string; content?: { type: string; text?: string } }>;
		};
		// The title has no cell title to draw on, so it stays a short language
		// tag — the huge code body lives only in the (collapsible) content.
		expect(update.title).toBe("[js]");
		const contentText = update.content?.[0]?.content?.text;
		expect(contentText).toHaveLength(4_000);
		expect(contentText?.endsWith("…")).toBe(true);
	});
	it("emits a diff ToolCallContent for each per-file edit result", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-1",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "applied" }],
					details: {
						diff: "--- a/foo\n+++ b/foo\n",
						perFileResults: [
							{ path: "foo.ts", diff: "...", oldText: "before\n", newText: "after\n" },
							{ path: "bar.ts", diff: "...", oldText: undefined, newText: "created\n" },
							{ path: "skipped.ts", diff: "", isError: true, errorText: "boom" },
						],
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; path?: string; oldText?: string | null; newText?: string }>;
			locations?: { path: string }[];
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		const diffBlocks = update.content?.filter(block => block.type === "diff") ?? [];
		expect(diffBlocks).toEqual([
			{ type: "diff", path: "foo.ts", oldText: "before\n", newText: "after\n" },
			{ type: "diff", path: "bar.ts", oldText: null, newText: "created\n" },
		]);
		expect(update.locations).toEqual([{ path: "foo.ts" }, { path: "bar.ts" }, { path: "skipped.ts" }]);
	});

	it("names successfully-edited files whose snapshot was pruned instead of dropping them", () => {
		// Regression test: when a multi-file edit's aggregate snapshot budget
		// runs out, a later successful entry can lose oldText/newText
		// (snapshotsPruned: true) with no diff of its own. Without a fallback,
		// the `diffContent.length > 0` branch renders only the entries that
		// still have a diff and the pruned file vanishes from ACP content
		// entirely, even though it was edited successfully.
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-pruned",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "Updated a.ts\nUpdated b.ts" }],
					details: {
						perFileResults: [
							{ path: "a.ts", diff: "...", oldText: "before-a\n", newText: "after-a\n" },
							{ path: "b.ts", diff: "...", snapshotsPruned: true },
						],
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{
				type: string;
				path?: string;
				oldText?: string | null;
				newText?: string;
				content?: { type: string; text?: string };
			}>;
		};
		const diffBlocks = update.content?.filter(block => block.type === "diff") ?? [];
		expect(diffBlocks).toEqual([{ type: "diff", path: "a.ts", oldText: "before-a\n", newText: "after-a\n" }]);
		const textBlocks = update.content?.filter(block => block.type === "content") ?? [];
		expect(textBlocks).toHaveLength(1);
		expect(textBlocks[0]?.content?.text).toBe("```\nAlso applied (diff omitted: file snapshot too large): b.ts\n```");
	});

	it("names successfully-edited files whose snapshot was pruned even on a partial failure", () => {
		// Regression test: the fix
		// above only reached the `!event.isError` success branch —
		// `extractPrunedEditPathsText` was never called from the `event.isError`
		// branch, so a successfully-edited-but-pruned file disappeared from the
		// card whenever the same multi-file edit also had an unrelated failure.
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-pruned-partial-fail",
				toolName: "edit",
				isError: true,
				result: {
					content: [{ type: "text", text: "Updated a.ts\nUpdated b.ts\nError editing c.ts: boom" }],
					details: {
						perFileResults: [
							{ path: "a.ts", diff: "...", oldText: "before-a\n", newText: "after-a\n" },
							{ path: "b.ts", diff: "...", snapshotsPruned: true },
							{ path: "c.ts", diff: "", isError: true, errorText: "boom" },
						],
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		const update = updates[0]!.update as {
			content?: Array<{
				type: string;
				path?: string;
				oldText?: string | null;
				newText?: string;
				content?: { type: string; text?: string };
			}>;
		};
		const diffBlocks = update.content?.filter(block => block.type === "diff") ?? [];
		expect(diffBlocks).toEqual([{ type: "diff", path: "a.ts", oldText: "before-a\n", newText: "after-a\n" }]);
		const textBlocks = update.content?.filter(block => block.type === "content") ?? [];
		expect(textBlocks).toHaveLength(1);
		expect(textBlocks[0]?.content?.text).toBe(
			"```\nAlso applied (diff omitted: file snapshot too large): b.ts\n\nError editing c.ts: boom\n```",
		);
	});

	it("preserves LSP diagnostics alongside a successful edit's diff", () => {
		// Regression test: edit tools
		// route through `wrapToolWithMetaNotice`, which appends a rendered
		// "LSP Diagnostics (...)" notice onto the tool's own text content from
		// `details.meta.diagnostics`. The diff-present success branch discarded
		// the whole content array in favor of the diff, taking that notice
		// down with it whenever there was nothing to prune. Diagnostics on a
		// successful edit must survive next to the diff.
		const meta = { diagnostics: { summary: "1 warning", messages: ["a.ts:3: unused import"] } };
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-diagnostics",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "Updated a.ts" }],
					details: {
						perFileResults: [{ path: "a.ts", diff: "...", oldText: "before-a\n", newText: "after-a\n" }],
						meta,
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{
				type: string;
				path?: string;
				oldText?: string | null;
				newText?: string;
				content?: { type: string; text?: string };
			}>;
		};
		const diffBlocks = update.content?.filter(block => block.type === "diff") ?? [];
		expect(diffBlocks).toEqual([{ type: "diff", path: "a.ts", oldText: "before-a\n", newText: "after-a\n" }]);
		const textBlocks = update.content?.filter(block => block.type === "content") ?? [];
		expect(textBlocks).toHaveLength(1);
		expect(textBlocks[0]?.content?.text).toBe(`\`\`\`\n${formatOutputNotice(meta).trim()}\n\`\`\``);
	});

	it("preserves per-file LSP diagnostics for a multi-file edit with no top-level aggregate meta", () => {
		// Regression test:
		// `executeApplyPatchPerFile`'s multi-file aggregate has no top-level
		// `details.meta` at all — each file's own `meta` (with its own
		// diagnostics) lives only in `details.perFileResults[].meta`
		// (`edit/index.ts`). `extractOutputNoticeText` only read the aggregate
		// `details.meta`, so per-file diagnostics silently disappeared for
		// every successful or partially-failed multi-file edit.
		const metaA = { diagnostics: { summary: "1 warning", messages: ["a.ts:3: unused import"] } };
		const metaB = { diagnostics: { summary: "1 error", messages: ["b.ts:5: undefined name"] } };
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-multi-file-diagnostics",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "Updated a.ts\nUpdated b.ts" }],
					details: {
						perFileResults: [
							{ path: "a.ts", diff: "...", oldText: "before-a\n", newText: "after-a\n", meta: metaA },
							{ path: "b.ts", diff: "...", oldText: "before-b\n", newText: "after-b\n", meta: metaB },
						],
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{
				type: string;
				path?: string;
				oldText?: string | null;
				newText?: string;
				content?: { type: string; text?: string };
			}>;
		};
		const diffBlocks = update.content?.filter(block => block.type === "diff") ?? [];
		expect(diffBlocks).toEqual([
			{ type: "diff", path: "a.ts", oldText: "before-a\n", newText: "after-a\n" },
			{ type: "diff", path: "b.ts", oldText: "before-b\n", newText: "after-b\n" },
		]);
		const textBlocks = update.content?.filter(block => block.type === "content") ?? [];
		expect(textBlocks).toHaveLength(1);
		expect(textBlocks[0]?.content?.text).toBe(
			`\`\`\`\na.ts: ${formatOutputNotice(metaA).trim()}\n\nb.ts: ${formatOutputNotice(metaB).trim()}\n\`\`\``,
		);
	});

	it("preserves file attribution when diagnostics text is identical", () => {
		const meta = { diagnostics: { summary: "1 warning", messages: ["unused import"] } };
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-duplicate-diagnostics",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "Updated a.ts\nUpdated b.ts" }],
					details: {
						perFileResults: [
							{ path: "a.ts", oldText: "before-a", newText: "after-a", meta },
							{ path: "b.ts", oldText: "before-b", newText: "after-b", meta },
						],
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		const update = updates[0]!.update as {
			content?: Array<{ type: string; content?: { type: string; text?: string } }>;
		};
		const notice = update.content?.find(block => block.type === "content")?.content?.text;
		expect(notice).toContain(`a.ts: ${formatOutputNotice(meta).trim()}`);
		expect(notice).toContain(`b.ts: ${formatOutputNotice(meta).trim()}`);
	});

	it("preserves LSP diagnostics alongside a partially-failed edit's per-file failure text", () => {
		// Same discard, mirrored for the error branch: `extractEditFailureText`
		// reads only `perFileResults`, so a diagnostics notice attached to the
		// same result was dropped there too whenever there were per-file errors
		// to report (the `extractReadableText` fallback path already included
		// it, but that path is skipped once failure text exists).
		const meta = { diagnostics: { summary: "1 warning", messages: ["a.ts:3: unused import"] } };
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-diagnostics-failure",
				toolName: "edit",
				isError: true,
				result: {
					content: [{ type: "text", text: "Updated a.ts" }],
					details: {
						perFileResults: [
							{ path: "a.ts", diff: "...", oldText: "before-a\n", newText: "after-a\n" },
							{ path: "b.ts", isError: true, errorText: "boom" },
						],
						meta,
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{
				type: string;
				path?: string;
				oldText?: string | null;
				newText?: string;
				content?: { type: string; text?: string };
			}>;
		};
		const diffBlocks = update.content?.filter(block => block.type === "diff") ?? [];
		expect(diffBlocks).toEqual([{ type: "diff", path: "a.ts", oldText: "before-a\n", newText: "after-a\n" }]);
		const textBlocks = update.content?.filter(block => block.type === "content") ?? [];
		expect(textBlocks).toHaveLength(1);
		expect(textBlocks[0]?.content?.text).toBe(
			`\`\`\`\nError editing b.ts: boom\n\n${formatOutputNotice(meta).trim()}\n\`\`\``,
		);
	});

	it("shows only diffs when every successful entry still has one, even with an unrelated pruned+errored entry", () => {
		// snapshotsPruned entries that also failed (isError) are covered by the
		// error-branch's own failure text, not this note — an entry can't be
		// both a silent success and a reported failure.
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-pruned-error",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "Updated a.ts" }],
					details: {
						perFileResults: [
							{ path: "a.ts", diff: "...", oldText: "before-a\n", newText: "after-a\n" },
							{ path: "b.ts", isError: true, snapshotsPruned: true, errorText: "boom" },
						],
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);
		const update = updates[0]!.update as {
			content?: Array<{ type: string; path?: string; oldText?: string | null; newText?: string }>;
		};
		expect(update.content).toEqual([{ type: "diff", path: "a.ts", oldText: "before-a\n", newText: "after-a\n" }]);
	});

	it("emits a diff ToolCallContent for single-file edit details", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-single",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "applied" }],
					details: {
						path: "single.ts",
						diff: "--- a/single.ts\n+++ b/single.ts\n",
						oldText: "before\n",
						newText: "after\n",
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; path?: string; oldText?: string | null; newText?: string }>;
			locations?: { path: string }[];
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content?.filter(block => block.type === "diff")).toEqual([
			{ type: "diff", path: "single.ts", oldText: "before\n", newText: "after\n" },
		]);
		expect(update.locations).toEqual([{ path: "single.ts" }]);
	});

	it("drops the redundant text echo when a successful edit already has a diff", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-edit-no-echo",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "applied" }],
					details: { path: "single.ts", oldText: "before\n", newText: "after\n" },
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{ type: string; path?: string; oldText?: string | null; newText?: string }>;
		};
		expect(update.content).toEqual([{ type: "diff", path: "single.ts", oldText: "before\n", newText: "after\n" }]);
	});

	it("keeps the text content when a partially-failed edit has no diff for the failed file", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-edit-partial-fail",
				toolName: "edit",
				isError: true,
				result: {
					content: [{ type: "text", text: "Error editing skipped.ts: boom" }],
					details: {
						perFileResults: [
							{ path: "foo.ts", diff: "...", oldText: "before\n", newText: "after\n" },
							{ path: "skipped.ts", diff: "", isError: true, errorText: "boom" },
						],
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{
				type: string;
				path?: string;
				oldText?: string | null;
				newText?: string;
				content?: unknown;
			}>;
		};
		expect(update.content).toContainEqual({ type: "diff", path: "foo.ts", oldText: "before\n", newText: "after\n" });
		expect(update.content).toContainEqual({
			type: "content",
			content: { type: "text", text: "```\nError editing skipped.ts: boom\n```" },
		});
	});

	it("does not duplicate a succeeded file's diff with its own ack text when a later file in the same edit fails", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-edit-partial-fail-multi-success",
				toolName: "edit",
				isError: true,
				result: {
					// Mirrors `executeApplyPatchPerFile`'s real joined text: every
					// succeeded file's own ack line, followed by the failure.
					content: [
						{
							type: "text",
							text: "Updated foo.ts\nUpdated bar.ts\nError editing skipped.ts: boom\nFiles already applied: foo.ts, bar.ts.",
						},
					],
					details: {
						perFileResults: [
							{ path: "foo.ts", diff: "...", oldText: "before-foo\n", newText: "after-foo\n" },
							{ path: "bar.ts", diff: "...", oldText: "before-bar\n", newText: "after-bar\n" },
							{ path: "skipped.ts", diff: "", isError: true, errorText: "boom" },
						],
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{
				type: string;
				path?: string;
				oldText?: string | null;
				newText?: string;
				content?: { type: string; text?: string };
			}>;
		};
		expect(update.content).toContainEqual({
			type: "diff",
			path: "foo.ts",
			oldText: "before-foo\n",
			newText: "after-foo\n",
		});
		expect(update.content).toContainEqual({
			type: "diff",
			path: "bar.ts",
			oldText: "before-bar\n",
			newText: "after-bar\n",
		});
		const textBlocks = update.content?.filter(block => block.type === "content") ?? [];
		expect(textBlocks).toHaveLength(1);
		expect(textBlocks[0]?.content?.text).toBe("```\nError editing skipped.ts: boom\n```");
		// Neither succeeded file's own ack line should reappear alongside its diff.
		expect(textBlocks[0]?.content?.text).not.toContain("Updated foo.ts");
		expect(textBlocks[0]?.content?.text).not.toContain("Updated bar.ts");
	});

	it("keeps 'Files NOT applied' guidance for files never attempted after an earlier failure", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-edit-partial-fail-unattempted",
				toolName: "edit",
				isError: true,
				result: {
					content: [
						{
							type: "text",
							text: "Updated foo.ts\nError editing skipped.ts: boom\nFiles already applied: foo.ts.\nFiles NOT applied: never.ts; re-read the affected files and re-issue only the failed and unapplied files.",
						},
					],
					details: {
						perFileResults: [
							{ path: "foo.ts", diff: "...", oldText: "before-foo\n", newText: "after-foo\n" },
							{ path: "skipped.ts", diff: "", isError: true, errorText: "boom" },
						],
						unattemptedPaths: ["never.ts"],
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		const update = updates[0]!.update as {
			content?: Array<{ type: string; content?: { type: string; text?: string } }>;
		};
		const textBlocks = update.content?.filter(block => block.type === "content") ?? [];
		expect(textBlocks).toHaveLength(1);
		// `never.ts` was never in `perFileResults` at all — only `unattemptedPaths`
		// says it exists — so it must still reach the client as guidance, not be
		// silently dropped alongside the discarded full joined text.
		expect(textBlocks[0]?.content?.text).toBe(
			"```\nError editing skipped.ts: boom\nFiles NOT applied: never.ts; re-read the affected files and re-issue only the failed and unapplied files.\n```",
		);
	});

	it("falls back to the joined result text for a single-path aggregate edit failure with no perFileResults", () => {
		// Regression test: `apply_patch`'s single-target aggregation
		// (`executeSinglePathEntries`) returns one aggregate `diff`/`oldText`/
		// `newText` with no `perFileResults` array at all — `extractEditFailureText`
		// requires `perFileResults` and returned `undefined`, so this branch fell
		// straight to `diffContent` alone, silently dropping the "entry N was NOT
		// applied" guidance that only exists in the joined text echo.
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-edit-single-path-aggregate-fail",
				toolName: "edit",
				isError: true,
				result: {
					content: [
						{
							type: "text",
							text: "Error editing single.ts (entry 2 of 3): boom\nEntry 1 was already applied.\nEntry 3 was NOT applied; re-read the file and re-issue only the failed and unapplied entries.",
						},
					],
					details: {
						path: "single.ts",
						diff: "...",
						oldText: "before\n",
						newText: "after-entry-1\n",
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{
				type: string;
				path?: string;
				oldText?: string | null;
				newText?: string;
				content?: { type: string; text?: string };
			}>;
		};
		expect(update.content).toContainEqual({
			type: "diff",
			path: "single.ts",
			oldText: "before\n",
			newText: "after-entry-1\n",
		});
		const textBlocks = update.content?.filter(block => block.type === "content") ?? [];
		expect(textBlocks).toHaveLength(1);
		expect(textBlocks[0]?.content?.text).toBe(
			"```\nError editing single.ts (entry 2 of 3): boom\nEntry 1 was already applied.\nEntry 3 was NOT applied; re-read the file and re-issue only the failed and unapplied entries.\n```",
		);
	});

	it("includes the target file in the edit tool's title for every edit mode", () => {
		const pathStart = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-edit-title-path",
				toolName: "edit",
				args: { path: "src/foo.ts", edits: [] },
				intent: "Fix the off-by-one bug",
			} as AgentSessionEvent,
			"session-1",
		);
		const hashlineStart = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-edit-title-hashline",
				toolName: "edit",
				args: { input: "[src/bar.ts#1A2B]\nSWAP 3.=3:\n+fixed()\n" },
			} as AgentSessionEvent,
			"session-1",
		);
		const applyPatchStart = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-edit-title-apply-patch",
				toolName: "edit",
				args: { input: "*** Begin Patch\n*** Update File: src/baz.ts\n@@\n-old\n+new\n*** End Patch\n" },
			} as AgentSessionEvent,
			"session-1",
		);

		expectAcpNotifications([...pathStart, ...hashlineStart, ...applyPatchStart]);
		expect((pathStart[0]!.update as { title?: string }).title).toBe("Fix the off-by-one bug — src/foo.ts");
		expect((hashlineStart[0]!.update as { title?: string }).title).toBe("Edit src/bar.ts");
		expect((applyPatchStart[0]!.update as { title?: string }).title).toBe("Edit src/baz.ts");
	});

	it("resolves live image blob refs for ACP content without expanding rawOutput", () => {
		const blobRef = "blob:sha256:77467fcfe2bbdc034e0eabb4778c9d7de521c0d7c3e0d0a62566468e4d7da3a5";
		const resolvedImageData = "resolved-webp-base64";
		const events: AgentSessionEvent[] = [
			{
				type: "tool_execution_update",
				toolCallId: "tc-image-update",
				toolName: "generate_image",
				args: {},
				partialResult: {
					content: [{ type: "image", data: blobRef, mimeType: "image/webp" }],
					details: { images: [{ data: blobRef, mimeType: "image/webp" }] },
				},
			} as AgentSessionEvent,
			{
				type: "tool_execution_end",
				toolCallId: "tc-image-end",
				toolName: "generate_image",
				isError: false,
				result: {
					content: [{ type: "text", text: "Generated image saved." }],
					details: { images: [{ data: blobRef, mimeType: "image/webp" }] },
				},
			} as AgentSessionEvent,
		];

		for (const event of events) {
			const updates = mapUpdates(event, "session-1", {
				resolveImageData: data => (data === blobRef ? resolvedImageData : data),
			});
			const update = updates[0]!.update as {
				content?: Array<{
					type: string;
					content?: { type: string; data?: string; mimeType?: string; text?: string };
				}>;
				rawOutput?: unknown;
			};
			const images = update.content?.filter(item => item.type === "content" && item.content?.type === "image") ?? [];

			expect(images).toEqual([
				{ type: "content", content: { type: "image", data: resolvedImageData, mimeType: "image/webp" } },
			]);
			expect(JSON.stringify(update.content)).not.toContain("blob:sha256:");
			expect(JSON.stringify(update.rawOutput)).toContain(blobRef);
		}
	});

	it("emits locations on tool_execution_update from args", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-2",
				toolName: "edit",
				args: { path: "src/foo.ts" },
				partialResult: { content: [{ type: "text", text: "in progress" }] },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { sessionUpdate: string; locations?: { path: string }[] };
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.locations).toEqual([{ path: "src/foo.ts" }]);
	});

	it("shows only the live terminal for a command tool update, dropping the command echo", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-3",
				toolName: "bash",
				args: { command: "npm run check" },
				partialResult: { details: { terminalId: "term-1" } },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { sessionUpdate: string; content?: unknown };
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toEqual([{ type: "terminal", terminalId: "term-1" }]);
	});

	it("shows only the live terminal when details accompany empty content", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-terminal-empty-content",
				toolName: "bash",
				args: { command: "echo hi" },
				partialResult: { content: [], details: { terminalId: "term-1" } },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { sessionUpdate: string; content?: unknown };
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toEqual([{ type: "terminal", terminalId: "term-1" }]);
	});

	it("does not serialize a hub wait progress envelope into content text", () => {
		const partialResult = {
			content: [{ type: "text", text: "" }],
			details: {
				op: "wait",
				jobs: [
					{ id: "bash_1", state: "running" },
					{ id: "bash_2", state: "running" },
				],
			},
		};
		const updates = mapAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-hub-wait",
				toolName: "hub",
				args: { op: "wait", i: "waiting for jobs" },
				partialResult,
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: unknown;
			rawOutput?: unknown;
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		// The job details already ride the frame as structured rawOutput.
		expect(update.rawOutput).toEqual(partialResult);
		// An empty-text envelope must not be dumped as a JSON blob display row.
		expect(update.content).toBeUndefined();
		expect(JSON.stringify(update.content ?? [])).not.toContain('"op":"wait"');
	});

	it("drops raw output text once a live terminal already shows it", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-terminal-update-text",
				toolName: "bash",
				args: { command: "echo hi" },
				partialResult: {
					content: [{ type: "text", text: "running" }],
					details: { terminalId: "term-1" },
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { sessionUpdate: string; content?: unknown };
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toEqual([{ type: "terminal", terminalId: "term-1" }]);
	});

	it("drops raw end-result text once a live terminal already shows it", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-end",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "text", text: "done" }],
					details: { terminalId: "term-1" },
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { sessionUpdate: string; content?: unknown };
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toEqual([{ type: "terminal", terminalId: "term-1" }]);
	});

	it("shows only the live terminal for a command tool's final update", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-final-command",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "text", text: "done" }],
					details: { terminalId: "term-1" },
				},
			} as AgentSessionEvent,
			"session-1",
			{
				getToolArgs: toolCallId =>
					toolCallId === "tc-terminal-final-command" ? { command: "npm run check" } : undefined,
			},
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { sessionUpdate: string; content?: unknown };
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toEqual([{ type: "terminal", terminalId: "term-1" }]);
	});

	it("keeps terminal content alongside readable error and message fields", () => {
		const errorUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-error",
				toolName: "bash",
				isError: true,
				result: { errorMessage: "command failed", details: { terminalId: "term-1" } },
			} as AgentSessionEvent,
			"session-1",
		);
		const messageUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-message",
				toolName: "bash",
				isError: false,
				result: { message: "command completed", details: { terminalId: "term-1" } },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(errorUpdates).toHaveLength(1);
		expect(messageUpdates).toHaveLength(1);
		expectAcpNotifications([...errorUpdates, ...messageUpdates]);
		const errorUpdate = errorUpdates[0]!.update as {
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};
		const messageUpdate = messageUpdates[0]!.update as {
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};

		expect(errorUpdate.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
		expect(errorUpdate.content).toContainEqual({
			type: "content",
			content: { type: "text", text: "command failed" },
		});
		expect(messageUpdate.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
		expect(messageUpdate.content).toContainEqual({
			type: "content",
			content: { type: "text", text: "command completed" },
		});
	});

	it("widens the fence past backtick runs the output already contains", () => {
		const fenceUpdates = (output: string) =>
			mapUpdates(
				{
					type: "tool_execution_end",
					toolCallId: "tc-fence-widen",
					toolName: "bash",
					isError: false,
					result: output,
				} as AgentSessionEvent,
				"session-1",
			);

		const flush = fenceUpdates("```\nfenced\n```");
		// A closing fence indented up to three spaces closes the block too, so it
		// has to widen the wrapper the same way a flush run does.
		const indented = fenceUpdates("diff --git a/R.md b/R.md\n ```\n-a\n+b");

		expectAcpNotifications([...flush, ...indented]);
		expect((flush[0]!.update as { content?: unknown }).content).toEqual([
			{ type: "content", content: { type: "text", text: "````\n```\nfenced\n```\n````" } },
		]);
		expect((indented[0]!.update as { content?: unknown }).content).toEqual([
			{
				type: "content",
				content: { type: "text", text: "````\ndiff --git a/R.md b/R.md\n ```\n-a\n+b\n````" },
			},
		]);
	});

	it("keeps a framework error note beside fenced output without a terminal", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-no-terminal-error",
				toolName: "bash",
				isError: true,
				result: {
					content: [{ type: "text", text: "partial stdout" }],
					errorMessage: "Permission request cancelled",
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { content?: unknown };
		expect(update.content).toEqual([
			{ type: "content", content: { type: "text", text: "```\npartial stdout\n```" } },
			{ type: "content", content: { type: "text", text: "Permission request cancelled" } },
		]);
	});

	it("delivers live-terminal notices through _meta.terminal_output instead of dead sibling content", () => {
		// Regression test: Zed's `has_terminals` (`thread_view.rs`) renders a
		// terminal-bearing tool call exclusively through the terminal card,
		// silently dropping every other `content` item in the live view — the
		// prior sibling-`content` notices block never actually reached a Zed
		// user watching the card live (only "Copy as Markdown" export, via
		// `ToolCall::to_markdown`, which walks `content` unconditionally).
		// Notices must instead ride as extra `_meta.terminal_output` bytes on
		// the same real terminal id, which Zed's `on_terminal_provider_event`
		// appends straight into that terminal's own buffer.
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-notices",
				toolName: "bash",
				isError: true,
				result: {
					content: [{ type: "text", text: "boom\n\nCommand exited with code 1" }],
					details: {
						terminalId: "term-1",
						exitCode: 1,
						notices: ["Command exited with code 1", "[raw output: artifact://7]"],
					},
				},
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, realTerminalCapable: true },
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: unknown;
			_meta?: { terminal_output?: { terminal_id: string; data: string } };
		};
		// No dead sibling text block — only the terminal reference.
		expect(update.content).toEqual([{ type: "terminal", terminalId: "term-1" }]);
		expect(update._meta?.terminal_output).toEqual({
			terminal_id: "term-1",
			data: "\nCommand exited with code 1\n[raw output: artifact://7]\n",
		});
	});

	// Extends the binary-content fallback above: `details.notices` (bash's
	// exit code/wall-time/artifact notes) has no live terminal buffer to ride
	// in once the terminal item is dropped, so it must surface visibly
	// instead of via `buildLiveTerminalNoticeMeta` — writing it there too
	// would be a second, invisible delivery into a buffer this frame no
	// longer references.
	it("recovers notices visibly, with no _meta.terminal_output, for a live-terminal binary-content result", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-image-notices",
				toolName: "bash",
				isError: false,
				result: {
					content: [
						{ type: "text", text: "generated image" },
						{ type: "image", data: "base64-image-data", mimeType: "image/png" },
					],
					details: { terminalId: "term-image-notices", notices: ["Wall time: 2.00 seconds"] },
				},
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, realTerminalCapable: true },
		);

		const update = updates[0]!.update as { content?: ToolCallContent[]; _meta?: Record<string, unknown> };
		expect(update.content?.some(item => item.type === "terminal")).toBe(false);
		const texts = (update.content ?? [])
			.filter(
				(item): item is { type: "content"; content: { type: "text"; text: string } } =>
					item.type === "content" && item.content.type === "text",
			)
			.map(item => item.content.text)
			.join("\n");
		expect(texts).toContain("Wall time: 2.00 seconds");
		expect(update._meta?.terminal_output).toBeUndefined();
	});

	it("uses plain content for a live-terminal result containing binary content", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-image",
				toolName: "bash",
				isError: false,
				result: {
					content: [
						{ type: "text", text: "generated image" },
						{ type: "image", data: "base64-image-data", mimeType: "image/png" },
					],
					details: { terminalId: "term-image" },
				},
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, realTerminalCapable: true },
		);

		const update = updates[0]!.update as { content?: ToolCallContent[] };
		expect(update.content?.some(item => item.type === "terminal")).toBe(false);
		expect(update.content).toContainEqual({
			type: "content",
			content: { type: "image", data: "base64-image-data", mimeType: "image/png" },
		});
		expect(update.content).toContainEqual({
			type: "content",
			content: { type: "text", text: "```\ngenerated image\n```" },
		});
	});

	it("falls back to sibling content for live-terminal notices when the client hasn't negotiated _meta.terminal_output", () => {
		// Regression test: a client can advertise real ACP terminal support
		// (`terminal: true`) without negotiating Zed's ad hoc
		// `_meta.terminal_output` extension. `_meta.terminal_output` data means
		// nothing to such a client, and the live-terminal branch had stopped
		// emitting any sibling content for notices at all — the notices were
		// silently dropped entirely rather than falling back to the
		// best-effort sibling `content` item a spec-compliant (non-Zed) client
		// might still render.
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-notices-no-meta",
				toolName: "bash",
				isError: true,
				result: {
					content: [{ type: "text", text: "boom\n\nCommand exited with code 1" }],
					details: {
						terminalId: "term-2",
						exitCode: 1,
						notices: ["Command exited with code 1"],
					},
				},
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: false },
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { content?: unknown; _meta?: unknown };
		expect(update.content).toEqual([
			{ type: "terminal", terminalId: "term-2" },
			{ type: "content", content: { type: "text", text: "Command exited with code 1" } },
		]);
		expect(update._meta).toBeUndefined();
	});

	it("recovers a spilled artifact pointer into _meta.terminal_output when bash's own notices omit it", () => {
		// Regression test:
		// `bash.ts`'s `spilledArtifactId` is only populated inside
		// `enforceInlineByteCap`'s own save callback, which no-ops once
		// `OutputSink` already spilled the body under the inline cap — the
		// ordinary, common spill path (confirmed live: a real BashTool run
		// producing 76.5KB of output, spilled by the sink to a 51KB body,
		// carries `details.notices: ["Wall time: …"]` with no artifact
		// pointer at all, while `details.meta.truncation.artifactId` has it).
		// A terminal-rendering client only ever sees `details.notices` (or
		// its `_meta.terminal_output` mirror) — never the tool's own text —
		// so without re-deriving the notice from `details.meta`, the
		// recovery link and the "bytes were elided" acknowledgement vanish
		// entirely for every large bash call. This is the same underlying gap
		// as the "no acknowledgement when a producer silently drops bytes" case
		// elsewhere.
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-spilled-meta",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "text", text: "…truncated body…" }],
					details: {
						terminalId: "term-spilled",
						notices: ["Wall time: 0.21 seconds"],
						meta: {
							truncation: {
								direction: "middle",
								truncatedBy: "middle",
								totalLines: 1801,
								totalBytes: 76500,
								outputLines: 1207,
								outputBytes: 51222,
								headRange: { start: 1, end: 603 },
								tailRange: { start: 1199, end: 1801 },
								elidedBytes: 25300,
								elidedLines: 595,
								artifactId: "0",
							},
						},
					},
				},
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, realTerminalCapable: true },
		);

		expect(updates).toHaveLength(1);
		const update = updates[0]!.update as {
			content?: unknown;
			_meta?: { terminal_output?: { terminal_id: string; data: string } };
		};
		expect(update.content).toEqual([{ type: "terminal", terminalId: "term-spilled" }]);
		expect(update._meta?.terminal_output?.data).toContain("Wall time: 0.21 seconds");
		expect(update._meta?.terminal_output?.data).toContain("artifact://0");
	});

	it("recovers the same spilled artifact pointer as sibling content when the client hasn't negotiated the meta extension", () => {
		// Same producer gap as above, for the fallback path a real-terminal
		// client without `_meta.terminal_output` uses instead.
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-spilled-no-meta",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "text", text: "…truncated body…" }],
					details: {
						terminalId: "term-spilled-2",
						notices: ["Wall time: 0.21 seconds"],
						meta: {
							truncation: {
								direction: "middle",
								truncatedBy: "middle",
								totalLines: 1801,
								totalBytes: 76500,
								outputLines: 1207,
								outputBytes: 51222,
								headRange: { start: 1, end: 603 },
								tailRange: { start: 1199, end: 1801 },
								elidedBytes: 25300,
								elidedLines: 595,
								artifactId: "0",
							},
						},
					},
				},
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: false },
		);

		expect(updates).toHaveLength(1);
		const update = updates[0]!.update as { content?: ToolCallContent[]; _meta?: unknown };
		expect(update._meta).toBeUndefined();
		const textItem = update.content?.find(
			(item): item is { type: "content"; content: { type: "text"; text: string } } =>
				item.type === "content" && item.content.type === "text",
		);
		expect(textItem?.content.text).toContain("Wall time: 0.21 seconds");
		expect(textItem?.content.text).toContain("artifact://0");
	});

	it("delivers a framework-level directText note through _meta.terminal_output instead of dead sibling content", () => {
		// Regression test: `extractDirectText` (a top-level `errorMessage`/`message`/
		// `text` framework note, e.g. "Permission request cancelled") was
		// appended as sibling `content` in the live-terminal branch completely
		// ungated — the same has_terminals class of bug already fixed for
		// `details.notices`. No current producer sets both `terminalId` and a
		// top-level `errorMessage` on the same result, but the gate must hold
		// for whichever tool does next. Must ride via `_meta.terminal_output`
		// on the same terminal id for a terminalMetaCapable client instead.
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-direct-text",
				toolName: "bash",
				isError: true,
				result: {
					content: [],
					details: { terminalId: "term-3" },
					errorMessage: "Permission request cancelled",
				},
			} as unknown as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, realTerminalCapable: true },
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: unknown;
			_meta?: { terminal_output?: { terminal_id: string; data: string } };
		};
		expect(update.content).toEqual([{ type: "terminal", terminalId: "term-3" }]);
		expect(update._meta?.terminal_output).toEqual({
			terminal_id: "term-3",
			data: "\nPermission request cancelled\n",
		});
	});

	it("falls back to sibling content for a directText note when the client hasn't negotiated _meta.terminal_output", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-direct-text-no-meta",
				toolName: "bash",
				isError: true,
				result: {
					content: [],
					details: { terminalId: "term-4" },
					errorMessage: "Permission request cancelled",
				},
			} as unknown as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: false },
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { content?: unknown; _meta?: unknown };
		expect(update.content).toEqual([
			{ type: "terminal", terminalId: "term-4" },
			{ type: "content", content: { type: "text", text: "Permission request cancelled" } },
		]);
		expect(update._meta).toBeUndefined();
	});

	it("renders recorded output as text when the terminal id is not live", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-stale",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "text", text: "done" }],
					details: { terminalId: "term-replay" },
				},
			} as AgentSessionEvent,
			"session-1",
			{ isTerminalLive: () => false },
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { content?: unknown };
		expect(update.content).toEqual([{ type: "content", content: { type: "text", text: "```\ndone\n```" } }]);
	});

	it("uses the meta-terminal convention for a stale replay terminal id when the client supports it", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-stale-meta",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "text", text: "done" }],
					details: { terminalId: "term-replay" },
				},
			} as AgentSessionEvent,
			"session-1",
			{ isTerminalLive: () => false, terminalMetaCapable: true, realTerminalCapable: false },
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{ type: string; terminalId?: string }>;
			_meta?: Record<string, unknown>;
		};
		// The stale, connection-specific terminal id from `details` must never
		// leak into the content reference — only the tool call's own id (stable
		// across a `session/load` reconnect) can round-trip through replay.
		expect(update.content).toEqual([{ type: "terminal", terminalId: "tc-terminal-stale-meta" }]);
		expect(update._meta).toEqual({
			terminal_output: { terminal_id: "tc-terminal-stale-meta", data: "done" },
			terminal_exit: { terminal_id: "tc-terminal-stale-meta", exit_code: 0, signal: null },
		});
	});

	it("does not use the meta-terminal convention when a real client terminal is available", () => {
		const start = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-real-terminal",
				toolName: "bash",
				args: { command: "echo hi" },
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, realTerminalCapable: true },
		)[0]!.update as { content?: unknown; _meta?: unknown };
		// The live path still reports the real terminal id via a later
		// tool_execution_update once `terminal/create` resolves — the pending
		// start must not pre-empt it with a synthetic one.
		expect("content" in start).toBe(false);
		expect("_meta" in start).toBe(false);
	});

	it("routes a pty bash call through the meta terminal even when the client is realTerminalCapable", () => {
		// Regression test: BashTool
		// explicitly skips `clientBridge.createTerminal` whenever `pty: true` is
		// requested (PTY output needs the local interactive terminal UI
		// instead), so no real client-owned terminal is ever created for one of
		// these regardless of `realTerminalCapable`. `wantsMetaTerminal` used
		// to key purely off `realTerminalCapable`, so a pty call fell back to
		// the fenced-text path and was capped at `ACP_TEXT_LIMIT` even on a
		// terminalMetaCapable client that could render it untruncated.
		const start = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-pty",
				toolName: "bash",
				args: { command: "vim", pty: true },
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, realTerminalCapable: true },
		)[0]!.update as { content?: Array<{ type: string; terminalId?: string }>; _meta?: Record<string, unknown> };
		expect(start.content).toEqual([{ type: "terminal", terminalId: "tc-pty" }]);
		expect(start._meta).toEqual({ terminal_info: { terminal_id: "tc-pty" } });

		const end = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-pty",
				toolName: "bash",
				isError: false,
				result: { content: [{ type: "text", text: "pty output" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, realTerminalCapable: true, getToolArgs: () => ({ command: "vim", pty: true }) },
		)[0]!.update as { content?: Array<{ type: string; terminalId?: string }>; _meta?: Record<string, unknown> };
		expect(end.content).toEqual([{ type: "terminal", terminalId: "tc-pty" }]);
		expect(end._meta).toEqual({
			terminal_output: { terminal_id: "tc-pty", data: "pty output" },
			terminal_exit: { terminal_id: "tc-pty", exit_code: 0, signal: null },
		});
	});

	it("does not route a non-pty bash call through the meta terminal when a real client terminal is available", () => {
		const start = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-non-pty",
				toolName: "bash",
				args: { command: "echo hi", pty: false },
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, realTerminalCapable: true },
		)[0]!.update as { content?: unknown; _meta?: unknown };
		expect("content" in start).toBe(false);
		expect("_meta" in start).toBe(false);
	});

	it("registers a meta terminal on eval start and reports output/exit at the end", () => {
		const startUpdates = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-eval-meta",
				toolName: "eval",
				args: { language: "py", title: "hello", code: "print('hi')" },
				cwd: "/repo",
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, cwd: "/repo" },
		);
		expect(startUpdates).toHaveLength(1);
		expectAcpNotifications(startUpdates);
		const start = startUpdates[0]!.update as {
			content?: Array<{ type: string; terminalId?: string }>;
			_meta?: Record<string, unknown>;
		};
		expect(start.content).toEqual([{ type: "terminal", terminalId: "tc-eval-meta" }]);
		expect(start._meta).toEqual({ terminal_info: { terminal_id: "tc-eval-meta", cwd: "/repo" } });

		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-eval-meta",
				toolName: "eval",
				isError: false,
				result: { content: [{ type: "text", text: "hi" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, getToolArgs: () => ({ language: "py", title: "hello", code: "print('hi')" }) },
		);
		expect(endUpdates).toHaveLength(1);
		expectAcpNotifications(endUpdates);
		const end = endUpdates[0]!.update as {
			content?: Array<{ type: string; terminalId?: string }>;
			_meta?: Record<string, unknown>;
		};
		expect(end.content).toEqual([{ type: "terminal", terminalId: "tc-eval-meta" }]);
		// Zed routes any tool call carrying a `terminal` content item exclusively
		// through its terminal renderer — a separate text content item alongside
		// it is never shown. The only place eval's source (hidden behind a short
		// `[lang] title` header, unlike bash's full-command title) can render is
		// inside the terminal's own text stream, echoed ahead of the real output.
		expect(end._meta).toEqual({
			terminal_output: { terminal_id: "tc-eval-meta", data: `print('hi')\n${"─".repeat(48)}\nhi` },
			terminal_exit: { terminal_id: "tc-eval-meta", exit_code: 0, signal: null },
		});
	});

	it("keeps each cell's own [lang] title label in a multi-cell eval's meta-terminal source echo", () => {
		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-eval-multi-cell-meta",
				toolName: "eval",
				isError: false,
				result: { content: [{ type: "text", text: "1\n2" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			{
				terminalMetaCapable: true,
				getToolArgs: () => ({
					cells: [
						{ language: "py", title: "first", code: "print(1)" },
						{ language: "js", title: "second", code: "console.log(2)" },
					],
				}),
			},
		);
		const end = endUpdates[0]!.update as { _meta?: Record<string, unknown> };
		// The title ("[py] first, [js] second") only lists the labels together;
		// without a per-cell marker in the source echo itself, a reader can't
		// tell which code produced which part of the (also concatenated) output.
		expect(end._meta).toEqual({
			terminal_output: {
				terminal_id: "tc-eval-multi-cell-meta",
				data: `[py] first\nprint(1)\n\n[js] second\nconsole.log(2)\n${"─".repeat(48)}\n1\n2`,
			},
			terminal_exit: { terminal_id: "tc-eval-multi-cell-meta", exit_code: 0, signal: null },
		});
	});

	it("reports a failing eval cell's own exit code and a failed status", () => {
		// `eval` never calls `.error()` on its result builder, so the event's
		// `isError` is false even for a cell that exited nonzero — the failure
		// lives in `details.isError` and the cell's own `exitCode`. Reading only
		// the event flag reported `exit_code: 0` and `status: "completed"` for a
		// terminal whose body says the command failed.
		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-eval-failed",
				toolName: "eval",
				isError: false,
				result: {
					content: [{ type: "text", text: "boom\n\nCommand exited with code 1" }],
					details: {
						isError: true,
						cells: [{ index: 0, code: "process.exit(1)", output: "boom", status: "error", exitCode: 1 }],
					},
				},
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, getToolArgs: () => ({ language: "js", code: "process.exit(1)" }) },
		);
		const end = endUpdates[0]!.update as { status?: string; _meta?: Record<string, unknown> };
		expect(end.status).toBe("failed");
		expect(end._meta).toEqual({
			terminal_output: {
				terminal_id: "tc-eval-failed",
				data: `process.exit(1)\n${"─".repeat(48)}\nboom\n\nCommand exited with code 1`,
			},
			terminal_exit: { terminal_id: "tc-eval-failed", exit_code: 1, signal: null },
		});
	});

	it("takes the first failing cell's exit code in a multi-cell eval", () => {
		// Execution stops at the first cell that fails, so that cell's code is
		// the call's exit status — a later cell's absent/zero code must not
		// mask it.
		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-eval-failed-multi",
				toolName: "eval",
				isError: false,
				result: {
					content: [{ type: "text", text: "ok\n\nCommand exited with code 3" }],
					details: {
						isError: true,
						cells: [
							{ index: 0, code: "print(1)", output: "ok", status: "complete", exitCode: 0 },
							{ index: 1, code: "raise SystemExit(3)", output: "", status: "error", exitCode: 3 },
						],
					},
				},
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, getToolArgs: () => ({ language: "py", code: "print(1)" }) },
		);
		const end = endUpdates[0]!.update as { status?: string; _meta?: Record<string, unknown> };
		expect(end.status).toBe("failed");
		const meta = end._meta as { terminal_exit?: { exit_code?: number } };
		expect(meta.terminal_exit?.exit_code).toBe(3);
	});

	it("leaves a failed eval's exit status blank when no exit code exists anywhere", () => {
		// An aborted eval marks `details.isError` but has no exit code in any
		// cell (`eval.ts`'s cancelled branch clears it). A wrong code is worse
		// than none, so the terminal's exit status stays unset while the card
		// still reports the failure.
		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-eval-aborted",
				toolName: "eval",
				isError: false,
				result: {
					content: [{ type: "text", text: "Command aborted" }],
					details: {
						isError: true,
						cells: [{ index: 0, code: "sleep(30)", output: "", status: "error" }],
					},
				},
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, getToolArgs: () => ({ language: "py", code: "sleep(30)" }) },
		);
		const end = endUpdates[0]!.update as { status?: string; _meta?: Record<string, unknown> };
		expect(end.status).toBe("failed");
		expect(end._meta).toEqual({
			terminal_output: {
				terminal_id: "tc-eval-aborted",
				data: `sleep(30)\n${"─".repeat(48)}\nCommand aborted`,
			},
			terminal_exit: { terminal_id: "tc-eval-aborted", signal: null },
		});
	});

	it("delivers eval's singular backend-fallback notice to the terminal channel", () => {
		// `eval` records a backend-fallback explanation in `details.notice`
		// (singular), not bash's `details.notices` array — its TUI card renders
		// it as a dim bracketed line, while the ACP terminal path read only the
		// plural field and dropped it.
		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-eval-notice",
				toolName: "eval",
				isError: false,
				result: {
					content: [{ type: "text", text: "ok" }],
					details: { notice: "python unavailable; ran on the js backend instead" },
				},
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, getToolArgs: () => ({ language: "js", code: "print(1)" }) },
		);
		const meta = endUpdates[0]!.update._meta as { terminal_output?: { data: string } };
		expect(meta.terminal_output?.data).toContain("python unavailable; ran on the js backend instead");
	});

	it("re-attaches a truncation notice the text limit cut off the end of plain content", () => {
		// Producers append their notices *after* the output, so
		// `ACP_TEXT_LIMIT`'s head truncation drops them — leaving a client with
		// no terminal channel a silently clipped dump with no recovery pointer.
		const notice = "[Showing 1 of 9000 lines. Read artifact://7 for full output]";
		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-truncated-notice",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "text", text: `${"x".repeat(6000)}\n\n${notice}` }],
					details: { notices: [notice] },
				},
			} as AgentSessionEvent,
			"session-1",
			{ getToolArgs: () => ({ command: "seq 1 9000" }) },
		);
		const update = endUpdates[0]!.update as {
			content?: Array<{ type: string; content?: { type: string; text?: string } }>;
		};
		const content = update.content ?? [];
		const texts = content
			.filter(item => item.type === "content" && item.content?.type === "text")
			.map(item => item.content?.text ?? "");
		// The clipped body no longer carries the notice…
		expect(texts[0]).not.toContain("artifact://7");
		// …so it rides as its own block instead of being lost.
		expect(texts.join("\n")).toContain("artifact://7");
		// And it is not restated when the body still carries it.
		expect(texts.join("\n").match(/artifact:\/\/7/g)).toHaveLength(1);
	});

	it("routes eval images through a plain content card instead of the terminal-only one", () => {
		// Regression test, round 3 of the same finding: Zed's `has_terminals`
		// drops *every* sibling `content` item once a `terminal` item exists —
		// not just text (see `docs/acp-development.md`'s "Do" rule). Images
		// have no `_meta.terminal_output`-style byte-stream equivalent either
		// (that channel is text-only), so a terminal box that hides the image
		// is strictly worse than a plain content card that shows everything:
		// drop the terminal item from this final update whenever the result
		// actually produced an image.
		const imageData = "base64-image-data";
		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-eval-image",
				toolName: "eval",
				isError: false,
				result: {
					content: [
						{ type: "text", text: "(displayed 1 image; no text output)" },
						{ type: "image", data: imageData, mimeType: "image/png" },
					],
					details: { images: [{ data: imageData, mimeType: "image/png" }] },
				},
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, getToolArgs: () => ({ language: "py", code: "plt.show()" }) },
		);
		const end = endUpdates[0]!.update as {
			content?: Array<{
				type: string;
				terminalId?: string;
				content?: { type: string; text?: string; data?: string; mimeType?: string };
			}>;
			_meta?: Record<string, unknown>;
		};
		expect(end.content).toEqual([
			// The eval source has no other rendered channel once the terminal
			// item is dropped from this update (see `buildMetaTerminalOutput`'s
			// doc comment) — this was the same finding class as the dangling-
			// replay fix, round 4: `buildToolStartContent` is the same source
			// echo the non-meta fallback already prepends, kept in sync for free.
			{ type: "content", content: { type: "text", text: "[py]\nplt.show()" } },
			{ type: "content", content: { type: "text", text: "```\n(displayed 1 image; no text output)\n```" } },
			{ type: "content", content: { type: "image", data: imageData, mimeType: "image/png" } },
		]);
		// The display-only terminal Zed registered at `tool_execution_start`
		// still needs its lifecycle finalized even though it's no longer
		// referenced by this update's `content` — just no `terminal_output`,
		// since there's no terminal card left to append bytes into.
		expect(end._meta).toEqual({
			terminal_exit: { terminal_id: "tc-eval-image", exit_code: 0, signal: null },
		});
	});

	it("routes eval images through a plain content card when details.images is absent (real EvalTool result shape)", () => {
		// Regression test: `EvalTool.execute`'s actual final `toolResult(details)`
		// only ever puts images in `.content([{type:"text",...}, ...images])` —
		// `details.images` is populated solely on the intermediate streaming
		// snapshots (`buildUpdateDetails`), never the terminal result. The
		// sibling test above fabricates `details.images` alongside `content` and
		// so never exercised this — the real path lost every eval image once a
		// client advertised `_meta.terminal_output`.
		const imageData = "base64-image-data-2";
		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-eval-image-no-details",
				toolName: "eval",
				isError: false,
				result: {
					content: [
						{ type: "text", text: "(displayed 1 image; no text output)" },
						{ type: "image", data: imageData, mimeType: "image/png" },
					],
					details: {},
				},
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, getToolArgs: () => ({ language: "py", code: "plt.show()" }) },
		);
		const end = endUpdates[0]!.update as {
			content?: Array<{
				type: string;
				terminalId?: string;
				content?: { type: string; text?: string; data?: string; mimeType?: string };
			}>;
		};
		expect(end.content).toEqual([
			{ type: "content", content: { type: "text", text: "[py]\nplt.show()" } },
			{ type: "content", content: { type: "text", text: "```\n(displayed 1 image; no text output)\n```" } },
			{ type: "content", content: { type: "image", data: imageData, mimeType: "image/png" } },
		]);
	});

	it("delivers details.notice alongside an eval image in meta-capable mode", () => {
		// The image fallback composes `content` by hand instead of going through
		// `extractTerminalDeliverableFacts`'s other two call sites, so a
		// details-only fact (here `details.notice`, eval's backend-fallback
		// explanation) rode the terminal item this branch just dropped and had
		// no other channel — the non-meta path (below) already delivered it.
		const imageData = "base64-image-data-notice";
		const result = {
			content: [
				{ type: "text", text: "(displayed 1 image; no text output)" },
				{ type: "image", data: imageData, mimeType: "image/png" },
			],
			details: { notice: "Fell back to the js backend." },
		};
		const metaEnd = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-eval-image-notice",
				toolName: "eval",
				isError: false,
				result,
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, getToolArgs: () => ({ language: "py", code: "plt.show()" }) },
		)[0]!.update as { content?: Array<{ type: string; content?: { type: string; text?: string } }> };
		const plainEnd = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-eval-image-notice-plain",
				toolName: "eval",
				isError: false,
				result,
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: false, getToolArgs: () => ({ language: "py", code: "plt.show()" }) },
		)[0]!.update as { content?: Array<{ type: string; content?: { type: string; text?: string } }> };
		const metaTexts = (metaEnd.content ?? [])
			.filter(item => item.type === "content" && item.content?.type === "text")
			.map(item => item.content?.text)
			.join("\n");
		const plainTexts = (plainEnd.content ?? [])
			.filter(item => item.type === "content" && item.content?.type === "text")
			.map(item => item.content?.text)
			.join("\n");
		expect(plainTexts).toContain("Fell back to the js backend.");
		expect(metaTexts).toContain("Fell back to the js backend.");
	});

	it("delivers a framework-level errorMessage alongside an eval image in meta-capable mode", () => {
		const imageData = "base64-image-data-err";
		const result = {
			content: [
				{ type: "text", text: "(displayed 1 image; no text output)" },
				{ type: "image", data: imageData, mimeType: "image/png" },
			],
			details: {},
			errorMessage: "Permission request cancelled",
		};
		const metaEnd = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-eval-image-err",
				toolName: "eval",
				isError: false,
				result,
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, getToolArgs: () => ({ language: "py", code: "plt.show()" }) },
		)[0]!.update as { content?: Array<{ type: string; content?: { type: string; text?: string } }> };
		const metaTexts = (metaEnd.content ?? [])
			.filter(item => item.type === "content" && item.content?.type === "text")
			.map(item => item.content?.text)
			.join("\n");
		expect(metaTexts).toContain("Permission request cancelled");
	});

	it("does not double-deliver a details.meta notice already inline in an eval image's rendered output", () => {
		// `wrapToolWithMetaNotice`'s `appendOutputNotice` writes the
		// truncation notice into the result's text content directly, so
		// `extractTerminalStreamText` already carries it in `finalOutput` —
		// the fact-delivery fix must not restate it as a second content item.
		const imageData = "base64-image-data-dedupe";
		const noticeLine = "[Showing lines 2200-5199 of 5199 (187.5KB limit)]";
		const result = {
			content: [
				{ type: "text", text: `some output\n\n${noticeLine}` },
				{ type: "image", data: imageData, mimeType: "image/png" },
			],
			details: {
				meta: {
					truncation: {
						direction: "tail",
						truncatedBy: "bytes",
						totalLines: 5199,
						totalBytes: 256_000,
						outputLines: 3000,
						outputBytes: 192_000,
						maxBytes: 192_000,
						shownRange: { start: 2200, end: 5199 },
					},
				},
			},
		};
		const metaEnd = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-eval-image-dedupe",
				toolName: "eval",
				isError: false,
				result,
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, getToolArgs: () => ({ language: "py", code: "plt.show()" }) },
		)[0]!.update as { content?: Array<{ type: string; content?: { type: string; text?: string } }> };
		const texts = (metaEnd.content ?? [])
			.filter(item => item.type === "content" && item.content?.type === "text")
			.map(item => item.content?.text ?? "");
		const occurrences = texts.join("\n").split(noticeLine).length - 1;
		expect(occurrences).toBe(1);
	});

	it("streams cumulative output through the meta-terminal convention on tool_execution_update", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-eval-progress",
				toolName: "eval",
				args: { language: "py", title: "hello", code: "print('hi')" },
				partialResult: { content: [{ type: "text", text: "hi\nmore" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true },
		);
		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			status?: string;
			content?: unknown;
			_meta?: Record<string, unknown>;
		};
		expect(update.status).toBe("in_progress");
		// No incremental `content` story for a meta-terminal call (see
		// `wantsMetaTerminal`'s doc) — the cumulative-so-far text instead lands in
		// `_meta.terminal_output`, same shape `tool_execution_end` uses, so the
		// terminal fills in live instead of staying blank until completion.
		expect(update.content).toBeUndefined();
		expect(update._meta).toEqual({
			terminal_output: { terminal_id: "tc-eval-progress", data: `print('hi')\n${"─".repeat(48)}\nhi\nmore` },
		});
	});

	it("emits only the new bytes on tool_execution_end after a tool_execution_update already streamed a prefix", () => {
		// Regression test: Zed appends `terminal_output.data` to the terminal's
		// buffer rather than replacing it, so resending the full cumulative
		// snapshot at both `tool_execution_update` and `tool_execution_end`
		// duplicates every byte already streamed. `getMetaTerminalSent`/
		// `setMetaTerminalSent` must be backed by the same state across both
		// calls for the delta to be computed correctly.
		const sent = new Map<string, string>();
		const options = {
			terminalMetaCapable: true,
			getMetaTerminalSent: (id: string) => sent.get(id),
			setMetaTerminalSent: (id: string, text: string) => {
				sent.set(id, text);
			},
		};
		const updateUpdates = mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-eval-delta",
				toolName: "eval",
				args: { language: "py", title: "hello", code: "print('hi')" },
				partialResult: { content: [{ type: "text", text: "hi" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const update = updateUpdates[0]!.update as { _meta?: Record<string, unknown> };
		expect(update._meta).toEqual({
			terminal_output: { terminal_id: "tc-eval-delta", data: `print('hi')\n${"─".repeat(48)}\nhi` },
		});

		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-eval-delta",
				toolName: "eval",
				isError: false,
				result: { content: [{ type: "text", text: "hi\nmore" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const end = endUpdates[0]!.update as { _meta?: Record<string, unknown> };
		// Only the newly-appended "\nmore" — never the "print('hi')" header or
		// "hi" already delivered by the update above.
		expect(end._meta).toEqual({
			terminal_output: { terminal_id: "tc-eval-delta", data: "\nmore" },
			terminal_exit: { terminal_id: "tc-eval-delta", exit_code: 0, signal: null },
		});
	});

	it("streams past the 4000-char ACP_TEXT_LIMIT without stalling or truncating meta-terminal output", () => {
		// Regression test: `extractTerminalStreamText` must not run the
		// meta-terminal snapshot through `limitText`. A terminal is an
		// append-only byte stream, not a text content block — clamping the
		// snapshot to `ACP_TEXT_LIMIT` (4000 chars) makes every snapshot past
		// that size byte-identical to the previous one once truncated, so
		// `buildMetaTerminalDelta` sees no change and drops the rest of the
		// stream, including the final `tool_execution_end` payload.
		const sent = new Map<string, string>();
		const options = {
			terminalMetaCapable: true,
			getMetaTerminalSent: (id: string) => sent.get(id),
			setMetaTerminalSent: (id: string, text: string) => {
				sent.set(id, text);
			},
		};
		const args = { language: "py", title: "hello", code: "print('hi')" };
		const header = `print('hi')\n${"─".repeat(48)}\n`;
		let raw = "";
		let delivered = "";
		for (let i = 0; i < 20; i++) {
			raw += `line ${i} ${"y".repeat(500)}\n`;
			const updates = mapUpdates(
				{
					type: "tool_execution_update",
					toolCallId: "tc-eval-large",
					toolName: "eval",
					args,
					partialResult: { content: [{ type: "text", text: raw }], details: {} },
				} as AgentSessionEvent,
				"session-1",
				options,
			);
			const update = updates[0]!.update as { _meta?: { terminal_output?: { data: string } } };
			const data = update._meta?.terminal_output?.data;
			if (data) delivered += data;
		}
		expect(raw.length).toBeGreaterThan(4000);
		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-eval-large",
				toolName: "eval",
				isError: false,
				result: { content: [{ type: "text", text: raw }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const end = endUpdates[0]!.update as { _meta?: { terminal_output?: { data: string } } };
		if (end._meta?.terminal_output?.data) delivered += end._meta.terminal_output.data;
		// The header is sent exactly once, up front; every raw byte follows
		// verbatim, with no truncation, no duplication, and no trailing-newline
		// loss — `extractTerminalStreamText` preserves terminal snapshots as
		// append-only process bytes instead of trimming them like the
		// text-content path.
		expect(delivered).toBe(header + raw);
	});

	it("splices only the undelivered remainder when a snapshot rolls its tail window forward without being a plain extension", () => {
		// A bounded tail buffer's window can roll forward such that the new
		// snapshot is neither a superset nor a subset of what was delivered
		// (old leading bytes fell off the window). `terminal_output.data` is
		// append-only, so the delta must be exactly the bytes past the overlap
		// with what's already on screen — never the whole rolled window.
		const sent = new Map<string, string>();
		const options = {
			terminalMetaCapable: true,
			getMetaTerminalSent: (id: string) => sent.get(id),
			setMetaTerminalSent: (id: string, text: string) => {
				sent.set(id, text);
			},
		};
		mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-roll",
				toolName: "bash",
				args: { command: "seq 1 100000" },
				partialResult: { content: [{ type: "text", text: "line1\nline2\nline3" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const rolled = mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-roll",
				toolName: "bash",
				args: { command: "seq 1 100000" },
				// The window dropped "line1\n" off the front and gained "line4" at
				// the back — an overlap of "line2\nline3", not a superset.
				partialResult: { content: [{ type: "text", text: "line2\nline3\nline4" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const update = rolled[0]!.update as { _meta?: Record<string, unknown> };
		expect(update._meta).toEqual({
			terminal_output: { terminal_id: "tc-roll", data: "\nline4" },
		});
	});

	it("resolves overlap correctly when it exceeds the old fixed 4096-byte trial cap", () => {
		// The naive longest-candidate-first scan this superseded only tried
		// suffixes up to MAX_OVERLAP_TRIAL_BYTES (4096); a tail-buffer roll on
		// eval's 100 KB / bash's 50 KB window commonly overlaps by far more
		// than that, which made the old scan return 0 and suppress the rest of
		// the stream. Build a rollover whose genuine overlap is well past 4096
		// bytes and confirm only the truly new bytes are delivered.
		const sent = new Map<string, string>();
		const options = {
			terminalMetaCapable: true,
			getMetaTerminalSent: (id: string) => sent.get(id),
			setMetaTerminalSent: (id: string, text: string) => {
				sent.set(id, text);
			},
		};
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${"y".repeat(40)}`);
		const full = `${lines.join("\n")}\n`;
		const droppedPrefix = `${lines.slice(0, 10).join("\n")}\n`;
		const overlap = full.slice(droppedPrefix.length);
		expect(overlap.length).toBeGreaterThan(4096);
		mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-big-roll",
				toolName: "bash",
				args: { command: "seq 1 200" },
				partialResult: { content: [{ type: "text", text: full }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const rolled = mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-big-roll",
				toolName: "bash",
				args: { command: "seq 1 200" },
				partialResult: { content: [{ type: "text", text: `${overlap}NEW_LINE_APPENDED` }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const update = rolled[0]!.update as { _meta?: Record<string, unknown> };
		expect(update._meta).toEqual({
			terminal_output: { terminal_id: "tc-big-roll", data: "NEW_LINE_APPENDED" },
		});
	});

	it("does not diff a column-truncated final result against the raw watermark as a discontinuity (regression: false rollover resync)", () => {
		// Wire capture: a long single-line eval output streams raw via
		// tool_execution_update, but eval.ts's tool_execution_end result is a
		// *display re-render* for the model — truncated per-line at
		// `tools.maxColumn` (768 chars) with `details.meta.limits.
		// columnTruncated` set. Diffing that re-render against the raw
		// watermark via `deliveredOverlap` found zero overlap (the truncated
		// line's suffix never matches the raw tail's), which fired the
		// rollover-resync branch: a false "[terminal output discontinuity:
		// earlier bytes were dropped]" notice plus a *re-send* of the
		// (already-truncated) re-rendered text, even though every byte had
		// already reached the client live. Neither must happen once a prefix
		// has already streamed for this call.
		const sent = new Map<string, string>();
		const options = {
			terminalMetaCapable: true,
			getMetaTerminalSent: (id: string) => sent.get(id),
			setMetaTerminalSent: (id: string, text: string) => {
				sent.set(id, text);
			},
		};
		const raw = "A".repeat(30000);
		mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-column-truncated",
				toolName: "eval",
				args: { language: "python", code: "sys.stdout.write('A' * 30000)" },
				partialResult: { content: [{ type: "text", text: raw }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const rendered = `${"A".repeat(768)}…`;
		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-column-truncated",
				toolName: "eval",
				isError: false,
				result: {
					content: [{ type: "text", text: rendered }],
					details: { meta: { limits: { columnTruncated: { maxColumn: 768 } } } },
				},
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const end = endUpdates[0]!.update as { _meta?: Record<string, unknown> };
		// No discontinuity notice, no re-sent body — only the terminal's
		// lifecycle finalizing plus the genuinely new fact
		// (`details.meta.limits.columnTruncated`) that only the discarded final
		// body carried; `extractTerminalNotices` recovers it instead of losing
		// it the way `details.notices` alone would (finding 2, review
		// 4821242767: a fact that exists only in `details.meta`/the tool's own
		// text is invisible to the terminal-content path unless something
		// re-derives it structurally).
		const meta = { limits: { columnTruncated: { maxColumn: 768 } } };
		expect(end._meta).toEqual({
			terminal_output: { terminal_id: "tc-column-truncated", data: `\n${formatOutputNotice(meta).trim()}\n` },
			terminal_exit: { terminal_id: "tc-column-truncated", exit_code: 0, signal: null },
		});
	});

	it("still surfaces bash's exit notices on a column-truncated final result instead of dropping them entirely", () => {
		// Same hazard as above, but for bash: `details.notices` (wall time,
		// artifact pointer) must still reach the client through _meta even
		// though the truncated body itself is no longer re-diffed — and so
		// must `details.meta.limits.columnTruncated`, the genuine fact that
		// was only otherwise visible in that same discarded body text
		// (finding 2, review 4821242767).
		const sent = new Map<string, string>();
		const options = {
			terminalMetaCapable: true,
			getMetaTerminalSent: (id: string) => sent.get(id),
			setMetaTerminalSent: (id: string, text: string) => {
				sent.set(id, text);
			},
		};
		const raw = "A".repeat(30000);
		mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-bash-column-truncated",
				toolName: "bash",
				args: { command: "head -c 30000 /dev/zero | tr '\\0' 'A'" },
				partialResult: { content: [{ type: "text", text: raw }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const rendered = `${"A".repeat(768)}…\n\nWall time: 0.02 seconds\n\n[Some lines truncated to 768 chars]`;
		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-bash-column-truncated",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "text", text: rendered }],
					details: {
						notices: ["Wall time: 0.02 seconds"],
						meta: { limits: { columnTruncated: { maxColumn: 768 } } },
					},
				},
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const end = endUpdates[0]!.update as { _meta?: Record<string, unknown> };
		const meta = { limits: { columnTruncated: { maxColumn: 768 } } };
		expect(end._meta).toEqual({
			terminal_output: {
				terminal_id: "tc-bash-column-truncated",
				data: `\nWall time: 0.02 seconds\n\n${formatOutputNotice(meta).trim()}\n`,
			},
			terminal_exit: { terminal_id: "tc-bash-column-truncated", exit_code: 0, signal: null },
		});
	});

	it("does not report a discontinuity when the final result merely re-normalizes whitespace it already streamed", () => {
		// Regression test: the
		// re-render markers (`limits.columnTruncated`, `truncation`) are not
		// the only way a `tool_execution_end` result stops being a byte-wise
		// continuation of the streamed watermark. `eval.ts` builds its final
		// output from `result.output.trim()`, so streamed "  indented\n"
		// becomes "indented" with *no* meta marker at all: no suffix of the
		// watermark is a prefix of the final text, `deliveredOverlap` reads
		// zero, and the rollover-resync branch fabricates a data-loss warning
		// plus a duplicate re-send of output the user is already looking at.
		// On the final frame of a call that has already streamed, a
		// non-continuation must never be reported as dropped bytes.
		const sent = new Map<string, string>();
		const options = {
			terminalMetaCapable: true,
			getMetaTerminalSent: (id: string) => sent.get(id),
			setMetaTerminalSent: (id: string, text: string) => {
				sent.set(id, text);
			},
		};
		mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-trimmed",
				toolName: "eval",
				args: { language: "python", code: "print('  indented')" },
				partialResult: { content: [{ type: "text", text: "  indented\n" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-trimmed",
				toolName: "eval",
				isError: false,
				result: { content: [{ type: "text", text: "indented" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const end = endUpdates[0]!.update as { _meta?: Record<string, unknown> };
		expect(end._meta).toEqual({
			terminal_exit: { terminal_id: "tc-trimmed", exit_code: 0, signal: null },
		});
	});

	it("does not report a discontinuity when eval substitutes '(no output)' for an all-whitespace stream", () => {
		// Regression test: the prior
		// fix only handled the final result being no
		// *longer* than the watermark. `eval.ts` also substitutes `(no
		// output)` for a stream that was all whitespace — final.length (11)
		// now *exceeds* the raw watermark's length (4, "   \n"), which the
		// growth branch unconditionally trusted as genuine new output. Zero
		// overlap between "   \n" and "(no output)" then fired the same false
		// discontinuity + duplicate re-send this whole mechanism exists to
		// prevent — just via the grow side instead of the shrink side.
		const sent = new Map<string, string>();
		const options = {
			terminalMetaCapable: true,
			getMetaTerminalSent: (id: string) => sent.get(id),
			setMetaTerminalSent: (id: string, text: string) => {
				sent.set(id, text);
			},
		};
		mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-whitespace-only",
				toolName: "eval",
				args: { language: "python", code: "print('   ')" },
				partialResult: { content: [{ type: "text", text: "   \n" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-whitespace-only",
				toolName: "eval",
				isError: false,
				result: { content: [{ type: "text", text: "(no output)" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const end = endUpdates[0]!.update as { _meta?: Record<string, unknown> };
		// No discontinuity and no re-send of the whitespace — but `(no output)`
		// itself never streamed, so `undeliveredBodyLines` delivers that one
		// line. Without it the terminal shows four spaces and stops, and the
		// substitution the producer made to explain the empty run is invisible.
		expect(end._meta).toEqual({
			terminal_output: { terminal_id: "tc-whitespace-only", data: "\n(no output)\n" },
			terminal_exit: { terminal_id: "tc-whitespace-only", exit_code: 0, signal: null },
		});
	});

	it("does not report a discontinuity when a trailing-newline mismatch survives trimming plus a synthesized exit-code suffix", () => {
		// Same class, via the other growth path Codex named: a nonzero eval's
		// trimmed output gains a synthesized "Command exited with code N"
		// suffix. The raw watermark's trailing newline count doesn't line up
		// with the trimmed+suffixed final text, so `deliveredOverlap` finds
		// zero even though the core content ("hello") is identical.
		const sent = new Map<string, string>();
		const options = {
			terminalMetaCapable: true,
			getMetaTerminalSent: (id: string) => sent.get(id),
			setMetaTerminalSent: (id: string, text: string) => {
				sent.set(id, text);
			},
		};
		mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-trailing-newlines",
				toolName: "eval",
				args: { language: "python", code: "print('hello')" },
				partialResult: { content: [{ type: "text", text: "hello\n\n\n" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-trailing-newlines",
				toolName: "eval",
				isError: true,
				result: { content: [{ type: "text", text: "hello\n\nCommand exited with code 1" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const end = endUpdates[0]!.update as { _meta?: Record<string, unknown> };
		// The already-streamed "hello" is not re-sent, but the synthesized
		// exit-code suffix is a fact this fixture declares nowhere structurally
		// (no `details.notices`), so the body reconciliation is the only thing
		// that gets it to a terminal-rendering client.
		expect(end._meta).toEqual({
			terminal_output: { terminal_id: "tc-trailing-newlines", data: "\nCommand exited with code 1\n" },
			terminal_exit: { terminal_id: "tc-trailing-newlines", signal: null },
		});
	});

	it("still diffs a genuine final-frame continuation whose growth overlaps the streamed watermark", () => {
		// The fix above must not regress the legitimate case this mechanism
		// exists to serve: real new bytes that only arrived in the final
		// snapshot (no intervening tool_execution_update saw them). "hi" is a
		// real suffix-of-watermark/prefix-of-final overlap, so this must
		// still emit just the new bytes, not fall back to notices-only.
		const sent = new Map<string, string>();
		const options = {
			terminalMetaCapable: true,
			getMetaTerminalSent: (id: string) => sent.get(id),
			setMetaTerminalSent: (id: string, text: string) => {
				sent.set(id, text);
			},
		};
		mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-genuine-tail-growth",
				toolName: "eval",
				args: { language: "python", code: "print('hi', end='')" },
				partialResult: { content: [{ type: "text", text: "hi" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-genuine-tail-growth",
				toolName: "eval",
				isError: false,
				result: { content: [{ type: "text", text: "hi\nmore" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const end = endUpdates[0]!.update as { _meta?: { terminal_output?: { data: string } } };
		expect(end._meta?.terminal_output?.data).toBe("\nmore");
	});

	it("does not diff a middle-elided final result against the raw watermark as a discontinuity", () => {
		// Same class as the column-truncation case, via the other re-render
		// mechanism named in review 4820560308: head/tail elision past the
		// artifact-spill threshold sets `details.meta.truncation`, and the
		// elided body shares no byte-for-byte suffix with the raw streamed
		// tail. The genuine facts (bytes were dropped by the *producer*, and
		// where to recover them) travel as notices, not as a fabricated
		// terminal-stream discontinuity. `meta.truncation.artifactId` matches
		// the id `details.notices` already names (both name the same spill,
		// bash.ts's own `[raw output: artifact://N]` push and the sink's own
		// `truncationFromSummary` describing the same elision) —
		// `extractTerminalNotices` must not restate it a second time in a
		// different wording.
		const sent = new Map<string, string>();
		const options = {
			terminalMetaCapable: true,
			getMetaTerminalSent: (id: string) => sent.get(id),
			setMetaTerminalSent: (id: string, text: string) => {
				sent.set(id, text);
			},
		};
		mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-elided",
				toolName: "bash",
				args: { command: "yes hello | head -c 60000" },
				partialResult: { content: [{ type: "text", text: "hello\n".repeat(10000) }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-elided",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "text", text: `${"hello\n".repeat(100)}… [elided] …\n${"hello\n".repeat(100)}` }],
					details: {
						notices: ["(output truncated)", "[raw output: artifact://7]"],
						meta: {
							truncation: {
								direction: "middle",
								truncatedBy: "middle",
								totalLines: 20000,
								totalBytes: 140000,
								outputLines: 200,
								outputBytes: 1400,
								headRange: { start: 1, end: 100 },
								tailRange: { start: 19901, end: 20000 },
								elidedBytes: 40000,
								elidedLines: 19700,
								artifactId: "7",
							},
						},
					},
				},
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const end = endUpdates[0]!.update as { _meta?: Record<string, unknown> };
		// The elided body is not re-diffed, but its elision marker is a line the
		// client never received (the head/tail lines around it did stream), so
		// the body reconciliation delivers exactly that one line ahead of the
		// notices — the marker is the only in-band statement of *where* the gap
		// is. Everything else stays suppressed: 200 already-streamed `hello`
		// lines are recognised as delivered rather than re-sent.
		expect(end._meta).toEqual({
			terminal_output: {
				terminal_id: "tc-elided",
				data: "\n… [elided] …\n\n(output truncated)\n[raw output: artifact://7]\n",
			},
			terminal_exit: { terminal_id: "tc-elided", exit_code: 0, signal: null },
		});
	});

	it("does not let a malformed diagnostics sibling re-arm the rollover/discontinuity bug on a valid truncation marker", () => {
		// Regression test: `isDisplayReRendered` used to read `meta` through the
		// all-or-nothing `asOutputMeta` — one malformed sibling field
		// (`diagnostics.messages: null` here) rejected the *entire* `meta`
		// object, discarding an otherwise-valid `truncation` marker along with
		// it. That marker only matters on the *grow* path past bash's 50 KB
		// rollover floor (`DEFAULT_MAX_BYTES`, `buildFinalMetaTerminalDelta`):
		// a middle-elided head+tail summary can be genuinely longer than the
		// live watermark it replaces (the watermark holds only the bounded
		// tail buffer's window; the elided summary retains head *and* tail),
		// and shares no byte-for-byte suffix with it. Losing the marker there
		// reclassified that re-render as a plausible rollover continuation,
		// which resynced via `deliveredOverlap` (zero, correctly, since it's
		// not a continuation) and fired a false
		// "[terminal output discontinuity]" notice plus a full re-send of the
		// already-shown body — the exact review-4824091334 bug this marker
		// exists to prevent, re-armed by an unrelated sibling's malformed
		// shape.
		const sent = new Map<string, string>();
		const options = {
			terminalMetaCapable: true,
			getMetaTerminalSent: (id: string) => sent.get(id),
			setMetaTerminalSent: (id: string, text: string) => {
				sent.set(id, text);
			},
		};
		// The live watermark: exactly bash's 50 KB rollover floor
		// (`DEFAULT_MAX_BYTES`), one repeated character so its own content
		// shares nothing with the elided summary below.
		mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-malformed-diagnostics-sibling",
				toolName: "bash",
				args: { command: "yes | head -c 51200" },
				partialResult: { content: [{ type: "text", text: "y".repeat(51200) }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const truncation = {
			direction: "middle" as const,
			truncatedBy: "middle" as const,
			totalLines: 1,
			totalBytes: 60000,
			outputLines: 2,
			outputBytes: 60000,
			headRange: { start: 1, end: 1 },
			tailRange: { start: 1, end: 1 },
			elidedBytes: 0,
			elidedLines: 0,
			artifactId: "7",
		};
		// The final result: a middle-elided head+tail summary of *different*
		// content ("a"/"b", disjoint from the watermark's "y") that totals
		// more bytes (60013) than the watermark (51200) — the grow case, past
		// the rollover floor, with zero real overlap. Only `isDisplayReRendered`
		// (via `meta.truncation`) can correctly classify this as a re-render
		// instead of a rollover.
		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-malformed-diagnostics-sibling",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "text", text: `${"a".repeat(30000)}\n… [elided] …\n${"b".repeat(30000)}` }],
					details: {
						notices: ["(output truncated)"],
						// The only difference from a well-formed result: a malformed
						// sibling next to the otherwise-valid `truncation`.
						// `messages: null` fails `isValidDiagnosticMeta` (it requires an
						// array), so this field alone must be dropped — not the whole
						// `meta`, and not the `truncation` beside it.
						meta: { truncation, diagnostics: { summary: "broken", messages: null } },
					},
				},
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const end = endUpdates[0]!.update as { _meta?: { terminal_output?: { data: string } } };
		const data = end._meta?.terminal_output?.data ?? "";
		// No false discontinuity notice.
		expect(data).not.toContain("terminal output discontinuity");
		// No duplicate re-send of the 60 KB re-rendered body: `undeliveredBodyLines`'s
		// own cap (`MAX_RECONCILED_BODY_BYTES`, 2000) refuses to reconcile a
		// divergence this large, so the delivered bytes stay at notice size —
		// nowhere near the ~60 KB a re-sent body would add.
		expect(data.length).toBeLessThan(500);
		expect(data).toBe(
			"\n(output truncated)\n\n[Showing lines 1-1 and 1-1 of 1; 0 middle lines (0B) elided. Read artifact://7 for full output]\n",
		);
	});

	it("delivers a re-rendered final body's line that the producer declared nowhere structurally", () => {
		// The class every round of this review kept re-finding one instance of:
		// a producer bakes a fact into its own text (here an `OutputSink.dump`
		// timeout annotation, prefixed onto the body and never streamed through
		// `onChunk`) and declares it in no structural field. `details` is empty
		// on purpose — a check that compares the frame against declared facts is
		// vacuous by construction here, which is exactly why the reconciliation
		// reads the authoritative body instead.
		const sent = new Map<string, string>();
		const options = {
			terminalMetaCapable: true,
			getMetaTerminalSent: (id: string) => sent.get(id),
			setMetaTerminalSent: (id: string, text: string) => {
				sent.set(id, text);
			},
		};
		mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-undeclared-annotation",
				toolName: "bash",
				args: { command: "sleep 30" },
				partialResult: { content: [{ type: "text", text: "working\n" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-undeclared-annotation",
				toolName: "bash",
				isError: true,
				result: {
					content: [{ type: "text", text: "[Command timed out after 2 seconds]\nworking\n" }],
					details: {},
				},
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const end = endUpdates[0]!.update as { _meta?: { terminal_output?: { data: string } } };
		expect(end._meta?.terminal_output?.data).toBe("\n[Command timed out after 2 seconds]\n");
	});

	it("leaves a wholesale body divergence to the existing re-render classification", () => {
		// The other half of the cap's contract: past a handful of lines the
		// difference is not an annotation but a body that diverged wholesale
		// (an elided summary whose head the producer dropped, a rolled
		// watermark). Re-delivering that is the duplicate-send bug of review
		// 4824091334 — a client concatenates whatever arrives — so the
		// reconciliation reports nothing and the frame carries facts alone.
		const sent = new Map<string, string>();
		const options = {
			terminalMetaCapable: true,
			getMetaTerminalSent: (id: string) => sent.get(id),
			setMetaTerminalSent: (id: string, text: string) => {
				sent.set(id, text);
			},
		};
		mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-wholesale-divergence",
				toolName: "bash",
				args: { command: "printf 'streamed\\n'" },
				partialResult: { content: [{ type: "text", text: "streamed\n" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const replaced = Array.from({ length: 40 }, (_, i) => `replacement line ${i}`).join("\n");
		const endUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-wholesale-divergence",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "text", text: replaced }],
					details: { notices: ["Wall time: 0.02 seconds"] },
				},
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const end = endUpdates[0]!.update as { _meta?: { terminal_output?: { data: string } } };
		expect(end._meta?.terminal_output?.data).toBe("\nWall time: 0.02 seconds\n");
	});

	it("fuzz: deliveredOverlap matches a brute-force reference across randomized byte strings", () => {
		// This function has been the single densest source of review findings
		// in this subsystem (4096-byte trial cap, in-band NUL-separator
		// collision, k===m fallback) — each caught by one hand-picked example
		// at a time. A deterministic (seeded) fuzz loop against a trivial O(n^2)
		// reference implementation covers the input space an example-based
		// suite can't anticipate: NUL bytes, multi-byte unicode, and long
		// runs of repeated characters (self-similar inputs are exactly where a
		// KMP failure-function bug hides).
		function mulberry32(seed: number): () => number {
			let state = seed;
			return () => {
				state = (state + 0x6d2b79f5) | 0;
				let t = state;
				t = Math.imul(t ^ (t >>> 15), t | 1);
				t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};
		}
		function bruteForceOverlap(sent: string, next: string): number {
			const max = Math.min(sent.length, next.length);
			for (let len = max; len > 0; len--) {
				if (sent.slice(-len) === next.slice(0, len)) return len;
			}
			return 0;
		}
		const alphabet = ["\0", "a", "b", "\n", "🎉", "é"];
		const rand = mulberry32(0x5eed);
		const randomString = (maxLen: number): string => {
			const len = Math.floor(rand() * maxLen);
			let s = "";
			for (let i = 0; i < len; i++) {
				s += alphabet[Math.floor(rand() * alphabet.length)];
			}
			return s;
		};
		for (let trial = 0; trial < 500; trial++) {
			const sent = randomString(60);
			const next = randomString(60);
			expect(deliveredOverlap(sent, next)).toBe(bruteForceOverlap(sent, next));
		}
	});

	it("fuzz: buildMetaTerminalDelta's delivered stream always ends with the current producer window", () => {
		// End-to-end simulation of a bounded tail buffer (like bash's/eval's
		// real `TailBuffer`) streaming through the mapper across many random
		// rollovers, including NUL bytes and unicode. Concatenating every
		// `_meta.terminal_output.data` byte ever delivered for a tool call must
		// always end with the producer's current visible window — the
		// append-only contract `terminal_output.data` makes to the client
		// (bytes can be appended, never replaced or erased). Breaking this
		// invariant is exactly the corruption class the overlap/rollover/NUL
		// findings kept re-discovering one fixed example at a time.
		function mulberry32(seed: number): () => number {
			let state = seed;
			return () => {
				state = (state + 0x6d2b79f5) | 0;
				let t = state;
				t = Math.imul(t ^ (t >>> 15), t | 1);
				t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};
		}
		const alphabet = ["\0", "x", "y", "\n", "🎉"];
		const rand = mulberry32(0xc0ffee);
		for (let trial = 0; trial < 30; trial++) {
			const windowSize = 40 + Math.floor(rand() * 150);
			const sent = new Map<string, string>();
			const options = {
				terminalMetaCapable: true,
				getMetaTerminalSent: (id: string) => sent.get(id),
				setMetaTerminalSent: (id: string, text: string) => {
					sent.set(id, text);
				},
			};
			const toolCallId = `tc-fuzz-delta-${trial}`;
			let trueOutput = "";
			let delivered = "";
			for (let step = 0; step < 40; step++) {
				const chunkLen = 1 + Math.floor(rand() * 25);
				let chunk = "";
				for (let c = 0; c < chunkLen; c++) {
					chunk += alphabet[Math.floor(rand() * alphabet.length)];
				}
				trueOutput += chunk;
				// Simulates a bounded producer tail buffer: only the most recent
				// `windowSize` chars survive in the snapshot the mapper sees.
				const window = trueOutput.length > windowSize ? trueOutput.slice(-windowSize) : trueOutput;
				const updates = mapUpdates(
					{
						type: "tool_execution_update",
						toolCallId,
						toolName: "bash",
						args: { command: "noisy fuzz command" },
						partialResult: { content: [{ type: "text", text: window }], details: {} },
					} as AgentSessionEvent,
					"session-1",
					options,
				);
				const data = (updates[0]!.update as { _meta?: { terminal_output?: { data: string } } })._meta
					?.terminal_output?.data;
				if (data) delivered += data;
				expect(delivered.endsWith(window)).toBe(true);
			}
		}
	});

	it("bounds the delivered watermark instead of growing it across every tail-buffer roll", () => {
		// Regression test: once the producer's tail buffer starts rolling
		// forward, `buildMetaTerminalDelta` stored `prior + delta` as the new
		// watermark on every update — the *total* history ever delivered to
		// the client, not the bounded producer window. That grows without
		// bound for a long, chatty command, and `deliveredOverlap`'s KMP scan
		// costs O(len(prior) + len(next)) per update, so it's both unbounded
		// memory and effectively quadratic CPU across the command's lifetime.
		const sent = new Map<string, string>();
		const options = {
			terminalMetaCapable: true,
			getMetaTerminalSent: (id: string) => sent.get(id),
			setMetaTerminalSent: (id: string, text: string) => {
				sent.set(id, text);
			},
		};
		const lineSize = 500;
		const windowLines = 20;
		const totalLines = 600;
		const allLines: string[] = [];
		let maxWatermarkSeen = 0;
		for (let i = 0; i < totalLines; i++) {
			allLines.push(`line ${i} ${"y".repeat(lineSize)}`);
			// Simulates the producer's own bounded tail buffer: only the most
			// recent `windowLines` survive in each snapshot, so once the window
			// fills, every later update is a genuine roll (drops the oldest
			// line, gains a new one) rather than a plain extension.
			const windowText = `${allLines.slice(-windowLines).join("\n")}\n`;
			mapUpdates(
				{
					type: "tool_execution_update",
					toolCallId: "tc-watermark-bound",
					toolName: "bash",
					args: { command: "a very noisy long-running command" },
					partialResult: { content: [{ type: "text", text: windowText }], details: {} },
				} as AgentSessionEvent,
				"session-1",
				options,
			);
			const stored = sent.get("tc-watermark-bound");
			if (stored) maxWatermarkSeen = Math.max(maxWatermarkSeen, stored.length);
		}
		// 600 lines * ~510 bytes each ≈ 306,000 bytes streamed in total, far
		// more than any single producer window — confirms rolling actually
		// happened and the watermark grew past one window's worth of content.
		expect(maxWatermarkSeen).toBeGreaterThan(windowLines * (lineSize + 10));
		// ...but never past the bound, regardless of how long the command runs.
		expect(maxWatermarkSeen).toBeLessThanOrEqual(200_000);
	});

	it("resyncs with a discontinuity notice on a non-overlapping tail rollover instead of freezing", () => {
		// Regression test: no genuine
		// overlap exists between the delivered watermark and the new snapshot —
		// a verbose command outrunning the producer's own tail-buffer window
		// between two updates is a real, recoverable case, not corruption. The
		// old behavior returned `undefined` without moving the watermark, which
		// freezes the meta terminal forever: every later snapshot keeps
		// diverging from the same stale watermark. The fix must emit a
		// discontinuity notice plus the whole new tail, and advance the
		// watermark so a later, genuinely overlapping snapshot resumes
		// delivering deltas instead of staying suppressed.
		const sent = new Map<string, string>();
		const options = {
			terminalMetaCapable: true,
			getMetaTerminalSent: (id: string) => sent.get(id),
			setMetaTerminalSent: (id: string, text: string) => {
				sent.set(id, text);
			},
		};
		mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-diverge",
				toolName: "bash",
				args: { command: "echo hi" },
				partialResult: { content: [{ type: "text", text: "alpha beta gamma" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const diverged = mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-diverge",
				toolName: "bash",
				args: { command: "echo hi" },
				partialResult: { content: [{ type: "text", text: "zzz completely unrelated" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const update = diverged[0]!.update as {
			_meta?: { terminal_output?: { terminal_id: string; data: string } };
		};
		expect(update._meta?.terminal_output).toEqual({
			terminal_id: "tc-diverge",
			data: "\n[terminal output discontinuity: earlier bytes were dropped]\nzzz completely unrelated",
		});

		// The watermark must now track the resynced snapshot, not the stale
		// pre-rollover one — a later snapshot that genuinely extends it resumes
		// delivering plain deltas instead of diverging (and resyncing) again.
		const resumed = mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-diverge",
				toolName: "bash",
				args: { command: "echo hi" },
				partialResult: { content: [{ type: "text", text: "zzz completely unrelated MORE" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const resumedUpdate = resumed[0]!.update as {
			_meta?: { terminal_output?: { terminal_id: string; data: string } };
		};
		expect(resumedUpdate._meta?.terminal_output).toEqual({
			terminal_id: "tc-diverge",
			data: " MORE",
		});
	});

	it("computes overlap correctly when both strings contain a literal NUL byte", () => {
		// Regression test: the prior
		// `deliveredOverlap` joined `sent`/`next` with an in-band `"\0"`
		// separator. Terminal output can genuinely contain NUL bytes (binary
		// commands, `find -print0`), so a real NUL in the input collided with
		// the separator: `sent = "a"`, `next = "\0a"` returned an overlap of 2
		// despite the two strings sharing no actual overlap at all, corrupting
		// the delta (`cumulativeOutput.slice(overlap)` sliced past the end).
		// The sentinel-free KMP automaton must return the correct answer (no
		// overlap) for this exact input.
		const sent = new Map<string, string>();
		const options = {
			terminalMetaCapable: true,
			getMetaTerminalSent: (id: string) => sent.get(id),
			setMetaTerminalSent: (id: string, text: string) => {
				sent.set(id, text);
			},
		};
		mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-nul",
				toolName: "bash",
				args: { command: "echo hi" },
				partialResult: { content: [{ type: "text", text: "a" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const update = mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-nul",
				toolName: "bash",
				args: { command: "echo hi" },
				partialResult: { content: [{ type: "text", text: "\0a" }], details: {} },
			} as AgentSessionEvent,
			"session-1",
			options,
		).at(0)!.update as { _meta?: { terminal_output?: { terminal_id: string; data: string } } };
		// No real overlap between "a" and "\0a": must resync with the whole new
		// tail via the discontinuity path, never a corrupted (over-sliced) delta.
		expect(update._meta?.terminal_output).toEqual({
			terminal_id: "tc-nul",
			data: "\n[terminal output discontinuity: earlier bytes were dropped]\n\u0000a",
		});
	});

	it("emits no meta-terminal output on tool_execution_update when there is no partial output yet", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-eval-progress-empty",
				toolName: "eval",
				args: { language: "py", code: "print('hi')" },
				partialResult: { content: [], details: {} },
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true },
		);
		const update = updates[0]!.update as { _meta?: unknown };
		expect("_meta" in update).toBe(false);
	});

	it("never uses the meta-terminal convention when the client didn't advertise it", () => {
		const start = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-eval-no-meta",
				toolName: "eval",
				args: { language: "py", code: "print('hi')" },
			} as AgentSessionEvent,
			"session-1",
		)[0]!.update as { content?: Array<{ type: string }>; _meta?: unknown };
		// Falls back to the existing collapsible source-echo content, not a
		// terminal reference the client couldn't render.
		expect(start.content?.some(item => item.type === "terminal")).toBe(false);
		expect("_meta" in start).toBe(false);
	});

	it("reports a captured non-zero exit code through the meta-terminal convention", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-exit-code",
				toolName: "bash",
				isError: true,
				result: {
					content: [{ type: "text", text: "boom" }],
					details: { exitCode: 7 },
				},
			} as AgentSessionEvent,
			"session-1",
			{ terminalMetaCapable: true, realTerminalCapable: false },
		);
		const update = updates[0]!.update as { _meta?: Record<string, unknown> };
		expect(update._meta).toEqual({
			terminal_output: { terminal_id: "tc-terminal-exit-code", data: "boom" },
			terminal_exit: { terminal_id: "tc-terminal-exit-code", exit_code: 7, signal: null },
		});
	});

	it("fences plain command output visible without terminal details", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-plain-output",
				toolName: "bash",
				isError: false,
				result: "hello from stdout",
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{ type: string; content?: { type: string; text?: string } }>;
		};

		expect(update.content).toEqual([
			{ type: "content", content: { type: "text", text: "```\nhello from stdout\n```" } },
		]);
	});

	it("embeds only terminal content from direct terminalId", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-direct-terminal",
				toolName: "bash",
				isError: false,
				result: { terminalId: "term-1" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{ type: string; terminalId?: string }>;
		};
		expect(update.content).toEqual([{ type: "terminal", terminalId: "term-1" }]);
	});

	it("does not duplicate existing terminal content", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-dedup",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "terminal", terminalId: "term-1" }],
					details: { terminalId: "term-1" },
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{ type: string; terminalId?: string }>;
		};
		expect(update.content?.filter(item => item.type === "terminal" && item.terminalId === "term-1")).toHaveLength(1);
	});
	it("shows the raw command as the title of a pending bash tool call, without content", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "toolu_bash_1",
				toolName: "bash",
				args: { command: "npm run check", cwd: "/repo" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			toolCallId?: string;
			title?: string;
			kind?: string;
			status?: string;
			rawInput?: unknown;
			content?: unknown;
		};
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.toolCallId).toBe("toolu_bash_1");
		expect(update.title).toBe("npm run check");
		expect(update.kind).toBe("execute");
		expect(update.status).toBe("pending");
		expect(update.rawInput).toEqual({ command: "npm run check", cwd: "/repo" });
		expect("content" in update).toBe(false);
	});

	it("maps shell and exec tool starts as execute", () => {
		for (const toolName of ["shell", "exec"] as const) {
			const updates = mapUpdates(
				{
					type: "tool_execution_start",
					toolCallId: `toolu_${toolName}_1`,
					toolName,
					args: { command: "echo hi" },
				} as AgentSessionEvent,
				"session-1",
			);

			expect(updates).toHaveLength(1);
			expectAcpNotifications(updates);
			const update = updates[0]!.update as {
				sessionUpdate: string;
				kind?: string;
				content?: unknown;
			};
			expect(update.sessionUpdate).toBe("tool_call");
			expect(update.kind).toBe("execute");
			expect("content" in update).toBe(false);
		}
	});

	it("code-fences read/grep/write output but leaves web_search prose unfenced", () => {
		const readUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-read-fence",
				toolName: "read",
				isError: false,
				result: "1:# not a heading\n2:const x = 1;",
			} as AgentSessionEvent,
			"session-1",
		);
		const grepUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-grep-fence",
				toolName: "grep",
				isError: false,
				result: "# src/foo.ts\n*3: match here",
			} as AgentSessionEvent,
			"session-1",
		);
		const writeUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-write-fence",
				toolName: "write",
				isError: false,
				result: "Successfully wrote 12 bytes to foo.txt",
			} as AgentSessionEvent,
			"session-1",
		);
		const webSearchUpdates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-web-search-no-fence",
				toolName: "web_search",
				isError: false,
				result: "# Top hit\nSome prose summary.",
			} as AgentSessionEvent,
			"session-1",
		);

		expectAcpNotifications([...readUpdates, ...grepUpdates, ...writeUpdates, ...webSearchUpdates]);
		const readUpdate = readUpdates[0]!.update as {
			content?: Array<{ type: string; content?: { type: string; text?: string } }>;
		};
		const grepUpdate = grepUpdates[0]!.update as {
			content?: Array<{ type: string; content?: { type: string; text?: string } }>;
		};
		const writeUpdate = writeUpdates[0]!.update as {
			content?: Array<{ type: string; content?: { type: string; text?: string } }>;
		};
		const webSearchUpdate = webSearchUpdates[0]!.update as {
			content?: Array<{ type: string; content?: { type: string; text?: string } }>;
		};

		expect(readUpdate.content).toEqual([
			{ type: "content", content: { type: "text", text: "```\n1:# not a heading\n2:const x = 1;\n```" } },
		]);
		expect(grepUpdate.content).toEqual([
			{ type: "content", content: { type: "text", text: "```\n# src/foo.ts\n*3: match here\n```" } },
		]);
		expect(writeUpdate.content).toEqual([
			{ type: "content", content: { type: "text", text: "```\nSuccessfully wrote 12 bytes to foo.txt\n```" } },
		]);
		// web_search results are meant to render as rich Markdown, not code.
		expect(webSearchUpdate.content).toEqual([
			{ type: "content", content: { type: "text", text: "# Top hit\nSome prose summary." } },
		]);
	});

	it("replays assistant tool_use input through the ACP dispatcher without wrapping", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-acp-replay-contract-"));
		const cwd = path.join(root, "cwd");
		const sessionDir = path.join(root, "sessions");
		const initialSessionDir = path.join(root, "initial-session");
		const updates: SessionNotification[] = [];
		const sessions: ReplayTestSession[] = [];
		const abortController = new AbortController();
		try {
			await fs.promises.mkdir(cwd, { recursive: true });
			const connection = {
				sessionUpdate: async (notification: SessionNotification) => {
					updates.push(notification);
				},
				signal: abortController.signal,
				closed: Promise.resolve(),
			} as unknown as AgentSideConnection;
			const agent = new AcpAgent(
				connection,
				async (sessionCwd: string) => {
					const session = new ReplayTestSession(sessionCwd, sessionDir);
					sessions.push(session);
					return session as unknown as AgentSession;
				},
				new ReplayTestSession(cwd, initialSessionDir) as unknown as AgentSession,
			);
			const created = await agent.newSession({ cwd, mcpServers: [] });
			const session = sessions[0]!;
			session.sessionManager.appendMessage({
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "toolu_replay_input",
						name: "bash",
						input: { command: "echo hi" },
					},
				],
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				stopReason: "stop",
				timestamp: Date.now(),
			} as unknown as Parameters<SessionManager["appendMessage"]>[0]);
			session.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "toolu_replay_input",
				toolName: "bash",
				content: [{ type: "text", text: "done" }],
				details: { terminalId: "term-replay" },
				isError: false,
				timestamp: Date.now(),
			});

			updates.length = 0;
			await agent.loadSession({ sessionId: created.sessionId, cwd, mcpServers: [] });

			expectAcpNotifications(updates);
			const toolCall = updates.find(update => update.update.sessionUpdate === "tool_call")?.update as
				| { rawInput?: unknown; content?: unknown }
				| undefined;
			const finalUpdate = updates.find(update => update.update.sessionUpdate === "tool_call_update")?.update as
				| { content?: unknown }
				| undefined;

			expect(toolCall?.rawInput).toEqual({ command: "echo hi" });
			expect(toolCall?.rawInput).not.toEqual({ input: { command: "echo hi" } });
			expect(toolCall?.content).toBeUndefined();
			// The persisted terminal id belongs to the connection that ran the
			// command, so replay shows the recorded output instead of a terminal
			// widget this client cannot resolve.
			expect(finalUpdate?.content).toEqual([{ type: "content", content: { type: "text", text: "```\ndone\n```" } }]);
		} finally {
			abortController.abort();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
	it("builds replayed bash tool calls from JSON string arguments", () => {
		const replayArgs = normalizeReplayToolArguments(JSON.stringify({ command: "npm test", cwd: "/repo" }));
		const update = buildToolCallStartUpdate({
			toolCallId: "toolu_replay_1",
			toolName: "bash",
			args: replayArgs.args,
			status: "completed",
		});

		expectAcpStructure(arkSessionNotification, { sessionId: "session-1", update });
		expect(update).toMatchObject({
			sessionUpdate: "tool_call",
			toolCallId: "toolu_replay_1",
			title: "npm test",
			kind: "execute",
			status: "completed",
			rawInput: { command: "npm test", cwd: "/repo" },
		});
		expect("content" in update).toBe(false);
	});

	it("builds replayed read tool-call locations against the replay cwd", () => {
		const replayArgs = normalizeReplayToolArguments(JSON.stringify({ path: "src/foo.ts" }));
		const update = buildToolCallStartUpdate({
			toolCallId: "toolu_replay_read",
			toolName: "read",
			args: replayArgs.args,
			cwd: path.resolve("/repo"),
			status: "completed",
		});

		expectAcpStructure(arkSessionNotification, { sessionId: "session-1", update });
		expect(update).toMatchObject({
			sessionUpdate: "tool_call",
			toolCallId: "toolu_replay_read",
			title: "read: src/foo.ts",
			kind: "read",
			status: "completed",
			rawInput: { path: "src/foo.ts" },
			locations: [{ path: path.resolve("/repo", "src/foo.ts") }],
		});
		expect("content" in update).toBe(false);
	});

	it("keeps malformed replay arguments as raw input without command content", () => {
		const replayArgs = normalizeReplayToolArguments("{not json");
		const update = buildToolCallStartUpdate({
			toolCallId: "toolu_replay_bad",
			toolName: "bash",
			args: replayArgs.args,
			status: "completed",
		});

		expectAcpStructure(arkSessionNotification, { sessionId: "session-1", update });
		expect(update).toMatchObject({
			sessionUpdate: "tool_call",
			toolCallId: "toolu_replay_bad",
			title: "bash",
			kind: "execute",
			status: "completed",
			rawInput: "{not json",
		});
		expect("content" in update).toBe(false);
	});

	it("keeps object replay arguments unchanged and builds command content", () => {
		const rawArgs = { command: "bun test", cwd: "/repo" };
		const replayArgs = normalizeReplayToolArguments(rawArgs);
		const update = buildToolCallStartUpdate({
			toolCallId: "toolu_replay_object",
			toolName: "bash",
			args: replayArgs.args,
			status: "completed",
		});

		expect(replayArgs.args).toBe(rawArgs);
		expectAcpStructure(arkSessionNotification, { sessionId: "session-1", update });
		expect(update).toMatchObject({
			title: "bun test",
			status: "completed",
			rawInput: rawArgs,
		});
		expect("content" in update).toBe(false);
	});
	it("does not add command text content to non-command tool starts", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "toolu_read_1",
				toolName: "read",
				args: { path: "README.md" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			title?: string;
			kind?: string;
			rawInput?: unknown;
			locations?: { path: string }[];
			content?: unknown;
		};
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.title).toBe("read: README.md");
		expect(update.kind).toBe("read");
		expect(update.rawInput).toEqual({ path: "README.md" });
		expect(update.locations).toEqual([{ path: "README.md" }]);
		expect("content" in update).toBe(false);
	});
	it("resolves tool_execution_start locations against mapper cwd", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "toolu_read_cwd",
				toolName: "read",
				args: { path: "src/file.ts" },
			} as AgentSessionEvent,
			"session-1",
			{ cwd: "/repo" },
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { sessionUpdate: string; locations?: { path: string }[]; content?: unknown };
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.locations).toEqual([{ path: path.resolve("/repo", "src/file.ts") }]);
		expect("content" in update).toBe(false);
	});
	it("emits distinct locations for move-style path arguments", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-move",
				toolName: "move",
				args: { path: "src/current.ts", oldPath: "src/old.ts", newPath: "src/new.ts" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { sessionUpdate: string; locations?: { path: string }[] };
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.locations).toEqual([{ path: "src/current.ts" }, { path: "src/old.ts" }, { path: "src/new.ts" }]);
	});

	it("maps xd:// device writes to an execute call with no fabricated file location", () => {
		const update = buildToolCallStartUpdate({
			toolCallId: "toolu_xd_write",
			toolName: "write",
			args: { path: "xd://github", content: '{"op":"repo_view"}' },
			cwd: path.resolve("/repo"),
		});

		expectAcpStructure(arkSessionNotification, { sessionId: "session-1", update });
		expect(update).toMatchObject({
			sessionUpdate: "tool_call",
			title: "xd://github",
			kind: "execute",
		});
		expect("locations" in update).toBe(false);
	});

	it("keeps xd:// discovery reads as read kind and plain file writes as edit", () => {
		const discovery = buildToolCallStartUpdate({
			toolCallId: "toolu_xd_read",
			toolName: "read",
			args: { path: "xd://lsp" },
		});
		expect(discovery).toMatchObject({ title: "xd://lsp", kind: "read" });
		expect("locations" in discovery).toBe(false);

		const fileWrite = buildToolCallStartUpdate({
			toolCallId: "toolu_file_write",
			toolName: "write",
			args: { path: "src/foo.ts", content: "x" },
			cwd: path.resolve("/repo"),
		});
		expect(fileWrite).toMatchObject({
			title: "write: src/foo.ts",
			kind: "edit",
			locations: [{ path: path.resolve("/repo", "src/foo.ts") }],
		});
	});

	it("rejects mutated ACP notification discriminators", () => {
		const [notification] = mapUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-schema",
				toolName: "read",
				args: { path: "package.json" },
			} as AgentSessionEvent,
			"session-1",
		);

		expectAcpStructure(arkSessionNotification, notification);
		expectAcpStructureRejects(arkSessionNotification, {
			...notification,
			update: { ...notification!.update, sessionUpdate: "tool_call_updates" },
		});
		expectAcpStructureRejects(arkSessionNotification, { ...notification, sessionId: 42 });
	});

	it("does not crash on a malformed perFileResults entry from an arbitrary tool", () => {
		// Regression test:
		// `asEditDetails` accepted any `details.perFileResults` array as long as
		// it was an array, so an extension/custom/MCP tool result carrying
		// `perFileResults: [{}]` or `[null]` — a shape no built-in edit tool
		// produces, but nothing prevents an arbitrary tool from setting — threw
		// inside `extractOutputNoticeText` (`entry.path.length` on a path-less
		// entry) or `buildDiffContent` (`entry.isError` on `null`), dropping the
		// tool's entire ACP update instead of just skipping the edit-specific
		// rendering it doesn't apply to.
		expect(() =>
			mapUpdates(
				{
					type: "tool_execution_end",
					toolCallId: "tc-malformed-per-file-empty",
					toolName: "custom_mcp_tool",
					isError: false,
					result: {
						content: [{ type: "text", text: "ok" }],
						details: { terminalId: "term-malformed", perFileResults: [{}] },
					},
				} as unknown as AgentSessionEvent,
				"session-1",
				{ terminalMetaCapable: false },
			),
		).not.toThrow();

		expect(() =>
			mapUpdates(
				{
					type: "tool_execution_end",
					toolCallId: "tc-malformed-per-file-null",
					toolName: "custom_mcp_tool",
					isError: false,
					result: {
						content: [{ type: "text", text: "ok" }],
						details: { perFileResults: [null] },
					},
				} as unknown as AgentSessionEvent,
				"session-1",
			),
		).not.toThrow();

		// Falls back to the plain-content path instead of the (skipped)
		// edit-specific diff/notice rendering.
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-malformed-per-file-fallback",
				toolName: "custom_mcp_tool",
				isError: false,
				result: { content: [{ type: "text", text: "ok" }], details: { perFileResults: [{}] } },
			} as unknown as AgentSessionEvent,
			"session-1",
		);
		const update = updates[0]!.update as { content?: { type: string; content?: { type?: string; text?: string } }[] };
		expect(update.content).toEqual([{ type: "content", content: { type: "text", text: "ok" } }]);
	});

	it("falls back to plain content for malformed edit snapshot types", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-malformed-edit-snapshot",
				toolName: "custom_mcp_tool",
				isError: false,
				result: {
					content: [{ type: "text", text: "ok" }],
					details: { perFileResults: [{ path: "x.ts", oldText: 42, newText: { bad: true } }] },
				},
			} as unknown as AgentSessionEvent,
			"session-1",
		);
		const update = updates[0]!.update as { content?: ToolCallContent[] };
		expect(update.content).toEqual([{ type: "content", content: { type: "text", text: "ok" } }]);
	});

	// A malformed `meta` costs only its notice, not the whole edit result:
	// `oldText`/`newText`/`path` feed the `diff` frame and must reject the
	// result when broken, but rejecting the details for a bad `meta` too would
	// also disarm `isDisplayReRendered`'s re-render classifier, re-arming the
	// 51 KB duplicate-delivery bug.
	it("keeps a valid diff and drops only the notice for a malformed output meta", () => {
		const updates = mapUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-malformed-edit-meta",
				toolName: "custom_mcp_tool",
				isError: false,
				result: {
					content: [{ type: "text", text: "ok" }],
					details: {
						perFileResults: [
							{
								path: "x.ts",
								oldText: "before",
								newText: "after",
								meta: { diagnostics: { summary: "broken", messages: null } },
							},
						],
					},
				},
			} as unknown as AgentSessionEvent,
			"session-1",
		);
		const update = updates[0]!.update as { content?: ToolCallContent[] };
		expect(update.content).toEqual([{ type: "diff", path: "x.ts", oldText: "before", newText: "after" }]);
	});
});
