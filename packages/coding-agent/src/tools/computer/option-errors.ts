/** Self-contained so the same implementation can be injected into the JavaScript facade. */
export function unknownOptionsMessage(value: object, allowed: string[], label: string): string | undefined {
	const unknown = Object.keys(value).filter(key => !allowed.includes(key));
	if (unknown.length === 0) return undefined;
	const hints = unknown.flatMap(key => {
		const normalized = key.toLowerCase().replace(/[_-]/g, "");
		const matches = allowed.filter(name => name.toLowerCase().replace(/[_-]/g, "") === normalized);
		return normalized.length > 0 && matches.length === 1 ? [`${key}: did you mean ${matches[0]}?`] : [];
	});
	return `${label}: unknown option(s): ${unknown.join(", ")}. Valid names: ${allowed.join(", ")}${hints.length ? `. ${hints.join(" ")}` : ""}`;
}
