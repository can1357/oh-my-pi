import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { ToolSession } from "../../tools";
import { ToolError } from "../../tools/tool-errors";
import { EVAL_AGENT_BRIDGE_NAME, runEvalAgent } from "../agent-bridge";
import { EVAL_BUDGET_BRIDGE_NAME, type EvalBudgetResult, runEvalBudget } from "../budget-bridge";
import { EVAL_COMPLETION_BRIDGE_NAME, runEvalCompletion } from "../completion-bridge";
import { EVAL_CONCURRENCY_BRIDGE_NAME, type EvalConcurrencyResult, runEvalConcurrency } from "../concurrency-bridge";
import type { JsStatusEvent } from "./shared/types";

export type { JsStatusEvent } from "./shared/types";

interface ToolBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

type ToolValue =
	| string
	| EvalBudgetResult
	| EvalConcurrencyResult
	| {
			text: string;
			details?: unknown;
			images?: Array<{ mimeType: string; data: string }>;
			hasError?: boolean;
	  };
function toolResultHasError(result: AgentToolResult): boolean {
	if ((result as { isError?: unknown }).isError === true) {
		return true;
	}
	if (!(result.details && typeof result.details === "object")) {
		return false;
	}
	return (result.details as { isError?: unknown }).isError === true;
}

function getTool(session: ToolSession, name: string): AgentTool {
	const tool = session.getToolForEvalBridge ? session.getToolForEvalBridge(name) : session.getToolByName?.(name);
	if (!tool) {
		throw new ToolError(`Unknown tool from js runtime: ${name}`);
	}
	return tool;
}

function normalizeArgs(args: unknown): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return args;
	}
	const record = { ...(args as Record<string, unknown>) };
	if (record[INTENT_FIELD] === undefined) {
		record[INTENT_FIELD] = "js prelude";
	}
	return record;
}

function summarizeToolResult(
	name: string,
	args: unknown,
	result: AgentToolResult,
	text: string,
	hasError: boolean,
): JsStatusEvent {
	const record = (args && typeof args === "object" ? (args as Record<string, unknown>) : {}) as Record<
		string,
		unknown
	>;
	const details = (
		result.details && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {}
	) as Record<string, unknown>;
	const withError = (event: JsStatusEvent): JsStatusEvent =>
		hasError ? { ...event, hasError: true, error: text.slice(0, 500) } : event;

	switch (name) {
		case "read":
			return withError({ op: "read", path: record.path, chars: text.length, preview: text.slice(0, 500) });
		case "write":
			return withError({
				op: "write",
				path: record.path,
				chars: typeof record.content === "string" ? record.content.length : 0,
			});
		case "grep":
			return withError({
				op: "grep",
				pattern: record.pattern,
				path: record.path,
				count: details.matchCount ?? undefined,
			});
		case "glob":
			return withError({
				op: "glob",
				pattern: record.pattern,
				count: details.fileCount ?? undefined,
				matches: Array.isArray(details.files) ? details.files.slice(0, 20) : undefined,
			});
		case "bash":
			return withError({
				op: "run",
				cmd: record.command,
				code: typeof details.exitCode === "number" ? details.exitCode : undefined,
				output: text.slice(0, 500),
			});
		default:
			return withError({ op: name, chars: text.length });
	}
}

export async function callSessionTool(name: string, args: unknown, options: ToolBridgeOptions): Promise<ToolValue> {
	if (name === EVAL_COMPLETION_BRIDGE_NAME) {
		return await runEvalCompletion(args, options);
	}
	if (name === EVAL_AGENT_BRIDGE_NAME) {
		return await runEvalAgent(args, options);
	}
	if (name === EVAL_BUDGET_BRIDGE_NAME) {
		return await runEvalBudget(args, options);
	}
	if (name === EVAL_CONCURRENCY_BRIDGE_NAME) {
		return runEvalConcurrency(args, options);
	}
	if (name === "checkpoint" || name === "rewind") {
		// The session recognizes checkpoint/rewind only as direct toolResult
		// messages; a bridged call would report success without taking effect.
		throw new ToolError(`\`${name}\` cannot run through the eval bridge; call the direct \`${name}\` tool.`);
	}
	const tool = getTool(options.session, name);
	const normalizedArgs = normalizeArgs(args);
	const toolCallId = `js-${name}-${crypto.randomUUID()}`;
	try {
		const result = await tool.execute(
			toolCallId,
			normalizedArgs,
			options.signal,
			undefined,
			options.session.getToolContext?.(),
		);
		const textBlocks = result.content.filter(
			(content): content is { type: "text"; text: string } =>
				content.type === "text" && typeof content.text === "string",
		);
		const imageBlocks = result.content.filter(
			(content): content is { type: "image"; mimeType: string; data: string } =>
				content.type === "image" && typeof content.mimeType === "string" && typeof content.data === "string",
		);
		const text = textBlocks.map(block => block.text).join("");
		const hasError = toolResultHasError(result);
		options.emitStatus?.(summarizeToolResult(name, normalizedArgs, result, text, hasError));
		if (result.details === undefined && imageBlocks.length === 0 && !hasError) {
			return text;
		}
		const value: Exclude<ToolValue, string> = {
			text,
			details: result.details,
		};
		if (imageBlocks.length > 0) {
			value.images = imageBlocks.map(block => ({
				mimeType: block.mimeType,
				data: block.data,
			}));
		}
		if (hasError) {
			value.hasError = true;
		}
		return value;
	} catch (error) {
		options.emitStatus?.({
			op: name,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
