/**
 * The state behind every model list (the alt+p switcher, the /models hub,
 * the standalone browser, setup): the scope's rows, the query and its
 * ranking, the selection, the scroll window and the pointer hover, plus the
 * row and preview facts every view of it shows.
 *
 * Rows the user has used or that hold a role lead the list (the Recent
 * block), split from the rest by a rule. A blank query lists the scope in
 * display order; a query ranks it ({@link ModelItemRanker}, or fuzzy order
 * when the host keeps its own order). Single steps wrap, page and edge jumps
 * clamp; the window follows the selection only as far as it must, while the
 * wheel pans it without moving the selection.
 *
 * Views read it reactively: terminal looks through {@link ModelBrowserState.view},
 * native trees through the picker helpers ({@link ModelBrowserState.pickerItems},
 * {@link ModelBrowserState.pickerOrder}) or the row facts.
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getFactoryDroidCreditRate } from "@oh-my-pi/pi-catalog/models";
import { batch, type KeyEvent, type Signal, signal } from "@oh-my-pi/pi-tui";
import { presetSymbols } from "@oh-my-pi/pi-tui/theme/symbols";
import { sanitizeText, formatNumber } from "@oh-my-pi/pi-utils";
import type { TspPickerGroup, TspPickerItem, TspText } from "@oh-my-pi/pi-wire";
import {
	buildSearchAffinity,
	formatCostDetail,
	formatCostPair,
	fuzzyHits,
	heldRoles,
	inProviderScope,
	isFreeModel,
	MODEL_PICKER_COLUMNS,
	type ModelBrowserItem,
	type ModelBrowserPerf,
	type ModelBrowserSource,
	ModelItemRanker,
	measuredPerf,
	modelSearchText,
	nextCreditRateNote,
	parseProviderScopedQuery,
	pickerPrice,
	providerMark,
	recentBlockLength,
	type RoleAssignments,
	roleChipLabel,
	type SearchAffinity,
	thinkingDotToken,
} from "../../../modes/view-model/overlays/model-browser";
import { fuzzyRank } from "../../../utils/fuzzy";
import type { ConfiguredThinkingLevel } from "../../../utils/render-utils";
import { editLine, type LineState } from "../settings/line-edit";
import { matchesSelectCancel, selectKeyId } from "../../../config/keybindings/matchers";

/** The rule between the Recent block and the rest. */
export const SEPARATOR = Object.freeze({ separator: true as const });

/** One list row: a model or the Recent rule. */
export type BrowserRow = ModelBrowserItem | typeof SEPARATOR;

/** Whether a row is the Recent rule. */
export function isSeparator(row: BrowserRow | undefined): row is typeof SEPARATOR {
	return row === SEPARATOR;
}

/** What a row's perf column shows: nothing (narrow), output speed, or time-to-first-token and speed. */
export type PerfMode = "off" | "tps" | "full";

/** `118t/s` average output speed; one decimal below 10 t/s. */
export function formatTps(tps: number): string {
	return `${tps >= 10 ? String(Math.round(tps)) : tps.toFixed(1)}t/s`;
}

/** `0.9s` average time-to-first-token; whole seconds from 10s up. */
export function formatTtft(ms: number): string {
	const seconds = ms / 1000;
	return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
}

/** `200k` token count as rows show it. */
export function tokenCount(n: number): string {
	return formatNumber(n).toLowerCase();
}

/** A model's intelligence score, rounded; undefined when the catalog has none. */
export function intelligenceOf(model: Model): number | undefined {
	return model.int != null && Number.isFinite(model.int) ? Math.round(model.int) : undefined;
}

/** A provider blurb flattened to one line. */
export function flatDescription(description: string | undefined): string {
	if (!description) return "";
	return sanitizeText(description)
		.replace(/\t/g, "   ")
		.replace(/[\r\n]+/g, " ")
		.trim();
}

/** A role chip of the detail line: its label, whether auto-selected, its color, its thinking level. */
export interface RoleChip {
	readonly label: string;
	readonly auto: boolean;
	readonly color: string | undefined;
	readonly level: ConfiguredThinkingLevel;
}

/** One model row of a view: what the row draws, before width decides the columns. */
export interface ModelRowView {
	readonly selector: string;
	readonly provider: string;
	readonly id: string;
	readonly labelColor?: string;
	readonly current: boolean;
	/** The context window the session exceeds (`4.1k`); undefined when it fits. */
	readonly overContext?: string;
	readonly intelligence?: number;
	/** Context window (`200k`); undefined when unknown. */
	readonly ctx?: string;
	readonly cost: string;
	/** Perf column text per mode. */
	readonly perf: { readonly tps: string; readonly full: string };
}

/** The selection's detail: its facts, then the over-context warning or its role chips. */
export interface DetailView {
	readonly facts: readonly string[];
	/** Over the context window: `[session tokens, model window]`. */
	readonly overContext?: readonly [string, string];
	readonly current: boolean;
	readonly roles: readonly RoleChip[];
}

/** A terminal snapshot of the browser. */
export interface ModelBrowserView {
	readonly query: string;
	readonly cursor: number;
	readonly focused: boolean;
	readonly showProvider: boolean;
	/** Rows in the window, from {@link start}. */
	readonly rows: readonly (ModelRowView | null)[];
	/** Visible rows in total (scrollbar). */
	readonly total: number;
	readonly start: number;
	/** Window rows (blank rows pad the list to it). */
	readonly maxVisible: number;
	/** Index into the visible rows; -1 when none. */
	readonly selected: number;
	readonly hovered: number | null;
	/** The empty list's text (with its indent). */
	readonly empty: string;
	readonly detail: DetailView | undefined;
}

/** How {@link ModelBrowserState.pickerOrder} heads its rows. */
export interface PickerGrouping {
	/** One group per provider after the Recent block. */
	readonly providers: boolean;
	/** Label of the rows after the Recent block when not split by provider; null drops every head. */
	readonly rest: string | null;
}

/** A picker's catalogue props: `items` as last sent whole, plus patches since. */
export interface PickerCatalogue {
	readonly items: readonly TspPickerItem[];
	readonly itemsAdd?: readonly TspPickerItem[];
	readonly itemsDel?: readonly string[];
}

/** Options of a {@link ModelBrowserState}. */
export interface ModelBrowserOptions {
	/** Rows lead with a dim `provider/` (default true). */
	readonly showProvider?: boolean;
	/** Session tokens: rows whose window is smaller are flagged (when {@link markOverContext}). */
	readonly currentContextTokens?: number;
	readonly markOverContext?: boolean;
	/** Host empty-state text (provider discovery status), with its indent. */
	readonly emptyText?: () => string | undefined;
}

/** Keys the browser takes from the query field. */
const PAGE_KEYS: Readonly<Record<string, -1 | 1>> = { pageUp: -1, pageDown: 1 };

/** The browser state. */
export class ModelBrowserState {
	readonly source: ModelBrowserSource;
	readonly #items = signal<readonly BrowserRow[]>([]);
	readonly #visible = signal<readonly BrowserRow[]>([]);
	readonly #selected = signal(-1);
	readonly #start = signal(0);
	readonly #hovered = signal<number | null>(null);
	readonly #line = signal<LineState>({ text: "", cursor: 0 });
	readonly #roles = signal<RoleAssignments>({});
	readonly #mru = signal<readonly string[]>([]);
	readonly #perf = signal<ReadonlyMap<string, ModelBrowserPerf>>(new Map());
	readonly #current = signal<string | undefined>(undefined);
	readonly #maxVisible = signal(10);
	readonly #showProvider: Signal<boolean>;
	readonly #pickerProvider = signal(true);
	readonly #markOverContext: Signal<boolean>;
	readonly #preserveOrder = signal(false);
	readonly #focused = signal(true);
	readonly #contextTokens: number;
	readonly #emptyText: (() => string | undefined) | undefined;
	#affinity: SearchAffinity = { models: new Map(), providers: new Map() };
	#ranker: { source: readonly BrowserRow[]; affinity: SearchAffinity; ranker: ModelItemRanker } | undefined;
	/** When the earliest dated credit card of a listed model takes effect (the `free` search word follows it). */
	#nextCreditChange = Number.POSITIVE_INFINITY;
	/** The rows last sent whole as picker `items`, and the ids patched since. */
	#pickerBase: readonly TspPickerItem[] | undefined;
	readonly #pickerPatched = new Set<string>();

	/** Enter, a click on the selected row, or a native pick. */
	onActivate?: (item: ModelBrowserItem) => void;
	onSelectionChange?: (item: ModelBrowserItem | undefined) => void;
	onQueryChange?: (query: string) => void;
	/** The cancel key with an empty query (a non-empty query is cleared first). */
	onCancel?: () => void;

	constructor(source: ModelBrowserSource, options: ModelBrowserOptions = {}) {
		this.source = source;
		this.#showProvider = signal(options.showProvider ?? true);
		this.#markOverContext = signal(options.markOverContext ?? false);
		const tokens = options.currentContextTokens ?? 0;
		this.#contextTokens = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
		this.#emptyText = options.emptyText;
		this.#syncAffinity();
	}

	// ─── Inputs ─────────────────────────────────────────────────────────────

	/** Replace the scope's rows; the query re-applies and the selection stays on its model when listed. */
	setItems(items: readonly ModelBrowserItem[]): void {
		batch(() => {
			const key = this.selected()?.selector;
			this.#items.set(this.#withSeparator(items));
			this.#trackCreditClock();
			this.#refilter(key);
			this.onSelectionChange?.(this.selected());
			if (key) this.selectSelector(key);
			this.#clampWindow();
		});
	}

	setRoles(roles: RoleAssignments): void {
		this.#roles.set(roles);
		this.#syncAffinity();
	}

	setMruOrder(order: readonly string[]): void {
		this.#mru.set(order);
		this.#syncAffinity();
	}

	/** Measured speeds keyed by `provider/id` (and `provider/id@tier`). */
	setPerfStats(perf: ReadonlyMap<string, ModelBrowserPerf>): void {
		this.#perf.set(perf);
	}

	/** Mark `selector` as the session's model (undefined clears the mark). */
	setCurrentSelector(selector: string | undefined): void {
		this.#current.set(selector);
	}

	/** List window rows (the rest scrolls). */
	setMaxVisible(rows: number): void {
		batch(() => {
			this.#maxVisible.set(Math.max(1, rows));
			this.#clampWindow();
		});
	}

	setShowProvider(show: boolean): void {
		this.#showProvider.set(show);
	}

	/** Whether picker rows' labels lead with `provider/` (off where a provider logo already says it). */
	setPickerProvider(show: boolean): void {
		this.#pickerProvider.set(show);
	}

	/** Keep the host's order while searching (virtual rows such as quick roles). */
	setPreserveQueryOrder(preserve: boolean): void {
		this.#preserveOrder.set(preserve);
	}

	setMarkOverContext(mark: boolean): void {
		this.#markOverContext.set(mark);
	}

	/** Focused: the selected row shows the cursor glyph. */
	setFocused(focused: boolean): void {
		this.#focused.set(focused);
	}

	/** Replace the query (caret at its end). */
	setQuery(query: string): void {
		batch(() => {
			this.#line.set({ text: query, cursor: query.length });
			this.#applyQuery(true);
		});
	}

	// ─── Reads ──────────────────────────────────────────────────────────────

	get query(): string {
		return this.#line().text;
	}

	get cursor(): number {
		return this.#line().cursor;
	}

	get roles(): RoleAssignments {
		return this.#roles();
	}

	get currentSelector(): string | undefined {
		return this.#current();
	}

	get maxVisible(): number {
		return this.#maxVisible();
	}

	/** Whether rows lead with a dim `provider/`. */
	get showProvider(): boolean {
		return this.#showProvider();
	}

	/** The host's empty-state text, as given (with its indent). */
	get emptyNote(): string | undefined {
		return this.#emptyText?.();
	}

	/** The rows the list shows now, rule included. */
	get visible(): readonly BrowserRow[] {
		this.#syncCreditClock();
		return this.#visible();
	}

	/** The selected model; undefined when the list is empty. */
	selected(): ModelBrowserItem | undefined {
		this.#syncCreditClock();
		const row = this.#visible()[this.#selected()];
		return row && !isSeparator(row) ? row : undefined;
	}

	/** The selected row's selector, null when none. */
	get pickerSelected(): string | null {
		return this.selected()?.selector ?? null;
	}

	/** Rows of the scope before the query. */
	get baseCount(): number {
		let count = 0;
		for (const row of this.#items()) if (!isSeparator(row)) count++;
		return count;
	}

	/** Base rows matching the query, best first (rule dropped); undefined while the query is blank. */
	get queryMatches(): readonly ModelBrowserItem[] | undefined {
		if (!this.query.trim()) return undefined;
		this.#syncCreditClock();
		return this.#visible().filter((row): row is ModelBrowserItem => !isSeparator(row));
	}

	/** Whether `item`'s window is smaller than the session (flagged rows; hosts compact before switching). */
	isOverContext(item: ModelBrowserItem): boolean {
		if (!this.#markOverContext() || this.#contextTokens <= 0) return false;
		const window = item.model.contextWindow ?? 0;
		return window > 0 && this.#contextTokens > window;
	}

	/** Session tokens over-context rows compare against. */
	get contextTokens(): number {
		return this.#contextTokens;
	}

	// ─── Navigation ─────────────────────────────────────────────────────────

	/** Select `selector` when listed (scrolling it into view when the selection moves); false when it is not. */
	selectSelector(selector: string): boolean {
		const index = this.#visible().findIndex(row => !isSeparator(row) && row.selector === selector);
		if (index < 0) return false;
		// The window follows only a moved selection: re-selecting the selected row keeps a panned window.
		batch(() => {
			if (this.#select(index, 1)) this.#reveal();
		});
		return true;
	}

	/** Move by `delta` models (the rule is skipped); single steps wrap unless `wrap` is false. */
	moveSelection(delta: number, options: { wrap?: boolean } = {}): void {
		const rows = this.#visible();
		const total = rows.length;
		if (total === 0 || delta === 0) return;
		const wrap = options.wrap ?? true;
		const direction: -1 | 1 = delta < 0 ? -1 : 1;
		let remaining = Math.max(1, Math.abs(Math.trunc(delta)));
		const from = this.#selected();
		let at = from;
		for (let attempts = 0; attempts < total && remaining > 0; attempts++) {
			let next = at + direction;
			if (next < 0 || next >= total) {
				if (!wrap) break;
				next = direction > 0 ? 0 : total - 1;
			}
			if (next === at) break;
			at = next;
			if (!isSeparator(rows[at])) remaining--;
		}
		if (at === from) return;
		batch(() => {
			if (!this.#select(at, direction)) return;
			this.#reveal();
			this.onSelectionChange?.(this.selected());
		});
	}

	/** A picker row press: select it; `activate` also runs Enter. False when it is not a listed model. */
	routePickerItem(selector: string, activate: boolean): boolean {
		const index = this.#visible().findIndex(row => !isSeparator(row) && row.selector === selector);
		const row = this.#visible()[index];
		if (!row || isSeparator(row)) return false;
		batch(() => {
			if (this.#select(index, 1)) {
				this.#reveal();
				this.onSelectionChange?.(this.selected());
			}
		});
		if (activate) this.onActivate?.(row);
		return true;
	}

	/** The cancel ladder: clear a non-empty query, else hand cancel to the host. */
	handleCancel(): void {
		if (this.query.length > 0) {
			this.setQuery("");
			this.onQueryChange?.("");
			return;
		}
		this.onCancel?.();
	}

	/** A key: navigation, Enter, cancel, or a query edit. False when the browser has no use for it. */
	handleKey(key: KeyEvent): boolean {
		const total = this.#visible().length;
		if (matchesSelectCancel(key)) {
			this.handleCancel();
			return true;
		}
		const id = selectKeyId(key);
		switch (id) {
			case "up":
				this.moveSelection(-1);
				return true;
			case "down":
				this.moveSelection(1);
				return true;
			case "home":
				this.moveSelection(-total, { wrap: false });
				return true;
			case "end":
				this.moveSelection(total, { wrap: false });
				return true;
			case "enter": {
				const selected = this.selected();
				if (selected) this.onActivate?.(selected);
				return true;
			}
		}
		const page = PAGE_KEYS[id];
		if (page !== undefined) {
			this.moveSelection(page * this.#maxVisible(), { wrap: false });
			return true;
		}
		const next = editLine(this.#line(), key);
		if (!next) return false;
		const before = this.query;
		batch(() => {
			this.#line.set(next);
			if (next.text !== before) this.#applyQuery(true);
		});
		if (next.text !== before) this.onQueryChange?.(next.text);
		return true;
	}

	/** A native query edit (the field's own text and caret). */
	editQuery(line: LineState): void {
		const before = this.query;
		batch(() => {
			this.#line.set(line);
			if (line.text !== before) this.#applyQuery(true);
		});
		if (line.text !== before) this.onQueryChange?.(line.text);
	}

	// ─── Pointer ────────────────────────────────────────────────────────────

	/** The wheel pans the window by `delta` rows (never the selection); the hover follows the pointer's row. */
	wheel(delta: number, row: number | null): void {
		batch(() => {
			this.#start.set(this.#clampStart(this.#start() + delta));
			this.#hovered.set(this.#hoverable(row));
		});
	}

	/** Pointer motion over window row `row` (null: off the list). */
	hover(row: number | null): void {
		this.#hovered.set(this.#hoverable(row));
	}

	/** A click on window row `row`: selects it, or activates the selected one. */
	click(row: number): void {
		const index = this.#hoverable(row);
		const item = index === null ? undefined : this.#visible()[index];
		if (index === null || !item || isSeparator(item)) return;
		if (index === this.#selected()) {
			this.onActivate?.(item);
			return;
		}
		batch(() => {
			if (!this.#select(index, 1)) return;
			this.#reveal();
			this.onSelectionChange?.(this.selected());
		});
	}

	/** Drop the hover band (the pointer left the list). */
	clearHover(): void {
		this.#hovered.set(null);
	}

	// ─── Facts ──────────────────────────────────────────────────────────────

	/** Measured perf of `item`, else nothing. */
	measured(item: ModelBrowserItem): { perf: ModelBrowserPerf; tier?: string } | undefined {
		return measuredPerf(this.#perf(), item, this.source.serviceTierFor?.(item.model));
	}

	/** The perf column: measured speed (`25t/s`, `0.5s 25t/s`, with its tier), else the catalog's as `~80t/s`. */
	perfCell(item: ModelBrowserItem, mode: PerfMode): string {
		if (mode === "off") return "";
		const measured = this.measured(item);
		if (measured) {
			const tps = formatTps(measured.perf.tps);
			const tier = measured.tier ? ` ${measured.tier}` : "";
			if (mode === "full" && measured.perf.ttftMs !== null)
				return `${formatTtft(measured.perf.ttftMs)} ${tps}${tier}`;
			return `${tps}${tier}`;
		}
		const tps = item.model.tps;
		return tps != null && Number.isFinite(tps) && tps > 0 ? `~${formatTps(tps)}` : "";
	}

	/** The detail line's facts after the name: badges, window, output, price, capabilities, speed, credits, blurb. */
	detailFacts(
		item: ModelBrowserItem,
		options: { badges: boolean; description: boolean; symbol?: (key: string) => string },
	): string[] {
		const model = item.model;
		const facts: string[] = [];
		if (options.badges) {
			if (model.isNew) facts.push("new");
			if (model.isBeta) facts.push("beta");
			if (model.isRecommended) facts.push("recommended");
		}
		if (model.contextWindow) facts.push(`${tokenCount(model.contextWindow)} ctx`);
		if (model.maxTokens) facts.push(`${tokenCount(model.maxTokens)} out`);
		facts.push(formatCostDetail(model));
		if (model.reasoning) facts.push("reasoning");
		if (model.input.includes("image")) facts.push("vision");
		const int = intelligenceOf(model);
		if (int !== undefined) facts.push(`${(options.symbol ?? glyph)("icon.intelligence")} ${int}`);
		const measured = this.measured(item);
		if (measured) {
			facts.push(`~${formatTps(measured.perf.tps)}${measured.tier ? ` ${measured.tier}` : ""}`);
			if (measured.perf.ttftMs !== null) facts.push(`${formatTtft(measured.perf.ttftMs)} ttft`);
		} else if (model.tps != null && Number.isFinite(model.tps) && model.tps > 0) {
			facts.push(`~${formatTps(model.tps)}`);
		}
		const credits = nextCreditRateNote(model);
		if (credits) facts.push(credits);
		if (options.description) {
			const description = flatDescription(model.description);
			if (description) facts.push(description);
		}
		return facts;
	}

	/** Visible roles `model` holds, as detail chips. */
	roleChips(model: Model): RoleChip[] {
		return heldRoles(model, this.#roles(), this.source).map(({ role, assignment }) => ({
			label: roleChipLabel(role, this.source),
			auto: assignment.autoSelected,
			color: this.source.getRoleInfo(role).color,
			level: assignment.thinkingLevel,
		}));
	}

	/** One model row's facts. */
	rowView(item: ModelBrowserItem): ModelRowView {
		const model = item.model;
		const window = model.contextWindow ?? 0;
		return {
			selector: item.selector,
			provider: item.provider,
			id: item.id,
			...(item.labelColor ? { labelColor: item.labelColor } : {}),
			current: item.selector === this.#current(),
			...(this.isOverContext(item) ? { overContext: tokenCount(window) } : {}),
			...(intelligenceOf(model) !== undefined ? { intelligence: intelligenceOf(model) } : {}),
			...(window > 0 ? { ctx: tokenCount(window) } : {}),
			cost: formatCostPair(model),
			perf: { tps: this.perfCell(item, "tps"), full: this.perfCell(item, "full") },
		};
	}

	/** The terminal snapshot; `symbol` resolves the theme's glyphs. */
	view(symbol: (key: string) => string = glyph): ModelBrowserView {
		this.#syncCreditClock();
		const rows = this.#visible();
		const max = this.#maxVisible();
		const start = this.#start();
		const end = Math.min(start + max, rows.length);
		const window: (ModelRowView | null)[] = [];
		for (let i = start; i < end; i++) {
			const row = rows[i]!;
			window.push(isSeparator(row) ? null : this.rowView(row));
		}
		const selected = this.selected();
		const query = this.#line();
		return {
			query: query.text,
			cursor: query.cursor,
			focused: this.#focused(),
			showProvider: this.#showProvider(),
			rows: window,
			total: rows.length,
			start,
			maxVisible: max,
			selected: this.#selected(),
			hovered: this.#hovered(),
			empty:
				this.#emptyText?.() ?? (query.text.trim() ? "  No matching models" : "  No models available in this scope"),
			detail: selected
				? {
						facts: [
							selected.model.name,
							...this.detailFacts(selected, { badges: true, description: true, symbol }),
						],
						...(this.isOverContext(selected)
							? { overContext: [tokenCount(this.#contextTokens), tokenCount(selected.model.contextWindow ?? 0)] }
							: {}),
						current: selected.selector === this.#current(),
						roles: this.roleChips(selected.model),
					}
				: undefined,
		};
	}

	// ─── Picker (`picker` kind) ─────────────────────────────────────────────

	/** A picker row's label: the model id, after `provider/` unless the provider shows as a logo. */
	pickerLabel(item: ModelBrowserItem): string {
		return item.provider === "" || !this.#pickerProvider() ? item.id : item.selector;
	}

	/** One picker row. */
	pickerItem(item: ModelBrowserItem): TspPickerItem {
		const model = item.model;
		const facts: Record<string, TspText | number> = {};
		const int = intelligenceOf(model);
		if (int !== undefined) facts.int = String(int);
		const speed = this.perfCell(item, "tps")
			.replace(/\s*t\/s\s*/, " ")
			.trim();
		if (speed) facts.speed = speed;
		if (model.contextWindow) facts.ctx = model.contextWindow;
		facts.price = pickerPrice(model);
		const badges: { text: string; tone?: "accent" | "warning" | "success"; title?: string }[] = [];
		if (this.isOverContext(item)) {
			badges.push({
				text: `ctx>${tokenCount(model.contextWindow ?? 0)}`,
				tone: "warning",
				title: `Context ${tokenCount(this.#contextTokens)} exceeds this model's limit; picking it compacts first`,
			});
		}
		if (model.isNew) badges.push({ text: "new", tone: "accent" });
		if (model.isBeta) badges.push({ text: "beta", tone: "warning" });
		if (isFreeModel(model)) badges.push({ text: "free", tone: "success" });
		const chips = heldRoles(model, this.#roles(), this.source).map(({ role, assignment }) => {
			const dot = thinkingDotToken(assignment.thinkingLevel);
			return {
				text: roleChipLabel(role, this.source),
				on: !assignment.autoSelected,
				...(assignment.autoSelected ? { auto: true } : {}),
				...(dot ? { dot } : {}),
			};
		});
		// Quick-role rows (`@role`) name the role and trail the model they apply.
		const quickRole = item.provider === "" && item.id.startsWith("@");
		const title = [
			...(this.#pickerProvider() || item.provider === "" ? [] : [item.provider]),
			...(model.int != null && Number.isFinite(model.int) ? [`Intelligence ${Math.round(model.int)}`] : []),
		].join(" · ");
		return {
			id: item.selector,
			label: this.pickerLabel(item),
			mark: providerMark(model.provider),
			mono: true,
			...(quickRole ? { detail: `${model.provider}/${model.id}` } : {}),
			facts,
			...(badges.length > 0 ? { badges: badges.slice(0, 3) } : {}),
			...(chips.length > 0 ? { chips } : {}),
			...(title ? { title } : {}),
		};
	}

	/**
	 * Picker rows for `catalogue`. A catalogue that differs from the rows
	 * last sent whole in up to a quarter of them patches it (`itemsAdd`,
	 * `itemsDel`; a patched row stays in the patch), else it is sent whole.
	 */
	pickerItems(catalogue: readonly ModelBrowserItem[]): PickerCatalogue {
		const rows = catalogue.map(item => this.pickerItem(item));
		const base = this.#pickerBase;
		if (base) {
			const baseById = new Map(base.map(row => [row.id, row]));
			const listed = new Set(rows.map(row => row.id));
			const add = rows.filter(row => this.#pickerPatched.has(row.id) || !Bun.deepEquals(baseById.get(row.id), row));
			const del: string[] = [];
			for (const row of base) if (!listed.has(row.id)) del.push(row.id);
			for (const id of this.#pickerPatched) if (!baseById.has(id) && !listed.has(id)) del.push(id);
			if (add.length + del.length === 0) return { items: base };
			if ((add.length + del.length) * 4 <= base.length) {
				for (const row of add) this.#pickerPatched.add(row.id);
				for (const id of del) this.#pickerPatched.add(id);
				return {
					items: base,
					...(add.length > 0 ? { itemsAdd: add } : {}),
					...(del.length > 0 ? { itemsDel: del } : {}),
				};
			}
		}
		this.#pickerBase = rows;
		this.#pickerPatched.clear();
		return { items: rows };
	}

	/**
	 * The visible rows as picker `order` (the Recent block under "Recent",
	 * then the rest per provider or under `grouping.rest`), the query's hit
	 * ranges, and the selectable count.
	 */
	pickerOrder(grouping: PickerGrouping): {
		order: (string | TspPickerGroup)[];
		hits: Record<string, [number, number][]> | undefined;
		count: number;
	} {
		this.#syncCreditClock();
		const visible = this.#visible();
		const query = this.query.trim();
		const split = visible.findIndex(isSeparator);
		const order: (string | TspPickerGroup)[] = [];
		let count = 0;
		const push = (rows: readonly BrowserRow[]): void => {
			for (const row of rows) {
				if (isSeparator(row)) continue;
				order.push(row.selector);
				count++;
			}
		};
		const recent = split > 0 ? visible.slice(0, split) : [];
		const rest = split > 0 ? visible.slice(split + 1) : visible;
		if (grouping.rest === null) push(visible);
		else {
			if (recent.length > 0) {
				order.push({ group: "recent", label: "Recent", count: recent.length });
				push(recent);
			}
			if (grouping.providers) {
				for (let start = 0; start < rest.length;) {
					const provider = (rest[start] as ModelBrowserItem).provider;
					let end = start + 1;
					while (end < rest.length && (rest[end] as ModelBrowserItem).provider === provider) end++;
					order.push({ group: `provider:${provider}:${start}`, label: provider, count: end - start });
					push(rest.slice(start, end));
					start = end;
				}
			} else {
				if (recent.length > 0 && rest.length > 0)
					order.push({ group: "rest", label: grouping.rest, count: rest.length });
				push(rest);
			}
		}
		let hits: Record<string, [number, number][]> | undefined;
		if (query) {
			hits = {};
			const scoped = parseProviderScopedQuery(query);
			for (const row of visible) {
				if (isSeparator(row)) continue;
				const ranges =
					scoped && inProviderScope(scoped, row.provider)
						? this.#scopedHits(row, scoped.provider, scoped.model)
						: fuzzyHits(this.pickerLabel(row), query);
				if (ranges) hits[row.selector] = ranges;
			}
		}
		return { order, hits, count };
	}

	/** The search, column and row props of a model picker sheet. */
	pickerRows(catalogue: PickerCatalogue, grouping: PickerGrouping, current: string | undefined) {
		const view = this.pickerOrder(grouping);
		return {
			query: this.query,
			cursor: this.cursor,
			columns: MODEL_PICKER_COLUMNS,
			...catalogue,
			order: view.order,
			...(view.hits ? { hits: view.hits } : {}),
			selected: this.pickerSelected,
			...(current ? { current: [current] } : {}),
			total: this.baseCount,
		};
	}

	// ─── Internals ──────────────────────────────────────────────────────────

	#scopedHits(item: ModelBrowserItem, provider: string, model: string): [number, number][] | undefined {
		const idHits = fuzzyHits(item.id, model) ?? [];
		if (this.pickerLabel(item) === item.id) return idHits.length > 0 ? idHits : undefined;
		const offset = item.provider.length + 1;
		const ranges = [
			...(fuzzyHits(item.provider, provider) ?? []),
			...idHits.map(([start, end]): [number, number] => [start + offset, end + offset]),
		];
		return ranges.length > 0 ? ranges : undefined;
	}

	/** Note the earliest upcoming dated credit card across every listed model, shown or not. */
	#trackCreditClock(): void {
		const now = Date.now();
		let next = Number.POSITIVE_INFINITY;
		for (const row of this.#items.peek()) {
			if (isSeparator(row)) continue;
			const at = getFactoryDroidCreditRate(row.model, now)?.next?.at;
			if (at !== undefined && at < next) next = at;
		}
		this.#nextCreditChange = next;
	}

	/**
	 * A dated credit card took effect since the query was ranked: re-rank, so
	 * the `free` search word follows the rate in force (the selection stays
	 * on its model when still listed).
	 */
	#syncCreditClock(): void {
		if (Date.now() < this.#nextCreditChange) return;
		this.#trackCreditClock();
		// The ranker memoizes `provider/model` haystacks, `free` word included.
		this.#ranker = undefined;
		if (!this.query.trim()) return;
		batch(() => {
			const row = this.#visible.peek()[this.#selected.peek()];
			this.#refilter(row && !isSeparator(row) ? row.selector : undefined);
			this.#clampWindow();
		});
	}

	#syncAffinity(): void {
		this.#affinity = buildSearchAffinity(this.source.modelProviderOrder, this.#roles.peek(), this.#mru.peek());
	}

	/** `items` with the Recent rule after its block (none when the block is empty or everything). */
	#withSeparator(items: readonly BrowserRow[]): BrowserRow[] {
		const models = items.filter((row): row is ModelBrowserItem => !isSeparator(row));
		const recent = recentBlockLength(models, this.#roles.peek(), this.#mru.peek());
		return recent > 0 ? [...models.slice(0, recent), SEPARATOR, ...models.slice(recent)] : models;
	}

	/** The rows a non-blank query lists. */
	#rank(query: string): BrowserRow[] {
		const items = this.#items.peek();
		const models = items.filter((row): row is ModelBrowserItem => !isSeparator(row));
		if (this.#preserveOrder.peek())
			return this.#withSeparator(fuzzyRank(models, query, modelSearchText).map(r => r.item));
		let cached = this.#ranker;
		if (cached?.source !== items || cached.affinity !== this.#affinity) {
			cached = {
				source: items,
				affinity: this.#affinity,
				ranker: new ModelItemRanker(models, {
					roles: this.#roles.peek(),
					mruOrder: this.#mru.peek(),
					affinity: this.#affinity,
				}),
			};
			this.#ranker = cached;
		}
		return this.#withSeparator(cached.ranker.rank(query));
	}

	/** Recompute the visible rows; the selection lands on `preferred` when listed, else the first model. */
	#refilter(preferred: string | undefined): void {
		const query = this.query.trim();
		const rows = query ? this.#rank(query) : this.#items.peek();
		this.#visible.set(rows);
		let index = -1;
		if (preferred !== undefined) index = rows.findIndex(row => !isSeparator(row) && row.selector === preferred);
		this.#selected.set(index >= 0 ? index : this.#coerce(rows, 0, 1));
	}

	/**
	 * Re-apply the query after it changed. The selection resets to the first
	 * row unless every choice up to it is unchanged; a blank query re-seats
	 * the rule on the base order.
	 */
	#applyQuery(resetChangedPrefix: boolean): void {
		const previous = this.#visible.peek();
		const previousIndex = this.#selected.peek();
		const previousRow = previous[previousIndex];
		const previousKey = previousRow && !isSeparator(previousRow) ? previousRow.selector : undefined;
		if (!this.query.trim()) this.#items.set(this.#withSeparator(this.#items.peek()));
		this.#refilter(resetChangedPrefix ? undefined : previousKey);
		if (resetChangedPrefix && previousKey && this.#stablePrefix(previous, previousIndex)) {
			const index = this.#visible.peek().findIndex(row => !isSeparator(row) && row.selector === previousKey);
			if (index >= 0) this.#select(index, 1);
		}
		this.#reveal();
		this.onSelectionChange?.(this.selected());
	}

	/** Whether the new rows keep every model up to the previous selection, in order. */
	#stablePrefix(previous: readonly BrowserRow[], previousIndex: number): boolean {
		const current = this.#visible.peek();
		let at = 0;
		for (let i = 0; i <= previousIndex; i++) {
			const before = previous[i];
			if (!before || isSeparator(before)) continue;
			let found: ModelBrowserItem | undefined;
			while (at < current.length) {
				const candidate = current[at++];
				if (candidate && !isSeparator(candidate)) {
					found = candidate;
					break;
				}
			}
			if (found?.selector !== before.selector) return false;
		}
		return true;
	}

	/** Select `index` (a rule moves on in `direction`); false when the selection did not move. */
	#select(index: number, direction: -1 | 1): boolean {
		const next = this.#coerce(this.#visible.peek(), index, direction);
		if (next === this.#selected.peek()) return false;
		this.#selected.set(next);
		return true;
	}

	/** `index` clamped into `rows`, moved off the rule (`direction` first); -1 for no rows. */
	#coerce(rows: readonly BrowserRow[], index: number, direction: -1 | 1): number {
		if (rows.length === 0) return -1;
		const clamped = Math.max(0, Math.min(Math.trunc(index), rows.length - 1));
		if (!isSeparator(rows[clamped])) return clamped;
		for (let next = clamped + direction; next >= 0 && next < rows.length; next += direction)
			if (!isSeparator(rows[next])) return next;
		for (let next = clamped - direction; next >= 0 && next < rows.length; next -= direction)
			if (!isSeparator(rows[next])) return next;
		return clamped;
	}

	#clampStart(start: number): number {
		return Math.max(
			0,
			Math.min(Math.trunc(start), Math.max(0, this.#visible.peek().length - this.#maxVisible.peek())),
		);
	}

	#clampWindow(): void {
		this.#start.set(this.#clampStart(this.#start.peek()));
	}

	/** Scroll just enough to show the selection. */
	#reveal(): void {
		const total = this.#visible.peek().length;
		const height = this.#maxVisible.peek();
		if (total === 0) {
			this.#start.set(0);
			return;
		}
		const selected = Math.max(0, Math.min(this.#selected.peek(), total - 1));
		let start = this.#clampStart(this.#start.peek());
		if (selected < start) start = selected;
		else if (selected >= start + height) start = selected - height + 1;
		this.#start.set(this.#clampStart(start));
	}

	/** The list index under window row `row`; null off the list or on the rule. */
	#hoverable(row: number | null): number | null {
		if (row === null || row < 0) return null;
		const start = this.#start.peek();
		const end = Math.min(start + this.#maxVisible.peek(), this.#visible.peek().length);
		if (row >= end - start) return null;
		const index = start + row;
		return isSeparator(this.#visible.peek()[index]) ? null : index;
	}
}

const UNICODE_GLYPHS = presetSymbols("unicode");

/** A unicode-preset glyph for native text (`status.enabled` → `●`). */
export function glyph(key: string): string {
	return UNICODE_GLYPHS[key] ?? "";
}

/** The thinking glyph of a role chip: ⦸ for off, the level's own otherwise; none for inherit. */
export function thinkingGlyph(level: ConfiguredThinkingLevel): string {
	if (level === ThinkingLevel.Inherit) return "";
	if (level === ThinkingLevel.Off) return glyph("status.disabled");
	const symbol = glyph(`thinking.${level === "auto" ? "autoPending" : level}`);
	const space = symbol.indexOf(" ");
	return space < 0 ? symbol : symbol.slice(0, space);
}
