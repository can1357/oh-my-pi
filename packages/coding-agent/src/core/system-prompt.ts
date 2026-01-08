/**
 * System prompt construction and project context loading
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { contextFileCapability } from "../capability/context-file";
import type { Rule } from "../capability/rule";
import { systemPromptCapability } from "../capability/system-prompt";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config";
import { type ContextFile, loadSync, type SystemPrompt as SystemPromptFile } from "../discovery/index";
import systemPromptTemplate from "../prompts/system-prompt.md" with { type: "text" };
import type { SkillsSettings } from "./settings-manager";
import { formatSkillsForPrompt, loadSkills, type Skill } from "./skills";
import type { ToolName } from "./tools/index";
import { formatRulesForPrompt } from "./tools/rulebook";

/**
 * Execute a git command synchronously and return stdout or null on failure.
 */
function execGit(args: string[], cwd: string): string | null {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) return null;
	return result.stdout.toString().trim() || null;
}

/**
 * Load git context for the system prompt.
 * Returns formatted git status or null if not in a git repo.
 */
export function loadGitContext(cwd: string): string | null {
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
	const statusText = gitStatus?.trim() || "(clean)";

	// Get recent commits
	const recentCommits = execGit(["log", "--oneline", "-5"], cwd);
	const commitsText = recentCommits?.trim() || "(no commits)";

	return `This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.
Current branch: ${currentBranch}

Main branch (you will usually use this for PRs): ${mainBranch}

Status:
${statusText}

Recent commits:
${commitsText}`;
}

/** Tool descriptions for system prompt */
const toolDescriptions: Record<ToolName, string> = {
	ask: "Ask user for input or clarification",
	read: "Read file contents",
	bash: "Execute bash commands (npm, docker, etc.)",
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

function applyTemplate(template: string, values: Record<string, string>): string {
	let output = template;
	for (const [key, value] of Object.entries(values)) {
		output = output.replaceAll(`{{${key}}}`, value);
	}
	return output;
}

function appendBlock(prompt: string, block: string | null | undefined, separator = "\n\n"): string {
	if (!block) return prompt;
	if (block.startsWith("\n")) {
		return `${prompt}${block}`;
	}
	return `${prompt}${separator}${block}`;
}

function appendSection(prompt: string, title: string, content: string | null | undefined): string {
	if (!content) return prompt;
	return `${prompt}\n\n# ${title}\n\n${content}`;
}

function formatProjectContext(contextFiles: Array<{ path: string; content: string; depth?: number }>): string | null {
	if (contextFiles.length === 0) return null;
	const parts: string[] = ["The following project context files have been loaded:", ""];
	for (const { path: filePath, content } of contextFiles) {
		parts.push(`## ${filePath}`, "", content, "");
	}
	return parts.join("\n").trimEnd();
}

function formatToolDescriptions(tools: Map<string, { description: string; label: string }> | undefined): string | null {
	if (!tools || tools.size === 0) return null;
	return Array.from(tools.entries())
		.map(([name, { description }]) => `- ${name}: ${description}`)
		.join("\n");
}

function buildPromptFooter(dateTime: string, cwd: string): string {
	return `Current date and time: ${dateTime}\nCurrent working directory: ${cwd}`;
}

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

function formatEnvironmentInfo(): string {
	// Load cached system info or collect fresh
	let sysInfo = loadSystemInfoCache();
	if (!sysInfo) {
		sysInfo = collectSystemInfo();
		saveSystemInfoCache(sysInfo);
	}

	// Session-specific values (not cached)
	const items: Array<[string, string]> = [
		["OS", sysInfo.os],
		["Distro", sysInfo.distro],
		["Kernel", sysInfo.kernel],
		["Arch", sysInfo.arch],
		["CPU", sysInfo.cpu],
		["GPU", sysInfo.gpu],
		["Disk", sysInfo.disk],
		["Shell", getShellName()],
		["Terminal", getTerminalName()],
		["DE", getDesktopEnvironment()],
		["WM", getWindowManager()],
	];
	return items.map(([label, value]) => `- ${label}: ${value}`).join("\n");
}

/**
 * Generate anti-bash rules section if the agent has both bash and specialized tools.
 * Only include rules for tools that are actually available.
 */
function generateAntiBashRules(tools: ToolName[]): string | null {
	const hasBash = tools.includes("bash");
	if (!hasBash) return null;

	const hasRead = tools.includes("read");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasEdit = tools.includes("edit");
	const hasLsp = tools.includes("lsp");
	const hasGit = tools.includes("git");

	// Only show rules if we have specialized tools that should be preferred
	const hasSpecializedTools = hasRead || hasGrep || hasFind || hasLs || hasEdit || hasGit;
	if (!hasSpecializedTools) return null;

	const lines: string[] = [];
	lines.push("## Tool Usage Rules — MANDATORY\n");
	lines.push("### Forbidden Bash Patterns");
	lines.push("NEVER use bash for these operations:\n");

	if (hasRead) lines.push("- **File reading**: Use `read` instead of cat/head/tail/less/more");
	if (hasGrep) lines.push("- **Content search**: Use `grep` instead of grep/rg/ag/ack");
	if (hasFind) lines.push("- **File finding**: Use `find` instead of find/fd/locate");
	if (hasLs) lines.push("- **Directory listing**: Use `ls` instead of bash ls");
	if (hasEdit) lines.push("- **File editing**: Use `edit` instead of sed/awk/perl -pi/echo >/cat <<EOF");
	if (hasGit) lines.push("- **Git operations**: Use `git` tool instead of bash git commands");

	lines.push("\n### Tool Preference (highest → lowest priority)");
	const ladder: string[] = [];
	if (hasLsp) ladder.push("lsp (go-to-definition, references, type info) — DETERMINISTIC");
	if (hasGrep) ladder.push("grep (text/regex search)");
	if (hasFind) ladder.push("find (locate files by pattern)");
	if (hasRead) ladder.push("read (view file contents)");
	if (hasEdit) ladder.push("edit (precise text replacement)");
	if (hasGit) ladder.push("git (structured git operations with safety guards)");
	ladder.push(`bash (ONLY for ${hasGit ? "" : "git, "}npm, docker, make, cargo, etc.)`);
	lines.push(ladder.map((t, i) => `${i + 1}. ${t}`).join("\n"));

	// Add LSP guidance if available
	if (hasLsp) {
		lines.push("\n### LSP — Preferred for Semantic Queries");
		lines.push("Use `lsp` instead of grep/bash when you need:");
		lines.push("- **Where is X defined?** → `lsp definition`");
		lines.push("- **What calls X?** → `lsp incoming_calls`");
		lines.push("- **What does X call?** → `lsp outgoing_calls`");
		lines.push("- **What type is X?** → `lsp hover`");
		lines.push("- **What symbols are in this file?** → `lsp symbols`");
		lines.push("- **Find symbol across codebase** → `lsp workspace_symbols`\n");
	}

	// Add Git guidance if available
	if (hasGit) {
		lines.push("\n### Git Tool — Preferred for Git Operations");
		lines.push("Use `git` instead of bash git when you need:");
		lines.push(
			"- **Status/diff/log**: `git { operation: 'status' }`, `git { operation: 'diff' }`, `git { operation: 'log' }`",
		);
		lines.push(
			"- **Commit workflow**: `git { operation: 'add', paths: [...] }` then `git { operation: 'commit', message: '...' }`",
		);
		lines.push("- **Branching**: `git { operation: 'branch', action: 'create', name: '...' }`");
		lines.push("- **GitHub PRs**: `git { operation: 'pr', action: 'create', title: '...', body: '...' }`");
		lines.push(
			"- **GitHub Issues**: `git { operation: 'issue', action: 'list' }` or `{ operation: 'issue', number: 123 }`",
		);
		lines.push(
			"The git tool provides typed output, safety guards, and a clean API for all git and GitHub operations.\n",
		);
	}

	// Add SSH remote filesystem guidance if available
	const hasSSH = tools.includes("ssh");
	if (hasSSH) {
		lines.push("\n### SSH Command Execution");
		lines.push(
			"**Critical**: Each SSH host runs a specific shell. **You MUST match commands to the host's shell type**.",
		);
		lines.push("Check the host list in the ssh tool description. Shell types:");
		lines.push("- linux/bash, linux/zsh, macos/bash, macos/zsh: ls, cat, grep, find, ps, df, uname");
		lines.push("- windows/bash, windows/sh: ls, cat, grep, find (Windows with WSL/Cygwin — Unix commands)");
		lines.push("- windows/cmd: dir, type, findstr, tasklist, systeminfo");
		lines.push("- windows/powershell: Get-ChildItem, Get-Content, Select-String, Get-Process");
		lines.push("");
		lines.push("### SSH Filesystems");
		lines.push("Mounted at `~/.omp/remote/<hostname>/` — use read/edit/write tools directly.");
		lines.push("Windows paths need colon: `~/.omp/remote/host/C:/Users/...` not `C/Users/...`\n");
	}

	// Add search-first protocol
	if (hasGrep || hasFind) {
		lines.push("\n### Search-First Protocol");
		lines.push("Before reading any file:");
		if (hasFind) lines.push("1. Unknown structure → `find` to see file layout");
		if (hasGrep) lines.push("2. Known location → `grep` for specific symbol/error");
		if (hasRead) lines.push("3. Use `read offset/limit` for line ranges, not entire large files");
		lines.push("4. Never read a large file hoping to find something — search first");
	}

	return lines.join("\n");
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
export function loadProjectContextFiles(
	options: LoadContextFilesOptions = {},
): Array<{ path: string; content: string; depth?: number }> {
	const resolvedCwd = options.cwd ?? process.cwd();

	const result = loadSync(contextFileCapability.id, { cwd: resolvedCwd });

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
export function loadSystemPromptFiles(options: LoadContextFilesOptions = {}): string | null {
	const resolvedCwd = options.cwd ?? process.cwd();

	const result = loadSync<SystemPromptFile>(systemPromptCapability.id, { cwd: resolvedCwd });

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
	rules?: Rule[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		tools,
		appendSystemPrompt,
		skillsSettings,
		toolNames,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		rules: rulebookRules,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const resolvedCustomPrompt = resolvePromptInput(customPrompt, "system prompt");
	const resolvedAppendPrompt = resolvePromptInput(appendSystemPrompt, "append system prompt");

	// Load SYSTEM.md customization (prepended to prompt)
	const systemPromptCustomization = loadSystemPromptFiles({ cwd: resolvedCwd });

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
	const contextFiles = providedContextFiles ?? loadProjectContextFiles({ cwd: resolvedCwd });

	// Build tools list based on selected tools
	const toolsList = toolNames?.map((name) => `- ${name}: ${toolDescriptions[name as ToolName]}`).join("\n") ?? "";

	// Resolve skills: use provided or discover
	const skills =
		providedSkills ??
		(skillsSettings?.enabled !== false ? loadSkills({ ...skillsSettings, cwd: resolvedCwd }).skills : []);

	if (resolvedCustomPrompt) {
		let prompt = systemPromptCustomization
			? `${systemPromptCustomization}\n\n${resolvedCustomPrompt}`
			: resolvedCustomPrompt;

		prompt = appendBlock(prompt, resolvedAppendPrompt);
		prompt = appendSection(prompt, "Project Context", formatProjectContext(contextFiles));
		prompt = appendSection(prompt, "Tools", formatToolDescriptions(tools));

		const gitContext = loadGitContext(resolvedCwd);
		prompt = appendSection(prompt, "Git Status", gitContext);

		if (tools?.has("read") && skills.length > 0) {
			prompt = appendBlock(prompt, formatSkillsForPrompt(skills));
		}

		if (rulebookRules && rulebookRules.length > 0) {
			prompt = appendBlock(prompt, formatRulesForPrompt(rulebookRules));
		}

		prompt = appendBlock(prompt, buildPromptFooter(dateTime, resolvedCwd), "\n");

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Generate anti-bash rules (returns null if not applicable)
	const antiBashSection = generateAntiBashRules(Array.from(tools?.keys() ?? []));
	const environmentInfo = formatEnvironmentInfo();

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];

	const hasBash = tools?.has("bash");
	const hasEdit = tools?.has("edit");
	const hasWrite = tools?.has("write");
	const hasRead = tools?.has("read");

	// Read-only mode notice (no bash, edit, or write)
	if (!hasBash && !hasEdit && !hasWrite) {
		guidelinesList.push("You are in READ-ONLY mode - you cannot modify files or execute arbitrary commands");
	}

	// Bash without edit/write = read-only bash mode
	if (hasBash && !hasEdit && !hasWrite) {
		guidelinesList.push(
			"Use bash ONLY for read-only operations (git log, gh issue view, curl, etc.) - do NOT modify any files",
		);
	}

	// Read before edit guideline
	if (hasRead && hasEdit) {
		guidelinesList.push("Use read to examine files before editing");
	}

	// Edit guideline
	if (hasEdit) {
		guidelinesList.push(
			"Use edit for precise changes (old text must match exactly, fuzzy matching handles whitespace)",
		);
	}

	// Write guideline
	if (hasWrite) {
		guidelinesList.push("Use write only for new files or complete rewrites");
	}

	// Output guideline (only when actually writing/executing)
	if (hasEdit || hasWrite) {
		guidelinesList.push(
			"When summarizing your actions, output plain text directly - do NOT use cat or bash to display what you did",
		);
	}

	// Always include these
	guidelinesList.push("Be concise in your responses");
	guidelinesList.push("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	// Build the prompt with anti-bash rules prominently placed
	const antiBashBlock = antiBashSection ? `\n${antiBashSection}\n` : "";
	let prompt = applyTemplate(systemPromptTemplate, {
		toolsList,
		antiBashSection: antiBashBlock,
		guidelines,
		environmentInfo,
		readmePath,
		docsPath,
		examplesPath,
	});

	prompt = appendBlock(prompt, resolvedAppendPrompt);
	prompt = appendSection(prompt, "Project Context", formatProjectContext(contextFiles));

	const gitContext = loadGitContext(resolvedCwd);
	prompt = appendSection(prompt, "Git Status", gitContext);

	if (hasRead && skills.length > 0) {
		prompt = appendBlock(prompt, formatSkillsForPrompt(skills));
	}

	if (rulebookRules && rulebookRules.length > 0) {
		prompt = appendBlock(prompt, formatRulesForPrompt(rulebookRules));
	}

	prompt = appendBlock(prompt, buildPromptFooter(dateTime, resolvedCwd), "\n");

	// Prepend SYSTEM.md customization if present
	if (systemPromptCustomization) {
		prompt = `${systemPromptCustomization}\n\n${prompt}`;
	}

	return prompt;
}
