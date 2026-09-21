import { expect, it } from "bun:test";
import { wrapTmuxPassthrough } from "../src/tmux";
import { CURSOR_MARKER, TUI, type TerminalFramePlan, type TerminalFrameProvider } from "../src/tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

class Provider implements TerminalFrameProvider {
	#history: readonly string[] = [];
	#nextHistoryId = 2;
	frame: TerminalFramePlan = {
		history: { id: 1, kind: "append", rows: Array.from({ length: 30 }, (_, i) => `HISTORY_${i}`) },
		viewport: ["live", `${CURSOR_MARKER}input`],
	};
	renderFrame(): TerminalFramePlan {
		return this.frame;
	}
	acknowledgeHistory(): void {
		const batch = this.frame.history;
		if (batch) {
			this.#history = batch.kind === "replay" ? batch.rows : [...this.#history, ...batch.rows];
			this.#nextHistoryId = Math.max(this.#nextHistoryId, batch.id + 1);
		}
		this.frame = { viewport: this.frame.viewport };
	}
	beginHistoryReplay(): void {
		this.frame = {
			history: { id: this.#nextHistoryId++, kind: "replay", rows: this.#history },
			viewport: this.frame.viewport,
		};
	}
	renderResizeFrame(): readonly string[] {
		return this.frame.viewport;
	}
}

function expectCleanAuthoritativeHistory(terminal: VirtualTerminal, count: number): void {
	const rows = terminal.getScrollBuffer();
	expect(rows.filter(row => row.startsWith("HISTORY_"))).toEqual(
		Array.from({ length: count }, (_, index) => `HISTORY_${index}`),
	);
	expect(rows.join("\n")).not.toContain("MENU_");
}

it("restores covered screen cells before new history is appended", async () => {
	const reference = new VirtualTerminal(40, 12);
	const terminal = new VirtualTerminal(40, 12);
	const ui = new TUI(terminal);
	const referenceUi = new TUI(reference);
	const provider = new Provider();
	const referenceProvider = new Provider();
	ui.setFrameProvider(provider);
	referenceUi.setFrameProvider(referenceProvider);
	ui.start();
	referenceUi.start();
	const paint = async () => {
		ui.requestRender(true);
		referenceUi.requestRender(true);
		await terminal.waitForRender();
		await reference.waitForRender();
	};
	try {
		await paint();
		ui.setCursorOverlay(() => ["MENU_1", "MENU_2", "MENU_3", "MENU_4"], 0, 1);
		await paint();
		expect(terminal.getViewport().join("\n")).toContain("MENU_1");
		const next: TerminalFramePlan = {
			history: { id: 2, kind: "append", rows: Array.from({ length: 8 }, (_, i) => `NEW_${i}`) },
			viewport: ["updated", `${CURSOR_MARKER}input`],
		};
		provider.frame = next;
		referenceProvider.frame = next;
		await paint();
		expect(terminal.getScrollBuffer().slice(0, -terminal.rows).join("\n")).not.toContain("MENU_");
		ui.setCursorOverlay(undefined, 0, 0);
		await paint();
		expect(terminal.getScrollBuffer()).toEqual(reference.getScrollBuffer());
	} finally {
		ui.stop();
		referenceUi.stop();
	}
});

it("clips over-width cursor popup rows at the terminal boundary", async () => {
	const terminal = new VirtualTerminal(20, 6);
	const writes: string[] = [];
	const write = terminal.write.bind(terminal);
	terminal.write = data => {
		writes.push(data);
		write(data);
	};
	const ui = new TUI(terminal);
	const provider = new Provider();
	provider.frame = { viewport: ["live", `${CURSOR_MARKER}input`] };
	ui.setFrameProvider(provider);
	ui.setCursorOverlay(() => ["X".repeat(25)], 0, 1);
	ui.start();
	try {
		ui.requestRender(true);
		await terminal.waitForRender();
		expect(writes.join("")).not.toContain("X".repeat(25));
		expect(terminal.getViewport()[2]).toBe("X".repeat(20));
		expect(terminal.getViewport()[3]).toBe("");
		expect(terminal.getViewport()[1]).toBe("input");
	} finally {
		ui.stop();
	}
});

it("restores the complete scaled glyph when a popup covers only its lower row", async () => {
	const terminal = new VirtualTerminal(40, 6);
	const ui = new TUI(terminal);
	const provider = new Provider();
	const heading = "\x1b]66;s=2;Heading\x1b\\";
	provider.frame = { viewport: ["", "", heading, "", `${CURSOR_MARKER}input`, ""] };
	ui.setFrameProvider(provider);
	ui.start();
	try {
		await terminal.waitForRender();
		ui.setCursorOverlay(() => ["MENU"], 0, 1);
		ui.requestRender();
		await terminal.waitForRender();
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = data => {
			writes.push(data);
			write(data);
		};
		ui.setCursorOverlay(undefined, 0, 0);
		ui.requestRender();
		await terminal.waitForRender();
		expect(writes.join("")).toContain(heading);
		expect(writes.join("")).not.toContain("\x1b[4;1H\x1b[0m\x1b[K");
	} finally {
		ui.stop();
	}
});

it("replays authoritative history after a popup is resized into native scrollback", async () => {
	const terminal = new VirtualTerminal(40, 12);
	const ui = new TUI(terminal);
	const provider = new Provider();
	ui.setFrameProvider(provider);
	ui.start();
	try {
		await terminal.waitForRender();
		ui.setCursorOverlay(() => ["MENU_1", "MENU_2", "MENU_3", "MENU_4"], 0, 1);
		ui.requestRender();
		await terminal.waitForRender();
		terminal.resize(40, 4);
		await terminal.waitForRender(() => terminal.getViewport().some(row => row.includes("input")));
		await Bun.sleep(300);
		ui.setCursorOverlay(undefined, 0, 0);
		ui.requestRender();
		await terminal.waitForRender();
		const rows = terminal.getScrollBuffer();
		expect(rows.filter(row => row.startsWith("HISTORY_"))).toEqual(
			Array.from({ length: 30 }, (_, i) => `HISTORY_${i}`),
		);
		expect(rows.join("\n")).not.toContain("MENU_");
	} finally {
		ui.stop();
	}
});

it("restores popup backing on stop without an optional history flush hook", async () => {
	const terminal = new VirtualTerminal(40, 12);
	const reference = new VirtualTerminal(40, 12);
	const ui = new TUI(terminal);
	const referenceUi = new TUI(reference);
	ui.setFrameProvider(new Provider());
	referenceUi.setFrameProvider(new Provider());
	ui.start();
	referenceUi.start();
	try {
		await terminal.waitForRender();
		await reference.waitForRender();
		ui.setCursorOverlay(() => ["MENU_1", "MENU_2", "MENU_3", "MENU_4"], 0, 1);
		ui.requestRender();
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("MENU_1");
	} finally {
		ui.stop();
		referenceUi.stop();
	}
	expect(terminal.getScrollBuffer()).toEqual(reference.getScrollBuffer());
});

it.each([
	{ width: 40, height: 4, historyCount: 30, stop: false, keepOpen: false },
	{ width: 40, height: 16, historyCount: 30, stop: false, keepOpen: false },
	{ width: 40, height: 20, historyCount: 12, stop: false, keepOpen: false },
	{ width: 40, height: 20, historyCount: 12, stop: true, keepOpen: false },
	{ width: 60, height: 20, historyCount: 12, stop: false, keepOpen: true },
	{ width: 40, height: 20, historyCount: 12, stop: false, keepOpen: true },
	{ width: 30, height: 12, historyCount: 30, stop: false, keepOpen: true },
	{ width: 30, height: 12, historyCount: 30, stop: true, keepOpen: false },
])("restores popup history without cursor reports: %j", async ({ width, height, historyCount, stop, keepOpen }) => {
	const terminal = new VirtualTerminal(40, 12);
	const start = terminal.start.bind(terminal);
	terminal.start = (_input, resize) => start(() => {}, resize);
	const write = terminal.write.bind(terminal);
	terminal.write = data => {
		write(data);
		// VirtualTerminal's Kitty core does not pull the inactive normal
		// buffer on growth. Emulate the xterm-style pull on its restoration.
		if (height > 12 && data.includes("\x1b[?1049l")) {
			const pull = Math.min(height - 12, Math.max(0, historyCount + 2 - 12));
			if (pull > 0) write(`\x1b[${pull}+T\x1b[${pull}B`);
		}
	};
	const ui = new TUI(terminal);
	const provider = new Provider();
	provider.frame = {
		history: { id: 1, kind: "append", rows: Array.from({ length: historyCount }, (_, i) => `HISTORY_${i}`) },
		viewport: provider.frame.viewport,
	};
	ui.setFrameProvider(provider);
	ui.start();
	try {
		await terminal.waitForRender();
		ui.setCursorOverlay(() => ["MENU_1", "MENU_2", "MENU_3", "MENU_4"], 0, 1);
		ui.requestRender();
		await terminal.waitForRender();
		const selector = ui.showOverlay({ render: () => ["SELECTOR"] }, { fullscreen: true, mouseTracking: false });
		await terminal.waitForRender();
		terminal.resize(width, height);
		await terminal.waitForRender();
		if (stop) ui.stop();
		else {
			selector.hide();
			if (keepOpen) {
				ui.requestRender();
				await Bun.sleep(600);
				await terminal.waitForRender();
				expect(terminal.getViewport().join("\n")).toContain("MENU_1");
			}
			ui.setCursorOverlay(undefined, 0, 0);
			ui.requestRender();
			await terminal.waitForRender();
			await Bun.sleep(600);
			await terminal.waitForRender();
		}
		const rows = terminal.getScrollBuffer();
		expect(rows.filter(row => row.startsWith("HISTORY_"))).toEqual(
			Array.from({ length: historyCount }, (_, i) => `HISTORY_${i}`),
		);
		expect(rows.join("\n")).not.toContain("MENU_");
	} finally {
		ui.stop();
	}
});

it.each(["clear", "shrink"] as const)("restores popup backing changed during fullscreen: %s", async action => {
	const terminal = new VirtualTerminal(40, 12);
	const reference = new VirtualTerminal(40, 12);
	const ui = new TUI(terminal);
	const referenceUi = new TUI(reference);
	ui.setFrameProvider(new Provider());
	referenceUi.setFrameProvider(new Provider());
	ui.start();
	referenceUi.start();
	try {
		await terminal.waitForRender();
		await reference.waitForRender();
		ui.setCursorOverlay(() => ["MENU_1", "MENU_2", "MENU_3", "MENU_4"], 0, 1);
		ui.requestRender();
		await terminal.waitForRender();
		const selector = ui.showOverlay({ render: () => ["SELECTOR"] }, { fullscreen: true });
		await terminal.waitForRender();
		const popup = action === "clear" ? undefined : () => ["SMALL_MENU"];
		ui.setCursorOverlay(popup, 0, 1);
		referenceUi.setCursorOverlay(popup, 0, 1);
		referenceUi.requestRender();
		selector.hide();
		await terminal.waitForRender();
		await reference.waitForRender();
		expect(terminal.getScrollBuffer()).toEqual(reference.getScrollBuffer());
	} finally {
		ui.stop();
		referenceUi.stop();
	}
});

it("recovers popup rows when stopping before resize settles", async () => {
	const terminal = new VirtualTerminal(40, 12);
	const scheduler = new VirtualRenderScheduler();
	const ui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	ui.setFrameProvider(new Provider());
	ui.start();
	try {
		await scheduler.settle(terminal);
		ui.setCursorOverlay(() => ["MENU_1", "MENU_2", "MENU_3", "MENU_4"], 0, 1);
		ui.requestRender();
		await scheduler.settle(terminal);
		terminal.resize(40, 8);
	} finally {
		ui.stop();
	}
	await terminal.flush();
	expectCleanAuthoritativeHistory(terminal, 30);
	expect(terminal.getViewport().join("\n")).not.toContain("MENU_");
});

it.each(["append", undefined] as const)(
	"recovers after acknowledging queued %s history before shutdown cancels replay",
	async kind => {
		let stoppedAfterAppend = false;
		class DelayedReplayProvider extends Provider {
			#replayQueued = false;
			beginHistoryFlush(): void {
				this.#replayQueued = false;
				if (this.frame.history?.kind === "replay") this.frame = { viewport: this.frame.viewport };
			}
			override beginHistoryReplay(): void {
				if (this.frame.history) this.#replayQueued = true;
				else super.beginHistoryReplay();
			}
			override acknowledgeHistory(): void {
				super.acknowledgeHistory();
				if (this.#replayQueued) {
					this.#replayQueued = false;
					super.beginHistoryReplay();
					queueMicrotask(() => {
						stoppedAfterAppend = true;
						ui.stop();
					});
				}
			}
		}
		const terminal = new VirtualTerminal(40, 12);
		const scheduler = new VirtualRenderScheduler();
		const ui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const provider = new DelayedReplayProvider();
		ui.setFrameProvider(provider);
		ui.start();
		try {
			await scheduler.settle(terminal);
			ui.setCursorOverlay(() => ["MENU_1", "MENU_2", "MENU_3", "MENU_4"], 0, 1);
			ui.requestRender();
			await scheduler.settle(terminal);
			provider.frame = {
				history: { id: 2, kind, rows: ["HISTORY_30"] },
				viewport: provider.frame.viewport,
			};
			terminal.resize(40, 4);
			await scheduler.advance(terminal, 120);
			expect(stoppedAfterAppend).toBe(true);
		} finally {
			ui.stop();
		}
		await terminal.flush();
		expectCleanAuthoritativeHistory(terminal, 31);
		expect(terminal.getViewport().join("\n")).not.toContain("MENU_");
	},
);

it.each([false, true])("preserves pulled external history when popup predates growth=%s", async openBeforeResize => {
	const terminal = new VirtualTerminal(40, 12);
	terminal.write(Array.from({ length: 50 }, (_, index) => `SHELL_${index}\r\n`).join(""));
	const ui = new TUI(terminal);
	const provider = new Provider();
	provider.frame = {
		history: { id: 1, rows: Array.from({ length: 12 }, (_, index) => `HISTORY_${index}`) },
		viewport: provider.frame.viewport,
	};
	ui.setFrameProvider(provider);
	ui.start();
	const open = () =>
		ui.setCursorOverlay((_width, rows) => Array.from({ length: rows }, (_, index) => `MENU_${index}`), 0, 1, "above");
	try {
		await terminal.waitForRender();
		const original = terminal.getScrollBuffer().filter(row => /^(SHELL|HISTORY)_/.test(row));
		if (openBeforeResize) {
			open();
			ui.requestRender();
			await terminal.waitForRender();
		}
		terminal.resize(40, 20);
		await Bun.sleep(600);
		await terminal.waitForRender();
		if (!openBeforeResize) open();
		ui.requestRender();
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("MENU_");
		ui.setCursorOverlay(undefined, 0, 0);
		ui.requestRender();
		await terminal.waitForRender();
		expect(terminal.getScrollBuffer().filter(row => /^(SHELL|HISTORY)_/.test(row))).toEqual(original);
	} finally {
		ui.stop();
	}
});

it("chooses available safe space below an editor after external history is pulled down", async () => {
	const terminal = new VirtualTerminal(40, 12);
	terminal.write(Array.from({ length: 40 }, (_, index) => `SHELL_${index}\r\n`).join(""));
	const ui = new TUI(terminal);
	const provider = new Provider();
	provider.frame = { viewport: [`${CURSOR_MARKER}EDITOR`, "STATUS", "EXTENSION"] };
	ui.setFrameProvider(provider);
	ui.start();
	try {
		await terminal.waitForRender();
		terminal.resize(40, 20);
		await Bun.sleep(600);
		await terminal.waitForRender();
		ui.setCursorOverlay(() => ["SAFE_MENU"], 0, 1);
		ui.requestRender();
		await terminal.waitForRender();
		const rows = terminal.getViewport();
		const menu = rows.findIndex(row => row.includes("SAFE_MENU"));
		expect(menu).toBeGreaterThan(rows.findIndex(row => row.includes("EDITOR")));
	} finally {
		ui.stop();
	}
});

it.each([
	[40, 14],
	[40, 10],
	[60, 12],
])("preserves native history when popup backing remains addressable at %ix%i", async (columns, rows) => {
	const terminal = new VirtualTerminal(40, 12);
	const reference = new VirtualTerminal(40, 12);
	const ui = new TUI(terminal);
	const referenceUi = new TUI(reference);
	for (const target of [terminal, reference]) {
		target.write(Array.from({ length: 20 }, (_, i) => `EXTERNAL_${i}\r\n`).join(""));
	}
	ui.setFrameProvider(new Provider());
	referenceUi.setFrameProvider(new Provider());
	ui.start();
	referenceUi.start();
	try {
		await terminal.waitForRender();
		await reference.waitForRender();
		ui.setCursorOverlay(() => ["MENU_1", "MENU_2", "MENU_3", "MENU_4"], 0, 1);
		ui.requestRender();
		await terminal.waitForRender();
		terminal.resize(columns!, rows!);
		reference.resize(columns!, rows!);
		await Bun.sleep(400);
		ui.setCursorOverlay(undefined, 0, 0);
		ui.requestRender();
		referenceUi.requestRender();
		await terminal.waitForRender();
		await reference.waitForRender();
		expect(terminal.getScrollBuffer()).toEqual(reference.getScrollBuffer());
		expect(terminal.getScrollBuffer().join("\n")).not.toContain("MENU_");
	} finally {
		ui.stop();
		referenceUi.stop();
	}
});

it("keeps external scrollback on stop during a non-damaging resize", async () => {
	const terminal = new VirtualTerminal(40, 12);
	terminal.write(Array.from({ length: 20 }, (_, i) => `EXTERNAL_${i}\r\n`).join(""));
	const ui = new TUI(terminal);
	ui.setFrameProvider(new Provider());
	ui.start();
	await terminal.waitForRender();
	const external = terminal.getScrollBuffer().filter(row => row.startsWith("EXTERNAL_"));
	try {
		ui.setCursorOverlay(() => ["MENU_1", "MENU_2", "MENU_3", "MENU_4"], 0, 1);
		ui.requestRender();
		await terminal.waitForRender();
		terminal.resize(40, 10);
	} finally {
		ui.stop();
	}
	await terminal.flush();
	const rows = terminal.getScrollBuffer();
	expect(rows.filter(row => row.startsWith("EXTERNAL_"))).toEqual(external);
	expect(rows.filter(row => row.startsWith("HISTORY_"))).toEqual(Array.from({ length: 30 }, (_, i) => `HISTORY_${i}`));
	expect(rows.join("\n")).not.toContain("MENU_");
});

it("keeps uncovered click targets available while blocking popup-covered rows", async () => {
	const terminal = new VirtualTerminal(40, 8);
	const ui = new TUI(terminal);
	const provider = new Provider();
	provider.frame = {
		viewport: ["CARD", "row1", "row2", "row3", "row4", "COVERED", `${CURSOR_MARKER}input`, "footer"],
	};
	ui.setFrameProvider(provider);
	ui.start();
	try {
		await terminal.waitForRender();
		ui.setCursorOverlay(() => ["MENU"], 0, 1);
		ui.requestRender();
		await terminal.waitForRender();
		expect(terminal.getViewport()[5]).toBe("MENU");
		expect(ui.getMutableViewport(0)).toEqual({ top: 0, length: 8 });
		expect(ui.getMutableViewport(5)).toEqual({ top: 0, length: 0 });
		ui.setCursorOverlay(undefined, 0, 0);
		ui.requestRender();
		await terminal.waitForRender();
		expect(ui.getMutableViewport(5)).toEqual({ top: 0, length: 8 });
	} finally {
		ui.stop();
	}
});

it.each([false, true])("preserves image placement IDs when history scrolls under a popup (tmux=%s)", async tmux => {
	if (tmux) Bun.env.TMUX = "/tmp/omp-test-tmux,1,0";
	const terminal = new VirtualTerminal(40, 12);
	const ui = new TUI(terminal);
	const provider = new Provider();
	const apc = "\x1b_Ga=p,q=2,C=1,i=713,p=713,c=40,r=8,z=-2147483648\x1b\\";
	const placement = "\x1b7\x1b[7A" + (tmux ? wrapTmuxPassthrough(apc) : apc) + "\x1b8";
	provider.frame = { viewport: [...Array<string>(7).fill(""), placement, `${CURSOR_MARKER}input`] };
	ui.setFrameProvider(provider);
	const writes: string[] = [];
	const write = terminal.write.bind(terminal);
	terminal.write = data => {
		writes.push(data);
		write(data);
	};
	ui.start();
	try {
		await terminal.waitForRender();
		writes.length = 0;
		ui.setCursorOverlay(() => ["MODEL_RESULT"], 0, 1);
		ui.requestRender();
		await terminal.waitForRender();
		expect(writes.join("")).not.toMatch(/\x1b_Ga=d,/);
		expect(terminal.getViewport().join("\n")).toContain("MODEL_RESULT");
		expect(terminal.getViewportRowBackgroundColumns(7)).toEqual([]);
		provider.frame = {
			history: { id: 2, kind: "append", rows: Array<string>(6).fill("APPENDED") },
			viewport: provider.frame.viewport,
		};
		ui.requestRender();
		await terminal.waitForRender();
		ui.setCursorOverlay(undefined, 0, 0);
		ui.requestRender();
		await terminal.waitForRender();
		expect(writes.join("")).toContain(placement);
		expect(writes.join("")).not.toMatch(/\x1b_Ga=d,/);
	} finally {
		ui.stop();
	}
});

it("places suggestions immediately after the visible tail of a clipped editor", async () => {
	const terminal = new VirtualTerminal(40, 8);
	const ui = new TUI(terminal);
	const provider = new Provider();
	provider.frame = { viewport: [`${CURSOR_MARKER}input`, "editor bottom", ...Array<string>(6).fill("footer")] };
	ui.setFrameProvider(provider);
	ui.setCursorOverlay(() => ["MENU_1", "MENU_2"], 2, 4);
	ui.start();
	try {
		await terminal.waitForRender();
		expect(terminal.getViewport()[1]).toBe("editor bottom");
		expect(terminal.getViewport()[2]).toBe("MENU_1");
		expect(terminal.getViewport()[3]).toBe("MENU_2");
	} finally {
		ui.stop();
	}
});
