/**
 * The terminal's model of a `prefs` page: the flat list of rows and section
 * headings the settings window draws and navigates, derived from the node's
 * props (plus the `term` facts a program adds for exact looks). Shared by the
 * `prefs` painter and widget so drawing and keys agree.
 */
import type { TspPrefsControl, TspPrefsProps, TspPrefsRow, TspSpan } from "@oh-my-pi/pi-wire";
import type { UiNode } from "../../node";
import type { Theme } from "../../theme/contract";

/** Terminal-only facts a program may put on a `prefs` node's `term` prop. */
export type PrefsTerm = {
	/** Frame title (default: the `title` prop). */
	readonly title?: string;
	/** Row display values by row id (default: derived from the control). */
	readonly values?: Readonly<Record<string, string>>;
	/** Sections drawn without a heading row (settings outside any group). */
	readonly headless?: readonly string[];
	/** Fixed sidebar width of the split layout (columns incl. indent and gap). */
	readonly sidebar?: number;
	/** Search results in display order (row ids); default: section order. */
	readonly order?: readonly string[];
	/** Keyboard focus is on the section headings (the selected row's section). */
	readonly sectionFocus?: boolean;
	/** The selected row while `focus` names a section (or nothing). */
	readonly selected?: string;
	/** A node drawn as the page body instead of the rows (a page the program draws itself). */
	readonly body?: UiNode;
	/** A preview line the open choice menu of `rows` shows above its options (wrapped). */
	readonly menuPreview?: { readonly rows: readonly string[]; readonly line: readonly TspSpan[] };
	/** Row hints as the window draws them, where they differ from the (single-line, trimmed) `hint`. */
	readonly hints?: Readonly<Record<string, string>>;
	/** Validation error of the open text editor. */
	readonly error?: string;
	/** The page the strip highlights while searching (default: the selected result's). */
	readonly page?: string;
	/** Footer hint replacing the one the window derives. */
	readonly hint?: string;
};

/** One entry of the drawn list: a section heading or a settings row. */
export interface PrefsItem {
	readonly heading: boolean;
	readonly id: string;
	readonly label: string;
	readonly row?: TspPrefsRow;
	/** The page of a search result. */
	readonly page?: string;
}

/** A run of rows under one heading (or the leading rows without one). */
export interface PrefsRun {
	/** Heading label ("" for the leading run without a heading). */
	readonly name: string;
	/** The section id the run's rows belong to. */
	readonly section: string;
	readonly first: number;
	readonly last: number;
}

/** Most choices drawn as a popup menu; longer choice lists open as a picker the program shows. */
export const PREFS_MENU_MAX = 12;

/** A node's `prefs` props. */
export function prefsProps(node: UiNode): TspPrefsProps & { role?: string; term?: PrefsTerm } {
	return node.props() as TspPrefsProps & { role?: string; term?: PrefsTerm };
}

/** Whether the page is showing search results. */
export function isSearching(props: TspPrefsProps): boolean {
	return (props.query ?? "") !== "";
}

/** The glyph of a page icon. */
export function pageIcon(theme: Theme, icon: string | undefined): string {
	if (!icon) return "";
	return theme.symbols.symbol(`tab.${icon}`) || theme.symbols.icon(icon === "plugins" ? "package" : icon);
}

/** The flat list the window draws: headings and rows, in order. */
export function prefsItems(props: TspPrefsProps, term: PrefsTerm | undefined, theme: Theme): PrefsItem[] {
	const items: PrefsItem[] = [];
	if (isSearching(props)) {
		const rows = new Map<string, { row: TspPrefsRow; page?: string }>();
		for (const section of props.sections)
			for (const row of section.rows) rows.set(row.id, { row, page: section.page });
		const order = term?.order ?? [...rows.keys()];
		let page: string | undefined;
		let first = true;
		for (const id of order) {
			const entry = rows.get(id);
			if (!entry) continue;
			if (first || entry.page !== page) {
				first = false;
				page = entry.page;
				const meta = props.pages.find(candidate => candidate.id === page);
				const icon = pageIcon(theme, meta?.icon);
				items.push({ heading: true, id: `__tab:${page}`, label: `${icon} ${meta?.label ?? page ?? ""}` });
			}
			items.push({ heading: false, id, label: entry.row.label, row: entry.row, page: entry.page });
		}
		return items;
	}
	const headless = term?.headless;
	for (const section of props.sections) {
		if (section.rows.length === 0) continue;
		if (!headless?.includes(section.id))
			items.push({ heading: true, id: `__heading:${section.id}`, label: section.title });
		for (const row of section.rows) items.push({ heading: false, id: row.id, label: row.label, row });
	}
	return items;
}

/** Runs of rows under each heading (the leading rows without one form a nameless run). */
export function prefsRuns(items: readonly PrefsItem[], props: TspPrefsProps): PrefsRun[] {
	const sectionOf = new Map<string, string>();
	for (const section of props.sections) for (const row of section.rows) sectionOf.set(row.id, section.id);
	const runs: { name: string; section: string; first: number; last: number }[] = [];
	let current: (typeof runs)[number] | undefined;
	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		if (item.heading) {
			current = { name: item.label, section: "", first: -1, last: -1 };
			runs.push(current);
			continue;
		}
		if (!current) {
			current = { name: "", section: "", first: i, last: i };
			runs.push(current);
		}
		if (current.first < 0) current.first = i;
		if (!current.section) current.section = sectionOf.get(item.id) ?? "";
		current.last = i;
	}
	return runs.filter(run => run.first >= 0);
}

/** The selected row id: the focused row, else the row the program names while sections hold the focus. */
export function selectedRow(
	props: TspPrefsProps,
	term: PrefsTerm | undefined,
	items: readonly PrefsItem[],
): string | undefined {
	const focus = props.focus ?? undefined;
	if (!term?.sectionFocus && focus !== undefined && items.some(item => !item.heading && item.id === focus))
		return focus;
	if (term?.selected !== undefined) return term.selected;
	if (focus !== undefined) {
		// Focus on a section: its first row.
		const section = props.sections.find(candidate => candidate.id === focus);
		if (section?.rows[0]) return section.rows[0].id;
	}
	return items.find(item => !item.heading)?.id;
}

/** Index of the run holding item `index`. */
export function runAt(runs: readonly PrefsRun[], index: number): number {
	for (let i = runs.length - 1; i >= 0; i--) if (runs[i]!.first <= index) return i;
	return 0;
}

/** Whether Enter/Space cycles the row's choices in place (a plain enum) instead of opening a menu. */
export function cyclesInPlace(control: TspPrefsControl): boolean {
	return control.k === "choice" && control.style === undefined;
}

/** The value a row shows at its right. */
export function rowValue(row: TspPrefsRow, term: PrefsTerm | undefined): string {
	const override = term?.values?.[row.id];
	if (override !== undefined) return override;
	const control = row.control;
	switch (control.k) {
		case "switch":
			return control.on ? "true" : "false";
		case "choice":
			return control.value;
		case "number":
			return control.labels?.[String(control.value)] ?? String(control.value);
		case "text":
			return control.value;
		case "keys":
			return control.keys.map(chord => chord.join("+")).join(", ");
		case "multi": {
			const labels = control.values.flatMap(value => {
				const option = control.options.find(candidate => candidate.value === value);
				return option ? [option.label] : [];
			});
			if (labels.length === 0) return control.ordered ? "default" : "none";
			return labels.join(control.ordered ? " → " : ", ");
		}
		case "action":
			return control.label;
	}
}

/** The choices a menu-style editor lists for a row (choice options, or a number's labelled steps). */
export function menuOptions(control: TspPrefsControl): { value: string; label: string; detail?: string }[] {
	if (control.k === "choice") return control.options.map(option => ({ ...option }));
	if (control.k !== "number" || !control.labels) return [];
	const steps: { value: string; label: string }[] = [];
	for (const value in control.labels) steps.push({ value, label: control.labels[value]! });
	// Object keys put integer-like keys first; steps read low to high.
	return steps.sort((a, b) => Number(a.value) - Number(b.value));
}

/** Widget state names. */
export const PREFS_HOVER = "hover";
export const PREFS_TAB_HOVER = "tabHover";
export const PREFS_OPTION_HOVER = "optionHover";
export const PREFS_DRAG = "drag";
