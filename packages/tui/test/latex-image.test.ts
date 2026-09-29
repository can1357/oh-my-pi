import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "../src/chat/assistant-message";
import { latexImage } from "../src/chat/latex-image";
import { assistantText } from "../src/overlays/copy-targets";
import { ImageProtocol, TERMINAL } from "../src/terminal-capabilities";
import { initTheme } from "../src/theme";

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

describe("LaTeX image rendering", () => {
	it("rasterizes a display expression with the requested foreground", async () => {
		const image = await latexImage("x+y=1", "#123456");
		const metadata = await new Bun.Image(Buffer.from(image.data, "base64")).metadata();
		expect(image.mimeType).toBe("image/png");
		expect(metadata.width).toBeGreaterThan(0);
		expect(metadata.height).toBeGreaterThan(0);
	});

	it("keeps inline math in text and renders only standalone display math as an image", async () => {
		const protocol = Object.getOwnPropertyDescriptor(TERMINAL, "imageProtocol")!;
		Object.defineProperty(TERMINAL, "imageProtocol", { value: ImageProtocol.Iterm2 });
		const source = "Let $x$ satisfy $x+y=1$.\n\n$$\\frac{a}{b}$$";
		const updated = Promise.withResolvers<void>();
		const message = assistant(source);
		const component = new AssistantMessageComponent(message, false, () => updated.resolve());
		component.render(80);
		await updated.promise;
		const rendered = component.render(80).join("\n");
		expect(Bun.stripANSI(rendered)).toContain("Let x satisfy x+y=1.");
		expect(rendered.match(/\x1b]1337;File=inline=1/g)).toHaveLength(1);
		expect(assistantText(message)).toBe(source);
		Object.defineProperty(TERMINAL, "imageProtocol", protocol);
	});
});
