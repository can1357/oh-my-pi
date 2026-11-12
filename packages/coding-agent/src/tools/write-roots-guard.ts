import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { InternalUrlRouter, sessionResolveContext } from "../internal-urls";
import type { ToolSession } from ".";
import { unwrapHashlineHeaderPath } from "./hashline-header-path";
import { resolveToCwd } from "./path-utils";
import { cfgToolsWriteRoots } from "./settings";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/**
 * Opt-in write confinement (`tools.writeRoots`).
 *
 * When set, the write-capable file tools (`write`, `edit` including
 * rename/delete, `ast_edit`) may only touch files inside the configured
 * roots (e.g. `["."]` for the session cwd). Reads are never restricted, and
 * `workspace.additionalDirectories` grants no write access. The check runs at
 * tool-execution time — after approval resolution — so it holds in every
 * approval mode including `yolo`, in headless `omp -p` sessions (where it
 * fails as a tool error, never an approval prompt), and in subagents, which
 * inherit the setting with their session.
 *
 * Symlink boundary (resolve-then-check): both the target and each root are
 * compared by where they physically land — the deepest existing ancestor is
 * realpath-resolved with the missing tail re-appended, exactly like plan
 * mode's guard. An existing symlink is resolved outright; a dangling symlink
 * (or any otherwise unresolvable path, whose destination cannot be judged)
 * is refused. Symlink-swap races between the check and the write (TOCTOU)
 * are out of scope, same as the plan-mode guard.
 */

/** Configured roots for this call, or `undefined` when confinement is off. */
export function writeRoots(session: ToolSession): readonly string[] | undefined {
	const roots = cfgToolsWriteRoots.get(session.settings);
	if (roots.length === 0) return undefined;
	return roots;
}

/** Where a write to `absolutePath` physically lands (see module docs). */
async function canonicalWriteTarget(absolutePath: string): Promise<string | undefined> {
	const tail: string[] = [];
	for (let current = absolutePath; ; current = path.dirname(current)) {
		try {
			return path.join(await fs.realpath(current), ...tail);
		} catch (error) {
			if (!isEnoent(error)) return undefined;
		}
		try {
			await fs.lstat(current);
			// Exists but unresolvable (dangling symlink): the write would
			// follow it somewhere this cannot name — refuse outright.
			return undefined;
		} catch (error) {
			if (!isEnoent(error)) return undefined;
		}
		if (path.dirname(current) === current) return undefined;
		tail.unshift(path.basename(current));
	}
}

/** True when `absolutePath` is `root` or under it (both canonicalized). */
function isWithinRoot(absolutePath: string, root: string): boolean {
	if (absolutePath === root) return true;
	return absolutePath.startsWith(`${root}${path.sep}`);
}

/**
 * Resolve one configured root entry the way tool paths resolve: relative to
 * the session cwd, with `~` expansion, then canonicalized to where it
 * physically lands. Throws {@link ToolError} when the entry cannot be
 * inspected (fail closed: a root that cannot be judged confines nothing).
 */
async function canonicalRoot(session: ToolSession, entry: string): Promise<string> {
	const absolute = resolveToCwd(entry, session.cwd);
	const canonical = await canonicalWriteTarget(path.resolve(absolute));
	if (canonical === undefined) {
		throw new ToolError(
			`tools.writeRoots misconfigured: cannot resolve root '${entry}' (dangling symlink or missing ancestor).`,
		);
	}
	return canonical;
}

function rootsSummary(canonicalRoots: readonly string[]): string {
	return canonicalRoots.join(", ");
}

function refusalMessage(authored: string, canonicalRoots: readonly string[]): string {
	return (
		`Write outside allowed roots (tools.writeRoots): '${authored}' is not inside ` +
		`${rootsSummary(canonicalRoots)}. Reads stay unrestricted; adjust tools.writeRoots to allow this path.`
	);
}

/**
 * Enforce write confinement for one already-resolved absolute filesystem path.
 * No-op when `tools.writeRoots` is unset. Throws {@link ToolError} naming the
 * root violation otherwise.
 */
export async function enforceWriteRootsAbsolute(
	session: ToolSession,
	absolutePath: string,
	options?: { authored?: string; roots?: readonly string[]; canonicalRoots?: readonly string[]; signal?: AbortSignal },
): Promise<void> {
	const entries = options?.roots ?? writeRoots(session);
	if (!entries || entries.length === 0) return;
	options?.signal?.throwIfAborted();
	const canonicalRoots =
		options?.canonicalRoots ?? (await Promise.all(entries.map(entry => canonicalRoot(session, entry))));
	const target = await canonicalWriteTarget(path.resolve(absolutePath));
	if (target !== undefined && canonicalRoots.some(root => isWithinRoot(target, root))) return;
	throw new ToolError(refusalMessage(options?.authored ?? absolutePath, canonicalRoots));
}

/**
 * Resolve an authored write/edit target to its absolute filesystem path the
 * way the tools do (hashline header unwrapped, internal URLs located with
 * creation allowed), or `undefined` when the target is not a filesystem write
 * subject to confinement: handler/device/coordination writes (e.g. `xd://`
 * dispatches, which carry no path) and URLs no local file backs (which fail
 * on their own error downstream).
 */
export async function resolveWriteTargetAbsolute(
	session: ToolSession,
	authoredPath: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const router = InternalUrlRouter.instance();
	const normalized = router.normalize(unwrapHashlineHeaderPath(authoredPath));
	if (router.canHandle(normalized)) {
		if (!router.fileWritable(normalized)) return undefined;
		try {
			return await router.requireLocal(normalized, "write", sessionResolveContext(session, { signal }), {
				create: true,
			});
		} catch {
			return undefined;
		}
	}
	return resolveToCwd(normalized, session.cwd);
}

/**
 * Enforce write confinement for authored `write`/`edit` targets (plain paths
 * and file-backed internal URLs). Rename sources and destinations each pass
 * through here, so renames are covered on both sides; deletes pass their
 * target. Non-filesystem writes are left to their own gates (see
 * {@link resolveWriteTargetAbsolute}).
 */
export async function enforceWriteRoots(
	session: ToolSession,
	authoredPaths: readonly string[],
	signal?: AbortSignal,
): Promise<void> {
	const entries = writeRoots(session);
	if (!entries || entries.length === 0) return;
	signal?.throwIfAborted();
	const canonicalRoots = await Promise.all(entries.map(entry => canonicalRoot(session, entry)));
	for (const authored of authoredPaths) {
		signal?.throwIfAborted();
		const absolute = await resolveWriteTargetAbsolute(session, authored, signal);
		if (absolute === undefined) continue;
		const target = await canonicalWriteTarget(path.resolve(absolute));
		if (target !== undefined && canonicalRoots.some(root => isWithinRoot(target, root))) continue;
		throw new ToolError(refusalMessage(authored, canonicalRoots));
	}
}
