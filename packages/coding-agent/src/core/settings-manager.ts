import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Settings as SettingsItem, settingsCapability } from "../capability/settings";
import { getAgentDir } from "../config";
import { loadSync } from "../discovery";
import type { SymbolPreset } from "../modes/interactive/theme/theme";

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

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
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
	doubleEscapeAction?: "branch" | "tree"; // Action for double-escape with empty editor (default: "tree")
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
	edit?: EditSettings;
	ttsr?: TtsrSettings;
	voice?: VoiceSettings;
	providers?: ProviderSettings;
	disabledProviders?: string[]; // Discovery provider IDs that are disabled
	disabledExtensions?: string[]; // Individual extension IDs that are disabled (e.g., "skill:commit")
	statusLine?: StatusLineSettings; // Status line configuration
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

function normalizeSettings(settings: Settings): Settings {
	const merged = deepMergeSettings(DEFAULT_SETTINGS, settings);
	return {
		...merged,
		bashInterceptor: normalizeBashInterceptorSettings(merged.bashInterceptor),
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
		this.settings = normalizeSettings(deepMergeSettings(this.globalSettings, projectSettings));

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
			const settings = JSON.parse(content);
			return SettingsManager.migrateSettings(settings as Record<string, unknown>);
		} catch (error) {
			console.error(`Warning: Could not read settings file ${path}: ${error}`);
			return {};
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

		return SettingsManager.migrateSettings(merged as Record<string, unknown>);
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		this.settings = normalizeSettings(deepMergeSettings(this.settings, overrides));
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
			this.settings = normalizeSettings(deepMergeSettings(this.globalSettings, projectSettings));
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

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "one-at-a-time";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.steeringMode = mode;
		this.save();
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.followUpMode = mode;
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

	getSymbolPreset(): SymbolPreset | undefined {
		return this.settings.symbolPreset;
	}

	setSymbolPreset(preset: SymbolPreset): void {
		this.globalSettings.symbolPreset = preset;
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

	getBranchSummaryEnabled(): boolean {
		return this.settings.branchSummary?.enabled ?? false;
	}

	setBranchSummaryEnabled(enabled: boolean): void {
		if (!this.globalSettings.branchSummary) {
			this.globalSettings.branchSummary = {};
		}
		this.globalSettings.branchSummary.enabled = enabled;
		this.save();
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

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.globalSettings.extensions = paths;
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

	getNotificationOnComplete(): NotificationMethod {
		return this.settings.notifications?.onComplete ?? "auto";
	}

	setNotificationOnComplete(method: NotificationMethod): void {
		if (!this.globalSettings.notifications) {
			this.globalSettings.notifications = {};
		}
		this.globalSettings.notifications.onComplete = method;
		this.save();
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.autoResize = enabled;
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

	// Provider settings
	getWebSearchProvider(): WebSearchProviderOption {
		return this.settings.providers?.webSearch ?? "auto";
	}

	setWebSearchProvider(provider: WebSearchProviderOption): void {
		if (!this.globalSettings.providers) {
			this.globalSettings.providers = {};
		}
		this.globalSettings.providers.webSearch = provider;
		this.save();
	}

	getImageProvider(): ImageProviderOption {
		return this.settings.providers?.image ?? "auto";
	}

	setImageProvider(provider: ImageProviderOption): void {
		if (!this.globalSettings.providers) {
			this.globalSettings.providers = {};
		}
		this.globalSettings.providers.image = provider;
		this.save();
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

	setBashInterceptorEnabled(enabled: boolean): void {
		if (!this.globalSettings.bashInterceptor) {
			this.globalSettings.bashInterceptor = {};
		}
		this.globalSettings.bashInterceptor.enabled = enabled;
		this.save();
	}

	getGitToolEnabled(): boolean {
		return this.settings.git?.enabled ?? false;
	}

	setGitToolEnabled(enabled: boolean): void {
		if (!this.globalSettings.git) {
			this.globalSettings.git = {};
		}
		this.globalSettings.git.enabled = enabled;
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
		return this.settings.lsp?.formatOnWrite ?? false;
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

	getDisabledExtensions(): string[] {
		return [...(this.settings.disabledExtensions ?? [])];
	}

	setDisabledExtensions(extensionIds: string[]): void {
		this.globalSettings.disabledExtensions = extensionIds;
		this.save();
	}

	isExtensionEnabled(extensionId: string): boolean {
		return !(this.settings.disabledExtensions ?? []).includes(extensionId);
	}

	enableExtension(extensionId: string): void {
		const disabled = this.globalSettings.disabledExtensions ?? [];
		const index = disabled.indexOf(extensionId);
		if (index !== -1) {
			disabled.splice(index, 1);
			this.globalSettings.disabledExtensions = disabled;
			this.save();
		}
	}

	disableExtension(extensionId: string): void {
		const disabled = this.globalSettings.disabledExtensions ?? [];
		if (!disabled.includes(extensionId)) {
			disabled.push(extensionId);
			this.globalSettings.disabledExtensions = disabled;
			this.save();
		}
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

	setVoiceSettings(settings: VoiceSettings): void {
		this.globalSettings.voice = { ...this.globalSettings.voice, ...settings };
		this.save();
	}

	getVoiceEnabled(): boolean {
		return this.settings.voice?.enabled ?? false;
	}

	setVoiceEnabled(enabled: boolean): void {
		if (!this.globalSettings.voice) {
			this.globalSettings.voice = {};
		}
		this.globalSettings.voice.enabled = enabled;
		this.save();
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

	setStatusLinePreset(preset: StatusLinePreset): void {
		if (!this.globalSettings.statusLine) {
			this.globalSettings.statusLine = {};
		}
		if (preset !== "custom") {
			delete this.globalSettings.statusLine.leftSegments;
			delete this.globalSettings.statusLine.rightSegments;
			delete this.globalSettings.statusLine.segmentOptions;
		}
		this.globalSettings.statusLine.preset = preset;
		this.save();
	}

	getStatusLineSeparator(): StatusLineSeparatorStyle {
		return this.settings.statusLine?.separator ?? "powerline-thin";
	}

	setStatusLineSeparator(separator: StatusLineSeparatorStyle): void {
		if (!this.globalSettings.statusLine) {
			this.globalSettings.statusLine = {};
		}
		this.globalSettings.statusLine.separator = separator;
		this.save();
	}

	getStatusLineLeftSegments(): StatusLineSegmentId[] {
		return [...(this.settings.statusLine?.leftSegments ?? [])];
	}

	setStatusLineLeftSegments(segments: StatusLineSegmentId[]): void {
		if (!this.globalSettings.statusLine) {
			this.globalSettings.statusLine = {};
		}
		this.globalSettings.statusLine.leftSegments = segments;
		// Setting segments explicitly implies custom preset
		if (this.globalSettings.statusLine.preset !== "custom") {
			this.globalSettings.statusLine.preset = "custom";
		}
		this.save();
	}

	getStatusLineRightSegments(): StatusLineSegmentId[] {
		return [...(this.settings.statusLine?.rightSegments ?? [])];
	}

	setStatusLineRightSegments(segments: StatusLineSegmentId[]): void {
		if (!this.globalSettings.statusLine) {
			this.globalSettings.statusLine = {};
		}
		this.globalSettings.statusLine.rightSegments = segments;
		// Setting segments explicitly implies custom preset
		if (this.globalSettings.statusLine.preset !== "custom") {
			this.globalSettings.statusLine.preset = "custom";
		}
		this.save();
	}

	getStatusLineSegmentOptions(): StatusLineSegmentOptions {
		return { ...this.settings.statusLine?.segmentOptions };
	}

	setStatusLineSegmentOption<K extends keyof StatusLineSegmentOptions>(
		segment: K,
		option: keyof NonNullable<StatusLineSegmentOptions[K]>,
		value: boolean | number | string,
	): void {
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
		this.save();
	}

	clearStatusLineSegmentOption<K extends keyof StatusLineSegmentOptions>(
		segment: K,
		option: keyof NonNullable<StatusLineSegmentOptions[K]>,
	): void {
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
		this.save();
	}

	getStatusLineShowHookStatus(): boolean {
		return this.settings.statusLine?.showHookStatus ?? true;
	}

	setStatusLineShowHookStatus(show: boolean): void {
		if (!this.globalSettings.statusLine) {
			this.globalSettings.statusLine = {};
		}
		this.globalSettings.statusLine.showHookStatus = show;
		this.save();
	}

	getDoubleEscapeAction(): "branch" | "tree" {
		return this.settings.doubleEscapeAction ?? "tree";
	}

	setDoubleEscapeAction(action: "branch" | "tree"): void {
		this.globalSettings.doubleEscapeAction = action;
		this.save();
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
	setEnvironmentVariables(envVars: Record<string, string>): void {
		this.globalSettings.env = { ...envVars };
		this.save();
	}

	/**
	 * Clear all environment variables from settings
	 */
	clearEnvironmentVariables(): void {
		delete this.globalSettings.env;
		this.save();
	}

	/**
	 * Set a single environment variable in settings
	 */
	setEnvironmentVariable(key: string, value: string): void {
		if (!this.globalSettings.env) {
			this.globalSettings.env = {};
		}
		this.globalSettings.env[key] = value;
		this.save();
	}

	/**
	 * Remove a single environment variable from settings
	 */
	removeEnvironmentVariable(key: string): void {
		if (this.globalSettings.env) {
			delete this.globalSettings.env[key];
			this.save();
		}
	}
}
