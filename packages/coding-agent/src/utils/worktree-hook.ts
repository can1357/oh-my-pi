/** Runs a new linked worktree's `post-checkout` hook as `git worktree add` does. Git decides whether a hook exists. */
import { $envAnyCase, $which, postmortem, ptree, WhichCachePolicy } from "@oh-my-pi/pi-utils";
import {
	sanitizeDisplayLines,
	sanitizeDisplayWarning,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "@oh-my-pi/pi-tui/render/render-utils";

/**
 * After a git process exits (the `git version` probe, or `git hook run`), stop waiting on pipes a
 * background process it started still holds. That process gets SIGPIPE on its next write to them.
 */
const HOOK_EXIT_GRACE_MS = 250;

interface PostCheckoutHookOptions {
	/**
	 * Run as `git worktree add` does in a terminal: output goes straight to omp's stdout/stderr (git sends a
	 * hook's stdout to stderr) and the hook stays in omp's process group, so the terminal's Ctrl-C reaches it and
	 * a background job it starts keeps writing there. Neither `signal` nor omp's exit reaches the hook.
	 */
	inheritOutput?: boolean;
	/**
	 * Kills the hook's process group on POSIX and its process tree on Windows. A descendant that `setsid`s
	 * into its own session is not reached; git does not reach it either. On Windows,
	 * Git runs hooks through MSYS `sh`, whose child processes have no living Windows parent, so
	 * the tree kill ends git and the call returns, but commands the hook started keep running.
	 * An already-aborted signal skips the hook.
	 */
	signal?: AbortSignal;
	/** The hook's env; each caller names its own. */
	env: Record<string, string>;
}

type PostCheckoutHookResult =
	| { status: "ok" }
	/** `lastLine`: the last line the hook printed, as a terminal showed it; none with `inheritOutput`. */
	| { status: "failed"; exitCode: number; lastLine?: string }
	| { status: "cancelled" }
	/** Git could not run the hook at all (spawn failure); `message` is git's or the OS's own text. */
	| { status: "error"; message: string }
	/** No git that can run `git hook run`: none on the hook env's PATH, `git version` fails, or older than 2.36. */
	| { status: "unavailable"; reason: string };

/**
 * Why the git behind this `git version` result can't run `git hook run`, or undefined when it can or its version
 * doesn't parse. `git hook run` arrived in git 2.36; a git whose `git version` fails (such as macOS's stub
 * without the Command Line Tools) runs nothing.
 */
function hookRunUnsupportedReason({ ok, stdout }: ptree.ExecResult): string | undefined {
	if (!ok) return "`git version` failed";
	const match = /^git version (\d+)\.(\d+)/.exec(stdout);
	if (!match) return undefined;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	if (major > 2 || (major === 2 && minor >= 36)) return undefined;
	return `git ${major}.${minor} has no \`git hook run\` (needs 2.36 or newer)`;
}

/** The last non-empty line of `output` as a terminal shows it; a trailing carriage return leaves its frame on screen. */
function lastLine(output: string): string | undefined {
	return sanitizeDisplayLines(output.replace(/\r+(?=\n|$)/g, ""))
		.map(line => line.trim())
		.findLast(Boolean);
}

export async function runPostCheckoutHook(
	worktreeRoot: string,
	head: string,
	options: PostCheckoutHookOptions,
): Promise<PostCheckoutHookResult> {
	const { signal, inheritOutput, env } = options;
	if (signal?.aborted) return { status: "cancelled" };
	// `$which` falls back to macOS's Xcode git and resolves a relative PATH entry against the worktree, as a
	// bare spawn there would. Env names are case-insensitive only on Windows.
	const git = $which("git", {
		PATH: (process.platform === "win32" ? $envAnyCase("PATH", env) : env.PATH) ?? "",
		cwd: worktreeRoot,
		cache: WhichCachePolicy.Bypass,
	});
	if (!git) return { status: "unavailable", reason: "git executable not found" };
	// Git's new-worktree arguments: a null old HEAD, the new HEAD, and the branch-checkout flag.
	const argv = [git, "hook", "run", "--ignore-missing", "post-checkout", "--", "0".repeat(head.length), head, "1"];
	// omp exiting ends the hook as a cancel does: a detached hook would otherwise outlive omp and keep writing
	// into the worktree. The exit waits until the kill has landed (the tree kill runs off the JS thread); a hook
	// with inherited output stays in omp's process group and is not killed, so the exit doesn't wait for it.
	const exiting = new AbortController();
	const finished = Promise.withResolvers<void>();
	const unregisterExit = postmortem.register("post-checkout-hook", () => {
		exiting.abort();
		return inheritOutput ? undefined : finished.promise;
	});
	const hookSignal = signal ? AbortSignal.any([signal, exiting.signal]) : exiting.signal;
	const execOptions = {
		cwd: worktreeRoot,
		env,
		signal: hookSignal,
		exitGraceMs: HOOK_EXIT_GRACE_MS,
		allowNonZero: true,
	};
	try {
		const unsupported = hookRunUnsupportedReason(await ptree.exec([git, "version"], execOptions));
		if (hookSignal.aborted) return { status: "cancelled" };
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
			return exitCode === 0 ? { status: "ok" } : { status: "failed", exitCode };
		}
		// On Windows `detached` only drops the console; ptree's abort kills the tree natively there.
		const result = await ptree.exec(argv, { ...execOptions, detached: process.platform !== "win32" });
		if (result.ok) return { status: "ok" };
		return {
			status: "failed",
			exitCode: result.exitCode ?? -1,
			lastLine: lastLine(`${result.stdout}\n${result.stderr}`),
		};
	} catch (error) {
		if (hookSignal.aborted) return { status: "cancelled" };
		return { status: "error", message: error instanceof Error ? error.message : String(error) };
	} finally {
		unregisterExit();
		finished.resolve();
	}
}

/** One-line, display-ready notice (`Worktree created, but post-checkout hook …`), or undefined when nothing went wrong. */
export function formatPostCheckoutHookWarning(result: PostCheckoutHookResult): string | undefined {
	let text: string;
	switch (result.status) {
		// No git that can run hooks: `/wt` shows nothing; `omp worktree add` reports `reason` itself.
		case "ok":
		case "unavailable":
			return undefined;
		case "cancelled":
			text = "post-checkout hook cancelled";
			break;
		case "error":
			text = `post-checkout hook could not run: ${result.message}`;
			break;
		case "failed":
			text = `post-checkout hook exited with ${result.exitCode}${result.lastLine ? `: ${result.lastLine}` : ""}`;
			break;
	}
	return truncateToWidth(sanitizeDisplayWarning(`Worktree created, but ${text}`), TRUNCATE_LENGTHS.LONG);
}
