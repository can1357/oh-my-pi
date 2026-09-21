/**
 * Normalize `press` arguments across the Playwright-style `(selector, key)`
 * form and the options-object form (issue #12136).
 */
export interface ResolvedPressArgs {
	key: string;
	selector?: string;
}

export function splitPressArgs(key: string, opts?: { selector?: string } | string): ResolvedPressArgs {
	if (typeof opts === "string") return { key: opts, selector: key };
	return { key, selector: opts?.selector };
}
