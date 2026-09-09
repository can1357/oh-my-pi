import { $env, ptree, USER_AGENT } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatMediaDuration, loadPage } from "./types";

interface GitHubUrl {
	type:
		| "blob"
		| "tree"
		| "repo"
		| "commit"
		| "issue"
		| "issues"
		| "pull"
		| "pulls"
		| "discussion"
		| "discussions"
		| "actions-run"
		| "actions-job"
		| "other";
	owner: string;
	repo: string;
	ref?: string;
	path?: string;
	number?: number;
	runId?: number;
	jobId?: number;
}

interface GitHubIssueComment {
	user: { login: string };
	created_at: string;
	body: string;
}

/**
 * Parse GitHub URL into components
 */
export function parseGitHubUrl(url: string): GitHubUrl | null {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "github.com") return null;

		const parts = parsed.pathname.split("/").filter(Boolean);
		if (parts.length < 2) return null;

		const [owner, repo, ...rest] = parts;

		if (rest.length === 0) {
			return { type: "repo", owner, repo };
		}

		const [section, ...subParts] = rest;

		switch (section) {
			case "blob":
			case "tree": {
				const [ref, ...pathParts] = subParts;
				return { type: section, owner, repo, ref, path: pathParts.join("/") };
			}
			case "commit":
				if (subParts.length > 0 && subParts[0]) {
					return { type: "commit", owner, repo, ref: subParts[0] };
				}
				return { type: "other", owner, repo };
			case "issues":
				if (subParts.length > 0 && /^\d+$/.test(subParts[0])) {
					return { type: "issue", owner, repo, number: parseInt(subParts[0], 10) };
				}
				return { type: "issues", owner, repo };
			case "pull":
				if (subParts.length > 0 && /^\d+$/.test(subParts[0])) {
					return { type: "pull", owner, repo, number: parseInt(subParts[0], 10) };
				}
				return { type: "pulls", owner, repo };
			case "pulls":
				return { type: "pulls", owner, repo };
			case "actions": {
				// /actions/runs/{runId}                      → run summary + jobs
				// /actions/runs/{runId}/job/{jobId}          → single job (web URL uses singular "job")
				// /actions/runs/{runId}/jobs/{jobId}         → single job (API-style plural)
				if (subParts[0] === "runs" && /^\d+$/.test(subParts[1] ?? "")) {
					const runId = parseInt(subParts[1], 10);
					const seg = subParts[2];
					if ((seg === "job" || seg === "jobs") && /^\d+$/.test(subParts[3] ?? "")) {
						return { type: "actions-job", owner, repo, runId, jobId: parseInt(subParts[3], 10) };
					}
					return { type: "actions-run", owner, repo, runId };
				}
				return { type: "other", owner, repo };
			}
			case "discussions":
				if (subParts.length > 0 && /^\d+$/.test(subParts[0])) {
					return { type: "discussion", owner, repo, number: parseInt(subParts[0], 10) };
				}
				return { type: "discussions", owner, repo };
			default:
				return { type: "other", owner, repo };
		}
	} catch {
		return null;
	}
}

/**
 * Convert GitHub blob URL to raw URL
 */
function toRawGitHubUrl(gh: GitHubUrl): string {
	return `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${gh.ref}/${gh.path}`;
}

/**
 * Fetch from GitHub API
 */
export async function fetchGitHubApi(
	endpoint: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ data: unknown; ok: boolean }> {
	try {
		const requestSignal = ptree.combineSignals(signal, timeout * 1000);

		const headers: Record<string, string> = {
			Accept: "application/vnd.github.v3+json",
			"User-Agent": USER_AGENT,
		};

		// Use GITHUB_TOKEN if available
		const token = $env.GITHUB_TOKEN || $env.GH_TOKEN;
		if (token) {
			headers.Authorization = `Bearer ${token}`;
		}

		const response = await fetch(`https://api.github.com${endpoint}`, {
			signal: requestSignal,
			headers,
		});

		if (!response.ok) {
			return { data: null, ok: false };
		}

		return { data: await response.json(), ok: true };
	} catch {
		return { data: null, ok: false };
	}
}

/**
 * Fetch all issue comments with pagination.
 */
async function fetchGitHubIssueComments(
	owner: string,
	repo: string,
	issueNumber: number,
	expectedCount: number,
	timeout: number,
	signal?: AbortSignal,
): Promise<GitHubIssueComment[]> {
	const perPage = 100;
	const comments: GitHubIssueComment[] = [];

	for (let page = 1; comments.length < expectedCount; page++) {
		const result = await fetchGitHubApi(
			`/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${perPage}&page=${page}`,
			timeout,
			signal,
		);
		if (!result.ok || !Array.isArray(result.data)) {
			break;
		}

		const pageComments = result.data as GitHubIssueComment[];
		if (pageComments.length === 0) {
			break;
		}

		comments.push(...pageComments);
		if (pageComments.length < perPage) {
			break;
		}
	}

	return comments;
}

/**
 * Render GitHub issue/PR to markdown
 */
async function renderGitHubIssue(
	gh: GitHubUrl,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; ok: boolean }> {
	const endpoint =
		gh.type === "pull"
			? `/repos/${gh.owner}/${gh.repo}/pulls/${gh.number}`
			: `/repos/${gh.owner}/${gh.repo}/issues/${gh.number}`;

	const result = await fetchGitHubApi(endpoint, timeout, signal);
	if (!result.ok || !result.data) return { content: "", ok: false };

	const issue = result.data as {
		title: string;
		number: number;
		state: string;
		user: { login: string };
		created_at: string;
		updated_at: string;
		body: string | null;
		labels: Array<{ name: string }>;
		comments: number;
		html_url: string;
	};

	let md = `# ${issue.title}\n\n`;
	md += `**#${issue.number}** · ${issue.state} · opened by @${issue.user.login}\n`;
	md += `Created: ${issue.created_at} · Updated: ${issue.updated_at}\n`;
	if (issue.labels.length > 0) {
		md += `Labels: ${issue.labels.map(l => l.name).join(", ")}\n`;
	}
	md += `\n---\n\n`;
	md += issue.body || "*No description provided.*";
	md += `\n\n---\n\n`;

	// Fetch comments if any
	if (issue.comments > 0) {
		const comments = await fetchGitHubIssueComments(gh.owner, gh.repo, issue.number, issue.comments, timeout, signal);
		if (comments.length > 0) {
			const commentCount =
				issue.comments > comments.length ? `${comments.length} of ${issue.comments}` : `${comments.length}`;
			md += `## Comments (${commentCount})\n\n`;
			for (const comment of comments) {
				md += `### @${comment.user.login} · ${comment.created_at}\n\n`;
				md += `${comment.body}\n\n---\n\n`;
			}
		}
	}

	return { content: md, ok: true };
}

interface GitHubCommitFile {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
	changes: number;
	patch?: string;
	previous_filename?: string;
}

/**
 * Render a GitHub commit (metadata, message, and per-file diff) to markdown.
 *
 * The commits API (`/repos/{owner}/{repo}/commits/{ref}`) returns the full
 * unified diff inline via `files[].patch`, so a single request yields both the
 * summary and the diff. Binary files have no `patch` and are flagged instead.
 */
async function renderGitHubCommit(
	gh: GitHubUrl,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; ok: boolean }> {
	const result = await fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}/commits/${gh.ref}`, timeout, signal);
	if (!result.ok || !result.data) return { content: "", ok: false };

	const commit = result.data as {
		sha: string;
		html_url: string;
		commit: {
			author?: { name?: string; date?: string } | null;
			committer?: { name?: string; date?: string } | null;
			message: string;
		};
		author?: { login: string } | null;
		committer?: { login: string } | null;
		parents?: Array<{ sha: string }>;
		stats?: { total?: number; additions?: number; deletions?: number };
		files?: GitHubCommitFile[];
	};

	const message = commit.commit.message ?? "";
	const [subject, ...bodyLines] = message.split("\n");
	const authorName = commit.author?.login ? `@${commit.author.login}` : (commit.commit.author?.name ?? "unknown");
	const authoredAt = commit.commit.author?.date ?? "";

	let md = `# ${subject || commit.sha.slice(0, 7)}\n\n`;
	md += `**${commit.sha.slice(0, 12)}** · authored by ${authorName}`;
	if (authoredAt) md += ` · ${authoredAt}`;
	md += `\n`;
	if (commit.stats) {
		const { additions = 0, deletions = 0 } = commit.stats;
		const fileCount = commit.files?.length ?? 0;
		md += `${fileCount} file${fileCount === 1 ? "" : "s"} changed · +${additions} −${deletions}\n`;
	}
	if (commit.parents && commit.parents.length > 0) {
		md += `Parents: ${commit.parents.map(p => p.sha.slice(0, 12)).join(", ")}\n`;
	}

	const body = bodyLines.join("\n").trim();
	if (body) {
		md += `\n${body}\n`;
	}

	const files = commit.files ?? [];
	if (files.length > 0) {
		md += `\n---\n\n## Files (${files.length})\n\n`;
		for (const file of files) {
			const name = file.previous_filename ? `${file.previous_filename} → ${file.filename}` : file.filename;
			md += `### ${name}\n\n`;
			md += `${file.status} · +${file.additions} −${file.deletions}\n\n`;
			if (file.patch) {
				md += `\`\`\`diff\n${file.patch}\n\`\`\`\n\n`;
			} else {
				md += `*No textual diff (binary or too large).*\n\n`;
			}
		}
	}

	return { content: md, ok: true };
}

/**
 * Render GitHub issues list to markdown
 */
async function renderGitHubIssuesList(
	gh: GitHubUrl,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; ok: boolean }> {
	const result = await fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}/issues?state=open&per_page=30`, timeout, signal);
	if (!result.ok || !Array.isArray(result.data)) return { content: "", ok: false };

	const issues = result.data as Array<{
		number: number;
		title: string;
		state: string;
		user: { login: string };
		created_at: string;
		comments: number;
		labels: Array<{ name: string }>;
		pull_request?: unknown;
	}>;

	let md = `# ${gh.owner}/${gh.repo} - Open Issues\n\n`;

	for (const issue of issues) {
		if (issue.pull_request) continue; // Skip PRs in issues list
		const labels = issue.labels.length > 0 ? ` [${issue.labels.map(l => l.name).join(", ")}]` : "";
		md += `- **#${issue.number}** ${issue.title}${labels}\n`;
		md += `  by @${issue.user.login} · ${issue.comments} comments · ${issue.created_at}\n\n`;
	}

	return { content: md, ok: true };
}

/**
 * Render GitHub tree (directory) to markdown
 */
async function renderGitHubTree(
	gh: GitHubUrl,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; ok: boolean }> {
	// Fetch repo info first to get default branch if ref not specified
	const repoResult = await fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}`, timeout, signal);
	if (!repoResult.ok) return { content: "", ok: false };

	const repo = repoResult.data as {
		full_name: string;
		default_branch: string;
	};

	const ref = gh.ref || repo.default_branch;
	const dirPath = gh.path || "";

	let md = `# ${repo.full_name}/${dirPath || "(root)"}\n\n`;
	md += `**Branch:** ${ref}\n\n`;

	// Fetch directory contents
	const contentsResult = await fetchGitHubApi(
		`/repos/${gh.owner}/${gh.repo}/contents/${dirPath}?ref=${ref}`,
		timeout,
		signal,
	);

	if (contentsResult.ok && Array.isArray(contentsResult.data)) {
		const items = contentsResult.data as Array<{
			name: string;
			type: "file" | "dir" | "symlink" | "submodule";
			size?: number;
			path: string;
		}>;

		// Sort: directories first, then files, alphabetically
		items.sort((a, b) => {
			if (a.type === "dir" && b.type !== "dir") return -1;
			if (a.type !== "dir" && b.type === "dir") return 1;
			return a.name.localeCompare(b.name);
		});

		md += `## Contents\n\n`;
		md += "```\n";
		for (const item of items) {
			const prefix = item.type === "dir" ? "[dir] " : "      ";
			const size = item.size ? ` (${item.size} bytes)` : "";
			md += `${prefix}${item.name}${item.type === "file" ? size : ""}\n`;
		}
		md += "```\n\n";

		// Look for README in this directory
		const readmeFile = items.find(item => item.type === "file" && /^readme\.md$/i.test(item.name));
		if (readmeFile) {
			const readmePath = dirPath ? `${dirPath}/${readmeFile.name}` : readmeFile.name;
			const rawUrl = `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${ref}/${readmePath}`;
			const readmeResult = await loadPage(rawUrl, { timeout, signal });
			if (readmeResult.ok) {
				md += `---\n\n## README\n\n${readmeResult.content}`;
			}
		}
	}

	return { content: md, ok: true };
}

/**
 * Render GitHub repo to markdown (file list + README)
 */
async function renderGitHubRepo(
	gh: GitHubUrl,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; ok: boolean }> {
	// Fetch repo info
	const repoResult = await fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}`, timeout, signal);
	if (!repoResult.ok) return { content: "", ok: false };

	const repo = repoResult.data as {
		full_name: string;
		description: string | null;
		stargazers_count: number;
		forks_count: number;
		open_issues_count: number;
		default_branch: string;
		language: string | null;
		license: { name: string } | null;
	};

	let md = `# ${repo.full_name}\n\n`;
	if (repo.description) md += `${repo.description}\n\n`;
	md += `Stars: ${repo.stargazers_count} · Forks: ${repo.forks_count} · Issues: ${repo.open_issues_count}\n`;
	if (repo.language) md += `Language: ${repo.language}\n`;
	if (repo.license) md += `License: ${repo.license.name}\n`;
	md += `\n---\n\n`;

	// Fetch file tree
	const treeResult = await fetchGitHubApi(
		`/repos/${gh.owner}/${gh.repo}/git/trees/${repo.default_branch}?recursive=1`,
		timeout,
		signal,
	);
	if (treeResult.ok && treeResult.data) {
		const tree = (treeResult.data as { tree: Array<{ path: string; type: string }> }).tree;
		md += `## Files\n\n`;
		md += "```\n";
		for (const item of tree.slice(0, 100)) {
			const prefix = item.type === "tree" ? "[dir] " : "      ";
			md += `${prefix}${item.path}\n`;
		}
		if (tree.length > 100) {
			md += `[…${tree.length - 100} files elided…]\n`;
		}
		md += "```\n\n";
	}

	// Fetch README
	const readmeResult = await fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}/readme`, timeout, signal);
	if (readmeResult.ok && readmeResult.data) {
		const readme = readmeResult.data as { content: string; encoding: string };
		if (readme.encoding === "base64") {
			const decoded = Buffer.from(readme.content, "base64").toString("utf-8");
			md += `## README\n\n${decoded}`;
		}
	}

	return { content: md, ok: true };
}

interface GitHubActionsStep {
	name: string;
	status: string;
	conclusion: string | null;
	number: number;
	started_at: string | null;
	completed_at: string | null;
}

interface GitHubActionsJob {
	id: number;
	run_id: number;
	name: string;
	status: string;
	conclusion: string | null;
	started_at: string | null;
	completed_at: string | null;
	html_url: string | null;
	steps?: GitHubActionsStep[];
	runner_name?: string | null;
	labels?: string[];
	workflow_name?: string | null;
	head_branch?: string | null;
	head_sha?: string;
}

interface GitHubActionsRun {
	id: number;
	name?: string | null;
	display_title?: string;
	run_number: number;
	run_attempt?: number;
	event: string;
	status: string;
	conclusion: string | null;
	head_branch?: string | null;
	head_sha?: string;
	html_url: string;
	created_at: string;
	updated_at: string;
	run_started_at?: string;
	actor?: { login: string };
	triggering_actor?: { login: string };
}

/** Combine status + conclusion into a single label, e.g. `completed (failure)`. */
function statusLabel(status: string, conclusion: string | null | undefined): string {
	return conclusion ? `${status} (${conclusion})` : status;
}

/** Wall-clock duration between two ISO timestamps, formatted HH:MM:SS / MM:SS. Empty when unknown. */
function actionDuration(start?: string | null, end?: string | null): string {
	if (!start || !end) return "";
	const ms = Date.parse(end) - Date.parse(start);
	if (!Number.isFinite(ms) || ms < 0) return "";
	return formatMediaDuration(Math.round(ms / 1000));
}

/** Escape `|` so step/job names can't break a markdown table row. */
function escapeCell(text: string): string {
	return text.replaceAll("|", "\\|");
}

/**
 * Strip the per-line ISO-8601 timestamp prefix GitHub prepends to every job log line.
 * Cuts ~28 bytes/line of noise while preserving the message text. Also drops the leading
 * UTF-8 BOM GitHub puts at the start of the log file (otherwise the first line's timestamp
 * survives because `^` no longer sits before a digit).
 */
export function stripActionsLogTimestamps(logs: string): string {
	return logs.replace(/^\uFEFF/, "").replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /gm, "");
}

/** Render a job's steps as a markdown table. Empty string when there are no steps. */
function renderActionsSteps(steps?: GitHubActionsStep[]): string {
	if (!steps || steps.length === 0) return "";
	let md = "| # | Step | Status | Conclusion | Duration |\n";
	md += "|---|------|--------|------------|----------|\n";
	for (const step of steps) {
		const dur = actionDuration(step.started_at, step.completed_at) || "-";
		md += `| ${step.number} | ${escapeCell(step.name)} | ${step.status} | ${step.conclusion ?? "-"} | ${dur} |\n`;
	}
	return `${md}\n`;
}

/** Run-level metadata lines shared by the run and job renderers. */
function renderActionsRunMeta(run: GitHubActionsRun): string {
	let md = `**Workflow:** ${run.name ?? "(unknown)"}\n`;
	md += `**Run:** #${run.run_number}`;
	if (run.run_attempt && run.run_attempt > 1) md += ` (attempt ${run.run_attempt})`;
	md += ` · ${statusLabel(run.status, run.conclusion)}\n`;
	if (run.head_branch) {
		md += `**Branch:** ${run.head_branch}${run.head_sha ? ` @ ${run.head_sha.slice(0, 7)}` : ""}\n`;
	}
	const actor = run.triggering_actor?.login ?? run.actor?.login;
	md += `**Event:** ${run.event}${actor ? ` · by @${actor}` : ""}\n`;
	const started = run.run_started_at ?? run.created_at;
	const dur = actionDuration(started, run.updated_at);
	md += `Started: ${started}${dur ? ` · Duration: ${dur}` : ""}\n`;
	md += `URL: ${run.html_url}\n`;
	return md;
}

/** Fetch a job's plain-text logs. Returns null when unavailable (no token / expired / private). */
async function fetchGitHubJobLogs(
	owner: string,
	repo: string,
	jobId: number,
	timeout: number,
	signal?: AbortSignal,
): Promise<string | null> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	const token = $env.GITHUB_TOKEN || $env.GH_TOKEN;
	if (token) headers.Authorization = `Bearer ${token}`;

	// 302 → signed log URL on a different origin; fetch strips Authorization on the cross-origin hop.
	const result = await loadPage(`https://api.github.com/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, {
		timeout,
		headers,
		signal,
	});
	return result.ok && result.content ? result.content : null;
}

/**
 * Render a workflow run: run metadata plus a per-job breakdown. Steps are listed for any job that
 * did not succeed (the debugging-relevant ones); successful jobs collapse to a single line.
 */
async function renderGitHubActionsRun(
	gh: GitHubUrl,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; ok: boolean }> {
	const runResult = await fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}/actions/runs/${gh.runId}`, timeout, signal);
	if (!runResult.ok || !runResult.data) return { content: "", ok: false };

	const run = runResult.data as GitHubActionsRun;
	let md = `# ${run.display_title || run.name || `Run #${run.run_number}`}\n\n`;
	md += renderActionsRunMeta(run);
	md += `\n---\n\n`;

	const jobsResult = await fetchGitHubApi(
		`/repos/${gh.owner}/${gh.repo}/actions/runs/${gh.runId}/jobs?per_page=100`,
		timeout,
		signal,
	);
	if (jobsResult.ok && jobsResult.data) {
		const jobs = (jobsResult.data as { jobs?: GitHubActionsJob[] }).jobs ?? [];
		md += `## Jobs (${jobs.length})\n\n`;
		for (const job of jobs) {
			const dur = actionDuration(job.started_at, job.completed_at);
			md += `### ${escapeCell(job.name)} — ${statusLabel(job.status, job.conclusion)}${dur ? ` (${dur})` : ""}\n\n`;
			if (job.conclusion !== "success") {
				md += renderActionsSteps(job.steps);
			}
		}
	}

	return { content: md, ok: true };
}

/**
 * Render a single workflow job: run context, step table, and the full job logs.
 */
async function renderGitHubActionsJob(
	gh: GitHubUrl,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; ok: boolean }> {
	const jobResult = await fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}/actions/jobs/${gh.jobId}`, timeout, signal);
	if (!jobResult.ok || !jobResult.data) return { content: "", ok: false };

	const job = jobResult.data as GitHubActionsJob;

	// Best-effort run context for nicer headers; the job render stands on its own without it.
	const runResult = await fetchGitHubApi(`/repos/${gh.owner}/${gh.repo}/actions/runs/${job.run_id}`, timeout, signal);
	const run = runResult.ok && runResult.data ? (runResult.data as GitHubActionsRun) : null;

	let md = `# ${escapeCell(job.name)}\n\n`;
	if (run) {
		md += renderActionsRunMeta(run);
	} else if (job.workflow_name) {
		md += `**Workflow:** ${job.workflow_name}\n`;
		if (job.head_branch) md += `**Branch:** ${job.head_branch}\n`;
	}
	const dur = actionDuration(job.started_at, job.completed_at);
	md += `**Job:** ${escapeCell(job.name)} · ${statusLabel(job.status, job.conclusion)}${dur ? ` · ${dur}` : ""}\n`;
	if (job.runner_name) md += `**Runner:** ${job.runner_name}\n`;
	if (job.html_url) md += `URL: ${job.html_url}\n`;
	md += `\n---\n\n`;

	const steps = renderActionsSteps(job.steps);
	if (steps) md += `## Steps\n\n${steps}`;

	const logs = await fetchGitHubJobLogs(gh.owner, gh.repo, job.id, timeout, signal);
	md += `## Logs\n\n`;
	md += logs
		? stripActionsLogTimestamps(logs)
		: "*Logs unavailable — requires a GITHUB_TOKEN/GH_TOKEN with read access, or the run's logs have expired.*\n";

	return { content: md, ok: true };
}

/**
 * Handle GitHub URLs specially
 */
export const handleGitHub: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	const gh = parseGitHubUrl(url);
	if (!gh) return null;

	const fetchedAt = new Date().toISOString();
	const notes: string[] = [];

	switch (gh.type) {
		case "blob": {
			// Convert to raw URL and fetch
			const rawUrl = toRawGitHubUrl(gh);
			notes.push(`Fetched raw: ${rawUrl}`);
			const result = await loadPage(rawUrl, { timeout, signal });
			if (result.ok) {
				return buildResult(result.content, {
					url,
					finalUrl: rawUrl,
					method: "github-raw",
					fetchedAt,
					notes,
					contentType: "text/plain",
				});
			}
			break;
		}

		case "tree": {
			notes.push(`Fetched via GitHub API`);
			const result = await renderGitHubTree(gh, timeout, signal);
			if (result.ok) {
				return buildResult(result.content, { url, method: "github-tree", fetchedAt, notes });
			}
			break;
		}

		case "commit": {
			notes.push(`Fetched via GitHub API`);
			const result = await renderGitHubCommit(gh, timeout, signal);
			if (result.ok) {
				return buildResult(result.content, { url, method: "github-commit", fetchedAt, notes });
			}
			break;
		}

		case "issue":
		case "pull": {
			notes.push(`Fetched via GitHub API`);
			const result = await renderGitHubIssue(gh, timeout, signal);
			if (result.ok) {
				return buildResult(result.content, {
					url,
					method: gh.type === "pull" ? "github-pr" : "github-issue",
					fetchedAt,
					notes,
				});
			}
			break;
		}

		case "issues": {
			notes.push(`Fetched via GitHub API`);
			const result = await renderGitHubIssuesList(gh, timeout, signal);
			if (result.ok) {
				return buildResult(result.content, { url, method: "github-issues", fetchedAt, notes });
			}
			break;
		}

		case "repo": {
			notes.push(`Fetched via GitHub API`);
			const result = await renderGitHubRepo(gh, timeout, signal);
			if (result.ok) {
				return buildResult(result.content, { url, method: "github-repo", fetchedAt, notes });
			}
			break;
		}

		case "actions-run": {
			notes.push(`Fetched via GitHub API`);
			const result = await renderGitHubActionsRun(gh, timeout, signal);
			if (result.ok) {
				return buildResult(result.content, { url, method: "github-actions-run", fetchedAt, notes });
			}
			break;
		}

		case "actions-job": {
			notes.push(`Fetched via GitHub API`);
			const result = await renderGitHubActionsJob(gh, timeout, signal);
			if (result.ok) {
				return buildResult(result.content, { url, method: "github-actions-job", fetchedAt, notes });
			}
			break;
		}
	}

	// Fall back to null (let normal rendering handle it)
	return null;
};
