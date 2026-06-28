/**
 * Micro-benchmark harness shared by the tui bench scripts.
 *
 * `makeBench(iterations)` returns a `bench(name, fn)` that runs `fn` the given
 * number of times, prints `<name>: <total>ms total (<perOp>ms/op)`, and returns
 * the total elapsed milliseconds.
 */
export function makeBench(iterations: number): (name: string, fn: () => void) => number {
	return function bench(name: string, fn: () => void): number {
		const start = Bun.nanoseconds();
		for (let i = 0; i < iterations; i++) {
			fn();
		}
		const elapsed = (Bun.nanoseconds() - start) / 1e6;
		const perOp = (elapsed / iterations).toFixed(6);
		console.log(`${name}: ${elapsed.toFixed(2)}ms total (${perOp}ms/op)`);
		return elapsed;
	};
}
