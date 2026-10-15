/**
 * `<` of a harness tag: `irc` or a `system-*` name (`system-notice`,
 * `system-reminder`, `system-interrupt`, …), opening or closing. The system
 * prompt tells the model these blocks are harness-authored.
 */
const HARNESS_TAG_START_RE = /<(?=\s*\/?\s*(?:irc|system-[a-z][a-z-]*)(?![\w-]))/gi;

/**
 * Keep agent- or job-authored text from closing the harness block it is
 * rendered into, or opening a forged one such as a parent's `<irc from="parent">`.
 * Only harness tag names are escaped, so code, placeholders and the harness's
 * own nested `<task-result>` envelope reach the model unchanged.
 */
export function escapeHarnessTags(text: string): string {
	return text.replace(HARNESS_TAG_START_RE, "&lt;");
}

/** Other-session text is untrusted, including markup that is not a harness tag. */
export function escapePeerText(text: string): string {
	return text.replaceAll("<", "&lt;");
}
