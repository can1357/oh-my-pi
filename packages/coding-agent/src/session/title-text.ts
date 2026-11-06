/**
 * What a session title may contain, and so what counts as blank.
 *
 * Deliberately free of imports: the launch flag table rejects a blank `--title`
 * at parse time and may not reach session code, so the definition has to live
 * somewhere both it and {@link SessionManager.setSessionName} can read. A
 * second copy of this rule would disagree with the one that decides whether a
 * title is kept — `"\u0001"` is not blank to `trim()` and is blank to this.
 */

/** Control characters become spaces, runs of spaces collapse, and the ends are trimmed. */
export function cleanSessionTitle(raw: string): string {
	return raw
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}
