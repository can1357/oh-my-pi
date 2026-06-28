/**
 * AgentDashboard - dedicated control center for Task subagent configuration.
 *
 * Layout:
 * - Top: source tabs (All, Project, User, Bundled)
 * - Body: two-column view (agent list + inspector)
 *
 * Controls:
 * - Up/Down or j/k: move selection
 * - Tab / Shift+Tab or Left/Right: switch source tab
 * - Space: enable/disable selected agent
 * - Enter: edit model override for selected agent
 * - N: start agent creation flow
 * - Esc: clear search (if any) or close dashboard
 * - Ctrl+R: reload discovered agents
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import {
	type Component,
	Container,
	Editor,
	fuzzyMatch,
	Input,
	matchesKey,
	padding,
	replaceTabs,
	ScrollView,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@pk-nerdsaver-ai/pi-tui";
import { isEnoent, prompt } from "@pk-nerdsaver-ai/pi-utils";
import { YAML } from "bun";
import { getConfigDirs } from "../../config";
import type { ModelRegistry } from "../../config/model-registry";
import {
	formatModelString,
	resolveAgentModelPatterns,
	resolveConfiguredModelPatterns,
	resolveModelOverride,
} from "../../config/model-resolver";
import { Settings } from "../../config/settings";
import agentCreationArchitectPrompt from "../../prompts/system/agent-creation-architect.md" with { type: "text" };
import agentCreationUserPrompt from "../../prompts/system/agent-creation-user.md" with { type: "text" };
import { createAgentSession } from "../../sdk";
import { discoverAgents } from "../../task/discovery";
import type { AgentDefinition, AgentSource } from "../../task/types";
import { shortenPath } from "../../tools/render-utils";
import { getEditorTheme, theme } from "../theme/theme";
import {
	matchesAppFollowUp,
	matchesAppInterrupt,
	matchesSelectDown,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import { DynamicBorder } from "./dynamic-border";
import { clampSelection, handleTabSwitchKey, padLinesToHeight, searchableChar } from "./selector-helpers";

type SourceTabId = "all" | AgentSource;
type AgentScope = "project" | "user";

interface SourceTab {
	id: SourceTabId;
	label: string;
	count: number;
}

interface DashboardAgent extends AgentDefinition {
	disabled: boolean;
	overrideModel?: string;
}

interface ModelResolution {
	resolved: string;
	thinkingLevel?: string;
	explicitThinkingLevel: boolean;
}

interface GeneratedAgentSpec {
	identifier: string;
	whenToUse: string;
	systemPrompt: string;
}

interface AgentDashboardModelContext {
	modelRegistry?: ModelRegistry;
	activeModelPattern?: string;
	defaultModelPattern?: string;
}

const SOURCE_ORDER: Record<AgentSource, number> = {
	project: 0,
	user: 1,
	bundled: 2,
};

const SOURCE_LABEL: Record<AgentSource, string> = {
	project: "Project",
	user: "User",
	bundled: "Bundled",
};

const LIST_FOOTER =
	" ↑/↓: navigate  Space: toggle  Enter: model override  N: new agent  ←/→: source  Ctrl+R: reload  Esc: close";

const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+){1,5}$/;
function joinPatterns(patterns: string[]): string {
	if (patterns.length === 0) return "(session model)";
	return patterns.join(", ");
}

function formatResolution(resolution: ModelResolution): string {
	const resolved = theme.fg("success", resolution.resolved);
	if (!resolution.explicitThinkingLevel || !resolution.thinkingLevel) return resolved;
	return `${resolved} ${theme.fg("dim", `(${resolution.thinkingLevel})`)}`;
}

function matchAgent(agent: DashboardAgent, query: string): boolean {
	const text = `${agent.name} ${agent.description} ${SOURCE_LABEL[agent.source]} ${agent.overrideModel ?? ""}`;
	return query
		.trim()
		.split(/\s+/)
		.every(token => fuzzyMatch(token, text).matches);
}

function extractAssistantText(messages: AgentMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const blocks = message.content;
		if (!Array.isArray(blocks)) continue;
		const text = blocks
			.map(block => {
				if (!block || typeof block !== "object") return "";
				if (!("type" in block) || (block as { type?: unknown }).type !== "text") return "";
				const value = (block as { text?: unknown }).text;
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
	if (fenceMatch?.[1]) {
		return fenceMatch[1].trim();
	}
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start >= 0 && end >= start) {
		return raw.slice(start, end + 1).trim();
	}
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

class AgentListPane implements Component {
	constructor(
		private readonly agents: DashboardAgent[],
		private readonly selectedIndex: number,
		private readonly scrollOffset: number,
		private readonly searchQuery: string,
		private readonly maxVisible: number,
	) {}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		const searchPrefix = theme.fg("muted", "Search: ");
		const searchText = this.searchQuery || theme.fg("dim", "type to filter");
		lines.push(`${searchPrefix}${searchText}`);
		lines.push("");

		if (this.agents.length === 0) {
			lines.push(theme.fg("muted", "  No agents found."));
			return lines;
		}

		const overflow = this.agents.length > this.maxVisible;
		const rowWidth = Math.max(0, width - (overflow ? 1 : 0));
		const start = this.scrollOffset;
		const end = Math.min(start + this.maxVisible, this.agents.length);

		const rows: string[] = [];
		for (let i = start; i < end; i++) {
			const agent = this.agents[i];
			const selected = i === this.selectedIndex;
			const status = agent.disabled
				? theme.fg("dim", theme.status.disabled)
				: theme.fg("success", theme.status.enabled);
			const source = theme.fg("dim", `[${SOURCE_LABEL[agent.source]}]`);
			const override = agent.overrideModel ? ` ${theme.fg("warning", "(override)")}` : "";
			let line = ` ${status} ${replaceTabs(agent.name)} ${source}${override}`;

			if (selected) {
				line = theme.bg("selectedBg", theme.bold(theme.fg("accent", line)));
			} else if (agent.disabled) {
				line = theme.fg("dim", line);
			}

			rows.push(truncateToWidth(line, rowWidth));
		}

		const sv = new ScrollView(rows, {
			height: rows.length,
			scrollbar: "auto",
			totalRows: this.agents.length,
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		sv.setScrollOffset(this.scrollOffset);
		lines.push(...sv.render(width));

		return lines;
	}

	invalidate(): void {}
}

class AgentInspectorPane implements Component {
	constructor(
		private readonly agent: DashboardAgent | null,
		private readonly defaultPatterns: string[],
		private readonly defaultResolution: ModelResolution | undefined,
		private readonly effectivePatterns: string[],
		private readonly effectiveResolution: ModelResolution | undefined,
	) {}

	render(width: number): readonly string[] {
		if (!this.agent) {
			return [theme.fg("muted", "Select an agent"), theme.fg("dim", "to inspect settings")];
		}

		const lines: string[] = [];
		const state = this.agent.disabled
			? theme.fg("dim", `${theme.status.disabled} Disabled`)
			: theme.fg("success", `${theme.status.enabled} Enabled`);

		lines.push(theme.bold(theme.fg("accent", replaceTabs(this.agent.name))));
		lines.push("");
		lines.push(`${theme.fg("muted", "Status:")} ${state}`);
		lines.push(`${theme.fg("muted", "Source:")} ${SOURCE_LABEL[this.agent.source]}`);
		lines.push("");

		lines.push(`${theme.fg("muted", "Default pattern:")} ${replaceTabs(joinPatterns(this.defaultPatterns))}`);
		lines.push(
			`${theme.fg("muted", "Default resolves:")} ${this.defaultResolution ? this.#formatResolution(this.defaultResolution) : theme.fg("dim", "(unresolved)")}`,
		);
		lines.push(
			`${theme.fg("muted", "Override:")} ${this.agent.overrideModel ? theme.fg("warning", replaceTabs(this.agent.overrideModel)) : theme.fg("dim", "(none)")}`,
		);
		lines.push(`${theme.fg("muted", "Effective pattern:")} ${replaceTabs(joinPatterns(this.effectivePatterns))}`);
		lines.push(
			`${theme.fg("muted", "Effective:")} ${this.effectiveResolution ? this.#formatResolution(this.effectiveResolution) : theme.fg("dim", "(unresolved)")}`,
		);

		if (this.agent.filePath) {
			lines.push("");
			lines.push(theme.fg("muted", "Path:"));
			lines.push(theme.fg("dim", `  ${replaceTabs(shortenPath(this.agent.filePath))}`));
		}

		if (this.agent.description) {
			lines.push("");
			lines.push(theme.fg("muted", "Description:"));
			for (const wrapped of wrapTextWithAnsi(replaceTabs(this.agent.description), Math.max(10, width - 2))) {
				lines.push(truncateToWidth(wrapped, width));
			}
		}

		return lines;
	}

	#formatResolution(resolution: ModelResolution): string {
		return formatResolution(resolution);
	}

	invalidate(): void {}
}

class TwoColumnBody implements Component {
	constructor(
		private readonly leftPane: AgentListPane,
		private readonly rightPane: AgentInspectorPane,
		private readonly maxHeight: number,
	) {}

	render(width: number): readonly string[] {
		const leftWidth = Math.floor(width * 0.5);
		const rightWidth = width - leftWidth - 3;
		const leftLines = this.leftPane.render(leftWidth);
		const rightLines = this.rightPane.render(rightWidth);
		const lineCount = this.maxHeight;
		const out: string[] = [];
		const separator = theme.fg("dim", ` ${theme.boxRound.vertical} `);

		for (let i = 0; i < lineCount; i++) {
			const left = truncateToWidth(leftLines[i] ?? "", leftWidth);
			const leftPadded = left + padding(Math.max(0, leftWidth - visibleWidth(left)));
			const right = truncateToWidth(rightLines[i] ?? "", rightWidth);
			out.push(leftPadded + separator + right);
		}

		return out;
	}

	invalidate(): void {
		this.leftPane.invalidate?.();
		this.rightPane.invalidate?.();
	}
}

export class AgentDashboard extends Container {
	#settingsManager: Settings | null = null;
	#allAgents: DashboardAgent[] = [];
	#filteredAgents: DashboardAgent[] = [];
	#tabs: SourceTab[] = [{ id: "all", label: "All", count: 0 }];
	#activeTabIndex = 0;
	#selectedIndex = 0;
	#scrollOffset = 0;
	#searchQuery = "";
	#loading = true;
	#loadError: string | null = null;
	#notice: string | null = null;
	#builtRows = -1;
	#builtCols = -1;

	#editInput: Input | null = null;
	#editingAgentName: string | null = null;

	#createInput: Editor | null = null;
	#createDescription = "";
	#createScope: AgentScope = "project";
	#createGenerating = false;
	#createSpec: GeneratedAgentSpec | null = null;
	#createError: string | null = null;
	#createStreamingText = "";

	onClose?: () => void;
	onRequestRender?: () => void;

	private constructor(
		private readonly cwd: string,
		private readonly settings: Settings | null,
		private readonly terminalHeight: number,
		private readonly modelContext: AgentDashboardModelContext,
	) {
		super();
	}

	static async create(
		cwd: string,
		settings: Settings | null = null,
		terminalHeight?: number,
		modelContext: AgentDashboardModelContext = {},
	): Promise<AgentDashboard> {
		const dashboard = new AgentDashboard(cwd, settings, terminalHeight ?? process.stdout.rows ?? 24, modelContext);
		await dashboard.#init();
		return dashboard;
	}

	async #init(): Promise<void> {
		this.#settingsManager = this.settings ?? (await Settings.init());
		await this.#reloadData();
		this.#buildLayout();
	}

	async #reloadData(): Promise<void> {
		this.#loading = true;
		this.#loadError = null;
		this.#buildLayout();

		try {
			const selectedName = this.#selectedAgent()?.name;
			const activeTabId = this.#tabs[this.#activeTabIndex]?.id ?? "all";
			const { agents } = await discoverAgents(this.cwd);
			const disabled = new Set((this.#settingsManager?.get("task.disabledAgents") as string[] | undefined) ?? []);
			const overrides = this.#settingsManager?.get("task.agentModelOverrides") ?? {};

			this.#allAgents = agents
				.slice()
				.sort((a, b) => {
					const sourceCmp = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
					if (sourceCmp !== 0) return sourceCmp;
					return a.name.localeCompare(b.name);
				})
				.map(agent => ({
					...agent,
					disabled: disabled.has(agent.name),
					overrideModel: overrides[agent.name]?.trim() || undefined,
				}));

			this.#tabs = this.#buildTabs(this.#allAgents);
			const nextTabIndex = this.#tabs.findIndex(tab => tab.id === activeTabId);
			this.#activeTabIndex = nextTabIndex >= 0 ? nextTabIndex : 0;
			this.#applyFilters();

			if (selectedName) {
				const idx = this.#filteredAgents.findIndex(agent => agent.name === selectedName);
				if (idx >= 0) {
					this.#selectedIndex = idx;
				}
			}
			this.#clampSelection();
		} catch (error) {
			this.#allAgents = [];
			this.#filteredAgents = [];
			this.#tabs = [{ id: "all", label: "All", count: 0 }];
			this.#activeTabIndex = 0;
			this.#selectedIndex = 0;
			this.#scrollOffset = 0;
			this.#loadError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#loading = false;
			this.#rebuildAndRender();
		}
	}

	#buildTabs(agents: DashboardAgent[]): SourceTab[] {
		const tabs: SourceTab[] = [{ id: "all", label: "All", count: agents.length }];
		const counts: Record<AgentSource, number> = { project: 0, user: 0, bundled: 0 };

		for (const agent of agents) {
			counts[agent.source] += 1;
		}

		for (const source of ["project", "user", "bundled"] as const) {
			if (counts[source] > 0) {
				tabs.push({ id: source, label: SOURCE_LABEL[source], count: counts[source] });
			}
		}

		return tabs;
	}

	#selectedAgent(): DashboardAgent | null {
		return this.#filteredAgents[this.#selectedIndex] ?? null;
	}

	#applyFilters(): void {
		const activeTab = this.#tabs[this.#activeTabIndex] ?? this.#tabs[0];
		const tabFiltered =
			activeTab.id === "all" ? this.#allAgents : this.#allAgents.filter(agent => agent.source === activeTab.id);

		if (!this.#searchQuery) {
			this.#filteredAgents = tabFiltered;
		} else {
			this.#filteredAgents = tabFiltered.filter(agent => matchAgent(agent, this.#searchQuery));
		}

		this.#clampSelection();
	}

	/** Live terminal height so the dashboard tracks resize while open. */
	#terminalRows(): number {
		return process.stdout.rows || this.terminalHeight || 24;
	}

	#noticeBlockLines(): number {
		if (!this.#notice) return 0;
		return wrapTextWithAnsi(theme.fg("success", replaceTabs(this.#notice)), this.#uiWidth()).length + 1;
	}

	#footerLines(): number {
		return Math.max(1, wrapTextWithAnsi(theme.fg("dim", LIST_FOOTER), this.#uiWidth()).length);
	}

	/** Height budget for the two-column body, sized to the live terminal. */
	#computeBodyHeight(): number {
		// Chrome around the body: top border + title + tab bar + spacer (4),
		// optional notice block, then spacer + footer + bottom border.
		const chrome = 4 + this.#noticeBlockLines() + 1 + this.#footerLines() + 1;
		return Math.max(5, this.#terminalRows() - chrome);
	}

	#getMaxVisibleItems(): number {
		// List pane chrome inside the body: search line, blank line, count line.
		return Math.max(3, this.#computeBodyHeight() - 3);
	}

	override render(width: number): readonly string[] {
		// Rebuild when terminal geometry changes so the full-screen overlay
		// re-fits on resize.
		if (this.#terminalRows() !== this.#builtRows || this.#uiWidth() !== this.#builtCols) {
			this.#buildLayout();
		}
		const lines = super.render(width);
		// Pad to the full viewport so every state (list, edit, create) covers the
		// screen as a true full-screen view instead of letting the transcript peek
		// through below it.
		return padLinesToHeight(lines, this.#terminalRows());
	}

	#clampSelection(): void {
		const next = clampSelection(
			this.#selectedIndex,
			this.#scrollOffset,
			this.#filteredAgents.length,
			this.#getMaxVisibleItems(),
		);
		this.#selectedIndex = next.selectedIndex;
		this.#scrollOffset = next.scrollOffset;
	}

	#persistDisabledAgents(): void {
		if (!this.#settingsManager) return;
		const disabled = this.#allAgents
			.filter(agent => agent.disabled)
			.map(agent => agent.name)
			.sort((a, b) => a.localeCompare(b));
		this.#settingsManager.set("task.disabledAgents", disabled);
	}

	#persistModelOverrides(): void {
		if (!this.#settingsManager) return;
		const overrides: Record<string, string> = {};
		for (const agent of this.#allAgents) {
			const value = agent.overrideModel?.trim();
			if (value) {
				overrides[agent.name] = value;
			}
		}
		this.#settingsManager.set("task.agentModelOverrides", overrides);
	}

	#toggleSelectedAgent(): void {
		const selected = this.#selectedAgent();
		if (!selected) return;
		selected.disabled = !selected.disabled;
		this.#persistDisabledAgents();
		this.#buildLayout();
	}

	#beginModelEdit(): void {
		const selected = this.#selectedAgent();
		if (!selected) return;
		this.#createError = null;
		this.#editingAgentName = selected.name;
		this.#editInput = new Input();
		if (selected.overrideModel) {
			this.#editInput.setValue(selected.overrideModel);
		}
		this.#editInput.onSubmit = value => {
			this.#saveModelOverride(value);
		};
		this.#buildLayout();
	}

	#saveModelOverride(rawValue: string): void {
		if (!this.#editingAgentName) return;
		const selected = this.#allAgents.find(agent => agent.name === this.#editingAgentName);
		if (!selected) return;
		const value = rawValue.trim();
		selected.overrideModel = value || undefined;
		this.#persistModelOverrides();
		this.#editingAgentName = null;
		this.#editInput = null;
		this.#applyFilters();
		this.#notice = `Updated model override for ${selected.name}`;
		this.#buildLayout();
	}

	#cancelModelEdit(): void {
		this.#editingAgentName = null;
		this.#editInput = null;
		this.#buildLayout();
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
		this.#buildLayout();
	}

	#clearCreateFlow(): void {
		this.#createInput = null;
		this.#createDescription = "";
		this.#createGenerating = false;
		this.#createSpec = null;
		this.#createError = null;
		this.#createStreamingText = "";
	}

	#toggleCreateScope(): void {
		this.#createScope = this.#createScope === "project" ? "user" : "project";
		this.#buildLayout();
	}

	#submitCreateDescription(): void {
		if (!this.#createInput || this.#createGenerating) return;
		const description = this.#createInput.getExpandedText();
		this.#createDescription = description;
		void this.#generateAgentFromDescription(description);
	}

	#insertCreateNewline(): void {
		if (!this.#createInput || this.#createGenerating) return;
		this.#createInput.handleInput("\n");
		this.#createDescription = this.#createInput.getExpandedText();
		this.#buildLayout();
	}

	async #generateAgentFromDescription(rawDescription: string): Promise<void> {
		const description = rawDescription.trim();
		this.#createDescription = description;
		if (!description) {
			this.#createError = "Description is required.";
			this.#buildLayout();
			return;
		}

		this.#createGenerating = true;
		this.#createError = null;
		this.#createSpec = null;
		this.#createStreamingText = "";
		this.#buildLayout();

		try {
			const spec = await this.#runAgentCreationArchitect(description);
			this.#createSpec = spec;
			this.#notice = null;
		} catch (error) {
			this.#createError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#createGenerating = false;
			this.#rebuildAndRender();
		}
	}

	async #runAgentCreationArchitect(description: string): Promise<GeneratedAgentSpec> {
		const modelRegistry = this.modelContext.modelRegistry;
		if (!modelRegistry) {
			throw new Error("Model registry unavailable in current session.");
		}
		await modelRegistry.refresh();

		const settings = this.#settingsManager ?? undefined;
		const modelPatterns = resolveConfiguredModelPatterns(
			this.modelContext.activeModelPattern ??
				this.modelContext.defaultModelPattern ??
				settings?.getModelRole("default"),
			settings,
		);
		const { model } = resolveModelOverride(modelPatterns, modelRegistry, settings);
		const fallbackModel = modelRegistry.getAvailable()[0];
		const selectedModel = model ?? fallbackModel;
		if (!selectedModel) {
			throw new Error("No available model to generate agent specification.");
		}

		const systemPrompt = prompt.render(agentCreationArchitectPrompt, {});
		const userPrompt = prompt.render(agentCreationUserPrompt, { request: description });

		const { session } = await createAgentSession({
			cwd: this.cwd,
			authStorage: modelRegistry.authStorage,
			modelRegistry,
			settings,
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
					this.#rebuildAndRender();
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
			cwd: this.cwd,
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
			if (!isEnoent(error)) {
				throw error;
			}
		}

		const frontmatter = YAML.stringify(
			{
				name: spec.identifier,
				description: spec.whenToUse,
			},
			null,
			2,
		).trimEnd();
		const content = `---\n${frontmatter}\n---\n\n${spec.systemPrompt.trim()}\n`;
		await Bun.write(filePath, content);
		await this.#reloadData();
		this.#clearCreateFlow();
		this.#notice = `Created agent ${spec.identifier} at ${shortenPath(filePath)}`;
		this.#rebuildAndRender();
	}

	#getModelSuggestions(input: string): string[] {
		const modelRegistry = this.modelContext.modelRegistry;
		if (!modelRegistry) return [];
		const query = input.trim().toLowerCase();
		if (!query) return [];
		const available = modelRegistry.getAvailable();
		const seen = new Set<string>();
		const matches: string[] = [];
		for (const model of available) {
			const full = `${model.provider}/${model.id}`;
			if (seen.has(full)) continue;
			if (!full.toLowerCase().includes(query)) continue;
			seen.add(full);
			matches.push(full);
			if (matches.length >= 5) break;
		}
		return matches;
	}

	#switchTab(direction: 1 | -1): void {
		if (this.#tabs.length === 0) return;
		this.#activeTabIndex = (this.#activeTabIndex + direction + this.#tabs.length) % this.#tabs.length;
		this.#selectedIndex = 0;
		this.#scrollOffset = 0;
		this.#applyFilters();
		this.#buildLayout();
	}

	#moveSelection(delta: -1 | 1): void {
		if (this.#filteredAgents.length === 0) return;
		this.#selectedIndex = Math.max(0, Math.min(this.#filteredAgents.length - 1, this.#selectedIndex + delta));
		this.#clampSelection();
		this.#buildLayout();
	}

	#defaultPatternsFor(agent: DashboardAgent): string[] {
		return resolveAgentModelPatterns({
			agentModel: agent.model,
			settings: this.#settingsManager ?? undefined,
			activeModelPattern: this.modelContext.activeModelPattern,
			fallbackModelPattern: this.modelContext.defaultModelPattern,
		});
	}

	#effectivePatternsFor(agent: DashboardAgent, draftOverride: string | undefined): string[] {
		return resolveAgentModelPatterns({
			settingsOverride: draftOverride,
			agentModel: agent.model,
			settings: this.#settingsManager ?? undefined,
			activeModelPattern: this.modelContext.activeModelPattern,
			fallbackModelPattern: this.modelContext.defaultModelPattern,
		});
	}

	#resolvePatterns(patterns: string[]): ModelResolution | undefined {
		const modelRegistry = this.modelContext.modelRegistry;
		if (!modelRegistry || patterns.length === 0) return undefined;
		const { model, thinkingLevel, explicitThinkingLevel } = resolveModelOverride(
			patterns,
			modelRegistry,
			this.#settingsManager ?? undefined,
		);
		if (!model) return undefined;
		return {
			resolved: formatModelString(model),
			thinkingLevel,
			explicitThinkingLevel,
		};
	}

	#renderTabBar(): string {
		const parts: string[] = [" "];
		for (let i = 0; i < this.#tabs.length; i++) {
			const tab = this.#tabs[i];
			const label = `${tab.label} (${tab.count})`;
			if (i === this.#activeTabIndex) {
				parts.push(theme.bg("selectedBg", ` ${label} `));
			} else {
				parts.push(theme.fg("muted", ` ${label} `));
			}
		}
		return parts.join("");
	}
	#renderCreateInput(): void {
		this.addChild(new Text(theme.bold(theme.fg("accent", " Create New Agent")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "Describe what the new agent should do:"), 0, 0));
		this.addChild(new Spacer(1));
		if (this.#createInput) {
			this.#createInput.setMaxHeight(Math.max(3, Math.min(8, this.#terminalRows() - 12)));
			this.addChild(this.#createInput);
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", `Scope: ${this.#createScope}`), 0, 0));
		if (this.#createGenerating) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("accent", "Generating agent specification..."), 0, 0));
			if (this.#createStreamingText) {
				this.addChild(new Spacer(1));
				const maxPreview = Math.max(3, this.#terminalRows() - 18);
				const contentWidth = Math.max(20, this.#uiWidth() - 4);
				const wrappedLines: string[] = [];
				for (const raw of this.#createStreamingText.split("\n")) {
					for (const w of wrapTextWithAnsi(replaceTabs(raw), contentWidth)) {
						wrappedLines.push(w);
					}
				}
				const tail = wrappedLines.slice(-maxPreview);
				if (wrappedLines.length > maxPreview) {
					this.addChild(new Text(theme.fg("dim", `  ... ${wrappedLines.length - maxPreview} lines above`), 0, 0));
				}
				for (const line of tail) {
					this.addChild(new Text(theme.fg("dim", `  ${line}`), 0, 0));
				}
			}
		}
		if (this.#createError) {
			this.addChild(new Text(theme.fg("error", replaceTabs(this.#createError)), 0, 0));
		}
		this.addChild(new Spacer(1));
		const hints = this.#createGenerating
			? " Generating..."
			: " Ctrl+Q/Ctrl+Enter: generate  Enter: newline  Tab: toggle scope  Esc: cancel";
		this.addChild(new Text(theme.fg("dim", hints), 0, 0));
	}

	#renderCreateReview(): void {
		const spec = this.#createSpec;
		if (!spec) return;

		this.addChild(new Text(theme.bold(theme.fg("accent", " Review Generated Agent")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", `Identifier: ${spec.identifier}`), 0, 0));
		this.addChild(new Text(theme.fg("muted", `Scope: ${this.#createScope}`), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "whenToUse:"), 0, 0));
		for (const line of wrapTextWithAnsi(replaceTabs(spec.whenToUse), Math.max(20, this.#uiWidth() - 2)).slice(0, 8)) {
			this.addChild(new Text(truncateToWidth(line, this.#uiWidth() - 2), 0, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "systemPrompt preview:"), 0, 0));
		const promptWidth = Math.max(20, this.#uiWidth() - 4);
		const wrappedPrompt: string[] = [];
		for (const raw of spec.systemPrompt.split("\n")) {
			for (const w of wrapTextWithAnsi(replaceTabs(raw), promptWidth)) {
				wrappedPrompt.push(w);
			}
		}
		const promptPreview = wrappedPrompt.slice(0, 10);
		for (const line of promptPreview) {
			this.addChild(new Text(`  ${line}`, 0, 0));
		}
		if (wrappedPrompt.length > promptPreview.length) {
			this.addChild(
				new Text(theme.fg("dim", `  ... ${wrappedPrompt.length - promptPreview.length} more lines`), 0, 0),
			);
		}
		if (this.#createError) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("error", replaceTabs(this.#createError)), 0, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", " Enter: save  Tab: toggle scope  R: regenerate  Esc: cancel"), 0, 0));
	}

	#uiWidth(): number {
		return Math.max(40, process.stdout.columns ?? 100);
	}

	/** Rebuild layout and request a TUI render pass (for use after async state changes). */
	#rebuildAndRender(): void {
		this.#buildLayout();
		this.onRequestRender?.();
	}

	#buildLayout(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", " Agent Control Center")), 0, 0));
		this.addChild(new Text(this.#renderTabBar(), 0, 0));
		this.addChild(new Spacer(1));

		if (this.#notice) {
			this.addChild(new Text(theme.fg("success", replaceTabs(this.#notice)), 0, 0));
			this.addChild(new Spacer(1));
		}

		if (this.#loading) {
			this.addChild(new Text(theme.fg("muted", "Loading agents..."), 0, 0));
			this.addChild(new Spacer(1));
		} else if (this.#loadError) {
			this.addChild(new Text(theme.fg("error", `Failed to load agents: ${replaceTabs(this.#loadError)}`), 0, 0));
			this.addChild(new Spacer(1));
		} else if (this.#createSpec) {
			this.#renderCreateReview();
		} else if (this.#createInput || this.#createGenerating) {
			this.#renderCreateInput();
		} else if (this.#editInput && this.#editingAgentName) {
			const editingAgent = this.#allAgents.find(agent => agent.name === this.#editingAgentName) ?? null;
			const draft = this.#editInput.getValue();
			const defaultPatterns = editingAgent ? this.#defaultPatternsFor(editingAgent) : [];
			const defaultResolution = editingAgent ? this.#resolvePatterns(defaultPatterns) : undefined;
			const previewPatterns = editingAgent ? this.#effectivePatternsFor(editingAgent, draft) : [];
			const previewResolution = editingAgent ? this.#resolvePatterns(previewPatterns) : undefined;
			const suggestions = this.#getModelSuggestions(draft);

			this.addChild(
				new Text(theme.bold(theme.fg("accent", `Model override: ${replaceTabs(this.#editingAgentName)}`)), 0, 0),
			);
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", "Enter model pattern (empty clears override)"), 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(this.#editInput);
			this.addChild(new Spacer(1));

			this.addChild(
				new Text(theme.fg("muted", `Default pattern: ${replaceTabs(joinPatterns(defaultPatterns))}`), 0, 0),
			);
			this.addChild(
				new Text(
					`${theme.fg("muted", "Default resolves:")} ${defaultResolution ? formatResolution(defaultResolution) : theme.fg("dim", "(unresolved)")}`,
					0,
					0,
				),
			);
			this.addChild(
				new Text(
					`${theme.fg("muted", "Preview effective:")} ${previewResolution ? formatResolution(previewResolution) : theme.fg("dim", "(unresolved)")}`,
					0,
					0,
				),
			);

			if (suggestions.length > 0) {
				this.addChild(new Spacer(1));
				this.addChild(new Text(theme.fg("muted", "Suggestions:"), 0, 0));
				for (const suggestion of suggestions) {
					this.addChild(new Text(theme.fg("dim", `  ${suggestion}`), 0, 0));
				}
			}

			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", " Enter: save  Esc: cancel"), 0, 0));
		} else {
			const selected = this.#selectedAgent();
			const defaultPatterns = selected ? this.#defaultPatternsFor(selected) : [];
			const defaultResolution = selected ? this.#resolvePatterns(defaultPatterns) : undefined;
			const effectivePatterns = selected ? this.#effectivePatternsFor(selected, selected.overrideModel) : [];
			const effectiveResolution = selected ? this.#resolvePatterns(effectivePatterns) : undefined;

			const listPane = new AgentListPane(
				this.#filteredAgents,
				this.#selectedIndex,
				this.#scrollOffset,
				this.#searchQuery,
				this.#getMaxVisibleItems(),
			);
			const inspector = new AgentInspectorPane(
				selected,
				defaultPatterns,
				defaultResolution,
				effectivePatterns,
				effectiveResolution,
			);
			const bodyHeight = this.#computeBodyHeight();
			this.addChild(new TwoColumnBody(listPane, inspector, bodyHeight));
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("dim", LIST_FOOTER), 0, 0));
		}

		this.addChild(new DynamicBorder());
		this.#builtRows = this.#terminalRows();
		this.#builtCols = this.#uiWidth();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.onClose?.();
			return;
		}

		if (this.#createSpec) {
			if (matchesAppInterrupt(data)) {
				this.#clearCreateFlow();
				this.#buildLayout();
				return;
			}
			if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
				this.#toggleCreateScope();
				return;
			}
			if (data.toLowerCase() === "r") {
				void this.#generateAgentFromDescription(this.#createDescription);
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
				void this.#saveGeneratedAgent().catch(error => {
					this.#createError = error instanceof Error ? error.message : String(error);
					this.#rebuildAndRender();
				});
				return;
			}
			return;
		}

		if (this.#createInput || this.#createGenerating) {
			if (matchesAppInterrupt(data)) {
				if (!this.#createGenerating) {
					this.#clearCreateFlow();
					this.#buildLayout();
				}
				return;
			}
			if (!this.#createGenerating && matchesAppFollowUp(data)) {
				this.#submitCreateDescription();
				return;
			}
			if (!this.#createGenerating && (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n")) {
				this.#insertCreateNewline();
				return;
			}
			if (!this.#createGenerating && (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))) {
				this.#toggleCreateScope();
				return;
			}
			if (!this.#createGenerating && this.#createInput) {
				this.#createInput.handleInput(data);
				this.#createDescription = this.#createInput.getExpandedText();
				this.#buildLayout();
			}
			return;
		}

		if (this.#editInput) {
			if (matchesAppInterrupt(data)) {
				this.#cancelModelEdit();
				return;
			}
			this.#editInput.handleInput(data);
			if (this.#editInput) {
				this.#buildLayout();
			}
			return;
		}

		if (matchesAppInterrupt(data)) {
			if (this.#searchQuery.length > 0) {
				this.#searchQuery = "";
				this.#applyFilters();
				this.#buildLayout();
				return;
			}
			this.onClose?.();
			return;
		}

		if (matchesKey(data, "ctrl+r")) {
			void this.#reloadData();
			return;
		}

		if (handleTabSwitchKey(data, direction => this.#switchTab(direction))) {
			return;
		}

		if (matchesSelectUp(data) || data === "k") {
			this.#moveSelection(-1);
			return;
		}
		if (matchesSelectDown(data) || data === "j") {
			this.#moveSelection(1);
			return;
		}

		if (data === " ") {
			this.#toggleSelectedAgent();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#beginModelEdit();
			return;
		}
		if (data.toLowerCase() === "n") {
			this.#beginCreateFlow();
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.#searchQuery.length > 0) {
				this.#searchQuery = this.#searchQuery.slice(0, -1);
				this.#applyFilters();
				this.#buildLayout();
			}
			return;
		}

		const char = searchableChar(data);
		if (char !== null) {
			this.#searchQuery += char;
			this.#applyFilters();
			this.#buildLayout();
		}
	}
}
