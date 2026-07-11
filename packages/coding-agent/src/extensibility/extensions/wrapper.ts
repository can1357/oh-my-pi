/**
 * Tool wrappers for extensions.
 */
import type { AgentTool, AgentToolContext, AgentToolUpdateCallback } from "@pk-nerdsaver-ai/pi-agent-core";
import type { ImageContent, Static, TextContent, TSchema } from "@pk-nerdsaver-ai/pi-ai";
import type { Settings } from "../../config/settings";
import type { Theme } from "../../modes/theme/theme";
import { type ApprovalMode, formatApprovalPrompt, requiresApproval } from "../../tools/approval";
import { normalizeToolEventInput } from "../tool-event-input";
import { applyToolProxy } from "../tool-proxy";
import type { ExtensionRunner } from "./runner";
import type { RegisteredTool, ToolCallEventResult } from "./types";

/**
 * Adapts a RegisteredTool into an AgentTool.
 */
export class RegisteredToolAdapter implements AgentTool<any, any, any> {
	declare name: string;
	declare description: string;
	declare parameters: any;
	declare label: string;
	declare strict: boolean;

	renderCall?: (args: any, options: any, theme: any) => any;
	renderResult?: (result: any, options: any, theme: any, args?: any) => any;

	constructor(
		private registeredTool: RegisteredTool,
		private runner: ExtensionRunner,
	) {
		applyToolProxy(registeredTool.definition, this);

		// Only define render methods when the underlying definition provides them.
		// If these exist unconditionally on the prototype, ToolExecutionComponent
		// enters the custom-renderer path, gets undefined back, and silently
		// discards tool result text (extensions without renderers show blank).
		if (registeredTool.definition.renderCall) {
			this.renderCall = (args: any, options: any, theme: any) =>
				registeredTool.definition.renderCall!(args, options, theme as Theme);
		}
		if (registeredTool.definition.renderResult) {
			this.renderResult = (result: any, options: any, theme: any, args?: any) =>
				registeredTool.definition.renderResult!(
					result,
					{ expanded: options.expanded, isPartial: options.isPartial, spinnerFrame: options.spinnerFrame },
					theme as Theme,
					args,
				);
		}
	}

	async execute(
		toolCallId: string,
		params: any,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<any>,
		_context?: AgentToolContext,
	) {
		return this.registeredTool.definition.execute(toolCallId, params, signal, onUpdate, this.runner.createContext());
	}
}

/**
 * Backward-compatible factory function wrapper.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	return new RegisteredToolAdapter(registeredTool, runner);
}

/**
 * Wrap all registered tools into AgentTools.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map(rt => wrapRegisteredTool(rt, runner));
}

/**
 * Wraps a tool with extension callbacks for interception.
 * - Emits tool_call event before execution (can block)
 * - Emits tool_result event after execution (can modify result)
 */
export class ExtensionToolWrapper<TParameters extends TSchema = TSchema, TDetails = unknown>
	implements AgentTool<TParameters, TDetails>
{
	declare name: string;
	declare description: string;
	declare parameters: TParameters;
	declare label: string;
	declare strict: boolean;

	constructor(
		private tool: AgentTool<TParameters, TDetails>,
		private runner: ExtensionRunner,
	) {
		applyToolProxy(tool, this);
	}

	/**
	 * Forward browser mode changes when available.
	 */
	restartForModeChange(): Promise<void> {
		const target = this.tool as { restartForModeChange?: () => Promise<void> };
		if (!target.restartForModeChange) return Promise.resolve();
		return target.restartForModeChange();
	}

	async execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
		context?: AgentToolContext,
	) {
		// 1. Check approval policy (before extension handlers).
		// CLI `--auto-approve` / `--yolo` sets approval mode to yolo.
		// User `tools.approval.<tool>` policies are still applied in all modes.
		const cliAutoApprove = context?.autoApprove === true;
		const settings: Settings | undefined = context?.settings;
		const configuredMode = (settings?.get("tools.approvalMode") ?? "yolo") as ApprovalMode;
		const approvalMode: ApprovalMode = cliAutoApprove ? "yolo" : configuredMode;
		const userPolicies = (settings?.get("tools.approval") ?? {}) as Record<string, unknown>;
		const approvalCheck = requiresApproval(this.tool, params, approvalMode, userPolicies);

		if (approvalCheck.required) {
			const hasApprovalHandlers =
				this.runner.hasHandlers("tool_approval_requested") || this.runner.hasHandlers("tool_approval_resolved");
			const sessionId = context?.sessionManager?.getSessionId() ?? "";
			if (hasApprovalHandlers) {
				await this.runner.emit({
					type: "tool_approval_requested",
					sessionId,
					toolName: this.tool.name,
					toolCallId,
					...(approvalCheck.reason ? { reason: approvalCheck.reason } : {}),
					approvalMode,
				});
			}

			const resolveApproval = async (approved: boolean, reason?: string) => {
				if (!hasApprovalHandlers) return;
				await this.runner.emit({
					type: "tool_approval_resolved",
					sessionId,
					toolName: this.tool.name,
					toolCallId,
					approved,
					...(reason ? { reason } : {}),
				});
			};

			// Check if UI is available
			if (!this.runner.hasUI()) {
				const reason = "no interactive UI available";
				await resolveApproval(false, reason);
				throw new Error(
					`Tool "${this.tool.name}" requires approval but no interactive UI available.\n` +
						`Options:\n` +
						`  1. Set tools.approvalMode: yolo in /settings\n` +
						`  2. Add tools.approval.${this.tool.name}: allow to config\n` +
						`  3. Use an interactive UI to approve the tool call`,
				);
			}

			const uiContext = this.runner.getUIContext();
			let choice: string | undefined;
			try {
				choice = await uiContext.select(formatApprovalPrompt(this.tool, params, approvalCheck.reason), [
					"Approve",
					"Deny",
				]);
			} catch (err) {
				await resolveApproval(false, err instanceof Error ? err.message : "approval aborted");
				throw err;
			}
			const approved = choice === "Approve";
			await resolveApproval(approved, approved ? undefined : "denied by user");
			if (!approved) {
				throw new Error(`Tool call denied by user: ${this.tool.name}`);
			}
		}

		// 2. Emit tool_call event - extensions can block execution
		if (this.runner.hasHandlers("tool_call")) {
			try {
				const callResult = (await this.runner.emitToolCall({
					type: "tool_call",
					toolName: this.tool.name,
					toolCallId,
					input: normalizeToolEventInput(this.tool.name, params as Record<string, unknown>),
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
		let result: { content: any; details?: TDetails };
		let executionError: Error | undefined;

		try {
			result = await this.tool.execute(toolCallId, params, signal, onUpdate, context);
		} catch (err) {
			executionError = err instanceof Error ? err : new Error(String(err));
			result = {
				content: [{ type: "text", text: executionError.message }],
				details: undefined as TDetails,
			};
		}

		// Emit tool_result event - extensions can modify the result and error status
		if (this.runner.hasHandlers("tool_result")) {
			const resultResult = await this.runner.emitToolResult({
				type: "tool_result",
				toolName: this.tool.name,
				toolCallId,
				input: normalizeToolEventInput(this.tool.name, params as Record<string, unknown>),
				content: result.content,
				details: result.details,
				isError: !!executionError,
			});

			if (resultResult) {
				const modifiedContent: (TextContent | ImageContent)[] = resultResult.content ?? result.content;
				const modifiedDetails = (resultResult.details ?? result.details) as TDetails;

				// Extension can override error status
				if (resultResult.isError === true && !executionError) {
					// Extension marks a successful result as error
					const textBlocks = (modifiedContent ?? []).filter((c): c is TextContent => c.type === "text");
					const errorText = textBlocks.map(t => t.text).join("\n") || "Tool result marked as error by extension";
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
	}
}
