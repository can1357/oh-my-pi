/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Edit (and apply_patch): a file change as its diff.
 *
 * The call reads its target from whatever the payload grammar gives first
 * (`path`, `edits[]`, a hashline `[path]` header, an apply_patch or sloppy
 * envelope, the streamed JSON) and shows the streamed preview: a computed
 * diff, the replacement text, per-file previews of a multi-file payload, or
 * a magic payload's described changes. The result shows each file's diff
 * (or error) with its LSP diagnostics; several files read as one section
 * each, plus a spinner for files still pending.
 *
 * The terminal look (`src/ui/styles/tools/edit.ts`) draws from `term.edit`:
 * one framed card (or inline row for a delete or a plain move) per file,
 * with the raw diff text the old renderer drew.
 */
import { editInspect } from "@oh-my-pi/pi-natives";
import { parseCompactDiff } from "@oh-my-pi/pi-tui/text/diff";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { splitMagicSections } from "../../edit/magic-sections";
import { normalizeEditMode } from "../../edit/settings";
import type {
	EditMode,
	EditToolDetails,
	EditToolPerFileResult,
	Operation,
	PerFileDiffPreview,
} from "../../tools/details/edit";
import {
	HASHLINE_TAG_SUFFIX_RE,
	HL_FILE_PREFIX,
	HL_FILE_SUFFIX,
	HL_MOVE_KEYWORD,
	HL_REM_KEYWORD,
} from "../../tools/hashline-format";
import { ErrorText, NoteText } from "./agent-common";
import type { ToolActivity, ToolHead, ToolPresenter, ToolResult, ToolView, ToolViewState } from "./contract";
import { resultText } from "./default";
import {
	DiagnosticsSection,
	diagnosticsBadge,
	displayPath,
	type FileDiagnostics,
	fileHref,
	pendingLinkPath,
} from "./file-common";
import { registerToolPresenter } from "./registry";

export interface EditArgs {
	readonly path?: unknown;
	readonly file_path?: unknown;
	readonly oldText?: unknown;
	readonly newText?: unknown;
	readonly new_string?: unknown;
	readonly patch?: unknown;
	readonly input?: unknown;
	readonly _input?: unknown;
	readonly op?: Operation;
	readonly rename?: unknown;
	readonly diff?: unknown;
	readonly previewDiff?: unknown;
	readonly __partialJson?: unknown;
	readonly edits?: readonly {
		readonly path?: unknown;
		readonly rename?: unknown;
		readonly move?: unknown;
		readonly op?: Operation;
	}[];
}

type EditDiffPreview = { readonly diff?: string; readonly firstChangedLine?: number; readonly error?: string };

/** What the transcript threads to an edit call (the host's preview computations). */
interface EditContext {
	readonly editMode?: EditMode;
	readonly editDiffPreview?: EditDiffPreview;
	readonly perFileDiffPreview?: readonly PerFileDiffPreview[];
	readonly editStreamingFallback?: string;
	/** A streaming edit's pushed preview (diffs per file). */
	readonly streamPreview?: { readonly files?: readonly PerFileDiffPreview[] };
}

// ─── Terminal facts ─────────────────────────────────────────────────────────

/** One part of a card's body, as the terminal draws it. */
export type EditBodyPart =
	/** A streamed diff's tail (`… (content above)` when cut). */
	| { readonly k: "stream"; readonly diff: string; readonly path: string }
	/** Per-file streamed previews under `── path ──` rules. */
	| { readonly k: "files"; readonly files: readonly PerFileDiffPreview[] }
	/** Replacement text: its first lines. */
	| { readonly k: "text"; readonly text: string }
	/** A host-rendered fallback, drawn as is. */
	| { readonly k: "raw"; readonly text: string }
	/** A result's diff: hunks trimmed to a preview while collapsed. */
	| { readonly k: "diff"; readonly diff: string; readonly path: string }
	| { readonly k: "error"; readonly text: string }
	/** An apply_patch parse error, one cut line. */
	| { readonly k: "patchError"; readonly text: string }
	| { readonly k: "note"; readonly text: string }
	| { readonly k: "diagnostics"; readonly diagnostics: FileDiagnostics };

/** One file's card (or inline row). */
export interface EditCard {
	/** `inline`: a delete or plain move as one status row. */
	readonly kind: "card" | "inline";
	readonly title: string;
	readonly path: string;
	readonly rename?: string;
	/** The files `path` and `rename` link to, and the line `path` opens at. */
	readonly link?: { readonly path?: string; readonly rename?: string; readonly line?: number };
	/** Further files of the call (`(+N more)`). */
	readonly more?: number;
	/** The head glyph: the spinner while args stream, a still status glyph, or none. */
	readonly icon: "spin" | "pending" | "error" | "success" | "edit" | "delete" | "move";
	readonly stats?: { readonly added: number; readonly removed: number };
	readonly body: readonly EditBodyPart[];
	/** Label in the bottom edge while collapsed (`preview`) or while args stream (`streaming`). */
	readonly footer?: "preview" | "streaming";
	readonly phase: "pending" | "partial" | "success" | "error";
}

/** `term.edit`: the cards, files still pending, and whether spinners turn. */
export interface EditTerm {
	readonly cards: readonly EditCard[];
	readonly pending?: number;
}

// ─── Payload facts ──────────────────────────────────────────────────────────

interface FileEntry {
	readonly path: string;
	op?: Operation;
	rename?: string;
	/** A PUT/CUT line edit precedes the file op (a hashline move stays framed). */
	hasLineEdits?: boolean;
}

interface CallFacts {
	readonly rawPath: string;
	readonly rename?: string;
	readonly op?: Operation;
	/** Distinct files the call touches (0 when unknown). */
	readonly fileCount: number;
	readonly applyPatchError?: string;
	readonly hasLineEdits: boolean;
}

const MISSING_APPLY_PATCH_END = "The last line of the patch must be '*** End Patch'";
const TYPED_TAG = new RegExp(HASHLINE_TAG_SUFFIX_RE.source, "i");
const LINE_OP_HEADER = /^(?:PUT|CUT)\b/;
const PARTIAL_JSON_PATH = /"path"\s*:\s*"((?:\\.|[^"\\])*)/u;

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function payloadOf(args: EditArgs): string | undefined {
	return str(args.input) ?? str(args._input);
}

/** A magic payload: mode `replace` (whose own schema has no `input`) with an `input` string. */
function magicPayload(args: EditArgs, mode: EditMode | undefined): string | undefined {
	return mode === "replace" ? payloadOf(args) : undefined;
}

interface MagicChange {
	readonly path: string;
	change: string;
	/** The payload's last section (the one that may still stream). */
	open: boolean;
}

/** Files of a magic payload in order, sections naming one path merged. */
function magicChanges(input: string): MagicChange[] {
	const merged = new Map<string, MagicChange>();
	const { runs } = splitMagicSections(input);
	runs.forEach((run, index) => {
		const change = sanitizeText(run.text).trim();
		const open = index === runs.length - 1;
		const file = merged.get(run.path);
		if (!file) merged.set(run.path, { path: run.path, change, open });
		else {
			file.change = [file.change, change].filter(Boolean).join("\n\n");
			file.open = open;
		}
	});
	return [...merged.values()];
}

function hashlinePath(raw: string): string {
	const trimmed = raw.trim();
	const tag = TYPED_TAG.exec(trimmed)?.index;
	const bare = tag === undefined ? trimmed : trimmed.slice(0, tag);
	if (bare.length >= 2 && (bare[0] === '"' || bare[0] === "'") && bare[0] === bare[bare.length - 1])
		return bare.slice(1, -1);
	return bare;
}

/** Sections of a (possibly partial) hashline payload: path, file op, rename, line edits. */
function hashlineEntries(input: string): FileEntry[] {
	const entries: FileEntry[] = [];
	let current: FileEntry | undefined;
	for (const raw of (input.startsWith("\uFEFF") ? input.slice(1) : input).split("\n")) {
		const line = raw.replace(/\r$/, "");
		const trimmedEnd = line.trimEnd();
		if (trimmedEnd.startsWith(HL_FILE_PREFIX)) {
			// The closing bracket may still be streaming.
			const end = trimmedEnd.endsWith(HL_FILE_SUFFIX)
				? trimmedEnd.length - HL_FILE_SUFFIX.length
				: trimmedEnd.length;
			const path = hashlinePath(trimmedEnd.slice(HL_FILE_PREFIX.length, end));
			if (path) {
				current = { path };
				entries.push(current);
				continue;
			}
		}
		if (!current) continue;
		const trimmed = line.trim();
		if (trimmed === HL_REM_KEYWORD) current.op = "delete";
		else if (trimmed.startsWith(`${HL_MOVE_KEYWORD} `))
			current.rename = hashlinePath(trimmed.slice(HL_MOVE_KEYWORD.length + 1));
		else if (LINE_OP_HEADER.test(trimmed)) current.hasLineEdits = true;
	}
	return entries;
}

let inspected: { mode: EditMode; input: string; entries?: FileEntry[]; error?: string } | undefined;

/** Files of an apply_patch or sloppy envelope (the native inspection, memoized for the last payload). */
function inspectEntries(mode: EditMode, input: string): { entries: FileEntry[]; error?: string } {
	if (inspected?.mode !== mode || inspected.input !== input) {
		try {
			const inspection = editInspect(mode, JSON.stringify({ input }));
			const entries = new Map<string, FileEntry>();
			for (const path of inspection.paths) entries.set(path, { path });
			for (const intent of inspection.fileOps) {
				const entry = entries.get(intent.path) ?? { path: intent.path };
				if (intent.kind === "delete") entry.op = "delete";
				else if (intent.kind === "move") {
					entry.op = "update";
					entry.rename = intent.to;
				}
				entries.set(intent.path, entry);
			}
			inspected = { mode, input, entries: [...entries.values()] };
		} catch (error) {
			inspected = { mode, input, error: error instanceof Error ? error.message : String(error) };
		}
	}
	return { entries: inspected.entries ?? [], error: inspected.error };
}

function partialJsonPath(args: EditArgs): string | undefined {
	const json = str(args.__partialJson);
	const match = json ? PARTIAL_JSON_PATH.exec(json) : null;
	if (!match) return undefined;
	let text = match[1]!.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
	if ((/\\+$/.exec(text)?.[0].length ?? 0) % 2 === 1) text = text.slice(0, -1);
	try {
		return JSON.parse(`"${text}"`) as string;
	} catch {
		return text;
	}
}

function editFileCount(edits: NonNullable<EditArgs["edits"]>): number {
	return new Set(edits.map(edit => str(edit.path)).filter(Boolean)).size;
}

function callFacts(args: EditArgs, state: ToolViewState, mode: EditMode | undefined): CallFacts {
	const magic = magicPayload(args, mode);
	if (magic !== undefined) {
		const files = magicChanges(magic);
		return { rawPath: files[0]?.path ?? "", fileCount: files.length, hasLineEdits: false };
	}
	const input = payloadOf(args);
	const hashline = mode === "hashline" && input !== undefined ? hashlineEntries(input) : undefined;
	let sloppy: FileEntry[] | undefined;
	if (mode === "sloppy" && input !== undefined) {
		const { entries, error } = inspectEntries("sloppy", input);
		if (!error && entries.length > 0) sloppy = entries;
	}
	let patch: { entries: FileEntry[]; error?: string } | undefined;
	const patchInput = str(args.input);
	if ((mode === undefined || mode === "apply_patch") && patchInput !== undefined) {
		const inspection = inspectEntries("apply_patch", patchInput);
		patch =
			inspection.error === undefined || (state.isPartial && inspection.error === MISSING_APPLY_PATCH_END)
				? { entries: inspection.entries }
				: { entries: [], error: inspection.error };
	}
	const first = args.edits?.[0];
	const rawPath =
		str(args.file_path) ??
		str(args.path) ??
		str(first?.path) ??
		partialJsonPath(args) ??
		hashline?.[0]?.path ??
		sloppy?.[0]?.path ??
		patch?.entries[0]?.path ??
		"";
	const rename =
		str(args.rename) ?? str(first?.rename) ?? str(first?.move) ?? patch?.entries[0]?.rename ?? hashline?.[0]?.rename;
	const op = args.op || first?.op || patch?.entries[0]?.op || hashline?.[0]?.op;
	const fileCount = args.edits
		? editFileCount(args.edits)
		: (hashline?.length ?? sloppy?.length ?? patch?.entries.length ?? 0);
	return {
		rawPath,
		rename,
		op,
		fileCount,
		applyPatchError: patch?.error,
		hasLineEdits: hashline?.[0]?.hasLineEdits === true,
	};
}

function operationTitle(op: Operation | undefined): string {
	return op === "create" ? "Create" : op === "delete" ? "Delete" : "Edit";
}

/** Added and removed lines of a diff. */
export function diffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff ? diff.split("\n") : []) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

function statsMeta(added: number, removed: number): string | undefined {
	const parts = [added > 0 ? `+${added}` : undefined, removed > 0 ? `−${removed}` : undefined].filter(Boolean);
	return parts.length > 0 ? parts.join(" ") : undefined;
}

function shownPath(raw: string): string {
	return displayPath(sanitizeText(raw));
}

interface HeadFacts {
	readonly op?: Operation;
	readonly path?: string;
	readonly files?: number;
	readonly line?: number;
	readonly href?: string;
	readonly rename?: string;
	readonly added: number;
	readonly removed: number;
	readonly diagnostics?: readonly (FileDiagnostics | undefined)[];
}

/** `Edit · path:line · +8 −1 · → new/path` for one file, `Edit · 3 files · +21 −4` for several. */
function editHead(facts: HeadFacts): ToolHead {
	const multi = (facts.files ?? 0) > 1;
	const meta = [
		statsMeta(facts.added, facts.removed),
		!multi && facts.rename ? `→ ${shownPath(facts.rename)}` : undefined,
	].filter((part): part is string => part !== undefined);
	const badge = facts.diagnostics && diagnosticsBadge(facts.diagnostics);
	return {
		title: multi ? "Edit" : operationTitle(facts.op),
		target: multi
			? `${facts.files} files`
			: facts.path
				? `${shownPath(facts.path)}${facts.line ? `:${facts.line}` : ""}`
				: undefined,
		targetKind: multi ? "text" : "path",
		href: multi ? undefined : facts.href,
		meta: meta.length > 0 ? meta : undefined,
		badges: badge ? [badge] : undefined,
	};
}

/** A file's diff: hunks for Tern, the compact text for the terminal. */
function DiffNode(props: { readonly diff: string; readonly path: string }): JSXNode {
	return <diff hunks={parseCompactDiff(props.diff)} path={props.path || undefined} />;
}

/** A file's section in a multi-file view: path and its `+a −r` head. */
function FileSection(props: {
	readonly path: string;
	readonly added?: number;
	readonly removed?: number;
	readonly error?: boolean;
	readonly children?: JSXNode;
}): JSXNode {
	const head: TspSpan[] = [{ s: "path", t: shownPath(props.path) }];
	if (props.added) head.push({ s: "ins", t: ` +${props.added}` });
	if (props.removed) head.push({ s: "del", t: ` −${props.removed}` });
	return (
		<section key={props.path} head={head} role="omp.tool.edit.file" tone={props.error ? "error" : undefined}>
			{props.children}
		</section>
	);
}

function contextOf(state: ToolViewState, defaultMode: EditMode | undefined): EditContext & { mode?: EditMode } {
	const context = (state.renderContext ?? {}) as EditContext;
	const files = context.streamPreview?.files;
	const mode = context.editMode ?? defaultMode;
	if (!files || context.perFileDiffPreview || context.editDiffPreview) return { ...context, mode };
	// A streamed preview: several files as per-file previews, one as the call's diff.
	if (files.length > 1) return { ...context, mode, perFileDiffPreview: files };
	const only = files[0];
	if (only?.diff)
		return { ...context, mode, editDiffPreview: { diff: only.diff, firstChangedLine: only.firstChangedLine } };
	return only?.error ? { ...context, mode, editDiffPreview: { error: only.error } } : { ...context, mode };
}

/** Per-file previews worth showing (several files, some with a diff or an error). */
function multiPreview(context: EditContext): readonly PerFileDiffPreview[] | undefined {
	const multi = context.perFileDiffPreview;
	return multi && multi.length > 1 && multi.some(p => p.diff || p.error) ? multi : undefined;
}

function hasPayload(args: EditArgs, context: EditContext): boolean {
	if (multiPreview(context)) return true;
	if (str(args.previewDiff) || str(args.diff) || str(args.newText) || str(args.new_string) || str(args.patch))
		return true;
	if (args.edits && args.edits.length > 0) return true;
	return Boolean(context.editStreamingFallback);
}

// ─── Call ───────────────────────────────────────────────────────────────────

function magicCallView(input: string, state: ToolViewState, card: EditCard): ToolView {
	const files = magicChanges(input);
	const view = (file: MagicChange): JSXNode => (
		<md role="omp.tool.edit.change" text={file.change} stream={state.isPartial && file.open} />
	);
	const head = editHead({ path: files[0]?.path, files: files.length, added: 0, removed: 0 });
	const body =
		files.length === 1
			? files[0]!.change
				? view(files[0]!)
				: undefined
			: files.map(file => <FileSection path={file.path}>{file.change ? view(file) : undefined}</FileSection>);
	return {
		head,
		body,
		term: { look: "edit", spinning: !state.argsComplete, edit: { cards: [card] } satisfies EditTerm },
	};
}

/** Link targets of a card's path and rename (relative paths resolved against the cwd). */
function linkPaths(primary: string, rename: string | undefined): NonNullable<EditCard["link"]> {
	return {
		...(primary ? { path: pendingLinkPath(primary) } : {}),
		...(rename ? { rename: pendingLinkPath(rename) } : {}),
	};
}

/** A call's links: the argument paths, before the tool resolves them. */
function callLink(facts: CallFacts): EditCard["link"] {
	return linkPaths(facts.rawPath, facts.rename);
}

function callView(args: EditArgs, state: ToolViewState, defaultMode: EditMode | undefined): ToolView {
	const context = contextOf(state, defaultMode);
	const facts = callFacts(args, state, context.mode);
	const spinning = !state.argsComplete;
	const multi = multiPreview(context);
	const more = facts.fileCount > 1 ? facts.fileCount - 1 : undefined;

	// Terminal card.
	let card: EditCard;
	const payload = hasPayload(args, context) || facts.hasLineEdits;
	if (
		facts.fileCount <= 1 &&
		!facts.applyPatchError &&
		(facts.op === "delete" || (facts.rename !== undefined && !payload))
	) {
		card = {
			kind: "inline",
			title: facts.op === "delete" ? "Delete" : "Move",
			path: facts.rawPath,
			rename: facts.rename,
			link: callLink(facts),
			icon: "pending",
			body: [],
			phase: "pending",
		};
	} else {
		const body: EditBodyPart[] = [];
		let footer: EditCard["footer"];
		const previewDiff = str(args.previewDiff);
		const diff = str(args.diff);
		const replacement = str(args.newText) ?? str(args.new_string) ?? str(args.patch);
		if (multi) {
			body.push({ k: "files", files: multi });
			if (multi.some(p => p.diff)) footer = "preview";
		} else if (previewDiff) {
			body.push({ k: "stream", diff: previewDiff, path: facts.rawPath });
			footer = "preview";
		} else if (diff && args.op) {
			body.push({ k: "stream", diff, path: facts.rawPath });
			footer = "streaming";
		} else if (diff) body.push({ k: "text", text: diff });
		else if (replacement) body.push({ k: "text", text: replacement });
		else if (context.editStreamingFallback) body.push({ k: "raw", text: context.editStreamingFallback });
		else if (context.editDiffPreview?.error) body.push({ k: "error", text: context.editDiffPreview.error });
		else if (context.editDiffPreview?.diff) {
			body.push({ k: "stream", diff: context.editDiffPreview.diff, path: facts.rawPath });
			footer = "preview";
		}
		if (facts.applyPatchError) body.push({ k: "patchError", text: facts.applyPatchError });
		// Expanded approval previews hide `preview`; `streaming` ends with the args.
		if ((footer === "preview" && state.expanded) || (footer === "streaming" && state.argsComplete))
			footer = undefined;
		card = {
			kind: "card",
			title: operationTitle(facts.op),
			path: facts.rawPath,
			rename: facts.rename,
			link: callLink(facts),
			more,
			icon: "spin",
			body,
			footer,
			phase: facts.applyPatchError ? "error" : "pending",
		};
	}

	const magic = magicPayload(args, context.mode);
	if (magic !== undefined) return magicCallView(magic, state, card);

	const body: JSXNode[] = [];
	let head: ToolHead;
	if (multi) {
		let added = 0;
		let removed = 0;
		for (const preview of multi) {
			const stats = preview.diff ? diffStats(preview.diff) : undefined;
			added += stats?.added ?? 0;
			removed += stats?.removed ?? 0;
			body.push(
				<FileSection
					path={preview.path}
					added={stats?.added}
					removed={stats?.removed}
					error={Boolean(preview.error)}
				>
					{preview.error ? (
						<ErrorText message={preview.error} />
					) : (
						<DiffNode diff={preview.diff ?? ""} path={preview.path} />
					)}
				</FileSection>,
			);
		}
		head = editHead({ op: facts.op, files: Math.max(facts.fileCount, multi.length), added, removed });
	} else {
		let diffText: string | undefined;
		let line: number | undefined;
		const previewDiff = str(args.previewDiff);
		const diff = str(args.diff);
		const text = diff ?? str(args.newText) ?? str(args.new_string) ?? str(args.patch);
		if (previewDiff || (diff && args.op)) {
			diffText = previewDiff ?? diff ?? "";
			body.push(<DiffNode diff={diffText} path={facts.rawPath} />);
		} else if (text) {
			body.push(<code text={text} path={facts.rawPath || undefined} />);
		} else if (context.editDiffPreview) {
			const preview = context.editDiffPreview;
			if (preview.error) body.push(<ErrorText message={preview.error} />);
			else if (preview.diff) {
				diffText = preview.diff;
				line = preview.firstChangedLine;
				body.push(<DiffNode diff={preview.diff} path={facts.rawPath} />);
			}
		}
		const stats = diffText ? diffStats(diffText) : { added: 0, removed: 0 };
		head = editHead({
			op: facts.op,
			path: facts.rawPath,
			files: facts.fileCount,
			line,
			rename: facts.rename,
			...stats,
		});
	}
	if (facts.applyPatchError) body.push(<ErrorText message={facts.applyPatchError} />);
	return {
		head,
		body: body.length > 0 ? body : undefined,
		tone: facts.applyPatchError ? "error" : undefined,
		term: { look: "edit", spinning, edit: { cards: [card] } satisfies EditTerm },
	};
}

// ─── Result ─────────────────────────────────────────────────────────────────

type FileDetails = EditToolDetails | EditToolPerFileResult;

interface FileParts {
	readonly head: HeadFacts & { readonly path: string };
	readonly isError: boolean;
	readonly diagnostics?: FileDiagnostics;
	readonly body: JSXNode[];
	readonly card: EditCard;
}

/** One file's result: head facts, native body and terminal card. */
function fileParts(
	result: { readonly content: ToolResult["content"]; readonly details?: FileDetails; readonly isError?: boolean },
	state: ToolViewState,
	context: EditContext,
	args?: EditArgs,
): FileParts {
	const details = result.details;
	const isError = Boolean(result.isError ?? (details && "isError" in details ? details.isError : false));
	const first = args?.edits?.[0];
	const mode = context.editMode;
	const hashlineFirst =
		mode === "hashline" && args && payloadOf(args) ? hashlineEntries(payloadOf(args)!)[0] : undefined;
	const moveSource = details?.sourcePath;
	const detailPath = details?.path;
	const rawPath =
		moveSource ??
		str(args?.file_path) ??
		str(args?.path) ??
		str(first?.path) ??
		detailPath ??
		hashlineFirst?.path ??
		"";
	const op = args?.op || first?.op || details?.op;
	const rename = str(args?.rename) ?? str(first?.rename) ?? str(first?.move) ?? details?.move;
	// Details that only class a failure leave the streamed preview to locate it.
	const preview = details && !("errorKind" in details && details.errorKind) ? undefined : context.editDiffPreview;
	const previewDiff = preview && !preview.error ? preview.diff : undefined;
	const diffText = isError ? undefined : details?.diff || previewDiff;
	const line =
		(preview && !preview.error ? preview.firstChangedLine : undefined) ||
		(details && !isError ? details.firstChangedLine : undefined);
	const shown = shownPath(detailPath ?? rawPath);
	const diagnostics = details?.diagnostics as FileDiagnostics | undefined;
	// The head shows the argument paths but links the files the edit resolved
	// (a relative argument would otherwise resolve against the process cwd).
	const resolved = rename ? (moveSource ?? detailPath) : detailPath;
	const paths = linkPaths(resolved ?? rawPath, rename === undefined ? undefined : (detailPath ?? rename));
	const link = line ? { ...paths, line } : paths;

	const body: JSXNode[] = [];
	let errorText = "";
	if (isError) {
		const display = details && "displayErrorText" in details ? details.displayErrorText : undefined;
		errorText =
			display || (details && "errorText" in details ? details.errorText : "") || resultText(result as ToolResult);
		if (errorText) body.push(<ErrorText message={errorText} />);
	} else if (diffText) body.push(<DiffNode diff={diffText} path={detailPath ?? rawPath} />);
	else if (preview?.error) body.push(<ErrorText message={preview.error} />);
	else if (details && op !== "delete" && op !== "create" && !rename)
		body.push(<NoteText message={`No changes were made${shown ? ` to ${shown}` : ""}.`} />);
	if (diagnostics) body.push(<DiagnosticsSection diagnostics={diagnostics} />);
	const stats = diffText ? diffStats(diffText) : { added: 0, removed: 0 };

	// Terminal: a delete or move-only result is one status row; anything else a card.
	const inline = !isError && !details?.diff && !details?.diagnostics && (op === "delete" || rename !== undefined);
	let card: EditCard;
	if (inline) {
		card = {
			kind: "inline",
			title: op === "delete" ? "Delete" : "Move",
			path: rawPath,
			rename,
			link: paths,
			icon: op === "delete" ? "delete" : "move",
			body: [],
			phase: "success",
		};
	} else {
		const parts: EditBodyPart[] = [];
		const headerDiff = isError ? undefined : details?.diff || previewDiff;
		if (isError) {
			if (errorText) parts.push({ k: "error", text: errorText });
		} else if (details?.diff) parts.push({ k: "diff", diff: details.diff, path: rawPath });
		else if (details) {
			if (op !== "delete" && op !== "create" && !rename) {
				const noChange = detailPath ? displayPath(detailPath) : rawPath ? displayPath(sanitizeText(rawPath)) : "";
				parts.push({ k: "note", text: `No changes were made${noChange ? ` to ${noChange}` : ""}.` });
			}
		} else if (preview) {
			if (preview.error) parts.push({ k: "error", text: preview.error });
			else if (preview.diff) parts.push({ k: "diff", diff: preview.diff, path: rawPath });
		}
		if (diagnostics) parts.push({ k: "diagnostics", diagnostics });
		card = {
			kind: "card",
			title: operationTitle(op),
			path: rawPath,
			rename,
			link,
			icon: isError ? "error" : state.isPartial ? "success" : "edit",
			stats: headerDiff ? diffStats(headerDiff) : undefined,
			body: parts,
			phase: isError ? "error" : state.isPartial ? "partial" : "success",
		};
	}
	return {
		head: {
			op,
			path: sanitizeText(rawPath),
			line,
			rename: rename === undefined ? undefined : sanitizeText(rename),
			href: fileHref(detailPath),
			...stats,
		},
		isError,
		diagnostics,
		body,
		card,
	};
}

function resultView(
	result: ToolResult<EditToolDetails>,
	state: ToolViewState,
	args: EditArgs | undefined,
	defaultMode: EditMode | undefined,
): ToolView {
	const context = contextOf(state, defaultMode);
	const perFile = result.details?.perFileResults;
	const totalFiles = args?.edits ? editFileCount(args.edits) : 0;
	if (perFile && (perFile.length > 1 || totalFiles > 1)) {
		const remaining = Math.max(0, totalFiles - perFile.length);
		let added = 0;
		let removed = 0;
		const cards: EditCard[] = [];
		const body: JSXNode[] = perFile.map(file => {
			const parts = fileParts({ content: [], details: file, isError: file.isError }, state, context);
			added += parts.head.added;
			removed += parts.head.removed;
			cards.push(parts.card);
			return (
				<FileSection
					path={parts.head.path}
					added={parts.head.added}
					removed={parts.head.removed}
					error={parts.isError}
				>
					{parts.body}
				</FileSection>
			);
		});
		if (remaining > 0)
			body.push(
				<spinner label={[{ s: "muted", t: `${remaining} more file${remaining > 1 ? "s" : ""} pending…` }]} />,
			);
		return {
			head: editHead({
				files: Math.max(totalFiles, perFile.length),
				added,
				removed,
				diagnostics: perFile.map(file => file.diagnostics as FileDiagnostics | undefined),
			}),
			body,
			tone: perFile.some(file => file.isError) ? "error" : undefined,
			// Stacked cards: the transcript sets them off by no margin rows.
			term: { look: "edit", spinning: false, margin: false, edit: { cards, pending: remaining } satisfies EditTerm },
		};
	}
	const file = fileParts(result, state, context, args);
	return {
		head: editHead({ ...file.head, diagnostics: [file.diagnostics] }),
		body: file.body.length > 0 ? file.body : undefined,
		tone: file.isError ? "error" : undefined,
		term: { look: "edit", spinning: false, edit: { cards: [file.card] } satisfies EditTerm },
	};
}

function editPresenter(defaultMode: EditMode | undefined): ToolPresenter<EditArgs, EditToolDetails> {
	return {
		merge: true,
		streamsBody: true,
		activity(args, state): ToolActivity {
			const context = contextOf(state, defaultMode);
			const facts = callFacts(args ?? {}, state, context.mode);
			const label = operationTitle(facts.op);
			if (!facts.rawPath) return { label };
			let detail = shownPath(facts.rawPath);
			if (facts.rename) detail += ` → ${shownPath(facts.rename)}`;
			if (facts.fileCount > 1) detail += ` (+${facts.fileCount - 1} more)`;
			return { label, detail };
		},
		call: (args, state) => callView(args ?? {}, state, defaultMode),
		result: (result, state, args) => resultView(result, state, args, defaultMode),
	};
}

/**
 * The payload grammar a call to `toolName` streams, which the host threads to
 * the call as `editMode`: apply_patch's own, the `edit` tool's `mode` getter
 * (`undefined` for a bridge edit tool without one), none for other tools.
 * Without it a hashline, sloppy or magic payload's target path stays unknown
 * until the result arrives.
 */
export function toolEditMode(toolName: string, tool: unknown): EditMode | undefined {
	if (toolName === "apply_patch") return "apply_patch";
	if (toolName !== "edit" || !isRecord(tool) || typeof tool.mode !== "string") return undefined;
	return normalizeEditMode(tool.mode);
}

export const editToolPresenter = editPresenter(undefined);
export const applyPatchPresenter = editPresenter("apply_patch");

registerToolPresenter("edit", editToolPresenter);
registerToolPresenter("apply_patch", applyPatchPresenter);
