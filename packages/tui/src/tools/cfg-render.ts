/**
 * Transcript renderers for `cfg://` settings reads and writes.
 *
 * Reads show the YAML-ish settings listing the model received, highlighted as
 * YAML. Writes show the `previous → value` change, its scope (session or
 * saved), and whether the user approved it.
 */
import type { Component } from "../tui";
import { renderStatusLine } from "../render";
import {
	cappedHeadLines,
	formatBadge,
	formatErrorDetail,
	formatMoreItems,
	PREVIEW_LIMITS,
} from "../render/render-utils";
import { highlightCode, type Theme } from "../theme/theme";
import { parseCfgUrl } from "./cfg-url";
import type { NativeToolView, RenderResultOptions } from "./renderer";
import { card, type CardToolResult, firstText, safe } from "./result-card";
import { code, compact, span, text } from "../native/describe";
import { plainText } from "../native/spans";
import { errorView, toolHead } from "./native-view";

/** Summary of a `cfg://` read, attached to read tool details. */
export interface CfgReadDetails {
	/** Dotted setting path or namespace that was read; empty for the whole tree. */
	path: string;
	/** Settings in the listing. */
	count: number;
	/** Listed settings whose effective value differs from the schema default. */
	modified: number;
}

/** How a `cfg://` write ended. */
export type CfgWriteOutcome = "applied" | "declined" | "unchanged";

/** A `cfg://` write, attached to write tool details. Values are display-formatted (credentials redacted). */
export interface CfgWriteDetails {
	path: string;
	/** Persisted to config.yml rather than scoped to the session. */
	save: boolean;
	previous: string;
	value: string;
	outcome: CfgWriteOutcome;
	/** Effective value after saving when a higher-precedence layer still shadows the saved one. */
	effective?: string;
}

/** Render `read cfg://…`: pending header, or the highlighted listing with counts. */
export function renderCfgRead(
	url: string,
	result: CardToolResult | undefined,
	details: CfgReadDetails | undefined,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	return card((_width, expanded) => {
		const meta: string[] = [];
		if (details) {
			meta.push(details.count === 1 ? "1 setting" : `${details.count} settings`);
			if (details.modified) meta.push(`${details.modified} modified`);
		}
		const header = renderStatusLine(
			{
				icon: result === undefined ? "pending" : result.isError ? "error" : "info",
				title: "Config",
				description: (details?.path ?? parseCfgUrl(url)?.segments.join(".")) || "all settings",
				meta,
			},
			theme,
		);
		if (!result) return [header];
		if (result.isError) return [header, formatErrorDetail(firstText(result) || "Settings read failed.", theme)];
		const body = firstText(result).trimEnd().split("\n");
		const shown = cappedHeadLines(body, expanded ? body.length : PREVIEW_LIMITS.COLLAPSED_ITEMS);
		const lines = [header, ...highlightCode(safe(shown.lines.join("\n")), "yaml", theme).map(line => `  ${line}`)];
		if (shown.hidden) lines.push(theme.fg("dim", `  ${formatMoreItems(shown.hidden, "line")}`));
		return lines;
	}, options);
}

/** TSP view of `read cfg://…`: path and counts in the head, the listing as YAML. */
export function describeCfgRead(
	url: string,
	result: CardToolResult | undefined,
	details: CfgReadDetails | undefined,
): NativeToolView {
	const description = (details?.path ?? parseCfgUrl(url)?.segments.join(".")) || "all settings";
	const meta: string[] = [];
	if (details) {
		meta.push(details.count === 1 ? "1 setting" : `${details.count} settings`);
		if (details.modified) meta.push(`${details.modified} modified`);
	}
	if (result?.isError) return errorView("Config", firstText(result) || "Settings read failed.", description, ...meta);
	const head = toolHead("Config", description, ...meta);
	if (!result) return { head };
	const listing = plainText(safe(firstText(result).trimEnd()));
	return {
		head,
		body: listing ? [code(listing, { lang: "yaml" })] : undefined,
		preview: { lines: PREVIEW_LIMITS.COLLAPSED_ITEMS },
	};
}

/** TSP view of `write cfg://…[/save]`: scope/outcome in the head, then `previous → value`. */
export function describeCfgWrite(
	url: string,
	content: string | undefined,
	result: CardToolResult | undefined,
	details: CfgWriteDetails | undefined,
): NativeToolView {
	const target = parseCfgUrl(url);
	const path = details?.path ?? target?.segments.join(".");
	const save = details?.save ?? target?.save ?? false;
	if (result?.isError) return errorView("Config", firstText(result) || "Settings write failed.", path);
	const head = toolHead("Config", path);
	head.push(span(" "), span(save ? "persist" : "session", save ? "accent strong" : "muted"));
	if (details?.outcome === "declined") head.push(span(" "), span("declined", "warning strong"));
	if (details?.outcome === "unchanged") head.push(span(" "), span("unchanged", "muted"));
	const next = span(plainText(details?.value ?? content?.trim() ?? "…"), "toolOutput");
	const change = details
		? [span(plainText(details.previous), "dim"), span(" → ", "dim"), next]
		: [span("→ ", "dim"), next];
	return {
		head,
		tone: details?.outcome === "declined" ? "warning" : undefined,
		body: compact([
			text(change, { wrap: "word" }),
			details?.effective !== undefined
				? text(
						[
							span(
								`still ${plainText(details.effective)}: a higher-precedence layer overrides the saved value`,
								"warning",
							),
						],
						{ wrap: "word" },
					)
				: undefined,
		]),
	};
}

/** Render `write cfg://…[/save]`: the proposed value while pending, then the approved/declined change. */
export function renderCfgWrite(
	url: string,
	content: string | undefined,
	result: CardToolResult | undefined,
	details: CfgWriteDetails | undefined,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	return card(() => {
		const target = parseCfgUrl(url);
		const save = details?.save ?? target?.save ?? false;
		const icon =
			result === undefined
				? "pending"
				: result.isError
					? "error"
					: details?.outcome === "declined"
						? "warning"
						: "success";
		const badges = [formatBadge(save ? "persist" : "session", save ? "accent" : "muted", theme)];
		if (details?.outcome === "declined") badges.push(formatBadge("declined", "warning", theme));
		if (details?.outcome === "unchanged") badges.push(formatBadge("unchanged", "muted", theme));
		const header = `${renderStatusLine({ icon, title: "Config", description: details?.path ?? target?.segments.join(".") }, theme)} ${badges.join(" ")}`;
		if (result?.isError) return [header, formatErrorDetail(firstText(result) || "Settings write failed.", theme)];
		const arrow = theme.fg("dim", "→");
		const next = theme.fg("toolOutput", details?.value ?? content?.trim() ?? "…");
		const lines = [
			header,
			details ? `  ${theme.fg("dim", details.previous)} ${arrow} ${next}` : `  ${arrow} ${next}`,
		];
		if (details?.effective !== undefined)
			lines.push(
				theme.fg("warning", `  still ${details.effective}: a higher-precedence layer overrides the saved value`),
			);
		return lines;
	}, options);
}
