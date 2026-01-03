/**
 * Custom command types.
 *
 * Custom commands are TypeScript modules that define executable slash commands.
 * Unlike markdown commands which expand to prompts, custom commands can execute
 * arbitrary logic with full access to the hook context.
 */

import type { ExecOptions, ExecResult, HookCommandContext } from "../hooks/types.js";

// Re-export for custom commands to use
export type { ExecOptions, ExecResult, HookCommandContext };

/**
 * API passed to custom command factory.
 * Similar to HookAPI but focused on command needs.
 */
export interface CustomCommandAPI {
	/** Current working directory */
	cwd: string;
	/** Execute a shell command */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
	/** Injected @sinclair/typebox module */
	typebox: typeof import("@sinclair/typebox");
	/** Injected pi-coding-agent exports */
	pi: typeof import("../../index.js");
}

/**
 * Custom command definition.
 *
 * Commands can either:
 * - Return a string to be sent to the LLM as a prompt
 * - Return void/undefined to do nothing (fire-and-forget)
 *
 * @example
 * ```typescript
 * const factory: CustomCommandFactory = (pi) => ({
 *	  name: "deploy",
 *	  description: "Deploy current branch to staging",
 *	  async execute(args, ctx) {
 *		 const env = args[0] || "staging";
 *		 const confirmed = await ctx.ui.confirm("Deploy", `Deploy to ${env}?`);
 *		 if (!confirmed) return;
 *
 *		 const result = await pi.exec("./deploy.sh", [env]);
 *		 if (result.exitCode !== 0) {
 *			ctx.ui.notify(`Deploy failed: ${result.stderr}`, "error");
 *			return;
 *		 }
 *
 *		 ctx.ui.notify("Deploy successful!", "info");
 *		 // No return = no prompt sent to LLM
 *	  }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Return a prompt to send to the LLM
 * const factory: CustomCommandFactory = (pi) => ({
 *	  name: "git:status",
 *	  description: "Show git status and suggest actions",
 *	  async execute(args, ctx) {
 *		 const result = await pi.exec("git", ["status", "--porcelain"]);
 *		 return `Here's the git status:\n\`\`\`\n${result.stdout}\`\`\`\nSuggest what to do next.`;
 *	  }
 * });
 * ```
 */
export interface CustomCommand {
	/** Command name (can include namespace like "git:commit") */
	name: string;
	/** Description shown in command autocomplete */
	description: string;
	/**
	 * Execute the command.
	 * @param args - Parsed command arguments
	 * @param ctx - Command context with UI and session control
	 * @returns String to send as prompt, or void for fire-and-forget
	 */
	execute(args: string[], ctx: HookCommandContext): Promise<string | undefined> | string | undefined;
}

/**
 * Factory function that creates custom command(s).
 * Can return a single command or an array of commands.
 */
export type CustomCommandFactory = (
	api: CustomCommandAPI,
) => CustomCommand | CustomCommand[] | Promise<CustomCommand | CustomCommand[]>;

/** Source of a loaded custom command */
export type CustomCommandSource = "user" | "project";

/** Loaded custom command with metadata */
export interface LoadedCustomCommand {
	/** Original path to the command module */
	path: string;
	/** Resolved absolute path */
	resolvedPath: string;
	/** The command definition */
	command: CustomCommand;
	/** Where the command was loaded from */
	source: CustomCommandSource;
}

/** Result from loading custom commands */
export interface CustomCommandsLoadResult {
	commands: LoadedCustomCommand[];
	errors: Array<{ path: string; error: string }>;
}
