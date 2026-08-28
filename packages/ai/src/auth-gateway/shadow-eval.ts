export interface ShadowEvalGateOptions {
	maxConcurrent: number;
}

/**
 * In-process permit gate for shadow evaluations. No LLM, no network — only
 * bounded concurrency. {@link ShadowEvalGate.tryAcquire} is false at cap;
 * extra {@link ShadowEvalGate.release} calls are no-ops so the cap cannot
 * inflate.
 */
export class ShadowEvalGate {
	#maxConcurrent: number;
	#inFlight = 0;

	constructor(opts: ShadowEvalGateOptions) {
		this.#maxConcurrent = opts.maxConcurrent;
	}

	tryAcquire(): boolean {
		if (this.#inFlight >= this.#maxConcurrent) return false;
		this.#inFlight += 1;
		return true;
	}

	release(): void {
		if (this.#inFlight === 0) return;
		this.#inFlight -= 1;
	}
}
