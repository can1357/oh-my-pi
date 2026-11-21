import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspText } from "@oh-my-pi/pi-wire";
import { type Component, Container } from "../tui";
import type { Theme } from "../theme/theme";
import { compact, keyed, node, span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { renderStatusLine } from "../render/status-line";
import { WidthAwareText } from "../render/width-aware-text";
import { Ellipsis, replaceTabs, truncateToWidth } from "../render/render-utils";
import { describeDefaultToolExecution, renderDefaultToolExecution } from "./default-renderer";
import { parseMCPToolName } from "./mcp";
import { toolHead } from "./native-view";
import type { NativeToolView, RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";

/** Display callbacks of a mounted tool, independent of tool execution state. */
export interface ToolCommandMountedRenderer {
	label?: string;
	describeCall?: ToolRenderer["describeCall"];
	describeResult?: ToolRenderer["describeResult"];
	renderCall?(...args: Parameters<ToolRenderer["renderCall"]>): unknown;
	renderResult?(...args: Parameters<ToolRenderer["renderResult"]>): unknown;
	mergeCallAndResult?: boolean;
}

/** Tool presentation state supplied by the host's canonical tool map. */
export interface ToolCommandMountedState {
	readonly mountedNames: ReadonlySet<string>;
	readonly tools: ReadonlyMap<string, ToolCommandMountedRenderer>;
	/**
	 * Canonical renderer for a tool command name, supplied by the host with the
	 * same predicate as dispatch (`resolveToolCommand`: mounted tools plus active
	 * top-level tools). The TUI keeps no predicate copy of its own.
	 */
	readonly resolve?: (name: string) => ToolCommandMountedRenderer | undefined;
}

/** Host lookup of the live renderer behind a tool command name. */
export type ToolCommandRendererResolver = (name: string) => ToolCommandMountedRenderer | undefined;

/** One tool command invocation inside a bash run, as recorded on the bash result. */
export interface ToolCommandRenderDispatch {
	tool: string;
	mode: "help" | "execute";
	/** Exit status of this invocation, independent of the outer shell status. */
	exitCode: number;
	args?: Record<string, unknown>;
	tier?: ToolTier;
	readOnlyHint?: true;
	/** Details object returned by the wrapped tool. */
	inner?: unknown;
}

/** What one nested tool command card draws. */
export interface ToolCommandDispatchInput {
	dispatch: ToolCommandRenderDispatch;
	/** Text the invocation printed, when the card stands for the whole call's output. */
	output?: string;
	/** Host lookup of live mounted renderers (custom, MCP and extension tools). */
	resolveMounted?: ToolCommandRendererResolver;
}

function isComponent(value: unknown): value is Component {
	return typeof value === "object" && value !== null && "render" in value && typeof value.render === "function";
}

let rendererLookup: ((name: string) => ToolRenderer | undefined) | undefined;

/** Wire the built-in renderer lookup. Called once by the renderer registry. */
export function setToolCommandRendererLookup(lookup: (name: string) => ToolRenderer | undefined): void {
	rendererLookup = lookup;
}

/** The mounted tool's own render callbacks (custom/MCP/image tools carry them) first, then the built-in map. */
function resolveRenderer(
	name: string,
	mounted: ToolCommandMountedRenderer | undefined,
): ToolCommandMountedRenderer | undefined {
	if (mounted && (mounted.renderCall || mounted.renderResult)) return mounted;
	return rendererLookup?.(name);
}

/** Native form of {@link resolveRenderer}: the first renderer that can describe. */
function resolveDescriber(
	name: string,
	mounted: ToolCommandMountedRenderer | undefined,
): ToolCommandMountedRenderer | undefined {
	if (mounted && (mounted.describeCall || mounted.describeResult)) return mounted;
	return rendererLookup?.(name);
}

/** Human label for a tool command: mounted tool label, else `server/tool` for MCP names. */
function displayLabel(name: string, mounted: ToolCommandMountedRenderer | undefined): string {
	if (mounted?.label) return replaceTabs(sanitizeText(mounted.label));
	const parsed = parseMCPToolName(name);
	if (parsed) return replaceTabs(sanitizeText(`${parsed.serverName}/${parsed.toolName}`));
	return replaceTabs(sanitizeText(name));
}

/** The wrapped tool's result as its own renderer receives it. */
function innerResult(input: ToolCommandDispatchInput): ToolRenderResult {
	const { dispatch, output } = input;
	return {
		content: output ? [{ type: "text", text: output }] : [],
		details: dispatch.inner,
		isError: dispatch.exitCode !== 0,
	};
}

/** One-line `<tool> --help` card. */
function renderHelpCard(label: string, dispatch: ToolCommandRenderDispatch, theme: Theme): Component {
	const line = renderStatusLine(
		{ icon: dispatch.exitCode === 0 ? "done" : "error", title: label, description: theme.fg("dim", "--help") },
		theme,
	);
	return new WidthAwareText(width => truncateToWidth(line, width, Ellipsis.Unicode), 0, 0);
}

/**
 * Nested card for one tool command invocation. An executed command renders
 * through the wrapped tool's renderer, fed its parsed arguments as the call
 * and its details as the result (a call header above it when that renderer
 * does not merge call and result); `--help` draws a one-line card; anything
 * without a renderer, or without parsed arguments, gets the generic card.
 */
export function renderToolCommandDispatch(
	input: ToolCommandDispatchInput,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	const { dispatch } = input;
	const mounted = input.resolveMounted?.(dispatch.tool);
	const label = displayLabel(dispatch.tool, mounted);
	if (dispatch.mode === "help") return renderHelpCard(label, dispatch, theme);
	const result = innerResult(input);
	const renderer = dispatch.args ? resolveRenderer(dispatch.tool, mounted) : undefined;
	if (dispatch.args && renderer?.renderResult) {
		const parts: Component[] = [];
		if (!renderer.mergeCallAndResult && renderer.renderCall) {
			const call = renderer.renderCall(dispatch.args, { ...options, isPartial: false }, theme);
			if (isComponent(call)) parts.push(call);
		}
		const rendered = renderer.renderResult(result, options, theme, dispatch.args);
		if (isComponent(rendered)) parts.push(rendered);
		if (parts.length === 1) return parts[0];
		if (parts.length > 1) {
			const box = new Container();
			for (const part of parts) box.addChild(part);
			return box;
		}
	}
	return renderDefaultToolExecution(
		{
			label,
			args: dispatch.args ?? {},
			result: { output: input.output ?? "", isError: result.isError },
			options,
		},
		theme,
	);
}

/** Native view of one tool command invocation; same routing as {@link renderToolCommandDispatch}. */
export function describeToolCommandDispatch(
	input: ToolCommandDispatchInput,
	options: RenderResultOptions,
): NativeToolView {
	const { dispatch } = input;
	const mounted = input.resolveMounted?.(dispatch.tool);
	const label = displayLabel(dispatch.tool, mounted);
	const isError = dispatch.exitCode !== 0;
	if (dispatch.mode === "help") {
		return {
			tool: { title: label, target: "--help", targetKind: "text", exit: isError ? dispatch.exitCode : undefined },
			tone: isError ? "error" : undefined,
		};
	}
	const result = innerResult(input);
	const renderer = dispatch.args ? resolveDescriber(dispatch.tool, mounted) : undefined;
	if (dispatch.args && renderer?.describeResult) {
		const view = renderer.describeResult(result, options, dispatch.args);
		if (view) {
			if (renderer.mergeCallAndResult || !renderer.describeCall) return view;
			const call = renderer.describeCall(dispatch.args, { ...options, isPartial: false });
			return {
				...view,
				tool: view.tool ?? call?.tool,
				head: view.head ?? call?.head,
				body: [...(call?.body ?? []), ...(view.body ?? [])],
			};
		}
	}
	return describeDefaultToolExecution({
		label,
		args: dispatch.args ?? {},
		result: { output: input.output ?? "", isError },
		options,
	});
}

/** Plain text of a head field. */
function headText(value: TspText | undefined): string | undefined {
	if (value === undefined) return undefined;
	return typeof value === "string" ? value : value.map(part => part.t).join("");
}

/** Head spans of a nested view: the renderer's own spans, else spans from its data head. */
function nestedHead(view: NativeToolView, label: string, dispatch: ToolCommandRenderDispatch): TspText {
	if (view.head !== undefined) return view.head;
	const head = view.tool;
	const spans = toolHead(headText(head?.title) ?? label, headText(head?.target), ...(head?.meta ?? []).map(headText));
	const exit = head?.exit ?? (dispatch.exitCode !== 0 ? dispatch.exitCode : undefined);
	if (exit) spans.push(span(" "), span(`exit ${exit}`, "error"));
	const note = headText(head?.note);
	if (note) spans.push(span(" "), span(note, "muted"));
	return spans;
}

/**
 * Native node of one nested tool command card inside a shell run: a one-line
 * head over the wrapped view's body.
 */
export function describeToolCommandNode(
	input: ToolCommandDispatchInput,
	options: RenderResultOptions,
	key: string,
): NativeNode {
	const view = describeToolCommandDispatch(input, options);
	const label = displayLabel(input.dispatch.tool, input.resolveMounted?.(input.dispatch.tool));
	return node(
		"col",
		{ role: "omp.tool.bash.command-tool", gap: "sm" },
		compact([
			keyed(
				text(nestedHead(view, label, input.dispatch), {
					role: "omp.tool.bash.command-tool.head",
					wrap: "none",
					truncate: "end",
				}),
				"head",
			),
			...(view.body ?? []),
		]),
		key,
	);
}
