import { describe, expect, it } from "bun:test";
import { RenderFlightRecorder } from "../src/render-flight-recorder";
import { type Component, type RenderTimer, TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

describe("render flight recorder", () => {
	it("emits once on settlement, distinguishes output deferral and retains bounded history", () => {
		let now = 0;
		const records: Record<string, unknown>[] = [];
		const flight = new RenderFlightRecorder(
			() => now,
			(_, record) => records.push(record),
		);
		flight.request("input");
		now = 100;
		flight.beginProvider();
		flight.endProvider();
		flight.settle(0);
		expect(records).toEqual([]);
		flight.request("content");
		for (let i = 0; i < 3000; i++) flight.event("deferred", "output-backlog", 65536);
		now = 2201;
		flight.beginProvider();
		flight.write(512);
		flight.endProvider();
		flight.settle(128);
		flight.settle(0);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			durationMs: 2101,
			frameBytes: 512,
			pendingOutputBytes: 128,
			terminalDrain: "pending",
			providerAwait: null,
		});
		expect(records[0]!.droppedEvents).toBeGreaterThan(0);
		const timeline = records[0]!.timeline as { kind: string; tag: string; value: number }[];
		expect(timeline).toHaveLength(2048);
		expect(timeline.some(e => e.kind === "deferred" && e.tag === "output-backlog" && e.value === 65536)).toBe(true);
	});

	it("reports repeated cancelled render timers when a producer starves the pending key paint", () => {
		let now = 0;
		let id = 0;
		let flood = false;
		const timers = new Map<number, () => void>();
		const immediates: (() => void)[] = [];
		const records: Record<string, unknown>[] = [];
		const flight = new RenderFlightRecorder(
			() => now,
			(_, record) => records.push(record),
		);
		const scheduler = {
			now: () => now,
			scheduleImmediate: (cb: () => void) => {
				immediates.push(cb);
			},
			scheduleRender: (cb: () => void, _delay: number): RenderTimer => {
				const key = id++;
				timers.set(key, cb);
				return {
					cancel: () => {
						timers.delete(key);
					},
				};
			},
		};
		const term = new VirtualTerminal(140, 40);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler, renderFlightRecorder: flight });
		let text = "";
		let paintedAt = -1;
		tui.addFrameWriteListener(() => {
			if (text && paintedAt < 0) paintedAt = now;
		});
		const input: Component = {
			render: () => [],
			handleInput: data => {
				text += data;
				tui.requestRender();
			},
		};
		tui.addChild(input);
		tui.setFocus(input);
		tui.setFrameProvider({ renderFrame: () => ({ viewport: [text] }), acknowledgeHistory() {} });
		const turn = (): void => {
			for (const cb of immediates.splice(0)) cb();
			const due = [...timers.entries()];
			for (const [key, cb] of due) {
				if (flood) tui.requestRender(false, { caller: "repro:ordered-producer" });
				if (!timers.has(key)) continue;
				timers.delete(key);
				cb();
			}
		};
		try {
			tui.start();
			turn();
			now = 100;
			tui.requestRender();
			for (const cb of immediates.splice(0)) cb();
			term.sendInput("x");
			flood = true;
			for (now = 101; now < 2300; now++) turn();
			flood = false;
			turn();
			// On the round-3 negative control this records the delayed visible paint.
			// On the fixed scheduler the key settles promptly, so there is no long-gap record.
			const cancelled = records
				.flatMap(r => r.timeline as { kind: string }[])
				.filter(e => e.kind === "timer-cancelled");
			if (process.env.RENDER_STARVATION_NEGATIVE_CONTROL === "1") {
				expect(records).toHaveLength(1);
				expect(paintedAt).toBeGreaterThan(2200);
				expect(cancelled.length).toBeGreaterThan(100);
				expect(records[0]!.providerAwait).toBeNull();
			} else {
				expect(paintedAt).toBeGreaterThanOrEqual(100);
				expect(paintedAt).toBeLessThan(134);
				expect(records).toEqual([]);
			}
		} finally {
			tui.stop();
		}
	});
});
