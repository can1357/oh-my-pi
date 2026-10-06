import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ImageBudget, ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const originalImageProtocol = TERMINAL.imageProtocol;
const FIGURE = "<svg viewBox='0 0 80 20'><rect width='80' height='20' fill='var(--accent)'/></svg>";

function message(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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

/** A component whose figure updates resolve `changed` (the raster landed or fell back). */
function figureComponent(text?: string): { component: AssistantMessageComponent; changed: Promise<void> } {
	const changed = Promise.withResolvers<void>();
	const component = new AssistantMessageComponent(
		text === undefined ? undefined : message(text),
		false,
		() => changed.resolve(),
		[],
		new ImageBudget(),
	);
	return { component, changed: changed.promise };
}

const plain = (component: AssistantMessageComponent): string => Bun.stripANSI(component.render(100).join("\n"));

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	setTerminalImageProtocol(ImageProtocol.Kitty);
});

afterEach(() => {
	setTerminalImageProtocol(originalImageProtocol);
});

describe("AssistantMessageComponent svg figures", () => {
	it("draws a finished svg fence as an inline image between its prose", async () => {
		const { component, changed } = figureComponent(`Before\n\n\`\`\`svg\n${FIGURE}\n\`\`\`\n\nAfter`);
		await changed;

		const rendered = component.render(100).join("\n");
		expect(rendered).toContain("\x1b_G");
		expect(plain(component)).toContain("Before");
		expect(plain(component)).toContain("After");
		expect(plain(component)).not.toContain("<rect");
	});

	it("draws the partial figure while its fence is still streaming", async () => {
		const { component, changed } = figureComponent();
		component.updateContent(message(`Look:\n\n\`\`\`svg\n<svg viewBox='0 0 80 20'><rect width='80' height`), {
			transient: true,
		});
		component.render(100);
		await changed;

		expect(component.render(100).join("\n")).toContain("\x1b_G");
		expect(plain(component)).not.toContain("<rect");
	});

	it("falls back to the fenced code when the finished source does not render", async () => {
		const { component, changed } = figureComponent("Bad:\n\n```svg\n<svg><rect width='x' </svg>\n```");
		await changed;

		expect(plain(component)).toContain("```svg");
		expect(plain(component)).toContain("<rect width='x'");
		expect(component.render(100).join("\n")).not.toContain("\x1b_G");
	});

	it("keeps a finished reply out of native scrollback until its figure's raster lands", async () => {
		const { component, changed } = figureComponent(`\`\`\`svg\n${FIGURE}\n\`\`\``);
		const transcript = new TranscriptContainer();
		transcript.addChild(component);

		expect(transcript.peekFinalizedBatch(100, 0)).toBeUndefined();
		await changed;
		expect(transcript.peekFinalizedBatch(100, 0)?.rows.join("\n")).toContain("\x1b_G");
	});

	it("keeps the fence as code on a terminal without graphics", () => {
		setTerminalImageProtocol(null);
		const { component } = figureComponent(`\`\`\`svg\n${FIGURE}\n\`\`\``);

		expect(plain(component)).toContain("```svg");
		expect(component.isTranscriptBlockPending()).toBe(false);
	});
});
