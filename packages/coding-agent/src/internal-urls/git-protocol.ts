/**
 * Protocol handler for `git://` URLs backed by `@oh-my-pi/pi-natives/vcs`.
 *
 * URL shapes:
 * - `git://` — HEAD state, local branches, tags, and recent commits.
 * - `git://commit/<rev>` — commit metadata, diff stats, and bounded patch.
 * - `git://branch/<name>` — branch tip commit, ahead/behind vs default branch, and recent commits.
 * - `git://tag/<name>` — tag target commit details and co-located tags.
 * - `git://diff` — uncommitted changes (HEAD → working tree); `git://diff/staged` (HEAD → index),
 *   `git://diff/unstaged` (index → working tree), `git://diff/<base>` (merge base with `<base>` → HEAD).
 * - `git://<rev>` — friendly fallback resolving any revision as a commit.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsCommitDetails, VcsDiffOptions, VcsGitRepo, VcsHeadState, VcsNumstatEntry } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import gitDoc from "../prompts/internal-urls/git.md" with { type: "text" };
import { resolveCwd } from "./forge-diff";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	UrlCompletion,
} from "./types";

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_COMMIT_PATCH_BYTES = 256 * 1024;
const OVERVIEW_TAG_LIMIT = 20;
const OVERVIEW_COMMIT_LIMIT = 15;
const BRANCH_COMMIT_LIMIT = 15;
const COMPLETE_BRANCH_LIMIT = 50;
const COMPLETE_COMMIT_LIMIT = 20;
const COMPLETE_TAG_LIMIT = 30;

type ParsedGitUrl =
	| { kind: "overview" }
	| { kind: "commit"; rev: string }
	| { kind: "branch"; name: string }
	| { kind: "tag"; name: string }
	| { kind: "diff"; mode: GitDiffMode; base?: string }
	| { kind: "rev"; rev: string };

/** What `git://diff[/…]` compares. */
type GitDiffMode = "uncommitted" | "staged" | "unstaged" | "branch";

function sortTagNames(tags: Iterable<string>): string[] {
	return [...new Set(tags)].sort((a, b) => {
		const cmp = b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" });
		return cmp !== 0 ? cmp : b.localeCompare(a);
	});
}

async function collectLooseTags(dir: string, prefix: string, out: Set<string>): Promise<boolean> {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
	}
	for (const entry of entries) {
		if (entry.name.endsWith(".lock")) continue;
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await collectLooseTags(fullPath, rel, out);
		} else if (entry.isFile() || entry.isSymbolicLink()) {
			out.add(rel);
		}
	}
	return true;
}

async function collectPackedTags(packedRefsPath: string, out: Set<string>): Promise<boolean> {
	let text: string;
	try {
		text = await fs.readFile(packedRefsPath, "utf8");
	} catch (err) {
		return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
	}
	const tagPrefix = "refs/tags/";
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("^")) continue;
		const spaceIdx = trimmed.search(/\s+/);
		if (spaceIdx === -1) continue;
		const refName = trimmed.slice(spaceIdx).trim();
		if (refName.startsWith(tagPrefix)) {
			const tagName = refName.slice(tagPrefix.length);
			if (tagName) out.add(tagName);
		}
	}
	return true;
}

/**
 * List git tags directly from loose refs (`refs/tags`) and `packed-refs`,
 * falling back to `repo.tagsAt("HEAD")` for reftable repos or IO failures.
 */
export async function listGitTags(repo: VcsGitRepo): Promise<string[]> {
	try {
		const info = repo.info();
		if (info.isReftable) {
			return sortTagNames(await repo.tagsAt("HEAD").catch(() => []));
		}
		const tags = new Set<string>();
		const [looseOk, packedOk] = await Promise.all([
			collectLooseTags(path.join(info.commonDir, "refs", "tags"), "", tags),
			collectPackedTags(path.join(info.commonDir, "packed-refs"), tags),
		]);
		if (!looseOk && !packedOk) {
			return sortTagNames(await repo.tagsAt("HEAD").catch(() => []));
		}
		return sortTagNames(tags);
	} catch {
		try {
			return sortTagNames(await repo.tagsAt("HEAD"));
		} catch {
			return [];
		}
	}
}

function decodeTargetPath(url: InternalUrl): string {
	const rawPath = url.rawPathname ?? url.pathname;
	const stripped = (rawPath.startsWith("/") ? rawPath.slice(1) : rawPath).replace(/\/+$/, "");
	if (!stripped) return "";
	const decodedSegments: string[] = [];
	for (const seg of stripped.split("/")) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(seg);
		} catch {
			throw new Error(`Invalid git:// URL: malformed percent-encoding in '${rawPath}'`);
		}
		if (decoded === "") {
			throw new Error(`Invalid git:// URL: empty path segment in '${rawPath}'`);
		}
		decodedSegments.push(decoded);
	}
	return decodedSegments.join("/");
}

function parseGitUrl(url: InternalUrl): ParsedGitUrl {
	const host = url.rawHost || url.hostname;
	const targetPath = decodeTargetPath(url);
	if (!host && !targetPath) {
		return { kind: "overview" };
	}
	const lowered = host.toLowerCase();
	if (lowered === "commit") {
		if (!targetPath) throw new Error("Invalid git:// URL: expected git://commit/<rev>");
		return { kind: "commit", rev: targetPath };
	}
	if (lowered === "branch") {
		if (!targetPath) throw new Error("Invalid git:// URL: expected git://branch/<name>");
		return { kind: "branch", name: targetPath };
	}
	if (lowered === "tag") {
		if (!targetPath) throw new Error("Invalid git:// URL: expected git://tag/<name>");
		return { kind: "tag", name: targetPath };
	}
	if (lowered === "diff") {
		if (!targetPath) return { kind: "diff", mode: "uncommitted" };
		if (targetPath === "staged" || targetPath === "unstaged") return { kind: "diff", mode: targetPath };
		return { kind: "diff", mode: "branch", base: targetPath };
	}
	const rev = host ? (targetPath ? `${host}/${targetPath}` : host) : targetPath;
	return { kind: "rev", rev };
}

function shortSha(sha: string): string {
	return sha.slice(0, 7);
}

function commitSubject(message: string): string {
	const firstLine = message.split(/\r?\n/, 1)[0] ?? "";
	return firstLine.trim();
}

function formatHeadLine(head: VcsHeadState): string {
	if (head.branch && head.commit) {
		return `- Branch: \`${head.branch}\` (\`${shortSha(head.commit)}\`)`;
	}
	if (head.branch) {
		return `- Branch: \`${head.branch}\` (unborn)`;
	}
	if (head.commit) {
		return `- Detached HEAD: \`${shortSha(head.commit)}\``;
	}
	return `- HEAD: ${head.kind}`;
}

function formatNumstat(entries: readonly VcsNumstatEntry[]): string[] {
	if (entries.length === 0) return [];
	let totalAdded = 0;
	let totalRemoved = 0;
	const lines: string[] = [];
	for (const entry of entries) {
		if (entry.added === undefined && entry.removed === undefined) {
			lines.push(`- \`${entry.path}\` (binary)`);
		} else {
			const added = entry.added ?? 0;
			const removed = entry.removed ?? 0;
			totalAdded += added;
			totalRemoved += removed;
			lines.push(`- \`${entry.path}\` (+${added} -${removed})`);
		}
	}
	lines.unshift(`Files changed: ${entries.length} (+${totalAdded} -${totalRemoved})`, "");
	return lines;
}

function extractPatchSection(showText: string): string {
	if (showText.startsWith("diff --git ")) return showText;
	const marker = "\ndiff --git ";
	const idx = showText.indexOf(marker);
	if (idx === -1) return "";
	return showText.slice(idx + 1);
}

function formatCommitMetadata(details: VcsCommitDetails): string[] {
	const lines: string[] = [
		`- Commit: \`${details.sha}\``,
		`- Author: ${details.author.name} <${details.author.email}>`,
	];
	if (details.author.date) {
		lines.push(`- Date: ${details.author.date}`);
	}
	if (details.parents.length > 0) {
		lines.push(`- Parents: ${details.parents.map(parent => `\`${shortSha(parent)}\``).join(", ")}`);
	}
	lines.push("", details.message.trimEnd());
	return lines;
}

function buildResource(
	url: InternalUrl,
	content: string,
	options?: { immutable?: boolean; notes?: string[] },
): InternalResource {
	const normalized = content.endsWith("\n") ? content : `${content}\n`;
	const resource: InternalResource = {
		url: url.rawHref ?? url.href,
		content: normalized,
		contentType: "text/markdown",
		size: Buffer.byteLength(normalized, "utf-8"),
	};
	if (options?.immutable !== undefined) resource.immutable = options.immutable;
	if (options?.notes && options.notes.length > 0) resource.notes = options.notes;
	return resource;
}

async function resolveOverview(
	repo: VcsGitRepo,
	url: InternalUrl,
	signal: AbortSignal | undefined,
): Promise<InternalResource> {
	const [head, branches, tags, recentCommits] = await Promise.all([
		repo.head(signal),
		repo.listBranches(false, signal),
		listGitTags(repo),
		repo.logOnelines(OVERVIEW_COMMIT_LIMIT, signal).catch(() => [] as string[]),
	]);

	const lines: string[] = ["# Git Repository", "", "## HEAD", formatHeadLine(head), ""];

	lines.push(`## Local Branches (${branches.length})`);
	if (branches.length === 0) {
		lines.push("- (none)");
	} else {
		for (const branch of branches) {
			const marker = head.branch === branch ? " *(HEAD)*" : "";
			lines.push(`- \`${branch}\`${marker}`);
		}
	}
	lines.push("");

	lines.push(`## Tags (${tags.length})`);
	if (tags.length === 0) {
		lines.push("- (none)");
	} else {
		const visible = tags.slice(0, OVERVIEW_TAG_LIMIT);
		for (const tag of visible) {
			lines.push(`- \`${tag}\``);
		}
		if (tags.length > visible.length) {
			lines.push(`- … (+${tags.length - visible.length} more)`);
		}
	}
	lines.push("");

	lines.push(`## Recent Commits (${recentCommits.length})`);
	if (recentCommits.length === 0) {
		lines.push("- (none)");
	} else {
		for (const entry of recentCommits) {
			const spaceIdx = entry.indexOf(" ");
			if (spaceIdx === -1) {
				lines.push(`- \`${entry}\``);
			} else {
				lines.push(`- \`${entry.slice(0, spaceIdx)}\` ${entry.slice(spaceIdx + 1)}`);
			}
		}
	}

	return buildResource(url, lines.join("\n"), { immutable: false });
}

async function resolveCommit(
	repo: VcsGitRepo,
	rev: string,
	url: InternalUrl,
	signal: AbortSignal | undefined,
): Promise<InternalResource> {
	let details: VcsCommitDetails;
	try {
		details = await repo.commitDetails(rev, signal);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Git commit '${rev}' could not be resolved: ${message}`);
	}

	const diffBase = details.parents[0] ?? EMPTY_TREE_SHA;
	const [stats, showResult] = await Promise.all([
		repo.numstat({ base: diffBase, head: details.sha }, signal).catch(() => [] as VcsNumstatEntry[]),
		repo.showCommit(details.sha, MAX_COMMIT_PATCH_BYTES, signal).catch(() => null),
	]);

	const subject = commitSubject(details.message);
	const heading = subject
		? `# Commit \`${shortSha(details.sha)}\`: ${subject}`
		: `# Commit \`${shortSha(details.sha)}\``;
	const lines: string[] = [heading, "", ...formatCommitMetadata(details)];

	const statLines = formatNumstat(stats);
	if (statLines.length > 0) {
		lines.push("", "## Stats", ...statLines);
	}

	const notes: string[] = [];
	if (showResult) {
		const rawText = showResult.data.toString("utf8");
		const patch = extractPatchSection(rawText).trimEnd();
		if (patch) {
			lines.push("", "## Patch", "```diff", patch);
			if (showResult.truncated) {
				lines.push("[Patch truncated at 256 KiB]");
				notes.push("Patch truncated at 256 KiB");
			}
			lines.push("```");
		} else if (showResult.truncated) {
			notes.push("Commit output truncated at 256 KiB");
		}
	}

	return buildResource(url, lines.join("\n"), {
		immutable: FULL_SHA_RE.test(rev),
		notes,
	});
}

async function resolveDiff(
	repo: VcsGitRepo,
	mode: GitDiffMode,
	base: string | undefined,
	url: InternalUrl,
	signal: AbortSignal | undefined,
): Promise<InternalResource> {
	let options: VcsDiffOptions;
	let heading: string;
	switch (mode) {
		case "uncommitted":
			options = { base: "HEAD" };
			heading = "Uncommitted changes (HEAD → working tree)";
			break;
		case "staged":
			options = { cached: true };
			heading = "Staged changes (HEAD → index)";
			break;
		case "unstaged":
			options = {};
			heading = "Unstaged changes (index → working tree)";
			break;
		case "branch": {
			const target = base ?? "HEAD";
			const mergeBase = await repo.mergeBase(target, "HEAD", signal).catch(() => null);
			if (!mergeBase) throw new Error(`git://diff/${target}: no merge base between '${target}' and HEAD`);
			options = { base: mergeBase, head: "HEAD" };
			heading = `Changes on HEAD since \`${target}\` (merge base \`${shortSha(mergeBase)}\` → HEAD)`;
			break;
		}
	}

	const stats = await repo.numstat(options, signal).catch(() => [] as VcsNumstatEntry[]);
	const lines: string[] = [`# ${heading}`, ""];
	if (stats.length === 0) {
		lines.push("No changes.");
		return buildResource(url, lines.join("\n"), { immutable: false });
	}
	lines.push(...formatNumstat(stats));

	const notes: string[] = [];
	try {
		const patch = (await repo.diffText({ ...options, maxBytes: MAX_COMMIT_PATCH_BYTES }, signal)).trimEnd();
		if (patch) lines.push("", "## Patch", "```diff", patch, "```");
	} catch (err) {
		if (!vcs.isVcsError(err) || err.code !== "OutputTooLarge") throw err;
		lines.push("", "[Patch exceeds 256 KiB; stats only. Read individual files for details.]");
		notes.push("Patch omitted: larger than 256 KiB");
	}
	return buildResource(url, lines.join("\n"), { immutable: false, notes });
}

async function resolveDefaultBaseRef(
	repo: VcsGitRepo,
	branchName: string,
	signal: AbortSignal | undefined,
): Promise<{ label: string; sha: string } | null> {
	const defaultName = await repo.defaultBranch(signal).catch(() => null);
	if (!defaultName || defaultName === branchName) return null;
	const localSha = await repo.resolveRef(`refs/heads/${defaultName}`, signal).catch(() => null);
	if (localSha) return { label: defaultName, sha: localSha };
	const fallbackSha =
		(await repo.resolveRef(defaultName, signal).catch(() => null)) ??
		(await repo.resolveRef(`origin/${defaultName}`, signal).catch(() => null));
	return fallbackSha ? { label: defaultName, sha: fallbackSha } : null;
}

async function resolveBranch(
	repo: VcsGitRepo,
	name: string,
	url: InternalUrl,
	signal: AbortSignal | undefined,
): Promise<InternalResource> {
	const resolved =
		(await repo.resolveRef(`refs/heads/${name}`, signal).catch(() => null)) ??
		(await repo.resolveRef(name, signal).catch(() => null));
	if (!resolved) {
		throw new Error(`Git branch not found: ${name}`);
	}

	const [details, head, baseRef] = await Promise.all([
		repo.commitDetails(resolved, signal),
		repo.head(signal),
		resolveDefaultBaseRef(repo, name, signal),
	]);

	const lines: string[] = [`# Branch \`${name}\``, ""];
	if (head.branch === name) {
		lines.push("- Status: current HEAD branch");
	}
	if (baseRef) {
		const [aheadList, behindList] = await Promise.all([
			repo.revListRange(baseRef.sha, resolved, signal).catch(() => [] as string[]),
			repo.revListRange(resolved, baseRef.sha, signal).catch(() => [] as string[]),
		]);
		lines.push(`- Compared to \`${baseRef.label}\`: ${aheadList.length} ahead, ${behindList.length} behind`);
	}

	lines.push("", "## Tip Commit", ...formatCommitMetadata(details));

	const commitLines: string[] = [];
	if (head.commit && head.commit === resolved) {
		const onelines = await repo.logOnelines(BRANCH_COMMIT_LIMIT, signal).catch(() => [] as string[]);
		for (const entry of onelines) {
			const spaceIdx = entry.indexOf(" ");
			if (spaceIdx === -1) {
				commitLines.push(`- \`${entry}\``);
			} else {
				commitLines.push(`- \`${entry.slice(0, spaceIdx)}\` ${entry.slice(spaceIdx + 1)}`);
			}
		}
	} else {
		const rangeBase = baseRef?.sha ?? head.commit;
		if (rangeBase && rangeBase !== resolved) {
			const rangeShas = await repo.revListRange(rangeBase, resolved, signal).catch(() => [] as string[]);
			const recentShas = rangeShas.slice(-BRANCH_COMMIT_LIMIT).reverse();
			const recentDetails = await Promise.all(
				recentShas.map(sha => repo.commitDetails(sha, signal).catch(() => null)),
			);
			for (const item of recentDetails) {
				if (!item) continue;
				const subject = commitSubject(item.message);
				commitLines.push(`- \`${shortSha(item.sha)}\`${subject ? ` ${subject}` : ""}`);
			}
		}
	}

	if (commitLines.length > 0) {
		lines.push("", `## Recent Commits (${commitLines.length})`, ...commitLines);
	}

	return buildResource(url, lines.join("\n"), { immutable: false });
}

async function resolveTag(
	repo: VcsGitRepo,
	name: string,
	url: InternalUrl,
	signal: AbortSignal | undefined,
): Promise<InternalResource> {
	const resolved =
		(await repo.resolveRef(`refs/tags/${name}`, signal).catch(() => null)) ??
		(await repo.resolveRef(name, signal).catch(() => null));
	if (!resolved) {
		throw new Error(`Git tag not found: ${name}`);
	}

	let details: VcsCommitDetails;
	try {
		details = await repo.commitDetails(resolved, signal);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Git tag '${name}' does not resolve to a commit: ${message}`);
	}

	const tagsAtCommit = await repo.tagsAt(details.sha, signal).catch(() => [] as string[]);
	const lines: string[] = [`# Tag \`${name}\``, ""];
	if (resolved !== details.sha) {
		lines.push(`- Tag Object: \`${resolved}\``);
	}
	if (tagsAtCommit.length > 0) {
		lines.push(`- Tags at Commit: ${tagsAtCommit.map(tag => `\`${tag}\``).join(", ")}`);
	}
	lines.push(
		"",
		"## Target Commit",
		...formatCommitMetadata(details),
		"",
		`Full diff: \`git://commit/${details.sha}\``,
	);

	return buildResource(url, lines.join("\n"), { immutable: false });
}

/**
 * Handler for `git://` URLs: repository overview, commits, branches, and tags.
 */
export class GitProtocolHandler implements ProtocolHandler {
	readonly scheme = "git";
	readonly spec: SchemeSpec = { backing: "virtual", selectors: "lines", immutable: false };

	promptDoc(): string {
		return gitDoc.trim();
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const parsed = parseGitUrl(url);
		const cwd = resolveCwd(context);
		const repo = vcs.git(cwd);
		if (!repo) {
			throw new Error(`git:// requires a git repository (not found from '${cwd}')`);
		}
		const signal = context?.signal;
		switch (parsed.kind) {
			case "overview":
				return resolveOverview(repo, url, signal);
			case "commit":
			case "rev":
				return resolveCommit(repo, parsed.rev, url, signal);
			case "branch":
				return resolveBranch(repo, parsed.name, url, signal);
			case "tag":
				return resolveTag(repo, parsed.name, url, signal);
			case "diff":
				return resolveDiff(repo, parsed.mode, parsed.base, url, signal);
		}
	}

	async complete(query = "", context?: ResolveContext): Promise<UrlCompletion[]> {
		try {
			const cwd = resolveCwd(context);
			const repo = vcs.git(cwd);
			if (!repo) return [];
			const signal = context?.signal;
			const [branches, commits, tags] = await Promise.all([
				repo.listBranches(false, signal).catch(() => [] as string[]),
				repo.logOnelines(COMPLETE_COMMIT_LIMIT, signal).catch(() => [] as string[]),
				listGitTags(repo).catch(() => [] as string[]),
			]);

			const candidates: UrlCompletion[] = [
				{ value: "diff", label: "diff", description: "uncommitted changes" },
				{ value: "diff/staged", label: "diff/staged", description: "staged changes" },
				{ value: "diff/unstaged", label: "diff/unstaged", description: "unstaged changes" },
			];
			for (const branch of branches.slice(0, COMPLETE_BRANCH_LIMIT)) {
				candidates.push({
					value: `branch/${branch}`,
					label: branch,
					description: "branch",
				});
			}
			for (const entry of commits) {
				const spaceIdx = entry.indexOf(" ");
				const sha = spaceIdx === -1 ? entry : entry.slice(0, spaceIdx);
				const subject = spaceIdx === -1 ? "" : entry.slice(spaceIdx + 1);
				if (!sha) continue;
				candidates.push({
					value: `commit/${sha}`,
					label: sha,
					description: subject || "commit",
				});
			}
			for (const tag of tags.slice(0, COMPLETE_TAG_LIMIT)) {
				candidates.push({
					value: `tag/${tag}`,
					label: tag,
					description: "tag",
				});
			}

			const normalizedQuery = query.trim().toLowerCase();
			if (!normalizedQuery) return candidates;
			return candidates.filter(candidate =>
				[candidate.value, candidate.label ?? "", candidate.description ?? ""].some(part =>
					part.toLowerCase().includes(normalizedQuery),
				),
			);
		} catch {
			return [];
		}
	}
}
