/**
 * Autocomplete for GitHub issue/PR references typed as `#<number>` (e.g. `#3164`).
 *
 * Mirrors the `@` file-reference and `scheme://` internal-url conventions: the
 * token is rewritten to an internal URL (`pr://3164` or `issue://3164`) plus a
 * trailing space, and the existing tool-mediated pipeline (the `read` tool →
 * InternalUrlRouter → `gh`) resolves it from the session cwd's git remote.
 *
 * No network at suggestion time — candidates are generated locally. GitHub
 * shares the issue/PR number space and there is no cheap way to tell which a
 * given number is while typing, so both a PR and an Issue candidate are offered
 * by default. Naming the type first (`pr #3164` / `issue #3164`) constrains the
 * candidates to that kind. Anything that is not a standalone `#<number>` token
 * keeps falling through to the existing prompt-action menu.
 */
import type { AutocompleteItem } from "@oh-my-pi/pi-tui";

/** Candidate kinds, in default display order. */
const GITHUB_REF_KINDS = [
	{ qualifier: "pr", scheme: "pr", label: "PR", description: "GitHub pull request" },
	{ qualifier: "issue", scheme: "issue", label: "Issue", description: "GitHub issue" },
] as const;

export interface GithubRefContext {
	/** Text to replace on accept: `#3164`, or `pr #3164` when a qualifier precedes it. */
	prefix: string;
	/** Type the user named (`pr`/`pull` → `pr`, `issue` → `issue`), or null to offer both. */
	qualifier: "pr" | "issue" | null;
	/** The numeric reference, e.g. `3164`. */
	number: string;
}

/**
 * A standalone `#<positive-number>` token ending at the cursor. The `#` must be
 * preceded by a token boundary (start, whitespace, or an opening quote/paren/`<`/`=`,
 * matching the internal-URL boundary set) so embedded hashes like `owner/repo#N`,
 * `foo#N`, `C#12`, or a URL fragment do not match. An optional `pr`/`pull`/`issue`
 * qualifier word (case-insensitive) immediately before the `#` constrains the kind.
 */
const GITHUB_REF_TOKEN_RE = /(?:^|[\s"'`(<=])(?:(pr|pull|issue)(\s+))?#([1-9]\d*)$/i;

export function getGithubRefContext(textBeforeCursor: string): GithubRefContext | null {
	const match = textBeforeCursor.match(GITHUB_REF_TOKEN_RE);
	if (!match) return null;
	const qualifierWord = match[1];
	const whitespace = match[2] ?? "";
	const number = match[3] ?? "";
	return {
		prefix: qualifierWord ? `${qualifierWord}${whitespace}#${number}` : `#${number}`,
		qualifier: !qualifierWord ? null : qualifierWord.toLowerCase() === "issue" ? "issue" : "pr",
		number,
	};
}

/**
 * Suggestions for a `#<number>` token. Both kinds are offered unless the user
 * named a type (`pr #3164` / `issue #3164`), in which case only that kind is
 * offered. Returns `null` when the text before the cursor is not a standalone
 * `#<number>` token.
 */
export function getGithubRefSuggestions(
	textBeforeCursor: string,
): { items: AutocompleteItem[]; prefix: string } | null {
	const context = getGithubRefContext(textBeforeCursor);
	if (!context) return null;
	const kinds = context.qualifier
		? GITHUB_REF_KINDS.filter(kind => kind.qualifier === context.qualifier)
		: GITHUB_REF_KINDS;
	const items: AutocompleteItem[] = kinds.map(kind => ({
		value: `${kind.scheme}://${context.number}`,
		label: `${kind.label} #${context.number}`,
		description: kind.description,
	}));
	return { items, prefix: context.prefix };
}
