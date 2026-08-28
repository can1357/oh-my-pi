import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CurrentTranscriptViewer } from "@oh-my-pi/pi-coding-agent/modes/components/current-transcript-viewer";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Component } from "@oh-my-pi/pi-tui";

class Block implements Component {
	constructor(private readonly rows: readonly string[]) {}

	render(): readonly string[] {
		return this.rows;
	}
}

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
const bodyTop = (viewer: CurrentTranscriptViewer): string =>
	stripAnsi(viewer.render(80)[3] ?? "")
		.replace(/\s+[│█]$/, "")
		.trim();

const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");

beforeAll(async () => {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: 12 });
	await initTheme(false);
});

afterAll(() => {
	if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
	else Reflect.deleteProperty(process.stdout, "rows");
});

function createViewer(
	responseRows: readonly string[] = [
		"RESPONSE_START",
		...Array.from({ length: 18 }, (_, index) => `RESPONSE_${index}`),
		"RESPONSE_END",
	],
) {
	const container = new TranscriptContainer();
	container.addChild(new Block(Array.from({ length: 5 }, (_, index) => `PROMPT_${index}`)));
	const response = new Block(responseRows);
	container.addChild(response);
	let renders = 0;
	let closes = 0;
	const viewer = new CurrentTranscriptViewer({
		container,
		anchor: response,
		requestRender: () => renders++,
		onClose: () => closes++,
	});
	return { container, response, viewer, renders: () => renders, closes: () => closes };
}

describe("CurrentTranscriptViewer", () => {
	it("opens with the latest answer marker at the body top", () => {
		const { viewer } = createViewer();
		const rendered = stripAnsi(viewer.render(80).join("\n"));
		expect(bodyTop(viewer)).toBe("RESPONSE_START");
		expect(rendered).not.toContain("RESPONSE_END");
		expect(rendered).not.toContain("PROMPT_0");
	});

	it("keeps a short latest answer at the body top with blank space below", () => {
		const { viewer } = createViewer(["SHORT_RESPONSE_START", "SHORT_RESPONSE_END"]);
		const rendered = viewer.render(80).map(stripAnsi);

		expect(bodyTop(viewer)).toBe("SHORT_RESPONSE_START");
		expect(rendered[4]?.trimStart()).toStartWith("SHORT_RESPONSE_END");
		expect(rendered.slice(5, -2).every(row => row.trim() === "" || /^[│█]$/.test(row.trim()))).toBe(true);
	});

	it("scrolls by page and wheel, then returns to the marker with r", () => {
		const { viewer, renders } = createViewer();
		viewer.render(80);

		viewer.handleInput("\x1b[6~");
		expect(bodyTop(viewer)).not.toBe("RESPONSE_START");
		viewer.handleInput("\x1b[<65;1;1M");
		expect(bodyTop(viewer)).toBe("RESPONSE_8");
		expect(renders()).toBe(2);

		viewer.handleInput("r");
		expect(bodyTop(viewer)).toBe("RESPONSE_START");
	});

	it("closes on escape or ctrl+c", () => {
		const escapeReader = createViewer();
		const ctrlCReader = createViewer();
		escapeReader.viewer.handleInput("\x1b");
		ctrlCReader.viewer.handleInput("\x03");
		expect(escapeReader.closes()).toBe(1);
		expect(ctrlCReader.closes()).toBe(1);
	});

	it("retains a safe viewport and shows a notice when the anchor disappears", () => {
		const { container, response, viewer } = createViewer();
		viewer.render(80);
		viewer.handleInput("\x1b[6~");
		container.removeChild(response);

		const rendered = stripAnsi(viewer.render(80).join("\n"));
		expect(rendered).toContain("Answer start is no longer in the visible transcript");
		expect(rendered).toContain("PROMPT_");
	});
});
