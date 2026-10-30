import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { type Component, Markdown, Text, type TUI } from "../index";
import { replaceTabs } from "../render/render-utils";
import { getMarkdownTheme, theme } from "../theme/theme";
import { sanitizeErrorLine } from "../chrome/error-block";
import { OverlayPanel } from "../chrome/overlay-box";
import { StreamingPanelContent } from "../chrome/streaming-panel";
import { boundKeys, interruptKey } from "../chrome/keybinding-hints";
import { formatKeyHint } from "../app-keybindings";
import type { NativeNode } from "../native/node";
import { col, md, node, span, text } from "../native/describe";
import { hintsRow, type NativeHint, statusHintsRow } from "../native/overlay";

type BtwPanelState = "running" | "complete" | "branching" | "aborted" | "error";

interface BtwPanelComponentOptions {
	question: string;
	/** Heading shown instead of `/btw <question>`, e.g. `/sitrep the migration` for a side command. */
	title?: string;
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
	#native: { node: NativeNode; canFollowUp: boolean; canBranch: boolean } | undefined;

	constructor(options: BtwPanelComponentOptions) {
		const baseTitle = replaceTabs(options.title ?? `/btw ${options.question}`);
		super(baseTitle, "omp.overlay.btw");
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

	override invalidate(): void {
		this.#native = undefined;
		super.invalidate();
	}

	override describe(): NativeNode {
		const canFollowUp = this.#canFollowUp?.() ?? false;
		const canBranch = this.#canBranch?.() ?? this.isBranchable();
		const memo = this.#native;
		if (memo && memo.canFollowUp === canFollowUp && memo.canBranch === canBranch) return memo.node;
		// Inline in the dock, styled as a sheet by role: a borderless column headed by the question.
		// The command word is the accent; the rest of the heading is the question or arguments.
		const space = this.#baseTitle.indexOf(" ");
		const command = space === -1 ? this.#baseTitle : this.#baseTitle.slice(0, space);
		const rest = space === -1 ? "" : this.#baseTitle.slice(space);
		const title = text([span(command, "accent"), ...(rest ? [span(rest)] : [])], { truncate: "end", lines: 1 });
		const live = this.#state === "running" || this.#state === "branching";
		const head = node("row", { role: "omp.sheet.head", gap: "sm", align: "center" }, [
			...(live ? [node("spinner", {})] : []),
			title,
		]);
		const described = col([head, this.#describeBody(), this.#describeFooter(canFollowUp, canBranch)], {
			role: this.nativeRole,
			gap: "sm",
			tone: this.#state === "error" ? "error" : this.#state === "aborted" ? "warning" : undefined,
		});
		this.#native = { node: described, canFollowUp, canBranch };
		return described;
	}

	#describeBody(): NativeNode {
		if (this.#state === "error") {
			return text([span(sanitizeErrorLine(this.#errorMessage ?? __ompTranslate("Unknown error")), "error")], {
				wrap: "word",
			});
		}
		const answer = this.#visibleAnswer;
		if (answer) return md(answer, { stream: this.#state === "running" });
		const waiting =
			this.#state === "running"
				? __ompTranslate("{0} Waiting for response…", `${theme.status.pending}`)
				: __ompTranslate("No text returned.");
		return text([span(waiting, "dim")]);
	}

	#describeFooter(canFollowUp: boolean, canBranch: boolean): NativeNode {
		const esc: NativeHint = {
			keys: boundKeys("app.interrupt", ["escape"]).slice(0, 1),
			label: __ompTranslate("to close"),
		};
		switch (this.#state) {
			case "running":
				return hintsRow([{ ...esc, label: __ompTranslate("to cancel") }]);
			case "complete": {
				const hints: NativeHint[] = [];
				if (this.isCopyable())
					hints.push({
						keys: ["c"],
						label: this.#copied ? __ompTranslate("to copy again") : __ompTranslate("to copy"),
					});
				if (canFollowUp) hints.push({ keys: ["f"], label: __ompTranslate("to follow up") });
				if (canBranch) hints.push({ keys: ["b"], label: __ompTranslate("to branch") });
				hints.push(esc);
				if (!this.#copied) return hintsRow(hints);
				return statusHintsRow([span(__ompTranslate("✓ Copied to clipboard"), "success")], hints);
			}
			case "branching":
				return text([span(__ompTranslate("{0} Branching to chat…", `${theme.status.pending}`), "muted")]);
			case "aborted":
				return statusHintsRow([span(__ompTranslate("{0} Cancelled", `${theme.status.warning}`), "warning")], [esc]);
			case "error":
				return statusHintsRow([span(__ompTranslate("{0} Error", `${theme.status.error}`), "error")], [esc]);
		}
	}

	#rebuild(): void {
		this.#native = undefined;
		this.#content.refresh();
		// Component-scoped: a rebuild replaces only this panel's own children
		// (streaming deltas arrive per token, and a full compose would re-walk
		// the whole transcript each time). Before the panel is mounted the TUI
		// cannot resolve it and falls back to a full compose on its own.
		this.#tui.requestComponentRender(this);
	}

	#footerLine(): string {
		// The main editor routes `app.interrupt` (Escape by default) to the panel.
		const esc = interruptKey();
		switch (this.#state) {
			case "running":
				return theme.fg("muted", __ompTranslate("{0} to cancel", `${esc}`));
			case "complete": {
				const actions: string[] = [];
				const copyKey = formatKeyHint("c");
				if (this.isCopyable())
					actions.push(
						this.#copied
							? __ompTranslate("{0} to copy again", `${copyKey}`)
							: __ompTranslate("{0} to copy", `${copyKey}`),
					);
				if (this.#canFollowUp?.()) actions.push(__ompTranslate("{0} to follow up", `${formatKeyHint("f")}`));
				if (this.#canBranch?.() ?? this.isBranchable())
					actions.push(__ompTranslate("{0} to branch", `${formatKeyHint("b")}`));
				actions.push(__ompTranslate("{0} to close", `${esc}`));
				if (this.#copied) {
					return `${theme.fg("success", __ompTranslate("✓ Copied to clipboard"))}${theme.fg("muted", actions.length > 0 ? ` · ${actions.join(" · ")}` : "")}`;
				}
				return theme.fg("muted", actions.join(" · "));
			}
			case "branching":
				return theme.fg("muted", __ompTranslate("{0} Branching to chat…", `${theme.status.pending}`));
			case "aborted":
				return theme.fg(
					"warning",
					__ompTranslate("{0} Cancelled · {1} to close", `${theme.status.warning}`, `${esc}`),
				);
			case "error":
				return theme.fg("error", __ompTranslate("{0} Error · {1} to close", `${theme.status.error}`, `${esc}`));
		}
	}

	#contentComponent(): Component {
		if (this.#state === "error") {
			return new Text(
				theme.fg("error", sanitizeErrorLine(this.#errorMessage ?? __ompTranslate("Unknown error"))),
				0,
				0,
			);
		}
		const text = this.#visibleAnswer;
		if (!text) {
			const waiting =
				this.#state === "running"
					? __ompTranslate("{0} Waiting for response…", `${theme.status.pending}`)
					: __ompTranslate("No text returned.");
			return new Text(theme.fg("dim", waiting), 0, 0);
		}
		return new Markdown(text, 0, 0, getMarkdownTheme());
	}
}
