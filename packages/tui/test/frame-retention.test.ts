import { describe, expect, it } from "bun:test";
import { type TerminalFramePlan, type TerminalFrameProvider, TUI, type ViewportSize } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

// Bounded frame retention under the explicit history-batch contract: the
// engine itself retains only the mutable viewport (#providerWindow), and the
// application layer retires finalized rows into immutable HistoryBatch offers
// under capacity pressure. These tests pin the observable contract that made
// the old engine-side per-row caches safe, ported to the batch lifecycle:
//
//   ► sustained streaming past any capacity keeps the terminal tape an exact
//     transcript copy — every committed row exactly once, in order, with the
//     visible region always matching the transcript tail;
//   ► every offered history batch is accepted exactly once, ids contiguous
//     and ascending (no duplicate or skipped acknowledgements);
//   ► the application-layer live set stays bounded while the tape keeps the
//     full history, so nothing grows without bound anywhere in the pipeline.

/**
 * Application-side transcript owner mimicking the product container's
 * capacity-driven retirement: the mutable viewport can only show
 * `viewport.rows` rows, so once more live transcript rows exist than fit,
 * the settled prefix above them is offered as an immutable HistoryBatch
 * (one outstanding offer at a time, one batch drained per engine frame)
 * until the terminal acknowledges it. A batch leaves the viewport in the
 * same frame it is appended, so its rows are never painted twice.
 */
class RetiringFrameProvider implements TerminalFrameProvider {
	#transcript: string[] = [];
	#retiredRows = 0;
	#nextBatchId = 1;
	#offered: { id: number; rows: string[] } | undefined;
	readonly acknowledgedIds: number[] = [];

	append(rows: readonly string[]): void {
		this.#transcript.push(...rows);
	}

	/** Transcript rows not yet handed to the terminal as history. */
	get liveRowCount(): number {
		return this.#transcript.length - this.#retiredRows - (this.#offered?.rows.length ?? 0);
	}

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		const room = Math.max(1, viewport.rows);
		if (this.#offered === undefined) {
			const live = this.#transcript.length - this.#retiredRows;
			if (live > room) {
				// Retire down to one live viewport; the mutable tail stays below.
				const end = this.#transcript.length - room;
				if (end > this.#retiredRows) {
					this.#offered = { id: this.#nextBatchId++, rows: this.#transcript.slice(this.#retiredRows, end) };
				}
			}
		}
		return {
			history: this.#offered !== undefined ? { id: this.#offered.id, rows: this.#offered.rows } : undefined,
			viewport: this.#transcript.slice(-room),
		};
	}
	acknowledgeHistory(id: number): void {
		if (this.#offered === undefined || this.#offered.id !== id) return;
		this.#retiredRows += this.#offered.rows.length;
		this.acknowledgedIds.push(id);
		this.#offered = undefined;
	}
}

const scheduler = new VirtualRenderScheduler();

function rowsFrom(start: number, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `row-${String(start + i).padStart(5, "0")}`);
}

/** Scrollback history + active grid, right-trimmed, trailing blanks dropped. */
function tape(term: VirtualTerminal): string[] {
	const buffer = term.getScrollBuffer().map(line => line.trimEnd());
	while (buffer.length > 0 && buffer.at(-1) === "") buffer.pop();
	return buffer;
}

function saveTerminalEnv(): Record<string, string | undefined> {
	const saved: Record<string, string | undefined> = {};
	for (const key of ["TERM_PROGRAM", "TMUX", "PI_TUI_RESIZE_IN_PLACE", "HERDR_ENV"]) {
		saved[key] = Bun.env[key];
		delete Bun.env[key];
	}
	return saved;
}

function restoreTerminalEnv(saved: Record<string, string | undefined>): void {
	for (const key in saved) {
		if (saved[key] === undefined) delete Bun.env[key];
		else Bun.env[key] = saved[key];
	}
}

describe("bounded engine-side frame retention", () => {
	it("keeps the tape an exact transcript copy while sustained streaming drains history batches", async () => {
		if (process.platform === "win32") return;
		const width = 40;
		const height = 12;
		const term = new VirtualTerminal(width, height, 8000);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const provider = new RetiringFrameProvider();
		const transcript: string[] = [];
		const saved = saveTerminalEnv();

		try {
			tui.setFrameProvider(provider);

			// Stream many viewport-fills past the initial screen, one
			// viewport-height chunk per frame; pressure fires every round once
			// the transcript outgrows the mutable viewport.
			for (let round = 0; round < 120; round++) {
				transcript.push(...rowsFrom(transcript.length, height));
				provider.append(transcript.slice(-height));
				tui.requestRender();
				await scheduler.settle(term);
			}
			expect(transcript.length).toBeGreaterThan(height * 10);
			expect(provider.acknowledgedIds.length).toBeGreaterThan(50);

			// (a) Capacity pressure fired repeatedly, and every offered batch
			// was accepted exactly once: ids are contiguous, ascending, never
			// repeated.
			expect(provider.acknowledgedIds.length).toBeGreaterThan(0);
			expect(provider.acknowledgedIds).toEqual(provider.acknowledgedIds.map((_, index) => index + 1));

			// (b) Retirement bounds the application-side live set to the
			// mutable viewport even though the tape keeps the full history.
			expect(provider.liveRowCount).toBeLessThanOrEqual(height);

			// (c) Rendered output is semantically identical to the source of
			// truth: the tape holds every committed row exactly once, in order,
			// byte-for-byte against the transcript — retirement never changes
			// what the terminal shows.
			expect(tape(term)).toEqual(transcript);

			// (d) The visible region always matches the transcript tail.
			expect(term.getViewport().map(row => row.trimEnd())).toEqual(transcript.slice(-height));
		} finally {
			restoreTerminalEnv(saved);
			tui.stop();
		}
	});
});
