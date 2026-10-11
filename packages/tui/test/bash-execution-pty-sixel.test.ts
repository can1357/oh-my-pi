import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminal = TERMINAL as unknown as MutableTerminalInfo;
const SIXEL = "\x1bPq#0;2;100;0;0#0~~\x1b\\";
// 1x1 opaque PNG, large enough for the dimension probe to report a size.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

// Condition-driven poll, not a fixed wait: the vterm write pipeline completes on
// its own scheduling (no promise/event exposed to the component) and the PTY
// refresh path rides a 50 ms chunk-gate timer plus a dynamic xterm import, so
// fake timers cannot drive it; mirrors renderUntil in bash-execution-pty.test.ts.
async function renderUntil(component: BashExecutionComponent, predicate: (text: string) => boolean): Promise<string> {
	const deadline = Date.now() + 2_000;
	let text = component.render(100).join("\n");
	while (!predicate(text) && Date.now() < deadline) {
		await Bun.sleep(10);
		text = component.render(100).join("\n");
	}
	return text;
}

describe("BashExecutionComponent PTY SIXEL", () => {
	const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	const originalAllowPassthrough = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
	const originalProtocol = TERMINAL.imageProtocol;

	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	afterEach(() => {
		terminal.imageProtocol = originalProtocol;
		if (originalForceProtocol === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		else Bun.env.PI_FORCE_IMAGE_PROTOCOL = originalForceProtocol;
		if (originalAllowPassthrough === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
		else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = originalAllowPassthrough;
	});

	it("keeps a payload emitted before its text through streaming and finalize", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";

		const component = new BashExecutionComponent("img", ui, false);
		component.appendPtyChunk(`${SIXEL}\r\nvisible\r\n`);
		component.setComplete(0, false);

		await renderUntil(component, () => component.isTranscriptBlockFinalized());

		const output = component.getOutput();
		expect(output).toContain("\x1bPq");
		expect(output).toContain("\x1b\\");
		expect(output).toContain("visible");
		expect(output).not.toContain("__OMP_SIXEL_SEQUENCE_");
	});

	it("keeps a payload emitted between text on the same row", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";

		const component = new BashExecutionComponent("img", ui, false);
		component.appendPtyChunk(`before${SIXEL}after\r\n`);
		component.setComplete(0, false);

		await renderUntil(component, () => component.isTranscriptBlockFinalized());

		const output = component.getOutput();
		expect(output).toContain("before");
		expect(output).toContain("after");
		expect(output).toContain(SIXEL);
		expect(output).not.toContain("__OMP_SIXEL_SEQUENCE_");
	});

	it("keeps a payload split across chunks without swallowing the rows after it", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";

		const component = new BashExecutionComponent("img", ui, false);
		component.appendPtyChunk("\x1bPqAB");
		component.appendPtyChunk(`C\x1b\\\r\nvisible\r\n`);
		component.setComplete(0, false);

		await renderUntil(component, () => component.isTranscriptBlockFinalized());

		const output = component.getOutput();
		expect(output).toContain("\x1bPqABC\x1b\\");
		expect(output).toContain("visible");
	});

	it("keeps a payload that is the last thing the command emits", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";

		const component = new BashExecutionComponent("img", ui, false);
		component.appendPtyChunk(`visible\r\n${SIXEL}`);
		component.setComplete(0, false);

		await renderUntil(component, () => component.isTranscriptBlockFinalized());

		const output = component.getOutput();
		expect(output).toContain("visible");
		expect(output).toContain(SIXEL);
	});

	it("holds a DCS introducer split across chunks", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";

		// The chunk boundary inside the introducer must not reach the vterm: it
		// would open a DCS string and swallow the rows that follow it.
		const component = new BashExecutionComponent("img", ui, false);
		component.appendPtyChunk("head\r\n\x1bP");
		component.appendPtyChunk(`q#0~~\x1b\\\r\nvisible\r\n`);
		component.setComplete(0, false);

		await renderUntil(component, () => component.isTranscriptBlockFinalized());

		const output = component.getOutput();
		expect(output).toContain("\x1bPq#0~~\x1b\\");
		expect(output).toContain("visible");
	});

	it("drops a payload whose rows were trimmed out of the scrollback", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";

		// Once the scrollback is full every added row splices one off the front
		// while `buffer.length` stays at its cap, so an anchor recorded as a row
		// index resolves onto a newer line. The payload belongs to trimmed
		// history: it must vanish, not reappear on an unrelated row.
		const component = new BashExecutionComponent("img", ui, false);
		component.appendPtyChunk(`line0\r\n${SIXEL}line1\r\n`);
		const rows = Array.from({ length: 6000 }, (_, index) => `L${index}\r\n`).join("");
		component.appendPtyChunk(rows);
		component.setComplete(0, false);

		await renderUntil(component, () => component.isTranscriptBlockFinalized());

		const output = component.getOutput();
		expect(output).not.toContain("\x1bPq");
		expect(output).toContain("L5999");
	});

	it("renders the raw payload once, without the executor's decoded image", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";

		// The PTY executor decodes every frame it saw into an image as well; the
		// raw payload already rasterizes in the host terminal, so the decode is
		// dropped instead of drawn a second time below the output.
		const component = new BashExecutionComponent("img", ui, false);
		component.appendPtyChunk(`${SIXEL}\r\nvisible\r\n`);
		component.setComplete(0, false, {
			images: [{ type: "image", data: PNG, mimeType: "image/png" }],
			showImages: false,
		});

		const text = await renderUntil(component, () => component.isTranscriptBlockFinalized());
		expect(text).toContain(SIXEL);
		expect(text).not.toContain("[Image:");
	});

	it("renders the payload raw and uncapped with no expand hint", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";

		const rows = Array.from({ length: 30 }, (_, index) => `row${index}`).join("\r\n");
		const component = new BashExecutionComponent("img", ui, false);
		component.appendPtyChunk(`${SIXEL}\r\n${rows}\r\n`);
		component.setComplete(0, false);

		const text = await renderUntil(component, () => component.isTranscriptBlockFinalized());
		expect(text).toContain("\x1bPq");
		expect(text).toContain("\x1b\\");
		expect(text).toContain("row29");
		expect(text).not.toContain("more lines");
		expect(text).not.toContain("__OMP_SIXEL_SEQUENCE_");
	});

	it("replays plain text unchanged when passthrough gates are disabled", async () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;

		const component = new BashExecutionComponent("img", ui, false);
		component.appendPtyChunk("visible\r\n");
		component.setComplete(0, false);

		const text = await renderUntil(component, () => component.isTranscriptBlockFinalized());
		expect(text).toContain("visible");
		expect(text).not.toContain("\x1bPq");
	});
});
