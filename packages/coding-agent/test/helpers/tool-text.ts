/**
 * Plain text of a tool call's transcript card: one {@link ToolCall} driven to
 * a final (or partial) result and painted once through {@link ToolBlock}.
 */
import "../../src/ui/styles/tools";
import "../../src/ui/tools";
import { printRows } from "../../src/ui/print-rows";
import { ToolBlock, ToolCall, type ToolCallResult } from "../../src/ui/transcript/tool-block";

export interface ToolTextInput {
	readonly name: string;
	readonly args: unknown;
	readonly result?: ToolCallResult;
	/** The result is still streaming. */
	readonly partial?: boolean;
	readonly expanded?: boolean;
	readonly width?: number;
	/** Host render context (badge settings, job state). */
	readonly renderContext?: Readonly<Record<string, unknown>>;
}

/** The {@link ToolCall} for `input`, args complete and its result (if any) applied. */
export function toolCall(input: ToolTextInput): ToolCall {
	const call = new ToolCall({
		id: "call-1",
		name: input.name,
		args: input.args,
	});
	call.setArgsComplete();
	call.setExecutionStarted();
	if (input.result) call.updateResult(input.result, input.partial === true);
	if (input.expanded) call.setExpanded(true);
	if (input.renderContext) call.setRenderContext(input.renderContext);
	return call;
}

/** The card's rows for `call` at `width`, ANSI stripped. */
export function toolCallText(call: ToolCall, width = 120): string {
	return Bun.stripANSI(printRows(() => ToolBlock({ call }), width).join("\n"));
}

/** The card's rows for `input`, ANSI stripped. */
export function toolText(input: ToolTextInput): string {
	return toolCallText(toolCall(input), input.width);
}
