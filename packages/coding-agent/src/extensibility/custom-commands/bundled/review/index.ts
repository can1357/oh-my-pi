/**
 * /review command - Interactive code review launcher
 *
 * Provides a menu to select review mode:
 * 1. Review against a base branch (PR style)
 * 2. Review uncommitted changes
 * 3. Review a specific commit
 * 4. Custom review instructions
 *
 * Runs VCS diffs upfront, parses results, filters noise, and provides
 * rich context for the orchestrating agent to distribute work across
 * multiple reviewer agents based on diff weight and locality.
 */

import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { prompt } from "@oh-my-pi/pi-utils";
import type { CustomCommand, CustomCommandAPI } from "../../../../extensibility/custom-commands/types";
import type { HookCommandContext } from "../../../../extensibility/hooks/types";
import reviewCustomRequestTemplate from "../../../../prompts/review-custom-request.md" with { type: "text" };
import reviewHeadlessRequestTemplate from "../../../../prompts/review-headless-request.md" with { type: "text" };
import reviewRequestTemplate from "../../../../prompts/review-request.md" with { type: "text" };
import * as gh from "../../../../tools/gh";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface FileDiff {
	path: string;
	linesAdded: number;
	linesRemoved: number;
	hunks: string;
}

interface DiffStats {
	files: FileDiff[];
	totalAdded: number;
	totalRemoved: number;
	excluded: { path: string; reason: string; linesAdded: number; linesRemoved: number }[];
}

interface CurrentReviewDiff {
	diffInstruction: string;
	diffText: string;
	emptyMessage?: string;
	mode: string;
}

interface ReviewPrRef {
	repo: string;
	number: number;
	raw: string;
	kind: "github-url" | "pr-url";
}

interface ParsedReviewArgs {
	prRef: ReviewPrRef | undefined;
	extraInstructions: string;
}

type ReviewMenuChoice =
	| { kind: "detected-pr"; ref: ReviewPrRef }
	| { kind: "base-branch" }
	| { kind: "uncommitted" }
	| { kind: "commit" }
	| { kind: "custom" };

// ─────────────────────────────────────────────────────────────────────────────
// Exclusion patterns for noise files
// ─────────────────────────────────────────────────────────────────────────────

const EXCLUDED_PATTERNS: { pattern: RegExp; reason: string }[] = [
	// Lock files
	{ pattern: /\.lock$/, reason: "lock file" },
	{ pattern: /-lock\.(json|yaml|yml)$/, reason: "lock file" },
	{ pattern: /package-lock\.json$/, reason: "lock file" },
	{ pattern: /yarn\.lock$/, reason: "lock file" },
	{ pattern: /pnpm-lock\.yaml$/, reason: "lock file" },
	{ pattern: /Cargo\.lock$/, reason: "lock file" },
	{ pattern: /Gemfile\.lock$/, reason: "lock file" },
	{ pattern: /poetry\.lock$/, reason: "lock file" },
	{ pattern: /composer\.lock$/, reason: "lock file" },
	{ pattern: /flake\.lock$/, reason: "lock file" },

	// Generated/build artifacts
	{ pattern: /\.min\.(js|css)$/, reason: "minified" },
	{ pattern: /\.generated\./, reason: "generated" },
	{ pattern: /\.snap$/, reason: "snapshot" },
	{ pattern: /\.map$/, reason: "source map" },
	{ pattern: /^dist\//, reason: "build output" },
	{ pattern: /^build\//, reason: "build output" },
	{ pattern: /^out\//, reason: "build output" },
	{ pattern: /node_modules\//, reason: "vendor" },
	{ pattern: /vendor\//, reason: "vendor" },

	// Binary/assets (usually shown as binary in diff anyway)
	{ pattern: /\.(png|jpg|jpeg|gif|ico|webp|avif)$/i, reason: "image" },
	{ pattern: /\.(woff|woff2|ttf|eot|otf)$/i, reason: "font" },
	{ pattern: /\.(pdf|zip|tar|gz|rar|7z)$/i, reason: "binary" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Diff parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a file path should be excluded from review.
 * Returns the exclusion reason if excluded, undefined otherwise.
 */
function getExclusionReason(path: string): string | undefined {
	for (const { pattern, reason } of EXCLUDED_PATTERNS) {
		if (pattern.test(path)) return reason;
	}
	return undefined;
}

/**
 * Parse unified diff output into per-file stats.
 * Splits on file boundaries, counts +/- lines, and filters excluded files.
 */
function parseDiff(diffOutput: string): DiffStats {
	const files: FileDiff[] = [];
	const excluded: DiffStats["excluded"] = [];
	let totalAdded = 0;
	let totalRemoved = 0;

	// Split by file boundary: "diff --git a/... b/..."
	const fileChunks = diffOutput.split(/^diff --git /m).filter(Boolean);

	for (const chunk of fileChunks) {
		// Extract file path from "a/path b/path" line
		const headerMatch = chunk.match(/^a\/(.+?) b\/(.+)/);
		if (!headerMatch) continue;

		const path = headerMatch[2];

		// Count added/removed lines (lines starting with + or - but not ++ or --)
		let linesAdded = 0;
		let linesRemoved = 0;

		const lines = chunk.split("\n");
		for (const line of lines) {
			if (line.startsWith("+") && !line.startsWith("+++")) {
				linesAdded++;
			} else if (line.startsWith("-") && !line.startsWith("---")) {
				linesRemoved++;
			}
		}

		const exclusionReason = getExclusionReason(path);
		if (exclusionReason) {
			excluded.push({ path, reason: exclusionReason, linesAdded, linesRemoved });
		} else {
			files.push({
				path,
				linesAdded,
				linesRemoved,
				hunks: `diff --git ${chunk}`,
			});
			totalAdded += linesAdded;
			totalRemoved += linesRemoved;
		}
	}

	return { files, totalAdded, totalRemoved, excluded };
}

/**
 * Get file extension for display purposes.
 */
function getFileExt(path: string): string {
	const match = path.match(/\.([^.]+)$/);
	return match ? match[1] : "";
}

/**
 * Determine recommended number of reviewer agents based on diff weight.
 * Uses total lines changed as the primary metric.
 */
function getRecommendedAgentCount(stats: DiffStats): number {
	const totalLines = stats.totalAdded + stats.totalRemoved;
	const fileCount = stats.files.length;

	// Heuristics:
	// - Tiny (<100 lines or 1-2 files): 1 agent
	// - Small (<500 lines): 1-2 agents
	// - Medium (<2000 lines): 2-4 agents
	// - Large (<5000 lines): 4-8 agents
	// - Huge (>5000 lines): 8-16 agents

	if (totalLines < 100 || fileCount <= 2) return 1;
	if (totalLines < 500) return Math.min(2, fileCount);
	if (totalLines < 2000) return Math.min(4, Math.ceil(fileCount / 3));
	if (totalLines < 5000) return Math.min(8, Math.ceil(fileCount / 2));
	return Math.min(16, fileCount);
}

/**
 * Extract first N lines of actual diff content (excluding headers) for preview.
 */
function getDiffPreview(hunks: string, maxLines: number): string {
	const lines = hunks.split("\n");
	const contentLines: string[] = [];

	for (const line of lines) {
		// Skip diff headers, keep actual content
		if (
			line.startsWith("diff --git") ||
			line.startsWith("index ") ||
			line.startsWith("---") ||
			line.startsWith("+++") ||
			line.startsWith("@@")
		) {
			continue;
		}
		contentLines.push(line);
		if (contentLines.length >= maxLines) break;
	}

	return contentLines.join("\n");
}

// Thresholds for diff inclusion
const MAX_DIFF_CHARS = 50_000; // Don't include diff above this
const MAX_FILES_FOR_INLINE_DIFF = 20; // Don't include diff if more files than this
const DEFAULT_LARGE_DIFF_INSTRUCTION = "MUST run `git diff`/`git show` for assigned files";
const DEFAULT_CONTEXT_INSTRUCTION = "MAY read full file context as needed via `read`";
const GIT_UNCOMMITTED_DIFF_INSTRUCTION =
	"MUST run both `git diff -- <path>` and `git diff --cached -- <path>` for assigned files";
const JJ_UNCOMMITTED_DIFF_INSTRUCTION = "MUST run `jj --ignore-working-copy diff --git -- <path>` for assigned files";

/**
 * Build the full review prompt with diff stats and distribution guidance.
 */
function buildReviewPrompt(
	mode: string,
	stats: DiffStats,
	rawDiff: string,
	options: { additionalInstructions?: string; diffInstruction?: string; contextInstruction?: string } = {},
): string {
	const agentCount = getRecommendedAgentCount(stats);
	const skipDiff = rawDiff.length > MAX_DIFF_CHARS || stats.files.length > MAX_FILES_FOR_INLINE_DIFF;
	const totalLines = stats.totalAdded + stats.totalRemoved;
	const linesPerFile = skipDiff ? Math.max(5, Math.floor(100 / stats.files.length)) : 0;

	const filesWithExt = stats.files.map(f => ({
		...f,
		ext: getFileExt(f.path),
		hunksPreview: skipDiff ? getDiffPreview(f.hunks, linesPerFile) : "",
	}));

	return prompt.render(reviewRequestTemplate, {
		mode,
		files: filesWithExt,
		excluded: stats.excluded,
		totalAdded: stats.totalAdded,
		totalRemoved: stats.totalRemoved,
		totalLines,
		agentCount,
		multiAgent: agentCount > 1,
		skipDiff,
		rawDiff: rawDiff.trim(),
		linesPerFile,
		additionalInstructions: options.additionalInstructions,
		diffInstruction: options.diffInstruction ?? DEFAULT_LARGE_DIFF_INSTRUCTION,
		contextInstruction: options.contextInstruction ?? DEFAULT_CONTEXT_INSTRUCTION,
	});
}

function buildCustomReviewPrompt(instructions: string): string {
	return prompt.render(reviewCustomRequestTemplate, { instructions });
}

function buildHeadlessReviewPrompt(focus?: string): string {
	return prompt.render(reviewHeadlessRequestTemplate, { focus });
}

const REVIEW_CONTEXT_PR_LIMIT = 3;
const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const PR_SCHEME_PATTERN = /^pr:\/\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([1-9]\d*)(?:\/diff(?:\/(?:all|[1-9]\d*))?)?$/;
const PR_REF_TEXT_PATTERN = /https:\/\/github\.com\/[^\s<>"']+|pr:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[^\s<>"']+/g;

function stripTrailingPrRefPunctuation(text: string): string {
	return text.replace(/[.,)\]>]+$/g, "");
}

function isValidRepoSegment(segment: string | undefined): segment is string {
	return segment !== undefined && REPO_SEGMENT_PATTERN.test(segment);
}

function parsePositivePrNumber(value: string | undefined): number | undefined {
	if (value === undefined || !/^[1-9]\d*$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseGithubPrUrl(text: string): ReviewPrRef | undefined {
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return undefined;
	}

	if (url.protocol !== "https:" || url.hostname !== "github.com") return undefined;

	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length < 4 || parts[2] !== "pull") return undefined;

	const [owner, repo, , numberPart] = parts;
	if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) return undefined;

	const number = parsePositivePrNumber(numberPart);
	if (number === undefined) return undefined;

	return { repo: `${owner}/${repo}`, number, raw: text, kind: "github-url" };
}

function parsePrSchemeRef(text: string): ReviewPrRef | undefined {
	const match = PR_SCHEME_PATTERN.exec(text);
	if (!match) return undefined;

	const [, owner, repo, numberPart] = match;
	const number = parsePositivePrNumber(numberPart);
	if (number === undefined) return undefined;

	return { repo: `${owner}/${repo}`, number, raw: text, kind: "pr-url" };
}

function parseReviewPrRef(text: string): ReviewPrRef | undefined {
	const candidate = stripTrailingPrRefPunctuation(text);
	return parseGithubPrUrl(candidate) ?? parsePrSchemeRef(candidate);
}

function buildPrLargeDiffInstruction(ref: ReviewPrRef): string {
	const prDiffUrl = `pr://${ref.repo}/${ref.number}/diff`;
	return `MUST read assigned PR file diffs from \`${prDiffUrl}/all\` or per-file \`${prDiffUrl}/<index>\`; NEVER use local \`git diff\`/\`git show\` for PR diff content`;
}

function buildPrContextInstruction(ref: ReviewPrRef): string {
	const prDiffUrl = `pr://${ref.repo}/${ref.number}/diff`;
	return `MUST NOT read local workspace files for PR file context; use the fetched PR diff and \`${prDiffUrl}/all\` or per-file \`${prDiffUrl}/<index>\` only`;
}

function extractReviewPrRefFromArgs(args: string[]): ParsedReviewArgs {
	let prRef: ReviewPrRef | undefined;
	let prRefIndex = -1;
	for (const [idx, arg] of args.entries()) {
		const parsed = parseReviewPrRef(arg);
		if (parsed) {
			prRef = parsed;
			prRefIndex = idx;
			break;
		}
	}

	return {
		prRef,
		extraInstructions: args.filter((_, idx) => idx !== prRefIndex).join(" "),
	};
}

function extractReviewPrRefsFromText(text: string): ReviewPrRef[] {
	return Array.from(text.matchAll(PR_REF_TEXT_PATTERN), match => parseReviewPrRef(match[0])).filter(
		(ref): ref is ReviewPrRef => ref !== undefined,
	);
}

function buildReviewPromptFromDiff(
	ctx: HookCommandContext,
	mode: string,
	diffText: string,
	extraInstructions: string | undefined,
	emptyMessage: string,
	options: { diffInstruction?: string; filteredMessage?: string; contextInstruction?: string } = {},
): string | undefined {
	if (!diffText.trim()) {
		if (ctx.hasUI) ctx.ui.notify(emptyMessage, "warning");
		return undefined;
	}

	const stats = parseDiff(diffText);
	if (stats.files.length === 0) {
		if (ctx.hasUI)
			ctx.ui.notify(options.filteredMessage ?? "No reviewable files (all changes filtered out)", "warning");
		return undefined;
	}

	return buildReviewPrompt(mode, stats, diffText, {
		additionalInstructions: extraInstructions,
		diffInstruction: options.diffInstruction,
		contextInstruction: options.contextInstruction,
	});
}

async function buildPrReviewPrompt(
	api: CustomCommandAPI,
	ctx: HookCommandContext,
	ref: ReviewPrRef,
	extraInstructions: string,
): Promise<string | undefined> {
	let diffText: string;
	try {
		const lookup = await gh.getOrFetchPrDiff({ cwd: api.cwd, repo: ref.repo, number: ref.number });
		diffText = lookup.payload.unified;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const failure = `Failed to fetch PR diff for ${ref.repo}#${ref.number}: ${message}`;
		if (ctx.hasUI) {
			ctx.ui.notify(failure, "error");
			return undefined;
		}
		return failure;
	}

	const promptText = buildReviewPromptFromDiff(
		ctx,
		`PR ${ref.repo}#${ref.number}`,
		diffText,
		extraInstructions || undefined,
		`PR ${ref.repo}#${ref.number} has no diff content available`,
		{ diffInstruction: buildPrLargeDiffInstruction(ref), contextInstruction: buildPrContextInstruction(ref) },
	);
	if (promptText !== undefined || ctx.hasUI) return promptText;
	return `Unable to review PR ${ref.repo}#${ref.number}: no diff content available.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getTextContentParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const parts: string[] = [];
	for (const item of content) {
		if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
			parts.push(item.text);
		}
	}
	return parts;
}

function findRecentPrRefs(ctx: HookCommandContext, limit: number): ReviewPrRef[] {
	const refs: ReviewPrRef[] = [];
	const seen = new Set<string>();
	const entries = ctx.sessionManager.getBranch();

	for (let idx = entries.length - 1; idx >= 0 && refs.length < limit; idx--) {
		const entry = entries[idx];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant") continue;

		const parts = getTextContentParts(message.content);
		for (let partIdx = parts.length - 1; partIdx >= 0; partIdx--) {
			const part = parts[partIdx];
			const partRefs = extractReviewPrRefsFromText(part);
			for (let refIdx = partRefs.length - 1; refIdx >= 0; refIdx--) {
				const ref = partRefs[refIdx];
				const key = `${ref.repo.toLowerCase()}#${ref.number}`;
				if (seen.has(key)) continue;
				seen.add(key);
				refs.push(ref);
				if (refs.length >= limit) break;
			}
			if (refs.length >= limit) break;
		}
	}

	return refs;
}

export class ReviewCommand implements CustomCommand {
	name = "review";
	description = "Launch interactive code review";

	constructor(private api: CustomCommandAPI) {}

	async execute(args: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const parsedArgs = extractReviewPrRefFromArgs(args);
		if (parsedArgs.prRef) {
			return buildPrReviewPrompt(this.api, ctx, parsedArgs.prRef, parsedArgs.extraInstructions);
		}

		const extraInstructions = parsedArgs.extraInstructions || undefined;
		if (!ctx.hasUI) {
			return buildHeadlessReviewPrompt(extraInstructions);
		}

		const choices: Array<{ label: string; value: ReviewMenuChoice }> = [
			...findRecentPrRefs(ctx, REVIEW_CONTEXT_PR_LIMIT).map(ref => ({
				label: `Review PR ${ref.repo}#${ref.number} from conversation`,
				value: { kind: "detected-pr" as const, ref },
			})),
			{
				label: "1. Review against a base branch (PR Style)",
				value: { kind: "base-branch" },
			},
			{
				label: "2. Review uncommitted changes",
				value: { kind: "uncommitted" },
			},
			{
				label: "3. Review a specific commit",
				value: { kind: "commit" },
			},
		];

		if (!extraInstructions) {
			choices.push({
				label: "4. Custom review instructions",
				value: { kind: "custom" },
			});
		}

		const selected = await ctx.ui.select(
			"Review Mode",
			choices.map(choice => choice.label),
		);
		if (!selected) return undefined;

		const selectedChoice = choices.find(choice => choice.label === selected)?.value;
		if (!selectedChoice) return undefined;

		switch (selectedChoice.kind) {
			case "detected-pr":
				return buildPrReviewPrompt(this.api, ctx, selectedChoice.ref, extraInstructions ?? "");

			case "base-branch": {
				const branches = await getGitBranches(this.api);
				if (branches.length === 0) {
					ctx.ui.notify("No git branches found", "error");
					return undefined;
				}

				const baseBranch = await ctx.ui.select("Select base branch to compare against", branches);
				if (!baseBranch) return undefined;

				const currentBranch = await getCurrentBranch(this.api);
				let diffText: string;
				try {
					const repository = vcs.requireGit(this.api.cwd);
					// PR-style review compares the merge base against the current
					// branch (`base...head`), so base-only commits are excluded.
					const mergeBase = await repository.mergeBase(baseBranch, currentBranch);
					if (!mergeBase) {
						// No common ancestor: `git diff base...head` aborts here
						// rather than comparing unrelated trees tip-to-tip.
						ctx.ui.notify(`No common history between ${baseBranch} and ${currentBranch}`, "error");
						return undefined;
					}
					diffText = await repository.diffText({ base: mergeBase, head: currentBranch });
				} catch (err) {
					ctx.ui.notify(`Failed to get diff: ${err instanceof Error ? err.message : String(err)}`, "error");
					return undefined;
				}

				return buildReviewPromptFromDiff(
					ctx,
					`Reviewing changes between \`${baseBranch}\` and \`${currentBranch}\` (PR-style)`,
					diffText,
					extraInstructions,
					`No changes between ${baseBranch} and ${currentBranch}`,
				);
			}

			case "uncommitted": {
				const reviewDiff = await getUncommittedReviewDiff(this.api).catch(err => {
					ctx.ui.notify(`Failed to get diff: ${err instanceof Error ? err.message : String(err)}`, "error");
					return undefined;
				});
				if (!reviewDiff) return undefined;

				return buildReviewPromptFromDiff(
					ctx,
					reviewDiff.mode,
					reviewDiff.diffText,
					extraInstructions,
					reviewDiff.emptyMessage ?? "No diff content found",
					{ diffInstruction: reviewDiff.diffInstruction },
				);
			}

			case "commit": {
				const commits = await getRecentCommits(this.api, 20);
				if (commits.length === 0) {
					ctx.ui.notify("No commits found", "error");
					return undefined;
				}

				const selectedCommit = await ctx.ui.select("Select commit to review", commits);
				if (!selectedCommit) return undefined;

				const hash = selectedCommit.split(" ")[0];

				let diffText: string;
				try {
					const result = await vcs.requireGit(this.api.cwd).showCommit(hash);
					diffText = result.data.toString("utf8");
				} catch (err) {
					ctx.ui.notify(`Failed to get commit: ${err instanceof Error ? err.message : String(err)}`, "error");
					return undefined;
				}

				return buildReviewPromptFromDiff(
					ctx,
					`Reviewing commit \`${hash}\``,
					diffText,
					extraInstructions,
					"Commit has no diff content",
					{ filteredMessage: "No reviewable files in commit (all changes filtered out)" },
				);
			}

			case "custom": {
				const instructions = await ctx.ui.editor(
					"Enter custom review instructions",
					"Review the following:\n\n",
					undefined,
					{ promptStyle: true },
				);
				if (!instructions?.trim()) return undefined;

				const reviewDiff = await getUncommittedReviewDiff(this.api).catch(() => undefined);

				if (reviewDiff?.diffText.trim()) {
					const stats = parseDiff(reviewDiff.diffText);
					return buildReviewPrompt(
						`Custom review: ${instructions.split("\n")[0].slice(0, 60)}…`,
						stats,
						reviewDiff.diffText,
						{
							additionalInstructions: instructions,
							diffInstruction: reviewDiff.diffInstruction,
						},
					);
				}

				return buildCustomReviewPrompt(instructions);
			}
		}
	}
}

async function getGitBranches(api: CustomCommandAPI): Promise<string[]> {
	try {
		return await vcs.requireGit(api.cwd).listBranches(true);
	} catch {
		return [];
	}
}

async function getCurrentBranch(api: CustomCommandAPI): Promise<string> {
	try {
		return (await vcs.git(api.cwd)?.currentBranch()) ?? "HEAD";
	} catch {
		return "HEAD";
	}
}

async function getUncommittedReviewDiff(api: CustomCommandAPI): Promise<CurrentReviewDiff> {
	const repository = vcs.require(api.cwd);
	const diffText = await repository.uncommittedDiff([]);
	const isJj = repository.kind() === "jj";
	return {
		diffText,
		diffInstruction: isJj ? JJ_UNCOMMITTED_DIFF_INSTRUCTION : GIT_UNCOMMITTED_DIFF_INSTRUCTION,
		emptyMessage: isJj || !diffText.trim() ? "No uncommitted changes found" : "No diff content found",
		mode: isJj ? "Reviewing JJ working-copy changes" : "Reviewing uncommitted changes (staged + unstaged)",
	};
}

async function getRecentCommits(api: CustomCommandAPI, count: number): Promise<string[]> {
	try {
		return await vcs.require(api.cwd).logOnelines(count);
	} catch {
		return [];
	}
}

export default ReviewCommand;
