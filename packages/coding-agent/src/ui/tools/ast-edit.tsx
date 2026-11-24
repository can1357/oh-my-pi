/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `ast_edit`: structural rewrites. The call heads with the rewrite pattern
 * (or `N rewrites`) and the scope. A result heads like edit: one file by its
 * path with a bare diff, several as `N files` with a section per file; the
 * pattern moves to a quiet context line, `proposed` badges an unapplied
 * rewrite, and parse issues and scope stats follow.
 *
 * Terminal look: `ast_edit` (`src/ui/styles/tools/ast-edit.ts`), fed by {@link AstEditTerm}.
 */

import type { JSXNode } from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { OutputMeta } from "../../tools/output-meta-format";
import { ErrorText, NoteText } from "./agent-common";
import type { ToolHead, ToolPresenter, ToolResult, ToolView } from "./contract";
import { resultText } from "./default";
import { displayPath } from "./file-common";
import { type GroupedLinks, groupedLinks, keptGroupedLines, ParseIssues, walkGroupedOutput } from "./grouped-output";
import { registerToolPresenter } from "./registry";
import { countText } from "./search-common";

/** ast-edit call args. */
export interface AstEditArgs {
	readonly ops?: readonly { readonly pat?: string; readonly out?: string }[];
	readonly paths?: readonly string[];
}

/** ast-edit result details. */
export interface AstEditDetails {
	readonly totalReplacements?: number;
	readonly filesTouched?: number;
	readonly filesSearched?: number;
	readonly applied?: boolean;
	readonly limitReached?: boolean;
	readonly parseErrors?: readonly string[];
	readonly parseErrorsTotal?: number;
	readonly scopePath?: string;
	readonly meta?: OutputMeta;
	/** The display text (`-12│old` / `+12│new` under file headers). */
	readonly displayContent?: string;
	readonly searchPath?: string;
	readonly cwd?: string;
}

/** Terminal-only facts of an ast-edit call (`term`). */
export type AstEditTerm = {
	readonly look: "ast_edit";
	readonly phase: "call" | "error" | "result";
	/** The pattern preview or `N rewrites`. */
	readonly subject?: string;
	readonly scope?: string;
	readonly error?: string;
	readonly applied?: boolean;
	readonly partial?: boolean;
	readonly replacements?: number;
	readonly filesTouched?: number;
	readonly filesSearched?: number;
	readonly limitReached?: boolean;
	readonly parseErrors?: readonly string[];
	readonly parseErrorsTotal?: number;
	/** Display output rows. */
	readonly output?: string;
	/** Where the output's paths lead (file rows link). */
	readonly links?: GroupedLinks;
};

/** Collapsed rows of the change list. */
export const AST_EDIT_PREVIEW_ROWS = 6;
/** Groups that are notes, not changes. */
const NOTE_GROUPS = ["Safety cap reached", "Parse issues:"];
const CHANGE_ROW = /^([+\- ])\s*(\d+)(?:│|[:|])(.*)$/;

/** A pattern on one line (whitespace runs collapsed). */
function patternPreview(pattern: string | undefined): string | undefined {
	return pattern?.replace(/\s+/g, " ").trim() || undefined;
}

/** The single rewrite's pattern, or `N rewrites`. */
function rewriteLabel(args: AstEditArgs | undefined): string | undefined {
	const count = args?.ops?.length ?? 0;
	if (count === 1) return patternPreview(args?.ops?.[0]?.pat);
	return count > 1 ? `${count} rewrites` : undefined;
}

function patternHead(args: AstEditArgs | undefined): Pick<ToolHead, "target" | "targetKind"> {
	const label = rewriteLabel(args);
	if (!label) return {};
	return {
		target: label,
		targetKind: args?.ops?.length === 1 ? "pattern" : "text",
	};
}

interface FileChanges {
	readonly path: string;
	readonly lines: string[];
	added: number;
	removed: number;
	lastOld?: number;
}

/** The display output as one unified diff per file. */
function parseChanges(lines: readonly string[]): FileChanges[] {
	const files: FileChanges[] = [];
	let file: FileChanges | undefined;
	for (const event of walkGroupedOutput(lines)) {
		if (event.kind !== "line") {
			if (file && file.lines.length > 0) files.push(file);
			file = event.kind === "file" ? { path: event.path, lines: [], added: 0, removed: 0 } : undefined;
			continue;
		}
		if (!file) continue;
		const change = CHANGE_ROW.exec(event.text);
		if (!change) continue;
		const n = Number.parseInt(change[2]!, 10);
		if (file.lastOld === undefined || n > file.lastOld + 1 || n < file.lastOld) file.lines.push(`@@ -${n} +${n} @@`);
		file.lastOld = n;
		if (change[1] === "+") file.added++;
		else if (change[1] === "-") file.removed++;
		file.lines.push(`${change[1]}${change[3]}`);
	}
	if (file && file.lines.length > 0) files.push(file);
	return files;
}

function FileDiff(props: { readonly file: FileChanges }): JSXNode {
	return <diff text={props.file.lines.join("\n")} path={props.file.path} />;
}

/** A file of a multi-file rewrite: a section headed by its path and `+a −d`, over its diff. */
function FileSection(props: { readonly file: FileChanges }): JSXNode {
	const { file } = props;
	const head: TspSpan[] = [{ s: "path", t: displayPath(file.path) }];
	if (file.added) head.push({ s: "ins", t: ` +${file.added}` });
	if (file.removed) head.push({ s: "del", t: ` \u2212${file.removed}` });
	return (
		<section key={file.path} head={head} role="omp.tool.ast_edit.file">
			<FileDiff file={file} />
		</section>
	);
}

/** `in src · searched 12 files · limit reached; narrow path`. */
function ScopeStats(props: { readonly details: AstEditDetails | undefined }): JSXNode {
	const { details } = props;
	const parts: string[] = [];
	if (details?.scopePath) parts.push(`in ${details.scopePath}`);
	if (details?.filesSearched) parts.push(`searched ${countText(details.filesSearched, "file")}`);
	if (details?.limitReached) parts.push("limit reached; narrow path");
	if (parts.length === 0) return undefined;
	return <text spans={[{ s: "muted", t: parts.join(" · ") }]} wrap="word" role="omp.tool.stats" />;
}

export const astEditPresenter: ToolPresenter<AstEditArgs, AstEditDetails> = {
	merge: true,
	call(args): ToolView {
		const subject = rewriteLabel(args);
		const scope = args.paths?.join(", ");
		return {
			head: {
				title: "AST Edit",
				...patternHead(args),
				...(args.paths?.length ? { meta: [`in ${args.paths.map(displayPath).join(", ")}`] } : {}),
			},
			term: {
				look: "ast_edit",
				phase: "call",
				subject: subject ?? "?",
				...(scope ? { scope } : {}),
			} satisfies AstEditTerm,
		};
	},
	result(result: ToolResult<AstEditDetails>, state, args): ToolView {
		const details = result.details;
		const subject = rewriteLabel(args);
		const scope = details?.scopePath || args?.paths?.join(", ");
		const base = {
			look: "ast_edit" as const,
			...(subject ? { subject } : {}),
			...(scope ? { scope } : {}),
		};
		if (result.isError) {
			const message = resultText(result) || "Unknown error";
			const headScope = details?.scopePath || args?.paths?.map(displayPath).join(", ");
			return {
				head: {
					title: "AST Edit",
					...patternHead(args),
					...(headScope ? { meta: [`in ${headScope}`] } : {}),
				},
				tone: "error",
				body: <ErrorText message={message} />,
				term: { ...base, phase: "error", error: message } satisfies AstEditTerm,
			};
		}
		const parseErrors = details?.parseErrors ?? [];
		const replacements = details?.totalReplacements ?? 0;
		const limitReached = details?.limitReached ?? false;
		const output = details?.displayContent ?? resultText(result);
		const links = groupedLinks(details);
		const term: AstEditTerm = {
			...base,
			phase: "result",
			applied: details?.applied === true,
			partial: state.isPartial === true,
			replacements,
			filesTouched: details?.filesTouched ?? 0,
			filesSearched: details?.filesSearched ?? 0,
			limitReached,
			...(parseErrors.length > 0 ? { parseErrors } : {}),
			...(details?.parseErrorsTotal !== undefined ? { parseErrorsTotal: details.parseErrorsTotal } : {}),
			output,
			...(links ? { links } : {}),
		};
		const issues = <ParseIssues errors={parseErrors} total={details?.parseErrorsTotal} />;
		if (replacements === 0) {
			return {
				head: {
					title: "AST Edit",
					...patternHead(args),
					meta: ["0 replacements"],
				},
				tone: "warning",
				body: [issues, <ScopeStats details={details} />],
				term,
			};
		}
		const kept = keptGroupedLines(output.split("\n"), NOTE_GROUPS, false);
		const files = parseChanges(kept);
		const fileCount = Math.max(details?.filesTouched ?? 0, files.length);
		let added = 0;
		let removed = 0;
		for (const file of files) {
			added += file.added;
			removed += file.removed;
		}
		const single = fileCount === 1 && files.length === 1 ? files[0] : undefined;
		const changes: JSXNode[] = single ? [<FileDiff file={single} />] : files.map(file => <FileSection file={file} />);
		const pattern = args?.ops?.length === 1 ? patternPreview(args.ops[0]?.pat) : undefined;
		const stats: string[] = [];
		if (added > 0) stats.push(`+${added}`);
		if (removed > 0) stats.push(`\u2212${removed}`);
		return {
			head: {
				title: "AST Edit",
				target: single ? displayPath(single.path) : countText(fileCount, "file"),
				targetKind: single ? "path" : "text",
				meta: [...(stats.length > 0 ? [stats.join(" ")] : []), countText(replacements, "replacement")],
				...(details?.applied ? {} : { badges: [{ text: "proposed", tone: "warning" as const }] }),
			},
			...(limitReached ? { tone: "warning" as const } : {}),
			body: [
				pattern !== undefined && (
					<text spans={[{ s: "code", t: pattern }]} lines={1} truncate="end" role="omp.tool.context" />
				),
				...(changes.length > 0 ? changes : [<NoteText message={kept.join("\n")} />]),
				issues,
				<ScopeStats details={details} />,
			],
			preview: { lines: AST_EDIT_PREVIEW_ROWS },
			term,
		};
	},
};

registerToolPresenter("ast_edit", astEditPresenter);
