import * as path from "node:path";
import type { ConventionalAnalysis, ConventionalCommit } from "../types";
import { conventionalAnalysis, conventionalCommit, formatTypesDescription } from "./commit-types";
import type { ConventionalGenerationConfig } from "./config";
import {
	classifyDiffWhitespace,
	condenseStat,
	scrubDiffForPrompt,
	smartTruncateDiff,
	stripWhitespaceOnlyFiles,
	truncateDiffByLines,
} from "./diff";
import type { CommitInference } from "./inference";
import { runMapReduce, shouldUseMapReduce } from "./map-reduce";
import {
	fallbackSummary,
	parseConventionalAnalysisMarkdown,
	parseFastCommitMarkdown,
	parseSummaryMarkdown,
	stripTypePrefix,
} from "./markdown";
import { formatConventionalCommit, postProcessCommitMessage } from "./normalization";
import { renderConventionalPrompt } from "./prompts";
import { extractScopeCandidates, ScopeAnalyzer } from "./scope";
import { codePointLength, sliceCodePoints } from "./text";
import { isPastTenseFirstWord, repairSummaryTense, validateCommitMessage, validateSummaryQuality } from "./validation";

/** Repository context supplied to analysis and final project-scope validation. */
export interface ConventionalGenerationContext {
	userContext?: string;
	recentCommits?: string;
	commonScopes?: string;
	projectContext?: string;
	projectNames?: readonly string[];
}

/** Inputs captured from one immutable staged-tree view. */
export interface ConventionalGenerationInput {
	diff: string;
	stat: string;
	numstat: string;
	config: ConventionalGenerationConfig;
	inference: CommitInference;
	context?: ConventionalGenerationContext;
}

/** Generated commit plus any final validation failure left for manual correction. */
export interface ConventionalGenerationResult {
	commit: ConventionalCommit;
	validationError: string | null;
}

/** Run llm-git's exact standard-mode generation algorithm over captured Git inputs. */
export async function generateConventionalCommit(
	input: ConventionalGenerationInput,
): Promise<ConventionalGenerationResult> {
	const whitespace = classifyDiffWhitespace(input.diff);
	let commit: ConventionalCommit;
	if (whitespace.allWhitespace) {
		const summary =
			whitespace.whitespaceOnlyFiles.length === 1
				? `reformatted ${path.basename(whitespace.whitespaceOnlyFiles[0] ?? "")}`
				: `reformatted ${whitespace.whitespaceOnlyFiles.length} files`;
		commit = postProcessCommitMessage(conventionalCommit({ type: "style", summary }), input.config);
	} else {
		const changedLines = countAutoFastLines(input.numstat, input.config);
		commit = changedLines !== null ? await generateFastWorkflow(input) : await generateStandardWorkflow(input);
	}
	return validateAndProcess(
		commit,
		input.stat,
		commit.body,
		input.context?.userContext,
		input.config,
		input.inference,
		input.context?.projectNames ?? [],
	);
}

async function generateFastWorkflow(input: ConventionalGenerationInput): Promise<ConventionalCommit> {
	let diff = stripWhitespaceOnlyFiles(input.diff) ?? input.diff;
	diff = scrubDiffForPrompt(diff);
	diff = truncateDiffByLines(diff, 10_000, input.config);
	const scopeCandidates = extractScopeCandidates(input.numstat, input.config).scopeCandidates;
	try {
		const commit = await generateFastCommit(
			input.inference,
			input.config,
			input.stat,
			diff,
			scopeCandidates,
			input.context?.userContext,
		);
		if (validateCommitMessage(commit, input.config, { stat: input.stat }).ok) return commit;
	} catch {}
	const analysis = await generateAnalysisWithMapReduce(
		input.inference,
		input.config,
		input.stat,
		diff,
		scopeCandidates,
		input.context,
	);
	return messageFromAnalysis(analysis, input.config, input.stat, input.context?.userContext, input.inference);
}

async function generateStandardWorkflow(input: ConventionalGenerationInput): Promise<ConventionalCommit> {
	let diff = stripWhitespaceOnlyFiles(input.diff) ?? input.diff;
	diff = scrubDiffForPrompt(diff);
	const scopeCandidates = extractScopeCandidates(input.numstat, input.config).scopeCandidates;
	const mapReduce = shouldUseMapReduce(diff, input.config);
	const analysisDiff =
		mapReduce || codePointLength(diff) <= input.config.maxDiffLength
			? diff
			: smartTruncateDiff(diff, input.config.maxDiffLength, input.config);
	const analysis = mapReduce
		? await runMapReduce({
				inference: input.inference,
				config: input.config,
				stat: input.stat,
				diff: analysisDiff,
				scopeCandidates,
			})
		: await generateDirectAnalysis(
				input.inference,
				input.config,
				input.stat,
				analysisDiff,
				scopeCandidates,
				input.context,
			);
	return messageFromAnalysis(analysis, input.config, input.stat, input.context?.userContext, input.inference);
}

async function generateAnalysisWithMapReduce(
	inference: CommitInference,
	config: ConventionalGenerationConfig,
	stat: string,
	diff: string,
	scopeCandidates: string,
	context?: ConventionalGenerationContext,
): Promise<ConventionalAnalysis> {
	if (shouldUseMapReduce(diff, config)) {
		return runMapReduce({ inference, config, stat, diff, scopeCandidates });
	}
	return generateDirectAnalysis(inference, config, stat, diff, scopeCandidates, context);
}

async function generateDirectAnalysis(
	inference: CommitInference,
	_config: ConventionalGenerationConfig,
	stat: string,
	diff: string,
	scopeCandidates: string,
	context?: ConventionalGenerationContext,
): Promise<ConventionalAnalysis> {
	const prompts = renderConventionalPrompt("analysis", {
		project_context: context?.projectContext ?? "",
		types_description: formatTypesDescription(),
		stat,
		scope_candidates: scopeCandidates,
		common_scopes: context?.commonScopes ?? "",
		recent_commits: context?.recentCommits ?? "",
		diff,
	});
	const userPrompt = context?.userContext
		? `${prompts.user}\n\n<user_context>\n${context.userContext}\n</user_context>`
		: prompts.user;
	return inference.complete(
		{
			operation: "analysis",
			role: "analysis",
			promptFamily: "analysis",
			systemPrompt: prompts.system,
			userPrompt,
			toolName: "create_conventional_analysis",
			progressLabel: "Analyzing staged changes…",
		},
		response => parseConventionalAnalysisMarkdown(response.text),
	);
}

async function generateFastCommit(
	inference: CommitInference,
	config: ConventionalGenerationConfig,
	stat: string,
	diff: string,
	scopeCandidates: string,
	userContext?: string,
): Promise<ConventionalCommit> {
	const prompts = renderConventionalPrompt("fast", {
		stat,
		diff,
		scope_candidates: scopeCandidates,
		user_context: userContext ?? "",
		types_description: formatTypesDescription(),
	});
	const commit = await inference.complete(
		{
			operation: "fast",
			role: "fast",
			promptFamily: "fast",
			systemPrompt: prompts.system,
			userPrompt: prompts.user,
			toolName: "create_fast_commit",
			progressLabel: "Generating commit message…",
		},
		response => parseFastCommitMarkdown(response.text),
	);
	return postProcessCommitMessage(commit, config);
}

async function messageFromAnalysis(
	analysis: ConventionalAnalysis,
	config: ConventionalGenerationConfig,
	stat: string,
	userContext: string | undefined,
	inference: CommitInference,
): Promise<ConventionalCommit> {
	let summary = analysis.summary ?? "";
	for (let attempt = 0; attempt < Math.max(1, config.maxRetries); attempt += 1) {
		if (!summary || attempt > 0) {
			summary = await generateSummaryFromAnalysis(config, analysis, stat, userContext, inference);
		}
		if (validateSummaryQuality(summary, analysis.type, stat).ok) break;
		summary = "";
	}
	if (!summary) {
		summary = fallbackSummary(
			stat,
			analysis.details.map(detail => detail.text),
			"",
			{
				limit: config.summaryGuideline,
			},
		);
	}
	return postProcessCommitMessage(
		conventionalCommit({
			type: analysis.type,
			scope: analysis.scope,
			summary,
			body: analysis.details.map(detail => detail.text),
		}),
		config,
	);
}

/** Generate and salvage a compliant summary from one holistic analysis. */
export async function generateSummaryFromAnalysis(
	config: ConventionalGenerationConfig,
	analysis: ConventionalAnalysis,
	stat: string,
	userContext: string | undefined,
	inference: CommitInference,
): Promise<string> {
	const prefixLength = codePointLength(analysis.type) + 2 + (analysis.scope ? codePointLength(analysis.scope) + 2 : 0);
	const chars = Math.max(20, config.summaryGuideline - prefixLength);
	const details =
		analysis.details.length > 0
			? analysis.details.map(detail => `- ${detail.text}`).join("\n")
			: `- ${analysis.summary ?? ""}`;
	const prompts = renderConventionalPrompt("summary", {
		commit_type: analysis.type,
		scope: analysis.scope,
		chars,
		user_context: userContext ?? "",
		details,
		stat: condenseStat(stat, 30),
	});
	let generated = "";
	try {
		generated = await inference.complete(
			{
				operation: "summary",
				role: "summary",
				promptFamily: "summary",
				systemPrompt: prompts.system,
				userPrompt: prompts.user,
				toolName: "create_commit_summary",
				progressLabel: "Generating commit summary…",
			},
			response => parseSummaryMarkdown(response.text),
		);
	} catch {}
	let chosen = "";
	let draft = "";
	let rejection = "";
	for (const raw of [generated, analysis.summary ?? ""]) {
		const candidate = stripTypePrefix(raw).trim();
		if (!candidate) continue;
		const accepted = acceptSummary(candidate, analysis.type, stat);
		if (accepted.summary) {
			chosen = accepted.summary;
			break;
		}
		if (!draft) {
			draft = candidate;
			rejection = accepted.rejection ?? "";
		}
	}
	if (!chosen && draft) {
		chosen = await rewriteSummaryForCompliance(config, inference, draft, rejection, analysis.type, chars, stat);
	}
	if (!chosen) {
		chosen = fallbackSummaryForCommit(
			stat,
			analysis.details.map(detail => detail.text),
			analysis.type,
			config.summaryHardLimit,
		);
	}
	return sliceCodePoints(chosen, 0, config.summaryHardLimit).replace(/[ .]+$/g, "");
}

function acceptSummary(
	candidate: string,
	commitType: string,
	stat: string,
): { summary: string | null; rejection: string | null } {
	const report = validateSummaryQuality(candidate, commitType, stat);
	if (report.ok) return { summary: candidate, rejection: null };
	const repaired = repairSummaryTense(candidate);
	if (repaired && validateSummaryQuality(repaired, commitType, stat).ok) {
		return { summary: repaired, rejection: null };
	}
	return { summary: null, rejection: report.errors.map(issue => issue.message).join("; ") };
}

async function rewriteSummaryForCompliance(
	_config: ConventionalGenerationConfig,
	inference: CommitInference,
	draft: string,
	rejection: string,
	commitType: string,
	chars: number,
	stat: string,
): Promise<string> {
	const prompts = renderConventionalPrompt("summary-rewrite", {
		commit_type: commitType,
		chars,
		draft,
		rejection,
	});
	try {
		const summary = await inference.complete(
			{
				operation: "summary-rewrite",
				role: "summary",
				promptFamily: "summary-rewrite",
				systemPrompt: prompts.system,
				userPrompt: prompts.user,
				toolName: "create_commit_summary",
				progressLabel: "Rewriting commit summary…",
			},
			response => stripTypePrefix(parseSummaryMarkdown(response.text)).trim(),
		);
		return acceptSummary(summary, commitType, stat).summary ?? "";
	} catch {
		return "";
	}
}

function fallbackSummaryForCommit(stat: string, details: readonly string[], commitType: string, limit: number): string {
	const candidate = fallbackSummary(stat, details, "", { limit, commitType });
	if (validateSummaryQuality(candidate, commitType, stat).ok) return candidate;
	const firstDetail = details[0]?.trim().replace(/\.+$/g, "") ?? "";
	let cleaned = firstDetail || stripTypePrefix(candidate).trim();
	for (const variant of [commitType, `${commitType}ed`, `${commitType}d`]) {
		if (cleaned.toLowerCase().startsWith(`${variant.toLowerCase()} `)) {
			cleaned = cleaned.slice(variant.length).trim();
			break;
		}
	}
	const verb =
		(
			{
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
			} satisfies Record<string, string>
		)[commitType] ?? "changed";
	const firstWord = cleaned.split(/\s+/, 1)[0] ?? "";
	const prefixed = firstWord && isPastTenseFirstWord(firstWord) ? cleaned : `${verb} ${cleaned || "files"}`;
	if (Buffer.byteLength(prefixed) <= limit) return prefixed;
	return fallbackSummary("", details, "", { limit, commitType });
}

async function validateAndProcess(
	message: ConventionalCommit,
	stat: string,
	detailPoints: readonly string[],
	userContext: string | undefined,
	config: ConventionalGenerationConfig,
	inference: CommitInference,
	projectNames: readonly string[],
): Promise<ConventionalGenerationResult> {
	let current = message;
	let validationError: string | null = null;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		current = postProcessCommitMessage(current, config);
		if (attempt === 0 && firstLineLength(current) > config.summarySoftLimit) {
			let summary: string;
			try {
				summary = await generateSummaryFromAnalysis(
					config,
					conventionalAnalysis({ type: current.type, scope: current.scope, details: detailPoints }),
					stat,
					userContext,
					inference,
				);
			} catch {
				summary = fallbackSummary(stat, detailPoints, "", { limit: config.summaryGuideline });
			}
			current = postProcessCommitMessage({ ...current, summary }, config);
			continue;
		}
		let report = validateCommitMessage(current, config, { stat, projectNames });
		if (report.ok) return { commit: current, validationError: null };
		if (current.scope && report.errors.some(issue => issue.code === "project_name_scope")) {
			current = postProcessCommitMessage({ ...current, scope: null }, config);
			report = validateCommitMessage(current, config, { stat, projectNames });
			if (report.ok) return { commit: current, validationError: null };
		}
		validationError = report.errors.map(issue => issue.message).join("; ");
		if (attempt < 2) {
			const summary = fallbackSummary(stat, detailPoints, "", { limit: config.summaryGuideline });
			current = postProcessCommitMessage({ ...current, summary }, config);
			continue;
		}
		break;
	}
	return { commit: current, validationError };
}

function countAutoFastLines(numstat: string, config: ConventionalGenerationConfig): number | null {
	if (config.autoFastThresholdLines === 0) return null;
	const changed = ScopeAnalyzer.countChangedLines(numstat, config);
	return changed === 0 || changed > config.autoFastThresholdLines ? null : changed;
}

function firstLineLength(message: ConventionalCommit): number {
	return codePointLength(formatConventionalCommit(message).split("\n", 1)[0] ?? "");
}
