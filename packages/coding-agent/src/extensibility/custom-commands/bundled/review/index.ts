import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { prompt } from "@oh-my-pi/pi-utils";
import type { CustomCommand, CustomCommandAPI } from "../../../../extensibility/custom-commands/types";
import type { HookCommandContext } from "../../../../extensibility/hooks/types";
import reviewCustomRequestTemplate from "../../../../prompts/review-custom-request.md" with { type: "text" };
import reviewHeadlessRequestTemplate from "../../../../prompts/review-headless-request.md" with { type: "text" };
import * as gh from "../../../../tools/gh";
import { github } from "../../../../utils/github";
import { buildReviewPrompt } from "./prompt";
import {
	createResolvedReviewTarget,
	getReviewTargetIssue,
	LOCAL_REVIEW_CHOICES,
	type LocalReviewKind,
	type ResolvedReviewTarget,
	readUncommittedReviewTarget,
	resolveLocalReviewTarget,
} from "./target";

interface ParsedReviewArgs {
	prRef: ReviewPrRef | undefined;
	extraInstructions: string;
}

export interface ReviewPrRef {
	repo: string;
	number: number;
	raw: string;
	kind: "github-url" | "pr-url";
}

/** A diff the reviewer can target: a detected PR or one local diff kind. */
export type ReviewTargetChoice =
	| { label: string; kind: "pr"; ref: ReviewPrRef }
	| { label: string; kind: LocalReviewKind };

export type ReviewChoice = ReviewTargetChoice | { label: string; kind: "custom" };

const REVIEW_CONTEXT_PR_LIMIT = 3;
const PICK_PR_CHOICE_LABEL = "4. Review a specific PR";
/** `gh pr list` page size. 100 is gh's per-page maximum. */
const PR_PICKER_LIMIT = 100;
const PR_PICKER_SEARCH_ENTRY = "Search open pull requests…";
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

export function parseReviewPrRef(text: string): ReviewPrRef | undefined {
	const candidate = stripTrailingPrRefPunctuation(text);
	return parseGithubPrUrl(candidate) ?? parsePrSchemeRef(candidate);
}

export function extractReviewPrRefFromArgs(args: string[]): ParsedReviewArgs {
	let prRef: ReviewPrRef | undefined;
	let prRefIndex = -1;
	for (const [index, arg] of args.entries()) {
		const parsed = parseReviewPrRef(arg);
		if (!parsed) continue;
		prRef = parsed;
		prRefIndex = index;
		break;
	}
	return {
		prRef,
		extraInstructions: args.filter((_, index) => index !== prRefIndex).join(" "),
	};
}

function extractReviewPrRefsFromText(text: string): ReviewPrRef[] {
	return Array.from(text.matchAll(PR_REF_TEXT_PATTERN), match => parseReviewPrRef(match[0])).filter(
		(ref): ref is ReviewPrRef => ref !== undefined,
	);
}

function buildPrLargeDiffInstruction(ref: ReviewPrRef): string {
	const prDiffUrl = `pr://${ref.repo}/${ref.number}/diff`;
	return `MUST read assigned PR file diffs from \`${prDiffUrl}/all\` or per-file \`${prDiffUrl}/<index>\`; NEVER use local \`git diff\`/\`git show\` for PR diff content`;
}

function buildPrContextInstruction(ref: ReviewPrRef): string {
	const prDiffUrl = `pr://${ref.repo}/${ref.number}/diff`;
	return `MUST NOT read local workspace files for PR file context; use the fetched PR diff and \`${prDiffUrl}/all\` or per-file \`${prDiffUrl}/<index>\` only`;
}

/** Fetch one PR patch and freeze it before any overlay or LLM prompt is built. */
export async function resolvePrReviewTarget(
	cwd: string,
	ctx: HookCommandContext,
	ref: ReviewPrRef,
): Promise<ResolvedReviewTarget | undefined> {
	try {
		const lookup = await gh.getOrFetchPrDiff({ cwd, repo: ref.repo, number: ref.number });
		return createResolvedReviewTarget(
			"pr",
			`PR ${ref.repo}#${ref.number}`,
			lookup.payload.unified,
			`PR ${ref.repo}#${ref.number} has no diff content available`,
			{
				diffInstruction: buildPrLargeDiffInstruction(ref),
				contextInstruction: buildPrContextInstruction(ref),
			},
		);
	} catch (error) {
		const failure = `Failed to fetch PR diff for ${ref.repo}#${ref.number}: ${error instanceof Error ? error.message : String(error)}`;
		if (!ctx.hasUI) throw new Error(failure);
		ctx.ui.notify(failure, "error");
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getTextContentParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const item of content) {
		if (isRecord(item) && item.type === "text" && typeof item.text === "string") parts.push(item.text);
	}
	return parts;
}

export function findRecentPrRefs(ctx: HookCommandContext, limit: number): ReviewPrRef[] {
	const refs: ReviewPrRef[] = [];
	const seen = new Set<string>();
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0 && refs.length < limit; index--) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const parts = getTextContentParts(message.content);
		for (let partIndex = parts.length - 1; partIndex >= 0 && refs.length < limit; partIndex--) {
			const partRefs = extractReviewPrRefsFromText(parts[partIndex]!);
			for (let refIndex = partRefs.length - 1; refIndex >= 0 && refs.length < limit; refIndex--) {
				const ref = partRefs[refIndex]!;
				const key = `${ref.repo.toLowerCase()}#${ref.number}`;
				if (seen.has(key)) continue;
				seen.add(key);
				refs.push(ref);
			}
		}
	}
	return refs;
}

interface PrListItem {
	number?: number;
	title?: string;
	author?: { login?: string } | null;
	isDraft?: boolean;
	url?: string;
}

type PickablePr = PrListItem & { number: number };

function formatPrPickerLabel(item: PickablePr): string {
	const collapsed = (item.title ?? "(no title)").replace(/[\r\n\x00-\x1F\x7F]+/g, " ");
	const singleLine = replaceTabs(collapsed).replace(/\s+/g, " ").trim() || "(no title)";
	const title = truncateToWidth(singleLine, TRUNCATE_LENGTHS.TITLE);
	const author = item.author?.login?.trim() || "unknown";
	const draftSuffix = item.isDraft ? "  [draft]" : "";
	return `#${item.number}  ${title}  @${author}${draftSuffix}`;
}

function prNumberRef(repo: string, number: number): ReviewPrRef {
	return { repo, number, raw: `pr://${repo}/${number}`, kind: "pr-url" };
}

function pickablePrs(items: PrListItem[]): PickablePr[] {
	return items.filter(
		(item): item is PickablePr =>
			typeof item.number === "number" && Number.isSafeInteger(item.number) && item.number > 0,
	);
}

async function fetchOpenPullRequests(
	cwd: string,
	ctx: HookCommandContext,
	repo: string,
	search: string | undefined,
): Promise<PickablePr[] | undefined> {
	const args = [
		"pr",
		"list",
		"--repo",
		repo,
		"--state",
		"open",
		"--limit",
		String(PR_PICKER_LIMIT),
		"--json",
		"number,title,author,isDraft,url",
	];
	if (search !== undefined) args.push("--search", search);
	ctx.ui.setStatus("review", "Loading open pull requests…");
	try {
		return pickablePrs(await github.json<PrListItem[]>(cwd, args, undefined, { repoProvided: true }));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Failed to list open pull requests in ${repo}: ${message}`, "error");
		return undefined;
	} finally {
		ctx.ui.setStatus("review", undefined);
	}
}

/**
 * List the repository's open PRs with a server-side search row and a `#123`
 * fast-path. Local type-to-filter only covers the fetched page; the search row
 * reaches PRs beyond it, and a number skips listing entirely because
 * `gh pr list --search` never matches PR numbers.
 */
async function selectPullRequestRef(cwd: string, ctx: HookCommandContext): Promise<ReviewPrRef | undefined> {
	let repo: string;
	try {
		repo = await gh.resolveDefaultRepoMemoized(cwd);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Failed to resolve repository for PR picker: ${message}`, "error");
		return undefined;
	}
	const openPrs = await fetchOpenPullRequests(cwd, ctx, repo, undefined);
	if (openPrs === undefined) return undefined;
	if (openPrs.length === 0) {
		ctx.ui.notify(`No open pull requests in ${repo}`, "warning");
		return undefined;
	}
	let activeQuery: string | undefined;
	let currentPrs = openPrs;
	for (;;) {
		const rows = currentPrs.map(item => ({ label: formatPrPickerLabel(item), item }));
		const title =
			activeQuery === undefined
				? `Open pull requests in ${repo}`
				: `Open pull requests in ${repo} matching "${activeQuery}"`;
		const selected = await ctx.ui.select(title, [...rows.map(row => row.label), PR_PICKER_SEARCH_ENTRY]);
		if (selected === undefined) return undefined;
		if (selected !== PR_PICKER_SEARCH_ENTRY) {
			const match = rows.find(row => row.label === selected);
			if (!match) return undefined;
			return (match.item.url ? parseGithubPrUrl(match.item.url) : undefined) ?? prNumberRef(repo, match.item.number);
		}
		// The hint rides in the title: `HookInputComponent` accepts a placeholder
		// and never renders it, so a second argument would be invisible.
		const input = await ctx.ui.input("Search open pull requests — title, author, or #123");
		if (input === undefined) continue;
		const query = input.trim();
		if (query === "") {
			activeQuery = undefined;
			currentPrs = openPrs;
			continue;
		}
		const number = parsePositivePrNumber(query.startsWith("#") ? query.slice(1) : query);
		if (number !== undefined) return prNumberRef(repo, number);
		const matches = await fetchOpenPullRequests(cwd, ctx, repo, query);
		// The failure was already reported; stay in the picker on the list shown before.
		if (matches === undefined) continue;
		if (matches.length === 0) {
			ctx.ui.notify(`No open pull requests matching "${query}" in ${repo}`, "warning");
			activeQuery = undefined;
			currentPrs = openPrs;
			continue;
		}
		activeQuery = query;
		currentPrs = matches;
	}
}

type ReviewMenuChoice = ReviewChoice | { label: string; kind: "pick-pr" };

/**
 * Review target menu shared by `/review` and `/annotate code-review`. Picking
 * "Review a specific PR" opens the open-PR picker and resolves to a `pr`
 * choice, so callers never see the picker step.
 */
export async function selectReviewChoice(ctx: HookCommandContext, cwd: string): Promise<ReviewTargetChoice | undefined>;
export async function selectReviewChoice(
	ctx: HookCommandContext,
	cwd: string,
	options: { includeCustom: boolean },
): Promise<ReviewChoice | undefined>;
export async function selectReviewChoice(
	ctx: HookCommandContext,
	cwd: string,
	options: { includeCustom: boolean } = { includeCustom: false },
): Promise<ReviewChoice | undefined> {
	const choices: ReviewMenuChoice[] = [
		...findRecentPrRefs(ctx, REVIEW_CONTEXT_PR_LIMIT).map(ref => ({
			label: `Review PR ${ref.repo}#${ref.number} from conversation`,
			kind: "pr" as const,
			ref,
		})),
		...LOCAL_REVIEW_CHOICES.map(choice => ({ label: choice.label, kind: choice.kind })),
		{ label: PICK_PR_CHOICE_LABEL, kind: "pick-pr" },
	];
	if (options.includeCustom) choices.push({ label: "5. Custom review instructions", kind: "custom" });
	const selected = await ctx.ui.select(
		"Review Mode",
		choices.map(choice => choice.label),
	);
	const choice = choices.find(candidate => candidate.label === selected);
	if (choice?.kind !== "pick-pr") return choice;
	const ref = await selectPullRequestRef(cwd, ctx);
	return ref ? { label: `Review PR ${ref.repo}#${ref.number}`, kind: "pr", ref } : undefined;
}

function reviewTargetPrompt(
	ctx: HookCommandContext,
	target: ResolvedReviewTarget,
	instructions?: string,
): string | undefined {
	const issue = getReviewTargetIssue(target);
	if (issue) {
		if (ctx.hasUI) ctx.ui.notify(issue, "warning");
		return undefined;
	}
	return buildReviewPrompt(target, instructions);
}

function buildHeadlessReviewPrompt(focus?: string): string {
	return prompt.render(reviewHeadlessRequestTemplate, { focus });
}

/**
 * `api.cwd` freezes at command-load time; after /move or /wt the live session
 * cwd comes from the session manager (issue #12501).
 */
export function liveCommandCwd(api: CustomCommandAPI, ctx: HookCommandContext): string {
	return ctx.sessionManager?.getCwd?.() || api.cwd;
}

function buildCustomReviewPrompt(instructions: string): string {
	return prompt.render(reviewCustomRequestTemplate, { instructions });
}

export class ReviewCommand implements CustomCommand {
	name = "review";
	description = "Launch interactive code review";

	constructor(private readonly api: CustomCommandAPI) {}

	async execute(args: string[], ctx: HookCommandContext): Promise<string | undefined> {
		const cwd = liveCommandCwd(this.api, ctx);
		const parsedArgs = extractReviewPrRefFromArgs(args);
		if (parsedArgs.prRef) {
			try {
				const target = await resolvePrReviewTarget(cwd, ctx, parsedArgs.prRef);
				const result = target
					? reviewTargetPrompt(ctx, target, parsedArgs.extraInstructions || undefined)
					: undefined;
				return (
					result ??
					(ctx.hasUI
						? undefined
						: `Unable to review PR ${parsedArgs.prRef.repo}#${parsedArgs.prRef.number}: no diff content available.`)
				);
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		}
		const extraInstructions = parsedArgs.extraInstructions || undefined;
		if (!ctx.hasUI) return buildHeadlessReviewPrompt(extraInstructions);
		const selectedChoice = await selectReviewChoice(ctx, cwd, { includeCustom: !extraInstructions });
		if (!selectedChoice) return undefined;
		if (selectedChoice.kind === "pr") {
			const target = await resolvePrReviewTarget(cwd, ctx, selectedChoice.ref);
			return target ? reviewTargetPrompt(ctx, target, extraInstructions) : undefined;
		}
		if (selectedChoice.kind === "custom") {
			const instructions = await ctx.ui.editor(
				"Enter custom review instructions",
				"Review the following:\n\n",
				undefined,
				{ promptStyle: true },
			);
			if (!instructions?.trim()) return undefined;
			const target = await readUncommittedReviewTarget(cwd).catch(() => undefined);
			if (target?.rawDiff.trim()) {
				return buildReviewPrompt(
					{ ...target, mode: `Custom review: ${instructions.split("\n")[0].slice(0, 60)}…` },
					instructions,
				);
			}
			return buildCustomReviewPrompt(instructions);
		}
		const target = await resolveLocalReviewTarget(selectedChoice.kind, cwd, ctx.ui);
		return target ? reviewTargetPrompt(ctx, target, extraInstructions) : undefined;
	}
}

export default ReviewCommand;
