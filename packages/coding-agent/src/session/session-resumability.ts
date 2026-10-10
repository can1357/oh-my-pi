/** Dependency-light facts shared by live and synchronous recent-session selection. */
export interface SessionResumabilityFacts {
	readonly status?: "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";
	readonly assistantTurns?: number;
	readonly title?: string;
	readonly firstMessage?: string;
}

/** Prefix window the live recent-session scan uses for displayable resume intent. */
export const SESSION_RESUMABILITY_PREFIX_BYTES = 4096;

/** Message roles whose text makes a transcript visible and resumable in the session picker. */
export function isSessionDisplayMessageRole(role: unknown): role is "user" | "developer" | "assistant" {
	return role === "user" || role === "developer" || role === "assistant";
}

function decodeJsonStringFragment(value: string): string {
	const safeValue = value.endsWith("\\") ? value.slice(0, -1) : value;
	try {
		return JSON.parse(`"${safeValue}"`) as string;
	} catch {
		return safeValue
			.replace(/\\n/g, "\n")
			.replace(/\\r/g, "\r")
			.replace(/\\t/g, "\t")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}
}

/** Extract one string property from complete or prefix-truncated persisted JSON. */
export function extractSessionStringProperty(source: string, name: string, startIndex = 0): string | undefined {
	const propertyIndex = source.indexOf(`"${name}"`, startIndex);
	if (propertyIndex === -1) return undefined;

	const colonIndex = source.indexOf(":", propertyIndex + name.length + 2);
	if (colonIndex === -1) return undefined;

	let valueIndex = colonIndex + 1;
	while (valueIndex < source.length) {
		const char = source.charCodeAt(valueIndex);
		if (char !== 32 && char !== 9 && char !== 10 && char !== 13) break;
		valueIndex++;
	}
	if (source.charCodeAt(valueIndex) !== 34) return undefined;

	const valueStart = valueIndex + 1;
	let escaped = false;
	for (let i = valueStart; i < source.length; i++) {
		const char = source.charCodeAt(i);
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === 92) {
			escaped = true;
			continue;
		}
		if (char === 34) return decodeJsonStringFragment(source.slice(valueStart, i));
	}

	return decodeJsonStringFragment(source.slice(valueStart));
}

/** First displayable message text wholly visible inside the shared prefix window. */
export function extractFirstDisplayMessageFromPrefix(content: string): string | undefined {
	let fallback: string | undefined;
	let index = content.indexOf('"role"');

	while (index !== -1) {
		const role = extractSessionStringProperty(content, "role", index);
		const text =
			extractSessionStringProperty(content, "content", index) ??
			extractSessionStringProperty(content, "text", index);
		if (text && isSessionDisplayMessageRole(role)) {
			if (role === "user") return text;
			fallback ??= text;
		}
		index = content.indexOf('"role"', index + 6);
	}

	return fallback;
}

export function sanitizeSessionName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const firstLine = value.split(/\r?\n/)[0] ?? "";
	const stripped = firstLine.replace(/[\x00-\x1F\x7F]/g, "");
	const trimmed = stripped.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Canonical empty-session predicate used by both live resume and startup prepaint. */
export function isSessionResumabilityEmpty(facts: SessionResumabilityFacts): boolean {
	if (facts.status !== undefined && facts.status !== "pending" && facts.status !== "unknown") return false;
	if ((facts.assistantTurns ?? 1) > 0) return false;
	if (sanitizeSessionName(facts.title)) return false;
	if (sanitizeSessionName(facts.firstMessage === "(no messages)" ? undefined : facts.firstMessage)) return false;
	return true;
}
