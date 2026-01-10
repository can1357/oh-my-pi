import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	Box,
	Container,
	getCapabilities,
	getImageDimensions,
	Image,
	imageFallback,
	Spacer,
	Text,
	type TUI,
} from "@oh-my-pi/pi-tui";
import stripAnsi from "strip-ansi";
import { computeEditDiff, type EditDiffError, type EditDiffResult } from "../../../core/tools/edit-diff";
import { toolRenderers } from "../../../core/tools/renderers";
import { convertToPng } from "../../../utils/image-convert";
import { sanitizeBinaryOutput } from "../../../utils/shell";
import { theme } from "../theme/theme";
import { renderDiff } from "./diff";

// Preview line limit for bash when not expanded
const BASH_PREVIEW_LINES = 5;
const GENERIC_PREVIEW_LINES = 6;
const GENERIC_ARG_PREVIEW = 6;
const GENERIC_VALUE_MAX = 80;

function formatCompactValue(value: unknown, maxLength: number): string {
	let rendered = "";

	if (value === null) {
		rendered = "null";
	} else if (value === undefined) {
		rendered = "undefined";
	} else if (typeof value === "string") {
		rendered = value;
	} else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		rendered = String(value);
	} else if (Array.isArray(value)) {
		const previewItems = value.slice(0, 3).map((item) => formatCompactValue(item, maxLength));
		rendered = `[${previewItems.join(", ")}${value.length > 3 ? ", ..." : ""}]`;
	} else if (typeof value === "object") {
		try {
			rendered = JSON.stringify(value);
		} catch {
			rendered = "[object]";
		}
	} else if (typeof value === "function") {
		rendered = "[function]";
	} else {
		rendered = String(value);
	}

	if (rendered.length > maxLength) {
		rendered = `${rendered.slice(0, maxLength - 1)}${theme.format.ellipsis}`;
	}

	return rendered;
}

function formatArgsPreview(
	args: unknown,
	maxEntries: number,
	maxValueLength: number,
): { lines: string[]; remaining: number; total: number } {
	if (args === undefined) {
		return { lines: [theme.fg("dim", "(none)")], remaining: 0, total: 0 };
	}
	if (args === null || typeof args !== "object") {
		const single = theme.fg("toolOutput", formatCompactValue(args, maxValueLength));
		return { lines: [single], remaining: 0, total: 1 };
	}

	const entries = Object.entries(args as Record<string, unknown>);
	const total = entries.length;
	const visible = entries.slice(0, maxEntries);
	const lines = visible.map(([key, value]) => {
		const keyText = theme.fg("accent", key);
		const valueText = theme.fg("toolOutput", formatCompactValue(value, maxValueLength));
		return `${keyText}: ${valueText}`;
	});

	return { lines, remaining: Math.max(total - visible.length, 0), total };
}

export interface ToolExecutionOptions {
	showImages?: boolean; // default: true (only used if terminal supports images)
}

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container {
	private contentBox: Box; // Used for custom tools and bash visual truncation
	private contentText: Text; // For built-in tools (with its own padding/bg)
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolLabel: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private isPartial = true;
	private tool?: AgentTool;
	private ui: TUI;
	private cwd: string;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError?: boolean;
		details?: any;
	};
	// Cached edit diff preview (computed when args arrive, before tool executes)
	private editDiffPreview?: EditDiffResult | EditDiffError;
	private editDiffArgsKey?: string; // Track which args the preview is for
	// Cached converted images for Kitty protocol (which requires PNG), keyed by index
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	// Spinner animation for partial task results
	private spinnerFrame = 0;
	private spinnerInterval: ReturnType<typeof setInterval> | null = null;

	constructor(
		toolName: string,
		args: any,
		options: ToolExecutionOptions = {},
		tool: AgentTool | undefined,
		ui: TUI,
		cwd: string = process.cwd(),
	) {
		super();
		this.toolName = toolName;
		this.toolLabel = tool?.label ?? toolName;
		this.args = args;
		this.showImages = options.showImages ?? true;
		this.tool = tool;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create both - contentBox for custom tools/bash/tools with renderers, contentText for other built-ins
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));

		// Use Box for custom tools or built-in tools that have renderers
		const hasRenderer = toolName in toolRenderers;
		const hasCustomRenderer = !!(tool?.renderCall || tool?.renderResult);
		if (hasCustomRenderer || hasRenderer) {
			this.addChild(this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	/**
	 * Signal that args are complete (tool is about to execute).
	 * This triggers diff computation for edit tool.
	 */
	setArgsComplete(): void {
		this.maybeComputeEditDiff();
	}

	/**
	 * Compute edit diff preview when we have complete args.
	 * This runs async and updates display when done.
	 */
	private maybeComputeEditDiff(): void {
		if (this.toolName !== "edit") return;

		const path = this.args?.path;
		const oldText = this.args?.oldText;
		const newText = this.args?.newText;
		const all = this.args?.all;

		// Need all three params to compute diff
		if (!path || oldText === undefined || newText === undefined) return;

		// Create a key to track which args this computation is for
		const argsKey = JSON.stringify({ path, oldText, newText, all });

		// Skip if we already computed for these exact args
		if (this.editDiffArgsKey === argsKey) return;

		this.editDiffArgsKey = argsKey;

		// Compute diff async
		computeEditDiff(path, oldText, newText, this.cwd, true, all).then((result) => {
			// Only update if args haven't changed since we started
			if (this.editDiffArgsKey === argsKey) {
				this.editDiffPreview = result;
				this.updateDisplay();
				this.ui.requestRender();
			}
		});
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError?: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateSpinnerAnimation();
		this.updateDisplay();
		// Convert non-PNG images to PNG for Kitty protocol (async)
		this.maybeConvertImagesForKitty();
	}

	/**
	 * Get all image blocks from result content and details.images.
	 * Some tools (like generate_image) store images in details to avoid bloating model context.
	 */
	private getAllImageBlocks(): Array<{ data?: string; mimeType?: string }> {
		if (!this.result) return [];
		const contentImages = this.result.content?.filter((c: any) => c.type === "image") || [];
		const detailImages = this.result.details?.images || [];
		return [...contentImages, ...detailImages];
	}

	/**
	 * Convert non-PNG images to PNG for Kitty graphics protocol.
	 * Kitty requires PNG format (f=100), so JPEG/GIF/WebP won't display.
	 */
	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		// Only needed for Kitty protocol
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.getAllImageBlocks();

		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			// Skip if already PNG or already converted
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			// Convert async
			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	/**
	 * Start or stop spinner animation based on whether this is a partial task result.
	 */
	private updateSpinnerAnimation(): void {
		const needsSpinner = this.isPartial && this.toolName === "task";
		if (needsSpinner && !this.spinnerInterval) {
			this.spinnerInterval = setInterval(() => {
				const frameCount = theme.spinnerFrames.length;
				if (frameCount === 0) return;
				this.spinnerFrame = (this.spinnerFrame + 1) % frameCount;
				this.updateDisplay();
				this.ui.requestRender();
			}, 80);
		} else if (!needsSpinner && this.spinnerInterval) {
			clearInterval(this.spinnerInterval);
			this.spinnerInterval = null;
		}
	}

	/**
	 * Stop spinner animation and cleanup resources.
	 */
	stopAnimation(): void {
		if (this.spinnerInterval) {
			clearInterval(this.spinnerInterval);
			this.spinnerInterval = null;
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		// Set background based on state
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		// Check for custom tool rendering
		if (this.tool && (this.tool.renderCall || this.tool.renderResult)) {
			const tool = this.tool;
			// Custom tools use Box for flexible component rendering
			this.contentBox.setBgFn(bgFn);
			this.contentBox.clear();

			// Render call component
			if (tool.renderCall) {
				try {
					const callComponent = tool.renderCall(this.args, theme);
					if (callComponent) {
						// Ensure component has invalidate() method for Component interface
						const component = callComponent as any;
						if (!component.invalidate) {
							component.invalidate = () => {};
						}
						this.contentBox.addChild(component);
					}
				} catch {
					// Fall back to default on error
					this.contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.toolLabel)), 0, 0));
				}
			} else {
				// No custom renderCall, show tool name
				this.contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.toolLabel)), 0, 0));
			}

			// Render result component if we have a result
			if (this.result && tool.renderResult) {
				try {
					const resultComponent = tool.renderResult(
						{ content: this.result.content as any, details: this.result.details },
						{ expanded: this.expanded, isPartial: this.isPartial, spinnerFrame: this.spinnerFrame },
						theme,
					);
					if (resultComponent) {
						// Ensure component has invalidate() method for Component interface
						const component = resultComponent as any;
						if (!component.invalidate) {
							component.invalidate = () => {};
						}
						this.contentBox.addChild(component);
					}
				} catch {
					// Fall back to showing raw output on error
					const output = this.getTextOutput();
					if (output) {
						this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
					}
				}
			} else if (this.result) {
				// Has result but no custom renderResult
				const output = this.getTextOutput();
				if (output) {
					this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
				}
			}
		} else if (this.toolName in toolRenderers) {
			// Built-in tools with renderers
			const renderer = toolRenderers[this.toolName];
			this.contentBox.setBgFn(bgFn);
			this.contentBox.clear();

			const shouldRenderCall = !this.result || !renderer.mergeCallAndResult;
			if (shouldRenderCall) {
				// Render call component
				try {
					const callComponent = renderer.renderCall(this.args, theme);
					if (callComponent) {
						// Ensure component has invalidate() method for Component interface
						const component = callComponent as any;
						if (!component.invalidate) {
							component.invalidate = () => {};
						}
						this.contentBox.addChild(component);
					}
				} catch {
					// Fall back to default on error
					this.contentBox.addChild(new Text(theme.fg("toolTitle", theme.bold(this.toolLabel)), 0, 0));
				}
			}

			// Render result component if we have a result
			if (this.result) {
				try {
					// Build render context for tools that need extra state
					const renderContext = this.buildRenderContext();

					const resultComponent = renderer.renderResult(
						{ content: this.result.content as any, details: this.result.details, isError: this.result.isError },
						{
							expanded: this.expanded,
							isPartial: this.isPartial,
							spinnerFrame: this.spinnerFrame,
							renderContext,
						},
						theme,
						this.args, // Pass args for tools that need them
					);
					if (resultComponent) {
						// Ensure component has invalidate() method for Component interface
						const component = resultComponent as any;
						if (!component.invalidate) {
							component.invalidate = () => {};
						}
						this.contentBox.addChild(component);
					}
				} catch {
					// Fall back to showing raw output on error
					const output = this.getTextOutput();
					if (output) {
						this.contentBox.addChild(new Text(theme.fg("toolOutput", output), 0, 0));
					}
				}
			}
		} else {
			// Other built-in tools: use Text directly with caching
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
		}

		// Handle images (same for both custom and built-in)
		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.getAllImageBlocks();
			const caps = getCapabilities();

			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					// Use converted PNG for Kitty protocol if available
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;

					// For Kitty, skip non-PNG images that haven't been converted yet
					if (caps.images === "kitty" && imageMimeType !== "image/png") {
						continue;
					}

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: 60 },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}
	}

	/**
	 * Build render context for tools that need extra state (bash, edit)
	 */
	private buildRenderContext(): Record<string, unknown> {
		const context: Record<string, unknown> = {};

		if (this.toolName === "bash" && this.result) {
			// Pass raw output and expanded state - renderer handles width-aware truncation
			const output = this.getTextOutput().trim();
			context.output = output;
			context.expanded = this.expanded;
			context.previewLines = BASH_PREVIEW_LINES;
		} else if (this.toolName === "edit") {
			// Edit needs diff preview and renderDiff function
			context.editDiffPreview = this.editDiffPreview;
			context.renderDiff = renderDiff;
		}

		return context;
	}

	private getTextOutput(): string {
		if (!this.result) return "";

		const textBlocks = this.result.content?.filter((c: any) => c.type === "text") || [];
		const imageBlocks = this.getAllImageBlocks();

		let output = textBlocks
			.map((c: any) => {
				// Use sanitizeBinaryOutput to handle binary data that crashes string-width
				return sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "");
			})
			.join("\n");

		const caps = getCapabilities();
		if (imageBlocks.length > 0 && (!caps.images || !this.showImages)) {
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
	 * Format a generic tool execution (fallback for tools without custom renderers)
	 */
	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolLabel));

		const argTotal =
			this.args && typeof this.args === "object"
				? Object.keys(this.args as Record<string, unknown>).length
				: this.args === undefined
					? 0
					: 1;
		const argPreviewLimit = this.expanded ? argTotal : GENERIC_ARG_PREVIEW;
		const valueLimit = this.expanded ? 2000 : GENERIC_VALUE_MAX;
		const argsPreview = formatArgsPreview(this.args, argPreviewLimit, valueLimit);

		text += `\n\n${theme.fg("toolTitle", "Args")} ${theme.fg("dim", `(${argsPreview.total})`)}`;
		if (argsPreview.lines.length > 0) {
			text += `\n${argsPreview.lines.join("\n")}`;
		} else {
			text += `\n${theme.fg("dim", "(none)")}`;
		}
		if (argsPreview.remaining > 0) {
			text += theme.fg("dim", `\n${theme.format.ellipsis} (${argsPreview.remaining} more args) (ctrl+o to expand)`);
		}

		const output = this.getTextOutput().trim();
		text += `\n\n${theme.fg("toolTitle", "Output")}`;
		if (output) {
			const lines = output.split("\n");
			const maxLines = this.expanded ? lines.length : GENERIC_PREVIEW_LINES;
			const displayLines = lines.slice(-maxLines);
			const remaining = lines.length - displayLines.length;
			text += ` ${theme.fg("dim", `(${lines.length} lines)`)}`;
			text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
			if (remaining > 0) {
				text += theme.fg("dim", `\n${theme.format.ellipsis} (${remaining} earlier lines) (ctrl+o to expand)`);
			}
		} else {
			text += ` ${theme.fg("dim", "(empty)")}`;
		}

		return text;
	}
}
