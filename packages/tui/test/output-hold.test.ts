/**
 * Regression for the "terminal follows the agent while the user reads back"
 * complaint (oh-my-pi#1755): the renderer never probes the user's scroll
 * position (`docs/tui-core-renderer.md` §7), so a hold has to be an explicit
 * gesture. This file defends the contract that makes the gesture usable:
 *
 * 1. While held, no frame reaches the terminal — streaming rows, spinner
 *    frames, an in-flight resize transaction, and history retirement all stop,
 *    so the screen cannot scroll.
 * 2. The hold does not drop work: a batch offered *during* the hold is neither
 *    written nor acknowledged, and lands exactly once on release.
 * 3. Release repaints without a scrollback rebuild, even when the terminal
 *    changed width while held — a hold must never itself cause the jump it
 *    exists to prevent.
 * 4. A grow that pulled committed history back onto the grid is not overwritten:
 *    the release re-anchors before painting.
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

/** A provider that offers a batch only when told to, so a hold can be tested mid-offer. */
class ScriptedProvider {
	viewport: string[] = ["live one"];
	#pending: { id: number; rows: readonly string[] } | undefined;
	acknowledged: number[] = [];

	/** Offer `rows` as the next ordered batch. */
	offer(id: number, rows: readonly string[]): void {
		this.#pending = { id, rows };
	}

	renderFrame(): {
		viewport: readonly string[];
		history?: { id: number; rows: readonly string[] };
	} {
		const pending = this.#pending;
		if (pending === undefined) return { viewport: this.viewport };
		this.#pending = undefined;
		return { viewport: this.viewport, history: pending };
	}

	acknowledgeHistory(id: number): void {
		this.acknowledged.push(id);
	}
}

async function openHarness(rows = 8, columns = 30) {
	const terminal = new RecordingTerminal(columns, rows);
	const scheduler = new VirtualRenderScheduler();
	const tui = new TUI(terminal, true, { renderScheduler: scheduler });
	const provider = new ScriptedProvider();
	tui.setFrameProvider(provider);
	tui.start();
	await scheduler.settle(terminal);
	terminal.takeWrites();
	return { terminal, scheduler, tui, provider };
}

describe("TUI output hold", () => {
	it("emits nothing while held and repaints once on release", async () => {
		const { terminal, scheduler, tui, provider } = await openHarness();
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
		expect(terminal.takeWrites()).toContain("live three");
		expect(tui.getOutputHold()).toBe(false);
		tui.stop();
	});

	it("withholds a batch offered during the hold and commits it once on release", async () => {
		const { terminal, scheduler, tui, provider } = await openHarness();
		tui.setOutputHold(true);

		// A fresh, higher-id batch arrives while held: nothing may reach the
		// terminal and nothing may be acknowledged.
		provider.offer(7, ["retired while held"]);
		tui.requestRender();
		await scheduler.settle(terminal);
		expect(provider.acknowledged).toEqual([]);
		expect(terminal.getScrollBuffer().join("\n")).not.toContain("retired while held");

		tui.setOutputHold(false);
		await scheduler.settle(terminal);
		expect(provider.acknowledged).toEqual([7]);
		expect(terminal.getScrollBuffer().join("\n")).toContain("retired while held");
		tui.stop();
	});

	it("does not clear scrollback when the width changed during the hold", async () => {
		const { terminal, scheduler, tui } = await openHarness(8, 30);
		const firstRow = terminal.getScrollBuffer()[0]!;
		tui.setOutputHold(true);
		terminal.resize(20, 8);
		tui.requestRender();
		await scheduler.settle(terminal);

		tui.setOutputHold(false);
		await scheduler.settle(terminal);
		// `rebuild` would emit ED3 (`\x1b[3J`) plus a full transcript replay.
		expect(terminal.takeWrites()).not.toContain("\x1b[3J");
		expect(terminal.getScrollBuffer().join("\n")).toContain(firstRow);
		tui.stop();
	});

	it("keeps every committed history row when the hold ends after a grow", async () => {
		const terminal = new RecordingTerminal(30, 8);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, true, { renderScheduler: scheduler });
		const provider = new ScriptedProvider();
		tui.setFrameProvider(provider);
		tui.start();
		// Fill the terminal, then commit ten rows above the live viewport.
		provider.offer(
			1,
			Array.from({ length: 10 }, (_, i) => `history-${i}`),
		);
		await scheduler.settle(terminal);
		const committedBefore = terminal.getScrollBuffer().filter(row => row.includes("history-")).length;
		expect(committedBefore).toBeGreaterThan(0);

		tui.setOutputHold(true);
		// A grow pulls committed rows back onto the grid.
		terminal.resize(30, 12);
		tui.requestRender();
		await scheduler.settle(terminal);
		tui.setOutputHold(false);
		await scheduler.settle(terminal);

		// None of the pulled-back history may be painted over by live rows.
		const surviving = new Set(
			terminal
				.getScrollBuffer()
				.join("\n")
				.match(/history-\d+/g) ?? [],
		);
		expect(surviving.size).toBe(committedBefore);
		tui.stop();
	});

	it("abandons an in-flight resize borrow instead of letting it write", async () => {
		const { terminal, scheduler, tui } = await openHarness();
		// Start a real borrow transaction (SIGWINCH) and hold before it settles.
		terminal.resize(30, 6);
		terminal.takeWrites();
		tui.setOutputHold(true, "held");
		await scheduler.settle(terminal, 500);
		// The settle timer would have written the alt exit and started a DSR probe.
		const writes = terminal.takeWrites();
		expect(writes).not.toContain("\x1b[?1049l");
		expect(writes).not.toContain("\x1b[6n");
		tui.setOutputHold(false);
		await scheduler.settle(terminal);
		tui.stop();
	});

	it("restores the normal buffer when the borrow entry was already painted", async () => {
		// Force the alt-buffer borrow path; the default here repaints in place.
		process.env.PI_TUI_RESIZE_IN_PLACE = "0";
		try {
			const { terminal, scheduler, tui } = await openHarness();
			// Let a borrow paint its entry, then hold before its settle timer fires.
			terminal.resize(30, 6);
			await scheduler.advance(terminal, 40);
			expect(terminal.takeWrites()).toContain("\x1b[?1049h");
			tui.setOutputHold(true, "held");
			// Leaving the user on the alternate buffer would hide the transcript.
			expect(terminal.takeWrites()).toContain("\x1b[?1049l");
			tui.setOutputHold(false);
			await scheduler.settle(terminal);
			tui.stop();
		} finally {
			delete process.env.PI_TUI_RESIZE_IN_PLACE;
		}
	});

	it("rejects control bytes and newlines in the notice", async () => {
		const { terminal, scheduler, tui } = await openHarness();
		tui.setOutputHold(true, "held\x1b[3J\nIMPOSTOR");
		const writes = terminal.takeWrites();
		// The hostile payload must not reach the terminal as control sequences.
		expect(writes).not.toContain("\x1b[3J");
		expect(writes).toContain("IMPOSTOR");
		tui.setOutputHold(false);
		await scheduler.settle(terminal);
		tui.stop();
	});

	it("keeps the notice off the scrollback and the hold idempotent", async () => {
		const { terminal, scheduler, tui } = await openHarness();
		const before = terminal.getScrollBuffer().length;
		tui.setOutputHold(true, "held");
		terminal.takeWrites();
		expect(tui.setOutputHold(true, "held again")).toBe(false);
		await scheduler.settle(terminal);
		expect(terminal.takeWrites()).toBe("");
		expect(terminal.getScrollBuffer().length).toBe(before);
		tui.setOutputHold(false);
		await scheduler.settle(terminal);
		tui.stop();
	});

	it("drops the hold on stop so the exit flush can paint", async () => {
		const { terminal, scheduler, tui } = await openHarness();
		tui.setOutputHold(true);
		tui.stop();
		expect(tui.getOutputHold()).toBe(false);
		await scheduler.settle(terminal);
	});

	it("releases the hold when an overlay opens, and paints it", async () => {
		const { terminal, scheduler, tui } = await openHarness();
		tui.setOutputHold(true);
		terminal.takeWrites();
		const handle = tui.showOverlay({ render: () => ["dialog-row"], invalidate: () => {} });
		// A prompt the agent waits on must never be hidden behind a held screen.
		expect(tui.getOutputHold()).toBe(false);
		await scheduler.settle(terminal);
		expect(terminal.takeWrites()).toContain("dialog-row");
		handle.hide();
		await scheduler.settle(terminal);
		tui.stop();
	});
});
