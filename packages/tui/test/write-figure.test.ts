import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { writeToolRenderer } from "@oh-my-pi/pi-tui/tools/write";

const originalImageProtocol = TERMINAL.imageProtocol;
const SVG = "<svg viewBox='0 0 160 40'><rect width='160' height='40' fill='#3b82f6'/></svg>";
const MERMAID = "flowchart LR\n  A[Start] --> B[Ship]\n";
const OBJ = "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
const WROTE = { content: [{ type: "text", text: "Wrote" }], details: {} };

/** A write card still streaming `content`, whose repaint requests resolve `changed()`. */
function streamingWrite(path: string, content: string) {
	let resolve = () => {};
	const ui = {
		requestRender: () => resolve(),
		requestComponentRender() {},
		resetDisplay() {},
		imageBudget: new ImageBudget(),
	};
	const component = new ToolExecutionComponent("write", { path, content }, {}, undefined, ui);
	return {
		component,
		changed: () => {
			const next = Promise.withResolvers<void>();
			resolve = next.resolve;
			return next.promise;
		},
		finish: (full: string) => {
			component.updateArgs({ path, content: full });
			component.updateResult(WROTE, false);
		},
	};
}

const plain = (rows: readonly string[]): string => Bun.stripANSI(rows.join("\n"));
const hasImage = (rows: readonly string[]): boolean => rows.some(row => TERMINAL.isImageLine(row));

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	setTerminalImageProtocol(ImageProtocol.Kitty);
});

afterEach(() => {
	setTerminalImageProtocol(originalImageProtocol);
});

describe("write figures", () => {
	it("draws an svg under its card as it streams, and holds retirement until the final raster lands", async () => {
		const write = streamingWrite("logo.svg", SVG.slice(0, -"</svg>".length));
		const partial = write.changed();
		expect(hasImage(write.component.render(80))).toBe(false);
		await partial;
		expect(hasImage(write.component.render(80))).toBe(true);
		expect(write.component.isTranscriptBlockPending()).toBe(false);

		const final = write.changed();
		write.finish(SVG);
		write.component.render(80);
		expect(write.component.isTranscriptBlockPending()).toBe(true);
		await final;
		expect(write.component.isTranscriptBlockPending()).toBe(false);
		const rows = write.component.render(80);
		expect(plain(rows)).toContain("<svg viewBox='0 0 160 40'>");
		expect(hasImage(rows)).toBe(true);
	});

	it("keeps an svg write as code alone on a terminal without graphics", () => {
		setTerminalImageProtocol(null);
		const write = streamingWrite("logo.svg", SVG);
		write.finish(SVG);
		expect(write.component.isTranscriptBlockPending()).toBe(false);
		expect(hasImage(write.component.render(80))).toBe(false);
	});

	it("draws a mermaid file as its diagram once written, not while it streams or when it does not parse", () => {
		// The label shows once in the card's source, and again in a drawn diagram.
		const write = streamingWrite("flow.mmd", MERMAID);
		expect(plain(write.component.render(80)).match(/Start/g)).toHaveLength(1);
		write.finish(MERMAID);
		expect(plain(write.component.render(80)).match(/Start/g)).toHaveLength(2);

		const broken = streamingWrite("broken.mmd", "not a diagram {{{");
		broken.finish("not a diagram {{{");
		expect(plain(broken.component.render(80)).match(/not a diagram/g)).toHaveLength(1);
	});

	it("leads a native figure write with its fence: open and streaming until the content is final", () => {
		const fence = (view: { body?: readonly unknown[] } | undefined) =>
			view?.body?.find(child => typeof child === "object" && child !== null && "k" in child && child.k === "md");
		const streaming = (path: string, content: string) =>
			fence(writeToolRenderer.describeCall({ path, content }, { expanded: false, isPartial: true }));
		const written = (path: string, content: string) =>
			fence(writeToolRenderer.describeResult(WROTE, { expanded: false, isPartial: false }, { path, content }));

		expect(streaming("model.obj", OBJ)).toMatchObject({ p: { text: `\`\`\`obj\n${OBJ}`, stream: true } });
		// Tern shows an open mermaid fence as code, so the diagram waits for the whole file.
		expect(streaming("flow.mermaid", MERMAID)).toBeUndefined();
		expect(written("model.obj", OBJ)).toMatchObject({
			p: { text: `\`\`\`obj\n${OBJ.trimEnd()}\n\`\`\``, stream: false },
		});
		expect(written("flow.mermaid", MERMAID)).toMatchObject({
			p: { text: `\`\`\`mermaid\n${MERMAID.trimEnd()}\n\`\`\`` },
		});
		expect(written("logo.svg", SVG)).toMatchObject({ p: { text: `\`\`\`svg\n${SVG}\n\`\`\`` } });
		expect(written("notes.txt", "plain")).toBeUndefined();
	});
});
