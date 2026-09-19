import { type Component, Markdown, Text, type TUI } from "../index";
import { replaceTabs } from "../render/render-utils";
import { getMarkdownTheme, theme } from "../theme/theme";
import { sanitizeErrorLine } from "../chrome/error-block";
import { OverlayPanel } from "../chrome/overlay-box";
import { StreamingPanelContent } from "../chrome/streaming-panel";

type BtwPanelState = "running" | "complete" | "branching" | "aborted" | "error";

interface BtwPanelComponentOptions {
	question: string;
	tui: TUI;
	canBranch?: () => boolean;
	canFollowUp?: () => boolean;
}

export class BtwPanelComponent extends OverlayPanel {
	#tui: TUI;
	#canBranch: (() => boolean) | undefined;
	#canFollowUp: (() => boolean) | undefined;
	#state: BtwPanelState = "running";
	#answer = "";
	#errorMessage: string | undefined;
	#visibleAnswer = "";
	#closed = false;
	#copied = false;
	#baseTitle: string;
	readonly #content: StreamingPanelContent;

	constructor(options: BtwPanelComponentOptions) {
		const baseTitle = `/btw ${replaceTabs(options.question)}`;
		super(baseTitle);
		this.#baseTitle = baseTitle;
		this.#tui = options.tui;
		this.#canBranch = options.canBranch;
		this.#canFollowUp = options.canFollowUp;
		this.#content = new StreamingPanelContent(() => ({
			sections: [this.#contentComponent()],
			footer: () => this.#footerLine(),
		}));
		this.addChild(this.#content);
		this.#rebuild();
	}

	appendText(delta: string): void {
		if (!delta || this.#closed) return;
		this.#answer += delta;
		this.#visibleAnswer = replaceTabs(this.#answer).trim();
		this.#setCopied(false);
		this.#rebuild();
	}

	setAnswer(text: string): void {
		if (this.#closed) return;
		this.#answer = text;
		this.#visibleAnswer = replaceTabs(text).trim();
		this.#setCopied(false);
		this.#rebuild();
	}

	markComplete(): void {
		if (this.#closed) return;
		this.#state = "complete";
		this.#errorMessage = undefined;
		this.#setCopied(false);
		this.#rebuild();
	}

	/** Visual confirmation that `c` copied the answer to the clipboard. */
	markCopied(): void {
		if (this.#closed || !this.isCopyable()) return;
		this.#setCopied(true);
		this.#rebuild();
	}

	#setCopied(copied: boolean): void {
		this.#copied = copied;
		this.title = copied ? `${this.#baseTitle} ✓ Copied` : this.#baseTitle;
	}

	/** Shows that the completed answer is being promoted into the chat session. */
	markBranching(): void {
		if (this.#closed) return;
		this.#state = "branching";
		this.#errorMessage = undefined;
		this.#setCopied(false);
		this.#rebuild();
	}

	markAborted(): void {
		if (this.#closed) return;
		this.#state = "aborted";
		this.#errorMessage = undefined;
		this.#setCopied(false);
		this.#rebuild();
	}

	markError(message: string): void {
		if (this.#closed) return;
		this.#state = "error";
		this.#errorMessage = message;
		this.#setCopied(false);
		this.#rebuild();
	}
	isBranchable(): boolean {
		return this.isCopyable();
	}

	isCopyable(): boolean {
		return this.#state === "complete" && this.#visibleAnswer.length > 0;
	}

	getCopyText(): string | undefined {
		if (!this.isCopyable()) return undefined;
		return this.#visibleAnswer;
	}

	close(): void {
		this.#closed = true;
	}

	#rebuild(): void {
		this.#content.refresh();
		// Component-scoped: a rebuild replaces only this panel's own children
		// (streaming deltas arrive per token, and a full compose would re-walk
		// the whole transcript each time). Before the panel is mounted the TUI
		// cannot resolve it and falls back to a full compose on its own.
		this.#tui.requestComponentRender(this);
	}

	#footerLine(): string {
		switch (this.#state) {
			case "running":
				return theme.fg("muted", "Esc to cancel");
			case "complete": {
				const actions: string[] = [];
				if (this.isCopyable()) actions.push(this.#copied ? "c to copy again" : "c to copy");
				if (this.#canFollowUp?.()) actions.push("f to follow up");
				if (this.#canBranch?.() ?? this.isBranchable()) actions.push("b to branch");
				actions.push("Esc to close");
				if (this.#copied) {
					return `${theme.fg("success", "✓ Copied to clipboard")}${theme.fg("muted", actions.length > 0 ? ` · ${actions.join(" · ")}` : "")}`;
				}
				return theme.fg("muted", actions.join(" · "));
			}
			case "branching":
				return theme.fg("muted", `${theme.status.pending} Branching to chat…`);
			case "aborted":
				return theme.fg("warning", `${theme.status.warning} Cancelled · Esc to close`);
			case "error":
				return theme.fg("error", `${theme.status.error} Error · Esc to close`);
		}
	}

	#contentComponent(): Component {
		if (this.#state === "error") {
			return new Text(theme.fg("error", sanitizeErrorLine(this.#errorMessage ?? "Unknown error")), 0, 0);
		}
		const text = this.#visibleAnswer;
		if (!text) {
			const waiting =
				this.#state === "running" ? `${theme.status.pending} Waiting for response…` : "No text returned.";
			return new Text(theme.fg("dim", waiting), 0, 0);
		}
		return new Markdown(text, 0, 0, getMarkdownTheme());
	}
}
