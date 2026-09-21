import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { toolWireSchema, validateToolArguments } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { ToolSession } from "../../tools";
import { committedTodoPhases } from "../../tools/todo";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { schemaDeclaresIntentField } from "../../utils/tool-schema";
import { findEnabledEvalPrelude, invokeEvalPrelude } from "../preludes";
import { EVAL_AGENT_BRIDGE_NAME, type EvalAgentHandleResult, runEvalAgent } from "../agent-bridge";
import { EVAL_BUDGET_BRIDGE_NAME, type EvalBudgetResult, runEvalBudget } from "../budget-bridge";
import { withBridgeTimeoutPause } from "../bridge-timeout";
import { EVAL_COMPLETION_BRIDGE_NAME, type EvalCompletionHandleResult, runEvalCompletion } from "../completion-bridge";
import {
	EVAL_JUDGMENT_BATCH_BRIDGE_NAME,
	type EvalJudgmentBatchResult,
	runEvalJudgmentBatch,
} from "../judgment-batch-bridge";
import { EVAL_JUDGMENT_BRIDGE_NAME, type EvalJudgmentResult, runEvalJudgment } from "../judgment-bridge";
import {
	EVAL_CANCEL_BRIDGE_NAME,
	type EvalHandleSnapshot,
	EVAL_STATUS_BRIDGE_NAME,
	EVAL_WAIT_BRIDGE_NAME,
	runEvalCancel,
	runEvalStatus,
	runEvalWait,
} from "../handle-bridge";
import type { EvalShadowCellSession } from "../speculation/cell-session";
import { getActiveEvalShadowCell } from "../speculation/runtime-context";
import { EVAL_WORKPOOL_BRIDGE_NAME, type EvalWorkpoolResult, runEvalWorkpool } from "../workpool-bridge";
import type { RuntimeCallIdentity } from "./shared/runtime";
import type { JsStatusEvent } from "./shared/types";

export type { JsStatusEvent } from "./shared/types";

export interface ToolBridgeOptions {
	session: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
	defaultIntent?: string;
	identity?: RuntimeCallIdentity;
	shadowCell?: EvalShadowCellSession;
}

type ToolValue =
	| string
	| EvalBudgetResult
	| EvalAgentHandleResult
	| EvalCompletionHandleResult
	| EvalJudgmentResult
	| EvalJudgmentBatchResult
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

/** Builds the status event recorded for one bridged host call; `undefined` records nothing. */
type StatusSummarizer = (
	name: string,
	args: unknown,
	result: AgentToolResult,
	text: string,
	hasError: boolean,
) => JsStatusEvent | undefined;

const summarizeToolResult: StatusSummarizer = (name, args, result, text, hasError) => {
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
};

/**
 * Prelude calls (browser, computer) describe themselves: a bare op name with a
 * byte count is noise, so a prelude without a `status` hook records nothing on
 * success. Failures always surface.
 */
function summarizePreludeResult(session: ToolSession): StatusSummarizer {
	return (name, args, result, text, hasError) => {
		if (hasError) return { op: name, error: text.slice(0, 500) };
		const detail = findEnabledEvalPrelude(session, name)?.status?.(args, result);
		return detail === undefined ? undefined : { op: name, detail };
	};
}

export function bridgeValueFromToolResult(
	name: string,
	args: unknown,
	result: AgentToolResult,
	emitStatus?: (event: JsStatusEvent) => void,
	summarize: StatusSummarizer = summarizeToolResult,
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
	if (emitStatus) {
		const event = summarize(name, args, result, text, hasError);
		if (event) emitStatus(event);
	}
	if (result.details === undefined && imageBlocks.length === 0 && !hasError) return text;
	const value: Exclude<ToolValue, string> = { text, details: result.details };
	if (imageBlocks.length > 0) {
		value.images = imageBlocks.map(block => ({ mimeType: block.mimeType, data: block.data }));
	}
	if (hasError) value.hasError = true;
	return value;
}

function waitForSpeculativeClaim<T>(claim: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return claim;
	signal.throwIfAborted();
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	let onAbort: () => void = () => {};
	const finish = (settle: () => void): void => {
		if (settled) return;
		settled = true;
		signal.removeEventListener("abort", onAbort);
		settle();
	};
	onAbort = (): void =>
		finish(() => reject(signal.reason ?? new DOMException("Speculative claim was interrupted", "AbortError")));
	signal.addEventListener("abort", onAbort, { once: true });
	void claim.then(
		value => finish(() => resolve(value)),
		error => finish(() => reject(error)),
	);
	return promise;
}

export async function callSessionTool(name: string, args: unknown, options: ToolBridgeOptions): Promise<ToolValue> {
	if (name === "__prelude__") {
		const request = parsePreludeRequest(args);
		const toolCallId = `prelude-${request.name}-${crypto.randomUUID()}`;
		try {
			// Browser/computer operations own their deadlines. Charging their host
			// wait to Eval as well can kill its kernel during a first-use browser
			// install or an explicitly longer navigation. Caller abort still flows
			// through; only the runtime-work watchdog is paused.
			const result = await withBridgeTimeoutPause(options.emitStatus, () =>
				invokeEvalPrelude(request.name, request.parameters, {
					session: options.session,
					toolCallId,
					signal: options.signal,
					context: options.session.getToolContext?.(),
				}),
			);
			return bridgeValueFromToolResult(
				request.name,
				request.parameters,
				result,
				options.emitStatus,
				summarizePreludeResult(options.session),
			);
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
	if (name === EVAL_JUDGMENT_BRIDGE_NAME) {
		return await runEvalJudgment(args, options);
	}
	if (name === EVAL_JUDGMENT_BATCH_BRIDGE_NAME) {
		return await runEvalJudgmentBatch(args, options);
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
	const shadowCell = options.shadowCell ?? getActiveEvalShadowCell();
	if (shadowCell && options.identity) {
		const claimed = await waitForSpeculativeClaim(
			shadowCell.claim(name, normalizedArgs, options.identity, Number.MAX_SAFE_INTEGER, options.signal),
			options.signal,
		);
		options.signal?.throwIfAborted();
		if (claimed) return bridgeValueFromToolResult(name, normalizedArgs, claimed, options.emitStatus);
	}
	try {
		const result = await tool.execute(
			toolCallId,
			normalizedArgs,
			options.signal,
			undefined,
			options.session.getToolContext?.(),
		);
		if (name === "todo") {
			// A bridged call emits no `todo` toolResult entry, the only thing branch
			// rehydration reads; without this the in-memory update is lost on the
			// next resume/rewind/fork and stale todos trigger a false reminder.
			const phases = committedTodoPhases(result);
			if (phases) options.session.persistTodoPhases?.(phases);
		}
		return bridgeValueFromToolResult(name, normalizedArgs, result, options.emitStatus);
	} catch (error) {
		options.emitStatus?.({
			op: name,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
