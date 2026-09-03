import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { framedBlock, renderStatusLine } from "../tui";
import type { ComputerToolDetails } from "./computer";
import { PREVIEW_LIMITS, replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "./render-utils";

interface ComputerRenderArgs {
	code?: unknown;
	read_only?: unknown;
	window?: unknown;
	actions?: unknown;
}

interface ComputerRenderResult {
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

function sanitizedLine(value: string, width: number, collapse = false): string {
	const sanitized = replaceTabs(sanitizeText(value));
	const text = collapse ? sanitized.replace(/[\r\n]+/g, " ") : sanitized;
	return truncateToWidth(text, Math.max(1, Math.min(width, TRUNCATE_LENGTHS.LINE)));
}

function isComputerToolDetails(value: unknown): value is ComputerToolDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<ComputerToolDetails>;
	return (
		Array.isArray(details.screenshots) &&
		(details.code === undefined || typeof details.code === "string") &&
		(details.readOnly === undefined || typeof details.readOnly === "boolean") &&
		(details.returnValue === undefined || typeof details.returnValue === "string") &&
		(details.backend === undefined || typeof details.backend === "string") &&
		(details.capturePermission === undefined || typeof details.capturePermission === "string") &&
		(details.inputPermission === undefined || typeof details.inputPermission === "string") &&
		(details.axPermission === undefined || typeof details.axPermission === "string")
	);
}

function statusSuffix(
	args: ComputerRenderArgs | undefined,
	details: ComputerToolDetails | undefined,
	isError: boolean,
): string | undefined {
	const parts: string[] = [];
	if (details?.readOnly === true || args?.read_only === true) parts.push("read-only");
	if (details) {
		const count = details.screenshots.length;
		parts.push(`${count} ${count === 1 ? "screenshot" : "screenshots"}`);
	}
	if (isError) parts.push("error");
	return parts.length > 0 ? sanitizedLine(parts.join(" · "), TRUNCATE_LENGTHS.TITLE, true) : undefined;
}

function previewLines(text: string, limit: number, width: number): string[] {
	if (!text) return [];
	const rawLines = text.split(/\r?\n/);
	const lines = rawLines.slice(0, limit).map(line => sanitizedLine(line, width));
	if (rawLines.length > limit) {
		lines.push(sanitizedLine(`… ${rawLines.length - limit} more lines`, width));
	}
	return lines;
}

function renderComputerCell(
	args: ComputerRenderArgs | undefined,
	details: ComputerToolDetails | undefined,
	result: ComputerRenderResult | undefined,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	const isError = result?.isError === true;
	const code = typeof args?.code === "string" ? args.code : details?.code;
	const header = renderStatusLine(
		{
			icon: isError ? "error" : options.isPartial ? "pending" : result ? "success" : "pending",
			title: "Computer",
			description: statusSuffix(args, details, isError),
		},
		theme,
	);

	// Old persisted calls used {window, actions}; keep their replay deliberately plain.
	if (code === undefined) return new Text(header, 0, 0);

	return framedBlock(theme, width => {
		const lineWidth = Math.max(1, width - 4);
		const codeLimit = options.expanded ? Number.POSITIVE_INFINITY : PREVIEW_LIMITS.COMPUTER_CODE_COLLAPSED;
		const outputLimit = options.expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED;
		const sections: Array<{ label?: string; lines: string[] }> = [];
		const codeLines = previewLines(code, codeLimit, lineWidth).map(line => theme.fg("toolOutput", line));
		if (codeLines.length > 0)
			sections.push({ label: sanitizedLine("Code", TRUNCATE_LENGTHS.SHORT), lines: codeLines });

		const output = result
			? (result.content ?? [])
					.filter(
						(item): item is { type: string; text: string } =>
							item.type === "text" && typeof item.text === "string",
					)
					.map(item => item.text)
					.join("\n")
			: "";
		if (isError) {
			const errorLine = sanitizedLine(output || "Unknown error", lineWidth, true);
			sections.push({
				label: sanitizedLine("Error", TRUNCATE_LENGTHS.SHORT),
				lines: [theme.fg("error", errorLine)],
			});
		} else {
			const outputLines = previewLines(output, outputLimit, lineWidth).map(line => theme.fg("toolOutput", line));
			if (outputLines.length > 0) {
				sections.push({ label: sanitizedLine("Output", TRUNCATE_LENGTHS.SHORT), lines: outputLines });
			}
		}

		return {
			header,
			sections,
			state: isError ? "error" : options.isPartial || !result ? "pending" : "success",
			borderColor: isError ? "error" : "borderMuted",
			applyBg: false,
			width,
		};
	});
}

/** Renders computer scripts, run state, screenshots, and failures in the TUI. */
export const computerToolRenderer = {
	mergeCallAndResult: true,
	renderCall(args: ComputerRenderArgs, options: RenderResultOptions, theme: Theme): Component {
		return renderComputerCell(args, undefined, undefined, options, theme);
	},
	renderResult(
		result: ComputerRenderResult,
		options: RenderResultOptions,
		theme: Theme,
		args?: ComputerRenderArgs,
	): Component {
		const details = isComputerToolDetails(result.details) ? result.details : undefined;
		return renderComputerCell(args, details, result, options, theme);
	},
};
