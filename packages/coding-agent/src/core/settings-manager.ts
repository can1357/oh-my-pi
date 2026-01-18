import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { type Settings as SettingsItem, settingsCapability } from "../capability/settings";
import { getAgentDbPath, getAgentDir } from "../config";
import { loadCapability } from "../discovery";
import type { SymbolPreset } from "../modes/interactive/theme/theme";
import { AgentStorage } from "./agent-storage";
import { logger } from "./logger";

export interface CompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
}

export interface BranchSummarySettings {
	enabled?: boolean; // default: false (prompt user to summarize when leaving branch)
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
}

export interface SkillsSettings {
	enabled?: boolean; // default: true
	enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
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

export interface StartupSettings {
	quiet?: boolean; // default: false - suppress welcome screen and startup info
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export type NotificationMethod = "bell" | "osc99" | "osc9" | "auto" | "off";

export interface NotificationSettings {
	onComplete?: NotificationMethod; // default: "auto"
}

export interface ExaSettings {
	enabled?: boolean; // default: true (master toggle for all Exa tools)
	enableSearch?: boolean; // default: true (search, deep, code, crawl)
	enableLinkedin?: boolean; // default: false
	enableCompany?: boolean; // default: false
	enableResearcher?: boolean; // default: false
	enableWebsets?: boolean; // default: false
}

export type WebSearchProviderOption = "auto" | "exa" | "perplexity" | "anthropic";
export type ImageProviderOption = "auto" | "gemini" | "openrouter";

export interface ProviderSettings {
	webSearch?: WebSearchProviderOption; // default: "auto" (exa > perplexity > anthropic)
	image?: ImageProviderOption; // default: "auto" (openrouter > gemini)
}

export interface BashInterceptorRule {
	pattern: string;
	flags?: string;
	tool: string;
	message: string;
}

export interface BashInterceptorSettings {
	enabled?: boolean; // default: false (blocks shell commands that have dedicated tools)
	simpleLs?: boolean; // default: true (intercept bare ls commands)
	patterns?: BashInterceptorRule[]; // default: built-in rules
}

export interface GitSettings {
	enabled?: boolean; // default: false (structured git tool; use bash for git commands when disabled)
}

export interface MCPSettings {
	enableProjectConfig?: boolean; // default: true (load .mcp.json from project root)
}

export interface LspSettings {
	formatOnWrite?: boolean; // default: false (format files using LSP after write tool writes code files)
	diagnosticsOnWrite?: boolean; // default: true (return LSP diagnostics after write tool writes code files)
	diagnosticsOnEdit?: boolean; // default: false (return LSP diagnostics after edit tool edits code files)
}

export type PythonToolMode = "ipy-only" | "bash-only" | "both";
export type PythonKernelMode = "session" | "per-call";

export interface PythonSettings {
	toolMode?: PythonToolMode;
	kernelMode?: PythonKernelMode;
	sharedGateway?: boolean;
}

export interface EditSettings {
	fuzzyMatch?: boolean; // default: true (accept high-confidence fuzzy matches for whitespace/indentation)
}

export type { SymbolPreset };

export interface TtsrSettings {
	enabled?: boolean; // default: true
	/** What to do with partial output when TTSR triggers: "keep" shows interrupted attempt, "discard" removes it */
	contextMode?: "keep" | "discard"; // default: "discard"
	/** How TTSR rules repeat: "once" = only trigger once per session, "after-gap" = can repeat after N messages */
	repeatMode?: "once" | "after-gap"; // default: "once"
	/** Number of messages before a rule can trigger again (only used when repeatMode is "after-gap") */
	repeatGap?: number; // default: 10
}

export interface TodoCompletionSettings {
	enabled?: boolean; // default: false - warn agent when it stops with incomplete todos
	maxReminders?: number; // default: 3 - maximum reminders before giving up
}

export interface VoiceSettings {
	enabled?: boolean; // default: false
	transcriptionModel?: string; // default: "whisper-1"
	transcriptionLanguage?: string; // optional language hint (e.g., "en")
	ttsModel?: string; // default: "gpt-4o-mini-tts"
	ttsVoice?: string; // default: "alloy"
	ttsFormat?: "wav" | "mp3" | "opus" | "aac" | "flac"; // default: "wav"
}

export type StatusLineSegmentId =
	| "pi"
	| "model"
	| "path"
	| "git"
	| "subagents"
	| "token_in"
	| "token_out"
	| "token_total"
	| "cost"
	| "context_pct"
	| "context_total"
	| "time_spent"
	| "time"
	| "session"
	| "hostname"
	| "cache_read"
	| "cache_write";

export type StatusLineSeparatorStyle = "powerline" | "powerline-thin" | "slash" | "pipe" | "block" | "none" | "ascii";

export type StatusLinePreset = "default" | "minimal" | "compact" | "full" | "nerd" | "ascii" | "custom";

export interface StatusLineSegmentOptions {
	model?: { showThinkingLevel?: boolean };
	path?: { abbreviate?: boolean; maxLength?: number; stripWorkPrefix?: boolean };
	git?: { showBranch?: boolean; showStaged?: boolean; showUnstaged?: boolean; showUntracked?: boolean };
	time?: { format?: "12h" | "24h"; showSeconds?: boolean };
}

export interface StatusLineSettings {
	preset?: StatusLinePreset;
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];
	separator?: StatusLineSeparatorStyle;
	segmentOptions?: StatusLineSegmentOptions;
	showHookStatus?: boolean;
}

export interface Settings {
	lastChangelogVersion?: string;
	/** Model roles map: { default: "provider/modelId", small: "provider/modelId", ... } */
	modelRoles?: Record<string, string>;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	queueMode?: "all" | "one-at-a-time"; // legacy
	interruptMode?: "immediate" | "wait";
	theme?: string;
	symbolPreset?: SymbolPreset; // default: uses theme's preset or "unicode"
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean;
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows)
	collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
	startup?: StartupSettings;
	doubleEscapeAction?: "branch" | "tree"; // Action for double-escape with empty editor (default: "tree")
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	/** Environment variables to set automatically on startup */
	env?: Record<string, string>;
	extensions?: string[]; // Array of extension file paths
	skills?: SkillsSettings;
	commands?: CommandsSettings;
	terminal?: TerminalSettings;
	images?: ImageSettings;
	notifications?: NotificationSettings;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	exa?: ExaSettings;
	bashInterceptor?: BashInterceptorSettings;
	git?: GitSettings;
	mcp?: MCPSettings;
	lsp?: LspSettings;
	python?: PythonSettings;
	edit?: EditSettings;
	ttsr?: TtsrSettings;
	todoCompletion?: TodoCompletionSettings;
	voice?: VoiceSettings;
	providers?: ProviderSettings;
	disabledProviders?: string[]; // Discovery provider IDs that are disabled
	disabledExtensions?: string[]; // Individual extension IDs that are disabled (e.g., "skill:commit")
	statusLine?: StatusLineSettings; // Status line configuration
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
}

export const DEFAULT_BASH_INTERCEPTOR_RULES: BashInterceptorRule[] = [
	{
		pattern: "^\\s*(cat|head|tail|less|more)\\s+",
		tool: "read",
		message: "Use the `read` tool instead of cat/head/tail. It provides better context and handles binary files.",
	},
	{
		pattern: "^\\s*(grep|rg|ripgrep|ag|ack)\\s+",
		tool: "grep",
		message: "Use the `grep` tool instead of grep/rg. It respects .gitignore and provides structured output.",
	},
	{
		pattern: "^\\s*git(\\s+|$)",
		tool: "git",
		message:
			"Use the `git` tool instead of running git in bash. It provides structured output and safety confirmations.",
	},
	{
		pattern: "^\\s*(find|fd|locate)\\s+.*(-name|-iname|-type|--type|-glob)",
		tool: "find",
		message: "Use the `find` tool instead of find/fd. It respects .gitignore and is faster for glob patterns.",
	},
	{
		pattern: "^\\s*sed\\s+(-i|--in-place)",
		tool: "edit",
		message: "Use the `edit` tool instead of sed -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*perl\\s+.*-[pn]?i",
		tool: "edit",
		message: "Use the `edit` tool instead of perl -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*awk\\s+.*-i\\s+inplace",
		tool: "edit",
		message: "Use the `edit` tool instead of awk -i inplace. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*(echo|printf|cat\\s*<<)\\s+.*[^|]>\\s*\\S",
		tool: "write",
		message: "Use the `write` tool instead of echo/cat redirection. It handles encoding and provides confirmation.",
	},
];

const DEFAULT_BASH_INTERCEPTOR_SETTINGS: Required<BashInterceptorSettings> = {
	enabled: false,
	simpleLs: true,
	patterns: DEFAULT_BASH_INTERCEPTOR_RULES,
};

const DEFAULT_SETTINGS: Settings = {
	compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
	branchSummary: { enabled: false, reserveTokens: 16384 },
	retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
	skills: {
		enabled: true,
		enableCodexUser: true,
		enableClaudeUser: true,
		enableClaudeProject: true,
		enablePiUser: true,
		enablePiProject: true,
		customDirectories: [],
		ignoredSkills: [],
		includeSkills: [],
	},
	commands: { enableClaudeUser: true, enableClaudeProject: true },
	terminal: { showImages: true },
	images: { autoResize: true },
	notifications: { onComplete: "auto" },
	exa: {
		enabled: true,
		enableSearch: true,
		enableLinkedin: false,
		enableCompany: false,
		enableResearcher: false,
		enableWebsets: false,
	},
	bashInterceptor: DEFAULT_BASH_INTERCEPTOR_SETTINGS,
	git: { enabled: false },
	mcp: { enableProjectConfig: true },
	lsp: { formatOnWrite: false, diagnosticsOnWrite: true, diagnosticsOnEdit: false },
	python: { toolMode: "ipy-only", kernelMode: "session", sharedGateway: true },
	edit: { fuzzyMatch: true },
	ttsr: { enabled: true, contextMode: "discard", repeatMode: "once", repeatGap: 10 },
	voice: {
		enabled: false,
		transcriptionModel: "whisper-1",
		ttsModel: "gpt-4o-mini-tts",
		ttsVoice: "alloy",
		ttsFormat: "wav",
	},
	providers: { webSearch: "auto", image: "auto" },
} satisfies Settings;

function normalizeBashInterceptorRule(rule: unknown): BashInterceptorRule | null {
	if (!rule || typeof rule !== "object" || Array.isArray(rule)) return null;

	const candidate = rule as Record<string, unknown>;
	const pattern = typeof candidate.pattern === "string" ? candidate.pattern : "";
	const tool = typeof candidate.tool === "string" ? candidate.tool : "";
	const message = typeof candidate.message === "string" ? candidate.message : "";
	const flags = typeof candidate.flags === "string" && candidate.flags.length > 0 ? candidate.flags : undefined;

	if (!pattern || !tool || !message) return null;
	return { pattern, flags, tool, message };
}

function normalizeBashInterceptorSettings(
	settings: BashInterceptorSettings | undefined,
): Required<BashInterceptorSettings> {
	const enabled = settings?.enabled ?? DEFAULT_BASH_INTERCEPTOR_SETTINGS.enabled;
	const simpleLs = settings?.simpleLs ?? DEFAULT_BASH_INTERCEPTOR_SETTINGS.simpleLs;
	const rawPatterns = settings?.patterns;
	let patterns: BashInterceptorRule[];
	if (rawPatterns === undefined) {
		patterns = DEFAULT_BASH_INTERCEPTOR_RULES;
	} else if (Array.isArray(rawPatterns)) {
		patterns = rawPatterns
			.map((rule) => normalizeBashInterceptorRule(rule))
			.filter((rule): rule is BashInterceptorRule => rule !== null);
	} else {
		patterns = DEFAULT_BASH_INTERCEPTOR_RULES;
	}

	return { enabled, simpleLs, patterns };
}

let cachedNerdFonts: boolean | null = null;

function hasNerdFonts(): boolean {
	if (cachedNerdFonts !== null) {
		return cachedNerdFonts;
	}

	const envOverride = process.env.NERD_FONTS;
	if (envOverride === "1") {
		cachedNerdFonts = true;
		return true;
	}
	if (envOverride === "0") {
		cachedNerdFonts = false;
		return false;
	}

	const termProgram = (process.env.TERM_PROGRAM || "").toLowerCase();
	const term = (process.env.TERM || "").toLowerCase();
	const nerdTerms = ["iterm", "wezterm", "kitty", "ghostty", "alacritty"];
	cachedNerdFonts = nerdTerms.some((candidate) => termProgram.includes(candidate) || term.includes(candidate));
	return cachedNerdFonts;
}

function normalizeSettings(settings: Settings): Settings {
	const merged = deepMergeSettings(DEFAULT_SETTINGS, settings);
	const symbolPreset = merged.symbolPreset ?? (hasNerdFonts() ? "nerd" : "unicode");
	return {
		...merged,
		symbolPreset,
		bashInterceptor: normalizeBashInterceptorSettings(merged.bashInterceptor),
		python: normalizePythonSettings(merged.python),
	};
}

function normalizePythonSettings(settings: PythonSettings | undefined): PythonSettings {
	const toolMode = settings?.toolMode;
	const kernelMode = settings?.kernelMode;
	const sharedGateway = settings?.sharedGateway;
	return {
		toolMode:
			toolMode === "ipy-only" || toolMode === "bash-only" || toolMode === "both"
				? toolMode
				: (DEFAULT_SETTINGS.python?.toolMode ?? "ipy-only"),
		kernelMode:
			kernelMode === "session" || kernelMode === "per-call"
				? kernelMode
				: (DEFAULT_SETTINGS.python?.kernelMode ?? "session"),
		sharedGateway:
			typeof sharedGateway === "boolean" ? sharedGateway : (DEFAULT_SETTINGS.python?.sharedGateway ?? true),
	};
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
	/** SQLite storage for persisted settings (null for in-memory mode) */
	private storage: AgentStorage | null;
	private cwd: string | null;
	private globalSettings: Settings;
	private overrides: Settings;
	private settings!: Settings;
	private persist: boolean;

	/**
	 * Private constructor - use static factory methods instead.
	 * @param storage - SQLite storage instance for persistence, or null for in-memory mode
	 * @param cwd - Current working directory for project settings discovery
	 * @param initialSettings - Initial global settings to use
	 * @param persist - Whether to persist settings changes to storage
	 * @param projectSettings - Pre-loaded project settings (to avoid async in constructor)
	 */
	private constructor(
		storage: AgentStorage | null,
		cwd: string | null,
		initialSettings: Settings,
		persist: boolean,
		projectSettings: Settings,
	) {
		this.storage = storage;
		this.cwd = cwd;
		this.persist = persist;
		this.globalSettings = initialSettings;
		this.overrides = {};
		this.rebuildSettings(projectSettings);

		// Apply environment variables from settings
		this.applyEnvironmentVariables();
	}

	/**
	 * Apply environment variables from settings to process.env
	 * Only sets variables that are not already set in the environment
	 */
	applyEnvironmentVariables(): void {
		const envVars = this.settings.env;
		if (!envVars || typeof envVars !== "object") {
			return;
		}

		for (const [key, value] of Object.entries(envVars)) {
			if (typeof key === "string" && typeof value === "string") {
				// Only set if not already present in environment (allow override with env vars)
				if (!(key in process.env)) {
					process.env[key] = value;
				}
			}
		}
	}

	/**
	 * Create a SettingsManager that loads from persistent SQLite storage.
	 * @param cwd - Current working directory for project settings discovery
	 * @param agentDir - Agent directory containing agent.db
	 * @returns Configured SettingsManager with merged global and user settings
	 */
	static async create(cwd: string = process.cwd(), agentDir: string = getAgentDir()): Promise<SettingsManager> {
		const storage = AgentStorage.open(getAgentDbPath(agentDir));
		SettingsManager.migrateLegacySettingsFile(storage, agentDir);

		// Use capability API to load user-level settings from all providers
		const result = await loadCapability(settingsCapability.id, { cwd });

		// Merge all user-level settings
		let globalSettings: Settings = {};
		for (const item of result.items as SettingsItem[]) {
			if (item.level === "user") {
				globalSettings = deepMergeSettings(globalSettings, item.data as Settings);
			}
		}

		// Load persisted settings from agent.db (legacy settings.json is migrated separately)
		const storedSettings = SettingsManager.loadFromStorage(storage);
		globalSettings = deepMergeSettings(globalSettings, storedSettings);

		// Load project settings before construction (constructor is sync)
		const projectSettings = await SettingsManager.loadProjectSettingsStatic(cwd);

		return new SettingsManager(storage, cwd, globalSettings, true, projectSettings);
	}

	/**
	 * Create an in-memory SettingsManager without persistence.
	 * @param settings - Initial settings to use
	 * @returns SettingsManager that won't persist changes to disk
	 */
	static inMemory(settings: Partial<Settings> = {}): SettingsManager {
		return new SettingsManager(null, null, settings, false, {});
	}

	/**
	 * Serialize settings for passing to subagent workers.
	 * Returns the merged settings (global + project + overrides).
	 */
	serialize(): Settings {
		return { ...this.settings };
	}

	/**
	 * Load settings from SQLite storage, applying any schema migrations.
	 * @param storage - AgentStorage instance, or null for in-memory mode
	 * @returns Parsed and migrated settings, or empty object if storage is null/empty
	 */
	private static loadFromStorage(storage: AgentStorage | null): Settings {
		if (!storage) {
			return {};
		}
		const settings = storage.getSettings();
		if (!settings) {
			return {};
		}
		return SettingsManager.migrateSettings(settings as Record<string, unknown>);
	}

	private static migrateLegacySettingsFile(storage: AgentStorage, agentDir: string): void {
		const settingsPath = join(agentDir, "settings.json");
		if (!existsSync(settingsPath)) return;
		if (storage.getSettings() !== null) return;

		try {
			const content = readFileSync(settingsPath, "utf-8");
			const parsed = JSON.parse(content);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return;
			}
			const migrated = SettingsManager.migrateSettings(parsed as Record<string, unknown>);
			storage.saveSettings(migrated);
			try {
				renameSync(settingsPath, `${settingsPath}.bak`);
			} catch (error) {
				logger.warn("SettingsManager failed to backup settings.json", { error: String(error) });
			}
		} catch (error) {
			logger.warn("SettingsManager failed to migrate settings.json", { error: String(error) });
		}
	}

	/** Migrate old settings format to new format */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		// Migrate queueMode -> steeringMode
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}
		return settings as Settings;
	}

	/**
	 * Static helper to load project settings (used by create() before construction).
	 */
	private static async loadProjectSettingsStatic(cwd: string | null): Promise<Settings> {
		if (!cwd) return {};

		// Use capability API to discover settings from all providers
		const result = await loadCapability(settingsCapability.id, { cwd });

		// Merge only project-level settings (user-level settings are handled separately via globalSettings)
		let merged: Settings = {};
		for (const item of result.items as SettingsItem[]) {
			if (item.level === "project") {
				merged = deepMergeSettings(merged, item.data as Settings);
			}
		}

		return SettingsManager.migrateSettings(merged as Record<string, unknown>);
	}

	private async loadProjectSettings(): Promise<Settings> {
		return SettingsManager.loadProjectSettingsStatic(this.cwd);
	}

	private rebuildSettings(projectSettings: Settings): void {
		this.settings = normalizeSettings(
			deepMergeSettings(deepMergeSettings(this.globalSettings, projectSettings), this.overrides),
		);
	}

	/** Apply additional overrides on top of current settings */
	async applyOverrides(overrides: Partial<Settings>): Promise<void> {
		this.overrides = deepMergeSettings(this.overrides, overrides);
		const projectSettings = await this.loadProjectSettings();
		this.rebuildSettings(projectSettings);
	}

	/**
	 * Persist current global settings to SQLite storage and rebuild merged settings.
	 * Merges with any concurrent changes in storage before saving.
	 */
	private async save(): Promise<void> {
		if (this.persist && this.storage) {
			try {
				const currentSettings = this.storage.getSettings() ?? {};
				const mergedSettings = deepMergeSettings(currentSettings, this.globalSettings);
				this.globalSettings = mergedSettings;
				this.storage.saveSettings(this.globalSettings);
			} catch (error) {
				logger.warn("SettingsManager save failed", { error: String(error) });
			}
		}

		// Always re-merge to update active settings (needed for both file and inMemory modes)
		const projectSettings = await this.loadProjectSettings();
		this.rebuildSettings(projectSettings);
	}

	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	async setLastChangelogVersion(version: string): Promise<void> {
		this.globalSettings.lastChangelogVersion = version;
		await this.save();
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
	async setModelRole(role: string, model: string): Promise<void> {
		if (!this.globalSettings.modelRoles) {
			this.globalSettings.modelRoles = {};
		}
		this.globalSettings.modelRoles[role] = model;

		if (this.overrides.modelRoles && this.overrides.modelRoles[role] !== undefined) {
			this.overrides.modelRoles[role] = model;
		}

		await this.save();
	}

	/**
	 * Get all model roles.
	 */
	getModelRoles(): Record<string, string> {
		return { ...this.settings.modelRoles };
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "one-at-a-time";
	}

	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		this.globalSettings.steeringMode = mode;
		await this.save();
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		this.globalSettings.followUpMode = mode;
		await this.save();
	}

	getInterruptMode(): "immediate" | "wait" {
		return this.settings.interruptMode || "immediate";
	}

	async setInterruptMode(mode: "immediate" | "wait"): Promise<void> {
		this.globalSettings.interruptMode = mode;
		await this.save();
	}

	getTheme(): string | undefined {
		return this.settings.theme;
	}

	async setTheme(theme: string): Promise<void> {
		this.globalSettings.theme = theme;
		await this.save();
	}

	getSymbolPreset(): SymbolPreset | undefined {
		return this.settings.symbolPreset;
	}

	async setSymbolPreset(preset: SymbolPreset): Promise<void> {
		this.globalSettings.symbolPreset = preset;
		await this.save();
	}

	getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
		return this.settings.defaultThinkingLevel;
	}

	async setDefaultThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): Promise<void> {
		this.globalSettings.defaultThinkingLevel = level;
		await this.save();
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	async setCompactionEnabled(enabled: boolean): Promise<void> {
		if (!this.globalSettings.compaction) {
			this.globalSettings.compaction = {};
		}
		this.globalSettings.compaction.enabled = enabled;
		await this.save();
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

	getBranchSummaryEnabled(): boolean {
		return this.settings.branchSummary?.enabled ?? false;
	}

	async setBranchSummaryEnabled(enabled: boolean): Promise<void> {
		if (!this.globalSettings.branchSummary) {
			this.globalSettings.branchSummary = {};
		}
		this.globalSettings.branchSummary.enabled = enabled;
		await this.save();
	}

	getBranchSummarySettings(): { enabled: boolean; reserveTokens: number } {
		return {
			enabled: this.getBranchSummaryEnabled(),
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
		};
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	async setRetryEnabled(enabled: boolean): Promise<void> {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.enabled = enabled;
		await this.save();
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
		};
	}

	getRetryMaxRetries(): number {
		return this.settings.retry?.maxRetries ?? 3;
	}

	async setRetryMaxRetries(maxRetries: number): Promise<void> {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.maxRetries = maxRetries;
		await this.save();
	}

	getRetryBaseDelayMs(): number {
		return this.settings.retry?.baseDelayMs ?? 2000;
	}

	async setRetryBaseDelayMs(baseDelayMs: number): Promise<void> {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.baseDelayMs = baseDelayMs;
		await this.save();
	}

	getTodoCompletionSettings(): { enabled: boolean; maxReminders: number } {
		return {
			enabled: this.settings.todoCompletion?.enabled ?? false,
			maxReminders: this.settings.todoCompletion?.maxReminders ?? 3,
		};
	}

	getTodoCompletionEnabled(): boolean {
		return this.settings.todoCompletion?.enabled ?? false;
	}

	async setTodoCompletionEnabled(enabled: boolean): Promise<void> {
		if (!this.globalSettings.todoCompletion) {
			this.globalSettings.todoCompletion = {};
		}
		this.globalSettings.todoCompletion.enabled = enabled;
		await this.save();
	}

	getTodoCompletionMaxReminders(): number {
		return this.settings.todoCompletion?.maxReminders ?? 3;
	}

	async setTodoCompletionMaxReminders(maxReminders: number): Promise<void> {
		if (!this.globalSettings.todoCompletion) {
			this.globalSettings.todoCompletion = {};
		}
		this.globalSettings.todoCompletion.maxReminders = maxReminders;
		await this.save();
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	async setHideThinkingBlock(hide: boolean): Promise<void> {
		this.globalSettings.hideThinkingBlock = hide;
		await this.save();
	}

	getShellPath(): string | undefined {
		return this.settings.shellPath;
	}

	async setShellPath(path: string | undefined): Promise<void> {
		this.globalSettings.shellPath = path;
		await this.save();
	}

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? false;
	}

	async setCollapseChangelog(collapse: boolean): Promise<void> {
		this.globalSettings.collapseChangelog = collapse;
		await this.save();
	}

	getStartupQuiet(): boolean {
		return this.settings.startup?.quiet ?? false;
	}

	async setStartupQuiet(quiet: boolean): Promise<void> {
		if (!this.globalSettings.startup) {
			this.globalSettings.startup = {};
		}
		this.globalSettings.startup.quiet = quiet;
		await this.save();
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	async setExtensionPaths(paths: string[]): Promise<void> {
		this.globalSettings.extensions = paths;
		await this.save();
	}

	getSkillsEnabled(): boolean {
		return this.settings.skills?.enabled ?? true;
	}

	async setSkillsEnabled(enabled: boolean): Promise<void> {
		if (!this.globalSettings.skills) {
			this.globalSettings.skills = {};
		}
		this.globalSettings.skills.enabled = enabled;
		await this.save();
	}

	getSkillsSettings(): Required<SkillsSettings> {
		return {
			enabled: this.settings.skills?.enabled ?? true,
			enableSkillCommands: this.settings.skills?.enableSkillCommands ?? true,
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

	getEnableSkillCommands(): boolean {
		return this.settings.skills?.enableSkillCommands ?? true;
	}

	async setEnableSkillCommands(enabled: boolean): Promise<void> {
		if (!this.globalSettings.skills) {
			this.globalSettings.skills = {};
		}
		this.globalSettings.skills.enableSkillCommands = enabled;
		await this.save();
	}

	getCommandsSettings(): Required<CommandsSettings> {
		return {
			enableClaudeUser: this.settings.commands?.enableClaudeUser ?? true,
			enableClaudeProject: this.settings.commands?.enableClaudeProject ?? true,
		};
	}

	getCommandsEnableClaudeUser(): boolean {
		return this.settings.commands?.enableClaudeUser ?? true;
	}

	async setCommandsEnableClaudeUser(enabled: boolean): Promise<void> {
		if (!this.globalSettings.commands) {
			this.globalSettings.commands = {};
		}
		this.globalSettings.commands.enableClaudeUser = enabled;
		await this.save();
	}

	getCommandsEnableClaudeProject(): boolean {
		return this.settings.commands?.enableClaudeProject ?? true;
	}

	async setCommandsEnableClaudeProject(enabled: boolean): Promise<void> {
		if (!this.globalSettings.commands) {
			this.globalSettings.commands = {};
		}
		this.globalSettings.commands.enableClaudeProject = enabled;
		await this.save();
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	async setShowImages(show: boolean): Promise<void> {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showImages = show;
		await this.save();
	}

	getNotificationOnComplete(): NotificationMethod {
		return this.settings.notifications?.onComplete ?? "auto";
	}

	async setNotificationOnComplete(method: NotificationMethod): Promise<void> {
		if (!this.globalSettings.notifications) {
			this.globalSettings.notifications = {};
		}
		this.globalSettings.notifications.onComplete = method;
		await this.save();
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	async setImageAutoResize(enabled: boolean): Promise<void> {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.autoResize = enabled;
		await this.save();
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	async setBlockImages(blocked: boolean): Promise<void> {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.blockImages = blocked;
		await this.save();
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

	async setExaEnabled(enabled: boolean): Promise<void> {
		if (!this.globalSettings.exa) {
			this.globalSettings.exa = {};
		}
		this.globalSettings.exa.enabled = enabled;
		await this.save();
	}

	async setExaSearchEnabled(enabled: boolean): Promise<void> {
		if (!this.globalSettings.exa) {
			this.globalSettings.exa = {};
		}
		this.globalSettings.exa.enableSearch = enabled;
		await this.save();
	}

	async setExaLinkedinEnabled(enabled: boolean): Promise<void> {
		if (!this.globalSettings.exa) {
			this.globalSettings.exa = {};
		}
		this.globalSettings.exa.enableLinkedin = enabled;
		await this.save();
	}

	async setExaCompanyEnabled(enabled: boolean): Promise<void> {
		if (!this.globalSettings.exa) {
			this.globalSettings.exa = {};
		}
		this.globalSettings.exa.enableCompany = enabled;
		await this.save();
	}

	async setExaResearcherEnabled(enabled: boolean): Promise<void> {
		if (!this.globalSettings.exa) {
			this.globalSettings.exa = {};
		}
		this.globalSettings.exa.enableResearcher = enabled;
		await this.save();
	}

	async setExaWebsetsEnabled(enabled: boolean): Promise<void> {
		if (!this.globalSettings.exa) {
			this.globalSettings.exa = {};
		}
		this.globalSettings.exa.enableWebsets = enabled;
		await this.save();
	}

	// Provider settings
	getWebSearchProvider(): WebSearchProviderOption {
		return this.settings.providers?.webSearch ?? "auto";
	}

	async setWebSearchProvider(provider: WebSearchProviderOption): Promise<void> {
		if (!this.globalSettings.providers) {
			this.globalSettings.providers = {};
		}
		this.globalSettings.providers.webSearch = provider;
		await this.save();
	}

	getImageProvider(): ImageProviderOption {
		return this.settings.providers?.image ?? "auto";
	}

	async setImageProvider(provider: ImageProviderOption): Promise<void> {
		if (!this.globalSettings.providers) {
			this.globalSettings.providers = {};
		}
		this.globalSettings.providers.image = provider;
		await this.save();
	}

	getBashInterceptorEnabled(): boolean {
		return this.settings.bashInterceptor?.enabled ?? DEFAULT_BASH_INTERCEPTOR_SETTINGS.enabled;
	}

	getBashInterceptorSimpleLsEnabled(): boolean {
		return this.settings.bashInterceptor?.simpleLs ?? DEFAULT_BASH_INTERCEPTOR_SETTINGS.simpleLs;
	}

	getBashInterceptorRules(): BashInterceptorRule[] {
		return [...(this.settings.bashInterceptor?.patterns ?? DEFAULT_BASH_INTERCEPTOR_RULES)];
	}

	async setBashInterceptorEnabled(enabled: boolean): Promise<void> {
		if (!this.globalSettings.bashInterceptor) {
			this.globalSettings.bashInterceptor = {};
		}
		this.globalSettings.bashInterceptor.enabled = enabled;
		await this.save();
	}

	async setBashInterceptorSimpleLsEnabled(enabled: boolean): Promise<void> {
		if (!this.globalSettings.bashInterceptor) {
			this.globalSettings.bashInterceptor = {};
		}
		this.globalSettings.bashInterceptor.simpleLs = enabled;
		await this.save();
	}

	getGitToolEnabled(): boolean {
		return this.settings.git?.enabled ?? false;
	}

	getPythonToolMode(): PythonToolMode {
		return this.settings.python?.toolMode ?? "ipy-only";
	}

	async setPythonToolMode(mode: PythonToolMode): Promise<void> {
		if (!this.globalSettings.python) {
			this.globalSettings.python = {};
		}
		this.globalSettings.python.toolMode = mode;
		await this.save();
	}

	getPythonKernelMode(): PythonKernelMode {
		return this.settings.python?.kernelMode ?? "session";
	}

	async setPythonKernelMode(mode: PythonKernelMode): Promise<void> {
		if (!this.globalSettings.python) {
			this.globalSettings.python = {};
		}
		this.globalSettings.python.kernelMode = mode;
		await this.save();
	}

	getPythonSharedGateway(): boolean {
		return this.settings.python?.sharedGateway ?? true;
	}

	async setPythonSharedGateway(enabled: boolean): Promise<void> {
		if (!this.globalSettings.python) {
			this.globalSettings.python = {};
		}
		this.globalSettings.python.sharedGateway = enabled;
		await this.save();
	}

	async setGitToolEnabled(enabled: boolean): Promise<void> {
		if (!this.globalSettings.git) {
			this.globalSettings.git = {};
		}
		this.globalSettings.git.enabled = enabled;
		await this.save();
	}

	getMCPProjectConfigEnabled(): boolean {
		return this.settings.mcp?.enableProjectConfig ?? true;
	}

	async setMCPProjectConfigEnabled(enabled: boolean): Promise<void> {
		if (!this.globalSettings.mcp) {
			this.globalSettings.mcp = {};
		}
		this.globalSettings.mcp.enableProjectConfig = enabled;
		await this.save();
	}

	getLspFormatOnWrite(): boolean {
		return this.settings.lsp?.formatOnWrite ?? false;
	}

	async setLspFormatOnWrite(enabled: boolean): Promise<void> {
		if (!this.globalSettings.lsp) {
			this.globalSettings.lsp = {};
		}
		this.globalSettings.lsp.formatOnWrite = enabled;
		await this.save();
	}

	getLspDiagnosticsOnWrite(): boolean {
		return this.settings.lsp?.diagnosticsOnWrite ?? true;
	}

	async setLspDiagnosticsOnWrite(enabled: boolean): Promise<void> {
		if (!this.globalSettings.lsp) {
			this.globalSettings.lsp = {};
		}
		this.globalSettings.lsp.diagnosticsOnWrite = enabled;
		await this.save();
	}

	getLspDiagnosticsOnEdit(): boolean {
		return this.settings.lsp?.diagnosticsOnEdit ?? false;
	}

	async setLspDiagnosticsOnEdit(enabled: boolean): Promise<void> {
		if (!this.globalSettings.lsp) {
			this.globalSettings.lsp = {};
		}
		this.globalSettings.lsp.diagnosticsOnEdit = enabled;
		await this.save();
	}

	getEditFuzzyMatch(): boolean {
		return this.settings.edit?.fuzzyMatch ?? true;
	}

	async setEditFuzzyMatch(enabled: boolean): Promise<void> {
		if (!this.globalSettings.edit) {
			this.globalSettings.edit = {};
		}
		this.globalSettings.edit.fuzzyMatch = enabled;
		await this.save();
	}

	getDisabledProviders(): string[] {
		return [...(this.settings.disabledProviders ?? [])];
	}

	async setDisabledProviders(providerIds: string[]): Promise<void> {
		this.globalSettings.disabledProviders = providerIds;
		await this.save();
	}

	getDisabledExtensions(): string[] {
		return [...(this.settings.disabledExtensions ?? [])];
	}

	async setDisabledExtensions(extensionIds: string[]): Promise<void> {
		this.globalSettings.disabledExtensions = extensionIds;
		await this.save();
	}

	isExtensionEnabled(extensionId: string): boolean {
		return !(this.settings.disabledExtensions ?? []).includes(extensionId);
	}

	async enableExtension(extensionId: string): Promise<void> {
		const disabled = this.globalSettings.disabledExtensions ?? [];
		const index = disabled.indexOf(extensionId);
		if (index !== -1) {
			disabled.splice(index, 1);
			this.globalSettings.disabledExtensions = disabled;
			await this.save();
		}
	}

	async disableExtension(extensionId: string): Promise<void> {
		const disabled = this.globalSettings.disabledExtensions ?? [];
		if (!disabled.includes(extensionId)) {
			disabled.push(extensionId);
			this.globalSettings.disabledExtensions = disabled;
			await this.save();
		}
	}

	getTtsrSettings(): TtsrSettings {
		return this.settings.ttsr ?? {};
	}

	async setTtsrSettings(settings: TtsrSettings): Promise<void> {
		this.globalSettings.ttsr = { ...this.globalSettings.ttsr, ...settings };
		await this.save();
	}

	getTtsrEnabled(): boolean {
		return this.settings.ttsr?.enabled ?? true;
	}

	async setTtsrEnabled(enabled: boolean): Promise<void> {
		if (!this.globalSettings.ttsr) {
			this.globalSettings.ttsr = {};
		}
		this.globalSettings.ttsr.enabled = enabled;
		await this.save();
	}

	getTtsrContextMode(): "keep" | "discard" {
		return this.settings.ttsr?.contextMode ?? "discard";
	}

	async setTtsrContextMode(mode: "keep" | "discard"): Promise<void> {
		if (!this.globalSettings.ttsr) {
			this.globalSettings.ttsr = {};
		}
		this.globalSettings.ttsr.contextMode = mode;
		await this.save();
	}

	getTtsrRepeatMode(): "once" | "after-gap" {
		return this.settings.ttsr?.repeatMode ?? "once";
	}

	async setTtsrRepeatMode(mode: "once" | "after-gap"): Promise<void> {
		if (!this.globalSettings.ttsr) {
			this.globalSettings.ttsr = {};
		}
		this.globalSettings.ttsr.repeatMode = mode;
		await this.save();
	}

	getTtsrRepeatGap(): number {
		return this.settings.ttsr?.repeatGap ?? 10;
	}

	async setTtsrRepeatGap(gap: number): Promise<void> {
		if (!this.globalSettings.ttsr) {
			this.globalSettings.ttsr = {};
		}
		this.globalSettings.ttsr.repeatGap = gap;
		await this.save();
	}

	getVoiceSettings(): Required<VoiceSettings> {
		return {
			enabled: this.settings.voice?.enabled ?? false,
			transcriptionModel: this.settings.voice?.transcriptionModel ?? "whisper-1",
			transcriptionLanguage: this.settings.voice?.transcriptionLanguage ?? "",
			ttsModel: this.settings.voice?.ttsModel ?? "tts-1",
			ttsVoice: this.settings.voice?.ttsVoice ?? "alloy",
			ttsFormat: this.settings.voice?.ttsFormat ?? "wav",
		};
	}

	async setVoiceSettings(settings: VoiceSettings): Promise<void> {
		this.globalSettings.voice = { ...this.globalSettings.voice, ...settings };
		await this.save();
	}

	getVoiceEnabled(): boolean {
		return this.settings.voice?.enabled ?? false;
	}

	async setVoiceEnabled(enabled: boolean): Promise<void> {
		if (!this.globalSettings.voice) {
			this.globalSettings.voice = {};
		}
		this.globalSettings.voice.enabled = enabled;
		await this.save();
	}

	getVoiceTtsModel(): string {
		return this.settings.voice?.ttsModel ?? "gpt-4o-mini-tts";
	}

	async setVoiceTtsModel(model: string): Promise<void> {
		if (!this.globalSettings.voice) {
			this.globalSettings.voice = {};
		}
		this.globalSettings.voice.ttsModel = model;
		await this.save();
	}

	getVoiceTtsVoice(): string {
		return this.settings.voice?.ttsVoice ?? "alloy";
	}

	async setVoiceTtsVoice(voice: string): Promise<void> {
		if (!this.globalSettings.voice) {
			this.globalSettings.voice = {};
		}
		this.globalSettings.voice.ttsVoice = voice;
		await this.save();
	}

	getVoiceTtsFormat(): "wav" | "mp3" | "opus" | "aac" | "flac" {
		return this.settings.voice?.ttsFormat ?? "wav";
	}

	async setVoiceTtsFormat(format: "wav" | "mp3" | "opus" | "aac" | "flac"): Promise<void> {
		if (!this.globalSettings.voice) {
			this.globalSettings.voice = {};
		}
		this.globalSettings.voice.ttsFormat = format;
		await this.save();
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// Status Line Settings
	// ═══════════════════════════════════════════════════════════════════════════

	getStatusLineSettings(): StatusLineSettings {
		return this.settings.statusLine ? { ...this.settings.statusLine } : {};
	}

	getStatusLinePreset(): StatusLinePreset {
		return this.settings.statusLine?.preset ?? "default";
	}

	async setStatusLinePreset(preset: StatusLinePreset): Promise<void> {
		if (!this.globalSettings.statusLine) {
			this.globalSettings.statusLine = {};
		}
		if (preset !== "custom") {
			delete this.globalSettings.statusLine.leftSegments;
			delete this.globalSettings.statusLine.rightSegments;
			delete this.globalSettings.statusLine.segmentOptions;
		}
		this.globalSettings.statusLine.preset = preset;
		await this.save();
	}

	getStatusLineSeparator(): StatusLineSeparatorStyle {
		return this.settings.statusLine?.separator ?? "powerline-thin";
	}

	async setStatusLineSeparator(separator: StatusLineSeparatorStyle): Promise<void> {
		if (!this.globalSettings.statusLine) {
			this.globalSettings.statusLine = {};
		}
		this.globalSettings.statusLine.separator = separator;
		await this.save();
	}

	getStatusLineLeftSegments(): StatusLineSegmentId[] {
		return [...(this.settings.statusLine?.leftSegments ?? [])];
	}

	async setStatusLineLeftSegments(segments: StatusLineSegmentId[]): Promise<void> {
		if (!this.globalSettings.statusLine) {
			this.globalSettings.statusLine = {};
		}
		this.globalSettings.statusLine.leftSegments = segments;
		// Setting segments explicitly implies custom preset
		if (this.globalSettings.statusLine.preset !== "custom") {
			this.globalSettings.statusLine.preset = "custom";
		}
		await this.save();
	}

	getStatusLineRightSegments(): StatusLineSegmentId[] {
		return [...(this.settings.statusLine?.rightSegments ?? [])];
	}

	async setStatusLineRightSegments(segments: StatusLineSegmentId[]): Promise<void> {
		if (!this.globalSettings.statusLine) {
			this.globalSettings.statusLine = {};
		}
		this.globalSettings.statusLine.rightSegments = segments;
		// Setting segments explicitly implies custom preset
		if (this.globalSettings.statusLine.preset !== "custom") {
			this.globalSettings.statusLine.preset = "custom";
		}
		await this.save();
	}

	getStatusLineSegmentOptions(): StatusLineSegmentOptions {
		return { ...this.settings.statusLine?.segmentOptions };
	}

	async setStatusLineSegmentOption<K extends keyof StatusLineSegmentOptions>(
		segment: K,
		option: keyof NonNullable<StatusLineSegmentOptions[K]>,
		value: boolean | number | string,
	): Promise<void> {
		if (!this.globalSettings.statusLine) {
			this.globalSettings.statusLine = {};
		}
		if (!this.globalSettings.statusLine.segmentOptions) {
			this.globalSettings.statusLine.segmentOptions = {};
		}
		if (!this.globalSettings.statusLine.segmentOptions[segment]) {
			this.globalSettings.statusLine.segmentOptions[segment] = {} as NonNullable<StatusLineSegmentOptions[K]>;
		}
		(this.globalSettings.statusLine.segmentOptions[segment] as Record<string, unknown>)[option as string] = value;
		await this.save();
	}

	async clearStatusLineSegmentOption<K extends keyof StatusLineSegmentOptions>(
		segment: K,
		option: keyof NonNullable<StatusLineSegmentOptions[K]>,
	): Promise<void> {
		const segmentOptions = this.globalSettings.statusLine?.segmentOptions;
		if (!segmentOptions || !segmentOptions[segment]) {
			return;
		}
		delete (segmentOptions[segment] as Record<string, unknown>)[option as string];
		if (Object.keys(segmentOptions[segment] as Record<string, unknown>).length === 0) {
			delete segmentOptions[segment];
		}
		if (Object.keys(segmentOptions).length === 0) {
			delete this.globalSettings.statusLine?.segmentOptions;
		}
		await this.save();
	}

	getStatusLineShowHookStatus(): boolean {
		return this.settings.statusLine?.showHookStatus ?? true;
	}

	async setStatusLineShowHookStatus(show: boolean): Promise<void> {
		if (!this.globalSettings.statusLine) {
			this.globalSettings.statusLine = {};
		}
		this.globalSettings.statusLine.showHookStatus = show;
		await this.save();
	}

	getDoubleEscapeAction(): "branch" | "tree" {
		return this.settings.doubleEscapeAction ?? "tree";
	}

	async setDoubleEscapeAction(action: "branch" | "tree"): Promise<void> {
		this.globalSettings.doubleEscapeAction = action;
		await this.save();
	}

	getShowHardwareCursor(): boolean {
		// Check settings first
		if (this.settings.showHardwareCursor !== undefined) {
			return this.settings.showHardwareCursor;
		}
		// Check env var override
		const envVar = process.env.OMP_HARDWARE_CURSOR?.toLowerCase();
		if (envVar === "0" || envVar === "false") return false;
		if (envVar === "1" || envVar === "true") return true;
		// Default to true on Linux/macOS for IME support
		return process.platform === "linux" || process.platform === "darwin";
	}

	async setShowHardwareCursor(show: boolean): Promise<void> {
		this.globalSettings.showHardwareCursor = show;
		await this.save();
	}

	/**
	 * Get environment variables from settings
	 */
	getEnvironmentVariables(): Record<string, string> {
		return { ...(this.settings.env ?? {}) };
	}

	/**
	 * Set environment variables in settings (not process.env)
	 * This will be applied on next startup or reload
	 */
	async setEnvironmentVariables(envVars: Record<string, string>): Promise<void> {
		this.globalSettings.env = { ...envVars };
		await this.save();
	}

	/**
	 * Clear all environment variables from settings
	 */
	async clearEnvironmentVariables(): Promise<void> {
		delete this.globalSettings.env;
		await this.save();
	}

	/**
	 * Set a single environment variable in settings
	 */
	async setEnvironmentVariable(key: string, value: string): Promise<void> {
		if (!this.globalSettings.env) {
			this.globalSettings.env = {};
		}
		this.globalSettings.env[key] = value;
		await this.save();
	}

	/**
	 * Remove a single environment variable from settings
	 */
	async removeEnvironmentVariable(key: string): Promise<void> {
		if (this.globalSettings.env) {
			delete this.globalSettings.env[key];
			await this.save();
		}
	}
}
