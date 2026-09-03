import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AssistantThinkingRenderer } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AssistantMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/assistant-message";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { clearMermaidCache } from "@oh-my-pi/pi-coding-agent/modes/theme/mermaid-cache";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL, Text } from "@oh-my-pi/pi-tui";

const originalImageProtocol = TERMINAL.imageProtocol;

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

function renderAssistantMessage(markdown: string, renderers: readonly AssistantThinkingRenderer[] = []): string {
	const component = new AssistantMessageComponent(createAssistantMessage(markdown), false, undefined, renderers);
	return Bun.stripANSI(component.render(120).join("\n"))
		.split("\n")
		.map(line => line.trimEnd())
		.join("\n");
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	clearMermaidCache();
	setTerminalImageProtocol(null);
});

afterEach(() => {
	resetSettingsForTest();
	setTerminalImageProtocol(originalImageProtocol);
	clearMermaidCache();
});

describe("AssistantMessageComponent transcript lifecycle", () => {
	it("keeps a revised streaming message mutable until finalization", () => {
		const component = new AssistantMessageComponent();
		const transcript = new TranscriptContainer();
		transcript.addChild(component);
		component.updateContent(
			createAssistantMessage(
				"First completed paragraph is deliberately long enough to wrap.\n\nCurrent partial paragraph",
			),
			{ transient: true },
		);
		transcript.renderViewport(80, 20, { now: 0, tick: 0 });

		component.updateContent(
			createAssistantMessage("Revised opening paragraph replaces the prior draft.\n\nCurrent partial paragraph"),
			{ transient: true },
		);
		const live = Bun.stripANSI(transcript.renderViewport(80, 20, { now: 1, tick: 1 }).join("\n"));
		expect(live).toContain("Revised opening paragraph");
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();

		component.markTranscriptBlockFinalized();
		const batch = transcript.peekFlushBatch(80);
		expect(Bun.stripANSI(batch?.rows.join("\n") ?? "")).toContain("Revised opening paragraph");
	});

	it("retires the frozen thinking prefix into history while still streaming", () => {
		const thinkingMessage = (thinking: string): AssistantMessage => ({
			...createAssistantMessage(""),
			content: [{ type: "thinking", thinking }],
		});
		const component = new AssistantMessageComponent();
		const transcript = new TranscriptContainer();
		transcript.addChild(component);

		component.updateContent(
			thinkingMessage("Alpha reasoning paragraph.\n\nBeta reasoning paragraph.\n\nPartial tail"),
			{ transient: true },
		);
		transcript.renderViewport(80, 20, { now: 0, tick: 0 });
		component.updateContent(
			thinkingMessage(
				"Alpha reasoning paragraph.\n\nBeta reasoning paragraph.\n\nPartial tail keeps growing.\n\nNewer tail",
			),
			{ transient: true },
		);
		transcript.renderViewport(80, 20, { now: 1, tick: 1 });

		// Under pressure the frozen thinking prefix retires while streaming.
		const first = transcript.peekFinalizedBatch(80, 0);
		expect(first).toBeDefined();
		const firstText = Bun.stripANSI(first!.rows.join("\n"));
		expect(firstText).toContain("Alpha reasoning paragraph.");
		expect(firstText).not.toContain("Newer tail");
		transcript.acknowledgeFinalizedBatch(first!.id);

		// Emitted rows leave the mutable viewport; the streaming tail stays live.
		const live = Bun.stripANSI(transcript.renderViewport(80, 20, { now: 2, tick: 2 }).join("\n"));
		expect(live).not.toContain("Alpha reasoning paragraph.");
		expect(live).toContain("Newer tail");

		// Finalization retires exactly the un-emitted remainder — no duplicates.
		component.markTranscriptBlockFinalized();
		const flush = transcript.peekFlushBatch(80);
		const flushText = Bun.stripANSI(flush?.rows.join("\n") ?? "");
		expect(flushText).not.toContain("Alpha reasoning paragraph.");
		expect(flushText).toContain("Newer tail");
	});

	it("appends a late cache-miss marker after assistant output", () => {
		const component = new AssistantMessageComponent();
		component.updateContent(
			createAssistantMessage(
				"First completed paragraph is deliberately long enough to wrap.\n\nCurrent partial paragraph",
			),
			{ transient: true },
		);
		const transcript = new TranscriptContainer();
		transcript.addChild(component);
		transcript.renderViewport(80, 20, { now: 0, tick: 0 });

		component.setCacheInvalidation({ reprocessedTokens: 50_000 });
		component.markTranscriptBlockFinalized();

		const batch = transcript.peekFlushBatch(80);
		const rendered = Bun.stripANSI(batch?.rows.join("\n") ?? "");
		expect(rendered).toContain("Current partial paragraph");
		expect(rendered.indexOf("cache miss")).toBeGreaterThan(rendered.indexOf("Current partial paragraph"));
	});
});

describe("AssistantMessageComponent mermaid markdown", () => {
	it("renders fenced Mermaid ASCII without terminal image protocol", () => {
		const rendered = renderAssistantMessage("```mermaid\nflowchart TD\n  Start-->Stop\n```");

		expect(TERMINAL.imageProtocol).toBeNull();
		expect(rendered).toContain("Start");
		expect(rendered).toContain("Start--");
		expect(rendered).not.toContain("```mermaid");
		expect(rendered).not.toContain("flowchart TD");
	});

	it("aligns box borders for CJK labels in display columns", () => {
		// Defends the first-party vendored Mermaid ASCII renderer's CJK/East-Asian
		// display-width handling (packages/utils/src/vendor/mermaid-ascii): Hangul is 2
		// terminal columns wide, so every row of a single-node diagram must
		// measure the same display width or the right border drifts.
		const rendered = renderAssistantMessage("```mermaid\nflowchart TD\n  A[수집 스케줄러]\n```");
		const displayCols = (line: string): number => {
			let width = 0;
			for (const ch of line) {
				const code = ch.codePointAt(0) ?? 0;
				const wide =
					(code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
					(code >= 0x2e80 && code <= 0x9fff) || // CJK radicals/ideographs
					(code >= 0xff00 && code <= 0xff60); // fullwidth forms
				width += wide ? 2 : 1;
			}
			return width;
		};
		const boxRows = rendered.split("\n").filter(line => /[┌│└]/.test(line));
		expect(boxRows.length).toBeGreaterThanOrEqual(3);
		expect(new Set(boxRows.map(displayCols)).size).toBe(1);
	});

	it("falls back to the fenced code block when Mermaid rendering fails", () => {
		const rendered = renderAssistantMessage("```mermaid\nthis is not mermaid\n```");

		expect(TERMINAL.imageProtocol).toBeNull();
		expect(rendered).toContain("```mermaid");
		expect(rendered).toContain("this is not mermaid");
	});
});

describe("AssistantMessageComponent thinking renderers", () => {
	it("renders all extension outputs below visible thinking blocks in registration order", () => {
		const contexts: Array<{ contentIndex: number; thinkingIndex: number; text: string }> = [];
		const component = new AssistantMessageComponent(
			{
				...createAssistantMessage(""),
				content: [{ type: "thinking", thinking: "I should inspect the input." }],
			},
			false,
			undefined,
			[
				context => {
					contexts.push({
						contentIndex: context.contentIndex,
						thinkingIndex: context.thinkingIndex,
						text: context.text,
					});
					return new Text("first note", 1, 0);
				},
				() => new Text("second note", 1, 0),
			],
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("I should inspect the input.");
		expect(rendered.indexOf("I should inspect the input.")).toBeLessThan(rendered.indexOf("first note"));
		expect(rendered.indexOf("first note")).toBeLessThan(rendered.indexOf("second note"));
		expect(contexts).toEqual([{ contentIndex: 0, thinkingIndex: 0, text: "I should inspect the input." }]);
	});

	it("keeps original thinking visible when an extension renderer throws", () => {
		const component = new AssistantMessageComponent(
			{
				...createAssistantMessage(""),
				content: [{ type: "thinking", thinking: "I should inspect the input." }],
			},
			false,
			undefined,
			[
				() => {
					throw new Error("renderer failed");
				},
			],
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).toContain("I should inspect the input.");
		expect(rendered).not.toContain("renderer failed");
	});

	it("keeps async renderer components mounted when they request a render", () => {
		let renderRequests = 0;
		let rendererCalls = 0;
		let mountedNote: Text | undefined;
		let requestRender: (() => void) | undefined;
		const component = new AssistantMessageComponent(
			{
				...createAssistantMessage(""),
				content: [{ type: "thinking", thinking: "I should inspect the input." }],
			},
			false,
			() => {
				renderRequests += 1;
			},
			[
				context => {
					rendererCalls += 1;
					requestRender = context.requestRender;
					const note = new Text("translation loading", 1, 0);
					mountedNote ??= note;
					return note;
				},
			],
		);

		expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("translation loading");
		mountedNote?.setText("translation ready");
		requestRender?.();

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(renderRequests).toBe(1);
		expect(rendererCalls).toBe(1);
		expect(rendered).toContain("translation ready");
		expect(rendered).not.toContain("translation loading");
	});

	it("does not invoke extension renderers when thinking is hidden", () => {
		let rendererCalled = false;
		const component = new AssistantMessageComponent(
			{
				...createAssistantMessage(""),
				content: [{ type: "thinking", thinking: "I should inspect the input." }],
			},
			true,
			undefined,
			[
				() => {
					rendererCalled = true;
					return new Text("hidden note", 1, 0);
				},
			],
		);

		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		expect(rendered).not.toContain("Thinking...");
		expect(rendered).not.toContain("I should inspect the input.");
		expect(rendered).not.toContain("hidden note");
		expect(rendererCalled).toBe(false);
	});
});

describe("AssistantMessageComponent images", () => {
	it("renders native assistant images in content order and honors image visibility", () => {
		const message: AssistantMessage = {
			...createAssistantMessage(""),
			content: [
				{ type: "text", text: "Before image" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				{ type: "text", text: "After image" },
			],
		};
		const component = new AssistantMessageComponent(message);

		const rendered = Bun.stripANSI(component.render(80).join("\n"));
		expect(rendered.indexOf("Before image")).toBeLessThan(rendered.indexOf("[Image: image/png]"));
		expect(rendered.indexOf("[Image: image/png]")).toBeLessThan(rendered.indexOf("After image"));
		component.setImagesVisible(false);
		expect(Bun.stripANSI(component.render(80).join("\n"))).not.toContain("[Image: image/png]");
	});

	it("converts WebP tool images for Kitty terminal rendering", async () => {
		const webpBase64 = Buffer.from(
			await Bun.file(path.join(import.meta.dir, "../../../../../assets/python.webp")).arrayBuffer(),
		).toBase64();
		setTerminalImageProtocol(ImageProtocol.Kitty);

		const converted = Promise.withResolvers<void>();
		const component = new AssistantMessageComponent(createAssistantMessage("done"), false, () => converted.resolve());
		component.setToolResultImages("read-1", [{ type: "image", data: webpBase64, mimeType: "image/webp" }]);

		await converted.promise;
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("\x1b_G");
		expect(rendered).not.toContain("[Image: image/webp]");
	});
});
