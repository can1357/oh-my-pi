/** Runtime resolution shared by the backends' `runtime.ts`: the memo, and the search for a usable interpreter. */
import { Settings } from "../config/settings";
import {
	enumeratePythonRuntimes,
	filterEnv,
	type PythonRuntime,
	resolveExplicitPythonRuntime,
} from "../eval/py/runtime";
import type { DisasmBackendId, DisasmUnavailableError, WorkerRuntime } from "./backend";

const runtimes = new Map<string, Promise<WorkerRuntime>>();

/**
 * Resolve a backend's worker runtime once per `inputs` (its interpreter and install settings and
 * the cwd): concurrent and later callers share the resolution. A failed one is evicted, so the
 * next call retries.
 */
export function memoizeWorkerRuntime(
	backend: DisasmBackendId,
	inputs: readonly (string | undefined)[],
	resolve: () => Promise<WorkerRuntime>,
): Promise<WorkerRuntime> {
	const key = [backend, ...inputs.map(input => input ?? "")].join("\0");
	const cached = runtimes.get(key);
	if (cached) return cached;
	const promise = resolve();
	runtimes.set(key, promise);
	promise.catch(() => {
		if (runtimes.get(key) === promise) runtimes.delete(key);
	});
	return promise;
}

/**
 * First interpreter `probe` accepts: the configured `python` alone, otherwise every interpreter
 * found for `cwd`, each with the shell environment. `probe` returns the worker runtime for a
 * usable interpreter and undefined to try the next; it throws when no other interpreter can
 * succeed either. With none accepted, throws `unavailable` of the interpreters tried.
 */
export async function findWorkerRuntime(
	python: string | undefined,
	cwd: string,
	probe: (candidate: PythonRuntime) => Promise<WorkerRuntime | undefined>,
	unavailable: (tried: string) => DisasmUnavailableError,
): Promise<WorkerRuntime> {
	const baseEnv = filterEnv((await Settings.init()).getShellConfig().env);
	const candidates = python
		? [resolveExplicitPythonRuntime(python, cwd, baseEnv)]
		: enumeratePythonRuntimes(cwd, baseEnv);
	for (const candidate of candidates) {
		const runtime = await probe(candidate);
		if (runtime) return runtime;
	}
	throw unavailable(candidates.length > 0 ? candidates.map(candidate => candidate.pythonPath).join(", ") : "none");
}
