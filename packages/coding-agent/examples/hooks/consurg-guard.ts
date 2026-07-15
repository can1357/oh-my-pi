/**
 * Consurg Guard Hook (prototype)
 *
 * Enforces a Context Surgeon scope at the tool layer. When the session runs
 * under `consurg wrap -- omp ...` (or a `consurg guard` is active in the
 * project), every supported file or command tool call is evaluated against the
 * scope before it executes. Blocked calls return a structured denial the
 * model can reason about, mirroring consurg's hooks/enforce_guard.py.
 *
 * Decision path:
 *   1. `CONSURG_GUARD_PORT` env (set by `consurg wrap`) or `.consurg-guard.lock`
 *      in the workspace -> POST http://127.0.0.1:<port>/evaluate
 *   2. Guard unreachable -> fail open (log once) so a dead guard cannot brick
 *      the session. Harden to fail-closed by setting CONSURG_FAIL_CLOSED=1.
 *
 * Usage:
 *   consurg init sub-task && consurg add "src/feature/*.ts"
 *   consurg wrap -- omp --hook examples/hooks/consurg-guard.ts "do the task"
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookAPI } from "@pk-nerdsaver-ai/pi-coding-agent";

const READ_TOOLS: Record<string, true> = {
	read: true,
	grep: true,
	search: true,
	glob: true,
	find: true,
	ls: true,
	ast_grep: true,
	context_oracle: true,
	inspect_image: true,
	generate_image: true,
};
const WRITE_TOOLS: Record<string, true> = {
	write: true,
	edit: true,
	multi_edit: true,
	ast_edit: true,
};
const COMMAND_TOOLS: Record<string, true> = { bash: true };

const LOCKFILE_NAME = ".consurg-guard.lock";

interface GuardDecision {
	decision?: string;
	message?: string;
	tier?: number;
}

interface PathTargets {
	paths: string[];
	inspectable: boolean;
}

function isFailClosed(): boolean {
	return process.env.CONSURG_FAIL_CLOSED === "1";
}

function addPathValue(value: unknown, paths: string[]): boolean {
	if (typeof value !== "string" || value.length === 0) return false;
	paths.push(value);
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function pathTargets(toolName: string, input: Record<string, unknown>): PathTargets {
	const paths: string[] = [];
	let hasTarget = false;
	let inspectable = true;

	for (const key of ["path", "file_path", "filePath", "file", "scope"] as const) {
		if (!(key in input)) continue;
		hasTarget = true;
		if (key === "scope" && input[key] === "*") paths.push(".");
		else if (!addPathValue(input[key], paths)) inspectable = false;
	}

	if ("paths" in input) {
		hasTarget = true;
		const value = input.paths;
		if (typeof value === "string") {
			if (value.length > 0) paths.push(value);
			else inspectable = false;
		} else if (
			Array.isArray(value) &&
			value.length > 0 &&
			value.every(path => typeof path === "string" && path.length > 0)
		) {
			paths.push(...value);
		} else {
			inspectable = false;
		}
	}

	for (const key of ["rename", "move", "moveDest"] as const) {
		if (!(key in input)) continue;
		hasTarget = true;
		if (!addPathValue(input[key], paths)) inspectable = false;
	}

	if (toolName === "lsp" && input.action === "rename_file" && "new_name" in input) {
		hasTarget = true;
		if (!addPathValue(input.new_name, paths)) inspectable = false;
	}

	if ("edits" in input && Array.isArray(input.edits)) {
		for (const edit of input.edits) {
			if (!isRecord(edit)) continue;
			for (const key of ["rename", "move", "moveDest"] as const) {
				if (!(key in edit)) continue;
				hasTarget = true;
				if (!addPathValue(edit[key], paths)) inspectable = false;
			}
		}
	}

	if ("input" in input && Array.isArray(input.input)) {
		for (const source of input.input) {
			if (!isRecord(source) || !("path" in source)) continue;
			hasTarget = true;
			if (!addPathValue(source.path, paths)) inspectable = false;
		}
	}

	for (const value of [input.input, input._input]) {
		if (typeof value !== "string") continue;
		for (const line of value.split(/\r?\n/u)) {
			const trimmed = line.trim();
			const hashlineHeader = /^\[(.+?)#[0-9a-fA-F]{4}\]$/u.exec(trimmed);
			const applyPatchSource = /^\*{3}\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/u.exec(trimmed);
			const applyPatchDestination = /^\*{3}\s+Move to:\s*(.+?)\s*$/u.exec(trimmed);
			const hashlineMove = /^MV\s+(.+)$/u.exec(trimmed);
			for (const match of [hashlineHeader, applyPatchSource, applyPatchDestination, hashlineMove]) {
				if (!match) continue;
				hasTarget = true;
				if (!addPathValue(match[1], paths)) inspectable = false;
			}
		}
	}

	return {
		paths: [...new Set(paths)],
		inspectable: hasTarget && inspectable && paths.length > 0,
	};
}

function blockedUninspectable(reason: string): { block: true; reason: string } {
	return { block: true, reason };
}

function isTargetedInput(input: Record<string, unknown>): boolean {
	return [
		"path",
		"file_path",
		"filePath",
		"file",
		"scope",
		"paths",
		"rename",
		"move",
		"moveDest",
		"edits",
		"input",
	].some(key => key in input);
}
function isWorkspaceSearchInput(toolName: string, input: Record<string, unknown>): boolean {
	if (toolName !== "grep" && toolName !== "search") return false;
	if (!("paths" in input)) return !isTargetedInput(input);
	if ("path" in input || "file_path" in input || "filePath" in input) return false;
	const value = input.paths;
	return value === "" || (Array.isArray(value) && value.length === 0);
}

function isWorkspaceOracleInput(toolName: string, input: Record<string, unknown>): boolean {
	if (toolName !== "context_oracle") return false;
	// Unscoped or empty-scoped oracle calls (ask/symbol/editImpact) read
	// workspace-wide. Malformed non-string targets are NOT workspace calls;
	// they stay uninspectable so fail-closed mode still blocks them.
	for (const key of ["path", "file_path", "filePath", "file", "scope", "paths"] as const) {
		if (!(key in input)) continue;
		const value = input[key];
		if (value === "" || (Array.isArray(value) && value.length === 0)) continue;
		return false;
	}
	return true;
}

function guardPort(cwd: string): number | null {
	const fromEnv = Number(process.env.CONSURG_GUARD_PORT ?? "");
	if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
	const lockPath = join(cwd, LOCKFILE_NAME);
	if (!existsSync(lockPath)) return null;
	try {
		const data = JSON.parse(readFileSync(lockPath, "utf-8"));
		const port = Number(data?.port);
		return Number.isInteger(port) && port > 0 ? port : null;
	} catch {
		return null;
	}
}

async function evaluate(port: number, toolName: string, body: Record<string, unknown>): Promise<GuardDecision | null> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/evaluate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tool_name: toolName, ...body }),
			signal: AbortSignal.timeout(9_000),
		});
		if (!response.ok) return null;
		const payload: unknown = await response.json();
		if (!isRecord(payload)) return null;
		return {
			decision: typeof payload.decision === "string" ? payload.decision : undefined,
			message: typeof payload.message === "string" ? payload.message : undefined,
			tier: typeof payload.tier === "number" ? payload.tier : undefined,
		};
	} catch {
		return null;
	}
}

export default function (pi: HookAPI) {
	let warnedUnreachable = false;

	pi.on("tool_call", async (event, ctx) => {
		const isRead = READ_TOOLS[event.toolName] === true;
		const isWrite = WRITE_TOOLS[event.toolName] === true;
		const isCommand = COMMAND_TOOLS[event.toolName] === true;
		const failClosed = isFailClosed();
		const cwd = ctx.cwd;
		const port = guardPort(cwd);

		if (port === null) {
			// No guard: only enforce when a session explicitly declared one.
			if (process.env.CONSURG_ACTIVE === "1" && failClosed) {
				return blockedUninspectable("Consurg guard expected (CONSURG_ACTIVE=1) but not reachable");
			}
			return undefined;
		}

		if (isCommand) {
			const command = event.input.command;
			if (typeof command !== "string" || command.length === 0) {
				if (failClosed) {
					return blockedUninspectable("Consurg guard cannot inspect this command (fail-closed mode)");
				}
				return undefined;
			}

			const result = await evaluate(port, event.toolName, {
				tool_input: event.input,
				file_path: "",
				request_type: "command",
				command,
			});
			if (result === null) {
				if (failClosed) return blockedUninspectable("Consurg guard unreachable (fail-closed mode)");
				if (!warnedUnreachable && ctx.hasUI) {
					ctx.ui.notify("Consurg guard unreachable — scope not enforced", "warning");
					warnedUnreachable = true;
				}
				return undefined;
			}
			if (result.decision === "allow") return undefined;
			return {
				block: true,
				reason:
					result.message ??
					`[CONTEXT SURGEON] Blocked by scope (tier ${result.tier ?? 0}). ` +
						"State which file you need and why; the user will decide.",
			};
		}

		let targets = pathTargets(event.toolName, event.input);
		if (isWorkspaceSearchInput(event.toolName, event.input)) {
			targets = { paths: ["."], inspectable: true };
		} else if (isWorkspaceOracleInput(event.toolName, event.input)) {
			// Evaluate workspace-wide oracle reads against the workspace root
			// instead of letting them bypass scope enforcement.
			targets = { paths: ["."], inspectable: true };
		}
		if (!targets.inspectable) {
			if (failClosed && (isRead || isWrite || isTargetedInput(event.input))) {
				return blockedUninspectable("Consurg guard cannot inspect this targeted call (fail-closed mode)");
			}
			return undefined;
		}

		for (const target of targets.paths) {
			const result = await evaluate(port, event.toolName, {
				tool_input: event.input,
				file_path: target,
				request_type: "file",
			});

			if (result === null) {
				if (failClosed) {
					return blockedUninspectable("Consurg guard unreachable (fail-closed mode)");
				}
				if (!warnedUnreachable && ctx.hasUI) {
					ctx.ui.notify("Consurg guard unreachable — scope not enforced", "warning");
					warnedUnreachable = true;
				}
				return undefined;
			}
			if (result.decision !== "allow") {
				return {
					block: true,
					reason:
						result.message ??
						`[CONTEXT SURGEON] Blocked by scope (tier ${result.tier ?? 0}). ` +
							"State which file you need and why; the user will decide.",
				};
			}
		}

		return undefined;
	});
}
