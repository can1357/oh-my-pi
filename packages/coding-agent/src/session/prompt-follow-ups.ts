/**
 * Follow-ups that must run after one prompt, in order (`PromptOptions.followUps`).
 *
 * They stay off the queue until their prompt reaches the agent: its run goes live, it lands
 * on a queue, or a local command finishes handling it. Until then no drain or other run can
 * deliver them ahead of it, and a prompt that never gets there hands them back with itself.
 */
export class PromptFollowUps {
	readonly #texts: readonly string[];
	readonly #enqueue: (texts: readonly string[]) => void;
	#state: "held" | "released" | "handedBack" = "held";

	constructor(texts: readonly string[], enqueue: (texts: readonly string[]) => void) {
		this.#texts = texts;
		this.#enqueue = enqueue;
	}

	/** The prompt reached the agent: queue the follow-ups behind it. */
	release(): void {
		if (this.#state !== "held") return;
		this.#state = "released";
		this.#enqueue(this.#texts);
	}

	/** True until the follow-ups are released or handed back. */
	get held(): boolean {
		return this.#state === "held";
	}

	/** The prompt never reached the agent: return the follow-ups, once; `[]` after release or a prior hand-back. */
	handBack(): string[] {
		if (this.#state !== "held") return [];
		this.#state = "handedBack";
		return [...this.#texts];
	}
}
