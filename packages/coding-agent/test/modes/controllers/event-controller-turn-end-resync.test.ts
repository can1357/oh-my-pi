/**
 * Turn end must repair untracked physical scroll, not just repaint: during
 * streaming, scroll the ledger never observed (ConPTY pending-wrap
 * materialization, oversized image rows, multiplexer REP expansion) leaves the
 * TUI's viewport anchor stale, and even a full-rewrite frame then repaints at
 * the wrong physical offset, folding new content over the previous block.
 *
 * Contract: `agent_end` triggers the TUI anchor resync (`resyncViewportAnchor`)
 * BEFORE the render, and upgrades the render from a plain request to a forced
 * viewport repaint — never a destructive clearScrollback.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

function makeAssistantMessage(stopReason: "stop" | "aborted" | "error"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		stopReason,
		usage: { inputTokens: 0, outputTokens: 0 },
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

function makeAgentEndEvent(messages: AssistantMessage[]): Extract<AgentSessionEvent, { type: "agent_end" }> {
	return { type: "agent_end", messages } as Extract<AgentSessionEvent, { type: "agent_end" }>;
}

describe("EventController turn-end viewport resync", () => {
	it("agent_end triggers the anchor resync and a forced repaint", async () => {
		const ctx = createInteractiveModeContext({ sessionManager: { getSessionName: () => "test-session" } });
		const resync = vi.spyOn(ctx.ui, "resyncViewportAnchor");
		const requestRender = vi.spyOn(ctx.ui, "requestRender");
		const controller = new EventController(ctx);
		try {
			await controller.handleEvent(makeAgentEndEvent([makeAssistantMessage("stop")]));

			expect(resync).toHaveBeenCalledTimes(1);
			expect(requestRender).toHaveBeenCalledWith(true);
			// The resync precedes the frame it corrects.
			expect(resync.mock.invocationCallOrder[0]).toBeLessThan(requestRender.mock.invocationCallOrder[0]!);
			// The forced repaint must not carry the destructive clearScrollback intent.
			expect(requestRender).not.toHaveBeenCalledWith(true, { clearScrollback: true });
		} finally {
			controller.dispose();
		}
	});
});
