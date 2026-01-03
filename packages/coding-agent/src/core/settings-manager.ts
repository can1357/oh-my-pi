import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Settings as SettingsItem, settingsCapability } from "../capability/settings";
import { getAgentDir } from "../config";
import { loadSync } from "../discovery";

export interface CompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
}

export interface BranchSummarySettings {
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
}

export interface SkillsSettings {
	enabled?: boolean; // default: true
	enableCodexUser?: boolean; // default: true
	enableClaudeUser?: boolean; // default: true
	enableClaudeProject?: boolean; // default: true
	enablePiUser?: boolean; // default: true
	enablePiProject?: boolean; // default: true
	customDirectories?: string[]; // default: []
	ignoredSkills?: string[]; // default: [] (glob patterns to exclude; takes precedence over includeSkills)
	includeSkills?: string[]; // default: [] (empty = include all; glob patterns to filter)
}

export interface CommandsSettings {
	enableClaudeUser?: boolean; // default: true (load from ~/.claude/commands/)
	enableClaudeProject?: boolean; // default: true (load from .claude/commands/)
}

export interface TerminalSettings {
	showImages?: boolean; // default: true (only relevant if terminal supports images)
}

export interface ExaSettings {
	enabled?: boolean; // default: true (master toggle for all Exa tools)
	enableSearch?: boolean; // default: true (search, deep, code, crawl)
	enableLinkedin?: boolean; // default: false
	enableCompany?: boolean; // default: false
	enableResearcher?: boolean; // default: false
	enableWebsets?: boolean; // default: false
}

export interface BashInterceptorSettings {
	enabled?: boolean; // default: false (blocks shell commands that have dedicated tools)
}

export interface MCPSettings {
	enableProjectConfig?: boolean; // default: true (load .mcp.json from project root)
}

export interface LspSettings {
	formatOnWrite?: boolean; // default: true (format files using LSP after write tool writes code files)
	diagnosticsOnWrite?: boolean; // default: true (return LSP diagnostics after write tool writes code files)
	diagnosticsOnEdit?: boolean; // default: false (return LSP diagnostics after edit tool edits code files)
}

export interface EditSettings {
	fuzzyMatch?: boolean; // default: true (accept high-confidence fuzzy matches for whitespace/indentation)
}

export interface TtsrSettings {
	enabled?: boolean; // default: true
	/** What to do with partial output when TTSR triggers: "keep" shows interrupted attempt, "discard" removes it */
	contextMode?: "keep" | "discard"; // default: "discard"
	/** How TTSR rules repeat: "once" = only trigger once per session, "after-gap" = can repeat after N messages */
	repeatMode?: "once" | "after-gap"; // default: "once"
	/** Number of messages before a rule can trigger again (only used when repeatMode is "after-gap") */
	repeatGap?: number; // default: 10
}

export interface Settings {
	lastChangelogVersion?: string;
	/** Model roles map: { default: "provider/modelId", small: "provider/modelId", ... } */
	modelRoles?: Record<string, string>;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	queueMode?: "all" | "one-at-a-time";
	interruptMode?: "immediate" | "wait";
	theme?: string;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean;
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows)
	collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
	hooks?: string[]; // Array of hook file paths
	customTools?: string[]; // Array of custom tool file paths
	skills?: SkillsSettings;
	commands?: CommandsSettings;
	terminal?: TerminalSettings;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	exa?: ExaSettings;
	bashInterceptor?: BashInterceptorSettings;
	mcp?: MCPSettings;
	lsp?: LspSettings;
	edit?: EditSettings;
	ttsr?: TtsrSettings;
	disabledProviders?: string[]; // Discovery provider IDs that are disabled
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const result: Settings = { ...base };

	for (const key of Object.keys(overrides) as (keyof Settings)[]) {
		const overrideValue = overrides[key];
		const baseValue = base[key];

		if (overrideValue === undefined) {
			continue;
		}

		// For nested objects, merge recursively
		if (
			typeof overrideValue === "object" &&
			overrideValue !== null &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue)
		) {
			(result as Record<string, unknown>)[key] = { ...baseValue, ...overrideValue };
		} else {
			// For primitives and arrays, override value wins
			(result as Record<string, unknown>)[key] = overrideValue;
		}
	}

	return result;
}

export class SettingsManager {
	private settingsPath: string | null;
	private cwd: string | null;
	private globalSettings: Settings;
	private settings: Settings;
	private persist: boolean;

	private constructor(settingsPath: string | null, cwd: string | null, initialSettings: Settings, persist: boolean) {
		this.settingsPath = settingsPath;
		this.cwd = cwd;
		this.persist = persist;
		this.globalSettings = initialSettings;
		const projectSettings = this.loadProjectSettings();
		this.settings = deepMergeSettings(this.globalSettings, projectSettings);
	}

	/** Create a SettingsManager that loads from files */
	static create(cwd: string = process.cwd(), agentDir: string = getAgentDir()): SettingsManager {
		const settingsPath = join(agentDir, "settings.json");

		// Use capability API to load user-level settings from all providers
		const result = loadSync(settingsCapability.id, { cwd });

		// Merge all user-level settings
		let globalSettings: Settings = {};
		for (const item of result.items as SettingsItem[]) {
			if (item.level === "user") {
				globalSettings = deepMergeSettings(globalSettings, item.data as Settings);
			}
		}

		// Also load from agentDir for backward compatibility (if not covered by providers)
		const legacySettings = SettingsManager.loadFromFile(settingsPath);
		globalSettings = deepMergeSettings(globalSettings, legacySettings);

		return new SettingsManager(settingsPath, cwd, globalSettings, true);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}): SettingsManager {
		return new SettingsManager(null, null, settings, false);
	}

	private static loadFromFile(path: string): Settings {
		if (!existsSync(path)) {
			return {};
		}
		try {
			const content = readFileSync(path, "utf-8");
			return JSON.parse(content);
		} catch (error) {
			console.error(`Warning: Could not read settings file ${path}: ${error}`);
			return {};
		}
	}

	private loadProjectSettings(): Settings {
		if (!this.cwd) return {};

		// Use capability API to discover settings from all providers
		const result = loadSync(settingsCapability.id, { cwd: this.cwd });

		// Merge only project-level settings (user-level settings are handled separately via globalSettings)
		let merged: Settings = {};
		for (const item of result.items as SettingsItem[]) {
			if (item.level === "project") {
				merged = deepMergeSettings(merged, item.data as Settings);
			}
		}

		return merged;
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		this.settings = deepMergeSettings(this.settings, overrides);
	}

	private save(): void {
		if (!this.persist || !this.settingsPath) return;

		try {
			const dir = dirname(this.settingsPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}

			// Save only global settings (project settings are read-only)
			writeFileSync(this.settingsPath, JSON.stringify(this.globalSettings, null, 2), "utf-8");

			// Re-merge project settings into active settings
			const projectSettings = this.loadProjectSettings();
			this.settings = deepMergeSettings(this.globalSettings, projectSettings);
		} catch (error) {
			console.error(`Warning: Could not save settings file: ${error}`);
		}
	}

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.globalSettings.lastChangelogVersion = version;
		this.save();
	}

	/**
	 * Get model for a role. Returns "provider/modelId" string or undefined.
	 */
	getModelRole(role: string): string | undefined {
		return this.settings.modelRoles?.[role];
	}

	/**
	 * Set model for a role. Model should be "provider/modelId" format.
	 */
	setModelRole(role: string, model: string): void {
		if (!this.globalSettings.modelRoles) {
			this.globalSettings.modelRoles = {};
		}
		this.globalSettings.modelRoles[role] = model;
		this.save();
	}

	/**
	 * Get all model roles.
	 */
	getModelRoles(): Record<string, string> {
		return { ...this.settings.modelRoles };
	}

	getQueueMode(): "all" | "one-at-a-time" {
		return this.settings.queueMode || "one-at-a-time";
	}

	setQueueMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.queueMode = mode;
		this.save();
	}

	getInterruptMode(): "immediate" | "wait" {
		return this.settings.interruptMode || "immediate";
	}

	setInterruptMode(mode: "immediate" | "wait"): void {
		this.globalSettings.interruptMode = mode;
		this.save();
	}

	getTheme(): string | undefined {
		return this.settings.theme;
	}

	setTheme(theme: string): void {
		this.globalSettings.theme = theme;
		this.save();
	}

	getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): void {
		this.globalSettings.defaultThinkingLevel = level;
		this.save();
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		if (!this.globalSettings.compaction) {
			this.globalSettings.compaction = {};
		}
		this.globalSettings.compaction.enabled = enabled;
		this.save();
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? 16384;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? 20000;
	}

	getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
		};
	}

	getBranchSummarySettings(): { reserveTokens: number } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
		};
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.enabled = enabled;
		this.save();
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
		};
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	setHideThinkingBlock(hide: boolean): void {
		this.globalSettings.hideThinkingBlock = hide;
		this.save();
	}

	getShellPath(): string | undefined {
		return this.settings.shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.globalSettings.shellPath = path;
		this.save();
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? false;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.globalSettings.collapseChangelog = collapse;
		this.save();
	}

	getHookPaths(): string[] {
		return [...(this.settings.hooks ?? [])];
	}

	setHookPaths(paths: string[]): void {
		this.globalSettings.hooks = paths;
		this.save();
	}

	getCustomToolPaths(): string[] {
		return [...(this.settings.customTools ?? [])];
	}

	setCustomToolPaths(paths: string[]): void {
		this.globalSettings.customTools = paths;
		this.save();
	}

	getSkillsEnabled(): boolean {
		return this.settings.skills?.enabled ?? true;
	}

	setSkillsEnabled(enabled: boolean): void {
		if (!this.globalSettings.skills) {
			this.globalSettings.skills = {};
		}
		this.globalSettings.skills.enabled = enabled;
		this.save();
	}

	getSkillsSettings(): Required<SkillsSettings> {
		return {
			enabled: this.settings.skills?.enabled ?? true,
			enableCodexUser: this.settings.skills?.enableCodexUser ?? true,
			enableClaudeUser: this.settings.skills?.enableClaudeUser ?? true,
			enableClaudeProject: this.settings.skills?.enableClaudeProject ?? true,
			enablePiUser: this.settings.skills?.enablePiUser ?? true,
			enablePiProject: this.settings.skills?.enablePiProject ?? true,
			customDirectories: [...(this.settings.skills?.customDirectories ?? [])],
			ignoredSkills: [...(this.settings.skills?.ignoredSkills ?? [])],
			includeSkills: [...(this.settings.skills?.includeSkills ?? [])],
		};
	}

	getCommandsSettings(): Required<CommandsSettings> {
		return {
			enableClaudeUser: this.settings.commands?.enableClaudeUser ?? true,
			enableClaudeProject: this.settings.commands?.enableClaudeProject ?? true,
		};
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showImages = show;
		this.save();
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	getExaSettings(): Required<ExaSettings> {
		return {
			enabled: this.settings.exa?.enabled ?? true,
			enableSearch: this.settings.exa?.enableSearch ?? true,
			enableLinkedin: this.settings.exa?.enableLinkedin ?? false,
			enableCompany: this.settings.exa?.enableCompany ?? false,
			enableResearcher: this.settings.exa?.enableResearcher ?? false,
			enableWebsets: this.settings.exa?.enableWebsets ?? false,
		};
	}

	setExaEnabled(enabled: boolean): void {
		if (!this.globalSettings.exa) {
			this.globalSettings.exa = {};
		}
		this.globalSettings.exa.enabled = enabled;
		this.save();
	}

	setExaSearchEnabled(enabled: boolean): void {
		if (!this.globalSettings.exa) {
			this.globalSettings.exa = {};
		}
		this.globalSettings.exa.enableSearch = enabled;
		this.save();
	}

	setExaLinkedinEnabled(enabled: boolean): void {
		if (!this.globalSettings.exa) {
			this.globalSettings.exa = {};
		}
		this.globalSettings.exa.enableLinkedin = enabled;
		this.save();
	}

	setExaCompanyEnabled(enabled: boolean): void {
		if (!this.globalSettings.exa) {
			this.globalSettings.exa = {};
		}
		this.globalSettings.exa.enableCompany = enabled;
		this.save();
	}

	setExaResearcherEnabled(enabled: boolean): void {
		if (!this.globalSettings.exa) {
			this.globalSettings.exa = {};
		}
		this.globalSettings.exa.enableResearcher = enabled;
		this.save();
	}

	setExaWebsetsEnabled(enabled: boolean): void {
		if (!this.globalSettings.exa) {
			this.globalSettings.exa = {};
		}
		this.globalSettings.exa.enableWebsets = enabled;
		this.save();
	}

	getBashInterceptorEnabled(): boolean {
		return this.settings.bashInterceptor?.enabled ?? false;
	}

	setBashInterceptorEnabled(enabled: boolean): void {
		if (!this.globalSettings.bashInterceptor) {
			this.globalSettings.bashInterceptor = {};
		}
		this.globalSettings.bashInterceptor.enabled = enabled;
		this.save();
	}

	getMCPProjectConfigEnabled(): boolean {
		return this.settings.mcp?.enableProjectConfig ?? true;
	}

	setMCPProjectConfigEnabled(enabled: boolean): void {
		if (!this.globalSettings.mcp) {
			this.globalSettings.mcp = {};
		}
		this.globalSettings.mcp.enableProjectConfig = enabled;
		this.save();
	}

	getLspFormatOnWrite(): boolean {
		return this.settings.lsp?.formatOnWrite ?? true;
	}

	setLspFormatOnWrite(enabled: boolean): void {
		if (!this.globalSettings.lsp) {
			this.globalSettings.lsp = {};
		}
		this.globalSettings.lsp.formatOnWrite = enabled;
		this.save();
	}

	getLspDiagnosticsOnWrite(): boolean {
		return this.settings.lsp?.diagnosticsOnWrite ?? true;
	}

	setLspDiagnosticsOnWrite(enabled: boolean): void {
		if (!this.globalSettings.lsp) {
			this.globalSettings.lsp = {};
		}
		this.globalSettings.lsp.diagnosticsOnWrite = enabled;
		this.save();
	}

	getLspDiagnosticsOnEdit(): boolean {
		return this.settings.lsp?.diagnosticsOnEdit ?? false;
	}

	setLspDiagnosticsOnEdit(enabled: boolean): void {
		if (!this.globalSettings.lsp) {
			this.globalSettings.lsp = {};
		}
		this.globalSettings.lsp.diagnosticsOnEdit = enabled;
		this.save();
	}

	getEditFuzzyMatch(): boolean {
		return this.settings.edit?.fuzzyMatch ?? true;
	}

	setEditFuzzyMatch(enabled: boolean): void {
		if (!this.globalSettings.edit) {
			this.globalSettings.edit = {};
		}
		this.globalSettings.edit.fuzzyMatch = enabled;
		this.save();
	}

	getDisabledProviders(): string[] {
		return [...(this.settings.disabledProviders ?? [])];
	}

	setDisabledProviders(providerIds: string[]): void {
		this.globalSettings.disabledProviders = providerIds;
		this.save();
	}

	getTtsrSettings(): TtsrSettings {
		return this.settings.ttsr ?? {};
	}

	setTtsrSettings(settings: TtsrSettings): void {
		this.globalSettings.ttsr = { ...this.globalSettings.ttsr, ...settings };
		this.save();
	}

	getTtsrEnabled(): boolean {
		return this.settings.ttsr?.enabled ?? true;
	}

	setTtsrEnabled(enabled: boolean): void {
		if (!this.globalSettings.ttsr) {
			this.globalSettings.ttsr = {};
		}
		this.globalSettings.ttsr.enabled = enabled;
		this.save();
	}

	getTtsrContextMode(): "keep" | "discard" {
		return this.settings.ttsr?.contextMode ?? "discard";
	}

	setTtsrContextMode(mode: "keep" | "discard"): void {
		if (!this.globalSettings.ttsr) {
			this.globalSettings.ttsr = {};
		}
		this.globalSettings.ttsr.contextMode = mode;
		this.save();
	}

	getTtsrRepeatMode(): "once" | "after-gap" {
		return this.settings.ttsr?.repeatMode ?? "once";
	}

	setTtsrRepeatMode(mode: "once" | "after-gap"): void {
		if (!this.globalSettings.ttsr) {
			this.globalSettings.ttsr = {};
		}
		this.globalSettings.ttsr.repeatMode = mode;
		this.save();
	}

	getTtsrRepeatGap(): number {
		return this.settings.ttsr?.repeatGap ?? 10;
	}

	setTtsrRepeatGap(gap: number): void {
		if (!this.globalSettings.ttsr) {
			this.globalSettings.ttsr = {};
		}
		this.globalSettings.ttsr.repeatGap = gap;
		this.save();
	}
}
