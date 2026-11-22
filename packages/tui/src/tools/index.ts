/**
 * Built-in tool renderer registry: maps tool names to their transcript renderers.
 * `ToolExecutionComponent` and nested tool command cards in bash results look renderers up here;
 * tools without an entry fall back to `renderDefaultToolExecution`.
 */
import { askToolRenderer } from "./ask";
import { astEditToolRenderer } from "./ast-edit";
import { astGrepToolRenderer } from "./ast-grep";
import { bashToolRenderer } from "./bash";
import { debugToolRenderer } from "./debug";
import { editToolRenderer } from "./edit";
import { evalToolRenderer } from "./eval";
import { findToolRenderer } from "./find";
import { githubToolRenderer } from "./github";
import { globToolRenderer } from "./glob";
import { goalToolRenderer } from "./goal";
import { grepToolRenderer } from "./grep";
import { waitToolRenderer } from "./wait";
import { lspToolRenderer } from "./lsp";
import { recallToolRenderer, reflectToolRenderer, retainToolRenderer } from "./memory";
import { powershellToolRenderer } from "./powershell";
import { readToolRenderer } from "./read";
import type { ToolRenderer } from "./renderer";
import { proposeRenderer, rejectRenderer, resolveRenderer } from "./resolve";
import { reportIssueRenderer } from "./report-tool-issue";
import { taskToolRenderer } from "./task";
import { thinkToolRenderer } from "./think";
import { todoToolRenderer } from "./todo";
import { createVibeToolRenderer } from "./vibe";
import { webSearchToolRenderer } from "./web-search";
import { writeToolRenderer } from "./write";
import { yieldToolRenderer } from "./yield";
import { setToolCommandRendererLookup } from "./tool-commands";

export * from "./renderer";

/** Renderers keyed by tool name (plus the `apply_patch` alias that shares the edit renderer). */
export const toolRenderers: Record<string, ToolRenderer> = {
	ask: askToolRenderer,
	ast_grep: astGrepToolRenderer,
	ast_edit: astEditToolRenderer,
	bash: bashToolRenderer,
	debug: debugToolRenderer,
	eval: evalToolRenderer,
	edit: editToolRenderer,
	apply_patch: editToolRenderer,
	find: findToolRenderer,
	glob: globToolRenderer,
	grep: grepToolRenderer,
	lsp: lspToolRenderer,
	wait: waitToolRenderer,
	read: readToolRenderer,
	powershell: powershellToolRenderer,
	resolve: resolveRenderer,
	reject: rejectRenderer,
	propose: proposeRenderer,
	report_issue: reportIssueRenderer,
	retain: retainToolRenderer,
	recall: recallToolRenderer,
	reflect: reflectToolRenderer,
	task: taskToolRenderer,
	think: thinkToolRenderer,
	todo: todoToolRenderer,
	github: githubToolRenderer,
	goal: goalToolRenderer,
	web_search: webSearchToolRenderer,
	vibe_spawn: createVibeToolRenderer("spawn"),
	vibe_send: createVibeToolRenderer("send"),
	vibe_wait: createVibeToolRenderer("wait"),
	vibe_kill: createVibeToolRenderer("kill"),
	vibe_list: createVibeToolRenderer("list"),
	write: writeToolRenderer,
	yield: yieldToolRenderer,
};

// Wire nested tool command cards to this registry without tool-commands importing it.
setToolCommandRendererLookup(name => toolRenderers[name]);
