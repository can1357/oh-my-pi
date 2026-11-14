import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { InternalUrlRouter } from "../internal-urls";
import { sessionResolveContext } from "../internal-urls/context";
import type { ToolSession } from ".";
import { unwrapHashlineHeaderPath } from "./hashline-header-path";
import { resolveToCwd } from "./path-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** Where a write to `absolutePath` lands: its deepest existing ancestor realpathed, with
 *  the missing tail re-appended. `undefined` when the path goes through a dangling
 *  symlink (the write would follow it somewhere unknowable) or cannot be inspected. */
async function canonicalWritePath(absolutePath: string): Promise<string | undefined> {
	const tail: string[] = [];
	for (let current = absolutePath; ; current = path.dirname(current)) {
		try {
			return path.join(await fs.realpath(current), ...tail);
		} catch (error) {
			if (!isEnoent(error)) return undefined;
		}
		try {
			await fs.lstat(current);
			return undefined;
		} catch (error) {
			if (!isEnoent(error)) return undefined;
		}
		if (path.dirname(current) === current) return undefined;
		tail.unshift(path.basename(current));
	}
}

/** True when `absolutePath` resolves inside `root` (== root or under it). */
function isWithinRoot(absolutePath: string, root: string): boolean {
	if (absolutePath === root) return true;
	const sep = `${root}${path.sep}`;
	return absolutePath.startsWith(sep);
}

/** True when `targetPath` resolves into the session-local artifact sandbox.
 *  Routes through {@link resolvePlanPath} so the guard and the eventual write
 *  always agree on the absolute target (including bracketed hashline headers,
 *  internal URLs, and bare absolute paths). Files inside the sandbox are not
 *  part of the working tree, so plan mode treats them as freely writable
 *  scratch/plan space — and tag-based path recovery may rebind onto them. */
export async function targetsLocalSandbox(
	session: ToolSession,
	targetPath: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const roots = InternalUrlRouter.instance().sandboxRoots(sessionResolveContext(session, { signal }));
	if (roots.length === 0) return false;
	let resolved: string;
	try {
		resolved = await resolvePlanPath(session, targetPath, signal);
	} catch {
		return false;
	}
	if (!path.isAbsolute(resolved)) return false;
	// Compare where the write actually lands (symlinked ancestors, `/tmp` vs
	// `/private/tmp` on macOS) against the equally canonicalized roots.
	const target = await canonicalWritePath(path.resolve(resolved));
	if (target === undefined) return false;
	for (const root of roots) {
		const realRoot = await canonicalWritePath(root);
		if (realRoot !== undefined && isWithinRoot(target, realRoot)) return true;
	}
	return false;
}

/**
 * Resolve a write/edit target to its absolute filesystem path. Internal URLs
 * locate through their scheme handler (the entry need not exist yet); URLs no
 * local file backs throw the router's uniform error. Plain paths resolve
 * against the session cwd. Bracketed hashline headers (`[path#TAG]`) are
 * unwrapped first so the inner filesystem path drives resolution — keeping the
 * plan-mode guard and the eventual write in lockstep. Locating uses the session's
 * read context (same `local://` mapping), and `signal` aborts a vault root lookup.
 */
export async function resolvePlanPath(session: ToolSession, targetPath: string, signal?: AbortSignal): Promise<string> {
	const router = InternalUrlRouter.instance();
	const normalized = router.normalize(unwrapHashlineHeaderPath(targetPath));
	if (router.canHandle(normalized)) {
		return router.requireLocal(normalized, "write", sessionResolveContext(session, { signal }), { create: true });
	}
	return resolveToCwd(normalized, session.cwd);
}

/**
 * Plan mode keeps the working tree read-only while letting the agent draft its
 * plan. Writes and edits to the `local://` artifact sandbox are allowed (that is
 * where the plan and any scratch notes live); anything that would touch the
 * working tree — or rename/delete a file — is rejected.
 */
export async function enforcePlanModeWrite(
	session: ToolSession,
	targetPath: string,
	options?: { move?: string; op?: "create" | "update" | "delete"; signal?: AbortSignal },
): Promise<void> {
	const state = session.getPlanModeState?.();
	if (!state?.enabled) return;

	if (options?.move) {
		throw new ToolError("Plan mode: renaming files is not allowed.");
	}

	if (options?.op === "delete") {
		throw new ToolError("Plan mode: deleting files is not allowed.");
	}

	if (await targetsLocalSandbox(session, targetPath, options?.signal)) return;

	throw new ToolError(
		"Plan mode: the working tree is read-only. Write your plan to a local://<slug>-plan.md file instead.",
	);
}
