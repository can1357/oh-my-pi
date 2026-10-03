import { isRecord } from "@oh-my-pi/pi-utils";
import type { CommitType, ConventionalAnalysis, ConventionalCommit, ConventionalDetail } from "../types";
import { canonicalCommitType, coerceCommitType, conventionalAnalysis, conventionalCommit } from "./commit-types";
import { codePointLength, sliceCodePoints } from "./text";

const PREFIX_RE = /^\s*(?:#+\s*)?(?<type>[a-z][a-z0-9-]*)(?:\((?<scope>[^)]+)\))?!?\s*:\s*(?<summary>.+?)\s*$/i;
const ISSUE_RE = /#\d+(?:\s*-\s*#?\d+)?/g;
const CATEGORY_RE =
	/^\s*(?:\[(?<bracket>[^\]]+)\]|(?<prefix>Added|Changed|Fixed|Deprecated|Removed|Security|Breaking Changes)\s*:)\s*(?<text>.*)$/i;

const SUMMARY_VERB_BY_TYPE: Partial<Record<CommitType, string>> = {
	feat: "added",
	fix: "fixed",
	refactor: "restructured",
	docs: "documented",
	test: "tested",
	perf: "optimized",
	build: "updated",
	ci: "updated",
	chore: "updated",
	style: "formatted",
	revert: "reverted",
};

const SAFE_SUMMARY_BY_TYPE: Partial<Record<CommitType, string>> = {
	refactor: "restructured change",
	feat: "added functionality",
	fix: "fixed issue",
	docs: "documented updates",
	test: "tested changes",
	chore: "updated tooling",
	build: "updated tooling",
	ci: "updated tooling",
	style: "updated tooling",
	perf: "optimized performance",
	revert: "reverted previous commit",
};

/** Remove a conventional type/scope prefix from model summary text. */
export function stripTypePrefix(text: string, commitType?: string, scope?: string | null): string {
	if (commitType !== undefined) {
		const trimmed = text.trim();
		const prefixes = scope ? [`${commitType}(${scope}): `, `${commitType}: `] : [`${commitType}: `];
		for (const prefix of prefixes) {
			if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return trimmed.slice(prefix.length).trim();
		}
		const parsed = trimmed.match(/^([a-z][a-z0-9-]*)(?:\(([^)]*)\))?:\s+(.*)$/i);
		return parsed?.[1]?.toLowerCase() === commitType.toLowerCase() ? (parsed[3]?.trim() ?? "") : trimmed;
	}
	const cleaned = cleanMarkdownText(text);
	const firstLine = text.trim() ? (cleaned.split(/\r?\n/, 1)[0]?.trim() ?? "") : "";
	const match = firstLine.match(PREFIX_RE);
	const summary = match?.groups?.summary ?? firstLine;
	return stripTrailingPeriod(stripWrappingQuotes(summary.trim()));
}

/** Generate llm-git's deterministic type-aware fallback summary. */
export function fallbackSummary(
	stat = "",
	details: Iterable<string> = [],
	diff = "",
	options: { limit?: number; commitType?: string } = {},
): string {
	const commitType = canonicalCommitType(options.commitType ?? "chore") ?? "chore";
	let candidate = "";
	let needsVerb = false;
	for (const detail of details) {
		candidate = stripTypePrefix(
			String(detail)
				.replace(/^[-*•–+\s]+/, "")
				.trim(),
		);
		if (!candidate) continue;
		const stripped = stripLeadingTypeWord(candidate, commitType);
		candidate = stripped.text;
		needsVerb = stripped.needsVerb;
		break;
	}
	if (!candidate) {
		const area = primaryStatSubject(stat) ?? primaryStatSubject(diff);
		candidate = !area || area.toLowerCase() === "files" ? "Updated files" : `Updated ${area}`;
	}
	candidate = candidate.replaceAll("\n", " ").replaceAll("\r", " ").split(/\s+/).filter(Boolean).join(" ");
	candidate =
		candidate
			.trim()
			.replace(/[.;:]+$/g, "")
			.trim() || "Updated files";
	if (needsVerb && !startsWithPastTense(candidate))
		candidate = `${SUMMARY_VERB_BY_TYPE[commitType] ?? "changed"} ${candidate}`;
	const limit = Math.max(1, options.limit ?? 72);
	candidate = truncateSummary(candidate, limit).replace(/\.+$/g, "");
	const firstWord = candidate.split(/\s+/, 1)[0] ?? "";
	if (firstWord.toLowerCase() === commitType) candidate = SAFE_SUMMARY_BY_TYPE[commitType] ?? "updated files";
	return truncateSummary(candidate, limit);
}

/** Parse summary output from markdown, XML-ish tags, JSON, or plain text. */
export function parseSummaryMarkdown(text: string): string {
	if (!text.trim()) return "";
	const json = tryJson(text);
	if (isRecord(json)) {
		for (const key of ["summary", "title", "message"]) {
			const value = json[key];
			if (typeof value === "string" && value.trim()) return stripTypePrefix(value);
		}
	}
	const cleaned = cleanMarkdownText(text);
	const tagged = extractTagLenient(cleaned, "summary");
	let summary = tagged ?? cleaned;
	summary = stripHeadingMarkers(summary);
	summary = stripLabelPrefix(summary);
	summary = stripWrappingQuotes(summary);
	summary = summary.split(/\s+/).filter(Boolean).join(" ");
	if (!summary) throw new Error("Markdown summary empty after normalization");
	return stripTypePrefix(summary);
}

/** Parse a conventional analysis from llm-git's lenient markdown contract. */
export function parseConventionalAnalysisMarkdown(
	text: string,
	defaultType: CommitType = "chore",
): ConventionalAnalysis {
	const payload = tryJson(text);
	if (isRecord(payload)) return analysisFromMapping(payload, defaultType);
	const lines = cleanMarkdownText(text).split(/\r?\n/);
	let heading: { index: number; type: CommitType; scope: string | null; summary: string } | undefined;
	let coerced: typeof heading;
	for (let index = 0; index < Math.min(5, lines.length); index += 1) {
		const line = lines[index] ?? "";
		const candidate = stripHeadingMarkers(line);
		const parsed = parseHeadingLine(candidate, false);
		if (parsed) {
			heading = { index, ...parsed };
			break;
		}
		if (!coerced && line.trim().startsWith("#")) {
			const fallback = parseHeadingLine(candidate, true);
			if (fallback) coerced = { index, ...fallback };
		}
	}
	heading ??= coerced;
	if (!heading) throw new Error("Markdown analysis type(scope): summary heading not found");
	const detailTexts: string[] = [];
	const issueRefs: string[] = [];
	for (const line of lines.slice(heading.index + 1)) {
		const stripped = line.trim();
		if (!stripped) continue;
		const lower = stripped.toLowerCase();
		if (lower.startsWith("fixes:") || lower.startsWith("closes:") || lower.startsWith("resolves:")) {
			const separator = stripped.indexOf(":");
			for (const ref of stripped.slice(separator + 1).split(",")) if (ref.trim()) issueRefs.push(ref.trim());
			continue;
		}
		const bullet = stripBullet(stripped);
		if (!bullet) continue;
		detailTexts.push(ensureSentence(bullet));
		issueRefs.push(...(bullet.match(ISSUE_RE) ?? []));
	}
	return conventionalAnalysis({
		type: heading.type,
		scope: heading.scope,
		summary: heading.summary,
		details: dedupe(detailTexts),
		issueRefs: dedupe(issueRefs),
	});
}

/** Parse a complete conventional commit from markdown or JSON text. */
export function parseFastCommitMarkdown(text: string, defaultType: CommitType = "chore"): ConventionalCommit {
	const payload = tryJson(text);
	const analysis = isRecord(payload)
		? analysisFromMapping(payload, defaultType)
		: parseConventionalAnalysisMarkdown(text, defaultType);
	return conventionalCommit({
		type: analysis.type,
		scope: analysis.scope,
		summary:
			analysis.summary ??
			fallbackSummary(
				"",
				analysis.details.map(detail => detail.text),
			),
		body: analysis.details.map(detail => detail.text),
	});
}

/** Coerce a JSON-like payload into conventional analysis. */
export function analysisFromMapping(
	payload: Record<string, unknown>,
	defaultType: CommitType = "chore",
): ConventionalAnalysis {
	const typeValue = payload.type ?? payload.commit_type ?? defaultType;
	const type = String(typeValue).trim() || defaultType;
	const rawScope = payload.scope;
	const scopeText = rawScope === null || rawScope === undefined ? "" : String(rawScope).trim();
	const scope = ["", "null", "none", "(none)"].includes(scopeText.toLowerCase()) ? null : scopeText;
	const summary = stripTypePrefix(String(payload.summary ?? "")) || undefined;
	const rawDetails = payload.details ?? payload.body ?? [];
	const details: ConventionalDetail[] = [];
	for (const item of iterable(rawDetails)) {
		const detail = coerceDetail(item);
		if (detail) details.push(detail);
	}
	const issueRefs = iterable(payload.issue_refs ?? payload.issues ?? [])
		.map(item => String(item).trim())
		.filter(Boolean);
	return conventionalAnalysis({ type, scope, summary, details, issueRefs });
}

/** Parse map-phase file observations from JSON or lenient markdown. */
export function parseFileObservationsMarkdown(text: string): Array<{ path: string; observations: string[] }> {
	const payload = tryJson(text);
	if (isRecord(payload) && Array.isArray(payload.files)) {
		return payload.files.filter(isRecord).map(coerceFileObservations);
	}
	if (Array.isArray(payload)) return payload.filter(isRecord).map(coerceFileObservations);
	const files: Array<{ path: string; observations: string[] }> = [];
	let currentPath: string | undefined;
	let observations: string[] = [];
	for (const line of cleanMarkdownText(text).split(/\r?\n/)) {
		const stripped = line.trim();
		if (!stripped) continue;
		const heading = stripped.match(/^(?:#+\s*)?(?:file\s*[:=-]\s*)?`?([^`]+?)`?\s*:??$/i);
		const bullet = stripBullet(stripped);
		const candidate = heading?.[1] ?? "";
		if (!bullet && candidate && (candidate.includes("/") || candidate.includes("."))) {
			if (currentPath !== undefined) files.push({ path: currentPath, observations });
			currentPath = candidate.trim();
			observations = [];
		} else if (bullet && currentPath !== undefined) {
			observations.push(stripTrailingPeriod(bullet));
		}
	}
	if (currentPath !== undefined) files.push({ path: currentPath, observations });
	return files;
}

function coerceDetail(item: unknown): ConventionalDetail | null {
	let text = detailText(item);
	if (!text) return null;
	let category: ConventionalDetail["changelogCategory"];
	let userVisible = false;
	if (isRecord(item)) {
		const rawCategory = item.changelog_category ?? item.category;
		if (typeof rawCategory === "string") category = changelogCategory(rawCategory);
		userVisible = typeof item.user_visible === "boolean" ? item.user_visible : category !== undefined;
	} else {
		const stripped = stripCategoryPrefix(text);
		text = stripped.text;
		category = stripped.category;
		userVisible = category !== undefined;
	}
	return { text: ensureSentence(text), changelogCategory: category, userVisible };
}

function detailText(item: unknown): string {
	if (!isRecord(item)) return String(item).trim();
	return String(item.text ?? item.summary ?? item.detail ?? "").trim();
}

function coerceFileObservations(item: Record<string, unknown>): { path: string; observations: string[] } {
	return {
		path: String(item.path ?? item.file ?? ""),
		observations: observationStrings(item.observations ?? item.details ?? []),
	};
}

function observationStrings(value: unknown): string[] {
	if (typeof value === "string") {
		const stripped = value.trim();
		if (stripped.startsWith("[")) {
			try {
				const decoded = JSON.parse(stripped);
				if (Array.isArray(decoded))
					return decoded
						.map(String)
						.map(item => item.trim())
						.filter(Boolean);
			} catch {}
		}
		return stripped
			.split(/\r?\n/)
			.map(line => line.replace(/^[-*•\s]+/, "").trim())
			.filter(Boolean);
	}
	return iterable(value)
		.map(String)
		.map(item => item.trim())
		.filter(Boolean);
}

function iterable(value: unknown): unknown[] {
	if (value === null || value === undefined) return [];
	if (typeof value === "string") return value.trim() ? [value] : [];
	return Array.isArray(value) ? value : [value];
}

function stripLeadingTypeWord(text: string, commitType: CommitType): { text: string; needsVerb: boolean } {
	const cleaned = text.trim().replace(/\.+$/g, "");
	const variants = [commitType, `${commitType}ed`, `${commitType}d`].sort((left, right) => right.length - left.length);
	for (const variant of variants) {
		if (cleaned.toLowerCase().startsWith(`${variant.toLowerCase()} `)) {
			return { text: cleaned.slice(variant.length).trim(), needsVerb: true };
		}
	}
	return { text: cleaned, needsVerb: false };
}

function startsWithPastTense(text: string): boolean {
	const first = text.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
	return (
		first.endsWith("ed") ||
		["built", "changed", "documented", "fixed", "optimized", "restructured", "updated"].includes(first)
	);
}

function primaryStatSubject(text: string): string | null {
	for (const line of text.split(/\r?\n/)) {
		const stripped = line.trim();
		if (!stripped) continue;
		return stripped.split("|", 1)[0]?.trim() || "files";
	}
	return null;
}

function tryJson(text: string): unknown {
	const cleaned = cleanMarkdownText(text).trim();
	const fenced = text.match(/```(?:json|markdown|md)?\s*(.*?)```/is);
	const normalized = fenced?.[1]?.trim() ?? cleaned;
	const objectStart = normalized.indexOf("{");
	const objectEnd = normalized.lastIndexOf("}");
	const arrayStart = normalized.indexOf("[");
	const arrayEnd = normalized.lastIndexOf("]");
	const extracted =
		objectStart >= 0 && objectEnd >= objectStart
			? normalized.slice(objectStart, objectEnd + 1)
			: arrayStart >= 0 && arrayEnd >= arrayStart
				? normalized.slice(arrayStart, arrayEnd + 1)
				: normalized;
	const candidates = extracted === cleaned ? [extracted] : [extracted, cleaned];
	for (const candidate of candidates) {
		if (!candidate || (candidate[0] !== "[" && candidate[0] !== "{")) continue;
		try {
			return JSON.parse(candidate);
		} catch {}
	}
	return null;
}

function cleanMarkdownText(text: string): string {
	let cleaned = normalizeEscapedWhitespace(text.trim());
	if (cleaned.startsWith("```")) {
		const afterOpen = cleaned.slice(3);
		const contentStart = afterOpen.indexOf("\n");
		if (contentStart >= 0) {
			const body = afterOpen.slice(contentStart + 1);
			const end = body.lastIndexOf("```");
			cleaned = (end >= 0 ? body.slice(0, end) : body).trim();
		}
	} else {
		cleaned = cleaned
			.split(/\r?\n/)
			.filter(line => line.trim() !== "```" && !line.trimStart().startsWith("```"))
			.join("\n")
			.trim();
	}
	return cleaned.replaceAll("\r\n", "\n");
}

function stripBullet(line: string): string | null {
	const stripped = line.trimStart();
	for (const glyph of ["- ", "* ", "• ", "– ", "+ "]) {
		if (stripped.startsWith(glyph)) return stripped.slice(glyph.length).trim() || null;
	}
	return stripped.match(/^\s*\d+[.)]\s+(?<text>.+)$/)?.groups?.text?.trim() ?? null;
}

function stripCategoryPrefix(text: string): { text: string; category?: ConventionalDetail["changelogCategory"] } {
	const match = text.match(CATEGORY_RE);
	if (!match?.groups) return { text: text.trim() };
	return {
		text: (match.groups.text ?? "").trim(),
		category: changelogCategory(match.groups.bracket ?? match.groups.prefix ?? ""),
	};
}

function changelogCategory(raw: string): ConventionalDetail["changelogCategory"] {
	const normalized = raw.trim().toLowerCase();
	if (normalized === "breaking" || normalized === "breaking changes") return "Breaking Changes";
	if (normalized === "added") return "Added";
	if (normalized === "changed") return "Changed";
	if (normalized === "fixed") return "Fixed";
	if (normalized === "deprecated") return "Deprecated";
	if (normalized === "removed") return "Removed";
	if (normalized === "security") return "Security";
	throw new Error(`Unknown changelog category: ${raw}`);
}

function stripWrappingQuotes(text: string): string {
	const pairs: Record<string, string> = { '"': '"', "'": "'", "`": "`", "“": "”", "‘": "’" };
	const stripped = text.trim();
	return stripped.length >= 2 && pairs[stripped[0] ?? ""] === stripped.at(-1)
		? stripped.slice(1, -1).trim()
		: stripped;
}

function normalizeEscapedWhitespace(text: string): string {
	if (!text.includes("\\")) return text;
	const parts = text.split("`");
	for (let index = 0; index < parts.length; index += 2) {
		parts[index] = (parts[index] ?? "")
			.replaceAll("\\r\\n", "\n")
			.replaceAll("\\n", "\n")
			.replaceAll("\\r", "\n")
			.replaceAll("\\t", "\t");
	}
	return parts.join("`");
}

function extractTagLenient(text: string, tag: string): string | null {
	const open = text.toLowerCase().indexOf(`<${tag}`);
	if (open < 0) return null;
	const openEnd = text.indexOf(">", open);
	if (openEnd < 0) return null;
	const rest = text.slice(openEnd + 1);
	const close = rest.indexOf("</");
	return (close >= 0 ? rest.slice(0, close) : rest).trim();
}

function stripLabelPrefix(text: string): string {
	const stripped = text.trim();
	const separator = stripped.indexOf(":");
	if (separator < 0) return stripped;
	const label = stripped.slice(0, separator).trim().toLowerCase();
	return ["title", "summary", "description", "result"].includes(label)
		? stripped.slice(separator + 1).trim()
		: stripped;
}

function stripHeadingMarkers(text: string): string {
	let stripped = text
		.trim()
		.replace(/^#+\s*/, "")
		.trim();
	for (const marker of ["**", "*", "__", "_"]) {
		if (stripped.startsWith(marker) && stripped.endsWith(marker) && stripped.length > marker.length * 2) {
			stripped = stripped.slice(marker.length, -marker.length).trim();
		}
	}
	return stripped;
}

function parseHeadingLine(
	line: string,
	coerce: boolean,
): { type: CommitType; scope: string | null; summary: string } | null {
	const split = splitHeading(line);
	if (!split) return null;
	const canonical = canonicalCommitType(split.type);
	if (canonical) return { ...split, type: canonical };
	if (coerce && /^[A-Za-z][A-Za-z-]*$/.test(split.type) && !/^["{[]/.test(split.summary)) {
		return { ...split, type: coerceCommitType(split.type) };
	}
	return null;
}

function splitHeading(line: string): { type: string; scope: string | null; summary: string } | null {
	const separator = line.indexOf(":");
	if (separator < 0) return null;
	let type = line.slice(0, separator).trim();
	const summary = line.slice(separator + 1).trim();
	if (!type || !summary) return null;
	let scope: string | null = null;
	const scopeStart = type.indexOf("(");
	if (scopeStart >= 0) {
		const scopeEnd = type.indexOf(")", scopeStart + 1);
		if (scopeEnd < 0) return null;
		scope = type.slice(scopeStart + 1, scopeEnd).trim() || null;
		type = type.slice(0, scopeStart).trim();
	}
	return type ? { type, scope, summary } : null;
}

function stripTrailingPeriod(text: string): string {
	return text.trimEnd().endsWith(".") ? text.trimEnd().slice(0, -1).trimEnd() : text.trim();
}

function ensureSentence(text: string): string {
	const cleaned = text.trim();
	return !cleaned || /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function truncateSummary(text: string, limit: number): string {
	const cleaned = stripTrailingPeriod(text.trim());
	if (codePointLength(cleaned) <= limit) return cleaned;
	const sliced = sliceCodePoints(cleaned, 0, Math.max(1, limit));
	const breakAt = sliced.lastIndexOf(" ");
	return (
		(breakAt >= 0 ? sliced.slice(0, breakAt) : sliced).replace(/[ ,;:-]+$/g, "") ||
		sliceCodePoints(cleaned, 0, limit).replace(/[ ,;:-]+$/g, "")
	);
}

function dedupe(values: Iterable<string>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const key = value.trim().toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		result.push(value.trim());
	}
	return result;
}
