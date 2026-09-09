import { isRecord } from "@oh-my-pi/pi-utils";
import type {
	ChangelogCategory,
	CommitType,
	ConventionalAnalysis,
	ConventionalCommit,
	ConventionalDetail,
} from "../types";
import commitTypesResource from "./resources/commit_types.json" with { type: "json" };

/** Conventional commit types in llm-git's canonical classification order. */
export const COMMIT_TYPE_ORDER: readonly CommitType[] = [
	"feat",
	"fix",
	"refactor",
	"docs",
	"test",
	"chore",
	"style",
	"perf",
	"build",
	"ci",
	"revert",
	"deps",
	"security",
	"config",
	"ux",
	"release",
	"hotfix",
	"infra",
	"init",
	"merge",
	"hack",
	"wip",
];

const COMMIT_TYPE_SET: Record<string, true> = {
	feat: true,
	fix: true,
	refactor: true,
	docs: true,
	test: true,
	chore: true,
	style: true,
	perf: true,
	build: true,
	ci: true,
	revert: true,
	deps: true,
	security: true,
	config: true,
	ux: true,
	release: true,
	hotfix: true,
	infra: true,
	init: true,
	merge: true,
	hack: true,
	wip: true,
};
const TYPE_ALIASES = new Map<string, CommitType>();
for (const entry of commitTypesResource.types) {
	if (!isCommitType(entry.name)) continue;
	for (const alias of entry.aliases) TYPE_ALIASES.set(alias.toLowerCase(), entry.name);
}

const CHANGELOG_CATEGORY_BY_NAME: Record<string, ChangelogCategory> = {
	"breaking changes": "Breaking Changes",
	breaking: "Breaking Changes",
	added: "Added",
	changed: "Changed",
	deprecated: "Deprecated",
	removed: "Removed",
	fixed: "Fixed",
	security: "Security",
};

const NULL_SCOPE_MARKERS: Record<string, true> = { null: true, none: true, "n/a": true };

/** Return whether a string is an accepted conventional commit type. */
export function isCommitType(value: string): value is CommitType {
	return COMMIT_TYPE_SET[value] === true;
}

/** Resolve a canonical commit type or configured alias. */
export function canonicalCommitType(raw: string): CommitType | undefined {
	const normalized = raw.trim().toLowerCase();
	if (isCommitType(normalized)) return normalized;
	return TYPE_ALIASES.get(normalized);
}

/** Resolve a model-emitted type, falling back to `chore` when unknown. */
export function coerceCommitType(raw: string): CommitType {
	return canonicalCommitType(raw) ?? "chore";
}

/** Resolve a model-emitted scope using llm-git's lossy two-segment normalization. */
export function coerceOptionalScope(raw: unknown): string | null {
	if (raw === null || raw === undefined) return null;
	const trimmed = String(raw).trim();
	if (!trimmed || NULL_SCOPE_MARKERS[trimmed.toLowerCase()]) return null;
	const segments: string[] = [];
	for (const segment of trimmed.replaceAll("\\", "/").toLowerCase().split("/")) {
		const cleaned = sanitizeScopeSegment(segment);
		if (cleaned) segments.push(cleaned);
		if (segments.length === 2) break;
	}
	return segments.length > 0 ? segments.join("/") : null;
}

/** Render the configured commit-type vocabulary injected into analysis prompts. */
export function formatTypesDescription(): string {
	const lines: string[] = [];
	for (const entry of commitTypesResource.types) {
		if (!isCommitType(entry.name)) continue;
		let line = `- ${entry.name}: ${entry.description}`.trimEnd();
		if (entry.hint) line += ` (${entry.hint})`;
		lines.push(line);
	}
	const classifierHint = commitTypesResource.classifier_hint.trim();
	if (classifierHint) lines.push(classifierHint);
	return lines.join("\n");
}

/** Normalize raw model analysis into the conventional commit domain. */
export function conventionalAnalysis(input: {
	type: string;
	scope?: unknown;
	summary?: unknown;
	details?: unknown;
	issueRefs?: unknown;
}): ConventionalAnalysis {
	const type = canonicalCommitType(input.type);
	if (!type) throw new Error(`Invalid commit type: ${input.type}`);
	return {
		type,
		scope: coerceOptionalScope(input.scope),
		summary: typeof input.summary === "string" ? input.summary : undefined,
		details: normalizeDetails(input.details),
		issueRefs: stringsFrom(input.issueRefs),
	};
}

/** Build a normalized conventional commit value. */
export function conventionalCommit(input: {
	type: string;
	scope?: unknown;
	summary: string;
	body?: readonly string[];
	footers?: readonly string[];
}): ConventionalCommit {
	const type = canonicalCommitType(input.type);
	if (!type) throw new Error(`Invalid commit type: ${input.type}`);
	const scope = coerceOptionalScope(input.scope);
	if (!input.summary.trim()) throw new Error("Commit summary cannot be empty");
	return {
		type,
		scope,
		summary: input.summary,
		body: [...(input.body ?? [])],
		footers: [...(input.footers ?? [])],
	};
}

function sanitizeScopeSegment(segment: string): string | null {
	const out: string[] = [];
	let lastWasSeparator = false;
	for (const char of segment.trim()) {
		if (/^[a-z0-9]$/.test(char)) {
			out.push(char);
			lastWasSeparator = false;
		} else if (char === "-" || char === "_") {
			if (out.length > 0 && !lastWasSeparator) {
				out.push(char);
				lastWasSeparator = true;
			}
		} else if ((/\s/.test(char) || char === ".") && out.length > 0 && !lastWasSeparator) {
			out.push("-");
			lastWasSeparator = true;
		}
	}
	const cleaned = out.join("").replace(/^[-_]+|[-_]+$/g, "");
	return cleaned || null;
}

function normalizeDetails(value: unknown): ConventionalDetail[] {
	const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
	const details: ConventionalDetail[] = [];
	for (const item of values) {
		if (typeof item === "string") {
			if (item) details.push({ text: item, userVisible: false });
			continue;
		}
		if (!isRecord(item) || item.text === null || item.text === undefined) continue;
		const text = String(item.text);
		if (!text) continue;
		const category =
			typeof item.changelog_category === "string" ? changelogCategory(item.changelog_category) : undefined;
		const userVisible = typeof item.user_visible === "boolean" ? item.user_visible : false;
		details.push({ text, changelogCategory: userVisible ? category : undefined, userVisible });
	}
	return details;
}

function changelogCategory(raw: string): ChangelogCategory {
	const category = CHANGELOG_CATEGORY_BY_NAME[raw.trim().toLowerCase()];
	if (!category) throw new Error(`Unknown changelog category: ${raw}`);
	return category;
}

function stringsFrom(value: unknown): string[] {
	if (value === null || value === undefined) return [];
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.startsWith("[")) {
			try {
				return stringsFrom(JSON.parse(trimmed));
			} catch {}
		}
		return value
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(Boolean);
	}
	if (Array.isArray(value)) return value.flatMap(stringsFrom);
	if (isRecord(value)) {
		const strings: string[] = [];
		for (const key in value) {
			const inner = value[key];
			const innerValues = stringsFrom(inner);
			strings.push(...(innerValues.length === 0 ? [key] : innerValues.map(item => `${key}: ${item}`)));
		}
		return strings;
	}
	return [String(value)];
}
