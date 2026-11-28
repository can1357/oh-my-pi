/**
 * Teardown that releases each resource on its own: a cleanup step that throws skips none of the others, and the
 * teardown still fails with what threw once every step ran.
 */

/** Run every step in order, each after the one before even when that one threw; then throw what the steps threw. */
export async function runEach(steps: ReadonlyArray<() => unknown>): Promise<void> {
	const errors: unknown[] = [];
	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, `${errors.length} cleanup steps failed`);
}

/** Cleanup steps, each added as its resource is acquired; {@link run} runs them newest first, each on its own. */
export class Cleanups {
	readonly #steps: Array<() => unknown> = [];

	/** Release a resource just acquired at the next {@link run}. */
	add(step: () => unknown): void {
		this.#steps.push(step);
	}

	/** Run every step added since the last run, newest first, through {@link runEach}. */
	run(): Promise<void> {
		return runEach(this.#steps.splice(0).reverse());
	}
}
