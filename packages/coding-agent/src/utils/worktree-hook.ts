/**
 * Runs a new linked worktree's `post-checkout` hook the way `git worktree add`
 * does: git's new-worktree arguments (null old HEAD, new HEAD, branch flag `1`),
 * with the worktree as working directory. Git decides whether a hook exists.
 *
 * A failed or cancelled hook never discards anything; callers keep the worktree
 * and surface {@link formatPostCheckoutHookWarning}. `/wt` runs the hook after moving the
 * session, even for a checkout the session could not move into, and after `worktree.cleanSource`,
 * so an edit saved in the source meanwhile survives. It takes the env before that cleanup, which
 * can delete an untracked `.env` the dotenv filter reads. Once git's hook step has finished (also in
 * a repo without a hook), it rescans the moved session's skills and slash commands, so the session
 * sees the ones the hook added.
 */
import {
	$envAnyCase,
	$which,
	procmgr,
	ptree,
	sanitizeText,
	stripGitRepoLocationEnv,
	WhichCachePolicy,
} from "@oh-my-pi/pi-utils";
import { sanitizeDisplayWarning, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";

/**
 * After a git process exits (the `git version` probe, or `git hook run`), stop waiting on pipes a
 * background process it started still holds. That process gets SIGPIPE on its next write to them.
 */
const HOOK_EXIT_GRACE_MS = 250;
/** Captured output kept per stream; only the last line is ever shown. */
const HOOK_OUTPUT_TAIL_CHARS = 4096;

export interface PostCheckoutHookOptions {
	/**
	 * Run the hook as `git worktree add` does in a terminal: it writes straight to omp's
	 * stdout/stderr (git sends a hook's stdout to stderr) and stays in omp's process group,
	 * so the terminal's Ctrl-C reaches it and a background job it starts keeps writing there.
	 * `signal` is not used, and a failure has an empty `output`. Without this the runner keeps
	 * a bounded tail of the hook's output for the warning.
	 */
	inheritOutput?: boolean;
	/**
	 * Kills the hook's process group on POSIX and its process tree on Windows. A descendant that
	 * `setsid`s into its own session is not reached; git does not reach it either. On Windows,
	 * Git runs hooks through MSYS `sh`, whose child processes have no living Windows parent, so
	 * the tree kill ends git and the call returns, but commands the hook started keep running.
	 * An already-aborted signal skips the hook.
	 */
	signal?: AbortSignal;
	/**
	 * The env to run the hook with, a `procmgr.getChildShellEnv()` result; taken at the call when omitted.
	 */
	env?: Record<string, string>;
}

export type PostCheckoutHookResult =
	| { status: "ok" }
	| { status: "failed"; exitCode: number; output: string }
	| { status: "cancelled" }
	/** Git could not run the hook at all (spawn failure); `message` is git's or the OS's own text. */
	| { status: "error"; message: string }
	/**
	 * No git that can run the hook: none on the hook environment's PATH, one whose `git version`
	 * fails, or one older than 2.36 (no `git hook run`). Nothing ran; `reason` says which.
	 */
	| { status: "unavailable"; reason: string };

function tail(text: string): string {
	return text.length > HOOK_OUTPUT_TAIL_CHARS ? text.slice(-HOOK_OUTPUT_TAIL_CHARS) : text;
}

/**
 * Why this git can't run `git hook run`, or undefined when it can or its version doesn't parse.
 * `git hook run` arrived in git 2.36; a git whose `git version` fails (such as macOS's stub
 * without the Command Line Tools) runs nothing. An abort of `signal` kills the probe and throws.
 */
async function hookRunUnsupportedReason(
	git: string,
	cwd: string,
	env: Record<string, string>,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	const { stdout, ok } = await ptree.exec([git, "version"], {
		cwd,
		env,
		signal,
		allowNonZero: true,
		exitGraceMs: HOOK_EXIT_GRACE_MS,
	});
	if (!ok) return "`git version` failed";
	const match = /^git version (\d+)\.(\d+)/.exec(stdout);
	if (!match) return undefined;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	if (major > 2 || (major === 2 && minor >= 36)) return undefined;
	return `git ${major}.${minor} has no \`git hook run\` (needs 2.36 or newer)`;
}

/** Run `post-checkout` for a worktree just created at `worktreeRoot` whose HEAD is `head`. */
export async function runPostCheckoutHook(
	worktreeRoot: string,
	head: string,
	options: PostCheckoutHookOptions = {},
): Promise<PostCheckoutHookResult> {
	const { signal, inheritOutput } = options;
	if (signal?.aborted) return { status: "cancelled" };
	// Re-stripped: git repository-location vars may have been set after the env was taken.
	const env = options.env ? { ...options.env } : procmgr.getChildShellEnv();
	stripGitRepoLocationEnv(env);
	// Spawn what `$which` resolves (macOS Xcode fallback; a relative PATH entry against the worktree), uncached
	// since each worktree is a new cwd. Env names are case-insensitive only on Windows.
	const git = $which("git", {
		PATH: (process.platform === "win32" ? $envAnyCase("PATH", env) : env.PATH) ?? "",
		cwd: worktreeRoot,
		cache: WhichCachePolicy.Bypass,
	});
	if (!git) return { status: "unavailable", reason: "git executable not found" };
	const argv = [git, "hook", "run", "--ignore-missing", "post-checkout", "--", "0".repeat(head.length), head, "1"];
	try {
		const unsupported = await hookRunUnsupportedReason(git, worktreeRoot, env, signal);
		if (signal?.aborted) return { status: "cancelled" };
		if (unsupported) return { status: "unavailable", reason: unsupported };
		if (inheritOutput) {
			// No pipes for omp to hold or cut: the hook's output and its background jobs behave as under git.
			const child = Bun.spawn(argv, {
				cwd: worktreeRoot,
				env,
				stdin: "ignore",
				stdout: "inherit",
				stderr: "inherit",
			});
			const exitCode = await child.exited;
			return exitCode === 0 ? { status: "ok" } : { status: "failed", exitCode, output: "" };
		}
		const child = ptree.spawn(argv, {
			cwd: worktreeRoot,
			env,
			// Its own process group on POSIX, so an abort kills the whole hook tree; on Windows `detached` only
			// drops the console, and ptree's abort kills the tree natively.
			detached: process.platform !== "win32",
			signal,
			exitGraceMs: HOOK_EXIT_GRACE_MS,
		});
		const result = await child.wait({ allowNonZero: true, allowAbort: true });
		if (result.exitError?.aborted) return { status: "cancelled" };
		if (result.ok) return { status: "ok" };
		return {
			status: "failed",
			exitCode: result.exitCode ?? -1,
			output: `${tail(result.stdout)}\n${tail(result.stderr)}`,
		};
	} catch (error) {
		if (signal?.aborted) return { status: "cancelled" };
		return { status: "error", message: error instanceof Error ? error.message : String(error) };
	}
}

/** One-line, display-ready notice (`Worktree created, but post-checkout hook …`), or undefined when nothing went wrong. */
export function formatPostCheckoutHookWarning(result: PostCheckoutHookResult): string | undefined {
	let text: string;
	switch (result.status) {
		case "ok":
			return undefined;
		// No git that can run hooks: `/wt` shows nothing; `omp worktree add` reports `reason` itself.
		case "unavailable":
			return undefined;
		case "cancelled":
			text = "post-checkout hook cancelled";
			break;
		case "error":
			text = `post-checkout hook could not run: ${result.message}`;
			break;
		case "failed": {
			// A carriage return rewrites the line in place, so only the text after the last one is what the user saw.
			const last = result.output
				.split("\n")
				.map(line => {
					const frame = line.replace(/\r+$/, "");
					return sanitizeText(frame.slice(frame.lastIndexOf("\r") + 1)).trim();
				})
				.filter(Boolean)
				.at(-1);
			text = `post-checkout hook exited with ${result.exitCode}${last ? `: ${last}` : ""}`;
			break;
		}
	}
	return truncateToWidth(sanitizeDisplayWarning(`Worktree created, but ${text}`), TRUNCATE_LENGTHS.LONG);
}
