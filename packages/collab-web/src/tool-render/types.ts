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
