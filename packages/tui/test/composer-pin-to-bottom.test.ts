import { beforeAll, describe, expect, it } from "bun:test";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

const ROWS = 30;
const COLUMNS = 80;
const TRANSCRIPT_PREFIX = "Transcript row ";

interface Harness {
	terminal: VirtualTerminal;
	scheduler: VirtualRenderScheduler;
	composer: Composer;
	transcript: TranscriptContainer;
	appended: number;
}

function makeHarness(pinToBottom: boolean): Harness {
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true, pinToBottom },
	});
	const transcript = new TranscriptContainer();
	const editor = new Container();
	editor.addChild(new Text("EDITOR", 0, 0));
	composer.setRuntimeChildren([transcript, editor]);
	composer.start({ playWelcomeIntro: false });
	return { terminal, scheduler, composer, transcript, appended: 0 };
}

async function appendRows(h: Harness, count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		const row = h.appended++;
		h.transcript.addChild({ render: () => [`${TRANSCRIPT_PREFIX}${row}`] });
	}
	h.composer.ui.requestRender();
	await h.scheduler.settle(h.terminal);
}

function view(h: Harness): string[] {
	return h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

function transcriptIndices(rows: readonly string[]): number[] {
	return rows
		.map(row => Bun.stripANSI(row).trimEnd())
		.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
		.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
}

beforeAll(async () => {
	await initTheme();
});

describe("composer pinToBottom", () => {
	it("leaves the editor directly below a short transcript when the pin is off", async () => {
		const h = makeHarness(false);
		await appendRows(h, 3);

		const rows = view(h);
		expect(rows.findIndex(row => row.includes("EDITOR"))).toBeLessThan(ROWS - 1);

		h.composer.stop();
	});

	it("holds the editor on the bottom row from an empty transcript until the screen fills", async () => {
		const h = makeHarness(true);
		await h.scheduler.settle(h.terminal);
		expect(view(h).findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);

		await appendRows(h, 3);
		const short = view(h);
		expect(short.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		// The transcript still reads top-down; the pad sits between it and the editor.
		expect(short[0]).toBe(`${TRANSCRIPT_PREFIX}0`);

		h.composer.stop();
	});

	it("keeps every transcript row exactly once, in order, as the transcript overflows into scrollback", async () => {
		const h = makeHarness(true);
		for (let batch = 0; batch < 8; batch++) {
			await appendRows(h, 10);
			expect(view(h).findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		}

		// The pad must never reach native scrollback as a band of blank rows or
		// push committed rows out of order.
		expect(transcriptIndices(h.terminal.getScrollBuffer())).toEqual(Array.from({ length: 80 }, (_, i) => i));

		h.composer.stop();
	});

	it("re-pins after a terminal height resize", async () => {
		const taller = ROWS + 10;
		const h = makeHarness(true);
		await appendRows(h, 3);

		h.terminal.resize(COLUMNS, taller);
		await h.scheduler.advance(h.terminal, 300);
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		expect(view(h).findIndex(row => row.includes("EDITOR"))).toBe(taller - 1);

		h.composer.stop();
	});

	it("drops the pad on stop so the shell prompt lands under the content", async () => {
		const h = makeHarness(true);
		await appendRows(h, 3);

		h.composer.stop();

		const rows = view(h);
		const editorRow = rows.findIndex(row => row.includes("EDITOR"));
		expect(editorRow).toBeGreaterThanOrEqual(0);
		expect(editorRow).toBeLessThan(ROWS - 1);
		expect(rows.slice(0, editorRow).filter(row => row === "").length).toBeLessThan(ROWS - 5);
	});
});
