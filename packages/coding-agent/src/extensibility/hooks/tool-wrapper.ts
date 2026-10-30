/**
 * Tool wrapper - wraps tools with hook callbacks for interception.
 */
import {
	type AgentTool,
	type AgentToolContext,
	type AgentToolUpdateCallback,
	isNonBlankContext,
} from "@oh-my-pi/pi-agent-core";
import type { Static, TSchema } from "@oh-my-pi/pi-ai";
import { normalizeToolEventInput, resolveToolEventInput } from "../tool-event-input";
import { applyToolProxy } from "../tool-proxy";
import type { HookRunner } from "./runner";
import type { ToolCallEventResult, ToolResultEventResult } from "./types";

/**
 * Wraps an AgentTool with hook callbacks for interception.
 *
 * Features:
 * - Emits tool_call event before execution (can block)
 * - Emits tool_result event after execution (can modify result)
 * - Forwards onUpdate callback to wrapped tool for progress streaming
 */
export class HookToolWrapper<TParameters extends TSchema = TSchema, TDetails = unknown> implements AgentTool<
	TParameters,
	TDetails
> {
	declare name: string;
	declare description: string;
	declare parameters: TParameters;
	declare label: string;
	declare strict: boolean;

	constructor(
		private tool: AgentTool<TParameters, TDetails>,
		private hookRunner: HookRunner,
	) {
		applyToolProxy(tool, this);
	}

	async execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
		context?: AgentToolContext,
	) {
		// Emit tool_call event - hooks can block execution or revise the input the tool runs with.
		// If hook errors/times out, block by default (fail-safe)
		let effectiveParams = params;
		// Forwarded only after the tool returns a non-error result, matching the
		// extension wrapper and the agent loop.
		let pendingAdditionalContext: string | undefined;
		if (this.hookRunner.hasHandlers("tool_call")) {
			try {
				const callResult = (await this.hookRunner.emitToolCall({
					type: "tool_call",
					toolName: this.tool.name,
					toolCallId,
					input: normalizeToolEventInput(
						this.tool.name,
						resolveToolEventInput(this.tool, params as Record<string, unknown>),
					),
				})) as ToolCallEventResult | undefined;

				if (callResult?.block) {
					const reason = callResult.reason || "Tool execution was blocked by a hook";
					throw new Error(reason);
				}
				if (isNonBlankContext(callResult?.additionalContext)) {
					pendingAdditionalContext = callResult.additionalContext;
				}
				// A non-blocking handler may replace the execution input. The returned object is the raw
				// input the tool runs with (handler-owned); it is not re-normalized. Skipped for `computer`
				// tool calls, whose real parameters are not represented by the event input.
				if (callResult?.input !== undefined && context?.toolCall?.providerMetadata?.type !== "computer") {
					effectiveParams = callResult.input as Static<TParameters>;
				}
			} catch (err) {
				// Hook error or block - throw to mark as error
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Hook failed, blocking execution: ${String(err)}`);
			}
		}

		// Execute the actual tool, forwarding onUpdate for progress streaming
		try {
			const result = await this.tool.execute(toolCallId, effectiveParams, signal, onUpdate, context);

			// Emit tool_result event - hooks can modify the result
			let resultResult: ToolResultEventResult | undefined;
			if (this.hookRunner.hasHandlers("tool_result")) {
				resultResult = (await this.hookRunner.emit({
					type: "tool_result",
					toolName: this.tool.name,
					toolCallId,
					input: normalizeToolEventInput(
						this.tool.name,
						resolveToolEventInput(this.tool, effectiveParams as Record<string, unknown>),
					),
					content: result.content,
					details: result.details,
					isError: result.isError === true,
				})) as ToolResultEventResult | undefined;
				// tool_result context precedes the call's tool_call context, as in the agent loop.
				if (isNonBlankContext(resultResult?.additionalContext)) {
					context?.addAdditionalContext?.(resultResult.additionalContext);
				}
			}
			if (result.isError !== true && pendingAdditionalContext !== undefined) {
				context?.addAdditionalContext?.(pendingAdditionalContext);
			}

			// Apply modifications if any
			if (resultResult?.content !== undefined || resultResult?.details !== undefined) {
				return {
					content: resultResult.content ?? result.content,
					details: (resultResult.details ?? result.details) as TDetails,
					// A patch rewrites what the model sees; it never turns a failed call into a success.
					...(result.isError === true ? { isError: true } : {}),
				};
			}

			return result;
		} catch (err) {
			// Emit tool_result event for errors so hooks can observe failures and
			// attach failure-specific context; the result itself stays the error.
			if (this.hookRunner.hasHandlers("tool_result")) {
				const failure = (await this.hookRunner.emit({
					type: "tool_result",
					toolName: this.tool.name,
					toolCallId,
					input: normalizeToolEventInput(
						this.tool.name,
						resolveToolEventInput(this.tool, effectiveParams as Record<string, unknown>),
					),
					content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
					details: undefined,
					isError: true,
				})) as ToolResultEventResult | undefined;
				if (isNonBlankContext(failure?.additionalContext)) {
					context?.addAdditionalContext?.(failure.additionalContext);
				}
			}
			throw err; // Re-throw original error for agent-loop
		}
	}
}
