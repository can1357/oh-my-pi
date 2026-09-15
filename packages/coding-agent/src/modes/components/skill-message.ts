import type { TextContent } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Box, Container, Markdown, Spacer, Text } from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import type { CustomMessage, SkillPromptDetails } from "../../session/messages";
import { fileHyperlink } from "../../tui";
import { collapseSkillTokens, skillChipLabel, skillChipStyle, skillToken } from "../composer-attachments";
import { type UserBubbleOptions, UserMessageComponent, userBubbleColor } from "./user-message";

/**
 * Transcript row for a user-invoked skill. Two layouts, chosen by where the
 * `/skill:<name>` token sat in the submitted draft:
 *
 * - **Callout** (token first): a user bubble with a skill-colored left rail,
 *   the skill chip and prompt size as its header, then the rest of the draft
 *   as full Markdown.
 * - **Inline** (token mid-prompt): a plain user bubble with the token drawn
 *   as the same soft-pill chip the composer showed.
 *
 * In both, the chip is an OSC 8 link to the SKILL.md. Expanding (tool-output
 * toggle) appends the rendered skill prompt.
 */
export class SkillMessageComponent extends Container {
	#expanded = false;

	constructor(
		private readonly message: CustomMessage<SkillPromptDetails>,
		private readonly imageLinks?: readonly (string | undefined)[],
	) {
		super();
		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) {
			this.#expanded = expanded;
			this.#rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.#rebuild();
	}

	#rebuild(): void {
		this.clear();
		const details = this.message.details;
		const name = details?.name?.trim() || "unknown";
		const token = skillToken(name);
		const prompt = details?.prompt ?? (details?.args ? `${token} ${details.args}` : token);
		// Display-only collapse: only the invoked skill becomes a chip; a second `/skill:` token the
		// dispatcher ignored stays literal so the transcript never claims a skill that never loaded.
		const display = collapseSkillTokens(
			prompt,
			candidate => candidate === name,
			() => {},
		);
		const label = skillChipLabel(name);
		const leading = display.startsWith(label) && /^\s*$/.test(display.charAt(label.length));
		const bubble: UserBubbleOptions = {
			imageLinks: this.imageLinks,
			skillPath: candidate => (candidate === name ? details?.path : undefined),
		};

		const header = new Text(this.#header(label, details), 0, 0);
		if (!leading) {
			this.addChild(new UserMessageComponent(display, bubble));
			if (this.#expanded) this.addChild(new SkillCallout([header, ...this.#promptSection(bubble)]));
			return;
		}

		const body = display.slice(label.length).trim();
		const children: Component[] = [header];
		if (body) children.push(new Spacer(1), this.#markdown(body, bubble));
		if (this.#expanded) children.push(...this.#promptSection(bubble));
		this.addChild(new SkillCallout(children));
	}

	#markdown(text: string, bubble: UserBubbleOptions): Markdown {
		const md = new Markdown(text, 0, 0, getMarkdownTheme(), {
			bgColor: value => theme.bg("userMessageBg", value),
			color: userBubbleColor(bubble),
		});
		md.setIgnoreTight(true);
		return md;
	}

	/** Chip linked to its SKILL.md, then the muted prompt size. */
	#header(label: string, details: SkillPromptDetails | undefined): string {
		const chip = skillChipStyle(label, bubbleReset());
		const parts = [details?.path ? fileHyperlink(details.path, chip, { line: 1 }) : chip];
		if (typeof details?.lineCount === "number") {
			parts.push(theme.fg("muted", `${details.lineCount} ${details.lineCount === 1 ? "line" : "lines"}`));
		}
		return parts.join("  ");
	}

	/** The rendered SKILL.md prompt under a calm subheader (expanded view only). */
	#promptSection(bubble: UserBubbleOptions): Component[] {
		const text = this.#extractText();
		if (!text) return [];
		return [new Spacer(1), new Text(theme.fg("muted", "prompt"), 0, 0), new Spacer(1), this.#markdown(text, bubble)];
	}

	#extractText(): string {
		if (typeof this.message.content === "string") {
			return this.message.content;
		}
		return this.message.content
			.filter((c): c is TextContent => c.type === "text")
			.map(c => c.text)
			.join("\n");
	}
}

/** Bubble foreground + background to re-arm after an inline chip. */
function bubbleReset(): string {
	return `${theme.getFgOnBgAnsi("userMessageText", "userMessageBg")}${theme.getBgAnsi("userMessageBg")}`;
}

/**
 * A user-bubble box with a skill-colored rail down its left edge. Memoized on the
 * inner box's render so the transcript's incremental assembly sees stable rows.
 */
class SkillCallout implements Component {
	readonly #box: Box;
	#source: readonly string[] | undefined;
	#lines: string[] | undefined;

	constructor(children: readonly Component[]) {
		this.#box = new Box(1, 1, value => theme.bgFill("userMessageBg", value));
		this.#box.setIgnoreTight(true);
		for (const child of children) this.#box.addChild(child);
	}

	invalidate(): void {
		this.#box.invalidate();
		this.#source = undefined;
		this.#lines = undefined;
	}

	render(width: number): readonly string[] {
		const inner = this.#box.render(Math.max(1, width - 1));
		if (this.#source === inner && this.#lines !== undefined) return this.#lines;
		const rail = theme.bg("userMessageBg", theme.fg("customMessageLabel", theme.symbol("skill.rail")));
		const lines = inner.map(line => rail + line);
		this.#source = inner;
		this.#lines = lines;
		return lines;
	}
}
