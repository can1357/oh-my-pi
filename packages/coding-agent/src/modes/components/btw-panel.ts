import { type Component, Markdown, Spacer, Text, type TUI } from "@oh-my-pi/pi-tui";
import { replaceTabs } from "../../tools/render-utils";
import { getMarkdownTheme, theme } from "../theme/theme";
import { OverlayPanel } from "./overlay-box";

type BtwPanelState = "running" | "complete" | "branching" | "aborted" | "error";

interface BtwPanelComponentOptions {
	question: string;
	tui: TUI;
	canBranch?: () => boolean;
}

class BtwFooter implements Component {
	#getLine: () => string;
	#line: string | undefined;
	#text: Text | undefined;

	constructor(getLine: () => string) {
		this.#getLine = getLine;
	}

	render(width: number): readonly string[] {
		const line = this.#getLine();
		if (line !== this.#line || !this.#text) {
			this.#line = line;
			this.#text = new Text(line, 0, 0);
		}
		return this.#text.render(width);
	}
}

export class BtwPanelComponent extends OverlayPanel {
	#tui: TUI;
	#canBranch: (() => boolean) | undefined;
	#state: BtwPanelState = "running";
	#answer = "";
	#errorMessage: string | undefined;
	#visibleAnswer = "";
	#closed = false;

	constructor(options: BtwPanelComponentOptions) {
		super(`/btw ${replaceTabs(options.question)}`);
		this.#tui = options.tui;
		this.#canBranch = options.canBranch;
		this.#rebuild();
	}

	appendText(delta: string): void {
		if (!delta || this.#closed) return;
		this.#answer += delta;
		this.#visibleAnswer = replaceTabs(this.#answer).trim();
		this.#rebuild();
	}

	setAnswer(text: string): void {
		if (this.#closed) return;
		this.#answer = text;
		this.#visibleAnswer = replaceTabs(text).trim();
		this.#rebuild();
	}

	markComplete(): void {
		if (this.#closed) return;
		this.#state = "complete";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	/** Shows that the completed answer is being promoted into the chat session. */
	markBranching(): void {
		if (this.#closed) return;
		this.#state = "branching";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markAborted(): void {
		if (this.#closed) return;
		this.#state = "aborted";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markError(message: string): void {
		if (this.#closed) return;
		this.#state = "error";
		this.#errorMessage = message;
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
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(this.#contentComponent());
		this.addChild(new Spacer(1));
		this.addChild(new BtwFooter(() => this.#footerLine()));
		// Component-scoped: a rebuild replaces only this panel's own children
		// (streaming deltas arrive per token, and a full compose would re-walk
		// the whole transcript each time). Before the panel is mounted the TUI
		// cannot resolve it and falls back to a full compose on its own.
		this.#tui.requestComponentRender(this);
	}

	#footerLine(): string {
		switch (this.#state) {
			case "running":
				return theme.fg("muted", "Esc cancel /btw");
			case "complete": {
				if (!this.isCopyable()) return theme.fg("muted", "Esc dismiss");
				const actions = ["c copy"];
				if (this.#canBranch?.() ?? this.isBranchable()) actions.push("b branch to chat");
				actions.push("Esc dismiss");
				return theme.fg("muted", actions.join(" · "));
			}
			case "branching":
				return theme.fg("muted", `${theme.status.pending} Branching to chat…`);
			case "aborted":
				return theme.fg("warning", `${theme.status.warning} Cancelled · Esc dismiss`);
			case "error":
				return theme.fg("error", `${theme.status.error} Error · Esc dismiss`);
		}
	}

	#contentComponent(): Component {
		if (this.#state === "error") {
			return new Text(theme.fg("error", replaceTabs(this.#errorMessage ?? "Unknown error")), 0, 0);
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
