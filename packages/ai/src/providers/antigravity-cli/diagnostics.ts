/**
 * Opt-in timing samples for the Antigravity CLI host. Only stage names and
 * durations are kept: never request content, model output, account identifiers,
 * or session IDs. Enable with OMP_ACP_DIAGNOSTICS=1; the host logs a debug
 * rollup when it closes.
 */

export const DIAGNOSTICS_ENV = "OMP_ACP_DIAGNOSTICS";
export const DIAGNOSTICS_CAPACITY = 128;

/** Host stages worth measuring; everything else stays uninstrumented. */
export type DiagnosticsStage = "process.start" | "session.new" | "session.load" | "prompt" | "step.total";

export type DiagnosticsStageStats = {
	count: number;
	/** Lower middle sample, in milliseconds, rounded to microseconds. */
	medianMs: number;
	maxMs: number;
};

export type DiagnosticsSummary = {
	enabled: boolean;
	samples: number;
	capacity: number;
	stages: Record<string, DiagnosticsStageStats>;
};

/** True only for an explicit opt-in; every other value, including "true", stays off. */
export function diagnosticsEnabled(env: Record<string, string | undefined> = Bun.env): boolean {
	return env[DIAGNOSTICS_ENV] === "1";
}

/** Bounded in-memory sampler; the injected clock keeps it testable and free of timers. */
export class Diagnostics {
	readonly #enabled: boolean;
	readonly #now: () => number;
	readonly #samples: { stage: DiagnosticsStage; ms: number }[] = [];
	#active = 0;
	#idle: PromiseWithResolvers<void> | undefined;
	#generation = 0;

	constructor(enabled: boolean = diagnosticsEnabled(), now: () => number = () => performance.now()) {
		this.#enabled = enabled;
		this.#now = now;
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	/** Counts accepted samples, so a rollup can tell whether anything new arrived since the last one. */
	get generation(): number {
		return this.#generation;
	}

	/** Keep the newest samples; invalid durations are dropped rather than skewing the median. */
	record(stage: DiagnosticsStage, ms: number): void {
		if (!this.#enabled || !Number.isFinite(ms) || ms < 0) return;
		this.#samples.push({ stage, ms });
		if (this.#samples.length > DIAGNOSTICS_CAPACITY) this.#samples.shift();
		this.#generation++;
	}

	sync<T>(stage: DiagnosticsStage, work: () => T): T {
		if (!this.#enabled) return work();
		const startedAt = this.#now();
		try {
			return work();
		} finally {
			this.record(stage, this.#now() - startedAt);
		}
	}

	/** Resolves once every measured stage has settled, so a close-time rollup can be complete. */
	settled(): Promise<void> {
		if (this.#active === 0) return Promise.resolve();
		this.#idle ??= Promise.withResolvers<void>();
		return this.#idle.promise;
	}

	async measure<T>(stage: DiagnosticsStage, work: () => Promise<T>): Promise<T> {
		if (!this.#enabled) return work();
		const startedAt = this.#now();
		this.#active++;
		try {
			return await work();
		} finally {
			this.record(stage, this.#now() - startedAt);
			this.#active--;
			if (this.#active === 0 && this.#idle) {
				const idle = this.#idle;
				this.#idle = undefined;
				idle.resolve();
			}
		}
	}

	summary(): DiagnosticsSummary {
		const groups = new Map<DiagnosticsStage, number[]>();
		for (const sample of this.#samples) {
			const values = groups.get(sample.stage);
			if (values) values.push(sample.ms);
			else groups.set(sample.stage, [sample.ms]);
		}
		const stages: Record<string, DiagnosticsStageStats> = {};
		for (const [stage, values] of groups) {
			values.sort((a, b) => a - b);
			stages[stage] = {
				count: values.length,
				medianMs: roundMs(values[Math.floor((values.length - 1) / 2)]),
				maxMs: roundMs(values[values.length - 1]),
			};
		}
		return { enabled: this.#enabled, samples: this.#samples.length, capacity: DIAGNOSTICS_CAPACITY, stages };
	}

	reset(): void {
		this.#samples.length = 0;
	}
}

function roundMs(ms: number): number {
	return +ms.toFixed(3);
}
