import { afterEach, describe, expect, it, vi } from "bun:test";
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
	paintNotifications = 0;

	render(): readonly string[] {
		return ["measured block"];
	}

	notifyMeasuredPaint(): void {
		this.paintNotifications++;
	}
}

/** The collapsed write window is sized from the live viewport; pin it so the tail rows are deterministic. */
const VIEWPORT_ROWS = 32;
const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");

afterEach(() => {
	vi.restoreAllMocks();
	if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
	else Reflect.deleteProperty(process.stdout, "rows");
});

describe("TranscriptContainer measured-paint promotion", () => {
	it("does not promote a measured block the emergency layout omits", () => {
		// Genuine overflow (more rows than the viewport holds): the newest-first
		// walk stops at the capacity cap and the emergency layout shows one
		// representative row. Blocks it omits were only measured, never painted,
		// so none may be promoted.
		const transcript = new TranscriptContainer();
		const blocks = [new MeasuredBlock(), new MeasuredBlock(), new MeasuredBlock()];
		for (const block of blocks) transcript.addChild(block);

		// Capacity 2 forces genuine overflow: the walk stops mid-tail and the
		// emergency layout shows a subset. Omitted blocks were only measured.
		transcript.renderViewport(40, 2, frame);

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
		Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => VIEWPORT_ROWS, set: () => {} });
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

		try {
			// The whole live tail fits: the container reuses the measured rows.
			const rows = transcript.renderViewport(80, 30, frame);
			const text = Bun.stripANSI(rows.join("\n"));
			// The painted shape is the tail window the replay exists to clear:
			// the marker and the last line of the file, not a bare header.
			expect(text).toContain("… (8 earlier lines)");
			expect(text).toContain("line 20");
			expect(text).not.toContain("line 1 ");

			component.updateResult({ content: [{ type: "text", text: "Writing notes.txt..." }] }, true);

			expect(requestRender).toHaveBeenCalledTimes(1);
		} finally {
			// A partial result re-arms the component's spinner; leaving it
			// registered keeps the process-wide interval alive into later files.
			component.stopAnimation();
		}
	});
});
