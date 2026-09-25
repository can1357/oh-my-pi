export interface RouteAttemptRecord {
	routeId: string;
	target: string;
	success: boolean;
	durationMs: number;
	ttftMs?: number;
}

export interface RoutePerformanceSummary {
	attempts: number;
	successes: number;
	meanDurationMs: number;
}

const MAX_RECORDS = 10_000;

/**
 * Bounded in-memory attempt log keyed by routeId+target. FIFO cap of 10k
 * records across the store; summary is undefined when no rows match.
 */
export class RoutePerformanceStore {
	#records: RouteAttemptRecord[] = [];

	record(r: RouteAttemptRecord): void {
		const stored: RouteAttemptRecord = {
			routeId: r.routeId,
			target: r.target,
			success: r.success,
			durationMs: r.durationMs,
		};
		if (r.ttftMs !== undefined) stored.ttftMs = r.ttftMs;
		this.#records.push(stored);
		if (this.#records.length > MAX_RECORDS) {
			this.#records.splice(0, this.#records.length - MAX_RECORDS);
		}
	}

	summary(routeId: string, target: string): RoutePerformanceSummary | undefined {
		let attempts = 0;
		let successes = 0;
		let durationSum = 0;
		for (const rec of this.#records) {
			if (rec.routeId !== routeId || rec.target !== target) continue;
			attempts += 1;
			if (rec.success) successes += 1;
			durationSum += rec.durationMs;
		}
		if (attempts === 0) return undefined;
		return {
			attempts,
			successes,
			meanDurationMs: durationSum / attempts,
		};
	}
}
