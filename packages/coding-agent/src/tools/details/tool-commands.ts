import type { ToolTier } from "@oh-my-pi/pi-agent-core";

/** One tool command invocation inside a bash run, as recorded on the bash result. */
export interface ToolCommandRenderDispatch {
	tool: string;
	mode: "help" | "execute";
	/** Exit status of this invocation, independent of the outer shell status. */
	exitCode: number;
	args?: Record<string, unknown>;
	tier?: ToolTier;
	readOnlyHint?: true;
	/** Details object returned by the wrapped tool. */
	inner?: unknown;
}
