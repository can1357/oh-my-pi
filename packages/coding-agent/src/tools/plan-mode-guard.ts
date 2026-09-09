import * as fs from "node:fs";
import * as path from "node:path";
import { HL_FILE_HASH_LENGTH, HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX } from "./hashline-format";
import {
	type LocalProtocolOptions,
	resolveLocalRoot,
	resolveLocalUrlToPath,
	resolveVaultUrlToPath,
} from "../internal-urls";
import type { ToolSession } from ".";
import { normalizeLocalScheme, resolveToCwd } from "./path-utils";
import { ToolError } from "./tool-errors";

const VAULT_SCHEME_PREFIX = "vault:";
const LOCAL_SCHEME_PREFIX = "local:";
const HL_TRAILING_TAG_RE = new RegExp(`${HL_FILE_HASH_SEP}[0-9A-Fa-f]{${HL_FILE_HASH_LENGTH}}$`);

/** Resolve the `local://` options the session uses, preferring its own
 *  {@link LocalProtocolOptions} (the mapping `read`/`write`/`eval` resolve
 *  through) over the bare `getArtifactsDir`/`getSessionId` pair. Subagents and
 *  multi-session hosts (cmux/ACP, embedded SDK) pin `local://` to a parent/foreign
 *  root via `localProtocolOptions`; the sandbox root the plan-mode guard derives
 *  must match where the artifact actually lives, or it rejects a legitimate plan
 *  edit (and tag-based path recovery onto the sandbox would miss it). */
export function planLocalProtocolOptions(session: ToolSession): LocalProtocolOptions {
	return (
		session.localProtocolOptions ?? {
			getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
			getSessionId: () => session.getSessionId?.() ?? null,
		}
	);
}

/** Resolve the absolute path of the session's `local://` artifact sandbox.
 *  Returns `null` when the session has no artifact wiring (e.g. tests). */
function localSandboxRoot(session: ToolSession): string | null {
	try {
		return path.resolve(resolveLocalRoot(planLocalProtocolOptions(session)));
	} catch {
		return null;
	}
}

/** True when `absolutePath` resolves inside `root` (== root or under it). */
function isWithinRoot(absolutePath: string, root: string): boolean {
	if (absolutePath === root) return true;
	const sep = `${root}${path.sep}`;
	return absolutePath.startsWith(sep);
}

/** Strip the hashline `[path#TAG]` wrapper from a write/edit target so the inner
 *  filesystem path drives both authorization and resolution. Only unwraps inputs
 *  that match the strict hashline header shape (`[path]` or `[path#XXXX]` with a
 *  4-hex tag); anything else returns the original string so the downstream
 *  resolver surfaces the real error. Exported for callers (e.g. `write`) that
 *  make scheme/bridge-routing decisions before {@link resolvePlanPath} runs. */
export function unwrapHashlineHeaderPath(targetPath: string): string {
	const trimmed = targetPath.trimEnd();
	if (
		trimmed.length < HL_FILE_PREFIX.length + HL_FILE_SUFFIX.length ||
		trimmed[0] !== HL_FILE_PREFIX ||
		trimmed[trimmed.length - 1] !== HL_FILE_SUFFIX
	) {
		return targetPath;
	}
	const inner = trimmed.slice(HL_FILE_PREFIX.length, trimmed.length - HL_FILE_SUFFIX.length);
	const tagMatch = HL_TRAILING_TAG_RE.exec(inner);
	const pathPart = tagMatch ? inner.slice(0, tagMatch.index) : inner;
	// A valid header is exactly `PATH` or `PATH#XXXX`; reject any other shape
	// (selectors, non-hex tags, embedded `#`) so we never silently rewrite a
	// path the model did not author.
	if (pathPart.length === 0 || pathPart.includes(HL_FILE_HASH_SEP)) return targetPath;
	return pathPart;
}

/** True when `targetPath` resolves into the session-local artifact sandbox.
 *  Routes through {@link resolvePlanPath} so the guard and the eventual write
 *  always agree on the absolute target (including bracketed hashline headers,
 *  `local://` URLs, and bare absolute paths). Files inside the sandbox are not
 *  part of the working tree, so plan mode treats them as freely writable
 *  scratch/plan space — and tag-based path recovery may rebind onto them. */
export function targetsLocalSandbox(session: ToolSession, targetPath: string): boolean {
	const root = localSandboxRoot(session);
	if (!root) return false;
	let resolved: string;
	try {
		resolved = resolvePlanPath(session, targetPath);
	} catch {
		return false;
	}
	if (!path.isAbsolute(resolved)) return false;
	const absolute = path.resolve(resolved);
	if (isWithinRoot(absolute, root)) return true;
	// Compare realpath-normalized forms so that `/tmp/…` vs `/private/tmp/…`
	// (macOS) and other symlink-collapsed roots both resolve to the same
	// sandbox identity.
	try {
		const realRoot = fs.realpathSync.native(root);
		if (isWithinRoot(absolute, realRoot)) return true;
		const realParent = fs.realpathSync.native(path.dirname(absolute));
		return isWithinRoot(path.join(realParent, path.basename(absolute)), realRoot);
	} catch {
		return false;
	}
}

/**
 * Resolve a write/edit target to its absolute filesystem path, honoring the
 * `local://` and `vault://` schemes. Plain paths resolve against the session cwd.
 * Bracketed hashline headers (`[path#TAG]`) are unwrapped first so the inner
 * filesystem path drives resolution — keeping the plan-mode guard and the
 * eventual write in lockstep.
 */
export function resolvePlanPath(session: ToolSession, targetPath: string): string {
	const unwrapped = unwrapHashlineHeaderPath(targetPath);
	const normalized = normalizeLocalScheme(unwrapped);
	if (normalized.startsWith(LOCAL_SCHEME_PREFIX)) {
		return resolveLocalUrlToPath(normalized, planLocalProtocolOptions(session));
	}

	if (normalized.startsWith(VAULT_SCHEME_PREFIX)) {
		return resolveVaultUrlToPath(normalized);
	}

	return resolveToCwd(normalized, session.cwd);
}

/**
 * Plan mode keeps the working tree read-only while letting the agent draft its
 * plan. Writes and edits to the `local://` artifact sandbox are allowed (that is
 * where the plan and any scratch notes live); anything that would touch the
 * working tree — or rename/delete a file — is rejected.
 */
export function enforcePlanModeWrite(
	session: ToolSession,
	targetPath: string,
	options?: { move?: string; op?: "create" | "update" | "delete" },
): void {
	const state = session.getPlanModeState?.();
	if (!state?.enabled) return;

	if (options?.move) {
		throw new ToolError("Plan mode: renaming files is not allowed.");
	}

	if (options?.op === "delete") {
		throw new ToolError("Plan mode: deleting files is not allowed.");
	}

	if (targetsLocalSandbox(session, targetPath)) return;

	throw new ToolError(
		"Plan mode: the working tree is read-only. Write your plan to a local://<slug>-plan.md file instead.",
	);
}
