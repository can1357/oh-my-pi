/**
 * Fullscreen one-off panel lineup builder: assembles 2-4 panel members (model
 * picked through the shared ModelBrowser, an explicit thinking choice bounded
 * by that model's supported efforts, and a persona under the `personas`
 * strategy), then hands the finished {@link PanelRole} to the host through
 * `onSubmit`. The lineup is ephemeral by contract: the component never writes
 * settings, and the parsed `panel` settings passed in are read only as the
 * custom-persona catalog.
 *
 * Reuses the advisor-config overlay's screen state machine: a split
 * sidebar+preview root screen and full-frame sub-screens (member detail,
 * model browser, thinking picker, persona picker) swapped through #setScreen.
 * Lifecycle stays host-owned: Esc/Close invokes `onClose` while idle, Esc
 * invokes `onAbort` while a panel is running, a resolved `onSubmit` is the
 * host's cue to tear the overlay down, and rejections are surfaced through
 * `notify` while the builder stays open and editable.
 */
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { modelFamilyToken } from "@oh-my-pi/pi-catalog/identity";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import {
	type Component,
	type MouseRoutable,
	routeSgrMouseInput,
	type SelectItem,
	SelectList,
	type SgrMouseEvent,
	type TUI,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { BUILTIN_PANEL_PERSONAS } from "../../panel/config";
import {
	PANEL_MAX_MEMBERS,
	type PanelMember,
	type PanelPersona,
	type PanelRole,
	type PanelSettings,
	type PanelStrategy,
	type PanelTaskMode,
} from "../../panel/types";
import type { ConfiguredThinkingLevel } from "../../thinking";
import { getSelectListTheme, theme } from "../theme/theme";
import { buildBrowserItems, ModelBrowser, type ModelBrowserItem, sortModelItems } from "./model-browser";
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

/** Host callbacks: dispatch and overlay lifecycle stay host-owned. */
export interface PanelLineupBuilderCallbacks {
	/**
	 * Dispatch the built one-off lineup. Resolution means the host accepted the
	 * run (and typically closes the overlay itself); a rejection is surfaced
	 * through {@link PanelLineupBuilderCallbacks.notify} and the builder stays
	 * open and editable. Never persists anything.
	 */
	onSubmit: (role: PanelRole) => Promise<void>;
	/** Abort the running panel while preserving any settled member artifacts. */
	onAbort: () => Promise<void>;
	/** Tear down the overlay and restore the editor. */
	onClose: () => void;
	/** Surface a transient status/warning line to the user. */
	notify: (message: string) => void;
	requestRender: () => void;
}

/** Live model surfaces the builder reads; it never writes settings. */
export interface PanelLineupBuilderDeps {
	modelRegistry: ModelRegistry;
	settings: Settings;
	/** Session-scoped models; when non-empty they replace the registry catalog. */
	scopedModels?: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
}

/** The immutable run context the lineup is being built for. */
export interface PanelLineupBuilderContext {
	/** Parsed `panel` settings; read only as the custom-persona catalog. */
	panelSettings: PanelSettings;
	/** Task mode of the pending request; bounds which personas are offered. */
	taskMode: PanelTaskMode;
	/** The request the panel will answer, shown for confirmation only. */
	request: string;
}

/** One in-progress member row. `model` is kept for effort and family bounds. */
interface DraftMember {
	/** Canonical `provider/id` selector picked in the model browser. */
	selector: string;
	model: Model;
	/** Explicit member thinking; undefined means the model default. */
	thinking?: ConfiguredThinkingLevel;
	/** Persona id; meaningful (and required) only under the personas strategy. */
	persona?: string;
}

/** Request-preview line budget inside the run pane; the preview itself scrolls. */
const PREVIEW_REQUEST_LINES = 6;

/**
 * Rows the model browser adds around its list window (search row + blank
 * above, blank + two detail rows below); mirrors the model-hub sizing idiom.
 */
const MODEL_BROWSER_CHROME_ROWS = 5;

/** Soft-wrap plain text to `width`, returning at least one (possibly empty) line. */
function wrap(text: string, width: number): string[] {
	if (!text) return [""];
	return Bun.wrapAnsi(text, Math.max(1, width), { trim: false }).split("\n");
}

type Screen = "list" | "member" | "model" | "thinking" | "persona";

/**
 * Fullscreen one-off lineup builder. Implements {@link Component} directly
 * (rather than extending Container) so it owns the whole frame and the mouse
 * geometry needed to make every row clickable.
 */
export class PanelLineupBuilderOverlayComponent implements Component {
	#tui: TUI;
	#modelRegistry: ModelRegistry;
	#settings: Settings;
	#scopedModels: ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	#panelSettings: PanelSettings;
	#taskMode: PanelTaskMode;
	#request: string;
	#cb: PanelLineupBuilderCallbacks;

	#strategy: PanelStrategy = "independent";
	#members: DraftMember[] = [];
	/** True while `onSubmit` is in flight; guards re-entrant Run. */
	#submitting = false;
	/** True after Esc requests cancellation, until the submission settles. */
	#cancelling = false;

	#screen: Screen = "list";
	/** The interactive element for the current screen. */
	#active: Component = new SelectList([], 1, getSelectListTheme());
	#footerHint = "";
	#previewScroll = 0;

	// Frame geometry from the last render (the frame paints from screen row 0,
	// so SGR `event.row`/`event.col` (already 0-based) index it directly.
	#bodyRowStart = 0;
	#dividerCol = 0;

	constructor(
		tui: TUI,
		deps: PanelLineupBuilderDeps,
		context: PanelLineupBuilderContext,
		callbacks: PanelLineupBuilderCallbacks,
	) {
		this.#tui = tui;
		this.#modelRegistry = deps.modelRegistry;
		this.#settings = deps.settings;
		this.#scopedModels = deps.scopedModels ?? [];
		this.#panelSettings = context.panelSettings;
		this.#taskMode = context.taskMode;
		this.#request = context.request;
		this.#cb = callbacks;
		// An empty lineup's first action is always "add", so start the cursor there.
		this.#showList("add");
	}

	// ───────────────────────────── render ─────────────────────────────

	render(width: number): readonly string[] {
		const height = Math.max(14, this.#tui.terminal.rows || 40);
		const bodyRows = Math.max(3, height - 4);
		const runState = this.#cancelling ? " · cancelling…" : this.#submitting ? " · running…" : "";
		const title = `Panel lineup · one-off · ${this.#taskMode}${runState}`;
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
			// The browser pads itself to a fixed block (chrome + list window);
			// size the window so the block fills the frame body.
			if (this.#active instanceof ModelBrowser) {
				this.#active.setMaxVisible(Math.max(4, bodyRows - MODEL_BROWSER_CHROME_ROWS));
			}
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

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		// Right pane of the split (the preview) only scrolls; everything left of
		// the divider routes into the active list/component at frame-local
		// coordinates.
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
		const match = /^member:(\d+)$/.exec(value);
		if (match) {
			const index = Number(match[1]);
			const member = this.#members[index];
			if (member) return this.#memberPreview(member, index, bodyWidth);
		}
		if (value === "strategy") return this.#strategyPreview(bodyWidth);
		if (value === "run") return this.#runPreview(bodyWidth);
		const help =
			value === "add"
				? `Add a member: pick its model, then an explicit thinking effort${
						this.#strategy === "personas" ? ", then a persona" : ""
					}. Members run in row order, at most ${PANEL_MAX_MEMBERS}.`
				: value === "close"
					? "Close the builder and discard this one-off lineup. Nothing is written to settings."
					: "";
		return wrap(help, bodyWidth).map(line => truncateToWidth(theme.fg("muted", line), bodyWidth));
	}

	#memberPreview(member: DraftMember, index: number, bodyWidth: number): string[] {
		const family = modelFamilyToken(member.model.id);
		const efforts = getSupportedEfforts(member.model);
		const lines = [
			theme.bold(`Member ${index + 1}`),
			"",
			`${theme.fg("dim", "Model:")} ${member.selector}`,
			`${theme.fg("dim", "Family:")} ${family || theme.fg("warning", "(unknown)")}`,
			`${theme.fg("dim", "Thinking:")} ${member.thinking ?? "model default"}${
				efforts.length === 0 ? theme.fg("dim", " (no effort control)") : ""
			}`,
		];
		if (this.#strategy === "personas") {
			const persona = member.persona === undefined ? undefined : this.#lookupPersona(member.persona);
			lines.push(
				`${theme.fg("dim", "Persona:")} ${
					member.persona === undefined
						? theme.fg("warning", "(required)")
						: persona
							? `${member.persona} · ${persona.label} · ${persona.tools === "none" ? "no tools" : "workspace read"}`
							: `${member.persona} ${theme.fg("error", "(unknown persona)")}`
				}`,
			);
			if (persona) {
				lines.push("", theme.fg("dim", "Instructions:"));
				lines.push(...wrap(persona.instructions, bodyWidth));
			}
		} else if (family) {
			const clash = this.#members.findIndex(
				(other, otherIndex) => otherIndex !== index && modelFamilyToken(other.model.id) === family,
			);
			if (clash >= 0) {
				lines.push("");
				lines.push(
					...wrap(
						`Shares the "${family}" model family with member ${clash + 1}; independent panels need distinct families.`,
						bodyWidth,
					).map(line => theme.fg("warning", line)),
				);
			}
		}
		return lines.map(line => truncateToWidth(line, bodyWidth));
	}

	#strategyPreview(bodyWidth: number): string[] {
		const personaCount = this.#personaChoices().length;
		const lines: string[] = [theme.bold(`Strategy: ${this.#strategy}`), ""];
		lines.push(
			...wrap("independent: members answer in isolation and must resolve to distinct model families.", bodyWidth),
		);
		lines.push("");
		lines.push(
			...wrap("personas: every member takes a read-only persona perspective; model families may repeat.", bodyWidth),
		);
		lines.push("");
		lines.push(
			...wrap(
				`${personaCount} persona${personaCount === 1 ? "" : "s"} support${personaCount === 1 ? "s" : ""} ${this.#taskMode} mode.`,
				bodyWidth,
			).map(line => theme.fg("dim", line)),
		);
		return lines.map(line => truncateToWidth(line, bodyWidth));
	}

	#runPreview(bodyWidth: number): string[] {
		const issues = this.#validationIssues();
		const lines: string[] = [
			theme.bold("Run one-off panel"),
			"",
			`${theme.fg("dim", "Task mode:")} ${this.#taskMode}`,
			`${theme.fg("dim", "Strategy:")} ${this.#strategy}`,
			`${theme.fg("dim", "Members:")} ${this.#members.length}/${PANEL_MAX_MEMBERS}`,
		];
		this.#members.forEach((member, index) => {
			const parts = [member.selector];
			if (member.thinking !== undefined) parts.push(member.thinking);
			if (this.#strategy === "personas") parts.push(member.persona ?? "(persona required)");
			lines.push(`  ${index + 1}. ${parts.join(" · ")}`);
		});
		lines.push("", theme.fg("dim", "Request:"));
		lines.push(...this.#requestLines(bodyWidth));
		lines.push("");
		if (this.#submitting) {
			lines.push(theme.fg("accent", this.#cancelling ? "Cancelling panel…" : "Dispatching panel…"));
		} else if (issues.length === 0) {
			lines.push(theme.fg("success", "Ready. Runs once; nothing is saved."));
		} else {
			lines.push(theme.fg("warning", "Not ready:"));
			for (const issue of issues) {
				lines.push(...wrap(`- ${issue}`, bodyWidth).map(line => theme.fg("warning", line)));
			}
		}
		return lines.map(line => truncateToWidth(line, bodyWidth));
	}

	#requestLines(bodyWidth: number): string[] {
		const text = this.#request.trim();
		if (!text) return [theme.fg("muted", "(empty request)")];
		const wrapped = wrap(text, bodyWidth);
		if (wrapped.length <= PREVIEW_REQUEST_LINES) return wrapped;
		const hidden = wrapped.length - PREVIEW_REQUEST_LINES;
		return [
			...wrapped.slice(0, PREVIEW_REQUEST_LINES),
			theme.fg("dim", `… ${hidden} more line${hidden === 1 ? "" : "s"}`),
		];
	}

	// ─────────────────────────── catalog/state ───────────────────────

	#otherStrategy(): PanelStrategy {
		return this.#strategy === "independent" ? "personas" : "independent";
	}

	/** Custom-over-built-in persona lookup; mirrors panel config resolution order. */
	#lookupPersona(personaId: string): PanelPersona | undefined {
		if (Object.hasOwn(this.#panelSettings.personas, personaId)) return this.#panelSettings.personas[personaId];
		if (Object.hasOwn(BUILTIN_PANEL_PERSONAS, personaId)) return BUILTIN_PANEL_PERSONAS[personaId];
		return undefined;
	}

	/**
	 * Personas offerable for this lineup: configured personas first (shadowing
	 * built-ins by id), then the remaining built-ins, all filtered to the ones
	 * valid for the current task mode.
	 */
	#personaChoices(): Array<{ id: string; persona: PanelPersona }> {
		const choices: Array<{ id: string; persona: PanelPersona }> = [];
		for (const [id, persona] of Object.entries(this.#panelSettings.personas)) choices.push({ id, persona });
		for (const [id, persona] of Object.entries(BUILTIN_PANEL_PERSONAS)) {
			if (!Object.hasOwn(this.#panelSettings.personas, id)) choices.push({ id, persona });
		}
		return choices.filter(choice => choice.persona.modes.includes(this.#taskMode));
	}

	#memberSummary(member: DraftMember): string {
		const thinking = `thinking: ${member.thinking ?? "default"}`;
		if (this.#strategy !== "personas") return thinking;
		return `${thinking} · persona: ${member.persona ?? "(required)"}`;
	}

	/**
	 * Everything the builder can check before dispatch. Model availability,
	 * auth, and resolved-family diversity remain the runtime's authority; the
	 * family pre-check here mirrors it from the picked models so a certain
	 * rejection is reported before the run starts.
	 */
	#validationIssues(): string[] {
		const issues: string[] = [];
		if (this.#members.length < 2) {
			issues.push(`needs at least 2 members (${this.#members.length} configured)`);
		}
		if (this.#strategy === "personas") {
			this.#members.forEach((member, index) => {
				if (member.persona === undefined) {
					issues.push(`member ${index + 1} needs a persona`);
					return;
				}
				const persona = this.#lookupPersona(member.persona);
				if (!persona) {
					issues.push(`member ${index + 1} persona "${member.persona}" is not configured`);
				} else if (!persona.modes.includes(this.#taskMode)) {
					issues.push(`member ${index + 1} persona "${member.persona}" does not support ${this.#taskMode} mode`);
				}
			});
			return issues;
		}
		const seenFamilies = new Map<string, number>();
		this.#members.forEach((member, index) => {
			const family = modelFamilyToken(member.model.id);
			if (family.length === 0) {
				issues.push(`member ${index + 1} model has no known family; independent panels need distinct families`);
				return;
			}
			const first = seenFamilies.get(family);
			if (first !== undefined) {
				issues.push(`members ${first + 1} and ${index + 1} share the "${family}" model family`);
			} else {
				seenFamilies.set(family, index);
			}
		});
		return issues;
	}

	// ───────────────────────────── screens ───────────────────────────

	#setScreen(screen: Screen, active: Component, footerHint: string): void {
		this.#screen = screen;
		this.#active = active;
		this.#footerHint = footerHint;
		this.#previewScroll = 0;
		this.#cb.requestRender();
	}

	#showList(selectValue?: string): void {
		const issues = this.#validationIssues();
		const items: SelectItem[] = [
			{ value: "strategy", label: `Strategy: ${this.#strategy}`, description: `→ ${this.#otherStrategy()}` },
		];
		this.#members.forEach((member, index) => {
			items.push({
				value: `member:${index}`,
				label: `${index + 1}. ${member.selector}`,
				description: this.#memberSummary(member),
			});
		});
		if (this.#members.length < PANEL_MAX_MEMBERS) items.push({ value: "add", label: "+ Add member" });
		items.push({
			value: "run",
			label: this.#submitting ? "Running…" : "Run panel",
			description: issues.length > 0 ? issues[0] : `${this.#members.length} members · ${this.#taskMode} · not saved`,
		});
		if (!this.#submitting) items.push({ value: "close", label: "Close" });

		// Show every row (no internal overflow-search); the split frame supplies height.
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		if (selectValue !== undefined) {
			const index = items.findIndex(item => item.value === selectValue);
			if (index >= 0) list.setSelectedIndex(index);
		}
		list.onSelectionChange = () => {
			this.#previewScroll = 0;
			this.#cb.requestRender();
		};
		list.onSelect = item => {
			if (!this.#submitting) this.#onListSelect(item.value);
		};
		list.onCancel = () => {
			if (this.#submitting) this.#abort();
			else this.#cb.onClose();
		};
		this.#setScreen(
			"list",
			list,
			this.#submitting
				? this.#cancelling
					? "Cancelling panel · controls locked until it settles"
					: "Panel running · controls locked · Esc cancel"
				: "↑↓ move · Enter / click select · scroll preview on the right · Esc close",
		);
	}

	#onListSelect(value: string): void {
		if (value === "strategy") {
			this.#strategy = this.#otherStrategy();
			this.#showList("strategy");
			return;
		}
		if (value === "add") {
			this.#startAddMember();
			return;
		}
		if (value === "run") {
			void this.#run();
			return;
		}
		if (value === "close") {
			this.#cb.onClose();
			return;
		}
		const match = /^member:(\d+)$/.exec(value);
		if (match) this.#showMemberDetail(Number(match[1]));
	}

	#showMemberDetail(index: number): void {
		const member = this.#members[index];
		if (!member) {
			this.#showList();
			return;
		}
		const items: SelectItem[] = [{ value: "model", label: "Model", description: member.selector }];
		if (getSupportedEfforts(member.model).length > 0) {
			items.push({ value: "thinking", label: "Thinking", description: member.thinking ?? "(model default)" });
		}
		if (this.#strategy === "personas") {
			const persona = member.persona === undefined ? undefined : this.#lookupPersona(member.persona);
			items.push({
				value: "persona",
				label: "Persona",
				description:
					member.persona === undefined
						? "(required)"
						: `${member.persona}${persona ? ` · ${persona.label}` : " · unknown"}`,
			});
		}
		items.push({ value: "remove", label: "Remove this member" }, { value: "back", label: "Back" });
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		list.onSelect = item => this.#onMemberDetailSelect(index, item.value);
		list.onCancel = () => this.#showList(`member:${index}`);
		this.#setScreen("member", list, `Member ${index + 1} · Enter / click edit field · Esc back`);
	}

	#onMemberDetailSelect(index: number, field: string): void {
		const member = this.#members[index];
		if (!member) {
			this.#showList();
			return;
		}
		switch (field) {
			case "model":
				this.#editMemberModel(index);
				return;
			case "thinking":
				this.#showThinkingPicker({
					selector: member.selector,
					efforts: getSupportedEfforts(member.model),
					current: member.thinking,
					onPick: thinking => {
						member.thinking = thinking;
						this.#showMemberDetail(index);
					},
					onBack: () => this.#showMemberDetail(index),
				});
				return;
			case "persona":
				this.#showPersonaPicker({
					memberLabel: `member ${index + 1}`,
					current: member.persona,
					onPick: personaId => {
						member.persona = personaId;
						this.#showMemberDetail(index);
					},
					onBack: () => this.#showMemberDetail(index),
				});
				return;
			case "remove":
				this.#members.splice(index, 1);
				this.#showList();
				return;
			default:
				this.#showList(`member:${index}`);
		}
	}

	// ─────────────────────────── pick sub-screens ────────────────────

	#showModelBrowser(options: {
		current?: string;
		onPick: (item: ModelBrowserItem) => void;
		onBack: () => void;
	}): void {
		const storage = this.#settings.getStorage();
		const mruOrder = storage?.getModelUsageOrder() ?? [];
		let models: ReadonlyArray<Model>;
		if (this.#scopedModels.length > 0) {
			models = this.#scopedModels.map(scoped => scoped.model);
		} else {
			try {
				models = this.#modelRegistry.getAvailable();
			} catch {
				models = [];
			}
		}
		const items = buildBrowserItems(models);
		sortModelItems(items, { mruOrder });

		const picker = new ModelBrowser(this.#settings, {});
		picker.setMruOrder(mruOrder);
		picker.setPerfStats(storage?.getModelPerf() ?? new Map());
		picker.setItems(items);
		if (options.current !== undefined) picker.selectSelector(options.current);
		picker.onActivate = options.onPick;
		picker.onCancel = options.onBack;
		this.#setScreen("model", picker, "Type to search · Enter / click twice picks · Esc back");
	}

	/**
	 * Explicit thinking choice for a just-picked model. Offers the model
	 * default plus exactly the efforts the model supports, so a stored level
	 * is always valid for its member's model.
	 */
	#showThinkingPicker(options: {
		selector: string;
		efforts: readonly string[];
		current?: ConfiguredThinkingLevel;
		onPick: (thinking: ConfiguredThinkingLevel | undefined) => void;
		onBack: () => void;
	}): void {
		const items: SelectItem[] = [{ value: "", label: "(model default thinking)" }];
		for (const effort of options.efforts) items.push({ value: effort, label: effort });
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		const currentIndex = items.findIndex(item => item.value === (options.current ?? ""));
		if (currentIndex > 0) list.setSelectedIndex(currentIndex);
		list.onSelect = item => {
			// `item.value` is one of the model's own supported efforts (or "" for
			// the model default), so the cast stays inside the config vocabulary.
			options.onPick(item.value ? (item.value as ConfiguredThinkingLevel) : undefined);
		};
		list.onCancel = options.onBack;
		this.#setScreen("thinking", list, `Thinking effort for ${options.selector} · Enter / click pick · Esc back`);
	}

	#showPersonaPicker(options: {
		memberLabel: string;
		current?: string;
		onPick: (personaId: string) => void;
		onBack: () => void;
	}): void {
		const choices = this.#personaChoices();
		if (choices.length === 0) {
			this.#cb.notify(`Panel lineup: no personas support ${this.#taskMode} mode`);
			options.onBack();
			return;
		}
		const items: SelectItem[] = choices.map(({ id, persona }) => ({
			value: id,
			label: id === options.current ? `${id} ✓` : id,
			description: `${persona.label} · ${persona.tools === "none" ? "no tools" : "workspace read"}`,
		}));
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		const currentIndex = items.findIndex(item => item.value === options.current);
		if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
		list.onSelect = item => options.onPick(item.value);
		list.onCancel = options.onBack;
		this.#setScreen(
			"persona",
			list,
			`Persona for ${options.memberLabel} (${this.#taskMode}) · Enter / click pick · Esc back`,
		);
	}

	// ───────────────────────────── add flow ──────────────────────────

	#startAddMember(): void {
		if (this.#members.length >= PANEL_MAX_MEMBERS) {
			this.#cb.notify(`Panel lineup: at most ${PANEL_MAX_MEMBERS} members`);
			return;
		}
		this.#showModelBrowser({
			onPick: item => this.#addThinkingStep(item),
			onBack: () => this.#showList("add"),
		});
	}

	#addThinkingStep(item: ModelBrowserItem, current?: ConfiguredThinkingLevel): void {
		const efforts = getSupportedEfforts(item.model);
		if (efforts.length === 0) {
			this.#addPersonaStep(item, undefined);
			return;
		}
		this.#showThinkingPicker({
			selector: item.selector,
			efforts,
			current,
			onPick: thinking => this.#addPersonaStep(item, thinking),
			onBack: () => this.#startAddMember(),
		});
	}

	#addPersonaStep(item: ModelBrowserItem, thinking: ConfiguredThinkingLevel | undefined): void {
		const draft: DraftMember = { selector: item.selector, model: item.model };
		if (thinking !== undefined) draft.thinking = thinking;
		if (this.#strategy !== "personas") {
			this.#appendMember(draft);
			return;
		}
		if (this.#personaChoices().length === 0) {
			// Keep the picked model instead of discarding the user's work; the
			// missing persona stays visible on the row and blocks Run.
			this.#appendMember(draft);
			this.#cb.notify(
				`Panel lineup: no personas support ${this.#taskMode} mode; member ${this.#members.length} needs one before running`,
			);
			return;
		}
		this.#showPersonaPicker({
			memberLabel: `member ${this.#members.length + 1}`,
			onPick: personaId => {
				draft.persona = personaId;
				this.#appendMember(draft);
			},
			onBack: () => {
				// Step back to the previous *rendered* screen: the thinking picker
				// when the model has one, otherwise the model browser.
				if (getSupportedEfforts(item.model).length === 0) this.#startAddMember();
				else this.#addThinkingStep(item, thinking);
			},
		});
	}

	#appendMember(draft: DraftMember): void {
		this.#members.push(draft);
		this.#showList(`member:${this.#members.length - 1}`);
	}

	// ───────────────────────────── edit flow ─────────────────────────

	#editMemberModel(index: number): void {
		const member = this.#members[index];
		if (!member) {
			this.#showList();
			return;
		}
		this.#showModelBrowser({
			current: member.selector,
			onPick: item => {
				const apply = (thinking: ConfiguredThinkingLevel | undefined): void => {
					member.selector = item.selector;
					member.model = item.model;
					member.thinking = thinking;
					this.#showMemberDetail(index);
				};
				const efforts = getSupportedEfforts(item.model);
				if (efforts.length === 0) {
					apply(undefined);
					return;
				}
				this.#showThinkingPicker({
					selector: item.selector,
					efforts,
					// Carry the old level over as the cursor default only when the
					// new model still supports it.
					current:
						member.thinking !== undefined && (efforts as readonly string[]).includes(member.thinking)
							? member.thinking
							: undefined,
					onPick: apply,
					onBack: () => this.#editMemberModel(index),
				});
			},
			onBack: () => this.#showMemberDetail(index),
		});
	}

	// ───────────────────────────── dispatch ──────────────────────────

	#abort(): void {
		if (!this.#submitting || this.#cancelling) return;
		this.#cancelling = true;
		this.#showList("abort");
		void this.#cb.onAbort().catch(error => {
			this.#cancelling = false;
			this.#cb.notify(`Panel cancel failed: ${error instanceof Error ? error.message : String(error)}`);
			if (this.#screen === "list") this.#showList("abort failed");
			else this.#cb.requestRender();
		});
	}

	async #run(): Promise<void> {
		if (this.#submitting) return;
		const issues = this.#validationIssues();
		if (issues.length > 0) {
			this.#cb.notify(`Panel lineup: ${issues[0]}`);
			return;
		}
		const members: PanelMember[] = this.#members.map(member =>
			Object.freeze({
				model: member.selector,
				...(member.thinking !== undefined ? { thinking: member.thinking } : {}),
				...(this.#strategy === "personas" && member.persona !== undefined ? { persona: member.persona } : {}),
			}),
		);
		const role: PanelRole = Object.freeze({ strategy: this.#strategy, members: Object.freeze(members) });

		this.#submitting = true;
		this.#cancelling = false;
		this.#showList("run");
		try {
			await this.#cb.onSubmit(role);
		} catch (err) {
			this.#cb.notify(`Panel run failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.#submitting = false;
			this.#cancelling = false;
			// Rebuild only if the list screen is still up; the host may already
			// have closed the overlay or the user may be mid-edit elsewhere.
			if (this.#screen === "list") this.#showList("run");
			else this.#cb.requestRender();
		}
	}
}
