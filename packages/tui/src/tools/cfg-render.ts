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
import type { RenderResultOptions } from "./renderer";
import { card, type CardToolResult, firstText, safe } from "./result-card";

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
