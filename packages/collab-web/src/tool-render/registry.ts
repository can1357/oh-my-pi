/**
 * Tool renderer registry. Keys are current wire tool names.
 * Unknown tools fall back to the generic JSON renderer.
 */
import { createElement } from "react";
import { genericRenderer } from "./generic";
import { askRenderer } from "./tools/ask";
import { astEditRenderer } from "./tools/ast-edit";
import { astGrepRenderer } from "./tools/ast-grep";
import { bashRenderer } from "./tools/bash";
import { browserRenderer } from "./tools/browser";
import { debugRenderer } from "./tools/debug";
import { editRenderer } from "./tools/edit";
import { evalRenderer } from "./tools/eval";
import { fetchRenderer } from "./tools/fetch";
import { generateImageRenderer } from "./tools/generate-image";
import { githubRenderer } from "./tools/github";
import { globRenderer } from "./tools/glob";
import { goalRenderer } from "./tools/goal";
import { grepRenderer } from "./tools/grep";
import { waitRenderer } from "./tools/wait";
import { lspRenderer } from "./tools/lsp";
import { recallRenderer } from "./tools/memory-recall";
import { reflectRenderer } from "./tools/memory-reflect";
import { retainRenderer } from "./tools/memory-retain";
import { readRenderer } from "./tools/read";
import { reportToolIssueRenderer } from "./tools/report-tool-issue";
import { resolveRenderer } from "./tools/resolve";
import { taskRenderer } from "./tools/task";
import { todoRenderer } from "./tools/todo";
import { webSearchRenderer } from "./tools/web-search";
import { writeRenderer } from "./tools/write";
import { yieldRenderer } from "./tools/yield";
import type { ToolRenderer, ToolRenderProps } from "./types";

/**
 * `find` dispatches by argument shape: `pattern` is a content search (grep
 * renderer), `glob` (or `path` alone) a name search (glob renderer, which reads
 * the glob from `path`), otherwise the semantic query uses the glob renderer's
 * generic header. `grep`/`glob` keys stay for historical transcripts.
 */
function findProps(props: ToolRenderProps): { renderer: ToolRenderer; props: ToolRenderProps } {
	const { args } = props;
	if (args.pattern !== undefined) return { renderer: grepRenderer, props };
	if (args.query === undefined && (args.glob !== undefined || args.path !== undefined)) {
		const globArgs = args.glob !== undefined ? { ...args, path: args.glob } : args;
		return { renderer: globRenderer, props: { ...props, args: globArgs } };
	}
	return { renderer: globRenderer, props };
}

const findRenderer: ToolRenderer = {
	Summary: p => {
		const d = findProps(p);
		return createElement(d.renderer.Summary, d.props);
	},
	Body: p => {
		const d = findProps(p);
		const Body = d.renderer.Body;
		return Body ? createElement(Body, d.props) : null;
	},
};

const RENDERERS: Record<string, ToolRenderer> = {
	ask: askRenderer,
	ast_edit: astEditRenderer,
	ast_grep: astGrepRenderer,
	bash: bashRenderer,
	browser: browserRenderer,
	puppeteer: browserRenderer,
	debug: debugRenderer,
	edit: editRenderer,
	apply_patch: editRenderer,
	eval: evalRenderer,
	js: evalRenderer,
	python: evalRenderer,
	notebook: evalRenderer,
	fetch: fetchRenderer,
	glob: globRenderer,
	find: findRenderer,
	generate_image: generateImageRenderer,
	github: githubRenderer,
	goal: goalRenderer,
	wait: waitRenderer,
	lsp: lspRenderer,
	recall: recallRenderer,
	reflect: reflectRenderer,
	retain: retainRenderer,
	read: readRenderer,
	report_tool_issue: reportToolIssueRenderer,
	resolve: resolveRenderer,
	reject: resolveRenderer,
	propose: resolveRenderer,
	grep: grepRenderer,
	search: grepRenderer,
	task: taskRenderer,
	todo: todoRenderer,
	web_search: webSearchRenderer,
	write: writeRenderer,
	yield: yieldRenderer,
};

export function resolveToolRenderer(name: string): ToolRenderer {
	return RENDERERS[name] ?? genericRenderer;
}
