/**
 * The agent's sandbox access request (a path to write or read, or a host to
 * reach), in the composer's place like the tool-approval prompt: the request
 * — title, the agent's intent, the command, omp's own statement of the
 * effect, and what the agent does if denied — over the choices Allow for this
 * session, Always allow (when the backing list can be edited), Deny and Reply
 * with instructions. The last opens a text field: Enter sends the reply, an
 * empty reply or Esc goes back to the choices. Esc on the choices denies.
 * Enter and a click only arm {@link APPROVE_ARM_MS} after mount, so a key
 * meant for the composer as the dialog appears never answers it.
 *
 * The intent, command and alternative are the model's text: every line is
 * sanitized and bounded (the intent and alternative wrap to a few rows, the
 * command is one clipped row).
 */
import {
	type Component,
	Ellipsis,
	extractPrintableText,
	Input,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "../index";
import { OverlayPanel, PanelDivider, PanelRows } from "../chrome/overlay-box";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import { getKeybindings } from "../keybindings";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { col, node, span, text } from "../native/describe";
import type { NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionBar, actionButton } from "../native/overlay";
import { plainLine } from "../native/spans";
import { sanitizeDisplayLines, shortenPath } from "../render/render-utils";
import { theme } from "../theme/theme";
import { APPROVE_ARM_MS } from "./approval-dialog";

/** What the dialog shows: the request, with `effect` computed by omp (never the agent's text). */
export interface SandboxAccessView {
	readonly kind: "write" | "read" | "host";
	readonly target: string;
	readonly intent: string;
	readonly command?: string;
	readonly alternative?: string;
	readonly effect: string;
	/** False when the backing list cannot be edited here: no Always allow. */
	readonly canAlways: boolean;
}

/** The user's answer (structurally the runtime's `SandboxAccessAnswer`). */
export type SandboxAccessDialogAnswer =
	| { readonly decision: "session" | "always" | "deny" }
	| { readonly decision: "instruct"; readonly instructions: string };

/** A choice the dialog offers. */
export type SandboxAccessChoice = "session" | "always" | "deny" | "instruct";

const CHOICE_LABELS: Record<SandboxAccessChoice, string> = {
	session: "Allow for this session",
	always: "Always allow (saved to global config)",
	deny: "Deny",
	instruct: "Reply with instructions…",
};
const KIND_VERBS: Record<SandboxAccessView["kind"], string> = {
	write: "write to",
	read: "read",
	host: "connect to",
};
/** Characters kept of one model-written field before it is cut. */
const MAX_FIELD_CHARS = 2000;
/** Rows the intent wraps to before it is cut (the alternative gets fewer). */
const MAX_INTENT_ROWS = 6;
const MAX_ALTERNATIVE_ROWS = 3;

/** Model text as display lines: control characters and escapes removed, tabs expanded, bounded. */
function cleanLines(value: string | undefined): string[] {
	if (!value) return [];
	const lines = sanitizeDisplayLines(value.slice(0, MAX_FIELD_CHARS)).map(line => line.trimEnd());
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** `lines` wrapped to `width`, at most `max` rows, the last ending in an ellipsis when more remain. */
function wrapBounded(lines: readonly string[], width: number, max: number): string[] {
	const rows = lines.flatMap(line => (line === "" ? [""] : wrapTextWithAnsi(line, width)));
	if (rows.length <= max) return rows;
	return [...rows.slice(0, max - 1), truncateToWidth(`${rows[max - 1]}…`, width, Ellipsis.Unicode)];
}

export class SandboxAccessDialogComponent implements Component {
	readonly #title: string;
	readonly #intent: readonly string[];
	readonly #command: string | undefined;
	readonly #effect: readonly string[];
	readonly #alternative: readonly string[];
	readonly #choices: readonly SandboxAccessChoice[];
	#choice = 0;
	/** The reply field while the user writes instructions. */
	#reply: Input | undefined;
	#closed = false;
	readonly #armedAt = performance.now() + APPROVE_ARM_MS;
	readonly #panel: OverlayPanel;
	readonly #body = new PanelRows();
	readonly #choiceRows = new PanelRows();
	readonly #footer = new PanelRows();
	#native: { reply: Input | undefined; node: NativeNode } | undefined;

	readonly #tui: TUI | undefined;
	readonly #onAnswer: (answer: SandboxAccessDialogAnswer) => void;

	constructor(
		view: SandboxAccessView,
		options: {
			tui?: TUI;
			onAnswer(answer: SandboxAccessDialogAnswer): void;
			/** The highlighted choice on mount (default: Allow for this session); the host passes `deny` over a composer draft. */
			initialChoice?: SandboxAccessChoice;
		},
	) {
		this.#tui = options.tui;
		this.#onAnswer = options.onAnswer;
		const target = plainLine(view.target);
		this.#title = `Sandbox request: ${KIND_VERBS[view.kind]} ${view.kind === "host" ? target : shortenPath(target)}`;
		this.#intent = cleanLines(view.intent);
		const command = cleanLines(view.command).join(" ").trim();
		this.#command = command || undefined;
		this.#effect = cleanLines(view.effect);
		this.#alternative = cleanLines(view.alternative);
		this.#choices = view.canAlways ? ["session", "always", "deny", "instruct"] : ["session", "deny", "instruct"];
		this.#choice = Math.max(0, this.#choices.indexOf(options.initialChoice ?? "session"));
		this.#panel = new OverlayPanel(this.#title, "omp.overlay.sandbox.access");
		this.#footer.setHeight(1);
		this.#panel.addChild(this.#body);
		this.#panel.addChild(this.#choiceRows);
		this.#panel.addChild(new PanelDivider());
		this.#panel.addChild(this.#footer);
	}

	/** The choices offered, in order (`always` only when the list can be edited). */
	get choices(): readonly SandboxAccessChoice[] {
		return this.#choices;
	}

	invalidate(): void {
		this.#native = undefined;
		this.#panel.invalidate();
	}

	dispose(): void {
		this.#closed = true;
		this.#panel.dispose();
	}

	handleInput(keyData: string): void {
		if (this.#closed) return;
		const reply = this.#reply;
		if (reply) {
			reply.handleInput(keyData);
			this.#changed();
			return;
		}
		if (matchesSelectCancel(keyData)) {
			this.#finish({ decision: "deny" });
			return;
		}
		if (matchesSelectUp(keyData) || matchesSelectDown(keyData)) {
			const count = this.#choices.length;
			this.#choice = (this.#choice + (matchesSelectUp(keyData) ? -1 : 1) + count) % count;
			this.#changed();
			return;
		}
		if (getKeybindings().matches(keyData, "tui.select.confirm")) {
			if (performance.now() >= this.#armedAt) this.#take(this.#choices[this.#choice]!);
			return;
		}
		// Typing (a message meant for the composer, or a reply) goes to the reply field: text never grants.
		const printable = extractPrintableText(keyData);
		if (printable !== undefined) {
			this.#openReply();
			this.#reply?.handleInput(keyData);
			this.#changed();
		}
	}

	#take(choice: SandboxAccessChoice): void {
		if (choice === "instruct") this.#openReply();
		else this.#finish({ decision: choice });
	}

	#openReply(): void {
		const reply = new Input();
		reply.prompt = "";
		reply.placeholder = "Tell the agent what to do instead";
		reply.focused = true;
		reply.onSubmit = value => {
			const instructions = value.trim();
			if (instructions) this.#finish({ decision: "instruct", instructions });
			else this.#back();
		};
		reply.onEscape = () => this.#back();
		this.#reply = reply;
		this.#choice = this.#choices.indexOf("instruct");
		this.#changed();
	}

	#back(): void {
		this.#reply = undefined;
		this.#changed();
	}

	#changed(): void {
		this.#native = undefined;
		this.#tui?.requestRender();
	}

	#finish(answer: SandboxAccessDialogAnswer): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#onAnswer(answer);
	}

	/** Labeled body rows at `width`: Intent, Command, Effect, If denied. */
	#bodyLines(width: number): string[] {
		const label = (name: string) => theme.bold(theme.fg("muted", name));
		const lines: string[] = [label("Intent")];
		lines.push(...wrapBounded(this.#intent.length > 0 ? this.#intent : ["(none given)"], width, MAX_INTENT_ROWS));
		if (this.#command) {
			lines.push(label("Command"), truncateToWidth(theme.fg("accent", this.#command), width, Ellipsis.Unicode));
		}
		lines.push(label("Effect"), ...wrapBounded(this.#effect, width, 3));
		if (this.#alternative.length > 0) {
			lines.push(label("If denied"), ...wrapBounded(this.#alternative, width, MAX_ALTERNATIVE_ROWS));
		}
		return lines;
	}

	render(width: number): readonly string[] {
		const innerWidth = Math.max(1, width - 4);
		const body = this.#bodyLines(innerWidth);
		this.#body.setLines(body);
		this.#body.setHeight(body.length);
		const reply = this.#reply;
		if (reply) {
			this.#choiceRows.setLines([
				theme.bold(theme.fg("accent", truncateToWidth(CHOICE_LABELS.instruct, innerWidth, Ellipsis.Unicode))),
				...reply.render(innerWidth),
			]);
			this.#footer.setLines([
				theme.fg("dim", `${editorKey("tui.input.submit")} send · ${editorKey("tui.select.cancel")} back`),
			]);
		} else {
			this.#choiceRows.setLines(
				this.#choices.map((choice, index) => {
					const label = CHOICE_LABELS[choice];
					if (index !== this.#choice) return truncateToWidth(`  ${label}`, innerWidth, Ellipsis.Unicode);
					const row = truncateToWidth(`${theme.nav.cursor} ${label}`, innerWidth, Ellipsis.Unicode);
					return theme.bold(theme.fg(choice === "deny" ? "error" : "accent", row));
				}),
			);
			this.#footer.setLines([
				theme.fg(
					"dim",
					`${editorKeys("tui.select.up", "tui.select.down")} choose · ${editorKey("tui.select.confirm")} select · ${editorKey("tui.select.cancel")} deny`,
				),
			]);
		}
		return this.#panel.render(width);
	}

	/**
	 * In the dock like the approval prompt (the `omp.editor.ask.approval` root role): the title,
	 * the labeled fields, then every choice as a button — Reply… leading, Always allow (when
	 * offered), Deny and the primary Allow for this session end-aligned; while replying, the
	 * reply field with Back / Send. No selectable list beside the buttons: in a pointer UI the
	 * keyboard's highlighted row read as a second, clickable copy of the same choices.
	 */
	describe(): NativeNode {
		const native = this.#native;
		if (native && native.reply === this.#reply) return native.node;
		const field = (key: string, name: string, value: NativeNode): NativeNode =>
			node("col", { role: `omp.sandbox.access.${key}`, gap: "xs" }, [text([span(name, "strong")]), value], key);
		const children: NativeChild[] = [
			node(
				"text",
				{ text: this.#title, role: "omp.approval.title", tone: "accent", truncate: "end" },
				undefined,
				"title",
			),
			field(
				"intent",
				"Intent",
				text(this.#intent.join("\n") || "(none given)", { wrap: "word", lines: MAX_INTENT_ROWS }),
			),
		];
		if (this.#command) {
			children.push(
				field("command", "Command", node("text", { spans: [span(this.#command, "mono")], truncate: "end" })),
			);
		}
		children.push(field("effect", "Effect", text(this.#effect.join("\n"), { wrap: "word" })));
		if (this.#alternative.length > 0) {
			children.push(
				field(
					"alternative",
					"If denied",
					text(this.#alternative.join("\n"), { wrap: "word", lines: MAX_ALTERNATIVE_ROWS }),
				),
			);
		}
		const reply = this.#reply;
		if (reply) {
			children.push(
				node("col", { role: "omp.sandbox.access.reply" }, [reply], "reply"),
				actionBar([null, actionButton("Back", "back"), actionButton("Send", "send", { tone: "accent" })]),
			);
		} else {
			const cancelKey = getKeybindings().getKeys("tui.select.cancel")[0];
			children.push(
				actionBar([
					actionButton("Reply…", "instruct", {
						title: "Tell the agent what to do instead",
					}),
					null,
					...(this.#choices.includes("always")
						? [
								actionButton("Always allow", "always", {
									title: "Allow and save to the global config",
								}),
							]
						: []),
					actionButton("Deny", "deny", {
						tone: "error",
						...(cancelKey ? { keys: cancelKey } : {}),
					}),
					actionButton(CHOICE_LABELS.session, "session", { tone: "accent" }),
				]),
			);
		}
		const described = col(children, {
			role: "omp.editor.ask.approval",
			gap: "md",
		});
		this.#native = { reply, node: described };
		return described;
	}

	/** Buttons run what the keys run (granting ones only once armed); the reply's buttons send or go back. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#closed || event.type !== "action") return;
		switch (event.act) {
			case "deny":
			case "instruct":
				this.#take(event.act);
				return;
			case "session":
			case "always":
				if (this.#choices.includes(event.act) && performance.now() >= this.#armedAt) this.#take(event.act);
				return;
			case "send":
				this.#reply?.onSubmit?.(this.#reply.getValue());
				return;
			case "back":
				this.#back();
				return;
		}
	}
}
