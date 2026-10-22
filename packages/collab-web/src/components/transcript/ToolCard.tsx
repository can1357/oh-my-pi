import type { MessageEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import type { ReactNode } from "react";
import { memo, useMemo } from "react";
import { messageText } from "../../lib/format";
import { type ToolRenderHost, type ToolResultLike, ToolView } from "../../tool-render";

/** The session entry holding a tool result: its id and trims address loads of what the host trimmed. */
export interface ToolResultEntry extends MessageEntry {
	message: ToolResultMessage;
}

export interface ToolCardProps {
	toolCallId: string;
	name: string;
	args: unknown;
	intent?: string;
	result?: ToolResultEntry;
	running?: boolean;
	partialResult?: unknown;
	host?: ToolRenderHost;
}

/** Wire-type adapter over the shared per-tool renderer stack. */
export const ToolCard = memo(function ToolCard(props: ToolCardProps): ReactNode {
	const { name, intent, args, result, running, partialResult, host } = props;
	const toolResult = useMemo<ToolResultLike | undefined>(
		() =>
			result?.collabElided === undefined
				? result?.message
				: { ...result.message, entryId: result.id, collabElided: result.collabElided },
		[result],
	);
	const partial =
		running && !result ? (typeof partialResult === "string" ? partialResult : messageText(partialResult)) : "";
	return (
		<ToolView
			name={name}
			args={args}
			result={toolResult}
			running={running}
			intent={intent}
			partial={partial || undefined}
			host={host}
		/>
	);
});
