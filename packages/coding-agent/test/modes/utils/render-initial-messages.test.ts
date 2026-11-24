/**
 * Contract: renderInitialMessages renders the collapsed live DISPLAY TRANSCRIPT,
 * not the LLM context. The transcript comes from
 * `session.buildTranscriptSessionContext({ collapseCompactedHistory: true })`;
 * `sessionManager.buildSessionContext()` — the LLM-context builder — must not be
 * consulted for display.
 *
 * Also guards the cold-launch terminal cleanup: `omp` / `omp -c` leave the
 * previous run's transcript in native scrollback, so the cold-launch render
 * must commit with a scrollback-clearing repaint (`clearTerminalHistory`).
 */

import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Usage } from "@oh-my-pi/pi-ai";
import { kStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext, StrippedToolCallsMarker } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import { contextDisplay, createInteractiveModeContext, renderTranscript } from "../../helpers/interactive-mode-context";

const restoreTheme = currentTheme();

beforeEach(async () => {
	// renderInitialMessages reads the global Settings (display.collapseCompacted).
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
	vi.restoreAllMocks();
	setCurrentTheme(restoreTheme);
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

/** The test terminal has no image protocol: a shown image paints its fallback label (`[Image: …]`). */
const IMAGE_LABEL = "[Image: ";

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

interface RenderHarness {
	readonly ctx: InteractiveModeContext;
	readonly helpers: UiHelpers;
	readonly transcriptSpy: Mock<(options?: { collapseCompactedHistory?: boolean }) => SessionContext>;
	readonly llmContextSpy: Mock<() => SessionContext>;
	readonly commitSpy: Mock<(options?: { preserve?: boolean; history?: boolean }) => void>;
	/** The transcript as plain rows. */
	text(): string;
}

/** A context over `transcript` whose replay methods run through one real {@link UiHelpers}. */
function makeRenderCtx(
	transcript: SessionContext,
	{ showImages = true, hideToolActivity = false }: { showImages?: boolean; hideToolActivity?: boolean } = {},
): RenderHarness {
	const transcriptSpy = vi.fn((_options?: { collapseCompactedHistory?: boolean }) => transcript);
	const ctx = createInteractiveModeContext({
		settings: Settings.isolated({ "terminal.showImages": showImages, "composer.recallClearedDrafts": false }),
		session: {
			buildTranscriptSessionContext: transcriptSpy,
			getQueuedMessages: () => ({ steering: [], followUp: [], liveSteered: 0 }),
		},
	});
	contextDisplay(ctx).hideToolActivity.set(hideToolActivity);
	const helpers = new UiHelpers(ctx);
	Object.assign(ctx, {
		addMessageToChat: helpers.addMessageToChat.bind(helpers),
		renderSessionContext: helpers.renderSessionContext.bind(helpers),
		renderSessionContextIncrementally: helpers.renderSessionContextIncrementally.bind(helpers),
		renderInitialMessages: helpers.renderInitialMessages.bind(helpers),
		updatePendingMessagesDisplay: helpers.updatePendingMessagesDisplay.bind(helpers),
	});
	const llmContextSpy = spyOn(
		ctx.viewSession.sessionManager as SessionManager,
		"buildSessionContext",
	) as unknown as Mock<() => SessionContext>;
	const commitSpy = spyOn(ctx.shell.transcript, "commit") as unknown as RenderHarness["commitSpy"];
	return {
		ctx,
		helpers,
		transcriptSpy,
		llmContextSpy,
		commitSpy,
		text: () => renderTranscript(ctx).join("\n"),
	};
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("UiHelpers.renderInitialMessages — transcript source", () => {
	it("shows only the brief intent on a settled shell card restored from raw arguments", async () => {
		const args = { command: "ls -la", i: "Listing files: Which files have changed?" };
		const harness = makeRenderCtx(
			transcriptWith([
				assistantToolCall("ls", "bash", args),
				{
					role: "toolResult",
					toolCallId: "ls",
					toolName: "bash",
					content: [{ type: "text", text: "index.ts" }],
					isError: false,
					timestamp: 2,
				},
			]),
		);
		await harness.helpers.renderInitialMessages();
		const rendered = harness.text();
		expect(rendered).toContain("Listing files");
		expect(rendered).not.toContain("Which files have changed?");
		expect(args.i).toBe("Listing files: Which files have changed?");
	});

	it("renders the collapsed live display transcript, never the LLM context", async () => {
		const transcript = makeEmptyContext();
		const harness = makeRenderCtx(transcript);
		const renderSpy = spyOn(harness.ctx, "renderSessionContextIncrementally");

		await harness.helpers.renderInitialMessages();

		expect(harness.transcriptSpy).toHaveBeenCalledWith(expect.objectContaining({ collapseCompactedHistory: true }));
		expect(harness.llmContextSpy).not.toHaveBeenCalled();
		expect(renderSpy).toHaveBeenCalledWith(transcript, { updateFooter: true });
	});
});

describe("UiHelpers.renderInitialMessages — clearTerminalHistory", () => {
	it("never clears scrollback when clearTerminalHistory is unset", async () => {
		const harness = makeRenderCtx(makeEmptyContext());
		await harness.helpers.renderInitialMessages();
		expect(harness.commitSpy).toHaveBeenCalledTimes(1);
		expect(harness.commitSpy.mock.calls[0]?.[0]?.history).toBe(false);
	});
});

describe("UiHelpers.renderInitialMessages — queued messages", () => {
	it("keeps the queued-message bar after a mid-turn rebuild such as rewind (#13680)", async () => {
		const harness = makeRenderCtx(makeEmptyContext());
		spyOn(harness.ctx.viewSession, "getQueuedMessages").mockReturnValue({
			steering: ["steer now"],
			followUp: ["queued one", "queued two"],
			liveSteered: 0,
		});
		const display = spyOn(harness.ctx, "updatePendingMessagesDisplay");

		await harness.helpers.renderInitialMessages({ clearTerminalHistory: true });

		expect(display).toHaveBeenCalled();
		expect(harness.ctx.hud.queue.groups()).toEqual([
			{ label: "Steering", messages: ["steer now"] },
			{ label: "After yield", messages: ["queued one", "queued two"] },
		]);
	});
});

describe("UiHelpers.renderInitialMessages — responsiveness", () => {
	// Count the chunk boundaries an idle rebuild produces: each boundary calls
	// `renderChunk` and then awaits a macrotask, so a positive count proves the
	// rebuild handed control back to the event loop mid-replay.
	async function countRebuildChunks(messages: AgentMessage[]): Promise<number> {
		const transcript = transcriptWith(messages);
		const { helpers } = makeRenderCtx(transcript);
		let chunks = 0;
		await helpers.renderSessionContextIncrementally(transcript, { updateFooter: true }, () => {
			chunks++;
		});
		return chunks;
	}

	it("splits a large plain transcript rebuild across event-loop turns", async () => {
		const messages: AgentMessage[] = Array.from({ length: 256 }, (_, index) => ({
			role: "user",
			content: `message ${index}`,
			timestamp: index,
		}));
		expect(await countRebuildChunks(messages)).toBeGreaterThan(0);
	});

	it("keeps the complete transcript visible until an incremental replacement is ready", async () => {
		const messages: AgentMessage[] = Array.from({ length: 256 }, (_, index) => ({
			role: "user",
			content: `replacement ${index}`,
			timestamp: index,
		}));
		const harness = makeRenderCtx(transcriptWith(messages));
		harness.helpers.addMessageToChat({ role: "user", content: "VISIBLE_OLD_TRANSCRIPT", timestamp: -1 });

		const replay = harness.helpers.renderInitialMessages({ clearTerminalHistory: true });

		const duringReplay = harness.text();
		expect(duringReplay).toContain("VISIBLE_OLD_TRANSCRIPT");
		expect(duringReplay).not.toContain("replacement 0");
		expect(harness.commitSpy).not.toHaveBeenCalled();

		await replay;

		const afterReplay = harness.text();
		expect(afterReplay).not.toContain("VISIBLE_OLD_TRANSCRIPT");
		expect(afterReplay).toContain("replacement 255");
		expect(harness.commitSpy.mock.calls.map(([options]) => options?.history)).toEqual([true]);
	});

	it("commits only the latest replay when a second one starts mid-replay", async () => {
		// Leaving a focused subagent while its transcript is still replaying starts
		// the main session's replay on top of it. Overlapping replays must not
		// interleave their rows or clear scrollback twice.
		let current = transcriptWith(
			Array.from({ length: 320 }, (_, index) => ({ role: "user", content: `SUBAGENT-${index}`, timestamp: index })),
		);
		const harness = makeRenderCtx(current);
		harness.transcriptSpy.mockImplementation(() => current);
		const firstChunk = Promise.withResolvers<void>();
		const renderIncrementally = harness.ctx.renderSessionContextIncrementally;
		harness.ctx.renderSessionContextIncrementally = (context, options) =>
			renderIncrementally(context, options, () => firstChunk.resolve());

		const subagentReplay = harness.helpers.renderInitialMessages({ clearTerminalHistory: true });
		await firstChunk.promise;
		current = transcriptWith(
			Array.from({ length: 3 }, (_, index) => ({ role: "user", content: `MAIN-${index}`, timestamp: index })),
		);
		const mainReplay = harness.helpers.renderInitialMessages({ clearTerminalHistory: true });
		await Promise.all([subagentReplay, mainReplay]);

		const rendered = harness.text();
		expect(rendered).not.toContain("SUBAGENT-");
		expect(rendered.match(/MAIN-\d+/g)).toEqual(["MAIN-0", "MAIN-1", "MAIN-2"]);
		expect(harness.commitSpy.mock.calls.map(([options]) => options?.history)).toEqual([true]);
		expect(harness.ctx.initialChatRendered).toBeTrue();
	});

	it("reopens live display when a replay fails before it starts rebuilding", async () => {
		// The display gate closes when a replay is requested; a replay that throws
		// while reading the transcript must not leave live messages hidden.
		const harness = makeRenderCtx(transcriptWith([{ role: "user", content: "hello", timestamp: 0 }]));
		harness.transcriptSpy.mockImplementation(() => {
			throw new Error("transcript unavailable");
		});
		harness.ctx.initialChatRendered = true;

		await expect(harness.helpers.renderInitialMessages()).rejects.toThrow("transcript unavailable");
		expect(harness.ctx.initialChatRendered).toBeTrue();
	});

	it("yields across a large parallel read-result batch", async () => {
		// Regression: grouped `read` results replay through an early `continue`;
		// the top-of-loop yield must still hand control back between results.
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
	it("restores eval image blocks onto rebuilt tool output", async () => {
		const harness = makeRenderCtx(
			transcriptWith([
				assistantToolCall("eval-image", "eval", { language: "py", code: "print(image)" }),
				{
					role: "toolResult",
					toolCallId: "eval-image",
					toolName: "eval",
					content: [{ type: "text", text: "(1 image; no text output)" }, pngImage],
					details: {
						language: "python",
						cells: [{ index: 0, code: "print(image)", output: "image 1: 1x1", status: "complete" }],
					},
					isError: false,
					timestamp: 2,
				},
			]),
		);

		await harness.helpers.renderInitialMessages();

		const rendered = harness.text();
		expect(rendered).toContain(IMAGE_LABEL);
		expect(rendered).toContain("image 1: 1x1");
	});

	it("restores manual Bash image blocks from persisted message content", async () => {
		const harness = makeRenderCtx(
			transcriptWith([
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
			]),
		);

		await harness.helpers.renderInitialMessages();

		const rendered = harness.text();
		expect(countOccurrences(rendered, IMAGE_LABEL)).toBe(1);
		expect(rendered).toContain("$ emit-image");
	});

	it("does not show read images while terminal images are off", async () => {
		const harness = makeRenderCtx(
			transcriptWith([
				assistantToolCall("read-hidden", "read", { path: "hidden.png" }),
				{
					role: "toolResult",
					toolCallId: "read-hidden",
					toolName: "read",
					content: [{ type: "text", text: "Read image: hidden.png" }, pngImage],
					isError: false,
					timestamp: 2,
				},
			]),
			{ showImages: false },
		);

		await harness.helpers.renderInitialMessages();

		expect(harness.text()).not.toContain(IMAGE_LABEL);
	});

	it("preserves tool-result images while tool activity is hidden so revealing it can replay the image", async () => {
		const harness = makeRenderCtx(
			transcriptWith([
				assistantToolCall("read-tool-hidden", "read", { path: "tool-hidden.png" }),
				{
					role: "toolResult",
					toolCallId: "read-tool-hidden",
					toolName: "read",
					content: [{ type: "text", text: "Read image: tool-hidden.png" }, pngImage],
					isError: false,
					timestamp: 2,
				},
			]),
			{ hideToolActivity: true },
		);

		await harness.helpers.renderInitialMessages();

		expect(harness.text()).not.toContain(IMAGE_LABEL);
		contextDisplay(harness.ctx).hideToolActivity.set(false);
		expect(harness.text()).toContain(IMAGE_LABEL);
	});

	it("replays reopened session image blocks through the cold-start rebuild path", async () => {
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
		session.appendMessage(assistantToolCall("eval-reopened", "eval", { language: "py", code: "print(image)" }));
		session.appendMessage({
			role: "toolResult",
			toolCallId: "eval-reopened",
			toolName: "eval",
			content: [{ type: "text", text: "(displayed 1 image; no text output)" }, pngImage],
			details: {
				language: "python",
				cells: [{ index: 0, code: "print(image)", output: "image 1: 1x1", status: "complete" }],
			},
			isError: false,
			timestamp: 4,
		});
		await session.flush();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const reloaded = await SessionManager.open(sessionFile);
		const harness = makeRenderCtx(reloaded.buildSessionContext({ transcript: true }));

		await harness.helpers.renderInitialMessages({ clearTerminalHistory: true });

		const rendered = harness.text();
		expect(countOccurrences(rendered, IMAGE_LABEL)).toBe(2);
		expect(rendered).toContain("reopened.png");
		expect(harness.commitSpy.mock.calls.map(([options]) => options?.history)).toEqual([true]);
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

		const hidden = makeRenderCtx(transcript, { hideToolActivity: true });
		await hidden.helpers.renderInitialMessages();
		const hiddenRender = hidden.text();
		expect(hiddenRender).toContain(narrationMarker);
		expect(hiddenRender).toContain(finalMarker);
		expect(hiddenRender).not.toContain(toolArgumentMarker);
		expect(hiddenRender).not.toContain(toolResultMarker);

		const visible = makeRenderCtx(transcript);
		await visible.helpers.renderInitialMessages();
		const visibleRender = visible.text();
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

		const harness = makeRenderCtx(transcript, { hideToolActivity: true });
		await harness.helpers.renderInitialMessages();
		const hiddenRender = harness.text();
		expect(hiddenRender).not.toContain("ASYNC_JOB_MARKER");
		expect(hiddenRender).not.toContain("LATE_DIAGNOSTIC_MARKER");
		expect(hiddenRender).not.toContain("LAUNCH_COMPLETION_MARKER");

		contextDisplay(harness.ctx).hideToolActivity.set(false);
		const visibleRender = harness.text();
		expect(visibleRender).toContain("ASYNC_JOB_MARKER");
		expect(visibleRender).toContain("LATE_DIAGNOSTIC_MARKER");
		expect(visibleRender).toContain("LAUNCH_COMPLETION_MARKER");
	});

	it("keeps normal warnings visible and hides warnings tied to tool activity", () => {
		const hidden = makeRenderCtx(makeEmptyContext(), { hideToolActivity: true });
		hidden.helpers.showWarning("NORMAL_WARNING_MARKER");
		hidden.helpers.showWarning("TODO_WARNING_MARKER", { hideWithToolActivity: true });
		const hiddenRender = hidden.text();
		expect(hiddenRender).toContain("NORMAL_WARNING_MARKER");
		expect(hiddenRender).not.toContain("TODO_WARNING_MARKER");

		contextDisplay(hidden.ctx).hideToolActivity.set(false);
		expect(hidden.text()).toContain("TODO_WARNING_MARKER");
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
		const harness = makeRenderCtx(transcriptWith([strippedAssistant]), { hideToolActivity: true });
		await harness.helpers.renderInitialMessages();
		expect(harness.text()).not.toContain("elided — no result on this branch");

		// A live reveal must restore the placeholder without a transcript rebuild.
		contextDisplay(harness.ctx).hideToolActivity.set(false);
		expect(harness.text()).toContain("2 tool calls elided — no result on this branch");
	});
});

describe("UiHelpers.renderSessionContext — error-stop tool calls", () => {
	it("keeps the synthetic assistant error result instead of replaying a later tool result", async () => {
		const harness = makeRenderCtx(
			transcriptWith([
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
					details: { __synthetic: true, source: "assistant_stop_error", executed: false },
					isError: true,
					timestamp: 2,
				},
			]),
		);

		await harness.helpers.renderInitialMessages();

		const rendered = harness.text();
		expect(rendered).toContain("synthetic assistant stop error");
		expect(rendered).not.toContain("late tool result must not replace the assistant stop error");
	});

	it("shows the real results of an aborted Cursor turn and keeps the error on a call that never ran", async () => {
		const result = (toolCallId: string, toolName: string, text: string): AgentMessage => ({
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 2,
		});
		const harness = makeRenderCtx(
			transcriptWith([
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "read", name: "read", arguments: { path: "/tmp/file.txt" } },
						{ type: "toolCall", id: "grep", name: "grep", arguments: { pattern: "foo" } },
						{ type: "toolCall", id: "cut", name: "grep", arguments: { pattern: "bar" } },
					],
					api: "cursor-agent",
					provider: "cursor",
					model: "composer-2.5",
					usage: emptyUsage,
					stopReason: "aborted",
					errorMessage: "Deadline exceeded",
					timestamp: 1,
				},
				result("read", "read", "read output saved before the abort"),
				result("grep", "grep", "grep output saved before the abort"),
				{
					...result("cut", "grep", "placeholder for the call that never ran"),
					details: { __synthetic: true, source: "assistant_stop_aborted", executed: false },
					isError: true,
				} as AgentMessage,
			]),
		);

		await harness.helpers.renderInitialMessages();

		const rendered = harness.text();
		expect(rendered).toContain("✔ Read /tmp/file.txt");
		expect(rendered).toContain("grep output saved before the abort");
		expect(rendered).not.toContain("placeholder for the call that never ran");
		expect(countOccurrences(rendered, "Deadline exceeded")).toBe(1);
	});
});

describe("UiHelpers.renderSessionContext — mid-stream tool call rebuild", () => {
	it("decodes streamed write content from partialJson, not the provider's stale parsed arguments", async () => {
		// A transcript rebuild can land while a write's args still stream. The
		// provider re-parses `arguments` only every few bytes, so the parsed
		// snapshot lags the raw buffer; the rebuilt preview must decode the buffer.
		const staleContent = "line one of the streamed write";
		const grownBuffer = `{"path":"/tmp/mid.ts","content":"${staleContent}\\nGROWN_TAIL_SENTINEL`;
		const harness = makeRenderCtx(
			transcriptWith([
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
			]),
		);

		await harness.helpers.renderInitialMessages();

		expect(harness.text()).toContain("GROWN_TAIL_SENTINEL");
	});
});

describe("UiHelpers.renderInitialMessages — replay convergence (issue #7811)", () => {
	/** Replace the session's entries with a list whose length follows `lengthAt(call)`. */
	function stubEntries(harness: RenderHarness, lengthAt: (call: number) => number): void {
		let call = 0;
		spyOn(harness.ctx.viewSession.sessionManager, "getEntries").mockImplementation(
			() => Array.from({ length: lengthAt(call++) }, () => ({ type: "message" })) as never,
		);
	}

	it("terminates when entries are persisted during every replay pass", async () => {
		// Regression: a source persisting one entry per pass made the replay restart
		// forever (issue #7811). The loop gives up after a bounded number of restarts.
		const harness = makeRenderCtx(makeEmptyContext());
		stubEntries(harness, call => call + 1);

		await harness.helpers.renderInitialMessages();

		// The initial pass plus four retries reaches the five-attempt cap.
		expect(harness.transcriptSpy).toHaveBeenCalledTimes(5);
		expect(harness.ctx.initialChatRendered).toBeTrue();
	});

	it("still replays once more when a single entry lands mid-replay", async () => {
		const harness = makeRenderCtx(makeEmptyContext());
		stubEntries(harness, call => (call === 0 ? 0 : 1));

		await harness.helpers.renderInitialMessages();

		// Initial context build + exactly one reconciliation restart.
		expect(harness.transcriptSpy).toHaveBeenCalledTimes(2);
		expect(harness.ctx.initialChatRendered).toBeTrue();
	});
});

describe("UiHelpers.renderInitialMessages — prompt history isolation", () => {
	it("never adds past user messages to the prompt history", async () => {
		const reply = (text: string, timestamp: number): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage: emptyUsage,
			stopReason: "stop",
			timestamp,
		});
		const harness = makeRenderCtx(
			transcriptWith([
				{ role: "user", content: "first user prompt", timestamp: 1 },
				reply("reply 1", 2),
				{ role: "user", content: "second user prompt", timestamp: 3 },
				reply("reply 2", 4),
			]),
		);
		const addToHistory = spyOn(harness.ctx.composer, "addToHistory");

		await harness.helpers.renderInitialMessages();

		expect(addToHistory).not.toHaveBeenCalled();
	});
});
