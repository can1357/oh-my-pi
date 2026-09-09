import { $which } from "@oh-my-pi/pi-utils";
import { REJECT_PROMPT_COMMAND } from "../exec/non-interactive-env";
import { ToolAbortError, ToolError, throwIfAborted } from "../tools/tool-errors";

/** Captured result of a completed `gh` invocation. */
export interface GhCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Options shaping `gh` failure messages and output handling. */
export interface GhCommandOptions {
	/** Caller passed an explicit repo; suppresses "run inside a checkout" hints. */
	repoProvided?: boolean;
	/** Trim captured output (default true). */
	trimOutput?: boolean;
}

/** Deadline for `gh` subprocesses spawned by the coding agent. */
export const GH_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

const GH_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const GH_TRUNCATED_MARKER = "\n[gh subprocess output truncated after 8 MiB]\n";
const GH_NON_INTERACTIVE_ENV = {
	...process.env,
	GIT_ASKPASS: "true",
	GIT_EDITOR: "true",
	GIT_TERMINAL_PROMPT: "0",
	LC_ALL: undefined,
	LC_MESSAGES: "C",
	SSH_ASKPASS: REJECT_PROMPT_COMMAND,
	GH_PROMPT_DISABLED: "1",
};

async function readCappedText(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let captured = 0;
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (captured < GH_OUTPUT_LIMIT_BYTES) {
				const take = Math.min(value.byteLength, GH_OUTPUT_LIMIT_BYTES - captured);
				if (take > 0) chunks.push(value.subarray(0, take));
				captured += take;
			}
		}
	} finally {
		reader.releaseLock();
	}
	const text = Buffer.concat(chunks).toString("utf8");
	return total > GH_OUTPUT_LIMIT_BYTES ? `${text}${GH_TRUNCATED_MARKER}` : text;
}

function formatGhFailure(args: readonly string[], stdout: string, stderr: string, options?: GhCommandOptions): string {
	const message = (stderr || stdout).trim();
	if (message.includes("gh auth login") || message.includes("not logged into any GitHub hosts")) {
		return "GitHub CLI is not authenticated. Run `gh auth login`.";
	}
	if (
		!options?.repoProvided &&
		(message.includes("not a git repository") ||
			message.includes("no git remotes found") ||
			message.includes("unable to determine current repository"))
	) {
		return "GitHub repository context is unavailable. Pass `repo` explicitly or run the tool inside a GitHub checkout.";
	}
	if (message) return message;
	return `GitHub CLI command failed: gh ${args.join(" ")}`;
}

/** The sanctioned `gh` CLI runner: non-interactive env, bounded capture, deadline. */
export const github = {
	/** Check if the `gh` CLI is installed. */
	available(): boolean {
		return Boolean($which("gh"));
	},

	/** Run a raw `gh` CLI command. Does not throw on non-zero exit. */
	async run(cwd: string, args: string[], signal?: AbortSignal, options?: GhCommandOptions): Promise<GhCommandResult> {
		throwIfAborted(signal);
		if (!$which("gh")) {
			throw new ToolError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/.");
		}
		const timeoutSignal = AbortSignal.timeout(GH_COMMAND_TIMEOUT_MS);
		const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		try {
			const child = Bun.spawn(["gh", ...args], {
				cwd,
				env: GH_NON_INTERACTIVE_ENV,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
				signal: combinedSignal,
			});
			if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
				throw new ToolError("Failed to capture GitHub CLI output.");
			}
			const [stdout, stderr, exitCode] = await Promise.all([
				readCappedText(child.stdout),
				readCappedText(child.stderr),
				child.exited,
			]);
			throwIfAborted(signal);
			const trim = options?.trimOutput !== false;
			return {
				exitCode: exitCode ?? 0,
				stdout: trim ? stdout.trim() : stdout,
				stderr: trim ? stderr.trim() : stderr,
			};
		} catch (error) {
			if (signal?.aborted) throw new ToolAbortError();
			if (timeoutSignal.aborted) throw new ToolError(`GitHub CLI command timed out: gh ${args.join(" ")}`);
			throw error;
		}
	},

	/** Run `gh` and parse stdout as JSON. Throws on non-zero exit or invalid JSON. */
	async json<T>(cwd: string, args: string[], signal?: AbortSignal, options?: GhCommandOptions): Promise<T> {
		const result = await github.run(cwd, args, signal, options);
		if (result.exitCode !== 0) throw new ToolError(formatGhFailure(args, result.stdout, result.stderr, options));
		if (!result.stdout) throw new ToolError("GitHub CLI returned empty output.");
		try {
			return JSON.parse(result.stdout) as T;
		} catch {
			throw new ToolError("GitHub CLI returned invalid JSON output.");
		}
	},

	/** Run `gh` and return stdout as text. Throws on non-zero exit. */
	async text(cwd: string, args: string[], signal?: AbortSignal, options?: GhCommandOptions): Promise<string> {
		const result = await github.run(cwd, args, signal, options);
		if (result.exitCode !== 0) throw new ToolError(formatGhFailure(args, result.stdout, result.stderr, options));
		return result.stdout;
	},
};
