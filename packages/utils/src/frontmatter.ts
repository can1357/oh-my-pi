import { YAML } from "bun";
import { truncate } from "./format";
import * as logger from "./logger";

function stripHtmlComments(content: string): string {
	return content.replace(/<!--[\s\S]*?-->/g, "");
}

/** Convert kebab-case to camelCase (e.g. "thinking-level" -> "thinkingLevel") */
function kebabToCamel(key: string): string {
	if (!key.includes("-")) return key;
	return key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Recursively normalize object keys from kebab-case to camelCase — the
 * representation convention for frontmatter consumed inside this codebase.
 * Exported for loaders that parse with `rawKeys: true` to validate exact
 * spec-defined keys, then normalize for storage.
 */
export function normalizeFrontmatterKeys<T>(obj: T): T {
	if (obj === null || typeof obj !== "object") return obj;
	if (Array.isArray(obj)) {
		let changed = false;
		const out: unknown[] = new Array(obj.length);
		for (let i = 0; i < obj.length; i++) {
			const v = obj[i];
			const nv = normalizeFrontmatterKeys(v);
			out[i] = nv;
			if (nv !== v) changed = true;
		}
		return (changed ? (out as unknown) : obj) as T;
	}
	let changed = false;
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
		const nk = key.includes("-") ? kebabToCamel(key) : key;
		const nv = normalizeFrontmatterKeys(value);
		result[nk] = nv;
		if (nk !== key || nv !== value) changed = true;
	}
	return (changed ? result : obj) as T;
}

const PLAIN_SCALAR_KEY_VALUE = /^(\s*[A-Za-z_][\w-]*:\s+)(\S.*?)(\s*)$/;
const FLOW_OR_EXPLICIT_VALUE_START = new Set(['"', "'", "[", "{", "|", ">", "!", "&", "*", "#"]);

function quoteAmbiguousPlainScalars(metadata: string): string | undefined {
	let changed = false;
	const lines = metadata.split("\n").map(line => {
		const match = line.match(PLAIN_SCALAR_KEY_VALUE);
		if (!match) return line;
		const [, prefix, rawValue, suffix] = match;
		const value = rawValue.trimEnd();
		if (!value.includes(": ")) return line;
		if (FLOW_OR_EXPLICIT_VALUE_START.has(value[0])) return line;
		changed = true;
		return `${prefix}${JSON.stringify(value)}${suffix}`;
	});
	return changed ? lines.join("\n") : undefined;
}

function parseYamlRecord(metadata: string, repairTabs: boolean): Record<string, unknown> | null {
	const loaded = YAML.parse(repairTabs ? metadata.replaceAll("\t", "  ") : metadata);
	if (loaded === null || loaded === undefined) return null;
	if (typeof loaded !== "object" || Array.isArray(loaded)) return null;
	return loaded as Record<string, unknown>;
}

export class FrontmatterError extends Error {
	constructor(
		error: Error,
		readonly source?: unknown,
	) {
		super(`Failed to parse YAML frontmatter (${source}): ${error.message}`, { cause: error });
		this.name = "FrontmatterError";
	}

	override toString(): string {
		// Format the error with stack and detail, including the error message, stack, and source if present
		const details: string[] = [this.message];
		if (this.source !== undefined) {
			details.push(`Source: ${JSON.stringify(this.source)}`);
		}
		if (this.cause && typeof this.cause === "object" && "stack" in this.cause && this.cause.stack) {
			details.push(`Stack:\n${this.cause.stack}`);
		} else if (this.stack) {
			details.push(`Stack:\n${this.stack}`);
		}
		return details.join("\n\n");
	}
}

export interface FrontmatterOptions {
	/** Source of the content (alias: source) */
	location?: unknown;
	/** Source of the content (alias for location) */
	source?: unknown;
	/** Fallback frontmatter values */
	fallback?: Record<string, unknown>;
	/** Normalize the content */
	normalize?: boolean;
	/** Level of error handling */
	level?: "off" | "warn" | "fatal";
	/**
	 * Attempt lenient recovery of near-miss input before failing: quote
	 * ambiguous plain scalars, replace tabs with spaces, and strip leading HTML
	 * comments ahead of the opening delimiter. Default `true`. Spec-conformant
	 * loaders set `false` so malformed input is rejected instead of silently
	 * repaired (CRLF newline normalization still applies).
	 */
	repair?: boolean;
	/**
	 * Preserve frontmatter keys verbatim instead of normalizing kebab-case to
	 * camelCase. Default `false`. Strict spec loaders use this so a standard
	 * key (e.g. `allowed-tools`) is never aliased with its camelCase form.
	 */
	rawKeys?: boolean;
}

/**
 * Parse YAML frontmatter from markdown content
 * Returns { frontmatter, body } where body has frontmatter stripped
 */
export function parseFrontmatter(
	content: string,
	options?: FrontmatterOptions,
): { frontmatter: Record<string, unknown>; body: string } {
	const {
		location,
		source,
		fallback,
		normalize = true,
		level = "warn",
		repair = true,
		rawKeys = false,
	} = options ?? {};
	const finalizeKeys = (fm: Record<string, unknown>): Record<string, unknown> =>
		rawKeys ? fm : normalizeFrontmatterKeys(fm);
	const loc = location ?? source;
	const frontmatter: Record<string, unknown> = { ...fallback };

	const newlineNormalized = normalize ? content.replace(/\r\n?/g, "\n") : content;
	const normalized = normalize && repair ? stripHtmlComments(newlineNormalized) : newlineNormalized;
	if (!normalized.startsWith("---")) {
		return { frontmatter, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter, body: normalized };
	}

	const metadata = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	try {
		const loaded = parseYamlRecord(metadata, repair);
		return { frontmatter: finalizeKeys({ ...frontmatter, ...loaded }), body };
	} catch (error) {
		const quotedMetadata = repair ? quoteAmbiguousPlainScalars(metadata) : undefined;
		if (quotedMetadata) {
			try {
				const loaded = parseYamlRecord(quotedMetadata, true);
				return { frontmatter: finalizeKeys({ ...frontmatter, ...loaded }), body };
			} catch {
				// Fall through to the existing warning + simple key/value fallback.
			}
		}

		const err = new FrontmatterError(
			error instanceof Error ? error : new Error(`YAML: ${error}`),
			loc ?? `Inline '${truncate(content, 64)}'`,
		);
		if (level === "warn" || level === "fatal") {
			logger.warn("Failed to parse YAML frontmatter", { err: err.toString() });
		}
		if (level === "fatal") {
			throw err;
		}

		// Simple key: value fallback. Reparse each value on its own so one
		// malformed line (e.g. `scope: "text","thinking"`) can't leave sibling
		// values wrapped in literal quotes; values that don't parse as YAML fall
		// back to the raw trimmed string (issue #4796).
		for (const line of metadata.split("\n")) {
			const match = line.match(/^([\w-]+):\s*(.*)$/);
			if (!match) continue;
			const raw = match[2].trim();
			let value: unknown = raw;
			if (raw.length > 0) {
				try {
					const parsed = YAML.parse(raw);
					if (parsed !== null && typeof parsed !== "object") value = parsed;
					else if (Array.isArray(parsed)) value = parsed;
				} catch {
					// keep the raw string
				}
			}
			frontmatter[match[1]] = value;
		}

		return { frontmatter: finalizeKeys(frontmatter), body };
	}
}
