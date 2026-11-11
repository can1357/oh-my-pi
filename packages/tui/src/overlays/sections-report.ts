/**
 * A report that shows a summary over a list of sections. Up/Down pick a section, Enter opens it in the same report
 * area, Esc or Backspace goes back; Esc on the summary closes the report like any `ReportPanel`. Page keys and the
 * wheel still scroll the body.
 */
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import { Markdown } from "../components/markdown";
import { SelectList } from "../components/select-list";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { getKeybindings } from "../keybindings";
import { extractPrintableText, matchesKey } from "../keys";
import { getMarkdownTheme, getSelectListTheme } from "../theme/theme";
import type { Component } from "../tui";
import { ReportPanel, type ReportPanelOptions } from "./report-panel";

/** One section of a {@link SectionsReport}; `markdown` carries its own heading. Typing filters on `label`. */
export interface ReportSection {
	id: string;
	label: string;
	markdown: string;
	/** Drawn instead of `markdown` when the section opens, for content markdown cannot draw (file links). */
	body?: Component;
}

export interface ReportSectionsInput {
	/** Markdown, or a component drawn as it is. */
	summary: string | Component;
	/** Sections in display order. */
	sections: readonly ReportSection[];
}

class SectionsBody implements Component {
	readonly #summary: Component;
	readonly #sections: readonly ReportSection[];
	readonly #list: SelectList;
	#open: Component | undefined;
	#selectedRow: number | undefined;

	constructor({ summary, sections }: ReportSectionsInput) {
		this.#summary = typeof summary === "string" ? new Markdown(summary.trim(), 0, 0, getMarkdownTheme()) : summary;
		this.#sections = sections;
		this.#list = new SelectList(
			sections.map(section => ({ value: section.id, label: section.label })),
			Math.max(1, sections.length),
			getSelectListTheme(),
			{ search: sections.length > 1 ? "always" : "never", noMatchText: "No matching sections" },
		);
		this.#list.onSelect = item => {
			const section = this.#sections.find(candidate => candidate.id === item.value);
			if (section) this.#open = section.body ?? new Markdown(section.markdown, 0, 0, getMarkdownTheme());
		};
	}

	/** True when the key was consumed; false leaves it to the panel (Esc closes, page keys scroll). */
	handleInput(data: string): boolean {
		if (this.#open) {
			if (matchesSelectCancel(data) || matchesKey(data, "backspace")) {
				this.#open = undefined;
				return true;
			}
			return false;
		}
		// Cancel goes to the panel first: bound to a printable key, the list would take it as filter text.
		if (this.#sections.length === 0 || matchesSelectCancel(data)) return false;
		const typed = extractPrintableText(data) !== undefined;
		if (
			typed ||
			matchesSelectUp(data) ||
			matchesSelectDown(data) ||
			getKeybindings().matches(data, "tui.select.confirm") ||
			matchesKey(data, "backspace") ||
			matchesKey(data, "delete") ||
			matchesKey(data, "left") ||
			matchesKey(data, "right")
		) {
			this.#list.handleInput(data);
			return true;
		}
		return false;
	}

	get open(): boolean {
		return this.#open !== undefined;
	}

	/** The footer hint for the current view: back from a section, choose/open on the summary. */
	hint(closeHint: string): string {
		if (this.#open) return `${editorKey("tui.select.cancel")} or Backspace: back`;
		if (this.#sections.length === 0) return closeHint;
		const choose = editorKeys("tui.select.up", "tui.select.down");
		return `${choose}: choose · ${editorKey("tui.select.confirm")}: open · Type: filter · ${closeHint}`;
	}

	/** The rendered row of the selected section; `undefined` while a section is open or nothing is selected. */
	get selectedRow(): number | undefined {
		return this.#open ? undefined : this.#selectedRow;
	}

	render(width: number): readonly string[] {
		if (this.#open) return this.#open.render(width);
		if (this.#sections.length === 0) return this.#summary.render(width);
		const summary = this.#summary.render(width);
		const list = this.#list.render(width);
		const { items, selected } = this.#list.pickerView();
		const index = items.findIndex(item => item.value === selected);
		const row = list.findIndex((_, line) => this.#list.hitTest(line) === index);
		this.#selectedRow = row < 0 ? undefined : summary.length + 1 + row;
		return [...summary, "", ...list];
	}

	invalidate(): void {
		this.#summary.invalidate?.();
		this.#open?.invalidate?.();
		this.#list.invalidate();
	}
}

/** A {@link ReportPanel} whose focused input drives the section list before the panel's own keys. */
export class SectionsReport extends ReportPanel {
	readonly #body: SectionsBody;

	constructor(input: ReportSectionsInput, options: Omit<ReportPanelOptions, "body">) {
		const body = new SectionsBody(input);
		super({ ...options, body });
		this.#body = body;
	}

	override handleInput(data: string): void {
		if (this.#body.handleInput(data)) {
			this.invalidate();
			this.revealActiveRow();
			return;
		}
		super.handleInput(data);
	}

	override activeRow(): number | undefined {
		return this.#body.selectedRow;
	}

	override footerHint(closeHint: string): string {
		return this.#body.hint(closeHint);
	}

	override escapeCloses(): boolean {
		return !this.#body.open;
	}
}
