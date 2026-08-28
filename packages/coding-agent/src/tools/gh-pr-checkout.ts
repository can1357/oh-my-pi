import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getWorktreeDir, hashPath, isEnoent } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";
import type { ToolSession } from ".";
import type { GhPrCheckoutSummary, GhToolDetails } from "./gh";
import {
	appendRepoFlag,
	buildTextResult,
	formatAuthor,
	formatLabels,
	formatRepoRef,
	normalizeOptionalString,
	normalizePrIdentifierList,
	normalizeText,
	parsePullRequestUrl,
	parseRepoRef,
	pushLine,
	requireCurrentGitBranch,
	requireNonEmpty,
} from "./gh-common";
import { formatShortSha } from "./gh-format";
import type { GhPrViewData, GhRepoViewData, GithubInput } from "./gh-types";
import { GH_PR_FIELDS_NO_COMMENTS } from "./gh-view";
import { invalidateAllForNumber } from "./github-cache";
import { ToolError, throwIfAborted } from "./tool-errors";

export const GH_REPO_CLONE_FIELDS = ["nameWithOwner", "sshUrl", "url"];
export const GH_PR_CHECKOUT_FIELDS = [
	"baseRefName",
	"headRefName",
	"headRefOid",
	"headRepository",
	"headRepositoryOwner",
	"isCrossRepository",
	"maintainerCanModify",
	"number",
	"title",
	"url",
];

export function sanitizeRemoteName(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/g, "")
		.replace(/-+$/g, "");
	return sanitized.length > 0 ? `fork-${sanitized}` : "fork";
}

/** Maximum disambiguation suffixes we try before giving up on a worktree path. */
export const WORKTREE_PATH_MAX_SUFFIX = 100;

export function toLocalBranchRef(value: string): string {
	return `refs/heads/${value}`;
}

export async function requireGitRepoRoot(cwd: string, signal?: AbortSignal): Promise<string> {
	const repoRoot = await git.repo.root(cwd, signal);
	if (!repoRoot) {
		throw new ToolError("Current git repository is unavailable.");
	}

	return repoRoot;
}

export async function requirePrimaryGitRepoRoot(cwd: string, signal?: AbortSignal): Promise<string> {
	const primaryRepoRoot = await git.repo.primaryRoot(cwd, signal);
	if (!primaryRepoRoot) {
		throw new ToolError("Current git repository is unavailable.");
	}

	return primaryRepoRoot;
}

/**
 * Resolve a worktree path that is free of conflicts.
 *
 * Given a `basePath`, return either `basePath` itself or `${basePath}-2`,
 * `${basePath}-3`, … up to {@link WORKTREE_PATH_MAX_SUFFIX} — whichever is the
 * first variant that is **not** registered with git as another worktree and
 * **not** present on disk. The numeric tail salvages two rare cases that
 * would otherwise abort a checkout: stale leftover dirs from an interrupted
 * `git worktree add`, and the (vanishingly unlikely) `hashPath` collision
 * between two repos that happen to produce the same 7-hex digest.
 */
export async function resolveAvailableWorktreePath(
	basePath: string,
	existingWorktrees: git.GitWorktreeEntry[],
): Promise<string> {
	const registered = new Set(existingWorktrees.map(entry => path.resolve(entry.path)));
	for (let attempt = 0; attempt < WORKTREE_PATH_MAX_SUFFIX; attempt += 1) {
		const candidate = attempt === 0 ? basePath : `${basePath}-${attempt + 1}`;
		const normalized = path.resolve(candidate);
		if (registered.has(normalized)) continue;
		try {
			await fs.stat(normalized);
		} catch (error) {
			if (isEnoent(error)) {
				return candidate;
			}
			throw error;
		}
	}
	throw new ToolError(
		`could not find an unused worktree path under ${basePath} (tried ${WORKTREE_PATH_MAX_SUFFIX} suffixes)`,
	);
}

export function selectPrCloneUrl(originUrl: string | undefined, repo: Pick<GhRepoViewData, "url" | "sshUrl">): string {
	if (originUrl?.startsWith("http://") || originUrl?.startsWith("https://")) {
		return normalizeOptionalString(repo.url) ?? normalizeOptionalString(repo.sshUrl) ?? "";
	}

	return normalizeOptionalString(repo.sshUrl) ?? normalizeOptionalString(repo.url) ?? "";
}

export async function getRemoteUrls(repoRoot: string, signal?: AbortSignal): Promise<Map<string, string>> {
	const remotes = await git.remote.list(repoRoot, signal);
	const urls = new Map<string, string>();
	for (const remoteName of remotes) {
		const remoteUrl = await git.remote.url(repoRoot, remoteName, signal);
		if (remoteUrl) {
			urls.set(remoteName, remoteUrl);
		}
	}
	return urls;
}

export async function ensurePrRemote(
	repoRoot: string,
	data: GhPrViewData,
	signal?: AbortSignal,
): Promise<{ name: string; url: string }> {
	if (!data.isCrossRepository) {
		const originUrl = await git.remote.url(repoRoot, "origin", signal);
		if (!originUrl) {
			throw new ToolError("origin remote is unavailable for this repository.");
		}

		return {
			name: "origin",
			url: originUrl,
		};
	}

	const headRepository = requireNonEmpty(data.headRepository?.nameWithOwner, "head repository");
	const pullRepo = parsePullRequestUrl(data.url).repo;
	const pullHost = pullRepo ? parseRepoRef(pullRepo).host : undefined;
	const repoSummary = await git.github.json<GhRepoViewData>(
		repoRoot,
		["repo", "view", formatRepoRef(pullHost, headRepository), "--json", GH_REPO_CLONE_FIELDS.join(",")],
		signal,
		{ repoProvided: true },
	);
	const originUrl = await git.remote.url(repoRoot, "origin", signal);
	const remoteUrl = selectPrCloneUrl(originUrl, repoSummary);
	if (!remoteUrl) {
		throw new ToolError(`Could not determine a clone URL for ${headRepository}.`);
	}

	const remotes = await getRemoteUrls(repoRoot, signal);
	for (const [remoteName, url] of remotes) {
		if (url === remoteUrl) {
			return { name: remoteName, url };
		}
	}

	const preferredRemoteName = sanitizeRemoteName(
		data.headRepositoryOwner?.login ?? headRepository.split("/")[0] ?? "fork",
	);
	let remoteName = preferredRemoteName;
	let suffix = 2;
	while (remotes.has(remoteName)) {
		remoteName = `${preferredRemoteName}-${suffix}`;
		suffix += 1;
	}

	await git.remote.add(repoRoot, remoteName, remoteUrl, signal);

	return {
		name: remoteName,
		url: remoteUrl,
	};
}

export async function resolvePrBranchPushTarget(
	repoRoot: string,
	localBranch: string,
	signal?: AbortSignal,
): Promise<{
	remoteName: string;
	remoteBranch: string;
	remoteUrl?: string;
	prUrl?: string;
	maintainerCanModify?: boolean;
	isCrossRepository: boolean;
}> {
	const headRef = await git.config.getBranch(repoRoot, localBranch, "ompPrHeadRef", signal);
	if (!headRef) {
		throw new ToolError(`branch ${localBranch} has no PR push metadata; check it out via op: pr_checkout first`);
	}

	const pushRemote = await git.config.getBranch(repoRoot, localBranch, "pushRemote", signal);
	const remote = await git.config.getBranch(repoRoot, localBranch, "remote", signal);
	const prUrl = await git.config.getBranch(repoRoot, localBranch, "ompPrUrl", signal);
	const maintainerCanModifyValue = await git.config.getBranch(
		repoRoot,
		localBranch,
		"ompPrMaintainerCanModify",
		signal,
	);
	const isCrossRepositoryValue = await git.config.getBranch(repoRoot, localBranch, "ompPrIsCrossRepository", signal);

	const remoteName = pushRemote ?? remote;
	if (!remoteName) {
		throw new ToolError(`branch ${localBranch} has no configured push remote`);
	}

	return {
		remoteName,
		remoteBranch: headRef,
		remoteUrl: await git.remote.url(repoRoot, remoteName, signal),
		prUrl,
		maintainerCanModify:
			maintainerCanModifyValue === undefined
				? undefined
				: ["1", "true", "yes", "on"].includes(maintainerCanModifyValue.toLowerCase()),
		isCrossRepository: ["1", "true", "yes", "on"].includes((isCrossRepositoryValue ?? "").toLowerCase()),
	};
}

export function formatPrCheckoutResult(options: {
	data: GhPrViewData;
	localBranch: string;
	worktreePath: string;
	remoteName: string;
	remoteUrl: string;
	reused: boolean;
}): string {
	const { data, localBranch, worktreePath, remoteName, remoteUrl, reused } = options;
	const lines: string[] = [
		reused ? `# Pull Request #${data.number ?? "?"} Worktree` : `# Checked Out Pull Request #${data.number ?? "?"}`,
		"",
	];
	pushLine(lines, "Title", data.title ?? undefined);
	pushLine(lines, "URL", data.url);
	pushLine(lines, "Base", data.baseRefName);
	pushLine(lines, "Head", data.headRefName);
	pushLine(lines, "Local branch", localBranch);
	pushLine(lines, "Worktree", worktreePath);
	pushLine(lines, "Remote", remoteName);
	pushLine(lines, "Remote URL", remoteUrl);
	pushLine(lines, "Cross repository", data.isCrossRepository);
	pushLine(lines, "Maintainer can modify", data.maintainerCanModify);
	lines.push("");
	lines.push(
		reused
			? "Reused the existing PR worktree."
			: "Created a dedicated worktree for this PR and configured the local branch to push back to the PR head branch.",
	);
	return lines.join("\n").trim();
}

export function formatPrPushResult(options: {
	localBranch: string;
	remoteName: string;
	remoteBranch: string;
	remoteUrl?: string;
	prUrl?: string;
	forceWithLease: boolean;
}): string {
	const lines: string[] = ["# Pushed Pull Request Branch", ""];
	pushLine(lines, "Local branch", options.localBranch);
	pushLine(lines, "Remote", options.remoteName);
	pushLine(lines, "Remote branch", options.remoteBranch);
	pushLine(lines, "Remote URL", options.remoteUrl);
	pushLine(lines, "PR", options.prUrl);
	pushLine(lines, "Force with lease", options.forceWithLease);
	lines.push("");
	lines.push(`Pushed ${options.localBranch} to ${options.remoteName}:${options.remoteBranch}.`);
	return lines.join("\n").trim();
}

export function joinSections(sections: string[]): string[] {
	return sections.flatMap((section, idx) => (idx === 0 ? [section] : ["", "---", "", section]));
}

export async function executePrCheckout(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const force = params.force ?? false;
	const prList = normalizePrIdentifierList(params.pr);
	const prRefs = prList.length > 0 ? prList : [undefined];
	const isMulti = prRefs.length > 1;

	const settled = await Promise.allSettled(
		prRefs.map(prRef => checkoutPullRequest(session, signal, { prRef, repo, force })),
	);
	const outcomes: PrCheckoutOutcome[] = [];
	const failures: Array<{ prRef: string | undefined; reason: unknown }> = [];
	for (let i = 0; i < settled.length; i++) {
		const entry = settled[i];
		if (entry.status === "fulfilled") outcomes.push(entry.value);
		else failures.push({ prRef: prRefs[i], reason: entry.reason });
	}
	if (failures.length > 0) {
		throwIfAborted(signal);
		const failureLines = failures.map(
			f => `- ${f.prRef ?? "(current branch)"}: ${f.reason instanceof Error ? f.reason.message : String(f.reason)}`,
		);
		if (outcomes.length === 0) {
			if (failures.length === 1) throw failures[0].reason;
			throw new ToolError(`all ${failures.length} PR checkouts failed:\n${failureLines.join("\n")}`);
		}
		// Partial success: report the worktrees that did get created alongside
		// the failures so the agent does not lose track of them.
		const sections = outcomes.map(formatPrCheckoutResult);
		const header = `# ${outcomes.length}/${settled.length} Pull Request Worktrees checked out (${failures.length} failed)`;
		const text = [header, "", ...joinSections(sections), "", "## Failed", ...failureLines].join("\n").trim();
		return buildTextResult(text, undefined, {
			repo,
			checkouts: outcomes.map(outcomeToSummary),
		});
	}

	if (!isMulti) {
		const [outcome] = outcomes;
		return buildTextResult(formatPrCheckoutResult(outcome), outcome.data.url, {
			repo: repo ?? outcome.data.headRepository?.nameWithOwner,
			branch: outcome.localBranch,
			worktreePath: outcome.worktreePath,
			remote: outcome.remoteName,
			remoteBranch: outcome.headRefName,
			checkouts: [outcomeToSummary(outcome)],
		});
	}

	const sections = outcomes.map(formatPrCheckoutResult);
	const reusedCount = outcomes.reduce((acc, o) => acc + (o.reused ? 1 : 0), 0);
	const newCount = outcomes.length - reusedCount;
	const headerParts: string[] = [];
	if (newCount > 0) headerParts.push(`${newCount} checked out`);
	if (reusedCount > 0) headerParts.push(`${reusedCount} reused`);
	const header = `# ${outcomes.length} Pull Request Worktrees (${headerParts.join(", ")})`;
	const text = [header, "", ...joinSections(sections)].join("\n").trim();

	return buildTextResult(text, undefined, {
		repo,
		checkouts: outcomes.map(outcomeToSummary),
	});
}

export interface PrCheckoutOptions {
	prRef: string | undefined;
	repo: string | undefined;
	force: boolean;
}

export interface PrCheckoutOutcome {
	data: GhPrViewData;
	localBranch: string;
	worktreePath: string;
	remoteName: string;
	remoteUrl: string;
	headRefName: string;
	reused: boolean;
}

export async function checkoutPullRequest(
	session: ToolSession,
	signal: AbortSignal | undefined,
	options: PrCheckoutOptions,
): Promise<PrCheckoutOutcome> {
	const { prRef, repo, force } = options;
	if (prRef?.startsWith("-")) {
		throw new ToolError(`invalid PR identifier: ${prRef}. Pass a PR number, URL, or branch name.`);
	}
	const args = ["pr", "view"];
	if (prRef) args.push(prRef);
	appendRepoFlag(args, repo, prRef);
	args.push("--json", GH_PR_CHECKOUT_FIELDS.join(","));

	const data = await git.github.json<GhPrViewData>(session.cwd, args, signal, {
		repoProvided: Boolean(repo),
	});
	const prNumber = data.number;
	if (typeof prNumber !== "number") {
		throw new ToolError("GitHub CLI did not return a pull request number.");
	}

	const headRefName = requireNonEmpty(data.headRefName, "head branch");
	const headRefOid = requireNonEmpty(data.headRefOid, "head commit");
	const repoRoot = await requireGitRepoRoot(session.cwd, signal);
	const primaryRepoRoot = await requirePrimaryGitRepoRoot(repoRoot, signal);
	const localBranch = `pr-${prNumber}`;
	const worktreePath = getWorktreeDir(`${prNumber}-${hashPath(primaryRepoRoot)}`);

	// Every git mutation against `repoRoot` from here on must run under the
	// per-repo lock. Worktrees of the same primary repo share `.git/config`,
	// `commit-graph` chain, `packed-refs`, and worktree metadata files — git
	// uses O_EXCL lock files for each, with no waiter. Concurrent in-process
	// callers (e.g. parallel `pr_checkout` calls) would otherwise lose lock
	// races and surface "could not lock config file" / "Another git process
	// seems to be running" errors. The gh API call above stays outside the
	// lock so multiple checkouts can fetch PR metadata in parallel.
	return git.withRepoLock(
		repoRoot,
		async () => {
			const existingWorktrees = await git.worktree.list(repoRoot, signal);
			const existingWorktree = existingWorktrees.find(entry => entry.branch === toLocalBranchRef(localBranch));

			const remote = await ensurePrRemote(repoRoot, data, signal);
			await git.fetch(
				repoRoot,
				remote.name,
				`refs/heads/${headRefName}`,
				`refs/remotes/${remote.name}/${headRefName}`,
				{ signal },
			);

			if (!existingWorktree) {
				const localBranchRef = toLocalBranchRef(localBranch);
				const localBranchExists = await git.ref.exists(repoRoot, localBranchRef, signal);
				if (localBranchExists) {
					const existingOid = await git.ref.resolve(repoRoot, localBranchRef, signal);
					if (existingOid !== headRefOid) {
						if (!force) {
							throw new ToolError(
								`local branch ${localBranch} already exists at ${formatShortSha(existingOid ?? undefined) ?? existingOid ?? "unknown commit"}; pass force=true to reset it`,
							);
						}

						await git.branch.force(repoRoot, localBranch, `refs/remotes/${remote.name}/${headRefName}`, signal);
					}
				} else {
					await git.branch.create(repoRoot, localBranch, `refs/remotes/${remote.name}/${headRefName}`, signal);
				}
			}

			await git.config.setBranch(repoRoot, localBranch, "remote", remote.name, signal);
			await git.config.setBranch(repoRoot, localBranch, "merge", `refs/heads/${headRefName}`, signal);
			await git.config.setBranch(repoRoot, localBranch, "pushRemote", remote.name, signal);
			await git.config.setBranch(repoRoot, localBranch, "ompPrHeadRef", headRefName, signal);
			await git.config.setBranch(repoRoot, localBranch, "ompPrUrl", data.url ?? "", signal);
			await git.config.setBranch(
				repoRoot,
				localBranch,
				"ompPrIsCrossRepository",
				String(Boolean(data.isCrossRepository)),
				signal,
			);
			await git.config.setBranch(
				repoRoot,
				localBranch,
				"ompPrMaintainerCanModify",
				String(Boolean(data.maintainerCanModify)),
				signal,
			);

			let finalWorktreePath = existingWorktree?.path ?? worktreePath;
			if (!existingWorktree) {
				finalWorktreePath = await resolveAvailableWorktreePath(worktreePath, existingWorktrees);
				await fs.mkdir(path.dirname(finalWorktreePath), { recursive: true });
				await git.worktree.add(repoRoot, finalWorktreePath, localBranch, { signal });
			}
			const resolvedWorktreePath = await fs.realpath(finalWorktreePath);

			return {
				data,
				localBranch,
				worktreePath: resolvedWorktreePath,
				remoteName: remote.name,
				remoteUrl: remote.url,
				headRefName,
				reused: Boolean(existingWorktree),
			};
		},
		signal,
	);
}

export function outcomeToSummary(outcome: PrCheckoutOutcome): GhPrCheckoutSummary {
	return {
		prNumber: typeof outcome.data.number === "number" ? outcome.data.number : undefined,
		url: outcome.data.url ?? undefined,
		branch: outcome.localBranch,
		worktreePath: outcome.worktreePath,
		remote: outcome.remoteName,
		remoteBranch: outcome.headRefName,
		reused: outcome.reused,
	};
}

export async function executePrPush(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repoRoot = await requireGitRepoRoot(session.cwd, signal);
	const localBranch = normalizeOptionalString(params.branch) ?? (await requireCurrentGitBranch(repoRoot, signal));
	const refExists = await git.ref.exists(repoRoot, toLocalBranchRef(localBranch), signal);
	if (!refExists) {
		throw new ToolError(`local branch ${localBranch} does not exist`);
	}

	const target = await resolvePrBranchPushTarget(repoRoot, localBranch, signal);
	const currentBranch = await git.branch.current(repoRoot, signal);
	const sourceRef = currentBranch === localBranch ? "HEAD" : toLocalBranchRef(localBranch);
	const refspec = `${sourceRef}:refs/heads/${target.remoteBranch}`;
	await git.push(repoRoot, {
		forceWithLease: params.forceWithLease,
		refspec,
		remote: target.remoteName,
		signal,
	});

	// A successful push changes what `pr://N` and `pr://N/diff` should show;
	// drop the cached rows so the canonical "push → re-read diff" flow sees
	// fresh data instead of a soft-TTL stale snapshot.
	const pushedPr = parsePullRequestUrl(target.prUrl);
	if (pushedPr.prNumber !== undefined) {
		invalidateAllForNumber(pushedPr.prNumber, pushedPr.repo);
	}

	return buildTextResult(
		formatPrPushResult({
			localBranch,
			remoteName: target.remoteName,
			remoteBranch: target.remoteBranch,
			remoteUrl: target.remoteUrl,
			prUrl: target.prUrl,
			forceWithLease: params.forceWithLease ?? false,
		}),
		target.prUrl,
		{
			branch: localBranch,
			remote: target.remoteName,
			remoteBranch: target.remoteBranch,
		},
	);
}

export async function executePrCreate(
	session: ToolSession,
	params: GithubInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const repo = normalizeOptionalString(params.repo);
	const title = normalizeOptionalString(params.title);
	const body = params.body;
	const base = normalizeOptionalString(params.base);
	const head = normalizeOptionalString(params.head);
	const draft = params.draft ?? false;
	const fill = params.fill ?? false;
	const reviewers = normalizePrIdentifierList(params.reviewer);
	const assignees = normalizePrIdentifierList(params.assignee);
	const labels = normalizePrIdentifierList(params.label);

	if (!fill && !title) {
		throw new ToolError("title is required unless fill is true");
	}
	if (fill && (title || body !== undefined)) {
		throw new ToolError("fill is mutually exclusive with title and body");
	}

	const args = ["pr", "create"];
	appendRepoFlag(args, repo);
	if (title) args.push("--title", title);
	if (base) args.push("--base", base);
	if (head) args.push("--head", head);
	if (draft) args.push("--draft");
	if (fill) args.push("--fill");
	for (const reviewer of reviewers) args.push("--reviewer", reviewer);
	for (const assignee of assignees) args.push("--assignee", assignee);
	for (const label of labels) args.push("--label", label);

	let bodyDir: string | undefined;
	try {
		if (!fill) {
			if (body !== undefined && body.length > 0) {
				// Route through a temp file so multi-KB bodies stay clear of any
				// argv-length limits and shell-quoting hazards on uncommon platforms.
				bodyDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-pr-body-"));
				const bodyFile = path.join(bodyDir, "body.md");
				await Bun.write(bodyFile, body);
				args.push("--body-file", bodyFile);
			} else {
				// Avoid gh dropping into an interactive editor when no body is given.
				args.push("--body", "");
			}
		}

		const output = await git.github.text(session.cwd, args, signal, {
			repoProvided: Boolean(repo),
		});
		const url =
			output
				.split("\n")
				.map(line => line.trim())
				.find(line => line.startsWith("https://")) ?? output.trim();
		const parsed = parsePullRequestUrl(url);
		const resolvedRepo = repo ?? parsed.repo;

		let prView: GhPrViewData | undefined;
		if (resolvedRepo && parsed.prNumber !== undefined) {
			try {
				prView = await git.github.json<GhPrViewData>(
					session.cwd,
					[
						"pr",
						"view",
						String(parsed.prNumber),
						"--repo",
						resolvedRepo,
						"--json",
						GH_PR_FIELDS_NO_COMMENTS.join(","),
					],
					signal,
					{ repoProvided: true },
				);
			} catch {
				// Best-effort summary; PR creation already succeeded.
			}
		}

		const text = formatPrCreateResult({
			url,
			prNumber: parsed.prNumber,
			data: prView,
			title,
			base,
			head,
			draft,
		});
		return buildTextResult(text, url || prView?.url);
	} finally {
		if (bodyDir) {
			await fs.rm(bodyDir, { recursive: true, force: true }).catch(() => {});
		}
	}
}

export function formatPrCreateResult(options: {
	url: string;
	prNumber?: number;
	data?: GhPrViewData;
	title?: string;
	base?: string;
	head?: string;
	draft?: boolean;
}): string {
	const number = options.prNumber ?? options.data?.number;
	const headerTitle = options.data?.title ?? options.title ?? "Untitled";
	const header =
		number !== undefined
			? `# Created Pull Request #${number}: ${headerTitle}`
			: `# Created Pull Request: ${headerTitle}`;
	const lines: string[] = [header, ""];
	pushLine(lines, "URL", options.url || options.data?.url);
	pushLine(lines, "State", options.data?.state);
	pushLine(lines, "Draft", options.data?.isDraft ?? options.draft);
	pushLine(lines, "Base", options.data?.baseRefName ?? options.base);
	pushLine(lines, "Head", options.data?.headRefName ?? options.head);
	pushLine(lines, "Author", formatAuthor(options.data?.author));
	pushLine(lines, "Created", options.data?.createdAt);
	pushLine(lines, "Labels", formatLabels(options.data?.labels));

	const bodyText = normalizeText(options.data?.body);
	if (bodyText) {
		lines.push("");
		lines.push("## Body");
		lines.push("");
		lines.push(bodyText);
	}

	return lines.join("\n").trim();
}
