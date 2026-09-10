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
 * TUI event controller for the approval-title heuristic, which has no business
 * loading the native edit inspector.
 */
import { type EditInspection, editInspect } from "@oh-my-pi/pi-natives";
import { isRecord } from "@oh-my-pi/pi-utils";
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

/**
 * Dialects an `edit` call's `input` may be written in, probed in this order
 * until one names a file. `apply_patch` first: hashline bodies prefix every
 * row with `+`, so the envelope scan cannot misread one, whereas the hashline
 * header scan takes an apply-patch context line ` [x]` for a section. `sloppy`
 * answers only to its own `<SM:EDIT path=…>` opener.
 */
const INPUT_DIALECTS = ["apply_patch", "hashline", "sloppy"];

/** Authored file effects of one `edit` call, in any of its wire shapes. */
function editFileEffects(args: Record<string, unknown>): { writes: string[]; removes: boolean } {
	// `patch` and `replace` name one `path` (a patch entry may delete or move
	// it away); every `input` dialect names its own files. The inspectors read
	// partial payloads, so a malformed patch still yields the paths it names —
	// harmless, since an edit that never applies writes nothing.
	const modes = Array.isArray(args.edits) ? ["patch"] : typeof args.input === "string" ? INPUT_DIALECTS : ["replace"];
	const argsJson = JSON.stringify(args);
	for (const mode of modes) {
		let inspection: EditInspection;
		try {
			inspection = editInspect(mode, argsJson);
		} catch {
			// A parse failure must not escape into the approval gate.
			continue;
		}
		const { paths, fileOps } = inspection;
		if (paths.length === 0 && fileOps.length === 0) continue;
		// A path the call deletes or moves away from is not a path it writes; a
		// move writes its destination instead.
		const takenAway = new Set(fileOps.map(op => op.path));
		const writes = paths.filter(path => !takenAway.has(path));
		for (const op of fileOps) {
			if (op.kind === "move" && op.to) writes.push(op.to);
		}
		return { writes, removes: fileOps.length > 0 };
	}
	return { writes: [], removes: false };
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
