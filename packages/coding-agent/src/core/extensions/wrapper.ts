/**
 * Tool wrappers for extensions.
 */

import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { AgentTool, AgentToolContext, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Theme } from "../../modes/interactive/theme/theme";
import type { ExtensionRunner } from "./runner";
import type { ExtensionContext, RegisteredTool, ToolCallEventResult, ToolResultEventResult } from "./types";

/**
 * Wrap a RegisteredTool into an AgentTool.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, getContext: () => ExtensionContext): AgentTool {
	const { definition } = registeredTool;
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		execute: (toolCallId, params, signal, onUpdate) =>
			definition.execute(toolCallId, params, onUpdate, getContext(), signal),
		renderCall: definition.renderCall ? (args, theme) => definition.renderCall?.(args, theme as Theme) : undefined,
		renderResult: definition.renderResult
			? (result, options, theme) =>
					definition.renderResult?.(
						result,
						{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
						theme as Theme
					)
			: undefined,
	};
}

/**
 * Wrap all registered tools into AgentTools.
 */
export function wrapRegisteredTools(
	registeredTools: RegisteredTool[],
	getContext: () => ExtensionContext
): AgentTool[] {
	return registeredTools.map((rt) => wrapRegisteredTool(rt, getContext));
}

/**
 * Wrap a tool with extension callbacks for interception.
 * - Emits tool_call event before execution (can block)
 * - Emits tool_result event after execution (can modify result)
 */
export function wrapToolWithExtensions<T>(tool: AgentTool<any, T>, runner: ExtensionRunner): AgentTool<any, T> {
	return {
		...tool,
		execute: async (
			toolCallId: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback<T>,
			context?: AgentToolContext
		) => {
			// Emit tool_call event - extensions can block execution
			if (runner.hasHandlers("tool_call")) {
				try {
					const callResult = (await runner.emitToolCall({
						type: "tool_call",
						toolName: tool.name,
						toolCallId,
						input: params,
					})) as ToolCallEventResult | undefined;

					if (callResult?.block) {
						const reason = callResult.reason || "Tool execution was blocked by an extension";
						throw new Error(reason);
					}
				} catch (err) {
					if (err instanceof Error) {
						throw err;
					}
					throw new Error(`Extension failed, blocking execution: ${String(err)}`);
				}
			}

			// Execute the actual tool
			let result: { content: any; details: T };
			let executionError: Error | undefined;

			try {
				result = await tool.execute(toolCallId, params, signal, onUpdate, context);
			} catch (err) {
				executionError = err instanceof Error ? err : new Error(String(err));
				result = {
					content: [{ type: "text", text: executionError.message }],
					details: undefined as T,
				};
			}

			// Emit tool_result event - extensions can modify the result and error status
			if (runner.hasHandlers("tool_result")) {
				const resultResult = (await runner.emit({
					type: "tool_result",
					toolName: tool.name,
					toolCallId,
					input: params,
					content: result.content,
					details: result.details,
					isError: !!executionError,
				})) as ToolResultEventResult | undefined;

				if (resultResult) {
					const modifiedContent: (TextContent | ImageContent)[] = resultResult.content ?? result.content;
					const modifiedDetails = (resultResult.details ?? result.details) as T;

					// Extension can override error status
					if (resultResult.isError === true && !executionError) {
						// Extension marks a successful result as error
						const textBlocks = (modifiedContent ?? []).filter((c): c is TextContent => c.type === "text");
						const errorText = textBlocks.map((t) => t.text).join("\n") || "Tool result marked as error by extension";
						throw new Error(errorText);
					}
					if (resultResult.isError === false && executionError) {
						// Extension clears the error - return success
						return { content: modifiedContent, details: modifiedDetails };
					}

					// Error status unchanged, but content/details may be modified
					if (executionError) {
						throw executionError;
					}
					return { content: modifiedContent, details: modifiedDetails };
				}
			}

			// No extension modification
			if (executionError) {
				throw executionError;
			}
			return result;
		},
	};
}
