/** Runs a new linked worktree's `post-checkout` hook as `git worktree add` does. */
import { $envAnyCase, $which, postmortem, ptree, WhichCachePolicy } from "@oh-my-pi/pi-utils";
import {
	sanitizeDisplayLines,
	sanitizeDisplayWarning,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "@oh-my-pi/pi-tui/render/render-utils";

/**
 * After a git process or the hook exits, stop waiting on pipes a background process it started still holds.
 * That process gets SIGPIPE on its next write to them.
 */
const HOOK_EXIT_GRACE_MS = 250;

interface PostCheckoutHookOptions {
	/**
	 * Kills the hook's process group on POSIX and its process tree on Windows. A descendant that `setsid`s
	 * into its own session is not reached; git does not reach it either. On Windows,
	 * Git runs hooks through MSYS `sh`, whose child processes have no living Windows parent, so
	 * the tree kill ends git and the call returns, but commands the hook started keep running.
	 * An already-aborted signal skips the hook.
	 */
	signal?: AbortSignal;
	/** The hook's env. */
	env: Record<string, string>;
}

type PostCheckoutHookResult =
	| { status: "ok" }
	/** `lastLine`: the last line the hook printed, as a terminal showed it. */
	| { status: "failed"; exitCode: number; lastLine?: string }
	| { status: "cancelled" }
	/** Git could not run the hook at all (spawn failure); `message` is git's or the OS's own text. */
	| { status: "error"; message: string }
	/** No git that can run `git hook run`: none on the hook env's PATH, `git --version` fails, or older than 2.36. */
	| { status: "unavailable"; reason: string };

/** True when this `git --version` output is older than 2.36, which added `git hook run`; false when it doesn't parse. */
function predatesHookRun(version: string): boolean {
	const match = /^git version (\d+)\.(\d+)/.exec(version);
	if (!match) return false;
	const major = Number(match[1]);
	return major < 2 || (major === 2 && Number(match[2]) < 36);
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
	const { signal, env } = options;
	if (signal?.aborted) return { status: "cancelled" };
	// `$which` falls back to macOS's Xcode git and resolves a relative PATH entry against the worktree, as a
	// bare spawn there would. Env names are case-insensitive only on Windows.
	const git = $which("git", {
		PATH: (process.platform === "win32" ? $envAnyCase("PATH", env) : env.PATH) ?? "",
		cwd: worktreeRoot,
		cache: WhichCachePolicy.Bypass,
	});
	if (!git) return { status: "unavailable", reason: "git executable not found" };
	// omp exiting ends the hook as a cancel does: a detached hook would otherwise outlive omp and keep writing
	// into the worktree. The exit waits until the kill has landed (the tree kill runs off the JS thread).
	const exiting = new AbortController();
	const finished = Promise.withResolvers<void>();
	const unregisterExit = postmortem.register("post-checkout-hook", () => {
		exiting.abort();
		return finished.promise;
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
		const version = await ptree.exec([git, "--version"], execOptions);
		if (hookSignal.aborted) return { status: "cancelled" };
		// Such as macOS's stub git without the Command Line Tools.
		if (!version.ok) return { status: "unavailable", reason: "`git --version` failed" };
		if (predatesHookRun(version.stdout)) return { status: "unavailable", reason: "git older than 2.36" };
		// Git's new-worktree arguments: a null old HEAD, the new HEAD, and the branch-checkout flag.
		const args = ["0".repeat(head.length), head, "1"];
		// On Windows `detached` only drops the console; ptree's abort kills the tree natively there.
		const result = await ptree.exec([git, "hook", "run", "--ignore-missing", "post-checkout", "--", ...args], {
			...execOptions,
			detached: process.platform !== "win32",
		});
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
		// No git that can run hooks: `/wt` shows nothing, as before it ran the hook.
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
