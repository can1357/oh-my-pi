/**
 * TUI renderers for built-in tools.
 *
 * These provide rich visualization for tool calls and results in the TUI.
 */

import type { Component } from "@oh-my-pi/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme";
import type { RenderResultOptions } from "../custom-tools/types";
import { askToolRenderer } from "./ask";
import { bashToolRenderer } from "./bash";
import { calculatorToolRenderer } from "./calculator";
import { editToolRenderer } from "./edit";
import { findToolRenderer } from "./find";
import { grepToolRenderer } from "./grep";
import { lsToolRenderer } from "./ls";
import { lspToolRenderer } from "./lsp/render";
import { notebookToolRenderer } from "./notebook";
import { outputToolRenderer } from "./output";
import { pythonToolRenderer } from "./python";
import { readToolRenderer } from "./read";
import { sshToolRenderer } from "./ssh";
import { taskToolRenderer } from "./task/render";
import { todoWriteToolRenderer } from "./todo-write";
import { webFetchToolRenderer } from "./web-fetch";
import { webSearchToolRenderer } from "./web-search/render";
import { writeToolRenderer } from "./write";

type ToolRenderer = {
	renderCall: (args: unknown, theme: Theme) => Component;
	renderResult: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		options: RenderResultOptions & { renderContext?: Record<string, unknown> },
		theme: Theme,
		args?: unknown,
	) => Component;
	mergeCallAndResult?: boolean;
	/** Render without background box, inline in the response flow */
	inline?: boolean;
};

export const toolRenderers: Record<string, ToolRenderer> = {
	ask: askToolRenderer as ToolRenderer,
	bash: bashToolRenderer as ToolRenderer,
	python: pythonToolRenderer as ToolRenderer,
	calc: calculatorToolRenderer as ToolRenderer,
	edit: editToolRenderer as ToolRenderer,
	find: findToolRenderer as ToolRenderer,
	grep: grepToolRenderer as ToolRenderer,
	ls: lsToolRenderer as ToolRenderer,
	lsp: lspToolRenderer as ToolRenderer,
	notebook: notebookToolRenderer as ToolRenderer,
	output: outputToolRenderer as ToolRenderer,
	read: readToolRenderer as ToolRenderer,
	ssh: sshToolRenderer as ToolRenderer,
	task: taskToolRenderer as ToolRenderer,
	todo_write: todoWriteToolRenderer as ToolRenderer,
	web_fetch: webFetchToolRenderer as ToolRenderer,
	web_search: webSearchToolRenderer as ToolRenderer,
	write: writeToolRenderer as ToolRenderer,
};
