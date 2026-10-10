/**
 * Fullscreen /agents hub, shown on the alternate screen like /models.
 *
 * Layout mirrors the model hub: a sidebar of scopes (All agents, per-source
 * groups, "+ New agent"), a body listing agents with type-to-filter search,
 * and a footer that turns into a chip strip while configuring. Enter on an
 * agent opens its property strip (enabled / model / prewalk / advisor); a
 * property opens a value strip whose "pick model…" chip dives into the real
 * ModelBrowser and whose "pattern…" chip opens an inline pattern input, so
 * every per-agent knob is picked instead of memorized.
 */

import type { Model } from "@oh-my-pi/pi-ai";
import type { TspPickerAction, TspPickerColumn, TspPickerItem, TspPickerScope, TspSpan } from "@oh-my-pi/pi-wire";
import {
	type Component,
	Editor,
	FuzzyQuery,
	Input,
	matchesKey,
	replaceTabs,
	routeSgrMouseInput,
	type SgrMouseEvent,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../index";
import { code, col, md, node, row, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionHint, type NativeHint, hintsRow } from "../native/overlay";
import { CLOSE_ACTION, type PickerEvent, picker, pickerEvent, pickerQuery } from "../native/picker";
import type { AgentSource } from "../tools/task";
import { shortenPath } from "../render/render-utils";
import { sanitizeDisplaySingleLine } from "./extensions/display-text";
import { getEditorTheme, theme } from "../theme";
import { matchesAppFollowUp, matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { formatKeyHint, formatKeyHints } from "../app-keybindings";
import { boundKeys, editorKey, editorKeys } from "../chrome/keybinding-hints";
import {
	buildBrowserItems,
	ModelBrowser,
	type ModelBrowserItem,
	type ModelBrowserSource,
	sortModelItems,
} from "./model-browser";
import {
	describeHubFrame,
	describeHubSidebar,
	HubFrame,
	moveStripSelection,
	type SidebarEntry as HubSidebarEntry,
	type SidebarStyle,
	type StripChip as HubStripChip,
	type StripState as HubStripState,
} from "./hub-frame";

/** One agent with its per-agent settings overrides resolved for display. */
export interface HubAgent {
	name: string;
	description: string;
	systemPrompt: string;
	source: AgentSource;
	filePath?: string;
	model?: string[];
	prewalk?: boolean | string;
	advisor?: boolean | string;
	disabled: boolean;
	/** `task.agentModelOverrides[name]` as a comma-joined pattern list. */
	overrideModel?: string;
	/** `task.agentPrewalk[name]`: "on", "off", or a model pattern. */
	prewalkOverride?: string;
	/** `task.agentAdvisor[name]`: "on", "off", or a model pattern. */
	advisorOverride?: string;
}

const SOURCE_LABEL: Record<AgentSource, string> = {
	project: "Project",
	user: "User",
	bundled: "Bundled",
};
const SOURCE_ORDER: Record<AgentSource, number> = { project: 0, user: 1, bundled: 2 };
const SOURCES = ["project", "user", "bundled"] as const satisfies readonly AgentSource[];
/** Per-agent override columns of the config picker; lower priorities hide first. */
const AGENT_COLUMNS: readonly TspPickerColumn[] = [
	{ id: "model", head: "Model", format: "text", priority: 4, min: 8 },
	{ id: "prewalk", head: "Prewalk", format: "text", priority: 2 },
	{ id: "advisor", head: "Advisor", format: "text", priority: 3 },
];
const SOURCE_COLUMN: TspPickerColumn = { id: "source", head: "Source", format: "dim", priority: 1 };

interface SidebarEntry extends HubSidebarEntry<"all" | "source" | "new" | "separator"> {
	source?: AgentSource;
}

/** A body row of the agent list: an agent or the trailing "+ New agent…". */
type ListRow = { kind: "agent"; agent: HubAgent } | { kind: "new" };

/** The per-agent knob a strip or the model browser is editing. */
export type PropertyKind = "model" | "prewalk" | "advisor";

type StripChip = HubStripChip<
	| { kind: "toggle" }
	| { kind: "property"; property: PropertyKind }
	| { kind: "set"; property: PropertyKind; value: string | undefined }
	| { kind: "pick"; property: PropertyKind }
	| { kind: "pattern"; property: PropertyKind }
>;

type StripState =
	| (HubStripState<StripChip> & { kind: "chips"; agent: HubAgent; property?: PropertyKind })
	| { kind: "pattern"; agent: HubAgent; property: PropertyKind; input: Input };

export interface GeneratedAgentSpec {
	identifier: string;
	whenToUse: string;
	systemPrompt: string;
}

/** Runtime-owned discovery, settings, generation and persistence. */
export interface AgentsHubDeps {
	browserSource: ModelBrowserSource;
	loadAgents: () => Promise<HubAgent[]>;
	getAvailableModels: () => Model[];
	effectiveModelPatterns: (agent: HubAgent) => string[];
	resolvePatterns: (patterns: string[]) => string | undefined;
	effectivePrewalkPattern: (agent: HubAgent) => string | undefined;
	effectiveAdvisorPattern: (agent: HubAgent) => string | undefined;
	/** Persist one agent's enabled state; other agents are untouched. */
	setAgentDisabled: (name: string, options: { disabled: boolean }) => void;
	/** Persist one agent's override for `property`; `undefined` clears it. Other agents are untouched. */
	setAgentOverride: (property: PropertyKind, name: string, value: string | undefined) => void;
	generateAgent: (description: string, onText: (text: string) => void) => Promise<string>;
	saveAgent: (scope: "project" | "user", spec: GeneratedAgentSpec) => Promise<string>;
}

export interface AgentsHubCallbacks {
	onCancel: () => void;
}

const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+){1,5}$/;

function extractJsonObject(raw: string): string {
	// A bare JSON object may legitimately contain code fences inside string values; keep it intact.
	try {
		JSON.parse(raw);
		return raw;
	} catch {}
	const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenceMatch?.[1]) return fenceMatch[1].trim();
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start >= 0 && end >= start) return raw.slice(start, end + 1).trim();
	return raw.trim();
}

/**
 * Parse model output into a {@link GeneratedAgentSpec}. Accepts a bare JSON object
 * (tried first) or one wrapped in a code fence. Returns the spec with trimmed fields.
 * Throws if the output is not valid JSON or not an object, if `identifier`, `whenToUse`
 * or `systemPrompt` is missing or not a string, if the identifier is not lowercase
 * kebab-case with 2+ words, if `whenToUse` does not start with "Use this agent when",
 * or if `systemPrompt` is empty.
 */
export function parseGeneratedAgentSpec(raw: string): GeneratedAgentSpec {
	const parsed = JSON.parse(extractJsonObject(raw)) as Partial<GeneratedAgentSpec>;
	if (!parsed || typeof parsed !== "object") {
		throw new Error("Model output is not a JSON object");
	}
	if (
		typeof parsed.identifier !== "string" ||
		typeof parsed.whenToUse !== "string" ||
		typeof parsed.systemPrompt !== "string"
	) {
		throw new Error("Model output is missing required fields (identifier, whenToUse, systemPrompt)");
	}
	const identifier = parsed.identifier.trim();
	const whenToUse = parsed.whenToUse.trim();
	const systemPrompt = parsed.systemPrompt.trim();
	if (!IDENTIFIER_PATTERN.test(identifier)) {
		throw new Error("Generated identifier is invalid (must be lowercase kebab-case, 2+ words)");
	}
	if (!whenToUse.toLowerCase().startsWith("use this agent when")) {
		throw new Error("Generated whenToUse must start with 'Use this agent when...'");
	}
	if (!systemPrompt) {
		throw new Error("Generated systemPrompt is empty");
	}
	return { identifier, whenToUse, systemPrompt };
}

/** Stable native list-item id of an agent-list row. */
function listRowId(rowDef: ListRow): string {
	return rowDef.kind === "new" ? "new" : `agent:${rowDef.agent.source}:${rowDef.agent.name}`;
}

/** All `tokens` (prepared once per query) fuzzy-match the agent's searchable text. */
function matchAgent(agent: HubAgent, tokens: readonly FuzzyQuery[]): boolean {
	// Not memoized: `overrideModel` is edited in place, and the module index
	// cache already reuses the per-text index for unchanged agents.
	const text = `${agent.name} ${agent.description} ${SOURCE_LABEL[agent.source]} ${agent.overrideModel ?? ""}`;
	return tokens.every(token => token.match(text).matches);
}

/**
 * The fullscreen agents hub component. Hosted via
 * `ui.showOverlay(..., { fullscreen: true })`; the host must call
 * {@link AgentsHubComponent.dispose} when the overlay closes.
 */
export class AgentsHubComponent implements Component {
	#tui: TUI;
	#deps: AgentsHubDeps;
	#callbacks: AgentsHubCallbacks;

	#allAgents: HubAgent[] = [];
	#entries: SidebarEntry[] = [];
	#activeEntryId = "all";
	#focus: "scope" | "list" = "list";

	#rows: ListRow[] = [];
	#rowIndex = 0;
	#rowHover: number | null = null;
	#listScroll = 0;
	/** Type-to-filter field for the agent list (chrome-less; the hub draws `search:`). */
	readonly #search = Object.assign(new Input(), { prompt: "" });
	#notice: string | null = null;
	#loadError: string | null = null;

	#strip: StripState | null = null;
	/** Non-null while the body shows the model browser for one agent property. */
	#assigning: { agent: HubAgent; property: PropertyKind } | null = null;
	#browser: ModelBrowser;

	// Create flow (AI-generated agent definition).
	#createInput: Editor | null = null;
	#createDescription = "";
	#createScope: "project" | "user" = "project";
	#createGenerating = false;
	#createSpec: GeneratedAgentSpec | null = null;
	#createError: string | null = null;
	#createStreamingText = "";

	/** Bumped on every visible-state change; the described node is rebuilt when it moves. */
	#nativeVersion = 0;
	#nativeCache: { version: number; sheet: boolean; node: NativeNode } | undefined;
	/** Collapsed state of the generated system-prompt card (native only). */
	#promptCollapsed = true;

	#renderBodyPane = (width: number, height: number | undefined): readonly string[] => {
		const rows = Math.max(1, Math.floor(height ?? 10));
		const lines: string[] = [this.#statusRow(width)];
		if (this.#createActive) {
			lines.push(...this.#renderCreate(width, rows - 1));
		} else if (this.#assigning) {
			this.#browser.setMaxVisible(rows - 1 - 5);
			this.#browser.setFocused(true);
			lines.push(...this.#browser.render(width));
		} else {
			lines.push(...this.#renderList(width, rows - 1));
		}
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	};
	readonly #frame: HubFrame = new HubFrame(
		"Agents",
		{ min: 16, max: 24 },
		(width, rows) =>
			this.#frame.renderSidebar(
				this.#entries,
				width,
				rows,
				{ id: this.#activeEntryId, focused: this.#focus === "scope", follow: true, clamp: false },
				this.#sidebarStyle,
			),
		this.#renderBodyPane,
	);
	/** First agent-list row's offset in body-line coordinates (after the status row). */
	#listRowStart = 2;

	private constructor(tui: TUI, deps: AgentsHubDeps, callbacks: AgentsHubCallbacks) {
		this.#tui = tui;
		this.#deps = deps;
		this.#callbacks = callbacks;
		this.#browser = new ModelBrowser(deps.browserSource, {
			emptyText: () => "  No models available — configure a provider in /models first.",
		});
		this.#browser.setShowProvider(true);
		this.#browser.onActivate = item => this.#commitPickedModel(item);
		this.#browser.onCancel = () => this.#cancelAssign();
	}

	static async create(
		tui: TUI,
		deps: AgentsHubDeps,
		callbacks: AgentsHubCallbacks = { onCancel: () => {} },
	): Promise<AgentsHubComponent> {
		const hub = new AgentsHubComponent(tui, deps, callbacks);
		await hub.#reload();
		return hub;
	}

	dispose(): void {}
	invalidate(): void {
		this.#nativeVersion++;
		this.#frame.invalidate();
	}

	/** Request a repaint after a state change, invalidating the described node. */
	#requestRender(): void {
		this.#nativeVersion++;
		this.#tui.requestRender();
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Data pipeline
	// ═══════════════════════════════════════════════════════════════════════

	async #reload(): Promise<void> {
		this.#loadError = null;
		try {
			const selectedName = this.#selectedAgent()?.name;
			this.#allAgents = (await this.#deps.loadAgents()).sort((a, b) => {
				const sourceCmp = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
				return sourceCmp !== 0 ? sourceCmp : a.name.localeCompare(b.name);
			});
			this.#buildSidebar();
			this.#buildRows();
			if (selectedName) {
				const index = this.#rows.findIndex(r => r.kind === "agent" && r.agent.name === selectedName);
				if (index >= 0) this.#rowIndex = index;
			}
			this.#clampRowIndex();
		} catch (error) {
			this.#allAgents = [];
			this.#buildSidebar();
			this.#buildRows();
			this.#loadError = error instanceof Error ? error.message : String(error);
		}
		this.#requestRender();
	}

	#buildSidebar(): void {
		const counts: Record<AgentSource, number> = { project: 0, user: 0, bundled: 0 };
		for (const agent of this.#allAgents) counts[agent.source]++;
		const entries: SidebarEntry[] = [
			{ id: "all", kind: "all", label: "All agents", annotation: String(this.#allAgents.length) },
		];
		const sources = (["project", "user", "bundled"] as const).filter(source => counts[source] > 0);
		if (sources.length > 0) {
			entries.push({ id: "sep:sources", kind: "separator", label: "" });
			for (const source of sources) {
				entries.push({
					id: `source:${source}`,
					kind: "source",
					label: SOURCE_LABEL[source],
					source,
					annotation: String(counts[source]),
				});
			}
		}
		entries.push({ id: "sep:actions", kind: "separator", label: "" });
		entries.push({ id: "new", kind: "new", label: "New agent" });
		this.#entries = entries;
		if (!entries.some(entry => entry.id === this.#activeEntryId)) this.#activeEntryId = "all";
	}

	#activeEntry(): SidebarEntry {
		return this.#entries.find(entry => entry.id === this.#activeEntryId) ?? this.#entries[0];
	}

	#buildRows(): void {
		const entry = this.#activeEntry();
		const scoped =
			entry.kind === "source" ? this.#allAgents.filter(agent => agent.source === entry.source) : this.#allAgents;
		const query = this.#search.getValue();
		let filtered = scoped;
		if (query) {
			const tokens = query
				.trim()
				.split(/\s+/)
				.map(token => new FuzzyQuery(token));
			filtered = scoped.filter(agent => matchAgent(agent, tokens));
		}
		this.#rows = [...filtered.map(agent => ({ kind: "agent", agent }) as ListRow), { kind: "new" }];
	}

	#clampRowIndex(): void {
		this.#rowIndex = Math.max(0, Math.min(this.#rowIndex, this.#rows.length - 1));
	}

	#selectedAgent(): HubAgent | undefined {
		const rowDef = this.#rows[this.#rowIndex];
		return rowDef?.kind === "agent" ? rowDef.agent : undefined;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Mutations
	// ═══════════════════════════════════════════════════════════════════════

	#toggleAgent(agent: HubAgent): void {
		agent.disabled = !agent.disabled;
		this.#deps.setAgentDisabled(agent.name, { disabled: agent.disabled });
		this.#notice = `${agent.name} ${agent.disabled ? "disabled" : "enabled"}`;
		this.#requestRender();
	}

	#overrideFor(agent: HubAgent, property: PropertyKind): string | undefined {
		switch (property) {
			case "model":
				return agent.overrideModel;
			case "prewalk":
				return agent.prewalkOverride;
			case "advisor":
				return agent.advisorOverride;
		}
	}

	#setOverride(agent: HubAgent, property: PropertyKind, value: string | undefined): void {
		const trimmed = value?.trim() || undefined;
		switch (property) {
			case "model":
				agent.overrideModel = trimmed;
				break;
			case "prewalk":
				agent.prewalkOverride = trimmed;
				break;
			case "advisor":
				agent.advisorOverride = trimmed;
				break;
		}
		this.#deps.setAgentOverride(property, agent.name, trimmed);
		this.#notice = this.#describeProperty(agent, property);
		this.#requestRender();
	}

	/** One-line effective description used for notices and the status row. */
	#describeProperty(agent: HubAgent, property: PropertyKind): string {
		switch (property) {
			case "model": {
				const patterns = this.#deps.effectiveModelPatterns(agent);
				const resolved = this.#deps.resolvePatterns(patterns);
				const base = agent.overrideModel ?? (patterns.length > 0 ? patterns.join(",") : "session model");
				return `${agent.name} model: ${base}${resolved ? ` → ${resolved}` : ""}`;
			}
			case "prewalk": {
				const pattern = this.#deps.effectivePrewalkPattern(agent);
				return `${agent.name} prewalk: ${pattern ? `on (${pattern})` : "off"}`;
			}
			case "advisor": {
				const pattern = this.#deps.effectiveAdvisorPattern(agent);
				return `${agent.name} advisor: ${pattern ? `on (${pattern})` : "off"}`;
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Strips
	// ═══════════════════════════════════════════════════════════════════════

	#propertySummary(agent: HubAgent, property: PropertyKind): string {
		switch (property) {
			case "model":
				return agent.overrideModel ?? "auto";
			case "prewalk": {
				const pattern = this.#deps.effectivePrewalkPattern(agent);
				return pattern ?? "off";
			}
			case "advisor": {
				const pattern = this.#deps.effectiveAdvisorPattern(agent);
				return pattern ?? "off";
			}
		}
	}

	/** Level-1 strip: pick which knob of `agent` to change. */
	#openAgentStrip(agent: HubAgent): void {
		const enabledChip: StripChip = {
			label: agent.disabled ? "enable" : "disable",
			styled: agent.disabled
				? theme.fg("success", `${theme.status.enabled} enable`)
				: theme.fg("dim", `${theme.status.disabled} disable`),
			action: { kind: "toggle" },
		};
		const propertyChip = (property: PropertyKind): StripChip => {
			const summary = this.#propertySummary(agent, property);
			return {
				label: property,
				styled: `${theme.fg("accent", property)}${theme.fg("dim", `: ${summary}`)}`,
				action: { kind: "property", property },
			};
		};
		this.#strip = {
			kind: "chips",
			agent,
			chips: [enabledChip, propertyChip("model"), propertyChip("prewalk"), propertyChip("advisor")],
			index: 1,
		};
	}

	/** Level-2 strip: value choices for one property of `agent`. */
	#openPropertyStrip(agent: HubAgent, property: PropertyKind): void {
		const current = this.#overrideFor(agent, property)?.toLowerCase();
		const chips: StripChip[] = [];
		const mark = (label: string, active: boolean, color: "accent" | "muted" = "muted"): string =>
			active ? theme.fg("accent", `${theme.status.enabled} ${label}`) : theme.fg(color, label);
		if (property === "model") {
			chips.push({
				label: "pick model…",
				styled: theme.fg("accent", "pick model…"),
				action: { kind: "pick", property },
			});
			chips.push({
				label: "pattern…",
				styled: theme.fg("muted", "pattern…"),
				action: { kind: "pattern", property },
			});
			if (agent.overrideModel) {
				chips.push({
					label: "clear override",
					styled: theme.fg("warning", "clear override"),
					action: { kind: "set", property, value: undefined },
				});
			}
		} else {
			chips.push({
				label: "agent default",
				styled: mark("agent default", current === undefined),
				action: { kind: "set", property, value: undefined },
			});
			chips.push({
				label: "on",
				styled: mark("on", current === "on"),
				action: { kind: "set", property, value: "on" },
			});
			chips.push({
				label: "off",
				styled: mark("off", current === "off"),
				action: { kind: "set", property, value: "off" },
			});
			chips.push({
				label: "pick model…",
				styled: theme.fg("accent", "pick model…"),
				action: { kind: "pick", property },
			});
			chips.push({
				label: "pattern…",
				styled: theme.fg("muted", "pattern…"),
				action: { kind: "pattern", property },
			});
		}
		this.#strip = { kind: "chips", agent, property, chips, index: 0 };
	}

	#openPatternStrip(agent: HubAgent, property: PropertyKind): void {
		const input = new Input();
		const current = this.#overrideFor(agent, property);
		if (current) input.setValue(current);
		this.#strip = { kind: "pattern", agent, property, input };
	}

	#closeStrip(): void {
		this.#strip = null;
		this.#frame.chipRanges = [];
	}

	#activateStripChip(): void {
		const strip = this.#strip;
		if (strip?.kind !== "chips") return;
		const chip = strip.chips[strip.index];
		if (!chip) return;
		const action = chip.action;
		switch (action.kind) {
			case "toggle":
				this.#toggleAgent(strip.agent);
				this.#closeStrip();
				return;
			case "property":
				this.#openPropertyStrip(strip.agent, action.property);
				return;
			case "set":
				this.#setOverride(strip.agent, action.property, action.value);
				this.#closeStrip();
				return;
			case "pick":
				this.#closeStrip();
				this.#startAssign(strip.agent, action.property);
				return;
			case "pattern":
				this.#openPatternStrip(strip.agent, action.property);
				return;
		}
	}

	#submitPattern(): void {
		const strip = this.#strip;
		if (strip?.kind !== "pattern") return;
		this.#setOverride(strip.agent, strip.property, strip.input.getValue());
		this.#closeStrip();
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Model browser assign mode
	// ═══════════════════════════════════════════════════════════════════════

	#startAssign(agent: HubAgent, property: PropertyKind): void {
		const items = buildBrowserItems(this.#deps.getAvailableModels());
		sortModelItems(items, { mruOrder: this.#deps.browserSource.mruOrder });
		this.#assigning = { agent, property };
		this.#browser.setItems(items);
		this.#browser.setQuery("");
		const current = this.#overrideFor(agent, property);
		if (current) this.#browser.selectSelector(current);
	}

	#commitPickedModel(item: ModelBrowserItem): void {
		const target = this.#assigning;
		if (!target) return;
		this.#assigning = null;
		this.#browser.setQuery("");
		this.#setOverride(target.agent, target.property, item.selector);
	}

	#cancelAssign(): void {
		this.#assigning = null;
		this.#browser.setQuery("");
		this.#requestRender();
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Create flow
	// ═══════════════════════════════════════════════════════════════════════

	get #createActive(): boolean {
		return this.#createInput !== null || this.#createGenerating || this.#createSpec !== null;
	}

	#beginCreateFlow(): void {
		if (this.#createGenerating) return;
		this.#createError = null;
		this.#createSpec = null;
		this.#createDescription = "";
		const editor = new Editor(getEditorTheme());
		editor.setBorderVisible(false);
		editor.setPromptGutter("> ");
		editor.setMaxHeight(Math.max(3, Math.min(8, this.#terminalRows() - 12)));
		editor.disableSubmit = true;
		editor.onChange = value => {
			this.#createDescription = value;
		};
		this.#createInput = editor;
		this.#requestRender();
	}

	#clearCreateFlow(): void {
		this.#createInput = null;
		this.#createDescription = "";
		this.#createGenerating = false;
		this.#createSpec = null;
		this.#createError = null;
		this.#createStreamingText = "";
	}

	async #generateAgentFromDescription(rawDescription: string): Promise<void> {
		const description = rawDescription.trim();
		this.#createDescription = description;
		if (!description) {
			this.#createError = "Description is required.";
			this.#requestRender();
			return;
		}
		this.#createGenerating = true;
		this.#createError = null;
		this.#createSpec = null;
		this.#createStreamingText = "";
		this.#requestRender();
		try {
			const spec = await this.#runAgentCreationArchitect(description);
			this.#createSpec = spec;
			this.#notice = null;
		} catch (error) {
			this.#createError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#createGenerating = false;
			this.#requestRender();
		}
	}

	async #runAgentCreationArchitect(description: string): Promise<GeneratedAgentSpec> {
		const raw = await this.#deps.generateAgent(description, text => {
			this.#createStreamingText += text;
			this.#requestRender();
		});
		return parseGeneratedAgentSpec(raw);
	}

	async #saveGeneratedAgent(): Promise<void> {
		const spec = this.#createSpec;
		if (!spec) return;
		const filePath = await this.#deps.saveAgent(this.#createScope, spec);
		this.#clearCreateFlow();
		this.#notice = `Created agent ${spec.identifier} at ${shortenPath(filePath)}`;
		await this.#reload();
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Input
	// ═══════════════════════════════════════════════════════════════════════

	handleInput(data: string): void {
		this.#nativeVersion++;
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
			this.#requestRender();
			return;
		}

		if (this.#strip) {
			this.#handleStripInput(data);
			this.#requestRender();
			return;
		}

		if (this.#createActive) {
			this.#handleCreateInput(data);
			this.#requestRender();
			return;
		}

		if (matchesSelectCancel(data)) {
			if (this.#assigning) {
				this.#cancelAssign();
				return;
			}
			if (this.#search.getValue()) {
				this.#search.setValue("");
				this.#buildRows();
				this.#clampRowIndex();
				this.#requestRender();
				return;
			}
			this.#callbacks.onCancel();
			return;
		}

		if (this.#assigning) {
			this.#browser.handleInput(data);
			this.#requestRender();
			return;
		}

		if (matchesKey(data, "ctrl+r")) {
			void this.#reload();
			return;
		}

		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#focus = this.#focus === "scope" ? "list" : "scope";
			this.#requestRender();
			return;
		}
		if (matchesKey(data, "left")) {
			this.#focus = "scope";
			this.#requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			this.#focus = "list";
			this.#requestRender();
			return;
		}

		if (this.#focus === "scope") {
			if (matchesSelectUp(data)) {
				this.#moveSidebar(-1);
				this.#requestRender();
				return;
			}
			if (matchesSelectDown(data)) {
				this.#moveSidebar(1);
				this.#requestRender();
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				if (this.#activeEntry().kind === "new") {
					this.#beginCreateFlow();
				} else {
					this.#focus = "list";
				}
				this.#requestRender();
				return;
			}
		}

		if (matchesSelectUp(data)) {
			this.#rowIndex = Math.max(0, this.#rowIndex - 1);
			this.#requestRender();
			return;
		}
		if (matchesSelectDown(data)) {
			this.#rowIndex = Math.min(this.#rows.length - 1, this.#rowIndex + 1);
			this.#requestRender();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#activateRow(this.#rows[this.#rowIndex]);
			this.#requestRender();
			return;
		}
		if (data === " " && !this.#search.getValue()) {
			const agent = this.#selectedAgent();
			if (agent) this.#toggleAgent(agent);
			return;
		}
		// Type-to-filter: every other key edits the search field.
		const before = this.#search.getValue();
		if (!this.#search.handleInput(data)) return;
		const value = this.#search.getValue();
		if (value === before) {
			this.#requestRender();
		} else if (value.length < before.length) {
			this.#buildRows();
			this.#clampRowIndex();
			this.#requestRender();
		} else {
			this.#focus = "list";
			this.#buildRows();
			this.#rowIndex = 0;
			this.#listScroll = 0;
			this.#requestRender();
		}
	}

	#activateRow(rowDef: ListRow | undefined): void {
		if (!rowDef) return;
		if (rowDef.kind === "new") {
			this.#beginCreateFlow();
			return;
		}
		this.#openAgentStrip(rowDef.agent);
	}

	#handleStripInput(data: string): void {
		const strip = this.#strip;
		if (!strip) return;
		if (matchesSelectCancel(data)) {
			this.#stripBack(strip);
			return;
		}
		if (strip.kind === "pattern") {
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				this.#submitPattern();
				return;
			}
			strip.input.handleInput(data);
			return;
		}
		if (moveStripSelection(strip, data)) return;
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#activateStripChip();
			return;
		}
	}

	/** Esc on a strip: a property strip steps back up to the agent strip, the agent strip closes. */
	#stripBack(strip: StripState): void {
		if (strip.kind === "chips" && strip.property) {
			this.#openAgentStrip(strip.agent);
			return;
		}
		if (strip.kind === "pattern") {
			this.#openPropertyStrip(strip.agent, strip.property);
			return;
		}
		this.#closeStrip();
	}

	#handleCreateInput(data: string): void {
		if (this.#createSpec) {
			if (matchesSelectCancel(data)) {
				this.#clearCreateFlow();
				return;
			}
			if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
				this.#createScope = this.#createScope === "project" ? "user" : "project";
				return;
			}
			if (data.toLowerCase() === "r") {
				void this.#generateAgentFromDescription(this.#createDescription);
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				void this.#saveGeneratedAgent().catch(error => {
					this.#createError = error instanceof Error ? error.message : String(error);
					this.#requestRender();
				});
			}
			return;
		}
		if (matchesSelectCancel(data)) {
			if (!this.#createGenerating) this.#clearCreateFlow();
			return;
		}
		if (this.#createGenerating) return;
		if (matchesAppFollowUp(data)) {
			void this.#generateAgentFromDescription(this.#createInput?.getExpandedText() ?? this.#createDescription);
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#createScope = this.#createScope === "project" ? "user" : "project";
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#createInput?.handleInput("\n");
			this.#createDescription = this.#createInput?.getExpandedText() ?? "";
			return;
		}
		this.#createInput?.handleInput(data);
		this.#createDescription = this.#createInput?.getExpandedText() ?? "";
	}

	#moveSidebar(delta: number): void {
		const count = this.#entries.length;
		if (count === 0) return;
		let index = this.#entries.findIndex(entry => entry.id === this.#activeEntryId);
		if (index < 0) index = 0;
		for (let step = 0; step < count; step++) {
			index = (index + delta + count) % count;
			const entry = this.#entries[index];
			if (entry && entry.kind !== "separator") {
				this.#activeEntryId = entry.id;
				if (entry.kind !== "new") {
					this.#buildRows();
					this.#rowIndex = 0;
					this.#listScroll = 0;
				}
				return;
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Mouse
	// ═══════════════════════════════════════════════════════════════════════

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		const { footerColumn, bodyHeight, contentLine, overSidebar, overBody, bodyLine } = this.#frame.locate(
			event.row,
			event.col,
		);

		if (footerColumn !== undefined && this.#strip?.kind === "chips") {
			const strip = this.#strip;
			if (event.leftClick && this.#frame.selectChipAt(strip, footerColumn)) {
				this.#activateStripChip();
			}
			return true;
		}

		if (this.#assigning) {
			if (overBody) this.#browser.routeMouse(event, bodyLine);
			return true;
		}
		if (this.#createActive || this.#strip) return true;

		if (event.wheel !== null) {
			if (overSidebar) {
				this.#frame.scrollSidebar(event.wheel, bodyHeight, this.#entries.length);
			} else if (overBody) {
				this.#rowIndex = Math.max(0, Math.min(this.#rows.length - 1, this.#rowIndex + event.wheel));
			}
			return true;
		}

		if (event.motion) {
			// Hover is stored as an absolute row index so paint and click agree.
			const hoverRow = bodyLine - this.#listRowStart + this.#listScroll;
			this.#rowHover = overBody && hoverRow >= 0 && hoverRow < this.#rows.length ? hoverRow : null;
			return true;
		}

		if (!event.leftClick) return true;

		if (overSidebar) {
			const index = this.#frame.sidebarScroll + contentLine;
			const clicked = this.#entries[index];
			if (clicked && clicked.kind !== "separator") {
				if (clicked.kind === "new") {
					this.#beginCreateFlow();
				} else {
					this.#activeEntryId = clicked.id;
					this.#buildRows();
					this.#rowIndex = 0;
					this.#focus = "scope";
				}
			}
			return true;
		}
		if (overBody) {
			this.#focus = "list";
			const listLine = bodyLine - this.#listRowStart + this.#listScroll;
			if (listLine >= 0 && listLine < this.#rows.length) {
				if (listLine === this.#rowIndex) {
					this.#activateRow(this.#rows[listLine]);
				} else {
					this.#rowIndex = listLine;
				}
			}
		}
		return true;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Rendering
	// ═══════════════════════════════════════════════════════════════════════

	#terminalRows(): number {
		return Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
	}

	#sidebarStyle = (entry: SidebarEntry): SidebarStyle => {
		const icon = entry.kind === "all" ? theme.icon.model : entry.kind === "new" ? "+" : theme.status.enabled;
		return {
			icon: theme.fg(entry.kind === "new" ? "dim" : "accent", icon),
			annotation: theme.fg("dim", entry.annotation ?? ""),
		};
	};

	#statusRow(width: number): string {
		if (this.#loadError) return truncateToWidth(theme.fg("error", ` ${this.#loadError}`), width);
		if (this.#assigning) {
			const { agent, property } = this.#assigning;
			const what = property === "model" ? "model override" : `${property} model`;
			return truncateToWidth(
				theme.fg(
					"accent",
					` Picking ${what} for ${theme.bold(agent.name)} — ${formatKeyHint("enter")} assigns, ${editorKey("tui.select.cancel")} cancels`,
				),
				width,
			);
		}
		if (this.#createActive) {
			return truncateToWidth(theme.fg("accent", " New agent — describe it and let the architect draft it"), width);
		}
		if (this.#notice) return truncateToWidth(theme.fg("success", ` ${this.#notice}`), width);
		const entry = this.#activeEntry();
		const scopeLabel = entry.kind === "source" ? `${entry.label} agents` : "All agents";
		const count = this.#rows.filter(rowDef => rowDef.kind === "agent").length;
		return truncateToWidth(theme.fg("muted", ` ${scopeLabel} · ${count}`), width);
	}

	#renderList(width: number, rows: number): string[] {
		const lines: string[] = [];
		const query = this.#search.getValue();
		const searchText = query
			? theme.fg("accent", this.#search.render(visibleWidth(query) + 1)[0] ?? "")
			: theme.fg("dim", "type to filter");
		lines.push(truncateToWidth(` ${theme.fg("muted", "search:")} ${searchText}`, width));
		lines.push("");
		this.#listRowStart = lines.length;

		const detailRows = 4;
		const visibleRows = Math.max(3, rows - lines.length - detailRows);
		if (this.#rowIndex < this.#listScroll) this.#listScroll = this.#rowIndex;
		else if (this.#rowIndex >= this.#listScroll + visibleRows) this.#listScroll = this.#rowIndex - visibleRows + 1;
		this.#listScroll = Math.max(0, Math.min(this.#listScroll, Math.max(0, this.#rows.length - visibleRows)));

		let nameWidth = 0;
		for (const rowDef of this.#rows) {
			if (rowDef.kind === "agent") nameWidth = Math.max(nameWidth, visibleWidth(rowDef.agent.name));
		}

		const listFocused = this.#focus === "list";
		for (let i = this.#listScroll; i < Math.min(this.#rows.length, this.#listScroll + visibleRows); i++) {
			const rowDef = this.#rows[i];
			if (!rowDef) continue;
			const selected = i === this.#rowIndex;
			const hovered = i === this.#rowHover;
			const cursor = selected && listFocused ? theme.fg("accent", theme.nav.cursor) : " ";
			if (rowDef.kind === "new") {
				let line = ` ${cursor} ${theme.fg(selected ? "accent" : "dim", "+ New agent…")}`;
				if (hovered) line = theme.bg("selectedBg", line);
				lines.push(truncateToWidth(line, width));
				continue;
			}
			const agent = rowDef.agent;
			const dot = agent.disabled
				? theme.fg("dim", theme.status.disabled)
				: theme.fg("success", theme.status.enabled);
			const name = replaceTabs(agent.name).padEnd(nameWidth);
			const nameStyled = agent.disabled
				? theme.fg("dim", name)
				: selected
					? theme.bold(theme.fg("accent", name))
					: name;
			const badges: string[] = [];
			if (agent.overrideModel) badges.push(theme.fg("warning", agent.overrideModel));
			const prewalk = this.#deps.effectivePrewalkPattern(agent);
			if (prewalk) badges.push(theme.fg("dim", `pre:${prewalk}`));
			const advisor = this.#deps.effectiveAdvisorPattern(agent);
			if (advisor) badges.push(theme.fg("dim", `adv:${advisor}`));
			const sourceTag = theme.fg("dim", SOURCE_LABEL[agent.source].toLowerCase());
			let line = ` ${cursor} ${dot} ${nameStyled}  ${sourceTag}`;
			const right = badges.join("  ");
			const rightWidth = visibleWidth(right);
			const lineWidth = visibleWidth(line);
			if (rightWidth > 0 && lineWidth + rightWidth + 2 <= width) {
				line = `${line}${" ".repeat(width - lineWidth - rightWidth - 1)}${right}`;
			}
			line = truncateToWidth(line, width);
			if (hovered) {
				const w = visibleWidth(line);
				if (w < width) line += " ".repeat(width - w);
				line = theme.bg("selectedBg", line);
			}
			lines.push(line);
		}

		// Selected-agent detail block pinned to the bottom of the body pane.
		while (lines.length < rows - detailRows) lines.push("");
		const agent = this.#selectedAgent();
		lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));
		if (agent) {
			lines.push(truncateToWidth(` ${theme.fg("dim", replaceTabs(agent.description))}`, width));
			const patterns = this.#deps.effectiveModelPatterns(agent);
			const resolved = this.#deps.resolvePatterns(patterns);
			const modelLine = `${theme.fg("muted", "model:")} ${patterns.length > 0 ? replaceTabs(patterns.join(",")) : theme.fg("dim", "(session model)")}${resolved ? ` ${theme.fg("dim", "→")} ${theme.fg("success", resolved)}` : ""}`;
			lines.push(truncateToWidth(` ${modelLine}`, width));
			const prewalk = this.#deps.effectivePrewalkPattern(agent);
			const advisor = this.#deps.effectiveAdvisorPattern(agent);
			const flagLine = [
				`${theme.fg("muted", "prewalk:")} ${prewalk ? theme.fg("success", prewalk) : theme.fg("dim", "off")}`,
				`${theme.fg("muted", "advisor:")} ${advisor ? theme.fg("success", advisor) : theme.fg("dim", "off")}`,
				agent.filePath ? theme.fg("dim", shortenPath(agent.filePath)) : "",
			]
				.filter(Boolean)
				.join("   ");
			lines.push(truncateToWidth(` ${flagLine}`, width));
		} else {
			lines.push(theme.fg("dim", " Select an agent to inspect"));
			lines.push("");
			lines.push("");
		}
		return lines.slice(0, rows);
	}

	#renderCreate(width: number, rows: number): string[] {
		const lines: string[] = [];
		lines.push("");
		if (this.#createSpec) {
			const spec = this.#createSpec;
			lines.push(truncateToWidth(theme.bold(theme.fg("accent", " Review generated agent")), width));
			lines.push("");
			lines.push(truncateToWidth(theme.fg("muted", ` Identifier: ${spec.identifier}`), width));
			lines.push(truncateToWidth(theme.fg("muted", ` Scope: ${this.#createScope}`), width));
			lines.push("");
			lines.push(theme.fg("muted", " whenToUse:"));
			for (const line of wrapTextWithAnsi(replaceTabs(spec.whenToUse), Math.max(20, width - 2)).slice(0, 6)) {
				lines.push(truncateToWidth(` ${line}`, width));
			}
			lines.push("");
			lines.push(theme.fg("muted", " systemPrompt preview:"));
			const promptWidth = Math.max(20, width - 4);
			const wrapped: string[] = [];
			for (const raw of spec.systemPrompt.split("\n")) {
				for (const w of wrapTextWithAnsi(replaceTabs(raw), promptWidth)) wrapped.push(w);
			}
			const budget = Math.max(3, rows - lines.length - 3);
			for (const line of wrapped.slice(0, budget)) {
				lines.push(truncateToWidth(`   ${theme.fg("dim", line)}`, width));
			}
			if (wrapped.length > budget) {
				lines.push(theme.fg("dim", `   … ${wrapped.length - budget} more lines`));
			}
		} else {
			lines.push(truncateToWidth(theme.bold(theme.fg("accent", " Create new agent")), width));
			lines.push("");
			lines.push(
				truncateToWidth(
					theme.fg("muted", " Describe what the agent should do; scope: ") + theme.fg("accent", this.#createScope),
					width,
				),
			);
			lines.push("");
			if (this.#createInput && !this.#createGenerating) {
				for (const line of this.#createInput.render(Math.max(20, width - 2))) {
					lines.push(truncateToWidth(line, width));
				}
			}
			if (this.#createGenerating) {
				lines.push(theme.fg("muted", " Generating…"));
				lines.push("");
				const contentWidth = Math.max(20, width - 4);
				const wrapped: string[] = [];
				for (const raw of this.#createStreamingText.split("\n")) {
					for (const w of wrapTextWithAnsi(replaceTabs(raw), contentWidth)) wrapped.push(w);
				}
				const budget = Math.max(3, rows - lines.length - 2);
				for (const line of wrapped.slice(-budget)) {
					lines.push(truncateToWidth(`  ${theme.fg("dim", line)}`, width));
				}
			}
		}
		if (this.#createError) {
			lines.push("");
			lines.push(truncateToWidth(theme.fg("error", ` ${replaceTabs(this.#createError)}`), width));
		}
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	#footerHint(): string {
		const enter = formatKeyHint("enter");
		const cancel = editorKey("tui.select.cancel");
		const upDown = editorKeys("tui.select.up", "tui.select.down");
		if (this.#strip) {
			if (this.#strip.kind === "pattern") {
				const property = this.#strip.property;
				const values = property === "model" ? "a model pattern" : '"on", "off", or a model pattern';
				return `Enter ${values} (role aliases like @smol and :level suffixes work; empty clears) · ${cancel} back`;
			}
			const choose = formatKeyHints(["left", "right"]);
			return this.#strip.property
				? `${choose} choose · ${enter} apply · ${cancel} back`
				: `${choose} choose · ${enter} open · ${cancel} cancel`;
		}
		if (this.#assigning) {
			return `${enter} pick · ${upDown} models · type to search · ${cancel} cancel`;
		}
		if (this.#createActive) {
			const tab = formatKeyHint("tab");
			if (this.#createSpec)
				return `${enter} save · ${tab} scope · ${formatKeyHint("r")} regenerate · ${cancel} cancel`;
			if (this.#createGenerating) return "Generating…";
			const generate = formatKeyHints(boundKeys("app.message.followUp", ["ctrl+q", "ctrl+enter"]));
			return `${generate} generate · ${enter} newline · ${tab} scope · ${cancel} cancel`;
		}
		if (this.#focus === "scope") {
			return `${upDown} scopes · ${formatKeyHints(["right", "enter"])} agents · ${cancel} close`;
		}
		return `${enter} configure · ${formatKeyHint("space")} enable/disable · ${upDown} rows · type to search · ${formatKeyHint("ctrl+r")} reload · ${cancel} close`;
	}

	#renderFooter(width: number): string {
		const strip = this.#strip;
		return this.#frame.renderFooter(
			width,
			this.#footerHint(),
			strip ? () => this.#renderStrip(width, strip) : undefined,
		);
	}

	#renderStrip(width: number, strip: StripState): string {
		if (strip.kind === "pattern") {
			const label = theme.fg("accent", `${strip.agent.name} ${strip.property} pattern:`);
			const labelWidth = visibleWidth(`${strip.agent.name} ${strip.property} pattern:`);
			const inputWidth = Math.max(8, Math.min(40, width - labelWidth - 4));
			const inputLine = strip.input.render(inputWidth)[0] ?? "";
			return truncateToWidth(`${label} ${inputLine}`, width);
		}
		const prefix = strip.property
			? `${theme.fg("accent", strip.agent.name)}${theme.fg("dim", ` · ${strip.property} →`)} `
			: `${theme.fg("accent", strip.agent.name)}${theme.fg("dim", " →")} `;
		return this.#frame.renderChips(width, prefix, strip);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Native (TSP) description
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * The agent list (and its chip strips) is a `picker` sheet. The pattern
	 * input, the model browser and the create wizard stay the generic overlay.
	 */
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("picker") && !this.#createActive && !this.#assigning && this.#strip?.kind !== "pattern";
	}

	describe(cx: DescribeContext): NativeNode {
		const sheet = this.nativeSheet(cx);
		const cached = this.#nativeCache;
		if (cached?.version === this.#nativeVersion && cached.sheet === sheet) return cached.node;
		if (sheet) {
			const described = this.#describePicker();
			this.#nativeCache = { version: this.#nativeVersion, sheet, node: described };
			return described;
		}
		const footer: NativeChild[] = [];
		const strip = this.#describeStrip();
		if (strip) footer.push(strip);
		footer.push(hintsRow(this.#footerHints()));
		const described = describeHubFrame(
			"omp.hub.agents",
			"Agents",
			describeHubSidebar(this.#entries, this.#activeEntryId, this.#sidebarStyle, "scopes"),
			this.#describeBody(),
			node("col", { gap: "xs" }, footer, "footer"),
		);
		this.#nativeCache = { version: this.#nativeVersion, sheet, node: described };
		return described;
	}

	handleNativeEvent(event: NativeUiEvent): void {
		const target = event.key.slice(event.key.lastIndexOf("/") + 1);
		const pick = pickerEvent(event);
		if (pick) {
			this.#handlePickerEvent(pick);
			this.#requestRender();
			return;
		}
		if (event.type === "toggle") {
			if (target !== "prompt") return;
			this.#promptCollapsed = event.collapsed;
		} else if (event.type === "select" || event.type === "activate") {
			const activate = event.type === "activate";
			if (target === "strip") {
				const strip = this.#strip;
				const index = Number(event.item);
				if (strip?.kind !== "chips" || !Number.isInteger(index) || !strip.chips[index]) return;
				strip.index = index;
				if (activate) this.#activateStripChip();
			} else if (target === "agents") {
				// Like the mouse path: the list is inert under a strip, the create flow, or the model browser.
				if (this.#strip || this.#createActive || this.#assigning) return;
				const index = this.#rows.findIndex(rowDef => listRowId(rowDef) === event.item);
				if (index < 0) return;
				this.#focus = "list";
				this.#rowIndex = index;
				if (activate) this.#activateRow(this.#rows[index]);
			} else if (target === "scopes") {
				if (this.#strip || this.#createActive || this.#assigning) return;
				const entry = this.#entries.find(candidate => candidate.id === event.item);
				if (!entry || entry.kind === "separator") return;
				if (entry.kind === "new") {
					this.#beginCreateFlow();
				} else {
					this.#activeEntryId = entry.id;
					this.#buildRows();
					this.#rowIndex = 0;
					this.#listScroll = 0;
					this.#focus = activate ? "list" : "scope";
				}
			} else {
				return;
			}
		} else {
			return;
		}
		this.#requestRender();
	}

	/** Picker pointer events: each runs the path of the key it stands for. */
	#handlePickerEvent(pick: PickerEvent): void {
		const strip = this.#strip;
		if (pick.kind !== "action") {
			if (strip) return; // the list is inert under a strip, like the mouse path
			const index = this.#rows.findIndex(rowDef => listRowId(rowDef) === pick.item);
			if (index < 0) return;
			this.#focus = "list";
			this.#rowIndex = index;
			if (pick.kind === "activate") this.#activateRow(this.#rows[index]);
			return;
		}
		if (pick.act === "close") {
			this.#callbacks.onCancel();
			return;
		}
		if (strip?.kind === "chips") {
			if (pick.act === "strip") {
				const index = Number(pick.value);
				if (!Number.isInteger(index) || !strip.chips[index]) return;
				strip.index = index;
				this.#activateStripChip();
			} else if (pick.act === "apply") {
				this.#activateStripChip();
			} else if (pick.act === "back") {
				this.#stripBack(strip);
			}
			return;
		}
		const agent = this.#selectedAgent();
		switch (pick.act) {
			case "scope": {
				const entry = this.#entries.find(candidate => candidate.id === pick.value);
				if (!entry || entry.kind === "separator" || entry.kind === "new") return;
				this.#activeEntryId = entry.id;
				this.#buildRows();
				this.#rowIndex = 0;
				this.#listScroll = 0;
				this.#focus = "scope";
				return;
			}
			case "configure":
				this.#activateRow(this.#rows[this.#rowIndex]);
				return;
			case "toggle":
				if (agent) this.#toggleAgent(agent);
				return;
			case "model":
				if (agent) this.#openPropertyStrip(agent, "model");
				return;
			case "new":
				this.#beginCreateFlow();
				return;
			case "reload":
				void this.#reload();
				return;
		}
	}

	/** The config hub as a `picker` (§9.1): source scopes, override columns, prompt preview. */
	#describePicker(): NativeNode {
		const counts: Record<AgentSource, number> = { project: 0, user: 0, bundled: 0 };
		for (const agent of this.#allAgents) counts[agent.source]++;
		const scopes: TspPickerScope[] = [
			{ id: "all", label: "All agents", icon: "users", count: this.#allAgents.length },
			...SOURCES.map((source): TspPickerScope => ({
				id: `source:${source}`,
				label: SOURCE_LABEL[source],
				icon: source === "project" ? "folder" : source === "user" ? "user" : "box",
				count: counts[source],
				group: "Source",
				disabled: counts[source] === 0 ? `No ${source} agents` : undefined,
			})),
		];
		const entry = this.#activeEntry();
		const strip = this.#strip?.kind === "chips" ? this.#strip : null;
		const agent = this.#selectedAgent();
		let actions: TspPickerAction[];
		if (strip) {
			actions = [
				{ id: "apply", label: strip.property ? "Apply" : "Open", keys: ["enter"], primary: true },
				{ id: "back", label: strip.property ? "Back" : "Cancel", keys: ["esc"], end: true },
			];
		} else {
			const noAgent = agent ? undefined : "Select an agent";
			actions = [
				{ id: "configure", label: agent ? "Configure" : "Create", keys: ["enter"], primary: true },
				{
					id: "toggle",
					label: "Toggle",
					keys: ["space"],
					on: agent ? !agent.disabled : undefined,
					disabled: noAgent,
				},
				{ id: "model", label: "Model", disabled: noAgent },
				{ id: "new", label: "New agent" },
				{ id: "reload", label: "Reload", keys: ["ctrl", "r"] },
				CLOSE_ACTION,
			];
		}
		const selectedRow = this.#rows[this.#rowIndex];
		return picker(
			{
				title: "Agents",
				subtitle: this.#notice ?? undefined,
				icon: "users",
				noun: "agents",
				size: "lg",
				layout: "rows",
				preview: "side",
				...pickerQuery(this.#search),
				placeholder: "Search agents…",
				scopes,
				scope: entry.kind === "source" ? entry.id : "all",
				columns: entry.kind === "source" ? AGENT_COLUMNS : [...AGENT_COLUMNS, SOURCE_COLUMN],
				items: this.#rows.map(rowDef => this.#pickerItem(rowDef)),
				selected: selectedRow ? listRowId(selectedRow) : null,
				total: entry.kind === "source" && entry.source ? counts[entry.source] : this.#allAgents.length,
				state: this.#loadError ? "error" : "ready",
				message: this.#loadError ?? undefined,
				strip: strip
					? {
							label: strip.property ? `${strip.agent.name} · ${strip.property}` : strip.agent.name,
							items: strip.chips.map((chip, index) => ({
								id: String(index),
								label: this.#stripChipLabel(strip.agent, chip),
								on: this.#stripChipOn(strip.agent, strip.property, chip),
							})),
							selected: String(strip.index),
						}
					: null,
				actions,
				focus: strip ? "strip" : this.#focus === "scope" ? "scopes" : "list",
			},
			this.#describePreview(selectedRow),
		);
	}

	#pickerItem(rowDef: ListRow): TspPickerItem {
		if (rowDef.kind === "new") {
			return { id: listRowId(rowDef), label: "New agent…", icon: "plus", tone: "muted" };
		}
		const agent = rowDef.agent;
		const prewalk = this.#deps.effectivePrewalkPattern(agent);
		const advisor = this.#deps.effectiveAdvisorPattern(agent);
		return {
			id: listRowId(rowDef),
			label: agent.name,
			mono: true,
			detail: sanitizeDisplaySingleLine(agent.description),
			dot: agent.disabled ? "muted" : "success",
			disabled: agent.disabled ? "Disabled · space to enable" : undefined,
			facts: {
				model: agent.overrideModel ? agent.overrideModel : [span("auto", "dim")],
				prewalk: prewalk ?? [span("off", "dim")],
				advisor: advisor ?? [span("off", "dim")],
				source: SOURCE_LABEL[agent.source],
			},
		};
	}

	/** Chip text of a configuration strip, without the ANSI state glyphs (the chip's `on` carries state). */
	#stripChipLabel(agent: HubAgent, chip: StripChip): string {
		const action = chip.action;
		if (action.kind === "toggle") return agent.disabled ? "Enable" : "Disable";
		if (action.kind === "property") return `${action.property}: ${this.#propertySummary(agent, action.property)}`;
		return chip.label;
	}

	#stripChipOn(agent: HubAgent, property: PropertyKind | undefined, chip: StripChip): boolean | undefined {
		const action = chip.action;
		if (action.kind !== "set" || action.property === "model" || !property) return undefined;
		return this.#overrideFor(agent, property)?.toLowerCase() === action.value;
	}

	/** Preview of the selected agent: description, effective settings, system prompt. */
	#describePreview(rowDef: ListRow | undefined): NativeChild[] {
		if (!rowDef) return [];
		if (rowDef.kind === "new") {
			return [
				text("New agent", { role: "omp.picker.title" }),
				md(
					"Describe what the agent should do; the architect drafts its name, when to use it and its system prompt.",
				),
			];
		}
		const agent = rowDef.agent;
		const patterns = this.#deps.effectiveModelPatterns(agent);
		const resolved = this.#deps.resolvePatterns(patterns);
		const model: TspSpan[] = [patterns.length > 0 ? span(patterns.join(","), "mono") : span("session model", "dim")];
		if (resolved) model.push(span(" → ", "dim"), span(resolved, "mono success"));
		const prewalk = this.#deps.effectivePrewalkPattern(agent);
		const advisor = this.#deps.effectiveAdvisorPattern(agent);
		const facts: { k: string; v: TspSpan[] | string }[] = [
			{ k: "Model", v: model },
			{ k: "Prewalk", v: [prewalk ? span(prewalk, "mono") : span("off", "dim")] },
			{ k: "Advisor", v: [advisor ? span(advisor, "mono") : span("off", "dim")] },
			{ k: "Status", v: [agent.disabled ? span("Disabled", "warning") : span("Enabled", "success")] },
			{ k: "Source", v: SOURCE_LABEL[agent.source] },
		];
		if (agent.filePath) {
			// Bundled agents live in the binary (`embedded:…`): nothing to open.
			const href = agent.filePath.startsWith("/") ? { href: `file://${agent.filePath}` } : undefined;
			facts.push({ k: "File", v: [span(shortenPath(agent.filePath), "path", href)] });
		}
		const out: NativeChild[] = [
			node("text", { text: agent.name, role: "omp.picker.title" }, undefined, "title"),
			node("md", { text: agent.description }, undefined, "description"),
			node("kv", { items: facts, layout: "grid" }, undefined, "facts"),
		];
		if (agent.systemPrompt.trim()) {
			out.push(
				node(
					"section",
					{ head: "System prompt", role: "omp.agents.prompt" },
					[code(agent.systemPrompt, { lang: "md", wrap: true })],
					"prompt",
				),
			);
		}
		return out;
	}

	#describeBody(): NativeNode {
		const children: NativeChild[] = [
			node("text", { spans: this.#statusSpans(), truncate: "end" }, undefined, "status"),
		];
		if (this.#createActive) {
			children.push(...this.#describeCreate());
		} else if (this.#assigning) {
			this.#browser.setFocused(true);
			children.push(this.#browser);
		} else {
			children.push(...this.#describeList());
		}
		return node("col", { gap: "sm", grow: 1 }, children, "body");
	}

	#statusSpans(): TspSpan[] {
		if (this.#loadError) return [span(this.#loadError, "error")];
		if (this.#assigning) {
			const { agent, property } = this.#assigning;
			const what = property === "model" ? "model override" : `${property} model`;
			return [span(`Picking ${what} for `, "accent"), span(agent.name, "accent strong")];
		}
		if (this.#createActive) return [span("New agent — describe it and let the architect draft it", "accent")];
		if (this.#notice) return [span(this.#notice, "success")];
		const entry = this.#activeEntry();
		const scopeLabel = entry.kind === "source" ? `${entry.label} agents` : "All agents";
		const count = this.#rows.filter(rowDef => rowDef.kind === "agent").length;
		return [span(`${scopeLabel} · ${count}`, "muted")];
	}

	#describeList(): NativeNode[] {
		const search = node(
			"text",
			{
				spans: [
					span("search: ", "muted"),
					this.#search.getValue() ? span(this.#search.getValue(), "accent") : span("type to filter", "dim"),
				],
				truncate: "end",
			},
			undefined,
			"search",
		);
		const items = this.#rows.map(rowDef =>
			rowDef.kind === "new"
				? node("item", { label: [span("+ New agent…", "dim")] }, undefined, listRowId(rowDef))
				: this.#describeAgentItem(rowDef.agent),
		);
		const selectedRow = this.#rows[this.#rowIndex];
		const list = node(
			"list",
			{
				selected: selectedRow ? listRowId(selectedRow) : null,
				filter: this.#search.getValue() || undefined,
				virtual: true,
				grow: 1,
				tone: this.#focus === "list" ? "accent" : undefined,
				aria: "Agents",
			},
			items,
			"agents",
		);
		return [search, list, this.#describeDetail()];
	}

	#describeAgentItem(agent: HubAgent): NativeNode {
		const value: TspSpan[] = [];
		const badge = (t: string, s: string): void => {
			if (value.length > 0) value.push(span("  "));
			value.push(span(t, s));
		};
		if (agent.overrideModel) badge(agent.overrideModel, "warning");
		const prewalk = this.#deps.effectivePrewalkPattern(agent);
		if (prewalk) badge(`pre:${prewalk}`, "dim");
		const advisor = this.#deps.effectiveAdvisorPattern(agent);
		if (advisor) badge(`adv:${advisor}`, "dim");
		return node(
			"item",
			{
				label: [
					agent.disabled ? span(`${theme.status.disabled} `, "dim") : span(`${theme.status.enabled} `, "success"),
					span(agent.name, agent.disabled ? "dim" : "strong"),
				],
				detail: [span(SOURCE_LABEL[agent.source].toLowerCase(), "dim")],
				value: value.length > 0 ? value : undefined,
				tone: agent.disabled ? "muted" : undefined,
			},
			undefined,
			listRowId({ kind: "agent", agent }),
		);
	}

	/** Selected-agent detail block under the list. */
	#describeDetail(): NativeNode {
		const agent = this.#selectedAgent();
		if (!agent) {
			return node("section", {}, [text([span("Select an agent to inspect", "dim")])], "detail");
		}
		const patterns = this.#deps.effectiveModelPatterns(agent);
		const resolved = this.#deps.resolvePatterns(patterns);
		const model: TspSpan[] = [patterns.length > 0 ? span(patterns.join(",")) : span("(session model)", "dim")];
		if (resolved) model.push(span(" → ", "dim"), span(resolved, "success"));
		const prewalk = this.#deps.effectivePrewalkPattern(agent);
		const advisor = this.#deps.effectiveAdvisorPattern(agent);
		const children: NativeChild[] = [
			text([span(agent.description, "dim")], { wrap: "word", lines: 2 }),
			node("kv", {
				items: [
					{ k: [span("model", "muted")], v: model },
					{ k: [span("prewalk", "muted")], v: [prewalk ? span(prewalk, "success") : span("off", "dim")] },
					{ k: [span("advisor", "muted")], v: [advisor ? span(advisor, "success") : span("off", "dim")] },
				],
				layout: "inline",
			}),
		];
		if (agent.filePath) children.push(text([span(shortenPath(agent.filePath), "path dim")], { truncate: "middle" }));
		return node("section", { head: [span(agent.name, "accent strong")] }, children, "detail");
	}

	#describeCreate(): NativeChild[] {
		const nodes: NativeChild[] = [];
		const spec = this.#createSpec;
		if (spec) {
			nodes.push(
				text([span("Review generated agent", "accent strong")]),
				node("kv", {
					items: [
						{ k: [span("Identifier", "muted")], v: [span(spec.identifier, "code")] },
						{ k: [span("Scope", "muted")], v: [span(this.#createScope, "accent")] },
					],
				}),
				node("section", { head: [span("whenToUse", "muted")] }, [text(spec.whenToUse, { wrap: "word", lines: 6 })]),
				node(
					"card",
					{
						head: [span("System prompt", "muted")],
						collapsible: true,
						collapsed: this.#promptCollapsed,
						preview: { lines: 8 },
					},
					[md(spec.systemPrompt)],
					"prompt",
				),
			);
		} else {
			nodes.push(
				text([span("Create new agent", "accent strong")]),
				text([span("Describe what the agent should do; scope: ", "muted"), span(this.#createScope, "accent")], {
					wrap: "word",
				}),
			);
			if (this.#createInput && !this.#createGenerating) {
				nodes.push(this.#createInput);
			}
			if (this.#createGenerating) {
				nodes.push(node("spinner", { label: "Generating…" }, undefined, "generating"));
				if (this.#createStreamingText) {
					nodes.push(
						node("code", { text: this.#createStreamingText, lang: "json", wrap: true }, undefined, "stream"),
					);
				}
			}
		}
		if (this.#createError) {
			nodes.push(node("text", { text: this.#createError, tone: "error", wrap: "word" }, undefined, "error"));
		}
		return nodes;
	}

	/** Styled spans of one footer chip, from its action rather than its ANSI label. */
	#chipSpans(agent: HubAgent, property: PropertyKind | undefined, chip: StripChip): TspSpan[] {
		const action = chip.action;
		switch (action.kind) {
			case "toggle":
				return chip.label === "enable"
					? [span(`${theme.status.enabled} enable`, "success")]
					: [span(`${theme.status.disabled} disable`, "dim")];
			case "property":
				return [span(action.property, "accent"), span(`: ${this.#propertySummary(agent, action.property)}`, "dim")];
			case "set": {
				if (action.property === "model") return [span(chip.label, "warning")];
				const current = property ? this.#overrideFor(agent, property)?.toLowerCase() : undefined;
				return current === action.value
					? [span(`${theme.status.enabled} ${chip.label}`, "accent")]
					: [span(chip.label, "muted")];
			}
			case "pick":
				return [span(chip.label, "accent")];
			case "pattern":
				return [span(chip.label, "muted")];
		}
	}

	#describeStrip(): NativeNode | undefined {
		const strip = this.#strip;
		if (!strip) return undefined;
		if (strip.kind === "pattern") {
			return node(
				"row",
				{ gap: "sm", align: "center" },
				[text([span(`${strip.agent.name} ${strip.property} pattern:`, "accent")]), col([strip.input], { grow: 1 })],
				"pattern",
			);
		}
		const prefix: TspSpan[] = strip.property
			? [span(strip.agent.name, "accent"), span(` · ${strip.property} →`, "dim")]
			: [span(strip.agent.name, "accent"), span(" →", "dim")];
		return row(
			[
				text(prefix),
				node(
					"tabs",
					{
						items: strip.chips.map((chip, index) => ({
							id: String(index),
							label: this.#chipSpans(strip.agent, strip.property, chip),
						})),
						active: String(strip.index),
						actions: { click: "activate" },
					},
					undefined,
					"strip",
				),
			],
			{ gap: "sm", align: "center" },
		);
	}

	#footerHints(): (NativeHint | undefined)[] {
		const cancel = (label: string) => actionHint("tui.select.cancel", label);
		const upDown = (label: string) => actionHint(["tui.select.up", "tui.select.down"], label);
		const strip = this.#strip;
		if (strip) {
			if (strip.kind === "pattern") {
				const values = strip.property === "model" ? "a model pattern" : '"on", "off", or a model pattern';
				return [
					{ keys: ["enter"], label: `${values} (role aliases like @smol and :level suffixes work; empty clears)` },
					cancel("back"),
				];
			}
			return [
				{ keys: ["left", "right"], label: "choose" },
				{ keys: ["enter"], label: strip.property ? "apply" : "open" },
				cancel(strip.property ? "back" : "cancel"),
			];
		}
		if (this.#assigning) {
			return [
				{ keys: ["enter"], label: "pick" },
				upDown("models"),
				{ keys: [], label: "type to search" },
				cancel("cancel"),
			];
		}
		if (this.#createActive) {
			if (this.#createSpec) {
				return [
					{ keys: ["enter"], label: "save" },
					{ keys: ["tab"], label: "scope" },
					{ keys: ["r"], label: "regenerate" },
					cancel("cancel"),
				];
			}
			if (this.#createGenerating) return [];
			return [
				{ keys: boundKeys("app.message.followUp", ["ctrl+q", "ctrl+enter"]), label: "generate" },
				{ keys: ["enter"], label: "newline" },
				{ keys: ["tab"], label: "scope" },
				cancel("cancel"),
			];
		}
		if (this.#focus === "scope") {
			return [upDown("scopes"), { keys: ["right", "enter"], label: "agents" }, cancel("close")];
		}
		return [
			{ keys: ["enter"], label: "configure" },
			{ keys: ["space"], label: "enable/disable" },
			upDown("rows"),
			{ keys: [], label: "type to search" },
			{ keys: ["ctrl+r"], label: "reload" },
			cancel("close"),
		];
	}

	render(width: number): readonly string[] {
		return this.#frame.render(width, this.#terminalRows(), this.#entries, this.#renderFooter(width - 4));
	}
}
