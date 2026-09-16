import { $which, isRecord, ptree } from "@oh-my-pi/pi-utils";
import { REJECT_PROMPT_COMMAND } from "../exec/non-interactive-env";
import { ToolAbortError, ToolError, throwIfAborted } from "../tools/tool-errors";

/** Captured result of a completed `gh` invocation. */
export interface GhCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * A host a caller has resolved for one `gh` request, lowercased.
 *
 * The runner will not guess which instance a request is bound for: argv,
 * `GH_HOST` and the checkout's remotes are all things `gh` itself interprets,
 * and a wrong guess would hand a github.com credential to another host.
 * `ghAuthHost` is the only way to obtain this type, so every value the runner
 * sees was normalized in one place from a repository the caller had already
 * resolved.
 */
export type GhAuthHost = string & { readonly __ghAuthHost: unique symbol };

/** The host whose workstation credentials the runner is willing to acquire. */
const GH_PROBE_HOST = "github.com";

/** Normalize a resolved host into request auth metadata. */
export function ghAuthHost(host: string): GhAuthHost {
	return host.toLowerCase() as GhAuthHost;
}

/** Options shaping `gh` failure messages and output handling. */
export interface GhCommandOptions {
	/** Caller passed an explicit repo; suppresses "run inside a checkout" hints. */
	repoProvided?: boolean;
	/** Trim captured output (default true). */
	trimOutput?: boolean;
	/**
	 * Host this request targets. Supplying `github.com` lets the runner acquire
	 * a credential for the child when the environment carries none; omitting it
	 * runs `gh` on the ambient environment alone.
	 */
	authHost?: GhAuthHost;
}

/** Deadline for `gh` subprocesses spawned by the coding agent. */
export const GH_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

const GH_AUTH_TOKEN_TIMEOUT_MS = 10_000;
/** No credential approaches this; output that does is not one. */
const GH_AUTH_TOKEN_OUTPUT_LIMIT_BYTES = 64 * 1024;
const GH_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const GH_TRUNCATED_MARKER = "\n[gh subprocess output truncated after 8 MiB]\n";
function nonInteractiveEnv(): Record<string, string | undefined> {
	return {
		...process.env,
		GIT_ASKPASS: "true",
		GIT_EDITOR: "true",
		GIT_TERMINAL_PROMPT: "0",
		LC_ALL: undefined,
		LC_MESSAGES: "C",
		SSH_ASKPASS: REJECT_PROMPT_COMMAND,
		GH_PROMPT_DISABLED: "1",
	};
}

async function readCappedText(
	stream: ReadableStream<Uint8Array>,
	limit = GH_OUTPUT_LIMIT_BYTES,
	marker = GH_TRUNCATED_MARKER,
): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let captured = 0;
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (captured < limit) {
				const take = Math.min(value.byteLength, limit - captured);
				if (take > 0) chunks.push(value.subarray(0, take));
				captured += take;
			}
		}
	} finally {
		reader.releaseLock();
	}
	const text = Buffer.concat(chunks).toString("utf8");
	return total > limit ? `${text}${marker}` : text;
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

function describeGitHubApiError(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (!isRecord(value)) return undefined;
	if (typeof value.message === "string") return value.message.trim() || undefined;

	const resource = typeof value.resource === "string" ? value.resource.trim() : "";
	const field = typeof value.field === "string" ? value.field.trim() : "";
	const target = [resource, field].filter(Boolean).join(".");
	const code = typeof value.code === "string" ? value.code.trim() : "";
	if (target && code) return `${target}: ${code}`;
	return target || code || undefined;
}

function parseGitHubApiErrorMessages(stdout: string): string[] {
	let payload: unknown;
	try {
		payload = JSON.parse(stdout);
	} catch {
		return [];
	}
	if (!isRecord(payload)) return [];

	const messages = new Set<string>();
	const summary = describeGitHubApiError(payload.message);
	if (summary) messages.add(summary);
	if (Array.isArray(payload.errors)) {
		for (const error of payload.errors) {
			const message = describeGitHubApiError(error);
			if (message) messages.add(message);
		}
	}
	return [...messages];
}

function formatGhJsonFailure(
	args: readonly string[],
	stdout: string,
	stderr: string,
	options?: GhCommandOptions,
): string {
	const rawMessage = (stderr || stdout).trim();
	const fallback = formatGhFailure(args, stdout, stderr, options);
	if (fallback !== rawMessage) return fallback;
	const details = parseGitHubApiErrorMessages(stdout).filter(message => !fallback.includes(message));
	if (details.length === 0) return fallback;
	return `${fallback}\nGitHub details:\n${details.map(message => `- ${message}`).join("\n")}`;
}

/**
 * The whole of a probe's stdout as one credential, or nothing.
 *
 * At most one ordinary line terminator is removed; what remains must be
 * non-empty and consist entirely of visible ASCII (U+0021 through U+007E).
 * Padding, a blank line, a second line, a bare carriage return, a Unicode line
 * separator: none of those come out of `gh auth token`, and picking the
 * credential out of them would be guesswork.
 *
 * Rejecting whitespace alone was not enough. NUL, the C0/C1 controls, DEL and
 * U+FFFD are not whitespace, so they were accepted and then handed to a child
 * as an environment value — where a NUL truncates the variable and the rest
 * either corrupts the environment or fails the spawn, after the credential
 * decision was already made. U+FFFD is the specific hazard on this path,
 * because it is exactly what invalid UTF-8 on the pipe decodes to, so a probe
 * emitting raw bytes could otherwise mint a "token" out of mojibake.
 *
 * Deliberately the visible-ASCII range rather than a GitHub token grammar:
 * `gh auth token` hands back whatever credential it holds for this host, across
 * token types that have changed shape more than once, and no published charset
 * covers all of them stably. Refusing a legitimate credential is its own
 * failure, while this range already excludes every byte class that can corrupt
 * an environment or a spawn.
 *
 * Written as an explicit test on the code units rather than an anchored regex,
 * because whether `$` and `\s` cover a given terminator is exactly the subtlety
 * a credential decision should not rest on. The size bound is enforced while
 * the output is captured, so it is not rechecked here.
 */
function probeToken(stdout: string): string | undefined {
	const body = stdout.endsWith("\r\n") ? stdout.slice(0, -2) : stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
	if (body === "") return undefined;
	for (let index = 0; index < body.length; index++) {
		const code = body.charCodeAt(index);
		// Also refuses every non-ASCII code unit, lone surrogates included: a
		// surrogate half reads above 0x7e here rather than needing its own case.
		if (code < 0x21 || code > 0x7e) return undefined;
	}
	return body;
}

/**
 * Read the workstation's github.com credential out of `gh` itself.
 *
 * The result is a credential, so the probe is deliberately unforgiving: one
 * whole token on stdout, a clean exit, nothing on stderr, inside a short
 * deadline, under a size bound. Anything else — an oversized read, a second
 * line, a prompt, a warning, a non-zero exit — fails closed with a message
 * that repeats none of the streams, because the token would be in them.
 *
 * It runs under `ptree`, which owns the isolation this probe needs (see
 * `config/resolve-config-value`). A credential helper that forks background work
 * must not outlive the deadline. A descendant still holding the pipes must not
 * stall the read past it. The deadline and the output cap bound this probe on
 * every platform: both cut the pipe drains, so the probe fails closed. Cleanup
 * reaches what the helper forked only where ownership is provable: a live root's
 * own tree, the Linux subreaper, or the retained root identity on Windows. On
 * macOS, and on Linux without the subreaper, a descendant that changes session or
 * outlives the root keeps running, because `ptree` signals no group id it cannot
 * prove is this probe's.
 */
async function acquireGitHubToken(signal?: AbortSignal): Promise<string> {
	try {
		const probe = await ptree.exec(["gh", "auth", "token", "--hostname", GH_PROBE_HOST], {
			// An ambient token would be echoed straight back instead of the
			// credential `gh` holds for this host.
			env: { ...nonInteractiveEnv(), GH_TOKEN: undefined, GITHUB_TOKEN: undefined },
			timeout: GH_AUTH_TOKEN_TIMEOUT_MS,
			maxOutputBytes: GH_AUTH_TOKEN_OUTPUT_LIMIT_BYTES,
			signal,
			detached: true,
			subreaper: process.platform === "linux",
			allowNonZero: true,
			allowAbort: true,
		});
		throwIfAborted(signal);
		const token = probeToken(probe.stdout);
		// `ok` reads the root's exit code alone, and a root can exit zero while
		// the deadline or the output cap is already terminating its tree — a
		// token from a command that was stopped is not an answer.
		if (!probe.ok || probe.exitError || probe.stderr !== "" || token === undefined) {
			throw new Error("gh auth probe returned an unusable result");
		}
		return token;
	} catch (error) {
		if (signal?.aborted) throw new ToolAbortError();
		if (error instanceof ToolError) throw error;
		throw new ToolError("GitHub CLI authentication is unavailable. Run `gh auth login`.");
	}
}

/**
 * The environment for one `gh` child.
 *
 * A credential is acquired only for github.com, only when the caller stated
 * that host, and only when the environment carries no token for that host.
 * `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` are not such a token —
 * they authenticate an enterprise instance — so they are forwarded untouched
 * without standing in for a github.com credential. The acquired token is
 * injected into this child's environment and nowhere else: it is never cached,
 * so a later request probes again and concurrent requests cannot see each
 * other's value.
 */
async function childEnvironment(
	authHost: GhAuthHost | undefined,
	signal?: AbortSignal,
): Promise<Record<string, string | undefined>> {
	const env = nonInteractiveEnv();
	if (authHost !== GH_PROBE_HOST) return env;
	if (env.GH_TOKEN || env.GITHUB_TOKEN) return env;
	return { ...env, GH_TOKEN: undefined, GITHUB_TOKEN: await acquireGitHubToken(signal) };
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
				env: await childEnvironment(options?.authHost, signal),
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
		if (result.exitCode !== 0) {
			throw new ToolError(formatGhJsonFailure(args, result.stdout, result.stderr, options));
		}
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
