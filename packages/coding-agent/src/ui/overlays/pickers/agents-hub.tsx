/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The /agents hub: every agent definition (project, user, bundled) with its
 * per-agent settings, a scope sidebar, and an AI-drafted "New agent" flow.
 *
 * Natively the hub is a `picker` (source scopes, override columns, the
 * agent's prompt as preview; Enter opens a chip strip: enable/disable and the
 * model/prewalk/advisor knobs, each opening its value chips). The pattern
 * input, the model browser ("pick model…") and the create flow need a body
 * the picker has no slot for: then the hub is a card (`omp.hub.agents`):
 * the scope sidebar beside the body, a rule and the footer.
 *
 * The terminal draws the fullscreen hub frame for both (`omp.agents` look,
 * `src/ui/styles/pickers/agents-hub.ts`): sidebar, status row, the list with
 * the selected agent's summary pinned under it (or the browser / the create
 * flow), and the footer's hints or chip strip.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { computed, type JSXNode, type KeyEvent, signal, type UiEvent, untrack } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type {
	TspKvProps,
	TspPickerAction,
	TspPickerColumn,
	TspPickerItem,
	TspPickerProps,
	TspPickerScope,
	TspSpan,
} from "@oh-my-pi/pi-wire";
import { sanitizeDisplaySingleLine } from "../../../extensibility/inventory/display-text";
import {
	buildBrowserItems,
	type ModelBrowserItem,
	type ModelBrowserSource,
	sortModelItems,
} from "../../../modes/view-model/overlays/model-browser";
import type { AgentSource } from "../../../task/task-details";
import { FuzzyQuery } from "../../../utils/fuzzy";
import { shortenPath } from "../../../utils/render-utils";
import "../../styles/pickers/agents-hub";
import type {
	AgentsHubBody,
	AgentsHubFooter,
	AgentsHubTerm,
	AgentsListRow,
	AgentsSidebarEntry,
} from "../../styles/pickers/agents-hub";
import { span } from "./agent-hub-model";
import { ModelBrowser } from "./model-browser";
import { ModelBrowserState } from "./model-browser-state";
import { closeAction, pickerKeys } from "./select-sheet";
import { appFollowUpKeys, matchesAnyKey, matchesSelectCancel, selectKeyId } from "../../../config/keybindings/matchers";
import { bindingGlyph } from "../../styles/panels/common";
import { actionKeyId, cancelKbd, confirmKbd } from "../../keys/hints";

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

/** The per-agent knob a strip or the model browser edits. */
export type PropertyKind = "model" | "prewalk" | "advisor";

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
	/** Persist one agent's enabled state. */
	setAgentDisabled: (name: string, options: { disabled: boolean }) => void;
	/** Persist one agent's override for `property`; `undefined` clears it. */
	setAgentOverride: (property: PropertyKind, name: string, value: string | undefined) => void;
	generateAgent: (description: string, onText: (text: string) => void) => Promise<string>;
	saveAgent: (scope: "project" | "user", spec: GeneratedAgentSpec) => Promise<string>;
}

export interface AgentsHubProps {
	readonly deps: AgentsHubDeps;
	/** Terminal rows (the hub fills them). */
	readonly rows: () => number;
	readonly onCancel: () => void;
	/** Receives the hub's reload (the host awaits the first load before showing the hub). */
	readonly ref?: (hub: { reload(): Promise<void> }) => void;
}

const SOURCE_LABEL: Record<AgentSource, string> = { project: "Project", user: "User", bundled: "Bundled" };
const SOURCE_ORDER: Record<AgentSource, number> = { project: 0, user: 1, bundled: 2 };
const SOURCES: readonly AgentSource[] = ["project", "user", "bundled"];
const SOURCE_ICON: Record<AgentSource, string> = { project: "folder", user: "user", bundled: "box" };
const AGENT_COLUMNS: readonly TspPickerColumn[] = [
	{ id: "model", head: "Model", format: "text", priority: 4, min: 8 },
	{ id: "prewalk", head: "Prewalk", format: "text", priority: 2 },
	{ id: "advisor", head: "Advisor", format: "text", priority: 3 },
];
const SOURCE_COLUMN: TspPickerColumn = { id: "source", head: "Source", format: "dim", priority: 1 };
const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+){1,5}$/;
/** Keys that generate the drafted agent (the app's follow-up keys). */
const NEW_ROW = "new";
/** Summary rows pinned under the list. */
const DETAIL_ROWS = 4;

/** A body row: an agent or the trailing "+ New agent…". */
type ListRow = { kind: "agent"; agent: HubAgent } | { kind: "new" };

type StripAction =
	| { kind: "toggle" }
	| { kind: "property"; property: PropertyKind }
	| { kind: "set"; property: PropertyKind; value: string | undefined }
	| { kind: "pick"; property: PropertyKind }
	| { kind: "pattern"; property: PropertyKind };

interface StripChip {
	readonly label: string;
	readonly action: StripAction;
}

type Strip =
	| { kind: "chips"; agent: HubAgent; property?: PropertyKind; chips: StripChip[]; index: number }
	| { kind: "pattern"; agent: HubAgent; property: PropertyKind; text: string; cursor: number };

/** A one-line or multi-line text field state. */
interface Field {
	text: string;
	cursor: number;
}

function extractJsonObject(raw: string): string {
	// A bare object may hold code fences inside its strings: keep it whole.
	try {
		JSON.parse(raw);
		return raw;
	} catch {}
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) return fenced[1].trim();
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	return start >= 0 && end >= start ? raw.slice(start, end + 1).trim() : raw.trim();
}

/**
 * The architect's output as a {@link GeneratedAgentSpec}: a bare or fenced
 * JSON object whose `identifier` is lowercase kebab-case (2+ words), whose
 * `whenToUse` starts "Use this agent when" and whose `systemPrompt` is set.
 */
export function parseGeneratedAgentSpec(raw: string): GeneratedAgentSpec {
	const parsed: unknown = JSON.parse(extractJsonObject(raw));
	if (!parsed || typeof parsed !== "object") throw new Error("Model output is not a JSON object");
	const { identifier, whenToUse, systemPrompt } = parsed as Partial<Record<keyof GeneratedAgentSpec, unknown>>;
	if (typeof identifier !== "string" || typeof whenToUse !== "string" || typeof systemPrompt !== "string")
		throw new Error("Model output is missing required fields (identifier, whenToUse, systemPrompt)");
	const spec = { identifier: identifier.trim(), whenToUse: whenToUse.trim(), systemPrompt: systemPrompt.trim() };
	if (!IDENTIFIER_PATTERN.test(spec.identifier))
		throw new Error("Generated identifier is invalid (must be lowercase kebab-case, 2+ words)");
	if (!spec.whenToUse.toLowerCase().startsWith("use this agent when"))
		throw new Error("Generated whenToUse must start with 'Use this agent when...'");
	if (!spec.systemPrompt) throw new Error("Generated systemPrompt is empty");
	return spec;
}

function rowId(row: ListRow): string {
	return row.kind === "new" ? NEW_ROW : `agent:${row.agent.source}:${row.agent.name}`;
}

/** Edit a field with `key` (printable text, deletion, caret moves); `multiline` takes Enter as a newline. */
function editField(field: Field, key: KeyEvent): boolean {
	const { text, cursor } = field;
	switch (key.id) {
		case "backspace":
			if (cursor > 0) {
				field.text = text.slice(0, cursor - 1) + text.slice(cursor);
				field.cursor = cursor - 1;
			}
			return true;
		case "delete":
			field.text = text.slice(0, cursor) + text.slice(cursor + 1);
			return true;
		case "left":
			field.cursor = Math.max(0, cursor - 1);
			return true;
		case "right":
			field.cursor = Math.min(text.length, cursor + 1);
			return true;
		case "home":
			field.cursor = text.lastIndexOf("\n", cursor - 1) + 1;
			return true;
		case "end": {
			const end = text.indexOf("\n", cursor);
			field.cursor = end < 0 ? text.length : end;
			return true;
		}
	}
	if (key.text && !/[\x00-\x1f\x7f]/.test(key.text)) {
		field.text = text.slice(0, cursor) + key.text + text.slice(cursor);
		field.cursor = cursor + key.text.length;
		return true;
	}
	return false;
}

const isCancel = (key: KeyEvent): boolean => matchesSelectCancel(key);

/** The agents hub. */
export function AgentsHub(props: AgentsHubProps): JSXNode {
	const { deps } = props;
	const revision = signal(0);

	let allAgents: HubAgent[] = [];
	let activeEntryId = "all";
	let focus: "scope" | "list" = "list";
	let rows: ListRow[] = [];
	let rowIndex = 0;
	let listScroll = 0;
	const search: Field = { text: "", cursor: 0 };
	let notice: string | null = null;
	let loadError: string | null = null;
	let strip: Strip | null = null;
	let assigning: { agent: HubAgent; property: PropertyKind } | null = null;
	let create: Field | null = null;
	let createScope: "project" | "user" = "project";
	let generating = false;
	let spec: GeneratedAgentSpec | null = null;
	let createError: string | null = null;
	let streamed = "";
	let promptCollapsed = true;

	const browser = new ModelBrowserState(deps.browserSource, {
		emptyText: () => "  No models available — configure a provider in /models first.",
	});
	browser.setShowProvider(true);

	const createActive = (): boolean => create !== null || generating || spec !== null;

	// ─── Data ───────────────────────────────────────────────────────────────

	const entries = (): AgentsSidebarEntry[] => {
		const counts: Record<AgentSource, number> = { project: 0, user: 0, bundled: 0 };
		for (const agent of allAgents) counts[agent.source]++;
		const out: AgentsSidebarEntry[] = [
			{ id: "all", kind: "all", label: "All agents", annotation: String(allAgents.length) },
		];
		const sources = SOURCES.filter(source => counts[source] > 0);
		if (sources.length > 0) {
			out.push({ id: "sep:sources", kind: "separator", label: "" });
			for (const source of sources)
				out.push({
					id: `source:${source}`,
					kind: "source",
					label: SOURCE_LABEL[source],
					annotation: String(counts[source]),
				});
		}
		out.push({ id: "sep:actions", kind: "separator", label: "" }, { id: "new", kind: "new", label: "New agent" });
		return out;
	};
	let sidebar = entries();
	const activeEntry = (): AgentsSidebarEntry => sidebar.find(entry => entry.id === activeEntryId) ?? sidebar[0]!;
	const entrySource = (entry: AgentsSidebarEntry): AgentSource | undefined =>
		entry.kind === "source" ? (entry.id.slice("source:".length) as AgentSource) : undefined;

	const buildSidebar = (): void => {
		sidebar = entries();
		if (!sidebar.some(entry => entry.id === activeEntryId)) activeEntryId = "all";
	};

	const buildRows = (): void => {
		const source = entrySource(activeEntry());
		const scoped = source ? allAgents.filter(agent => agent.source === source) : allAgents;
		const query = search.text.trim();
		let filtered = scoped;
		if (query) {
			const tokens = query.split(/\s+/).map(token => new FuzzyQuery(token));
			filtered = scoped.filter(agent => {
				const text = `${agent.name} ${agent.description} ${SOURCE_LABEL[agent.source]} ${agent.overrideModel ?? ""}`;
				return tokens.every(token => token.match(text).matches);
			});
		}
		rows = [...filtered.map((agent): ListRow => ({ kind: "agent", agent })), { kind: "new" }];
	};

	const clampRow = (): void => {
		rowIndex = Math.max(0, Math.min(rowIndex, rows.length - 1));
	};

	const selectedAgent = (): HubAgent | undefined => {
		const row = rows[rowIndex];
		return row?.kind === "agent" ? row.agent : undefined;
	};

	// Keep one preview for this selection, not a catalog cache shared between agents or hub opens.
	let modelPreview:
		| { agent: HubAgent; revision: number; override?: string; patterns: string; resolved?: string }
		| undefined;
	const modelFor = (agent: HubAgent) => {
		const settingsRevision = deps.browserSource.revision;
		if (
			modelPreview?.agent === agent &&
			modelPreview.revision === settingsRevision &&
			modelPreview.override === agent.overrideModel
		)
			return modelPreview;
		const patterns = deps.effectiveModelPatterns(agent);
		modelPreview = {
			agent,
			revision: settingsRevision,
			override: agent.overrideModel,
			patterns: patterns.join(","),
			resolved: deps.resolvePatterns(patterns),
		};
		return modelPreview;
	};
	const touch = (): void => {
		if (modelPreview && (modelPreview.agent !== selectedAgent() || assigning || createActive()))
			modelPreview = undefined;
		revision.set(revision() + 1);
	};

	const reload = async (): Promise<void> => {
		loadError = null;
		try {
			const selectedName = selectedAgent()?.name;
			allAgents = (await deps.loadAgents()).sort(
				(a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || a.name.localeCompare(b.name),
			);
			buildSidebar();
			buildRows();
			if (selectedName) {
				const index = rows.findIndex(row => row.kind === "agent" && row.agent.name === selectedName);
				if (index >= 0) rowIndex = index;
			}
			clampRow();
		} catch (error) {
			allAgents = [];
			buildSidebar();
			buildRows();
			loadError = error instanceof Error ? error.message : String(error);
		}
		modelPreview = undefined;
		touch();
	};
	props.ref?.({ reload });

	// ─── Settings ───────────────────────────────────────────────────────────

	const overrideFor = (agent: HubAgent, property: PropertyKind): string | undefined =>
		property === "model"
			? agent.overrideModel
			: property === "prewalk"
				? agent.prewalkOverride
				: agent.advisorOverride;

	/** One line on what `property` resolves to now (notices). */
	const describeProperty = (agent: HubAgent, property: PropertyKind): string => {
		if (property === "model") {
			const { patterns, resolved } = modelFor(agent);
			const base = agent.overrideModel ?? (patterns || "session model");
			return `${agent.name} model: ${base}${resolved ? ` → ${resolved}` : ""}`;
		}
		const pattern =
			property === "prewalk" ? deps.effectivePrewalkPattern(agent) : deps.effectiveAdvisorPattern(agent);
		return `${agent.name} ${property}: ${pattern ? `on (${pattern})` : "off"}`;
	};

	/** A property chip's short value. */
	const propertySummary = (agent: HubAgent, property: PropertyKind): string => {
		if (property === "model") return agent.overrideModel ?? "auto";
		return (
			(property === "prewalk" ? deps.effectivePrewalkPattern(agent) : deps.effectiveAdvisorPattern(agent)) ?? "off"
		);
	};

	const toggleAgent = (agent: HubAgent): void => {
		agent.disabled = !agent.disabled;
		deps.setAgentDisabled(agent.name, { disabled: agent.disabled });
		notice = `${agent.name} ${agent.disabled ? "disabled" : "enabled"}`;
	};

	const setOverride = (agent: HubAgent, property: PropertyKind, value: string | undefined): void => {
		const trimmed = value?.trim() || undefined;
		if (property === "model") agent.overrideModel = trimmed;
		else if (property === "prewalk") agent.prewalkOverride = trimmed;
		else agent.advisorOverride = trimmed;
		deps.setAgentOverride(property, agent.name, trimmed);
		notice = describeProperty(agent, property);
	};

	// ─── Strips ─────────────────────────────────────────────────────────────

	/** The agent strip: enable/disable, then each knob. */
	const openAgentStrip = (agent: HubAgent): void => {
		strip = {
			kind: "chips",
			agent,
			chips: [
				{ label: agent.disabled ? "enable" : "disable", action: { kind: "toggle" } },
				...(["model", "prewalk", "advisor"] as const).map((property): StripChip => ({
					label: property,
					action: { kind: "property", property },
				})),
			],
			index: 1,
		};
	};

	/** A knob's value strip. */
	const openPropertyStrip = (agent: HubAgent, property: PropertyKind): void => {
		const chips: StripChip[] = [];
		if (property === "model") {
			chips.push({ label: "pick model…", action: { kind: "pick", property } });
			chips.push({ label: "pattern…", action: { kind: "pattern", property } });
			if (agent.overrideModel)
				chips.push({ label: "clear override", action: { kind: "set", property, value: undefined } });
		} else {
			chips.push({ label: "agent default", action: { kind: "set", property, value: undefined } });
			chips.push({ label: "on", action: { kind: "set", property, value: "on" } });
			chips.push({ label: "off", action: { kind: "set", property, value: "off" } });
			chips.push({ label: "pick model…", action: { kind: "pick", property } });
			chips.push({ label: "pattern…", action: { kind: "pattern", property } });
		}
		strip = { kind: "chips", agent, property, chips, index: 0 };
	};

	const openPatternStrip = (agent: HubAgent, property: PropertyKind): void => {
		const current = overrideFor(agent, property) ?? "";
		strip = { kind: "pattern", agent, property, text: current, cursor: current.length };
	};

	const startAssign = (agent: HubAgent, property: PropertyKind): void => {
		const items = buildBrowserItems(deps.getAvailableModels());
		sortModelItems(items, { mruOrder: deps.browserSource.mruOrder });
		assigning = { agent, property };
		// The body's rows less the status row, the search field, two blanks and the detail rows.
		browser.setMaxVisible(Math.max(10, Math.max(16, props.rows()) - 4) - 6);
		browser.setItems(items);
		browser.setQuery("");
		const current = overrideFor(agent, property);
		if (current) browser.selectSelector(current);
	};

	browser.onActivate = (item: ModelBrowserItem) => {
		const target = assigning;
		if (!target) return;
		assigning = null;
		browser.setQuery("");
		setOverride(target.agent, target.property, item.selector);
		touch();
	};
	browser.onCancel = () => {
		assigning = null;
		browser.setQuery("");
		touch();
	};

	const activateChip = (): void => {
		if (strip?.kind !== "chips") return;
		const current = strip;
		const chip = current.chips[current.index];
		if (!chip) return;
		const action = chip.action;
		switch (action.kind) {
			case "toggle":
				toggleAgent(current.agent);
				strip = null;
				return;
			case "property":
				openPropertyStrip(current.agent, action.property);
				return;
			case "set":
				setOverride(current.agent, action.property, action.value);
				strip = null;
				return;
			case "pick":
				strip = null;
				startAssign(current.agent, action.property);
				return;
			case "pattern":
				openPatternStrip(current.agent, action.property);
				return;
		}
	};

	/** Esc on a strip: a value strip steps back to the agent strip, the agent strip closes. */
	const stripBack = (current: Strip): void => {
		if (current.kind === "chips" && current.property) openAgentStrip(current.agent);
		else if (current.kind === "pattern") openPropertyStrip(current.agent, current.property);
		else strip = null;
	};

	// ─── Create flow ────────────────────────────────────────────────────────

	const beginCreate = (): void => {
		if (generating) return;
		createError = null;
		spec = null;
		create = { text: "", cursor: 0 };
	};

	const clearCreate = (): void => {
		create = null;
		generating = false;
		spec = null;
		createError = null;
		streamed = "";
	};

	const generate = async (raw: string): Promise<void> => {
		const description = raw.trim();
		if (!description) {
			createError = "Description is required.";
			touch();
			return;
		}
		generating = true;
		createError = null;
		spec = null;
		streamed = "";
		touch();
		try {
			const output = await deps.generateAgent(description, text => {
				streamed += text;
				touch();
			});
			spec = parseGeneratedAgentSpec(output);
			notice = null;
		} catch (error) {
			createError = error instanceof Error ? error.message : String(error);
		} finally {
			generating = false;
			touch();
		}
	};

	const save = async (): Promise<void> => {
		const draft = spec;
		if (!draft) return;
		const filePath = await deps.saveAgent(createScope, draft);
		clearCreate();
		notice = `Created agent ${draft.identifier} at ${shortenPath(filePath)}`;
		await reload();
	};

	// ─── Navigation ─────────────────────────────────────────────────────────

	const visibleRows = (): number => {
		const bodyRows = Math.max(10, Math.max(16, props.rows()) - 4);
		// The status row, then the search row and a blank before the list.
		return Math.max(3, bodyRows - 1 - 2 - DETAIL_ROWS);
	};

	/** Keep the selection inside the list's window. */
	const reveal = (): void => {
		const visible = visibleRows();
		if (rowIndex < listScroll) listScroll = rowIndex;
		else if (rowIndex >= listScroll + visible) listScroll = rowIndex - visible + 1;
		listScroll = Math.max(0, Math.min(listScroll, Math.max(0, rows.length - visible)));
	};

	const setScope = (id: string): void => {
		activeEntryId = id;
		buildRows();
		rowIndex = 0;
		listScroll = 0;
	};

	const moveSidebar = (delta: number): void => {
		const count = sidebar.length;
		let index = Math.max(
			0,
			sidebar.findIndex(entry => entry.id === activeEntryId),
		);
		for (let step = 0; step < count; step++) {
			index = (index + delta + count) % count;
			const entry = sidebar[index]!;
			if (entry.kind === "separator") continue;
			if (entry.kind === "new") activeEntryId = entry.id;
			else setScope(entry.id);
			return;
		}
	};

	const activateRow = (row: ListRow | undefined): void => {
		if (!row) return;
		if (row.kind === "new") beginCreate();
		else openAgentStrip(row.agent);
	};

	// ─── Keys ───────────────────────────────────────────────────────────────

	const onStripKey = (current: Strip, key: KeyEvent): void => {
		if (isCancel(key)) return stripBack(current);
		if (current.kind === "pattern") {
			if (key.id === "enter") {
				setOverride(current.agent, current.property, current.text);
				strip = null;
				return;
			}
			const field = { text: current.text, cursor: current.cursor };
			if (editField(field, key)) strip = { ...current, ...field };
			return;
		}
		const count = current.chips.length;
		const id = selectKeyId(key);
		if (["left", "up", "shift+tab"].includes(id)) current.index = (current.index - 1 + count) % count;
		else if (["right", "down", "tab"].includes(id)) current.index = (current.index + 1) % count;
		else if (id === "enter") activateChip();
	};

	const onCreateKey = (key: KeyEvent): void => {
		if (spec) {
			if (isCancel(key)) clearCreate();
			else if (key.id === "tab" || key.id === "shift+tab")
				createScope = createScope === "project" ? "user" : "project";
			else if (key.id === "r" || key.id === "shift+r") void generate(create?.text ?? "");
			else if (key.id === "enter")
				void save().catch((error: unknown) => {
					createError = error instanceof Error ? error.message : String(error);
					touch();
				});
			return;
		}
		if (isCancel(key)) {
			if (!generating) clearCreate();
			return;
		}
		if (generating || !create) return;
		if (matchesAnyKey(key, appFollowUpKeys())) {
			void generate(create.text);
			return;
		}
		if (key.id === "tab" || key.id === "shift+tab") {
			createScope = createScope === "project" ? "user" : "project";
			return;
		}
		if (key.id === "enter") {
			create.text = `${create.text.slice(0, create.cursor)}\n${create.text.slice(create.cursor)}`;
			create.cursor++;
			return;
		}
		editField(create, key);
	};

	const onListKey = (key: KeyEvent): void => {
		if (isCancel(key)) {
			if (assigning) {
				assigning = null;
				browser.setQuery("");
			} else if (search.text) {
				search.text = "";
				search.cursor = 0;
				buildRows();
				clampRow();
			} else props.onCancel();
			return;
		}
		if (assigning) {
			browser.handleKey(key);
			return;
		}
		if (key.id === "ctrl+r") {
			void reload();
			return;
		}
		if (key.id === "tab" || key.id === "shift+tab") {
			focus = focus === "scope" ? "list" : "scope";
			return;
		}
		if (key.id === "left" || key.id === "right") {
			focus = key.id === "left" ? "scope" : "list";
			return;
		}
		const id = selectKeyId(key);
		if (focus === "scope") {
			if (id === "up" || id === "down") {
				moveSidebar(id === "up" ? -1 : 1);
				return;
			}
			if (id === "enter") {
				if (activeEntry().kind === "new") beginCreate();
				else focus = "list";
				return;
			}
		}
		if (id === "up" || id === "down") {
			rowIndex = id === "up" ? Math.max(0, rowIndex - 1) : Math.min(rows.length - 1, rowIndex + 1);
			reveal();
			return;
		}
		if (id === "enter") {
			activateRow(rows[rowIndex]);
			return;
		}
		if (key.id === "space" && !search.text) {
			const agent = selectedAgent();
			if (agent) toggleAgent(agent);
			return;
		}
		// Type-to-filter: every other key edits the search.
		const before = search.text;
		if (!editField(search, key) || search.text === before) return;
		if (search.text.length > before.length) {
			focus = "list";
			buildRows();
			rowIndex = 0;
			listScroll = 0;
		} else {
			buildRows();
			clampRow();
		}
		reveal();
	};

	const onKey = (key: KeyEvent): boolean => {
		if (key.kind === "release") return false;
		if (strip) onStripKey(strip, key);
		else if (createActive()) onCreateKey(key);
		else onListKey(key);
		touch();
		return true;
	};

	// ─── Native events ──────────────────────────────────────────────────────

	const pickRow = (item: string, activate: boolean): void => {
		const index = rows.findIndex(row => rowId(row) === item);
		if (index < 0) return;
		focus = "list";
		rowIndex = index;
		reveal();
		if (activate) activateRow(rows[index]);
	};

	const pickScope = (item: string, activate: boolean): void => {
		const entry = sidebar.find(candidate => candidate.id === item);
		if (!entry || entry.kind === "separator") return;
		if (entry.kind === "new") beginCreate();
		else {
			setScope(entry.id);
			focus = activate ? "list" : "scope";
		}
	};

	const pickChip = (item: string, activate: boolean): void => {
		const index = Number(item);
		if (strip?.kind !== "chips" || !Number.isInteger(index) || !strip.chips[index]) return;
		strip.index = index;
		if (activate) activateChip();
	};

	/** Card events name a child list; sheet rows belong to the picker, even inside a fullscreen layer. */
	const onPick = (item: string, keypath: string, activate: boolean): void => {
		const target = keypath.slice(keypath.lastIndexOf("/") + 1);
		const inert = strip !== null || createActive() || assigning !== null;
		if (target === "strip") pickChip(item, activate);
		else if (target === "scopes") {
			if (!inert) pickScope(item, activate);
		} else if (!inert && (target === "agents" || sheetMode())) pickRow(item, activate);
		touch();
	};

	const onAction = (act: string, event: Extract<UiEvent, { type: "action" }>): void => {
		if (act === "close") props.onCancel();
		else if (strip?.kind === "chips") {
			if (act === "strip") pickChip(String(event.value), true);
			else if (act === "apply") activateChip();
			else if (act === "back") stripBack(strip);
		} else {
			const agent = selectedAgent();
			switch (act) {
				case "scope": {
					const entry = sidebar.find(candidate => candidate.id === event.value);
					if (!entry || entry.kind === "separator" || entry.kind === "new") break;
					setScope(entry.id);
					focus = "scope";
					break;
				}
				case "configure":
					activateRow(rows[rowIndex]);
					break;
				case "toggle":
					if (agent) toggleAgent(agent);
					break;
				case "model":
					if (agent) openPropertyStrip(agent, "model");
					break;
				case "new":
					beginCreate();
					break;
				case "reload":
					void reload();
					break;
			}
		}
		touch();
	};

	// ─── Native tree ────────────────────────────────────────────────────────

	const sheetMode = computed(() => {
		revision();
		return !createActive() && !assigning && strip?.kind !== "pattern";
	});

	const chipLabel = (agent: HubAgent, chip: StripChip): string => {
		const action = chip.action;
		if (action.kind === "toggle") return agent.disabled ? "Enable" : "Disable";
		if (action.kind === "property") return `${action.property}: ${propertySummary(agent, action.property)}`;
		return chip.label;
	};

	const chipOn = (agent: HubAgent, property: PropertyKind | undefined, chip: StripChip): boolean | undefined => {
		const action = chip.action;
		if (action.kind !== "set" || action.property === "model" || !property) return undefined;
		return overrideFor(agent, property)?.toLowerCase() === action.value;
	};

	/** A chip's styled spans (footer strip). */
	const chipSpans = (agent: HubAgent, property: PropertyKind | undefined, chip: StripChip): TspSpan[] => {
		const action = chip.action;
		switch (action.kind) {
			case "toggle":
				return chip.label === "enable"
					? [span(`${currentTheme().symbols.symbol("status.enabled")} enable`, "success")]
					: [span(`${currentTheme().symbols.symbol("status.disabled")} disable`, "dim")];
			case "property":
				return [span(action.property, "accent"), span(`: ${propertySummary(agent, action.property)}`, "dim")];
			case "set": {
				if (action.property === "model") return [span(chip.label, "warning")];
				const current = property ? overrideFor(agent, property)?.toLowerCase() : undefined;
				return current === action.value
					? [span(`${currentTheme().symbols.symbol("status.enabled")} ${chip.label}`, "accent")]
					: [span(chip.label, "muted")];
			}
			case "pick":
				return [span(chip.label, "accent")];
			case "pattern":
				return [span(chip.label, "muted")];
		}
	};

	const pickerItem = (row: ListRow): TspPickerItem => {
		if (row.kind === "new") return { id: NEW_ROW, label: "New agent…", icon: "plus", tone: "muted" };
		const agent = row.agent;
		const prewalk = deps.effectivePrewalkPattern(agent);
		const advisor = deps.effectiveAdvisorPattern(agent);
		return {
			id: rowId(row),
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
	};

	const pickerProps = computed((): TspPickerProps => {
		revision();
		const counts: Record<AgentSource, number> = { project: 0, user: 0, bundled: 0 };
		for (const agent of allAgents) counts[agent.source]++;
		const scopes: TspPickerScope[] = [
			{ id: "all", label: "All agents", icon: "users", count: allAgents.length },
			...SOURCES.map((source): TspPickerScope => ({
				id: `source:${source}`,
				label: SOURCE_LABEL[source],
				icon: SOURCE_ICON[source],
				count: counts[source],
				group: "Source",
				disabled: counts[source] === 0 ? `No ${source} agents` : undefined,
			})),
		];
		const entry = activeEntry();
		const source = entrySource(entry);
		const chips = strip?.kind === "chips" ? strip : null;
		const agent = selectedAgent();
		const noAgent = agent ? undefined : "Select an agent";
		const actions: TspPickerAction[] = chips
			? [
					{ id: "apply", label: chips.property ? "Apply" : "Open", keys: confirmKbd(), primary: true },
					{ id: "back", label: chips.property ? "Back" : "Cancel", keys: pickerKeys(cancelKbd()), end: true },
				]
			: [
					{ id: "configure", label: agent ? "Configure" : "Create", keys: confirmKbd(), primary: true },
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
					closeAction(),
				];
		const selected = rows[rowIndex];
		return {
			title: "Agents",
			subtitle: notice ?? undefined,
			icon: "users",
			noun: "agents",
			size: "lg",
			layout: "rows",
			preview: "side",
			query: search.text,
			cursor: search.cursor,
			placeholder: "Search agents…",
			scopes,
			scope: source ? entry.id : "all",
			columns: source ? AGENT_COLUMNS : [...AGENT_COLUMNS, SOURCE_COLUMN],
			items: rows.map(pickerItem),
			selected: selected ? rowId(selected) : null,
			total: source ? counts[source] : allAgents.length,
			state: loadError ? "error" : "ready",
			message: loadError ?? undefined,
			strip: chips
				? {
						label: chips.property ? `${chips.agent.name} · ${chips.property}` : chips.agent.name,
						items: chips.chips.map((chip, index) => ({
							id: String(index),
							label: chipLabel(chips.agent, chip),
							on: chipOn(chips.agent, chips.property, chip),
						})),
						selected: String(chips.index),
					}
				: null,
			actions,
			focus: chips ? "strip" : focus === "scope" ? "scopes" : "list",
		};
	});

	const preview = (): JSXNode[] => {
		const row = rows[rowIndex];
		if (!row) return [];
		if (row.kind === "new")
			return [
				<text text="New agent" role="omp.picker.title" />,
				<md text="Describe what the agent should do; the architect drafts its name, when to use it and its system prompt." />,
			];
		const agent = row.agent;
		const { patterns, resolved } = modelFor(agent);
		const model = [patterns ? span(patterns, "mono") : span("session model", "dim")];
		if (resolved) model.push(span(" → ", "dim"), span(resolved, "mono success"));
		const prewalk = deps.effectivePrewalkPattern(agent);
		const advisor = deps.effectiveAdvisorPattern(agent);
		const facts: TspKvProps["items"][number][] = [
			{ k: "Model", v: model },
			{ k: "Prewalk", v: [prewalk ? span(prewalk, "mono") : span("off", "dim")] },
			{ k: "Advisor", v: [advisor ? span(advisor, "mono") : span("off", "dim")] },
			{ k: "Status", v: [agent.disabled ? span("Disabled", "warning") : span("Enabled", "success")] },
			{ k: "Source", v: SOURCE_LABEL[agent.source] },
		];
		if (agent.filePath) {
			// Bundled agents live in the binary (`embedded:…`): nothing to open.
			const href = agent.filePath.startsWith("/") ? `file://${agent.filePath}` : undefined;
			facts.push({ k: "File", v: [{ t: shortenPath(agent.filePath), s: "path", ...(href ? { href } : {}) }] });
		}
		return [
			<text key="title" text={agent.name} role="omp.picker.title" />,
			<md key="description" text={agent.description} />,
			<kv key="facts" items={facts} layout="grid" />,
			agent.systemPrompt.trim() && (
				<section key="prompt" head="System prompt" role="omp.agents.prompt">
					<code text={agent.systemPrompt} lang="md" wrap />
				</section>
			),
		];
	};

	const statusSpans = (): TspSpan[] => {
		if (loadError) return [span(loadError, "error")];
		if (assigning) {
			const what = assigning.property === "model" ? "model override" : `${assigning.property} model`;
			return [span(`Picking ${what} for `, "accent"), span(assigning.agent.name, "accent strong")];
		}
		if (createActive()) return [span("New agent — describe it and let the architect draft it", "accent")];
		if (notice) return [span(notice, "success")];
		const entry = activeEntry();
		const label = entry.kind === "source" ? `${entry.label} agents` : "All agents";
		return [span(`${label} · ${rows.filter(row => row.kind === "agent").length}`, "muted")];
	};

	const agentItem = (agent: HubAgent): JSXNode => {
		const value: TspSpan[] = [];
		const badge = (t: string, s: string): void => {
			if (value.length > 0) value.push(span("  "));
			value.push(span(t, s));
		};
		if (agent.overrideModel) badge(agent.overrideModel, "warning");
		const prewalk = deps.effectivePrewalkPattern(agent);
		if (prewalk) badge(`pre:${prewalk}`, "dim");
		const advisor = deps.effectiveAdvisorPattern(agent);
		if (advisor) badge(`adv:${advisor}`, "dim");
		return (
			<item
				key={rowId({ kind: "agent", agent })}
				label={[
					span(
						`${currentTheme().symbols.symbol(agent.disabled ? "status.disabled" : "status.enabled")} `,
						agent.disabled ? "dim" : "success",
					),
					span(agent.name, agent.disabled ? "dim" : "strong"),
				]}
				detail={[span(SOURCE_LABEL[agent.source].toLowerCase(), "dim")]}
				value={value.length > 0 ? value : undefined}
				tone={agent.disabled ? "muted" : undefined}
			/>
		);
	};

	const detailSection = (): JSXNode => {
		const agent = selectedAgent();
		if (!agent)
			return (
				<section key="detail">
					<text spans={[span("Select an agent to inspect", "dim")]} />
				</section>
			);
		const { patterns, resolved } = modelFor(agent);
		const model = [patterns ? span(patterns) : span("(session model)", "dim")];
		if (resolved) model.push(span(" → ", "dim"), span(resolved, "success"));
		const prewalk = deps.effectivePrewalkPattern(agent);
		const advisor = deps.effectiveAdvisorPattern(agent);
		return (
			<section key="detail" head={[span(agent.name, "accent strong")]}>
				<text spans={[span(agent.description, "dim")]} wrap="word" lines={2} />
				<kv
					items={[
						{ k: [span("model", "muted")], v: model },
						{ k: [span("prewalk", "muted")], v: [prewalk ? span(prewalk, "success") : span("off", "dim")] },
						{ k: [span("advisor", "muted")], v: [advisor ? span(advisor, "success") : span("off", "dim")] },
					]}
					layout="inline"
				/>
				{agent.filePath && <text spans={[span(shortenPath(agent.filePath), "path dim")]} truncate="middle" />}
			</section>
		);
	};

	const createNodes = (): JSXNode[] => {
		const nodes: JSXNode[] = [];
		if (spec) {
			nodes.push(
				<text spans={[span("Review generated agent", "accent strong")]} />,
				<kv
					items={[
						{ k: [span("Identifier", "muted")], v: [span(spec.identifier, "code")] },
						{ k: [span("Scope", "muted")], v: [span(createScope, "accent")] },
					]}
				/>,
				<section head={[span("whenToUse", "muted")]}>
					<text text={spec.whenToUse} wrap="word" lines={6} />
				</section>,
				<card
					key="prompt"
					head={[span("System prompt", "muted")]}
					collapsible
					collapsed={promptCollapsed}
					preview={{ lines: 8 }}
				>
					<md text={spec.systemPrompt} />
				</card>,
			);
		} else {
			nodes.push(
				<text spans={[span("Create new agent", "accent strong")]} />,
				<text
					spans={[span("Describe what the agent should do; scope: ", "muted"), span(createScope, "accent")]}
					wrap="word"
				/>,
			);
			if (create && !generating)
				nodes.push(
					<col role="omp.field">
						<editor
							key="input"
							text={create.text}
							cursor={create.cursor}
							maxLines={Math.max(3, Math.min(8, Math.max(16, props.rows()) - 12))}
							sendable={false}
						/>
					</col>,
				);
			if (generating) {
				nodes.push(<spinner key="generating" label="Generating…" />);
				if (streamed) nodes.push(<code key="stream" text={streamed} lang="json" wrap />);
			}
		}
		if (createError) nodes.push(<text key="error" text={createError} tone="error" wrap="word" />);
		return nodes;
	};

	type Hint = { keys: readonly string[]; label: string };
	const hints = (): Hint[] => {
		const confirm = actionKeyId("tui.select.confirm", "enter");
		const cancel = actionKeyId("tui.select.cancel", "escape");
		const nav = [actionKeyId("tui.select.up", "up"), actionKeyId("tui.select.down", "down")];
		if (strip) {
			if (strip.kind === "pattern") {
				const values = strip.property === "model" ? "a model pattern" : '"on", "off", or a model pattern';
				return [
					{ keys: [confirm], label: `${values} (role aliases like @smol and :level suffixes work; empty clears)` },
					{ keys: [cancel], label: "back" },
				];
			}
			return [
				{ keys: ["left", "right"], label: "choose" },
				{ keys: [confirm], label: strip.property ? "apply" : "open" },
				{ keys: [cancel], label: strip.property ? "back" : "cancel" },
			];
		}
		if (assigning)
			return [
				{ keys: [confirm], label: "pick" },
				{ keys: nav, label: "models" },
				{ keys: [], label: "type to search" },
				{ keys: [cancel], label: "cancel" },
			];
		if (createActive()) {
			if (spec)
				return [
					{ keys: [confirm], label: "save" },
					{ keys: ["tab"], label: "scope" },
					{ keys: ["r"], label: "regenerate" },
					{ keys: [cancel], label: "cancel" },
				];
			if (generating) return [];
			return [
				{ keys: appFollowUpKeys(), label: "generate" },
				{ keys: [confirm], label: "newline" },
				{ keys: ["tab"], label: "scope" },
				{ keys: [cancel], label: "cancel" },
			];
		}
		if (focus === "scope")
			return [
				{ keys: nav, label: "scopes" },
				{ keys: ["right", confirm], label: "agents" },
				{ keys: [cancel], label: "close" },
			];
		return [
			{ keys: [confirm], label: "configure" },
			{ keys: ["space"], label: "enable/disable" },
			{ keys: nav, label: "rows" },
			{ keys: [], label: "type to search" },
			{ keys: ["ctrl+r"], label: "reload" },
			{ keys: [cancel], label: "close" },
		];
	};

	const stripNode = (): JSXNode => {
		if (!strip) return null;
		if (strip.kind === "pattern")
			return (
				<row key="pattern" gap="sm" align="center">
					<text spans={[span(`${strip.agent.name} ${strip.property} pattern:`, "accent")]} />
					<col grow={1}>
						<input text={strip.text} cursor={strip.cursor} prompt="> " sendable={false} />
					</col>
				</row>
			);
		const chips = strip;
		return (
			<row gap="sm" align="center">
				<text
					spans={
						chips.property
							? [span(chips.agent.name, "accent"), span(` · ${chips.property} →`, "dim")]
							: [span(chips.agent.name, "accent"), span(" →", "dim")]
					}
				/>
				<tabs
					key="strip"
					items={chips.chips.map((chip, index) => ({
						id: String(index),
						label: chipSpans(chips.agent, chips.property, chip),
					}))}
					active={String(chips.index)}
					actions={{ click: "activate" }}
				/>
			</row>
		);
	};

	const hintsNode = (): JSXNode => (
		<row key="hints" gap="md" wrap role="omp.overlay.hints">
			{hints().map(hint => (
				<row gap="xs" align="center">
					{hint.keys.map(key => (
						<kbd keys={key.split("+")} />
					))}
					<text spans={[span(hint.label, "muted")]} />
				</row>
			))}
		</row>
	);

	const cardChildren = (): JSXNode[] => {
		const entry = activeEntry();
		const sidebarList = (
			<list key="scopes" selected={entry.id} shrink={0}>
				{sidebar.map(item =>
					item.kind === "separator" ? (
						<rule key={item.id} />
					) : (
						<item
							key={item.id}
							label={[
								span(
									`${item.kind === "new" ? "+" : currentTheme().symbols.symbol(item.kind === "all" ? "icon.model" : "status.enabled")} `,
									"muted",
								),
								span(item.label),
							]}
							value={item.annotation ?? ""}
						/>
					),
				)}
			</list>
		);
		let body: JSXNode[];
		if (createActive()) body = createNodes();
		else if (assigning) {
			browser.setFocused(true);
			body = [<ModelBrowser browser={browser} />];
		} else {
			const selected = rows[rowIndex];
			body = [
				<text
					key="search"
					spans={[
						span("search: ", "muted"),
						search.text ? span(search.text, "accent") : span("type to filter", "dim"),
					]}
					truncate="end"
				/>,
				<list
					key="agents"
					selected={selected ? rowId(selected) : null}
					filter={search.text || undefined}
					virtual
					grow={1}
					tone={focus === "list" ? "accent" : undefined}
					aria="Agents"
				>
					{rows.map(row =>
						row.kind === "new" ? (
							<item key={NEW_ROW} label={[span("+ New agent…", "dim")]} />
						) : (
							agentItem(row.agent)
						),
					)}
				</list>,
				detailSection(),
			];
		}
		return [
			<row key="split" gap="md" align="start" grow={1}>
				{sidebarList}
				<col key="body" gap="sm" grow={1} basis={0} min={{ w: 0 }}>
					<text key="status" spans={statusSpans()} truncate="end" />
					{body}
				</col>
			</row>,
			<rule key="divider" />,
			<col key="footer" gap="xs">
				{stripNode()}
				{hintsNode()}
			</col>,
		];
	};

	// ─── Terminal look ──────────────────────────────────────────────────────

	const footerOf = (): AgentsHubFooter => {
		if (strip?.kind === "pattern")
			return {
				kind: "pattern",
				label: `${strip.agent.name} ${strip.property} pattern:`,
				text: strip.text,
				cursor: strip.cursor,
			};
		if (strip?.kind === "chips") {
			const chips = strip;
			return {
				kind: "chips",
				prefix: chips.property
					? [span(chips.agent.name, "accent"), span(` · ${chips.property} →`, "dim")]
					: [span(chips.agent.name, "accent"), span(" →", "dim")],
				chips: chips.chips.map(chip => chipSpans(chips.agent, chips.property, chip)),
				index: chips.index,
			};
		}
		return { kind: "hints", hints: hints() };
	};

	const listRow = (row: ListRow): AgentsListRow => {
		if (row.kind === "new") return { id: NEW_ROW };
		const agent = row.agent;
		return {
			id: rowId(row),
			name: agent.name,
			disabled: agent.disabled,
			source: SOURCE_LABEL[agent.source].toLowerCase(),
			override: agent.overrideModel,
			prewalk: deps.effectivePrewalkPattern(agent),
			advisor: deps.effectiveAdvisorPattern(agent),
		};
	};

	const bodyOf = (): AgentsHubBody => {
		if (createActive())
			return {
				kind: "create",
				spec: spec ?? undefined,
				scope: createScope,
				input: create && !generating ? { ...create } : undefined,
				generating,
				streamed,
				error: createError ?? undefined,
			};
		if (assigning) return { kind: "browser", browser };
		const agent = selectedAgent();
		let detail: Extract<AgentsHubBody, { kind: "list" }>["detail"];
		if (agent) {
			const { patterns, resolved } = modelFor(agent);
			detail = {
				description: agent.description,
				patterns,
				resolved,
				prewalk: deps.effectivePrewalkPattern(agent),
				advisor: deps.effectiveAdvisorPattern(agent),
				path: agent.filePath ? shortenPath(agent.filePath) : undefined,
			};
		}
		return {
			kind: "list",
			search: { ...search },
			rows: rows.map(listRow),
			selected: rowIndex,
			scroll: listScroll,
			focused: focus === "list",
			detail,
		};
	};

	const term = computed((): AgentsHubTerm => {
		revision();
		return {
			look: "omp.agents",
			role: "omp.agents",
			height: Math.max(16, props.rows()),
			sidebar,
			activeEntryId,
			sidebarFocused: focus === "scope",
			status: assigning
				? [
						...statusSpans(),
						span(
							` — ${bindingGlyph("tui.select.confirm", "enter")} assigns, ${bindingGlyph("tui.select.cancel", "escape")} cancels`,
							"accent",
						),
					]
				: statusSpans(),
			body: bodyOf(),
			footer: footerOf(),
			// Mouse input reaches the list only when nothing covers it.
			inert: strip !== null || createActive() || assigning !== null,
		};
	});

	const handlers = {
		term,
		onKey,
		onAction,
		onSelect: (item: string, event: Extract<UiEvent, { type: "select" }>) => onPick(item, event.key, false),
		onActivate: (item: string, event: Extract<UiEvent, { type: "activate" }>) => onPick(item, event.key, true),
		onToggle: (collapsed: boolean, event: Extract<UiEvent, { type: "toggle" }>) => {
			if (event.key.endsWith("prompt")) {
				promptCollapsed = collapsed;
				touch();
			}
		},
	};

	return () =>
		sheetMode() ? (
			<picker
				{...handlers}
				title="Agents"
				subtitle={() => pickerProps().subtitle}
				icon="users"
				noun="agents"
				size="lg"
				layout="rows"
				preview="side"
				query={() => pickerProps().query}
				cursor={() => pickerProps().cursor}
				placeholder="Search agents…"
				scopes={() => pickerProps().scopes}
				scope={() => pickerProps().scope}
				columns={() => pickerProps().columns}
				items={() => pickerProps().items}
				selected={() => pickerProps().selected}
				total={() => pickerProps().total}
				state={() => pickerProps().state}
				message={() => pickerProps().message}
				strip={() => pickerProps().strip}
				actions={() => pickerProps().actions}
				focus={() => pickerProps().focus}
			>
				{() => {
					revision();
					return untrack(preview);
				}}
			</picker>
		) : (
			<card {...handlers} head="Agents" role="omp.hub.agents">
				{() => {
					revision();
					return untrack(cardChildren);
				}}
			</card>
		);
}
