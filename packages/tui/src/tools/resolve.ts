import type { ToolRenderer } from "./renderer";

import type { Component } from "../index";
import { Text } from "../index";

import type { NativeToolView, RenderResultOptions, ToolRenderResult } from "./renderer";

import type { TspSpan } from "@oh-my-pi/pi-wire";
import { span, text } from "../native/describe";
import { OwnerMemo } from "../native/memo";
import { plainText } from "../native/spans";
import { noteText, toolHead } from "./native-view";

import type { Theme } from "../theme/theme";

import { Ellipsis, padToWidth, renderStatusLine, truncateToWidth } from "../render";

import { replaceTabs } from "../render/render-utils";

/** Command name for applying a staged action. */
export const RESOLVE_COMMAND_NAME = "resolve";

/** Command name for discarding a staged action. */
export const REJECT_COMMAND_NAME = "reject";

/** Command name for submitting a plan. */
export const PROPOSE_COMMAND_NAME = "propose";

/** Names of the staged-action commands. */
export type ResolutionCommandName =
	| typeof RESOLVE_COMMAND_NAME
	| typeof REJECT_COMMAND_NAME
	| typeof PROPOSE_COMMAND_NAME;

/** Resolution applied to a staged action. */
export type ResolveAction = "apply" | "discard";

/** Details payload carried on a resolve/reject result (and on its `ToolCommandDispatch.inner`). */
export interface ResolveDetails {
	action: ResolveAction;
	reason: string;
	sourceToolName?: string;
	label?: string;
	sourceResultDetails?: unknown;
}

/** Invoker input for queued pending-preview handlers. */
export interface ResolveInvocation {
	action: ResolveAction;
	reason: string;
}

/** First line of a string argument, tabs expanded; empty for anything else. */
function firstLine(value: unknown): string {
	return typeof value === "string" ? replaceTabs(value.trim().split("\n")[0] ?? "") : "";
}

/** Joined text blocks of a tool result. */
function resultText(result: ToolRenderResult): string {
	return result.content
		.flatMap(block => (block.type === "text" && block.text ? [block.text] : []))
		.join("\n")
		.trim();
}

/**
 * Renderer for a tool whose only argument is the string field `field`:
 * `Title: <first line>` while pending, then the same head with the result text.
 */
export function textArgumentRenderer(title: string, field: string) {
	return {
		renderCall(args: Record<string, unknown>, _options: RenderResultOptions, uiTheme: Theme): Component {
			const body = firstLine(args[field]);
			const line = renderStatusLine(
				{ icon: "pending", title, description: body ? truncateToWidth(body, 72, Ellipsis.Omit) : undefined },
				uiTheme,
			);
			return new Text(line, 0, 0);
		},

		renderResult(
			result: ToolRenderResult,
			_options: RenderResultOptions,
			uiTheme: Theme,
			args?: Record<string, unknown>,
		): Component {
			const body = firstLine(args?.[field]);
			const line = renderStatusLine(
				{
					icon: result.isError ? "error" : "success",
					title,
					description: body ? truncateToWidth(body, 72, Ellipsis.Omit) : undefined,
				},
				uiTheme,
			);
			const output = replaceTabs(resultText(result));
			const block = output ? `${line}\n${uiTheme.fg(result.isError ? "error" : "toolOutput", output)}` : line;
			return new Text(block, 0, 0);
		},

		describeCall(args: Record<string, unknown>): NativeToolView {
			return { head: toolHead(title, plainText(firstLine(args[field])) || undefined) };
		},

		describeResult(
			result: ToolRenderResult,
			_options: RenderResultOptions,
			args?: Record<string, unknown>,
		): NativeToolView {
			const output = plainText(resultText(result));
			return {
				head: toolHead(title, plainText(firstLine(args?.[field])) || undefined),
				tone: result.isError ? "error" : undefined,
				inline: true,
				body: output ? [text([span(output, result.isError ? "error" : "muted")], { wrap: "word" })] : undefined,
			};
		},

		inline: true,
		mergeCallAndResult: true,
	} satisfies ToolRenderer<Record<string, unknown>, unknown>;
}

/** Renders `propose` calls: the submitted plan title, then the approval outcome. */
export const proposeRenderer = textArgumentRenderer("Propose", "title");

const resolveResultMemo = new OwnerMemo<NativeToolView | undefined>();

/**
 * Renderer for staged-action acceptance or rejection. `defaultAction` is the
 * action a call carrying only a `reason` performs.
 */
function resolutionRenderer(defaultAction: ResolveAction) {
	return {
		renderCall(args: Partial<ResolveInvocation>, _options: RenderResultOptions, uiTheme: Theme): Component {
			const action = args.action ?? defaultAction;
			const reasonTrimmed = args.reason?.trim();
			const reason = reasonTrimmed ? truncateToWidth(reasonTrimmed, 72, Ellipsis.Omit) : undefined;
			const text = renderStatusLine(
				{
					icon: "pending",
					title: "Resolve",
					description: action,
					badge: {
						label: action === "apply" ? "proposed -> resolved" : "proposed -> rejected",
						color: action === "apply" ? "success" : "warning",
					},
					meta: reason ? [uiTheme.fg("muted", reason)] : undefined,
				},
				uiTheme,
			);
			return new Text(text, 0, 0);
		},

		renderResult(
			result: { content: Array<{ type: string; text?: string }>; details?: ResolveDetails; isError?: boolean },
			_options: RenderResultOptions,
			uiTheme: Theme,
		): Component {
			const details = result.details;
			const label = replaceTabs(details?.label ?? "pending action");
			const reason = replaceTabs(details?.reason?.trim() || "No reason provided");
			const action = details?.action ?? "apply";
			const isApply = action === "apply" && !result.isError;
			const isFailedApply = action === "apply" && result.isError;
			const bgColor = result.isError ? "error" : isApply ? "success" : "warning";
			// Bare symbol: the line is wrapped in inverse(fg(...)), so any embedded fg
			// reset (styledSymbol/status glyphs carry their own \x1b[39m) would drop the
			// inverse block back to the default background mid-line.
			const icon = uiTheme.symbol(isApply ? "tool.resolve" : "status.error");
			const verb = isApply ? "Accept" : isFailedApply ? "Failed" : "Discard";
			const separator = ": ";
			const separatorIndex = label.indexOf(separator);
			const sourceLabel = separatorIndex > 0 ? label.slice(0, separatorIndex).trim() : undefined;
			const summaryLabel = separatorIndex > 0 ? label.slice(separatorIndex + separator.length).trim() : label;
			const sourceBadge = sourceLabel
				? uiTheme.bold(`${uiTheme.format.bracketLeft}${sourceLabel}${uiTheme.format.bracketRight}`)
				: undefined;
			const headerLine = `${icon} ${uiTheme.bold(`${verb}:`)} ${summaryLabel}${sourceBadge ? ` ${sourceBadge}` : ""}`;
			const lines = ["", headerLine, "", uiTheme.italic(reason), ""];

			return {
				render(width: number): readonly string[] {
					const lineWidth = Math.max(3, width);
					const innerWidth = Math.max(1, lineWidth - 2);
					return lines.map(line => {
						const truncated = truncateToWidth(line, innerWidth, Ellipsis.Omit);
						const framed = ` ${padToWidth(truncated, innerWidth)} `;
						const padded = padToWidth(framed, lineWidth);
						return uiTheme.inverse(uiTheme.fg(bgColor, padded));
					});
				},
				invalidate() {},
			};
		},

		describeCall(args: Partial<ResolveInvocation>): NativeToolView {
			const action = args.action ?? defaultAction;
			const head: TspSpan[] = toolHead("Resolve", action);
			head.push(
				span(" "),
				span(
					action === "apply" ? "proposed → resolved" : "proposed → rejected",
					action === "apply" ? "success" : "warning",
				),
			);
			const reason = args.reason?.trim();
			return { head, inline: true, body: reason ? [noteText(reason, "muted", 1)] : undefined };
		},

		describeResult(result: {
			content: Array<{ type: string; text?: string }>;
			details?: ResolveDetails;
			isError?: boolean;
		}): NativeToolView | undefined {
			return resolveResultMemo.get(result, [], () => {
				const details = result.details;
				const label = plainText(details?.label ?? "pending action");
				const reason = plainText(details?.reason?.trim() || "No reason provided");
				const action = details?.action ?? "apply";
				const isApply = action === "apply" && !result.isError;
				const verb = isApply ? "Accept" : action === "apply" ? "Failed" : "Discard";
				const tone = result.isError ? "error" : isApply ? "success" : "warning";
				const separatorIndex = label.indexOf(": ");
				const sourceLabel = separatorIndex > 0 ? label.slice(0, separatorIndex).trim() : undefined;
				const summaryLabel = separatorIndex > 0 ? label.slice(separatorIndex + 2).trim() : label;
				const head: TspSpan[] = [span(`${verb}:`, `strong ${tone}`), span(" "), span(summaryLabel)];
				if (sourceLabel) head.push(span(" "), span(`[${sourceLabel}]`, "strong muted"));
				return {
					head,
					tone,
					inline: true,
					body: [text([span(reason, "muted")], { wrap: "word" })],
				};
			});
		},

		inline: true,
		mergeCallAndResult: true,
	} satisfies ToolRenderer<Partial<ResolveInvocation>, ResolveDetails>;
}

/** Renders `resolve` calls and the acceptance or rejection result of a staged action. */
export const resolveRenderer = resolutionRenderer("apply");

/** Renders `reject` calls; results share {@link resolveRenderer}'s acceptance/rejection block. */
export const rejectRenderer = resolutionRenderer("discard");

/** Whether a command name is one of the staged-action commands. */
export function isResolutionCommandName(name: string): name is ResolutionCommandName {
	return name === RESOLVE_COMMAND_NAME || name === REJECT_COMMAND_NAME || name === PROPOSE_COMMAND_NAME;
}
