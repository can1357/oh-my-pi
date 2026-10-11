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
