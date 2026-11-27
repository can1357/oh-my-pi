/** @jsxImportSource @oh-my-pi/pi-tui */
import { afterEach, describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createRoot, isUiNode, type UiNode } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { clearCopiedCode, copiedCodeHash } from "@oh-my-pi/pi-tui/term/painters/md";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { CODE_COPY_ACT_PREFIX, codeBlockHash } from "@oh-my-pi/pi-tui/text/markdown/index";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import "../../../../src/ui/styles/messages";
import { AssistantMessageBlock } from "../../../../src/ui/transcript/messages/assistant-message";

const theme = loadThemeSync("dark");

function makeAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		provider: "p",
		model: "m",
		api: "x",
		timestamp: 1_700_000_000_000,
	} as AssistantMessage;
}

afterEach(() => {
	clearCopiedCode();
});

describe("assistant message clickable code-block copy button", () => {
	test("renders [Copy] hits on fenced code blocks, strips trailing spaces on click, and shows [Copied] feedback", () => {
		const actions: Array<{ act: string; copyText?: string }> = [];
		const markdown = [
			"First block:",
			"```ts",
			"\tconst first = 1;   ",
			"  const second = 2;\t",
			"```",
			"",
			"Second block:",
			"```sh",
			"echo ok  ",
			"```",
		].join("\n");

		let rootNode!: UiNode;
		const dispose = createRoot(stop => {
			const built = AssistantMessageBlock({
				model: {
					message: makeAssistantMessage(markdown),
					finalized: true,
					onAction: (act, copyText) => actions.push({ act, copyText }),
				},
			});
			if (!isUiNode(built)) throw new Error("expected UiNode");
			rootNode = built;
			return stop;
		});

		try {
			// Native TSP <md> child carries codeCopy: true when onAction is wired.
			const mdChild = rootNode.children().find(child => child.kind === "md");
			expect((mdChild?.props() as { codeCopy?: boolean } | undefined)?.codeCopy).toBe(true);

			const env = staticEnvironment(theme);
			const block = paintNode(env, rootNode, 60);
			const copyHits = (block.hits ?? []).filter(hit => hit.act?.startsWith(CODE_COPY_ACT_PREFIX));

			expect(copyHits).toHaveLength(2);
			expect(block.rows.every(row => !row.includes("pi-code-copy"))).toBe(true);

			const firstHash = codeBlockHash("\tconst first = 1;\n  const second = 2;");
			const secondHash = codeBlockHash("echo ok");
			expect(copyHits[0]!.act).toBe(`${CODE_COPY_ACT_PREFIX}${firstHash}`);
			expect(copyHits[1]!.act).toBe(`${CODE_COPY_ACT_PREFIX}${secondHash}`);

			const firstHeader = stripEscapes(block.rows[copyHits[0]!.row]!);
			expect(firstHeader.slice(copyHits[0]!.col, copyHits[0]!.col + copyHits[0]!.width)).toBe("[Copy]");

			// Simulate left-clicking the first code block's [Copy] button (bubbles onAction to AssistantMessageBlock).
			rootNode.handlers.onAction?.(copyHits[0]!.act!, {
				type: "action",
				key: "",
				act: copyHits[0]!.act!,
				mods: [],
			});

			expect(actions).toHaveLength(1);
			expect(actions[0]!.act).toBe("copy-code");
			expect(actions[0]!.copyText).toContain("const first = 1;");
			expect(actions[0]!.copyText).toContain("const second = 2;");

			// Repainting immediately shows [Copied] on the clicked block and [Copy] on the second block.
			const updated = paintNode(env, rootNode, 60);
			const updatedHits = (updated.hits ?? []).filter(hit => hit.act?.startsWith(CODE_COPY_ACT_PREFIX));
			expect(updatedHits).toHaveLength(2);
			const updatedFirstHeader = stripEscapes(updated.rows[updatedHits[0]!.row]!);
			const updatedSecondHeader = stripEscapes(updated.rows[updatedHits[1]!.row]!);
			expect(updatedFirstHeader.slice(updatedHits[0]!.col, updatedHits[0]!.col + updatedHits[0]!.width)).toBe(
				"[Copied]",
			);
			expect(updatedSecondHeader.slice(updatedHits[1]!.col, updatedHits[1]!.col + updatedHits[1]!.width)).toBe(
				"[Copy]",
			);
		} finally {
			dispose();
		}
	});

	test("omits [Copy] hits and suppresses [Copied] feedback when model.onAction is absent", () => {
		const markdown = "```ts\nconst previewOnly = true;\n```";
		let rootNode!: UiNode;
		const dispose = createRoot(stop => {
			const built = AssistantMessageBlock({
				model: {
					message: makeAssistantMessage(markdown),
					finalized: true,
				},
			});
			if (!isUiNode(built)) throw new Error("expected UiNode");
			rootNode = built;
			return stop;
		});

		try {
			const mdChild = rootNode.children().find(child => child.kind === "md");
			expect((mdChild?.props() as { codeCopy?: boolean } | undefined)?.codeCopy).toBeUndefined();

			const env = staticEnvironment(theme);
			const block = paintNode(env, rootNode, 60);
			const copyHits = (block.hits ?? []).filter(hit => hit.act?.startsWith(CODE_COPY_ACT_PREFIX));
			expect(copyHits).toHaveLength(0);

			const hash = codeBlockHash("const previewOnly = true;");
			rootNode.handlers.onAction?.(`${CODE_COPY_ACT_PREFIX}${hash}`, {
				type: "action",
				key: "",
				act: `${CODE_COPY_ACT_PREFIX}${hash}`,
				mods: [],
			});
			expect(copiedCodeHash()).toBeUndefined();
		} finally {
			dispose();
		}
	});
});
