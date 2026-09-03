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

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type Component,
	Editor,
	fuzzyMatch,
	Input,
	matchesKey,
	replaceTabs,
	routeSgrMouseInput,
	type SgrMouseEvent,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { isEnoent, prompt } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type { EffectiveExtensionRoots } from "../../capability/types";
import { getConfigDirs } from "../../config";
import type { ModelRegistry } from "../../config/model-registry";
import {
	resolveAgentAdvisorSelection,
	resolveAgentModelPatterns,
	resolveAgentPrewalkPattern,
	resolveConfiguredModelPatterns,
	resolveModelOverride,
} from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import agentCreationArchitectPrompt from "../../prompts/system/agent-creation-architect.md" with { type: "text" };
import agentCreationUserPrompt from "../../prompts/system/agent-creation-user.md" with { type: "text" };
import { createAgentSession } from "../../sdk";
import { refreshAgentDiscovery } from "../../task";
import { discoverAgents } from "../../task/discovery";
import { resolveAgentPrewalkDefault } from "../../task/prewalk";
import type { AgentDefinition, AgentSource } from "../../task/types";
import { shortenPath } from "../../tools/render-utils";
import { getEditorTheme, theme } from "../theme/theme";
import {
	matchesAppFollowUp,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import { buildBrowserItems, ModelBrowser, type ModelBrowserItem, sortModelItems } from "./model-browser";
import { bottomBorder, dividerSplit, row, splitBodyWidth, splitRow, topBorderSplit } from "./overlay-box";

/** One agent with its per-agent settings overrides resolved for display. */
interface HubAgent extends AgentDefinition {
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

interface SidebarEntry {
	id: string;
	kind: "all" | "source" | "new" | "separator";
	label: string;
	source?: AgentSource;
	annotation?: string;
}

/** A body row of the agent list: an agent or the trailing "+ New agent…". */
type ListRow = { kind: "agent"; agent: HubAgent } | { kind: "new" };

/** The per-agent knob a strip or the model browser is editing. */
type PropertyKind = "model" | "prewalk" | "advisor";

interface StripChip {
	label: string;
	styled: string;
	action:
		| { kind: "toggle" }
		| { kind: "property"; property: PropertyKind }
		| { kind: "set"; property: PropertyKind; value: string | undefined }
		| { kind: "pick"; property: PropertyKind }
		| { kind: "pattern"; property: PropertyKind };
}

type StripState =
	| { kind: "chips"; agent: HubAgent; property?: PropertyKind; chips: StripChip[]; index: number }
	| { kind: "pattern"; agent: HubAgent; property: PropertyKind; input: Input };

/** Recorded chip hit-range on the footer row (columns relative to frame col 0). */
interface ChipRange {
	start: number;
	end: number;
	index: number;
}

interface GeneratedAgentSpec {
	identifier: string;
	whenToUse: string;
	systemPrompt: string;
}

/** Ambient model context for resolution previews and the creation architect. */
export interface AgentsHubModelContext {
	modelRegistry?: ModelRegistry;
	activeModelPattern?: string;
	defaultModelPattern?: string;
	/**
	 * Live provider for the owning session's extension roots (explicit + mode +
	 * configured). Supplied so `/agents` lists exactly the agents the session
	 * can spawn — including `--extension` roots and honoring `explicit-only`.
	 * Falls back to a settings-only merge struct when absent.
	 */
	extensionRoots?: () => EffectiveExtensionRoots;
}

export interface AgentsHubCallbacks {
	onCancel: () => void;
}

const SIDEBAR_MIN_WIDTH = 16;
const SIDEBAR_MAX_WIDTH = 24;
const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+){1,5}$/;

function extractAssistantText(messages: AgentMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const blocks = message.content;
		if (!Array.isArray(blocks)) continue;
		const text = blocks
			.map(block => {
				if (!block || typeof block !== "object") return "";
				if (!("type" in block) || block.type !== "text" || !("text" in block)) return "";
				const value = block.text;
				return typeof value === "string" ? value : "";
			})
			.join("\n")
			.trim();
		if (text.length > 0) return text;
	}
	return null;
}

function extractJsonObject(raw: string): string {
	const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenceMatch?.[1]) return fenceMatch[1].trim();
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start >= 0 && end >= start) return raw.slice(start, end + 1).trim();
	return raw.trim();
}

function parseGeneratedAgentSpec(raw: string): GeneratedAgentSpec {
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

function matchAgent(agent: HubAgent, query: string): boolean {
	const text = `${agent.name} ${agent.description} ${SOURCE_LABEL[agent.source]} ${agent.overrideModel ?? ""}`;
	return query
		.trim()
		.split(/\s+/)
		.every(token => fuzzyMatch(token, text).matches);
}

/**
 * The fullscreen agents hub component. Hosted via
 * `ui.showOverlay(..., { fullscreen: true })`; the host must call
 * {@link AgentsHubComponent.dispose} when the overlay closes.
 */
export class AgentsHubComponent implements Component {
	#tui: TUI;
	#cwd: string;
	#settings: Settings;
	#modelContext: AgentsHubModelContext;
	#callbacks: AgentsHubCallbacks;

	#allAgents: HubAgent[] = [];
	#entries: SidebarEntry[] = [];
	#activeEntryId = "all";
	#sidebarScroll = 0;
	#focus: "scope" | "list" = "list";

	#rows: ListRow[] = [];
	#rowIndex = 0;
	#rowHover: number | null = null;
	#listScroll = 0;
	#searchQuery = "";
	#notice: string | null = null;
	#loadError: string | null = null;

	#strip: StripState | null = null;
	#chipRanges: ChipRange[] = [];
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

	// Frame geometry from the last render, for mouse hit-testing.
	#contentRowStart = 1;
	#contentRowCount = 0;
	#sidebarWidthLast = SIDEBAR_MIN_WIDTH;
	#footerRow = 0;
	/** First agent-list row's offset in body-line coordinates (after the status row). */
	#listRowStart = 2;

	private constructor(
		tui: TUI,
		cwd: string,
		settings: Settings,
		modelContext: AgentsHubModelContext,
		callbacks: AgentsHubCallbacks,
	) {
		this.#tui = tui;
		this.#cwd = cwd;
		this.#settings = settings;
		this.#modelContext = modelContext;
		this.#callbacks = callbacks;
		this.#browser = new ModelBrowser(settings, {
			emptyText: () => "  No models available — configure a provider in /models first.",
		});
		this.#browser.setShowProvider(true);
		this.#browser.onActivate = item => this.#commitPickedModel(item);
		this.#browser.onCancel = () => this.#cancelAssign();
	}

	static async create(
		tui: TUI,
		cwd: string,
		settings: Settings,
		modelContext: AgentsHubModelContext = {},
		callbacks: AgentsHubCallbacks = { onCancel: () => {} },
	): Promise<AgentsHubComponent> {
		const hub = new AgentsHubComponent(tui, cwd, settings, modelContext, callbacks);
		await hub.#reload();
		return hub;
	}

	dispose(): void {}
	invalidate(): void {}

	/** Live extension roots for the owning session; settings-only merge fallback when no provider. */
	#extensionRoots(): EffectiveExtensionRoots {
		return (
			this.#modelContext.extensionRoots?.() ?? {
				explicit: [],
				mode: "merge",
				configured: this.#settings.get("extensions") ?? [],
				configuredLevel: this.#settings.extensionsSourceLevel(),
			}
		);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Data pipeline
	// ═══════════════════════════════════════════════════════════════════════

	async #reload(): Promise<void> {
		this.#loadError = null;
		try {
			const selectedName = this.#selectedAgent()?.name;
			const { agents } = await discoverAgents(this.#cwd, undefined, this.#extensionRoots());
			const disabled = new Set(this.#settings.get("task.disabledAgents") ?? []);
			const overrides = this.#settings.get("task.agentModelOverrides") ?? {};
			const prewalkOverrides = this.#settings.get("task.agentPrewalk") ?? {};
			const advisorOverrides = this.#settings.get("task.agentAdvisor") ?? {};
			this.#allAgents = agents
				.slice()
				.sort((a, b) => {
					const sourceCmp = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
					if (sourceCmp !== 0) return sourceCmp;
					return a.name.localeCompare(b.name);
				})
				.map(agent => {
					const override = overrides[agent.name];
					const overrideModel = (Array.isArray(override) ? override.join(",") : (override ?? "")).trim();
					return {
						...agent,
						disabled: disabled.has(agent.name),
						overrideModel: overrideModel || undefined,
						prewalkOverride: prewalkOverrides[agent.name]?.trim() || undefined,
						advisorOverride: advisorOverrides[agent.name]?.trim() || undefined,
					};
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
		this.#tui.requestRender();
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
		const filtered = this.#searchQuery ? scoped.filter(agent => matchAgent(agent, this.#searchQuery)) : scoped;
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
	// Effective per-agent values
	// ═══════════════════════════════════════════════════════════════════════

	#effectiveModelPatterns(agent: HubAgent): string[] {
		return resolveAgentModelPatterns({
			settingsOverride: agent.overrideModel,
			agentModel: agent.model,
			settings: this.#settings,
			activeModelPattern: this.#modelContext.activeModelPattern,
			fallbackModelPattern: this.#modelContext.defaultModelPattern,
		});
	}

	#resolvePatterns(patterns: string[]): string | undefined {
		const registry = this.#modelContext.modelRegistry;
		if (!registry || patterns.length === 0) return undefined;
		const { model, thinkingLevel, explicitThinkingLevel } = resolveModelOverride(patterns, registry, this.#settings);
		if (!model) return undefined;
		const level = explicitThinkingLevel && thinkingLevel ? `:${thinkingLevel}` : "";
		return `${model.provider}/${model.id}${level}`;
	}

	#effectivePrewalkPattern(agent: HubAgent): string | undefined {
		return resolveAgentPrewalkPattern({
			settingsOverride: agent.prewalkOverride,
			agentPrewalk: resolveAgentPrewalkDefault(agent, this.#settings.get("task.prewalk") ?? false),
		});
	}

	#effectiveAdvisorPattern(agent: HubAgent): string | undefined {
		const selection = resolveAgentAdvisorSelection({
			settingsOverride: agent.advisorOverride,
			agentAdvisor: agent.advisor,
		});
		return selection ? (selection.model ?? "@advisor") : undefined;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Mutations
	// ═══════════════════════════════════════════════════════════════════════

	#toggleAgent(agent: HubAgent): void {
		agent.disabled = !agent.disabled;
		const disabled = this.#allAgents
			.filter(entry => entry.disabled)
			.map(entry => entry.name)
			.sort((a, b) => a.localeCompare(b));
		this.#settings.set("task.disabledAgents", disabled);
		this.#notice = `${agent.name} ${agent.disabled ? "disabled" : "enabled"}`;
		this.#tui.requestRender();
	}

	#persistRecord(property: PropertyKind): void {
		const overrides: Record<string, string> = {};
		for (const agent of this.#allAgents) {
			const value = this.#overrideFor(agent, property)?.trim();
			if (value) overrides[agent.name] = value;
		}
		const key =
			property === "model"
				? "task.agentModelOverrides"
				: property === "prewalk"
					? "task.agentPrewalk"
					: "task.agentAdvisor";
		this.#settings.set(key, overrides);
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
		this.#persistRecord(property);
		this.#notice = this.#describeProperty(agent, property);
		this.#tui.requestRender();
	}

	/** One-line effective description used for notices and the status row. */
	#describeProperty(agent: HubAgent, property: PropertyKind): string {
		switch (property) {
			case "model": {
				const patterns = this.#effectiveModelPatterns(agent);
				const resolved = this.#resolvePatterns(patterns);
				const base = agent.overrideModel ?? (patterns.length > 0 ? patterns.join(",") : "session model");
				return `${agent.name} model: ${base}${resolved ? ` → ${resolved}` : ""}`;
			}
			case "prewalk": {
				const pattern = this.#effectivePrewalkPattern(agent);
				return `${agent.name} prewalk: ${pattern ? `on (${pattern})` : "off"}`;
			}
			case "advisor": {
				const pattern = this.#effectiveAdvisorPattern(agent);
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
				const pattern = this.#effectivePrewalkPattern(agent);
				return pattern ?? "off";
			}
			case "advisor": {
				const pattern = this.#effectiveAdvisorPattern(agent);
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
		this.#chipRanges = [];
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
		const registry = this.#modelContext.modelRegistry;
		const models = registry?.getAvailable() ?? [];
		const items = buildBrowserItems(models);
		sortModelItems(items, { mruOrder: this.#settings.getStorage()?.getModelUsageOrder() ?? [] });
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
		this.#tui.requestRender();
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
		this.#tui.requestRender();
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
			this.#tui.requestRender();
			return;
		}
		this.#createGenerating = true;
		this.#createError = null;
		this.#createSpec = null;
		this.#createStreamingText = "";
		this.#tui.requestRender();
		try {
			const spec = await this.#runAgentCreationArchitect(description);
			this.#createSpec = spec;
			this.#notice = null;
		} catch (error) {
			this.#createError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#createGenerating = false;
			this.#tui.requestRender();
		}
	}

	async #runAgentCreationArchitect(description: string): Promise<GeneratedAgentSpec> {
		const modelRegistry = this.#modelContext.modelRegistry;
		if (!modelRegistry) {
			throw new Error("Model registry unavailable in current session.");
		}
		await modelRegistry.refresh();
		const modelPatterns = resolveConfiguredModelPatterns(
			this.#modelContext.activeModelPattern ??
				this.#modelContext.defaultModelPattern ??
				this.#settings.getModelRole("default"),
			this.#settings,
		);
		const { model } = resolveModelOverride(modelPatterns, modelRegistry, this.#settings);
		const selectedModel = model ?? modelRegistry.getAvailable()[0];
		if (!selectedModel) {
			throw new Error("No available model to generate agent specification.");
		}
		const systemPrompt = prompt.render(agentCreationArchitectPrompt, {});
		const userPrompt = prompt.render(agentCreationUserPrompt, { request: description });
		const { session } = await createAgentSession({
			cwd: this.#cwd,
			authStorage: modelRegistry.authStorage,
			modelRegistry,
			settings: this.#settings,
			model: selectedModel,
			systemPrompt: [systemPrompt],
			hasUI: false,
			enableLsp: false,
			enableMCP: false,
			disableExtensionDiscovery: true,
			toolNames: ["__none__"],
			customTools: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		});
		const unsubscribe = session.subscribe(event => {
			if (event.type === "message_update" && "assistantMessageEvent" in event) {
				const ame = event.assistantMessageEvent;
				if (ame.type === "text_delta") {
					this.#createStreamingText += ame.delta;
					this.#tui.requestRender();
				}
			}
		});
		try {
			await session.prompt(userPrompt, { expandPromptTemplates: false });
			const raw = extractAssistantText(session.state.messages);
			if (!raw) {
				throw new Error("No response returned by agent creation architect.");
			}
			return parseGeneratedAgentSpec(raw);
		} finally {
			unsubscribe();
			await session.dispose();
		}
	}

	async #saveGeneratedAgent(): Promise<void> {
		const spec = this.#createSpec;
		if (!spec) return;
		const dirs = getConfigDirs("agents", {
			user: this.#createScope === "user",
			project: this.#createScope === "project",
			cwd: this.#cwd,
		});
		const targetDir = dirs[0]?.path;
		if (!targetDir) {
			throw new Error(`Cannot resolve ${this.#createScope} agents directory.`);
		}
		const filePath = path.join(targetDir, `${spec.identifier}.md`);
		try {
			await fs.stat(filePath);
			throw new Error(`Agent file already exists: ${shortenPath(filePath)}`);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const frontmatter = YAML.stringify({ name: spec.identifier, description: spec.whenToUse }, null, 2).trimEnd();
		const content = `---\n${frontmatter}\n---\n\n${spec.systemPrompt.trim()}\n`;
		await Bun.write(filePath, content);
		await refreshAgentDiscovery(this.#cwd, this.#extensionRoots());
		this.#clearCreateFlow();
		this.#notice = `Created agent ${spec.identifier} at ${shortenPath(filePath)}`;
		await this.#reload();
	}

	// ═══════════════════════════════════════════════════════════════════════
	// Input
	// ═══════════════════════════════════════════════════════════════════════

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
			this.#tui.requestRender();
			return;
		}

		if (this.#strip) {
			this.#handleStripInput(data);
			this.#tui.requestRender();
			return;
		}

		if (this.#createActive) {
			this.#handleCreateInput(data);
			this.#tui.requestRender();
			return;
		}

		if (matchesSelectCancel(data)) {
			if (this.#assigning) {
				this.#cancelAssign();
				return;
			}
			if (this.#searchQuery.length > 0) {
				this.#searchQuery = "";
				this.#buildRows();
				this.#clampRowIndex();
				this.#tui.requestRender();
				return;
			}
			this.#callbacks.onCancel();
			return;
		}

		if (this.#assigning) {
			this.#browser.handleInput(data);
			this.#tui.requestRender();
			return;
		}

		if (matchesKey(data, "ctrl+r")) {
			void this.#reload();
			return;
		}

		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#focus = this.#focus === "scope" ? "list" : "scope";
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "left")) {
			this.#focus = "scope";
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "right")) {
			this.#focus = "list";
			this.#tui.requestRender();
			return;
		}

		if (this.#focus === "scope") {
			if (matchesSelectUp(data)) {
				this.#moveSidebar(-1);
				this.#tui.requestRender();
				return;
			}
			if (matchesSelectDown(data)) {
				this.#moveSidebar(1);
				this.#tui.requestRender();
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				if (this.#activeEntry().kind === "new") {
					this.#beginCreateFlow();
				} else {
					this.#focus = "list";
				}
				this.#tui.requestRender();
				return;
			}
		}

		if (matchesSelectUp(data)) {
			this.#rowIndex = Math.max(0, this.#rowIndex - 1);
			this.#tui.requestRender();
			return;
		}
		if (matchesSelectDown(data)) {
			this.#rowIndex = Math.min(this.#rows.length - 1, this.#rowIndex + 1);
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#activateRow(this.#rows[this.#rowIndex]);
			this.#tui.requestRender();
			return;
		}
		if (data === " " && this.#searchQuery.length === 0) {
			const agent = this.#selectedAgent();
			if (agent) this.#toggleAgent(agent);
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.#searchQuery.length > 0) {
				this.#searchQuery = this.#searchQuery.slice(0, -1);
				this.#buildRows();
				this.#clampRowIndex();
				this.#tui.requestRender();
			}
			return;
		}
		// Type-to-filter: any printable character extends the query.
		if (data.length === 1 && data >= " " && data !== "\x7f") {
			this.#searchQuery += data;
			this.#focus = "list";
			this.#buildRows();
			this.#rowIndex = 0;
			this.#listScroll = 0;
			this.#tui.requestRender();
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
			// A property strip steps back up to the agent strip instead of closing.
			if (strip.kind === "chips" && strip.property) {
				this.#openAgentStrip(strip.agent);
				return;
			}
			if (strip.kind === "pattern") {
				this.#openPropertyStrip(strip.agent, strip.property);
				return;
			}
			this.#closeStrip();
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
		if (matchesKey(data, "left") || matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
			strip.index = (strip.index - 1 + strip.chips.length) % strip.chips.length;
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "down") || matchesKey(data, "tab")) {
			strip.index = (strip.index + 1) % strip.chips.length;
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#activateStripChip();
			return;
		}
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
					this.#tui.requestRender();
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
		const contentLine = event.row - this.#contentRowStart;
		const overContent = contentLine >= 0 && contentLine < this.#contentRowCount;
		const sidebarColEnd = 2 + this.#sidebarWidthLast;
		const bodyColStart = this.#sidebarWidthLast + 5;
		const overSidebar = overContent && event.col >= 0 && event.col < sidebarColEnd;
		const overBody = overContent && event.col >= bodyColStart;
		const bodyLine = contentLine - 1; // body row 0 is the status row

		if (event.row === this.#footerRow && this.#strip?.kind === "chips") {
			const strip = this.#strip;
			if (event.leftClick) {
				for (const range of this.#chipRanges) {
					if (event.col >= range.start && event.col < range.end) {
						strip.index = range.index;
						this.#activateStripChip();
						return true;
					}
				}
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
				const maxScroll = Math.max(0, this.#entries.length - this.#contentRowCount);
				this.#sidebarScroll = Math.max(0, Math.min(this.#sidebarScroll + event.wheel, maxScroll));
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
			const index = this.#sidebarScroll + contentLine;
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

	#sidebarWidth(): number {
		let longest = 0;
		for (const entry of this.#entries) {
			longest = Math.max(longest, visibleWidth(entry.label) + visibleWidth(entry.annotation ?? "") + 5);
		}
		return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, longest));
	}

	#renderSidebar(width: number, rows: number): string[] {
		const activeIndex = Math.max(
			0,
			this.#entries.findIndex(entry => entry.id === this.#activeEntryId),
		);
		if (activeIndex < this.#sidebarScroll) this.#sidebarScroll = activeIndex;
		else if (activeIndex >= this.#sidebarScroll + rows) this.#sidebarScroll = activeIndex - rows + 1;

		const lines: string[] = [];
		for (let i = this.#sidebarScroll; i < Math.min(this.#entries.length, this.#sidebarScroll + rows); i++) {
			const entry = this.#entries[i];
			if (!entry) continue;
			if (entry.kind === "separator") {
				lines.push(theme.fg("border", "─".repeat(width)));
				continue;
			}
			const active = entry.id === this.#activeEntryId;
			const cursor = active && this.#focus === "scope" ? theme.fg("accent", theme.nav.cursor) : " ";
			const icon = entry.kind === "all" ? theme.icon.model : entry.kind === "new" ? "+" : theme.status.enabled;
			const labelStyled = active ? theme.bold(theme.fg("accent", entry.label)) : entry.label;
			const left = `${cursor} ${theme.fg(entry.kind === "new" ? "dim" : "accent", icon)} ${labelStyled}`;
			const annotation = theme.fg("dim", entry.annotation ?? "");
			const leftWidth = visibleWidth(left);
			const annWidth = visibleWidth(annotation);
			let line: string;
			if (leftWidth + annWidth + 1 <= width) {
				line = `${left}${" ".repeat(width - leftWidth - annWidth)}${annotation}`;
			} else {
				line = truncateToWidth(left, width);
			}
			lines.push(line);
		}
		return lines;
	}

	#statusRow(width: number): string {
		if (this.#loadError) return truncateToWidth(theme.fg("error", ` ${this.#loadError}`), width);
		if (this.#assigning) {
			const { agent, property } = this.#assigning;
			const what = property === "model" ? "model override" : `${property} model`;
			return truncateToWidth(
				theme.fg("accent", ` Picking ${what} for ${theme.bold(agent.name)} — Enter assigns, Esc cancels`),
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
		const searchText = this.#searchQuery ? theme.fg("accent", this.#searchQuery) : theme.fg("dim", "type to filter");
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
			const prewalk = this.#effectivePrewalkPattern(agent);
			if (prewalk) badges.push(theme.fg("dim", `pre:${prewalk}`));
			const advisor = this.#effectiveAdvisorPattern(agent);
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
			const patterns = this.#effectiveModelPatterns(agent);
			const resolved = this.#resolvePatterns(patterns);
			const modelLine = `${theme.fg("muted", "model:")} ${patterns.length > 0 ? replaceTabs(patterns.join(",")) : theme.fg("dim", "(session model)")}${resolved ? ` ${theme.fg("dim", "→")} ${theme.fg("success", resolved)}` : ""}`;
			lines.push(truncateToWidth(` ${modelLine}`, width));
			const prewalk = this.#effectivePrewalkPattern(agent);
			const advisor = this.#effectiveAdvisorPattern(agent);
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
		if (this.#strip) {
			if (this.#strip.kind === "pattern") {
				const property = this.#strip.property;
				const values = property === "model" ? "a model pattern" : '"on", "off", or a model pattern';
				return `Enter ${values} (role aliases like @smol and :level suffixes work; empty clears) · Esc back`;
			}
			return this.#strip.property ? "←/→ choose · Enter apply · Esc back" : "←/→ choose · Enter open · Esc cancel";
		}
		if (this.#assigning) {
			return "Enter pick · ↑/↓ models · type to search · Esc cancel";
		}
		if (this.#createActive) {
			if (this.#createSpec) return "Enter save · Tab scope · r regenerate · Esc cancel";
			if (this.#createGenerating) return "Generating…";
			return "Ctrl+Q/Ctrl+Enter generate · Enter newline · Tab scope · Esc cancel";
		}
		if (this.#focus === "scope") {
			return "↑/↓ scopes · →/Enter agents · Esc close";
		}
		return "Enter configure · Space enable/disable · ↑/↓ rows · type to search · Ctrl+R reload · Esc close";
	}

	#renderFooter(width: number): string {
		this.#chipRanges = [];
		const strip = this.#strip;
		if (!strip) {
			return truncateToWidth(theme.fg("dim", this.#footerHint()), width);
		}
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
		let line = prefix;
		let col = 2 + visibleWidth(prefix);
		for (let i = 0; i < strip.chips.length; i++) {
			const chip = strip.chips[i];
			if (!chip) continue;
			const selected = i === strip.index;
			const body = ` ${chip.styled} `;
			const rendered = selected
				? theme.bg("selectedBg", `${theme.fg("accent", "[")}${body}${theme.fg("accent", "]")}`)
				: body;
			const w = visibleWidth(body) + (selected ? 2 : 0);
			this.#chipRanges.push({ start: col, end: col + w, index: i });
			line += rendered;
			col += w;
			line += " ";
			col += 1;
		}
		return truncateToWidth(line, width);
	}

	render(width: number): string[] {
		const height = this.#terminalRows();
		const sidebarWidth = this.#sidebarWidth();
		this.#sidebarWidthLast = sidebarWidth;
		const bodyWidth = splitBodyWidth(width, sidebarWidth);
		const contentRows = Math.max(10, height - 4);
		this.#contentRowCount = contentRows;

		const bodyLines: string[] = [this.#statusRow(bodyWidth)];
		if (this.#createActive) {
			bodyLines.push(...this.#renderCreate(bodyWidth, contentRows - 1));
		} else if (this.#assigning) {
			this.#browser.setMaxVisible(contentRows - 1 - 5);
			this.#browser.setFocused(true);
			bodyLines.push(...this.#browser.render(bodyWidth));
		} else {
			bodyLines.push(...this.#renderList(bodyWidth, contentRows - 1));
		}

		const sidebarLines = this.#renderSidebar(sidebarWidth, contentRows);
		const out: string[] = [];
		out.push(topBorderSplit(width, "Agents", sidebarWidth));
		this.#contentRowStart = out.length;
		for (let i = 0; i < contentRows; i++) {
			out.push(splitRow(sidebarLines[i] ?? "", bodyLines[i] ?? "", width, sidebarWidth));
		}
		out.push(dividerSplit(width, sidebarWidth));
		this.#footerRow = out.length;
		out.push(row(this.#renderFooter(width - 4), width));
		out.push(bottomBorder(width));
		return out;
	}
}
