import { describe, expect, it } from "bun:test";
import { type Component, type RenderTimer, TUI } from "@oh-my-pi/pi-tui";
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
	readonly timers: Array<{ callback: () => void; canceled: boolean }> = [];

	now(): number {
		return this.nowMs;
	}

	scheduleImmediate(callback: () => void): void {
		this.immediates.push(callback);
	}

	scheduleRender(callback: () => void, _delayMs: number): RenderTimer {
		const timer = { callback, canceled: false };
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
});
