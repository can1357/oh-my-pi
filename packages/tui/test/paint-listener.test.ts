import { expect, it } from "bun:test";
import {
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type TuiPaint,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class Provider implements TerminalFrameProvider {
	plan: TerminalFramePlan;

	constructor(plan: TerminalFramePlan) {
		this.plan = plan;
	}

	renderFrame(_viewport: ViewportSize): TerminalFramePlan {
		return this.plan;
	}

	acknowledgeHistory(id: number): void {
		if (this.plan.history?.id === id) this.plan = { viewport: this.plan.viewport };
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

function plain(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row));
}

it("reports complete diff, history-append, and destructive-reset paints", () => {
	const terminal = new VirtualTerminal(20, 4);
	const provider = new Provider({ viewport: ["initial", "status"] });
	const paints: TuiPaint[] = [];
	const recordPaint = (paint: TuiPaint) => paints.push(paint);
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler, onPaint: recordPaint });
	tui.setFrameProvider(provider);
	paints.length = 0;

	provider.plan = { viewport: ["diff", "status changed"] };
	tui.requestRender();
	expect(paints).toHaveLength(1);
	expect(plain(paints[0]!.history)).toEqual([]);
	expect(plain(paints[0]!.viewport)).toEqual(["diff", "status changed"]);
	expect(paints[0]).toMatchObject({ reset: false, alt: false, columns: 20, rows: 4 });

	paints.length = 0;
	provider.plan = { history: { id: 1, rows: ["finished block"] }, viewport: ["next", "status"] };
	tui.requestRender(true);
	expect(plain(paints[0]!.history)).toEqual(["finished block"]);
	expect(plain(paints[0]!.viewport)).toEqual(["next", "status"]);
	expect(paints[0]).toMatchObject({ reset: false, alt: false, columns: 20, rows: 4 });

	paints.length = 0;
	provider.plan = { viewport: ["replacement", "status"] };
	tui.requestRender(true, { clearScrollback: true });
	expect(paints).toHaveLength(1);
	expect(plain(paints[0]!.history)).toEqual([]);
	expect(plain(paints[0]!.viewport)).toEqual(["replacement", "status"]);
	expect(paints[0]).toMatchObject({ reset: true, alt: false, columns: 20, rows: 4 });

	tui.setPaintListener(null);
	tui.stop();
});
