import { afterEach, describe, expect, it } from "bun:test";
import { type Component, type RenderTimer, TUI } from "@oh-my-pi/pi-tui";
import { DEFAULT_MAX_FPS, setMaxFps } from "@oh-my-pi/pi-tui/frame-rate";
import { VirtualTerminal } from "./virtual-terminal";

class InputProbe implements Component {
	constructor(private readonly events: string[]) {}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		this.events.push("render");
		return ["probe"];
	}

	handleInput(_data: string): void {
		this.events.push("input");
	}
}

class DeferredRenderScheduler {
	nowMs = 0;
	readonly immediates: Array<() => void> = [];
	readonly timers: Array<{ callback: () => void; canceled: boolean; delayMs: number }> = [];

	now(): number {
		return this.nowMs;
	}

	scheduleImmediate(callback: () => void): void {
		this.immediates.push(callback);
	}

	scheduleRender(callback: () => void, delayMs: number): RenderTimer {
		const timer = { callback, canceled: false, delayMs };
		this.timers.push(timer);
		return {
			cancel: () => {
				timer.canceled = true;
			},
		};
	}
}

describe("TUI input/render scheduling", () => {
	it("can commit a priority frame without waiting for queued immediates", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const events: string[] = [];
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new InputProbe(events));

		try {
			tui.start();
			tui.renderNow();
			expect(events).toEqual(["render"]);

			for (const immediate of scheduler.immediates.splice(0)) immediate();
			expect(events).toEqual(["render"]);
		} finally {
			tui.stop();
		}
	});

	it("can process terminal input before a deferred ordinary repaint", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const events: string[] = [];
		const probe = new InputProbe(events);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(probe);
		tui.setFocus(probe);

		try {
			tui.start();
			scheduler.immediates.shift()?.();
			const initialTimer = scheduler.timers.shift();
			if (initialTimer && !initialTimer.canceled) initialTimer.callback();
			events.length = 0;
			scheduler.nowMs = 100;

			tui.requestRender();
			term.sendInput("x");
			scheduler.immediates.shift()?.();
			const repaintTimer = scheduler.timers.shift();
			if (repaintTimer && !repaintTimer.canceled) repaintTimer.callback();

			expect(events[0]).toBe("input");
			expect(events).toContain("render");
		} finally {
			tui.stop();
		}
	});

	it("paints a key while background requests arrive before every timer turn", () => {
		const term = new VirtualTerminal(140, 40);
		let nowMs = 0;
		const immediates: Array<() => void> = [];
		const timers = new Map<number, { at: number; run: () => void }>();
		let nextId = 0;
		const scheduler = {
			now: () => nowMs,
			scheduleImmediate: (run: () => void) => {
				immediates.push(run);
			},
			scheduleRender: (run: () => void, delay: number): RenderTimer => {
				const id = nextId++;
				timers.set(id, { at: nowMs + Math.max(1, Math.ceil(delay)), run });
				return {
					cancel: () => {
						timers.delete(id);
					},
				};
			},
		};
		let input = "";
		let inputPaintAt: number | undefined;
		let maxFrameBytes = 0;
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addFrameWriteListener(data => {
			maxFrameBytes = Math.max(maxFrameBytes, Buffer.byteLength(data));
			if (input && inputPaintAt === undefined) inputPaintAt = nowMs;
		});
		const probe: Component = {
			invalidate() {},
			render: () => [],
			handleInput: data => {
				input += data;
				tui.requestRender();
			},
		};
		tui.setFocus(probe);
		// Large plan, requirements and worker chrome share the provider with the editor.
		const rows = [
			"480 closed / archived tasks; 177 requirements",
			...Array.from({ length: 11 }, (_, n) => `worker ${n}: ${"progress ".repeat(14)}`),
		];
		tui.setFrameProvider({ renderFrame: () => ({ viewport: [...rows, input] }), acknowledgeHistory() {} });
		const tick = () => {
			for (const run of immediates.splice(0)) run();
			const due = Array.from(timers).filter(([, timer]) => timer.at <= nowMs);
			for (const [id, timer] of due) {
				if (!timers.delete(id)) continue;
				timer.run();
			}
		};
		try {
			tui.start();
			for (; nowMs < 100; nowMs++) tick();
			term.sendInput("x");
			// Timers remain runnable throughout: a ready producer runs just before
			// each render turn, as an interval or async worker completion can.
			for (; nowMs < 200; nowMs++) {
				tui.requestRender();
				tick();
			}
			expect(term.getViewport().join("\n")).toContain("x");
			expect(inputPaintAt).toBeDefined();
			expect(inputPaintAt! - 100).toBeLessThanOrEqual(34);
			expect(maxFrameBytes).toBeLessThan(4096);
		} finally {
			tui.stop();
		}
	});

	describe("tui.maxFps ceiling", () => {
		afterEach(() => {
			setMaxFps(DEFAULT_MAX_FPS);
		});

		/** Start the TUI, paint its first frame at t=0, and return the primed harness. */
		function primed(): {
			tui: TUI;
			scheduler: DeferredRenderScheduler;
			events: string[];
			term: VirtualTerminal;
			probe: InputProbe;
		} {
			const term = new VirtualTerminal(20, 4);
			const scheduler = new DeferredRenderScheduler();
			const events: string[] = [];
			const probe = new InputProbe(events);
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			tui.addChild(probe);
			tui.setFocus(probe);
			tui.start();
			scheduler.immediates.shift()?.();
			const initialTimer = scheduler.timers.shift();
			if (initialTimer && !initialTimer.canceled) initialTimer.callback();
			events.length = 0;
			return { tui, scheduler, events, term, probe };
		}

		it("paces animation-driven frames at the ceiling, not the scheduler's 30 fps floor", () => {
			setMaxFps(4);
			const { tui, scheduler, probe } = primed();
			try {
				// 40 ms after the last paint: at 30 fps the next frame would be due now; at 4 fps it
				// must wait the rest of the 250 ms period.
				scheduler.nowMs = 40;
				tui.requestComponentRender(probe);
				scheduler.immediates.shift()?.();
				const timer = scheduler.timers.shift();
				expect(timer?.delayMs).toBe(210);
			} finally {
				tui.stop();
			}
		});

		it("paints a keystroke within one 30 fps frame at any ceiling", () => {
			setMaxFps(1);
			const { tui, scheduler, term, events } = primed();
			try {
				scheduler.nowMs = 40;
				term.sendInput("x");
				scheduler.immediates.shift()?.();
				const timer = scheduler.timers.shift();
				// Already past the input cadence (1000/30 ms): due immediately, not in ~960 ms.
				expect(timer?.delayMs).toBe(0);
				timer?.callback();
				expect(events).toEqual(["input", "render"]);
			} finally {
				tui.stop();
			}
		});

		it("replaces a parked animation frame with the keystroke's frame instead of waiting behind it", () => {
			setMaxFps(4);
			const { tui, scheduler, term, probe, events } = primed();
			try {
				scheduler.nowMs = 10;
				tui.requestComponentRender(probe);
				scheduler.immediates.shift()?.();
				const parked = scheduler.timers.shift();
				expect(parked?.delayMs).toBe(240);

				scheduler.nowMs = 50;
				term.sendInput("x");
				expect(parked?.canceled).toBe(true);
				const input = scheduler.timers.shift();
				expect(input?.delayMs).toBe(0);
				input?.callback();
				expect(events).toEqual(["input", "render"]);

				// The ceiling applies again to the next animation frame after that paint.
				scheduler.nowMs = 60;
				tui.requestComponentRender(probe);
				scheduler.immediates.shift()?.();
				expect(scheduler.timers.shift()?.delayMs).toBe(240);
			} finally {
				tui.stop();
			}
		});

		it("keeps adaptive backpressure for keystroke frames: slow frames still rate-limit typing", () => {
			setMaxFps(4);
			const term = new VirtualTerminal(20, 4);
			const scheduler = new DeferredRenderScheduler();
			const events: string[] = [];
			// A probe whose paint costs 150 ms of scheduler time: the adaptive floor is 2 × cost, capped at
			// 200 ms from the last frame start.
			const probe = new (class extends InputProbe {
				override render(width: number): readonly string[] {
					scheduler.nowMs += 150;
					return super.render(width);
				}
			})(events);
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			tui.addChild(probe);
			tui.setFocus(probe);
			try {
				tui.start();
				scheduler.immediates.shift()?.();
				const initialTimer = scheduler.timers.shift();
				if (initialTimer && !initialTimer.canceled) initialTimer.callback();
				// The paint started at t=0 and cost 150 ms; now t=150.
				expect(scheduler.nowMs).toBe(150);
				term.sendInput("x");
				scheduler.immediates.shift()?.();
				// Input cadence alone would allow a paint now; the adaptive floor holds it until t=200.
				expect(scheduler.timers.shift()?.delayMs).toBe(50);
			} finally {
				tui.stop();
			}
		});

		it("keeps a keystroke frame's priority across an output-backlog deferral", () => {
			setMaxFps(4);
			const term = new (class extends VirtualTerminal {
				pendingOutputBytes = 0;
			})(20, 4);
			const scheduler = new DeferredRenderScheduler();
			const events: string[] = [];
			const probe = new InputProbe(events);
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			tui.addChild(probe);
			tui.setFocus(probe);
			try {
				tui.start();
				scheduler.immediates.shift()?.();
				const initialTimer = scheduler.timers.shift();
				if (initialTimer && !initialTimer.canceled) initialTimer.callback();
				events.length = 0;

				// The terminal owes a large backlog: the keystroke's frame is deferred, not painted.
				term.pendingOutputBytes = 64 * 1024 * 1024;
				scheduler.nowMs = 40;
				term.sendInput("x");
				scheduler.immediates.shift()?.();
				const due = scheduler.timers.shift();
				expect(due?.delayMs).toBe(0);
				due?.callback();
				expect(events).toEqual(["input"]);
				const retry = scheduler.timers.shift();
				expect(retry?.delayMs).toBe(10);

				// Backlog drained: the retry paints the keystroke's frame at once, and the latch it
				// carried is consumed by that paint — the next animation frame is paced by the ceiling.
				term.pendingOutputBytes = 0;
				scheduler.nowMs = 50;
				retry?.callback();
				expect(events).toEqual(["input", "render"]);
				scheduler.nowMs = 60;
				tui.requestComponentRender(probe);
				scheduler.immediates.shift()?.();
				expect(scheduler.timers.shift()?.delayMs).toBe(240);
			} finally {
				tui.stop();
			}
		});

		it("paces a render requested by an input listener that consumed the key at the input cadence", () => {
			setMaxFps(4);
			const { tui, scheduler, term, probe, events } = primed();
			// A host-level listener (thinking toggle, tools expand, …): consumes the key and repaints.
			const unsubscribe = tui.addInputListener(data => {
				if (data !== "\x0f") return undefined;
				events.push("toggle");
				tui.requestRender();
				return { consume: true };
			});
			try {
				scheduler.nowMs = 10;
				tui.requestComponentRender(probe);
				scheduler.immediates.shift()?.();
				const parked = scheduler.timers.shift();
				expect(parked?.delayMs).toBe(240);

				scheduler.nowMs = 50;
				term.sendInput("\x0f");
				expect(parked?.canceled).toBe(true);
				const frame = scheduler.timers.shift();
				expect(frame?.delayMs).toBe(0);
				frame?.callback();
				expect(events).toEqual(["toggle", "render"]);
			} finally {
				unsubscribe();
				tui.stop();
			}
		});

		it("paces a mouse-wheel repaint at the input cadence at a 1 fps ceiling", () => {
			setMaxFps(1);
			const { tui, scheduler, term, probe, events } = primed();
			const unsubscribe = tui.addInputListener(data => {
				if (!data.startsWith("\x1b[<64;")) return undefined;
				events.push("wheel");
				tui.requestRender();
				return { consume: true };
			});
			try {
				scheduler.nowMs = 10;
				tui.requestComponentRender(probe);
				scheduler.immediates.shift()?.();
				const parked = scheduler.timers.shift();
				expect(parked?.delayMs).toBe(990);

				scheduler.nowMs = 40;
				term.sendInput("\x1b[<64;5;5M");
				expect(parked?.canceled).toBe(true);
				const frame = scheduler.timers.shift();
				expect(frame?.delayMs).toBe(0);
				frame?.callback();
				expect(events).toEqual(["wheel", "render"]);
			} finally {
				unsubscribe();
				tui.stop();
			}
		});
	});
});
