import { Box, type Component, Markdown } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import type { BranchSummaryMessage, CompactionSummaryMessage, CustomMessage } from "../../session/messages";

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

class SummaryDividerComponent implements Component {
	#expanded = false;
	#cache?: { width: number; lines: string[] };
	#detail?: Box;

	constructor(private readonly options: SummaryDividerOptions) {}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.#cache = undefined;
	}

	invalidate(): void {
		this.#cache = undefined;
		// Theme may have changed — rebuild the detail box lazily on next render.
		this.#detail = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) {
			return this.#cache.lines;
		}
		const lines = this.#expanded
			? ["", this.#divider(width), "", ...this.#detailBox().render(width)]
			: ["", this.#divider(width), ""];
		this.#cache = { width, lines };
		return lines;
	}

	#divider(width: number): string {
		const rule = theme.tree.horizontal;
		const label = this.options.label();
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

	#detailBox(): Box {
		if (this.#detail) return this.#detail;
		const box = new Box(1, 1, t => theme.bg("customMessageBg", t));
		box.setIgnoreTight(true);
		box.addChild(
			new Markdown(this.options.detailMarkdown(), 0, 0, getMarkdownTheme(), {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
		this.#detail = box;
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
export class CompactionSummaryMessageComponent implements Component {
	#divider: SummaryDividerComponent;

	constructor(private readonly message: CompactionSummaryMessage) {
		this.#divider = new SummaryDividerComponent({
			// A dead-end warning stamped by the progress guard badges the bar;
			// the full text lives in the ctrl+o detail block below.
			label: () => this.#label(),
			detailMarkdown: () => this.#detailMarkdown(),
		});
	}

	#label(): string {
		const name = (this.message.method && COMPACTION_METHOD_LABELS[this.message.method]) || "compacted";
		let label = `${theme.icon.camera} ${name}`;
		const amount = compactionAmount(this.message);
		if (amount) label += `${theme.sep.dot}${amount}`;
		if (this.message.warning) label += ` ${theme.fg("warning", theme.icon.warning)}`;
		return label;
	}

	setExpanded(expanded: boolean): void {
		this.#divider.setExpanded(expanded);
	}

	invalidate(): void {
		this.#divider.invalidate();
	}

	render(width: number): readonly string[] {
		return this.#divider.render(width);
	}

	#detailMarkdown(): string {
		const tokenLine =
			this.message.tokensBefore > 0
				? this.message.tokensAfter !== undefined
					? `Compacted from ${this.message.tokensBefore.toLocaleString()} to ${this.message.tokensAfter.toLocaleString()} tokens`
					: `Compacted from ${this.message.tokensBefore.toLocaleString()} tokens`
				: this.message.tokensAfter !== undefined
					? `Compacted to ${this.message.tokensAfter.toLocaleString()} tokens`
					: "Compacted context";
		const frameCount = this.message.images?.length ?? 0;
		const frameNote =
			frameCount > 0 ? `\n\n_${frameCount} snapcompact frame${frameCount === 1 ? "" : "s"} attached_` : "";
		const warningNote = this.message.warning ? `\n\n${theme.icon.warning} **Warning:** ${this.message.warning}` : "";
		return `**${tokenLine}**${warningNote}\n\n${this.message.summary}${frameNote}`;
	}
}

/**
 * Handoff is a compaction strategy too, but it is persisted as a custom message
 * so the LLM sees the handoff-specific developer context. Render it with the
 * same divider affordance as `/compact` instead of the generic `[handoff]` box.
 */
export class HandoffSummaryMessageComponent implements Component {
	#divider: SummaryDividerComponent;

	constructor(private readonly message: CustomMessage<unknown>) {
		this.#divider = new SummaryDividerComponent({
			label: () => `${theme.icon.context} handed-off`,
			detailMarkdown: () => this.#detailMarkdown(),
		});
	}

	setExpanded(expanded: boolean): void {
		this.#divider.setExpanded(expanded);
	}

	invalidate(): void {
		this.#divider.invalidate();
	}

	render(width: number): readonly string[] {
		return this.#divider.render(width);
	}

	#detailMarkdown(): string {
		const document = extractHandoffDocument(getCustomMessageText(this.message));
		return `**Handoff context**\n\n${document || "_No handoff content._"}`;
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
export class BranchSummaryMessageComponent implements Component {
	#divider: SummaryDividerComponent;

	constructor(private readonly message: BranchSummaryMessage) {
		this.#divider = new SummaryDividerComponent({
			label: () => `${theme.icon.branch} branch`,
			detailMarkdown: () => `**Branch summary**\n\n${this.message.summary}`,
		});
	}

	setExpanded(expanded: boolean): void {
		this.#divider.setExpanded(expanded);
	}

	invalidate(): void {
		this.#divider.invalidate();
	}

	render(width: number): readonly string[] {
		return this.#divider.render(width);
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
