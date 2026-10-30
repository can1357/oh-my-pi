import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { findScopedSettings } from "../../../../config/settings";
import type { CustomCommand, CustomCommandAPI } from "../../../../extensibility/custom-commands/types";
import type { HookCommandContext } from "../../../../extensibility/hooks/types";
import { parseMrUrl } from "../../../../internal-urls/mr-protocol";
import { parseInternalUrl } from "../../../../internal-urls/parse";
import reviewCustomRequestTemplate from "../../../../prompts/review-custom-request.md" with { type: "text" };
import reviewHeadlessRequestTemplate from "../../../../prompts/review-headless-request.md" with { type: "text" };
import * as gh from "../../../../tools/gh";
import * as glab from "../../../../tools/glab-mr";
import { github } from "../../../../utils/github";
import { gitlab } from "../../../../utils/gitlab";
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

/** A GitHub pull request or GitLab merge request to review. */
export interface ReviewPrRef {
	forge: "github" | "gitlab";
	/** GitHub `[HOST/]OWNER/REPO`, or GitLab `<host>/<namespace…>/<project>`. */
	repo: string;
	/** PR number or MR iid. */
	number: number;
	raw: string;
	kind: "github-url" | "pr-url" | "gitlab-url" | "mr-url";
}

/** A diff the reviewer can target: a detected PR/MR or one local diff kind. */
export type ReviewTargetChoice =
	| { label: string; kind: "pr"; ref: ReviewPrRef }
	| { label: string; kind: LocalReviewKind };

export type ReviewChoice = ReviewTargetChoice | { label: string; kind: "custom" };

const REVIEW_CONTEXT_PR_LIMIT = 3;
const PICK_PR_CHOICE_LABEL = "4. Review a specific PR/MR";
/** `gh pr list` / `glab mr list` page size. 100 is the per-page maximum of both forges. */
const PR_PICKER_LIMIT = 100;
const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const PR_SCHEME_PATTERN =
	/^pr:\/\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([1-9]\d*)(?:\/diff(?:\/(?:all|[1-9]\d*))?)?(?:\?at=\d+)?$/;
const PR_REF_TEXT_PATTERN =
	/https:\/\/github\.com\/[^\s<>"']+|pr:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[^\s<>"']+|https:\/\/[^\s<>"'/]+\/[^\s<>"']*\/-\/merge_requests\/[^\s<>"']+|mr:\/\/[^\s<>"']+/g;

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
	return { forge: "github", repo: `${owner}/${repo}`, number, raw: text, kind: "github-url" };
}

function parsePrSchemeRef(text: string): ReviewPrRef | undefined {
	const match = PR_SCHEME_PATTERN.exec(text);
	if (!match) return undefined;
	const [, owner, repo, numberPart] = match;
	const number = parsePositivePrNumber(numberPart);
	if (number === undefined) return undefined;
	return { forge: "github", repo: `${owner}/${repo}`, number, raw: text, kind: "pr-url" };
}

/** `https://<host>/<group…>/<project>/-/merge_requests/<iid>[/…]` */
function parseGitlabMrUrl(text: string): ReviewPrRef | undefined {
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:") return undefined;
	const parts = url.pathname.split("/").filter(Boolean);
	const dash = parts.indexOf("-");
	if (dash < 0 || parts[dash + 1] !== "merge_requests") return undefined;
	const repo = glab.parseGitlabProjectWebUrl(`${url.origin}/${parts.slice(0, dash).join("/")}`);
	const number = parsePositivePrNumber(parts[dash + 2]);
	if (!repo || number === undefined) return undefined;
	return { forge: "gitlab", repo, number, raw: text, kind: "gitlab-url" };
}

/** Fully qualified `mr://<host>/<group…>/<project>/<iid>/diff[/…]`; the short `mr://<iid>/…` form names no project. */
function parseMrSchemeRef(text: string): ReviewPrRef | undefined {
	if (!text.startsWith("mr://")) return undefined;
	try {
		const parsed = parseMrUrl(parseInternalUrl(text));
		if (!parsed.project) return undefined;
		return { forge: "gitlab", repo: parsed.project, number: parsed.iid, raw: text, kind: "mr-url" };
	} catch {
		return undefined;
	}
}

export function parseReviewPrRef(text: string): ReviewPrRef | undefined {
	const candidate = stripTrailingPrRefPunctuation(text);
	return (
		parseGithubPrUrl(candidate) ??
		parsePrSchemeRef(candidate) ??
		parseGitlabMrUrl(candidate) ??
		parseMrSchemeRef(candidate)
	);
}

/** `PR owner/repo#N` for GitHub, `MR host/group/project!N` for GitLab. */
export function formatReviewRefLabel(ref: ReviewPrRef): string {
	return ref.forge === "gitlab" ? `MR ${ref.repo}!${ref.number}` : `PR ${ref.repo}#${ref.number}`;
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

/** Fetch one PR/MR patch and freeze it before any overlay or LLM prompt is built; throws on fetch failure. */
export async function fetchPrReviewTarget(cwd: string, ref: ReviewPrRef): Promise<ResolvedReviewTarget> {
	const label = formatReviewRefLabel(ref);
	// Session settings are the active scope (set around `/review`). Without them,
	// `resolveCacheTtl(undefined)` uses the default enabled cache and a kill switch
	// still stores a generation.
	const settings = findScopedSettings(cwd);
	if (ref.forge === "gitlab") {
		try {
			const lookup = await glab.getOrFetchMrDiff({
				cwd,
				project: ref.repo,
				iid: ref.number,
				...(settings ? { settings } : {}),
			});
			return createResolvedReviewTarget(
				"pr",
				label,
				lookup.payload.unified,
				`${label} has no diff content available`,
				{
					prDiffUrl: `mr://${ref.repo}/${ref.number}/diff`,
				},
			);
		} catch (error) {
			throw new Error(
				`Failed to fetch MR diff for ${ref.repo}!${ref.number}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	try {
		const lookup = await gh.getOrFetchPrDiff({
			cwd,
			repo: ref.repo,
			number: ref.number,
			...(settings ? { settings } : {}),
		});
		const generationAt =
			lookup.status === "disabled"
				? null
				: gh.retainPrDiffGeneration({
						repo: ref.repo,
						number: ref.number,
						rendered: lookup.rendered,
						files: lookup.payload.files,
						fetchedAt: lookup.fetchedAt,
					});
		return createResolvedReviewTarget("pr", label, lookup.payload.unified, `${label} has no diff content available`, {
			prDiffUrl: `pr://${ref.repo}/${ref.number}/diff`,
			prDiffQuery: generationAt !== null ? `?at=${generationAt}` : "",
		});
	} catch (error) {
		throw new Error(
			`Failed to fetch PR diff for ${ref.repo}#${ref.number}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Interactive wrapper: notifies instead of throwing when a UI is available. */
export async function resolvePrReviewTarget(
	cwd: string,
	ctx: HookCommandContext,
	ref: ReviewPrRef,
): Promise<ResolvedReviewTarget | undefined> {
	try {
		return await fetchPrReviewTarget(cwd, ref);
	} catch (error) {
		if (!ctx.hasUI) throw error;
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return undefined;
	}
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
				const key = `${ref.forge}:${ref.repo.toLowerCase()}#${ref.number}`;
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

/** One row of `glab mr list -F json` (GitLab REST list-MRs shape). */
interface GitlabMrListItem {
	iid?: number;
	title?: string;
	author?: { username?: string } | null;
	draft?: boolean;
	web_url?: string;
}

type PickablePr = PrListItem & { number: number };

function formatPrPickerLabel(item: PickablePr, prefix: string): string {
	const collapsed = (item.title ?? "(no title)").replace(/[\r\n\x00-\x1F\x7F]+/g, " ");
	const singleLine = replaceTabs(collapsed).replace(/\s+/g, " ").trim() || "(no title)";
	const title = truncateToWidth(singleLine, TRUNCATE_LENGTHS.TITLE);
	const author = item.author?.login?.trim() || "unknown";
	const draftSuffix = item.isDraft ? "  [draft]" : "";
	return `${prefix}${item.number}  ${title}  @${author}${draftSuffix}`;
}

function prNumberRef(repo: string, number: number): ReviewPrRef {
	return { forge: "github", repo, number, raw: `pr://${repo}/${number}`, kind: "pr-url" };
}

function mrNumberRef(project: string, iid: number): ReviewPrRef {
	return { forge: "gitlab", repo: project, number: iid, raw: `mr://${project}/${iid}`, kind: "mr-url" };
}

function pickablePrs(items: PrListItem[]): PickablePr[] {
	return items.filter(
		(item): item is PickablePr =>
			typeof item.number === "number" && Number.isSafeInteger(item.number) && item.number > 0,
	);
}

/** The forge-specific half of the open PR/MR picker. */
interface ChangeRequestSource {
	repo: string;
	plural: "pull requests" | "merge requests";
	prefix: "#" | "!";
	searchPrompt: string;
	/** One page of open items, optionally narrowed by a server-side search; throws on CLI failure. */
	fetch(search: string | undefined): Promise<PrListItem[]>;
	refFor(item: PickablePr): ReviewPrRef;
	refForNumber(number: number): ReviewPrRef;
}

/**
 * GitHub first; GitLab only when `gh` cannot resolve a repository and `glab`
 * is installed, so a checkout with both remotes keeps today's GitHub picker.
 */
async function resolveChangeRequestSource(
	cwd: string,
	ctx: HookCommandContext,
): Promise<ChangeRequestSource | undefined> {
	let ghMessage: string;
	try {
		const repo = await gh.resolveDefaultRepoMemoized(cwd);
		return {
			repo,
			plural: "pull requests",
			prefix: "#",
			searchPrompt: "Search open pull requests — title, author, or #123",
			fetch: search => {
				const args = ["pr", "list", "--repo", repo, "--state", "open", "--limit", String(PR_PICKER_LIMIT)];
				args.push("--json", "number,title,author,isDraft,url");
				if (search !== undefined) args.push("--search", search);
				return github.json<PrListItem[]>(cwd, args, undefined, { repoProvided: true });
			},
			refFor: item => (item.url ? parseGithubPrUrl(item.url) : undefined) ?? prNumberRef(repo, item.number),
			refForNumber: number => prNumberRef(repo, number),
		};
	} catch (error) {
		ghMessage = error instanceof Error ? error.message : String(error);
	}
	if (!gitlab.available()) {
		ctx.ui.notify(`Failed to resolve repository for PR picker: ${ghMessage}`, "error");
		return undefined;
	}
	try {
		const project = await glab.resolveDefaultGitlabProjectMemoized(cwd);
		return {
			repo: project,
			plural: "merge requests",
			prefix: "!",
			searchPrompt: "Search open merge requests — title, description, or !123",
			fetch: async search => {
				const args = ["mr", "list", "-R", glab.formatGitlabProjectArg(project), "-F", "json"];
				args.push("-P", String(PR_PICKER_LIMIT));
				if (search !== undefined) args.push("--search", search);
				const items = await gitlab.json<GitlabMrListItem[]>(cwd, args);
				return items.map(item => ({
					number: item.iid,
					title: item.title,
					author: { login: item.author?.username },
					isDraft: item.draft,
					url: item.web_url,
				}));
			},
			refFor: item => mrNumberRef(project, item.number),
			refForNumber: iid => mrNumberRef(project, iid),
		};
	} catch (error) {
		const glMessage = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Failed to resolve repository for PR picker: GitHub: ${ghMessage}; GitLab: ${glMessage}`, "error");
		return undefined;
	}
}

/**
 * List the repository's open PRs/MRs with a server-side search row and a
 * `#123`/`!123` fast-path. Local type-to-filter only covers the fetched page;
 * the search row reaches items beyond it, and a number skips listing entirely
 * because the forge list search never matches item numbers.
 */
async function selectPullRequestRef(cwd: string, ctx: HookCommandContext): Promise<ReviewPrRef | undefined> {
	const source = await resolveChangeRequestSource(cwd, ctx);
	if (!source) return undefined;
	const { repo, plural, prefix } = source;
	const searchEntry = `Search open ${plural}…`;
	/** Notifies and resolves `undefined` on failure. */
	const listOpen = async (search: string | undefined): Promise<PickablePr[] | undefined> => {
		ctx.ui.setStatus("review", `Loading open ${plural}…`);
		try {
			return pickablePrs(await source.fetch(search));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Failed to list open ${plural} in ${repo}: ${message}`, "error");
			return undefined;
		} finally {
			ctx.ui.setStatus("review", undefined);
		}
	};
	const openPrs = await listOpen(undefined);
	if (openPrs === undefined) return undefined;
	if (openPrs.length === 0) {
		ctx.ui.notify(`No open ${plural} in ${repo}`, "warning");
		return undefined;
	}
	let activeQuery: string | undefined;
	let currentPrs = openPrs;
	for (;;) {
		const rows = currentPrs.map(item => ({ label: formatPrPickerLabel(item, prefix), item }));
		const title =
			activeQuery === undefined
				? `Open ${plural} in ${repo}`
				: `Open ${plural} in ${repo} matching "${activeQuery}"`;
		const selected = await ctx.ui.select(title, [...rows.map(row => row.label), searchEntry]);
		if (selected === undefined) return undefined;
		if (selected !== searchEntry) {
			const match = rows.find(row => row.label === selected);
			if (!match) return undefined;
			return source.refFor(match.item);
		}
		// The hint rides in the title: `HookInputComponent` accepts a placeholder
		// and never renders it, so a second argument would be invisible.
		const input = await ctx.ui.input(source.searchPrompt);
		if (input === undefined) continue;
		const query = input.trim();
		if (query === "") {
			activeQuery = undefined;
			currentPrs = openPrs;
			continue;
		}
		const number = parsePositivePrNumber(query.startsWith(prefix) ? query.slice(1) : query);
		if (number !== undefined) return source.refForNumber(number);
		const matches = await listOpen(query);
		// The failure was already reported; stay in the picker on the list shown before.
		if (matches === undefined) continue;
		if (matches.length === 0) {
			ctx.ui.notify(`No open ${plural} matching "${query}" in ${repo}`, "warning");
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
 * "Review a specific PR/MR" opens the open-PR/MR picker and resolves to a `pr`
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
			label: `Review ${formatReviewRefLabel(ref)} from conversation`,
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
	return ref ? { label: `Review ${formatReviewRefLabel(ref)}`, kind: "pr", ref } : undefined;
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
						: `Unable to review ${formatReviewRefLabel(parsedArgs.prRef)}: no diff content available.`)
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
