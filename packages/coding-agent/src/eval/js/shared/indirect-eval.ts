/**
 * Indirect eval — runs in the host's global scope, isolating bindings declared with
 * `const`/`let` from this module's closure. Used by both the JS eval worker and the
 * browser tab worker to execute user-supplied source without `node:vm`.
 *
 * Why not vm.runInContext: Bun crashes the parent process with SIGTRAP when
 * `Worker.terminate()` fires while a worker is mid-`vm.runInContext` synchronous loop.
 * Indirect eval does not trip that bug.
 *
 * The optional `filename` is appended as a `//# sourceURL=...` pragma so V8 attributes
 * stack frames to the user cell instead of `<anonymous>`.
 */
export function indirectEval(source: string, filename?: string): unknown {
	const withPragma = filename ? `${source}\n//# sourceURL=${filename}` : source;
	// Read `eval` via a property access so the call site is *indirect* (global scope),
	// not direct (this module's lexical scope). The cast erases the DOM lib return type.
	// We deliberately avoid `node:vm` because Bun crashes the parent with SIGTRAP when
	// Worker.terminate() fires mid-`vm.runInContext` synchronous loop — indirect eval is
	// the executor for user code in the worker.
	// oxlint-disable-next-line no-eval -- this is the executor.
	const geval = globalThis.eval as (src: string) => unknown;
	return geval(withPragma);
}

export async function awaitMaybePromise<T>(value: T | Promise<T>): Promise<T> {
	if (!value || typeof value !== "object" || typeof (value as { then?: unknown }).then !== "function") {
		return value;
	}
	return await (value as Promise<T>);
}
