import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	Box,
	type Component,
	Container,
	getImageDimensions,
	Image,
	ImageProtocol,
	imageFallback,
	Spacer,
	TERMINAL,
	Text,
	type TUI,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import { getProjectDir, isRecord, logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { type PerFileDiffPreview, renderStreamingFallback } from "../../edit/renderer";
import type { Theme } from "../../modes/theme/theme";
import { getThemeEpoch, theme } from "../../modes/theme/theme";
import { BASH_DEFAULT_PREVIEW_LINES } from "../../tools/bash";
import { formatDefaultToolExecution } from "../../tools/default-renderer";
import { EVAL_DEFAULT_PREVIEW_LINES } from "../../tools/eval";
import { isWaitingPollDetails } from "../../tools/hub";
import { formatStatusIcon, replaceTabs, resolveImageOptions } from "../../tools/render-utils";
import {
	type FirstResultViewportRepaint,
	type ToolActivitySummary,
	type ToolRenderer,
	toolRenderers,
} from "../../tools/renderers";
import { TODO_STRIKE_TOTAL_FRAMES, type TodoToolDetails } from "../../tools/todo";
import type { XdevState } from "../../tools/xdev";
import type { EditMode } from "../../utils/edit-mode";
import { isFramedBlockComponent, markFramedBlockComponent, renderStatusLine, WidthAwareText } from "../../tui";
import { convertImageToPng } from "../../utils/image-loading";
import { sanitizeWithOptionalSixelPassthrough } from "../../utils/sixel";
import { renderDiff } from "./diff";
import { type AnimationFrame, trimBlankEdges } from "./transcript-container";

/** Resolves the canonical renderer key while retaining the provider's wire name in message history. */
export function toolRenderName(wireName: string, tool: AgentTool | undefined): string {
	return tool?.name ?? wireName;
}
type DisplaceableToolName = "hub" | "todo";

function isTodoToolDetails(details: unknown): details is TodoToolDetails {
	return (
		typeof details === "object" &&
		details !== null &&
		"phases" in details &&
		Array.isArray((details as { phases?: unknown }).phases)
	);
}

interface ToolImageBlock {
	data?: string;
	mimeType?: string;
}

function imageBlocksFromDetails(details: unknown): ToolImageBlock[] {
	if (!isRecord(details) || !Array.isArray(details.images)) return [];
	return details.images.filter(
		(image): image is ToolImageBlock =>
			isRecord(image) &&
			(image.data === undefined || typeof image.data === "string") &&
			(image.mimeType === undefined || typeof image.mimeType === "string"),
	);
}

function displaceableToolName(
	toolName: string,
	result: { details?: unknown; isError?: boolean },
	isPartial: boolean,
): DisplaceableToolName | undefined {
	if (result.isError === true) return undefined;
	if (toolName === "hub" && isWaitingPollDetails(result.details)) return "hub";
	if (toolName === "todo" && !isPartial && isTodoToolDetails(result.details)) return "todo";
	return undefined;
}

function isEditLikeToolName(toolName: string): boolean {
	return toolName === "edit" || toolName === "apply_patch";
}

function resolveEditModeForTool(toolName: string, tool: AgentTool | undefined): EditMode | undefined {
	if (toolName === "apply_patch") return "apply_patch";
	if (toolName !== "edit") return undefined;
	return (tool as { mode?: EditMode } | undefined)?.mode;
}

type ToolRendererStage = "call" | "result";

class SafeToolRendererComponent implements Component {
	#toolName: string;
	#stage: ToolRendererStage;
	#component: Component;
	#fallback: () => Component | undefined;
	#warned = false;
	readonly wantsKeyRelease: boolean | undefined;

	constructor(
		toolName: string,
		stage: ToolRendererStage,
		component: Component,
		fallback: () => Component | undefined,
	) {
		this.#toolName = toolName;
		this.#stage = stage;
		this.#component = component;
		this.#fallback = fallback;
		this.wantsKeyRelease = component.wantsKeyRelease;
		if (isFramedBlockComponent(component)) {
			markFramedBlockComponent(this);
		}
	}

	render(width: number): readonly string[] {
		try {
			return this.#component.render(width);
		} catch (err) {
			if (!this.#warned) {
				this.#warned = true;
				logger.warn("Tool renderer failed", { tool: this.#toolName, stage: this.#stage, error: String(err) });
			}
			return this.#fallback()?.render(width) ?? [];
		}
	}

	handleInput(data: string): void {
		const handleInput = this.#component.handleInput;
		if (handleInput === undefined) return;
		handleInput.call(this.#component, data);
	}

	invalidate(): void {
		const invalidate = this.#component.invalidate;
		if (invalidate === undefined) return;
		invalidate.call(this.#component);
	}

	setIgnoreTight(ignore: boolean): void {
		const setIgnoreTight = this.#component.setIgnoreTight;
		if (setIgnoreTight === undefined) return;
		setIgnoreTight.call(this.#component, ignore);
	}

	dispose(): void {
		const dispose = this.#component.dispose;
		if (dispose === undefined) return;
		dispose.call(this.#component);
	}
}

/** Minimal TUI surface ToolExecutionComponent uses to schedule repaints and share image budget. */
export interface ToolExecutionUi {
	requestRender(): void;
	requestComponentRender(component: Component): void;
	resetDisplay(): void;
	imageBudget?: TUI["imageBudget"];
}

export interface ToolExecutionOptions {
	showImages?: boolean; // default: true (only used if terminal supports images)
	/** Allow the name-keyed renderer registry only when the active tool is the built-in implementation. */
	useBuiltInRenderer?: boolean;
}

export interface ToolExecutionHandle extends Component {
	updateArgs(args: any, toolCallId?: string): void;
	updateStreamPreview?(update: unknown): void;
	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError?: boolean;
		},
		isPartial?: boolean,
		toolCallId?: string,
	): void;
	setArgsComplete(toolCallId?: string): void;
	setExecutionStarted(toolCallId?: string): void;
	setExpanded(expanded: boolean): void;
	setToolActivityVisible(visible: boolean): void;
	/** Mark the call parked: it returned, but stays tracked for async job frames. */
	parkAsBackground(): void;
	/** Seal the block as final history and stop its animations. */
	seal(): void;
}

/** Redraw live tool blocks at the spinner's glyph-advance rate. Rendering more
 * often produced identical frames — the previous 30fps cadence emitted ~2.4
 * paints per glyph step, and although the terminal I/O layer dedupes those, the
 * compose pipeline still ran end-to-end per frame (issue #4353). Matching the
 * render tick to the glyph tick halves the paints during tool execution with no
 * visible change. */
export const SPINNER_RENDER_INTERVAL_MS = 80;
/** Advance the spinner glyph at its classic ~12.5fps step (mirrors `Loader`). */
export const SPINNER_GLYPH_ADVANCE_MS = 80;

/** Phase-locked spinner glyph index shared by every live tool block so parallel
 * spinners advance in lockstep instead of each tracking its own start time. */
export function sharedSpinnerFrame(frameCount: number, now: number = performance.now()): number {
	return frameCount > 0 ? Math.floor(now / SPINNER_GLYPH_ADVANCE_MS) % frameCount : 0;
}

/** Live tool blocks currently driving a spinner. A single shared ticker (below)
 * advances and repaints every registered block per glyph step, so N concurrent
 * live/streaming blocks — e.g. parallel `task` subagents — cost one 80ms timer
 * and one coalesced render frame per tick instead of N unsynchronized timers
 * each independently waking the render scheduler (issue #8731). */
const liveSpinnerBlocks = new Set<ToolExecutionComponent>();
let sharedSpinnerTimer: NodeJS.Timeout | undefined;

/** Arm the shared spinner ticker if it is not already running. */
function ensureSharedSpinnerTicker(): void {
	if (sharedSpinnerTimer) return;
	sharedSpinnerTimer = setInterval(() => {
		const frame = sharedSpinnerFrame(theme.spinnerFrames.length);
		// Removing the current block mid-iteration is safe on a Set.
		for (const block of liveSpinnerBlocks) block.tickSpinner(frame);
	}, SPINNER_RENDER_INTERVAL_MS);
}

/** Register a live block with the shared ticker, starting it on first use. */
function registerSpinnerBlock(block: ToolExecutionComponent): void {
	liveSpinnerBlocks.add(block);
	ensureSharedSpinnerTicker();
}

/** Drop a block; stop the ticker once no live block remains. */
function unregisterSpinnerBlock(block: ToolExecutionComponent): void {
	if (!liveSpinnerBlocks.delete(block)) return;
	if (liveSpinnerBlocks.size === 0 && sharedSpinnerTimer) {
		clearInterval(sharedSpinnerTimer);
		sharedSpinnerTimer = undefined;
	}
}

/** Stop the shared spinner ticker and drop every registered live block.
 *  Called on interactive-mode teardown so a stray live block cannot keep the
 *  process-wide 80ms interval alive past shutdown (lingering event-loop
 *  handles pin the process; cf. `postmortem.quit`). Test files that assert on
 *  ticker arming also use this to start from a clean slate. */
export function stopSharedSpinnerTicker(): void {
	liveSpinnerBlocks.clear();
	if (sharedSpinnerTimer) {
		clearInterval(sharedSpinnerTimer);
		sharedSpinnerTimer = undefined;
	}
}

// Stable per-instance counter so each tool execution's inline images get a
// graphics id that survives child re-creation (the image budget keys off it).
let toolExecutionInstanceSeq = 0;

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container {
	#contentBox: Box; // Used for custom tools and bash visual truncation
	#contentText: WidthAwareText; // Generic fallback (no custom/built-in renderer)
	// Which container the constructor mounted: bespoke/built-in renderers use
	// #contentBox, everything else the generic #contentText fallback.
	#usesContentBox = false;
	#multiFileBoxes: (Box | Spacer)[] = []; // Extra boxes for multi-file edit results
	#imageComponents: Image[] = [];
	#imageSpacers: Spacer[] = [];
	readonly #instanceId = ++toolExecutionInstanceSeq;
	#toolName: string;
	#toolLabel: string;
	#args: any;
	#expanded = false;
	#allocation = Number.POSITIVE_INFINITY;
	#presentationFrame: AnimationFrame = { tick: 0, now: 0 };
	#toolActivityVisible = true;
	#showImages: boolean;
	#isPartial = true;
	// A background task whose call already returned; later async job frames are
	// partial updates, but the block is ready to retire as history.
	#parkedBackground = false;
	#resultVersion = 0;
	// Post-finalize mutation counter (see FinalizableBlock.getTranscriptBlockVersion):
	// a tool block can keep changing after isTranscriptBlockFinalized() first
	// returns true — an async task's terminal result settlement, seal(), or an
	// expansion toggle — and the transcript's width-epoch resolution and
	// committed-render bypass must observe those mutations.
	#blockVersion = 0;
	#lastDisplayKey: string | undefined;
	// Bumped whenever a render input that #rebuildDisplay consumes but the memo
	// key cannot cheaply hash changes: streamed call args, native edit-diff
	// previews, and Kitty PNG conversions. Folded into the dirty key so those
	// updates are not swallowed by the memo (see #updateDisplay).
	#displayInputVersion = 0;
	// Set once #rebuildDisplay has populated the display. Replaces a
	// #contentBox.children.length probe so the memo fast-path also covers the
	// #contentText fallback path (which leaves #contentBox empty).
	#displayBuilt = false;
	// Number of Image children the last rebuild emitted. Only when this is > 0 does
	// the memo key fold in viewport-dependent image sizing (resolveImageOptions),
	// so a terminal resize re-shapes image-bearing results to rescale them without
	// forcing the common image-free result to re-shape on every resize tick.
	#renderedImageCount = 0;
	#tool?: AgentTool;
	#renderer?: ToolRenderer;
	#ui: ToolExecutionUi;
	#result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError?: boolean;
		details?: any;
	};
	// Edit preview state
	#editMode?: EditMode;
	#editDiffPreview?: PerFileDiffPreview[];
	#previewReady?: PromiseWithResolvers<void>;
	// Cached converted images for Kitty protocol (which requires PNG), keyed by index
	#convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	// Spinner animation for partial task results
	#spinnerFrame?: number;
	#spinnerActive = false;
	// Todo write completion strikethrough reveal animation
	#todoStrikeInterval?: NodeJS.Timeout;
	// Track if args are still being streamed (for edit/write spinner)
	#argsComplete = false;
	#executionStarted = false;
	// Sealed once the tool reaches a terminal state (result delivered, or the
	// turn abandoned it without one). Until then the block remains active so a
	// late result can update its streaming preview.
	#sealed = false;
	// Tool result snapshots that may be superseded by a later same-tool call
	// while still in the mutable viewport. `hub` uses this for repeated all-running polls; `todo` uses
	// it for per-turn state snapshots so only the latest list remains visible.
	#displaceableByToolName: DisplaceableToolName | undefined;
	// Execution start on the presentation clock (performance.now domain, the
	// same domain as AnimationFrame.now supplied by the transcript allocator).
	#executionStartedAtNow: number | undefined;
	// Wall clock captured whenever a task card is rebuilt.
	#taskRenderNowMs = Date.now();
	// Set on each `render()` when the last painted pending shape must be
	// replayed wholesale when the first result arrives. Reset gates key off
	// these so a topology-changing update that lands before the shape reaches
	// the terminal never triggers an unnecessary full-viewport replay.
	#firstResultViewportRepaintShapePainted = false;
	#partialResultShapePainted = false;
	#renderState: {
		spinnerFrame?: number;
		expanded: boolean;
		isPartial: boolean;
		argsComplete?: boolean;
		executionStarted?: boolean;
		renderContext?: Record<string, unknown>;
	} = {
		expanded: false,
		isPartial: true,
		argsComplete: false,
		executionStarted: false,
	};

	constructor(
		toolName: string,
		args: any,
		options: ToolExecutionOptions = {},
		tool: AgentTool | undefined,
		ui: ToolExecutionUi,
		_cwd: string = getProjectDir(),
		_toolCallId?: string,
	) {
		super();
		this.#toolName = toolName;
		this.#toolLabel = tool?.label ?? toolName;
		this.#renderer = options.useBuiltInRenderer === false ? undefined : toolRenderers[toolName];
		this.#showImages = options.showImages ?? true;
		this.#tool = tool;
		this.#ui = ui;
		this.#args = args;
		this.#editMode = resolveEditModeForTool(toolName, tool);
		if (this.#editMode) this.#previewReady = Promise.withResolvers<void>();

		// Always create both - contentBox for custom tools/bash/tools with renderers, contentText for other built-ins.
		// paddingY is 1 so background-tinted blocks (custom/extension tools and the
		// generic fallback) get top/bottom breathing room. TranscriptContainer
		// strips PLAIN-blank edges, so framed/minimal blocks (no bg set) drop these
		// lines and keep their tight spacing — only tinted lines survive.
		this.#contentBox = new Box(0, 1);
		this.#contentText = new WidthAwareText(contentWidth => this.#renderDefaultCard(contentWidth), 1, 1);

		// Use Box for custom tools or built-in tools with rich renderers.
		const hasCustomRenderer = !!(tool?.renderCall || tool?.renderResult);
		this.#usesContentBox = hasCustomRenderer || this.#renderer !== undefined;
		if (this.#usesContentBox) {
			this.addChild(this.#contentBox);
		} else {
			this.addChild(this.#contentText);
		}
		// Tool blocks are visually distinct cards (background-tinted or framed),
		// so keep their horizontal padding even when the user enables tight layout.
		this.setIgnoreTight(true);

		this.#updateSpinnerAnimation();
		this.#updateDisplay();
	}

	updateArgs(args: any, _toolCallId?: string): void {
		// Reference-equality short-circuit before any further work. Callers
		// always allocate a new arg object on each streamed delta (see
		// event-controller.ts and ui-helpers.ts), so a same-reference assignment
		// signals "nothing meaningful changed" and the renderer can skip.
		if (args === this.#args) return;
		this.#args = args;
		this.#displayInputVersion++;
		this.#updateSpinnerAnimation();
		this.#updateDisplay();
	}

	/**
	 * Signal that args are complete (tool is about to execute).
	 * This triggers an immediate final diff computation for edit-like tools.
	 */
	setArgsComplete(_toolCallId?: string): void {
		const alreadyComplete = this.#argsComplete;
		this.#argsComplete = true;
		this.#updateSpinnerAnimation();
		if (alreadyComplete) return;
		this.#displayInputVersion++;
		this.#updateDisplay();
	}

	/**
	 * Signal that this specific call has begun executing (`tool_execution_start`).
	 * Distinct from {@link setArgsComplete}: exclusive writes are marked complete
	 * at `message_end` but stay queued until this fires for that call.
	 */
	setExecutionStarted(_toolCallId?: string): void {
		if (this.#executionStarted) return;
		this.#executionStarted = true;
		this.#executionStartedAtNow = performance.now();
		this.#argsComplete = true;
		this.#updateSpinnerAnimation();
		this.#displayInputVersion++;
		this.#updateDisplay();
	}

	/**
	 * Resolve once the final (`streaming: false`) preview batch lands or the
	 * result settles. Callers without a live batch source (gallery snapshots)
	 * pass a budget so a component that will never receive a batch cannot
	 * hang them; live approval gates omit it and wait indefinitely.
	 */
	async whenPreviewSettled(timeoutMs?: number): Promise<void> {
		if (this.#previewReady === undefined) return;
		if (timeoutMs === undefined) {
			await this.#previewReady.promise;
			return;
		}
		await Promise.race([this.#previewReady.promise, Bun.sleep(timeoutMs)]);
	}

	updateStreamPreview(update: unknown): void {
		if (
			this.#previewDiffSettled() ||
			update === null ||
			typeof update !== "object" ||
			!("files" in update) ||
			!Array.isArray(update.files)
		) {
			return;
		}
		if ("streaming" in update && update.streaming === false) this.#previewReady?.resolve();
		if (update.files.length === 0) return;
		const rawFiles: unknown[] = update.files;
		const files = rawFiles.filter(
			(
				file,
			): file is {
				path: string;
				diff?: string | null;
				firstChangedLine?: number | null;
				error?: string | null;
			} => file !== null && typeof file === "object" && "path" in file && typeof file.path === "string",
		);
		if (files.length === 0) return;
		this.#editDiffPreview = files.map(file => ({
			path: file.path,
			diff: file.diff ?? undefined,
			firstChangedLine: file.firstChangedLine ?? undefined,
			error: file.error ?? undefined,
		}));
		this.#displayInputVersion++;
		this.#updateDisplay();
		this.#ui.requestRender();
	}

	/**
	 * True once a terminal result makes the streaming preview moot: renderResult
	 * prefers `details.diff` and renders errors from the result text, consulting
	 * the computed preview only for a non-error result that carries no details.
	 */
	#previewDiffSettled(): boolean {
		const result = this.#result;
		return result !== undefined && !this.#isPartial && (result.isError === true || result.details != null);
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError?: boolean;
		},
		isPartial = false,
		_toolCallId?: string,
	): void {
		const hadNoResult = this.#result === undefined;
		const wasPartialResult = this.#result !== undefined && this.#isPartial;
		const firstResultRepaintShapePainted = this.#firstResultViewportRepaintShapePainted;
		const partialResultPainted = this.#partialResultShapePainted;
		this.#firstResultViewportRepaintShapePainted = false;
		this.#partialResultShapePainted = false;
		this.#result = result;
		this.#resultVersion++;
		this.#blockVersion++;
		this.#isPartial = isPartial;
		this.#displaceableByToolName = displaceableToolName(this.#toolName, result, isPartial);
		// When tool is complete, ensure args are marked complete so spinner stops
		if (!isPartial) {
			this.#argsComplete = true;
			this.#previewReady?.resolve();
		}
		this.#updateSpinnerAnimation();
		this.#updateTodoStrikeAnimation();
		this.#updateDisplay();
		this.#resetDisplayForResultTopologyChange(
			hadNoResult && firstResultRepaintShapePainted,
			wasPartialResult && partialResultPainted,
			isPartial,
		);
		// Convert non-PNG images to PNG for Kitty protocol (async)
		this.#maybeConvertImagesForKitty();
	}

	/**
	 * Get all image blocks from result content and details.
	 * Some tools (like generate_image) store images in details to avoid bloating
	 * model context. Xdev-dispatched tools preserve those details under
	 * details.xdev.inner.
	 */
	#getAllImageBlocks(): ToolImageBlock[] {
		if (!this.#result) return [];
		const contentImages = this.#result.content.filter(block => block.type === "image");
		const details = this.#result.details;
		const detailImages = imageBlocksFromDetails(details);
		const xdevImages = isRecord(details) && isRecord(details.xdev) ? imageBlocksFromDetails(details.xdev.inner) : [];
		return [...contentImages, ...detailImages, ...xdevImages];
	}

	/**
	 * Convert non-PNG images to PNG for Kitty graphics protocol.
	 * Kitty requires PNG format (f=100), so JPEG/GIF/WebP won't display.
	 */
	#maybeConvertImagesForKitty(): void {
		// Only needed for Kitty protocol
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		if (!this.#result) return;

		const imageBlocks = this.#getAllImageBlocks();

		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			// Skip if already PNG or already converted
			if (img.mimeType === "image/png") continue;
			if (this.#convertedImages.has(i)) continue;

			// Convert async - catch errors from processing
			const index = i;
			convertImageToPng({ type: "image", data: img.data, mimeType: img.mimeType })
				.then(converted => {
					this.#convertedImages.set(index, converted);
					this.#displayInputVersion++;
					this.#updateDisplay();
					this.#ui.requestRender();
				})
				.catch(() => {
					// Ignore conversion failures - display will use original image format
				});
		}
	}

	/**
	 * Start or stop spinner animation for live states that visibly tick.
	 */
	#updateSpinnerAnimation(): void {
		// Live partial tool blocks stay repaintable until a terminal result seals
		// them. Todo snapshots and detached background tool progress are deliberate
		// static exceptions because their rows can be superseded or committed to
		// scrollback while later updates continue elsewhere.
		const isStreamingArgs = !this.#argsComplete && (isEditLikeToolName(this.#toolName) || this.#toolName === "write");
		const isBackgroundAsyncRunning =
			(this.#result?.details as { async?: { state?: string } } | undefined)?.async?.state === "running";
		const renderer = this.#renderer;
		const pendingAnimation = renderer?.animatedPendingPreview;
		const partialAnimation = renderer?.animatedPartialResult;
		const pendingCallConsumesSpinner =
			this.#result === undefined &&
			(renderer === undefined
				? // Only the generic #formatToolExecution fallback consumes the frame;
					// a custom renderCall/renderResult pair routes through the custom
					// branch whose pending label is a static tool-name Text.
					!this.#tool?.renderCall && !this.#tool?.renderResult
				: typeof pendingAnimation === "function"
					? pendingAnimation(this.#args)
					: pendingAnimation === true);
		const partialResultConsumesSpinner =
			this.#result !== undefined &&
			(renderer === undefined
				? !this.#tool?.renderCall && !this.#tool?.renderResult
				: typeof partialAnimation === "function"
					? partialAnimation(this.#args)
					: partialAnimation === true);
		const isLivePartialTool =
			this.#isPartial &&
			this.#toolName !== "todo" &&
			!isBackgroundAsyncRunning &&
			(pendingCallConsumesSpinner || partialResultConsumesSpinner);
		const needsSpinner = isStreamingArgs || isLivePartialTool || this.#displaceableByToolName === "hub";
		if (needsSpinner && !this.#spinnerActive) {
			const frameCount = theme.spinnerFrames.length;
			const frame = sharedSpinnerFrame(frameCount);
			this.#spinnerFrame = frame;
			this.#renderState.spinnerFrame = frame;
			this.#spinnerActive = true;
			registerSpinnerBlock(this);
		} else if (!needsSpinner && this.#spinnerActive) {
			this.#spinnerActive = false;
			unregisterSpinnerBlock(this);
			// Clear the last drawn frame so a non-live renderCall (e.g. a write whose
			// args just completed) stops showing a frozen spinner glyph. Skip when a
			// todo strike owns the frame — it sets its own value right after this.
			if (!this.#todoStrikeInterval) {
				this.#spinnerFrame = undefined;
				this.#renderState.spinnerFrame = undefined;
			}
		}
	}

	/**
	 * Advance to the shared spinner glyph and repaint just this block. Driven by
	 * the single shared spinner ticker (see `registerSpinnerBlock`); the tick is
	 * component-scoped so the TUI reuses every other root subtree (issue #4377).
	 */
	tickSpinner(frame: number): void {
		this.#spinnerFrame = frame;
		this.#renderState.spinnerFrame = frame;
		this.#ui.requestComponentRender(this);
	}

	#updateTodoStrikeAnimation(): void {
		if (this.#toolName !== "todo" || this.#isPartial || this.#result?.isError) {
			this.#stopTodoStrikeAnimation();
			return;
		}
		const completedTasks = (this.#result?.details as { completedTasks?: unknown[] } | undefined)?.completedTasks;
		if (!completedTasks || completedTasks.length === 0) {
			this.#stopTodoStrikeAnimation();
			return;
		}
		if (this.#todoStrikeInterval) return;

		this.#spinnerFrame = 0;
		this.#renderState.spinnerFrame = 0;
		this.#todoStrikeInterval = setInterval(() => {
			const nextFrame = (this.#spinnerFrame ?? 0) + 1;
			if (nextFrame > TODO_STRIKE_TOTAL_FRAMES) {
				this.#stopTodoStrikeAnimation();
			} else {
				this.#spinnerFrame = nextFrame;
				this.#renderState.spinnerFrame = nextFrame;
			}
			// Component-scoped: strike animation only mutates this tool block's
			// glyph, so the TUI reuses every other root subtree (issue #4377).
			this.#ui.requestComponentRender(this);
		}, 65);
	}

	#stopTodoStrikeAnimation(): void {
		if (this.#todoStrikeInterval) {
			clearInterval(this.#todoStrikeInterval);
			this.#todoStrikeInterval = undefined;
		}
		if (!this.#spinnerActive) {
			this.#spinnerFrame = undefined;
			this.#renderState.spinnerFrame = undefined;
		}
	}

	/**
	 * Whether this block is ready to retire as immutable history. Partial
	 * results, including detached background tasks, remain active and mutable
	 * until they settle. Hidden blocks render no rows and cannot gate history.
	 */
	isTranscriptBlockFinalized(): boolean {
		if (!this.#toolActivityVisible) return true;
		if (this.#sealed) return true;
		if (this.#result === undefined) return false;
		// A parked background task's call already returned; job frames that land
		// while it is still live keep updating it, but it must not gate history.
		if (this.#parkedBackground) return true;
		return !this.#isPartial;
	}

	getTranscriptBlockVersion(): number {
		return this.#blockVersion;
	}
	/** Mark the call parked: it returned, but stays tracked for async job frames. */
	parkAsBackground(): void {
		this.#parkedBackground = true;
	}

	/**
	 * Mark the tool terminal even though no result arrived (the turn aborted or
	 * abandoned it) and stop animating so the container can retire it.
	 */
	seal(): void {
		if (this.#sealed) return;
		this.#sealed = true;
		this.#blockVersion++;
		this.#displaceableByToolName = undefined;
		this.stopAnimation();
		this.#updateDisplay();
		this.#ui.requestRender();
	}

	/**
	 * Whether this block is a supersedable result snapshot that has not been
	 * sealed. Displacement is best-effort: the snapshot finalizes like any other
	 * block, so under capacity pressure it may retire to native scrollback
	 * first — then the follow-up call appends a fresh snapshot instead of
	 * removing this one (see {@link TranscriptContainer.canRemoveBlock}).
	 */
	isDisplaceableBlock(): boolean {
		return this.#displaceableByToolName !== undefined && !this.#sealed;
	}

	canBeDisplacedBy(nextToolName: string | undefined): boolean {
		return (
			this.#displaceableByToolName !== undefined && this.#displaceableByToolName === nextToolName && !this.#sealed
		);
	}

	/**
	 * A live block torn down through the generic Container path (transcript
	 * clear, session switch mid-run) must not leak its shared-ticker
	 * registration: the dead component would keep the process-wide 80ms
	 * interval alive and keep being repainted.
	 */
	override dispose(): void {
		this.stopAnimation();
		super.dispose();
	}

	/**
	 * Stop spinner animation and cleanup resources.
	 */
	stopAnimation(): void {
		if (this.#spinnerActive) {
			this.#spinnerActive = false;
			unregisterSpinnerBlock(this);
			this.#spinnerFrame = undefined;
			this.#renderState.spinnerFrame = undefined;
		}
		this.#stopTodoStrikeAnimation();
		this.#previewReady?.resolve();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) this.#blockVersion++;
		this.#expanded = expanded;
		this.#updateDisplay();
	}

	/** Apply the transcript allocator's current viewport reservation. */
	setTranscriptAllocation(rows: number, frame: AnimationFrame): void {
		this.#allocation = Math.max(0, Math.trunc(rows));
		this.#presentationFrame = frame;
	}

	setToolActivityVisible(visible: boolean): void {
		this.#toolActivityVisible = visible;
		super.invalidate();
	}

	setShowImages(show: boolean): void {
		this.#showImages = show;
		this.#updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.#updateDisplay();
	}

	#updateDisplay(): void {
		// `TERMINAL.imageProtocol` is resolved by an async capability probe during
		// TUI startup, so a result rendered before it lands must re-shape once it
		// does (it gates Image children vs text fallback in #rebuildDisplay); keyed
		// here for the same reason markdown.ts keys its render cache on it.
		const key = `${this.#resultVersion}|${this.#expanded}|${this.#isPartial}|${this.#argsComplete ? "1" : "0"}|${this.#executionStarted ? "1" : "0"}|${this.#spinnerFrame ?? "-"}|${this.#showImages}|${getThemeEpoch()}|${this.#displayInputVersion}|${TERMINAL.imageProtocol ?? "-"}|${this.#imageSizeKey()}`;
		if (key === this.#lastDisplayKey && this.#displayBuilt) return;
		this.#lastDisplayKey = key;

		this.#rebuildDisplay();
		this.#displayBuilt = true;
	}

	#rendererFlag(name: "forceResultViewportRepaintOnSettle"): boolean {
		const toolValue = (this.#tool as Record<string, unknown> | undefined)?.[name];
		const rendererValue = this.#renderer?.[name];
		return toolValue === true || (toolValue === undefined && rendererValue === true);
	}

	/**
	 * True while the last painted pending-call shape opted into a full viewport
	 * repaint at the first result (`forceFirstResultViewportRepaint`) — e.g. a
	 * collapsed write tail window, which the first result render re-anchors
	 * instead of preserving. Kept as a per-paint fact so a topology-changing update that
	 * lands before the pending rows reach the terminal skips the reset.
	 */
	#needsFirstResultViewportRepaintAtRender(): boolean {
		if (this.#result !== undefined) return false;
		const toolValue = (this.#tool as { forceFirstResultViewportRepaint?: FirstResultViewportRepaint } | undefined)
			?.forceFirstResultViewportRepaint;
		const value = toolValue !== undefined ? toolValue : this.#renderer?.forceFirstResultViewportRepaint;
		if (typeof value === "function") return value(this.#args, this.#renderState);
		return value === true;
	}

	#resetDisplayForResultTopologyChange(
		firstResultAfterRepaintShapePaint: boolean,
		partialResultPaintedBeforeSettle: boolean,
		isPartial: boolean,
	): void {
		const provisionalResultSettled =
			partialResultPaintedBeforeSettle && !isPartial && this.#rendererFlag("forceResultViewportRepaintOnSettle");
		if (firstResultAfterRepaintShapePaint || provisionalResultSettled) {
			this.#ui.requestRender();
		}
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible || this.#allocation === 0) return [];
		let lines = super.render(width);
		if (this.#allocation < 3) {
			// A squeezed allocation degrades only blocks that genuinely overflow it.
			// The allocator measures blocks by trimmed height and never squeezes one
			// below that, so inline tools whose real content is 1-2 rows (hub
			// receipts, one-line results) keep that content instead of an equally
			// tall but contentless frame.
			const trimmed = trimBlankEdges(lines);
			if (trimmed.length > this.#allocation) return this.#renderCompact(width);
			lines = trimmed;
		}
		this.#firstResultViewportRepaintShapePainted = this.#needsFirstResultViewportRepaintAtRender();
		this.#partialResultShapePainted = this.#result !== undefined && this.#isPartial;
		return lines;
	}

	#renderCompact(width: number): readonly string[] {
		const summary = this.#activitySummary();
		const detail = summary.detail ? theme.fg("muted", ` · ${summary.detail.replace(/\s+/g, " ")}`) : "";
		// Elapsed ticks only while the call is genuinely running; a settled
		// placeholder row must not read as live ("Todo · running 0s").
		const elapsed =
			this.#isRunning() && this.#executionStartedAtNow !== undefined
				? theme.fg(
						"dim",
						` ${Math.max(0, Math.floor((this.#presentationFrame.now - this.#executionStartedAtNow) / 1000))}s`,
					)
				: "";
		const text = truncateToWidth(
			`${theme.fg("toolTitle", theme.bold(summary.label))}${detail}${elapsed}`,
			Math.max(1, width - 4),
		);
		if (this.#allocation === 1) {
			const glyph = this.#spinnerFrame === undefined ? "•" : (theme.spinnerFrames[this.#spinnerFrame] ?? "•");
			const styledGlyph = theme.fg(this.#spinnerFrame === undefined ? "dim" : "muted", glyph);
			return [truncateToWidth(`${styledGlyph} ${text}`, width)];
		}
		return [truncateToWidth(`${theme.fg("dim", "╭─")} ${text}`, width), theme.fg("dim", "╰")];
	}

	#activitySummary(): ToolActivitySummary {
		this.#renderState.renderContext ??= this.#buildRenderContext();
		const summary = this.#renderer?.activitySummary?.(this.#args, {
			expanded: this.#expanded,
			isPartial: this.#isPartial,
			spinnerFrame: this.#spinnerFrame,
			renderContext: this.#renderState.renderContext,
		});
		if (summary !== undefined) {
			if (summary.detail) return summary;
			// A detail-less custom summary (e.g. hub before its streamed args
			// parse) must not fold to a bare `╭─ Label` frame under viewport
			// pressure — keep the generic liveness hint for in-flight calls.
			return this.#isRunning() ? { ...summary, detail: "running" } : summary;
		}
		if (isRecord(this.#args)) {
			for (const key of ["command", "path", "input"] as const) {
				const value = this.#args[key];
				if (typeof value === "string" && value.length > 0) {
					return { label: this.#toolLabel, detail: value.split("\n", 1)[0] };
				}
			}
		}
		return { label: this.#toolLabel, detail: this.#isRunning() ? "running" : undefined };
	}
	/** Still executing: no settled result yet and the turn has not sealed it. */
	#isRunning(): boolean {
		return !this.#sealed && (this.#result === undefined || this.#isPartial);
	}

	// Viewport-/settings-dependent image sizing folded into the memo key only when
	// the last rebuild actually emitted images, so a terminal resize re-shapes an
	// image-bearing result (to rescale it) without re-shaping every image-free
	// result on each resize tick.
	#imageSizeKey(): string {
		if (this.#renderedImageCount === 0) return "-";
		const o = resolveImageOptions();
		return `${o.maxWidthCells}:${o.maxHeightCells ?? "-"}`;
	}

	#rebuildDisplay(): void {
		// Sync shared mutable render state for component closures
		this.#renderState.expanded = this.#expanded;
		this.#renderState.isPartial = this.#isPartial;
		this.#renderState.argsComplete = this.#argsComplete;
		this.#renderState.executionStarted = this.#executionStarted;
		this.#renderState.spinnerFrame = this.#spinnerFrame;

		// Non-self-framing tools (custom/extension renderers and the generic
		// fallback) get a padded, state-tinted block — built-ins that draw their
		// own frame opt out below via the framed-component mark. A benign skip
		// (steering/peer interrupt aborted a still-pending call) never ran, so it
		// gets the neutral pending tint rather than the error tint (#7199).
		const benignSkip = this.#isBenignSkip();
		const stateBgKey =
			this.#isPartial || benignSkip ? "toolPendingBg" : this.#result?.isError ? "toolErrorBg" : "toolSuccessBg";
		const stateBgFn = (t: string) => theme.bg(stateBgKey, t);

		// A benign skip is a synthetic placeholder for a call that never executed,
		// so bypass any bespoke error frame and draw the neutral generic card —
		// the per-tool ✘/red-border would misread normal mid-turn steering as a
		// failure (#7199).
		if (benignSkip) {
			this.#renderBenignSkipCard(stateBgFn);
		} else if (this.#tool && (this.#tool.renderCall || this.#tool.renderResult)) {
			const tool = this.#tool;
			const mergeCallAndResult = Boolean((tool as { mergeCallAndResult?: boolean }).mergeCallAndResult);
			// Custom tools use Box for flexible component rendering
			this.#contentBox.setBgFn(undefined);
			this.#contentBox.clear();
			// Mirror the built-in renderer branch so custom renderers (notably the
			// task tool, whose live instance routes through here) receive the same
			// render context — e.g. the `hasResult` flag that suppresses the task
			// call preview once result lines exist.
			this.#renderState.renderContext = this.#buildRenderContext();

			// Render call component. The fallback label only stands in for a
			// missing `renderCall`; when the call is intentionally suppressed
			// (mergeCallAndResult once a result exists) we render nothing here so
			// the result component isn't preceded by a redundant tool-name line.
			const shouldRenderCall = !this.#result || !mergeCallAndResult;
			if (shouldRenderCall) {
				if (tool.renderCall) {
					try {
						const callArgs = this.#getCallArgsForRender();
						const callComponent = tool.renderCall(callArgs, this.#renderState, theme) as Component | undefined;
						if (callComponent) {
							this.#contentBox.addChild(
								new SafeToolRendererComponent(
									this.#toolName,
									"call",
									callComponent,
									() => new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0),
								),
							);
						}
					} catch (err) {
						logger.warn("Tool renderer failed", { tool: this.#toolName, error: String(err) });
						// Fall back to default on error
						this.#contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0));
					}
				} else {
					// No custom renderCall, show tool name
					this.#contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0));
				}
			}

			// Render result component if we have a result
			if (this.#result && tool.renderResult) {
				try {
					const renderResult = tool.renderResult as (
						result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
						options: { expanded: boolean; isPartial: boolean; spinnerFrame?: number },
						theme: Theme,
						args?: unknown,
					) => Component;
					const resultComponent = renderResult(
						{
							content: this.#result.content as any,
							details: this.#result.details,
							isError: this.#result.isError,
						},
						this.#renderState,
						theme,
						this.#args,
					);
					if (resultComponent) {
						this.#contentBox.addChild(
							new SafeToolRendererComponent(this.#toolName, "result", resultComponent, () => {
								const output = this.#getTextOutput();
								if (!output) return undefined;
								return new Text(theme.fg("toolOutput", replaceTabs(output)), 0, 0);
							}),
						);
					}
				} catch (err) {
					logger.warn("Tool renderer failed", { tool: this.#toolName, error: String(err) });
					// Fall back to showing raw output on error
					const output = this.#getTextOutput();
					if (output) {
						this.#contentBox.addChild(new Text(theme.fg("toolOutput", replaceTabs(output)), 0, 0));
					}
				}
			} else if (this.#result) {
				// Has result but no custom renderResult
				const output = this.#getTextOutput();
				if (output) {
					this.#contentBox.addChild(new Text(theme.fg("toolOutput", replaceTabs(output)), 0, 0));
				}
			}
			// Custom tools that draw their own frame (task) render flush; plain
			// extension renderers get the padded, state-tinted block back.
			const customFramed = this.#contentBox.children.some(isFramedBlockComponent);
			this.#contentBox.setPaddingX(customFramed ? 0 : 1);
			this.#contentBox.setBgFn(customFramed ? undefined : stateBgFn);
		} else if (this.#renderer) {
			// The active registry entry is a built-in tool with a rich renderer.
			const renderer = this.#renderer;

			// Clean up previous multi-file boxes
			for (const box of this.#multiFileBoxes) {
				this.removeChild(box);
			}
			this.#multiFileBoxes = [];

			// Check for multi-file edit results
			const perFileResults = this.#result?.details?.perFileResults as
				| Array<{ path: string; isError?: boolean }>
				| undefined;
			if (perFileResults && perFileResults.length > 1) {
				// Multi-file: render each file as its own Box (identical to separate tool calls)
				this.#contentBox.setBgFn(undefined);
				this.#contentBox.clear();

				const renderContext = this.#buildRenderContext();
				this.#renderState.renderContext = renderContext;

				for (let i = 0; i < perFileResults.length; i++) {
					const fileResult = perFileResults[i];
					if (i > 0) {
						const spacer = new Spacer(1);
						this.#multiFileBoxes.push(spacer);
						this.addChild(spacer);
					}
					const fileBox = new Box(0, 0);
					try {
						const resultComponent = renderer.renderResult(
							{ content: [], details: fileResult, isError: fileResult.isError },
							this.#renderState,
							theme,
						);
						if (resultComponent) {
							fileBox.addChild(
								new SafeToolRendererComponent(this.#toolName, "result", resultComponent, () => undefined),
							);
						}
					} catch (err) {
						logger.warn("Tool renderer failed", { tool: this.#toolName, error: String(err) });
					}
					this.#multiFileBoxes.push(fileBox);
					this.addChild(fileBox);
				}

				// Show pending indicator for remaining files
				const totalFiles = this.#args?.edits
					? new Set((this.#args.edits as any[]).map((e: any) => e?.path).filter(Boolean)).size
					: 0;
				const remaining = Math.max(0, totalFiles - perFileResults.length);
				if (remaining > 0 && this.#isPartial) {
					const pendingSpacer = new Spacer(1);
					this.#multiFileBoxes.push(pendingSpacer);
					this.addChild(pendingSpacer);
					const pendingBox = new Box(0, 0);
					const spinner =
						this.#spinnerFrame !== undefined ? formatStatusIcon("running", theme, this.#spinnerFrame) : "";
					const pendingText = renderStatusLine(
						{
							iconOverride: spinner,
							title: "Edit",
							description: theme.fg("dim", `${remaining} more file${remaining > 1 ? "s" : ""} pending…`),
						},
						theme,
					);
					pendingBox.addChild(new Text(pendingText, 0, 0));
					this.#multiFileBoxes.push(pendingBox);
					this.addChild(pendingBox);
				}
			} else {
				// Single-file or no result: standard rendering
				// Inline renderers skip background styling
				this.#contentBox.setBgFn(undefined);
				this.#contentBox.clear();

				const renderContext = this.#buildRenderContext();
				this.#renderState.renderContext = renderContext;

				const shouldRenderCall = !this.#result || !renderer.mergeCallAndResult;
				if (shouldRenderCall) {
					// Render call component
					try {
						const callArgs = this.#getCallArgsForRender();
						const callComponent = renderer.renderCall(callArgs, this.#renderState, theme);
						if (callComponent) {
							this.#contentBox.addChild(
								new SafeToolRendererComponent(
									this.#toolName,
									"call",
									callComponent,
									() => new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0),
								),
							);
						}
					} catch (err) {
						logger.warn("Tool renderer failed", { tool: this.#toolName, error: String(err) });
						// Fall back to default on error
						this.#contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.#toolLabel)), 0, 0));
					}
				}

				// Render result component if we have a result
				if (this.#result) {
					try {
						const resultComponent = renderer.renderResult(
							{
								content: this.#result.content as any,
								details: this.#result.details,
								isError: this.#result.isError,
							},
							this.#renderState,
							theme,
							this.#getCallArgsForRender(),
						);
						if (resultComponent) {
							this.#contentBox.addChild(
								new SafeToolRendererComponent(this.#toolName, "result", resultComponent, () => {
									const output = this.#getTextOutput();
									if (!output) return undefined;
									return new Text(theme.fg("toolOutput", replaceTabs(output)), 0, 0);
								}),
							);
						}
					} catch (err) {
						logger.warn("Tool renderer failed", { tool: this.#toolName, error: String(err) });
						// Fall back to showing raw output on error
						const output = this.#getTextOutput();
						if (output) {
							this.#contentBox.addChild(new Text(theme.fg("toolOutput", replaceTabs(output)), 0, 0));
						}
					}
				}
			}
		} else {
			// Generic fallback (no custom/built-in renderer). WidthAwareText
			// reformats at render time so output fills the actual terminal width
			// instead of a fixed column cap.
			this.#contentText.setCustomBgFn(stateBgFn);
			this.#contentText.invalidate();
		}

		// Handle images (same for both custom and built-in)
		for (const img of this.#imageComponents) {
			this.removeChild(img);
		}
		this.#imageComponents = [];
		for (const spacer of this.#imageSpacers) {
			this.removeChild(spacer);
		}
		this.#imageSpacers = [];

		if (this.#result) {
			const imageBlocks = this.#getAllImageBlocks();

			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (TERMINAL.imageProtocol && this.#showImages && img.data && img.mimeType) {
					// Use converted PNG for Kitty protocol if available
					const converted = this.#convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;

					// For Kitty, skip non-PNG images that haven't been converted yet
					if (TERMINAL.imageProtocol === ImageProtocol.Kitty && imageMimeType !== "image/png") {
						continue;
					}

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.#imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ ...resolveImageOptions(), budget: this.#ui.imageBudget, imageKey: `te${this.#instanceId}:${i}` },
					);
					this.#imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}
		this.#renderedImageCount = this.#imageComponents.length;
	}

	#getCallArgsForRender(): any {
		const renderArgs = this.#args;
		if (!isEditLikeToolName(this.#toolName)) {
			return renderArgs;
		}
		const previews = this.#editDiffPreview;
		if (!previews || previews.length === 0) {
			return renderArgs;
		}
		// Single-file previews feed the existing `previewDiff` channel consumed
		// by `formatStreamingDiff` in the renderer.
		const first = previews[0];
		if (!first?.diff) {
			return renderArgs;
		}
		return { ...(renderArgs as Record<string, unknown>), previewDiff: first.diff };
	}

	/**
	 * Build render context for tools that need extra state (bash, python, edit)
	 */
	#buildRenderContext(): Record<string, unknown> {
		const context: Record<string, unknown> = {};
		const normalizeTimeoutSeconds = (value: unknown, maxSeconds: number): number | undefined => {
			if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
			return Math.max(1, Math.min(maxSeconds, value));
		};

		if (this.#toolName === "bash") {
			// Bash needs render context even before a result exists. The renderer uses the pending-call args
			// plus this context to keep the inline command preview visible while tool-call JSON is still streaming.
			if (this.#result) {
				// Pass raw output and expanded state - renderer handles width-aware truncation
				const output = this.#getTextOutput().trimEnd();
				context.output = output;
			}
			context.expanded = this.#expanded;
			context.previewLines = BASH_DEFAULT_PREVIEW_LINES;
			context.timeout = normalizeTimeoutSeconds(this.#args?.timeout, 3600);
		} else if (this.#toolName === "eval" && this.#result) {
			const output = this.#getTextOutput().trimEnd();
			context.output = output;
			context.expanded = this.#expanded;
			context.previewLines = EVAL_DEFAULT_PREVIEW_LINES;
		} else if (this.#toolName === "task") {
			// Once a result snapshot exists the task renderer's `renderResult`
			// draws every dispatched agent as a progress/result line, so tell
			// `renderCall` to drop its duplicate streaming preview list.
			context.hasResult = Boolean(this.#result);
			this.#taskRenderNowMs = Date.now();
			context.nowMs = this.#taskRenderNowMs;
		} else if (isEditLikeToolName(this.#toolName)) {
			context.editMode = this.#editMode;
			const previews = this.#editDiffPreview;
			if (previews && previews.length > 0) {
				const first = previews[0];
				if (first?.diff || first?.error) {
					context.editDiffPreview = first.error
						? { error: first.error }
						: { diff: first.diff ?? "", firstChangedLine: first.firstChangedLine };
				}
				if (previews.length > 1) {
					context.perFileDiffPreview = previews;
				}
			}
			if (!previews?.some(preview => preview.diff)) {
				const editMode = this.#editMode;
				const fallback = editMode ? renderStreamingFallback(editMode, this.#args, theme) : "";
				if (fallback) context.editStreamingFallback = fallback;
			}
			context.renderDiff = renderDiff;
		} else if (this.#toolName === "write") {
			// Device-dispatch previews resolve renderers from the canonical tool map.
			const writeTool = this.#tool as { session?: { xdev?: XdevState } } | undefined;
			const xdev = writeTool?.session?.xdev;
			if (xdev) {
				context.resolveXdevMounted = (name: string) =>
					xdev.mountedNames.has(name) ? xdev.tools.get(name) : undefined;
			}
		}

		return context;
	}

	#getTextOutput(): string {
		if (!this.#result) return "";

		const textBlocks = this.#result.content?.filter((c: any) => c.type === "text") || [];
		const imageBlocks = this.#getAllImageBlocks();

		let output = textBlocks
			.map((c: any) => {
				return sanitizeWithOptionalSixelPassthrough(c.text || "", sanitizeText);
			})
			.join("\n");

		if (imageBlocks.length > 0 && (!TERMINAL.imageProtocol || !this.#showImages)) {
			const imageIndicators = imageBlocks
				.map((img: any) => {
					const dims = img.data ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
					return imageFallback(img.mimeType, dims);
				})
				.join("\n");
			output = output ? `${output}\n${imageIndicators}` : imageIndicators;
		}

		return output;
	}

	/**
	 * Format the generic call/result card at `contentWidth`. Shared by the
	 * #contentText fallback and the benign-skip path so both render identically.
	 */
	#renderDefaultCard(contentWidth: number): string {
		return formatDefaultToolExecution(
			{
				label: this.#toolLabel,
				args: this.#args,
				result: this.#result
					? { output: this.#getTextOutput(), isError: this.#result.isError, skipped: this.#isBenignSkip() }
					: undefined,
				options: this.#renderState,
			},
			contentWidth,
			theme,
		);
	}

	/**
	 * True for a steering/peer-interrupt placeholder. A synthetic placeholder
	 * identifies a call that never entered `tool.execute`; an interrupted
	 * placeholder identifies one that started but threw before returning usable
	 * output. Both are normal steering control flow and render neutrally (#7199).
	 */
	#isBenignSkip(): boolean {
		if (this.#isPartial || !this.#result) return false;
		const details = this.#result.details as
			| { __synthetic?: boolean; __interrupted?: boolean; source?: string; execution?: string }
			| undefined;
		if (details?.source !== "interrupt_skipped") return false;
		return details.__synthetic === true || (details.__interrupted === true && details.execution === "started");
	}

	/**
	 * Render a benign skip as the neutral generic card, replacing any bespoke
	 * renderer's error frame. Generic-fallback tools already route through
	 * {@link #renderDefaultCard} (which emits the info card for a skip); they
	 * only need the neutral tint. Bespoke-renderer tools get their content box
	 * swapped for the same neutral card.
	 */
	#renderBenignSkipCard(stateBgFn: (text: string) => string): void {
		if (!this.#usesContentBox) {
			this.#contentText.setCustomBgFn(stateBgFn);
			this.#contentText.invalidate();
			return;
		}
		for (const box of this.#multiFileBoxes) {
			this.removeChild(box);
		}
		this.#multiFileBoxes = [];
		this.#contentBox.setBgFn(undefined);
		this.#contentBox.clear();
		this.#contentBox.setPaddingX(1);
		this.#contentBox.setBgFn(stateBgFn);
		this.#contentBox.addChild(new WidthAwareText(contentWidth => this.#renderDefaultCard(contentWidth), 0, 0));
	}
}
