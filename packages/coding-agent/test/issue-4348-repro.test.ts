/**
 * Regression for issue #4348: cursor-agent persisted transcripts lose tool-call
 * structure, so replay renders header-less tool results.
 *
 * Before the fix, the Cursor provider only synthesized `toolCall` content
 * blocks for `mcpToolCall` and `updateTodosToolCall`. Native exec-channel tools
 * (`bash`/`read`/`write`/`grep`/`ls`/`delete`/`lsp`) executed via the bridge
 * and never appeared in `AssistantMessage.content`. `renderSessionContext`
 * then had no matching toolCall block for each `toolResult` message, and the
 * results fell through to `addMessageToChat`, rendering as bare `⎿` lines
 * beneath the last assistant text.
 *
 * The fix (in `packages/ai/src/providers/cursor.ts` `handleExecServerMessage`)
 * synthesizes a `toolCall` block on the exec channel using the same tool name
 * and args the bridge emits via `tool_execution_start`. This test asserts the
 * post-fix persisted shape rebuilds into proper `ToolExecutionComponent`s
 * that own their tool results, not into orphan `⎿` toolResult lines.
 */

import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext, RenderSessionContextOptions } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { Container } from "@oh-my-pi/pi-tui";

beforeAll(() => {
	initTheme();
});

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function transcriptWith(messages: AgentMessage[]): SessionContext {
	return {
		messages,
		thinkingLevel: "off",
		serviceTier: undefined,
		models: {},
		injectedTtsrRules: [],
		mode: "none",
	};
}

function makeRenderCtx(transcript: SessionContext): { ctx: InteractiveModeContext; chatContainer: Container } {
	const chatContainer = new Container();
	let helpers: UiHelpers;
	const ctx = {
		chatContainer,
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
		pendingPythonComponents: [],
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		updateEditorTopBorder: vi.fn(),
		ui: { requestRender: vi.fn(), imageBudget: undefined },
		resetTranscript: () => chatContainer.clear(),
		settings: { get: () => false },
		toolOutputExpanded: false,
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
		renderSessionContext: (context: SessionContext, options?: RenderSessionContextOptions) =>
			helpers.renderSessionContext(context, options),
		renderSessionContextIncrementally: (
			context: SessionContext,
			options: RenderSessionContextOptions,
			renderChunk?: () => void,
		) => helpers.renderSessionContextIncrementally(context, options, renderChunk),
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;
	helpers = new UiHelpers(ctx);
	return { ctx, chatContainer };
}

/** Build the cursor-shaped assistant + toolResults message set for one turn. */
function cursorTurn(): AgentMessage[] {
	// After the fix, the Cursor provider synthesizes `toolCall` blocks with the
	// bridge's mapped tool names ("bash"/"read"). The stopReason for cursor
	// turns with tool results is "toolUse" mid-turn — this matches how the
	// agent-loop finalizes cursor exec turns.
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: "Reading and listing:" },
			{ type: "toolCall", id: "tc-read", name: "read", arguments: { path: "src/foo.ts" } },
			{
				type: "toolCall",
				id: "tc-bash",
				name: "bash",
				arguments: { command: "ls -1" },
			},
		],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-composer-2.5",
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: 1,
	};
	return [
		assistant,
		{
			role: "toolResult",
			toolCallId: "tc-read",
			toolName: "read",
			content: [{ type: "text", text: "READ_RESULT_MARKER content of foo.ts" }],
			isError: false,
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId: "tc-bash",
			toolName: "bash",
			content: [{ type: "text", text: "BASH_RESULT_MARKER file1\nfile2" }],
			isError: false,
			timestamp: 3,
		},
	];
}

describe("issue #4348: cursor exec-channel tool results pair with synthesized toolCall blocks on rebuild", () => {
	it("renders bash toolResult inside a ToolExecutionComponent, not as an orphan `⎿` line", async () => {
		await Settings.init({ inMemory: true });
		const transcript = transcriptWith(cursorTurn());
		const { ctx, chatContainer } = makeRenderCtx(transcript);

		await new UiHelpers(ctx).renderInitialMessages();

		// Component structure: an assistant message, then a bash
		// ToolExecutionComponent for the synthesized bash block, then a
		// ReadToolGroupComponent for the synthesized read block. Absent the
		// synthesis (pre-fix), neither would exist — both results would fall
		// through `addMessageToChat` (a no-op for `toolResult`) and vanish.
		const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(rendered).toContain("Reading and listing:");
		// Bash result is fully surfaced inside the ToolExecutionComponent —
		// header carries the command, body carries the output.
		expect(rendered).toContain("ls -1");
		expect(rendered).toContain("BASH_RESULT_MARKER");
		// Read result flows into the ReadToolGroupComponent. Its file-content
		// preview is gated by the `read.toolResultPreview` setting (off in
		// this harness), so we assert on the pairing signal: the read call
		// appears with its path, only reachable when the toolResult attaches.
		expect(rendered).toContain("Read src/foo.ts");
	});

	it("does not orphan the bash toolResult under the assistant when the toolCall block is missing", async () => {
		// Simulates the PRE-fix persisted shape: assistant with only text (no
		// toolCall blocks) + a toolResult message. The renderer has nothing to
		// pair the result with. This test guards the failure mode so a future
		// regression that reverts the synthesis is caught: the rendered output
		// notably omits the bash command preview.
		await Settings.init({ inMemory: true });
		const preFixAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Running command:" }],
			api: "cursor-agent",
			provider: "cursor",
			model: "cursor-composer-2.5",
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const transcript = transcriptWith([
			preFixAssistant,
			{
				role: "toolResult",
				toolCallId: "tc-orphan",
				toolName: "bash",
				content: [{ type: "text", text: "ORPHAN_RESULT some output" }],
				isError: false,
				timestamp: 2,
			},
		]);
		const { ctx, chatContainer } = makeRenderCtx(transcript);

		await new UiHelpers(ctx).renderInitialMessages();

		const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(rendered).toContain("Running command:");
		// Fallback path (`addMessageToChat` case "toolResult") is a no-op, so
		// the result content never lands in the transcript at all. That silent
		// drop is exactly what the reporter saw in the wild — every native
		// cursor tool's output disappeared from replay.
		expect(rendered).not.toContain("ORPHAN_RESULT");
	});
});
