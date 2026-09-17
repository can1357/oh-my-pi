import type { ToolRenderer } from "./renderer";

import type { Component } from "../index";
import { Text } from "../index";

import type { RenderResultOptions } from "./renderer";

import type { Theme } from "../theme/theme";

import { Ellipsis, padToWidth, renderStatusLine, truncateToWidth } from "../render";

import { replaceTabs } from "../render/render-utils";

/** Device name for applying a staged action. */
export const RESOLVE_DEVICE_NAME = "resolve";

/** Device name for discarding a staged action. */
export const REJECT_DEVICE_NAME = "reject";

/** Device name for submitting a plan. */
export const PROPOSE_DEVICE_NAME = "propose";

/** Plain-text staged-action device names. */
export type ResolutionDeviceName = typeof RESOLVE_DEVICE_NAME | typeof REJECT_DEVICE_NAME | typeof PROPOSE_DEVICE_NAME;

/** Resolution applied to a staged action. */
export type ResolveAction = "apply" | "discard";

/** Details payload carried on a resolve/reject dispatch result (`XdevDispatch.inner`). */
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

/** Streaming-safe call preview for a resolution-device write: `Resolve/Reject/Propose: <text>`. */
export function renderResolutionDeviceCall(device: ResolutionDeviceName, content: unknown, uiTheme: Theme): Component {
	const body = typeof content === "string" ? replaceTabs(content.trim().split("\n")[0] ?? "") : "";
	const title = device === PROPOSE_DEVICE_NAME ? "Propose" : device === REJECT_DEVICE_NAME ? "Reject" : "Resolve";
	const text = renderStatusLine(
		{
			icon: "pending",
			title,
			description: body ? truncateToWidth(body, 72, Ellipsis.Omit) : undefined,
		},
		uiTheme,
	);
	return new Text(text, 0, 0);
}

/** Render staged-action acceptance or rejection. */
export const resolveRenderer = {
	renderCall(args: Partial<ResolveInvocation>, _options: RenderResultOptions, uiTheme: Theme): Component {
		const reasonTrimmed = args.reason?.trim();
		const reason = reasonTrimmed ? truncateToWidth(reasonTrimmed, 72, Ellipsis.Omit) : undefined;
		const text = renderStatusLine(
			{
				icon: "pending",
				title: "Resolve",
				description: args.action,
				badge: {
					label: args.action === "apply" ? "proposed -> resolved" : "proposed -> rejected",
					color: args.action === "apply" ? "success" : "warning",
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

	inline: true,
	mergeCallAndResult: true,
} satisfies ToolRenderer<Partial<ResolveInvocation>, ResolveDetails>;

/** Whether an xd:// device name is one of the plain-text resolution devices. */
export function isResolutionDeviceName(name: string): name is ResolutionDeviceName {
	return name === RESOLVE_DEVICE_NAME || name === REJECT_DEVICE_NAME || name === PROPOSE_DEVICE_NAME;
}
