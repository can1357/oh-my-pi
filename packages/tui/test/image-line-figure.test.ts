import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TspHarness } from "./native/tsp-harness";

/** A 1×1 PNG: enough for the header probe, small enough to inline. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
	"base64",
);

function answer(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
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

/**
 * Render until the picture's graphic rows appear: the first render starts the
 * file read, a landed read repaints, and a SIXEL encode lands a repaint later.
 */
async function drawnRows(component: AssistantMessageComponent, tries = 40): Promise<readonly string[]> {
	let rows = component.render(80);
	for (let try_ = 0; try_ < tries && !rows.some(row => TERMINAL.isImageLine(row)); try_++) {
		await new Promise(resolve => setTimeout(resolve, 10));
		rows = component.render(80);
	}
	return rows;
}

describe("an assistant line naming a local picture", () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-image-line-"));
	const picture = join(dir, "shot.png");
	writeFileSync(picture, PNG);
	let harness: TspHarness | undefined;

	beforeAll(async () => {
		await initTheme(false);
	});

	afterEach(() => {
		harness?.stop();
		harness = undefined;
		setNativeRendering(false);
		setTerminalImageProtocol(null);
	});

	it("draws the file on a graphics terminal, with the prose around it intact", async () => {
		// Kitty placement is encoded in-band, so the graphic rows exist as soon as the bytes land.
		setTerminalImageProtocol(ImageProtocol.Kitty);
		setKittyGraphics({ unicodePlaceholders: false });
		const component = new AssistantMessageComponent(answer(`Here it is:\n\n![shot](${picture})\n\nThat is all.`));
		const rows = await drawnRows(component);
		const text = Bun.stripANSI(rows.join("\n"));
		expect(text).toContain("Here it is:");
		expect(text).toContain("That is all.");
		expect(text).not.toContain("Loading image…");
		expect(text).not.toContain("![shot]");
		expect(rows.some(row => TERMINAL.isImageLine(row))).toBe(true);
	});

	it("keeps the line as written when the file is not there", async () => {
		setTerminalImageProtocol(ImageProtocol.Kitty);
		const missing = join(dir, "absent.png");
		const component = new AssistantMessageComponent(answer(`Look:\n\n![shot](${missing})`));
		const text = Bun.stripANSI((await drawnRows(component)).join("\n"));
		expect(text).toContain(`![shot](${missing})`);
	});

	it("hands the native terminal a media node with the file's path", async () => {
		const component = new AssistantMessageComponent(answer(`Here it is:\n\n![shot](${picture})\n\nThat is all.`));
		harness = await TspHarness.start();
		harness.tui.addChild(component);
		await harness.render();
		const media = harness.findAll(node => node.k === "media");
		expect(media).toHaveLength(1);
		expect((media[0]!.p as { path?: string } | undefined)?.path).toBe(picture);
	});

	it("leaves the line in the markdown a native terminal draws when the file is gone", async () => {
		const missing = join(dir, "gone.png");
		const component = new AssistantMessageComponent(answer(`Look:\n\n![shot](${missing})`));
		harness = await TspHarness.start();
		harness.tui.addChild(component);
		await harness.render();
		expect(harness.findAll(node => node.k === "media")).toHaveLength(0);
		const drawn = harness
			.findAll(node => node.k === "md")
			.map(node => (node.p as { text?: string } | undefined)?.text ?? "");
		expect(drawn.join("\n")).toContain(`![shot](${missing})`);
	});
});
