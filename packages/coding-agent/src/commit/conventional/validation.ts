import * as path from "node:path";
import type { ConventionalCommit } from "../types";
import { COMMIT_TYPE_ORDER, isCommitType } from "./commit-types";
import type { ConventionalGenerationConfig } from "./config";
import validationResource from "./resources/validation_data.json" with { type: "json" };

/** Severity attached to a conventional commit validation issue. */
export type ValidationSeverity = "error" | "warning";

/** One structured conventional commit validation diagnostic. */
export interface ValidationIssue {
	severity: ValidationSeverity;
	field: string;
	code: string;
	message: string;
	value?: string;
}

/** Blocking errors and advisory warnings from conventional validation. */
export interface ValidationReport {
	errors: ValidationIssue[];
	warnings: ValidationIssue[];
	ok: boolean;
}

const PAST_BY_PRESENT: Record<string, string> = {};
const IRREGULAR_PAST = new Set(validationResource.irregular_past.map(value => value.toLowerCase()));
for (const pair of validationResource.past_tense) {
	const present = pair[0]?.toLowerCase();
	const past = pair[1]?.toLowerCase();
	if (!present || !past) continue;
	PAST_BY_PRESENT[present] = past;
	if (present === past) IRREGULAR_PAST.add(past);
}
const ED_BLOCKLIST = new Set(validationResource.ed_blocklist.map(value => value.toLowerCase()));
const D_BLOCKLIST = new Set(validationResource.d_blocklist.map(value => value.toLowerCase()));
const CODE_EXTENSIONS = new Set(validationResource.code_extensions.map(value => value.toLowerCase()));
const DOC_EXTENSIONS = new Set(validationResource.doc_extensions.map(value => value.toLowerCase()));
const FILLER_WORDS = validationResource.filler_words.map(value => value.toLowerCase());
const META_PHRASES = validationResource.meta_phrases.map(value => value.toLowerCase());
const BODY_PRESENT_TENSE = new Set(validationResource.body_present_tense.map(value => value.toLowerCase()));

/** Return the configured past-tense form for a present-tense verb. */
export function presentToPast(present: string): string | undefined {
	return PAST_BY_PRESENT[present.toLowerCase()];
}

/** Rewrite a leading present-tense verb, or return `null` when no repair applies. */
export function repairSummaryTense(summary: string): string | null {
	const words = summary.split(/\s+/, 2);
	if (!words[0]) return null;
	const past = presentToPast(words[0]);
	if (!past) return null;
	return words.length === 1 ? past : `${past} ${summary.slice(words[0].length).trimStart()}`;
}

/** Split the leading ASCII verb segment from punctuation or suffix text. */
export function splitVerbToken(token: string): [string, string] | null {
	let index = 0;
	for (const character of token) {
		if (!/^[A-Za-z]$/.test(character)) break;
		index += 1;
	}
	return index === 0 ? null : [token.slice(0, index), token.slice(index)];
}

/** Return a lowercase leading verb stem, excluding acronyms and numbers. */
export function verbStem(token: string): string | null {
	const split = splitVerbToken(token);
	if (!split || split[0] === split[0].toUpperCase()) return null;
	return split[0].toLowerCase();
}

/** Return whether a bare word looks like a past-tense verb. */
export function isPastTenseVerb(word: string): boolean {
	const lower = word.toLowerCase();
	for (const present in PAST_BY_PRESENT) {
		if (PAST_BY_PRESENT[present] === lower && present !== lower) return true;
	}
	if (lower.endsWith("ed")) return !ED_BLOCKLIST.has(lower);
	if (lower.length >= 4 && lower.endsWith("d") && "aeiou".includes(lower.at(-2) ?? "")) {
		return !D_BLOCKLIST.has(lower);
	}
	return IRREGULAR_PAST.has(lower);
}

/** Return whether a raw first summary token is acceptable past tense. */
export function isPastTenseFirstWord(token: string): boolean {
	if (!token) return false;
	if (isPastTenseVerb(token.toLowerCase())) return true;
	const stem = verbStem(token);
	if (stem && isPastTenseVerb(stem)) return true;
	const split = splitVerbToken(token);
	if (!split) return false;
	const [stemRaw, suffix] = split;
	if (stemRaw.toLowerCase() !== "re" || !suffix.startsWith("-")) return false;
	const innerMatch = suffix.slice(1).match(/^[A-Za-z]+/);
	if (!innerMatch) return false;
	const inner = innerMatch[0].toLowerCase();
	return isPastTenseVerb(inner) || presentToPast(inner) !== undefined;
}

/** Validate summary semantics before a conventional commit is built. */
export function validateSummaryQuality(summary: string, commitType: string, stat = ""): ValidationReport {
	const report = emptyReport();
	const cleaned = summary.trim();
	if (!cleaned) {
		addIssue(report, "error", "summary", "empty_summary", "summary is empty");
		return finishReport(report);
	}
	validateSummaryContent(cleaned, commitType, stat, report);
	return finishReport(report);
}

/** Validate a normalized conventional commit against llm-git's exact rules. */
export function validateCommitMessage(
	message: ConventionalCommit,
	config: ConventionalGenerationConfig,
	options: { stat?: string; projectNames?: readonly string[] } = {},
): ValidationReport {
	const report = emptyReport();
	if (!isCommitType(message.type)) {
		addIssue(
			report,
			"error",
			"type",
			"invalid_type",
			`Invalid commit type: ${JSON.stringify(message.type)}. Must be one of: ${COMMIT_TYPE_ORDER.join(", ")}`,
			message.type,
		);
	}
	validateScope(message.scope, options.projectNames ?? [], report);
	validateSummary(message, config, report);
	if (message.summary.trim()) validateSummaryContent(message.summary, message.type, options.stat ?? "", report);
	validateBody(message.body, report);
	if (options.stat) typeScopeConsistency(message.type, options.stat, message.body, report);
	return finishReport(report);
}

/** Return advisory type/file-stat consistency diagnostics. */
export function checkTypeScopeConsistency(message: ConventionalCommit, stat: string): ValidationReport {
	const report = emptyReport();
	typeScopeConsistency(message.type, stat, message.body, report);
	return finishReport(report);
}

function emptyReport(): ValidationReport {
	return { errors: [], warnings: [], ok: true };
}

function finishReport(report: ValidationReport): ValidationReport {
	report.ok = report.errors.length === 0;
	return report;
}

function addIssue(
	report: ValidationReport,
	severity: ValidationSeverity,
	field: string,
	code: string,
	message: string,
	value?: string,
): void {
	const issue: ValidationIssue = { severity, field, code, message, value };
	if (severity === "error") report.errors.push(issue);
	else report.warnings.push(issue);
}

function validateScope(scope: string | null, projectNames: readonly string[], report: ValidationReport): void {
	if (scope === null) return;
	if (!scope) {
		addIssue(report, "error", "scope", "empty_scope", "Scope cannot be empty string; omit it instead", scope);
		return;
	}
	const normalized = scope.toLowerCase().replaceAll("-", "").replaceAll("_", "");
	if (projectNames.some(name => name.toLowerCase().replaceAll("-", "").replaceAll("_", "") === normalized)) {
		addIssue(
			report,
			"error",
			"scope",
			"project_name_scope",
			`Scope ${JSON.stringify(scope)} is the project name; omit scope for project-wide changes`,
			scope,
		);
	}
}

function validateSummary(
	message: ConventionalCommit,
	config: ConventionalGenerationConfig,
	report: ValidationReport,
): void {
	const summary = message.summary;
	if (!summary.trim()) {
		addIssue(report, "error", "summary", "empty_summary", "Summary cannot be empty", summary);
		return;
	}
	if (summary.trimEnd().endsWith(".")) {
		addIssue(
			report,
			"error",
			"summary",
			"trailing_period",
			"Summary must NOT end with a period (conventional commits style)",
			summary,
		);
	}
	const firstLineLength =
		Buffer.byteLength(message.type) +
		(message.scope ? Buffer.byteLength(message.scope) + 2 : 0) +
		2 +
		Buffer.byteLength(summary);
	if (firstLineLength > config.summaryHardLimit) {
		addIssue(
			report,
			"error",
			"summary",
			"summary_too_long",
			`Summary line exceeds hard limit: ${firstLineLength} > ${config.summaryHardLimit} chars`,
			String(firstLineLength),
		);
	} else if (firstLineLength > config.summarySoftLimit) {
		addIssue(
			report,
			"warning",
			"summary",
			"summary_soft_limit",
			`Summary line exceeds soft limit: ${firstLineLength} > ${config.summarySoftLimit} chars`,
			String(firstLineLength),
		);
	} else if (firstLineLength > config.summaryGuideline) {
		addIssue(
			report,
			"warning",
			"summary",
			"summary_guideline",
			`Summary line exceeds guideline: ${firstLineLength} > ${config.summaryGuideline} chars`,
			String(firstLineLength),
		);
	}
}

function validateSummaryContent(summary: string, commitType: string, stat: string, report: ValidationReport): void {
	const firstWord = summary.split(/\s+/, 1)[0] ?? "";
	if (!firstWord) {
		addIssue(report, "error", "summary", "summary_missing_word", "Summary must contain at least one word");
		return;
	}
	if (!isPastTenseFirstWord(firstWord)) {
		addIssue(
			report,
			"error",
			"summary",
			"present_tense_first_word",
			`Summary must start with a past-tense verb (ending in -ed/-d or irregular). Got ${JSON.stringify(firstWord)}`,
			firstWord,
		);
	}
	if (firstWord.toLowerCase() === commitType) {
		addIssue(
			report,
			"error",
			"summary",
			"type_word_repetition",
			`Summary repeats commit type ${JSON.stringify(commitType)}: first word is ${JSON.stringify(firstWord)}`,
			firstWord,
		);
	}
	const lower = summary.toLowerCase();
	for (const filler of FILLER_WORDS) {
		if (lower.includes(filler))
			addIssue(
				report,
				"warning",
				"summary",
				"filler_word",
				`Summary contains filler word ${JSON.stringify(filler)}`,
				filler,
			);
	}
	for (const phrase of META_PHRASES) {
		if (lower.includes(phrase)) {
			addIssue(
				report,
				"warning",
				"summary",
				"meta_phrase",
				`Summary contains meta-phrase ${JSON.stringify(phrase)}; describe what changed`,
				phrase,
			);
		}
	}
	if (stat) summaryFileMismatch(commitType, stat, report);
}

function validateBody(body: readonly string[], report: ValidationReport): void {
	for (let index = 0; index < body.length; index += 1) {
		const stripped = (body[index] ?? "").trim();
		const firstWord = stripped.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
		if (BODY_PRESENT_TENSE.has(firstWord)) {
			addIssue(
				report,
				"warning",
				"body",
				"present_tense_body_item",
				`Body item uses present tense: ${JSON.stringify(stripped)}`,
				String(index),
			);
		}
		if (stripped && !stripped.endsWith(".")) {
			addIssue(
				report,
				"warning",
				"body",
				"missing_period_body_item",
				`Body item is missing a period: ${JSON.stringify(stripped)}`,
				String(index),
			);
		}
	}
}

function summaryFileMismatch(commitType: string, stat: string, report: ValidationReport): void {
	const extensions = statPaths(stat)
		.map(file => path.posix.extname(file).replace(/^\./, "").toLowerCase())
		.filter(Boolean);
	if (extensions.length === 0) return;
	const markdown = extensions.filter(extension => extension === "md").length;
	if (Math.floor((markdown * 100) / extensions.length) > 80 && commitType !== "docs") {
		addIssue(
			report,
			"warning",
			"type",
			"markdown_type_mismatch",
			`Type mismatch: ${Math.floor((markdown * 100) / extensions.length)}% .md files but type is ${JSON.stringify(commitType)}; consider docs`,
			commitType,
		);
	}
	const code = extensions.filter(extension => CODE_EXTENSIONS.has(extension)).length;
	if (code === 0 && (commitType === "feat" || commitType === "fix")) {
		addIssue(
			report,
			"warning",
			"type",
			"no_code_type_mismatch",
			`Type mismatch: no code files changed but type is ${JSON.stringify(commitType)}`,
			commitType,
		);
	}
}

function typeScopeConsistency(
	commitType: string,
	stat: string,
	body: readonly string[],
	report: ValidationReport,
): void {
	const paths = statPaths(stat);
	const lowerPaths = paths.map(file => file.toLowerCase());
	if (commitType === "docs") {
		const hasDocs = paths.some((file, index) => {
			const extension = path.posix.extname(file).replace(/^\./, "").toLowerCase();
			const lower = lowerPaths[index] ?? "";
			return DOC_EXTENSIONS.has(extension) || lower.includes("/docs/") || lower.includes("readme");
		});
		if (!hasDocs)
			addIssue(
				report,
				"warning",
				"type",
				"docs_without_docs",
				"Commit type 'docs' but no documentation files changed",
			);
	} else if (commitType === "test") {
		if (!lowerPaths.some(file => file.includes("/test") || file.includes("_test.") || file.includes(".test."))) {
			addIssue(report, "warning", "type", "test_without_tests", "Commit type 'test' but no test files changed");
		}
	} else if (commitType === "style") {
		if (paths.some(file => CODE_EXTENSIONS.has(path.posix.extname(file).replace(/^\./, "").toLowerCase()))) {
			addIssue(report, "warning", "type", "style_with_code", "Commit type 'style' but code files changed");
		}
	} else if (commitType === "ci") {
		if (
			!lowerPaths.some(
				file => file.includes(".github/workflows") || file.includes(".gitlab-ci") || file.includes("jenkinsfile"),
			)
		) {
			addIssue(report, "warning", "type", "ci_without_ci", "Commit type 'ci' but no CI configuration files changed");
		}
	} else if (commitType === "build") {
		if (
			!lowerPaths.some(
				file =>
					file.includes("cargo.toml") ||
					file.includes("package.json") ||
					file.includes("makefile") ||
					file.includes("build."),
			)
		) {
			addIssue(report, "warning", "type", "build_without_build", "Commit type 'build' but no build files changed");
		}
	} else if (commitType === "refactor") {
		if (
			stat
				.split(/\r?\n/)
				.some(line => line.trim().startsWith("create mode") || line.toLowerCase().includes("new file"))
		) {
			addIssue(
				report,
				"warning",
				"type",
				"refactor_with_new_files",
				"Commit type 'refactor' but new files were created; verify no new capabilities were added",
			);
		}
	} else if (commitType === "perf") {
		const hasFiles = lowerPaths.some(
			file => file.includes("bench") || file.includes("perf") || file.includes("profile"),
		);
		const details = body.join(" ").toLowerCase();
		const hasDetails = ["faster", "optimization", "performance", "optimized"].some(term => details.includes(term));
		if (!hasFiles && !hasDetails) {
			addIssue(
				report,
				"warning",
				"type",
				"perf_without_evidence",
				"Commit type 'perf' but no performance files or optimization keywords were found",
			);
		}
	}
}

function statPaths(stat: string): string[] {
	const paths: string[] = [];
	for (const line of stat.split(/\r?\n/)) {
		const stripped = line.trim();
		if (!stripped) continue;
		if (stripped.startsWith("create mode")) {
			const parts = stripped.split(/\s+/, 4);
			if (parts.length === 4 && parts[3]) paths.push(parts[3]);
			continue;
		}
		const file = stripped.split("|", 1)[0]?.trim() ?? "";
		if (file && !/^\d/.test(file)) paths.push(file);
	}
	return paths;
}
