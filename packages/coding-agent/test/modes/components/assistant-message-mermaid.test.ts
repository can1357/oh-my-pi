import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AssistantThinkingRenderer } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/render-types";
import { signal } from "@oh-my-pi/pi-tui";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import "../../../src/ui/styles/messages";
import { printRows } from "../../../src/ui/print-rows";
import {
	AssistantMessageBlock,
	type AssistantMessageModel,
} from "../../../src/ui/transcript/messages/assistant-message";
import { renderMarkdown } from "@oh-my-pi/pi-tui/text/markdown/render";
import { setMarkdownLook } from "@oh-my-pi/pi-tui/text/markdown/look";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

function createAssistantMessage(markdown: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: markdown }],
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function thinkingMessage(thinking: string): AssistantMessage {
	return { ...createAssistantMessage(""), content: [{ type: "thinking", thinking }] };
}

/** A settled assistant block's plain rows at `width` (no terminal images). */
function render(message: AssistantMessage, model: Partial<AssistantMessageModel> = {}, width = 120): string {
	const full: AssistantMessageModel = { message: signal(message), finalized: signal(true), ...model };
	return printRows(() => AssistantMessageBlock({ model: full }), width)
		.map(line => Bun.stripANSI(line).trimEnd())
		.join("\n");
}

/** Plain rows as `text` renders. */
const note = (text: string) => ({ render: () => [text] });

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("assistant message mermaid markdown", () => {
	it("renders fenced Mermaid ASCII without a terminal image protocol", () => {
		const rendered = render(createAssistantMessage("```mermaid\nflowchart TD\n  Start-->Stop\n```"));

		expect(rendered).toContain("Start");
		expect(rendered).toContain("Stop");
		expect(rendered).toMatch(/[►▼]/);
		expect(rendered).not.toContain("Start--");
		expect(rendered).not.toContain("```mermaid");
		expect(rendered).not.toContain("flowchart TD");
	});

	it("aligns box borders for CJK labels in display columns", () => {
		// Hangul is 2 terminal columns wide, so every row of a single-node diagram
		// must measure the same display width or the right border drifts.
		const rendered = render(createAssistantMessage("```mermaid\nflowchart TD\n  A[수집 스케줄러]\n```"));
		const boxRows = rendered.split("\n").filter(line => /[┌│└]/.test(line));
		expect(boxRows.length).toBeGreaterThanOrEqual(3);
		expect(new Set(boxRows.map(line => Bun.stringWidth(line))).size).toBe(1);
	});

	it("falls back to the fenced code block when Mermaid rendering fails", () => {
		const rendered = render(createAssistantMessage("```mermaid\nthis is not mermaid\n```"));

		expect(rendered).toContain("this is not mermaid");
	});
});

describe("assistant message markdown look", () => {
	afterEach(() => setMarkdownLook({ colorful: true, mermaid: true }));

	it("draws headings in mdHeading when colorful Markdown is off", () => {
		setMarkdownLook({ colorful: false, mermaid: true });
		const message = createAssistantMessage("# Title\n\nbody");
		const rows = printRows(
			() => AssistantMessageBlock({ model: { message: signal(message), finalized: signal(true) } }),
			40,
		);
		const heading = rows.find(row => Bun.stripANSI(row).includes("Title"))!;
		const headingOf = (colorful: boolean): string =>
			renderMarkdown("# Title", 40, { theme: currentTheme(), colorful })[0]!.trim();
		expect(headingOf(false)).not.toBe(headingOf(true));
		expect(heading).toContain(headingOf(false));
	});

	it("keeps mermaid fences as code when mermaid rendering is off", () => {
		setMarkdownLook({ colorful: true, mermaid: false });
		expect(render(createAssistantMessage("```mermaid\nflowchart TD\n  Start-->Stop\n```"))).toContain("flowchart TD");
	});
});

describe("assistant message thinking renderers", () => {
	it("renders all extension outputs below visible thinking blocks in registration order", () => {
		const contexts: Array<{ contentIndex: number; thinkingIndex: number; text: string }> = [];
		const renderers: AssistantThinkingRenderer[] = [
			context => {
				contexts.push({
					contentIndex: context.contentIndex,
					thinkingIndex: context.thinkingIndex,
					text: context.text,
				});
				return note("first note");
			},
			() => note("second note"),
		];
		const rendered = render(thinkingMessage("I should inspect the input."), {
			thinkingRenderers: signal(renderers),
			expandThinking: signal(true),
		});

		expect(rendered).toContain("I should inspect the input.");
		expect(rendered.indexOf("I should inspect the input.")).toBeLessThan(rendered.indexOf("first note"));
		expect(rendered.indexOf("first note")).toBeLessThan(rendered.indexOf("second note"));
		expect(contexts).toEqual([{ contentIndex: 0, thinkingIndex: 0, text: "I should inspect the input." }]);
	});

	it("keeps original thinking visible when an extension renderer throws", () => {
		const rendered = render(thinkingMessage("I should inspect the input."), {
			thinkingRenderers: signal<readonly AssistantThinkingRenderer[]>([
				() => {
					throw new Error("renderer failed");
				},
			]),
			expandThinking: signal(true),
		});

		expect(rendered).toContain("I should inspect the input.");
		expect(rendered).not.toContain("renderer failed");
	});

	it("redraws a renderer's output when it requests a render", () => {
		let text = "translation loading";
		let requestRender: (() => void) | undefined;
		const renderers: AssistantThinkingRenderer[] = [
			context => {
				requestRender = context.requestRender;
				return { render: () => [text] };
			},
		];
		const model: AssistantMessageModel = {
			message: signal(thinkingMessage("I should inspect the input.")),
			finalized: signal(true),
			expandThinking: signal(true),
			thinkingRenderers: signal(renderers),
		};
		const term = createTestTerminal(() => ({ main: AssistantMessageBlock({ model }) }), { columns: 120, rows: 40 });
		try {
			expect(term.screen().join("\n")).toContain("translation loading");
			text = "translation ready";
			requestRender?.();
			term.render();
			const rendered = term.screen().join("\n");
			expect(rendered).toContain("translation ready");
			expect(rendered).not.toContain("translation loading");
		} finally {
			term.dispose();
		}
	});

	it("does not invoke extension renderers when thinking is hidden", () => {
		let rendererCalled = false;
		const rendered = render(thinkingMessage("I should inspect the input."), {
			hideThinking: signal(true),
			thinkingRenderers: signal<readonly AssistantThinkingRenderer[]>([
				() => {
					rendererCalled = true;
					return note("hidden note");
				},
			]),
		});

		expect(rendered).not.toContain("I should inspect the input.");
		expect(rendered).not.toContain("hidden note");
		expect(rendererCalled).toBe(false);
	});
});

describe("assistant message images", () => {
	it("renders assistant images in content order and honors image visibility", () => {
		const message: AssistantMessage = {
			...createAssistantMessage(""),
			content: [
				{ type: "text", text: "Before image" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				{ type: "text", text: "After image" },
			],
		};
		const shown = render(message, {}, 80);
		expect(shown.indexOf("Before image")).toBeLessThan(shown.indexOf("[Image: image/png]"));
		expect(shown.indexOf("[Image: image/png]")).toBeLessThan(shown.indexOf("After image"));
		expect(render(message, { showImages: signal(false) }, 80)).not.toContain("[Image: image/png]");
	});
});
