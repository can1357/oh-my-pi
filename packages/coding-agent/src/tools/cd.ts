import * as fs from "node:fs/promises";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import cdDescription from "../prompts/tools/cd.md" with { type: "text" };
import type { ToolSession } from ".";
import { normalizePathLikeInput, resolveToCwd } from "./path-utils";

/** Message text of a thrown value. */
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const cdSchema = type({
	path: type("string").describe("directory to work in from now on"),
	"+": "reject",
});

export interface CdToolDetails {
	/** Absolute directory the session now reports as its cwd. */
	cwd: string;
	previousCwd: string;
}

/**
 * Changes the session's working directory. The move is the session's own, not
 * a shell variable: it relocates the session file and artifacts, the process
 * cwd, and every cwd-derived scope (project settings, memory, title prompt,
 * skills), so a later `read`, `bash`, or subagent inherits it without a `cd`
 * prefix.
 */
export class CdTool implements AgentTool<typeof cdSchema, CdToolDetails> {
	readonly name = "cd";
	readonly label = "Change directory";
	readonly summary = "Change the session's working directory";
	readonly description = cdDescription.trim();
	readonly parameters = cdSchema;
	readonly strict = true;
	readonly approval = "read" as const;
	readonly loadMode = "essential" as const;
	readonly intent = "omit" as const;
	/** Two cwd changes in one batch would each roll the other's cwd back. */
	readonly concurrency = "exclusive" as const;

	constructor(private readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: typeof cdSchema.infer): Promise<AgentToolResult<CdToolDetails>> {
		const previousCwd = this.session.cwd;
		const raw = normalizePathLikeInput(params.path);
		if (raw.length === 0) return failure("A directory path is required.", previousCwd);
		const change = this.session.changeWorkingDirectory;
		if (!change) return failure("This host cannot change the session's working directory.", previousCwd);

		let target: string;
		try {
			target = resolveToCwd(raw, previousCwd);
		} catch (error) {
			return failure(errorMessage(error), previousCwd);
		}
		try {
			const stat = await fs.stat(target);
			if (!stat.isDirectory()) return failure(`Not a directory: ${target}`, previousCwd);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return failure(`No such directory: ${target}`, previousCwd);
			if (code === "EACCES") return failure(`Cannot read directory: ${target}`, previousCwd);
			return failure(errorMessage(error), previousCwd);
		}

		try {
			await change(target);
		} catch (error) {
			return failure(errorMessage(error), previousCwd);
		}
		const cwd = this.session.cwd;
		return {
			content: [{ type: "text", text: `Working directory: ${cwd}` }],
			details: { cwd, previousCwd },
		};
	}
}

function failure(message: string, previousCwd: string): AgentToolResult<CdToolDetails> {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { cwd: previousCwd, previousCwd },
	};
}
