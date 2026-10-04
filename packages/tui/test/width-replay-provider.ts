import type { TerminalFramePlan, TerminalFrameProvider, ViewportSize } from "@oh-my-pi/pi-tui";

/**
 * Frame provider for resize-replay tests: streams a history batch plus an
 * editor row, both stamped with the render width, retires the batch on
 * acknowledge, and counts `beginHistoryReplay` resets. The width stamp is what
 * resize tests assert on — it proves which geometry re-rendered or replayed —
 * and `resetCount` proves how many destructive ledger refreshes ran.
 */
export class WidthReplayProvider implements TerminalFrameProvider {
	#nextHistoryId = 1;
	#retired = false;
	readonly #historyRows: readonly string[];
	resetCount = 0;

	constructor(historyRows: readonly string[] = ["history-one", "history-two"]) {
		this.#historyRows = historyRows;
	}

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		const width = viewport.columns;
		return {
			history: this.#retired
				? undefined
				: { id: this.#nextHistoryId, rows: this.#historyRows.map(row => `${row}@${width}`) },
			viewport: [`editor@${width}`],
		};
	}

	acknowledgeHistory(id: number): void {
		if (id !== this.#nextHistoryId) return;
		this.#nextHistoryId++;
		this.#retired = true;
	}

	beginHistoryReplay(): void {
		this.#retired = false;
		this.resetCount++;
	}
}
