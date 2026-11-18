/**
 * Backend support for tiny local models, read from the catalog policy rather
 * than from the model registry: `unsupported "<backend>" reason="…"` nodes on
 * the `local` provider's authored seed rows
 * (`packages/catalog/src/compat/rules/providers/local.kdl`).
 *
 * The tiny registry owns which weights omp offers; the catalog owns which
 * backend can load them, so a backend restriction is policy and lives in KDL.
 */
import { seedBackendRefusals } from "@oh-my-pi/pi-catalog/compat/providers";
import type { SeedBackend } from "@oh-my-pi/pi-catalog/compat/types";

/** Provider whose authored seed rows are the tiny-model roster. */
const LOCAL_PROVIDER = "local";

/** Why `backend` cannot load `modelKey`, or `undefined` when it can. */
export function tinyModelBackendRefusal(modelKey: string, backend: SeedBackend): string | undefined {
	return seedBackendRefusals(LOCAL_PROVIDER, modelKey).find(refusal => refusal.backend === backend)?.reason;
}

/** Whether every backend a tiny model declares can load it. */
export function tinyModelSupportsBackend(modelKey: string, backend: SeedBackend): boolean {
	return tinyModelBackendRefusal(modelKey, backend) === undefined;
}
