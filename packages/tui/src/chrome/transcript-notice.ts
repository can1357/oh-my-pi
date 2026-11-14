import type { TspText } from "@oh-my-pi/pi-wire";
import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import { node, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { styledSpans } from "../native/spans";
import { theme } from "../theme";
import type { Component } from "../tui";
import { TranscriptBlock } from "./transcript-container";

/** How loud an inline transcript notice is; a native terminal styles it as `omp.notice.<tone>`. */
export type NoticeTone = "info" | "success" | "warning" | "error";

/** Each tone's default icon. */
const ICONS: Readonly<Record<NoticeTone, string>> = {
	info: "info",
	success: "success",
	warning: "warning",
	error: "error",
};

/**
 * The word a warning or error leads with: a text terminal writes it
 * (`Warning: …`); a native row leaves it to the icon, whose name it becomes
 * for screen readers.
 */
const LABELS = { warning: "Warning", error: "Error" } as const;

/** Optional parts of a {@link noticeRow}. */
export interface NoticeRowOptions {
	/** Icon name in place of the tone's own (`read` for a file read, `download` for an update). */
	readonly icon?: string;
	readonly key?: string;
}

/**
 * One inline transcript notice for a native terminal (`omp.notice.<tone>`): a
 * leading icon beside the wrapped message. Warnings, errors, background-job
 * completions and prompt file reads all draw as this row, so they read alike.
 * The tone colors the icon (an info notice keeps it quiet); the message spans
 * carry emphasis only (`path`, `mono`, `dim`), never the tone itself.
 */
export function noticeRow(tone: NoticeTone, message: TspText, options: NoticeRowOptions = {}): NativeNode {
	const icon = node("icon", {
		name: options.icon ?? ICONS[tone],
		tone: tone === "info" ? undefined : tone,
		aria: tone === "warning" || tone === "error" ? LABELS[tone] : undefined,
	});
	return node(
		"row",
		{ role: `omp.notice.${tone}`, tone, gap: "sm", align: "start" },
		[icon, text(message, { wrap: "word", grow: 1, shrink: 1 })],
		options.key,
	);
}

/**
 * A transcript block that a native terminal draws as one {@link noticeRow}
 * while a text terminal draws `ansi`.
 */
export class TranscriptNotice extends TranscriptBlock {
	readonly #native: NativeNode;

	constructor(native: NativeNode, ansi: readonly Component[]) {
		super();
		for (const child of ansi) this.addChild(child);
		this.#native = native;
	}

	/**
	 * `showWarning` / `showError`: a blank row and the `Warning: …` / `Error: …`
	 * line in its color in a text terminal; natively the tone's icon and the
	 * message, the label left to the icon.
	 */
	static line(tone: "warning" | "error", message: string): TranscriptNotice {
		const line = new Text(`${LABELS[tone]}: ${message}`, 1, 0).setStyleFn(t => theme.fg(tone, t));
		return new TranscriptNotice(noticeRow(tone, styledSpans(message)), [new Spacer(1), line]);
	}

	override describe(): NativeNode {
		return this.#native;
	}
}
