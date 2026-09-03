/**
 * Contract: while a tool call's arguments stream (`partialJson` still open),
 * the pending tool preview is paced by ToolArgsRevealController — frames carry
 * growing prefixes of the raw stream re-parsed into display args — and once
 * the JSON closes the final parsed arguments render as-is (snap), mirroring
 * how assistant text snaps at message_end.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { kStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { STREAMING_REVEAL_FRAME_MS } from "@oh-my-pi/pi-coding-agent/modes/controllers/streaming-reveal";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

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

function createFixture(streamingMessage: AssistantMessage, tool?: AgentTool) {
	const pendingTools = new Map<string, ToolExecutionComponent>();
	let approvalWaiter: ((toolCallId: string) => Promise<void>) | undefined;
	const extensionRunner = {
		setToolApprovalPreviewWaiter(waiter: (toolCallId: string) => Promise<void>) {
			approvalWaiter = waiter;
			return () => {
				if (approvalWaiter === waiter) approvalWaiter = undefined;
			};
		},
	};
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		settings,
		statusLine: { invalidate: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		streamingComponent: { updateContent: vi.fn(), markTranscriptBlockFinalized: vi.fn() },
		streamingMessage,
		transcriptMessageComponents: new WeakMap(),
		pendingTools,
		noteDisplayableThinkingContent: vi.fn(() => false),
		chatContainer: { addChild: vi.fn() },
		toolOutputExpanded: false,
		session: { getToolByName: () => tool, hasBuiltInTool: () => true, extensionRunner },
		viewSession: { getToolByName: () => tool, hasBuiltInTool: () => true },
		sessionManager: { getCwd: () => process.cwd() },
	} as unknown as InteractiveModeContext;

	return {
		controller: new EventController(ctx),
		pendingTools,
		getApprovalWaiter: () => approvalWaiter,
	};
}

async function dispatch(controller: EventController, message: AssistantMessage) {
	const event = {
		type: "message_update",
		message,
		assistantMessageEvent: undefined as never,
	} as Extract<AgentSessionEvent, { type: "message_update" }>;
	await controller.handleEvent(event);
}

async function dispatchToolStart(
	controller: EventController,
	payload: { toolCallId: string; toolName: string; args: Record<string, unknown> },
) {
	await controller.handleEvent({
		type: "tool_execution_start",
		toolCallId: payload.toolCallId,
		toolName: payload.toolName,
		args: payload.args,
	} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
}

describe("EventController paces streamed tool args", () => {
	afterEach(() => {
		vi.useRealTimers();
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("reveals the initial slice immediately, then paces growth across message_updates", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		vi.useFakeTimers();
		const updateArgsSpy = vi.spyOn(ToolExecutionComponent.prototype, "updateArgs");
		const content = "x".repeat(400);
		const target = `{"path":"/tmp/a.ts","content":"${content}"}`;
		// Seed includes the complete `path` field (closing quote at byte 20) plus
		// the opening of `content`, so the rendered preview must show the real
		// path on the very first dispatch.
		const seed = target.slice(0, 35);

		// First message_update: only a small slice has arrived. The reveal
		// MUST surface it as-is (no empty initial frame).
		const seedStreaming = makeStreamingMessage([
			{ type: "toolCall", id: "tc-1", name: "write", arguments: {}, [kStreamingPartialJson]: seed },
		]);
		const { controller, pendingTools } = createFixture(seedStreaming);
		await dispatch(controller, seedStreaming);
		expect(pendingTools.size).toBe(1);

		// Component constructor consumes the initial render args directly; no
		// updateArgs has been invoked yet, but the seeded prefix is already on
		// the pending preview.
		const componentRender = pendingTools.get("tc-1")!.render(80).join("\n");
		expect(Bun.stripANSI(componentRender)).toContain("/tmp/a.ts");

		// Second message_update: the rest of the payload arrives. The controller
		// paces the new backlog through reveal ticks.
		const fullStreaming = makeStreamingMessage([
			{ type: "toolCall", id: "tc-1", name: "write", arguments: {}, [kStreamingPartialJson]: target },
		]);
		await dispatch(controller, fullStreaming);

		for (let i = 0; i < 3; i++) {
			vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS);
		}
		const pacedFrames = updateArgsSpy.mock.calls.map(call => call[0] as Record<string, unknown>);
		expect(pacedFrames.length).toBeGreaterThan(0);
		let previousLength = seed.length;
		for (const frame of pacedFrames) {
			const prefix = frame.__partialJson;
			if (typeof prefix !== "string") throw new Error("Expected __partialJson string on paced frame");
			expect(target.startsWith(prefix)).toBe(true);
			expect(prefix.length).toBeLessThan(target.length);
			expect(prefix.length).toBeGreaterThanOrEqual(previousLength);
			previousLength = prefix.length;
		}

		// The JSON closed: providers drop `partialJson` and deliver final args.
		const finalArgs = { path: "/tmp/a.ts", content };
		await dispatch(
			controller,
			makeStreamingMessage([{ type: "toolCall", id: "tc-1", name: "write", arguments: finalArgs }]),
		);
		expect(updateArgsSpy.mock.calls.at(-1)?.[0]).toBe(finalArgs);

		// The reveal entry is gone: no further paced frames tick in.
		const calls = updateArgsSpy.mock.calls.length;
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 5);
		expect(updateArgsSpy.mock.calls.length).toBe(calls);
	});

	it("streams the full target through unpaced when smoothing is disabled", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		settings.set("display.smoothStreaming", false);
		vi.useFakeTimers();
		const updateArgsSpy = vi.spyOn(ToolExecutionComponent.prototype, "updateArgs");
		const target = `{"path":"/tmp/a.ts","content":"abc"}`;
		const streaming = makeStreamingMessage([
			{
				type: "toolCall",
				id: "tc-1",
				name: "write",
				arguments: { path: "/tmp/a.ts" },
				[kStreamingPartialJson]: target,
			},
		]);
		const { controller } = createFixture(streaming);

		await dispatch(controller, streaming);
		await dispatch(controller, streaming);

		const frame = updateArgsSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		expect(frame.__partialJson).toBe(target);
		const calls = updateArgsSpy.mock.calls.length;
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 5);
		expect(updateArgsSpy.mock.calls.length).toBe(calls);
	});

	it("reconciles validated full args on tool_execution_start when the closing args update never lands", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		vi.useFakeTimers();
		const content = "y".repeat(50);
		const target = `{"path":"/tmp/exec.ts","content":"${content}"}`;
		const streaming = makeStreamingMessage([
			{ type: "toolCall", id: "tc-1", name: "write", arguments: {}, [kStreamingPartialJson]: target },
		]);
		const { controller, pendingTools } = createFixture(streaming);

		// Args still streaming, but the reveal now seeds the preview with the
		// full available partialJson on the very first message_update — so the
		// path is already visible before the tool starts executing.
		await dispatch(controller, streaming);
		const component = pendingTools.get("tc-1");
		if (!component) throw new Error("expected a pending write component");
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("/tmp/exec.ts");

		// The closing full-args message_update never arrives (throttled `arguments`
		// with smoothing off, an owned-dialect projector, or a superseded turn that
		// still runs the call). The tool executes anyway: tool_execution_start is the
		// one event every path emits with the validated args, so it must reconcile.
		await dispatchToolStart(controller, {
			toolCallId: "tc-1",
			toolName: "write",
			args: { path: "/tmp/exec.ts", content },
		});
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("/tmp/exec.ts");

		// The reveal entry was cancelled: a late tick cannot re-truncate the body
		// back to a streaming prefix.
		vi.advanceTimersByTime(STREAMING_REVEAL_FRAME_MS * 5);
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("/tmp/exec.ts");
	});
	it("holds approval until the native final edit preview is ready", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const args = {
			path: "/tmp/approval.ts",
			old_string: "old",
			new_string: "ISSUE_7957_PROPOSED_EDIT",
		};
		const streaming = makeStreamingMessage([{ type: "toolCall", id: "tc-approval", name: "edit", arguments: args }]);
		const tool = { mode: "replace" } as unknown as AgentTool;
		const { controller, pendingTools, getApprovalWaiter } = createFixture(streaming, tool);

		await controller.handleEvent({
			type: "tool_stream_update",
			toolCallId: "tc-approval",
			toolName: "edit",
			update: {
				generation: 1,
				streaming: true,
				files: [
					{
						path: "/tmp/approval.ts",
						diff: "@@ -1 +1 @@\n-old\n+ISSUE_7957_PROPOSED_EDIT",
						firstChangedLine: 1,
					},
				],
			},
		});
		await dispatch(controller, streaming);

		const waiter = getApprovalWaiter();
		if (!waiter) throw new Error("expected the TUI approval-preview waiter");
		let approvalReady = false;
		const waiting = waiter("tc-approval").then(() => {
			approvalReady = true;
		});
		await dispatchToolStart(controller, {
			toolCallId: "tc-approval",
			toolName: "edit",
			args,
		});
		await Promise.resolve();
		expect(approvalReady).toBe(false);

		await controller.handleEvent({
			type: "tool_stream_update",
			toolCallId: "tc-approval",
			toolName: "edit",
			update: {
				generation: 2,
				streaming: false,
				files: [
					{
						path: "/tmp/approval.ts",
						diff: "@@ -1 +1 @@\n-old\n+ISSUE_7957_PROPOSED_EDIT",
						firstChangedLine: 1,
					},
				],
			},
		});
		await waiting;
		const rendered = pendingTools.get("tc-approval")?.render(100).join("\n") ?? "";
		expect(Bun.stripANSI(rendered)).toContain("ISSUE_7957_PROPOSED_EDIT");
	});
});
