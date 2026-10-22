/**
 * The host package namespace, resolved on first use.
 *
 * The extension, custom-tool, custom-command and hook loaders all hand a
 * loaded module the host's package namespace (`api.pi`). Resolving it is one
 * operation, so it lives here instead of being re-implemented in each loader:
 * a change to the namespace-identity, retry or loading policy then applies to
 * every loader at once.
 *
 * First-use boundary: evaluating the package barrel at import time would pull
 * it (and through it sdk/tools/modes/task-executor) into every graph that
 * loads a loader. Bun's compiled ESM artifacts lower `require()` to a
 * CommonJS wrapper around the namespace, so the namespace must resolve through
 * a dynamic import to stay `===` with the statically imported host namespace.
 */
import type * as PiCodingAgent from "../index";

let piCodingAgentNamespace: typeof PiCodingAgent | undefined;

/**
 * The host package namespace, evaluated on first use and cached thereafter.
 *
 * Every loader resolves the namespace through this function, so a loaded
 * module always receives the same object the host itself imports.
 */
export async function loadPiCodingAgentNamespace(): Promise<typeof PiCodingAgent> {
	piCodingAgentNamespace ??= await import("../index");
	return piCodingAgentNamespace;
}
