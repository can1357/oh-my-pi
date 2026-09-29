import type { ToolResultMessage } from "@oh-my-pi/pi-wire";
import type { ReactNode } from "react";
import { memo } from "react";
import { normalizeToolResult } from "../../lib/tool-result";
import { type ToolRenderHost, ToolView } from "../../tool-render";

export interface ToolCardProps {
	toolCallId: string;
	name: string;
	args: unknown;
	intent?: string;
	result?: ToolResultMessage;
	running?: boolean;
	partialResult?: unknown;
	host?: ToolRenderHost;
}

/** Wire-type adapter over the shared per-tool renderer stack. */
export const ToolCard = memo(function ToolCard(props: ToolCardProps): ReactNode {
	const { toolCallId, name, intent, args, result, running, partialResult, host } = props;
	const displayResult =
		result ??
		(running && partialResult !== undefined ? normalizeToolResult(toolCallId, name, partialResult) : undefined);
	return <ToolView name={name} args={args} result={displayResult} running={running} intent={intent} host={host} />;
});
