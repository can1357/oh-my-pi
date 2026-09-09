import type { TextContent } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { Box, Container, Markdown, Spacer, Text } from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import type { CustomMessage, SkillPromptDetails } from "../../session/messages";
import { shortenPath } from "../../tools/render-utils";
import { fileHyperlink } from "../../tui";

export class SkillMessageComponent extends Container {
	#box: Box;
	#contentComponent?: Component;
	#expanded = false;

	constructor(private readonly message: CustomMessage<SkillPromptDetails>) {
		super();

		this.#box = new Box(1, 1, t => theme.bg("customMessageBg", t));
		this.#box.setIgnoreTight(true);
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
		if (this.#contentComponent) {
			this.removeChild(this.#contentComponent);
			this.#contentComponent = undefined;
		}

		this.removeChild(this.#box);
		this.addChild(this.#box);
		this.#box.clear();
		// Re-read symbols every rebuild so a runtime theme/preset switch refreshes the outline.
		this.#box.setBorder({ chars: theme.boxRound, color: t => theme.fg("borderMuted", t) });

		const details = this.message.details;
		const name = details?.name?.trim() || "unknown";
		// Collapse args to one line: a stray newline/tab in user-supplied args would split the header.
		const args = details?.args?.replace(/\s+/g, " ").trim() ?? "";

		// Header: icon-tag + skill name, with the invocation args trailing dimmed.
		const tag = theme.fg("customMessageLabel", theme.bold(`${theme.icon.extensionSkill} skill`));
		let header = `${tag} ${theme.fg("customMessageText", theme.bold(name))}`;
		if (args) {
			header += ` ${theme.fg("dim", args)}`;
		}
		this.#box.addChild(new Text(header, 0, 0));

		const meta = this.#metaLine(details);
		if (meta) {
			this.#box.addChild(new Text(meta, 0, 0));
		}

		if (!this.#expanded) {
			return;
		}

		const text = this.#extractText();
		if (!text) {
			return;
		}

		this.#box.addChild(new Spacer(1));
		this.#box.addChild(new Text(theme.fg("muted", "prompt"), 0, 0));
		this.#box.addChild(new Spacer(1));

		this.#contentComponent = new Markdown(text, 0, 0, getMarkdownTheme(), {
			color: (value: string) => theme.fg("customMessageText", value),
		});
		this.#box.addChild(this.#contentComponent);
	}

	/** Sub-line under the header: home-shortened (clickable) accent path · muted prompt size. */
	#metaLine(details: SkillPromptDetails | undefined): string | undefined {
		const parts: string[] = [];

		const filePath = details?.path;
		if (filePath) {
			parts.push(fileHyperlink(filePath, theme.fg("accent", shortenPath(filePath)), { line: 1 }));
		}
		if (typeof details?.lineCount === "number") {
			parts.push(theme.fg("muted", `${details.lineCount} ${details.lineCount === 1 ? "line" : "lines"}`));
		}

		if (parts.length === 0) {
			return undefined;
		}
		return `  ${parts.join(theme.fg("muted", theme.sep.dot))}`;
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
