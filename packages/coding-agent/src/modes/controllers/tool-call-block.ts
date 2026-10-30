import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { isReplyWrite } from "@oh-my-pi/pi-tui/chat/reply-write";
import { ToolExecutionComponent, type ToolExecutionHandle } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { createReplyWriteComponent } from "@oh-my-pi/pi-tui/prompt/interactive-context-helpers";
import { settings } from "../../config/settings";
import type { InteractiveModeContext } from "../types";
import { cfgTerminalShowImages } from "../settings";

/** A tool call about to get its transcript block. */
export interface ToolCallBlockSpec {
	/** Renderer name (`toolRenderName`). */
	readonly name: string;
	readonly args: unknown;
	readonly tool: AgentTool | undefined;
	readonly id: string;
	/** Directory the call's relative paths resolve against. */
	readonly cwd: string;
}

/**
 * The block a tool call opens in the interactive transcript: a reply block for a built-in
 * `write` to a reply URL (`out://`, see {@link isReplyWrite}), a tool card for anything else.
 * Shared by the live event path and the transcript rebuild so both draw a call the same way.
 */
export function createToolCallBlock(ctx: InteractiveModeContext, call: ToolCallBlockSpec): ToolExecutionHandle {
	const builtIn = ctx.viewSession.hasBuiltInTool(call.name);
	if (builtIn && isReplyWrite(call.name, call.args) === true) {
		const reply = createReplyWriteComponent(ctx);
		reply.updateArgs(call.args);
		return reply;
	}
	return new ToolExecutionComponent(
		call.name,
		call.args,
		{ useBuiltInRenderer: builtIn, showImages: cfgTerminalShowImages.get(settings) },
		call.tool,
		ctx.ui,
		call.cwd,
		call.id,
	);
}
