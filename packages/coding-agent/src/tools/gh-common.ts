import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";
import type { ToolSession } from ".";
import type { GhToolDetails } from "./gh";
import type { GhLabel, GhUser } from "./gh-types";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

export function normalizeText(value: string | null | undefined): string {
	return (value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "    ").trim();
}

export function normalizeBlock(value: string | null | undefined): string {
	return (value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "    ").trimEnd();
}

export function normalizeOptionalString(value: string | null | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

export function normalizePrIdentifierList(value: string | string[] | undefined): string[] {
	if (value === undefined) return [];
	const raw = typeof value === "string" ? [value] : value;
	const cleaned: string[] = [];
	for (const entry of raw) {
		const trimmed = entry?.trim();
		if (trimmed) cleaned.push(trimmed);
	}
	return cleaned;
}

export function requireNonEmpty(value: string | null | undefined, label: string): string {
	const normalized = normalizeOptionalString(value);
	if (!normalized) {
		throw new ToolError(`${label} must not be empty`);
	}
	return normalized;
}

export function appendRepoFlag(args: string[], repo: string | undefined, identifier?: string): void {
	// A full URL identifier already names host, repo, and number; `gh` derives
	// all three from it and rejects a competing `--repo`.
	if (!repo || identifier?.startsWith("https://")) {
		return;
	}

	args.push("--repo", repo);
}

/** The host `gh` assumes when a ref names none and `GH_HOST` is unset. */
export const GITHUB_HOST = "github.com";

/**
 * A repository in the GitHub CLI's `[HOST/]OWNER/REPO` form. A ref that names
 * no host is left for `gh` to resolve against `GH_HOST` (github.com by
 * default), so a host that is known — including github.com itself — is worth
 * keeping: it is what pins the request to the right instance.
 */
export interface GhRepoRef {
	/** Host this repo lives on, or undefined when unknown. */
	host?: string;
	/** `OWNER/REPO`, never host-qualified. */
	slug: string;
}

/** Split `[HOST/]OWNER/REPO`; anything with another shape is taken as a slug. */
export function parseRepoRef(repo: string): GhRepoRef {
	const firstSlash = repo.indexOf("/");
	if (firstSlash < 0) return { slug: repo };
	const secondSlash = repo.indexOf("/", firstSlash + 1);
	if (secondSlash < 0 || repo.includes("/", secondSlash + 1)) return { slug: repo };
	return { host: repo.slice(0, firstSlash), slug: repo.slice(firstSlash + 1) };
}

/** Join a known host and `OWNER/REPO` into the form `--repo` accepts. */
export function formatRepoRef(host: string | undefined, slug: string): string {
	return host ? `${host}/${slug}` : slug;
}

/**
 * `gh api` endpoint paths carry no host, so a ref has to name its host with a
 * flag instead.
 */
export function ghApiHostArgs(ref: GhRepoRef): string[] {
	return ref.host ? ["--hostname", ref.host] : [];
}

const REPO_URL_PATTERN = /^https?:\/\/([^/]+)\/([^/]+)\/([^/?#]+)/;

/**
 * `https://HOST/OWNER/REPO` → the repository's identity. The host is dropped
 * only when it is the one `gh` would have assumed anyway, so a bare identity
 * can never be redirected: with `GH_HOST` set elsewhere, even a github.com
 * checkout keeps its host.
 */
export function repoFromUrl(value: string | undefined): string | undefined {
	const match = REPO_URL_PATTERN.exec(value?.trim() ?? "");
	if (!match) return undefined;
	const host = match[1].toLowerCase();
	const slug = `${match[2]}/${match[3]}`;
	return host === defaultGhHost() ? slug : formatRepoRef(host, slug);
}

export const PR_URL_PATTERN = /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/;
export const ISSUE_URL_PATTERN = /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/.*)?$/;

export async function requireCurrentGitBranch(cwd: string, signal?: AbortSignal): Promise<string> {
	const branch = await git.branch.current(cwd, signal);
	if (!branch) {
		throw new ToolError("Current git branch is unavailable. Pass `branch` or `run` explicitly.");
	}

	return branch;
}

export async function requireCurrentGitHead(cwd: string, signal?: AbortSignal): Promise<string> {
	const headSha = await git.head.sha(cwd, signal);
	if (!headSha) {
		throw new ToolError("Current git HEAD is unavailable. Pass `run` explicitly.");
	}

	return headSha;
}

export function formatAuthor(author: GhUser | null | undefined): string | undefined {
	if (!author) return undefined;
	if (author.login) return `@${author.login}`;
	if (author.name) return author.name;
	return undefined;
}

export function formatLabels(labels: GhLabel[] | undefined): string | undefined {
	const names = labels?.map(label => label.name).filter((value): value is string => Boolean(value)) ?? [];
	if (names.length === 0) return undefined;
	return names.join(", ");
}

export function pushLine(lines: string[], label: string, value: string | number | boolean | undefined): void {
	if (value === undefined || value === "") return;
	lines.push(`${label}: ${value}`);
}

export function parsePullRequestUrl(value: string | undefined): { repo?: string; prNumber?: number } {
	const normalized = normalizeOptionalString(value);
	if (!normalized) {
		return {};
	}

	const match = normalized.match(PR_URL_PATTERN);
	if (!match) {
		return {};
	}

	return {
		repo: formatRepoRef(match[1], match[2]),
		prNumber: Number(match[3]),
	};
}

/**
 * Parse a digit-only decimal positive integer or return undefined. Rejects
 * `1e2`, `0x10`, `12.0`, leading +/-, or any other shape `Number()` would
 * accept — those would otherwise key the cache against the wrong row.
 */
export function parsePositiveDecimalInt(value: string | undefined): number | undefined {
	if (!value || !/^\d+$/.test(value)) return undefined;
	const num = Number(value);
	if (!Number.isSafeInteger(num) || num <= 0) return undefined;
	return num;
}

export function parseIssueUrl(value: string | undefined): { repo?: string; issueNumber?: number } {
	const normalized = normalizeOptionalString(value);
	if (!normalized) return {};
	const match = normalized.match(ISSUE_URL_PATTERN);
	if (!match) return {};
	return {
		repo: formatRepoRef(match[1], match[2]),
		issueNumber: Number(match[3]),
	};
}

/** The host `gh` falls back to for any ref that names none. */
export function defaultGhHost(): string {
	return (process.env.GH_HOST || GITHUB_HOST).toLowerCase();
}

/** The host `gh` will send a ref to, whether or not the ref names one. */
function effectiveHost(ref: GhRepoRef): string {
	return ref.host?.toLowerCase() ?? defaultGhHost();
}

/**
 * Case-insensitive repo comparison over the instance each ref actually
 * resolves to. A host-less ref is not a wildcard: `gh` sends it to `GH_HOST`,
 * so comparing slugs alone would call a bare `owner/repo` the same repository
 * as `ghe.example.com/owner/repo` and let a caller act on one while the
 * request goes to the other.
 */
export function githubRepoSlugEquals(left: string | undefined, right: string): boolean {
	if (left === undefined) return false;
	const leftRef = parseRepoRef(left);
	const rightRef = parseRepoRef(right);
	if (effectiveHost(leftRef) !== effectiveHost(rightRef)) return false;
	return leftRef.slug.toLowerCase() === rightRef.slug.toLowerCase();
}

/**
 * Ask `gh` which repository the checkout points at, as `[HOST/]OWNER/REPO`.
 *
 * `nameWithOwner` alone would drop the host, and `gh` resolves a host-less
 * `--repo` against `GH_HOST` (github.com by default) — so an enterprise
 * checkout would silently be looked up on github.com. The repo URL carries
 * the host `gh` itself resolved from the remote.
 */
async function resolveRepoFromCwd(cwd: string, signal?: AbortSignal): Promise<string> {
	const url = requireNonEmpty(
		await git.github.text(cwd, ["repo", "view", "--json", "url", "-q", ".url"], signal),
		"repo",
	);
	const repo = repoFromUrl(url);
	if (!repo) {
		throw new ToolError(`GitHub CLI returned an unrecognized repository URL: ${url}`);
	}
	return repo;
}

export async function resolveGitHubRepo(
	cwd: string,
	repo: string | undefined,
	runRepo: string | undefined,
	signal?: AbortSignal,
): Promise<string> {
	if (repo && runRepo && !githubRepoSlugEquals(repo, runRepo)) {
		throw new ToolError("run URL repository does not match the provided repo");
	}

	if (repo) {
		return repo;
	}

	if (runRepo) {
		return runRepo;
	}

	return resolveRepoFromCwd(cwd, signal);
}

/**
 * Process-lifetime cache of `gh repo view` lookups keyed by absolute cwd.
 * Avoids repeated `gh` chatter when the same protocol handler or tool call
 * resolves the default repo many times in a row.
 *
 * The shared lookup is intentionally **not** bound to any caller's
 * AbortSignal. Cancelling one caller would otherwise kill the underlying
 * `gh repo view` for every concurrent waiter on the same cwd. Each caller's
 * signal is honored at the wait point via `untilAborted` instead, so an abort
 * unwinds only that caller.
 */
export const DEFAULT_REPO_RESOLVED = new Map<string, string>();
export const DEFAULT_REPO_INFLIGHT = new Map<string, Promise<string>>();

export async function resolveDefaultRepoMemoized(cwd: string, signal?: AbortSignal): Promise<string> {
	const key = path.resolve(cwd);
	const ready = DEFAULT_REPO_RESOLVED.get(key);
	if (ready) return ready;
	let pending = DEFAULT_REPO_INFLIGHT.get(key);
	if (!pending) {
		pending = (async () => {
			// No caller signal: this lookup is shared across every concurrent
			// waiter on the same cwd.
			const value = await resolveRepoFromCwd(cwd);
			DEFAULT_REPO_RESOLVED.set(key, value);
			return value;
		})();
		// Drop the in-flight slot on settle so failures don't poison the cache
		// and so a successful resolution survives only in `DEFAULT_REPO_RESOLVED`.
		void pending.then(
			() => DEFAULT_REPO_INFLIGHT.delete(key),
			() => DEFAULT_REPO_INFLIGHT.delete(key),
		);
		DEFAULT_REPO_INFLIGHT.set(key, pending);
	}
	return untilAborted(signal, pending);
}

/**
 * Best-effort cached cwd → `owner/repo` resolution that swallows any failure
 * (not a git checkout, no GitHub remote, `gh` unauthenticated, …) into
 * `undefined`. Use where the cwd repo is a convenience fallback, not a safety
 * check.
 */
export async function tryResolveCurrentRepo(cwd: string, signal: AbortSignal | undefined): Promise<string | undefined> {
	try {
		return await resolveDefaultRepoMemoized(cwd, signal);
	} catch {
		return undefined;
	}
}

/**
 * Best-effort fresh cwd → `owner/repo` resolution for safety checks that must
 * reflect the repository currently mounted at `cwd`, not the process-lifetime
 * default-repo cache.
 */
export async function tryResolveCurrentRepoFresh(
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	try {
		return await resolveGitHubRepo(cwd, undefined, undefined, signal);
	} catch {
		return undefined;
	}
}

export async function saveArtifactText(
	session: ToolSession,
	toolType: string,
	text: string,
): Promise<string | undefined> {
	const { path: artifactPath, id: artifactId } = (await session.allocateOutputArtifact?.(toolType)) ?? {};
	if (!artifactPath || !artifactId) {
		return undefined;
	}

	await Bun.write(artifactPath, text);
	return artifactId;
}

export function appendArtifactReference(text: string, artifactId: string | undefined, label: string): string {
	if (!artifactId) {
		return text;
	}

	return `${text}\n\n${label}: artifact://${artifactId}`;
}

export function buildTextResult(
	text: string,
	sourceUrl?: string,
	details?: GhToolDetails,
	options?: { artifactId?: string; artifactLabel?: string; useless?: boolean },
): AgentToolResult<GhToolDetails> {
	const builder = toolResult<GhToolDetails>(details).text(
		appendArtifactReference(text, options?.artifactId, options?.artifactLabel ?? "Saved artifact"),
	);
	if (sourceUrl) {
		builder.sourceUrl(sourceUrl);
	}
	if (options?.useless) {
		builder.useless();
	}
	return builder.done();
}
