import { $which, isRecord } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { FORGE_NON_INTERACTIVE_ENV, type ForgeCliResult, type ForgeCliSpec, runForgeCli } from "./forge-cli";

/** Options shaping `gh` failure messages and output handling. */
export interface GhCommandOptions {
	/** Caller passed an explicit repo; suppresses "run inside a checkout" hints. */
	repoProvided?: boolean;
	/** Trim captured output (default true). */
	trimOutput?: boolean;
}

/** Deadline for `gh` subprocesses spawned by the coding agent. */
export const GH_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

const GH_SPEC: ForgeCliSpec = {
	bin: "gh",
	displayName: "GitHub CLI",
	installMessage: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/.",
	env: { ...FORGE_NON_INTERACTIVE_ENV, GH_PROMPT_DISABLED: "1" },
	timeoutMs: GH_COMMAND_TIMEOUT_MS,
};

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

/** The sanctioned `gh` CLI runner: non-interactive env, bounded capture, deadline. */
export const github = {
	/** Check if the `gh` CLI is installed. */
	available(): boolean {
		return Boolean($which("gh"));
	},

	/** Run a raw `gh` CLI command. Does not throw on non-zero exit. */
	run(cwd: string, args: string[], signal?: AbortSignal, options?: GhCommandOptions): Promise<ForgeCliResult> {
		return runForgeCli(GH_SPEC, cwd, args, signal, options?.trimOutput !== false);
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
