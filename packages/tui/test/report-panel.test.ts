import { beforeAll, describe, expect, it } from "bun:test";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { ReportPanel } from "@oh-my-pi/pi-tui/overlays/report-panel";
import { editorKey } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

const ROWS = 40;

beforeAll(async () => {
	await initTheme();
});

/**
 * A long transcript, a report above a one-row editor, both transient chrome as
 * the interactive mode mounts them, the report capped to the rows the editor
 * leaves free.
 */
async function mountReport(bodyRows: number) {
	const terminal = new VirtualTerminal(80, ROWS);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	const transcript = new TranscriptContainer();
	for (let i = 0; i < 60; i++) {
		const row = i;
		transcript.addChild({ render: () => [`Transcript ${row}`] });
	}
	const dock = new Container();
	const editor = new Container();
	editor.addChild(new Text("EDITOR", 0, 0));
	composer.setRuntimeChildren([transcript, dock, editor], { transient: [editor, dock] });
	composer.start({ playWelcomeIntro: false });
	await scheduler.settle(terminal);
	const panel = new ReportPanel({
		title: "Full Changelog",
		body: new Text(Array.from({ length: bodyRows }, (_, i) => `Entry ${i}`).join("\n"), 0, 0),
		closeKey: "Esc",
		onClose: () => {},
		maxRows: () => {
			const below = composer.rowsBelow(dock);
			return below === undefined ? undefined : ROWS - below;
		},
	});
	dock.addChild(panel);
	composer.ui.requestRender();
	await scheduler.settle(terminal);
	const screen = () => terminal.getViewport().map(row => Bun.stripANSI(row).trim());
	const entries = () =>
		screen()
			.map(row => row.match(/Entry (\d+)/)?.[1])
			.filter(entry => entry !== undefined)
			.map(Number);
	const repaint = async () => {
		composer.ui.requestRender();
		await scheduler.settle(terminal);
	};
	return { composer, dock, panel, screen, entries, repaint };
}

describe("ReportPanel in text mode", () => {
	it("grows up over the transcript to show a report that fits, without a scroll hint", async () => {
		const h = await mountReport(30);
		expect(h.entries()).toEqual(Array.from({ length: 30 }, (_, i) => i));
		expect(h.screen().some(row => row.includes("Full Changelog"))).toBe(true);
		expect(h.screen().some(row => row.includes("scroll"))).toBe(false);
		expect(h.panel.heightAt(80)).toBe(30 + 5);
		h.composer.stop();
	});

	it("caps a taller report to its rows, keeping the title, and scrolls on the page/End keys when focused", async () => {
		const h = await mountReport(80);
		const screen = h.screen();
		expect(screen.some(row => row.includes("Full Changelog"))).toBe(true);
		expect(screen.at(-1)).toBe("EDITOR");
		expect(screen.some(row => row.includes("PgUp/PgDn scroll"))).toBe(true);
		const first = h.entries();
		expect(first[0]).toBe(0);

		h.panel.handleInput("\x1b[6~");
		await h.repaint();
		const paged = h.entries();
		expect(paged[0]).toBeGreaterThan(0);
		expect(paged).toHaveLength(first.length);

		h.panel.handleInput("\x1b[F");
		await h.repaint();
		expect(h.entries().at(-1)).toBe(79);
		h.composer.stop();
	});

	it("puts the editor back on the bottom row with the transcript above it when the report closes", async () => {
		const h = await mountReport(80);
		h.dock.clear();
		await h.repaint();
		const screen = h.screen();
		expect(screen.at(-1)).toBe("EDITOR");
		expect(screen.at(-2)).toBe("Transcript 59");
		expect(screen.some(row => row.includes("Full Changelog"))).toBe(false);
		h.composer.stop();
	});

	it("keeps the editor on the bottom row when rows reached scrollback while the report was open", async () => {
		// With the welcome header on screen, opening a tall report retires the
		// header into scrollback, so the frame left after closing is shorter
		// than the screen. The interactive mode notes the editor sat on the
		// bottom row before opening and pins it there again on close.
		const terminal = new VirtualTerminal(100, ROWS);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: false },
		});
		const transcript = new TranscriptContainer();
		for (let i = 0; i < 15; i++) {
			const row = i;
			transcript.addChild({ render: () => [`Transcript ${row}`], isTranscriptBlockFinalized: () => true } as never);
		}
		const dock = new Container();
		const editor = new Container();
		editor.addChild(new Text("EDITOR", 0, 0));
		composer.setRuntimeChildren([transcript, dock, editor], { transient: [editor, dock] });
		composer.start({ playWelcomeIntro: false });
		await scheduler.settle(terminal);
		const editorRow = () => terminal.getViewport().findIndex(row => row.includes("EDITOR"));
		expect(editorRow()).toBe(ROWS - 1);
		const viewport = composer.ui.getMutableViewport();
		expect(viewport.top + viewport.length).toBe(ROWS);

		dock.addChild(
			new ReportPanel({
				title: "Full Changelog",
				body: new Text(Array.from({ length: 80 }, (_, i) => `Entry ${i}`).join("\n"), 0, 0),
				closeKey: "Esc",
				onClose: () => {},
				maxRows: () => {
					const below = composer.rowsBelow(dock);
					return below === undefined ? undefined : ROWS - below;
				},
			}),
		);
		composer.ui.requestRender();
		await scheduler.settle(terminal);
		dock.clear();
		composer.pinInputToBottom();
		composer.ui.requestRender();
		await scheduler.settle(terminal);

		expect(editorRow()).toBe(ROWS - 1);
		expect(terminal.getViewport().some(row => row.includes("Transcript 14"))).toBe(true);
		composer.stop();
	});

	it("never renders past its row cap, even when a resize leaves fewer rows than its chrome", () => {
		const body = new Text(Array.from({ length: 20 }, (_, i) => `Entry ${i}`).join("\n"), 0, 0);
		let cap = 12;
		const panel = new ReportPanel({ title: "Report", body, closeKey: "Esc", onClose: () => {}, maxRows: () => cap });
		expect(panel.render(60)).toHaveLength(12);
		cap = 4;
		const shrunk = panel.render(60);
		expect(shrunk).toHaveLength(4);
		expect(Bun.stripANSI(shrunk[0]!)).toContain("Report");
	});

	it("names the key that closes it: the editor's while docked, its own once it holds focus", () => {
		let closed = 0;
		const panel = new ReportPanel({
			title: "Report",
			body: new Text("body", 0, 0),
			// The editor's interrupt key, rebound away from Esc.
			closeKey: "Ctrl+Q",
			onClose: () => closed++,
		});
		const footer = () => Bun.stripANSI(panel.render(60).join("\n"));
		expect(footer()).toContain("Ctrl+Q to close");

		panel.holdFocus();
		expect(footer()).not.toContain("Ctrl+Q");
		expect(footer()).toContain(`${editorKey("tui.select.cancel")} to close`);
		panel.handleInput("\x1b");
		expect(closed).toBe(1);
	});
});
