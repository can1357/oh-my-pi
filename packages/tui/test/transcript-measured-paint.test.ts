import { describe, expect, it, vi } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer, type TranscriptPresentationTarget } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { type Component, type TUI } from "@oh-my-pi/pi-tui";

const frame = { tick: 0, now: 0 };

/**
 * A block that records the paints the transcript grants it.
 *
 * The transcript measures a block before it decides whether to show it, and
 * the measurement is not a paint: a block it then omits never reaches the
 * terminal. When the whole live tail fits, the measured rows ARE the viewport
 * output, so the block has to learn that its measurement was painted.
 */
class MeasuredBlock implements Component, TranscriptPresentationTarget {
	measuredRenders = 0;
	paintNotifications = 0;

	render(): readonly string[] {
		return ["measured block"];
	}

	setTranscriptAllocation(_rows: number, _frame: { tick: number; now: number }, measured = false): void {
		if (measured) this.measuredRenders++;
	}

	notifyMeasuredPaint(): void {
		this.paintNotifications++;
	}
}

describe("TranscriptContainer measured-paint promotion", () => {
	it("promotes a measured block to a paint when the whole live tail fits", () => {
		// The live tail fits inside the viewport, so the container reuses the
		// measured rows as its output: they reach the terminal. A block that
		// keeps a per-paint fact (a pending shape the first result must
		// replay) has to be told, or it treats a visible shape as one the
		// user never saw.
		const transcript = new TranscriptContainer();
		const block = new MeasuredBlock();
		transcript.addChild(block);

		const rows = transcript.renderViewport(40, 10, frame);

		expect(rows).toEqual(["measured block"]);
		expect(block.measuredRenders).toBe(1);
		expect(block.paintNotifications).toBe(1);
	});

	it("does not promote a measured block the emergency layout omits", () => {
		// More live blocks than the viewport can hold: the container cannot
		// show them all, so the ones it drops were only measured, never
		// painted. Promoting them would ask for a replay of a shape the
		// user never saw.
		const transcript = new TranscriptContainer();
		const blocks = [new MeasuredBlock(), new MeasuredBlock(), new MeasuredBlock()];
		for (const block of blocks) transcript.addChild(block);

		transcript.renderViewport(40, 1, frame);

		for (const block of blocks) {
			expect({ notifications: block.paintNotifications }).toEqual({ notifications: 0 });
		}
	});

	it("replays the viewport when a fitting transcript's write tail window takes its first result", async () => {
		// The end-to-end contract: a long collapsed write inside a live
		// transcript that FITS the viewport is painted (its measured rows are
		// the viewport output), so the first result has to re-anchor the frame
		// and clear the tail rows from the scrollback. Before the promotion
		// the block treated its measurement as "never painted", no replay was
		// requested, and the tail rows stayed in the scrollback.
		await initTheme();
		const requestRender = vi.fn();
		const ui = { requestRender, requestComponentRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent(
			"write",
			{
				path: "notes.txt",
				content: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"),
			},
			{},
			undefined,
			ui,
		);
		component.stopAnimation();
		const transcript = new TranscriptContainer();
		transcript.addChild(component);

		// The whole live tail fits: the container reuses the measured rows.
		const rows = transcript.renderViewport(80, 30, frame);
		expect(rows.length).toBeGreaterThan(0);

		component.updateResult({ content: [{ type: "text", text: "Writing notes.txt..." }] }, true);

		expect(requestRender).toHaveBeenCalledTimes(1);
	});
});
