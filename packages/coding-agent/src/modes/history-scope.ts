import { normalizePathForComparison } from "@oh-my-pi/pi-utils";
import {
	HISTORY_SCOPE_KINDS,
	type HistoryScope,
	type HistoryScopeKind,
	type HistoryStorage,
} from "../session/history-storage";
import { repoRootOrNull } from "../utils/active-repo-context";

/** Context a configured recall scope is resolved against. */
export interface HistoryScopeContext {
	/** Persistent conversation id (`SessionManager.getSessionId()`). */
	sessionId: string;
	/** Project directory prompts are written with (`getProjectDir()`). */
	cwd: string;
}

/**
 * Resolve a configured scope to the predicate reads use.
 *
 * A scope whose subject is unavailable falls back to `cwd` — never to `global`, so a
 * misconfigured or context-less scope cannot surface another project's prompts. `cwd` is
 * always available, and `repo` is unavailable outside a repository (its predicate would
 * then be indistinguishable from `cwd` while claiming otherwise).
 */
export function resolveHistoryScope(kind: HistoryScopeKind, context: HistoryScopeContext): HistoryScope {
	switch (kind) {
		case "global":
			return { kind: "global" };
		case "session":
			return context.sessionId ? { kind: "session", value: context.sessionId } : { kind: "cwd", value: context.cwd };
		case "repo": {
			const root = repoRootOrNull(context.cwd);
			return root ? { kind: "repo", value: root } : { kind: "cwd", value: context.cwd };
		}
		default:
			return { kind: "cwd", value: context.cwd };
	}
}

/**
 * Identity of a resolved scope. The editor compares it to detect that its backing data set
 * changed; it is never parsed, so only distinctness matters. The kind is part of the key:
 * at a repository root, `cwd` and `repo` carry the same value but read different sets.
 *
 * Directory-valued scopes are keyed by their normalized spelling, so the same folder reached
 * through a symlink (or with different Windows casing) does not look like a new data set —
 * which would re-seed the editor and drop recalled drafts for no reason.
 */
export function historyScopeKey(scope: HistoryScope): string {
	const directoryScoped = scope.kind === "cwd" || scope.kind === "repo";
	const value = directoryScoped && scope.value ? normalizePathForComparison(scope.value) : (scope.value ?? "");
	return `${scope.kind}\u0000${value}`;
}

/**
 * Scopes offered to history search, narrowest first, rotated so the resolved `start` scope
 * comes first. Scopes without a subject are dropped rather than labelled misleadingly.
 *
 * The rotation uses the *resolved* start scope, so a start configuring `repo` outside a
 * repository opens on `cwd` — the scope the reads actually use — instead of `global`.
 */
export function historyScopeRing(start: HistoryScopeKind, context: HistoryScopeContext): HistoryScope[] {
	const available = HISTORY_SCOPE_KINDS.filter(kind => {
		if (kind === "session") return context.sessionId.length > 0;
		if (kind === "repo") return repoRootOrNull(context.cwd) !== null;
		return true;
	}).map(kind => resolveHistoryScope(kind, context));
	const startKind = resolveHistoryScope(start, context).kind;
	const startIndex = available.findIndex(scope => scope.kind === startKind);
	if (startIndex <= 0) return available;
	return [...available.slice(startIndex), ...available.slice(0, startIndex)];
}

/**
 * Adapt `storage` to the editor's scope-free interface, resolving `scope` on every read.
 *
 * Resolution is lazy by design: the editor keeps one storage for its whole lifetime while
 * the conversation, the directory or the `history.scope` setting change underneath it, so a
 * scope captured at install time would keep serving the previous context.
 */
export function bindHistoryScope(
	storage: HistoryStorage,
	scope: () => HistoryScope,
): Pick<HistoryStorage, "add" | "getRecent"> {
	return {
		add: (prompt, cwd) => storage.add(prompt, cwd),
		getRecent: limit => storage.getRecent(limit, scope()),
	};
}

/** A storage bound to a live scope, plus the key an editor re-seeds on when that scope changes. */
export interface HistorySource {
	storage: Pick<HistoryStorage, "add" | "getRecent">;
	/** Identity of the scope in effect right now; distinct values mean a different data set. */
	sourceKey: () => string;
}

/**
 * Bind `storage` to a live `resolveScope` for a history editor: both the reads and the key the
 * editor compares come from the same resolution, so a host cannot install one without the other
 * — the composition is the contract, and the editor's recall scope is only correct when both
 * halves name the same data set.
 */
export function bindHistorySource(storage: HistoryStorage, resolveScope: () => HistoryScope): HistorySource {
	return {
		storage: bindHistoryScope(storage, resolveScope),
		sourceKey: () => historyScopeKey(resolveScope()),
	};
}
