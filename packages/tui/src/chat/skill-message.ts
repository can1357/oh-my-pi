import type { TextContent } from "@oh-my-pi/pi-ai";
import { type Component } from "../tui";
import { Box } from "../components/box";
import { Disclosure } from "../components/disclosure";
import { Container } from "../tui";
import { Markdown } from "../components/markdown";
import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import { getMarkdownTheme, theme } from "../theme";
import type { CustomMessage, SkillPromptDetails, SkillPromptSkill } from "./messages";
import { fileHyperlink } from "../render";
import { collapseSkillTokens, skillChipLabel, skillChipStyle, skillToken } from "../prompt/composer-attachments";
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
	// Canonical and replayed skill cards finalize immediately so they retire to
	// native scrollback like any settled block. An optimistically-painted
	// `/skill:` row (issue #11217) is instead held live until its canonical
	// `message_start` reconciles it, so it stays removable and never leaves a
	// duplicate behind in scrollback if reconcile swaps it out.
	#transcriptBlockFinalized = true;
	// Controlled expansion delegate. In callout mode it is the prompt-only
	// disclosure nested inside the single continuous SkillCallout rail; in
	// inline mode it pairs the user bubble summary with a lazy SkillCallout
	// body. Rebuilt (unmaterialized) on invalidate so header/body pick up the
	// current theme without eagerly constructing the expanded prompt.
	#disclosure: Disclosure | undefined;

	readonly #message: CustomMessage<SkillPromptDetails>;
	readonly #imageLinks?: readonly (string | undefined)[];

	constructor(message: CustomMessage<SkillPromptDetails>, imageLinks?: readonly (string | undefined)[]) {
		super();
		this.#message = message;
		this.#imageLinks = imageLinks;

		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		this.#disclosure?.setExpanded(expanded);
	}

	/**
	 * Transcript finalization contract (see `FinalizableBlock`): an optimistic
	 * `/skill:` row reports `false` so the container keeps it live and removable
	 * until reconcile; every other skill card is finalized on creation.
	 */
	isTranscriptBlockFinalized(): boolean {
		return this.#transcriptBlockFinalized;
	}

	/** Hold this card live as an unreconciled optimistic `/skill:` row (#11217). */
	markTranscriptBlockPending(): void {
		this.#transcriptBlockFinalized = false;
	}

	/** Finalize an optimistic row adopted in place after it already retired to
	 *  scrollback before its canonical `message_start` arrived (#11217). */
	markTranscriptBlockFinalized(): void {
		this.#transcriptBlockFinalized = true;
	}

	override invalidate(): void {
		this.#rebuild();
	}

	override dispose(): void {
		this.#disclosure?.dispose();
		super.dispose();
	}

	#rebuild(): void {
		const expanded = this.#disclosure?.expanded ?? false;
		this.#disclosure?.dispose();
		this.clear();
		const details = this.#message.details;
		const loaded: SkillPromptSkill[] = details?.skills?.length
			? details.skills
			: [
					{
						name: details?.name?.trim() || "unknown",
						path: details?.path ?? "",
						lineCount: details?.lineCount ?? 0,
					},
				];
		const byName = new Map(loaded.map(s => [s.name, s]));
		const prompt =
			details?.prompt ??
			(details?.args ? `${skillToken(loaded[0].name)} ${details.args}` : skillToken(loaded[0].name));

		// Display-only collapse: every loaded skill becomes a chip; a token that did not load stays literal.
		const display = collapseSkillTokens(
			prompt,
			name => byName.has(name),
			() => {},
		);

		const bubble: UserBubbleOptions = {
			imageLinks: this.#imageLinks,
			skillPath: name => byName.get(name)?.path || undefined,
		};

		const headerSkills: SkillPromptSkill[] = [];
		let rest = display;
		while (true) {
			const nextSkill = loaded.find(
				s =>
					!headerSkills.includes(s) &&
					rest.startsWith(skillChipLabel(s.name)) &&
					/^\s*$/.test(rest.charAt(skillChipLabel(s.name).length)),
			);
			if (!nextSkill) break;
			headerSkills.push(nextSkill);
			rest = rest.slice(skillChipLabel(nextSkill.name).length).trimStart();
		}

		const leading = headerSkills.length > 0;
		if (!leading) {
			this.#disclosure = new Disclosure({
				summary: new UserMessageComponent(display, bubble),
				// Prompt extraction and Markdown layout stay lazy: the factory
				// runs on the first expanded render, reading the current theme.
				body: () => new SkillCallout([new Text(this.#header(loaded), 0, 0), ...this.#promptSection(bubble)]),
				expanded,
			});
			this.addChild(this.#disclosure);
			return;
		}

		const body = rest.trim();
		const children: Component[] = [new Text(this.#header(headerSkills), 0, 0)];
		if (body) children.push(new Spacer(1), this.#markdown(body, bubble));
		// The prompt disclosure nests inside the one callout so the
		// skill-colored rail stays continuous across summary and detail.
		const promptDisclosure = new Disclosure({
			body: () => this.#promptFragment(bubble),
			expanded,
		});
		// The rail box and its Markdown always ignore tight viewports.
		promptDisclosure.setIgnoreTight(true);
		this.#disclosure = promptDisclosure;
		children.push(promptDisclosure);
		this.addChild(new SkillCallout(children));
	}

	/**
	 * Expanded prompt section (leading mode detail slot): raw rows appended to
	 * the outer callout, matching the pre-Disclosure layout of a single rail
	 * with no duplicate header.
	 */
	#promptFragment(bubble: UserBubbleOptions): Component {
		const fragment = new Container();
		for (const child of this.#promptSection(bubble)) fragment.addChild(child);
		return fragment;
	}

	#markdown(text: string, bubble: UserBubbleOptions): Markdown {
		const md = new Markdown(text, 0, 0, getMarkdownTheme(), {
			bgColor: value => theme.bg("userMessageBg", value),
			color: userBubbleColor(bubble),
		});
		md.setIgnoreTight(true);
		return md;
	}

	/** Chips linked to their SKILL.md, each followed by muted prompt size. */
	#header(skills: SkillPromptSkill[]): string {
		const skillEntries: string[] = [];
		for (const s of skills) {
			const label = skillChipLabel(s.name);
			const chip = skillChipStyle(label, bubbleReset());
			const linked = s.path ? fileHyperlink(s.path, chip, { line: 1 }) : chip;
			const parts = [linked];
			if (typeof s.lineCount === "number") {
				parts.push(theme.fg("muted", `${s.lineCount} ${s.lineCount === 1 ? "line" : "lines"}`));
			}
			skillEntries.push(parts.join(" "));
		}
		return skillEntries.join("  ");
	}

	/** The rendered SKILL.md prompt under a calm subheader (expanded view only). */
	#promptSection(bubble: UserBubbleOptions): Component[] {
		const text = this.#extractText();
		if (!text) return [];
		return [new Spacer(1), new Text(theme.fg("muted", "prompt"), 0, 0), new Spacer(1), this.#markdown(text, bubble)];
	}

	#extractText(): string {
		if (typeof this.#message.content === "string") {
			return this.#message.content;
		}
		return this.#message.content
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
