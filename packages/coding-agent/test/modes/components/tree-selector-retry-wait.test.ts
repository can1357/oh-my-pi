/**
 * A failed turn's tree row cuts the error to 80 characters, then renders the
 * server's retry wait from `errorRetryAfterMs`, so a long error keeps its wait.
 * Without the field no wait is rendered, even when the text names one.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { TreeSelectorComponent } from "@oh-my-pi/pi-tui/overlays/tree-selector";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import type { SessionTreeNode } from "@oh-my-pi/pi-coding-agent/session/session-entries";

function failedTurnRow(errorMessage: string, errorRetryAfterMs?: number): string {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		errorRetryAfterMs,
		timestamp: 2,
	};
	const user: SessionTreeNode = {
		entry: {
			type: "message",
			id: "user",
			parentId: null,
			timestamp: new Date(1).toISOString(),
			message: { role: "user", content: "go", timestamp: 1 },
		},
		children: [],
	};
	user.children.push({
		entry: { type: "message", id: "failed", parentId: "user", timestamp: new Date(2).toISOString(), message },
		children: [],
	});
	const selector = new TreeSelectorComponent(
		[user],
		"user",
		60,
		() => {},
		() => {},
	);
	const rows = Bun.stripANSI(selector.render(220).join("\n")).split("\n");
	return rows.find(row => row.includes("assistant:")) ?? "";
}

describe("TreeSelectorComponent failed turn retry wait", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	it("keeps a long error's wait after cutting the error", () => {
		const longError = `503 ${"overloaded ".repeat(20)}`.trim();
		const row = failedTurnRow(longError, 9000);
		expect(row).toContain(`${longError.slice(0, 80)} (retry after 9.0s)`);
		expect(row).not.toContain(longError);
	});

	it("renders no wait without the field, even when the text names one", () => {
		const row = failedTurnRow("503 overloaded retry-after-ms=9000");
		expect(row).toContain("503 overloaded retry-after-ms=9000");
		expect(row).not.toContain("(retry after");
	});
});
