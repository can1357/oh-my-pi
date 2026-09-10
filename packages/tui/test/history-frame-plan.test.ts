import { describe, expect, it } from "bun:test";
import {
	type Component,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	Text,
	TUI,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

class Provider implements TerminalFrameProvider {
	plan: TerminalFramePlan;
	resizeRows: readonly string[] | undefined;
	acknowledged: number[] = [];
	borrowed: number[] = [];

	constructor(plan: TerminalFramePlan) {
		this.plan = plan;
	}

	renderFrame(_viewport: ViewportSize): TerminalFramePlan {
		return this.plan;
	}
	renderResizeFrame(_viewport: ViewportSize): readonly string[] {
		return this.resizeRows ?? this.plan.viewport;
	}

	acknowledgeHistory(id: number): void {
		this.acknowledged.push(id);
		this.plan = { viewport: this.plan.viewport };
	}
	onViewportBorrowed(rows: number): void {
		this.borrowed.push(rows);
	}
}

class FullscreenOverlay implements Component {
	render(): string[] {
		return ["fullscreen overlay"];
	}
}

class CountingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

const scheduler = {
	now: () => 0,
	scheduleImmediate(callback: () => void) {
		callback();
		return { cancel() {} };
	},
	scheduleRender(callback: () => void) {
		callback();
		return { cancel() {} };
	},
};
class ResizeScheduler {
	#now = 0;
	#pending = new Set<() => void>();

	now(): number {
		return this.#now;
	}

	scheduleImmediate(callback: () => void): void {
		callback();
	}

	scheduleRender(callback: () => void, _delayMs: number) {
		this.#pending.add(callback);
		return { cancel: () => this.#pending.delete(callback) };
	}

	settle(): void {
		this.#now += 120;
		const pending = [...this.#pending];
		this.#pending.clear();
		for (const callback of pending) callback();
	}
}
class WidthReplayProvider implements TerminalFrameProvider {
	#nextHistoryId = 1;
	#retired = false;
	readonly #historyRows: readonly string[];
	resetCount = 0;

	constructor(historyRows: readonly string[] = ["history-one", "history-two"]) {
		this.#historyRows = historyRows;
	}

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		const width = viewport.columns;
		return {
			history: this.#retired
				? undefined
				: {
						id: this.#nextHistoryId,
						rows: this.#historyRows.map(row => `${row}@${width}`),
					},
			viewport: [`editor@${width}`],
		};
	}

	acknowledgeHistory(id: number): void {
		if (id !== this.#nextHistoryId) return;
		this.#nextHistoryId++;
		this.#retired = true;
	}

	beginHistoryReplay(): void {
		this.#retired = false;
		this.resetCount++;
	}
}

class HeightReplayProvider implements TerminalFrameProvider {
	#nextHistoryId = 1;
	#retired = false;
	resetCount = 0;

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		return {
			history: this.#retired
				? undefined
				: {
						id: this.#nextHistoryId,
						rows: ["real-todo-block", "real-read-block", "real-bash-block"],
					},
			viewport: ["dot-live-one", "dot-live-two", "editor"].slice(-viewport.rows),
		};
	}

	renderResizeFrame(): readonly string[] {
		return ["resize frame"];
	}

	acknowledgeHistory(id: number): void {
		if (id !== this.#nextHistoryId) return;
		this.#nextHistoryId++;
		this.#retired = true;
	}

	beginHistoryReplay(): void {
		this.#retired = false;
		this.resetCount++;
	}
}

class FlushProvider implements TerminalFrameProvider {
	#nextId = 1;
	#pending = ["final one", "final two"];
	#flushing = false;
	readonly acknowledged: number[] = [];

	renderFrame(): TerminalFramePlan {
		const row = this.#flushing ? this.#pending[0] : undefined;
		return {
			history: row === undefined ? undefined : { id: this.#nextId, rows: [row] },
			viewport: this.#flushing ? ["live one", "live two", "editor"] : ["editor"],
		};
	}

	acknowledgeHistory(id: number): void {
		if (id !== this.#nextId || this.#pending.length === 0) return;
		this.acknowledged.push(id);
		this.#nextId++;
		this.#pending.shift();
	}

	beginHistoryFlush(): void {
		this.#flushing = true;
	}
}

function plainBuffer(terminal: VirtualTerminal): string[] {
	return terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
}
/** Models tmux's preserved clear: a full-screen ED0/ED2 scrolls the live
 *  screen into pane history before blanking, unlike xterm-family discard. */
class TmuxPreservedClearTerminal extends VirtualTerminal {
	override write(data: string): void {
		const fullScreenClear = /\x1b\[1;1H\x1b\[J|\x1b\[2J/g;
		let translated = "";
		let last = 0;
		for (let match = fullScreenClear.exec(data); match; match = fullScreenClear.exec(data)) {
			translated += data.slice(last, match.index);
			translated += `\x1b[${this.rows};1H${"\n".repeat(this.rows)}${match[0]}`;
			last = match.index + match[0].length;
		}
		translated += data.slice(last);
		super.write(translated);
	}
}

describe("terminal frame plans", () => {
	it("consumes a finalized prefix without re-appending the still-borrowed suffix", () => {
		const terminal = new CountingTerminal(20, 3);
		const provider = new Provider({ viewport: ["a", "b", "tool-1", "tool-2", "tool-3", "editor"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		const initial = plainBuffer(terminal);
		provider.plan = { history: { id: 1, rows: ["a", "b"] }, viewport: ["tool-1", "tool-2", "tool-3", "editor"] };
		tui.requestRender(true);
		expect(plainBuffer(terminal)).toEqual(initial);
		expect(provider.borrowed.at(-1)).toBe(1);
		provider.plan = { history: { id: 2, rows: ["tool-1"] }, viewport: ["tool-2", "tool-3", "editor"] };
		tui.requestRender(true);
		expect(plainBuffer(terminal)).toEqual(initial);
		expect(provider.acknowledged).toEqual([1, 2]);
		expect(provider.borrowed.at(-1)).toBe(0);
		tui.stop();
	});

	it("keeps the live suffix aligned after overflow shrinks without duplicating native rows", () => {
		const terminal = new CountingTerminal(20, 4);
		const initial = ["a", "b", "c", "d", "editor", "suggest-1", "suggest-2"];
		const provider = new Provider({ viewport: initial });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		const oldHistory = plainBuffer(terminal).slice(0, terminal.getBufferPosition().baseY);
		terminal.writes.length = 0;
		provider.plan = { viewport: ["a", "b", "c", "d", "editor"] };
		tui.requestRender(true);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["", "", "d", "editor"]);
		expect(plainBuffer(terminal).slice(0, terminal.getBufferPosition().baseY)).toEqual(oldHistory);
		provider.plan = { viewport: initial };
		tui.requestRender(true);
		expect(plainBuffer(terminal)).toEqual(initial);
		expect(terminal.writes.join("")).not.toMatch(/\x1b\[[23]J/);
		tui.stop();
	});

	it("keeps a full-screen live frame bottom-anchored when a tool shrinks and grows", () => {
		const terminal = new CountingTerminal(30, 5);
		const provider = new Provider({ viewport: ["tool-1", "tool-2", "tool-3", "tool-4", "editor"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		const position = terminal.getBufferPosition();
		try {
			for (const viewport of [
				["failed", "editor"],
				["failed", "next", "editor"],
			]) {
				provider.plan = { viewport };
				tui.requestRender(true);
				const visible = terminal.getViewport().map(row => row.trimEnd());
				expect(visible.slice(-viewport.length)).toEqual(viewport);
				expect(visible.slice(0, -viewport.length).every(row => row === "")).toBeTrue();
				expect(terminal.getBufferPosition()).toEqual(position);
			}
		} finally {
			tui.stop();
		}
	});

	it("preserves retired assistant rows when the next live frame grows", () => {
		const terminal = new VirtualTerminal(40, 6);
		const provider = new Provider({
			history: { id: 1, kind: "append", rows: ["MESSAGE_001", "MESSAGE_002", "MESSAGE_003"] },
			viewport: ["tool", "editor"],
		});
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		try {
			for (let count = 1; count <= 4; count++) {
				provider.plan = {
					viewport: ["tool", ...Array.from({ length: count }, (_, i) => `NEXT_${i + 1}`), "editor"],
				};
				tui.renderNow();
				expect(plainBuffer(terminal).filter(row => row.startsWith("MESSAGE_"))).toEqual([
					"MESSAGE_001",
					"MESSAGE_002",
					"MESSAGE_003",
				]);
			}
		} finally {
			tui.stop();
		}
	});

	it("does not commit reversible viewport growth during an expand-contract cycle", () => {
		const terminal = new CountingTerminal(20, 4);
		const base = ["a", "b", "c", "d", "editor"];
		const provider = new Provider({ viewport: base });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		const before = terminal.getBufferPosition();
		provider.plan = {
			viewport: [...base, "suggest-1", "suggest-2", "suggest-3", "suggest-4"],
			viewportExpansionRows: 4,
		};
		tui.requestRender(true);
		expect(terminal.getBufferPosition()).toEqual(before);
		provider.plan = { viewport: base };
		tui.requestRender(true);
		expect(terminal.getBufferPosition()).toEqual(before);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["b", "c", "d", "editor"]);
		expect(plainBuffer(terminal)).toEqual(base);
		tui.stop();
	});

	it("repaints unchanged mutable rows when contraction moves their physical anchor", () => {
		const terminal = new CountingTerminal(30, 8);
		const provider = new Provider({
			history: { id: 1, kind: "append", rows: ["history-a", "history-b", "history-c"] },
			viewport: ["status", "suggestion", "editor"],
			viewportExpansionRows: 1,
		});
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		provider.plan = { viewport: ["status", "suggestion", "editor"], viewportExpansionRows: 1 };
		tui.renderNow();
		provider.plan = { viewport: ["status", "editor"] };
		tui.renderNow();
		const visible = terminal.getViewport().map(row => row.trimEnd());
		expect(visible.filter(row => row === "status")).toHaveLength(1);
		expect(visible.filter(row => row === "editor")).toHaveLength(1);
		expect(visible).not.toContain("suggestion");
		tui.stop();
	});

	it("appends finalized history once and leaves the requested mutable viewport intact", () => {
		const terminal = new VirtualTerminal(20, 3);
		const provider = new Provider({
			history: { id: 1, rows: ["history one", "history two"] },
			viewport: ["editor", "status"],
		});
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		expect(provider.acknowledged).toEqual([1]);
		expect(terminal.getBufferPosition().baseY).toBe(1);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["history two", "editor", "status"]);
		tui.stop();
	});
	it("keeps live viewport rows out of tmux-style preserved-clear scrollback on a scrolling append", () => {
		// Viewport at row 0 fills the screen: the protective erase is emitted
		// full-screen, which tmux would archive as the #9780 duplication.
		const terminal = new TmuxPreservedClearTerminal(20, 4);
		const provider = new Provider({
			viewport: ["live-1", "live-2", "live-3", "editor"],
		});
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		expect(terminal.getBufferPosition().baseY).toBe(0);

		provider.plan = {
			history: { id: 1, rows: ["hist-1", "hist-2"] },
			viewport: ["live-2", "live-3", "live-4", "editor"],
		};
		tui.requestRender(true);

		expect(provider.acknowledged).toEqual([1]);
		const scrollback = plainBuffer(terminal).slice(0, terminal.getBufferPosition().baseY);
		expect(scrollback.some(row => row.includes("live-") || row.includes("editor"))).toBe(false);
		expect(scrollback.filter(Boolean)).toEqual(["hist-1", "hist-2"]);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["live-2", "live-3", "live-4", "editor"]);
		tui.stop();
	});
	it("bottom-splits a complete replay and serializes it in one terminal write", () => {
		const terminal = new CountingTerminal(20, 4);
		const provider = new Provider({ viewport: ["live", "editor"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		terminal.writes.length = 0;

		provider.plan = {
			history: {
				id: 1,
				rows: ["history one", "history two", "history three", "history four"],
				kind: "replay",
			},
			viewport: ["live", "editor"],
		};
		tui.requestRender(true);

		expect(terminal.writes).toHaveLength(1);
		expect(provider.acknowledged).toEqual([1]);
		expect(plainBuffer(terminal)).toEqual([
			"history one",
			"history two",
			"history three",
			"history four",
			"live",
			"editor",
		]);

		tui.requestRender(true);
		expect(plainBuffer(terminal)).toEqual([
			"history one",
			"history two",
			"history three",
			"history four",
			"live",
			"editor",
		]);
		tui.stop();
	});

	it("preserves an oversized logical viewport during complete replay", () => {
		const terminal = new VirtualTerminal(20, 4);
		const provider = new Provider({ viewport: ["old"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		provider.plan = {
			history: { id: 1, rows: ["history one", "history two"], kind: "replay" },
			viewport: ["live one", "live two", "live three", "live four", "live five", "editor"],
		};
		tui.requestRender(true);

		expect(provider.acknowledged).toEqual([1]);
		expect(plainBuffer(terminal).filter(Boolean)).toEqual([
			"history one",
			"history two",
			"live one",
			"live two",
			"live three",
			"live four",
			"live five",
			"editor",
		]);
		const replayed = plainBuffer(terminal);
		for (let redraw = 0; redraw < 3; redraw++) {
			tui.requestRender(true);
			expect(plainBuffer(terminal)).toEqual(replayed);
		}
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual([
			"live three",
			"live four",
			"live five",
			"editor",
		]);
		tui.stop();
	});

	it("drops obsolete borrowed ownership when tools disappear without a history batch", () => {
		const terminal = new CountingTerminal(30, 4);
		const chrome = ["HUD one", "HUD two", "editor", "status"];
		const provider = new Provider({
			viewport: ["tool one", "tool two", "tool three", ...chrome],
			borrowableRows: 3,
			borrowedViewportRows: 0,
		});
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		expect(provider.borrowed.at(-1)).toBe(3);
		provider.plan = { viewport: chrome, borrowableRows: 0, borrowedViewportRows: 0 };
		tui.requestRender(true);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(chrome);
		expect(provider.borrowed.at(-1)).toBe(0);
		tui.stop();
	});

	it("does not borrow mutable anchored chrome when it exceeds terminal height", () => {
		const terminal = new CountingTerminal(30, 2);
		const provider = new Provider({
			viewport: ["transcript-a", "transcript-b", "old HUD", "visible HUD", "editor"],
			borrowableRows: 2,
		});
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		expect(plainBuffer(terminal)).not.toContain("old HUD");
		provider.plan = { viewport: ["transcript-a", "transcript-b", "new HUD", "editor"], borrowableRows: 2 };
		tui.requestRender(true);
		expect(plainBuffer(terminal)).toEqual(["transcript-a", "transcript-b", "new HUD", "editor"]);
		expect(provider.borrowed.at(-1)).toBe(2);
		tui.stop();
	});

	it("does not hide a new live row whose bytes match a finalized borrowed owner", () => {
		const terminal = new CountingTerminal(20, 3);
		const provider = new Provider({ viewport: ["old", "same", "same", "live", "editor"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		provider.plan = {
			history: { id: 1, rows: ["new", "same"] },
			viewport: ["same", "live", "editor"],
			borrowedViewportRows: 0,
		};
		tui.requestRender(true);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["same", "live", "editor"]);
		expect(provider.borrowed.at(-1)).toBe(0);
		tui.stop();
	});

	it("consumes a finalized prefix without re-appending the still-borrowed suffix", () => {
		const terminal = new CountingTerminal(20, 3);
		const provider = new Provider({
			viewport: ["a", "b", "tool-1", "tool-2", "tool-3", "editor"],
		});
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		const initial = plainBuffer(terminal);
		provider.plan = {
			history: { id: 1, rows: ["a", "b"] },
			viewport: ["tool-1", "tool-2", "tool-3", "editor"],
		};
		tui.requestRender(true);
		expect(plainBuffer(terminal)).toEqual(initial);
		expect(provider.borrowed).toContain(1);
		provider.plan = {
			history: { id: 2, rows: ["tool-1"] },
			viewport: ["tool-2", "tool-3", "editor"],
		};
		tui.requestRender(true);
		expect(plainBuffer(terminal)).toEqual(initial);
		expect(provider.acknowledged).toEqual([1, 2]);
		expect(provider.borrowed.at(-1)).toBe(0);
		tui.stop();
	});

	it("keeps the live suffix aligned after overflow shrinks without duplicating native rows", () => {
		const terminal = new CountingTerminal(20, 4);
		const initial = ["a", "b", "c", "d", "editor", "suggest-1", "suggest-2"];
		const provider = new Provider({ viewport: initial });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		const oldHistory = plainBuffer(terminal).slice(0, terminal.getBufferPosition().baseY);
		terminal.writes.length = 0;
		provider.plan = { viewport: ["a", "b", "c", "d", "editor"] };
		tui.requestRender(true);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["", "", "d", "editor"]);
		expect(plainBuffer(terminal).slice(0, terminal.getBufferPosition().baseY)).toEqual(oldHistory);
		provider.plan = { viewport: initial };
		tui.requestRender(true);
		expect(plainBuffer(terminal)).toEqual(initial);
		expect(terminal.writes.join("")).not.toMatch(/\x1b\[[23]J/);
		tui.stop();
	});

	it("bottom-splits a logical frame taller than the terminal", () => {
		const terminal = new VirtualTerminal(20, 4);
		const provider = new Provider({
			viewport: ["one", "two", "three", "four", "five", "editor"],
		});
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		expect(plainBuffer(terminal)).toEqual(["one", "two", "three", "four", "five", "editor"]);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["three", "four", "five", "editor"]);
		tui.stop();
	});

	it("replays a semantic prepend through the provider replay contract", () => {
		const terminal = new VirtualTerminal(20, 3);
		const viewport = ["a", "b", "live", "editor", "extra"];
		let plan: TerminalFramePlan = { viewport };
		const acknowledged: number[] = [];
		const provider: TerminalFrameProvider = {
			renderFrame: () => plan,
			acknowledgeHistory: id => {
				acknowledged.push(id);
				plan = { viewport: plan.viewport };
			},
		};
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		plan = {
			history: { id: 1, rows: ["new", ...viewport], kind: "replay" },
			viewport,
		};
		tui.requestRender(true);

		expect(acknowledged).toEqual([1]);
		expect(plainBuffer(terminal)).toContain("new");
		const replayed = plainBuffer(terminal);
		tui.requestRender(true);
		expect(plainBuffer(terminal)).toEqual(replayed);
		tui.stop();
	});

	it("does not treat a repeated later heading as a semantic prepend", () => {
		const terminal = new CountingTerminal(20, 3);
		const provider = new Provider({
			viewport: ["heading", "old", "heading", "live", "editor"],
		});
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		terminal.writes.length = 0;
		provider.plan = {
			viewport: ["changed", "heading", "old", "heading", "live", "editor"],
		};
		tui.requestRender(true);
		expect(terminal.writes.join("")).not.toMatch(/\x1b\[[23]J/);
		expect(plainBuffer(terminal).filter(row => row === "heading")).toHaveLength(2);
		tui.stop();
	});

	it("accepts re-offered borrowed rows without a destructive replay", () => {
		const terminal = new VirtualTerminal(20, 4);
		let replays = 0;
		const provider = new Provider({
			viewport: ["a", "b", "live", "editor", "extra"],
		});
		const replayingProvider: TerminalFrameProvider = {
			renderFrame: size => provider.renderFrame(size),
			acknowledgeHistory: id => provider.acknowledgeHistory(id),
			beginHistoryReplay: () => {
				replays++;
			},
		};
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(replayingProvider);
		expect(terminal.getBufferPosition().baseY).toBe(1);

		provider.plan = {
			history: { id: 1, rows: ["a", "b"] },
			viewport: ["live", "editor", "extra"],
		};
		tui.requestRender(true);

		expect(replays).toBe(0);
		expect(provider.acknowledged).toEqual([1]);
		expect(plainBuffer(terminal).filter(row => row === "a")).toHaveLength(1);
		expect(plainBuffer(terminal).filter(row => row === "b")).toHaveLength(1);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["b", "live", "editor", "extra"]);
		tui.stop();
	});

	it("finalizes drifted borrowed rows without clearing preexisting scrollback", () => {
		const terminal = new CountingTerminal(20, 4);
		const provider = new Provider({
			viewport: ["mutable old", "live one", "live two", "live three", "editor"],
		});
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		terminal.write("shell one\r\nshell two\r\nshell three\r\nshell four\r\n");
		terminal.writes.length = 0;

		provider.plan = {
			history: { id: 1, rows: ["mutable final"] },
			viewport: ["live one", "live two", "live three", "editor"],
		};
		tui.requestRender(true);

		expect(provider.acknowledged).toEqual([1]);
		expect(terminal.writes.join("")).not.toMatch(/\x1b\[[23]J/);
		const buffer = plainBuffer(terminal);
		for (const row of ["mutable old", "shell one", "mutable final"]) {
			expect(buffer.filter(line => line === row)).toHaveLength(1);
		}
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual([
			"live one",
			"live two",
			"live three",
			"editor",
		]);
		tui.stop();
	});

	it("retains borrowed live suffix when finalized block drifts", () => {
		const terminal = new CountingTerminal(20, 4);
		const provider = new Provider({
			viewport: ["final old", "live one", "live two", "live three", "editor"],
		});
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		provider.plan = {
			history: { id: 1, rows: ["final new"] },
			viewport: ["live one", "live two", "live three", "editor"],
		};
		tui.requestRender(true);
		provider.plan = {
			viewport: ["live one", "live two", "live three", "editor"],
		};
		tui.requestRender(true);
		expect(provider.borrowed).toContain(1);
		expect(plainBuffer(terminal).filter(row => row === "live one")).toHaveLength(1);
		expect(plainBuffer(terminal).filter(row => row === "live two")).toHaveLength(1);
		tui.stop();
	});

	it("preserves shortened views and replays actual prepends in order", () => {
		const terminal = new CountingTerminal(30, 3);
		const provider = new Provider({
			viewport: ["header", "editor", "s1", "s2", "s3", "s4"],
		});
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		terminal.writes.length = 0;
		try {
			provider.plan = { viewport: ["header", "editor"] };
			tui.requestRender(true);
			expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["", "header", "editor"]);
			expect(terminal.writes.join("")).not.toMatch(/\x1b\[[23]J/);
			provider.plan = {
				history: { id: 1, rows: ["new"], kind: "replay" },
				viewport: ["header", "editor", "s1", "s2", "s3", "s4"],
			};
			tui.requestRender(true);
			expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["s2", "s3", "s4"]);
			expect(plainBuffer(terminal)).toContain("new");
			const snapshot = plainBuffer(terminal);
			tui.requestRender(true);
			expect(plainBuffer(terminal)).toEqual(snapshot);
		} finally {
			tui.stop();
		}
	});
	it("trims borrowed ownership when a viewport shrinks to a strict prefix", () => {
		const terminal = new CountingTerminal(30, 3);
		const provider = new Provider({ viewport: ["a", "b", "c", "d", "e", "f"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		try {
			provider.plan = { viewport: ["a"] };
			tui.requestRender(true);
			expect(provider.borrowed.at(-1)).toBe(1);
			provider.plan = { viewport: ["a", "x", "y", "z"] };
			tui.requestRender(true);
			const viewport = terminal.getViewport().map(row => row.trimEnd());
			expect(viewport).toContain("x");
			expect(viewport).toContain("y");
			expect(plainBuffer(terminal).filter(row => row === "a")).toHaveLength(1);
		} finally {
			tui.stop();
		}
	});
	it("releases a shortened replacement from the previous frame watermark before it grows", () => {
		const terminal = new CountingTerminal(30, 3);
		const oldRows = ["old-1", "old-2", "old-3", "old-4", "old-5", "old-6"];
		const provider = new Provider({ viewport: oldRows });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		try {
			const oldHistory = plainBuffer(terminal).slice(0, terminal.getBufferPosition().baseY);

			provider.plan = { viewport: ["new-1"] };
			tui.requestRender(true);
			provider.plan = { viewport: ["new-1", "new-2", "new-3", "new-4"] };
			tui.requestRender(true);

			const buffer = plainBuffer(terminal);
			expect(buffer.slice(0, oldHistory.length)).toEqual(oldHistory);
			for (const row of ["new-1", "new-2", "new-3", "new-4"]) {
				expect(buffer.filter(line => line === row)).toHaveLength(1);
			}
			expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["new-2", "new-3", "new-4"]);
			const snapshot = buffer;
			tui.requestRender(true);
			expect(plainBuffer(terminal)).toEqual(snapshot);
			expect(terminal.writes.join("")).not.toMatch(/\x1b\[[23]J/);
		} finally {
			tui.stop();
		}
	});

	it("freezes a changing single-row prefix while the live body grows", () => {
		const terminal = new VirtualTerminal(40, 4);
		const provider = new Provider({
			viewport: ["spinner-0", "1. numbered row", "2. numbered row", "3. numbered row", "4. numbered row", "editor"],
		});
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		try {
			for (let step = 1; step <= 12; step++) {
				provider.plan = {
					viewport: [
						`spinner-${step}`,
						...Array.from({ length: step + 2 }, (_value, index) => `${index + 1}. numbered row`),
						"editor",
					],
				};
				tui.requestRender(true);
			}
			const buffer = plainBuffer(terminal);
			expect(buffer.filter(row => row === "spinner-0")).toHaveLength(1);
			for (let index = 1; index <= 14; index++) {
				expect(buffer.filter(row => row === `${index}. numbered row`)).toHaveLength(1);
			}
			for (let step = 1; step <= 12; step++) {
				expect(buffer.filter(row => row === `spinner-${step}`)).toHaveLength(0);
			}
		} finally {
			tui.stop();
		}
	});
	it("does not repaint scrolled rows when suggestions repeatedly open and close", () => {
		const terminal = new VirtualTerminal(30, 5);
		const header = ["HEADER-A", "HEADER-B", "HEADER-C", "HEADER-D"];
		const provider = new Provider({ viewport: [...header, "editor"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		try {
			for (let cycle = 0; cycle < 3; cycle++) {
				provider.plan = {
					viewport: [...header, "editor", "choice-1", "choice-2"],
				};
				tui.requestRender(true);
				provider.plan = { viewport: [...header, "editor"] };
				tui.requestRender(true);
				const buffer = plainBuffer(terminal);
				for (const row of header) expect(buffer.filter(line => line === row)).toHaveLength(1);
				expect(buffer.filter(line => line === "editor")).toHaveLength(1);
			}
		} finally {
			tui.stop();
		}
	});

	it("keeps replacement overflow owned across idle repaint and shrinking HUD", () => {
		const terminal = new VirtualTerminal(30, 5);
		const provider = new Provider({ viewport: ["old session"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		const transcript = ["row-a", "row-b", "row-c", "row-d", "resumed"];
		try {
			provider.plan = { viewport: [...transcript, "TODO", "done", "editor"] };
			tui.requestRender(true, { clearScrollback: true });
			tui.requestRender(true);
			for (const row of transcript) expect(plainBuffer(terminal).filter(line => line === row)).toHaveLength(1);
			provider.plan = { viewport: [...transcript, "editor"] };
			tui.requestRender(true);
			for (const row of transcript) expect(plainBuffer(terminal).filter(line => line === row)).toHaveLength(1);
			expect(plainBuffer(terminal)).not.toContain("old session");
			expect(plainBuffer(terminal)).not.toContain("TODO");
		} finally {
			tui.stop();
		}
	});

	it("fuses fullscreen overlay exit into a session replacement paint", () => {
		const terminal = new CountingTerminal(171, 39);
		const provider = new Provider({ viewport: ["old session"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		const overlay = tui.showOverlay(
			{
				render: () => ["session selector"],
			},
			{
				width: "100%",
				maxHeight: "100%",
				fullscreen: true,
			},
		);
		terminal.writes.length = 0;

		provider.plan = { viewport: ["resumed transcript", "resumed prompt"] };
		tui.requestRender(true, { clearScrollback: true });
		overlay.hide();

		const exitPaints = terminal.writes.filter(write => write.includes("\x1b[?1049l"));
		expect(exitPaints).toHaveLength(1);
		expect(exitPaints[0]).toContain("\x1b[3J");
		expect(exitPaints[0]).toContain("resumed transcript");
		tui.stop();
	});

	it("repaints a viewport-only frame in place without scrolling", () => {
		const terminal = new VirtualTerminal(20, 4);
		const provider = new Provider({ viewport: ["spinner one", "editor"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		provider.plan = { viewport: ["spinner two", "editor"] };
		tui.requestRender(true);
		expect(terminal.getBufferPosition().baseY).toBe(0);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["spinner two", "editor", "", ""]);
		tui.stop();
	});

	it("flushes every eligible history batch before terminal handoff", () => {
		const terminal = new VirtualTerminal(20, 2);
		const provider = new FlushProvider();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		tui.stop();

		expect(provider.acknowledged).toEqual([1, 2]);
		expect(plainBuffer(terminal).filter(Boolean)).toEqual([
			"final one",
			"final two",
			"live one",
			"live two",
			"editor",
		]);
		// Handoff leaves the shell cursor below the editor, scrolling once.
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["editor", ""]);
	});

	it("keeps visible history above the anchored viewport while room remains", () => {
		const terminal = new VirtualTerminal(20, 6);
		const provider = new Provider({
			history: { id: 1, rows: ["block one"] },
			viewport: ["editor"],
		});
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		provider.plan = {
			history: { id: 2, rows: ["block two"] },
			viewport: ["editor"],
		};
		tui.requestRender(true);
		expect(terminal.getBufferPosition().baseY).toBe(0);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual([
			"block one",
			"block two",
			"editor",
			"",
			"",
			"",
		]);
		tui.stop();
	});

	it("uses the alternate buffer during resize and restores anchored history", () => {
		const terminal = new VirtualTerminal(20, 4);
		const provider = new Provider({
			history: { id: 1, rows: ["welcome"] },
			viewport: ["editor"],
		});
		provider.resizeRows = ["welcome", "editor"];
		const renderScheduler = new ResizeScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setFrameProvider(provider);
		tui.start();

		terminal.resize(24, 5);
		expect(
			terminal
				.getViewport()
				.map(row => row.trimEnd())
				.slice(0, 2),
		).toEqual(["welcome", "editor"]);

		renderScheduler.settle();
		terminal.sendInput("\x1b[2;17R");
		renderScheduler.settle();
		expect(
			terminal
				.getViewport()
				.map(row => row.trimEnd())
				.slice(0, 2),
		).toEqual(["welcome", "editor"]);
		tui.stop();
	});
	it("keeps live viewport rows out of scrollback during a height shrink", () => {
		// Committed history above a pressured live tail (compact placeholder
		// rows). The terminal can push a placeholder before the resize callback runs,
		// so rebuild the semantic history after every geometry change: only real
		// finalized blocks become permanent scrollback bytes.
		const terminal = new VirtualTerminal(20, 6);
		const provider = new HeightReplayProvider();
		const renderScheduler = new ResizeScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setFrameProvider(provider);
		tui.setResizeScrollback("rebuild");
		tui.start();
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual([
			"real-todo-block",
			"real-read-block",
			"real-bash-block",
			"dot-live-one",
			"dot-live-two",
			"editor",
		]);

		terminal.resize(20, 2); // a single large shrink can push live rows before the callback runs
		renderScheduler.settle(); // restore the normal buffer, start the anchor probe
		renderScheduler.settle(); // probe timeout → one bounded retry under a multiplexer
		renderScheduler.settle(); // final timeout → settled repaint (no-op settle on direct)

		const scrollback = plainBuffer(terminal).slice(0, terminal.getBufferPosition().baseY);
		expect(scrollback.some(row => row.includes("dot-live"))).toBe(false);
		expect(scrollback).toEqual(["real-todo-block", "real-read-block", "real-bash-block"]);
		expect(provider.resetCount).toBe(1);
		tui.stop();
	});

	it("recomputes borrowed row ownership when preserve-mode width changes", async () => {
		const terminal = new VirtualTerminal(10, 3);
		const renderScheduler = new VirtualRenderScheduler();
		const text = new Text("abcdefghijklmnopqrstu", 0, 0);
		const provider: TerminalFrameProvider = {
			renderFrame: ({ columns }) => ({
				viewport: ["pre0", "pre1", ...text.render(columns), "tail"],
			}),
			acknowledgeHistory() {},
		};
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setResizeScrollback("preserve");
		tui.setFrameProvider(provider);
		tui.start();
		try {
			await renderScheduler.settle(terminal);
			terminal.resize(20, 3);
			await renderScheduler.settle(terminal);
			expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["abcdefghijklmnopqrst", "u", "tail"]);
			const afterResize = plainBuffer(terminal);
			tui.requestRender();
			await renderScheduler.settle(terminal);
			expect(plainBuffer(terminal)).toEqual(afterResize);
		} finally {
			tui.stop();
		}
	});

	it("appends a current-width replay after settled resize", async () => {
		const terminal = new VirtualTerminal(20, 2);
		const provider = new WidthReplayProvider();
		const renderScheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setResizeScrollback("append");
		tui.setFrameProvider(provider);
		tui.start();
		await renderScheduler.settle(terminal);

		expect(plainBuffer(terminal)).toContain("history-one@20");

		terminal.resize(30, 2);
		await renderScheduler.advance(terminal, 160);

		const resized = plainBuffer(terminal);
		expect(provider.resetCount).toBe(1);
		expect(resized).toContain("history-one@20");
		expect(resized).toContain("history-one@30");
		expect(resized.slice(-2)).toEqual(["history-two@30", "editor@30"]);
		tui.stop();
	});

	it("does not duplicate current-width history on a height-only grow", async () => {
		const terminal = new VirtualTerminal(20, 2);
		const provider = new WidthReplayProvider();
		const renderScheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setResizeScrollback("append");
		tui.setFrameProvider(provider);
		tui.start();
		await renderScheduler.settle(terminal);

		expect(plainBuffer(terminal)).toContain("history-one@20");

		terminal.resize(20, 6); // height-only grow: width unchanged, nothing rewraps
		await renderScheduler.advance(terminal, 160);

		const resized = plainBuffer(terminal);
		expect(provider.resetCount).toBe(0);
		expect(resized.filter(row => row === "history-one@20")).toEqual(["history-one@20"]);
		tui.stop();
	});

	it("re-anchors retained history after a height grow behind a fullscreen overlay", async () => {
		const history = Array.from({ length: 20 }, (_value, index) => `history-${index}`);
		const terminal = new CountingTerminal(20, 4);
		const provider = new WidthReplayProvider(history);
		const renderScheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setResizeScrollback("append");
		tui.setFrameProvider(provider);
		tui.start();
		await renderScheduler.settle(terminal);

		const overlay = tui.showOverlay(new FullscreenOverlay(), {
			fullscreen: true,
		});
		await renderScheduler.settle(terminal);
		terminal.resize(20, 12);
		await renderScheduler.settle(terminal);
		terminal.writes.length = 0;
		overlay.hide();
		await renderScheduler.settle(terminal);

		expect(terminal.writes.join("")).toContain("\x1b[6n");

		expect(provider.resetCount).toBe(0);
		expect(plainBuffer(terminal).filter(Boolean)).toEqual([...history.map(row => `${row}@20`), "editor@20"]);
		tui.stop();
	});

	it("rebuilds current-width history without retaining stale rows", async () => {
		const terminal = new VirtualTerminal(20, 2);
		const provider = new WidthReplayProvider();
		const renderScheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setResizeScrollback("rebuild");
		tui.setFrameProvider(provider);
		tui.start();
		await renderScheduler.settle(terminal);

		terminal.resize(30, 2);
		await renderScheduler.advance(terminal, 160);

		const resized = plainBuffer(terminal);
		expect(provider.resetCount).toBe(1);
		expect(resized.some(row => row.includes("@20"))).toBe(false);
		expect(resized).toEqual(["history-one@30", "history-two@30", "editor@30"]);
		tui.stop();
	});
});
