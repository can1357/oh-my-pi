/**
 * Identity of the omp build running in this process, stamped into session files so a
 * transcript records which code produced each entry.
 *
 * Installed builds (compiled binary, package install) record only their version. A source
 * checkout records the commit, branch, and a hash of its uncommitted diff, because its
 * version string stays the same across every unreleased commit and local edit.
 */
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { $env, isCompiledBinary, isRecord, logger, VERSION } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "./session-entries";

export interface RuntimeIdentity {
	/** omp package version. */
	version: string;
	/** Source checkout commit; absent for installed builds. */
	commit?: string;
	/** Source checkout branch; absent on a detached HEAD. */
	branch?: string;
	/**
	 * Hash of the checkout's uncommitted tracked changes (`git diff HEAD`); absent when clean,
	 * `unknown` when the diff could not be read (too large) or has not been read yet.
	 */
	diff?: string;
	/** Free-form name from `OMP_BUILD_LABEL`. */
	label?: string;
}

const MAX_LABEL_LENGTH = 80;
const MAX_DIFF_BYTES = 64 * 1024 * 1024;
const SOURCE_PACKAGE_PREFIX = "packages/coding-agent/";
const UNKNOWN_DIFF = "unknown";

let current: RuntimeIdentity | undefined;
let ready: Promise<void> = Promise.resolve();

/** Git handle of the checkout this module runs from; null for compiled binaries and package installs. */
function findSourceCheckout(): VcsGitRepo | null {
	// A git repository found above a node_modules install belongs to some other project.
	if (isCompiledBinary() || import.meta.dir.split(/[\\/]/).includes("node_modules")) return null;
	const repo = vcs.git(import.meta.dir);
	return repo?.prefixOf(import.meta.dir)?.startsWith(SOURCE_PACKAGE_PREFIX) ? repo : null;
}

async function readUncommittedDiff(repo: VcsGitRepo, identity: RuntimeIdentity): Promise<void> {
	let patch: string | null;
	try {
		patch = await repo.diffText({ base: "HEAD", binary: true, maxBytes: MAX_DIFF_BYTES });
	} catch (error) {
		logger.debug("Could not read the source checkout diff", { error: String(error) });
		patch = null;
	}
	current = {
		...identity,
		diff: patch === null ? UNKNOWN_DIFF : patch ? Bun.hash(patch).toString(16).padStart(16, "0") : undefined,
	};
}

/**
 * Resolves the identity on first use, not at import, so commands that never write a session skip
 * the VCS reads. Commit and branch resolve synchronously; only the diff hash is asynchronous.
 */
function resolveRuntimeIdentity(): RuntimeIdentity {
	if (current) return current;
	const label = $env.OMP_BUILD_LABEL?.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
	current = { version: VERSION, label: label || undefined };
	try {
		const repo = findSourceCheckout();
		const head = repo?.headSync();
		if (repo && head?.commit) {
			current = { ...current, commit: head.commit, branch: head.branch ?? undefined, diff: UNKNOWN_DIFF };
			ready = readUncommittedDiff(repo, current);
		}
	} catch (error) {
		logger.debug("Could not resolve source checkout identity", { error: String(error) });
	}
	return current;
}

/** Starts resolution if needed and settles once the source checkout's diff is read; session entry points await it before writing. */
export function loadRuntimeIdentity(): Promise<void> {
	resolveRuntimeIdentity();
	return ready;
}

/** Build identity of this process; a source checkout's `diff` is `unknown` until {@link loadRuntimeIdentity} settles. */
export function currentRuntimeIdentity(): RuntimeIdentity {
	return resolveRuntimeIdentity();
}

/**
 * Whether two stamps can name the same build. An `unknown` diff matches any diff of the same commit:
 * entries written before the diff was read carry it, and it carries no information to tell builds apart.
 */
export function sameRuntimeIdentity(
	a: RuntimeIdentity | null | undefined,
	b: RuntimeIdentity | null | undefined,
): boolean {
	if (!a || !b) return !a && !b;
	return (
		a.version === b.version &&
		a.commit === b.commit &&
		a.branch === b.branch &&
		(a.diff === b.diff || a.diff === UNKNOWN_DIFF || b.diff === UNKNOWN_DIFF) &&
		a.label === b.label
	);
}

const OPTIONAL_FIELDS = ["commit", "branch", "diff", "label"] as const;

/** Stamps are read back from session files without validation; a malformed one counts as unstamped. */
function stampOf(entry: SessionEntry): RuntimeIdentity | null {
	const runtime: unknown = entry.runtime;
	if (!isRecord(runtime) || typeof runtime.version !== "string") return null;
	for (const field of OPTIONAL_FIELDS) {
		if (runtime[field] !== undefined && typeof runtime[field] !== "string") return null;
	}
	return runtime as unknown as RuntimeIdentity;
}

/**
 * Builds that wrote the entries, in file order, collapsing consecutive repeats. `null` stands
 * for entries without a stamp (written before builds were recorded, or replicated without one).
 */
export function runtimeIdentityHistory(entries: readonly SessionEntry[]): Array<RuntimeIdentity | null> {
	const history: Array<RuntimeIdentity | null> = [];
	for (const entry of entries) {
		const writer = stampOf(entry);
		const last = history.length > 0 ? history[history.length - 1] : undefined;
		if (last === undefined || !sameRuntimeIdentity(writer, last)) history.push(writer);
		// A run that began before its diff was read is listed under the diff it read.
		else if (last?.diff === UNKNOWN_DIFF && writer?.diff !== UNKNOWN_DIFF) history[history.length - 1] = writer;
	}
	return history;
}

/** One-line label, e.g. `18.10.4`, `18.10.4 will/topic@a1b2c3d4e5 +diff 3f2a9c01 "variant-a"`. */
export function formatRuntimeIdentity(identity: RuntimeIdentity | null | undefined): string {
	if (!identity) return "unknown";
	let text = identity.version;
	if (identity.commit) text += ` ${identity.branch ? `${identity.branch}@` : ""}${identity.commit.slice(0, 10)}`;
	if (identity.diff) text += ` +diff ${identity.diff.slice(0, 8)}`;
	if (identity.label) text += ` "${identity.label}"`;
	return text;
}
