import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@pk-nerdsaver-ai/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/2088
//
// Closing a tmux horizontal split widens the surviving pane. SIGWINCH fires
// on the host process before tmux finishes repainting the pane buffer at
// the new size, and drag-resize/pane-close animations also fire several
// SIGWINCHes in flight. Forcing an immediate render on every event raced
// those mid-reflow paints — tmux's catch-up paint then partially overwrote
// the TUI output, which the user saw as a viewport flash or blank screen
// before the next throttled frame arrived.
//
// Fix: coalesce SIGWINCHes inside a multiplexer settle window so a single
// forced render fires once the pane is quiet. `#resizeEventPending` is set
// on every event so the eventual render still classifies as a resize.

// Pad the production debounce by 30 ms so the test consistently observes the
// settled render without re-encoding the constant.
const DEBOUNCE_SETTLE_WAIT_MS = 80;

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

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(1);
	await term.flush();
}

// Pad the non-multiplexer resize viewport settle window (120 ms) so the test
// reliably observes the deferred authoritative full paint. These are
// integration tests against the real render scheduler (process.nextTick
// immediates interleaved with setTimeout debounces), so the settle window is
// driven with a real delay rather than fake timers.
const RESIZE_VIEWPORT_SETTLE_WAIT_MS = 160;

async function settleResize(term: VirtualTerminal): Promise<void> {
	await Bun.sleep(RESIZE_VIEWPORT_SETTLE_WAIT_MS);
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

const MULTIPLEXER_ENV_KEYS = [
	"TMUX",
	"STY",
	"ZELLIJ",
	"CMUX_WORKSPACE_ID",
	"CMUX_SURFACE_ID",
	"CMUX_PANEL_ID",
	"CMUX_TAB_ID",
	"CMUX_SOCKET_PATH",
	"HERDR_PANE_ID",
	"HERDR_SOCKET_PATH",
];
const NO_MULTIPLEXER_ENV: Record<string, string | undefined> = Object.fromEntries(
	MULTIPLEXER_ENV_KEYS.map(key => [key, undefined]),
);
const TMUX_ENV: Record<string, string | undefined> = { ...NO_MULTIPLEXER_ENV, TMUX: "1" };
const CMUX_ENV_CASES: Array<[string, Record<string, string | undefined>]> = [
	["CMUX_WORKSPACE_ID", { ...NO_MULTIPLEXER_ENV, TERM: "dumb", CMUX_WORKSPACE_ID: "workspace:cmux-2088" }],
	["CMUX_SURFACE_ID", { ...NO_MULTIPLEXER_ENV, TERM: "dumb", CMUX_SURFACE_ID: "surface:cmux-2088" }],
];
const HERDR_ENV_CASES: Array<[string, Record<string, string | undefined>]> = [
	["HERDR_PANE_ID", { ...NO_MULTIPLEXER_ENV, TERM: "dumb", HERDR_PANE_ID: "w1:p1" }],
	["HERDR_SOCKET_PATH", { ...NO_MULTIPLEXER_ENV, TERM: "dumb", HERDR_SOCKET_PATH: "\\\\.\\pipe\\herdr-test" }],
];
const CMUX_SOCKET_ONLY_ENV: Record<string, string | undefined> = {
	...NO_MULTIPLEXER_ENV,
	TERM: "xterm-256color",
	CMUX_SOCKET_PATH: "/tmp/cmux.sock",
};
// Pin TERM to a non-multiplexer value: `isMultiplexerSession()` falls back to
// the TERM prefix, so leaving the host's TERM (which may be `tmux-*`/`screen-*`
// under CI-in-tmux) would misclassify this "direct terminal" case.
NO_MULTIPLEXER_ENV.TERM = "xterm-256color";
// Resize classification also keys off TERM_PROGRAM (Warp takes the in-place
// path) and PI_TUI_RESIZE_IN_PLACE, so neutralize them to keep this
// direct-terminal case deterministic.
NO_MULTIPLEXER_ENV.TERM_PROGRAM = undefined;
NO_MULTIPLEXER_ENV.PI_TUI_RESIZE_IN_PLACE = undefined;

describe("issue #2088: tmux pane-resize race produces viewport flash", () => {
	let monotonicNow = 0;

	beforeEach(() => {
		monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 40;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("coalesces a burst of multiplexer resize events into a single settled render", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

			try {
				tui.start();
				await settle(term);

				const baselineRedraws = tui.fullRedraws;
				const writes = captureWrites(term);

				// Simulate a tmux pane-close animation: several SIGWINCHes arrive
				// while tmux is still mid-reflow, each carrying an intermediate
				// width. Only the final width should be painted, and only once.
				term.resize(60, 10);
				term.resize(75, 10);
				term.resize(80, 10);

				// Inside the debounce window: no new paint must have landed yet,
				// otherwise the TUI would be writing into a pane tmux has not
				// finished reflowing.
				await Bun.sleep(10);
				expect(tui.fullRedraws).toBe(baselineRedraws);
				expect(writes.length).toBe(0);

				// After the settle window the single coalesced render fires at the
				// final geometry — exactly one paint covering 80×10.
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				expect(tui.fullRedraws - baselineRedraws).toBe(1);
				expect(visible(term)).toEqual(Array.from({ length: 10 }, (_v, i) => `line-${i + 10}`));
			} finally {
				tui.stop();
			}
		});
	});

	it("paints the viewport immediately on resize outside a multiplexer, then replays on settle", async () => {
		await withEnvPatch(NO_MULTIPLEXER_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

			try {
				tui.start();
				await settle(term);

				const baselineRedraws = tui.fullRedraws;
				const baselinePaints = tui.resizeViewportPaints;
				const expectedViewport = Array.from({ length: 10 }, (_v, i) => `line-${i + 10}`);
				term.resize(80, 10);
				await settle(term);

				// In flight: a cheap viewport-only paint lands at once (no native
				// scrollback replay), and the authoritative full paint is deferred.
				expect(tui.resizeViewportPaints).toBeGreaterThan(baselinePaints);
				expect(tui.fullRedraws).toBe(baselineRedraws);
				expect(visible(term)).toEqual(expectedViewport);

				// Once the drag goes quiet the full replay fires exactly once.
				await settleResize(term);
				expect(tui.fullRedraws).toBeGreaterThan(baselineRedraws);
				expect(visible(term)).toEqual(expectedViewport);
			} finally {
				tui.stop();
			}
		});
	});

	it("cancels a pending multiplexer resize timer on stop()", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

			tui.start();
			await settle(term);

			const writes = captureWrites(term);
			term.resize(80, 10);
			tui.stop();

			// stop() must cancel the pending debounce; no render bytes appear
			// after the settle window has elapsed, even though the resize was
			// armed only moments ago.
			await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
			const lateRepaintBytes = writes.filter(chunk => chunk.includes("\x1b[H")).length;
			expect(lateRepaintBytes).toBe(0);
		});
	});

	it("supersedes a throttled render queued just before a multiplexer SIGWINCH", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			const lines = Array.from({ length: 20 }, (_v, i) => `line-${i}`);
			const component = new MutableLinesComponent(lines);
			tui.addChild(component);

			try {
				tui.start();
				await settle(term);

				const baselineRedraws = tui.fullRedraws;
				const writes = captureWrites(term);

				// A streamed token lands in the same 30fps frame as the SIGWINCH:
				// `requestRender(false)` arms `#renderTimer`, then `term.resize`
				// fires the SIGWINCH that arms the multiplexer debounce. If the
				// queued throttled render were left active it would fire inside
				// the 50 ms settle window and paint mid-reflow.
				lines[19] = "line-19 streamed";
				component.setLines(lines);
				tui.requestRender();
				term.resize(80, 10);

				// During the debounce window: no paint must land. The queued
				// throttled timer was canceled and any follow-on
				// `requestRender(false)` is held off until the multiplexer
				// settles.
				await Bun.sleep(10);
				expect(tui.fullRedraws).toBe(baselineRedraws);
				expect(writes.length).toBe(0);

				// After the settle window: exactly one forced render lands, at
				// the new geometry, with the streamed token visible.
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				expect(tui.fullRedraws - baselineRedraws).toBe(1);
				expect(visible(term).at(-1)).toBe("line-19 streamed");
			} finally {
				tui.stop();
			}
		});
	});

	it("defers a forced repaint that lands inside the multiplexer settle window", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

			try {
				tui.start();
				await settle(term);

				const baselineRedraws = tui.fullRedraws;
				const writes = captureWrites(term);

				// A SIGWINCH starts the debounce. Then a `requestRender(true)`
				// (e.g. from finishSixelProbe or an image-budget eviction)
				// arrives mid-window. Without deferral it would paint
				// immediately into a still-reflowing pane.
				term.resize(80, 10);
				await Bun.sleep(10);
				tui.requestRender(true);

				// Inside the window: still no paint. The forced render was
				// folded into the in-flight debounce.
				await Bun.sleep(20);
				expect(tui.fullRedraws).toBe(baselineRedraws);
				expect(writes.length).toBe(0);

				// After the window: exactly one settled paint at the final
				// geometry.
				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				expect(tui.fullRedraws - baselineRedraws).toBe(1);
				expect(visible(term)).toEqual(Array.from({ length: 10 }, (_v, i) => `line-${i + 10}`));
			} finally {
				tui.stop();
			}
		});
	});

	it("defers resetDisplay() that lands inside the multiplexer settle window", async () => {
		await withEnvPatch(TMUX_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

			try {
				tui.start();
				await settle(term);

				const baselineRedraws = tui.fullRedraws;
				const writes = captureWrites(term);

				term.resize(80, 10);
				await Bun.sleep(10);
				tui.resetDisplay();

				// resetDisplay normally repaints synchronously; here it must
				// route through the multiplexer debounce so no paint lands
				// while tmux is still reflowing.
				await Bun.sleep(20);
				expect(tui.fullRedraws).toBe(baselineRedraws);
				expect(writes.length).toBe(0);

				await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
				await settle(term);
				expect(tui.fullRedraws - baselineRedraws).toBe(1);
				expect(visible(term)).toEqual(Array.from({ length: 10 }, (_v, i) => `line-${i + 10}`));
			} finally {
				tui.stop();
			}
		});
	});
});

// Regression for multiplexer auto-detection: `isMultiplexerSession()` gates the
// renderer's resize behavior. It previously checked only TMUX/STY/ZELLIJ, while
// sibling checks also fall back to TERM prefixes and CMUX exposes its own session
// env markers. When a multiplexer was missed, the engine misclassified the pane
// as a direct terminal and emitted ED3 (CSI 3 J) on resize — which wipes pane
// history (verified against tmux 3.6a: a 20-line pane drops to its 6 on-screen
// rows after ED3), so scrollback only reappeared after a full rerender.
describe("multiplexer detection gates ED3 on resize", () => {
	let monotonicNow = 0;

	beforeEach(() => {
		monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 40;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ED3 clears native scrollback; the renderer must never emit it in a mux.
	const ED3 = "\x1b[3J";

	// tmux/screen panes whose authoritative env signal was stripped but whose
	// TERM still names the multiplexer — the case previously misclassified.
	const strippedMuxTerms: Array<[string, Record<string, string | undefined>]> = [
		["tmux-256color", { ...NO_MULTIPLEXER_ENV, TERM: "tmux-256color" }],
		["screen-256color", { ...NO_MULTIPLEXER_ENV, TERM: "screen-256color" }],
	];

	for (const [label, env] of strippedMuxTerms) {
		it(`debounces the resize and emits no ED3 when only TERM=${label} marks the multiplexer`, async () => {
			await withEnvPatch(env, async () => {
				const term = new VirtualTerminal(40, 10, 1000);
				const tui = new TUI(term);
				tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

				try {
					tui.start();
					await settle(term);

					const baselineRedraws = tui.fullRedraws;
					const writes = captureWrites(term);

					// SIGWINCH must route through the multiplexer debounce, not the
					// immediate forced render: detection via TERM alone is the proof.
					term.resize(80, 10);
					await Bun.sleep(10);
					expect(writes.length).toBe(0);
					expect(tui.fullRedraws).toBe(baselineRedraws);

					// The settled paint repaints at the new geometry without clearing
					// native scrollback, so the pane keeps its history.
					await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
					await settle(term);
					const out = writes.join("");
					expect(out.length).toBeGreaterThan(0);
					expect(out).not.toContain(ED3);
					expect(tui.fullRedraws - baselineRedraws).toBe(1);
					expect(visible(term)).toEqual(Array.from({ length: 10 }, (_v, i) => `line-${i + 10}`));
				} finally {
					tui.stop();
				}
			});
		});
	}

	for (const [label, env] of CMUX_ENV_CASES) {
		it(`debounces resize and emits no ED3 when ${label} marks CMUX with TERM=dumb`, async () => {
			await withEnvPatch(env, async () => {
				const term = new VirtualTerminal(40, 10, 1000);
				const tui = new TUI(term);
				tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

				try {
					tui.start();
					await settle(term);

					const baselineRedraws = tui.fullRedraws;
					const writes = captureWrites(term);

					term.resize(80, 10);
					await Bun.sleep(10);
					expect(writes.length).toBe(0);
					expect(tui.fullRedraws).toBe(baselineRedraws);

					await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
					await settle(term);
					const out = writes.join("");
					expect(out.length).toBeGreaterThan(0);
					expect(out).not.toContain(ED3);
					expect(tui.fullRedraws - baselineRedraws).toBe(1);
					expect(visible(term)).toEqual(Array.from({ length: 10 }, (_v, i) => `line-${i + 10}`));
				} finally {
					tui.stop();
				}
			});
		});
	}

	for (const [label, env] of HERDR_ENV_CASES) {
		it(`debounces resize and emits no ED3 when ${label} marks pk-herdr with TERM=dumb`, async () => {
			await withEnvPatch(env, async () => {
				const term = new VirtualTerminal(40, 10, 1000);
				const tui = new TUI(term);
				tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

				try {
					tui.start();
					await settle(term);

					const baselineRedraws = tui.fullRedraws;
					const writes = captureWrites(term);

					term.resize(80, 10);
					await Bun.sleep(10);
					expect(writes.length).toBe(0);
					expect(tui.fullRedraws).toBe(baselineRedraws);

					await Bun.sleep(DEBOUNCE_SETTLE_WAIT_MS);
					await settle(term);
					const out = writes.join("");
					expect(out.length).toBeGreaterThan(0);
					expect(out).not.toContain(ED3);
					expect(tui.fullRedraws - baselineRedraws).toBe(1);
					expect(visible(term)).toEqual(Array.from({ length: 10 }, (_v, i) => `line-${i + 10}`));
				} finally {
					tui.stop();
				}
			});
		});
	}

	it("does not treat CMUX_SOCKET_PATH alone as a multiplexer session marker", async () => {
		await withEnvPatch(CMUX_SOCKET_ONLY_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

			try {
				tui.start();
				await settle(term);

				const writes = captureWrites(term);
				term.resize(80, 10);
				await settleResize(term);
				const out = writes.join("");
				expect(out).toContain(ED3);
			} finally {
				tui.stop();
			}
		});
	});
	it("still clears native scrollback (ED3) on a genuine direct-terminal resize", async () => {
		await withEnvPatch(NO_MULTIPLEXER_ENV, async () => {
			const term = new VirtualTerminal(40, 10, 1000);
			const tui = new TUI(term);
			tui.addChild(new MutableLinesComponent(Array.from({ length: 20 }, (_v, i) => `line-${i}`)));

			try {
				tui.start();
				await settle(term);

				// Capture only the resize-driven paint; the initial paint never
				// clears scrollback, so any ED3 in `out` belongs to the resize.
				// Wait past the 120 ms viewport-settle window — that deferred
				// `requestRender(true, { clearScrollback: true })` is what emits ED3.
				const writes = captureWrites(term);
				term.resize(80, 10);
				await settleResize(term);
				const out = writes.join("");
				expect(out).toContain(ED3);
				expect(visible(term)).toEqual(Array.from({ length: 10 }, (_v, i) => `line-${i + 10}`));
			} finally {
				tui.stop();
			}
		});
	});
});
