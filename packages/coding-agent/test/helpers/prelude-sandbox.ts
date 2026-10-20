import * as vm from "node:vm";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../../src/eval/js/shared/prelude";

/** Host bridge stub the eval JS prelude calls into. */
export type PreludeBridge = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Runs the shipped eval JS prelude verbatim in a throwaway VM context with
 * only the host bridge (`__omp_call_tool__`) stubbed — no worker, no kernel —
 * so tests exercise the real shipped helpers, not a re-implementation.
 */
export function loadPrelude(callTool: PreludeBridge): Record<string, unknown> {
	const sandbox: Record<string, unknown> = { __omp_call_tool__: callTool };
	vm.createContext(sandbox);
	vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, sandbox);
	return sandbox;
}

/**
 * Narrows a prelude global to a callable helper. Fails loudly when the prelude
 * does not expose it, instead of casting an unchecked `as`.
 */
export function preludeHelper<T extends (...args: never[]) => unknown>(
	sandbox: Record<string, unknown>,
	name: string,
): T {
	const value: unknown = sandbox[name];
	if (typeof value !== "function") throw new Error(`prelude helper ${name}() is not available`);
	return value as T;
}
