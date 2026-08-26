/**
 * Auto-checkpoint triggers and post-rollback cache/LSP invalidation.
 *
 * Three independent seams, all opt-in and inert unless `checkpoints.enabled`
 * (and the relevant `checkpoints.auto.*` flag) is set at event time:
 *
 * 1. **gitOperations** — when the agent loop is about to run a bash tool whose
 *    command is a destructive git operation (`reset --hard`, `clean -f`, a
 *    whole-tree `restore`/`checkout`, `push --force`, `branch -D`, `rebase`),
 *    capture a workspace checkpoint *before* the command mutates anything.
 * 2. **riskyEdits** — when an edit application would touch at least
 *    {@link RISKY_EDIT_FILE_THRESHOLD} files in one call (the `apply_patch`
 *    multi-file seam), capture a checkpoint before applying.
 * 3. **rollback invalidation** — when a rollback completes, drop stale
 *    filesystem scan caches and refresh LSP for the affected workspace root.
 *
 * The before-tool triggers are driven by `emitInternalBeforeToolCall`, which the
 * agent loop calls from `session/agent-session.ts` `#beforeToolCall` (the same
 * dispatch point that emits the extension `tool_call` event) — a first-class
 * internal subscriber list, so extensions are never affected. A checkpoint is
 * always created *before* the tool proceeds; a failed capture is logged and
 * swallowed so it can never become a foot-gun that blocks the user's command.
 */

import { invalidateFsScanCache } from "@oh-my-pi/pi-natives";
import { logger, toError } from "@oh-my-pi/pi-utils";
import { isSettingsInitialized, settings } from "../config/settings";
import { FileChangeType, notifyWorkspaceWatchedFiles } from "../lsp/client";
import { onWorkspaceRolledBack, type WorkspaceRolledBackEvent } from "./notify";
import { WorkspaceCheckpointService } from "./service";

/** Files touched by a single edit application that arms the risky-edits trigger. */
export const RISKY_EDIT_FILE_THRESHOLD = 5;

/** Minimum gap between two automatic checkpoints of the same session/workspace. */
export const AUTO_CHECKPOINT_DEBOUNCE_MS = 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// Destructive git command matching
// ─────────────────────────────────────────────────────────────────────────────

export interface DestructiveGitMatch {
	/** Human-readable verb used to label the checkpoint, e.g. `"reset"`. */
	readonly verb: string;
}

/**
 * Matchers run in priority order; the first hit wins. Every matcher requires a
 * literal `git` subcommand and restricts the destructive subcommand to the same
 * simple command (no shell separators `;|&` cross into it). Dry-run and scoped
 * variants are deliberately excluded so the trigger never fires on safe ops.
 */
const DESTRUCTIVE_GIT_MATCHERS: readonly { verb: string; test: (command: string) => boolean }[] = [
	{
		verb: "reset",
		test: command => /\bgit\b[^;|&]*\breset\b[^;|&]*--hard\b/.test(command),
	},
	{
		verb: "clean",
		test: isDestructiveClean,
	},
	{
		verb: "restore",
		test: command => /\bgit\b[^;|&]*\brestore\b/.test(command) && hasWholeTreeDot(command),
	},
	{
		verb: "checkout",
		test: command => /\bgit\b[^;|&]*\bcheckout\b/.test(command) && hasWholeTreeDot(command),
	},
	{
		// `--force-with-lease` is excluded: `--force` must be a whole flag token.
		verb: "push",
		test: command => /\bgit\b[^;|&]*\bpush\b[^;|&]*\s--force(?=\s|$)/.test(command),
	},
	{
		verb: "branch",
		test: command => /\bgit\b[^;|&]*\bbranch\b[^;|&]*\s-D\b/.test(command),
	},
	{
		// Resolution continuations (`--abort`/`--continue`/…) are the safe way out
		// of an in-flight rebase and must not capture.
		verb: "rebase",
		test: command =>
			/\bgit\b[^;|&]*\brebase\b/.test(command) && !/--(?:abort|continue|skip|quit|edit-todo)\b/.test(command),
	},
];

/** True when `command` is a destructive git operation; returns the matched verb. */
export function matchDestructiveGit(command: string): DestructiveGitMatch | undefined {
	if (typeof command !== "string" || command.length === 0) return undefined;
	if (!/\bgit\b/i.test(command)) return undefined;
	for (const matcher of DESTRUCTIVE_GIT_MATCHERS) {
		if (matcher.test(command)) return { verb: matcher.verb };
	}
	return undefined;
}

/** `git clean -f`/`-fd`/`-fdx` (force, recursive) but never `-n` (dry-run). */
function isDestructiveClean(command: string): boolean {
	if (/\bgit\b[^;|&]*\bclean\b/.test(command) === false) return false;
	// `-f`, `-fd`, `-fdx`, `-fxd` (force), not `-n` (dry-run). `-nf` is dry-run.
	const hasForce = /(?:^|\s)-f[dx]*(?=\s|$)/.test(command);
	if (!hasForce) return false;
	if (/(?:^|\s)-n\b/.test(command)) return false;
	return true;
}

/** True when the command's operand is the whole tree (a bare `.` path). */
function hasWholeTreeDot(command: string): boolean {
	// Matches ` .`, ` -- .`, ` .;`, ` .&`, ` .|` — a `.` path argument, but not
	// `..`, `./foo`, or `.bashrc` (those are parent dirs / scoped paths).
	return /(?:^|\s)(?:--\s+)?\.(?=\s|$)/.test(command);
}

/**
 * Number of distinct files a single edit application will touch. The `apply_patch`
 * mode is the only genuine multi-file seam (its `*** (Add|Update|Delete) File:`
 * markers), so that is what arms the risky-edits trigger; `patch`/`hashline`/
 * `sloppy` modes address at most one file and never arm it.
 */
export function countEditFiles(toolName: string, args: unknown): number {
	if (toolName !== "edit") return 0;
	if (args === null || typeof args !== "object") return 0;
	const record = args as Record<string, unknown>;
	const input = typeof record.input === "string" ? record.input : undefined;
	if (input !== undefined) {
		const markers = input.match(/^\*\*\* (?:Add|Update|Delete) File:/gm);
		return markers ? markers.length : 0;
	}
	if (typeof record.path === "string") return 1;
	return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal before-tool-call subscriber list
// ─────────────────────────────────────────────────────────────────────────────

export interface InternalBeforeToolEvent {
	readonly toolName: string;
	readonly args: unknown;
	readonly cwd: string;
	readonly sessionId: string;
	readonly signal?: AbortSignal;
}

type InternalBeforeToolListener = (event: InternalBeforeToolEvent) => void | Promise<void>;

const internalBeforeToolListeners = new Set<InternalBeforeToolListener>();

/** Subscribe to every before-tool-call event. Returns the unsubscribe handle. */
export function subscribeInternalBeforeToolCall(fn: InternalBeforeToolListener): () => void {
	internalBeforeToolListeners.add(fn);
	return () => {
		internalBeforeToolListeners.delete(fn);
	};
}

/**
 * Fan out a before-tool-call event to internal subscribers. A throwing listener
 * is logged and skipped so one broken consumer cannot block the others or the
 * tool that is about to run.
 */
export async function emitInternalBeforeToolCall(event: InternalBeforeToolEvent): Promise<void> {
	for (const fn of [...internalBeforeToolListeners]) {
		try {
			await fn(event);
		} catch (error) {
			logger.debug("auto-checkpoint before-tool listener failed", { error: toError(error).message });
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Wire the auto-checkpoint triggers and rollback invalidation. Returns an
 * unsubscribe handle that detaches both. Registration is unconditional; every
 * gate is read from settings at event time, so with defaults this is inert.
 *
 * The subscription is process-wide and idempotent: repeated calls (one per
 * session construction) return the same handle, so a destructive op never
 * captures more than one checkpoint.
 */

/** The three opt-in gates, resolved at event time. Defaults consult live settings. */
export interface AutoCheckpointFlags {
	enabled(): boolean;
	gitOperations(): boolean;
	riskyEdits(): boolean;
}

export interface RegisterAutoCheckpointsDeps {
	/** Fallbacks used when an event omits session/cwd context. */
	getSessionId?: () => string;
	getCwd?: () => string;
	getService?: () => WorkspaceCheckpointService;
	/** Gate overrides; omit to read `checkpoints.*` from live settings. */
	flags?: Partial<AutoCheckpointFlags>;
}

function readFlag(key: "checkpoints.auto.gitOperations" | "checkpoints.auto.riskyEdits"): boolean {
	if (!isSettingsInitialized()) return false;
	return Boolean(settings.get(key));
}

function defaultFlags(): AutoCheckpointFlags {
	return {
		// Inert while settings are uninitialized (early boot).
		enabled: () => isSettingsInitialized() && Boolean(settings.get("checkpoints.enabled")),
		gitOperations: () => readFlag("checkpoints.auto.gitOperations"),
		riskyEdits: () => readFlag("checkpoints.auto.riskyEdits"),
	};
}

let activeRegistration: (() => void) | null = null;

/**
 * Wire the auto-checkpoint triggers and rollback invalidation. Returns an
 * unsubscribe handle that detaches both. Registration is unconditional; gates
 * resolve at event time (settings by default), so this is inert until enabled.
 *
 * Last-wins: a newer registration (newest session) supersedes an older one.
 */
export function registerAutoCheckpoints(deps: RegisterAutoCheckpointsDeps): () => void {
	const getService = deps.getService ?? (() => WorkspaceCheckpointService.global());
	if (activeRegistration) activeRegistration();
	const beforeToolUnsub = subscribeInternalBeforeToolCall(event => handleBeforeTool(event, deps, getService));
	const rollbackUnsub = onWorkspaceRolledBack(event => handleWorkspaceRolledBack(event));
	const unsubscribe = () => {
		beforeToolUnsub();
		rollbackUnsub();
		if (activeRegistration === unsubscribe) activeRegistration = null;
	};
	activeRegistration = unsubscribe;
	return unsubscribe;
}

async function handleBeforeTool(
	event: InternalBeforeToolEvent,
	deps: RegisterAutoCheckpointsDeps,
	getService: () => WorkspaceCheckpointService,
): Promise<void> {
	const flags = { ...defaultFlags(), ...deps.flags };
	// Inert when the feature is off (default readers also require initialized settings).
	if (!flags.enabled()) return;
	const cwd = event.cwd || deps.getCwd?.() || process.cwd();
	const sessionId = event.sessionId || deps.getSessionId?.() || "";
	const service = getService();

	try {
		if (flags.gitOperations() && event.toolName === "bash") {
			const command = extractStringArg(event.args, "command") ?? extractStringArg(event.args, "input");
			const match = command ? matchDestructiveGit(command) : undefined;
			if (match) {
				await createAutoCheckpoint(service, sessionId, cwd, `before ${match.verb}`, "git", event.signal);
				return;
			}
		}
		if (flags.riskyEdits() && event.toolName === "edit") {
			const fileCount = countEditFiles(event.toolName, event.args);
			if (fileCount >= RISKY_EDIT_FILE_THRESHOLD) {
				await createAutoCheckpoint(service, sessionId, cwd, `before ${fileCount}-file edit`, "edit", event.signal);
			}
		}
	} catch (error) {
		// Unexpected logic error must never escape the hook path.
		logger.warn("auto-checkpoint trigger failed", { toolName: event.toolName, error: toError(error).message });
	}
}

async function createAutoCheckpoint(
	service: WorkspaceCheckpointService,
	sessionId: string,
	cwd: string,
	label: string,
	kind: string,
	signal?: AbortSignal,
): Promise<void> {
	try {
		// Cheap early-out: skip when an automatic checkpoint already landed very
		// recently. `service.create` additionally dedups identical working trees,
		// so this only trims redundant captures during rapid repeats.
		const latest = await service.latest(sessionId, cwd);
		if (
			latest &&
			latest.reason === "auto" &&
			Number.isFinite(Date.parse(latest.createdAt)) &&
			Date.now() - Date.parse(latest.createdAt) < AUTO_CHECKPOINT_DEBOUNCE_MS
		) {
			return;
		}
		await service.create({ sessionId, cwd, reason: "auto", label, signal });
	} catch (error) {
		// Best-effort safety net: a capture failure must not block the command.
		logger.warn("auto-checkpoint capture failed", { kind, label, error: toError(error).message });
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-rollback invalidation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drop stale caches for the workspace that was just rolled back. Each step is
 * failure-isolated; `notify.onWorkspaceRolledBack` additionally isolates this
 * listener from any other registered listener.
 */
export function invalidateWorkspaceAfterRollback(worktreePath: string): void {
	// (a) Filesystem scan cache: `invalidateFsScanCache(path)` removes every cached
	// scan whose root is a prefix of `worktreePath` (see docs/fs-scan-cache-
	// architecture.md). The whole workspace root is the broadest safe invalidation.
	try {
		invalidateFsScanCache(worktreePath);
	} catch (error) {
		logger.debug("fs scan cache invalidation after rollback failed", {
			worktreePath,
			error: toError(error).message,
		});
	}

	// (b) LSP: a `didChangeWatchedFiles` refresh keyed by workspace root is the
	// available affordance (no full restart-by-cwd API exists). Clients for the
	// root are filtered inside `notifyWorkspaceWatchedFiles`; if none are active
	// the call is a no-op.
	void notifyWorkspaceWatchedFiles(worktreePath, [{ filePath: worktreePath, type: FileChangeType.Changed }]).catch(
		(error: unknown) => {
			logger.debug("LSP refresh after rollback failed", { worktreePath, error: toError(error).message });
		},
	);

	// (c) File-read caches: the read tool keeps no cross-call content cache — only
	// a per-instance repeat-read counter (see tools/read.ts `[kRepeatReadTracker]`),
	// which is not keyed by mtime and does not survive the rolled-back process.
	// There is therefore nothing to invalidate; a no-op here is correct, not an
	// oversight.
}

function handleWorkspaceRolledBack(event: WorkspaceRolledBackEvent): void {
	invalidateWorkspaceAfterRollback(event.checkpoint.identity.worktreePath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function extractStringArg(args: unknown, key: string): string | undefined {
	if (args === null || typeof args !== "object") return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}
