/**
 * Fullscreen panel-persona editor: an explicit-save, in-memory editor for the
 * raw `panel.personas` settings record.
 *
 * It paints the entire alternate screen from row 0 (so SGR mouse rows index
 * directly into the rendered frame) using the shared {@link ./overlay-box}
 * chrome, mirroring {@link ./advisor-config}. The list screen is a two-pane
 * split: a clickable persona sidebar on the left and a scrollable preview of
 * the highlighted persona (or its parse error) on the right.
 *
 * Entries the shared config parser rejects are quarantined: they stay visible
 * with their parse error, cannot be edited, and are written back byte-for-byte
 * on save until the user deletes them. Editable entries expose id, label,
 * task modes, instructions, and a fixed tools catalog ({@link PANEL_PERSONA_TOOLS});
 * freeform tool names are never offered. Nothing touches settings until the
 * user picks "Save personas", which re-validates every editable entry with
 * {@link parsePanelPersona} (the exact parser the config loader applies)
 * and hands the assembled record to the host `save` callback.
 */
import {
	type Component,
	Input,
	type MouseRoutable,
	routeSgrMouseInput,
	type SelectItem,
	SelectList,
	type SgrMouseEvent,
	type TUI,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import { BUILTIN_PANEL_PERSONAS, parsePanelPersona } from "../../panel/config";
import { PANEL_PERSONA_TOOLS, PANEL_TASK_MODES, type PanelPersonaTools, type PanelTaskMode } from "../../panel/types";
import { getSelectListTheme, theme } from "../theme/theme";
import { HookEditorComponent } from "./hook-editor";
import {
	bottomBorder,
	divider,
	dividerSplit,
	row,
	splitBodyWidth,
	splitRow,
	topBorder,
	topBorderSplit,
} from "./overlay-box";

/** Host callbacks: the editor never reads or writes settings itself. */
export interface PanelPersonaEditorCallbacks {
	/**
	 * Persist the assembled personas record: quarantined raw entries unchanged
	 * plus every editable entry re-validated by the shared config parser.
	 */
	save: (next: Record<string, unknown>) => void;
	/** Tear down the overlay and restore the editor. */
	close: () => void;
	/** Surface a transient status/warning line to the user. */
	notify: (message: string) => void;
	requestRender: () => void;
}

/** An entry whose loaded (or created) shape passed {@link parsePanelPersona}. */
interface ValidPersonaEntry {
	readonly kind: "valid";
	id: string;
	label: string;
	/** Canonical {@link PANEL_TASK_MODES} order after any edit; loaded order kept until then. */
	modes: PanelTaskMode[];
	instructions: string;
	tools: PanelPersonaTools;
}

/** A loaded entry the shared parser rejected: visible, deletable, saved back unchanged. */
interface InvalidPersonaEntry {
	readonly kind: "invalid";
	readonly id: string;
	readonly raw: unknown;
	/** The full parse failure, `panel.personas.<id>` path included. */
	readonly error: string;
}

type PersonaEntry = ValidPersonaEntry | InvalidPersonaEntry;

type Screen = "list" | "detail" | "quarantine" | "id" | "label" | "modes" | "tools" | "instructions";

const PREVIEW_WIDTH = 60;

/**
 * Ids the config loader rejects at the container level (`requireRecord`
 * refuses unsafe own keys), so the value-scoped shared parser never sees
 * them. The editor quarantines such entries and refuses to mint new ones.
 */
const UNSAFE_PERSONA_IDS: readonly string[] = ["__proto__", "constructor", "prototype"];

const MODE_DESCRIPTION: Record<PanelTaskMode, string> = {
	answer: "available to answer panels",
	plan: "available to plan panels",
};

const TOOLS_DESCRIPTION: Record<PanelPersonaTools, string> = {
	none: "no tools; reasoning only",
	"workspace-read": "read-only workspace access",
};

/** First line of `text`, clipped for a description column. */
function previewLine(text: string): string {
	if (!text.trim()) return "(required)";
	const first = text.trim().split("\n", 1)[0] ?? "";
	return first.length > PREVIEW_WIDTH ? `${first.slice(0, PREVIEW_WIDTH - 1)}…` : first;
}

/** Soft-wrap plain text to `width`, returning at least one (possibly empty) line. */
function wrap(text: string, width: number): string[] {
	if (!text) return [""];
	return Bun.wrapAnsi(text, Math.max(1, width), { trim: false }).split("\n");
}

/**
 * Define `id` as a plain own data property. Quarantined ids may be unsafe
 * names (`__proto__` et al.); plain assignment would walk the prototype
 * setter instead of creating an own key.
 */
function defineEntry(target: Record<string, unknown>, id: string, value: unknown): void {
	Object.defineProperty(target, id, { value, enumerable: true, writable: true, configurable: true });
}

/** Drop the `panel.personas.<id>` prefix for narrow description columns. */
function stripPathPrefix(error: string, id: string): string {
	const prefix = `panel.personas.${id}`;
	return error.startsWith(prefix) ? error.slice(prefix.length).replace(/^[.:]\s*/, "") : error;
}

/** Split the raw record into editable and quarantined rows, preserving key order. */
function loadEntries(personasRaw: Readonly<Record<string, unknown>> | undefined): PersonaEntry[] {
	const entries: PersonaEntry[] = [];
	if (personasRaw === undefined) return entries;
	for (const [id, value] of Object.entries(personasRaw)) {
		if (UNSAFE_PERSONA_IDS.includes(id)) {
			entries.push({ kind: "invalid", id, raw: value, error: `panel.personas.${id}: unsafe key name` });
			continue;
		}
		try {
			const persona = parsePanelPersona(value, `panel.personas.${id}`);
			entries.push({
				kind: "valid",
				id,
				label: persona.label,
				modes: [...persona.modes],
				instructions: persona.instructions,
				tools: persona.tools,
			});
		} catch (err) {
			entries.push({ kind: "invalid", id, raw: value, error: err instanceof Error ? err.message : String(err) });
		}
	}
	return entries;
}

/**
 * Fullscreen explicit-save persona editor. Implements {@link Component}
 * directly (rather than extending Container) so it owns the whole frame and
 * the mouse geometry needed to make every row clickable.
 */
export class PanelPersonaEditorComponent implements Component {
	#tui: TUI;
	#cb: PanelPersonaEditorCallbacks;
	#entries: PersonaEntry[];
	#dirty = false;
	/** Set after a first Close attempt with unsaved edits; a second closes. */
	#confirmDiscard = false;

	#screen: Screen = "list";
	/** The interactive element for the current screen. */
	#active: Component = new SelectList([], 1, getSelectListTheme());
	#footerHint = "";
	#previewScroll = 0;

	// Frame geometry from the last render (the frame paints from screen row 0,
	// so SGR `event.row`/`event.col` (already 0-based) index it directly).
	#bodyRowStart = 0;
	#dividerCol = 0;

	constructor(
		tui: TUI,
		personasRaw: Readonly<Record<string, unknown>> | undefined,
		callbacks: PanelPersonaEditorCallbacks,
	) {
		this.#tui = tui;
		this.#cb = callbacks;
		this.#entries = loadEntries(personasRaw);
		this.#showList();
	}

	// ───────────────────────────── render ─────────────────────────────

	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || 40);
		const bodyRows = Math.max(3, height - 4);
		const title = `Panel personas${this.#dirty ? "  ● unsaved" : ""}`;
		const out: string[] = [];

		if (this.#screen === "list") {
			const sidebarWidth = Math.max(22, Math.min(42, Math.floor(width * 0.34)));
			this.#dividerCol = sidebarWidth + 3;
			const bodyWidth = splitBodyWidth(width, sidebarWidth);
			const sidebar = this.#active.render(sidebarWidth);
			const preview = this.#previewWindow(bodyWidth, bodyRows);
			out.push(topBorderSplit(width, title, sidebarWidth));
			this.#bodyRowStart = out.length;
			for (let i = 0; i < bodyRows; i++) {
				out.push(splitRow(sidebar[i] ?? "", preview[i] ?? "", width, sidebarWidth));
			}
			out.push(dividerSplit(width, sidebarWidth));
		} else {
			out.push(topBorder(width, title));
			this.#bodyRowStart = out.length;
			const lines = this.#active.render(Math.max(1, width - 4));
			for (let i = 0; i < bodyRows; i++) out.push(row(lines[i] ?? "", width));
			out.push(divider(width));
		}

		out.push(row(theme.fg("dim", this.#footerHint), width));
		out.push(bottomBorder(width));
		return out;
	}

	// ───────────────────────────── input ─────────────────────────────

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
			return;
		}
		this.#active.handleInput?.(data);
	}

	/** Forward enhanced-paste transports into a multiline instructions editor. */
	pasteText(text: string): void {
		if (this.#active instanceof HookEditorComponent) this.#active.pasteText(text);
	}

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		// Right pane of the split (the preview) only scrolls; everything left of the
		// divider routes into the active list/component at frame-local coordinates.
		if (this.#screen === "list" && event.col >= this.#dividerCol) {
			if (event.wheel !== null) {
				this.#previewScroll = Math.max(0, this.#previewScroll + event.wheel);
				this.#cb.requestRender();
			}
			return true;
		}
		const el = this.#active as Partial<MouseRoutable>;
		if (typeof el.routeMouse === "function") {
			el.routeMouse(event, event.row - this.#bodyRowStart, event.col);
			return true;
		}
		return false;
	}

	// ───────────────────────────── preview ───────────────────────────

	#previewWindow(bodyWidth: number, rows: number): string[] {
		const lines = this.#previewContent(bodyWidth);
		const maxScroll = Math.max(0, lines.length - rows);
		const start = Math.min(this.#previewScroll, maxScroll);
		const window = lines.slice(start, start + rows);
		if (lines.length > rows) {
			const marker =
				start + rows < lines.length
					? theme.fg("dim", `  ↓ ${lines.length - rows - start} more`)
					: theme.fg("dim", "  (end)");
			window[rows - 1] = marker;
		}
		return window;
	}

	#previewContent(bodyWidth: number): string[] {
		const list = this.#active;
		const value = list instanceof SelectList ? (list.getSelectedItem()?.value ?? "") : "";
		const match = /^persona:(\d+)$/.exec(value);
		if (match) {
			const entry = this.#entries[Number(match[1])];
			if (entry) {
				return entry.kind === "valid"
					? this.#validPreview(entry, bodyWidth)
					: this.#invalidPreview(entry, bodyWidth);
			}
		}
		const invalidCount = this.#entries.filter(entry => entry.kind === "invalid").length;
		const help =
			value === "add"
				? "Create a custom persona, then edit its label, modes, instructions, and tool profile. " +
					`Built-in personas (${Object.keys(BUILTIN_PANEL_PERSONAS).join(", ")}) are always available; ` +
					"a custom persona with the same id overrides the built-in."
				: value === "save"
					? "Re-validate every editable persona with the shared panel config parser and hand the " +
						"whole record to the host to persist" +
						(invalidCount > 0
							? `, including ${invalidCount} quarantined ${invalidCount === 1 ? "entry" : "entries"} kept unchanged. `
							: ". ") +
						"Until then all edits stay in memory."
					: value === "close"
						? this.#dirty
							? "Close the editor. Unsaved changes are discarded; pick Save personas first to keep them."
							: "Close the editor."
						: "";
		return wrap(help, bodyWidth).map(line => truncateToWidth(theme.fg("muted", line), bodyWidth));
	}

	#validPreview(entry: ValidPersonaEntry, bodyWidth: number): string[] {
		const lines = [theme.bold(entry.label), theme.fg("dim", `id: ${entry.id || "(empty)"}`)];
		if (Object.hasOwn(BUILTIN_PANEL_PERSONAS, entry.id)) {
			lines.push(theme.fg("warning", "Overrides the built-in persona with this id."));
		}
		lines.push(
			"",
			`${theme.fg("dim", "Modes:")} ${entry.modes.join(", ")}`,
			`${theme.fg("dim", "Tools:")} ${entry.tools}`,
			"",
			theme.fg("dim", "Instructions:"),
		);
		lines.push(
			...(entry.instructions.trim()
				? wrap(entry.instructions, bodyWidth)
				: [theme.fg("error", "(required; save fails until set)")]),
		);
		return lines.map(line => truncateToWidth(line, bodyWidth));
	}

	#invalidPreview(entry: InvalidPersonaEntry, bodyWidth: number): string[] {
		const lines = [
			theme.bold(entry.id || "(empty)"),
			theme.fg("error", `${theme.status.warning} Invalid persona (quarantined)`),
			"",
			...wrap(entry.error, bodyWidth).map(line => theme.fg("error", line)),
			"",
			theme.fg("dim", "Raw value (saved back unchanged until deleted):"),
		];
		let rawText: string;
		try {
			rawText = JSON.stringify(entry.raw, null, 2) ?? String(entry.raw);
		} catch {
			rawText = String(entry.raw);
		}
		lines.push(...rawText.split("\n"));
		lines.push(
			"",
			...wrap(
				"The panel config rejects this entry, so no panel can dispatch it. Fix it in the settings file by hand, or delete it here.",
				bodyWidth,
			).map(line => theme.fg("muted", line)),
		);
		return lines.map(line => truncateToWidth(line, bodyWidth));
	}

	// ───────────────────────────── screens ───────────────────────────

	#setScreen(screen: Screen, active: Component, footerHint: string): void {
		this.#screen = screen;
		this.#active = active;
		this.#footerHint = footerHint;
		this.#previewScroll = 0;
		this.#cb.requestRender();
	}

	#markDirty(): void {
		this.#dirty = true;
		this.#confirmDiscard = false;
	}

	#validSummary(entry: ValidPersonaEntry): string {
		const parts = [entry.label, entry.modes.join("/"), entry.tools];
		if (!entry.instructions.trim()) parts.push("needs instructions");
		if (Object.hasOwn(BUILTIN_PANEL_PERSONAS, entry.id)) parts.push("overrides built-in");
		return parts.join(" · ");
	}

	#showList(): void {
		const items: SelectItem[] = this.#entries.map((entry, index) =>
			entry.kind === "valid"
				? {
						value: `persona:${index}`,
						label: `${theme.status.enabled} ${entry.id || "(empty)"}`,
						description: this.#validSummary(entry),
					}
				: {
						value: `persona:${index}`,
						label: `${theme.status.warning} ${entry.id || "(empty)"}`,
						description: `invalid: ${stripPathPrefix(entry.error, entry.id)}`,
					},
		);
		items.push({ value: "add", label: "+ Add persona" });
		items.push({ value: "save", label: "Save personas" });
		items.push({ value: "close", label: "Close" });

		// Show every row (no internal overflow-search); the split frame supplies height.
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		list.onSelectionChange = () => {
			this.#previewScroll = 0;
			this.#cb.requestRender();
		};
		list.onSelect = item => this.#onListSelect(item.value);
		list.onCancel = () => this.#requestClose();
		this.#setScreen("list", list, "↑↓ move · Enter / click select · scroll preview on the right · Esc close");
	}

	#onListSelect(value: string): void {
		if (value === "add") {
			this.#showIdEditor(null);
			return;
		}
		if (value === "save") {
			this.#save();
			return;
		}
		if (value === "close") {
			this.#requestClose();
			return;
		}
		const match = /^persona:(\d+)$/.exec(value);
		if (match) {
			const index = Number(match[1]);
			const entry = this.#entries[index];
			if (!entry) return;
			if (entry.kind === "valid") this.#showDetail(index);
			else this.#showQuarantine(index);
		}
	}

	#requestClose(): void {
		if (this.#dirty && !this.#confirmDiscard) {
			this.#confirmDiscard = true;
			this.#cb.notify("Unsaved persona edits: pick Save personas to keep them, or Close again to discard.");
			return;
		}
		this.#cb.close();
	}

	/** Assemble the record and hand it to the host; abort on the first invalid editable entry. */
	#save(): void {
		const next: Record<string, unknown> = {};
		for (let index = 0; index < this.#entries.length; index++) {
			const entry = this.#entries[index];
			if (!entry) continue;
			if (entry.kind === "invalid") {
				defineEntry(next, entry.id, entry.raw);
				continue;
			}
			const shape = {
				label: entry.label,
				modes: [...entry.modes],
				instructions: entry.instructions,
				tools: entry.tools,
			};
			try {
				parsePanelPersona(shape, `panel.personas.${entry.id}`);
			} catch (err) {
				this.#cb.notify(err instanceof Error ? err.message : String(err));
				this.#showDetail(index);
				return;
			}
			defineEntry(next, entry.id, shape);
		}
		try {
			this.#cb.save(next);
		} catch (err) {
			this.#cb.notify(`Panel personas: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		this.#dirty = false;
		this.#confirmDiscard = false;
		this.#cb.notify("Panel personas saved.");
		this.#showList();
	}

	#showDetail(index: number): void {
		const entry = this.#entries[index];
		if (entry?.kind !== "valid") {
			this.#showList();
			return;
		}
		const items: SelectItem[] = [
			{ value: "id", label: "ID", description: entry.id || "(empty)" },
			{ value: "label", label: "Label", description: entry.label },
			{ value: "modes", label: "Modes", description: entry.modes.join(", ") },
			{ value: "instructions", label: "Instructions", description: previewLine(entry.instructions) },
			{ value: "tools", label: "Tools", description: entry.tools },
			{ value: "delete", label: "Delete this persona" },
			{ value: "back", label: "Back" },
		];
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		list.onSelect = item => this.#onDetailSelect(index, item.value);
		list.onCancel = () => this.#showList();
		this.#setScreen("detail", list, `Editing "${entry.id}" · Enter / click edit field · Esc back`);
	}

	#onDetailSelect(index: number, field: string): void {
		switch (field) {
			case "id":
				this.#showIdEditor(index);
				return;
			case "label":
				this.#showLabelEditor(index);
				return;
			case "modes": {
				const entry = this.#entries[index];
				if (entry?.kind === "valid") this.#showModesEditor(index, new Set(entry.modes), 0);
				return;
			}
			case "instructions":
				this.#showInstructionsEditor(index);
				return;
			case "tools":
				this.#showToolsPicker(index);
				return;
			case "delete":
				this.#entries.splice(index, 1);
				this.#markDirty();
				this.#showList();
				return;
			default:
				this.#showList();
		}
	}

	/** Quarantined entries expose exactly one action: delete. The parse error rides the footer. */
	#showQuarantine(index: number): void {
		const entry = this.#entries[index];
		if (entry?.kind !== "invalid") {
			this.#showList();
			return;
		}
		const items: SelectItem[] = [
			{ value: "delete", label: "Delete this persona", description: "remove the invalid entry from the record" },
			{ value: "back", label: "Keep quarantined", description: "saved back unchanged" },
		];
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		list.onSelect = item => {
			if (item.value === "delete") {
				this.#entries.splice(index, 1);
				this.#markDirty();
			}
			this.#showList();
		};
		list.onCancel = () => this.#showList();
		this.#setScreen("quarantine", list, `${entry.error} · Esc back`);
	}

	/** `index === null` creates a new persona; otherwise renames `entries[index]`. */
	#showIdEditor(index: number | null): void {
		const entry = index === null ? undefined : this.#entries[index];
		const input = new Input();
		if (entry) input.setValue(entry.id);
		input.onSubmit = value => {
			const id = value.trim();
			if (!id) {
				this.#cb.notify("Persona id must be a non-empty string.");
				return;
			}
			if (UNSAFE_PERSONA_IDS.includes(id)) {
				this.#cb.notify(`Persona id "${id}" is a reserved key name.`);
				return;
			}
			if (this.#entries.some((other, otherIndex) => other.id === id && otherIndex !== index)) {
				this.#cb.notify(`Persona id "${id}" already exists.`);
				return;
			}
			if (index === null) {
				this.#entries.push({
					kind: "valid",
					id,
					label: id,
					modes: [...PANEL_TASK_MODES],
					instructions: "",
					tools: "workspace-read",
				});
				this.#markDirty();
				this.#showDetail(this.#entries.length - 1);
				return;
			}
			if (entry?.kind === "valid" && entry.id !== id) {
				entry.id = id;
				this.#markDirty();
			}
			this.#showDetail(index);
		};
		input.onEscape = () => {
			if (index === null) this.#showList();
			else this.#showDetail(index);
		};
		this.#setScreen(
			"id",
			input,
			index === null
				? "Type a new persona id · Enter create · Esc cancel"
				: "Rename persona id · Enter save · Esc cancel",
		);
	}

	#showLabelEditor(index: number): void {
		const entry = this.#entries[index];
		if (entry?.kind !== "valid") {
			this.#showList();
			return;
		}
		const input = new Input();
		input.setValue(entry.label);
		input.onSubmit = value => {
			const label = value.trim();
			if (!label) {
				this.#cb.notify("Label must be a non-empty string.");
				return;
			}
			if (label !== entry.label) {
				entry.label = label;
				this.#markDirty();
			}
			this.#showDetail(index);
		};
		input.onEscape = () => this.#showDetail(index);
		this.#setScreen("label", input, "Type a label · Enter save · Esc cancel");
	}

	#showModesEditor(index: number, selected: Set<PanelTaskMode>, cursor: number): void {
		const entry = this.#entries[index];
		if (entry?.kind !== "valid") {
			this.#showList();
			return;
		}
		const items: SelectItem[] = PANEL_TASK_MODES.map(mode => ({
			value: mode,
			label: `${selected.has(mode) ? "[x]" : "[ ]"} ${mode}`,
			description: MODE_DESCRIPTION[mode],
		}));
		items.push({ value: "__done", label: "Done" });
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		list.setSelectedIndex(cursor);
		let cursorIndex = cursor;
		list.onSelectionChange = item => {
			cursorIndex = items.findIndex(i => i.value === item.value);
		};
		list.onSelect = item => {
			if (item.value === "__done") {
				if (selected.size === 0) {
					this.#cb.notify("Personas must support at least one task mode.");
					return;
				}
				const modes = PANEL_TASK_MODES.filter(mode => selected.has(mode));
				if (modes.join() !== entry.modes.join()) {
					entry.modes = modes;
					this.#markDirty();
				}
				this.#showDetail(index);
				return;
			}
			const mode = item.value as PanelTaskMode;
			if (selected.has(mode)) selected.delete(mode);
			else selected.add(mode);
			this.#showModesEditor(index, selected, cursorIndex);
		};
		list.onCancel = () => this.#showDetail(index);
		this.#setScreen("modes", list, "Enter / click toggle · Done apply · Esc discard");
	}

	/** Fixed catalog only: the two {@link PANEL_PERSONA_TOOLS} profiles, never freeform names. */
	#showToolsPicker(index: number): void {
		const entry = this.#entries[index];
		if (entry?.kind !== "valid") {
			this.#showList();
			return;
		}
		const items: SelectItem[] = PANEL_PERSONA_TOOLS.map(tools => ({
			value: tools,
			label: `${entry.tools === tools ? "(•)" : "( )"} ${tools}`,
			description: TOOLS_DESCRIPTION[tools],
		}));
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		list.setSelectedIndex(Math.max(0, PANEL_PERSONA_TOOLS.indexOf(entry.tools)));
		list.onSelect = item => {
			const tools = item.value as PanelPersonaTools;
			if (tools !== entry.tools) {
				entry.tools = tools;
				this.#markDirty();
			}
			this.#showDetail(index);
		};
		list.onCancel = () => this.#showDetail(index);
		this.#setScreen("tools", list, "Enter / click pick · Esc back");
	}

	#showInstructionsEditor(index: number): void {
		const entry = this.#entries[index];
		if (entry?.kind !== "valid") {
			this.#showList();
			return;
		}
		const editor = new HookEditorComponent(
			this.#tui,
			`Instructions — ${entry.id}`,
			entry.instructions || undefined,
			value => {
				const text = value.trim() ? value : "";
				if (text !== entry.instructions) {
					entry.instructions = text;
					this.#markDirty();
				}
				if (!text) this.#cb.notify("Instructions are required; save fails until they are set.");
				this.#showDetail(index);
			},
			() => this.#showDetail(index),
		);
		this.#setScreen("instructions", editor, "");
	}
}
