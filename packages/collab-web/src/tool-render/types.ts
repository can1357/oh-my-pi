/**
 * Tool renderer contract.
 *
 * Every tool gets a renderer with two React components:
 * - `Summary` — one-line inline header content (dense, truncated by the chrome).
 * - `Body` — expanded detail view (args, outputs, diffs, images).
 *
 * Renderers are host-agnostic: they run inside the collab-web React app and
 * inside the `<omp-tool-view>` web component bundled into HTML session exports.
 * They must never import host-specific modules (wire types, coding-agent
 * runtime, node builtins) and must tolerate partial/malformed `args` and
 * `details` — these arrive as plain JSON over the wire.
 */
import type { CollabElided } from "@oh-my-pi/pi-wire";
import type { ComponentType } from "react";

export interface ToolResultText {
	type: "text";
	text: string;
}

export interface ToolResultImage {
	type: "image";
	/** Base64-encoded image data. */
	data: string;
	/** e.g. "image/png". */
	mimeType: string;
}

export type ToolResultBlock = ToolResultText | ToolResultImage | { type: string };

export interface ToolResultLike {
	content: readonly ToolResultBlock[];
	details?: unknown;
	isError?: boolean;
	/** Id of the session entry holding the result; set when `collabElided` is. */
	entryId?: string;
	/** Values the collab host trimmed from the result entry. */
	collabElided?: readonly CollabElided[];
}

/**
 * Capabilities the embedding host exposes to renderers. Functions are live
 * objects (passed via property assignment or the payload store) — they cannot
 * ride the JSON `payload` attribute.
 */
export interface ToolRenderHost {
	/** True when the host can show a transcript for this agent id. */
	hasAgent?(id: string): boolean;
	/** Open the sub-session/transcript view for an agent id. */
	openAgent?(id: string): void;
	/**
	 * Fetch the original of a trimmed value and swap it into its entry.
	 * Resolves `null` once loaded, else the reason it could not be.
	 * Absent (HTML exports), trimmed values show only their placeholders.
	 */
	loadFull?(entryId: string, elided: CollabElided): Promise<string | null>;
}

export interface ToolRenderProps {
	/** Wire tool name (may be an alias of the registry key, e.g. `grep` → search). */
	name: string;
	/** Parsed tool-call arguments with the internal `i` intent already stripped. */
	args: Record<string, unknown>;
	result?: ToolResultLike;
	/** Tool is still executing (live collab view). */
	running?: boolean;
	/** Host capabilities (sub-session drill-down, …). */
	host?: ToolRenderHost;
}

export interface ToolRenderer {
	/** Inline single-line header summary. Must not render block elements. */
	Summary: ComponentType<ToolRenderProps>;
	/** Expanded body. Omit when the summary already says everything. */
	Body?: ComponentType<ToolRenderProps>;
}
