export interface Samples {
	firstCallMs: number | null;
	warmups: number;
	rawMs: number[];
	medianMs: number | null;
	p95Ms: number | null;
	errors: string[];
}

export function summarize(samples: number[]): { medianMs: number | null; p95Ms: number | null } {
	if (samples.length === 0) return { medianMs: null, p95Ms: null };
	const sorted = samples.toSorted((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return {
		medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
		p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
	};
}

/** Failed observations remain errors, never successful latency samples. */
export async function measure(run: () => Promise<void>, runs: number, warmups: number): Promise<Samples> {
	const rawMs: number[] = [];
	const errors: string[] = [];
	const observe = async (phase: string): Promise<number | null> => {
		const start = performance.now();
		try {
			await run();
			return performance.now() - start;
		} catch (error) {
			errors.push(`${phase}: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	};
	const first = await observe("first call");
	for (let i = 0; i < warmups; i++) await observe(`warmup ${i + 1}`);
	for (let i = 0; i < runs; i++) {
		const sample = await observe(`sample ${i + 1}`);
		if (sample !== null) rawMs.push(sample);
	}
	return { firstCallMs: first, warmups, rawMs, ...summarize(rawMs), errors };
}

export interface Options {
	runs: number;
	warmups: number;
	python?: string;
}

export function parseOptions(args: string[]): Options {
	const options: Options = { runs: 30, warmups: 5 };
	for (let i = 0; i < args.length; i += 2) {
		const flag = args[i];
		const value = args[i + 1];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
		if (flag === "--python") options.python = value;
		else if (flag === "--runs" || flag === "--warmups") {
			const number = Number(value);
			if (!Number.isInteger(number) || number < (flag === "--runs" ? 1 : 0) || number > 1000) {
				throw new Error(`${flag} must be an integer from ${flag === "--runs" ? 1 : 0} to 1000`);
			}
			options[flag === "--runs" ? "runs" : "warmups"] = number;
		} else throw new Error(`Unknown option: ${flag}`);
	}
	return options;
}
