/**
 * Contract: renderInitialMessages renders the collapsed live DISPLAY TRANSCRIPT,
 * not the LLM context. The transcript comes from
 * `session.buildTranscriptSessionContext({ collapseCompactedHistory: true })`;
 * `sessionManager.buildSessionContext()` — the LLM-context builder — must not be
 * consulted for display.
 *
 * Also guards the cold-launch terminal cleanup: `omp` / `omp -c` leave the
 * previous run's transcript in native scrollback because the TUI's initial
 * paint preserves it, so the cold-launch render must request a
 * scrollback-clearing repaint (`clearTerminalHistory`).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Usage } from "@oh-my-pi/pi-ai";
import { kStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext, RenderSessionContextOptions } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext, StrippedToolCallsMarker } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type Component, Container, Image, ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	// afterEach resets Settings, but renderInitialMessages reads the global
	// Settings (display.collapseCompacted) — re-init before every test.
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

const originalImageProtocol = TERMINAL.imageProtocol;

afterEach(() => {
	resetSettingsForTest();
	setTerminalImageProtocol(originalImageProtocol);
	vi.restoreAllMocks();
});

function makeEmptyContext(): SessionContext {
	return {
		messages: [],
		thinkingLevel: "off",
		serviceTier: undefined,
		models: {},
		injectedTtsrRules: [],
		mode: "none",
	};
}

interface RenderInitialMessagesTestContext {
	ctx: InteractiveModeContext;
	transcriptSpy: Mock<(options?: { collapseCompactedHistory?: boolean }) => SessionContext>;
	llmContextSpy: Mock<() => SessionContext>;
	renderSessionContextSpy: Mock<(...args: unknown[]) => Promise<void>>;
}

/** Build a minimal InteractiveModeContext mock, returning spies for assertions. */
function makeCtx(): RenderInitialMessagesTestContext {
	const transcriptSpy = vi.fn(() => makeEmptyContext());
	const llmContextSpy = vi.fn(() => makeEmptyContext());
	const renderSessionContextSpy = vi.fn(async () => {});
	const chatContainer = new TranscriptContainer();

	const ctx = {
		chatContainer,
		pendingMessagesContainer: { clear: vi.fn(), disposeChildren: vi.fn() },
		pendingBashComponents: [],
		pendingPythonComponents: [],
		transcriptMessageComponents: new WeakMap<AgentMessage, Component>(),
		pendingTools: new Map(),
		hideToolActivity: false,
		initialChatRendered: true,
		session: { buildTranscriptSessionContext: transcriptSpy },
		viewSession: {
			buildTranscriptSessionContext: transcriptSpy,
			hasBuiltInTool: () => true,
			sessionManager: {
				buildSessionContext: llmContextSpy,
				getEntries: vi.fn(() => []),
				getCwd: vi.fn(() => "/tmp"),
			},
		},
		sessionManager: {
			buildSessionContext: llmContextSpy,
			getEntries: vi.fn(() => []),
			getCwd: vi.fn(() => "/tmp"),
		},
		renderSessionContextIncrementally: renderSessionContextSpy,
		showStatus: vi.fn(),
		ui: { requestRender: vi.fn() },
		resetTranscript: () => ctx.chatContainer.disposeChildren(),
	} as unknown as InteractiveModeContext;

	return { ctx, transcriptSpy, llmContextSpy, renderSessionContextSpy };
}

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const pngImage: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	mimeType: "image/png",
};

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet",
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function transcriptWith(messages: AgentMessage[]): SessionContext {
	return { ...makeEmptyContext(), messages };
}

function countImageComponents(component: Component): number {
	const own = component instanceof Image ? 1 : 0;
	if (!("children" in component) || !Array.isArray(component.children)) return own;
	return own + component.children.reduce((count, child) => count + countImageComponents(child), 0);
}

function hasImageComponent(component: Component): boolean {
	return countImageComponents(component) > 0;
}

function makeRenderCtx(
	transcript: SessionContext,
	showImages = true,
	hideToolActivity = false,
): { ctx: InteractiveModeContext; chatContainer: TranscriptContainer } {
	const chatContainer = new TranscriptContainer();
	chatContainer.setToolActivityVisible(!hideToolActivity);
	const ctx = {
		chatContainer,
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
		pendingPythonComponents: [],
		transcriptMessageComponents: new WeakMap<AgentMessage, Component>(),
		pendingTools: new Map(),
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		updateEditorTopBorder: vi.fn(),
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn(), imageBudget: undefined },
		resetTranscript: () => {
			ctx.transcriptMessageComponents = new WeakMap<AgentMessage, Component>();
			ctx.chatContainer.disposeChildren();
		},
		present: (content: Component | readonly Component[]) => {
			const components = Array.isArray(content) ? content : [content];
			for (const component of components) ctx.chatContainer.addChild(component);
		},
		// Rebuild paths honor terminal.showImages since the native-image work;
		// keep it on so the image-replay contracts below stay meaningful.
		settings: {
			get: (key: string) => {
				if (key === "terminal.showImages") return showImages;
				if (key === "display.hideToolActivity") return hideToolActivity;
				return false;
			},
		},
		toolOutputExpanded: false,
		hideToolActivity,
		hideThinkingBlock: false,
		focusedAgentId: undefined,
		editor: { addToHistory: vi.fn() },
		viewSession: {
			buildTranscriptSessionContext: () => transcript,
			getToolByName: () => undefined,
			hasBuiltInTool: () => true,
			extensionRunner: undefined,
			sessionManager: {
				getEntries: vi.fn(() => []),
				getCwd: vi.fn(() => "/tmp"),
				putBlobSync: vi.fn(() => ({
					hash: "hash",
					path: "/tmp/hash",
					displayPath: "/tmp/hash.png",
					ref: "blob:sha256:hash",
				})),
			},
		},
		sessionManager: {
			getEntries: vi.fn(() => []),
			getCwd: vi.fn(() => "/tmp"),
			putBlobSync: vi.fn(() => ({
				hash: "hash",
				path: "/tmp/hash",
				displayPath: "/tmp/hash.png",
				ref: "blob:sha256:hash",
			})),
		},
		addMessageToChat: (message: AgentMessage, options?: { imageLinks?: readonly (string | undefined)[] }) =>
			helpers.addMessageToChat(message, options),
		getUserMessageText: (message: Message) => helpers.getUserMessageText(message),
		renderSessionContext: (context: SessionContext, options?: RenderSessionContextOptions) =>
			helpers.renderSessionContext(context, options),
		renderSessionContextIncrementally: (
			context: SessionContext,
			options: RenderSessionContextOptions,
			renderChunk?: () => void,
		) => helpers.renderSessionContextIncrementally(context, options, renderChunk),
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	return { ctx, chatContainer };
}

describe("UiHelpers.renderInitialMessages — transcript source", () => {
	it("renders the collapsed live display transcript, never the LLM context", async () => {
		await Settings.init({ inMemory: true });
		const { ctx, transcriptSpy, llmContextSpy, renderSessionContextSpy } = makeCtx();
		const transcript = makeEmptyContext();
		transcriptSpy.mockReturnValue(transcript);

		await new UiHelpers(ctx).renderInitialMessages();

		expect(transcriptSpy).toHaveBeenCalledWith({ collapseCompactedHistory: true });
		expect(llmContextSpy).not.toHaveBeenCalled();
		expect(renderSessionContextSpy).toHaveBeenCalledWith(transcript, {
			updateFooter: true,
		});
	});
});

describe("UiHelpers.renderInitialMessages — clearTerminalHistory", () => {
	it("requests a scrollback-clearing repaint when clearTerminalHistory is set", async () => {
		await Settings.init({ inMemory: true });
		const { ctx } = makeCtx();
		await new UiHelpers(ctx).renderInitialMessages({ clearTerminalHistory: true });
		expect(ctx.ui.requestRender).toHaveBeenCalledWith(true, { clearScrollback: true });
	});

	it("never clears scrollback when clearTerminalHistory is unset", async () => {
		await Settings.init({ inMemory: true });
		const { ctx } = makeCtx();
		await new UiHelpers(ctx).renderInitialMessages();
		const clearedCall = (ctx.ui.requestRender as Mock<(...a: unknown[]) => void>).mock.calls.find(
			([force, opts]) => force === true && (opts as { clearScrollback?: boolean } | undefined)?.clearScrollback,
		);
		expect(clearedCall).toBeUndefined();
	});
});

describe("UiHelpers.renderInitialMessages — responsiveness", () => {
	// Count the chunk boundaries an idle rebuild produces: each boundary calls
	// `renderChunk` and then awaits a macrotask, so a positive count proves the
	// rebuild handed control back to the event loop mid-replay instead of
	// running as one uninterruptible turn. Drives `renderSessionContextIncrementally`
	// directly (the layer that owns the chunk counter) so the assertion is
	// deterministic and never races a timer.
	async function countRebuildChunks(messages: AgentMessage[]): Promise<number> {
		const transcript = transcriptWith(messages);
		const { ctx } = makeRenderCtx(transcript);
		let chunks = 0;
		await new UiHelpers(ctx).renderSessionContextIncrementally(transcript, { updateFooter: true }, () => {
			chunks++;
		});
		return chunks;
	}

	it("splits a large plain transcript rebuild across event-loop turns", async () => {
		await Settings.init({ inMemory: true });
		const messages: AgentMessage[] = Array.from({ length: 256 }, (_, index) => ({
			role: "user",
			content: `message ${index}`,
			timestamp: index,
		}));
		expect(await countRebuildChunks(messages)).toBeGreaterThan(0);
	});

	it("keeps the complete transcript visible until an incremental replacement is ready", async () => {
		await Settings.init({ inMemory: true });
		const messages: AgentMessage[] = Array.from({ length: 256 }, (_, index) => ({
			role: "user",
			content: `replacement ${index}`,
			timestamp: index,
		}));
		const { ctx, chatContainer } = makeRenderCtx(transcriptWith(messages));
		const helpers = new UiHelpers(ctx);
		helpers.addMessageToChat({
			role: "user",
			content: "VISIBLE_OLD_TRANSCRIPT",
			timestamp: -1,
		});
		const requestRender = ctx.ui.requestRender as Mock<(...args: unknown[]) => void>;

		const replay = helpers.renderInitialMessages({ clearTerminalHistory: true });

		const duringReplay = Bun.stripANSI(chatContainer.render(100).join("\n"));
		expect(duringReplay).toContain("VISIBLE_OLD_TRANSCRIPT");
		expect(duringReplay).not.toContain("replacement 0");
		expect(requestRender.mock.calls.some(([force]) => force === true)).toBeFalse();

		await replay;

		const afterReplay = Bun.stripANSI(chatContainer.render(100).join("\n"));
		expect(afterReplay).not.toContain("VISIBLE_OLD_TRANSCRIPT");
		expect(afterReplay).toContain("replacement 255");
		expect(requestRender.mock.calls.filter(([force]) => force === true)).toEqual([[true, { clearScrollback: true }]]);
	});

	it("yields across a large parallel read-result batch", async () => {
		// Regression: a single assistant turn whose results are all grouped `read`
		// toolResults replays entirely through the `isReadGroupResult` early
		// `continue`. A trailing per-message yield is skipped by every one of
		// those results, so the whole batch would rebuild in one uninterruptible
		// event-loop turn and the chunk counter would never trip (zero chunks).
		// The top-of-loop yield must still hand control back between results.
		await Settings.init({ inMemory: true });
		const readCalls = Array.from({ length: 128 }, (_, index) => ({
			type: "toolCall" as const,
			id: `read-${index}`,
			name: "read",
			arguments: { path: `src/file-${index}.ts` },
		}));
		const assistant: AssistantMessage = {
			role: "assistant",
			content: readCalls,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const messages: AgentMessage[] = [assistant];
		for (let index = 0; index < 128; index++) {
			messages.push({
				role: "toolResult",
				toolCallId: `read-${index}`,
				toolName: "read",
				content: [{ type: "text", text: `contents ${index}` }],
				isError: false,
				timestamp: index + 2,
			});
		}
		expect(await countRebuildChunks(messages)).toBeGreaterThan(0);
	});
});

describe("UiHelpers.renderInitialMessages — image replay", () => {
	it("restores read tool image blocks onto the rebuilt assistant transcript", async () => {
		await Settings.init({ inMemory: true, overrides: { "terminal.showImages": true } });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const transcript = transcriptWith([
			assistantToolCall("read-image", "read", { path: "sample.png" }),
			{
				role: "toolResult",
				toolCallId: "read-image",
				toolName: "read",
				content: [{ type: "text", text: "Read image: sample.png" }, pngImage],
				isError: false,
				timestamp: 2,
			},
		]);
		const { ctx, chatContainer } = makeRenderCtx(transcript);

		await new UiHelpers(ctx).renderInitialMessages();

		expect(hasImageComponent(chatContainer)).toBe(true);
		expect(Bun.stripANSI(chatContainer.render(100).join("\n"))).toContain("Read sample.png");
	});

	it("restores eval display image blocks onto rebuilt tool output", async () => {
		await Settings.init({ inMemory: true, overrides: { "terminal.showImages": true } });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const transcript = transcriptWith([
			assistantToolCall("eval-image", "eval", { language: "py", code: "display(image)" }),
			{
				role: "toolResult",
				toolCallId: "eval-image",
				toolName: "eval",
				content: [{ type: "text", text: "(displayed 1 image; no text output)" }, pngImage],
				details: {
					language: "python",
					cells: [{ index: 0, code: "display(image)", output: "display image 1: 1x1", status: "complete" }],
				},
				isError: false,
				timestamp: 2,
			},
		]);

		const { ctx, chatContainer } = makeRenderCtx(transcript);

		await new UiHelpers(ctx).renderInitialMessages();

		expect(hasImageComponent(chatContainer)).toBe(true);
		expect(Bun.stripANSI(chatContainer.render(100).join("\n"))).toContain("display image 1: 1x1");
	});

	it("restores manual Bash image blocks from persisted message content", async () => {
		await Settings.init({ inMemory: true, overrides: { "terminal.showImages": true } });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const transcript = transcriptWith([
			{
				role: "bashExecution",
				command: "emit-image",
				output: "generated",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				images: [pngImage],
				timestamp: 1,
			},
		]);
		const { ctx, chatContainer } = makeRenderCtx(transcript);

		await new UiHelpers(ctx).renderInitialMessages();

		expect(countImageComponents(chatContainer)).toBe(1);
		expect(Bun.stripANSI(chatContainer.render(100).join("\n"))).toContain("$ emit-image");
	});

	it("preserves hidden read images so enabling them later can replay the image", async () => {
		await Settings.init({ inMemory: true, overrides: { "terminal.showImages": false } });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const transcript = transcriptWith([
			assistantToolCall("read-hidden", "read", { path: "hidden.png" }),
			{
				role: "toolResult",
				toolCallId: "read-hidden",
				toolName: "read",
				content: [{ type: "text", text: "Read image: hidden.png" }, pngImage],
				isError: false,
				timestamp: 2,
			},
		]);
		const { ctx, chatContainer } = makeRenderCtx(transcript, false);

		await new UiHelpers(ctx).renderInitialMessages();

		expect(hasImageComponent(chatContainer)).toBe(false);
		const assistant = chatContainer.children.find(
			(child): child is AssistantMessageComponent => child instanceof AssistantMessageComponent,
		);
		expect(assistant).toBeDefined();
		assistant?.setImagesVisible(true);
		expect(hasImageComponent(chatContainer)).toBe(true);
	});

	it("preserves tool-result images while tool activity is hidden so revealing it can replay the image", async () => {
		await Settings.init({ inMemory: true, overrides: { "terminal.showImages": true } });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		const transcript = transcriptWith([
			assistantToolCall("read-tool-hidden", "read", { path: "tool-hidden.png" }),
			{
				role: "toolResult",
				toolCallId: "read-tool-hidden",
				toolName: "read",
				content: [{ type: "text", text: "Read image: tool-hidden.png" }, pngImage],
				isError: false,
				timestamp: 2,
			},
		]);
		const { ctx, chatContainer } = makeRenderCtx(transcript, true, true);

		await new UiHelpers(ctx).renderInitialMessages();

		expect(hasImageComponent(chatContainer)).toBe(false);
		const assistant = chatContainer.children.find(
			(child): child is AssistantMessageComponent => child instanceof AssistantMessageComponent,
		);
		expect(assistant).toBeDefined();
		assistant?.setToolResultImagesVisible(true);
		expect(hasImageComponent(chatContainer)).toBe(true);
	});

	it("replays reopened session image blocks through the cold-start rebuild path", async () => {
		await Settings.init({ inMemory: true, overrides: { "terminal.showImages": true } });
		setTerminalImageProtocol(ImageProtocol.Sixel);
		using tempDir = TempDir.createSync("@pi-render-initial-image-replay-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		session.appendMessage(assistantToolCall("read-reopened", "read", { path: "reopened.png" }));
		session.appendMessage({
			role: "toolResult",
			toolCallId: "read-reopened",
			toolName: "read",
			content: [{ type: "text", text: "Read image: reopened.png" }, pngImage],
			isError: false,
			timestamp: 2,
		});
		session.appendMessage(assistantToolCall("eval-reopened", "eval", { language: "py", code: "display(image)" }));
		session.appendMessage({
			role: "toolResult",
			toolCallId: "eval-reopened",
			toolName: "eval",
			content: [{ type: "text", text: "(displayed 1 image; no text output)" }, pngImage],
			details: {
				language: "python",
				cells: [{ index: 0, code: "display(image)", output: "display image 1: 1x1", status: "complete" }],
			},
			isError: false,
			timestamp: 4,
		});
		await session.flush();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const reloaded = await SessionManager.open(sessionFile);
		const transcript = reloaded.buildSessionContext({ transcript: true });
		const { ctx, chatContainer } = makeRenderCtx(transcript);

		await new UiHelpers(ctx).renderInitialMessages({ clearTerminalHistory: true });

		expect(countImageComponents(chatContainer)).toBe(2);
		expect(Bun.stripANSI(chatContainer.render(100).join("\n"))).toContain("Read reopened.png");
		expect(ctx.ui.requestRender).toHaveBeenCalledWith(true, { clearScrollback: true });
	});
});

describe("UiHelpers.renderInitialMessages — hidden tool activity", () => {
	it("hides replayed tool cards without discarding them from the persisted transcript", async () => {
		const toolCallId = "replayed-hidden-tool";
		const toolArgumentMarker = "REPLAYED TOOL ARGUMENT MARKER";
		const toolResultMarker = "REPLAYED TOOL RESULT MARKER";
		const narrationMarker = "ASSISTANT NARRATION STAYS VISIBLE";
		const finalMarker = "FINAL ASSISTANT RESPONSE STAYS VISIBLE";
		const transcript = transcriptWith([
			{
				...assistantToolCall(toolCallId, "contract_probe", { value: toolArgumentMarker }),
				content: [
					{ type: "text", text: narrationMarker },
					{ type: "toolCall", id: toolCallId, name: "contract_probe", arguments: { value: toolArgumentMarker } },
				],
			},
			{
				role: "toolResult",
				toolCallId,
				toolName: "contract_probe",
				content: [{ type: "text", text: toolResultMarker }],
				isError: false,
				timestamp: 2,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: finalMarker }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet",
				usage: emptyUsage,
				stopReason: "stop",
				timestamp: 3,
			},
		]);

		const hidden = makeRenderCtx(transcript, true, true);
		await new UiHelpers(hidden.ctx).renderInitialMessages();
		const hiddenRender = Bun.stripANSI(hidden.chatContainer.render(120).join("\n"));
		expect(hiddenRender).toContain(narrationMarker);
		expect(hiddenRender).toContain(finalMarker);
		expect(hiddenRender).not.toContain(toolArgumentMarker);
		expect(hiddenRender).not.toContain(toolResultMarker);

		const visible = makeRenderCtx(transcript, true, false);
		await new UiHelpers(visible.ctx).renderInitialMessages();
		const visibleRender = Bun.stripANSI(visible.chatContainer.render(120).join("\n"));
		expect(visibleRender).toContain(toolArgumentMarker);
		expect(visibleRender).toContain(toolResultMarker);
	});

	it("hides and restores persisted internal activity blocks", async () => {
		const transcript = transcriptWith([
			{
				role: "custom",
				customType: "async-result",
				content: "",
				display: true,
				details: { jobId: "ASYNC_JOB_MARKER", type: "bash", label: "async marker" },
				timestamp: 1,
			},
			{
				role: "custom",
				customType: "lsp-late-diagnostic",
				content: "",
				display: true,
				details: {
					files: [
						{
							path: "/tmp/internal.ts",
							summary: "1 error(s)",
							errored: true,
							messages: ["internal.ts:1:1 [error] [typescript] LATE_DIAGNOSTIC_MARKER (2322)"],
						},
					],
				},
				timestamp: 2,
			},
			{
				role: "custom",
				customType: "launch-completion",
				content: "LAUNCH_COMPLETION_MARKER",
				display: true,
				timestamp: 3,
			},
		]);

		const hidden = makeRenderCtx(transcript, true, true);
		await new UiHelpers(hidden.ctx).renderInitialMessages();
		const hiddenRender = Bun.stripANSI(hidden.chatContainer.render(120).join("\n"));
		expect(hiddenRender).not.toContain("ASYNC_JOB_MARKER");
		expect(hiddenRender).not.toContain("LATE_DIAGNOSTIC_MARKER");
		expect(hiddenRender).not.toContain("LAUNCH_COMPLETION_MARKER");

		const visible = makeRenderCtx(transcript, true, false);
		await new UiHelpers(visible.ctx).renderInitialMessages();
		const visibleRender = Bun.stripANSI(visible.chatContainer.render(120).join("\n"));
		expect(visibleRender).toContain("ASYNC_JOB_MARKER");
		expect(visibleRender).toContain("LATE_DIAGNOSTIC_MARKER");
		expect(visibleRender).toContain("LAUNCH_COMPLETION_MARKER");
	});

	it("keeps normal warnings visible and hides warnings tied to tool activity", () => {
		const hidden = makeRenderCtx(makeEmptyContext(), true, true);
		const hiddenHelpers = new UiHelpers(hidden.ctx);
		hiddenHelpers.showWarning("NORMAL_WARNING_MARKER");
		hiddenHelpers.showWarning("TODO_WARNING_MARKER", { hideWithToolActivity: true });
		const hiddenRender = Bun.stripANSI(hidden.chatContainer.render(120).join("\n"));
		expect(hiddenRender).toContain("NORMAL_WARNING_MARKER");
		expect(hiddenRender).not.toContain("TODO_WARNING_MARKER");

		const visible = makeRenderCtx(makeEmptyContext(), true, false);
		new UiHelpers(visible.ctx).showWarning("TODO_WARNING_MARKER", { hideWithToolActivity: true });
		expect(Bun.stripANSI(visible.chatContainer.render(120).join("\n"))).toContain("TODO_WARNING_MARKER");
	});

	it("hides the stripped-tool-calls placeholder with tool activity and restores it on reveal", async () => {
		const strippedAssistant: AgentMessage & StrippedToolCallsMarker = {
			role: "assistant",
			content: [{ type: "text", text: "narration" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage: emptyUsage,
			stopReason: "stop",
			timestamp: 1,
			strippedToolCalls: 2,
		};
		const transcript = transcriptWith([strippedAssistant]);

		const hidden = makeRenderCtx(transcript, true, true);
		await new UiHelpers(hidden.ctx).renderInitialMessages();
		expect(Bun.stripANSI(hidden.chatContainer.render(120).join("\n"))).not.toContain(
			"elided — no result on this branch",
		);

		// A live reveal must restore the placeholder without a transcript rebuild.
		hidden.chatContainer.setToolActivityVisible(true);
		expect(Bun.stripANSI(hidden.chatContainer.render(120).join("\n"))).toContain(
			"2 tool calls elided — no result on this branch",
		);
	});
});

describe("UiHelpers.renderSessionContext — error-stop tool calls", () => {
	it("keeps the synthetic assistant error result instead of replaying a later tool result", async () => {
		await Settings.init({ inMemory: true });
		const transcript = transcriptWith([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "error-tool",
						name: "eval",
						arguments: { language: "py", code: "raise RuntimeError('boom')" },
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet",
				usage: emptyUsage,
				stopReason: "error",
				errorMessage: "synthetic assistant stop error",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "error-tool",
				toolName: "eval",
				content: [{ type: "text", text: "late tool result must not replace the assistant stop error" }],
				isError: false,
				timestamp: 2,
			},
		]);
		const { ctx, chatContainer } = makeRenderCtx(transcript);

		await new UiHelpers(ctx).renderInitialMessages();

		const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(rendered).toContain("synthetic assistant stop error");
		expect(rendered).not.toContain("late tool result must not replace the assistant stop error");
	});
});

describe("UiHelpers.renderSessionContext — mid-stream tool call rebuild", () => {
	it("decodes streamed write content from partialJson, not the provider's stale parsed arguments", async () => {
		// A transcript rebuild (theme change, settings edit, focus replay) can land
		// while a write's args still stream. The provider re-parses `arguments`
		// only every STREAMING_JSON_PARSE_MIN_GROWTH bytes, so the parsed snapshot
		// lags the raw buffer. The rebuilt preview must decode from the buffer —
		// exactly like the live reveal path — or the write body freezes at the
		// last throttled parse until more bytes arrive.
		await Settings.init({ inMemory: true });
		const staleContent = "line one of the streamed write";
		const grownBuffer = `{"path":"/tmp/mid.ts","content":"${staleContent}\\nGROWN_TAIL_SENTINEL`;
		const transcript = transcriptWith([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "write-mid",
						name: "write",
						// Provider-parsed snapshot from BEFORE the buffer grew.
						arguments: { path: "/tmp/mid.ts", content: staleContent },
						[kStreamingPartialJson]: grownBuffer,
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet",
				usage: emptyUsage,
				stopReason: "toolUse",
				timestamp: 1,
			},
		]);
		const { ctx, chatContainer } = makeRenderCtx(transcript);

		await new UiHelpers(ctx).renderInitialMessages();

		const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(rendered).toContain("GROWN_TAIL_SENTINEL");
	});
});

describe("UiHelpers.renderInitialMessages — replay convergence (issue #7811)", () => {
	/** getEntries mock whose returned array grows on every call, simulating a
	 * source that persists a new session entry during every replay pass. */
	function growingEntriesCtx(): RenderInitialMessagesTestContext {
		const made = makeCtx();
		let calls = 0;
		const getEntries = vi.fn(() => {
			calls++;
			return Array.from({ length: calls }, () => ({ type: "message" }));
		});
		(made.ctx.viewSession.sessionManager as unknown as { getEntries: unknown }).getEntries = getEntries;
		(made.ctx.sessionManager as unknown as { getEntries: unknown }).getEntries = getEntries;
		return made;
	}

	it("terminates when entries are persisted during every replay pass", async () => {
		// Regression: the replay restart loop was unbounded. A source persisting
		// one entry per pass made the entry-count check permanently false, so a
		// large resumed session replayed from scratch forever at 100% CPU
		// (issue #7811). The loop must give up after a bounded number of
		// restarts and accept the transcript it just replayed.
		await Settings.init({ inMemory: true });
		const { ctx, transcriptSpy } = growingEntriesCtx();

		await new UiHelpers(ctx).renderInitialMessages();

		// The initial pass plus four retries reaches the five-attempt cap.
		expect(transcriptSpy).toHaveBeenCalledTimes(5);
		expect(ctx.initialChatRendered).toBeTrue();
	});

	it("still replays once more when a single entry lands mid-replay", async () => {
		// The intended reconciliation must survive the cap: one entry persisted
		// during the first pass triggers exactly one restart against the fresh
		// context, then the stable entry count exits the loop.
		await Settings.init({ inMemory: true });
		const { ctx, transcriptSpy } = makeCtx();
		const lengths = [0, 1, 1, 1, 1, 1, 1, 1];
		let call = 0;
		const getEntries = vi.fn(() => {
			const length = lengths[Math.min(call, lengths.length - 1)]!;
			call++;
			return Array.from({ length }, () => ({ type: "message" }));
		});
		(ctx.viewSession.sessionManager as unknown as { getEntries: unknown }).getEntries = getEntries;
		(ctx.sessionManager as unknown as { getEntries: unknown }).getEntries = getEntries;

		await new UiHelpers(ctx).renderInitialMessages();

		// Initial context build + exactly one reconciliation restart.
		expect(transcriptSpy).toHaveBeenCalledTimes(2);
		expect(ctx.initialChatRendered).toBeTrue();
	});
});
describe("UiHelpers.renderInitialMessages — prompt history isolation", () => {
	it("never calls editor.addToHistory when rendering past user messages", async () => {
		await Settings.init({ inMemory: true });
		const transcript = transcriptWith([
			{ role: "user", content: "first user prompt", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "reply 1" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet",
				usage: emptyUsage,
				stopReason: "stop",
				timestamp: 2,
			},
			{ role: "user", content: "second user prompt", timestamp: 3 },
			{
				role: "assistant",
				content: [{ type: "text", text: "reply 2" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet",
				usage: emptyUsage,
				stopReason: "stop",
				timestamp: 4,
			},
		]);
		const { ctx } = makeRenderCtx(transcript);

		await new UiHelpers(ctx).renderInitialMessages();

		expect(ctx.editor.addToHistory).not.toHaveBeenCalled();
	});
});
