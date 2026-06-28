/**
 * TUI renderers for built-in tools.
 *
 * These provide rich visualization for tool calls and results in the TUI.
 */
import type { Component } from "@pk-nerdsaver-ai/pi-tui";
import { editToolRenderer } from "../edit/renderer";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { goalToolRenderer } from "../goals/tools/goal-tool";
import { lspToolRenderer } from "../lsp/render";
import type { Theme } from "../modes/theme/theme";
import { taskToolRenderer } from "../task/render";
import { webSearchToolRenderer } from "../web/search/render";
import { askToolRenderer } from "./ask";
import { astEditToolRenderer } from "./ast-edit";
import { astGrepToolRenderer } from "./ast-grep";
import { bashToolRenderer } from "./bash";
import { browserToolRenderer } from "./browser/render";
import { debugToolRenderer } from "./debug";
import { evalToolRenderer } from "./eval-render";
import { githubToolRenderer } from "./gh-renderer";
import { globToolRenderer } from "./glob";
import { grepToolRenderer } from "./grep";
import { inspectImageToolRenderer } from "./inspect-image-renderer";
import { ircToolRenderer } from "./irc";
import { jobToolRenderer } from "./job";
import { recallToolRenderer, reflectToolRenderer, retainToolRenderer } from "./memory-render";
import { readToolRenderer } from "./read";
import { resolveToolRenderer } from "./resolve";
import { searchToolBm25Renderer } from "./search-tool-bm25";
import { sshToolRenderer } from "./ssh";
import { todoToolRenderer } from "./todo";
import { writeToolRenderer } from "./write";

export type ToolRenderer = {
	renderCall: (args: unknown, options: RenderResultOptions, theme: Theme) => Component;
	renderResult: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		options: RenderResultOptions & { renderContext?: Record<string, unknown> },
		theme: Theme,
		args?: unknown,
	) => Component;
	mergeCallAndResult?: boolean;
	/** Render without background box, inline in the response flow */
	inline?: boolean;
	/**
	 * Whether pending-call rows are provisional: useful on screen while a tool is
	 * streaming, but not durable transcript history. `true` means every pending
	 * shape is provisional. `"collapsed"` means only the collapsed pending shape
	 * is provisional; expanded rendering is top-anchored/append-shaped enough to
	 * let the transcript commit its settled prefix. Absent = the pending preview
	 * streams rows the result render preserves.
	 */
	provisionalPendingPreview?: boolean | "collapsed";
	/**
	 * Whether the partial-result render is provisional: chrome rows (header
	 * glyph, frame state) that change between `options.isPartial === true` and
	 * the final result render. When `true`, the block is treated as
	 * commit-unstable while a partial result is in flight, so the
	 * stable-prefix ratchet in `deriveLiveCommitState` cannot promote the
	 * partial chrome to native scrollback only to have the final render strand
	 * it above the settled frame. Absent = the partial render is byte-stable
	 * with the final render and may commit like any settled stream.
	 */
	provisionalPartialResult?: boolean;
};

export const toolRenderers: Record<string, ToolRenderer> = {
	ask: askToolRenderer as ToolRenderer,
	ast_grep: astGrepToolRenderer as ToolRenderer,
	ast_edit: astEditToolRenderer as ToolRenderer,
	bash: bashToolRenderer as ToolRenderer,
	browser: browserToolRenderer as ToolRenderer,
	debug: debugToolRenderer as ToolRenderer,
	eval: evalToolRenderer as ToolRenderer,
	edit: editToolRenderer as ToolRenderer,
	apply_patch: editToolRenderer as ToolRenderer,
	glob: globToolRenderer as ToolRenderer,
	grep: grepToolRenderer as ToolRenderer,
	lsp: lspToolRenderer as ToolRenderer,
	inspect_image: inspectImageToolRenderer as ToolRenderer,
	irc: ircToolRenderer as ToolRenderer,
	read: readToolRenderer as ToolRenderer,
	job: jobToolRenderer as ToolRenderer,
	resolve: resolveToolRenderer as ToolRenderer,
	retain: retainToolRenderer as ToolRenderer,
	recall: recallToolRenderer as ToolRenderer,
	reflect: reflectToolRenderer as ToolRenderer,
	search_tool_bm25: searchToolBm25Renderer as ToolRenderer,
	ssh: sshToolRenderer as ToolRenderer,
	task: taskToolRenderer as ToolRenderer,
	todo: todoToolRenderer as ToolRenderer,
	github: githubToolRenderer as ToolRenderer,
	goal: goalToolRenderer as ToolRenderer,
	web_search: webSearchToolRenderer as ToolRenderer,
	write: writeToolRenderer as ToolRenderer,
};
