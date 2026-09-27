/**
 * Autocomplete for internal-url schemes (skill://, rule://, omp://, local://,
 * memory://, agent://, artifact://) while composing a prompt.
 *
 * Detection here MUST stay in sync with the generic URL-scheme trigger in the
 * TUI editor (`packages/tui/src/components/editor.ts`); the editor fires the
 * popup, this module decides whether there are candidates to show.
 */
import { subsequenceMatch, subsequenceScore } from "../autocomplete";
import type { AutocompleteItem } from "../index";
/** Lazy runtime capabilities supplied by the internal URL host. */
export interface InternalUrlCompletionHost {
	completionSchemes(): string[];
	resolveCompletions(
		scheme: string,
		query: string,
		context: InternalUrlCallerContext & { signal?: AbortSignal },
	): Promise<readonly { value: string; label?: string; description?: string }[] | null | undefined>;
}

let completionHost: InternalUrlCompletionHost | undefined;

/** Install the runtime URL completion capabilities. */
export function setInternalUrlCompletionHost(host: InternalUrlCompletionHost): void {
	completionHost = host;
}

/** Upper bound on candidates surfaced in the dropdown. */
const MAX_URL_SUGGESTIONS = 25;

/**
 * A URL token ending at the cursor: a known internal scheme followed by one or
 * two slashes and the partially typed host/path. The boundary/rest character
 * classes mirror the editor trigger so both agree on what counts as a token.
 */
const URL_TOKEN_RE = /(?:^|[\s"'`(<=])([a-z][a-z0-9+.-]*:\/{1,2}[^\s"'`()<>]*)$/i;
const SCHEME_SPLIT_RE = /^([a-z][a-z0-9+.-]*):\/{1,2}(.*)$/i;

export interface InternalUrlContext {
	/** Lowercased scheme (e.g. `local`). */
	scheme: string;
	/** Text typed after the slashes so far (host + path); may be empty. */
	query: string;
	/** Exact buffer token from its boundary to the cursor (the completion prefix). */
	token: string;
}

/** Decode a completion `value` for fuzzy matching (the inserted value may be
 * percent-encoded, e.g. an ssh host `alice%40prod`); identity for plain values. */
function decodeUrlCompletionValue(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Detect a completable internal-url token immediately before the cursor.
 * Returns `null` when the text is not a `scheme://` token whose scheme is
 * registered with a completion-capable handler.
 */
export function extractInternalUrlContext(textBeforeCursor: string): InternalUrlContext | null {
	const tokenMatch = URL_TOKEN_RE.exec(textBeforeCursor);
	if (!tokenMatch) return null;
	const token = tokenMatch[1]!;
	const parts = SCHEME_SPLIT_RE.exec(token);
	if (!parts) return null;
	const scheme = parts[1]!.toLowerCase();
	if (!completionHost?.completionSchemes().includes(scheme)) return null;
	return { scheme, query: parts[2] ?? "", token };
}

/** Caller binding shared by tool execution and prompt completion. */
export interface InternalUrlCallerContext {
	cwd?: string;
	sessionFile?: string;
	sessionId?: string;
}

/**
 * Suggestions for the internal-url token ending at the cursor, or `null` when
 * the text is not such a token or no candidate matches the typed query.
 * The optional lazy caller binding overrides cwd and is read only after
 * recognizing an internal-URL token.
 */
export async function getInternalUrlSuggestions(
	textBeforeCursor: string,
	cwd?: string,
	signal?: AbortSignal,
	getCaller?: () => InternalUrlCallerContext,
): Promise<{ items: AutocompleteItem[]; prefix: string } | null> {
	if (signal?.aborted) return null;
	const ctx = extractInternalUrlContext(textBeforeCursor);
	if (!ctx) return null;

	const candidates = await completionHost?.resolveCompletions(ctx.scheme, ctx.query, {
		...(cwd === undefined ? {} : { cwd }),
		...getCaller?.(),
		...(signal ? { signal } : {}),
	});
	if (!candidates || candidates.length === 0) return null;

	const query = ctx.query.toLowerCase();
	const scored: Array<{ item: AutocompleteItem; score: number }> = [];
	for (const candidate of candidates) {
		const target = decodeUrlCompletionValue(candidate.value).toLowerCase();
		if (!subsequenceMatch(query, target)) continue;
		scored.push({
			item: {
				value: `${ctx.scheme}://${candidate.value}`,
				label: candidate.label ?? candidate.value,
				...(candidate.description ? { description: candidate.description } : {}),
			},
			score: subsequenceScore(query, target),
		});
	}
	if (scored.length === 0) return null;

	scored.sort((a, b) => b.score - a.score);
	return {
		items: scored.slice(0, MAX_URL_SUGGESTIONS).map(entry => entry.item),
		prefix: ctx.token,
	};
}

/** Whether `prefix` (the token a completion was offered for) is an internal-url token. */
export function isInternalUrlPrefix(prefix: string): boolean {
	return extractInternalUrlContext(prefix) !== null;
}

/**
 * Replace the internal-url token with the selected candidate, appending a
 * trailing space (matching `@` file-reference behavior) so the user can keep
 * typing.
 */
export function applyInternalUrlCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: AutocompleteItem,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const currentLine = lines[cursorLine] || "";
	const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
	const afterCursor = currentLine.slice(cursorCol);
	const insert = `${item.value} `;
	const newLines = [...lines];
	newLines[cursorLine] = beforePrefix + insert + afterCursor;
	return {
		lines: newLines,
		cursorLine,
		cursorCol: beforePrefix.length + insert.length,
	};
}
