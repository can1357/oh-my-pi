import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	setTerminalScreenToScrollback,
	TERMINAL,
	TUI,
} from "@pk-nerdsaver-ai/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class MutableLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
}

// Models a component that caches its rendered output and only refreshes it when
// `invalidate()` fires — like a transcript block that freezes a snapshot. A
// state change behind the cache is invisible until something invalidates it,
// which is exactly what `resetDisplay()` must do to surface a Ctrl+O expansion.
class CachedComponent implements Component {
	#current: string[];
	#cache: string[] | undefined;

	constructor(lines: string[]) {
		this.#current = [...lines];
	}

	setLines(lines: string[]): void {
		this.#current = [...lines];
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): string[] {
		if (this.#cache === undefined) {
			this.#cache = this.#current.map(line => line.slice(0, width));
		}
		return this.#cache;
	}
}

class WrappingLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		const chunkWidth = Math.max(1, width);
		const rendered: string[] = [];
		for (const line of this.#lines) {
			if (line.length === 0) {
				rendered.push("");
				continue;
			}
			for (let offset = 0; offset < line.length; offset += chunkWidth) {
				rendered.push(line.slice(offset, offset + chunkWidth));
			}
		}
		return rendered;
	}
}

class UnknownViewportTerminal extends VirtualTerminal {
	isNativeViewportAtBottom(): undefined {
		return undefined;
	}
}

class StaleBottomViewportTerminal extends VirtualTerminal {
	#previous: boolean | undefined;
	#returnStale = false;

	isNativeViewportAtBottom(): boolean | undefined {
		const current = super.isNativeViewportAtBottom();
		if (this.#returnStale) {
			this.#returnStale = false;
			const stale = this.#previous;
			this.#previous = current;
			return stale;
		}
		this.#returnStale = true;
		this.#previous = current;
		return current;
	}
}

class CountingViewportTerminal extends VirtualTerminal {
	viewportProbeCount = 0;

	isNativeViewportAtBottom(): boolean | undefined {
		this.viewportProbeCount += 1;
		return super.isNativeViewportAtBottom();
	}
}

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_v, i) => `${prefix}${i}`);
}

async function settle(term: VirtualTerminal): Promise<void> {
	// The render scheduler defers its immediate hop with setImmediate (so queued
	// stdin such as Esc is read before an ordinary render). Drain that hop so the
	// throttled setTimeout(0) render is scheduled, let it fire, then flush.
	const immediate = Promise.withResolvers<void>();
	setImmediate(immediate.resolve);
	await immediate.promise;
	await Bun.sleep(1);
	await term.flush();
}

// Outside a multiplexer a resize paints the viewport immediately and defers the
// authoritative full replay (rewrap + ED3 + history rebuild) until the drag has
// been quiet for the resize settle window (120 ms). Tests asserting the settled
// end state wait past that window. These are integration tests against the real
// render scheduler, so the window is driven with a real delay, not fake timers.
async function settleResize(term: VirtualTerminal): Promise<void> {
	await Bun.sleep(160);
	await settle(term);
}

function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

function countMatches(lines: string[], pattern: RegExp): number {
	let count = 0;
	for (const line of lines) {
		if (pattern.test(line)) count += 1;
	}
	return count;
}

async function withEnvPatch<T>(patch: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const key in patch) {
		saved[key] = Bun.env[key];
		const value = patch[key];
		if (value === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = value;
		}
	}
	try {
		return await run();
	} finally {
		for (const key in saved) {
			const value = saved[key];
			if (value === undefined) {
				delete Bun.env[key];
			} else {
				Bun.env[key] = value;
			}
		}
	}
}

describe("TUI terminal-state regressions", () => {
	let monotonicNow = 0;
	let savedTerminalEnv: Record<string, string | undefined> = {};
	// Keep TUI's ~33ms render throttle deterministic without sleeping a real frame per render.

	beforeEach(() => {
		monotonicNow = 0;
		// Resize classification now depends on TERM_PROGRAM (Warp takes the
		// in-place path), so neutralize the ambient terminal identity to keep
		// these direct-terminal assertions deterministic on any dev machine.
		for (const key of ["TERM_PROGRAM", "PI_TUI_RESIZE_IN_PLACE"]) {
			savedTerminalEnv[key] = Bun.env[key];
			delete Bun.env[key];
		}
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 40;
			return monotonicNow;
		});
	});

	afterEach(() => {
		for (const key in savedTerminalEnv) {
			const value = savedTerminalEnv[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		savedTerminalEnv = {};
		vi.restoreAllMocks();
	});

	it("coalesces non-force render requests to 30fps", () => {
		const delays: number[] = [];
		const renderScheduler = {
			now: () => 0,
			scheduleImmediate: (callback: () => void) => callback(),
			scheduleRender: (_callback: () => void, delayMs: number) => {
				delays.push(delayMs);
				return { cancel: () => {} };
			},
		};
		const tui = new TUI(new VirtualTerminal(20, 4), true, { renderScheduler });

		tui.requestRender();

		expect(delays).toHaveLength(1);
		expect(delays[0]!).toBeCloseTo(1000 / 30, 5);
		tui.stop();
	});

	describe("cursor + differential stability", () => {
		it("keeps stable output across repeated no-op renders", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["hello", "world", "stable"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const before = visible(term);

				for (let i = 0; i < 8; i++) {
					tui.requestRender();
					await settle(term);
				}

				expect(visible(term)).toEqual(before);
			} finally {
				tui.stop();
			}
		});

		it("updates only changed middle line without corrupting neighbors", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["AAA", "BBB", "CCC", "DDD", "EEE"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const before = visible(term);

				component.setLines(["AAA", "BBB", "XXX", "DDD", "EEE"]);
				tui.requestRender();
				await settle(term);

				const after = visible(term);
				expect(after[0]).toBe(before[0]);
				expect(after[1]).toBe(before[1]);
				expect(after[2]?.trim()).toBe("XXX");
				expect(after[3]).toBe(before[3]);
				expect(after[4]).toBe(before[4]);
			} finally {
				tui.stop();
			}
		});
		it("rewrites changed rows before clearing suffixes for non-synchronized hosts", async () => {
			const term = new VirtualTerminal(40, 8);
			const tui = new TUI(term);
			const component = new MutableLinesComponent([
				"assistant output already rendered",
				"tool output already rendered",
				"todos/status already rendered",
			]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const writes = captureWrites(term);

				component.setLines(["assistant output already rendered", "tool", "todos/status already rendered"]);
				tui.requestRender();
				await settle(term);

				const paint = writes.at(-1) ?? "";
				expect(paint).toContain("tool\x1b[0m\x1b[K");
				expect(paint).not.toContain("\x1b[2Ktool");
				expect(visible(term)[1]).toBe("tool");
			} finally {
				tui.stop();
			}
		});

		it("clears removed tail lines after shrink", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["A", "B", "C", "D", "E"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines(["A", "B"]);
				tui.requestRender();
				await settle(term);

				const viewport = visible(term);
				expect(viewport[0]?.trim()).toBe("A");
				expect(viewport[1]?.trim()).toBe("B");
				expect(viewport[2]?.trim()).toBe("");
				expect(viewport[3]?.trim()).toBe("");
				expect(viewport[4]?.trim()).toBe("");
			} finally {
				tui.stop();
			}
		});

		it("clears row 0 when content shrinks to empty without clearOnShrink", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["A"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines([]);
				tui.requestRender();
				await settle(term);

				const viewport = visible(term);
				expect(viewport[0]?.trim()).toBe("");
			} finally {
				tui.stop();
			}
		});

		it("appends overflowing content after a legitimately empty previous frame", async () => {
			const term = new VirtualTerminal(20, 3);
			const tui = new TUI(term);
			const component = new MutableLinesComponent([]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines(["A", "B", "C", "D", "E"]);
				tui.requestRender();
				await settle(term);

				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(["A", "B", "C", "D", "E"]);
				expect(visible(term)).toEqual(["C", "D", "E"]);
			} finally {
				tui.stop();
			}
		});

		it("does not duplicate scrollback when two forced renders coalesce in one tick", async () => {
			const term = new VirtualTerminal(20, 3);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("L", 8));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				// Two forced renders queued before the render flush must still be
				// treated as a single drop of the already-committed transcript;
				// otherwise the second one re-emits the whole frame into scrollback.
				tui.requestRender(true);
				tui.requestRender(true);
				await settle(term);

				const occurrences = term
					.getScrollBuffer()
					.map(line => line.trimEnd())
					.filter(line => line === "L0").length;
				expect(occurrences).toBe(1);
			} finally {
				tui.stop();
			}
		});

		it("resetDisplay performs a clean redraw without a geometry change", async () => {
			const term = new VirtualTerminal(20, 3);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("L", 8));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const writes = captureWrites(term);

				tui.resetDisplay();
				await settle(term);

				expect(writes.some(write => write.includes("\x1b[2J\x1b[H\x1b[3J"))).toBe(true);
				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(rows("L", 8));
				expect(visible(term)).toEqual(["L5", "L6", "L7"]);
			} finally {
				tui.stop();
			}
		});

		it("resetDisplay surfaces a state change hidden behind a component's render cache", async () => {
			const term = new VirtualTerminal(20, 3);
			const tui = new TUI(term);
			const component = new CachedComponent(rows("L", 8));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				expect(visible(term)).toEqual(["L5", "L6", "L7"]);

				// The component's content changes, but its render stays cached (a
				// frozen transcript snapshot). resetDisplay() must invalidate it so the
				// forced replay reflects the new content rather than the stale cache —
				// the Ctrl+O expansion path depends on this.
				component.setLines(rows("M", 8));
				tui.resetDisplay();
				await settle(term);

				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(rows("M", 8));
				expect(visible(term)).toEqual(["M5", "M6", "M7"]);
			} finally {
				tui.stop();
			}
		});

		it("keeps appended rows in scrollback when a forced render coalesces with content growth", async () => {
			const term = new VirtualTerminal(20, 3);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("L", 5));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				tui.requestRender(true);
				component.setLines(rows("L", 6));
				tui.requestRender();
				await settle(term);

				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(rows("L", 6));
				expect(visible(term)).toEqual(["L3", "L4", "L5"]);
			} finally {
				tui.stop();
			}
		});

		it("appends at the seam without yanking a scrolled reader", async () => {
			// Law 7: the engine writes the same bytes regardless of scroll position —
			// a pure tail append only commits rows at the seam and rewrites grid
			// rows, so a reader scrolled into native scrollback keeps their view.
			const term = new VirtualTerminal(20, 3, 100);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("L", 8));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.scrollLines(-1);

				const beforeViewportY = term.getBufferPosition().viewportY;
				const beforeView = visible(term);
				const writes = captureWrites(term);

				component.setLines(rows("L", 9));
				tui.requestRender();
				await settle(term);

				// No yank bytes: ordinary updates never home the cursor or clear.
				const paint = writes.join("");
				expect(paint).not.toContain("\x1b[H");
				expect(paint).not.toContain("\x1b[2J");
				expect(paint).not.toContain("\x1b[3J");
				// The reader's anchor and view are untouched by the append.
				expect(term.getBufferPosition().viewportY).toBe(beforeViewportY);
				expect(visible(term)).toEqual(beforeView);

				term.scrollLines(1_000_000);
				await term.flush();
				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(rows("L", 9));
			} finally {
				tui.stop();
			}
		});
	});

	describe("resize + viewport behavior", () => {
		it("clears preexisting shell scrollback on a resize redraw (clean reset)", async () => {
			// A resize is a clean reset: the renderer clears the viewport and
			// scrollback (ED2+ED3) and redraws the transcript at the new geometry, so
			// preexisting shell scrollback above the UI does not survive.
			const term = new VirtualTerminal(50, 5);
			term.write("shell-0\r\nshell-1\r\nshell-2\r\nshell-3\r\nshell-4\r\n");
			await settle(term);

			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("ui-", 8));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				term.resize(49, 5);
				await settleResize(term);

				const buffer = term.getScrollBuffer().join("\n");
				expect(buffer.includes("shell-")).toBeFalsy();
				expect(visible(term).at(-1)?.trim()).toBe("ui-7");
			} finally {
				tui.stop();
			}
		});

		// Root cause: the renderer detected geometry changes by diffing dimensions
		// between frames, so a resize round trip that nets out unchanged by render
		// time (rapid SIGWINCH during a window drag, coalesced into one frame
		// budget) was invisible — but the terminal reflowed its buffer on each
		// event, moving rows between viewport and scrollback (and evicting some at
		// the cap), so diffing against the pre-resize screen splices blank phantom
		// rows into the viewport. The resize EVENT must mark the frame
		// geometry-changed regardless of the net dimension delta.
		it("repaints after a resize round trip whose dimensions net out unchanged", async () => {
			await withEnvPatch({ TMUX: undefined, STY: undefined, ZELLIJ: undefined }, async () => {
				const term = new VirtualTerminal(16, 6, 5);
				const tui = new TUI(term);
				const lines = rows("line-", 30);
				// Park the hardware cursor above the bottom row (focused editor row):
				// the diff emitter's scroll math is relative to this position, and the
				// resize round trip moves the real cursor out from under it.
				lines[28] = `line-28${CURSOR_MARKER}`;
				const component = new MutableLinesComponent(lines);
				tui.addChild(component);

				try {
					tui.start();
					await settle(term);

					// One frame budget: shrink, stream a row, grow back. The renderer
					// sees height 6 -> 6 (no net change) plus one appended row.
					term.resize(16, 4);
					lines.push("line-30 streamed");
					component.setLines(lines);
					term.resize(16, 6);
					await settle(term);

					expect(visible(term)).toEqual([
						"line-25",
						"line-26",
						"line-27",
						"line-28",
						"line-29",
						"line-30 streamed",
					]);
				} finally {
					tui.stop();
				}
			});
		});

		it("rewraps committed native scrollback when the terminal widens on POSIX (unknown viewport)", async () => {
			// POSIX reports no viewport position. A resize is now an unconditional
			// clean reset: the renderer clears scrollback (ED3) and redraws the
			// transcript at the new width, so committed history rewraps even when the
			// host scroll position is unobservable.
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			try {
				await withEnvPatch({ TMUX: undefined, STY: undefined, ZELLIJ: undefined }, async () => {
					// Each logical line is 36 cols: wraps to 20+16 at width 20, fits on one row at width 40.
					const logical = Array.from({ length: 10 }, (_v, i) => `L${i}:${"x".repeat(33)}`);
					const term = new UnknownViewportTerminal(20, 4, 200);
					const tui = new TUI(term);
					const component = new WrappingLinesComponent(logical);
					tui.addChild(component);

					try {
						tui.start();
						await settle(term);
						const narrow = term.getScrollBuffer().map(line => line.trimEnd());
						// Precondition: history is wrapped narrow (L0 split into a 20-col fragment).
						expect(narrow).toContain(`L0:${"x".repeat(17)}`);

						term.resize(40, 4);
						await settleResize(term);

						const wide = term.getScrollBuffer().map(line => line.trimEnd());
						// The resize rewraps history at the new width; the narrow fragment is gone.
						expect(wide).toContain(`L0:${"x".repeat(33)}`);
						expect(wide).not.toContain(`L0:${"x".repeat(17)}`);
					} finally {
						tui.stop();
					}
				});
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			}
		});

		it("resizing width truncates visible lines without ghost wrap rows", async () => {
			const term = new VirtualTerminal(30, 6);
			const tui = new TUI(term);
			const component = new MutableLinesComponent([
				"012345678901234567890123456789012345",
				"ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
			]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				term.resize(16, 6);
				await settle(term);

				const viewport = visible(term);
				expect(viewport[0]!.length).toBeLessThanOrEqual(16);
				expect(viewport[1]!.length).toBeLessThanOrEqual(16);
				expect(viewport[2]?.trim()).toBe("");
			} finally {
				tui.stop();
			}
		});

		it("width shrink rebuilds stale native history before later appends", async () => {
			const term = new VirtualTerminal(40, 3, 200);
			const tui = new TUI(term);
			const component = new WrappingLinesComponent(["A".repeat(20), "B".repeat(20)]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				// Root cause: shrinking the width can turn a frame that fit on screen
				// into overflowing wrapped rows. A viewport repaint leaves the old
				// terminal-reflowed fragments in native history; the next append then
				// grows scrollback by fewer rows than the logical frame grew.
				term.resize(10, 3);
				await settle(term);
				component.setLines(["A".repeat(20), "B".repeat(20), "C".repeat(20)]);
				tui.requestRender();
				await settleResize(term);

				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual([
					"AAAAAAAAAA",
					"AAAAAAAAAA",
					"BBBBBBBBBB",
					"BBBBBBBBBB",
					"CCCCCCCCCC",
					"CCCCCCCCCC",
				]);
			} finally {
				tui.stop();
			}
		});

		it("maintains exact viewport rows across repeated width reflow on sparse mixed content", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
			];
			tui.addChild(new MutableLinesComponent(lines));

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = lines.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);
				expect(visible(term)).toEqual(expectedViewport(80, 18));

				const widths = [72, 64, 56, 68, 52, 80];
				for (const width of widths) {
					term.resize(width, 18);
					await settle(term);
					expect(visible(term)).toEqual(expectedViewport(width, 18));
				}
			} finally {
				tui.stop();
			}
		});
		it("repaints viewport when width reflow grows rendered lines", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const lines = [
				...Array.from({ length: 5 }, (_v, i) => `long-${i}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`),
				...Array.from({ length: 20 }, (_v, i) => `tail-${i}`),
			];
			tui.addChild(new WrappingLinesComponent(lines));

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = new WrappingLinesComponent(lines).render(width);
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);
				expect(visible(term)).toEqual(expectedViewport(40, 10));

				term.resize(20, 10);
				await settle(term);

				expect(visible(term)).toEqual(expectedViewport(20, 10));
			} finally {
				tui.stop();
			}
		});
		it("aggressive resize storm does not duplicate viewport content", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
			];
			tui.addChild(new MutableLinesComponent(lines));

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = lines.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);

				const sizes: Array<[number, number]> = [];
				for (let i = 0; i < 240; i++) {
					sizes.push([i % 2 === 0 ? 79 : 80, i % 3 === 0 ? 17 : 18]);
				}

				for (const [w, h] of sizes) {
					term.resize(w, h);
				}
				await settle(term);

				const [finalWidth, finalHeight] = sizes[sizes.length - 1]!;
				expect(visible(term)).toEqual(expectedViewport(finalWidth, finalHeight));
			} finally {
				tui.stop();
			}
		});
		it("height-only resize recovers from cursor drift without duplicate rows", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
			];
			tui.addChild(new MutableLinesComponent(lines));

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = lines.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);

				// Simulate terminal-managed cursor relocation during aggressive UI changes/resizes.
				// TUI's internal cursor row bookkeeping does not observe this external movement.
				term.write("\x1b[18;1H");
				await settle(term);

				term.resize(80, 17);
				await settle(term);

				expect(visible(term)).toEqual(expectedViewport(80, 17));
			} finally {
				tui.stop();
			}
		});
		it("streaming content under aggressive resize keeps a single consistent viewport", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const source = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
				"        ├─────────┬─────────┬────────┬──────┬──────────────┬──────────────┐",
				"        │         │         │        │      │              │              │",
				"        ▼         │         ▼        │      ▼              ▼              ▼",
				"┌──────────────┐  │  ┌────────────┐  │  ┌───────┐     ┌─────────┐     ┌───────┐",
				"│    agent     │  │  │    tui     │  │  │ utils │     │ natives │     │ stats │",
				"└───────┬──────┘  │  └──────┬─────┘  │  └───────┘     └────┬────┘     └───────┘",
				"        ├─────────┘         └────────┘                     │",
				"        ▼                                                  │",
				"┌──────────────┐     ┌────────────┐                        │",
				"│      ai      │     │ pi-natives │◄───────────────────────┘",
				"└──────────────┘     └────────────┘",
			];
			const working: string[] = [];
			const component = new MutableLinesComponent(working);
			tui.addChild(component);

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = working.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);

				let nextLine = 0;
				let finalWidth = term.columns;
				let finalHeight = term.rows;
				for (let i = 0; i < 180; i++) {
					if (i % 3 === 0 && nextLine < source.length) {
						working.push(source[nextLine++]!);
						component.setLines(working);
					}

					finalWidth = i % 2 === 0 ? 79 : 80;
					finalHeight = i % 4 < 2 ? 17 : 18;
					term.resize(finalWidth, finalHeight);
					tui.requestRender();
					await settle(term);
				}

				expect(visible(term)).toEqual(expectedViewport(finalWidth, finalHeight));
			} finally {
				tui.stop();
			}
		}, 15_000);
		it("forced renders during resize storm stay stable under cursor relocation", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = Array.from({ length: 40 }, (_v, i) => `row-${i}`);
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			const expectedViewport = (width: number, height: number): string[] => {
				const rendered = lines.map(line => line.slice(0, width));
				const top = Math.max(0, rendered.length - height);
				const viewport = rendered.slice(top, top + height);
				while (viewport.length < height) viewport.push("");
				return viewport.map(line => line.trimEnd());
			};

			try {
				tui.start();
				await settle(term);

				let finalWidth = term.columns;
				let finalHeight = term.rows;
				for (let i = 0; i < 80; i++) {
					finalWidth = i % 2 === 0 ? 79 : 80;
					finalHeight = i % 3 === 0 ? 17 : 18;
					term.resize(finalWidth, finalHeight);
					term.write("\x1b[18;1H");
					tui.requestRender(true);
					await settle(term);
				}

				expect(visible(term)).toEqual(expectedViewport(finalWidth, finalHeight));
			} finally {
				tui.stop();
			}
		});
		it("shrink then grow keeps tail anchored to latest rows", async () => {
			const term = new VirtualTerminal(24, 6);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("row-", 30));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines(rows("row-", 16));
				tui.requestRender();
				await settle(term);

				component.setLines(rows("row-", 24));
				tui.requestRender();
				await settle(term);

				const viewport = visible(term).filter(line => line.trim().length > 0);
				expect(viewport).toHaveLength(6);
				expect(viewport[0]?.trim()).toBe("row-18");
				expect(viewport[5]?.trim()).toBe("row-23");
			} finally {
				tui.stop();
			}
		});
		it("mixed width/height resize storm keeps scrollback bounded for static content", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines = [
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"",
				"",
				"doesnt matter",
				"",
				"doesnt matter",
				"",
				"",
				"Operation aborted",
				"",
				"Operation aborted",
				"",
				"┌──────────────┐",
				"",
				"┌──────────────┐",
				"│              │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"│ coding-agent │",
				"┌──────────────┐",
				"│              │",
				"│ coding-agent │",
				"│              │",
				"└───────┬──────┘",
				"        │",
				"        │",
				"        ├─────────┬─────────┬────────┬──────┬──────────────┬──────────────┐",
				"        │         │         │        │      │              │              │",
				"        ▼         │         ▼        │      ▼              ▼              ▼",
				"┌──────────────┐  │  ┌────────────┐  │  ┌───────┐     ┌─────────┐     ┌───────┐",
				"│    agent     │  │  │    tui     │  │  │ utils │     │ natives │     │ stats │",
				"└───────┬──────┘  │  └──────┬─────┘  │  └───────┘     └────┬────┘     └───────┘",
				"        ├─────────┘         └────────┘                     │",
				"        ▼                                                  │",
				"┌──────────────┐     ┌────────────┐                        │",
				"│      ai      │     │ pi-natives │◄───────────────────────┘",
				"└──────────────┘     └────────────┘",
			];
			tui.addChild(new MutableLinesComponent(lines));

			try {
				tui.start();
				await settle(term);
				const before = term.getScrollBuffer().length;

				for (let i = 0; i < 220; i++) {
					term.resize(i % 2 === 0 ? 79 : 80, i % 3 === 0 ? 17 : 18);
					await settle(term);
				}

				const after = term.getScrollBuffer().length;
				expect(after - before).toBeLessThan(120);
			} finally {
				tui.stop();
			}
		}, 15_000);

		it("keeps appended rows contiguous when a height grow coincides with new content", async () => {
			// A terminal resize fires requestRender(), and streamed content fires
			// its own requestRender(); the ~33ms throttle coalesces them into a
			// single frame that is both taller and longer. The diff/append-tail
			// emitters position scrolled rows against the previous viewport top and
			// hardware cursor row, both invalidated by the reflow — so the appended
			// tail used to slip down by the height delta, leaving a blank gap.
			const term = new VirtualTerminal(40, 12);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("line-", 16));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				term.resize(40, 24);
				component.setLines(rows("line-", 19));
				tui.requestRender();
				await settle(term);

				// 19 lines fit inside the 24-row viewport: rows 0..18 hold content,
				// 19..23 stay blank — with no 4-row (height delta) displacement.
				expect(visible(term)).toEqual([...rows("line-", 19), "", "", "", "", ""]);
				const position = term.getBufferPosition();
				expect(position.viewportY).toBe(position.baseY);
			} finally {
				tui.stop();
			}
		});

		it("keeps native scrollback row-exact when a height shrink coalesces with streamed appends", async () => {
			// Stress repro: darwin-normal-large seed 0x5eed1234 op 1062. A height
			// SHRINK coalesced into the same frame as a streamed append, with content
			// overflowing the viewport, fell through to the diff emitter. The
			// terminal's resize reflow had already moved committed rows between
			// scrollback and viewport, so the emitter's previous-frame anchors were
			// stale and its relative scroll spliced a phantom blank row into native
			// scrollback; every later append stayed offset by one row. Geometry
			// changes must instead rebuild history (viewport at bottom) or defer —
			// never diff against pre-reflow anchors.
			const term = new VirtualTerminal(40, 8);
			const tui = new TUI(term);
			const lines = rows("row-", 14);
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				// Coalesce: height shrink 8→4 + streamed append in one frame.
				term.resize(40, 4);
				component.setLines([...lines, "stream-0"]);
				tui.requestRender();
				await settle(term);

				// Follow-up plain appends must land contiguously after the streamed row.
				const final = [...lines, "stream-0", "tail-0", "tail-1", "tail-2"];
				component.setLines(final);
				tui.requestRender();
				await settleResize(term);

				// Scrolling back must show exactly the transcript: no phantom blank
				// row, no offset rows, no duplicates.
				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(final);
			} finally {
				tui.stop();
			}
		});

		it("repaints content at the new geometry on a Termux resize-with-append (not the stale-anchor diff)", async () => {
			// Stress repro: linux-normal-termux-large seed 0x207adeeb op 11. Termux
			// was excluded from every geometry-change repaint branch (to avoid churn
			// on software-keyboard height toggles), so a real resize carrying new
			// content fell through to the diff/append emitter, which scrolls relative
			// to the pre-resize viewport top — offsetting the appended rows by the
			// geometry delta. Pure height changes repaint too: otherwise the terminal
			// exposes blank rows that a later append can fill without growing
			// scrollback.
			await withEnvPatch({ TERMUX_VERSION: "0.118" }, async () => {
				const term = new VirtualTerminal(120, 12);
				const tui = new TUI(term);
				const lines = rows("row-", 14);
				const component = new MutableLinesComponent(lines);
				tui.addChild(component);

				try {
					tui.start();
					await settle(term);

					// Resize (rotation: 120×12 → 80×24) coalesced with a 3-row append.
					// 17 rows fit the 24-row viewport, so they must be contiguous from
					// the top with no geometry-delta displacement.
					term.resize(80, 24);
					const final = [...lines, "app-0", "app-1", "app-2"];
					component.setLines(final);
					tui.requestRender();
					await settle(term);

					expect(visible(term)).toEqual([...final, ...Array<string>(24 - final.length).fill("")]);
				} finally {
					tui.stop();
				}
			});
		});

		it("repaints pure Termux height grows so later appends cannot fill phantom blank rows", async () => {
			// Stress repro: linux-normal-termux-small seed 0x207adeeb op 1257-1259.
			// A pure Termux height grow (software keyboard/rotation, no content
			// change) used to no-op. The terminal exposed two blank rows at the bottom
			// of the viewport, and the next append wrote into that phantom space
			// instead of scrolling a new row into native history, breaking row
			// accounting and hiding the true frame tail.
			await withEnvPatch({ TERMUX_VERSION: "0.118" }, async () => {
				const term = new VirtualTerminal(16, 4, 100);
				const tui = new TUI(term);
				const lines = rows("row-", 12);
				const component = new MutableLinesComponent(lines);
				tui.addChild(component);

				try {
					tui.start();
					await settle(term);

					term.resize(16, 6);
					await settle(term);
					expect(visible(term)).toEqual(lines.slice(6));

					const final = [...lines, "row-12"];
					component.setLines(final);
					tui.requestRender();
					await settleResize(term);

					expect(visible(term)).toEqual(final.slice(7));
					expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(final);
				} finally {
					tui.stop();
				}
			});
		});
	});

	describe("screen clearing", () => {
		it("saves to scrollback and clears the viewport for supported non-destructive full paints", async () => {
			const saved = TERMINAL.supportsScreenToScrollback;
			setTerminalScreenToScrollback(true);
			const term = new VirtualTerminal(20, 5);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(["hello"]));
			const writes = captureWrites(term);

			try {
				tui.start();
				await settle(term);
				const out = writes.join("");
				const screenToScrollback = out.indexOf("\x1b[22J");
				const viewportClear = out.indexOf("\x1b[2J\x1b[H");
				expect(screenToScrollback).toBeGreaterThanOrEqual(0);
				expect(viewportClear).toBeGreaterThanOrEqual(0);
				expect(screenToScrollback).toBeLessThan(viewportClear);
				expect(out).not.toContain("\x1b[3J");
			} finally {
				tui.stop();
				setTerminalScreenToScrollback(saved);
			}
		});

		it("clears stale screen content on a supported non-destructive paint when the terminal ignores CSI 22 J", async () => {
			const saved = TERMINAL.supportsScreenToScrollback;
			setTerminalScreenToScrollback(true);
			const term = new VirtualTerminal(40, 8);
			// A previous program's screen the TUI must not leave behind.
			term.write("\x1b[H");
			for (let r = 0; r < 6; r++) term.write(`STALE-ROW-${r} leftover content\r\n`);
			await term.flush();
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(["omp line 1", "omp line 2"]));

			try {
				tui.start();
				await settle(term);
				const viewport = term.getViewport().join("\n");
				expect(viewport).not.toContain("STALE-ROW");
				expect(viewport).toContain("omp line 1");
			} finally {
				tui.stop();
				setTerminalScreenToScrollback(saved);
			}
		});

		it("keeps CSI 2 J as the non-destructive fallback", async () => {
			const saved = TERMINAL.supportsScreenToScrollback;
			setTerminalScreenToScrollback(false);
			const term = new VirtualTerminal(20, 5);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(["hello"]));
			const writes = captureWrites(term);

			try {
				tui.start();
				await settle(term);
				const out = writes.join("");
				expect(out).toContain("\x1b[2J\x1b[H");
				expect(out).not.toContain("\x1b[22J");
				expect(out).not.toContain("\x1b[3J");
			} finally {
				tui.stop();
				setTerminalScreenToScrollback(saved);
			}
		});

		it("uses ED3 for destructive rebuilds even when CSI 22 J is supported", async () => {
			const saved = TERMINAL.supportsScreenToScrollback;
			setTerminalScreenToScrollback(true);
			const term = new VirtualTerminal(20, 3);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(rows("line-", 6)));
			const writes = captureWrites(term);

			try {
				tui.start();
				await settle(term);
				writes.length = 0;

				tui.requestRender(true, { clearScrollback: true });
				await settle(term);
				const out = writes.join("");
				expect(out).toContain("\x1b[2J\x1b[H\x1b[3J");
				expect(out).not.toContain("\x1b[22J");
			} finally {
				tui.stop();
				setTerminalScreenToScrollback(saved);
			}
		});
	});

	describe("scrollback integrity", () => {
		it("does not probe native viewport state before appends can affect scrollback", async () => {
			const term = new CountingViewportTerminal(32, 5);
			const tui = new TUI(term);
			const lines = rows("line-", 3);
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 3; i < 5; i++) {
					lines.push(`line-${i}`);
					component.setLines(lines);
					tui.requestRender();
					await settle(term);
				}

				expect(term.viewportProbeCount).toBe(0);
			} finally {
				tui.stop();
			}
		});

		it("overflow content appears once across buffer without duplicate row IDs", async () => {
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("line-", 10));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const all = term.getScrollBuffer();
				for (let i = 0; i < 10; i++) {
					const pattern = new RegExp(`\\bline-${i}\\b`);
					expect(countMatches(all, pattern), `line-${i} should appear exactly once`).toBe(1);
				}
			} finally {
				tui.stop();
			}
		});

		// Root cause: inside a multiplexer, #planRender routed dirty-scrollback
		// live frames to historyRebuild/overlayRebuild, but the full-frame replay
		// cannot clear tmux pane history (clearScrollback is forced off there), so
		// every dirty->rebuild cycle appended a complete duplicate copy of the
		// transcript to pane history. Live frames must keep repainting the
		// viewport and leave reconciliation to explicit checkpoints.
		it("tmux: dirty-scrollback live frames do not replay the transcript into pane history", async () => {
			await withEnvPatch({ TMUX: "1", STY: undefined, ZELLIJ: undefined }, async () => {
				const term = new VirtualTerminal(40, 5, 10_000);
				const tui = new TUI(term);
				const lines = rows("line-", 30);
				const component = new MutableLinesComponent(lines);
				tui.addChild(component);

				try {
					tui.start();
					await settle(term);
					const baseYAfterStart = term.getBufferPosition().baseY;

					// An offscreen edit in tmux defers: viewport repaint + scrollback
					// marked dirty (pane history cannot be rewritten).
					lines[2] = "line-2 edited";
					component.setLines(lines);
					tui.requestRender();
					await settle(term);

					// The next frame (a pure tail append) must NOT flush the dirty flag
					// through a full transcript replay: pane history would gain a
					// duplicate copy of every row.
					lines.push("line-30");
					component.setLines(lines);
					tui.requestRender();
					await settle(term);

					const baseYGrowth = term.getBufferPosition().baseY - baseYAfterStart;
					expect(baseYGrowth).toBeLessThanOrEqual(1);

					const scrollback = term.getScrollBuffer();
					for (const probe of [0, 1, 10, 20, 29]) {
						const pattern = new RegExp(`\\bline-${probe}\\b`);
						expect(
							countMatches(scrollback, pattern),
							`line-${probe} must appear exactly once in pane history`,
						).toBe(1);
					}
				} finally {
					tui.stop();
				}
			});
		});

		it("tmux: deleting a committed row re-anchors via commit resync without losing rows", async () => {
			await withEnvPatch({ TMUX: "1", STY: undefined, ZELLIJ: undefined }, async () => {
				const term = new UnknownViewportTerminal(40, 4, 10_000);
				const tui = new TUI(term);
				const component = new MutableLinesComponent([
					"old-0",
					"remove-me",
					"old-2",
					"old-3",
					"tail-0",
					"tail-1",
					"tail-2",
					"tail-3",
				]);
				tui.addChild(component);

				try {
					tui.start();
					await settle(term);
					expect(visible(term)).toEqual(["tail-0", "tail-1", "tail-2", "tail-3"]);

					const writes = captureWrites(term);
					// Deleting "remove-me" (already committed to pane history) shifts
					// every later row up by one. The committed-prefix audit detects the
					// shift and re-anchors the commit index at the divergence: pane
					// history keeps the stale copy and the shifted rows recommit
					// (duplication, never loss), so the window re-anchors to the full
					// tail instead of pinning a blank row.
					component.setLines(["old-0", "old-2", "old-3", "tail-0", "tail-1", "tail-2", "tail-3"]);
					tui.requestRender();
					await settle(term);

					expect(visible(term)).toEqual(["tail-0", "tail-1", "tail-2", "tail-3"]);
					expect(writes.join("")).not.toContain("\x1b[3J");
					const history = term.getScrollBuffer().slice(0, term.getBufferPosition().baseY);
					expect(history.map(line => line.trimEnd())).toEqual([
						"old-0",
						"remove-me",
						"old-2",
						"old-3",
						"old-2",
						"old-3",
					]);
				} finally {
					tui.stop();
				}
			});
		});

		// Root cause family: the dirty/replay machinery assumes native scrollback
		// can be cleared and rebuilt, which is never true inside a multiplexer —
		// tmux owns pane history, reflows it on resize itself, and a "replay" can
		// only append a duplicate copy of the transcript on top of it.
		describe("tmux: destructive scrollback reconciliation is impossible", () => {
			const TMUX_ENV = { TMUX: "1", STY: undefined, ZELLIJ: undefined };

			// Hole A: a resize racing a streamed append in the same frame (SIGWINCH +
			// token) reached the diff/append emitters, whose scroll math is anchored
			// to the pre-reflow viewport top — tmux reflowed the pane grid, so the
			// anchors are stale and rows land in the wrong place.
			it("repaints the viewport when a resize and an append land in one frame", async () => {
				await withEnvPatch(TMUX_ENV, async () => {
					const term = new VirtualTerminal(40, 12, 10_000);
					const tui = new TUI(term);
					const lines = rows("line-", 40);
					const component = new MutableLinesComponent(lines);
					tui.addChild(component);

					try {
						tui.start();
						await settle(term);

						// SIGWINCH (height shrink) and a streamed token arrive inside the
						// same multiplexer-resize debounce window. The TUI coalesces every
						// SIGWINCH into one settled forced render once the pane stops
						// resizing (issue #2088); the streamed append rides along on the
						// eventual render at the new geometry.
						lines.push("line-40 streamed");
						component.setLines(lines);
						term.resize(40, 6);
						await Bun.sleep(80);
						await settle(term);

						// The visible pane must show the frame tail at the new geometry —
						// no phantom rows, no stale-anchor splices.
						const view = visible(term);
						expect(view).toEqual(["line-35", "line-36", "line-37", "line-38", "line-39", "line-40 streamed"]);
					} finally {
						tui.stop();
					}
				});
			});

			// Hole B: a forced render that races a resize promoted the frame to
			// sessionReplace via #prepareForcedRender's replayGeometry, but the
			// "replay" cannot clear tmux pane history — it only appended a full
			// duplicate copy of the transcript.
			it("does not replay the transcript into pane history on a forced render after resize", async () => {
				await withEnvPatch(TMUX_ENV, async () => {
					const term = new VirtualTerminal(40, 12, 10_000);
					const tui = new TUI(term);
					const component = new MutableLinesComponent(rows("line-", 40));
					tui.addChild(component);

					try {
						tui.start();
						await settle(term);
						const baseYAfterStart = term.getBufferPosition().baseY;

						// Embedder force-redraws while a resize is still unprocessed.
						term.resize(40, 6);
						tui.requestRender(true);
						await settle(term);

						// xterm/tmux reflow on a 12 -> 6 height shrink moves at most 6 rows
						// into pane history; a transcript replay would add ~40 more.
						const baseYGrowth = term.getBufferPosition().baseY - baseYAfterStart;
						expect(baseYGrowth).toBeLessThanOrEqual(6);

						const scrollback = term.getScrollBuffer();
						for (const probe of [0, 10, 20, 30]) {
							const pattern = new RegExp(`\\bline-${probe}\\b`);
							expect(
								countMatches(scrollback, pattern),
								`line-${probe} must appear exactly once in pane history`,
							).toBe(1);
						}
					} finally {
						tui.stop();
					}
				});
			});
		});

		it("appending lines during aggressive resize does not duplicate history rows", async () => {
			const term = new VirtualTerminal(80, 18);
			const tui = new TUI(term);
			const lines: string[] = [];
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 0; i < 140; i++) {
					lines.push(`line-${i}`);
					component.setLines(lines);
					term.resize(i % 2 === 0 ? 79 : 80, i % 3 === 0 ? 17 : 18);
					tui.requestRender();
					await settle(term);
				}
				// The aggressive drag only ever painted the viewport; let the settle
				// window elapse so the authoritative rebuild commits the full history.
				await settleResize(term);

				const scrollback = term.getScrollBuffer();
				const duplicated: number[] = [];
				let presentCount = 0;
				for (let i = 0; i < 140; i++) {
					const pattern = new RegExp(`\\bline-${i}\\b`);
					const count = countMatches(scrollback, pattern);
					if (count > 0) presentCount += 1;
					if (count > 1) duplicated.push(i);
				}
				expect(presentCount).toBeGreaterThan(30);
				expect(duplicated).toEqual([]);
			} finally {
				tui.stop();
			}
		}, 15_000);

		it("rebuilds native scrollback on a width resize without duplicating rows", async () => {
			// A width resize makes the terminal reflow its own committed scrollback
			// at the new size. Repainting only the viewport leaves those stale
			// old-width rows in history, so overflowed rows show up twice (old-width
			// wrap + new-width copy) when the user scrolls back. A real resize must
			// rebuild history synchronously, unlike a pure content mutation which is
			// deferred to the next checkpoint.
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			// Rows wider than the post-resize width so the committed scrollback
			// reflows (wraps) at the narrower size; short rows would not regress.
			const filler = "x".repeat(24);
			const component = new MutableLinesComponent(Array.from({ length: 12 }, (_v, i) => `line-${i}-${filler}`));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				// User sits at the bottom (not scrolled) and narrows the terminal.
				term.resize(28, 5);
				await settleResize(term);

				const scrollback = term.getScrollBuffer();
				for (let i = 0; i < 12; i++) {
					const pattern = new RegExp(`\\bline-${i}\\b`);
					expect(countMatches(scrollback, pattern), `line-${i} should appear once after resize`).toBe(1);
				}
			} finally {
				tui.stop();
			}
		});

		it("rebuilds in place even when the reader is scrolled (clean reset on resize)", async () => {
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("line-", 12));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.scrollLines(-2);
				expect(term.getBufferPosition().viewportY).toBeGreaterThan(0);

				component.setLines(rows("line-", 8));
				term.resize(28, 5);
				await settleResize(term);

				// A resize is a clean reset: history is rebuilt in place at the new
				// geometry instead of deferring to keep the reader scrolled. Each line
				// appears exactly once and nothing is left deferred.
				const buffer = term.getScrollBuffer().map(line => line.trim());
				for (let i = 0; i < 8; i++) {
					expect(buffer.filter(line => line === `line-${i}`).length).toBe(1);
				}
				expect(buffer.filter(line => line.startsWith("line-")).length).toBe(8);
			} finally {
				tui.stop();
			}
		});

		it("keeps viewport aligned when offscreen header changes during overflow growth", async () => {
			const term = new VirtualTerminal(32, 6);
			const tui = new TUI(term);
			const logLines = rows("line-", 6);
			let tick = 0;
			const component = new MutableLinesComponent([`status-${tick}`, ...logLines]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 6; i < 70; i++) {
					tick += 1;
					logLines.push(`line-${i}`);
					component.setLines([`status-${tick}`, ...logLines]);
					tui.requestRender();
					await settle(term);
				}
				const viewport = visible(term).map(line => line.trim());
				expect(viewport.at(-1)).toBe("line-69");
				for (let i = 1; i < viewport.length; i++) {
					const prev = Number.parseInt(viewport[i - 1]!.slice(5), 10);
					const next = Number.parseInt(viewport[i]!.slice(5), 10);
					expect(next - prev).toBe(1);
				}
			} finally {
				tui.stop();
			}
		});
		it("recommits an offscreen expansion behind the stale prefix while seam commits continue in order", async () => {
			const term = new VirtualTerminal(32, 6);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["status-0", ...rows("line-", 11)]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				expect(visible(term).map(line => line.trim())).toEqual([
					"line-5",
					"line-6",
					"line-7",
					"line-8",
					"line-9",
					"line-10",
				]);

				// Rows 0..5 (status-0, line-0..line-4) are committed. The frame edits
				// row 0 and inserts a row above the commit boundary while a tail
				// append lands in the same frame: 2+ prefix tail samples change, so
				// the committed-prefix audit re-anchors at row 0 and recommits.
				component.setLines(["status-1", "expanded-details", ...rows("line-", 12)]);
				tui.requestRender();
				await settle(term);

				expect(visible(term).map(line => line.trim())).toEqual([
					"line-6",
					"line-7",
					"line-8",
					"line-9",
					"line-10",
					"line-11",
				]);
				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				const history = buffer.slice(0, term.getBufferPosition().baseY);
				// RESYNC law: native history keeps the stale committed copy AND gains
				// a fresh copy of the diverged frame from row 0 — the offscreen edit
				// and the expansion reach history (duplication, never loss).
				expect(history).toEqual([
					// stale committed prefix, never rewritten
					"status-0",
					...rows("line-", 5),
					// recommitted frame rows 0..7 (new committed = 14 - height)
					"status-1",
					"expanded-details",
					...rows("line-", 6),
				]);
				// The appended tail row reaches the screen exactly once.
				expect(buffer.filter(row => row === "line-11").length).toBe(1);
			} finally {
				tui.stop();
			}
		});

		it("does not duplicate the viewport-top row when an offscreen edit repeats the tail", async () => {
			// 6 rows over height 4: scrollback ["E0","E1"], viewport ["a","b","c","d"].
			const term = new VirtualTerminal(32, 4);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["E0", "E1", "a", "b", "c", "d"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				expect(term.isNativeViewportAtBottom()).toBe(true);
				expect(visible(term).map(line => line.trim())).toEqual(["a", "b", "c", "d"]);

				// An offscreen edit (E0 -> E0x, above the commit boundary) lands
				// together with a tail append whose rows make the prior last line "d"
				// recur one row early. The seam must advance by exactly the growth —
				// committing one row — without duplicating the viewport-top row "b".
				component.setLines(["E0x", "E1", "a", "b", "d", "e", "f"]);
				tui.requestRender();
				await settle(term);

				expect(visible(term).map(line => line.trim())).toEqual(["b", "d", "e", "f"]);
				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				for (const line of ["E1", "a", "b", "d", "e", "f"]) {
					expect(buffer.filter(row => row === line).length, `${line} should appear exactly once`).toBe(1);
				}
				// Committed rows are immutable: the stale "E0" copy survives in
				// history and the offscreen edit "E0x" never paints anywhere.
				expect(buffer.filter(row => row === "E0").length).toBe(1);
				expect(buffer).not.toContain("E0x");
			} finally {
				tui.stop();
			}
		});

		it("keeps stale collapsed ctrl-o markers in history and recommits the expanded rows behind them", async () => {
			// A Ctrl+O expansion mutates committed rows, so the committed-prefix
			// audit resyncs: the collapsed markers that already scrolled into native
			// history stay there — one stale copy each, never rewritten — and the
			// expanded rows recommit behind them (duplication, never loss).
			const term = new VirtualTerminal(48, 6);
			const tui = new TUI(term);
			const collapsedLines = [
				"frame-top",
				"code preview … 16 more lines ⟨Ctrl+O: Expand⟩",
				"output preview … 106 more lines (ctrl+o to expand)",
				...rows("json-", 10),
				"status",
				"editor",
			];
			const component = new MutableLinesComponent(collapsedLines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				expect(term.getScrollBuffer().join("\n")).toContain("ctrl+o");

				component.setLines([
					"frame-top",
					"code line 0",
					"code line 1",
					"output line 0",
					"output line 1",
					...rows("json-", 10),
					"status",
					"editor",
				]);
				tui.requestRender();
				await settle(term);
				const history = term.getScrollBuffer().slice(0, term.getBufferPosition().baseY);

				expect(visible(term).map(line => line.trim())).toEqual([
					"json-6",
					"json-7",
					"json-8",
					"json-9",
					"status",
					"editor",
				]);
				const scrollback = term.getScrollBuffer();
				expect(countMatches(scrollback, /Ctrl\+O: Expand/)).toBe(1);
				expect(countMatches(scrollback, /ctrl\+o/)).toBe(1);
				// The resync re-anchors at the first diverged row (the code marker)
				// and recommits from there: the expanded rows reach history exactly
				// once, right behind the stale markers.
				for (const line of ["code line 0", "code line 1", "output line 0", "output line 1"]) {
					expect(countMatches(history, new RegExp(`^${line}\\s*$`)), `${line} recommits exactly once`).toBe(1);
				}
				// json rows inside the recommitted span carry one stale + one fresh
				// copy; rows still in the live window appear exactly once.
				for (let i = 0; i < 6; i++) {
					const pattern = new RegExp(`\\bjson-${i}\\b`);
					expect(countMatches(scrollback, pattern), `json-${i} appears twice (stale + recommit)`).toBe(2);
				}
				for (let i = 6; i < 10; i++) {
					const pattern = new RegExp(`\\bjson-${i}\\b`);
					expect(countMatches(scrollback, pattern), `json-${i} should appear exactly once`).toBe(1);
				}
			} finally {
				tui.stop();
			}
		});

		it("defers offscreen expansion rebuild when the viewport position is unknown", async () => {
			// POSIX terminals cannot report whether the user scrolled up, so an
			// ordinary offscreen expansion must NOT destructively rebuild scrollback
			// (anti-yank). The collapsed ctrl+o markers that scrolled into history
			// therefore stay stale until the next checkpoint — this is the deferral
			// that makes an un-flagged Ctrl+O expand look broken above the fold.
			const term = new UnknownViewportTerminal(48, 6);
			const tui = new TUI(term);
			const component = new MutableLinesComponent([
				"frame-top",
				"code preview … 16 more lines ⟨Ctrl+O: Expand⟩",
				"output preview … 106 more lines (ctrl+o to expand)",
				...rows("json-", 10),
				"status",
				"editor",
			]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				expect(term.isNativeViewportAtBottom()).toBeUndefined();
				expect(term.getScrollBuffer().join("\n")).toContain("ctrl+o");

				component.setLines([
					"frame-top",
					"code line 0",
					"code line 1",
					"output line 0",
					"output line 1",
					...rows("json-", 10),
					"status",
					"editor",
				]);
				tui.requestRender();
				await settle(term);

				// No flag: the rebuild is deferred, so the stale markers survive offscreen.
				expect(term.getScrollBuffer().join("\n")).toContain("ctrl+o");
			} finally {
				tui.stop();
			}
		});

		it("paints an offscreen expansion identically when the viewport probe is unavailable", async () => {
			// Law 3: there is no probe and no platform fork. A terminal that cannot
			// report its native viewport position gets exactly the same treatment as
			// one that can: committed rows stay immutable, the live window repaints,
			// and no clear/home bytes are emitted.
			const term = new UnknownViewportTerminal(48, 6);
			const tui = new TUI(term);
			const component = new MutableLinesComponent([
				"frame-top",
				"code preview … 16 more lines ⟨Ctrl+O: Expand⟩",
				"output preview … 106 more lines (ctrl+o to expand)",
				...rows("json-", 10),
				"status",
				"editor",
			]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				expect(term.isNativeViewportAtBottom()).toBeUndefined();
				expect(term.getScrollBuffer().join("\n")).toContain("ctrl+o");

				const writes = captureWrites(term);
				component.setLines([
					"frame-top",
					"code line 0",
					"code line 1",
					"output line 0",
					"output line 1",
					...rows("json-", 10),
					"status",
					"editor",
				]);
				tui.requestRender();
				await settle(term);

				const paint = writes.join("");
				expect(paint).not.toContain("\x1b[3J");
				expect(paint).not.toContain("\x1b[2J");
				expect(visible(term).map(line => line.trim())).toEqual([
					"json-6",
					"json-7",
					"json-8",
					"json-9",
					"status",
					"editor",
				]);
				// History is never rewritten: the stale markers survive offscreen.
				expect(term.getScrollBuffer().join("\n")).toContain("ctrl+o");
			} finally {
				tui.stop();
			}
		});
		it("updates visible tail line when appending during overflow", async () => {
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const lines = [...rows("line-", 7), "tail-0"];
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let tick = 1; tick <= 30; tick++) {
					lines[lines.length - 1] = `tail-${tick}`;
					lines.push(`new-${tick}`);
					component.setLines(lines);
					tui.requestRender();
					await settle(term);

					const viewport = visible(term).map(line => line.trim());
					const expectedViewport = lines.slice(Math.max(0, lines.length - term.rows)).map(line => line.trim());
					expect(viewport).toEqual(expectedViewport);
				}
			} finally {
				tui.stop();
			}
		});
		it("forced full redraws do not duplicate persistent content", async () => {
			const term = new VirtualTerminal(40, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["alpha", "beta", "gamma"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 0; i < 5; i++) {
					tui.requestRender(true);
					await settle(term);
				}

				const allText = term.getScrollBuffer().join("\n");
				expect((allText.match(/alpha/g) ?? []).length).toBe(1);
				expect((allText.match(/beta/g) ?? []).length).toBe(1);
				expect((allText.match(/gamma/g) ?? []).length).toBe(1);
			} finally {
				tui.stop();
			}
		});

		it("re-anchors a bottom-anchored high-water collapse at the divergence and recommits the tail into history", async () => {
			// RESYNC law: the collapse shrinks the frame below the committed count,
			// so the engine re-anchors the commit index at the first diverged row
			// (row 8, where preview-* became result-*). Native history is
			// append-only: the high-water preview copy stays in scrollback above
			// (accepted artifact) — never clawed back. The window starts at the
			// re-anchored commit index, which here sits past `length - height`, so
			// the short tail is blank-padded rather than overwriting committed rows.
			const term = new VirtualTerminal(40, 5);
			const highWaterFrame = [...rows("base-", 8), ...rows("preview-", 10)];
			const finalFrame = [...rows("base-", 8), "result-0", "result-1"];
			const tui = new TUI(term);
			const component = new MutableLinesComponent(highWaterFrame);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(highWaterFrame);
				expect(term.getBufferPosition().viewportY).toBe(term.getBufferPosition().baseY);

				const writes = captureWrites(term);
				component.setLines(finalFrame);
				tui.requestRender();
				await settle(term);

				expect(writes.join("")).not.toContain("\x1b[3J");
				expect(visible(term).map(line => line.trim())).toEqual(["result-0", "result-1", "", "", ""]);
				const history = term.getScrollBuffer().slice(0, term.getBufferPosition().baseY);
				expect(history.map(line => line.trimEnd())).toEqual(highWaterFrame.slice(0, 13));

				// Once the transcript grows past the window again, the post-collapse
				// tail commits: result rows REACH history instead of being ignored.
				component.setLines([...finalFrame, ...rows("tail-", 5)]);
				tui.requestRender();
				await settle(term);

				expect(visible(term).map(line => line.trim())).toEqual(rows("tail-", 5));
				const grownHistory = term
					.getScrollBuffer()
					.slice(0, term.getBufferPosition().baseY)
					.map(line => line.trimEnd());
				expect(grownHistory).toEqual([...highWaterFrame.slice(0, 13), "result-0", "result-1"]);
			} finally {
				tui.stop();
			}
		});

		it("defers stale-history rebuild while native scrollback is scrolled", async () => {
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("line-", 12));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.scrollLines(-2);
				const before = term.getBufferPosition();
				expect(before.viewportY).toBeGreaterThan(0);
				expect(visible(term).map(line => line.trim())).toEqual(["line-5", "line-6", "line-7", "line-8", "line-9"]);

				component.setLines(rows("line-", 8));
				tui.requestRender();
				await settle(term);

				const after = term.getBufferPosition();
				expect(after.viewportY).toBe(before.viewportY);
				expect(visible(term).map(line => line.trim())).toEqual(["line-5", "line-6", "line-7", "", ""]);
			} finally {
				tui.stop();
			}
		});

		it("recommits an offscreen expansion at the seam while the reader is parked in scrollback", async () => {
			// An expansion above the commit boundary triggers the committed-prefix
			// resync: the inserted rows (and the shifted committed rows) recommit
			// at the seam, so the expansion reaches native history instead of
			// being skipped. The reader scrolled into scrollback keeps a stable
			// view — the recommit only appends below their anchor.
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("line-", 12));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.scrollLines(-5);
				const before = term.getBufferPosition();
				expect(before.viewportY).toBe(2);
				expect(visible(term).map(line => line.trim())).toEqual(["line-2", "line-3", "line-4", "line-5", "line-6"]);

				const writes = captureWrites(term);
				component.setLines(["line-0", "line-1", "expanded-0", "expanded-1", ...rows("line-", 12).slice(2)]);
				tui.requestRender();
				await settle(term);

				const paint = writes.join("");
				expect(paint).not.toContain("\x1b[3J");
				expect(paint).not.toContain("\x1b[2J");
				expect(paint).not.toContain("\x1b[H");
				expect(term.getBufferPosition().viewportY).toBe(before.viewportY);
				expect(visible(term).map(line => line.trim())).toEqual(["line-2", "line-3", "line-4", "line-5", "line-6"]);
				// The resync recommits the expansion: it reaches native history
				// exactly because the commit index re-anchored at the divergence.
				expect(term.getScrollBuffer().join("\n")).toContain("expanded-0");

				term.scrollLines(999);
				tui.requestRender();
				await settle(term);

				const finalPosition = term.getBufferPosition();
				expect(finalPosition.viewportY).toBe(finalPosition.baseY);
				expect(term.getScrollBuffer().join("\n")).toContain("expanded-0");
				expect(visible(term).map(line => line.trim())).toEqual([
					"line-7",
					"line-8",
					"line-9",
					"line-10",
					"line-11",
				]);
			} finally {
				tui.stop();
			}
		});

		it("paints a height-changing tail preview in the window while the reader is parked in scrollback", async () => {
			// Same law-7 shape as above, but the inserted row lands BELOW the commit
			// boundary: it paints into the live window immediately. The scrolled
			// reader still gets the same bytes — no clear, no yank — and finds the
			// preview row waiting in the window when they scroll back down.
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("line-", 12));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.scrollLines(-5);
				const before = term.getBufferPosition();
				expect(before.viewportY).toBe(2);
				expect(visible(term).map(line => line.trim())).toEqual(["line-2", "line-3", "line-4", "line-5", "line-6"]);

				const writes = captureWrites(term);
				component.setLines([...rows("line-", 9), "preview-appeared", ...rows("line-", 12).slice(9)]);
				tui.requestRender();
				await settle(term);

				const paint = writes.join("");
				expect(paint).not.toContain("\x1b[3J");
				expect(paint).not.toContain("\x1b[2J");
				expect(paint).not.toContain("\x1b[H");
				expect(term.getBufferPosition().viewportY).toBe(before.viewportY);
				expect(visible(term).map(line => line.trim())).toEqual(["line-2", "line-3", "line-4", "line-5", "line-6"]);
				// The preview painted into the live grid, not into history.
				const history = term.getScrollBuffer().slice(0, term.getBufferPosition().baseY);
				expect(history.join("\n")).not.toContain("preview-appeared");

				term.scrollLines(999);
				await term.flush();
				expect(visible(term).map(line => line.trim())).toEqual([
					"line-8",
					"preview-appeared",
					"line-9",
					"line-10",
					"line-11",
				]);
			} finally {
				tui.stop();
			}
		});
		it("treats unknown Windows viewport state as scrolled", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			const term = new UnknownViewportTerminal(32, 5);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(rows("line-", 12));
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.scrollLines(-2);
				const before = term.getBufferPosition();
				expect(before.viewportY).toBeGreaterThan(0);

				component.setLines(rows("line-", 8));
				tui.requestRender();
				await settle(term);

				const after = term.getBufferPosition();
				expect(after.viewportY).toBe(before.viewportY);
				expect(visible(term).map(line => line.trim())).toEqual(["line-5", "line-6", "line-7", "", ""]);
				expect(term.getBufferPosition().viewportY).toBe(before.viewportY);
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
				tui.stop();
			}
		});

		it("defers bottom-anchored shrink when POSIX viewport state is unknown", async () => {
			// Repro for #1566 follow-up (kitty/Linux): a bottom-anchored shrink across the
			// viewport boundary used to fall through to `viewportRepaint`, which redrew the
			// new transcript at `newLength - height` while leaving rows
			// `[newLength - height .. prevLength - height - 1]` already in native
			// scrollback — they reappeared at the top of the viewport, duplicating two rows
			// at the boundary in the captured trace.
			const term = new UnknownViewportTerminal(40, 6);
			const tui = new TUI(term);
			const body = rows("line-", 12);
			const component = new MutableLinesComponent([...body, "spinner-row", "spacer-row", "prompt-row"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				component.setLines([...body, "prompt-row"]);
				tui.requestRender();
				await settle(term);

				const scrollback = term.getScrollBuffer();
				for (let i = 0; i < body.length; i++) {
					const pattern = new RegExp(`\\bline-${i}\\b`);
					expect(
						countMatches(scrollback, pattern),
						`line-${i} must not duplicate at boundary`,
					).toBeLessThanOrEqual(1);
				}

				await settle(term);
				const stillDeferred = term.getScrollBuffer();
				for (let i = 0; i < body.length; i++) {
					const pattern = new RegExp(`\\bline-${i}\\b`);
					expect(
						countMatches(stillDeferred, pattern),
						`line-${i} remains non-duplicated while deferred`,
					).toBeLessThanOrEqual(1);
				}
			} finally {
				tui.stop();
			}
		});

		it("repaints only the active-grid bottom row while unknown viewport mutation is deferred", async () => {
			const initial = [...rows("line-", 12), "spinner-a"];
			const updated = ["edited-0", ...rows("line-", 12).slice(1), "spinner-b"];

			const term = new UnknownViewportTerminal(40, 6);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(initial);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				const writes = captureWrites(term);

				component.setLines(updated);
				tui.requestRender();
				await settle(term);

				const viewport = visible(term).map(line => line.trim());
				expect(viewport.at(-1)).toBe("spinner-b");
				expect(term.getScrollBuffer().join("\n")).not.toContain("edited-0");
				const paint = writes.at(-1) ?? "";
				expect(paint).toContain("\rspinner-b\x1b[0m\x1b[K");
				expect(paint).not.toContain("\x1b[H");
				expect(paint).not.toContain("\x1b[3J");
			} finally {
				tui.stop();
			}

			const scrolledTerm = new UnknownViewportTerminal(40, 6);
			const scrolledTui = new TUI(scrolledTerm);
			const scrolledComponent = new MutableLinesComponent(initial);
			scrolledTui.addChild(scrolledComponent);

			try {
				scrolledTui.start();
				await settle(scrolledTerm);
				scrolledTerm.scrollLines(-1);
				const before = scrolledTerm.getBufferPosition();
				const beforeViewport = visible(scrolledTerm).map(line => line.trim());
				const writes = captureWrites(scrolledTerm);

				scrolledComponent.setLines(updated);
				scrolledTui.requestRender();
				await settle(scrolledTerm);

				expect(scrolledTerm.getBufferPosition()).toEqual(before);
				expect(visible(scrolledTerm).map(line => line.trim())).toEqual(beforeViewport);
				expect(scrolledTerm.getScrollBuffer().join("\n")).not.toContain("edited-0");
				const paint = writes.at(-1) ?? "";
				expect(paint).toContain("\rspinner-b\x1b[0m\x1b[K");
				expect(paint).not.toContain("\x1b[H");
				expect(paint).not.toContain("\x1b[3J");
			} finally {
				scrolledTui.stop();
			}
		});
		it("re-anchors a huge completion-style collapse at the new tail and recommits the diverged head behind stale history", async () => {
			// RESYNC law (#1599 lineage): a 100-row transcript collapsing to 20 rows
			// in a 10-row window must keep the new tail (including the prompt) on
			// screen. The frame no longer covers the committed prefix, so the commit
			// index re-anchors at the first diverged row (row 0) and recommits up to
			// `newLength - height`: short-0..short-9 land in history right behind
			// the stale line-* copy — duplication of the stale prefix, never loss.
			const term = new UnknownViewportTerminal(40, 10);
			const tui = new TUI(term);
			const body = rows("line-", 99);
			const component = new MutableLinesComponent([...body, "prompt-row"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const short = rows("short-", 19);
				component.setLines([...short, "prompt-row"]);
				tui.requestRender();
				await settle(term);

				const viewport = visible(term).map(line => line.trim());
				expect(viewport).toEqual([
					"short-10",
					"short-11",
					"short-12",
					"short-13",
					"short-14",
					"short-15",
					"short-16",
					"short-17",
					"short-18",
					"prompt-row",
				]);
				const buffer = term.getScrollBuffer();
				// The recommit puts short-0..short-9 into history exactly once and
				// the re-anchored window holds short-10..prompt-row exactly once —
				// nothing is lost, nothing duplicates.
				for (let i = 0; i < short.length; i++) {
					expect(countMatches(buffer, new RegExp(`\\bshort-${i}\\b`)), `short-${i} appears once`).toBe(1);
				}
				const history = buffer.slice(0, term.getBufferPosition().baseY).map(line => line.trimEnd());
				expect(history).toEqual([...body.slice(0, 90), ...rows("short-", 10)]);
			} finally {
				tui.stop();
			}
		});

		it("recommits a huge collapse without clears while the reader is parked in scrollback", async () => {
			// RESYNC + no-clear law: even a 100→20 row collapse never emits ED2/ED3
			// — the re-anchor recommits the diverged frame head behind the stale
			// prefix and rewrites the window, so a reader parked in native
			// scrollback keeps a byte-stable view and their anchor.
			const term = new UnknownViewportTerminal(40, 10);
			const tui = new TUI(term);
			const body = rows("line-", 99);
			const component = new MutableLinesComponent([...body, "prompt-row"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				term.scrollLines(-10);
				const before = term.getBufferPosition();
				const beforeViewport = visible(term).map(line => line.trim());
				expect(before.viewportY).toBeGreaterThan(0);

				const writes = captureWrites(term);
				const short = rows("short-", 19);
				component.setLines([...short, "prompt-row"]);
				tui.requestRender();
				await settle(term);

				const paint = writes.join("");
				expect(paint).not.toContain("\x1b[3J");
				expect(paint).not.toContain("\x1b[2J");
				expect(term.getBufferPosition().viewportY).toBe(before.viewportY);
				expect(visible(term).map(line => line.trim())).toEqual(beforeViewport);

				term.scrollLines(999);
				await settle(term);

				expect(visible(term).map(line => line.trim())).toEqual([
					"short-10",
					"short-11",
					"short-12",
					"short-13",
					"short-14",
					"short-15",
					"short-16",
					"short-17",
					"short-18",
					"prompt-row",
				]);
				// Stale committed history stays above — never clawed back — and the
				// recommitted frame head follows it (no row loss).
				const history = term.getScrollBuffer().slice(0, term.getBufferPosition().baseY);
				expect(history.join("\n")).toContain("line-89");
				for (let i = 0; i < 10; i++) {
					expect(countMatches(history, new RegExp(`\\bshort-${i}\\b`)), `short-${i} recommits once`).toBe(1);
				}
				for (let i = 10; i < short.length; i++) {
					expect(countMatches(history, new RegExp(`\\bshort-${i}\\b`)), `short-${i} stays in the window`).toBe(0);
				}
			} finally {
				tui.stop();
			}
		});
		it("resyncs an offscreen-edit grow and re-anchors the following collapse", async () => {
			const term = new UnknownViewportTerminal(40, 10);
			const tui = new TUI(term);
			const initial = rows("line-", 19);
			const component = new MutableLinesComponent([...initial, "prompt-row"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				// Offscreen edit (row 0) + 100-row growth in one frame: the edit is
				// an insertion above the commit boundary, so the audit re-anchors and
				// the edited transcript recommits behind the stale original (law 1
				// content-at-commit-time, duplication never loss).
				const expanded = ["edited-line", ...rows("line-", 118), "prompt-row"];
				component.setLines(expanded);
				tui.requestRender();
				await settle(term);
				expect(visible(term).map(line => line.trim())).toEqual([
					"line-109",
					"line-110",
					"line-111",
					"line-112",
					"line-113",
					"line-114",
					"line-115",
					"line-116",
					"line-117",
					"prompt-row",
				]);
				expect(term.getScrollBuffer().join("\n")).toContain("edited-line");

				// Collapse far below the commit boundary: law 4 re-anchors the window
				// at the new tail; the stale committed transcript stays above.
				const short = [...rows("short-", 14), "prompt-row"];
				component.setLines(short);
				tui.requestRender();
				await settle(term);

				expect(visible(term).map(line => line.trim())).toEqual([
					"short-5",
					"short-6",
					"short-7",
					"short-8",
					"short-9",
					"short-10",
					"short-11",
					"short-12",
					"short-13",
					"prompt-row",
				]);
				const history = term.getScrollBuffer().slice(0, term.getBufferPosition().baseY).join("\n");
				expect(history).toContain("line-108");
				expect(history).toContain("short-4");
				expect(history).toContain("edited-line");
			} finally {
				tui.stop();
			}
		});

		it("renders streaming row inserts on WSL Windows Terminal even when viewport probe is unavailable", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			try {
				await withEnvPatch(
					{ WT_SESSION: "wt-test", WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: undefined },
					async () => {
						// Simulate WSL: native viewport probe returns undefined unconditionally
						// (kernel32.dll FFI cannot bind from a Linux user-space process).
						const term = new UnknownViewportTerminal(32, 5);
						const tui = new TUI(term);
						// Bottom-anchored footer (prompt area) with streaming assistant rows above it.
						// Seed the transcript so the viewport is already saturated — the footer pins
						// to the last viewport row and streamed rows must appear above it.
						const transcript = new MutableLinesComponent(rows("seed-", 4));
						const footer = new MutableLinesComponent(["prompt>"]);
						tui.addChild(transcript);
						tui.addChild(footer);

						try {
							tui.start();
							await settle(term);
							expect(visible(term).map(line => line.trim())).toEqual([
								"seed-0",
								"seed-1",
								"seed-2",
								"seed-3",
								"prompt>",
							]);

							// Stream tokens row-by-row. Each frame inserts a new row above the footer,
							// mimicking an assistant response materializing during a turn.
							for (let i = 0; i < 4; i++) {
								transcript.setLines([...rows("seed-", 4), ...rows("token-", i + 1)]);
								tui.requestRender();
								await settle(term);

								const viewport = visible(term).map(line => line.trim());
								// The most recently streamed token MUST land in the viewport without the
								// user resizing the window. Pre-fix the viewport stayed frozen at the
								// initial seed because deferredMutation returned a no-op render.
								expect(viewport).toContain(`token-${i}`);
								expect(viewport[viewport.length - 1]).toBe("prompt>");
							}
						} finally {
							tui.stop();
						}
					},
				);
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			}
		});

		it("keeps a scrolled-up reader anchored while streaming inserts arrive on POSIX (unknown viewport)", async () => {
			// POSIX terminals cannot report scrollback position, so isNativeViewportAtBottom()
			// is undefined. Before the fix the planner optimistically treated "unknown" as
			// "at bottom" and rebuilt native scrollback (clear + replay) on every offscreen
			// streaming insert, wiping history and yanking a scrolled-up reader to the tail.
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			try {
				await withEnvPatch({ TMUX: undefined, STY: undefined, ZELLIJ: undefined }, async () => {
					const term = new UnknownViewportTerminal(32, 5);
					const tui = new TUI(term);
					// Assistant transcript that already overflows into scrollback, pinned footer below.
					const transcript = new MutableLinesComponent(rows("seed-", 12));
					const footer = new MutableLinesComponent(["prompt>"]);
					tui.addChild(transcript);
					tui.addChild(footer);

					try {
						tui.start();
						await settle(term);

						// Reader scrolls up into history.
						term.scrollLines(-4);
						const before = term.getBufferPosition();
						const anchored = visible(term).map(line => line.trim());
						expect(before.viewportY).toBeGreaterThan(0);
						expect(before.viewportY).toBeLessThan(before.baseY);

						// Stream rows above the footer — the real coding-agent shape. Each frame is a
						// length-changing insert that previously routed to a destructive historyRebuild.
						for (let i = 0; i < 4; i++) {
							transcript.setLines([...rows("seed-", 12), ...rows("token-", i + 1)]);
							tui.requestRender();
							await settle(term);

							const pos = term.getBufferPosition();
							// Still scrolled up (not snapped to the tail) and reading the same rows.
							expect(pos.viewportY).toBeLessThan(pos.baseY);
							expect(visible(term).map(line => line.trim())).toEqual(anchored);
						}

						// The incremental diff path streamed the tail straight into native
						// scrollback without a destructive rebuild: earliest history survives and
						// the live tail is reachable once the reader returns to the bottom.
						expect(term.getScrollBuffer().join("\n")).toContain("seed-0");
						expect(term.getScrollBuffer().join("\n")).toContain("token-3");

						// An offscreen reflow (edit above the fold) must defer rather than rebuild,
						// so the reader is still not yanked; the deferred rewrite is marked dirty.
						transcript.setLines(["seed-EDIT", ...rows("seed-", 12).slice(1), ...rows("token-", 4)]);
						tui.requestRender();
						await settle(term);
						const offscreenPos = term.getBufferPosition();
						expect(offscreenPos.viewportY).toBeLessThan(offscreenPos.baseY);
						expect(visible(term).map(line => line.trim())).toEqual(anchored);

						term.scrollLines(999);
						await settle(term);
						expect(term.getScrollBuffer().join("\n")).not.toContain("seed-EDIT");
					} finally {
						tui.stop();
					}
				});
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			}
		});

		it("does not trust a single stale at-bottom probe for live rebuilds", async () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			try {
				await withEnvPatch(
					{ TMUX: undefined, STY: undefined, ZELLIJ: undefined, WT_SESSION: undefined },
					async () => {
						const term = new StaleBottomViewportTerminal(32, 5, 200);
						const tui = new TUI(term);
						const component = new MutableLinesComponent(rows("seed-", 12));
						tui.addChild(component);

						try {
							tui.start();
							await settle(term);
							expect(term.isNativeViewportAtBottom()).toBe(true);

							term.scrollLines(-4);
							const before = term.getBufferPosition();
							const anchored = visible(term).map(line => line.trim());
							expect(before.viewportY).toBeLessThan(before.baseY);

							component.setLines(["seed-EDIT", ...rows("seed-", 12).slice(1), ...rows("tail-", 4)]);
							tui.requestRender();
							await settle(term);

							const after = term.getBufferPosition();
							expect(after.viewportY).toBe(before.viewportY);
							expect(visible(term).map(line => line.trim())).toEqual(anchored);
						} finally {
							tui.stop();
						}
					},
				);
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			}
		});
		it("keeps scroll-off rows reachable when a streaming block re-lays-out past the viewport (ED3-risk, unknown viewport)", async () => {
			// Regression: a stable-prefix scrollback experiment withheld a live block's
			// overflow from native history whenever a frame rewrote a row in the
			// scroll-off band [prevViewportTop, overflowRows) — exactly what a streaming
			// markdown/plan block does as it re-wraps while growing. Those rows then
			// scrolled above the bottom-anchored viewport without ever being committed,
			// so they were neither in scrollback nor on screen: a large response showed
			// "only half" until a resize forced a full rebuild. Rows that scroll off the
			// viewport MUST reach native scrollback so the reader can scroll up to them,
			// and the commit must stay non-destructive (no ED3 saved-lines erase).
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			try {
				await withEnvPatch({ TMUX: undefined, STY: undefined, ZELLIJ: undefined }, async () => {
					const height = 8;
					const term = new UnknownViewportTerminal(50, height, 500);
					const writes = captureWrites(term);
					const tui = new TUI(term);
					// Reader follows the live tail (bottom-anchored, never scrolled up).
					const transcript = new MutableLinesComponent(["intro", ...rows("row-", 18)]);
					const footer = new MutableLinesComponent(["status", "prompt>"]);
					tui.addChild(transcript);
					tui.addChild(footer);

					try {
						tui.start();
						await settle(term);

						// prevLen = 1 + 18 + 2 = 21, height = 8 -> prevViewportTop = 13.
						// Append 6 rows (newLen = 27 -> overflowRows = 19) and, in the SAME
						// frame, re-lay-out logical row 14 ("row-13"), which sits inside the
						// scroll-off band [13, 19) and is about to leave the viewport.
						const reflowed = rows("row-", 18).map((row, i) => (i === 13 ? `${row}-reflowed` : row));
						const grown = ["intro", ...reflowed, ...rows("row-", 24).slice(18)];
						transcript.setLines(grown);
						tui.requestRender();
						await settle(term);

						// Bottom-anchored on the live tail.
						expect(visible(term).map(line => line.trim())).toEqual([
							"row-18",
							"row-19",
							"row-20",
							"row-21",
							"row-22",
							"row-23",
							"status",
							"prompt>",
						]);

						// Every logical row is reachable through native scrollback ∪ viewport.
						const baseY = term.getBufferPosition().baseY;
						const history = term
							.getScrollBuffer()
							.slice(0, baseY)
							.map(line => line.trimEnd());
						const reachable = new Set([...history, ...visible(term)].map(line => line.trim()));
						for (const row of grown) {
							expect(reachable.has(row), `${row} must stay reachable`).toBe(true);
						}

						// The scrolled-off rows — including the in-band re-laid-out one — landed
						// in committed native history, not just the active grid.
						expect(history).toContain("row-13-reflowed");
						expect(history).toContain("row-12");
						expect(history).toContain("row-17");

						// Anti-yank guarantee preserved: no destructive saved-lines erase.
						expect(writes.join("")).not.toContain("\x1b[3J");
					} finally {
						tui.stop();
					}
				});
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			}
		});
		it("keeps offscreen streaming growth incremental when the viewport is unknown", async () => {
			// Unknown viewport probes are not proof that the user is at the tail. While
			// a foreground tool is active, same-size/growing offscreen edits must keep
			// using append/repaint primitives instead of clearing scrollback once per
			// streaming tick after the transcript fills the viewport.
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			try {
				await withEnvPatch(
					{
						TMUX: undefined,
						STY: undefined,
						ZELLIJ: undefined,
						WEZTERM_PANE: undefined,
						KITTY_WINDOW_ID: undefined,
						GHOSTTY_RESOURCES_DIR: undefined,
						ALACRITTY_WINDOW_ID: undefined,
						TERM_PROGRAM: undefined,
					},
					async () => {
						const term = new UnknownViewportTerminal(40, 5, 200);
						const tui = new TUI(term);
						const component = new MutableLinesComponent(rows("row-", 16));
						tui.addChild(component);

						try {
							tui.start();
							await settle(term);
							const writes = captureWrites(term);

							// A streaming tool result re-laying out: an offscreen header changes and the
							// block grows past the fold in the same frame.
							component.setLines(["HEADER-EDITED", ...rows("row-", 16).slice(1), ...rows("tail-", 4)]);
							tui.requestRender();
							await settle(term);

							const output = writes.join("");
							expect(output).not.toContain("\x1b[2J");
							expect(output).not.toContain("\x1b[3J");
							const buffer = term.getScrollBuffer().map(line => line.trimEnd());
							expect(buffer).toContain("row-0");
							expect(buffer).toContain("tail-3");
							expect(buffer).not.toContain("HEADER-EDITED");
						} finally {
							tui.stop();
						}
					},
				);
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			}
		});

		it("paints a viewport-saturating pure-append on native Windows Terminal (no \\x1b[3J)", async () => {
			// Regression: on native Windows the viewport probe is permanently
			// `undefined` (ProcessTerminal does not implement it — see #1635/#1746). The
			// `15.7.5` #1635 fix routed pure-append-over-saturated-viewport frames to
			// `deferredMutation` here, which is a literal no-op. That froze the editor
			// on the very keystroke that grows `lines.length` past the viewport (the
			// wrap keystroke) until the next prompt-submit checkpoint flushed.
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			try {
				await withEnvPatch(
					{ WT_SESSION: "wt-test", TMUX: undefined, STY: undefined, ZELLIJ: undefined },
					async () => {
						const term = new UnknownViewportTerminal(32, 5);
						const tui = new TUI(term);
						// Five-row transcript + one editor row saturates the viewport (height = 5).
						// The user is at the tail — no scroll — but the probe still answers `undefined`.
						const transcript = new MutableLinesComponent(rows("seed-", 5));
						const editor = new MutableLinesComponent(["prompt> a"]);
						tui.addChild(transcript);
						tui.addChild(editor);

						try {
							tui.start();
							await settle(term);

							const writes: string[] = [];
							const realWrite = term.write.bind(term);
							(term as unknown as { write: (s: string) => void }).write = (data: string) => {
								writes.push(data);
								realWrite(data);
							};

							// The wrap keystroke: editor grows from one to two visual rows. This is a
							// pure append (`firstChanged === previousLines.length`, content grew) over
							// a viewport already at capacity — exactly the branch that used to defer.
							editor.setLines(["prompt> a", "wrap-row"]);
							tui.requestRender();
							await settle(term);

							// The #1635 anti-yank guarantee must survive: no destructive scrollback erase.
							expect(writes.join("")).not.toContain("\x1b[3J");
							// The wrap row paints in the same frame — viewportRepaint is non-destructive
							// but writes the visible window, so the editor's new visual row is on screen.
							expect(visible(term).map(line => line.trim())).toContain("wrap-row");
						} finally {
							tui.stop();
						}
					},
				);
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			}
		});

		it("paints a slash-command-shaped structural mutation on native Windows Terminal (no \\x1b[3J)", async () => {
			// Sibling regression: `/plan`, `/resume`, model switches, role-badge flips,
			// status-line toggles — any structural offscreen mutation — also routed to
			// `deferredMutation` under WT, so the toggle never painted until the next
			// checkpoint. After the fix the planner falls back to `viewportRepaint`
			// instead, painting the visible window without emitting `\x1b[3J`.
			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			try {
				await withEnvPatch(
					{ WT_SESSION: "wt-test", TMUX: undefined, STY: undefined, ZELLIJ: undefined },
					async () => {
						const term = new UnknownViewportTerminal(32, 5);
						const tui = new TUI(term);
						// Transcript + status + prompt; total six rows over a five-row viewport.
						const transcript = new MutableLinesComponent(rows("seed-", 4));
						const status = new MutableLinesComponent(["STATUS-OLD"]);
						const prompt = new MutableLinesComponent(["prompt>"]);
						tui.addChild(transcript);
						tui.addChild(status);
						tui.addChild(prompt);

						try {
							tui.start();
							await settle(term);

							const writes: string[] = [];
							const realWrite = term.write.bind(term);
							(term as unknown as { write: (s: string) => void }).write = (data: string) => {
								writes.push(data);
								realWrite(data);
							};

							// Slash-command toggle: an existing offscreen row flips its content and a
							// new chrome row is inserted. firstChanged lands above the viewport top,
							// length grew by one — a structural mutation, not a pure append.
							status.setLines(["STATUS-NEW", "EXTRA"]);
							tui.requestRender();
							await settle(term);

							expect(writes.join("")).not.toContain("\x1b[3J");
							const view = visible(term).map(line => line.trim());
							expect(view).toContain("STATUS-NEW");
							expect(view).toContain("EXTRA");
						} finally {
							tui.stop();
						}
					},
				);
			} finally {
				Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
			}
		});

		it("keeps transient checkpoint rows out of clean rebuilt scrollback", async () => {
			const term = new VirtualTerminal(32, 5);
			const tui = new TUI(term);
			const chat = new MutableLinesComponent(rows("line-", 12));
			const status = new MutableLinesComponent([]);
			const footer = new MutableLinesComponent(["FOOTER"]);
			tui.addChild(chat);
			tui.addChild(status);
			tui.addChild(footer);

			try {
				tui.start();
				await settle(term);

				chat.setLines(rows("line-", 8));
				tui.requestRender();
				await settle(term);
				term.scrollLines(999);

				status.setLines(["LOADER"]);
				tui.requestRender();
				await settle(term);

				status.setLines([]);
				tui.requestRender();
				await settle(term);

				expect(term.getScrollBuffer().join("\n")).not.toContain("LOADER");
			} finally {
				tui.stop();
			}
		});

		it("repaints a tail-cell mutation inside the window on the next ordinary frame", async () => {
			// Once header rows have scrolled into native history they are immutable;
			// a tail cell collapsing and regrowing inside the live window repaints
			// immediately on the next frame — there is no deferred reconciliation
			// pass — and the seam only ever advances, so nothing duplicates.
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const header = new MutableLinesComponent(["HEADER-0", "HEADER-1", "HEADER-2", "HEADER-3", "HEADER-4"]);
			const tail = new MutableLinesComponent(["cell-init"]);
			tui.addChild(header);
			tui.addChild(tail);

			try {
				tui.start();
				await settle(term);

				// Stream output until the transcript exceeds the viewport and the
				// header rows are committed.
				const out: string[] = [];
				for (let i = 0; i < 15; i++) {
					out.push(`cell-${i}`);
					tail.setLines([...out, "[footer]"]);
					tui.requestRender();
					await settle(term);
				}

				// Collapse the streamed preview into a summary. The collapse stays
				// below the commit boundary, so the window repaints on this very
				// frame: shorter tail plus trailing blanks (law 5).
				tail.setLines([...out.slice(0, 8), "[summary]", "[footer]"]);
				tui.requestRender();
				await settle(term);
				expect(visible(term).map(line => line.trim())).toEqual([
					"cell-6",
					"cell-7",
					"[summary]",
					"[footer]",
					"",
					"",
					"",
					"",
					"",
					"",
				]);

				// Regrow: streaming resumes, the summary disappears before its row
				// ever reaches the seam, and commits continue in order, exactly once.
				out.push("cell-15", "cell-16");
				tail.setLines([...out, "[footer]"]);
				tui.requestRender();
				await settle(term);

				expect(visible(term).map(line => line.trim())).toEqual([
					"cell-8",
					"cell-9",
					"cell-10",
					"cell-11",
					"cell-12",
					"cell-13",
					"cell-14",
					"cell-15",
					"cell-16",
					"[footer]",
				]);
				const scrollback = term.getScrollBuffer();
				expect(scrollback.join("\n")).not.toContain("[summary]");
				for (let i = 0; i < 5; i++) {
					const pattern = new RegExp(`\\bHEADER-${i}\\b`);
					expect(countMatches(scrollback, pattern), `HEADER-${i} appears exactly once`).toBe(1);
				}
				for (let i = 0; i < 17; i++) {
					const pattern = new RegExp(`\\bcell-${i}\\b`);
					expect(countMatches(scrollback, pattern), `cell-${i} appears exactly once`).toBe(1);
				}
			} finally {
				tui.stop();
			}
		});

		it("scrollback grows again after stale history is cleared", async () => {
			const term = new VirtualTerminal(60, 20);
			const tui = new TUI(term);
			const toast = new MutableLinesComponent(["TOAST"]);
			const userMessage = new MutableLinesComponent(["USER"]);
			const chat = new MutableLinesComponent([]);
			const footer = new MutableLinesComponent(["STATUS", "EDITOR-TOP", "EDITOR-CONTENT", "EDITOR-BOTTOM"]);

			tui.addChild(toast);
			tui.addChild(userMessage);
			tui.addChild(chat);
			tui.addChild(footer);

			try {
				tui.start();
				await settle(term);

				const thinkingLines = ["THINKING-0"];
				for (let i = 0; i < 25; i++) {
					thinkingLines.push(`THINKING-${i + 1}`);
					chat.setLines(thinkingLines);
					tui.requestRender();
					await settle(term);
				}

				// Collapse below the previous scrollback boundary, forcing the
				// stale-history reset path.
				chat.setLines(thinkingLines.slice(0, 5));
				tui.requestRender();
				await settle(term);
				const afterResetLength = term.getScrollBuffer().length;

				// Subsequent growth must be allowed to scroll normally. A
				// viewport-only repaint loop here leaves the user with no
				// terminal history to scroll back through.
				for (let i = 0; i < 30; i++) {
					thinkingLines.push(`LATER-${i}`);
					chat.setLines(thinkingLines);
					tui.requestRender();
					await settle(term);
				}

				expect(term.getScrollBuffer().length).toBeGreaterThan(afterResetLength);
			} finally {
				tui.stop();
			}
		});
		it("places hardware cursor at the focused row after a height-grow resize", async () => {
			// Mirrors the editor input layout: the focused component sits at the
			// last content row and emits CURSOR_MARKER. When the terminal grows
			// taller than the rendered content, #emitViewportRepaint must move
			// the hardware cursor up to the marker row instead of leaving it at
			// the viewport bottom (the rows below the content are blank padding).
			const term = new VirtualTerminal(40, 6);
			const tui = new TUI(term, true);
			const cursorAnchorRow = 5;
			class CursorAnchor implements Component, Focusable {
				focused = false;
				invalidate(): void {}
				render(_width: number): string[] {
					return [`anchor>${CURSOR_MARKER}`];
				}
			}
			tui.addChild(new MutableLinesComponent(rows("body-", cursorAnchorRow)));
			const anchor = new CursorAnchor();
			tui.addChild(anchor);
			tui.setFocus(anchor);

			try {
				tui.start();
				await settle(term);
				// Sanity check: content fills the viewport exactly.
				expect(term.getCursor().row).toBe(cursorAnchorRow);

				// Grow the terminal so it has more rows than the rendered content.
				term.resize(40, 20);
				await settleResize(term);

				// Regression: the cursor must follow the marker, not the bottom
				// of the now-taller viewport.
				expect(term.getCursor().row).toBe(cursorAnchorRow);
			} finally {
				tui.stop();
			}
		});

		it("leaves the parent shell prompt directly after short content on stop", async () => {
			const term = new VirtualTerminal(20, 5);
			const tui = new TUI(term);
			let stopped = false;
			tui.addChild(new MutableLinesComponent(["omp0", "omp1", "omp2"]));

			try {
				tui.start();
				await settle(term);
				tui.stop();
				stopped = true;
				await term.flush();
				term.write("bash$ ");
				await term.flush();

				expect(visible(term)).toEqual(["omp0", "omp1", "omp2", "bash$", ""]);
			} finally {
				if (!stopped) tui.stop();
			}
		});
	});

	describe("overlay compositing", () => {
		it("overlay show/hide restores underlying content", async () => {
			const term = new VirtualTerminal(40, 8);
			const tui = new TUI(term);
			const base = new MutableLinesComponent(rows("base-", 8));
			tui.addChild(base);

			try {
				tui.start();
				await settle(term);

				const handle = tui.showOverlay(new MutableLinesComponent(["OVERLAY-0", "OVERLAY-1"]), {
					anchor: "top-left",
					row: 2,
					col: 4,
				});
				await settle(term);

				expect(visible(term)[2]?.includes("OVERLAY-0")).toBeTruthy();
				expect(visible(term)[3]?.includes("OVERLAY-1")).toBeTruthy();

				handle.hide();
				await settle(term);

				const viewport = visible(term);
				expect(viewport[2]?.trim()).toBe("base-2");
				expect(viewport[3]?.trim()).toBe("base-3");
			} finally {
				tui.stop();
			}
		});

		it("hiding an overlay scrubs sentinel rows leaked into scrollback by resize reflow", async () => {
			const term = new VirtualTerminal(40, 4, 200);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(rows("base-", 20)));

			try {
				tui.start();
				await settle(term);

				const handle = tui.showOverlay(
					new MutableLinesComponent(["OV_SENTINEL_4_ov4-0-0-0-0-0-0", "ov4-1-0-0-0-0"]),
					{ row: 2, col: 18 },
				);
				await settle(term);
				term.resize(20, 4);
				await settle(term);

				expect(term.getScrollBuffer().some(line => line.includes("OV_SENTINEL_4_"))).toBeTrue();

				term.scrollLines(-1);
				await settle(term);
				handle.hide();
				await settle(term);

				expect(term.getScrollBuffer().some(line => line.includes("OV_SENTINEL_4_"))).toBeFalse();
				expect(visible(term).some(line => line.includes("OV_SENTINEL_4_"))).toBeFalse();
			} finally {
				tui.stop();
			}
		});

		it("tmux overlay hide repaints rows exposed by a shorter base frame", async () => {
			await withEnvPatch({ TMUX: "1", STY: undefined, ZELLIJ: undefined }, async () => {
				const term = new UnknownViewportTerminal(40, 3);
				const tui = new TUI(term);
				tui.addChild(new MutableLinesComponent(["base-0", "base-1", "base-2"]));

				try {
					tui.start();
					await settle(term);

					const handle = tui.showOverlay(new MutableLinesComponent(["OV-0", "OV-1", "OV-2"]), {
						row: 2,
						col: 0,
					});
					await settle(term);
					expect(visible(term)).toEqual(["OV-0", "OV-1", "OV-2"]);

					// Root cause: tmux disables destructive history rebuilds, so overlay
					// removal that shrinks the composite frame must repaint the viewport;
					// diffing from the old viewport top clears only the overlay suffix.
					handle.hide();
					await settle(term);

					expect(visible(term)).toEqual(["base-0", "base-1", "base-2"]);
				} finally {
					tui.stop();
				}
			});
		});
	});

	describe("fullscreen overlay alt-screen", () => {
		it("enters the alt buffer on show, leaves it on hide, and emits no ED3 while modal", async () => {
			const term = new VirtualTerminal(40, 8, 200);
			const writes = captureWrites(term);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(rows("base-", 8)));

			try {
				tui.start();
				await settle(term);

				const showFrom = writes.length;
				const handle = tui.showOverlay(new MutableLinesComponent(["MODAL-0", "MODAL-1"]), {
					anchor: "bottom-center",
					width: "100%",
					maxHeight: "100%",
					margin: 0,
					fullscreen: true,
				});
				await settle(term);

				const modalWrites = writes.slice(showFrom).join("");
				// Borrowed the alternate screen buffer …
				expect(modalWrites).toContain("\x1b[?1049h");
				// … re-pushed kitty keyboard flags in the same write: the mode stack
				// is per-screen, so without this Esc reverts to legacy bare \x1b
				// inside fullscreen overlays (settings Esc bug).
				expect(modalWrites).toContain("\x1b[?1049h\x1b[>1u");
				// … enabled mouse tracking for click/scroll/hover support …
				expect(modalWrites).toContain("\x1b[?1000h");
				expect(modalWrites).toContain("\x1b[?1003h"); // any-motion tracking drives hover
				expect(modalWrites).toContain("\x1b[?1006h");
				// … and never erased scrollback (ED3) or otherwise touched the transcript.
				expect(modalWrites).not.toContain("\x1b[3J");
				expect(visible(term).some(line => line.includes("MODAL-0"))).toBeTrue();

				const hideFrom = writes.length;
				handle.hide();
				await settle(term);

				const hideWrites = writes.slice(hideFrom).join("");
				expect(hideWrites).toContain("\x1b[?1049l");
				// The alt screen's kitty frame is popped before leaving it.
				expect(hideWrites).toContain("\x1b[<u\x1b[?1049l");
				// Mouse tracking is disabled again so the rest of the app keeps native
				// terminal selection.
				expect(hideWrites).toContain("\x1b[?1003l"); // motion tracking torn down too
				expect(hideWrites).toContain("\x1b[?1000l");
				// Transcript is back on the normal screen after leaving the alt buffer.
				expect(visible(term).some(line => line.includes("base-"))).toBeTrue();
				expect(visible(term).some(line => line.includes("MODAL-0"))).toBeFalse();
			} finally {
				tui.stop();
			}
		});

		it("leaves native scrollback untouched across the modal lifetime", async () => {
			const term = new VirtualTerminal(40, 6, 200);
			const tui = new TUI(term);
			// Base transcript overflows the viewport, so rows land in scrollback.
			tui.addChild(new MutableLinesComponent(rows("base-", 24)));

			try {
				tui.start();
				await settle(term);
				const scrollbackBefore = term.getScrollBuffer().map(line => line.trimEnd());

				const handle = tui.showOverlay(new MutableLinesComponent(["MODAL"]), {
					anchor: "bottom-center",
					width: "100%",
					maxHeight: "100%",
					margin: 0,
					fullscreen: true,
				});
				await settle(term);
				handle.hide();
				await settle(term);

				// The modal borrowed/returned the alt buffer without rewriting the
				// normal screen's scrollback — the transcript a reader scrolled up to
				// see is identical before and after.
				expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual(scrollbackBefore);
			} finally {
				tui.stop();
			}
		});
	});

	describe("stress scenarios", () => {
		it("rapid content mutations converge to final expected screen", async () => {
			const term = new VirtualTerminal(30, 8);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["init"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				for (let i = 0; i < 80; i++) {
					const n = (i % 7) + 1;
					component.setLines(Array.from({ length: n }, (_v, j) => `iter-${i}-line-${j}`));
					tui.requestRender();
					await settle(term);
				}

				const expected = Array.from({ length: 3 }, (_v, j) => `iter-79-line-${j}`);
				const viewport = visible(term);
				expect(viewport[0]?.trim()).toBe(expected[0]);
				expect(viewport[1]?.trim()).toBe(expected[1]);
				expect(viewport[2]?.trim()).toBe(expected[2]);
				expect(viewport[3]?.trim()).toBe("");
			} finally {
				tui.stop();
			}
		});
	});

	describe("ZWJ grapheme row containment", () => {
		// Ghostty agrees with the renderer for this family sequence, so these
		// regressions no longer use xterm's legacy width tables as the terminal
		// model. They still pin the row-accounting boundary that used to corrupt
		// scrollback when a terminal measured a grapheme wider than the renderer:
		// content writes are wrapped in DECAWM-off (\x1b[?7l), so any future
		// terminal-side overrun must be contained to the row instead of wrapping
		// into a phantom spill row.
		const ZWJ_FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";

		// MutableLinesComponent pre-slices by UTF-16 code units, which would cut the
		// ZWJ sequence before the renderer ever measures it. Width decisions must be
		// made by the renderer's own #fitLineToWidth, so pass lines through raw.
		class RawLinesComponent implements Component {
			#lines: string[];
			constructor(lines: string[]) {
				this.#lines = [...lines];
			}
			setLines(lines: string[]): void {
				this.#lines = [...lines];
			}
			invalidate(): void {}
			render(): string[] {
				return [...this.#lines];
			}
		}

		it("keeps ZWJ boundary rows on one terminal row; row accounting stays exact", async () => {
			const width = 20;
			const height = 6;
			const term = new VirtualTerminal(width, height);
			const tui = new TUI(term);
			// Renderer and Ghostty both fit 18 ASCII + the ZWJ family into this
			// row. If either side drifts wider, DECAWM-off containment must still
			// prevent a wrap into the following logical row.
			const zwjRow = `${"B".repeat(18)}${ZWJ_FAMILY}`;
			const lines = ["header", zwjRow, "tail"];
			const component = new RawLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				// One terminal row per logical line — the boundary row did not wrap.
				expect(term.getScrollBuffer().length).toBe(height);
				const viewport = visible(term);
				expect(viewport[0]).toBe("header");
				expect(viewport[2]).toBe("tail");
				expect(viewport[1]?.startsWith("B".repeat(18))).toBe(true);
				expect(viewport[3]).toBe("");

				// Push content into scrollback: accounting must track logical rows
				// exactly with the ZWJ boundary row in history.
				const appended = [...lines, ...rows("after-", 10)];
				component.setLines(appended);
				tui.requestRender();
				await settle(term);

				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				expect(buffer.length).toBe(appended.length);
				expect(buffer[0]).toBe("header");
				expect(buffer[2]).toBe("tail");
				expect(buffer[buffer.length - 1]).toBe("after-9");
				// The ZWJ row exists exactly once — no duplicate, no spill row.
				expect(countMatches(buffer, /^B{18}/)).toBe(1);
			} finally {
				tui.stop();
			}
		});

		it("keeps differential row targeting exact after rendering a ZWJ boundary row", async () => {
			const width = 20;
			const height = 8;
			const term = new VirtualTerminal(width, height);
			const tui = new TUI(term);
			const zwjRow = `${"B".repeat(18)}${ZWJ_FAMILY}`;
			const lines = ["row-0", zwjRow, "row-2", "row-3", "row-4"];
			const component = new RawLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				// Diff-edit the row below the clipped row. If clipping had desynced the
				// renderer's hardware-cursor row tracking, this write would land on the
				// wrong terminal row.
				component.setLines(["row-0", zwjRow, "EDITED", "row-3", "row-4"]);
				tui.requestRender();
				await settle(term);

				const viewport = visible(term);
				expect(viewport[0]).toBe("row-0");
				expect(viewport[2]).toBe("EDITED");
				expect(viewport[3]).toBe("row-3");
				expect(viewport[4]).toBe("row-4");
				// Neighbor above the edit (the clipped row) was not rewritten or moved.
				expect(viewport[1]?.startsWith("B".repeat(18))).toBe(true);
				expect(term.getScrollBuffer().length).toBe(height);
			} finally {
				tui.stop();
			}
		});
	});

	describe("Ghostty-backed renderer/terminal agreement", () => {
		// Counterpart of the disagreement tests above: VirtualTerminal is backed by
		// Ghostty's grapheme-aware engine, so its terminal cell widths must agree
		// with the renderer for emoji presentation, VS16, and keycap sequences. An
		// exact-fit line fills the row with nothing clipped, and the renderer's
		// truncation boundary lands the last glyph exactly at the right margin.

		// MutableLinesComponent pre-slices by UTF-16 code units; width decisions
		// must come from the renderer's #fitLineToWidth.
		class RawLinesComponent implements Component {
			#lines: string[];
			constructor(lines: string[]) {
				this.#lines = [...lines];
			}
			setLines(lines: string[]): void {
				this.#lines = [...lines];
			}
			invalidate(): void {}
			render(): string[] {
				return [...this.#lines];
			}
		}

		it("renders an exact-fit emoji-presentation line without truncation or wrap", async () => {
			const width = 20;
			const term = new VirtualTerminal(width, 6);
			const tui = new TUI(term);
			// 14 ASCII + ⚠️(2) + 🙂(2) + keycap(2) = 20 cells for both Ghostty's
			// grapheme-aware terminal and the renderer — an exact fit.
			const line = `${"a".repeat(14)}\u26A0\uFE0F\u{1F642}1\uFE0F\u20E3`;
			const component = new RawLinesComponent(["head", line, "tail"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const viewport = term.getViewport();
				// Cell-exact: the full line survives the round trip on one row.
				expect(viewport[1]).toBe(line);
				expect(viewport[0]?.trimEnd()).toBe("head");
				expect(viewport[2]?.trimEnd()).toBe("tail");
				// One terminal row per logical row — no wrap from the wide glyphs.
				expect(term.getScrollBuffer().length).toBe(6);
			} finally {
				tui.stop();
			}
		});

		it("exposes Ghostty legacy-width/xterm-width overrun instead of accepting hidden truncation", () => {
			const width = 12;
			const term = new VirtualTerminal(width, 4);
			const prefix = "012345678";
			const wide = "\u{1F642}";
			const sentinel = "sentinel";

			// A legacy/xterm-width oracle that counts 🙂 as 1 would accept this as
			// a 12-cell exact fit: 9 ASCII + 🙂 + ZZ. Ghostty counts the emoji as
			// 2 cells, so the second Z overruns the row. Renderer paints run with
			// DECAWM off; mirror that containment contract directly through
			// VirtualTerminal instead of reaching into TUI internals.
			term.write(`\x1b[?7l${prefix}${wide}ZZ\r\n${sentinel}\x1b[?7h`);
			const viewport = term.getViewport();
			expect(viewport[0]).toBe(`${prefix}${wide}Z`);
			expect(viewport[0]).not.toContain("ZZ");
			expect(viewport[1]).toBe(sentinel);
			expect(term.getScrollBuffer().length).toBe(4);
		});

		it("lands the renderer's truncation boundary exactly at the right margin", async () => {
			const width = 12;
			const term = new VirtualTerminal(width, 4);
			const tui = new TUI(term);
			// Renderer width: 10 ASCII + 2 + 2 + 2 = 16 > 12 → #fitLineToWidth
			// truncates. The truncated text must occupy exactly 12 Ghostty cells:
			// 10 ASCII + ⚠️ = 12, with 🙂 dropped whole (never split).
			const line = `${"x".repeat(10)}\u26A0\uFE0F\u{1F642}1\uFE0F\u20E3`;
			const nextLine = "after";
			const component = new RawLinesComponent([line, nextLine]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const viewport = term.getViewport();
				const rendered = viewport[0] ?? "";
				// The kept prefix is exactly the renderer's 12-cell truncation.
				expect(rendered).toBe(`${"x".repeat(10)}\u26A0\uFE0F`);
				// The exact-width row occupies one Ghostty row: the dropped glyphs
				// neither split nor wrap into the following logical row.
				expect(viewport[1]?.trimEnd()).toBe(nextLine);
				expect(term.getScrollBuffer().length).toBe(4);
			} finally {
				tui.stop();
			}
		});
	});

	describe("SGR background containment (BCE)", () => {
		// Components leak unreset SGR (markdown renderers, raw tool output). On
		// BCE terminals (xterm.js, xterm, VTE, kitty, ...), \x1b[K / \x1b[2K /
		// \x1b[2J erase cells using the CURRENT background color, so background
		// state that leaks across a line boundary paints whole phantom-colored
		// rows — the "random colored blank rows" bug class. The renderer's
		// per-line terminators (#applyLineResets appending \x1b[0m + OSC8 close to
		// every row) must confine a component's unreset background to its own row
		// on every emit path.
		class RawLinesComponent implements Component {
			#lines: string[];
			constructor(lines: string[]) {
				this.#lines = [...lines];
			}
			setLines(lines: string[]): void {
				this.#lines = [...lines];
			}
			invalidate(): void {}
			render(): string[] {
				return [...this.#lines];
			}
		}

		const UNRESET_BG_ROW = "\x1b[41mRED-BG-NO-RESET";
		const UNRESET_FG_UNDERLINE_ROW = "\x1b[32;4mGREEN-UNDER-NO-RESET";

		function backgroundRows(term: VirtualTerminal, height: number): number[] {
			const rows: number[] = [];
			for (let row = 0; row < height; row++) {
				if (term.getViewportRowBackgroundColumns(row).length > 0) rows.push(row);
			}
			return rows;
		}

		function foregroundRows(term: VirtualTerminal, height: number): number[] {
			const rows: number[] = [];
			for (let row = 0; row < height; row++) {
				if (term.getViewportRowForegroundColumns(row).length > 0) rows.push(row);
			}
			return rows;
		}

		function underlineRows(term: VirtualTerminal, height: number): number[] {
			const rows: number[] = [];
			for (let row = 0; row < height; row++) {
				if (term.getViewportRowUnderlineColumns(row).length > 0) rows.push(row);
			}
			return rows;
		}

		it("confines an unreset background to its own row across initial, diff, and shrink paints", async () => {
			const height = 6;
			const term = new VirtualTerminal(20, height);
			const tui = new TUI(term);
			const component = new RawLinesComponent(["plain-0", UNRESET_BG_ROW, "plain-2"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				// Initial paint: only the styled row carries background cells.
				expect(backgroundRows(term, height)).toEqual([1]);

				// Diff path: rewriting the row below clears only after the row reset;
				// with leaked background, BCE would otherwise paint that row red.
				component.setLines(["plain-0", UNRESET_BG_ROW, "EDITED-2"]);
				tui.requestRender();
				await settle(term);
				expect(backgroundRows(term, height)).toEqual([1]);
				expect(visible(term)[2]).toBe("EDITED-2");

				// Shrink path: the cleared trailing row must come back as a
				// default-background blank, not a red bar.
				component.setLines(["plain-0", UNRESET_BG_ROW]);
				tui.requestRender();
				await settle(term);
				expect(backgroundRows(term, height)).toEqual([1]);
				expect(visible(term)[2]).toBe("");
			} finally {
				tui.stop();
			}
		});

		it("confines unreset foreground and underline to their own row", async () => {
			const height = 6;
			const term = new VirtualTerminal(24, height);
			const tui = new TUI(term);
			const component = new RawLinesComponent(["plain-0", UNRESET_FG_UNDERLINE_ROW, "plain-2"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				expect(foregroundRows(term, height)).toEqual([1]);
				expect(underlineRows(term, height)).toEqual([1]);

				// Rewriting the next row clears only after the row reset; leaked SGR
				// would make the edited row green/underlined despite containing plain text.
				component.setLines(["plain-0", UNRESET_FG_UNDERLINE_ROW, "EDITED-2"]);
				tui.requestRender();
				await settle(term);
				expect(foregroundRows(term, height)).toEqual([1]);
				expect(underlineRows(term, height)).toEqual([1]);
				expect(term.getViewportRowForegroundColumns(2)).toEqual([]);
				expect(term.getViewportRowUnderlineColumns(2)).toEqual([]);

				component.setLines(["plain-0", UNRESET_FG_UNDERLINE_ROW]);
				tui.requestRender();
				await settle(term);
				expect(foregroundRows(term, height)).toEqual([1]);
				expect(underlineRows(term, height)).toEqual([1]);
				expect(term.getViewportRowForegroundColumns(2)).toEqual([]);
				expect(term.getViewportRowUnderlineColumns(2)).toEqual([]);
			} finally {
				tui.stop();
			}
		});

		it("confines an unreset background during full viewport repaints", async () => {
			const height = 4;
			const term = new VirtualTerminal(20, height);
			const tui = new TUI(term);
			// Content taller than the viewport so repaints exercise the
			// bottom-anchored slice logic with the styled row offscreen and onscreen.
			const lines = ["plain-0", UNRESET_BG_ROW, ...rows("tail-", 4)];
			const component = new RawLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				// Force a full repaint (viewport rewrite path suffix-clears each text row).
				tui.requestRender(true);
				await settle(term);

				// The styled row is offscreen (frame rows 2-5 visible); no visible row
				// may carry background cells.
				expect(backgroundRows(term, height)).toEqual([]);
				// And the committed scrollback copy of the styled row keeps its color
				// confined: the rows after it in history have no background.
				expect(term.getViewportRowBackgroundColumns(0)).toEqual([]);
			} finally {
				tui.stop();
			}
		});
	});

	describe("pending-wrap / DECAWM at exact-width rows", () => {
		// A row whose visible width EXACTLY equals the terminal width writes its
		// last cell, latching the "pending wrap" flag on autowrap terminals — a
		// following cursor move can then wrap to the next row and produce staircase
		// trails / phantom rows in scrollback. The renderer disables autowrap
		// (\x1b[?7l) around every paint and restores it (\x1b[?7h) only at PAINT_END,
		// after emitting explicit CRLFs, so an exact-width row never latches
		// pending-wrap. These tests pin that with Ghostty-backed ASCII and wide-glyph
		// rows across the initial, diff, and append emit paths.
		class RawLinesComponent implements Component {
			#lines: string[];
			constructor(lines: string[]) {
				this.#lines = [...lines];
			}
			setLines(lines: string[]): void {
				this.#lines = [...lines];
			}
			invalidate(): void {}
			render(): string[] {
				return [...this.#lines];
			}
		}

		it("keeps exact-width Ghostty-backed rows on one terminal row without staircase", async () => {
			const width = 10;
			const height = 6;
			const term = new VirtualTerminal(width, height);
			const tui = new TUI(term);
			// Two exact-width (10-cell) rows: one ASCII, one ending on 2-cell wide
			// glyphs exactly at the right margin (the pending-wrap trigger).
			const exactAscii = "0123456789";
			const exactWide = "AAAA界界界"; // 4 + 2+2+2 = 10
			const lines = ["top", exactAscii, exactWide, "bot"];
			const component = new RawLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				// Each logical row occupies exactly one terminal row — no wrap.
				// Content (4 rows) fits the 6-row viewport, so the buffer is the
				// viewport: 4 content rows + 2 trailing blanks, each on its own row.
				const buffer = term.getScrollBuffer().map(line => line.trimEnd());
				expect(buffer).toEqual(["top", exactAscii, exactWide, "bot", "", ""]);

				// Diff-edit the row below the exact-width wide row: if pending-wrap
				// had latched, the relative cursor move would land a row off.
				component.setLines(["top", exactAscii, exactWide, "EDIT"]);
				tui.requestRender();
				await settle(term);
				expect(term.getViewport().map(line => line.trimEnd())).toEqual([
					"top",
					exactAscii,
					exactWide,
					"EDIT",
					"",
					"",
				]);

				// Append past the viewport: exact-width rows must scroll into
				// history one row each, contiguous, no phantom blank from a latched
				// wrap.
				component.setLines(["top", exactAscii, exactWide, "EDIT", ...rows("a-", 6)]);
				tui.requestRender();
				await settle(term);
				const after = term.getScrollBuffer().map(line => line.trimEnd());
				expect(after).toEqual(["top", exactAscii, exactWide, "EDIT", ...rows("a-", 6)]);
			} finally {
				tui.stop();
			}
		});
	});
	describe("hardware cursor preference", () => {
		const SHOW_CURSOR = "\x1b[?25h";

		class FocusedCursor implements Component, Focusable {
			focused = false;
			invalidate(): void {}
			render(_width: number): string[] {
				return [`prompt>${CURSOR_MARKER}`];
			}
		}

		class CursorModeAware implements Component, Focusable {
			focused = false;
			useTerminalCursor = false;
			seenModes: boolean[] = [];

			setUseTerminalCursor(useTerminalCursor: boolean): void {
				this.useTerminalCursor = useTerminalCursor;
				this.seenModes.push(useTerminalCursor);
			}

			invalidate(): void {}

			render(_width: number): string[] {
				return [this.focused ? `prompt>${CURSOR_MARKER}` : "prompt>"];
			}
		}

		class CursorVisibilityTerminal extends VirtualTerminal {
			visibilityWrites: string[] = [];

			override hideCursor(): void {
				this.visibilityWrites.push("\x1b[?25l");
				super.hideCursor();
			}

			override showCursor(): void {
				this.visibilityWrites.push(SHOW_CURSOR);
				super.showCursor();
			}
		}

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("honors the requested hardware cursor preference under Ghostty (no terminal override)", async () => {
			// Regression: a Ghostty-specific override used to force the hardware
			// cursor off while the editor stayed in terminal-cursor mode (marker
			// only, no software glyph), leaving Ghostty users with no visible
			// caret at all. The preference must follow the constructor arg only.
			await withEnvPatch(
				{
					TERM_PROGRAM: "ghostty",
					TERM: "xterm-ghostty",
					GHOSTTY_RESOURCES_DIR: "/tmp/ghostty",
					GHOSTTY_SURFACE_ID: "0x1",
				},
				() => {
					expect(new TUI(new VirtualTerminal(20, 4), true).getShowHardwareCursor()).toBe(true);
					expect(new TUI(new VirtualTerminal(20, 4), false).getShowHardwareCursor()).toBe(false);
				},
			);
		});

		it("emits the show-cursor sequence for the focused marker only when enabled", async () => {
			for (const enabled of [true, false]) {
				const term = new VirtualTerminal(20, 4);
				const tui = new TUI(term, enabled);
				const writes: string[] = [];
				vi.spyOn(term, "write").mockImplementation((data: string) => {
					writes.push(data);
				});
				const anchor = new FocusedCursor();
				tui.addChild(anchor);
				tui.setFocus(anchor);

				try {
					tui.start();
					await settle(term);
					// Disabled keeps the caret hidden (\x1b[?25l only); enabled re-shows
					// it at the marker after positioning inside the synchronized paint.
					expect(writes.join("").includes(SHOW_CURSOR)).toBe(enabled);
				} finally {
					tui.stop();
					vi.restoreAllMocks();
				}
			}
		});

		it("syncs focused component cursor rendering mode on focus and preference changes", () => {
			const renderScheduler = {
				now: () => 0,
				scheduleImmediate: () => {},
				scheduleRender: () => ({ cancel: () => {} }),
			};
			const tui = new TUI(new VirtualTerminal(20, 4), true, { renderScheduler });
			const first = new CursorModeAware();
			const second = new CursorModeAware();

			tui.setFocus(first);
			expect(first.focused).toBe(true);
			expect(first.useTerminalCursor).toBe(true);
			expect(first.seenModes).toEqual([true]);

			tui.setShowHardwareCursor(false);
			expect(first.useTerminalCursor).toBe(false);
			expect(first.seenModes).toEqual([true, false]);

			tui.setFocus(second);
			expect(first.focused).toBe(false);
			expect(second.focused).toBe(true);
			expect(second.useTerminalCursor).toBe(false);
			expect(second.seenModes).toEqual([false]);

			tui.setShowHardwareCursor(true);
			expect(first.useTerminalCursor).toBe(false);
			expect(second.useTerminalCursor).toBe(true);
			expect(second.seenModes).toEqual([false, true]);
		});
		it("shows the terminal cursor during stop even when paints keep it hidden", async () => {
			// DECSC/DECRC restore cursor position and attributes, not DECTCEM
			// visibility. The TUI hides the hardware cursor before paints, so stop()
			// must explicitly show it even when the session disabled hardware-cursor
			// rendering and no paint ever emitted \x1b[?25h.
			const term = new CursorVisibilityTerminal(20, 4);
			const tui = new TUI(term, false);
			tui.addChild(new MutableLinesComponent(["prompt"]));

			try {
				tui.start();
				await settle(term);
				expect(term.visibilityWrites).not.toContain(SHOW_CURSOR);
			} finally {
				tui.stop();
			}
			expect(term.visibilityWrites.at(-1)).toBe(SHOW_CURSOR);
		});
	});

	describe("cursor escape sequences stay inside synchronized output blocks", () => {
		// Cursor placement sequences that must not leak outside \x1b[?2026h…\x1b[?2026l
		const CURSOR_SEQ = /\x1b\[\?(?:25[hl]|\d+[A-G])/g;
		const BSU = "\x1b[?2026h";
		const ESU = "\x1b[?2026l";
		const HIDE_CURSOR = "\x1b[?25l";
		const DISABLE_AUTOWRAP = "\x1b[?7l";
		const ENABLE_AUTOWRAP = "\x1b[?7h";

		// Force DEC 2026 synchronized output on regardless of the host terminal so
		// these wrapper-bracketing assertions stay deterministic. In CI an unknown
		// TERM disables sync output by default, which would emit no BSU/ESU pairs.
		const SYNC_ENV: Record<string, string | undefined> = {
			PI_FORCE_SYNC_OUTPUT: "1",
			PI_NO_SYNC_OUTPUT: undefined,
			PI_TUI_SYNC_OUTPUT: undefined,
		};
		const savedSyncEnv: Record<string, string | undefined> = {};

		beforeEach(() => {
			for (const key in SYNC_ENV) {
				savedSyncEnv[key] = Bun.env[key];
				const value = SYNC_ENV[key];
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
		});

		function getWrites(term: VirtualTerminal): string[] {
			const writes: string[] = [];
			const spy = vi.spyOn(term, "write");
			spy.mockImplementation((data: string) => {
				writes.push(data);
			});
			return writes;
		}

		afterEach(() => {
			for (const key in savedSyncEnv) {
				const value = savedSyncEnv[key];
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
			vi.restoreAllMocks();
		});

		it("all cursor sequences fall inside BSU/ESU brackets on full render", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			const writes = getWrites(term);

			const component = new MutableLinesComponent(["hello", "world"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);
				assertCursorSequencesInsideSyncBlocks(writes);
			} finally {
				tui.stop();
			}
		});

		it("all cursor sequences fall inside BSU/ESU brackets on differential render", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);

			const component = new MutableLinesComponent(["AAA", "BBB", "CCC"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const writes = getWrites(term);
				component.setLines(["AAA", "XXX", "CCC"]);
				tui.requestRender();
				await settle(term);
				assertCursorSequencesInsideSyncBlocks(writes);
			} finally {
				tui.stop();
			}
		});

		it("disables terminal autowrap inside paint writes", async () => {
			const term = new VirtualTerminal(12, 6);
			const tui = new TUI(term);
			const component = new MutableLinesComponent(["ABCDEFGHIJKL", "tail"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const writes = getWrites(term);
				component.setLines(["XXXXEFGHIJKL", "tail"]);
				tui.requestRender();
				await settle(term);

				const paintWrites = writes.filter(write => write.includes(BSU));
				expect(paintWrites.length).toBeGreaterThan(0);
				for (const write of paintWrites) {
					const begin = write.indexOf(BSU);
					expect(write.startsWith(HIDE_CURSOR)).toBe(true);
					expect(begin).toBe(HIDE_CURSOR.length);
					const disable = write.indexOf(DISABLE_AUTOWRAP, begin + BSU.length);
					const enable = write.lastIndexOf(ENABLE_AUTOWRAP);
					const end = write.lastIndexOf(ESU);
					expect(disable).toBe(begin + BSU.length);
					expect(enable).toBeGreaterThan(disable);
					expect(end).toBeGreaterThan(enable);
				}
			} finally {
				tui.stop();
			}
		});

		it("all cursor sequences fall inside BSU/ESU brackets on deleted-lines render", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);

			const component = new MutableLinesComponent(["A", "B", "C", "D"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const writes = getWrites(term);
				component.setLines(["A", "B"]);
				tui.requestRender();
				await settle(term);
				assertCursorSequencesInsideSyncBlocks(writes);
			} finally {
				tui.stop();
			}
		});

		it("all cursor sequences fall inside BSU/ESU brackets on repeated no-op renders", async () => {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);

			const component = new MutableLinesComponent(["hello", "world", "stable"]);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const writes = getWrites(term);
				for (let i = 0; i < 4; i++) {
					tui.requestRender();
					await settle(term);
				}
				assertCursorSequencesInsideSyncBlocks(writes);
			} finally {
				tui.stop();
			}
		});

		/**
		 * Assert that every cursor escape sequence in every write call appears
		 * strictly between a matched BSU/ESU pair, is the leading hideCursor that
		 * intentionally happens just before BSU, or is the sole payload of a
		 * standalone hideCursor call (from a no-change/no-cursor path).
		 */
		function assertCursorSequencesInsideSyncBlocks(writes: string[]): void {
			for (const write of writes) {
				if (write === HIDE_CURSOR) {
					// Standalone hideCursor — allowed (no-change/no-cursor path)
					continue;
				}
				// Walk through the write, tracking BSU/ESU nesting
				let depth = 0;
				let idx = 0;
				while (idx < write.length) {
					CURSOR_SEQ.lastIndex = idx;
					const match = CURSOR_SEQ.exec(write);
					if (!match) break;

					const matchIdx = match.index;
					// Count BSU/ESU depth up to the match position
					let scanIdx = idx;
					while (scanIdx < matchIdx) {
						if (write.startsWith(BSU, scanIdx)) {
							depth++;
							scanIdx += BSU.length;
						} else if (write.startsWith(ESU, scanIdx)) {
							depth--;
							scanIdx += ESU.length;
						} else {
							scanIdx++;
						}
					}

					if (match[0] === HIDE_CURSOR && write.startsWith(HIDE_CURSOR + BSU) && matchIdx === 0) {
						idx = matchIdx + match[0].length;
						continue;
					}
					expect(depth).toBeGreaterThan(0);

					idx = matchIdx + match[0].length;
				}
			}
		}
	});
});

describe("foreground-tool streaming on ED3-risk terminals", () => {
	beforeEach(() => {
		let monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 20;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Repro of the "injected notification chip renders over the active tool
	// render" report. A foreground tool streams while its header (carrying a
	// ticking elapsed-time counter) has scrolled above the window top. The tick
	// is an offscreen edit — committed rows are immutable, so it is ignored —
	// while injected chips grow the frame and advance the commit boundary. When
	// a visible chip then collapses, the window cannot re-show committed rows
	// (law 5: that would visually duplicate them for a scrolling reader): it
	// stays floored at the commit boundary and shows the shorter tail with a
	// trailing blank row instead of drifting content upward over the rows above.
	it("floors a visible-region shrink at the commit boundary after an offscreen-edit grow", async () => {
		const term = new UnknownViewportTerminal(40, 6);
		const tui = new TUI(term);
		// done-* are completed messages that have scrolled into history; the
		// "Write …s" header carries the ticking timer; code-* is the streamed
		// preview; loader/todos/editor is the stable footer below the tool.
		const frameA = [
			"done-0",
			"done-1",
			"done-2",
			"done-3",
			"done-4",
			"done-5",
			"Write 0s",
			"code-148",
			"code-149",
			"code-150",
			"loader",
			"todos",
			"editor",
		];
		const component = new MutableLinesComponent(frameA);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);
			// The header has scrolled above the viewport top (offscreen).
			expect(visible(term)).toEqual(["code-148", "code-149", "code-150", "loader", "todos", "editor"]);

			// Frame B: the offscreen header ticks (0s -> 1s) AND four notification
			// chips inject between the tool and the footer — an offscreen-edit grow
			// that repaints in place and lags native history behind the new overflow.
			const frameB = [
				"done-0",
				"done-1",
				"done-2",
				"done-3",
				"done-4",
				"done-5",
				"Write 1s",
				"code-148",
				"code-149",
				"code-150",
				"chip-0",
				"chip-1",
				"chip-2",
				"chip-3",
				"loader",
				"todos",
				"editor",
			];
			component.setLines(frameB);
			tui.requestRender();
			await term.waitForRender();
			expect(visible(term)).toEqual(["chip-1", "chip-2", "chip-3", "loader", "todos", "editor"]);

			// Frame C: a visible chip collapses (a shrink whose first change lands in
			// the visible region) while the header does NOT tick this frame. The
			// window stays floored at the commit boundary: chip-0 committed when the
			// chips scrolled the seam forward, so the shorter tail renders with a
			// trailing blank row rather than re-showing chip-0.
			const frameC = [
				"done-0",
				"done-1",
				"done-2",
				"done-3",
				"done-4",
				"done-5",
				"Write 1s",
				"code-148",
				"code-149",
				"code-150",
				"chip-0",
				"chip-1",
				"chip-2",
				"loader",
				"todos",
				"editor",
			];
			component.setLines(frameC);
			tui.requestRender();
			await term.waitForRender();
			expect(visible(term)).toEqual(["chip-1", "chip-2", "loader", "todos", "editor", ""]);
		} finally {
			tui.stop();
		}
	});

	it("honors a clear-scrollback replay queued before the initial paint", async () => {
		const term = new VirtualTerminal(40, 6);
		const writes = captureWrites(term);
		const tui = new TUI(term);
		tui.addChild(new MutableLinesComponent(["resumed-message", "prompt>"]));

		try {
			tui.start();
			tui.requestRender(true, { clearScrollback: true });
			await settle(term);

			expect(writes.join("")).toContain("\x1b[3J");
		} finally {
			tui.stop();
		}
	});

	// Repro of the drag-resize line-duplication: dragging the terminal smaller
	// fires a stream of height shrinks. While the transcript FITS the viewport,
	// each shrink used to scroll live rows into native scrollback — the in-place
	// viewport repaint parked the hardware cursor on the padded viewport bottom,
	// BELOW the short content, so the terminal's shrink reflow pushed the live
	// rows up to keep that cursor on screen and the next repaint redrew them,
	// committing one duplicate copy of the visible block per resize step. The
	// repaint must leave the cursor on the real content bottom instead.
	it("does not duplicate fitting content into scrollback across a drag-resize", async () => {
		const term = new UnknownViewportTerminal(40, 24);
		const tui = new TUI(term);
		const body = rows("line-", 4);
		const component = new MutableLinesComponent(body);
		tui.addChild(component);
		try {
			tui.start();
			await settle(term);
			// A drag-resize: a stream of height shrinks while the 4-line block
			// keeps fitting the (still larger) viewport.
			for (const height of [22, 20, 18, 16, 14, 12, 10, 8, 6]) {
				term.resize(40, height);
				tui.requestRender();
				await settle(term);
			}
			// The drag itself must not have accreted duplicate copies into
			// scrollback. Assert this BEFORE the settle: the authoritative rebuild
			// erases scrollback (ED3) and replays once, so it would collapse — and
			// thereby mask — any drag-time duplication. Checking only the settled
			// state would make this regression test pass even if the in-flight
			// viewport repaints duplicated every visible row per step.
			const draggedScrollback = term.getScrollBuffer();
			for (let i = 0; i < body.length; i++) {
				expect(
					countMatches(draggedScrollback, new RegExp(`\\bline-${i}\\b`)),
					`line-${i} must not duplicate during the drag`,
				).toBeLessThanOrEqual(1);
			}
			// Then let the settle window elapse so the authoritative rebuild
			// collapses history to one copy, and confirm the end state holds too.
			await settleResize(term);
			const scrollback = term.getScrollBuffer();
			for (let i = 0; i < body.length; i++) {
				expect(
					countMatches(scrollback, new RegExp(`\\bline-${i}\\b`)),
					`line-${i} must not duplicate across resizes`,
				).toBeLessThanOrEqual(1);
			}
		} finally {
			tui.stop();
		}
	});
});
