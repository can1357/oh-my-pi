/**
 * TUI renderer for the `generate_image` tool.
 *
 * Display-only chrome: renders each generated image path as an OSC 8 file
 * hyperlink plus a stats line (provider · model · dimensions · size · cost).
 * The actual image pixels are NOT rendered here — `ToolExecutionComponent`
 * draws them inline from `details.images` through the shared image budget /
 * kitty conversion path (same mechanism as screenshots), so this renderer
 * stays text-only and never double-renders.
 */

import * as path from "node:path";
import type { Component } from "@oh-my-pi/pi-tui";
import { TERMINAL, Text } from "@oh-my-pi/pi-tui";
import { formatBytes } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { fileHyperlink, framedBlock, renderStatusLine } from "../tui";
import { formatErrorDetail, replaceTabs, shortenPath, truncateToWidth } from "./render-utils";
import type { ToolDetailImage } from "./tool-detail-images";

interface ImageGenRenderArgs {
	model?: unknown;
}

interface ImageGenImageStat {
	path: string;
	width?: number;
	height?: number;
	sizeBytes: number;
	mimeType?: string;
}

interface ImageGenRenderDetails {
	provider?: string;
	model?: string;
	entryId?: string;
	costUsd?: number;
	imageStats?: ImageGenImageStat[];
	images?: ToolDetailImage[];
	responseText?: string;
	revisedPrompt?: string;
}

interface ImageGenRenderResult {
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

// Accepts any object carrying one of the known metadata fields so provider/model/
// cost still surface for legacy results (no imageStats) and error details that
// omit the image list — the header and meta line degrade gracefully either way.
function isImageGenDetails(value: unknown): value is ImageGenRenderDetails {
	if (!value || typeof value !== "object") return false;
	const d = value as ImageGenRenderDetails;
	return (
		typeof d.provider === "string" ||
		typeof d.model === "string" ||
		typeof d.entryId === "string" ||
		typeof d.costUsd === "number" ||
		typeof d.responseText === "string" ||
		typeof d.revisedPrompt === "string" ||
		Array.isArray(d.imageStats) ||
		Array.isArray(d.images)
	);
}

export const imageGenToolRenderer = {
	mergeCallAndResult: true,

	renderCall(args: ImageGenRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const requested = typeof args?.model === "string" ? args.model : undefined;
		return new Text(renderStatusLine({ icon: "pending", title: "Image", description: requested }, uiTheme), 0, 0);
	},

	renderResult(
		result: ImageGenRenderResult,
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: ImageGenRenderArgs,
	): Component {
		const details = isImageGenDetails(result.details) ? result.details : undefined;
		const isError = result.isError === true;
		const firstPath = details?.imageStats?.[0]?.path;
		// The full path is hyperlinked in the body; keep the header title compact
		// so the provider · model meta fits without squeezing it off the line.
		const requestedModel = typeof args?.model === "string" ? args.model : undefined;
		const description = firstPath ? path.basename(firstPath) : (details?.entryId ?? requestedModel ?? "image");
		const header = renderStatusLine(
			isError
				? { icon: "error", title: "Image", description }
				: { icon: options.isPartial ? "pending" : "done", title: "Image", description },
			uiTheme,
		);

		const outputText = (result.content ?? []).find(content => content.type === "text")?.text?.trimEnd() ?? "";

		if (isError) {
			return framedBlock(uiTheme, width => ({
				header,
				sections: [{ lines: [formatErrorDetail(outputText || "image generation failed", uiTheme)] }],
				state: "error",
				borderColor: "error",
				applyBg: false,
				width,
			}));
		}

		const metaParts: string[] = [];
		if (details?.provider) metaParts.push(details.provider);
		if (details?.model) metaParts.push(details.model);
		if (details?.entryId && details.entryId !== details.model) metaParts.push(details.entryId);
		if (details?.costUsd != null) {
			const cost = details.costUsd;
			metaParts.push(`$${cost >= 1 ? cost.toFixed(2) : cost.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`);
		}
		const metaLine = metaParts.length > 0 ? uiTheme.fg("dim", metaParts.join(" · ")) : "";

		const stats = details?.imageStats;
		// Pixels are drawn by ToolExecutionComponent from `details.images`; when it
		// cannot draw them, name the reason instead of silently omitting them.
		const previewBlocker =
			(details?.images?.length ?? 0) === 0
				? undefined
				: !TERMINAL.imageProtocol
					? "terminal has no image protocol"
					: settings.get("terminal.showImages")
						? undefined
						: "terminal.showImages is off";
		if (!stats || stats.length === 0) {
			// No per-image metadata (e.g. older persisted results): keep a minimal
			// header+meta block; the model-visible text still carries the paths.
			const sections: Array<{ label?: string; lines: string[] }> = [
				{ lines: [uiTheme.fg("dim", replaceTabs(outputText || "Image generated."))] },
			];
			if (previewBlocker) {
				sections.push({
					label: uiTheme.fg("dim", "Preview"),
					lines: [uiTheme.fg("dim", `inline preview unavailable — ${previewBlocker}`)],
				});
			}
			return framedBlock(uiTheme, width => ({
				header,
				headerMeta: metaLine || undefined,
				sections,
				state: "success",
				borderColor: "borderMuted",
				applyBg: false,
				width,
			}));
		}

		return framedBlock(uiTheme, width => {
			const lineWidth = Math.max(1, width - 4);
			// One line per image: `  [hyperlink path] dims` — only the path is
			// clickable, and the label is truncated to leave room for the dims suffix.
			const lines = stats.map(stat => {
				const dims =
					stat.width && stat.height ? ` ${stat.width}x${stat.height}, ${formatBytes(stat.sizeBytes)}` : "";
				const label = uiTheme.fg(
					"accent",
					truncateToWidth(shortenPath(stat.path), Math.max(1, lineWidth - Bun.stringWidth(dims))),
				);
				return fileHyperlink(stat.path, `  ${label}`) + dims;
			});

			// Preserve provider-reported prose (OpenAI revised_prompt, Gemini
			// feedback) in its own labeled section so it stays visible instead of
			// living only in the transcript. Framed blocks wrap long lines.
			const sections: Array<{ label?: string; lines: string[] }> = [{ lines }];
			if (previewBlocker) {
				sections.push({
					label: uiTheme.fg("dim", "Preview"),
					lines: [uiTheme.fg("dim", `inline preview unavailable — ${previewBlocker}`)],
				});
			}
			if (details?.revisedPrompt) {
				sections.push({
					label: uiTheme.fg("dim", "Revised prompt"),
					lines: replaceTabs(details.revisedPrompt.trim())
						.split("\n")
						.map(line => uiTheme.fg("toolOutput", line)),
				});
			}
			if (details?.responseText) {
				sections.push({
					label: uiTheme.fg("dim", "Response"),
					lines: replaceTabs(details.responseText.trim())
						.split("\n")
						.map(line => uiTheme.fg("toolOutput", line)),
				});
			}
			return {
				header,
				headerMeta: metaLine || undefined,
				sections,
				state: "success",
				borderColor: "borderMuted",
				applyBg: false,
				width,
			};
		});
	},
};
