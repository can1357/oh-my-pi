import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type Component,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
import type { RenderTimer } from "@oh-my-pi/pi-tui/tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

// Warp re-reports size when the alternate buffer toggles. The resize path
// borrows that buffer, waits 120 ms, restores it, then starts a CPR probe.
// The restore write (`CSI ?1049l`) arrives as a SIGWINCH while the probe is
// in flight, so restarting the borrow there loops:
// 1049l → SIGWINCH → 1049h → settle → 1049l → …
//
// The skip is Warp-only: every other terminal keeps the alt-borrow path.
//
// Observable contract: one real resize on Warp must not keep toggling the
// alternate buffer after the settle window.

const ALT_ENTER = "\x1b[?1049h";
const ALT_EXIT = "\x1b[?1049l";

const TERMINAL_ENV = ["TERM_PROGRAM", "PI_TUI_RESIZE_IN_PLACE"] as const;

class LineComponent implements Component {
	constructor(
		private readonly prefix: string,
		private readonly count: number,
	) {}
	invalidate(): void {}
	render(width: number): string[] {
		return Array.from({ length: this.count }, (_v, i) => `${this.prefix}${i}`.slice(0, width));
	}
}

/**
 * Models Warp's alt-toggle size echo: each 1049h/l write is followed by a
 * height-only ±1 SIGWINCH, delivered asynchronously like a PTY read.
 */
class AltToggleEchoTerminal extends VirtualTerminal {
	altEnters = 0;

	override write(data: string): void {
		const enters = countNeedle(data, ALT_ENTER);
		this.altEnters += enters;
		const exits = countNeedle(data, ALT_EXIT);
		super.write(data);
		if (enters + exits === 0) return;
		const delta = enters > 0 ? -1 : 1;
		queueMicrotask(() => {
			this.resize(this.columns, Math.max(1, this.rows + delta));
		});
	}
}

function countNeedle(haystack: string, needle: string): number {
	let count = 0;
	let from = 0;
	while (from < haystack.length) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) return count;
		count++;
		from = at + needle.length;
	}
	return count;
}

withoutTerminalMultiplexer();

describe("resize on Warp, which SIGWINCHes on alt-buffer toggle", () => {
	let saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		saved = {};
		for (const key of TERMINAL_ENV) {
			saved[key] = Bun.env[key];
			delete Bun.env[key];
		}
	});

	afterEach(() => {
		for (const key of TERMINAL_ENV) {
			if (saved[key] === undefined) delete Bun.env[key];
			else Bun.env[key] = saved[key];
		}
		saved = {};
	});

	it("does not borrow the alt buffer for a Warp pane resize", async () => {
		Bun.env.TERM_PROGRAM = "WarpTerminal";
		const term = new AltToggleEchoTerminal(40, 12);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new LineComponent("row-", 8));
		try {
			tui.start();
			await scheduler.settle(term);
			term.altEnters = 0;

			term.resize(40, 20);
			// Quiet window (120) + CPR timeout (200) + another borrow cycle if
			// the echo restarted alt-paint. A loop grows altEnters past 1.
			await scheduler.advance(term, 500);

			expect(term.altEnters).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("borrows the alt buffer once when Warp in-place is forced off", async () => {
		Bun.env.TERM_PROGRAM = "WarpTerminal";
		Bun.env.PI_TUI_RESIZE_IN_PLACE = "0";
		const term = new AltToggleEchoTerminal(40, 12);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new LineComponent("row-", 8));
		try {
			tui.start();
			await scheduler.settle(term);
			term.altEnters = 0;

			term.resize(40, 20);
			await scheduler.advance(term, 500);

			// Forced borrow still happens, but the ±1 echo during the probe
			// must not restart it into a loop.
			expect(term.altEnters).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("borrows the alt buffer on non-Warp terminals", async () => {
		const term = new AltToggleEchoTerminal(40, 12);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new LineComponent("row-", 8));
		try {
			tui.start();
			await scheduler.settle(term);
			term.altEnters = 0;

			term.resize(40, 20);
			await scheduler.advance(term, 500);

			expect(term.altEnters).toBeGreaterThanOrEqual(1);
		} finally {
			tui.stop();
		}
	});

	it("paints after a restart during the in-place settle window", async () => {
		Bun.env.TERM_PROGRAM = "WarpTerminal";
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const originalWrite = term.write.bind(term);
		term.write = (data: string) => {
			writes.push(data);
			originalWrite(data);
		};
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new LineComponent("row-", 8));
		try {
			tui.start();
			await scheduler.settle(term);

			// Stop mid-settle: the pending transaction must not wedge the next
			// session's paints.
			term.resize(40, 20);
			tui.stop();
			writes.length = 0;

			tui.start();
			await scheduler.settle(term);
			expect(writes.join("")).toContain("row-0");
		} finally {
			tui.stop();
		}
	});
	it("repaints the modal instead of probing on an overlay toggle echo", async () => {
		Bun.env.TERM_PROGRAM = "WarpTerminal";
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const originalWrite = term.write.bind(term);
		term.write = (data: string) => {
			writes.push(data);
			originalWrite(data);
		};
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new LineComponent("row-", 8));
		try {
			tui.start();
			await scheduler.settle(term);
			tui.showOverlay({ render: () => ["modal"] }, { width: "100%", maxHeight: "100%", fullscreen: true });
			await scheduler.settle(term);
			expect(writes.join("")).toContain(ALT_ENTER);
			writes.length = 0;

			// Zero-delta SIGWINCH from the overlay's own alt-buffer toggle: the
			// modal repaints, but no normal-buffer anchor probe may start.
			term.resize(40, 12);
			await scheduler.settle(term);
			expect(writes.join("")).not.toContain("\x1b[6n");
		} finally {
			tui.stop();
		}
	});
	it("parks the cursor before the shell handoff when stopping mid-resize", async () => {
		Bun.env.TERM_PROGRAM = "WarpTerminal";
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const originalWrite = term.write.bind(term);
		term.write = (data: string) => {
			writes.push(data);
			originalWrite(data);
		};
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new LineComponent("row-", 8));
		try {
			tui.start();
			await scheduler.settle(term);
			writes.length = 0;

			// Quit inside the settle window: the drag left the hardware cursor
			// behind while tracking still describes the pre-resize row, so stop
			// must park absolutely before handing off to the shell.
			term.resize(40, 20);
			tui.stop();
			expect(writes.join("")).toContain("\x1b[20;1H");
		} finally {
			tui.stop();
		}
	});
});

describe("Warp in-place resize with a frame provider in rebuild mode", () => {
	let saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		saved = {};
		for (const key of TERMINAL_ENV) {
			saved[key] = Bun.env[key];
			delete Bun.env[key];
		}
	});

	afterEach(() => {
		for (const key of TERMINAL_ENV) {
			if (saved[key] === undefined) delete Bun.env[key];
			else Bun.env[key] = saved[key];
		}
		saved = {};
	});

	it("coalesces a drag into one ED3-free repaint with no alt borrow", async () => {
		Bun.env.TERM_PROGRAM = "WarpTerminal";
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const originalWrite = term.write.bind(term);
		term.write = (data: string) => {
			writes.push(data);
			originalWrite(data);
		};
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const provider = new RebuildProvider();
		tui.setResizeScrollback("rebuild");
		tui.setFrameProvider(provider);
		try {
			tui.start();
			await scheduler.settle(term);
			writes.length = 0;

			// Two drag frames before the quiet window: one settled repaint.
			term.resize(40, 20);
			term.resize(44, 20);
			await scheduler.advance(term, 150);

			const joined = writes.join("");
			expect(joined).not.toContain(ALT_ENTER);
			expect(countNeedle(joined, "\x1b[6n")).toBe(1);

			// Answer the anchor probe, then drain past every deferred window.
			const tag = joined.match(/\x1b\[(\d+)G\x1b\[6n/);
			expect(tag).not.toBeNull();
			term.sendInput(`\x1b[18;${tag![1]}R`);
			await scheduler.settle(term);
			await scheduler.advance(term, 300);

			const all = writes.join("");
			expect(all).not.toContain(ALT_ENTER);
			expect(all).not.toContain("\x1b[3J");
			expect(provider.replayCalls).toBe(0);
			expect(provider.lastViewport?.columns).toBe(44);
			expect(provider.lastViewport?.rows).toBe(20);
		} finally {
			tui.stop();
		}
	});

	it("drops ordinary paints while the in-place resize settles", async () => {
		Bun.env.TERM_PROGRAM = "WarpTerminal";
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const originalWrite = term.write.bind(term);
		term.write = (data: string) => {
			writes.push(data);
			originalWrite(data);
		};
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const provider = new RebuildProvider();
		tui.setResizeScrollback("rebuild");
		tui.setFrameProvider(provider);
		try {
			tui.start();
			await scheduler.settle(term);
			writes.length = 0;

			// A streaming tick racing the drag must not paint on the stale anchor.
			// The pre-erase may write escapes, but no viewport rows may paint.
			term.resize(40, 20);
			tui.renderNow();
			tui.requestRender();
			await scheduler.settle(term);
			expect(writes.join("")).not.toContain("live-");

			// The settled probe still resolves and repaints exactly once.
			await scheduler.advance(term, 150);
			const joined = writes.join("");
			const tag = joined.match(/\x1b\[(\d+)G\x1b\[6n/);
			expect(tag).not.toBeNull();
			term.sendInput(`\x1b[18;${tag![1]}R`);
			await scheduler.settle(term);
			expect(provider.lastViewport?.columns).toBe(40);
			expect(provider.lastViewport?.rows).toBe(20);
			expect(writes.join("")).not.toContain("\x1b[3J");
		} finally {
			tui.stop();
		}
	});
	it("settles a shrink drag in place with history and viewport intact", async () => {
		Bun.env.TERM_PROGRAM = "WarpTerminal";
		const term = new VirtualTerminal(40, 12);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const provider = new RebuildProvider();
		tui.setResizeScrollback("rebuild");
		tui.setFrameProvider(provider);
		try {
			tui.start();
			await scheduler.settle(term);

			// The in-place pre-erase blanks the live region up front. It must
			// never touch committed rows, and the settled repaint must restore
			// the live rows exactly once.
			term.resize(40, 8);
			await scheduler.advance(term, 150);
			const joined = term.getScrollBuffer().join("\n");
			const liveRows = joined.match(/^live-\d$/gm) ?? [];
			expect(liveRows).toHaveLength(8);
			for (const row of ["committed-0", "committed-1", "committed-2"]) {
				expect(countNeedle(joined, row)).toBe(1);
			}
		} finally {
			tui.stop();
		}
	});
});

describe("Warp echo expectation is single-shot", () => {
	let saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		saved = {};
		for (const key of TERMINAL_ENV) {
			saved[key] = Bun.env[key];
			delete Bun.env[key];
		}
	});

	afterEach(() => {
		for (const key of TERMINAL_ENV) {
			if (saved[key] === undefined) delete Bun.env[key];
			else Bun.env[key] = saved[key];
		}
		saved = {};
	});

	it("consumes the echo expectation so a later one-row resize restarts", () => {
		Bun.env.TERM_PROGRAM = "WarpTerminal";
		Bun.env.PI_TUI_RESIZE_IN_PLACE = "0";
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const originalWrite = term.write.bind(term);
		term.write = (data: string) => {
			writes.push(data);
			originalWrite(data);
		};
		const scheduler = new SyncScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new LineComponent("row-", 8));
		try {
			tui.start();
			scheduler.settle();
			scheduler.t += 200;
			writes.length = 0;

			// Forced borrow: settle exits alt and starts the anchor probe. Never
			// awaiting keeps the engine's own CPR reply queued, so each step below
			// observes exactly the SIGWINCH it simulates.
			term.resize(40, 20);
			scheduler.settle();
			expect(countNeedle(writes.join(""), "\x1b[6n")).toBe(1);

			// The +1 alt-toggle echo retires the probe and reissues it at the new
			// geometry: a second DSR, but no alt re-borrow.
			term.resize(40, 21);
			expect(countNeedle(writes.join(""), "\x1b[6n")).toBe(2);
			expect(countNeedle(writes.join(""), ALT_ENTER)).toBe(1);

			// A real one-row resize back to the baseline restarts the transaction.
			term.resize(40, 20);
			scheduler.settle();
			const all = writes.join("");
			expect(countNeedle(all, "\x1b[6n")).toBe(3);
			expect(countNeedle(all, ALT_ENTER)).toBe(2);
		} finally {
			tui.stop();
		}
	});
	it("re-probes a delayed echo that arrives after its probe resolved", () => {
		Bun.env.TERM_PROGRAM = "WarpTerminal";
		Bun.env.PI_TUI_RESIZE_IN_PLACE = "0";
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const originalWrite = term.write.bind(term);
		term.write = (data: string) => {
			writes.push(data);
			originalWrite(data);
		};
		const scheduler = new SyncScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new LineComponent("row-", 8));
		try {
			tui.start();
			scheduler.settle();
			scheduler.t += 200;
			writes.length = 0;

			term.resize(40, 20);
			scheduler.settle();
			const tag = writes.join("").match(/\x1b\[(\d+)G\x1b\[6n/);
			expect(tag).not.toBeNull();

			// The CPR wins the race against the echo: the probe resolves first.
			term.sendInput(`\x1b[19;${tag![1]}R`);
			scheduler.settle();

			// The delayed echo re-probes at the echoed size instead of borrowing
			// or painting on the resolved anchor.
			term.resize(40, 21);
			const all = writes.join("");
			expect(countNeedle(all, "\x1b[6n")).toBe(2);
			expect(countNeedle(all, ALT_ENTER)).toBe(1);
		} finally {
			tui.stop();
		}
	});
	it("never probes while the resize borrow owns the alt buffer", () => {
		Bun.env.TERM_PROGRAM = "WarpTerminal";
		Bun.env.PI_TUI_RESIZE_IN_PLACE = "0";
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const originalWrite = term.write.bind(term);
		term.write = (data: string) => {
			writes.push(data);
			originalWrite(data);
		};
		const scheduler = new SyncScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new LineComponent("row-", 8));
		try {
			tui.start();
			scheduler.settle();
			scheduler.t += 200;
			writes.length = 0;

			// Borrow owns the alt buffer; its enter echo must not start a
			// normal-screen anchor probe against the alternate grid.
			term.resize(40, 20);
			term.resize(40, 19);
			expect(writes.join("")).not.toContain("\x1b[6n");

			// The settle exit starts the only probe of this transaction.
			scheduler.settle();
			const all = writes.join("");
			expect(countNeedle(all, "\x1b[6n")).toBe(1);
			expect(countNeedle(all, ALT_ENTER)).toBe(1);
		} finally {
			tui.stop();
		}
	});
	it("keeps the borrow path for Warp sessions inside a multiplexer", () => {
		Bun.env.TERM_PROGRAM = "WarpTerminal";
		const previousTmux = Bun.env.TMUX;
		Bun.env.TMUX = "/tmp/tmux-1000/default,1,0";
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const originalWrite = term.write.bind(term);
		term.write = (data: string) => {
			writes.push(data);
			originalWrite(data);
		};
		const scheduler = new SyncScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new LineComponent("row-", 8));
		try {
			tui.start();
			scheduler.settle();
			scheduler.t += 200;
			writes.length = 0;

			// The mux owns the grid and consumes the toggles itself, so the
			// inherited Warp marker must not divert the mux-tuned borrow path.
			term.resize(40, 20);
			scheduler.settle();
			expect(countNeedle(writes.join(""), ALT_ENTER)).toBe(1);

			// And a ±1 resize during the probe is real (muxes never echo), so
			// it restarts the transaction instead of re-probing.
			term.resize(40, 21);
			scheduler.settle();
			const all = writes.join("");
			expect(countNeedle(all, ALT_ENTER)).toBe(2);
			expect(countNeedle(all, "\x1b[6n")).toBe(2);
		} finally {
			tui.stop();
			if (previousTmux === undefined) delete Bun.env.TMUX;
			else Bun.env.TMUX = previousTmux;
		}
	});
});

/** Synchronous scheduler: delay-ignoring timers fire on settle(). */
class SyncScheduler {
	#pending = new Set<() => void>();
	t = 0;
	now(): number {
		return this.t;
	}
	scheduleImmediate(callback: () => void): void {
		callback();
	}
	scheduleRender(callback: () => void): RenderTimer {
		this.#pending.add(callback);
		return { cancel: () => this.#pending.delete(callback) };
	}
	settle(): void {
		const pending = [...this.#pending];
		this.#pending.clear();
		for (const callback of pending) callback();
	}
}
/** Frame provider mirroring the coding-agent transcript: committed history plus live rows. */
class RebuildProvider implements TerminalFrameProvider {
	replayCalls = 0;
	lastViewport: ViewportSize | undefined;
	history: { id: number; rows: string[] } | undefined = {
		id: 1,
		rows: ["committed-0", "committed-1", "committed-2"],
	};

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		this.lastViewport = viewport;
		return {
			history: this.history,
			viewport: Array.from({ length: Math.min(8, viewport.rows) }, (_, i) => `live-${i}`),
		};
	}

	acknowledgeHistory(): void {
		this.history = undefined;
	}

	beginHistoryReplay(): void {
		this.replayCalls++;
	}
}
