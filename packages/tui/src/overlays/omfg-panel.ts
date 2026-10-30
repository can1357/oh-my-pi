import { type Component, Markdown, Text, type TUI } from "../index";
import { replaceTabs } from "../render/render-utils";
import { getMarkdownTheme, theme } from "../theme/theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { StreamingPanelContent } from "../chrome/streaming-panel";
import { boundKeys, interruptKey } from "../chrome/keybinding-hints";
import type { NativeNode } from "../native/node";
import { col, md, node, span, text } from "../native/describe";
import { hintsRow, type NativeHint, statusHintsRow } from "../native/overlay";

export type OmfgPanelState =
	| "generating"
	| "validating"
	| "confirming"
	| "saving"
	| "saved"
	| "rejected"
	| "aborted"
	| "error";

/** States with work still in flight (the sheet head shows the live spinner). */
const LIVE_STATES: Record<OmfgPanelState, boolean> = {
	generating: true,
	validating: true,
	confirming: true,
	saving: true,
	saved: false,
	rejected: false,
	aborted: false,
	error: false,
};

interface OmfgPanelComponentOptions {
	complaint: string;
	tui: TUI;
}

export class OmfgPanelComponent extends OverlayPanel {
	#tui: TUI;
	#state: OmfgPanelState = "generating";
	#status = "Generating TTSR rule…";
	#preview = "";
	#savedPath: string | undefined;
	#errorMessage: string | undefined;
	#closed = false;
	readonly #complaint: string;
	readonly #content: StreamingPanelContent;
	#native: NativeNode | undefined;

	constructor(options: OmfgPanelComponentOptions) {
		super(`/omfg ${replaceTabs(options.complaint)}`, "omp.overlay.omfg");
		this.#tui = options.tui;
		this.#complaint = replaceTabs(options.complaint);
		this.#content = new StreamingPanelContent(() => ({
			sections: [new Text(theme.fg("muted", replaceTabs(this.#status)), 0, 0), this.#contentComponent()],
			footer: this.#footerLine(),
		}));
		this.addChild(this.#content);
		this.#rebuild();
	}

	appendDraft(delta: string): void {
		if (!delta || this.#closed) return;
		this.#preview += delta;
		this.#rebuild();
	}

	setRule(text: string): void {
		if (this.#closed) return;
		this.#preview = text;
		this.#rebuild();
	}

	setStatus(state: OmfgPanelState, status: string): void {
		if (this.#closed) return;
		this.#state = state;
		this.#status = status;
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markSaved(path: string): void {
		if (this.#closed) return;
		this.#state = "saved";
		this.#savedPath = path;
		this.#status = `Saved ${path}`;
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markRejected(): void {
		if (this.#closed) return;
		this.#state = "rejected";
		this.#status = "Rule was not saved.";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markAborted(): void {
		if (this.#closed) return;
		this.#state = "aborted";
		this.#status = "Cancelled.";
		this.#errorMessage = undefined;
		this.#rebuild();
	}

	markError(message: string): void {
		if (this.#closed) return;
		this.#state = "error";
		this.#status = "Could not create rule.";
		this.#errorMessage = message;
		this.#rebuild();
	}

	close(): void {
		this.#closed = true;
	}

	override invalidate(): void {
		this.#native = undefined;
		super.invalidate();
	}

	override describe(): NativeNode {
		if (this.#native) return this.#native;
		const tone =
			this.#state === "error"
				? "error"
				: this.#state === "rejected" || this.#state === "aborted"
					? "warning"
					: undefined;
		// Inline in the dock, styled as a sheet by role: a borderless column headed by the complaint.
		const head = node("row", { role: "omp.sheet.head", gap: "sm", align: "center" }, [
			...(LIVE_STATES[this.#state] ? [node("spinner", {})] : []),
			text([span("/omfg", "accent"), span(` ${this.#complaint}`)], { truncate: "end", lines: 1 }),
		]);
		this.#native = col(
			[
				head,
				text([span(replaceTabs(this.#status), "muted")], { wrap: "word" }),
				this.#describeBody(),
				this.#describeFooter(),
			],
			{ role: this.nativeRole, gap: "sm", tone },
		);
		return this.#native;
	}

	#describeBody(): NativeNode {
		if (this.#state === "error") {
			return text([span(replaceTabs(this.#errorMessage ?? "Unknown error"), "error")], { wrap: "word" });
		}
		const preview = replaceTabs(this.#preview).trim();
		if (preview) return md(preview, { stream: this.#state === "generating" });
		return text([span(`${theme.status.pending} Waiting for candidate rule…`, "dim")]);
	}

	#describeFooter(): NativeNode {
		const esc: NativeHint = { keys: boundKeys("app.interrupt", ["escape"]).slice(0, 1), label: "dismiss" };
		switch (this.#state) {
			case "generating":
			case "validating":
			case "confirming":
			case "saving":
				return hintsRow([{ ...esc, label: "cancel /omfg" }]);
			case "saved":
				return statusHintsRow(
					[
						span(`${theme.status.success} Registered live`, "success"),
						span(" · ", "muted"),
						span(replaceTabs(this.#savedPath ?? "saved"), "path"),
					],
					[esc],
				);
			case "rejected":
				return statusHintsRow([span(`${theme.status.warning} Not saved`, "warning")], [esc]);
			case "aborted":
				return statusHintsRow([span(`${theme.status.warning} Cancelled`, "warning")], [esc]);
			case "error":
				return statusHintsRow([span(`${theme.status.error} Error`, "error")], [esc]);
		}
	}

	#rebuild(): void {
		this.#native = undefined;
		this.#content.refresh();
		this.#tui.requestRender();
	}

	#footerLine(): string {
		// The composer's `app.interrupt` handler routes Esc to this panel.
		const esc = interruptKey();
		switch (this.#state) {
			case "generating":
			case "validating":
			case "confirming":
			case "saving":
				return theme.fg("muted", `${esc} cancel /omfg`);
			case "saved":
				return theme.fg(
					"success",
					`${theme.status.success} Registered live · ${replaceTabs(this.#savedPath ?? "saved")} · ${esc} dismiss`,
				);
			case "rejected":
				return theme.fg("warning", `${theme.status.warning} Not saved · ${esc} dismiss`);
			case "aborted":
				return theme.fg("warning", `${theme.status.warning} Cancelled · ${esc} dismiss`);
			case "error":
				return theme.fg("error", `${theme.status.error} Error · ${esc} dismiss`);
		}
	}

	#contentComponent(): Component {
		if (this.#state === "error") {
			return new Text(theme.fg("error", replaceTabs(this.#errorMessage ?? "Unknown error")), 0, 0);
		}
		const text = replaceTabs(this.#preview).trim();
		if (!text) {
			return new Text(theme.fg("dim", `${theme.status.pending} Waiting for candidate rule…`), 0, 0);
		}
		return new Markdown(text, 0, 0, getMarkdownTheme());
	}
}
