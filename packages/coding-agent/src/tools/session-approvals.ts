/**
 * In-memory per-session tool approval state.
 *
 * Backs the "Approve <tool> Commands for Session" and "Approve Similar <tool>
 * Commands for Session" approval-prompt options. Three grant kinds: a whole
 * tool, a recorded subject the classifier compares later calls against, and a
 * file the session may write — the last one is session-wide, so it covers the
 * same file whether `write`, `edit`, or a `bash` command reaches it.
 *
 * State is keyed by the session id the approval gate already derives from
 * `sessionManager.getSessionId()`, is never persisted to settings or session
 * files, and dies with the logical session: `AgentSession` releases the entry
 * at every conversation boundary
 * (`/new`, `/reset`, fork, rewind/branch, session switch) and on dispose via
 * `clearSessionApprovals`, so nothing survives the session that granted it —
 * not even a revival that re-opens the same session id in the same process.
 */
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";

import { hasGlobPathChars, resolveToCwd } from "./path-utils";

/** The only part of a tool `approvalSubject` needs: its approval-prompt detail lines. */
export type ApprovalSubjectTool = Pick<AgentTool, "formatApprovalDetails">;

/** Maximum recorded similar-approval subjects per tool, newest first. */
const MAX_SIMILAR_SUBJECTS = 10;

/**
 * Retention bound per recorded subject — a subject can be a whole `write`
 * payload or patch. The classifier never cuts a subject to fit its own, much
 * smaller budget (`MAX_SUBJECT_CHARS` in `approval-similarity.ts`): it skips
 * the oversized ones, so everything past that budget is retention and display
 * only.
 */
const MAX_RETAINED_SUBJECT_CHARS = 4096;

/**
 * Maximum approved file paths per session. A single `edit` call can name many
 * files, and the whole set is offered to the classifier, so it stays small
 * enough to read in one prompt; the oldest entries fall off first.
 */
const MAX_FILE_APPROVALS = 64;

/** One recorded "approve similar" grant. */
export interface SimilarApproval {
	/** Bounded display text the user approved — for display and classification only. */
	subject: string;
	/** {@link approvalIdentity} of the call's full resolved args; the only exact-repeat key. */
	identity: string;
}

export interface SessionApprovalState {
	/** Tools approved for the rest of the session, by tool name. */
	approvedTools: Set<string>;
	/** Recorded approvals per tool, newest first, capped. */
	similar: Map<string, SimilarApproval[]>;
	/**
	 * Absolute normalized files this session may write, newest inserted last.
	 *
	 * Deliberately NOT keyed by tool: the file is what the user approved, so a
	 * grant made through `write` covers the same file reached through `edit`, and
	 * a `bash` command's write target covers both. Per-tool keying would make
	 * every tool re-earn the same file.
	 */
	files: Set<string>;
}

const sessionApprovals = new Map<string, SessionApprovalState>();

function mutableState(sessionId: string): SessionApprovalState | undefined {
	if (!sessionId) return undefined;
	let state = sessionApprovals.get(sessionId);
	if (!state) {
		state = { approvedTools: new Set(), similar: new Map(), files: new Set() };
		sessionApprovals.set(sessionId, state);
	}
	return state;
}

export function isToolApprovedForSession(sessionId: string, toolName: string): boolean {
	return sessionId ? (sessionApprovals.get(sessionId)?.approvedTools.has(toolName) ?? false) : false;
}

export function approveToolForSession(sessionId: string, toolName: string): void {
	const state = mutableState(sessionId);
	if (!state) return;
	state.approvedTools.add(toolName);
	// Whole-tool approval subsumes the tool's similar list; dropping it keeps
	// the classifier prompt source bounded and the state unambiguous.
	state.similar.delete(toolName);
}

/** Record one "approve similar" grant. `identity` must come from {@link approvalIdentity}. */
export function addSimilarApproval(sessionId: string, toolName: string, subject: string, identity: string): void {
	const state = mutableState(sessionId);
	if (!state || !subject) return;
	const bounded =
		subject.length > MAX_RETAINED_SUBJECT_CHARS ? `${subject.slice(0, MAX_RETAINED_SUBJECT_CHARS - 1)}…` : subject;
	const entry: SimilarApproval = { subject: bounded, identity };
	const existing = state.similar.get(toolName) ?? [];
	// Dedup on identity, not on the bounded subject: a re-approval of the same
	// call refreshes it to newest-first, while two calls that differ only past
	// the display truncation stay two entries.
	const next = [entry, ...existing.filter(recorded => recorded.identity !== identity)];
	state.similar.set(toolName, next.slice(0, MAX_SIMILAR_SUBJECTS));
}

export function getSimilarApprovals(sessionId: string, toolName: string): readonly SimilarApproval[] {
	return sessionId ? (sessionApprovals.get(sessionId)?.similar.get(toolName) ?? []) : [];
}

/**
 * Record files the user approved writing this session. Paths must already be
 * absolute and normalized — {@link normalizeApprovalPath} is the only producer.
 */
export function addFileApprovals(sessionId: string, paths: Iterable<string>): void {
	const state = mutableState(sessionId);
	if (!state) return;
	for (const filePath of paths) {
		if (!filePath) continue;
		// Re-approval moves the path to the newest end so the cap evicts by last
		// use, not by first grant.
		state.files.delete(filePath);
		state.files.add(filePath);
	}
	for (const oldest of state.files) {
		if (state.files.size <= MAX_FILE_APPROVALS) break;
		state.files.delete(oldest);
	}
}

/** Whether `filePath` (absolute, normalized) carries a file grant this session. */
export function isFileApprovedForSession(sessionId: string, filePath: string): boolean {
	return sessionId ? (sessionApprovals.get(sessionId)?.files.has(filePath) ?? false) : false;
}

/** Approved files, newest first — the order the classifier prompt lists them in. */
export function getFileApprovals(sessionId: string): readonly string[] {
	const files = sessionId ? sessionApprovals.get(sessionId)?.files : undefined;
	return files ? [...files].reverse() : [];
}

/**
 * Whether anything recorded this session could cover a `toolName` call, i.e.
 * whether the gate has a reason to classify at all. File grants count for every
 * tool; recorded subjects only for the tool that earned them.
 */
export function hasSessionApprovalGrants(sessionId: string, toolName: string): boolean {
	const state = sessionId ? sessionApprovals.get(sessionId) : undefined;
	if (!state) return false;
	return (state.similar.get(toolName)?.length ?? 0) > 0 || state.files.size > 0;
}

/**
 * Whether no session grant may ever cover `toolName`.
 *
 * `task` runs a whole subagent: its subject is a free-form prompt with no
 * bounded operation to compare, and what it authorizes is every tool call the
 * subagent then makes behind its own approval gate. One approved delegation
 * says nothing about the next, so `task` is offered no session option and
 * honors none — including a file grant, which the subagent's own `write`/`edit`
 * calls consume on their own.
 */
export function isSessionGrantExcluded(toolName: string): boolean {
	return toolName === "task";
}

/**
 * Absolute grant key for one tool-supplied path, or `undefined` when the value
 * is not a plain filesystem path this session can pin down.
 *
 * Rejected: `scheme://` targets (internal URLs, `ssh://`, http) — those are
 * handler-owned, not files — and glob characters, which name a set that would
 * silently widen with the filesystem. Everything else resolves against the
 * call's own cwd, so a grant recorded from `src/a.ts` in one call matches an
 * absolute path in the next.
 */
export function normalizeApprovalPath(filePath: string, cwd: string): string | undefined {
	const trimmed = filePath.trim();
	if (trimmed.length === 0 || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || hasGlobPathChars(trimmed)) return undefined;
	try {
		const resolved = resolveToCwd(trimmed, cwd);
		return path.normalize(resolved);
	} catch {
		// `resolveToCwd` throws on internal schemes that survived the check above
		// (e.g. `~`-expanded ones); no grant is the fail-safe answer.
		return undefined;
	}
}

export function clearSessionApprovals(sessionId: string): void {
	sessionApprovals.delete(sessionId);
}

/**
 * Serialized values longer than this are bulk payloads (file content, patches,
 * scripts) and sort after the compact fields.
 */
const BULK_VALUE_CHARS = 96;

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	// Compact fields first, bulk payloads last, each group by key name. The
	// ordering is for `approvalSubject`'s JSON fallback: its head is what the
	// user reads in the approval prompt and all of it the retention bound keeps,
	// so a `path`/`url`-style discriminator must not sit behind a whole file's
	// content merely because its key sorts later in the alphabet. The
	// same-named helper in `../mcp/tool-cache.ts` sorts keys plainly instead —
	// different consumer, deliberately not the same function.
	const fields = Object.entries(value as Record<string, unknown>)
		.filter(entry => entry[1] !== undefined)
		.map(([key, entry]) => ({ key, json: stableStringify(entry) }))
		.sort((a, b) => {
			const bulk = Number(a.json.length > BULK_VALUE_CHARS) - Number(b.json.length > BULK_VALUE_CHARS);
			if (bulk !== 0) return bulk;
			return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
		});
	return `{${fields.map(field => `${JSON.stringify(field.key)}:${field.json}`).join(",")}}`;
}

/**
 * Exact-repeat key of a tool call: a digest of its FULL resolved arguments,
 * taken before any display truncation.
 *
 * Approval subjects are lossy twice over — every tool cuts its bulk payloads to
 * 2000 chars for the prompt (`truncateForPrompt`) and this store bounds the
 * result again — so two calls that differ only past the cut carry byte-identical
 * subject text. Matching a repeat on that text would auto-approve the second
 * one with no model and no prompt; matching on this digest cannot.
 *
 * Cryptographic on purpose. A digest hit is the strongest short-circuit in the
 * feature — `classifyApprovalSimilarity` reports the call covered on it before
 * the model, before the budget gates, and with no prompt — and both digested
 * argument sets are written by a model that may be acting on injected content.
 * So a constructed colliding pair (the benign call the user approves, plus a
 * malicious twin) is a way to run a tool unprompted, which rules out
 * `Bun.hash`: wyhash with a fixed public seed claims no collision resistance,
 * and its 64-bit output falls to a birthday search. SHA-256 costs a few
 * milliseconds even on a multi-megabyte `write` payload, once per gated call,
 * on a path that already waits up to 3 s on a model.
 */
export function approvalIdentity(args: unknown): string {
	return new Bun.CryptoHasher("sha256").update(stableStringify(args)).digest("base64url");
}

function approvalDetails(tool: ApprovalSubjectTool, args: unknown): string | undefined {
	let details: string | string[] | undefined;
	try {
		details = tool.formatApprovalDetails?.(args);
	} catch (error) {
		// Extension-supplied formatters are third-party code; a throw here must
		// not turn an approval prompt into a failed tool call.
		logger.debug("session-approvals: formatApprovalDetails failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
	const text = Array.isArray(details) ? details.filter(line => line.length > 0).join("\n") : details;
	return text && text.length > 0 ? text : undefined;
}

/**
 * Extract the comparable approval subject for a tool call.
 *
 * Preference order: the tool's own approval-prompt detail lines — the exact
 * text the user approved, and the only form that keeps the discriminating
 * field (`Path:`, `Command:`, `Action:`) at the head where the classifier's
 * truncation can't drop it — then a raw `command` string for command-shaped
 * args without a formatter, then stable JSON with bulk fields last. Kept raw:
 * the similarity classifier applies its own truncation.
 */
export function approvalSubject(tool: ApprovalSubjectTool, args: unknown): string {
	const details = approvalDetails(tool, args);
	if (details) return details;
	if (typeof args === "object" && args !== null && !Array.isArray(args)) {
		const command = (args as Record<string, unknown>).command;
		if (typeof command === "string" && command.length > 0) return command;
	}
	return stableStringify(args);
}
