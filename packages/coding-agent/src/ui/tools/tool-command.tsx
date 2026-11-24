/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Tool commands: a mounted tool invoked inside a bash run (`<tool> …`,
 * `<tool> --help`), recorded on the bash result as dispatches.
 *
 * `--help` is a one-line card; an executed command shows through the wrapped
 * tool's presenter (fed its parsed args as the call and its details as the
 * result), a mounted tool's row-drawing hooks, or the generic card.
 *
 * Terminal look: `tool-command` (`src/ui/styles/tools/tool-command.ts`).
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { TspSpan, TspText } from "@oh-my-pi/pi-wire";
import type { ToolPresenter, ToolResult, ToolView, ToolViewState } from "./contract";
import { defaultPresenter } from "./default";
import { type LegacyToolRenderer, legacyParts, legacyView, type ToolRenderPart } from "./legacy";
import { toolPresenter } from "./registry";

/** One tool command invocation inside a bash run, as the bash result records it. */
export interface ToolCommandDispatch {
	readonly tool: string;
	readonly mode: "help" | "execute";
	/** Exit status of this invocation. */
	readonly exitCode: number;
	readonly args?: Record<string, unknown>;
	/** Details the wrapped tool returned. */
	readonly inner?: unknown;
}

/** What the host knows about a mounted tool. */
export interface ToolCommandMounted {
	readonly label?: string;
	/** The tool's presenter (built-in or extension). */
	readonly presenter?: ToolPresenter;
	/** Row-drawing hooks of an extension tool. */
	readonly legacy?: LegacyToolRenderer;
}

/** Host lookup of mounted tools by command name. */
export type ToolCommandResolver = (name: string) => ToolCommandMounted | undefined;

/** One nested card's inputs. */
export interface ToolCommandInput {
	readonly dispatch: ToolCommandDispatch;
	/** What the invocation printed, when its card stands for the whole call's output. */
	readonly output?: string;
	readonly resolveMounted?: ToolCommandResolver;
}

/** Terminal-only facts of a tool command card (`term`). */
export interface ToolCommandTerm {
	readonly look: "tool-command";
	readonly mode: "help" | "legacy" | "view";
	readonly exitCode: number;
	/** The look of the wrapped view (`view` mode). */
	readonly inner?: string;
	/** The command's label (`server/tool`, the mounted tool's label). */
	readonly commandLabel: string;
	readonly args?: unknown;
	/** What a mounted tool's render hooks drew (`legacy` mode). */
	readonly parts?: readonly ToolRenderPart[];
}

const MCP_PREFIX = "mcp__";

/** `server/tool` of an MCP tool name. */
function mcpLabel(name: string): string | undefined {
	if (!name.startsWith(MCP_PREFIX)) return undefined;
	const rest = name.slice(MCP_PREFIX.length);
	const at = rest.indexOf("_");
	return at === -1 ? undefined : `${rest.slice(0, at)}/${rest.slice(at + 1)}`;
}

/** The command's label: the mounted tool's, else `server/tool` for MCP names, else the name. */
export function toolCommandLabel(name: string, mounted: ToolCommandMounted | undefined): string {
	return replaceTabs(sanitizeText(mounted?.label ?? mcpLabel(name) ?? name));
}

function innerResult(input: ToolCommandInput): ToolResult {
	return {
		content: input.output ? [{ type: "text", text: input.output }] : [],
		details: input.dispatch.inner,
		isError: input.dispatch.exitCode !== 0,
	};
}

/** The view of one invocation. */
export function toolCommandView(input: ToolCommandInput, state: ToolViewState): ToolView {
	const { dispatch } = input;
	const mounted = input.resolveMounted?.(dispatch.tool);
	const label = toolCommandLabel(dispatch.tool, mounted);
	const isError = dispatch.exitCode !== 0;
	const term = {
		look: "tool-command",
		exitCode: dispatch.exitCode,
		commandLabel: label,
		args: dispatch.args ?? {},
	} as const;
	if (dispatch.mode === "help") {
		return {
			head: { title: label, target: "--help", targetKind: "text", ...(isError ? { exit: dispatch.exitCode } : {}) },
			...(isError ? { tone: "error" as const } : {}),
			term: { ...term, mode: "help" } satisfies ToolCommandTerm,
		};
	}
	const result = innerResult(input);
	const presenter = dispatch.args ? (mounted?.presenter ?? toolPresenter(dispatch.tool)) : undefined;
	if (dispatch.args && presenter?.result) {
		const view = presenter.result(result, state, dispatch.args);
		if (view) {
			const merged =
				presenter.merge || !presenter.call
					? view
					: (() => {
							const call = presenter.call(dispatch.args, { ...state, isPartial: false });
							return {
								...view,
								head: view.head ?? call?.head,
								label: view.label ?? call?.label,
								body: [call?.body, view.body],
							};
						})();
			return {
				...merged,
				term: {
					...merged.term,
					...term,
					mode: "view",
					inner: (merged.term?.look as string | undefined) ?? dispatch.tool,
				},
			};
		}
	}
	const fallback =
		defaultPresenter.result?.(
			result,
			{ ...state, renderContext: { ...state.renderContext, label } },
			dispatch.args ?? {},
		) ?? {};
	const legacy = dispatch.args ? mounted?.legacy : undefined;
	if (legacy?.renderResult) {
		const drawing = legacyParts(legacy, dispatch.args, state, result);
		const view = legacyView(fallback, drawing);
		if (view !== fallback) {
			return {
				...fallback,
				body: view?.body,
				term: { ...term, mode: "legacy", parts: drawing.parts } satisfies ToolCommandTerm,
			};
		}
	}
	return { ...fallback, term: { ...term, mode: "view", inner: "default" } satisfies ToolCommandTerm };
}

/** Plain text of a head field. */
function plain(value: TspText | undefined): string | undefined {
	if (value === undefined) return undefined;
	return typeof value === "string" ? value : value.map(span => span.t).join("");
}

/** One-line head of a nested card: the renderer's label spans, else spans from its head facts. */
function nestedHead(view: ToolView, label: string, dispatch: ToolCommandDispatch): TspText {
	if (view.label !== undefined) return view.label;
	const head = view.head;
	const spans: TspSpan[] = [{ t: plain(head?.title) ?? label, s: "toolTitle strong" }];
	for (const detail of [plain(head?.target), ...(head?.meta ?? []).map(plain)]) {
		if (!detail) continue;
		spans.push({ t: " " }, { t: detail, s: "muted" });
	}
	const exit = head?.exit ?? (dispatch.exitCode !== 0 ? dispatch.exitCode : undefined);
	if (exit) spans.push({ t: " " }, { t: `exit ${exit}`, s: "error" });
	const note = plain(head?.note);
	if (note) spans.push({ t: " " }, { t: note, s: "muted" });
	return spans;
}

/** The nested card of one invocation inside a shell run. */
export function ToolCommandNode(props: {
	readonly input: ToolCommandInput;
	readonly state: ToolViewState;
	readonly nodeKey: string;
}): JSXNode {
	const view = toolCommandView(props.input, props.state);
	const label = toolCommandLabel(props.input.dispatch.tool, props.input.resolveMounted?.(props.input.dispatch.tool));
	const head = nestedHead(view, label, props.input.dispatch);
	return (
		<col
			key={props.nodeKey}
			role="omp.tool.bash.command-tool"
			gap="sm"
			// The wrapped look's own facts win: its painter draws the nested card from them.
			term={{ title: view.head?.title, target: view.head?.target, tone: view.tone, ...view.term }}
		>
			<text
				key="head"
				role="omp.tool.bash.command-tool.head"
				spans={typeof head === "string" ? [{ t: head }] : head}
				wrap="none"
				truncate="end"
			/>
			{view.body}
		</col>
	);
}

/** The `tools/tool-command` presenter: a dispatch input as the call's args. */
export const toolCommandPresenter: ToolPresenter<ToolCommandInput> = {
	call: (input, state) => toolCommandView(input, state),
};
