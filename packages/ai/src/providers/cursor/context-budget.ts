import { prompt } from "@oh-my-pi/pi-utils";
import contextBudgetNotice from "./context-budget-notice.md" with { type: "text" };

/**
 * Asks a Cursor turn to wrap up once its conversation passes the host's
 * compaction threshold.
 *
 * Cursor runs the whole tool loop server-side inside one request, so the host
 * only gets a compaction boundary when the turn ends: until then every internal
 * step replays an ever-growing conversation. One notice, attached to the first
 * tool result that can carry it once past the threshold, ends the turn so the
 * host can compact and continue — the boundary mid-turn compaction gets for free
 * on providers whose tool loop runs on the client.
 */
export class CursorContextBudget {
	#spent = false;

	constructor(readonly thresholdTokens: number) {}

	/**
	 * The notice to attach to the next tool result, at most once per turn.
	 * `contextTokens` is Cursor's live conversation size from its latest checkpoint;
	 * like the host's compaction check, only a size past the threshold counts.
	 */
	takeNotice(contextTokens: number | undefined): string | undefined {
		if (this.#spent || contextTokens === undefined || contextTokens <= this.thresholdTokens) return undefined;
		this.#spent = true;
		return prompt.render(contextBudgetNotice, { contextTokens, thresholdTokens: this.thresholdTokens });
	}
}
