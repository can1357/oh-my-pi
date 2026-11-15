/**
 * Process-wide Antigravity CLI workspace-isolation default.
 *
 * Kept free of runtime provider imports so settings registration can configure
 * the default without loading the ACP transport eagerly.
 */
import { $flag } from "@oh-my-pi/pi-utils";

let configuredIsolateWorkspace = true;

/**
 * Set the process-wide default for passing an empty workspace directory to `agy`.
 * Covers direct `streamSimple`/`completeSimple` callers without session settings.
 */
export function configureAntigravityCliIsolateWorkspace(enabled: boolean | undefined): void {
	configuredIsolateWorkspace = enabled ?? true;
}

/** Effective workspace-isolation mode: explicit request option, then `PI_AGY_ISOLATE_WORKSPACE`, then host default (`true`). */
export function resolveAntigravityCliIsolateWorkspace(option?: boolean): boolean {
	return option ?? $flag("PI_AGY_ISOLATE_WORKSPACE", configuredIsolateWorkspace);
}
