/**
 * Detect cache-mutating `gh` subcommands inside a bash invocation and drop
 * the matching `github-cache` rows so a subsequent `issue://<n>` or
 * `pr://<n>` read sees the post-mutation state instead of the stale
 * pre-mutation snapshot.
 *
 * Triggered before the bash command runs: on success the cache is now
 * empty and the next read fetches fresh; on failure the worst case is one
 * extra `gh` round-trip on the following read. That cost is bounded and
 * eliminates the much-worse "issue shows OPEN for up to softTtlSec after
 * `gh issue close`" failure mode reported by users.
 *
 * Plain `git push` calls are handled after the command exits 0 instead, once
 * their destination repository can be resolved (`invalidateGithubCacheForBashResult`).
 *
 * Detector scope: ops that change visible issue/PR state — `close`,
 * `reopen`, `merge`, `delete`, `ready`, `lock`, `unlock`, `pin`, `unpin`,
 * `transfer`, plus the comment/review/edit ops that change the rendered
 * body. We deliberately over-invalidate (e.g. all matching rows for the
 * number, all auth_keys) because the upside of staleness elimination
 * dwarfs the cost of one cache miss.
 */
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { logger } from "@oh-my-pi/pi-utils";
import { parseGitUrl } from "../extensibility/plugins/git-url";
import { formatRepoRef } from "./gh-common";
import { invalidateAllForNumber, invalidateAllForRepo, invalidatePullRequestsForRepo } from "./github-cache";
import { tokenizeShellSegments } from "./shell-tokenize";

const PR_URL_PATTERN = /^https:\/\/([^/\s]+)\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const ISSUE_URL_PATTERN = /^https:\/\/([^/\s]+)\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)(?:[/?#].*)?$/i;

/** Subcommands that mutate the rendered issue/PR view in any meaningful way. */
const MUTATING_ISSUE_SUBCMDS: Record<string, true> = {
	close: true,
	reopen: true,
	delete: true,
	edit: true,
	comment: true,
	lock: true,
	unlock: true,
	pin: true,
	unpin: true,
	transfer: true,
	develop: true,
};

const MUTATING_PR_SUBCMDS: Record<string, true> = {
	close: true,
	reopen: true,
	merge: true,
	ready: true,
	edit: true,
	comment: true,
	review: true,
	lock: true,
	unlock: true,
};

/**
 * Flags whose value is the next argv token (`--milestone 3`). The detector
 * must skip those values so `gh pr edit --milestone 3 14` invalidates #14,
 * not #3. Curated for the mutating issue/PR subcommands above; a few short
 * flags are booleans for *some* subcommands (e.g. `-c` is `--comment` text
 * for `pr close` but a boolean for `pr review`) — we bias toward value-taking
 * because over-skipping at worst falls back to repo-wide invalidation, while
 * under-skipping invalidates the wrong number.
 */
const VALUE_TAKING_FLAGS: ReadonlySet<string> = new Set([
	"-m",
	"--milestone",
	"-t",
	"--title",
	"-b",
	"--body",
	"-F",
	"--body-file",
	"-a",
	"--assignee",
	"--add-assignee",
	"--remove-assignee",
	"-l",
	"--label",
	"--add-label",
	"--remove-label",
	"-p",
	"--project",
	"--add-project",
	"--remove-project",
	"--add-reviewer",
	"--remove-reviewer",
	"-B",
	"--base",
	"-c",
	"--comment",
	"-r",
	"--reason",
	"--branch",
	"--subject",
	"--match-head-commit",
	"--author-email",
]);
/**
 * Walk a single shell command's token stream looking for a top-level
 * `gh (issue|pr) <subcmd> [<id-or-url>]` invocation and return the
 * invalidation key when one is found. `number === undefined` means the
 * subcommand mutates state but names no identifier (gh defaults to the
 * current branch's PR), so the caller must fall back to repo-wide
 * invalidation. Returns `null` for non-matching commands so the caller can
 * iterate cheaply.
 */
function detectGhMutation(tokens: readonly string[]): { number?: number; repo?: string } | null {
	const ghIdx = tokens.indexOf("gh");
	if (ghIdx === -1) return null;
	const subject = tokens[ghIdx + 1];
	if (subject !== "issue" && subject !== "pr") return null;
	const subcmd = tokens[ghIdx + 2];
	if (!subcmd) return null;
	const expected = subject === "issue" ? MUTATING_ISSUE_SUBCMDS : MUTATING_PR_SUBCMDS;
	if (!expected[subcmd]) return null;

	let repo: string | undefined;
	// First pass: scan for --repo so it wins regardless of position relative
	// to the issue/PR identifier (gh accepts the flag both before and after
	// the positional argument).
	for (let i = ghIdx + 3; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "-R" || token === "--repo") {
			const next = tokens[i + 1];
			if (next) repo = next;
			i++;
			continue;
		}
		if (token.startsWith("--repo=")) {
			repo = token.slice("--repo=".length);
		}
	}
	for (let i = ghIdx + 3; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "-R" || token === "--repo" || VALUE_TAKING_FLAGS.has(token)) {
			// Skip the flag's value so it is never mistaken for the positional
			// identifier (`--milestone 3 14` must invalidate #14, not #3).
			i++;
			continue;
		}
		if (token.startsWith("-")) continue;
		const direct = /^\d+$/.test(token) ? Number(token) : undefined;
		if (direct !== undefined && Number.isSafeInteger(direct) && direct > 0) {
			return repo !== undefined ? { number: direct, repo } : { number: direct };
		}
		const urlMatch = (subject === "pr" ? PR_URL_PATTERN : ISSUE_URL_PATTERN).exec(token);
		if (urlMatch) {
			const num = Number(urlMatch[3]);
			if (Number.isSafeInteger(num) && num > 0) {
				// URL carries its own repo and wins over a stray --repo flag.
				return { number: num, repo: formatRepoRef(urlMatch[1], urlMatch[2]) };
			}
		}
	}
	// Mutating subcommand with no identifier: gh operates on the current
	// branch's PR, which we cannot resolve synchronously here.
	return repo !== undefined ? { repo } : {};
}

/**
 * Drop `github-cache` rows for any `gh issue|pr <mutating-subcmd>` call
 * embedded in `command`. Safe to invoke unconditionally; no-op when the
 * command does not touch GitHub state.
 */
export function invalidateGithubCacheForBashCommand(command: string): void {
	if (!command?.includes("gh")) return;
	const segments = tokenizeShellSegments(command);
	for (const segment of segments) {
		const hit = detectGhMutation(segment);
		if (!hit) continue;
		if (hit.number !== undefined) {
			invalidateAllForNumber(hit.number, hit.repo);
		} else {
			invalidateAllForRepo(hit.repo);
		}
	}
}

/** Options of `git push` that consume the next argv token. */
const PUSH_VALUE_FLAGS: Record<string, true> = {
	"--receive-pack": true,
	"--exec": true,
	"-o": true,
	"--push-option": true,
};

/** A redirection word (`2>&1` lexes as `2>`, `>/dev/null`) ends the argv. */
const REDIRECT = /^\d*[<>]/;

/** Repository a `git push` argv sends to, or undefined for dry runs and non-push commands. */
async function pushedRepo(tokens: readonly string[], cwd: string): Promise<string | undefined> {
	if (path.basename(tokens[0]) !== "git") return undefined;
	let i = 1;
	for (; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "-C") cwd = path.resolve(cwd, tokens[++i] ?? "");
		else if (token.startsWith("-C")) cwd = path.resolve(cwd, token.slice(2));
		else if (token !== "--no-pager" && token !== "--paginate") break;
	}
	if (tokens[i] !== "push") return undefined;
	let positional: string | undefined;
	let repoFlag: string | undefined;
	for (i++; i < tokens.length && !REDIRECT.test(tokens[i]); i++) {
		const token = tokens[i];
		if (token === "--dry-run" || /^-[^-]*n/.test(token)) return undefined;
		if (token === "--repo") repoFlag = tokens[++i];
		else if (token.startsWith("--repo=")) repoFlag = token.slice("--repo=".length);
		else if (PUSH_VALUE_FLAGS[token]) i++;
		else if (token === "--") {
			positional ??= tokens[i + 1];
			break;
		} else if (!token.startsWith("-")) positional ??= token;
	}
	// Git's precedence: the positional repository wins over `--repo`.
	let remote = positional ?? repoFlag;
	const repository = vcs.git(cwd);
	if (!remote) {
		if (!repository) return undefined;
		const branch = await repository.currentBranch();
		remote =
			(branch && (await repository.configGet(`branch.${branch}.pushRemote`))) ||
			(await repository.configGet("remote.pushDefault")) ||
			(branch && (await repository.configGet(`branch.${branch}.remote`))) ||
			undefined;
		if (!remote) {
			const remotes = await repository.remoteList();
			remote = remotes.length === 1 ? remotes[0] : "origin";
		}
	}
	const url =
		(await repository?.configGet(`remote.${remote}.pushurl`)) ?? (await repository?.remoteUrl(remote)) ?? remote;
	const source = parseGitUrl(url);
	return source ? formatRepoRef(source.host, source.path) : undefined;
}

/**
 * After a bash command exits 0, drop live PR metadata/diff rows for every
 * repository a `git push` in it sent to. Like the `gh` detector this
 * over-invalidates (a push hidden behind `|| true` still clears): a spurious
 * clear costs one refetch, a missed one serves the old head until the TTL.
 */
export async function invalidateGithubCacheForBashResult(
	command: string,
	cwd: string,
	result: { exitCode?: number },
): Promise<void> {
	if (result.exitCode !== 0 || !command.includes("push")) return;
	for (const tokens of tokenizeShellSegments(command)) {
		try {
			const repo = await pushedRepo(tokens, cwd);
			if (repo) invalidatePullRequestsForRepo(repo);
		} catch (err) {
			logger.debug("github cache: push destination lookup failed", { err: String(err) });
		}
	}
}
