/**
 * String format of TTSR injection-record keys, persisted in `ttsr_injection`
 * session entries: a bare rule name, or `<name>::scope:<lowercase hex hash>`
 * for a model-scoped variant of that rule.
 */
const SCOPED_RECORD_KEY = /^(.*)::scope:([0-9a-f]+)$/;

/** Record key for rule `name`; a non-empty `scopeHash` (lowercase hex) marks a model-scoped variant. */
export function formatTtsrRecordKey(name: string, scopeHash?: string): string {
	return scopeHash ? `${name}::scope:${scopeHash}` : name;
}

/**
 * Split a record key into the rule name and, for a scoped variant, its scope
 * hash. Any string that is not a scoped key is a bare rule name.
 */
export function parseTtsrRecordKey(key: string): { name: string; scopeHash?: string } {
	const match = SCOPED_RECORD_KEY.exec(key);
	return match ? { name: match[1], scopeHash: match[2] } : { name: key };
}
