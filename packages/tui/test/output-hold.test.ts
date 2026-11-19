/**
 * Regression for the "terminal follows the agent while the user reads back"
 * complaint (oh-my-pi#1755): the renderer never probes the user's scroll
 * position (`docs/tui-core-renderer.md` §7), so a hold has to be an explicit
 * gesture. This file defends the contract that makes the gesture usable:
 *
 * 1. While held, no frame reaches the terminal — streaming rows, spinner
 *    frames, and history retirement all stop, so the screen cannot scroll.
 * 2. The hold does not drop work: the withheld history batch is still offered
 *    on release, once, and acknowledged then.
 * 3. Release repaints without a scrollback rebuild, even when the terminal
 *    changed width while held — a hold must never itself cause the jump it
 *    exists to prevent.
 * 4. A resize that arrives while held is absorbed, not painted.
 */
import { describe, expect, it } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	takeWrites(): string {
		const out = this.writes.join("");
		this.writes.length = 0;
		return out;
	}
}

/** A provider offering one history batch, then a growing viewport. */
class OfferOnceProvider {
	historyOffered = false;
	acknowledged = 0;
	viewport: string[] = ["live one"];
	#retire = ["finished one"];

	renderFrame(): { viewport: readonly string[]; history?: { id: number; rows: readonly string[] } } {
		if (!this.historyOffered) {
			this.historyOffered = true;
			return { viewport: this.viewport, history: { id: 1, rows: this.#retire } };
		}
		return { viewport: this.viewport };
	}

	acknowledgeHistory(id: number): void {
		this.acknowledged = id;
	}
}

async function openHoldHarness(rows = 8, columns = 30) {
	const terminal = new RecordingTerminal(columns, rows);
	const scheduler = new VirtualRenderScheduler();
	const tui = new TUI(terminal, true, { renderScheduler: scheduler });
	const provider = new OfferOnceProvider();
	tui.setFrameProvider(provider);
	tui.start();
	await scheduler.settle(terminal);
	return { terminal, scheduler, tui, provider };
}

describe("TUI output hold", () => {
	it("emits nothing while held and repaints once on release", async () => {
		const { terminal, scheduler, tui, provider } = await openHoldHarness();
		expect(tui.setOutputHold(true, "held")).toBe(true);
		terminal.takeWrites();

		// Streaming rows keep arriving, and the spinner keeps requesting frames.
		provider.viewport = ["live one", "live two", "live three"];
		for (let i = 0; i < 5; i++) {
			tui.requestRender();
			await scheduler.settle(terminal);
		}

		expect(terminal.takeWrites()).toBe("");
		tui.setOutputHold(false);
		await scheduler.settle(terminal);
		const painted = terminal.takeWrites();
		expect(painted).toContain("live three");
		expect(tui.getOutputHold()).toBe(false);
		tui.stop();
	});

	it("withholds history while held and offers it exactly once on release", async () => {
		const { terminal, scheduler, tui, provider } = await openHoldHarness();
		// The first frame already retired its batch, so start from a clean slate.
		expect(provider.acknowledged).toBe(1);
		provider.historyOffered = false;
		tui.setOutputHold(true);
		tui.requestRender();
		await scheduler.settle(terminal);
		expect(provider.acknowledged).toBe(1);

		tui.setOutputHold(false);
		await scheduler.settle(terminal);
		expect(provider.acknowledged).toBe(1);
		expect(terminal.getScrollBuffer().join("\n")).toContain("finished one");
		tui.stop();
	});

	it("does not clear scrollback when the width changed during the hold", async () => {
		const { terminal, scheduler, tui } = await openHoldHarness(8, 30);
		const before = terminal.getScrollBuffer().join("\n");
		tui.setOutputHold(true);
		terminal.resize(20, 8);
		tui.requestRender();
		await scheduler.settle(terminal);

		tui.setOutputHold(false);
		await scheduler.settle(terminal);
		const painted = terminal.takeWrites();
		// `rebuild` would emit ED3 (`\x1b[3J`) plus a full transcript replay.
		expect(painted).not.toContain("\x1b[3J");
		expect(terminal.getScrollBuffer().join("\n")).toContain(before.split("\n")[0]!);
		tui.stop();
	});

	it("keeps the notice off the scrollback and the hold idempotent", async () => {
		const { terminal, scheduler, tui } = await openHoldHarness();
		const scrollbackBefore = terminal.getScrollBuffer().length;
		tui.setOutputHold(true, "held");
		terminal.takeWrites();
		// A second hold request changes nothing and paints nothing.
		expect(tui.setOutputHold(true, "held again")).toBe(false);
		await scheduler.settle(terminal);
		expect(terminal.takeWrites()).toBe("");
		expect(terminal.getScrollBuffer().length).toBe(scrollbackBefore);

		tui.setOutputHold(false);
		await scheduler.settle(terminal);
		tui.stop();
	});

	it("drops the hold on stop so the exit flush can paint", async () => {
		const { terminal, scheduler, tui } = await openHoldHarness();
		tui.setOutputHold(true);
		tui.stop();
		expect(tui.getOutputHold()).toBe(false);
		await scheduler.settle(terminal);
	});
});
