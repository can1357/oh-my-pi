/**
 * CustomToolAdapter wraps CustomTool instances into AgentTool for use with the agent.
 */
import type { AgentTool, AgentToolUpdateCallback, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { Static, TSchema } from "@oh-my-pi/pi-ai";
import type { Theme } from "../../modes/theme/theme";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import { applyToolProxy } from "../tool-proxy";
import type { CustomTool, CustomToolContext } from "./types";

export class CustomToolAdapter<
	TParams extends TSchema = TSchema,
	TDetails = any,
	TTheme extends Theme = Theme,
> implements AgentTool<TParams, TDetails, TTheme> {
	declare name: string;
	declare label: string;
	declare description: string;
	declare parameters: TParams;
	readonly strict: boolean | undefined;
	readonly loadMode: ToolLoadMode;

	constructor(
		private tool: CustomTool<TParams, TDetails>,
		private getContext: () => CustomToolContext,
	) {
		applyToolProxy(tool, this);
		this.strict = tool.strict;
		this.loadMode = defaultLoadModeForToolName(tool.name, tool.loadMode);
	}

	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParams>,
		context?: CustomToolContext,
	) {
		return this.tool.execute(toolCallId, params, onUpdate, context ?? this.getContext(), signal);
	}

	/**
	 * Backward-compatible export of factory function for existing callers.
	 * Prefer CustomToolAdapter constructor directly.
	 */
	static wrap<TParams extends TSchema = TSchema, TDetails = any, TTheme extends Theme = Theme>(
		tool: CustomTool<TParams, TDetails>,
		getContext: () => CustomToolContext,
	): AgentTool<TParams, TDetails, TTheme> {
		return new CustomToolAdapter(tool, getContext);
	}
}
