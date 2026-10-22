import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { EvalExecutionComponent } from "@oh-my-pi/pi-tui/chat/eval-execution";
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminal = TERMINAL as unknown as MutableTerminalInfo;
const SIXEL = "\x1bPq#0;2;100;0;0#0~~\x1b\\";
const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

function enableSixelPassthrough(): void {
	terminal.imageProtocol = ImageProtocol.Sixel;
	Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
	Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
}

describe("EvalExecutionComponent SIXEL", () => {
	const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	const originalAllowPassthrough = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
	const originalProtocol = TERMINAL.imageProtocol;
	let darkTheme: Theme;

	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		expect(loaded).toBeDefined();
		darkTheme = loaded!;
	});

	beforeEach(() => {
		setThemeInstance(darkTheme);
	});

	afterEach(() => {
		terminal.imageProtocol = originalProtocol;
		if (originalForceProtocol === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		else Bun.env.PI_FORCE_IMAGE_PROTOCOL = originalForceProtocol;
		if (originalAllowPassthrough === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
		else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = originalAllowPassthrough;
	});

	it("keeps a streamed payload intact", () => {
		enableSixelPassthrough();
		const component = new EvalExecutionComponent("print(1)", ui, false);
		component.appendOutput(SIXEL);

		const output = component.getOutput();
		expect(output).toContain("\x1bPq");
		expect(output).toContain("\x1b\\");
		expect(output).toContain("#0~~");
		expect(output).not.toContain("__OMP_SIXEL_SEQUENCE_");
	});

	it("does not clamp a long payload line mid-sequence", () => {
		enableSixelPassthrough();
		const payload = `\x1bPq${"A".repeat(6000)}\x1b\\`;
		const component = new EvalExecutionComponent("print(1)", ui, false);
		component.appendOutput(payload);
		component.setComplete(0, false);

		const output = component.getOutput();
		expect(output).toContain("\x1bPq");
		expect(output).toContain("A".repeat(6000));
		expect(output).toContain("\x1b\\");
		expect(output).not.toContain("visible columns omitted");
	});

	it("keeps a payload that spans several rows intact", () => {
		enableSixelPassthrough();
		// The continuation row carries no DCS start of its own: the clamp must
		// still recognize it as part of the open sequence. The newline arrives in
		// its own append, so the row it closes is complete before the next one.
		const secondRow = `C${"x".repeat(6000)}\x1b\\`;
		const component = new EvalExecutionComponent("print(1)", ui, false);
		component.appendOutput(`\x1bPqAB\n`);
		component.appendOutput(`${secondRow}\n`);

		const output = component.getOutput();
		expect(output).toContain("\x1bPqAB");
		expect(output).toContain(secondRow);
		expect(output).not.toContain("visible columns omitted");
	});

	it("keeps a continuation row classified after its terminator arrived", () => {
		enableSixelPassthrough();
		// The continuation row already saw the DCS terminator, and a later chunk
		// still appends plain text to that same row. Classifying the row from
		// scratch would see no start marker and clamp the payload, cutting the
		// terminator and leaving the host terminal inside the string.
		const continuation = `#0${"~".repeat(6000)}\x1b\\`;
		const component = new EvalExecutionComponent("print(1)", ui, false);
		component.appendOutput(`\x1bPq#0~~-\n${continuation}`);
		component.appendOutput(" done");

		const output = component.getOutput();
		expect(output).toContain(continuation);
		expect(output).toContain(" done");
		expect(output).not.toContain("visible columns omitted");
	});

	it("keeps the payload through completion with a final snapshot", () => {
		enableSixelPassthrough();
		const component = new EvalExecutionComponent("print(1)", ui, false);
		component.appendOutput("partial\n");
		component.setComplete(0, false, { output: `${SIXEL}\ndone` });

		const output = component.getOutput();
		expect(output).toContain("\x1bPq");
		expect(output).toContain("\x1b\\");
		expect(output).toContain("done");
		// The streaming preview is replaced, not kept alongside the snapshot.
		expect(output).not.toContain("partial");
		expect(output).not.toContain("__OMP_SIXEL_SEQUENCE_");
	});

	it("keeps the payload through transcript replay", () => {
		enableSixelPassthrough();
		// Replay seeds the whole message output through appendOutput and then
		// completes without a fresh snapshot (chat-transcript-builder path).
		const component = new EvalExecutionComponent("print(1)", ui, false);
		component.appendOutput(`${SIXEL}\ndone\n`);
		component.setComplete(0, false);

		const output = component.getOutput();
		expect(output).toContain("\x1bPq");
		expect(output).toContain("\x1b\\");
		expect(output).toContain("done");
	});

	it("renders the payload raw and uncapped with no expand hint", () => {
		enableSixelPassthrough();
		const rows = Array.from({ length: 30 }, (_, index) => `row${index}`).join("\n");
		const component = new EvalExecutionComponent("print(1)", ui, false);
		component.appendOutput(`${SIXEL}\n${rows}\n`);
		component.setComplete(0, false);

		const rendered = component.render(100).join("\n");
		expect(rendered).toContain("\x1bPq");
		expect(rendered).toContain("\x1b\\");
		// Every row survives: the payload forces the full output, so the footer
		// must not advertise hidden lines.
		expect(rendered).toContain("row29");
		expect(rendered).not.toContain("more lines");
		expect(rendered).not.toContain("__OMP_SIXEL_SEQUENCE_");
	});

	it("still clamps a long non-SIXEL line", () => {
		enableSixelPassthrough();
		const component = new EvalExecutionComponent("print(1)", ui, false);
		component.appendOutput("x".repeat(6000));
		component.setComplete(0, false);

		const output = component.getOutput();
		expect(output).toContain("visible columns omitted");
		expect(output).not.toContain("\x1bPq");
	});

	it("strips the payload when passthrough gates are disabled", () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;

		// appendOutput receives pre-sanitized chunks from OutputSink: simulate
		// that (gates off) before handing the final snapshot to the component.
		const component = new EvalExecutionComponent("print(1)", ui, false);
		component.appendOutput(sanitizeText(SIXEL));
		component.setComplete(0, false, { output: `${SIXEL}\ndone` });

		const output = component.getOutput();
		expect(output).not.toContain("\x1bPq");
		expect(output).toContain("done");
		expect(output).not.toContain("__OMP_SIXEL_SEQUENCE_");
	});
});
