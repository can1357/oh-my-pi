import type { Component } from "../tui";
import { Text } from "../components/text";
import type { Theme } from "../theme/theme";
import { renderStatusLine } from "../render/status-line";
import { framedToolCard } from "../render/tool-card";
import {
	formatExpandHint,
	formatStatusIcon,
	PREVIEW_LIMITS,
	replaceTabs,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../render/render-utils";
import type { RenderResultOptions, ToolRenderer } from "./renderer";

/** Display fields captured from a debugger session. */
export interface DebugSessionSnapshot {
	id: string;
	adapter: string;
	status: string;
	cwd: string;
	program?: string;
	stopReason?: string;
	frameName?: string;
	instructionPointerReference?: string;
	source?: { path?: string };
	line?: number;
	column?: number;
	needsConfigurationDone: boolean;
	exitCode?: number;
}

/** Debug execution metadata consumed by the transcript. */
export interface DebugToolDetails {
	action: string;
	success: boolean;
	snapshot?: DebugSessionSnapshot;
}

/** Debug arguments used to describe a pending request. */
export interface DebugRenderArgs {
	action?: string;
	program?: string;
	file?: string;
	line?: number;
	function?: string;
	expression?: string;
	command?: string;
	memory_reference?: string;
	instruction_reference?: string;
	data_id?: string;
	name?: string;
}

/** Formats a debugger stop location as a source path and coordinates. */
export function formatLocation(snapshot: DebugSessionSnapshot | undefined): string | null {
	if (!snapshot?.source?.path || snapshot.line === undefined) {
		return null;
	}
	return `${snapshot.source.path}:${snapshot.line}${snapshot.column !== undefined ? `:${snapshot.column}` : ""}`;
}

/** Formats the debugger session snapshot for model and terminal output. */
export function formatSessionSnapshot(snapshot: DebugSessionSnapshot): string[] {
	const lines = [
		`Session ${snapshot.id}`,
		`Adapter: ${snapshot.adapter}`,
		`Status: ${snapshot.status}`,
		`CWD: ${snapshot.cwd}`,
	];
	if (snapshot.program) lines.push(`Program: ${snapshot.program}`);
	if (snapshot.stopReason) lines.push(`Stop reason: ${snapshot.stopReason}`);
	if (snapshot.frameName) lines.push(`Frame: ${snapshot.frameName}`);
	if (snapshot.instructionPointerReference) {
		lines.push(`Instruction pointer: ${snapshot.instructionPointerReference}`);
	}
	const location = formatLocation(snapshot);
	if (location) lines.push(`Location: ${location}`);
	if (snapshot.needsConfigurationDone) {
		lines.push("Configuration: pending configurationDone; set breakpoints, then continue.");
	}
	if (snapshot.exitCode !== undefined) lines.push(`Exit code: ${snapshot.exitCode}`);
	return lines;
}

function summarizeDebugCall(args: DebugRenderArgs): string {
	const action = args.action ? args.action.replaceAll("_", " ") : "request";
	if (args.program) {
		return `${action} ${truncateToWidth(args.program, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.file && args.line !== undefined) {
		return `${action} ${truncateToWidth(`${args.file}:${args.line}`, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.function) {
		return `${action} ${truncateToWidth(args.function, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.expression) {
		return `${action} ${truncateToWidth(args.expression, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.command) {
		return `${action} ${truncateToWidth(args.command, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.memory_reference) {
		return `${action} ${truncateToWidth(args.memory_reference, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.instruction_reference) {
		return `${action} ${truncateToWidth(args.instruction_reference, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.data_id) {
		return `${action} ${truncateToWidth(args.data_id, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.name) {
		return `${action} ${truncateToWidth(args.name, TRUNCATE_LENGTHS.TITLE)}`;
	}
	return action;
}

/** Renders debugger calls and captured execution snapshots. */
export const debugToolRenderer = {
	animatedPartialResult: true,
	renderCall(args: DebugRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		const text = renderStatusLine({ icon: "pending", title: "Debug", description: summarizeDebugCall(args) }, theme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: DebugToolDetails; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: DebugRenderArgs,
	): Component {
		return framedToolCard(theme, () => {
			const action = (args?.action ?? result.details?.action ?? "debug").replaceAll("_", " ");
			const success = !options.isPartial && !result.isError;
			const statusIcon = success
				? theme.styledSymbol("tool.debug", "accent")
				: formatStatusIcon(options.isPartial ? "running" : "error", theme, options.spinnerFrame);
			const header = `${statusIcon} Debug ${action}`;
			const summaryLines = result.details?.snapshot
				? formatSessionSnapshot(result.details.snapshot).map(line => replaceTabs(line))
				: [];
			const text = result.content.find(block => block.type === "text")?.text ?? "No output";
			const rawLines = replaceTabs(text).split("\n");
			const previewLimit = options.expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
			const displayedLines = rawLines
				.slice(0, previewLimit)
				.map(line => truncateToWidth(line, TRUNCATE_LENGTHS.LINE));
			const remaining = rawLines.length - displayedLines.length;
			if (remaining > 0) {
				displayedLines.push(
					theme.fg("muted", `… ${remaining} more lines ${formatExpandHint(theme, options.expanded, true)}`),
				);
			}
			return {
				header,
				phase: options.isPartial ? "partial" : result.isError ? "error" : "success",
				sections: [
					...(summaryLines.length > 0 ? [{ label: theme.fg("toolTitle", "Session"), content: summaryLines }] : []),
					{ label: theme.fg("toolTitle", "Output"), content: displayedLines },
				],
				applyBg: false,
			};
		});
	},
	mergeCallAndResult: true,
	inline: true,
} satisfies ToolRenderer<DebugRenderArgs, DebugToolDetails>;
