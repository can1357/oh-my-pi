/**
 * In-session fallbacks for permission-denied file writes and deletes.
 *
 * A host that embeds the agent inside an OS sandbox can grant a path mid-session
 * but cannot apply that grant to an in-process write, because the write happens
 * in the agent process under a profile fixed at launch. This module gives such a
 * host a seam to intercept a denied mutation and perform it through a privileged
 * channel, without reimplementing `write`/`edit` semantics: the native tool still
 * records its own snapshot under the real destination path once the fallback
 * reports success, so a follow-up hashline `edit` on that path keeps working.
 *
 * Writes and deletes have SEPARATE registries. A write handler brokers `content`
 * to `dst`, so a delete request reaching it with no content invites brokering an
 * empty write and truncating the file it was asked to remove. Opting into deletes
 * is therefore explicit; see {@link addFileDeleteFallback}.
 *
 * ## What is routed
 *
 * The byte-write that `write`, `edit` and `apply_patch` perform on an ordinary
 * file path goes through the same two-line primitive
 * (`file ? file.write(content) : Bun.write(dst, content)`). It has four call
 * sites, and all of them route here:
 *
 * - `writethroughNoop` and `runLspWritethrough`'s `writeContent` (`lsp/writethrough.ts`),
 *   the `WritethroughCallback` that `write` and `edit` both write through.
 *   `apply_patch` reaches it too: `LspFileSystem.write` (`edit/modes/patch.ts`),
 *   which it always injects, delegates to the same callback.
 * - `HashlineFilesystem.move` (`edit/hashline/filesystem.ts`) — a hashline `MV`
 *   destination, the one `edit` write that does not pass through the writethrough.
 * - `defaultFileSystem.write` (`edit/modes/patch.ts`), only the default parameter
 *   for external `applyPatch` callers and tests.
 *
 * `apply_patch` also creates a missing parent directory before writing, via its
 * filesystem's `mkdir`. That `mkdir` consults {@link hasFileWriteFallback} so a
 * denial there falls through to the write and reaches a handler, instead of
 * throwing before the seam is ever consulted.
 *
 * The unlink that `edit` and `apply_patch` perform routes to the separate delete
 * seam ({@link deleteFileWithFallback}) at four sites: `HashlineFilesystem.delete`
 * (`edit`'s `REM`) and `HashlineFilesystem.move`'s source unlink, plus
 * `LspFileSystem.delete` and `defaultFileSystem.delete` for `apply_patch`.
 *
 * ## What is NOT routed
 *
 * This is deliberately not an exhaustive interception of every syscall the tools
 * can make. A permission error from any of these surfaces as it does today:
 *
 * - `write` to an archive member (`foo.zip:entry`) or a SQLite row. Neither is a
 *   byte-write to `dst`: an archive member rewrite reads the whole archive, sets
 *   one entry, writes a temp file and renames over the original, so the bytes on
 *   disk are a whole binary container rather than the string the tool was given;
 *   a SQLite write is a row operation inside the database engine with no byte
 *   payload at all. Brokering either needs a different request shape than
 *   "these exact bytes belong at this path".
 * - `acp-bridge.ts`'s `bridge.writeTextFile` — a remote-client transport.
 * - Removing a DIRECTORY is never the intent: the delete seam refuses to divert a
 *   target it can confirm is one, and reports `confirmedFile: false` when the
 *   target's metadata is behind the same boundary and the check cannot be resolved.
 * - The `lsp` tool's own writes: applying a workspace edit or a code action
 *   (`lsp/edits.ts`), and the Biome formatter, which writes the buffer and then
 *   shells out to `biome format --write` (`lsp/clients/biome-client.ts`) — a
 *   subprocess write no in-process seam can reach anyway.
 *
 * ## Diverting
 *
 * Only a permission boundary diverts — `EPERM`, `EACCES`, `EROFS`, plus the one
 * case where Bun hides such a denial behind an `ENOENT` (see
 * {@link classifyWriteFailure}). Every other error rethrows untouched.
 *
 * With no handler registered this module is inert: the primitive runs exactly as
 * it did before, a failure rethrows from the same place, and no extra syscalls
 * are performed.
 *
 * ## The path a handler is given
 *
 * A handler is more privileged than the syscall that just failed, so it is never
 * handed the lexical path the tool used. A lexical path is not a destination: the
 * kernel follows every component above the last, so `ws/link/file` under a
 * `ws/link -> /elsewhere` link lands outside `ws` while still looking
 * in-workspace. That defeats the defence a helper author reaches for first, since
 * a prefix allowlist passes on the link's own path — and for writes the final
 * component is followed too, so a plain `ws/link` is enough.
 *
 * `req.dst` is therefore resolved through {@link resolveSyscallTarget} to the path
 * the failed syscall itself acted on: fully for a write, and up to the last
 * component for a delete, since `unlink` removes a link rather than following it.
 * Resolving rather than refusing also closes the TOCTOU window, because the
 * handler no longer traverses a link the agent could re-point after the check.
 *
 * A path that cannot be canonicalized — a dangling final link, or an ancestor
 * whose own resolution is denied — is not brokered at all. "Where would this
 * land" has no answer there, and a privileged writer is the wrong place to guess.
 * That narrows the seam for a sandbox that also hides the ancestors of a denied
 * path, which is the honest cost of not handing over an unverifiable target.
 *
 * That refusal is load-bearing for more than symlink safety, and relaxing it needs
 * care. `apply_patch`'s `create` and rename-destination refuse to overwrite, and
 * they decide that with `Bun.file(dst).exists()`, which reports `false` when the
 * parent hides the target's metadata rather than distinguishing "absent" from
 * "unknown". The non-overwrite contract holds today only because the same denied
 * `lstat` that fools that check also stops this seam from brokering — a privileged
 * writer, the one party that could enforce exclusivity itself, is never handed the
 * path. Broker an unverifiable destination and a `create` starts clobbering a
 * protected file it was told not to touch; a request field carrying explicit
 * exclusive-create intent would be the prerequisite for that change.
 *
 * ## Scope of the registry
 *
 * Handlers live in one process-wide list, and a process can host several sessions
 * (a subagent gets its own `ExtensionRunner`). A handler is therefore consulted
 * for denied mutations from ANY session in the process, not only the one whose
 * extension registered it. Filtering by session here would be wrong: a subagent
 * spawned with `restrictToolNames` loads no extensions of its own, so scoping
 * would leave its denied writes with nothing to broker them, and a host that
 * registers once in its top-level session expects subagent writes covered.
 *
 * So the request names its origin instead, and the policy stays with the party
 * that owns it. `req.sessionId` is the session that issued the mutation (see
 * {@link withFileMutationSession}); a handler compares it with
 * `ctx.sessionManager.getSessionId()` to decide. That matters most for a handler
 * that prompts: `ctx.ui` belongs to the session whose extension registered the
 * handler, which is not necessarily the session being asked about.
 *
 * Each list is iterated over a snapshot, because a concurrent session shutdown
 * splices the live array and a `for` over it would skip whichever handler shifted
 * into the hole.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isFsError, logger } from "@oh-my-pi/pi-utils";
import type { BunFile } from "bun";
import type { ExtensionContext } from "../extensibility/extensions/types";
import { resolveSyscallTarget } from "./path-utils";

/** A denied write, captured for a registered fallback to retry through a privileged channel. */
export interface FileWriteFallbackRequest {
	/**
	 * Absolute, symlink-resolved path to write the bytes to.
	 *
	 * This is where the failed in-process write would itself have landed, which is
	 * not necessarily the path the tool was given: `open` follows every component,
	 * so a link anywhere in that path redirects the bytes. Resolving it here is
	 * what lets a handler's allowlist see the real destination instead of a
	 * lexically innocent path, so a handler MUST treat this as authoritative and
	 * MUST NOT re-derive the target from anything else.
	 */
	dst: string;
	/**
	 * Session the denied write was issued from, or `undefined` when the mutation
	 * did not happen inside a tool call (an external `applyPatch` caller, a test).
	 *
	 * The registry is process-wide, so a handler can be consulted for a write from
	 * a session other than the one whose extension registered it. Compare this with
	 * `ctx.sessionManager.getSessionId()` to tell the two apart — a handler that
	 * prompts through `ctx.ui` needs to, since that UI belongs to ITS session and
	 * not necessarily to the one being asked about.
	 */
	sessionId: string | undefined;
	/** The exact bytes the tool intended to write. */
	content: string;
	/**
	 * The error that proves the write hit a permission boundary. Usually the write's
	 * own `EPERM`/`EACCES`/`EROFS`; for a write into a directory the host may not
	 * create, the denial raised by creating that directory, in which case `dst`'s
	 * parent may not exist yet and the handler is responsible for creating it.
	 */
	cause: unknown;
}

/** Extension-authored handler. Return `true` once `content` is durably on disk at `dst`. */
export type FileWriteFallbackHandler = (req: FileWriteFallbackRequest, ctx: ExtensionContext) => Promise<boolean>;

/** A handler already bound to its owning extension's live context. */
type BoundFileWriteFallbackHandler = (req: FileWriteFallbackRequest) => Promise<boolean>;

/** A denied unlink, captured for a registered fallback to perform through a privileged channel. */
export interface FileDeleteFallbackRequest {
	/**
	 * Absolute, symlink-resolved path the unlink was denied for.
	 *
	 * Every component ABOVE the last is resolved, so a handler cannot be walked
	 * outside its allowed roots through a link in the path. The last component is
	 * deliberately NOT resolved, because `unlink` removes a link itself rather
	 * than its target — which is also why this may still name a symlink.
	 */
	dst: string;
	/** The `EPERM`/`EACCES`/`EROFS` that proves the unlink hit a permission boundary. */
	cause: unknown;
	/**
	 * Whether `dst` was confirmed to be a plain regular file before diverting.
	 *
	 * `false` means the seam could not establish that, either because the target's
	 * own metadata is behind the same boundary that denied the unlink — the common
	 * sandbox case, since `unlink` on a directory also reports `EPERM` on Darwin —
	 * or because `dst` is a symlink.
	 *
	 * A handler MUST remove `dst` with a plain unlink. It MUST NOT remove it
	 * recursively, and MUST NOT resolve the path first: when this is `false` the
	 * target may be a directory, and resolving a symlink would delete whatever it
	 * points at instead of the link.
	 */
	confirmedFile: boolean;
	/** See {@link FileWriteFallbackRequest.sessionId}. */
	sessionId: string | undefined;
}

/** Extension-authored handler. Return `true` once `dst` is gone from disk. */
export type FileDeleteFallbackHandler = (req: FileDeleteFallbackRequest, ctx: ExtensionContext) => Promise<boolean>;

/** A handler already bound to its owning extension's live context. */
type BoundFileDeleteFallbackHandler = (req: FileDeleteFallbackRequest) => Promise<boolean>;

const PERMISSION_DENIED_CODES: Record<string, true> = { EPERM: true, EACCES: true, EROFS: true };
const PERMISSION_DENIED_MESSAGE = /\b(EPERM|EACCES|EROFS)\b/;

/** True for `EPERM`, `EACCES`, and `EROFS` — the sandbox-boundary write failures this seam exists for. */
export function isPermissionDeniedError(error: unknown): boolean {
	// A structured `code` is authoritative. Checking the message as well would
	// misclassify any error whose path contains one of these names, and Bun embeds
	// the full path in its fs error messages (`ENOENT: ..., open '/x/EACCES/y'`).
	if (isFsError(error)) return PERMISSION_DENIED_CODES[error.code] === true;
	// Some write paths (e.g. a bridged transport) surface the denial as a plain
	// Error with no structured `code`, leaving only the message to go on.
	return error instanceof Error && PERMISSION_DENIED_MESSAGE.test(error.message);
}

const fallbackHandlers: BoundFileWriteFallbackHandler[] = [];

/** Whether any fallback is registered. Lets a caller skip work that only this seam needs. */
export function hasFileWriteFallback(): boolean {
	return fallbackHandlers.length > 0;
}

/**
 * Append a fallback writer, consulted in registration order when a direct write is
 * permission-denied. Returns a disposer that removes this exact registration; the
 * runner calls it on session shutdown so no handler outlives its session.
 */
export function addFileWriteFallback(handler: BoundFileWriteFallbackHandler): () => void {
	fallbackHandlers.push(handler);
	return () => {
		const index = fallbackHandlers.indexOf(handler);
		if (index !== -1) fallbackHandlers.splice(index, 1);
	};
}

const deleteFallbackHandlers: BoundFileDeleteFallbackHandler[] = [];

/** Whether any delete fallback is registered. */
export function hasFileDeleteFallback(): boolean {
	return deleteFallbackHandlers.length > 0;
}

/**
 * Append a fallback deleter, consulted in registration order when a direct unlink is
 * permission-denied. Deliberately a separate registry from
 * {@link addFileWriteFallback}: a write handler brokers `content` to `dst`, and
 * handing it a request with no content would let it "broker" an empty write and
 * truncate the file it was asked to remove. Opting in is explicit for that reason.
 */
export function addFileDeleteFallback(handler: BoundFileDeleteFallbackHandler): () => void {
	deleteFallbackHandlers.push(handler);
	return () => {
		const index = deleteFallbackHandlers.indexOf(handler);
		if (index !== -1) deleteFallbackHandlers.splice(index, 1);
	};
}

const mutationSessionStorage = new AsyncLocalStorage<string>();

/**
 * Name the session whose tool call is about to run, so a denied mutation inside it
 * can tell a handler where the request came from.
 *
 * Entered once per tool call by `ExtensionToolWrapper` (`extensibility/extensions/
 * wrapper.ts`), which `sdk.ts` puts around the whole tool registry whenever an
 * `ExtensionRunner` exists — so the component that owns the handlers is the one
 * naming its own session, and no caller has to thread an `AgentToolContext`
 * through for attribution to work.
 *
 * That covers the deferred LSP write batch too: a batch id belongs to one
 * assistant turn of one session, and its flush is awaited inside a tool call of
 * that same session, so a write performed during a later call of the group is
 * still attributed to the session that issued it.
 *
 * Deliberately NOT a general "current session" accessor: nothing else enters this
 * scope, so outside a tool call it is empty by design — an external `applyPatch`
 * caller reports `undefined` rather than borrowing someone else's identity.
 */
export function withFileMutationSession<T>(sessionId: string | undefined, fn: () => T): T {
	// With nothing registered no scope is entered, keeping the seam's inertness
	// promise: a stock host pays one length check per tool call and no more.
	if (sessionId === undefined || (fallbackHandlers.length === 0 && deleteFallbackHandlers.length === 0)) return fn();
	return mutationSessionStorage.run(sessionId, fn);
}

/**
 * Remove a file, consulting registered delete fallbacks when the unlink is denied.
 *
 * Unlike the write path there is no masked-`ENOENT` case to see through: nothing is
 * created on the way, so an `ENOENT` here means the file genuinely is not there and
 * must propagate — `edit`'s `REM` turns it into a `NotFoundError`.
 */
export async function deleteFileWithFallback(dst: string, file?: BunFile): Promise<void> {
	try {
		if (file) {
			await file.unlink();
		} else {
			await fs.unlink(dst);
		}
	} catch (error) {
		if (deleteFallbackHandlers.length === 0 || !isPermissionDeniedError(error)) throw error;
		// A handler is more privileged than the unlink that just failed, so it is told
		// which path really gets removed, not the lexical one the tool used. `unlink`
		// follows every component ABOVE the last, so `ws/link/victim` under a
		// `ws/link -> /elsewhere` link removes a file outside `ws` while a helper's
		// prefix allowlist still passes. The final component is deliberately left
		// unresolved: `unlink` removes the link itself, never its target.
		const target = await resolveSyscallTarget(dst, false);
		if (target === null) throw error;
		// `unlink` on a directory reports EPERM on Darwin (EISDIR on Linux), which is
		// indistinguishable from a sandbox denial by code alone, so check the target
		// before diverting: asking a privileged deleter to remove a DIRECTORY on
		// behalf of a tool that only ever removes one file would far exceed the
		// intent. `lstat` rather than `stat`, so the link itself is judged — removing
		// a symlink is a legitimate file removal, and following it here would ask the
		// wrong question.
		const stat = await fs.lstat(target).catch((statError: unknown) => {
			// A sandbox that denies the unlink usually denies the target's metadata
			// too, so a denied `lstat` is expected here and must still divert — it
			// just leaves the question unresolved, which `confirmedFile` reports.
			// Any OTHER `lstat` failure is not something this seam should paper over.
			if (isPermissionDeniedError(statError)) return null;
			throw error;
		});
		if (stat?.isDirectory()) throw error;
		// A symlink is safe to unlink but NOT safe to resolve: a helper that
		// realpaths `dst` for auditing, or removes it recursively, would act on the
		// link's target instead. Only a plain regular file is a confirmed file.
		const confirmedFile = stat?.isFile() ?? false;
		// The process-wide registry can hand this to a handler from another session,
		// so the request names the one that issued it.
		const sessionId = mutationSessionStorage.getStore();
		// Snapshot: a concurrent session shutdown splices the live array, and
		// iterating it directly would skip whichever handler shifted into the hole.
		for (const handler of [...deleteFallbackHandlers]) {
			try {
				if (await handler({ dst: target, cause: error, confirmedFile, sessionId })) return;
			} catch (handlerError) {
				logger.warn("File delete fallback handler threw; trying next handler", {
					dst: target,
					error: handlerError instanceof Error ? handlerError.message : String(handlerError),
				});
			}
		}
		// Always the ORIGINAL error, never a handler's, so behaviour matches a host
		// with no fallback registered.
		throw error;
	}
}

/**
 * Outcome of inspecting a failed primitive write. `denied` diverts to the
 * registered handlers, `retry` repeats the write because this call repaired the
 * cause, and `rethrow` leaves the original error alone.
 */
type WriteFailureKind = { kind: "denied"; cause: unknown } | { kind: "retry" } | { kind: "rethrow" };

/**
 * Decide whether a failed write hit a permission boundary.
 *
 * `Bun.write` and `BunFile.write` create missing parent directories themselves,
 * but when that `mkdir` is the thing being denied they report the subsequent
 * `open()`'s `ENOENT` rather than the denial — so a sandboxed write into a new
 * out-of-tree directory is indistinguishable from an ordinary missing path.
 * Redoing the `mkdir` explicitly recovers the real errno, and because it runs
 * through the same enforcement path as the write it sees kernel-level denials
 * (Seatbelt, LSM) that a `stat`/`access` probe would report as writable.
 *
 * Only called with at least one handler registered, so a stock host never pays
 * for this.
 */
async function classifyWriteFailure(dst: string, error: unknown): Promise<WriteFailureKind> {
	if (isPermissionDeniedError(error)) return { kind: "denied", cause: error };
	if (!isEnoent(error)) return { kind: "rethrow" };
	try {
		await fs.mkdir(path.dirname(dst), { recursive: true });
	} catch (mkdirError) {
		// A denied `mkdir` is the boundary the write hid; anything else (`ENOTDIR`
		// for a file used as a directory, ...) is a genuine bad path.
		if (isPermissionDeniedError(mkdirError)) return { kind: "denied", cause: mkdirError };
		return { kind: "rethrow" };
	}
	// The parent exists now, so the `ENOENT` was a lost race rather than a
	// boundary. Any directory just created stays, matching what a permitted
	// `Bun.write` would have left behind; removing it could race a concurrent
	// writer that legitimately needs it.
	return { kind: "retry" };
}

export async function writeFileWithFallback(dst: string, content: string, file?: BunFile): Promise<void> {
	// Attempt 0 is the plain write. The single retry is reachable only when the
	// first failure turned out to be a parent-directory race this call repaired,
	// which bounds the loop at two writes.
	for (let attempt = 0; ; attempt++) {
		try {
			if (file) {
				await file.write(content);
			} else {
				await Bun.write(dst, content);
			}
			return;
		} catch (error) {
			if (fallbackHandlers.length === 0) throw error;
			// On the second attempt a `retry` verdict can no longer change the
			// outcome, so skip the probe and let the error stand unless it is a
			// denial the handlers should see.
			const failure =
				attempt === 0
					? await classifyWriteFailure(dst, error)
					: isPermissionDeniedError(error)
						? ({ kind: "denied", cause: error } as const)
						: ({ kind: "rethrow" } as const);
			if (failure.kind === "retry") continue;
			if (failure.kind === "denied") {
				// A handler is more privileged than the write that just failed, so it is
				// told where the bytes would REALLY have landed rather than the lexical
				// path the tool used. `open` follows EVERY component, so `ws/link/file`
				// under a `ws/link -> /elsewhere` link writes outside `ws` while still
				// looking in-workspace — which defeats the defence a helper author
				// reaches for first, since a prefix allowlist passes on the link's own
				// path. Resolving closes that, and closes the TOCTOU window with it: the
				// helper no longer traverses a link the agent could re-point after the
				// check. A path that cannot be canonicalized is not brokered at all,
				// because "where would this land" then has no answer to hand over.
				const target = await resolveSyscallTarget(dst, true);
				// Snapshot: a concurrent session shutdown splices the live array, and
				// iterating it directly would skip whichever handler shifted into the hole.
				if (target !== null) {
					// The process-wide registry can hand this to a handler from another
					// session, so the request names the one that issued it.
					const sessionId = mutationSessionStorage.getStore();
					for (const handler of [...fallbackHandlers]) {
						try {
							if (await handler({ dst: target, content, cause: failure.cause, sessionId })) return;
						} catch (handlerError) {
							logger.warn("File write fallback handler threw; trying next handler", {
								dst: target,
								error: handlerError instanceof Error ? handlerError.message : String(handlerError),
							});
						}
					}
				}
			}
			// Always the ORIGINAL error, never a handler's, so behaviour matches a
			// host with no fallback registered. When the real boundary was recovered
			// from behind a masked `ENOENT`, attach it so the denial is not lost:
			// without this the caller is told `ENOENT` for a path this code has
			// already proven is `EACCES`.
			if (failure.kind === "denied" && failure.cause !== error && error instanceof Error && error.cause == null) {
				error.cause = failure.cause;
			}
			throw error;
		}
	}
}
