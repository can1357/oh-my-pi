import { ToolView } from "@oh-my-pi/collab-web/src/tool-render";
import type { ToolResultLike } from "@oh-my-pi/collab-web/src/tool-render/types";
import { memo } from "react";
import type { ToolEntry } from "../rpc/transcript";
import { useContextMenu } from "../shell/contextMenu";
import { toolMenuItems } from "./toolMenu";

/**
 * Adapter between an RPC `tool_execution_*` entry and omp's shared renderer.
 *
 * `collab-web/src/components/transcript/ToolCard.tsx` does the same job for
 * wire-typed frames; this is the RPC-shaped twin. The renderers themselves are
 * declared host-agnostic — plain JSON in, tolerant of malformed args — so no
 * translation is needed beyond naming.
 */
export const ToolCard = memo(function ToolCard({
	entry,
	onError,
}: {
	entry: ToolEntry;
	onError(cause: unknown): void;
}) {
	const { open: openMenu } = useContextMenu();
	return (
		// A wrapper, because `ToolView` is the shared renderer and does not take a
		// context-menu handler — and should not learn about one host's menus.
		<div onContextMenu={event => openMenu(event, toolMenuItems(entry, onError))}>
			<ToolView
				name={entry.name}
				args={entry.args}
				result={toolResult(entry.result, entry.isError)}
				running={entry.running}
				intent={entry.intent}
				partial={partialText(entry.partial)}
			/>
		</div>
	);
});

/**
 * Narrow to what the renderers declare instead of asserting past the checker.
 *
 * This was `entry.result as never`, which silenced the one contract that could
 * have caught a shape drift between the live frames and the replayed history —
 * and a drift in that exact pair is what left every reopened tool card without
 * its arguments.
 */
function toolResult(result: unknown, isError?: boolean): ToolResultLike | undefined {
	if (!result || typeof result !== "object") return undefined;
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	/*
	 * `isError` rides beside the result on both paths — the replay puts it on the
	 * entry, and every live emitter rebuilds the result as `{ content, details }`
	 * — but `ToolView` reads it off `result`. Dropped, a tool that failed drew
	 * the same status square as one that succeeded.
	 */
	return { ...(result as ToolResultLike), isError: isError ?? (result as ToolResultLike).isError };
}

/** `partialResult` streams as `{ content: [{ type: "text", text }], details }`. */
function partialText(partial: unknown): string | undefined {
	if (!partial || typeof partial !== "object") return undefined;
	const content = (partial as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map(block =>
			block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
				? (block as { text: string }).text
				: "",
		)
		.join("");
	return text || undefined;
}
