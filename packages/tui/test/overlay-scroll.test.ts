import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, type OverlayFocusOwner, TUI } from "@oh-my-pi/pi-tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualTerminal } from "./virtual-terminal";

class LineComponent implements Component {
	constructor(
		private readonly prefix: string,
		private readonly count: number,
	) {}

	invalidate(): void {
		// No cached state
	}

	render(_width: number): string[] {
		return Array.from({ length: this.count }, (_v, i) => `${this.prefix}${i}`);
	}
}

class MutableContentComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {
		// No cached state
	}

	render(_width: number): string[] {
		return [...this.#lines];
	}
}

class CursorOnlyComponent implements Component {
	#cursorCol = 0;
	readonly #line = "cursor-anchor";

	setCursorCol(col: number): void {
		this.#cursorCol = Math.max(0, Math.min(col, this.#line.length));
	}

	invalidate(): void {
		// No cached state
	}

	render(_width: number): string[] {
		return [`${this.#line.slice(0, this.#cursorCol)}${CURSOR_MARKER}${this.#line.slice(this.#cursorCol)}`];
	}
}

class FocusedMutableOverlay implements Component, Focusable {
	focused = false;
	#text: string;

	constructor(text: string) {
		this.#text = text;
	}

	setText(text: string): void {
		this.#text = text;
	}

	invalidate(): void {
		// No cached state
	}

	render(_width: number): string[] {
		return [`${this.#text}${this.focused ? CURSOR_MARKER : ""}`];
	}
}

class OverlayFocusDelegator implements Component, OverlayFocusOwner {
	#text: string;

	constructor(
		text: string,
		private readonly ownedFocusTarget: Component,
	) {
		this.#text = text;
	}

	setText(text: string): void {
		this.#text = text;
	}

	ownsOverlayFocusTarget(component: Component): boolean {
		return component === this.ownedFocusTarget;
	}

	invalidate(): void {
		// No cached state
	}

	render(_width: number): string[] {
		return [this.#text];
	}
}

function buildRows(count: number): string[] {
	return Array.from({ length: count }, (_v, i) => `row-${i}`);
}

function viewportRowNumbers(term: VirtualTerminal): number[] {
	const rows: number[] = [];
	for (const line of term.getViewport()) {
		const match = line.trim().match(/^row-(\d+)$/);
		if (match) rows.push(Number.parseInt(match[1], 10));
	}
	return rows;
}

function longestBlankRun(lines: string[]): number {
	let longest = 0;
	let current = 0;
	for (const line of lines) {
		if (line.trim().length === 0) {
			current += 1;
			longest = Math.max(longest, current);
		} else {
			current = 0;
		}
	}
	return longest;
}

async function flushRender(term: VirtualTerminal): Promise<void> {
	await new Promise<void>(resolve => process.nextTick(resolve));
	await Bun.sleep(40);
	await term.flush();
}

// Resize frames use the alternate buffer until the 120 ms quiet window settles.
async function settleResize(term: VirtualTerminal): Promise<void> {
	await Bun.sleep(160);
	await flushRender(term);
}

withoutTerminalMultiplexer();

describe("TUI overlays", () => {
	let savedTerminalEnv: Record<string, string | undefined> = {};
	beforeEach(() => {
		// A resize on Warp takes the in-place path (no ED3), so neutralize the
		// ambient terminal identity to keep the direct-terminal resize/scrollback
		// assertions below deterministic on any dev machine.
		for (const key of ["TERM_PROGRAM", "PI_TUI_RESIZE_IN_PLACE", "HERDR_ENV"]) {
			savedTerminalEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
	});
	afterEach(() => {
		for (const key in savedTerminalEnv) {
			const value = savedTerminalEnv[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		savedTerminalEnv = {};
	});

	it("does not scroll the terminal when an overlay is shown with a large historical working area", async () => {
		const term = new VirtualTerminal(80, 24);
		const tui = new TUI(term);

		tui.addChild(new LineComponent("base-", 5));

		tui.start();
		await flushRender(term);

		// Simulate a large historical working area (max lines ever rendered) without actually
		// rendering that many lines in the current view.
		(tui as unknown as { maxLinesRendered: number }).maxLinesRendered = 1500;

		tui.showOverlay(new LineComponent("overlay-", 3), { anchor: "center" });
		await flushRender(term);

		// The scroll buffer should stay small; we should not have printed hundreds/thousands of blank lines.
		expect(term.getScrollBuffer().length).toBeLessThan(200);
	});

	it("keeps the native viewport anchored when an overlay repaint follows a focused cursor below the frame tail", async () => {
		const term = new VirtualTerminal(24, 6, 100);
		const tui = new TUI(term, true);
		const base = new MutableContentComponent(buildRows(8));
		const cursorOverlay = new FocusedMutableOverlay("overlay-cursor");
		const statusOverlay = new OverlayFocusDelegator("status-before", cursorOverlay);
		tui.addChild(base);

		try {
			tui.start();
			await flushRender(term);

			tui.showOverlay(cursorOverlay, { row: 5, col: 0, width: 16 });
			tui.showOverlay(statusOverlay, { row: 0, col: 0, width: 16 });
			tui.setFocus(cursorOverlay);
			tui.requestRender();
			await flushRender(term);

			base.setLines(["base-0", "base-1"]);
			tui.requestRender();
			await flushRender(term);
			expect(term.getCursor().row).toBe(5);

			const before = term.getBufferPosition();
			const beforeScrollBufferLength = term.getScrollBuffer().length;

			statusOverlay.setText("status-after");
			tui.requestRender();
			await flushRender(term);

			expect(term.getBufferPosition()).toEqual(before);
			expect(term.getScrollBuffer()).toHaveLength(beforeScrollBufferLength);
			expect(term.getViewport().map(line => line.trimEnd())).toEqual([
				"status-after",
				"base-1",
				"",
				"",
				"",
				"overlay-cursor",
			]);
			expect(term.getCursor().row).toBe(5);
		} finally {
			tui.stop();
		}
	});

	it("clamps tall overlays without an explicit maxHeight to the available rows", async () => {
		const term = new VirtualTerminal(80, 24);
		const tui = new TUI(term);

		tui.addChild(new LineComponent("base-", 3));

		tui.start();
		await flushRender(term);

		// A bottom margin reserves rows the overlay must NOT paint into. The overlay
		// has no explicit maxHeight, so before the fix it rendered all 40 lines and
		// the compositor only skipped rows past the terminal edge — ov-0..ov-(rows-1)
		// were painted, including the reserved bottom band. The maxHeight=availHeight
		// default slices the overlay to availHeight = rows - marginBottom.
		const marginBottom = 6;
		tui.showOverlay(new LineComponent("ov-", 40), { anchor: "top-center", margin: { bottom: marginBottom } });
		await flushRender(term);

		const maxVisibleOverlayIndex = (): number => {
			let max = -1;
			for (const line of term.getViewport()) {
				const match = line.trim().match(/^ov-(\d+)$/);
				if (!match) continue;
				max = Math.max(max, Number.parseInt(match[1], 10));
			}
			return max;
		};

		// availHeight = 24 - 6 = 18 → overlay sliced to ov-0..ov-17, nothing in the
		// reserved bottom 6 rows. The old unclamped behavior surfaced ov-18..ov-23.
		expect(maxVisibleOverlayIndex()).toBeGreaterThanOrEqual(0);
		expect(maxVisibleOverlayIndex()).toBeLessThan(24 - marginBottom);

		term.resize(80, 10);
		await settleResize(term);

		// availHeight = 10 - 6 = 4 → overlay re-clamped to ov-0..ov-3.
		expect(maxVisibleOverlayIndex()).toBeGreaterThanOrEqual(0);
		expect(maxVisibleOverlayIndex()).toBeLessThan(10 - marginBottom);

		tui.stop();
	});

	it("preserves bottom-anchored overlay actions when clamped", async () => {
		const term = new VirtualTerminal(80, 5);
		const tui = new TUI(term);

		tui.addChild(new LineComponent("base-", 1));

		try {
			tui.start();
			await flushRender(term);

			tui.showOverlay(new LineComponent("ov-", 10), { anchor: "bottom-center", width: "100%", maxHeight: "100%" });
			await flushRender(term);

			const viewport = term.getViewport().join("\n");
			expect(viewport).toContain("ov-5");
			expect(viewport).toContain("ov-9");
			expect(viewport).not.toContain("ov-0");
		} finally {
			tui.stop();
		}
	});

	it("clears stale viewport content on launch", async () => {
		const term = new VirtualTerminal(40, 4);
		term.write("shell-0\r\nshell-1\r\nshell-2\r\nshell-3\r\nshell-4\r\n");
		await flushRender(term);

		const tui = new TUI(term);
		tui.addChild(new MutableContentComponent(["ui-0", "ui-1"]));
		try {
			tui.start();
			await flushRender(term);

			expect(term.getViewport().join("\n").includes("shell-")).toBeFalsy();
		} finally {
			tui.stop();
		}
	});

	it("does not duplicate transcript into scrollback on repeated forced redraws", async () => {
		const term = new VirtualTerminal(40, 4);
		const tui = new TUI(term);
		const component = new MutableContentComponent(buildRows(60));
		tui.addChild(component);

		tui.start();
		await flushRender(term);
		const baseline = term.getScrollBuffer().filter(line => /^row-\d+$/.test(line.trim())).length;

		for (let i = 0; i < 5; i++) {
			tui.requestRender(true);
			await flushRender(term);
		}

		const after = term.getScrollBuffer().filter(line => /^row-\d+$/.test(line.trim())).length;
		expect(after).toBeLessThanOrEqual(baseline + 4);

		tui.stop();
	});
	it("fully redraws on height increase to avoid stale viewport rows", async () => {
		const term = new VirtualTerminal(40, 4);
		term.write("shell-0\r\nshell-1\r\nshell-2\r\nshell-3\r\nshell-4\r\n");
		await flushRender(term);

		const tui = new TUI(term);
		const component = new MutableContentComponent(["ui-0", "ui-1", "ui-2", "ui-3"]);
		tui.addChild(component);

		tui.start();
		await flushRender(term);

		term.resize(40, 8);
		await flushRender(term);

		const viewport = term.getViewport().join("\n");
		expect(viewport.includes("shell-")).toBeFalsy();

		tui.stop();
	});
	it("keeps single viewport copy under simultaneous height and content changes", async () => {
		const term = new VirtualTerminal(60, 8);
		const tui = new TUI(term);
		const component = new MutableContentComponent(buildRows(4));
		tui.addChild(component);
		try {
			tui.start();
			await flushRender(term);

			for (let i = 0; i < 12; i++) {
				component.setLines(buildRows(4 + i));
				term.resize(60, i % 2 === 0 ? 7 : 9);
				await flushRender(term);
			}

			const viewport = term.getViewport();
			const rowOccurrences = new Map<string, number>();
			for (const line of viewport) {
				const trimmed = line.trim();
				if (!/^row-\d+$/.test(trimmed)) continue;
				rowOccurrences.set(trimmed, (rowOccurrences.get(trimmed) ?? 0) + 1);
			}
			for (const [row, count] of rowOccurrences) {
				expect(count, `${row} should appear at most once in the viewport`).toBe(1);
			}
			expect(viewport.at(-1)?.trim()).toBe("row-14");
		} finally {
			tui.stop();
		}
	});
	it("keeps scrollback bounded on resize when content size is stable", async () => {
		const term = new VirtualTerminal(60, 8);
		const tui = new TUI(term);
		const component = new MutableContentComponent(Array.from({ length: 140 }, (_v, i) => `row-${i}`));
		tui.addChild(component);
		try {
			tui.start();
			await flushRender(term);
			const before = term.getScrollBuffer().length;

			for (let i = 0; i < 8; i++) {
				term.resize(i % 2 === 0 ? 59 : 60, i % 2 === 0 ? 9 : 8);
				await flushRender(term);
			}

			const after = term.getScrollBuffer().length;
			expect(after - before).toBeLessThan(120);
		} finally {
			tui.stop();
		}
	});

	it("renders a fresh viewport on resize when content grows before resize", async () => {
		const term = new VirtualTerminal(60, 8);
		const tui = new TUI(term);
		const component = new MutableContentComponent(Array.from({ length: 8 }, (_v, i) => `row-${i}`));
		tui.addChild(component);
		try {
			tui.start();
			await flushRender(term);
			component.setLines(Array.from({ length: 140 }, (_v, i) => `row-${i}`));
			term.resize(59, 9);
			await flushRender(term);
			const viewport = term.getViewport();
			expect(viewport.at(-1)?.includes("row-139")).toBeTruthy();
		} finally {
			tui.stop();
		}
	});

	it("stays anchored across shrink-grow cycles while overflowing viewport", async () => {
		const term = new VirtualTerminal(30, 6);
		const tui = new TUI(term);
		const component = new MutableContentComponent(Array.from({ length: 64 }, (_v, i) => `row-${i}`));
		tui.addChild(component);
		try {
			tui.start();
			await flushRender(term);

			for (let cycle = 0; cycle < 3; cycle++) {
				component.setLines(Array.from({ length: 64 - cycle * 8 }, (_v, i) => `row-${i}`));
				tui.requestRender();
				await flushRender(term);

				component.setLines(Array.from({ length: 64 - cycle * 8 + 4 }, (_v, i) => `row-${i}`));
				tui.requestRender();
				await flushRender(term);
			}

			const viewport = term.getViewport().map(line => line.trim());
			expect(viewport.every(line => /^row-\d+$/.test(line))).toBeTruthy();
			const viewportRows = viewport.map(line => Number.parseInt(line.slice(4), 10));
			expect(viewportRows.at(-1)).toBe(51);
			expect(viewportRows[0]).toBeGreaterThanOrEqual(40);
		} finally {
			tui.stop();
		}
	});

	it("updates hardware cursor without redrawing content", async () => {
		const term = new VirtualTerminal(40, 6);
		const tui = new TUI(term, true);
		const component = new CursorOnlyComponent();
		tui.addChild(component);
		try {
			tui.start();
			await flushRender(term);
			const before = term.getScrollBuffer().length;

			for (let col = 0; col <= 10; col++) {
				component.setCursorCol(col);
				tui.requestRender();
				await flushRender(term);
			}

			const viewport = term.getViewport();
			expect(viewport[0]?.trim()).toBe("cursor-anchor");
			expect(term.getScrollBuffer().length - before).toBeLessThan(2);
		} finally {
			tui.stop();
		}
	});

	it("limits scrollback growth during resize oscillation with overflowing content", async () => {
		const term = new VirtualTerminal(60, 10);
		const tui = new TUI(term);
		const component = new MutableContentComponent(buildRows(160));
		tui.addChild(component);
		try {
			tui.start();
			await flushRender(term);
			const before = term.getScrollBuffer().length;

			for (let i = 0; i < 18; i++) {
				component.setLines(buildRows(140 + (i % 6) * 8));
				term.resize(i % 2 === 0 ? 59 : 60, i % 3 === 0 ? 11 : 10);
				tui.requestRender();
				await flushRender(term);
				const viewportRows = viewportRowNumbers(term);
				expect(viewportRows.length).toBeGreaterThan(0);
			}

			const scrollback = term.getScrollBuffer();
			expect(scrollback.length - before).toBeLessThan(220);
			expect(longestBlankRun(scrollback)).toBeLessThan(30);
		} finally {
			tui.stop();
		}
	});

	it("limits scrollback while toggling overlays over overflowing content", async () => {
		const term = new VirtualTerminal(60, 10);
		const tui = new TUI(term);
		const component = new MutableContentComponent(buildRows(150));
		tui.addChild(component);
		try {
			tui.start();
			await flushRender(term);
			const before = term.getScrollBuffer().length;

			for (let i = 0; i < 12; i++) {
				const handle = tui.showOverlay(new LineComponent(`overlay-${i}-`, 3), { anchor: "center" });
				await flushRender(term);
				handle.hide();
				await flushRender(term);

				if (i % 4 === 0) {
					component.setLines(buildRows(140 + (i % 4) * 10));
					tui.requestRender();
					await flushRender(term);
				}

				expect(viewportRowNumbers(term).length).toBeGreaterThan(0);
			}

			const scrollback = term.getScrollBuffer();
			expect(scrollback.length - before).toBeLessThan(320);
			expect(longestBlankRun(scrollback)).toBeLessThan(50);
		} finally {
			tui.stop();
		}
	});

	it("keeps scrollback bounded under rapid micro-resize oscillation", async () => {
		const term = new VirtualTerminal(80, 12);
		const tui = new TUI(term);
		const component = new MutableContentComponent(buildRows(180));
		tui.addChild(component);
		try {
			tui.start();
			await flushRender(term);
			const before = term.getScrollBuffer().length;

			for (let i = 0; i < 24; i++) {
				term.resize(i % 2 === 0 ? 79 : 80, i % 3 === 0 ? 11 : 12);
				await flushRender(term);
				expect(viewportRowNumbers(term).length).toBeGreaterThan(0);
			}

			const scrollback = term.getScrollBuffer();
			expect(scrollback.length - before).toBeLessThan(320);
			expect(longestBlankRun(scrollback)).toBeLessThan(60);
		} finally {
			tui.stop();
		}
	});

	it("avoids scrollback growth on repeated no-op renders with overflowing content", async () => {
		const term = new VirtualTerminal(70, 10);
		const tui = new TUI(term);
		tui.addChild(new MutableContentComponent(buildRows(130)));
		try {
			tui.start();
			await flushRender(term);
			const before = term.getScrollBuffer().length;

			for (let i = 0; i < 16; i++) {
				tui.requestRender();
				await flushRender(term);
			}

			const scrollback = term.getScrollBuffer();
			expect(scrollback.length - before).toBeLessThan(30);
		} finally {
			tui.stop();
		}
	});
	it("stays stable with direct row-delta movement", async () => {
		const term = new VirtualTerminal(50, 10);
		const tui = new TUI(term);
		const component = new MutableContentComponent(buildRows(150));
		tui.addChild(component);
		try {
			tui.start();
			await flushRender(term);
			const before = term.getScrollBuffer().length;

			for (let i = 0; i < 18; i++) {
				component.setLines(buildRows(120 + (i % 8) * 6));
				term.resize(i % 2 === 0 ? 50 : 49, i % 3 === 0 ? 11 : 10);
				tui.requestRender();
				await flushRender(term);
				expect(viewportRowNumbers(term).length).toBeGreaterThan(0);
			}

			const scrollback = term.getScrollBuffer();
			expect(scrollback.length - before).toBeLessThan(260);
			expect(longestBlankRun(scrollback)).toBeLessThan(40);
		} finally {
			tui.stop();
		}
	});
});
