import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { toolWireSchema, validateToolArguments } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { ToolSession } from "../../tools";
import { ToolError } from "../../tools/tool-errors";
import { schemaDeclaresIntentField } from "../../utils/tool-schema";
import { invokeEvalPrelude } from "../preludes";
import { EVAL_AGENT_BRIDGE_NAME, type EvalAgentHandleResult, runEvalAgent } from "../agent-bridge";
import { EVAL_BUDGET_BRIDGE_NAME, type EvalBudgetResult, runEvalBudget } from "../budget-bridge";
import { EVAL_COMPLETION_BRIDGE_NAME, type EvalCompletionHandleResult, runEvalCompletion } from "../completion-bridge";
import {
	EVAL_CANCEL_BRIDGE_NAME,
	type EvalHandleSnapshot,
	EVAL_STATUS_BRIDGE_NAME,
	EVAL_WAIT_BRIDGE_NAME,
	runEvalCancel,
	runEvalStatus,
	runEvalWait,
} from "../handle-bridge";
import { EVAL_WORKPOOL_BRIDGE_NAME, type EvalWorkpoolResult, runEvalWorkpool } from "../workpool-bridge";
import type { JsStatusEvent } from "./shared/types";

export type { JsStatusEvent } from "./shared/types";

interface ToolBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
	defaultIntent?: string;
}

type ToolValue =
	| string
	| EvalBudgetResult
	| EvalAgentHandleResult
	| EvalCompletionHandleResult
	| EvalHandleSnapshot
	| EvalWorkpoolResult
	| { items: EvalHandleSnapshot[] }
	| { cancelled: boolean }
	| {
			text: string;
			details?: unknown;
			images?: Array<{ mimeType: string; data: string }>;
			hasError?: boolean;
	  };
function toolResultHasError(result: AgentToolResult): boolean {
	if (isRecord(result) && result.isError === true) return true;
	return isRecord(result.details) && result.details.isError === true;
}

function getTool(session: ToolSession, name: string): AgentTool {
	const tool = session.getToolForEvalBridge ? session.getToolForEvalBridge(name) : session.getToolByName?.(name);
	if (!tool) {
		throw new ToolError(`Unknown tool from js runtime: ${name}`);
	}
	return tool;
}

function normalizeArgs(args: unknown, defaultIntent?: string): unknown {
	if (!isRecord(args)) return args;
	const record = { ...args };
	if (defaultIntent !== undefined && !(INTENT_FIELD in record)) {
		record[INTENT_FIELD] = defaultIntent;
	}
	return record;
}

function parsePreludeRequest(args: unknown): { name: string; parameters: unknown } {
	if (!isRecord(args)) throw new ToolError("Invalid eval prelude bridge request");
	const name = args.name;
	if (typeof name !== "string" || name.length === 0) {
		throw new ToolError("Invalid eval prelude bridge name");
	}
	return { name, parameters: args.parameters };
}

function summarizeToolResult(
	name: string,
	args: unknown,
	result: AgentToolResult,
	text: string,
	hasError: boolean,
): JsStatusEvent {
	const record = isRecord(args) ? args : {};
	const details = isRecord(result.details) ? result.details : {};
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

function normalizeAgentToolResult(
	name: string,
	args: unknown,
	result: AgentToolResult,
	options: ToolBridgeOptions,
): ToolValue {
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
	options.emitStatus?.(summarizeToolResult(name, args, result, text, hasError));
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
	if (hasError) value.hasError = true;
	return value;
}

export async function callSessionTool(name: string, args: unknown, options: ToolBridgeOptions): Promise<ToolValue> {
	if (name === "__prelude__") {
		const request = parsePreludeRequest(args);
		const toolCallId = `prelude-${request.name}-${crypto.randomUUID()}`;
		try {
			const result = await invokeEvalPrelude(request.name, request.parameters, {
				session: options.session,
				toolCallId,
				signal: options.signal,
				context: options.session.getToolContext?.(),
			});
			return normalizeAgentToolResult(request.name, request.parameters, result, options);
		} catch (error) {
			options.emitStatus?.({
				op: request.name,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}
	if (name === EVAL_COMPLETION_BRIDGE_NAME) {
		return await runEvalCompletion(args, options);
	}
	if (name === EVAL_AGENT_BRIDGE_NAME) {
		return await runEvalAgent(args, options);
	}
	if (name === EVAL_BUDGET_BRIDGE_NAME) {
		return await runEvalBudget(args, options);
	}
	if (name === EVAL_WAIT_BRIDGE_NAME) {
		return await runEvalWait(args, options);
	}
	if (name === EVAL_STATUS_BRIDGE_NAME) {
		return runEvalStatus(args, options);
	}
	if (name === EVAL_CANCEL_BRIDGE_NAME) {
		return runEvalCancel(args, options);
	}
	if (name === EVAL_WORKPOOL_BRIDGE_NAME) {
		return await runEvalWorkpool(args, options);
	}
	if (name === "checkpoint" || name === "rewind") {
		// The session recognizes checkpoint/rewind only as direct toolResult
		// messages; a bridged call would report success without taking effect.
		throw new ToolError(`\`${name}\` cannot run through the eval bridge; call the direct \`${name}\` tool.`);
	}
	const tool = getTool(options.session, name);
	const toolCallId = `js-${name}-${crypto.randomUUID()}`;
	// A schema-owned name stays tool data across alternatives. Deleting an
	// invalid value to make another branch match could select a different operation.
	const intentIsDeclared = schemaDeclaresIntentField(toolWireSchema(tool));
	const suppliedIntent = isRecord(args) ? args[INTENT_FIELD] : undefined;
	const validationArgs = isRecord(args) ? { ...args } : args;
	if (isRecord(validationArgs) && !intentIsDeclared) delete validationArgs[INTENT_FIELD];
	let validatedArgs: unknown;
	try {
		validatedArgs = validateToolArguments(tool, {
			type: "toolCall",
			id: toolCallId,
			name,
			arguments: validationArgs as Record<string, unknown>,
		});
	} catch (error) {
		if (!tool.lenientArgValidation) {
			options.emitStatus?.({
				op: name,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		if (isRecord(validationArgs)) {
			const fallback = { ...validationArgs };
			delete fallback.__parseError;
			delete fallback.__rawJson;
			validatedArgs = fallback;
		} else {
			validatedArgs = validationArgs;
		}
	}
	if (isRecord(validatedArgs) && !intentIsDeclared && suppliedIntent !== undefined) {
		validatedArgs[INTENT_FIELD] = suppliedIntent;
	}
	const normalizedArgs = normalizeArgs(
		validatedArgs,
		!intentIsDeclared ? (options.defaultIntent ?? "js prelude") : undefined,
	);
	try {
		const result = await tool.execute(
			toolCallId,
			normalizedArgs,
			options.signal,
			undefined,
			options.session.getToolContext?.(),
		);
		return normalizeAgentToolResult(name, normalizedArgs, result, options);
	} catch (error) {
		options.emitStatus?.({
			op: name,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
