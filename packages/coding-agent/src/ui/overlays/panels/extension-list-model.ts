/**
 * The extension inventory list: kind groups with headers (the unfiltered
 * ALL view), a provider's master switch (and `~/` opt-in) above its items,
 * or a flat list of search hits; the selection, its window, the search
 * field, and the row under the pointer.
 */
import { signal } from "@oh-my-pi/pi-tui";
import type { TspPickerGroup, TspPickerItem, TspTone } from "@oh-my-pi/pi-wire";
import { sanitizeDisplayLine } from "../../../extensibility/inventory/display-text";
import type {
	MCPConnectionHealth,
	MCPRuntimeSnapshot,
	MCPRuntimeSource,
} from "../../../extensibility/inventory/mcp-runtime";
import { snapshotMcpRuntime } from "../../../extensibility/inventory/mcp-runtime";
import { applyFilter } from "../../../extensibility/inventory/state-manager";
import {
	type Extension,
	type ExtensionKind,
	type ExtensionProvider,
	isShadowedExtension,
} from "../../../extensibility/inventory/types";
import { fuzzyHits } from "../../../modes/view-model/overlays/model-browser";
import { stableKey } from "../pickers/format";
import {
	isDiscoveredMcpServer,
	KIND_ORDER,
	kindIcon,
	kindLabel,
	rowHint,
	snapshotTools,
	type ToolRuntimeSource,
} from "./extensions-data";
import { selectKeyId } from "../../../config/keybindings/matchers";

export interface ExtensionListCallbacks {
	getProviders?: () => readonly ExtensionProvider[];
	onSelectionChange?: (extension: Extension | null) => void;
	onToggle?: (extensionId: string, enabled: boolean) => void;
	onMasterToggle?: (providerId: string) => void;
	onUserSourceToggle?: (providerId: string) => void;
	masterSwitchProvider?: string | null;
	mcpSource?: MCPRuntimeSource;
	toolSource?: ToolRuntimeSource;
}

/** One row of the list. */
export type ListRow =
	| { readonly type: "master"; readonly providerId: string; readonly providerName: string; readonly enabled: boolean }
	| {
			readonly type: "user-source";
			readonly providerId: string;
			readonly providerName: string;
			readonly enabled: boolean;
	  }
	| {
			readonly type: "kind-header";
			readonly kind: ExtensionKind;
			readonly label: string;
			readonly icon: string;
			readonly count: number;
	  }
	| { readonly type: "extension"; readonly item: Extension };

/** The selected row's switch: on or off, and why it cannot flip. */
export interface ListSwitch {
	readonly on: boolean;
	readonly blocked?: string;
}

const DEFAULT_MAX_VISIBLE = 15;

const MCP_HEALTH_TONE: Record<MCPConnectionHealth, TspTone> = {
	connected: "success",
	connecting: "pending",
	disconnected: "muted",
	inactive: "warning",
};

/** A row's identity: kept across rebuilds and filtering. */
function rowKey(row: ListRow): string {
	switch (row.type) {
		case "master":
			return `master:${row.providerId}`;
		case "user-source":
			return `user-source:${row.providerId}`;
		case "kind-header":
			return `kind:${row.kind}`;
		case "extension":
			// Shadowed same-name rows share the winner's id; the path tells them apart.
			return `extension:${row.item.id}:${row.item.path}`;
	}
}

/** A row's native id (its key hashed: safe inside keypaths). */
export function rowId(row: ListRow): string {
	return stableKey(rowKey(row));
}

export class ExtensionListModel {
	readonly rev = signal(0);
	extensions: Extension[];
	masterSwitchProvider: string | null;
	maxVisible: number;
	mcpSource: MCPRuntimeSource | undefined;
	toolSource: ToolRuntimeSource | undefined;
	focused = false;
	hovered: number | null = null;
	scrollOffset = 0;
	/** The search field (its text filters once it changes). */
	search = { text: "", cursor: 0 };
	/** The query the rows are filtered by. */
	query = "";
	rows: ListRow[] = [];
	selected = -1;
	#rev = 0;

	constructor(
		extensions: Extension[],
		readonly callbacks: ExtensionListCallbacks = {},
		maxVisible?: number,
	) {
		this.extensions = extensions;
		this.masterSwitchProvider = callbacks.masterSwitchProvider ?? null;
		this.mcpSource = callbacks.mcpSource;
		this.toolSource = callbacks.toolSource;
		this.maxVisible = maxVisible ?? DEFAULT_MAX_VISIBLE;
		this.rows = this.#build("");
		this.selected = this.rows.length > 0 ? 0 : -1;
	}

	touch(): void {
		this.rev.set(++this.#rev);
	}

	// ─── Rows ───────────────────────────────────────────────────────────────

	#provider(id: string | null): ExtensionProvider | undefined {
		return id === null ? undefined : this.callbacks.getProviders?.().find(provider => provider.id === id);
	}

	/** The provider in view is switched off: its rows are inert. */
	masterDisabled(): boolean {
		return this.masterSwitchProvider !== null && this.#provider(this.masterSwitchProvider)?.enabled === false;
	}

	#build(query: string): ListRow[] {
		const rows: ListRow[] = [];
		const filtered = query.length > 0 ? applyFilter(this.extensions, query) : this.extensions;
		if (query.length > 0) {
			for (const item of filtered) rows.push({ type: "extension", item });
			return rows;
		}
		if (this.masterSwitchProvider) {
			const providerName = filtered[0]?.source.providerName ?? this.masterSwitchProvider;
			const provider = this.#provider(this.masterSwitchProvider);
			rows.push({
				type: "master",
				providerId: this.masterSwitchProvider,
				providerName,
				enabled: provider?.enabled ?? true,
			});
			if (provider?.foreignUserSource) {
				rows.push({
					type: "user-source",
					providerId: this.masterSwitchProvider,
					providerName,
					enabled: provider.userSourceEnabled,
				});
			}
			for (const item of filtered) rows.push({ type: "extension", item });
			return rows;
		}
		const byKind = new Map<ExtensionKind, Extension[]>();
		for (const ext of filtered) {
			const list = byKind.get(ext.kind);
			if (list) list.push(ext);
			else byKind.set(ext.kind, [ext]);
		}
		for (const kind of KIND_ORDER) {
			const items = byKind.get(kind);
			if (!items?.length) continue;
			rows.push({ type: "kind-header", kind, label: kindLabel(kind), icon: kindIcon(kind), count: items.length });
			for (const item of items) rows.push({ type: "extension", item });
		}
		return rows;
	}

	/** Rebuild the rows, keeping the selected row when it is still there. */
	#rebuild(keep: boolean): void {
		const key = keep ? this.selectedRow() && rowKey(this.selectedRow()!) : undefined;
		this.rows = this.#build(this.query.trim());
		const index = key === undefined ? -1 : this.rows.findIndex(row => rowKey(row) === key);
		this.selected = this.rows.length === 0 ? -1 : Math.max(0, index);
	}

	selectedRow(): ListRow | undefined {
		return this.rows[this.selected];
	}

	selectedExtension(): Extension | null {
		const row = this.selectedRow();
		return row?.type === "extension" ? row.item : null;
	}

	/** Keep the selection in the window. */
	#syncScroll(): void {
		this.scrollOffset = scrollToShow(this.scrollOffset, this.selected, this.rows.length, this.maxVisible);
	}

	#notify(): void {
		this.callbacks.onSelectionChange?.(this.selectedExtension());
	}

	// ─── Owner API ──────────────────────────────────────────────────────────

	setMaxVisible(maxVisible: number): void {
		this.maxVisible = maxVisible;
		this.#syncScroll();
		this.touch();
	}

	setExtensions(extensions: Extension[]): void {
		this.extensions = extensions;
		const keepIndex = this.selected;
		this.#rebuild(true);
		this.selected = this.rows.length === 0 ? -1 : Math.max(0, Math.min(keepIndex, this.rows.length - 1));
		this.#syncScroll();
		this.touch();
	}

	setFocused(focused: boolean): void {
		this.focused = focused;
		this.touch();
	}

	setMasterSwitchProvider(providerId: string | null): void {
		this.masterSwitchProvider = providerId;
		this.#rebuild(true);
		this.#syncScroll();
		this.touch();
	}

	setMcpSource(source: MCPRuntimeSource | undefined): void {
		this.mcpSource = source;
		this.touch();
	}

	setToolSource(source: ToolRuntimeSource | undefined): void {
		this.toolSource = source;
		this.touch();
	}

	resetSelection(): void {
		this.selected = this.rows.length > 0 ? 0 : -1;
		this.scrollOffset = 0;
		this.#notify();
		this.touch();
	}

	/** Replace the search text (caret to the end) and refilter from the top. */
	setSearchQuery(query: string): void {
		this.search = { text: query, cursor: query.length };
		this.#setQuery(query);
		this.scrollOffset = 0;
		this.#notify();
		this.touch();
	}

	clearSearch(): void {
		this.setSearchQuery("");
	}

	#setQuery(query: string): void {
		if (query === this.query) return;
		this.query = query;
		this.#rebuild(false);
	}

	// ─── Input ──────────────────────────────────────────────────────────────

	/** Toggle the selected row, or flip the provider's master switch / `~/` opt-in. */
	activateSelected(): void {
		const row = this.selectedRow();
		if (row?.type === "master") this.callbacks.onMasterToggle?.(row.providerId);
		else if (row?.type === "user-source") {
			if (this.#provider(row.providerId)?.enabled !== false) this.callbacks.onUserSourceToggle?.(row.providerId);
		} else if (row?.type === "extension") {
			// A shadowed copy shares the winner's id: toggling it would flip the winner.
			if (isShadowedExtension(row.item) || this.masterDisabled()) return;
			this.callbacks.onToggle?.(row.item.id, row.item.state === "disabled");
		}
		this.touch();
	}

	#move(delta: -1 | 1): void {
		const next = Math.max(0, Math.min(this.rows.length - 1, this.selected + delta));
		if (this.rows.length === 0 || next === this.selected) return;
		this.selected = next;
		this.#syncScroll();
		this.#notify();
	}

	/** A key: ↑/↓ move, Space/Enter toggle (`tui.select.*`), everything else edits the search. */
	key(id: string, text: string | undefined): void {
		const nav = selectKeyId(id);
		if (nav === "up") this.#move(-1);
		else if (nav === "down") this.#move(1);
		else if (id === "space" || text === " " || nav === "enter") this.activateSelected();
		else {
			const before = this.search.text;
			this.search = editLine(this.search, id, text);
			if (this.search.text !== before) {
				this.#setQuery(this.search.text);
				this.scrollOffset = 0;
				this.#notify();
			}
		}
		this.touch();
	}

	/** Rows drawn in the window. */
	visibleCount(): number {
		if (this.rows.length === 0) return 0;
		const start = clampOffset(this.scrollOffset, this.rows.length, this.maxVisible);
		return Math.min(this.rows.length, start + Math.max(0, this.maxVisible)) - start;
	}

	/** The row index on line `line` of the list's face (search and blank first), or null. */
	hitTest(line: number): number | null {
		const at = line - 2;
		if (at < 0 || at >= this.visibleCount()) return null;
		const index = this.scrollOffset + at;
		return index < this.rows.length ? index : null;
	}

	setHoverIndex(index: number | null): void {
		this.hovered = index;
		this.touch();
	}

	/** A wheel notch moves the selection one row. */
	handleWheel(delta: -1 | 1): void {
		this.#move(delta);
		this.touch();
	}

	/** A click selects the row under the pointer, or toggles it when already selected. */
	handleClick(line: number): void {
		const index = this.hitTest(line);
		if (index === null) return;
		if (index === this.selected) {
			this.activateSelected();
			return;
		}
		this.selected = index;
		this.#notify();
		this.touch();
	}

	/** A native pick of row `id`: select it, then toggle it when `activate`. */
	pickNative(id: string, activate: boolean): boolean {
		const index = this.rows.findIndex(row => rowId(row) === id);
		if (index < 0) return false;
		if (index !== this.selected) {
			this.selected = index;
			this.#syncScroll();
			this.#notify();
		}
		if (activate) this.activateSelected();
		this.touch();
		return true;
	}

	// ─── Views ──────────────────────────────────────────────────────────────

	/** Live MCP health for an unshadowed discovered server. */
	mcpSnapshot(ext: Extension, shadowed: boolean, off: boolean): MCPRuntimeSnapshot | undefined {
		return ext.kind === "mcp" && isDiscoveredMcpServer(ext.raw) && !shadowed
			? snapshotMcpRuntime(ext.raw, this.mcpSource, { enabled: !off, shadowed: false })
			: undefined;
	}

	/** The selected row's switch (undefined on a header or an empty list). */
	selectedSwitch(): ListSwitch | undefined {
		const row = this.selectedRow();
		if (!row || row.type === "kind-header") return undefined;
		if (row.type === "master") return { on: row.enabled };
		if (row.type === "user-source")
			return this.#provider(row.providerId)?.enabled === false
				? { on: row.enabled, blocked: "Provider disabled" }
				: { on: row.enabled };
		const on = row.item.state !== "disabled";
		if (isShadowedExtension(row.item)) return { on, blocked: "Shadowed by another source" };
		if (this.masterDisabled()) return { on, blocked: "Provider disabled" };
		return { on };
	}

	#pickerItem(
		row: Exclude<ListRow, { type: "kind-header" }>,
		masterOff: boolean,
		tools: ToolRuntimeSource | undefined,
	): TspPickerItem {
		const id = rowId(row);
		if (row.type === "master") {
			return {
				id,
				label: `Enable ${sanitizeDisplayLine(row.providerName)}`,
				icon: "power",
				dot: row.enabled ? "success" : "muted",
				badges: [{ text: "Master Switch", tone: "warning" }],
				tone: row.enabled ? undefined : "muted",
			};
		}
		if (row.type === "user-source") {
			return {
				id,
				label: `Load ~/ ${sanitizeDisplayLine(row.providerName)} config`,
				icon: "folder",
				detail: "opt-in; project config always loads",
				dot: row.enabled ? "success" : "muted",
				tone: !row.enabled || masterOff ? "muted" : undefined,
				disabled: masterOff ? "Provider disabled" : undefined,
			};
		}
		const ext = row.item;
		const shadowed = isShadowedExtension(ext);
		const off = masterOff || ext.state === "disabled";
		const mcp = this.mcpSnapshot(ext, shadowed, off);
		const hint = rowHint(ext, mcp, tools);
		return {
			id,
			label: sanitizeDisplayLine(ext.displayName),
			detail: hint ? sanitizeDisplayLine(hint) : undefined,
			dot: masterOff
				? "muted"
				: shadowed
					? "warning"
					: mcp
						? MCP_HEALTH_TONE[mcp.health]
						: ext.state === "active"
							? "success"
							: "muted",
			tone: off ? "muted" : shadowed ? "warning" : undefined,
			badges: shadowed
				? [
						{
							text: "shadowed",
							tone: "warning",
							title: ext.shadowedBy ? `Shadowed by ${sanitizeDisplayLine(ext.shadowedBy)}` : undefined,
						},
					]
				: undefined,
			facts: { kind: kindLabel(ext.kind) },
			// Only a switched-off provider makes a row inert: a row toggled off must stay activatable.
			disabled: masterOff ? "Provider disabled" : undefined,
		};
	}

	/** The rows as `picker` data: items, display order with kind groups, selection and search hits. */
	pickerView(): {
		items: TspPickerItem[];
		order: (string | TspPickerGroup)[];
		selected: string | null;
		hits: Record<string, [number, number][]>;
		grouped: boolean;
	} {
		const tools = snapshotTools(this.toolSource);
		const masterOff = this.masterDisabled();
		const items: TspPickerItem[] = [];
		const order: (string | TspPickerGroup)[] = [];
		const hits: Record<string, [number, number][]> = {};
		let grouped = false;
		for (const row of this.rows) {
			if (row.type === "kind-header") {
				grouped = true;
				order.push({ group: rowId(row), label: row.label, count: row.count });
				continue;
			}
			const item = this.#pickerItem(row, masterOff, tools);
			items.push(item);
			order.push(item.id);
			if (this.query && typeof item.label === "string") {
				const marked = fuzzyHits(item.label, this.query);
				if (marked) hits[item.id] = marked;
			}
		}
		const selected = this.selectedRow();
		return {
			items,
			order,
			selected: selected && selected.type !== "kind-header" ? rowId(selected) : null,
			hits,
			grouped,
		};
	}
}

/** `offset` clamped to the rows a `height`-row window can start at. */
export function clampOffset(offset: number, total: number, height: number): number {
	return Math.max(0, Math.min(Math.trunc(offset) || 0, Math.max(0, total - Math.max(0, height))));
}

/** The window's start keeping `row` shown, moving as little as possible. */
export function scrollToShow(offset: number, row: number, total: number, height: number): number {
	if (total === 0 || height <= 0) return 0;
	const selected = Math.max(0, Math.min(row, total - 1));
	const current = clampOffset(offset, total, height);
	const next = selected < current ? selected : selected >= current + height ? selected - height + 1 : current;
	return clampOffset(next, total, height);
}

/** A key's edit of a one-line field: typing, deletion and caret moves. */
export function editLine(
	line: { readonly text: string; readonly cursor: number },
	id: string,
	text: string | undefined,
): { text: string; cursor: number } {
	const { text: value, cursor } = line;
	const chars = Array.from(value.slice(0, cursor));
	const prev = cursor - (chars.at(-1)?.length ?? 0);
	const after = Array.from(value.slice(cursor));
	const next = cursor + (after[0]?.length ?? 0);
	switch (id) {
		case "backspace":
			return cursor > 0
				? { text: value.slice(0, prev) + value.slice(cursor), cursor: prev }
				: { text: value, cursor };
		case "delete":
			return { text: value.slice(0, cursor) + value.slice(next), cursor };
		case "left":
			return { text: value, cursor: prev };
		case "right":
			return { text: value, cursor: next };
		case "home":
		case "ctrl+a":
			return { text: value, cursor: 0 };
		case "end":
		case "ctrl+e":
			return { text: value, cursor: value.length };
	}
	if (text && !/[\u0000-\u001f\u007f]/.test(text))
		return { text: value.slice(0, cursor) + text + value.slice(cursor), cursor: cursor + text.length };
	return { text: value, cursor };
}
