/**
 * Regression: a provider whose streamed tool-call id never materializes until
 * agent-loop's `done`-time mint (`ensureUniqueToolCallIds`) surfaces the id
 * change only on the final message snapshot — the last `message_update` still
 * carries `""`, so the delta-driven `#migrateStreamedToolCallId` replay in
 * `#handleMessageUpdate` never fires and `#handleMessageEnd` must reconcile the
 * per-index ids itself. Without that replay the `""`-keyed card ghosts: it shows
 * 'running' until `#sealAbandonedForegroundTools` while `tool_execution_start`
 * under the minted id finds no card and mounts a second one — a visible ghost
 * per empty-id call, plus a lost stream preview (held under the pre-mint id).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { InteractiveModeContext, PendingTool } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isSettled } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { TranscriptBlock } from "../../../src/ui/shell";
import { initTheme } from "../../../src/ui/theme/service";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { createModeTerminal } from "../../helpers/mode-terminal";
import { blockText, transcriptText } from "../../helpers/transcript-text";

beforeAll(() => {
	initTheme();
});

function makeStreamingMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

// Contexts built by a test; their pending tool cards are sealed in afterEach.
const contexts: InteractiveModeContext[] = [];

function createFixture(streamingMessage: AssistantMessage) {
	const ctx = createInteractiveModeContext({ streamingMessage });
	ctx.streaming = ctx.presentAssistant();
	contexts.push(ctx);
	const controller = new EventController(ctx);
	return { controller, ctx };
}

/** Tool cards in the transcript. */
function cards(ctx: InteractiveModeContext): PendingTool[] {
	const found: PendingTool[] = [];
	for (const block of ctx.shell.transcript.blocks()) {
		const entry = ctx.transcriptEntry(block);
		if (entry?.kind === "tool" && entry.tool.call) found.push(entry.tool);
	}
	return found;
}

describe("EventController reconciles streamed tool-call ids at message_end", () => {
	afterEach(() => {
		for (const ctx of contexts.splice(0)) for (const tool of ctx.pendingTools.values()) tool.seal();
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("settles the streamed empty-id card under the minted id — no ghost card at execution start", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const args = { file_path: "/tmp/a.ts", content: "x" };
		// The call streams under a never-materialized id; agent-loop mints the id
		// only on the final snapshot, so no delta ever shows the change.
		const streamed = makeStreamingMessage([{ type: "toolCall", id: "", name: "write", arguments: args }]);
		const minted = makeStreamingMessage([{ type: "toolCall", id: "call_1", name: "write", arguments: args }]);
		const { controller, ctx } = createFixture(streamed);

		await controller.handleEvent({
			type: "message_update",
			message: streamed,
			assistantMessageEvent: undefined as never,
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		const streamedCard = ctx.pendingTools.get("");
		expect(streamedCard).toBeDefined();

		await controller.handleEvent({
			type: "message_end",
			message: minted,
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call_1",
			toolName: "write",
			args,
			intent: undefined,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);

		// ONE card — the streamed card migrated under the minted id and execution
		// reused it. Without the message_end reconciliation a second card mounts
		// under `call_1` and the streamed `""` card ghosts until sealed.
		expect(ctx.pendingTools.get("call_1")).toBe(streamedCard);
		expect(ctx.pendingTools.has("")).toBe(false);
		expect([...ctx.pendingTools.keys()]).toEqual(["call_1"]);
		expect(cards(ctx)).toHaveLength(1);
		controller.dispose();
	});

	it("keeps one settled card per sibling when a reused id splits at message_end", async () => {
		// Failure mode if this regresses: both siblings stream under ONE reused id
		// (`call-1`), sharing the single `pendingTools` entry. agent-loop's repair
		// re-keys the second at `done` (`call-1_dup1`), and the naive per-index
		// migration moves that one shared card to `call-1_dup1` — index 0 (still
		// `call-1`) is left with NO streamed card (reverse ghost): its args and
		// stream preview ride its sibling's card while its own card only appears
		// at `tool_execution_start`. Invariant: after message_end +
		// tool_execution_start for both siblings, exactly ONE settled card per id,
		// no ghost, and the streamed card (with its preview) is a real card of the
		// id that keeps it.
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const argsA = { file_path: "/tmp/a.ts", content: "x" };
		const argsB = { file_path: "/tmp/b.ts", content: "y" };
		const streamed = makeStreamingMessage([
			{ type: "toolCall", id: "call-1", name: "write", arguments: argsA },
			{ type: "toolCall", id: "call-1", name: "write", arguments: argsB },
		]);
		const minted = makeStreamingMessage([
			{ type: "toolCall", id: "call-1", name: "write", arguments: argsA },
			{ type: "toolCall", id: "call-1_dup1", name: "write", arguments: argsB },
		]);
		const { controller, ctx } = createFixture(streamed);

		await controller.handleEvent({
			type: "message_update",
			message: streamed,
			assistantMessageEvent: undefined as never,
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		// During streaming BOTH indices share the one `call-1` entry.
		const sharedCard = ctx.pendingTools.get("call-1");
		expect(sharedCard).toBeDefined();
		const previewSpy = vi.spyOn(sharedCard!, "updateStreamPreview");
		const argsSpy = vi.spyOn(sharedCard!, "updateArgs");
		await controller.handleEvent({
			type: "tool_stream_update",
			toolCallId: "call-1",
			update: { text: "writing" },
		} as Extract<AgentSessionEvent, { type: "tool_stream_update" }>);
		expect(previewSpy).toHaveBeenCalledWith({ text: "writing" });

		await controller.handleEvent({
			type: "message_end",
			message: minted,
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
		// The still-referenced `call-1` keeps the streamed card (with its preview);
		// the re-keyed sibling must not steal it — it picks up its own card at
		// tool_execution_start.
		expect(ctx.pendingTools.get("call-1")).toBe(sharedCard);
		expect(ctx.pendingTools.has("call-1_dup1")).toBe(false);
		// The kept card renders its own call's args — not the sibling's, which
		// was the last writer on the shared card while the id was still shared.
		expect(argsSpy).toHaveBeenLastCalledWith(argsA, "call-1");

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "write",
			args: argsA,
			intent: undefined,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call-1_dup1",
			toolName: "write",
			args: argsB,
			intent: undefined,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		const splitCard = ctx.pendingTools.get("call-1_dup1");
		expect(ctx.pendingTools.get("call-1")).toBe(sharedCard);
		expect(splitCard).toBeDefined();
		expect(splitCard).not.toBe(sharedCard);

		// Exactly one card per id in the transcript: the streamed card the kept id
		// owns, plus the card the split sibling picked up at execution start.
		const shown = cards(ctx);
		expect(shown).toHaveLength(2);
		expect(shown.some(card => card === sharedCard)).toBe(true);
		expect(shown.some(card => card === splitCard)).toBe(true);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "write",
			result: { content: [{ type: "text", text: "ok:a" }], details: {} },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call-1_dup1",
			toolName: "write",
			result: { content: [{ type: "text", text: "ok:b" }], details: {} },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		// Both siblings settled — no card stuck pending.
		expect(ctx.pendingTools.size).toBe(0);
		controller.dispose();
	});

	it("retires later output after a provider replay discards a streamed tool preview", async () => {
		await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false } });
		const staleCall = {
			type: "toolCall" as const,
			id: "discarded-attempt",
			name: "write",
			arguments: { path: "/tmp/stale.ts", content: "draft" },
		};
		const streamed = makeStreamingMessage([
			{ type: "thinking", thinking: "First attempt" },
			{ type: "thinking", thinking: "Still preparing" },
			staleCall,
		]);
		const { controller, ctx } = createFixture(streamed);
		try {
			await controller.dispatchSessionEvent({
				type: "message_update",
				message: streamed,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, partial: streamed },
			});
			// Flush the first preview before the transport retries.
			await controller.dispatchSessionEvent({
				type: "tool_stream_update",
				toolCallId: staleCall.id,
				toolName: staleCall.name,
				update: {},
			});
			const staleCard = ctx.pendingTools.get(staleCall.id);
			expect(staleCard?.call).toBeDefined();

			const restart = makeStreamingMessage([]);
			const recoveredCall = {
				type: "toolCall" as const,
				id: "recovered-attempt",
				name: "write",
				arguments: { path: "/tmp/recovered.ts", content: "complete" },
			};
			const recovered = makeStreamingMessage([{ type: "thinking", thinking: "Recovered attempt" }, recoveredCall]);
			// Agent-loop represents a second provider `start` as message_update.
			// Its empty snapshot can be coalesced away by the next delta.
			await controller.dispatchSessionEvent({
				type: "message_update",
				message: restart,
				assistantMessageEvent: { type: "start", partial: restart },
			});
			await controller.dispatchSessionEvent({
				type: "message_update",
				message: recovered,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial: recovered },
			});
			await controller.dispatchSessionEvent({ type: "message_end", message: recovered });
			await controller.dispatchSessionEvent({
				type: "tool_execution_start",
				toolCallId: recoveredCall.id,
				toolName: recoveredCall.name,
				args: recoveredCall.arguments,
			});
			await controller.dispatchSessionEvent({
				type: "tool_execution_end",
				toolCallId: recoveredCall.id,
				toolName: recoveredCall.name,
				result: { content: [{ type: "text", text: "Written" }], details: {} },
				isError: false,
			});

			ctx.presentAssistant(makeStreamingMessage([{ type: "text", text: "Following final answer" }]));
			// A finished reply settles on the next microtask.
			await Promise.resolve();
			// Nothing pins retirement: every block is settled, so the terminal can move all of
			// them into scrollback.
			for (const block of ctx.shell.transcript.blocks()) expect(isSettled(block.node)).toBe(true);
			const rendered = transcriptText(ctx.shell, 100);
			expect(rendered).toContain("Following final answer");
			expect(rendered).toContain("Recovered attempt");
			expect(rendered).not.toContain("First attempt");
			expect(rendered).not.toContain("stale.ts");
			expect(ctx.shell.transcript.blocks()).not.toContain(staleCard!.block);
			expect(ctx.pendingTools.size).toBe(0);
		} finally {
			controller.dispose();
		}
	});

	it.each(["mounted", "deferred"] as const)(
		"retires a running read after replay drops its %s sibling preview",
		async previewState => {
			await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false } });
			const empty = makeStreamingMessage([]);
			const { controller, ctx } = createFixture(empty);
			try {
				const preview = makeStreamingMessage([
					{ type: "toolCall", id: "executing-read", name: "read", arguments: { path: "/tmp/running.ts" } },
					{
						type: "toolCall",
						id: "discarded-read",
						name: "read",
						arguments: previewState === "mounted" ? { path: "/tmp/discarded.ts" } : {},
					},
				]);
				await controller.handleEvent({
					type: "message_update",
					message: preview,
					assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial: preview },
				});
				await controller.handleEvent({
					type: "tool_execution_start",
					toolCallId: "executing-read",
					toolName: "read",
					args: { path: "/tmp/running.ts" },
				});
				const group = ctx.pendingTools.get("executing-read");
				if (!group?.group) throw new Error("Expected a grouped read");
				expect(ctx.pendingTools.get("discarded-read")).toBe(previewState === "mounted" ? group : undefined);
				await controller.handleEvent({
					type: "message_update",
					message: empty,
					assistantMessageEvent: { type: "start", partial: empty },
				});

				expect(blockText(group.block, 100)).not.toContain("discarded.ts");
				expect(isSettled(group.block.node)).toBe(false);
				await controller.handleEvent({
					type: "tool_execution_end",
					toolCallId: "executing-read",
					toolName: "read",
					result: { content: [{ type: "text", text: "Read completed" }], details: {} },
					isError: false,
				});
				expect(isSettled(group.block.node)).toBe(true);
				expect(ctx.pendingTools.size).toBe(0);
			} finally {
				controller.dispose();
			}
		},
	);

	it("replaces post-tool text when a replay reuses an id whose preview card was deferred", async () => {
		await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false } });
		const empty = makeStreamingMessage([]);
		const { controller, ctx } = createFixture(empty);
		try {
			const abandoned = makeStreamingMessage([
				{ type: "toolCall", id: "reused-read", name: "read", arguments: {} },
				{ type: "text", text: "Discarded assistant segment" },
			]);
			await controller.handleEvent({
				type: "message_update",
				message: abandoned,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 1,
					delta: "Discarded assistant segment",
					partial: abandoned,
				},
			});
			expect(ctx.pendingTools.has("reused-read")).toBe(false);
			await controller.handleEvent({
				type: "message_update",
				message: empty,
				assistantMessageEvent: { type: "start", partial: empty },
			});
			const recovered = makeStreamingMessage([
				{ type: "toolCall", id: "reused-read", name: "read", arguments: { path: "/tmp/recovered.ts" } },
				{ type: "text", text: "Recovered assistant segment" },
			]);
			await controller.handleEvent({
				type: "message_update",
				message: recovered,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 1,
					delta: "Recovered assistant segment",
					partial: recovered,
				},
			});
			const rendered = transcriptText(ctx.shell, 100);
			expect(rendered).toContain("Recovered assistant segment");
			expect(rendered).not.toContain("Discarded assistant segment");
		} finally {
			controller.dispose();
		}
	});

	it("hands the migrated card its final id, so presenters and refreshes see it", async () => {
		// Regression guard: the reused card keeping its streamed id, so presenters saw `""` and a
		// refresh by the final id missed the live card.
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const args = { file_path: "/tmp/a.ts", content: "x" };
		const streamed = makeStreamingMessage([{ type: "toolCall", id: "", name: "write", arguments: args }]);
		const minted = makeStreamingMessage([{ type: "toolCall", id: "call_1", name: "write", arguments: args }]);
		const { controller, ctx } = createFixture(streamed);
		await controller.handleEvent({
			type: "message_update",
			message: streamed,
			assistantMessageEvent: undefined as never,
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		const card = ctx.pendingTools.get("");
		if (!card?.rename) throw new Error("Expected the streamed card");
		const rename = vi.spyOn(card, "rename");

		await controller.handleEvent({ type: "message_end", message: minted } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		expect(rename).toHaveBeenCalledWith("call_1");
		expect(ctx.pendingTools.get("call_1")).toBe(card);
		controller.dispose();
	});
});

describe("InteractiveMode re-keys a streamed tool card when its id changes mid-stream", () => {
	const CMD = "which psql";
	const READ_PATH = "src/index.ts";

	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let settingsDir: TempDir;

	function bashToolCall(id: string): ToolCall {
		return { type: "toolCall", id, name: "bash", arguments: { command: CMD } };
	}

	function toolUseMessage(content: AssistantMessage["content"]): AssistantMessage {
		return { ...makeStreamingMessage(content), stopReason: "toolUse" };
	}

	/** Transcript blocks whose painted rows contain `text`. */
	function blocksShowing(text: string): TranscriptBlock[] {
		return mode.shell.transcript.blocks().filter(block => blockText(block).includes(text));
	}

	beforeAll(async () => {
		resetSettingsForTest();
		settingsDir = TempDir.createSync("@pi-streamed-tool-id-settings-");
		await Settings.init({ inMemory: true, cwd: settingsDir.path() });
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-streamed-tool-id-");
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		// The session is constructed with no tools; bash is a built-in in real
		// sessions, so provenance-gated rendering must treat it as one here.
		vi.spyOn(session, "hasBuiltInTool").mockReturnValue(true);
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			createModeTerminal().frame,
		);
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		tempDir?.removeSync();
	});

	afterAll(() => {
		authStorage.close();
		settingsDir.removeSync();
		resetSettingsForTest();
	});

	async function runToolCallToCompletion(id: string): Promise<void> {
		const ec = mode.eventController;
		await ec.handleEvent({
			type: "tool_execution_start",
			toolCallId: id,
			toolName: "bash",
			args: { command: CMD },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await ec.handleEvent({
			type: "tool_execution_end",
			toolCallId: id,
			toolName: "bash",
			result: { content: [{ type: "text", text: "(no output)" }] },
			isError: true,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await ec.handleEvent({ type: "message_end", message: toolUseMessage([bashToolCall(id)]) } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
	}

	it("re-keys a streamed tool card when its id is populated after the block appears", async () => {
		const ec = mode.eventController;
		await ec.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		await ec.handleEvent({ type: "message_start", message: toolUseMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		// Provider (e.g. GitHub Copilot) streams the tool block before its id: the
		// first delta carries an empty id, a later delta populates it.
		await ec.handleEvent({
			type: "message_update",
			message: toolUseMessage([bashToolCall("")]),
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial: toolUseMessage([bashToolCall("")]),
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		expect(blocksShowing(CMD)).toHaveLength(1);
		await ec.handleEvent({
			type: "message_update",
			message: toolUseMessage([bashToolCall("call-real")]),
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "{}",
				partial: toolUseMessage([bashToolCall("call-real")]),
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		// The populated id must reuse the existing card, not spawn a second one.
		expect(blocksShowing(CMD)).toHaveLength(1);
		await ec.handleEvent({
			type: "message_end",
			message: toolUseMessage([bashToolCall("call-real")]),
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
		await runToolCallToCompletion("call-real");
		expect(blocksShowing(CMD)).toHaveLength(1);
		// The result routes into the surviving card (no orphaned pending preview).
		expect(transcriptText(mode.shell)).toContain("(no output)");
	});

	it("re-keys a grouped read when its id is populated after the block appears", async () => {
		const ec = mode.eventController;
		const readAt = (id: string): ToolCall => ({
			type: "toolCall",
			id,
			name: "read",
			arguments: { path: READ_PATH, i: "Inspect entrypoint" },
		});
		await ec.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		await ec.handleEvent({ type: "message_start", message: toolUseMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await ec.handleEvent({
			type: "message_update",
			message: toolUseMessage([readAt("")]),
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial: toolUseMessage([readAt("")]),
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await ec.handleEvent({
			type: "message_update",
			message: toolUseMessage([readAt("read-real")]),
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "{}",
				partial: toolUseMessage([readAt("read-real")]),
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);

		expect(mode.pendingTools.has("")).toBeFalse();
		expect(mode.pendingTools.has("read-real")).toBeTrue();
		expect(blocksShowing(READ_PATH)).toHaveLength(1);
	});

	it("re-keys a streamed tool card when its id grows across deltas (piped copilot id)", async () => {
		const ec = mode.eventController;
		await ec.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		await ec.handleEvent({ type: "message_start", message: toolUseMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await ec.handleEvent({
			type: "message_update",
			message: toolUseMessage([bashToolCall("call-x")]),
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial: toolUseMessage([bashToolCall("call-x")]),
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await ec.handleEvent({
			type: "message_update",
			message: toolUseMessage([bashToolCall("call-x|abc123==")]),
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "{}",
				partial: toolUseMessage([bashToolCall("call-x|abc123==")]),
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		expect(blocksShowing(CMD)).toHaveLength(1);
		await ec.handleEvent({
			type: "message_end",
			message: toolUseMessage([bashToolCall("call-x|abc123==")]),
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
		await runToolCallToCompletion("call-x|abc123==");
		expect(blocksShowing(CMD)).toHaveLength(1);
	});

	it("settles a held server-resolved completion after the tool-call id is re-keyed", async () => {
		const ec = mode.eventController;
		const todoAt = (id: string): ToolCall => ({ type: "toolCall", id, name: "todo", arguments: {} });
		await ec.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		await ec.handleEvent({ type: "message_start", message: toolUseMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		// The todo block streams before its id (placeholder empty id).
		await ec.handleEvent({
			type: "message_update",
			message: toolUseMessage([todoAt("")]),
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				partial: toolUseMessage([todoAt("")]),
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		// A server-resolved completion (Cursor todo) arrives under the REAL id
		// before the id delta — no card is keyed by it yet, so it is held.
		await ec.handleEvent({
			type: "tool_execution_end",
			toolCallId: "todo-real",
			toolName: "todo",
			result: { content: [{ type: "text", text: "todo done" }], details: { phases: [] } },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		expect(mode.pendingTools.has("todo-real")).toBeFalse();

		// A later delta fills the real id: the re-key must consume the held
		// completion and settle the migrated card, not leave it pending.
		await ec.handleEvent({
			type: "message_update",
			message: toolUseMessage([todoAt("todo-real")]),
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: "{}",
				partial: toolUseMessage([todoAt("todo-real")]),
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		expect(mode.pendingTools.has("todo-real")).toBeFalse();
		expect(mode.pendingTools.has("")).toBeFalse();
	});
});
