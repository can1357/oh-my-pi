/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The `/sandbox` sheet: the OS sandbox's status and settings as a `prefs`
 * page set (Overview, Filesystem, Network, Effective policy).
 *
 * The sheet owns its page, selection, open draft and notice; the host owns
 * the data. Every edit goes out through {@link SandboxConfigCallbacks}; the
 * host writes the settings and pushes the refreshed model back through the
 * {@link SandboxConfigHandle} (and a rejected edit's reason as the notice).
 *
 * A Tern terminal draws the `prefs` node natively and reports what the user
 * did as UI events; in a plain terminal the `prefs` widget turns keys into
 * the same events. Keys only the sheet can interpret — typing into a draft,
 * ↑↓ over the enabled rows, ←→ on a choice, Tab between pages, Delete on an
 * entry — are handled here first (`onKey`).
 */
import {
	batch,
	computed,
	type JSXNode,
	type KeyEvent,
	nativeRendering,
	type PasteEvent,
	signal,
	type UiEvent,
	untrack,
} from "@oh-my-pi/pi-tui";
import type { PrefsTerm } from "@oh-my-pi/pi-tui/term/painters/prefs-model";
import type { TspPrefsProps, TspPrefsSection } from "@oh-my-pi/pi-wire";
import { plainLine } from "../../../extensibility/inventory/display-text";
import { getKeybindings } from "../../../config/keybindings/keybindings";
import { listKeyId } from "../../../config/keybindings/matchers";
import {
	disabledRowValue,
	followSandboxFocus,
	isSandboxPage,
	listEntries,
	listEntryId,
	NO_FOCUS,
	parseListRow,
	resolveSandboxFocus,
	SANDBOX_PAGE_TABS,
	SANDBOX_PAGES,
	type SandboxConfigCallbacks,
	type SandboxConfigModel,
	type SandboxEdit,
	type SandboxListId,
	type SandboxPage,
	sandboxRowAction,
	sandboxSections,
	sandboxStatusText,
	sandboxValueEdit,
	sectionRows,
	stepSandboxChoice,
} from "../../../modes/view-model/overlays/sandbox-config";
import { editLine, type LineState } from "../settings/line-edit";

/** Pushes host data into the open sheet. */
export interface SandboxConfigHandle {
	/** Replace the shown data (after a write, a settings reload or a runtime change). */
	setModel(model: SandboxConfigModel): void;
	/** Show why an edit was rejected (`undefined` clears it). */
	setNotice(message: string | undefined): void;
}

export interface SandboxConfigProps {
	readonly model: SandboxConfigModel;
	readonly callbacks: SandboxConfigCallbacks;
	/** Receives the sheet's handle once it is built. */
	readonly ref?: (handle: SandboxConfigHandle) => void;
}

/** The open editor: a text row's draft, or the scope multi-select with its highlighted option. */
type Editing =
	| { readonly kind: "text"; readonly row: string; readonly line: LineState }
	| { readonly kind: "multi"; readonly row: string; readonly option: string };

/** Action ids the sheet's action rows carry (a Tern click sends them with the row as the value). */
const ROW_ACTIONS: Readonly<Record<string, true>> = { add: true, allow: true, remove: true, trust: true, revoke: true };
/** Why the terminal-only status rows above the page are read-only. */
const STATUS_DISABLED = "Sandbox status";
const HINT_ROWS = "↑↓ move · enter toggle/edit · ←→ change · tab page · del remove · esc close";
const HINT_TEXT = "enter save · esc cancel · empty text removes the entry";
const HINT_MULTI = "↑↓ move · space toggle · esc back";

export function SandboxConfigOverlay(props: SandboxConfigProps): JSXNode {
	const cb = props.callbacks;
	const model = signal(props.model);
	const page = signal<SandboxPage>("overview");
	/** The list a pending new entry is being added to. */
	const adding = signal<SandboxListId | undefined>(undefined);
	const editing = signal<Editing | undefined>(undefined);
	const notice = signal<string | undefined>(undefined);
	/**
	 * An entry edit awaiting the host's write: once the new value is listed the selection follows the
	 * entry to it. A rejected write leaves the selection on the old entry.
	 */
	let renamed: { from: string; to: string } | undefined;

	const sections = computed(() => sandboxSections(model(), page(), adding()));
	// Pin the first row now: left unset, the first row would follow the data, and a default row that
	// became disabled would silently hand the next Enter to the row below it.
	const focus = signal(
		untrack(sections)
			.flatMap(section => section.rows)
			.find(row => !row.disabled)?.id ?? NO_FOCUS,
	);
	const focused = computed(() => resolveSandboxFocus(sections(), focus()));
	const status = computed(() => sandboxStatusText(model()));

	const setNotice = (message: string | undefined): void => {
		notice.set(message === undefined ? undefined : plainLine(message));
	};

	const apply = (edit: SandboxEdit | undefined): void => {
		if (!edit) return;
		if (edit.k === "notice") setNotice(edit.message);
		else if (edit.k === "set") cb.set(edit.change);
		else cb.reset(edit.id);
	};

	const beginEdit = (row: string, text: string): void => {
		batch(() => {
			editing.set({ kind: "text", row, line: { text, cursor: text.length } });
			focus.set(row);
		});
	};

	/** Drop the open editor; a cancelled new entry leaves the selection on its list's Add row. */
	const cancelEdit = (): void => {
		const open = untrack(editing);
		const parsed = open?.kind === "text" ? parseListRow(open.row) : undefined;
		batch(() => {
			if (parsed?.kind === "new") focus.set(`${parsed.list}:add`);
			editing.set(undefined);
			adding.set(undefined);
		});
	};

	/** Apply a text row's value: a new entry adds, an emptied entry is removed, a changed one replaced. */
	const commit = (rowId: string, raw: string): void => {
		const value = raw.trim();
		const parsed = parseListRow(rowId);
		const current = untrack(model);
		editing.set(undefined);
		if (!parsed || current.locked[parsed.list]) return;
		if (parsed.kind === "new") {
			batch(() => {
				adding.set(undefined);
				focus.set(`${parsed.list}:add`);
			});
			if (value) cb.addEntry(parsed.list, value);
		} else if (parsed.kind === "entry") {
			const entries = listEntries(current, parsed.list);
			const previous = parsed.entry;
			const at = entries.indexOf(previous);
			if (at < 0) return;
			if (!value) {
				// The next entry takes the selection; with none left, the list's Add row does.
				const next = entries[at + 1];
				focus.set(next === undefined ? rowId : listEntryId(parsed.list, next));
				cb.removeEntry(parsed.list, previous);
			} else if (value !== previous) {
				renamed = { from: rowId, to: listEntryId(parsed.list, value) };
				cb.replaceEntry(parsed.list, previous, value);
			}
		}
	};

	/** Enter on a row (or a Tern activate/click): toggle, step, open the editor or run the action. */
	const activate = (id: string): void => {
		const row = sectionRows(untrack(sections)).find(candidate => candidate.id === id);
		if (!row || row.disabled) return;
		const current = untrack(model);
		const control = row.control;
		switch (control.k) {
			case "switch":
				apply(sandboxValueEdit(current, id, !control.on));
				return;
			case "choice":
				apply(stepSandboxChoice(current, id, 1));
				return;
			case "multi":
				batch(() => {
					editing.set({ kind: "multi", row: id, option: control.values[0] ?? control.options[0]?.value ?? "" });
					focus.set(id);
				});
				return;
			case "text": {
				const parsed = parseListRow(id);
				if (parsed?.kind === "entry") beginEdit(id, parsed.entry);
				return;
			}
			case "action": {
				const parsed = parseListRow(id);
				if (parsed?.kind === "add") {
					adding.set(parsed.list);
					beginEdit(`${parsed.list}:new`, "");
					return;
				}
				const action = sandboxRowAction(current, id);
				switch (action?.k) {
					case "allow":
						cb.allowHost(action.host);
						return;
					case "revoke":
						cb.revokePath(action.kind, action.path);
						return;
					case "revokeExec":
						cb.revokeExec(action.target);
						return;
					case "trust":
						cb.trustCreated(action.path);
						return;
					case "forget":
						cb.forgetCreated(action.path);
						return;
				}
				return;
			}
			default:
				return;
		}
	};

	/** A typed value (a Tern control, the widget's switch or multi-select): `null` resets / removes. */
	const change = (item: string, value: boolean | number | string | readonly string[] | null): void => {
		if (parseListRow(item)) {
			if (typeof value === "string") commit(item, value);
			else if (value === null) commit(item, "");
			return;
		}
		apply(sandboxValueEdit(untrack(model), item, value));
	};

	const showPage = (next: SandboxPage): void => {
		batch(() => {
			page.set(next);
			focus.set(NO_FOCUS);
			editing.set(undefined);
			adding.set(undefined);
		});
	};

	const stepPage = (delta: -1 | 1): void => {
		const at = SANDBOX_PAGES.indexOf(untrack(page));
		showPage(SANDBOX_PAGES[(at + delta + SANDBOX_PAGES.length) % SANDBOX_PAGES.length]!);
	};

	/** ↑↓ over the enabled rows, wrapping; a page with none (the resolved policy) moves over all, so it scrolls. */
	const move = (delta: -1 | 1): void => {
		const rows = sectionRows(untrack(sections));
		const selectable = rows.filter(row => !row.disabled);
		const pool = selectable.length > 0 ? selectable : rows;
		if (pool.length === 0) return;
		const current = untrack(focused);
		const index = current ? pool.findIndex(row => row.id === current.id) : -1;
		const target =
			index < 0 ? pool[delta > 0 ? 0 : pool.length - 1]! : pool[(index + delta + pool.length) % pool.length]!;
		focus.set(target.id);
	};

	const onKey = (key: KeyEvent): boolean => {
		if (key.kind === "release") return false;
		const open = untrack(editing);
		const nav = listKeyId(key);
		const keys = getKeybindings();
		if (open?.kind === "text") {
			if (nav === "escape") cancelEdit();
			else if (keys.matches(key, "tui.input.submit")) commit(open.row, open.line.text);
			else {
				const line = editLine(open.line, key);
				if (line) editing.set({ ...open, line });
			}
			return true;
		}
		// The open multi-select is the widget's.
		if (open) return false;
		if (key.id === "tab" || key.id === "shift+tab") {
			stepPage(key.id === "tab" ? 1 : -1);
			return true;
		}
		if (nav === "up" || nav === "down") {
			move(nav === "up" ? -1 : 1);
			return true;
		}
		const row = untrack(focused);
		// ←→ step a focused choice; otherwise the widget switches pages.
		if ((key.id === "left" || key.id === "right") && row?.control.k === "choice") {
			apply(stepSandboxChoice(untrack(model), row.id, key.id === "left" ? -1 : 1));
			return true;
		}
		if (
			row &&
			(keys.matches(key, "tui.editor.deleteCharBackward") || keys.matches(key, "tui.editor.deleteCharForward"))
		) {
			if (parseListRow(row.id)?.kind === "entry") commit(row.id, "");
			return true;
		}
		return false;
	};

	/** A paste goes into the open draft at its caret (one line). */
	const onPaste = (paste: PasteEvent): boolean => {
		const open = untrack(editing);
		if (open?.kind !== "text") return false;
		const text = paste.text.replace(/[\r\n]+/g, "");
		const { line } = open;
		editing.set({
			...open,
			line: {
				text: line.text.slice(0, line.cursor) + text + line.text.slice(line.cursor),
				cursor: line.cursor + text.length,
			},
		});
		return true;
	};

	/**
	 * Events: a page click switches pages; a value change applies (a list entry's text commits like
	 * Enter: emptied removes); an action row adds an entry, allows a blocked host or drops a grant or
	 * record; closing the open editor cancels it and closing the page closes the sheet; picking
	 * another row while an editor is open cancels it.
	 */
	const onEvent = (event: UiEvent): void => {
		switch (event.type) {
			case "action":
				if (event.act === "page" && event.value) {
					if (isSandboxPage(event.value)) showPage(event.value);
				} else if (event.act === "close") {
					if (event.value === undefined) cb.close();
					else if (untrack(editing)) cancelEdit();
				} else if (Object.hasOwn(ROW_ACTIONS, event.act) && event.value) {
					if (untrack(editing)) cancelEdit();
					activate(event.value);
				}
				return;
			case "change":
				if ("item" in event) change(event.item, event.value);
				return;
			case "activate": {
				const open = untrack(editing);
				if (open?.row === event.item) return;
				if (open) cancelEdit();
				activate(event.item);
				return;
			}
			case "select": {
				const open = untrack(editing);
				const eq = event.item.indexOf("=");
				if (eq >= 0) {
					if (open?.kind === "multi" && open.row === event.item.slice(0, eq))
						editing.set({ ...open, option: event.item.slice(eq + 1) });
					return;
				}
				if (open && open.row !== event.item) cancelEdit();
				focus.set(event.item);
				return;
			}
			default:
				return;
		}
	};

	props.ref?.({
		setModel(next) {
			const previous = untrack(model);
			const rename = renamed;
			renamed = undefined;
			batch(() => {
				model.set(next);
				const open = untrack(editing);
				const parsed = open?.kind === "text" ? parseListRow(open.row) : undefined;
				if (parsed?.kind === "entry" && !next[parsed.list].includes(parsed.entry)) editing.set(undefined);
				focus.set(followSandboxFocus(untrack(focus), previous, next, rename));
			});
		},
		setNotice,
	});

	/** The page, with the status (and notice) rows a plain terminal shows above it; Tern shows them as the lead. */
	const shownSections = computed((): TspPrefsSection[] => {
		if (nativeRendering()) return sections();
		const message = notice();
		const rows: TspPrefsSection["rows"][number][] = [
			{ id: "status:state", label: "Sandbox", disabled: STATUS_DISABLED, control: { k: "text", value: status() } },
		];
		if (message)
			rows.push({
				id: "status:notice",
				label: "Rejected",
				warning: message,
				disabled: STATUS_DISABLED,
				control: { k: "text", value: "" },
			});
		return [{ id: "status", title: "Status", rows }, ...sections()];
	});

	const nativeEditing = (): TspPrefsProps["editing"] => {
		const open = editing();
		if (!open) return null;
		return open.kind === "text"
			? { row: open.row, draft: open.line.text, cursor: open.line.cursor }
			: { row: open.row, option: open.option };
	};

	const term = (): PrefsTerm => {
		const values: Record<string, string> = {};
		for (const row of sectionRows(shownSections())) {
			const value = row.id === "status:state" ? status() : disabledRowValue(row);
			if (value !== undefined) values[row.id] = value;
		}
		const open = editing();
		return {
			title: "Sandbox",
			values,
			// Nothing selected: no cursor, and Enter has no row to act on.
			selected: focused() ? undefined : NO_FOCUS,
			hint: open ? (open.kind === "text" ? HINT_TEXT : HINT_MULTI) : HINT_ROWS,
		};
	};

	return (
		<prefs
			title="Sandbox"
			pages={SANDBOX_PAGE_TABS}
			page={page}
			lead={() => {
				const message = notice();
				return message ? `${status()} — ${message}` : status();
			}}
			sections={shownSections}
			focus={() => focused()?.id ?? null}
			editing={nativeEditing}
			term={term}
			onKey={onKey}
			onPaste={onPaste}
			onEvent={onEvent}
		/>
	);
}
