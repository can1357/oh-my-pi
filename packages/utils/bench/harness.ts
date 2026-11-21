/**
 * Micro-benchmark harness for the `*.bench.ts` scripts in this directory.
 *
 * {@link group} times alternative implementations of one task and prints a
 * table; the first case is the baseline the others are compared with.
 * {@link measure} times one function and returns the numbers. Each case warms
 * up, is calibrated to a batch size that runs long enough for the clock, and
 * is sampled several times: the median is reported, with the fastest sample
 * next to it as a floor less sensitive to machine load.
 *
 * `BENCH_MIN_MS` overrides the time spent per case (default 300) and
 * `BENCH_FILTER` (a regex on "group › case") selects what runs.
 *
 * @example
 * // Run: bun packages/utils/bench/my.bench.ts
 * import { group } from "./harness";
 *
 * const text = "lorem ipsum ".repeat(100_000);
 * await group("find a needle", { units: text.length, unit: "char" }, {
 *   indexOf: () => text.indexOf("needle"),
 *   regex: () => /needle/.test(text),
 * });
 */

/** How one case is run and reported. */
export interface BenchOptions {
	/** Time spent sampling the case, after warm-up; default 300, or `BENCH_MIN_MS`. */
	minTimeMs?: number;
	/** Samples the time is split into; default 15. */
	samples?: number;
	/** Work items one call processes (bytes, matches, rows): adds a time-per-item column. */
	units?: number;
	/** Name of one work item in that column; default "unit". */
	unit?: string;
}

/** Timing of one case, in nanoseconds per call. */
export interface BenchResult {
	name: string;
	/** Calls per sample. */
	batch: number;
	/** Every sample, ascending. */
	samples: number[];
	min: number;
	median: number;
	p95: number;
}

/** A case's body; a returned promise is awaited before the next call. */
export type BenchFn = () => unknown;

/** Kept reachable so a call whose result is unused cannot be optimized away. */
const sink: { last: unknown } = { last: undefined };

async function runBatch(fn: BenchFn, batch: number, isAsync: boolean): Promise<number> {
	const start = Bun.nanoseconds();
	if (isAsync) for (let i = 0; i < batch; i++) sink.last = await fn();
	else for (let i = 0; i < batch; i++) sink.last = fn();
	return Bun.nanoseconds() - start;
}

/** Times `fn`: warm-up, batch calibration, then `samples` batches. */
export async function measure(name: string, fn: BenchFn, options: BenchOptions = {}): Promise<BenchResult> {
	const minTimeNs = (options.minTimeMs ?? Number(Bun.env.BENCH_MIN_MS ?? 300)) * 1e6;
	const sampleCount = Math.max(1, options.samples ?? 15);
	const first = fn();
	const isAsync = first instanceof Promise;
	if (isAsync) await first;
	// Grow the batch until one takes a sample's share of the time; this doubles as warm-up.
	const target = minTimeNs / sampleCount;
	let batch = 1;
	for (;;) {
		const elapsed = await runBatch(fn, batch, isAsync);
		if (elapsed >= target || batch >= 1 << 30) break;
		// Aim past the target at once when the clock resolved the batch, else just grow.
		batch = elapsed > 1e5 ? Math.ceil((batch * target * 1.1) / elapsed) : batch * 8;
	}
	const samples: number[] = [];
	for (let i = 0; i < sampleCount; i++) samples.push((await runBatch(fn, batch, isAsync)) / batch);
	samples.sort((a, b) => a - b);
	return {
		name,
		batch,
		samples,
		min: samples[0]!,
		median: samples[samples.length >> 1]!,
		p95: samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]!,
	};
}

/** A duration in nanoseconds with the unit that keeps three significant digits. */
export function formatDuration(ns: number): string {
	if (ns < 1e3) return `${ns.toPrecision(3)} ns`;
	if (ns < 1e6) return `${(ns / 1e3).toPrecision(3)} µs`;
	if (ns < 1e9) return `${(ns / 1e6).toPrecision(3)} ms`;
	return `${(ns / 1e9).toPrecision(3)} s`;
}

function printTable(rows: string[][]): void {
	const widths = rows[0]!.map((_, column) => Math.max(...rows.map(row => Bun.stringWidth(row[column]!))));
	for (const row of rows) {
		const cells = row.map((cell, column) => {
			const pad = " ".repeat(widths[column]! - Bun.stringWidth(cell));
			return column === 0 ? cell + pad : pad + cell;
		});
		console.log(`  ${cells.join("  ")}`);
	}
}

/**
 * Times each case of one task and prints them as a table, comparing every case
 * with the first. Returns the results of the cases that ran.
 */
export async function group(
	title: string,
	options: BenchOptions,
	cases: Record<string, BenchFn>,
): Promise<BenchResult[]> {
	const filter = Bun.env.BENCH_FILTER ? new RegExp(Bun.env.BENCH_FILTER, "i") : undefined;
	const results: BenchResult[] = [];
	for (const name in cases) {
		if (filter && !filter.test(`${title} › ${name}`)) continue;
		results.push(await measure(name, cases[name]!, options));
	}
	if (results.length === 0) return results;
	const { units, unit = "unit" } = options;
	const header = ["", "median", "min", "p95"];
	if (units) header.push(`per ${unit}`);
	header.push(`vs ${results[0]!.name}`);
	const rows = [header];
	for (const result of results) {
		const row = [result.name, formatDuration(result.median), formatDuration(result.min), formatDuration(result.p95)];
		if (units) row.push(formatDuration(result.median / units));
		const ratio = result.median / results[0]!.median;
		const factor = ratio >= 1 ? ratio : 1 / ratio;
		const shown = factor >= 1000 ? Math.round(factor).toLocaleString("en-US") : factor.toPrecision(3);
		row.push(result === results[0] ? "—" : `${shown}× ${ratio >= 1 ? "slower" : "faster"}`);
		rows.push(row);
	}
	console.log(`\n${title}`);
	printTable(rows);
	return results;
}
