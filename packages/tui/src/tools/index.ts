/**
 * Built-in tool renderer registry: maps tool names to their transcript renderers.
 * `ToolExecutionComponent` and the `xd://` dispatch look renderers up here;
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
import { readToolRenderer } from "./read";
import type { ToolRenderer } from "./renderer";
import { resolveRenderer } from "./resolve";
import { taskToolRenderer } from "./task";
import { thinkToolRenderer } from "./think";
import { todoToolRenderer } from "./todo";
import { createVibeToolRenderer } from "./vibe";
import { webSearchToolRenderer } from "./web-search";
import { writeToolRenderer } from "./write";
import { setXdevRendererLookup } from "./xdev";

export * from "./renderer";

/** Renderers keyed by tool name (plus `apply_patch`/`reject` aliases that share a renderer). */
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
	// Keyed by xd:// resolution-device names: the write dispatch delegates here
	// by dispatch tool, and historical `resolve` tool transcripts still render
	// through the `resolve` entry. Both devices carry the same ResolveDetails.
	resolve: resolveRenderer,
	reject: resolveRenderer,
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
};

// Wire the xd:// render delegation without the xdev module importing this registry.
setXdevRendererLookup(name => toolRenderers[name]);
