/**
 * System prompt construction and project context loading
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { contextFileCapability } from "../capability/context-file";
import { systemPromptCapability } from "../capability/system-prompt";
import { type ContextFile, loadCapability, type SystemPrompt as SystemPromptFile } from "../discovery/index";
import customSystemPromptTemplate from "../prompts/system/custom-system-prompt.md" with { type: "text" };
import systemPromptTemplate from "../prompts/system/system-prompt.md" with { type: "text" };
import { renderPromptTemplate } from "./prompt-templates";
import type { SkillsSettings } from "./settings-manager";
import { loadSkills, type Skill } from "./skills";
import type { ToolName } from "./tools/index";

/**
 * Execute a git command synchronously and return stdout or null on failure.
 */
function execGit(args: string[], cwd: string): string | null {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) return null;
	return result.stdout.toString().trim() || null;
}

interface GitContext {
	isRepo: boolean;
	currentBranch: string;
	mainBranch: string;
	status: string;
	commits: string;
}

/**
 * Load git context for the system prompt.
 * Returns structured git data or null if not in a git repo.
 */
export function loadGitContext(cwd: string): GitContext | null {
	// Check if inside a git repo
	const isGitRepo = execGit(["rev-parse", "--is-inside-work-tree"], cwd);
	if (isGitRepo !== "true") return null;

	// Get current branch
	const currentBranch = execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
	if (!currentBranch) return null;

	// Detect main branch (check for 'main' first, then 'master')
	let mainBranch = "main";
	const mainExists = execGit(["rev-parse", "--verify", "main"], cwd);
	if (mainExists === null) {
		const masterExists = execGit(["rev-parse", "--verify", "master"], cwd);
		if (masterExists !== null) mainBranch = "master";
	}

	// Get git status (porcelain format for parsing)
	const gitStatus = execGit(["status", "--porcelain"], cwd);
	const status = gitStatus?.trim() || "(clean)";

	// Get recent commits
	const recentCommits = execGit(["log", "--oneline", "-5"], cwd);
	const commits = recentCommits?.trim() || "(no commits)";

	return {
		isRepo: true,
		currentBranch,
		mainBranch,
		status,
		commits,
	};
}

/** Tool descriptions for system prompt */
const toolDescriptions: Record<ToolName, string> = {
	ask: "Ask user for input or clarification",
	read: "Read file contents",
	bash: "Execute bash commands (npm, docker, etc.)",
	python: "Execute Python code via a session-backed IPython kernel",
	calc: "{ calculations: array of { expression: string, prefix: string, suffix: string } } Basic calculations.",
	ssh: "Execute commands on remote hosts via SSH",
	edit: "Make surgical edits to files (find exact text and replace)",
	write: "Create or overwrite files",
	grep: "Search file contents for patterns (respects .gitignore)",
	find: "Find files by glob pattern (respects .gitignore)",
	git: "Structured Git operations with safety guards (status, diff, log, commit, push, pr, etc.)",
	ls: "List directory contents",
	lsp: "PREFERRED for semantic code queries: go-to-definition, find-all-references, hover (type info), call hierarchy. Returns precise, deterministic results. Use BEFORE grep for symbol lookups.",
	notebook: "Edit Jupyter notebook cells",
	output: "Output structured data to the user (bypasses tool result formatting)",
	task: "Spawn a sub-agent to handle complex tasks",
	web_fetch: "Fetch and render URLs into clean text for LLM consumption",
	web_search: "Search the web for information",
	report_finding: "Report a finding during code review",
};

function execCommand(args: string[]): string | null {
	const result = Bun.spawnSync(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) return null;
	const output = result.stdout.toString().trim();
	return output.length > 0 ? output : null;
}

function execIfExists(command: string, args: string[]): string | null {
	if (!Bun.which(command)) return null;
	return execCommand([command, ...args]);
}

function firstNonEmpty(values: Array<string | undefined | null>): string | null {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return null;
}

function firstNonEmptyLine(value: string | null): string | null {
	if (!value) return null;
	const line = value
		.split("\n")
		.map((entry) => entry.trim())
		.filter(Boolean)[0];
	return line ?? null;
}

function parseWmicTable(output: string, header: string): string | null {
	const lines = output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const filtered = lines.filter((line) => line.toLowerCase() !== header.toLowerCase());
	return filtered[0] ?? null;
}

function parseKeyValueOutput(output: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const [key, ...rest] = trimmed.split("=");
		if (!key || rest.length === 0) continue;
		const value = rest.join("=").trim();
		if (value) result[key.trim()] = value;
	}
	return result;
}

function stripQuotes(value: string): string {
	return value.replace(/^"|"$/g, "");
}

const AGENTS_MD_PATTERN = "**/AGENTS.md";
const AGENTS_MD_LIMIT = 200;

interface AgentsMdSearch {
	scopePath: string;
	limit: number;
	pattern: string;
	files: string[];
}

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/");
}

function listAgentsMdFiles(root: string, limit: number): string[] {
	try {
		const entries = Array.from(
			new Bun.Glob(AGENTS_MD_PATTERN).scanSync({ cwd: root, onlyFiles: true, dot: false, absolute: false }),
		);
		const normalized = entries
			.map((entry) => normalizePath(entry))
			.filter((entry) => entry.length > 0 && !entry.includes("node_modules"))
			.sort();
		return normalized.length > limit ? normalized.slice(0, limit) : normalized;
	} catch {
		return [];
	}
}

function buildAgentsMdSearch(cwd: string): AgentsMdSearch {
	const files = listAgentsMdFiles(cwd, AGENTS_MD_LIMIT);
	return {
		scopePath: ".",
		limit: AGENTS_MD_LIMIT,
		pattern: AGENTS_MD_PATTERN,
		files,
	};
}

function getOsName(): string {
	switch (process.platform) {
		case "win32":
			return "Windows";
		case "darwin":
			return "macOS";
		case "linux":
			return "Linux";
		case "freebsd":
			return "FreeBSD";
		case "openbsd":
			return "OpenBSD";
		case "netbsd":
			return "NetBSD";
		case "aix":
			return "AIX";
		default:
			return process.platform || "unknown";
	}
}

function getKernelVersion(): string {
	if (process.platform === "win32") {
		return execCommand(["cmd", "/c", "ver"]) ?? "unknown";
	}

	return execCommand(["uname", "-sr"]) ?? "unknown";
}

function getOsDistro(): string | null {
	switch (process.platform) {
		case "win32": {
			const output = execIfExists("wmic", ["os", "get", "Caption,Version", "/value"]);
			if (!output) return null;
			const parsed = parseKeyValueOutput(output);
			const caption = parsed.Caption;
			const version = parsed.Version;
			if (caption && version) return `${caption} ${version}`.trim();
			return caption ?? version ?? null;
		}
		case "darwin": {
			const name = firstNonEmptyLine(execIfExists("sw_vers", ["-productName"]));
			const version = firstNonEmptyLine(execIfExists("sw_vers", ["-productVersion"]));
			if (name && version) return `${name} ${version}`.trim();
			return name ?? version ?? null;
		}
		case "linux": {
			const lsb = firstNonEmptyLine(execIfExists("lsb_release", ["-ds"]));
			if (lsb) return stripQuotes(lsb);
			const osRelease = execIfExists("cat", ["/etc/os-release"]);
			if (!osRelease) return null;
			const parsed = parseKeyValueOutput(osRelease);
			const pretty = parsed.PRETTY_NAME ?? parsed.NAME;
			const version = parsed.VERSION ?? parsed.VERSION_ID;
			if (pretty) return stripQuotes(pretty);
			if (parsed.NAME && version) return `${stripQuotes(parsed.NAME)} ${stripQuotes(version)}`.trim();
			return parsed.NAME ? stripQuotes(parsed.NAME) : null;
		}
		default:
			return null;
	}
}

function getCpuArch(): string {
	return process.arch || "unknown";
}

function getCpuModel(): string | null {
	switch (process.platform) {
		case "win32": {
			const output = execIfExists("wmic", ["cpu", "get", "Name"]);
			return output ? parseWmicTable(output, "Name") : null;
		}
		case "darwin": {
			return firstNonEmptyLine(execIfExists("sysctl", ["-n", "machdep.cpu.brand_string"]));
		}
		case "linux": {
			const lscpu = execIfExists("lscpu", []);
			if (lscpu) {
				const match = lscpu
					.split("\n")
					.map((line) => line.trim())
					.find((line) => line.toLowerCase().startsWith("model name:"));
				if (match) return match.split(":").slice(1).join(":").trim();
			}
			const cpuInfo = execIfExists("cat", ["/proc/cpuinfo"]);
			if (!cpuInfo) return null;
			for (const line of cpuInfo.split("\n")) {
				const [key, ...rest] = line.split(":");
				if (!key || rest.length === 0) continue;
				const normalized = key.trim().toLowerCase();
				if (normalized === "model name" || normalized === "hardware" || normalized === "processor") {
					return rest.join(":").trim();
				}
			}
			return null;
		}
		default:
			return null;
	}
}

function getGpuModel(): string | null {
	switch (process.platform) {
		case "win32": {
			const output = execIfExists("wmic", ["path", "win32_VideoController", "get", "name"]);
			return output ? parseWmicTable(output, "Name") : null;
		}
		case "linux": {
			const output = execIfExists("lspci", []);
			if (!output) return null;
			const gpus: Array<{ name: string; priority: number }> = [];
			for (const line of output.split("\n")) {
				if (!/(VGA|3D|Display)/i.test(line)) continue;
				const parts = line.split(":");
				const name = parts.length > 1 ? parts.slice(1).join(":").trim() : line.trim();
				const nameLower = name.toLowerCase();
				// Skip BMC/server management adapters
				if (/aspeed|matrox g200|mgag200/i.test(name)) continue;
				// Prioritize discrete GPUs
				let priority = 0;
				if (
					nameLower.includes("nvidia") ||
					nameLower.includes("geforce") ||
					nameLower.includes("quadro") ||
					nameLower.includes("rtx")
				) {
					priority = 3;
				} else if (nameLower.includes("amd") || nameLower.includes("radeon") || nameLower.includes("rx ")) {
					priority = 3;
				} else if (nameLower.includes("intel")) {
					priority = 1;
				} else {
					priority = 2;
				}
				gpus.push({ name, priority });
			}
			if (gpus.length === 0) return null;
			gpus.sort((a, b) => b.priority - a.priority);
			return gpus[0].name;
		}
		default:
			return null;
	}
}

function getShellName(): string {
	const shell = firstNonEmpty([process.env.SHELL, process.env.ComSpec]);
	return shell ?? "unknown";
}

function getTerminalName(): string {
	const termProgram = process.env.TERM_PROGRAM;
	const termProgramVersion = process.env.TERM_PROGRAM_VERSION;
	if (termProgram) {
		return termProgramVersion ? `${termProgram} ${termProgramVersion}` : termProgram;
	}

	if (process.env.WT_SESSION) return "Windows Terminal";

	const term = firstNonEmpty([process.env.TERM, process.env.COLORTERM, process.env.TERMINAL_EMULATOR]);
	return term ?? "unknown";
}

function normalizeDesktopValue(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "unknown";
	const parts = trimmed
		.split(":")
		.map((part) => part.trim())
		.filter(Boolean);
	return parts[0] ?? trimmed;
}

function getDesktopEnvironment(): string {
	if (process.env.KDE_FULL_SESSION === "true") return "KDE";
	const raw = firstNonEmpty([
		process.env.XDG_CURRENT_DESKTOP,
		process.env.DESKTOP_SESSION,
		process.env.XDG_SESSION_DESKTOP,
		process.env.GDMSESSION,
	]);
	return raw ? normalizeDesktopValue(raw) : "unknown";
}

function matchKnownWindowManager(value: string): string | null {
	const normalized = value.toLowerCase();
	const candidates = [
		"sway",
		"i3",
		"i3wm",
		"bspwm",
		"openbox",
		"awesome",
		"herbstluftwm",
		"fluxbox",
		"icewm",
		"dwm",
		"hyprland",
		"wayfire",
		"river",
		"labwc",
		"qtile",
	];
	for (const candidate of candidates) {
		if (normalized.includes(candidate)) return candidate;
	}
	return null;
}

function getWindowManager(): string {
	const explicit = firstNonEmpty([process.env.WINDOWMANAGER]);
	if (explicit) return explicit;

	const desktop = firstNonEmpty([process.env.XDG_CURRENT_DESKTOP, process.env.DESKTOP_SESSION]);
	if (desktop) {
		const matched = matchKnownWindowManager(desktop);
		if (matched) return matched;
	}

	return "unknown";
}

/** Cached system info structure */
interface SystemInfoCache {
	os: string;
	distro: string;
	kernel: string;
	arch: string;
	cpu: string;
	gpu: string;
	disk: string;
}

function getSystemInfoCachePath(): string {
	return join(homedir(), ".omp", "system_info.json");
}

function loadSystemInfoCache(): SystemInfoCache | null {
	try {
		const cachePath = getSystemInfoCachePath();
		if (!existsSync(cachePath)) return null;
		const content = readFileSync(cachePath, "utf-8");
		return JSON.parse(content) as SystemInfoCache;
	} catch {
		return null;
	}
}

function saveSystemInfoCache(info: SystemInfoCache): void {
	try {
		const cachePath = getSystemInfoCachePath();
		const dir = join(homedir(), ".omp");
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(cachePath, JSON.stringify(info, null, "\t"), "utf-8");
	} catch {
		// Silently ignore cache write failures
	}
}

function collectSystemInfo(): SystemInfoCache {
	return {
		os: getOsName(),
		distro: getOsDistro() ?? "unknown",
		kernel: getKernelVersion(),
		arch: getCpuArch(),
		cpu: getCpuModel() ?? "unknown",
		gpu: getGpuModel() ?? "unknown",
		disk: getDiskInfo() ?? "unknown",
	};
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	if (bytes < 1024 * 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
	return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(1)}TB`;
}

function getDiskInfo(): string | null {
	switch (process.platform) {
		case "win32": {
			const output = execIfExists("wmic", ["logicaldisk", "get", "Caption,Size,FreeSpace", "/format:csv"]);
			if (!output) return null;
			const lines = output.split("\n").filter((l) => l.trim() && !l.startsWith("Node"));
			const disks: string[] = [];
			for (const line of lines) {
				const parts = line.split(",");
				if (parts.length < 4) continue;
				const caption = parts[1]?.trim();
				const freeSpace = Number.parseInt(parts[2]?.trim() ?? "", 10);
				const size = Number.parseInt(parts[3]?.trim() ?? "", 10);
				if (!caption || Number.isNaN(size) || size === 0) continue;
				const used = size - (Number.isNaN(freeSpace) ? 0 : freeSpace);
				const pct = Math.round((used / size) * 100);
				disks.push(`${caption} ${formatBytes(used)}/${formatBytes(size)} (${pct}%)`);
			}
			return disks.length > 0 ? disks.join(", ") : null;
		}
		case "linux":
		case "darwin": {
			const output = execIfExists("df", ["-h", "/"]);
			if (!output) return null;
			const lines = output.split("\n");
			if (lines.length < 2) return null;
			const parts = lines[1].split(/\s+/);
			if (parts.length < 5) return null;
			const size = parts[1];
			const used = parts[2];
			const pct = parts[4];
			return `/ ${used}/${size} (${pct})`;
		}
		default:
			return null;
	}
}

function getEnvironmentInfo(): Array<{ label: string; value: string }> {
	// Load cached system info or collect fresh
	let sysInfo = loadSystemInfoCache();
	if (!sysInfo) {
		sysInfo = collectSystemInfo();
		saveSystemInfoCache(sysInfo);
	}

	return [
		{ label: "OS", value: sysInfo.os },
		{ label: "Distro", value: sysInfo.distro },
		{ label: "Kernel", value: sysInfo.kernel },
		{ label: "Arch", value: sysInfo.arch },
		{ label: "CPU", value: sysInfo.cpu },
		{ label: "GPU", value: sysInfo.gpu },
		{ label: "Disk", value: sysInfo.disk },
		{ label: "Shell", value: getShellName() },
		{ label: "Terminal", value: getTerminalName() },
		{ label: "DE", value: getDesktopEnvironment() },
		{ label: "WM", value: getWindowManager() },
	];
}

/** Resolve input as file path or literal string */
export function resolvePromptInput(input: string | undefined, description: string): string | undefined {
	if (!input) {
		return undefined;
	}

	if (existsSync(input)) {
		try {
			return readFileSync(input, "utf-8");
		} catch (error) {
			console.error(chalk.yellow(`Warning: Could not read ${description} file ${input}: ${error}`));
			return input;
		}
	}

	return input;
}

export interface LoadContextFilesOptions {
	/** Working directory to start walking up from. Default: process.cwd() */
	cwd?: string;
}

/**
 * Load all project context files using the capability API.
 * Returns {path, content, depth} entries for all discovered context files.
 * Files are sorted by depth (descending) so files closer to cwd appear last/more prominent.
 */
export async function loadProjectContextFiles(
	options: LoadContextFilesOptions = {},
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	const resolvedCwd = options.cwd ?? process.cwd();

	const result = await loadCapability(contextFileCapability.id, { cwd: resolvedCwd });

	// Convert ContextFile items and preserve depth info
	const files = result.items.map((item) => {
		const contextFile = item as ContextFile;
		return {
			path: contextFile.path,
			content: contextFile.content,
			depth: contextFile.depth,
		};
	});

	// Sort by depth (descending): higher depth (farther from cwd) comes first,
	// so files closer to cwd appear later and are more prominent
	files.sort((a, b) => {
		const depthA = a.depth ?? -1;
		const depthB = b.depth ?? -1;
		return depthB - depthA;
	});

	return files;
}

/**
 * Load system prompt customization files (SYSTEM.md).
 * Returns combined content from all discovered SYSTEM.md files.
 */
export async function loadSystemPromptFiles(options: LoadContextFilesOptions = {}): Promise<string | null> {
	const resolvedCwd = options.cwd ?? process.cwd();

	const result = await loadCapability<SystemPromptFile>(systemPromptCapability.id, { cwd: resolvedCwd });

	if (result.items.length === 0) return null;

	// Combine all SYSTEM.md contents (user-level first, then project-level)
	const userLevel = result.items.filter((item) => item.level === "user");
	const projectLevel = result.items.filter((item) => item.level === "project");

	const parts: string[] = [];
	for (const item of [...userLevel, ...projectLevel]) {
		parts.push(item.content);
	}

	return parts.join("\n\n");
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. */
	tools?: Map<string, { description: string; label: string }>;
	/** Tool names to include in prompt. */
	toolNames?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Skills settings for discovery. */
	skillsSettings?: SkillsSettings;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files (skips discovery if provided). */
	contextFiles?: Array<{ path: string; content: string; depth?: number }>;
	/** Pre-loaded skills (skips discovery if provided). */
	skills?: Skill[];
	/** Pre-loaded rulebook rules (rules with descriptions, excluding TTSR and always-apply). */
	rules?: Array<{ name: string; description?: string; path: string; globs?: string[] }>;
}

/** Build the system prompt with tools, guidelines, and context */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<string> {
	if (process.env.NULL_PROMPT === "true") {
		return "";
	}

	const {
		customPrompt,
		tools,
		appendSystemPrompt,
		skillsSettings,
		toolNames,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		rules,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const resolvedCustomPrompt = resolvePromptInput(customPrompt, "system prompt");
	const resolvedAppendPrompt = resolvePromptInput(appendSystemPrompt, "append system prompt");

	// Load SYSTEM.md customization (prepended to prompt)
	const systemPromptCustomization = await loadSystemPromptFiles({ cwd: resolvedCwd });

	const now = new Date();
	const dateTime = now.toLocaleString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		timeZoneName: "short",
	});

	// Resolve context files: use provided or discover
	const contextFiles = providedContextFiles ?? (await loadProjectContextFiles({ cwd: resolvedCwd }));
	const agentsMdSearch = buildAgentsMdSearch(resolvedCwd);

	// Build tool descriptions array
	// Priority: toolNames (explicit list) > tools (Map) > defaults
	// Default includes both bash and python; actual availability determined by settings in createTools
	const defaultToolNames: ToolName[] = ["read", "bash", "python", "edit", "write"];
	let toolNamesArray: string[];
	if (toolNames !== undefined) {
		// Explicit toolNames list provided (could be empty)
		toolNamesArray = toolNames;
	} else if (tools !== undefined) {
		// Tools map provided
		toolNamesArray = Array.from(tools.keys());
	} else {
		// Use defaults
		toolNamesArray = defaultToolNames;
	}
	const toolDescriptionsArray = toolNamesArray.map((name) => ({
		name,
		description: toolDescriptions[name as ToolName] ?? "",
	}));

	// Resolve skills: use provided or discover
	const skills =
		providedSkills ??
		(skillsSettings?.enabled !== false ? (await loadSkills({ ...skillsSettings, cwd: resolvedCwd })).skills : []);

	// Get git context
	const git = loadGitContext(resolvedCwd);

	// Filter skills to only include those with read tool
	const hasRead = tools?.has("read");
	const filteredSkills = hasRead ? skills : [];

	if (resolvedCustomPrompt) {
		return renderPromptTemplate(customSystemPromptTemplate, {
			systemPromptCustomization: systemPromptCustomization ?? "",
			customPrompt: resolvedCustomPrompt,
			appendPrompt: resolvedAppendPrompt ?? "",
			contextFiles,
			agentsMdSearch,
			toolDescriptions: toolDescriptionsArray,
			git,
			skills: filteredSkills,
			rules: rules ?? [],
			dateTime,
			cwd: resolvedCwd,
		});
	}

	return renderPromptTemplate(systemPromptTemplate, {
		tools: toolNamesArray,
		toolDescriptions: toolDescriptionsArray,
		environment: getEnvironmentInfo(),
		systemPromptCustomization: systemPromptCustomization ?? "",
		contextFiles,
		agentsMdSearch,
		git,
		skills: filteredSkills,
		rules: rules ?? [],
		dateTime,
		cwd: resolvedCwd,
		appendSystemPrompt: resolvedAppendPrompt ?? "",
	});
}
