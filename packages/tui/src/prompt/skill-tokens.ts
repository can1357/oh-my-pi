/**
 * One `/skill:<name>` token delimited by whitespace or line edges. Group 1 is
 * the leading delimiter (empty at line start), group 2 the bare skill name.
 * Global so callers can walk every token; reset `lastIndex` before reuse.
 */
export const SKILL_TOKEN_RE = /(^|\s)\/skill:([^\s/]+)(?=\s|$)/g;

/**
 * Whether the draft begins with a TUI local-execution sigil that downstream
 * branches consume verbatim.
 */
export function isLocalExecutionDraft(text: string): boolean {
	const trimmedStart = text.trimStart();
	if (trimmedStart.startsWith("!")) return true;
	if (trimmedStart.charCodeAt(0) !== 36 /* $ */) return false;
	if (trimmedStart.charCodeAt(1) === 123 /* { */) return false;
	const sigilLength = trimmedStart.charCodeAt(1) === 36 /* $ */ ? 2 : 1;
	const next = trimmedStart.charCodeAt(sigilLength);
	if (Number.isNaN(next)) return true;
	return next === 32 /* space */ || next === 9 /* tab */ || next === 10 /* LF */ || next === 13; /* CR */
}

/**
 * Whether `/skill:<name>` tokens in `text` are invocations rather than content
 * belonging to another slash command or local-execution sigil.
 */
export function allowsSkillTokens(text: string): boolean {
	const trimmedStart = text.trimStart();
	if (trimmedStart.startsWith("/skill:")) return true;
	if (trimmedStart.startsWith("/")) return false;
	return !isLocalExecutionDraft(trimmedStart);
}

/** Whether model mentions may collapse in this draft; local execution consumes its body verbatim. */
export function allowsModelMentions(text: string): boolean {
	return !isLocalExecutionDraft(text);
}
