/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The transcript's tool block: one `tool` node per tool call.
 *
 * A {@link ToolCall} holds what the event stream reports about a call (args
 * as they stream, execution start, partial and final results, the user's
 * expand state, seal) and asks the call's presenter for a {@link ToolView}.
 * {@link ToolBlock} wraps that view in the `tool` node: head facts become the
 * node's props, the body its children, the call state its status/age/took.
 * A Tern terminal draws the node natively; the terminal backend paints it
 * with the `omp.tool.*` looks (`src/ui/styles/tools`).
 *
 * Merged presenters (`merge`) show the result view in place of the call's;
 * others stack the result body under the call body.
 */
import {
	type Accessor,
	computed,
	effect,
	isUiNode,
	type JSXNode,
	onCleanup,
	type Signal,
	signal,
	structural,
	type UiEvent,
	untrack,
} from "@oh-my-pi/pi-tui";
import {
	INTENT_FIELD,
	isShellTrace,
	type ShellTrace,
	type ShellVizPresentation,
	type TspCardStatus,
	type TspText,
	type TspTone,
	type TspToolProps,
	toolIntentLabel,
} from "@oh-my-pi/pi-wire";
import { registerBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { isRecord } from "@oh-my-pi/pi-utils";
import { readMediaPath } from "../../session/transcript/tool-execution";
import { readImageHeaderDimensions } from "../../utils/image-resize";
import { type ShellInspectorSource, shellVizEventAction } from "../apps/shell-visualizer/model";
import type { ToolTerm } from "../styles/tools/look";
import type { ToolActivity, ToolPresenter, ToolResult, ToolView, ToolViewState } from "../tools/contract";
import { defaultPresenter } from "../tools/default";
import { mcpPresenter } from "../tools/mcp";
import { toolPresenter } from "../tools/registry";
import { settledRevision } from "../shell/transcript";
import { presentShellScript, presentShellTrace } from "../tools/shell-viz";
import { imageBlob, inlineImageTerm } from "./messages/image";
import { presenterRows } from "./figures/presented-block";
import { RESULT_IMAGE_ROLE } from "./image-links";
import { ShellVizState } from "./shell-viz-state";
import type { ToolCommandResolver } from "../tools/tool-command";

/** An extension presenter's own compact row: its label and the rows below it (theme-token spans kept). */
export interface CompactRow {
	readonly label?: TspText;
	readonly rows?: readonly TspText[];
}

/**
 * How an extension transcript presenter wants a call shown: as usual, as a
 * compact line (optionally with its own label and rows), or not at all.
 */
export type ToolPresentation = "full" | "compact" | "hidden" | { readonly compact: CompactRow };

/** A tool result as the transcript receives it (images included). */
export interface ToolCallResult extends ToolResult {
	readonly content: readonly {
		readonly type: string;
		readonly text?: string;
		readonly data?: string;
		readonly mimeType?: string;
	}[];
}

export interface ToolCallOptions {
	/** The tool call id (the node's `key`). */
	readonly id: string;
	/** The wire tool name. */
	readonly name: string;
	/** The tool's display label ("Bash", "Custom Tool"); defaults to the name. */
	readonly label?: string;
	/** The call's args as first seen (they may still stream). */
	readonly args?: unknown;
	/** The presenter; defaults to the registered one for `name`, then the generic card. */
	readonly presenter?: ToolPresenter;
	/** The application clock in ms (call start, age and took are measured on it). */
	readonly now?: () => number;
	/** Host lookup of mounted tools behind a bash run's tool commands. */
	readonly resolveToolCommand?: ToolCommandResolver;
	/** Show bash commands through the shell engine's presentation (default on). */
	readonly shellVisualization?: boolean;
	/** Opens the focused inspector of a bash call's presentation (its `shell` node's `inspect`); the handle closes it. */
	readonly inspectShell?: (source: ShellInspectorSource) => { close(): void };
	/** Draw MCP text results as Markdown (`mcp.renderMarkdownResults`; default off). */
	readonly mcpMarkdown?: boolean;
}

/** Wire names of MCP tools (`mcp__<server>_<tool>`). */
const MCP_PREFIX = "mcp__";

/** Collapsed output rows of shell and eval results. */
const SHELL_PREVIEW_LINES = 10;
/** Longest shell timeout the transcript shows, in seconds. */
const MAX_TIMEOUT_SECONDS = 3600;

/** A result's text output (text blocks, image placeholders) without trailing blank lines. */
function resultOutput(result: ToolCallResult): string {
	const parts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && block.text !== undefined) parts.push(block.text);
	}
	for (const block of result.content) if (block.type === "image") parts.push(imagePlaceholder(block));
	return parts.join("\n").trimEnd();
}

/** A result's text blocks only, verbatim (what a shell run printed, its closing newline included). */
function resultTextOnly(result: ToolCallResult): string {
	const parts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && block.text !== undefined) parts.push(block.text);
	}
	return parts.join("\n");
}

/** The shell trace a bash frame or result carries (`details.trace`), when valid. */
/**
 * The trace a bash call presents after `result` arrived: the result's own, else the one `held` from
 * an earlier frame (a stopped run's last result carries none, and keeps showing what ran).
 */
function resultTrace(result: ToolCallResult, held: ShellTrace | undefined): ShellTrace | undefined {
	const details = result.details;
	if (typeof details !== "object" || details === null || !("trace" in details)) return held;
	if (details.trace === undefined) return held;
	return isShellTrace(details.trace) ? details.trace : undefined;
}

/** A tool call's live state and its presenter's view of it. */
export class ToolCall {
	readonly id: string;
	readonly name: string;
	readonly label: string;
	readonly presenter: ToolPresenter;
	readonly #now: () => number;
	readonly #args: Signal<unknown>;
	readonly #argsComplete = signal(false);
	readonly #startedAt = signal<number | undefined>(undefined);
	readonly #settledAt = signal<number | undefined>(undefined);
	readonly #result = signal<ToolCallResult | undefined>(undefined);
	readonly #partial = signal(false);
	readonly #expanded = signal(false);
	/** A native fold/unfold since the last expand change. */
	readonly #fold = signal<boolean | undefined>(undefined);
	readonly #sealed = signal(false);
	readonly #activityVisible = signal(true);
	readonly #showImages = signal(true);
	readonly #presentation = signal<ToolPresentation>("full");
	readonly #renderContext = signal<Readonly<Record<string, unknown>> | undefined>(undefined);
	readonly #streamPreview = signal<unknown>(undefined);
	readonly #resolveToolCommand: ToolCallOptions["resolveToolCommand"];
	/** A bash call's shell-viz state (undefined: another tool, or visualization off). */
	readonly #shell: ShellVizState | undefined;
	readonly #shellPresentation: Accessor<ShellVizPresentation | undefined>;
	readonly #inspectShell: ToolCallOptions["inspectShell"];
	#shellInspector: { close(): void } | undefined;
	/** Counts the user's changes to the card's shell view made by hand: a view action on the card, its inspector closing. */
	readonly #shellTouched = signal(0);
	/** The last trace a result carried: a later result without one (an abort) keeps presenting it. */
	#shellTrace: ShellTrace | undefined;

	/** What presenters see. */
	readonly state: Accessor<ToolViewState>;
	/** The presenter's view of the call (call and result combined). */
	readonly view: Accessor<ToolView | undefined>;

	constructor(options: ToolCallOptions) {
		this.id = options.id;
		this.name = options.name;
		this.label = options.label ?? options.name;
		this.presenter =
			options.presenter ??
			toolPresenter(options.name) ??
			(options.name.startsWith(MCP_PREFIX)
				? (mcpPresenter(this.label, {
						markdown: options.mcpMarkdown,
					}) as ToolPresenter)
				: defaultPresenter);
		this.#now = options.now ?? Date.now;
		this.#args = signal(options.args ?? {});
		this.#resolveToolCommand = options.resolveToolCommand;
		this.#inspectShell = options.inspectShell;
		this.#shell =
			options.name === "bash" && (options.shellVisualization ?? true)
				? new ShellVizState(() => this.#shellTrace)
				: undefined;
		this.#shellPresentation = computed(() => this.#presentShell());
		const renderContext = computed(() => this.#buildRenderContext());
		this.state = computed(() => {
			const startedAt = this.#startedAt();
			const settledAt = this.#settledAt();
			const result = this.#result();
			const elapsedMs = startedAt === undefined ? undefined : (settledAt ?? untrack(() => this.#now())) - startedAt;
			const cancelled = this.#sealed() && (result === undefined || this.#partial());
			return {
				// A native fold wins over the transcript's expand state until it changes.
				expanded: this.#fold() === undefined ? this.#expanded() : !this.#fold(),
				isPartial: result === undefined || this.#partial(),
				argsComplete: this.#argsComplete(),
				executionStarted: startedAt !== undefined,
				...(elapsedMs !== undefined ? { elapsedMs } : {}),
				...(cancelled ? { cancelled } : {}),
				renderContext: renderContext(),
			};
		});
		this.view = structural(() => {
			const state = this.state();
			const args = this.#args();
			const result = this.#result();
			// A call skipped to service steering input never ran: the generic card says so.
			const presenter = result && !this.#partial() && isInterruptSkip(result) ? defaultPresenter : this.presenter;
			const call = presenter.call?.(args, state);
			let view = call;
			if (result) {
				// The generic card names hidden images in its output; presenters get the result as it is.
				const shown = this.#showImages() || presenter !== defaultPresenter ? result : withImagesAsText(result);
				const outcome = presenter.result?.(shown, state, args);
				view = presenter.merge ? (outcome ?? call) : combineViews(call, outcome);
			}
			// A presenter's frameless default applies to views that do not say.
			return view && view.inline === undefined && presenter.inline ? { ...view, inline: true } : view;
		});
	}

	/** The args as they are now. */
	get args(): unknown {
		return this.#args.peek();
	}

	/** Streamed (or final) args. */
	updateArgs(args: unknown): void {
		this.#args.set(args);
	}

	/** The args are final (message end). */
	setArgsComplete(): void {
		this.#argsComplete.set(true);
	}

	/** The call began executing. */
	setExecutionStarted(): void {
		if (this.#startedAt.peek() === undefined) this.#startedAt.set(this.#now());
		this.#argsComplete.set(true);
	}

	/** A progress frame (`partial`) or the final result. */
	updateResult(result: ToolCallResult, partial: boolean): void {
		const old = this.#shellTrace;
		const trace = this.#shell && resultTrace(result, old);
		this.#shellTrace = trace || undefined;
		this.#result.set(result);
		if (trace && trace !== old) this.#shell?.adopt(old, trace);
		this.#partial.set(partial);
		if (!partial && this.#settledAt.peek() === undefined) this.#settledAt.set(this.#now());
	}

	/** The transcript's expand state (ctrl+o); resets any native fold. */
	setExpanded(expanded: boolean): void {
		this.#expanded.set(expanded);
		this.#fold.set(undefined);
	}

	/** A native fold toggle. */
	toggle(collapsed: boolean): void {
		this.#fold.set(collapsed);
	}

	/** No more events will arrive (turn over, or aborted while running). */
	seal(): void {
		if (this.#sealed.peek()) return;
		if (this.#settledAt.peek() === undefined && this.#startedAt.peek() !== undefined)
			this.#settledAt.set(this.#now());
		this.#sealed.set(true);
	}

	/** The user's "show tool activity" setting. */
	setActivityVisible(visible: boolean): void {
		this.#activityVisible.set(visible);
	}

	/** The user's "show images" setting. */
	setShowImages(show: boolean): void {
		this.#showImages.set(show);
	}

	/** An extension transcript presenter's answer for this call. */
	setPresentation(presentation: ToolPresentation): void {
		this.#presentation.set(presentation);
	}

	/** The edit preview a streaming edit-like call pushes (diffs per file). */
	updateStreamPreview(preview: unknown): void {
		this.#streamPreview.set(preview);
	}

	/**
	 * The command as the shell engine presents it under the call's view
	 * preferences: what of a traced run ran (loop iterations, bound values),
	 * before its first trace the command itself.
	 */
	#presentShell(): ShellVizPresentation | undefined {
		const shell = this.#shell;
		if (!shell) return undefined;
		const result = this.#result();
		const args = this.#args();
		const trace = result ? this.#shellTrace : undefined;
		const options = { preferences: shell.preferences(), ...(result ? { output: resultTextOnly(result) } : {}) };
		if (trace) return presentShellTrace(trace, options);
		const command = isRecord(args) ? args.command : undefined;
		return typeof command === "string" && command !== ""
			? presentShellScript(command, { ...options, streaming: !this.#argsComplete() })
			: undefined;
	}

	/**
	 * A shell-viz action on a bash call (`view:raw`, `layer:color`, `split`,
	 * `play`, `step`, `seek:3`, …) from its `shell` node or its inspector;
	 * `inspect` opens the inspector.
	 */
	shellVizAction(action: string): void {
		if (!this.#shell) return;
		if (action === "inspect") this.#openShellInspector();
		else this.#shell.action(action);
	}

	/** An event of the card's `shell` node. Selecting a step there is not a view preference. */
	readonly #shellEvent = (event: UiEvent): void => {
		const shell = this.#shell;
		const action = shell && shellVizEventAction(event, shell.preferences.peek());
		if (!action || action.startsWith("select:")) return;
		this.shellVizAction(action);
		if (action !== "inspect") this.#shellTouched.update(n => n + 1);
	};

	#openShellInspector(): void {
		const shell = this.#shell;
		if (!shell || !this.#inspectShell || this.#shellInspector) return;
		this.#shellInspector = this.#inspectShell({
			presentation: this.#shellPresentation,
			replayEpoch: shell.replayEpoch,
			liveOrigin: () => this.#startedAt() !== undefined,
			action: action => this.shellVizAction(action),
			close: () => this.closeShellInspector(),
		});
	}

	/** Stop a playing replay and take the inspector down (its Escape or close action; the block going away). */
	closeShellInspector(): void {
		this.#shell?.stop();
		const inspector = this.#shellInspector;
		if (!inspector) return;
		this.#shellInspector = undefined;
		inspector.close();
		this.#shellTouched.update(n => n + 1);
	}

	/**
	 * What the transcript threads to the presenter: the tool's label, the
	 * shell viewport (bash: output, expand state, preview rows, timeout,
	 * tool command lookup; eval: output once a result exists), whether a task
	 * has its result, a streaming edit preview, plus whatever the host set.
	 */
	#buildRenderContext(): Readonly<Record<string, unknown>> {
		const context: Record<string, unknown> = { label: this.label };
		const result = this.#result();
		const args = this.#args();
		const output = (): string => (result ? resultOutput(result) : "");
		if (this.name === "bash") {
			if (result) context.output = output();
			context.expanded = this.#expanded();
			context.previewLines = SHELL_PREVIEW_LINES;
			const timeout =
				args !== null && typeof args === "object" ? (args as { timeout?: unknown }).timeout : undefined;
			if (typeof timeout === "number" && Number.isFinite(timeout))
				context.timeout = Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, timeout));
			if (this.#resolveToolCommand) context.resolveToolCommandMounted = this.#resolveToolCommand;
			const presentation = this.#shellPresentation();
			if (presentation && this.#shell) {
				context.shellPresentation = presentation;
				context.shellReplayEpoch = this.#shell.replayEpoch();
				context.shellStep = { focus: [] };
				context.shellEvent = this.#shellEvent;
			}
		} else if (this.name === "eval" && result) {
			context.output = output();
			context.expanded = this.#expanded();
			context.previewLines = SHELL_PREVIEW_LINES;
		} else if (this.name === "task") {
			context.hasResult = result !== undefined;
			context.nowMs = untrack(() => this.#now());
		}
		const preview = this.#streamPreview();
		if (preview !== undefined) context.streamPreview = preview;
		return { ...context, ...this.#renderContext() };
	}

	/** Tool-specific context threaded to the presenter. */
	setRenderContext(context: Readonly<Record<string, unknown>> | undefined): void {
		this.#renderContext.set(context);
	}

	/**
	 * What the call is doing, for compact rows: the presenter's summary, else
	 * the label with the args' `command`/`path`/`input` (first line); a running
	 * call without a detail reads "running".
	 */
	readonly activity = (): ToolActivity => {
		const running = !this.#sealed() && (this.#result() === undefined || this.#partial());
		const args = this.#args();
		const summary = this.presenter.activity?.(args, this.state());
		if (summary) return summary.detail || !running ? summary : { ...summary, detail: "running" };
		if (args !== null && typeof args === "object") {
			for (const key of ["command", "path", "input"] as const) {
				const value = (args as Record<string, unknown>)[key];
				if (typeof value === "string" && value.length > 0)
					return { label: this.label, detail: value.split("\n", 1)[0] };
			}
		}
		return running ? { label: this.label, detail: "running" } : { label: this.label };
	};

	/** The call's status. */
	readonly status = (): TspCardStatus => {
		const result = this.#result();
		const started = this.#startedAt() !== undefined;
		if (result && !this.#partial()) {
			if (isInterruptSkip(result)) return "cancelled";
			return result.isError ? "error" : "done";
		}
		if (this.#sealed()) return "cancelled";
		return started ? "running" : "pending";
	};

	/** @internal Facts the block node reads. */
	get facts(): ToolCallFacts {
		return {
			result: this.#result,
			partial: this.#partial,
			startedAt: this.#startedAt,
			settledAt: this.#settledAt,
			expanded: this.#expanded,
			fold: this.#fold,
			sealed: this.#sealed,
			shellTouched: this.#shellTouched,
			activityVisible: this.#activityVisible,
			showImages: this.#showImages,
			presentation: () => (this.#expanded() ? "full" : this.#presentation()),
			activity: () => this.activity(),
			running: () => !this.#sealed() && (this.#result() === undefined || this.#partial()),
			args: this.#args,
			now: this.#now,
		};
	}
}

interface ToolCallFacts {
	readonly result: Accessor<ToolCallResult | undefined>;
	readonly partial: Accessor<boolean>;
	readonly startedAt: Accessor<number | undefined>;
	readonly settledAt: Accessor<number | undefined>;
	readonly expanded: Accessor<boolean>;
	readonly fold: Accessor<boolean | undefined>;
	readonly sealed: Accessor<boolean>;
	readonly shellTouched: Accessor<number>;
	readonly activityVisible: Accessor<boolean>;
	readonly showImages: Accessor<boolean>;
	readonly presentation: Accessor<ToolPresentation>;
	readonly activity: Accessor<ToolActivity>;
	readonly running: Accessor<boolean>;
	readonly args: Accessor<unknown>;
	readonly now: () => number;
}

function isInterruptSkip(result: ToolCallResult): boolean {
	const details = result.details as { source?: unknown } | undefined;
	return details?.source === "interrupt_skipped";
}

/** Image blocks as the placeholder text a terminal without images shows. */
function withImagesAsText(result: ToolCallResult): ToolCallResult {
	if (!result.content.some(block => block.type === "image")) return result;
	const content = result.content.map(block =>
		block.type === "image" ? { type: "text", text: imagePlaceholder(block) } : block,
	);
	return { ...result, content };
}

/** `[Image: [image/png] 1x1]`. */
export function imagePlaceholder(block: { readonly data?: string; readonly mimeType?: string }): string {
	const mime = block.mimeType ?? "image";
	// Same size source as the drawn `image` node, so the label a look prints matches the linked text.
	const size = block.data ? imageSize(Buffer.from(block.data, "base64")) : undefined;
	return `[Image: [${mime}]${size ? ` ${size.w}x${size.h}` : ""}]`;
}

/** Pixel size of decoded PNG/JPEG/GIF/WebP bytes, when the header says (the whole image is scanned for a JPEG SOF). */
export function imageSize(bytes: Uint8Array): { w: number; h: number } | undefined {
	const size = readImageHeaderDimensions(bytes);
	return size ? { w: size.width, h: size.height } : undefined;
}

/** Call view then result view: the result's head facts win; bodies stack. */
function combineViews(call: ToolView | undefined, result: ToolView | undefined): ToolView | undefined {
	if (!call) return result;
	if (!result) return call;
	return {
		...call,
		...result,
		head: call.head || result.head ? { ...call.head, ...result.head } : undefined,
		body: [call.body, result.body],
		term: call.term || result.term ? { ...call.term, ...result.term } : undefined,
	};
}

/** Body clamp of a view, as the `tool` node's `preview` prop. */
type ToolPreviewProp = { lines: number } | { tail: number } | "none" | "children";

/** Lines a collapsed body shows when the view sets no clamp. */
const DEFAULT_PREVIEW_LINES = 10;

/** The `tool` node props a call shows (everything but children). */
export interface ToolNodeProps {
	readonly name: string;
	readonly title: TspText;
	readonly status: TspCardStatus;
	readonly frame: "card" | "inline";
	readonly collapsible: boolean;
	readonly propKey?: string;
	readonly role?: string;
	readonly target?: TspText;
	readonly targetKind?: TspToolProps["targetKind"];
	readonly lang?: string;
	readonly command?: string;
	readonly href?: string;
	readonly meta?: readonly TspText[];
	readonly badges?: NonNullable<ToolView["head"]>["badges"];
	readonly age?: number;
	readonly took?: number;
	readonly exit?: number | null;
	readonly note?: TspText;
	readonly collapsed?: boolean;
	readonly preview?: ToolPreviewProp;
	readonly tone?: TspTone;
	readonly hidden?: boolean;
	readonly tools?: ToolView["tools"];
	/** The model's intent line (the call's `i` arg): Tern shows it while running and as the head's tooltip. */
	readonly intent?: string;
	readonly term: ToolTerm;
}

/** Inputs of {@link toolNodeProps}: one call's state at one moment. */
export interface ToolNodeInput {
	readonly id?: string;
	readonly name: string;
	readonly label: string;
	readonly view: ToolView | undefined;
	readonly status: TspCardStatus;
	readonly expanded: boolean;
	/** A native fold override. */
	readonly fold?: boolean;
	readonly startedAt?: number;
	/** Ms the call has been running (running) or ran (settled); undefined before it started. */
	readonly elapsedMs?: number;
	readonly sealedWithoutResult?: boolean;
	readonly interruptSkip?: boolean;
	readonly hidden?: boolean;
	readonly presentation?: ToolPresentation;
	/** The compact row's summary. */
	readonly activity?: ToolActivity;
	/** Still executing (no settled result, not sealed). */
	readonly running?: boolean;
	readonly hasBody: boolean;
	/** The presenter streams its body while live: the block stays open while pending/running. */
	readonly streamsBody?: boolean;
	readonly args?: unknown;
	/** Whether the terminal draws inline result pictures. */
	readonly showImages?: boolean;
	/** The result's image placeholders and the images they link to. */
	readonly imageLinks?: readonly ImagePlaceholderLink[];
}

/** An image placeholder (`[Image: [image/png] 1x1]`) a look may draw, and the image it opens. */
export interface ImagePlaceholderLink {
	readonly text: string;
	/** The image's blob. */
	readonly blob: string;
	/** The file the image was read from. */
	readonly source?: string;
}

/** A result image the transcript shows. */
interface ResultImage {
	readonly data: string;
	readonly mimeType?: string;
}

/**
 * A result's images in order: its image blocks, then those a progress frame
 * keeps in `details.images` (an eval run's, before its result carries them).
 */
function resultImages(result: ToolCallResult | undefined): ResultImage[] {
	if (!result) return [];
	const images: ResultImage[] = [];
	for (const block of result.content) {
		if (block.type === "image" && block.data) images.push({ data: block.data, mimeType: block.mimeType });
	}
	const details = result.details;
	if (typeof details !== "object" || details === null || !("images" in details) || !Array.isArray(details.images))
		return images;
	for (const image of details.images as unknown[]) {
		if (typeof image !== "object" || image === null || !("data" in image)) continue;
		if (typeof image.data !== "string" || !image.data) continue;
		const mimeType = "mimeType" in image && typeof image.mimeType === "string" ? image.mimeType : undefined;
		images.push({ data: image.data, mimeType });
	}
	return images;
}

/** The placeholders of a result's images, in order, with the images they link to. */
function imagePlaceholderLinks(result: ToolCallResult | undefined): readonly ImagePlaceholderLink[] | undefined {
	if (!result) return undefined;
	const source = readMediaPath(result.details);
	const links = resultImages(result).map(image => ({
		text: imagePlaceholder(image),
		blob: imageBlob({ data: image.data, mimeType: image.mimeType ?? "image/png" }),
		...(source ? { source } : {}),
	}));
	return links.length > 0 ? links : undefined;
}

/** The `tool` node props for one call state (pure; the block and the tool tests share it). */
export function toolNodeProps(input: ToolNodeInput): ToolNodeProps {
	const { view, status } = input;
	const head = view?.head;
	const presentation = input.presentation ?? "full";
	const compact = presentation !== "full" && presentation !== "hidden";
	const compactSpec = typeof presentation === "object" ? presentation.compact : undefined;
	const hasBody = compactSpec ? (compactSpec.rows?.length ?? 0) > 0 : input.hasBody;
	const preview: ToolPreviewProp | undefined = compact
		? compactSpec
			? { lines: compactSpec.rows?.length ?? 0 }
			: "none"
		: hasBody
			? view?.preview === undefined || view.preview === "auto"
				? view?.inline
					? "none"
					: { lines: DEFAULT_PREVIEW_LINES }
				: view.preview
			: undefined;
	const collapsible = hasBody || compact;
	const live = status === "pending" || status === "running";
	const collapsed = collapsible
		? view?.open === true && !compact
			? false
			: (input.fold ??
				(view?.folded === true ? true : !(input.expanded || (live && input.streamsBody === true && !compact))))
		: undefined;
	const settled = status !== "pending" && status !== "running";
	const tone: TspTone | undefined = input.interruptSkip ? "info" : view?.tone;
	const inline = compact || view?.inline === true;
	return {
		name: input.name,
		title: head?.title ?? view?.label ?? input.label,
		status,
		frame: inline ? "inline" : "card",
		collapsible,
		...(input.id !== undefined ? { propKey: input.id } : {}),
		role: `omp.tool.${input.name}`,
		...(compactSpec?.label !== undefined
			? { target: compactSpec.label, targetKind: "text" as const }
			: {
					target: head?.target,
					targetKind: head?.targetKind,
				}),
		lang: head?.lang,
		command: head?.command,
		href: head?.href,
		meta: head?.meta,
		badges: head?.badges,
		age: status === "running" ? (input.elapsedMs ?? 0) : undefined,
		took: settled && input.elapsedMs !== undefined ? input.elapsedMs : undefined,
		exit: head?.exit,
		note: input.sealedWithoutResult ? "cancelled" : head?.note,
		collapsed,
		preview,
		tone,
		hidden: input.hidden || presentation === "hidden" ? true : undefined,
		tools: view?.tools,
		intent: callIntent(input.args),
		term: {
			args: input.args,
			...view?.term,
			label: input.label,
			expanded: input.expanded,
			...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
			...(compact ? { compact: compactSpec ? "label" : "bare" } : {}),
			...(input.activity ? { activity: input.activity } : {}),
			...(input.running ? { running: true } : {}),
			...(view?.inline ? { inline: true } : {}),
			...(input.showImages === false ? { showImages: false } : {}),
			...(input.imageLinks ? { imageLinks: input.imageLinks } : {}),
		},
	};
}

/** A result's images as `image` nodes (shown under the body while images are on). */
function imageNodes(result: ToolCallResult | undefined): JSXNode {
	return resultImages(result).map((image, index) => {
		const bytes = Buffer.from(image.data, "base64");
		const size = imageSize(bytes);
		return (
			<image
				key={`img${index}`}
				term={inlineImageTerm({ role: RESULT_IMAGE_ROLE })}
				blob={registerBlob(bytes, image.mimeType ?? "image/png")}
				alt={image.mimeType}
				w={size?.w}
				h={size?.h}
			/>
		);
	});
}

/** Compact rows of an extension presenter, as the body text. */
function compactBody(presentation: ToolPresentation): JSXNode {
	if (typeof presentation !== "object") return undefined;
	const rows = presentation.compact.rows ?? [];
	if (rows.length === 0) return undefined;
	return <text spans={presenterRows(rows)} wrap="none" />;
}

/** The transcript tool block of `call`. */
export function ToolBlock(props: { readonly call: ToolCall }): JSXNode {
	const call = props.call;
	const facts = call.facts;
	const body = structural((): JSXNode => {
		const presentation = facts.presentation();
		if (typeof presentation === "object") return compactBody(presentation);
		const view = call.view();
		// Result images show under the body unless the view draws them itself.
		const drawsImages = flattenNodes(view?.body).some(node => {
			if (!isUiNode(node)) return false;
			if (node.kind === "image") return true;
			if (node.kind !== "media") return false;
			const props = untrack(node.props);
			return "path" in props && props.path === readMediaPath(facts.result()?.details);
		});
		const images = facts.showImages() && !drawsImages ? imageNodes(facts.result()) : undefined;
		return [view?.body, images];
	});
	const bodyNodes = structural(() => flattenNodes(body()));
	const imageLinks = computed(() => imagePlaceholderLinks(facts.result()));
	const nodeProps = computed(() => {
		const state = call.state();
		const result = facts.result();
		return toolNodeProps({
			id: call.id,
			name: call.name,
			label: call.label,
			view: call.view(),
			status: call.status(),
			expanded: state.expanded,
			fold: facts.fold(),
			startedAt: facts.startedAt(),
			elapsedMs: state.elapsedMs,
			sealedWithoutResult: facts.sealed() && (result === undefined || facts.partial()),
			interruptSkip: result !== undefined && !facts.partial() && isInterruptSkip(result),
			// A `wait` skipped for steering input waited for nothing: it leaves no card.
			hidden:
				!facts.activityVisible() ||
				(call.name === "wait" && result !== undefined && !facts.partial() && isInterruptSkip(result)),
			presentation: facts.presentation(),
			activity: facts.activity(),
			running: facts.running(),
			hasBody: bodyNodes().length > 0,
			streamsBody: call.presenter.streamsBody,
			args: facts.args(),
			showImages: facts.showImages(),
			imageLinks: imageLinks(),
		});
	});
	// The block going away takes its inspector with it and ends a playing replay.
	onCleanup(() => call.closeShellInspector());
	// Tern dropped a settled card's description: a shell view changed by hand describes it again.
	const revise = settledRevision();
	effect(() => {
		if (facts.shellTouched() > 0) untrack(revise);
	});
	const prop =
		<K extends keyof ToolNodeProps>(name: K): Accessor<ToolNodeProps[K]> =>
		() =>
			nodeProps()[name];
	return (
		<tool
			name={prop("name")}
			// KindAttributes maps TspText's union member-wise; the accessor yields either form.
			title={prop("title") as Accessor<string>}
			status={prop("status")}
			frame={prop("frame")}
			collapsible={prop("collapsible")}
			propKey={prop("propKey")}
			role={prop("role")}
			target={prop("target")}
			targetKind={prop("targetKind")}
			lang={prop("lang")}
			command={prop("command")}
			href={prop("href")}
			meta={prop("meta")}
			badges={prop("badges")}
			age={prop("age")}
			took={prop("took")}
			exit={prop("exit")}
			note={prop("note")}
			collapsed={prop("collapsed")}
			preview={prop("preview")}
			tone={prop("tone")}
			hidden={prop("hidden")}
			tools={prop("tools")}
			intent={prop("intent")}
			term={prop("term")}
			onToggle={collapsed => call.toggle(collapsed)}
		>
			{() => body()}
		</tool>
	);
}

/** The call's intent line (`i` arg), if it gave one: its brief label (`README` of `README: reflow the intro`). */
function callIntent(args: unknown): string | undefined {
	if (!isRecord(args)) return undefined;
	const intent = args[INTENT_FIELD];
	return typeof intent === "string" ? toolIntentLabel(intent).trim() || undefined : undefined;
}

/** Whether a JSX value holds any node (to tell an empty body from a real one). */
function flattenNodes(value: JSXNode): unknown[] {
	if (value === undefined || value === null || value === false || value === true || value === "") return [];
	if (Array.isArray(value)) return value.flatMap(item => flattenNodes(item as JSXNode));
	if (typeof value === "function") return flattenNodes(value());
	return [value];
}
