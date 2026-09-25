import { afterEach, beforeAll, expect, it, vi } from "bun:test";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { setTerminalSelectionBackground } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { Container, type Component, Text } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";

withoutTerminalMultiplexer();
beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
	setTerminalSelectionBackground(undefined);
});

const CTRL_UP = "\x1b[1;5A";
const CTRL_DOWN = "\x1b[1;5B";

async function mount(turns: number, options: { band?: Component[] } = {}) {
	const terminal = new VirtualTerminal(80, 20);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: {
			quiet: true,
			spellingTypoDetection: false,
			spellingAutocomplete: false,
			spellingAutocorrect: false,
		},
	});
	composer.setHeaderExtras([], [new Text("WELCOME HEADER", 0, 0)]);
	const transcript = new TranscriptContainer();
	for (let turn = 1; turn <= turns; turn++) {
		transcript.addChild(new UserMessageComponent(`prompt ${turn}`));
		transcript.addChild(new Text(Array.from({ length: 8 }, (_, row) => `answer ${turn}.${row}`).join("\n"), 0, 0));
	}
	// Live layout: a todo-style HUD between the transcript and the input band.
	const band = new Container();
	for (const child of options.band ?? []) band.addChild(child);
	band.addChild(composer.editor);
	composer.setStatusComponent(new Text("STATUS", 0, 0));
	composer.setRuntimeChildren([transcript, new Text("TODO PANEL", 0, 0), band]);
	composer.start({ playWelcomeIntro: false });
	await scheduler.settle(terminal);
	const screen = () => terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
	const press = async (key: string) => {
		terminal.sendInput(key);
		await scheduler.settle(terminal);
	};
	return { terminal, scheduler, composer, screen, press };
}

/** Row of the scrollbar thumb's first cell in the body above the pinned band. */
function thumbTop(rows: readonly string[]): number {
	return rows.slice(0, -1).findIndex(row => row.endsWith("\u2588"));
}

it("hops prompt by prompt up to the welcome header, moving the one scrollbar, with the editor pinned below", async () => {
	const { composer, screen, press } = await mount(4);
	try {
		composer.openTranscriptScroll(-1, () => {});
		await press("");
		const firstHop = screen();
		expect(firstHop.at(-1)).toBe("STATUS");
		expect(firstHop[1]).toContain("prompt 3");
		await press(CTRL_UP);
		expect(screen()[1]).toContain("prompt 2");
		expect(thumbTop(screen())).toBeLessThan(thumbTop(firstHop));
		for (let i = 0; i < 3; i++) await press(CTRL_UP);
		const top = screen();
		expect(top[0]).toContain("WELCOME HEADER");
		expect(thumbTop(top)).toBe(0);
		expect(top.at(-1)).toBe("STATUS");
	} finally {
		composer.stop();
	}
});

it("returns to the live screen, and passes typing to the editor", async () => {
	const { composer, screen, press } = await mount(3);
	try {
		composer.openTranscriptScroll(-1, () => {});
		await press("");
		expect(composer.isTranscriptScrollOpen()).toBe(true);
		for (let i = 0; i < 5 && composer.isTranscriptScrollOpen(); i++) await press(CTRL_DOWN);
		expect(composer.isTranscriptScrollOpen()).toBe(false);
		expect(screen().at(-1)).toBe("STATUS");

		composer.openTranscriptScroll(-1, () => {});
		await press("x");
		expect(composer.isTranscriptScrollOpen()).toBe(false);
		expect(composer.editor.getText()).toBe("x");
	} finally {
		composer.stop();
	}
});

/** SGR mouse report at a 0-based screen cell. */
function mouse(button: number, col: number, row: number, release = false): string {
	return `\x1b[<${button};${col + 1};${row + 1}${release ? "m" : "M"}`;
}

it("drags the scrollbar to seek from the welcome header to the tail", async () => {
	const { composer, screen, press } = await mount(4);
	try {
		composer.openTranscriptScroll(-1, () => {});
		await press("");
		const bar = 79;
		await press(mouse(0, bar, 10));
		await press(mouse(32, bar, 0));
		expect(screen()[0]).toContain("WELCOME HEADER");
		expect(thumbTop(screen())).toBe(0);
		// Past the track's end clamps to the tail.
		await press(mouse(32, bar, 19));
		await press(mouse(0, bar, 19, true));
		const tail = screen();
		expect(tail.some(row => row.startsWith("answer 4.7"))).toBe(true);
		expect(tail.at(-1)).toBe("STATUS");
		expect(composer.isTranscriptScrollOpen()).toBe(true);
	} finally {
		composer.stop();
	}
});

it("copies the plain text of a drag selection across rows on release", async () => {
	const { composer, screen, press } = await mount(4);
	const copied: string[] = [];
	try {
		composer.openTranscriptScroll(-1, text => copied.push(text));
		await press("");
		const rows = screen();
		const first = rows.findIndex(row => row.startsWith("answer 3.1"));
		expect(first).toBeGreaterThan(-1);
		await press(mouse(0, 7, first));
		await press(mouse(32, 5, first + 1));
		await press(mouse(0, 5, first + 1, true));
		expect(copied).toEqual(["3.1\nanswer"]);
		expect(composer.isTranscriptScrollOpen()).toBe(true);
	} finally {
		composer.stop();
	}
});

it("paints a held selection in the terminal's selection color and clears it the moment release copies", async () => {
	setTerminalSelectionBackground("#336699");
	const { terminal, composer, screen, press } = await mount(4);
	const copied: string[] = [];
	try {
		composer.openTranscriptScroll(-1, text => copied.push(text));
		await press("");
		const row = screen().findIndex(line => line.startsWith("answer 3.1"));
		const plain = terminal.getViewportRowBackgroundValues(row)[0];
		await press(mouse(0, 0, row));
		await press(mouse(32, 3, row));
		expect(terminal.getViewportRowBackgroundColumns(row)).toEqual([0, 1, 2, 3]);
		expect(terminal.getViewportRowBackgroundValues(row)[0]).not.toBe(plain);
		await press(mouse(0, 3, row, true));
		expect(copied).toEqual(["answ"]);
		expect(terminal.getViewportRowBackgroundColumns(row)).toEqual([]);

		// Double click: a dotted token is one word; the click lands mid-token.
		await press(mouse(0, 8, row));
		await press(mouse(0, 8, row, true));
		await press(mouse(0, 8, row));
		expect(terminal.getViewportRowBackgroundColumns(row)).toEqual([7, 8, 9]);
		await press(mouse(0, 8, row, true));
		expect(copied.at(-1)).toBe("3.1");
		expect(terminal.getViewportRowBackgroundColumns(row)).toEqual([]);

		await press(mouse(0, 8, row));
		await press(mouse(0, 8, row, true));
		expect(copied).toEqual(["answ", "3.1", "answer 3.1"]);
	} finally {
		composer.stop();
	}
});

it("falls back to the theme's selectedBg when the terminal does not report a selection color", async () => {
	const { terminal, composer, screen, press } = await mount(4);
	const write = vi.spyOn(terminal, "write");
	try {
		composer.openTranscriptScroll(-1, () => {});
		await press("");
		const row = screen().findIndex(line => line.startsWith("answer 3.1"));
		await press(mouse(0, 0, row));
		write.mockClear();
		await press(mouse(32, 3, row));
		const written = write.mock.calls.map(([data]) => data).join("");
		// The renderer may merge SGR parameters, so match the background inside the merged code.
		const selectedBg = theme.getBgAnsi("selectedBg").slice(2, -1);
		expect(written).toMatch(new RegExp(`\\x1b\\[(?:[0-9;]*;)?${selectedBg}mansw\\x1b\\[49m`));
		expect(written).not.toMatch(/\x1b\[(?:[0-9;]*;)?7m/);
	} finally {
		composer.stop();
	}
});

it("pins only the input band: live panels such as the todo list never cover the scrolled transcript", async () => {
	const { composer, screen, press } = await mount(4);
	try {
		expect(screen()).toContain("TODO PANEL");
		composer.openTranscriptScroll(-1, () => {});
		await press("");
		expect(screen()).not.toContain("TODO PANEL");
		await press("\x1b");
		expect(screen()).toContain("TODO PANEL");
	} finally {
		composer.stop();
	}
});

it("keeps body rows visible when the input band is taller than the screen", async () => {
	const tall = new Text(Array.from({ length: 30 }, (_, row) => `widget ${row}`).join("\n"), 0, 0);
	const { composer, screen, press } = await mount(4, { band: [tall] });
	try {
		composer.openTranscriptScroll(-1, () => {});
		await press("");
		// Three body rows survive; with the tail that short, the first hop
		// seats the last prompt, which the tail no longer shows.
		const rows = screen();
		expect(rows[1]).toContain("prompt 4");
		expect(rows[3]).toContain("widget");
		expect(rows.at(-1)).toBe("STATUS");
	} finally {
		composer.stop();
	}
});

it("yields to a dialog that asks for focus, or an overlay that opens, so neither is hidden or starved", async () => {
	const { composer, screen, press } = await mount(4);
	const inputs: string[] = [];
	const dialog: Component = { render: () => ["DIALOG"], invalidate() {}, handleInput: data => void inputs.push(data) };
	try {
		composer.openTranscriptScroll(-1, () => {});
		await press("");
		composer.ui.setFocus(dialog);
		expect(composer.isTranscriptScrollOpen()).toBe(false);
		await press("y");
		expect(inputs).toEqual(["y"]);

		composer.ui.setFocus(composer.editor);
		composer.openTranscriptScroll(-1, () => {});
		await press("");
		composer.ui.showOverlay(dialog, { anchor: "center" });
		await press("");
		expect(composer.isTranscriptScrollOpen()).toBe(false);
		expect(screen().some(row => row.includes("DIALOG"))).toBe(true);
		await press("n");
		expect(inputs).toEqual(["y", "n"]);
	} finally {
		composer.stop();
	}
});
