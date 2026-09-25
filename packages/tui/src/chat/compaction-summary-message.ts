import { Box } from "../components/box";
import { Disclosure } from "../components/disclosure";
import { type Component } from "../tui";
import { Markdown } from "../components/markdown";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { getMarkdownTheme, theme } from "../theme";
import type { BranchSummaryMessage, CompactionSummaryMessage, CustomMessage } from "./messages";

/** Divider labels per compaction method; unknown/legacy methods fall back to "compacted". */
const COMPACTION_METHOD_LABELS: Record<string, string> = {
	remote: "remote-compacted",
	soft: "soft-compacted",
	handoff: "handed-off",
	snapcompact: "snap-compacted",
	shake: "shaken",
};

/** `256K→20K` amount badge, or undefined when the entry predates `tokensAfter`. */
function compactionAmount(message: CompactionSummaryMessage): string | undefined {
	if (message.tokensAfter === undefined || message.tokensBefore <= 0) return undefined;
	return `${formatNumber(message.tokensBefore)}→${formatNumber(message.tokensAfter)}`;
}

interface SummaryDividerOptions {
	label: () => string;
	detailMarkdown: () => string;
}

/**
 * Width-aware divider banner shared as every history-collapse summary row:
 * blank, the labeled rule (or the bare label when too narrow to frame), blank.
 */
class DividerSummary implements Component {
	readonly #label: () => string;
	#cache: { width: number; lines: readonly string[] } | undefined;

	constructor(label: () => string) {
		this.#label = label;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) return this.#cache.lines;
		const lines = ["", this.#divider(width), ""];
		this.#cache = { width, lines };
		return lines;
	}

	#divider(width: number): string {
		const rule = theme.tree.horizontal;
		const label = this.#label();
		// sep.dot ships pre-padded (" · "); trim so the hint joins with single spaces.
		const hint = `${theme.sep.dot.trim()} ctrl+o`;
		const plainWidth = Bun.stringWidth(`${label} ${hint}`, { countAnsiEscapeCodes: false });
		// ` label hint ` framed by rules on both sides.
		const remaining = width - plainWidth - 2;
		if (remaining < 4) {
			// Too narrow for a framed rule — emit the bare label.
			return theme.fg("muted", label);
		}
		const left = Math.floor(remaining / 2);
		const right = remaining - left;
		return (
			theme.fg("dim", rule.repeat(left)) +
			` ${theme.fg("muted", label)} ${theme.fg("dim", hint)} ` +
			theme.fg("dim", rule.repeat(right))
		);
	}
}

/**
 * Common summary/detail delegate behind the compaction, handoff, and branch
 * banners: the width-aware divider is always shown while the Markdown detail
 * box is constructed lazily only on the first expanded render and retained
 * across collapse/re-expand cycles.
 */
class SummaryMessageComponent implements Component {
	#disclosure: Disclosure;
	#ignoreTight: boolean | undefined;
	#disposed = false;

	readonly #options: SummaryDividerOptions;

	constructor(options: SummaryDividerOptions) {
		this.#options = options;
		this.#disclosure = this.#createDisclosure(false);
	}

	setExpanded(expanded: boolean): void {
		this.#disclosure.setExpanded(expanded);
	}

	setIgnoreTight(ignore: boolean): this {
		if (this.#disposed || this.#ignoreTight === ignore) return this;
		this.#ignoreTight = ignore;
		this.#disclosure.setIgnoreTight(ignore);
		return this;
	}

	invalidate(): void {
		if (this.#disposed) return;
		// Theme may have changed — rebuild the delegate unmaterialized so the
		// detail box picks up fresh styling lazily on its next expanded render.
		const expanded = this.#disclosure.expanded;
		this.#disclosure.dispose();
		this.#disclosure = this.#createDisclosure(expanded);
		if (this.#ignoreTight !== undefined) this.#disclosure.setIgnoreTight(this.#ignoreTight);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#disclosure.dispose();
	}

	render(width: number): readonly string[] {
		return this.#disclosure.render(width);
	}

	#createDisclosure(expanded: boolean): Disclosure {
		return new Disclosure({
			summary: new DividerSummary(this.#options.label),
			body: () => this.#detailBox(),
			expanded,
		});
	}

	#detailBox(): Box {
		const box = new Box(1, 1, t => theme.bg("customMessageBg", t));
		box.setIgnoreTight(true);
		box.addChild(
			new Markdown(this.#options.detailMarkdown(), 0, 0, getMarkdownTheme(), {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
		return box;
	}
}

/**
 * Compaction point in the transcript, rendered as a slim horizontal divider:
 *
 *   ──────── 📷 remote-compacted · 256K→20K · ctrl+o ────────
 *
 * The label names the maintenance method that fired (remote/soft/handoff/
 * snapcompact; "compacted" for legacy or extension-provided entries) and the
 * before → after context amounts when the entry recorded them. The
 * conversation above the divider stays visible (display transcript keeps
 * full history); only the LLM context was reset. Expanding (ctrl+o) reveals
 * the compaction summary below the divider.
 */
export class CompactionSummaryMessageComponent extends SummaryMessageComponent {
	constructor(message: CompactionSummaryMessage) {
		super({
			// A dead-end warning stamped by the progress guard badges the bar;
			// the full text lives in the ctrl+o detail block below.
			label: () => compactionLabel(message),
			detailMarkdown: () => compactionDetailMarkdown(message),
		});
	}
}

function compactionLabel(message: CompactionSummaryMessage): string {
	const name = (message.method && COMPACTION_METHOD_LABELS[message.method]) || "compacted";
	let label = `${theme.icon.camera} ${name}`;
	const amount = compactionAmount(message);
	if (amount) label += `${theme.sep.dot}${amount}`;
	if (message.warning) label += ` ${theme.fg("warning", theme.icon.warning)}`;
	return label;
}

function compactionDetailMarkdown(message: CompactionSummaryMessage): string {
	const tokenLine =
		message.tokensBefore > 0
			? message.tokensAfter !== undefined
				? `Compacted from ${message.tokensBefore.toLocaleString()} to ${message.tokensAfter.toLocaleString()} tokens`
				: `Compacted from ${message.tokensBefore.toLocaleString()} tokens`
			: message.tokensAfter !== undefined
				? `Compacted to ${message.tokensAfter.toLocaleString()} tokens`
				: "Compacted context";
	const frameCount = message.images?.length ?? 0;
	const frameNote =
		frameCount > 0 ? `\n\n_${frameCount} snapcompact frame${frameCount === 1 ? "" : "s"} attached_` : "";
	const warningNote = message.warning ? `\n\n${theme.icon.warning} **Warning:** ${message.warning}` : "";
	return `**${tokenLine}**${warningNote}\n\n${message.summary}${frameNote}`;
}

/**
 * Handoff is a compaction strategy too, but it is persisted as a custom message
 * so the LLM sees the handoff-specific developer context. Render it with the
 * same divider affordance as `/compact` instead of the generic `[handoff]` box.
 */
export class HandoffSummaryMessageComponent extends SummaryMessageComponent {
	constructor(message: CustomMessage<unknown>) {
		super({
			label: () => `${theme.icon.context} handed-off`,
			detailMarkdown: () => {
				const document = extractHandoffDocument(getCustomMessageText(message));
				return `**Handoff context**\n\n${document || "_No handoff content._"}`;
			},
		});
	}
}

export function createHandoffSummaryMessageComponent(
	message: CustomMessage<unknown>,
	expanded: boolean,
): HandoffSummaryMessageComponent | undefined {
	if (message.customType !== "handoff" || !message.display) return undefined;
	const component = new HandoffSummaryMessageComponent(message);
	component.setExpanded(expanded);
	return component;
}

/**
 * A branch summary collapses a side branch back into the main line. Render it
 * with the same slim divider as `/compact` and handoff rather than a `[branch]`
 * box, so every history-collapse point reads as one consistent banner.
 */
export class BranchSummaryMessageComponent extends SummaryMessageComponent {
	constructor(message: BranchSummaryMessage) {
		super({
			label: () => `${theme.icon.branch} branch`,
			detailMarkdown: () => `**Branch summary**\n\n${message.summary}`,
		});
	}
}

function getCustomMessageText(message: CustomMessage<unknown>): string {
	if (typeof message.content === "string") return message.content;
	let firstText: string | undefined;
	let parts: string[] | undefined;
	for (const content of message.content) {
		if (content.type !== "text") continue;
		if (firstText === undefined) {
			firstText = content.text;
			continue;
		}
		if (parts === undefined) {
			parts = [firstText];
		}
		parts.push(content.text);
	}
	return parts === undefined ? (firstText ?? "") : parts.join("\n");
}

function extractHandoffDocument(text: string): string {
	const openTag = "<handoff-context>";
	const closeTag = "</handoff-context>";
	const openIndex = text.indexOf(openTag);
	if (openIndex === -1) return text.trim();

	const contentStart = openIndex + openTag.length;
	const closeIndex = text.indexOf(closeTag, contentStart);
	const document = closeIndex === -1 ? text.slice(contentStart) : text.slice(contentStart, closeIndex);
	return document.trim();
}
