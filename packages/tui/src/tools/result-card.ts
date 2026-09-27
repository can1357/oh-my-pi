/**
 * Line-based status cards shared by the internal-URL renderers (`proc://`,
 * `agent://`, `cfg://`): a header plus sanitized, width-truncated body lines.
 */
import type { Component } from "../tui";
import { createCachedComponent, Ellipsis, truncateToWidth } from "../render";
import { replaceTabs } from "../render/render-utils";
import type { RenderResultOptions } from "./renderer";

/** Tool result fields the card renderers read. */
export interface CardToolResult {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

/** First text block of a tool result, or `""`. */
export function firstText(result: CardToolResult): string {
	return result.content.find(item => item.type === "text")?.text ?? "";
}

/** Sanitize one display line: tabs become spaces, carriage returns are dropped. */
export function safe(value: string): string {
	return replaceTabs(value).replace(/\r/g, "");
}

/** Padded card whose lines are sanitized and truncated, re-rendered when the expanded state flips. */
export function card(lines: (width: number, expanded: boolean) => string[], options: RenderResultOptions): Component {
	return createCachedComponent(
		() => Boolean(options.expanded),
		(width, expanded) =>
			lines(width, expanded)
				.flatMap(line => line.split("\n"))
				.map(line => truncateToWidth(safe(line), width, Ellipsis.Unicode)),
		{ paddingX: 1 },
	);
}
