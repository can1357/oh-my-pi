/**
 * What a pending tool call does to files, read straight out of its resolved
 * arguments.
 *
 * Only `write` and `edit` are covered: their arguments name their targets
 * exactly, so a session file grant can match them without asking a model. Every
 * other tool (notably `bash`, whose targets live inside a shell command) reports
 * nothing and relies on the similarity classifier to name what it writes.
 *
 * Own module, not part of `session-approvals.ts`: the store is imported by the
 * TUI event controller for the approval-title heuristic, and the edit-mode
 * parsers pulled in here drag the whole `../edit` graph behind them.
 */
import { Patch } from "@oh-my-pi/hashline";
import { isRecord } from "@oh-my-pi/pi-utils";
import { expandApplyPatchToEntries } from "../edit";
import { normalizeApprovalPath } from "./session-approvals";

/** File effects of one tool call, as far as its own arguments state them. */
export interface ToolFileEffects {
	/**
	 * Absolute normalized files the call creates, modifies, or truncates — the
	 * one effect a session file grant covers. Paths `normalizeApprovalPath`
	 * refuses (URLs, globs) are dropped.
	 */
	writes: readonly string[];
	/**
	 * The call also takes a path away: a delete, or the source of a move. A
	 * grant to write a file never answers that, so such a call is refused
	 * outright rather than judged.
	 */
	removes: boolean;
}

/** Authored file effects of one `edit` call, in either of its two wire shapes. */
function editFileEffects(args: Record<string, unknown>): { writes: string[]; removes: boolean } {
	const writes: string[] = [];
	let removes = false;
	// `replace` and `patch` modes: one `path`, which a patch entry may delete or
	// move away. `op: "create"` ignores a `rename`, so only the other ops move.
	const filePath = typeof args.path === "string" ? args.path : undefined;
	if (Array.isArray(args.edits)) {
		for (const entry of args.edits) {
			if (!isRecord(entry)) continue;
			if (entry.op === "delete") removes = true;
			else if (entry.op !== "create" && typeof entry.rename === "string") {
				removes = true;
				writes.push(entry.rename);
			}
		}
	}
	// A path the call deletes or moves away from is not a path it writes.
	if (filePath !== undefined && !removes) writes.push(filePath);
	const input = typeof args.input === "string" ? args.input : undefined;
	if (!input) return { writes, removes };
	// `hashline` mode: every section header is a separate target, `REM` deletes
	// its file and `MV` writes the destination instead of the source. Parsing can
	// throw on a malformed patch — an edit that never applies grants nothing.
	try {
		const sections = Patch.parse(input).sections;
		for (const section of sections) {
			const fileOp = section.fileOp;
			if (fileOp?.kind === "rem") removes = true;
			else if (fileOp?.kind === "move") {
				removes = true;
				writes.push(fileOp.dest);
			} else writes.push(section.path);
		}
		if (sections.length > 0) return { writes, removes };
	} catch {
		// Not a hashline patch (or not a valid one) — try the apply-patch envelope.
	}
	try {
		for (const entry of expandApplyPatchToEntries({ input })) {
			if (entry.op === "delete") removes = true;
			else if (entry.op !== "create" && entry.rename) {
				removes = true;
				writes.push(entry.rename);
			} else writes.push(entry.path);
		}
	} catch {
		// Neither wire shape parsed; the call names no file this gate can pin down.
	}
	return { writes, removes };
}

/**
 * File effects `toolName` has with `args`, with every path resolved against
 * `cwd`. `undefined` for every tool whose effects are not readable from
 * arguments — those are the model's to name, and nothing structural may answer
 * for them.
 */
export function toolFileEffects(toolName: string, args: unknown, cwd: string): ToolFileEffects | undefined {
	if (!isRecord(args)) return undefined;
	const authored =
		toolName === "write"
			? { writes: typeof args.path === "string" ? [args.path] : [], removes: false }
			: toolName === "edit"
				? editFileEffects(args)
				: undefined;
	if (!authored) return undefined;
	const writes: string[] = [];
	for (const authoredPath of authored.writes) {
		const normalized = normalizeApprovalPath(authoredPath, cwd);
		if (normalized && !writes.includes(normalized)) writes.push(normalized);
	}
	return { writes, removes: authored.removes };
}

/**
 * Working directory one tool call acts in: `bash` may redirect itself with its
 * own `cwd` argument, every other tool resolves paths against the session's.
 */
export function toolCallCwd(toolName: string, args: unknown, sessionCwd: string): string {
	if (toolName !== "bash" || !isRecord(args) || typeof args.cwd !== "string" || args.cwd.length === 0) {
		return sessionCwd;
	}
	return normalizeApprovalPath(args.cwd, sessionCwd) ?? sessionCwd;
}
