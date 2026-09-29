import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "../src/chat/assistant-message";
import { latexImage } from "../src/chat/latex-image";
import { latexSpans } from "../src/chat/latex-spans";
import { assistantText } from "../src/overlays/copy-targets";
import { ImageProtocol, TERMINAL } from "../src/terminal-capabilities";
import { initTheme } from "../src/theme";

const terminal = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
const originalProtocol = TERMINAL.imageProtocol;

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "fixture",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

beforeAll(async () => {
	await initTheme();
});

afterAll(() => {
	terminal.imageProtocol = originalProtocol;
});

describe("LaTeX image rendering", () => {
	it("extracts math while ignoring code spans and fences", () => {
		expect(latexSpans("$x^2$ and `$ignored$`\n\n```latex\n$also_ignored$\n```\n\n$$\\frac{a}{b}$$")).toEqual([
			{ tex: "x^2", display: false },
			{ tex: "\\frac{a}{b}", display: true },
		]);
	});

	it("renders MathJax SVG as a PNG image", async () => {
		const image = await latexImage("\\frac{a}{b}", true);
		const metadata = await new Bun.Image(Buffer.from(image.data, "base64")).metadata();
		expect(image.mimeType).toBe("image/png");
		expect(metadata.width).toBeGreaterThan(0);
		expect(metadata.height).toBeGreaterThan(0);
	});

	it("adds an image render without replacing the original LaTeX text", async () => {
		terminal.imageProtocol = ImageProtocol.Iterm2;
		const source = "Formula: $$\\frac{a}{b}$$";
		let resolveUpdate: (() => void) | undefined;
		const updated = new Promise<void>(resolve => {
			resolveUpdate = resolve;
		});
		const message = assistant(source);
		const component = new AssistantMessageComponent(message, false, () => resolveUpdate?.());
		await updated;
		const rendered = component.render(80).join("\n");
		expect(rendered).toContain("\x1b]1337;File=inline=1");
		expect(assistantText(message)).toBe(source);
	});
});
