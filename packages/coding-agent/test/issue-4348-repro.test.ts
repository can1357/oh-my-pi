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
 * post-fix persisted shape rebuilds into proper tool cards that own their
 * tool results, not into orphan `⎿` toolResult lines.
 */

import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { createInteractiveModeContext, renderTranscript } from "./helpers/interactive-mode-context";

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

function makeRenderCtx(transcript: SessionContext): InteractiveModeContext {
	const ctx = createInteractiveModeContext({
		viewSession: {
			buildTranscriptSessionContext: () => transcript,
			hasBuiltInTool: () => true,
		},
	});
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
	ctx.renderSessionContext = helpers.renderSessionContext.bind(helpers);
	ctx.renderSessionContextIncrementally = helpers.renderSessionContextIncrementally.bind(helpers);
	return ctx;
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
			{
				type: "toolCall",
				id: "tc-read",
				name: "read",
				arguments: { path: "src/foo.ts" },
			},
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
	it("renders bash toolResult inside its tool card, not as an orphan `⎿` line", async () => {
		await Settings.init({ inMemory: true });
		const transcript = transcriptWith(cursorTurn());
		const ctx = makeRenderCtx(transcript);

		await new UiHelpers(ctx).renderInitialMessages();

		// Block structure: an assistant message, then a bash tool card for
		// the synthesized bash block, then a read group for the synthesized
		// read block. Absent the
		// synthesis (pre-fix), neither would exist — both results would fall
		// through `addMessageToChat` (a no-op for `toolResult`) and vanish.
		const rendered = renderTranscript(ctx).join("\n");
		expect(rendered).toContain("Reading and listing:");
		// Bash result is fully surfaced inside the bash card —
		// header carries the command, body carries the output.
		expect(rendered).toContain("ls -1");
		expect(rendered).toContain("BASH_RESULT_MARKER");
		// Read result flows into the read group. Its file-content
		// preview is gated by the `read.toolResultPreview` setting (off in
		// this harness), so we assert on the pairing signal: the read call
		// appears with its path, only reachable when the toolResult attaches.
		expect(rendered).toContain("Read src/foo.ts");
	});
});
