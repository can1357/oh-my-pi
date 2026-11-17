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
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { setTranscriptPresenters } from "@oh-my-pi/pi-tui/chat/transcript-presentation";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { Component } from "@oh-my-pi/pi-tui";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme();
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

// Components the controller mounts during a dispatch (pending tool previews).
// Sealed in afterEach so their spinner intervals never outlive the test file.
const mountedComponents: Component[] = [];

function createFixture(streamingMessage: AssistantMessage) {
	const streamingComponent = new AssistantMessageComponent();
	const ctx = createInteractiveModeContext({ streamingComponent, streamingMessage });
	ctx.chatContainer.addChild(streamingComponent);
	const addChild = ctx.chatContainer.addChild.bind(ctx.chatContainer);
	vi.spyOn(ctx.chatContainer, "addChild").mockImplementation(child => {
		mountedComponents.push(child);
		addChild(child);
	});
	const controller = new EventController(ctx);
	return { controller, ctx };
}

describe("EventController reconciles streamed tool-call ids at message_end", () => {
	afterEach(() => {
		for (const component of mountedComponents.splice(0)) {
			if (component instanceof ToolExecutionComponent || component instanceof ReadToolGroupComponent)
				component.seal();
		}
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
		const cards = ctx.chatContainer.children.filter(child => child instanceof ToolExecutionComponent);
		expect(cards).toHaveLength(1);
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
		const cards = ctx.chatContainer.children.filter(child => child instanceof ToolExecutionComponent);
		expect(cards).toHaveLength(2);
		expect(cards.some(card => card === sharedCard)).toBe(true);
		expect(cards.some(card => card === splitCard)).toBe(true);

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
			expect(staleCard).toBeInstanceOf(ToolExecutionComponent);

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

			ctx.chatContainer.addChild(
				new AssistantMessageComponent(makeStreamingMessage([{ type: "text", text: "Following final answer" }])),
			);
			const history: string[] = [];
			for (let index = 0; index <= ctx.chatContainer.children.length; index++) {
				const batch = ctx.chatContainer.peekFinalizedBatch(100, 0);
				if (!batch) break;
				history.push(...batch.rows);
				ctx.chatContainer.acknowledgeFinalizedBatch(batch.id);
			}
			const renderedHistory = Bun.stripANSI(history.join("\n"));
			expect(renderedHistory).toContain("Following final answer");
			expect(renderedHistory).toContain("Recovered attempt");
			expect(renderedHistory).not.toContain("First attempt");
			expect(renderedHistory).not.toContain("stale.ts");
			expect(ctx.chatContainer.children).not.toContain(staleCard);
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
				if (!(group instanceof ReadToolGroupComponent)) throw new Error("Expected a grouped read");
				expect(ctx.pendingTools.get("discarded-read")).toBe(previewState === "mounted" ? group : undefined);
				await controller.handleEvent({
					type: "message_update",
					message: empty,
					assistantMessageEvent: { type: "start", partial: empty },
				});

				expect(Bun.stripANSI(group.render(100).join("\n"))).not.toContain("discarded.ts");
				expect(group.isTranscriptBlockFinalized()).toBe(false);
				await controller.handleEvent({
					type: "tool_execution_end",
					toolCallId: "executing-read",
					toolName: "read",
					result: { content: [{ type: "text", text: "Read completed" }], details: {} },
					isError: false,
				});
				expect(group.isTranscriptBlockFinalized()).toBe(true);
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
			const rendered = Bun.stripANSI(ctx.chatContainer.render(100).join("\n"));
			expect(rendered).toContain("Recovered assistant segment");
			expect(rendered).not.toContain("Discarded assistant segment");
		} finally {
			controller.dispose();
		}
	});

	it("hands presenters, and refreshTranscript, the migrated card's final id", async () => {
		// Regression guard: the reused card keeping its streamed id, so presenters saw `""` and a
		// refresh by the final id missed the live card.
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		setTranscriptPresenters([
			block => (block.type === "toolCall" ? { compact: { label: `ROW-${block.id}` } } : undefined),
		]);
		try {
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
			if (!(card instanceof ToolExecutionComponent)) throw new Error("Expected the streamed card");
			card.render(120);

			await controller.handleEvent({
				type: "message_end",
				message: minted,
			} as Extract<AgentSessionEvent, { type: "message_end" }>);
			expect(card.refreshTranscriptPresentation(new Set(["call_1"]))).toBe(true);
			expect(Bun.stripANSI(card.render(120).join("\n"))).toContain("ROW-call_1");
			controller.dispose();
		} finally {
			setTranscriptPresenters([]);
		}
	});
});
