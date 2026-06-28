/**
 * Shared ACP client bridge routing for file-write sites.
 *
 * When an ACP client (e.g. Zed) advertises the `fs.writeTextFile` capability,
 * all write-mode tools must route through it so the editor's open buffer is
 * updated immediately. Internal artifacts ('/Users/theo/.omp/agent/sessions/-Projects-oh-my-pi/2026-06-10T09-11-41-506Z_019eb0cd-3ec2-7000-92aa-1b82aa4d78f0/local' plan files, other scheme
 * URLs) are always written directly to disk — those are OMP-owned and should
 * never be pushed into the editor.
 */
import type { ToolSession } from ".";
import { invalidateFsScanAfterWrite } from "./fs-cache-invalidation";
import { isInternalUrlPath } from "./path-utils";
import { resolvePlanPath, targetsLocalSandbox } from "./plan-mode-guard";
import { ToolError } from "./tool-errors";

/**
 * Return `true` when an ACP client bridge write is appropriate for this path.
 *
 * Returns `false` for internal-URL paths (e.g. `'/Users/theo/.omp/agent/sessions/-Projects-oh-my-pi/2026-06-10T09-11-41-506Z_019eb0cd-3ec2-7000-92aa-1b82aa4d78f0/local/PLAN.md'`) and for the
 * active plan file while plan mode is enabled — both are OMP-internal artifacts
 * that must stay off the editor's buffer.
 */
export function shouldRouteWriteThroughBridge(
	session: ToolSession,
	requestedPath: string,
	absolutePath: string,
): boolean {
	if (isInternalUrlPath(requestedPath)) return false;
	// OMP-owned session artifacts (plan files, scratch notes) must stay off the
	// editor buffer even when addressed by their absolute sandbox path — e.g.
	// after tag-based path recovery rebinds a bare `plan.md#tag` onto the
	// `local://` artifact, `requestedPath` is the absolute path, not the URL.
	if (targetsLocalSandbox(session, absolutePath)) return false;

	const state = session.getPlanModeState?.();
	if (!state?.enabled || !isInternalUrlPath(state.planFilePath)) return true;

	return absolutePath !== resolvePlanPath(session, state.planFilePath);
}

/**
 * Try to route a file write through the ACP client bridge.
 *
 * Performs the full guard check, bridge call (wrapped in {@link ToolError}),
 * FS-scan cache invalidation, and session mutation-version bump.
 *
 * Returns `true` when the bridge was used and the caller must skip the
 * writethrough path. Returns `false` when the bridge is unavailable or the
 * path should not be routed through it.
 */
export async function routeWriteThroughBridge(
	session: ToolSession,
	requestedPath: string,
	absolutePath: string,
	content: string,
): Promise<boolean> {
	if (!shouldRouteWriteThroughBridge(session, requestedPath, absolutePath)) return false;

	const bridge = session.getClientBridge?.();
	if (!bridge?.capabilities.writeTextFile || !bridge.writeTextFile) return false;

	try {
		await bridge.writeTextFile({ path: absolutePath, content });
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}

	invalidateFsScanAfterWrite(absolutePath);
	session.bumpFileMutationVersion?.(absolutePath);
	return true;
}
