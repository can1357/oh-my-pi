/**
 * Types for `omp gallery` sample data. See {@link ./index} for the aggregated
 * fixture registry and the contract each fixture must satisfy.
 */
import type { EditMode } from "../../edit";

/** A tool result snapshot, matching the shape `ToolExecutionComponent` consumes. */
export interface GalleryResult {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError?: boolean;
}

export type GalleryFixtureState = "streaming" | "progress" | "success" | "error";

/** One named preview inside a composer or status-segment gallery section. */
export interface GalleryPreviewVariant {
	label: string;
	render(width: number, expanded: boolean): readonly string[] | Promise<readonly string[]>;
}

/** Registry-derived gallery entry rendered through the shared section layout. */
export interface GalleryPreviewEntry {
	id: string;
	heading: string;
	variants: readonly GalleryPreviewVariant[];
}

export interface GalleryFixture {
	/** Display label for the tool header (defaults to the tool name). */
	label?: string;
	/** Edit mode for edit-like tools so the streaming preview dispatches correctly. */
	editMode?: EditMode;
	/**
	 * Custom gallery-only renderer for fixtures that are not one ToolExecutionComponent
	 * (for example the read-group transcript component).
	 */
	renderState?: (
		state: GalleryFixtureState,
		width: number,
		expanded: boolean,
	) => readonly string[] | Promise<readonly string[]>;
	/**
	 * Set for tools whose real `AgentTool` attaches `renderCall`/`renderResult`
	 * directly on the instance (e.g. `task`). The harness then attaches
	 * the registry renderer onto the fake tool so the component routes through
	 * the custom-tool branch — the same path production takes — instead of the
	 * built-in registry branch. The two branches can diverge, so exercising the
	 * real one keeps the gallery honest for these tools.
	 */
	customRendered?: boolean;
	/**
	 * Renderer-registry key to use when the fixture key is a variant of a tool
	 * (e.g. `hub_wait` → `hub`). Defaults to the fixture key.
	 */
	renderer?: string;
	/**
	 * Arguments shown during the streaming state — a partial view of {@link args}
	 * as if the tool-call JSON were still arriving. May include `__partialJson`
	 * for renderers (bash, edit) that surface fields before the object closes.
	 * Defaults to {@link args} when omitted.
	 */
	streamingArgs?: unknown;
	/** Complete arguments shown for the in-progress, success, and error states. */
	args: unknown;
	/** Successful result. */
	result: GalleryResult;
	/** Failed result. Falls back to a generic error when omitted. */
	errorResult?: GalleryResult;
}
