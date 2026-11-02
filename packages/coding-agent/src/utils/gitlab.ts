import { $which } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { FORGE_NON_INTERACTIVE_ENV, type ForgeCliResult, type ForgeCliSpec, runForgeCli } from "./forge-cli";

/** Options shaping `glab` output handling. */
export interface GlabCommandOptions {
	/** Trim captured output (default true). */
	trimOutput?: boolean;
}

const GLAB_SPEC: ForgeCliSpec = {
	bin: "glab",
	displayName: "GitLab CLI",
	installMessage: "GitLab CLI (glab) is not installed. Install it from https://gitlab.com/gitlab-org/cli.",
	env: { ...FORGE_NON_INTERACTIVE_ENV, GLAB_NO_PROMPT: "1", GLAB_CHECK_UPDATE: "false", NO_COLOR: "1" },
	timeoutMs: 5 * 60 * 1000,
};

function formatGlabFailure(args: readonly string[], stdout: string, stderr: string): string {
	const message = (stderr || stdout).trim();
	if (
		message.includes("glab auth login") ||
		message.includes("401 Unauthorized") ||
		message.includes("has not been authenticated")
	) {
		return "GitLab CLI is not authenticated. Run `glab auth login`.";
	}
	if (message) return message;
	return `GitLab CLI command failed: glab ${args.join(" ")}`;
}

/** The sanctioned `glab` CLI runner: non-interactive env, bounded capture, deadline. */
export const gitlab = {
	/** Check if the `glab` CLI is installed. */
	available(): boolean {
		return Boolean($which("glab"));
	},

	/** Run a raw `glab` CLI command. Does not throw on non-zero exit. */
	run(cwd: string, args: string[], signal?: AbortSignal, options?: GlabCommandOptions): Promise<ForgeCliResult> {
		return runForgeCli(GLAB_SPEC, cwd, args, signal, options?.trimOutput !== false);
	},

	/** Run `glab` and parse stdout as JSON. Throws on non-zero exit or invalid JSON. */
	async json<T>(cwd: string, args: string[], signal?: AbortSignal): Promise<T> {
		const result = await gitlab.run(cwd, args, signal);
		if (result.exitCode !== 0) throw new ToolError(formatGlabFailure(args, result.stdout, result.stderr));
		if (!result.stdout) throw new ToolError("GitLab CLI returned empty output.");
		try {
			return JSON.parse(result.stdout) as T;
		} catch {
			throw new ToolError("GitLab CLI returned invalid JSON output.");
		}
	},

	/** Run `glab` and return stdout as text. Throws on non-zero exit. */
	async text(cwd: string, args: string[], signal?: AbortSignal, options?: GlabCommandOptions): Promise<string> {
		const result = await gitlab.run(cwd, args, signal, options);
		if (result.exitCode !== 0) throw new ToolError(formatGlabFailure(args, result.stdout, result.stderr));
		return result.stdout;
	},
};
