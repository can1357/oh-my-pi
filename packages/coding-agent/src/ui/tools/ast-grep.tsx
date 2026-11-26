/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `ast_grep`: a structural search. The head is `AST Grep <pattern>` with the
 * scope, counts and a `limit reached` warning; the body lists the matched
 * files, each its path row and its match rows as numbered code with the
 * matches marked (`meta:` capture rows stay plain code), then the limit note
 * and the parse issues as a folded section.
 *
 * Terminal look: `ast_grep` (`src/ui/styles/tools/ast-grep.ts`), fed by {@link AstGrepTerm}.
 */
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { OutputMeta } from "../../tools/output-meta-format";
import { ErrorText, NoteText } from "./agent-common";
import type { ToolPresenter, ToolResult, ToolView } from "./contract";
import { resultText } from "./default";
import {
	type GroupedLinks,
	groupedLinks,
	groupedOutputNodes,
	keptGroupedLines,
	ParseIssues,
	pathList,
} from "./grouped-output";
import { registerToolPresenter } from "./registry";
import { countText } from "./search-common";

/** ast-grep call args. */
export interface AstGrepArgs {
	readonly pat?: string;
	readonly path?: string | readonly string[];
	/** The pre-`path` name, in older transcripts. */
	readonly paths?: readonly string[];
	readonly skip?: number;
	/** The language the files were parsed as: highlighting follows it. */
	readonly lang?: string;
}

/** ast-grep result details. */
export interface AstGrepDetails {
	readonly matchCount?: number;
	readonly fileCount?: number;
	readonly filesSearched?: number;
	readonly limitReached?: boolean;
	readonly nextSkip?: number;
	readonly parseErrors?: readonly string[];
	readonly parseErrorsTotal?: number;
	readonly scopePath?: string;
	readonly meta?: OutputMeta;
	/** The display text (`│` gutters, `*` match marks). */
	readonly displayContent?: string;
	readonly searchPath?: string;
	readonly cwd?: string;
}

/** Terminal-only facts of an ast-grep call (`term`). */
export type AstGrepTerm = {
	readonly look: "ast_grep";
	readonly phase: "call" | "error" | "result";
	readonly pattern?: string;
	readonly scope?: string;
	readonly skip?: number;
	readonly lang?: string;
	readonly error?: string;
	readonly matchCount?: number;
	readonly fileCount?: number;
	readonly filesSearched?: number;
	readonly limitReached?: boolean;
	/** Skip offset of the next page, when the result recorded it. */
	readonly nextSkip?: number;
	readonly parseErrors?: readonly string[];
	readonly parseErrorsTotal?: number;
	/** Display output rows. */
	readonly output?: string;
	/** Where the output's paths lead (file and match rows link). */
	readonly links?: GroupedLinks;
};

/** Collapsed rows of the match tree. */
export const AST_GREP_PREVIEW_ROWS = 6;
/** Groups that are notes, not matches. */
const NOTE_GROUPS = ["Result limit reached", "Parse issues:"];

/** `AST Grep` then each fact after a space (plain facts muted). */
function headSpans(...facts: readonly (TspSpan | string | undefined)[]): TspSpan[] {
	const spans: TspSpan[] = [{ s: "toolTitle strong", t: "AST Grep" }];
	for (const fact of facts) {
		if (fact === undefined) continue;
		const span = typeof fact === "string" ? { s: "muted", t: fact } : fact;
		if (!span.t) continue;
		spans.push({ t: " " }, span);
	}
	return spans;
}

function linksOf(details: AstGrepDetails | undefined): { links?: GroupedLinks } {
	const links = groupedLinks(details);
	return links ? { links } : {};
}

function argScope(args: AstGrepArgs | undefined): string {
	return pathList(args?.path ?? args?.paths).join(", ");
}

/** The truncation hint; results recorded before `nextSkip` existed get the generic form. */
export function astGrepLimitAdvice(nextSkip: number | undefined): string {
	return nextSkip === undefined
		? "limit reached; narrow path or use skip"
		: `limit reached; narrow path or use skip=${nextSkip} for the next page`;
}

export const astGrepPresenter: ToolPresenter<AstGrepArgs, AstGrepDetails> = {
	merge: true,
	call(args): ToolView {
		const scope = argScope(args);
		const skip = args.skip !== undefined && args.skip > 0 ? args.skip : undefined;
		return {
			label: headSpans(
				{ s: "code", t: args.pat ?? "?" },
				scope ? `in ${scope}` : undefined,
				skip ? `skip:${skip}` : undefined,
			),
			term: {
				look: "ast_grep",
				phase: "call",
				pattern: args.pat || "?",
				...(scope ? { scope } : {}),
				...(skip ? { skip } : {}),
			} satisfies AstGrepTerm,
		};
	},
	result(result: ToolResult<AstGrepDetails>, _state, args): ToolView {
		const details = result.details;
		const pattern: TspSpan = { s: "code", t: args?.pat ?? "?" };
		const scope = details?.scopePath || argScope(args);
		const base = {
			look: "ast_grep" as const,
			...(args?.pat ? { pattern: args.pat } : {}),
			...(scope ? { scope } : {}),
			...(args?.lang ? { lang: args.lang } : {}),
		};
		if (result.isError) {
			const message = resultText(result) || "Unknown error";
			return {
				label: headSpans(pattern, scope ? `in ${scope}` : undefined),
				tone: "error",
				body: <ErrorText message={message} />,
				term: { ...base, phase: "error", error: message } satisfies AstGrepTerm,
			};
		}
		const matchCount = details?.matchCount ?? 0;
		const fileCount = details?.fileCount ?? 0;
		const filesSearched = details?.filesSearched ?? 0;
		const limitReached = details?.limitReached ?? false;
		const parseErrors = details?.parseErrors ?? [];
		const output = details?.displayContent ?? resultText(result);
		const term: AstGrepTerm = {
			...base,
			phase: "result",
			matchCount,
			fileCount,
			filesSearched,
			limitReached,
			...(details?.nextSkip !== undefined ? { nextSkip: details.nextSkip } : {}),
			...(parseErrors.length > 0 ? { parseErrors } : {}),
			...(details?.parseErrorsTotal !== undefined ? { parseErrorsTotal: details.parseErrorsTotal } : {}),
			output,
			...linksOf(details),
		};
		const scopeFact = details?.scopePath ? `in ${details.scopePath}` : undefined;
		const issues = <ParseIssues errors={parseErrors} total={details?.parseErrorsTotal} />;
		if (matchCount === 0) {
			return {
				label: headSpans(
					pattern,
					scopeFact,
					"0 matches",
					filesSearched > 0 ? `searched ${filesSearched}` : undefined,
				),
				tone: "warning",
				body: [
					parseErrors.length > 0 && (
						<NoteText
							message="Query may be mis-scoped; narrow `path` before concluding absence"
							token="warning"
						/>
					),
					issues,
				],
				term,
			};
		}
		const label = headSpans(
			pattern,
			scopeFact,
			countText(matchCount, "match"),
			countText(fileCount, "file"),
			`searched ${filesSearched}`,
		);
		if (limitReached) label.push({ s: "warning", t: " limit reached" });
		return {
			label,
			body: [
				...groupedOutputNodes(keptGroupedLines(output.split("\n"), NOTE_GROUPS, true)),
				limitReached && <NoteText message={astGrepLimitAdvice(details?.nextSkip)} token="warning" />,
				issues,
			],
			preview: { lines: AST_GREP_PREVIEW_ROWS },
			term,
		};
	},
};

registerToolPresenter("ast_grep", astGrepPresenter);
