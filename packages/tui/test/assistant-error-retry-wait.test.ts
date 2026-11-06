/**
 * A failed turn's retry wait reaches the transcript only as display text,
 * rendered from `AssistantMessage.errorRetryAfterMs`. Without the field no
 * wait is rendered, even when a message persisted before the wait was
 * structured still names one in its text.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { resolveAssistantErrorPresentation } from "@oh-my-pi/pi-tui/chat/transcript-render-helpers";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme(false);
});

const OLD_TEXT = "503 overloaded retry-after-ms=9000";

function failed(errorMessage: string, errorRetryAfterMs?: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "error",
		errorMessage,
		errorRetryAfterMs,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
}

describe("a failed turn's retry wait in the transcript", () => {
	it("presents the wait from errorRetryAfterMs, and none scanned from the text", () => {
		expect(resolveAssistantErrorPresentation(failed("503 overloaded", 9000))).toEqual({
			kind: "full",
			text: "503 overloaded (retry after 9.0s)",
			body: "503 overloaded",
			retryAfterMs: 9000,
			isError: true,
		});
		expect(resolveAssistantErrorPresentation(failed(OLD_TEXT))).toEqual({
			kind: "full",
			text: OLD_TEXT,
			body: OLD_TEXT,
			isError: true,
		});
	});

	it("draws the wait in the inline error block, and leaves an old message's text as it was", () => {
		const current = Bun.stripANSI(
			new AssistantMessageComponent(failed("503 overloaded", 9000)).render(100).join("\n"),
		);
		expect(current).toContain("Error: 503 overloaded (retry after 9.0s)");

		const old = Bun.stripANSI(new AssistantMessageComponent(failed(OLD_TEXT)).render(100).join("\n"));
		expect(old).toContain(`Error: ${OLD_TEXT}`);
		expect(old).not.toContain("(retry after");
	});
});
