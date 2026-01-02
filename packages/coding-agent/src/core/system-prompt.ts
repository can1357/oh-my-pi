/**
 * System prompt construction and project context loading
 */

import chalk from "chalk";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { getAgentDir, getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import type { SkillsSettings } from "./settings-manager.js";
import { formatSkillsForPrompt, loadSkills, type Skill } from "./skills.js";
import type { ToolName } from "./tools/index.js";

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
	ast: "Perform AST-level code analysis and transformations",
	read: "Read file contents",
	bash: "Execute bash commands (git, npm, docker, etc.)",
	edit: "Make surgical edits to files (find exact text and replace)",
	write: "Create or overwrite files",
	grep: "Search file contents for patterns (respects .gitignore)",
	find: "Find files by glob pattern (respects .gitignore)",
	ls: "List directory contents",
	lsp: "PREFERRED for semantic code queries: go-to-definition, find-all-references, hover (type info), call hierarchy. Returns precise, deterministic results. Use BEFORE grep for symbol lookups.",
	notebook: "Edit Jupyter notebook cells",
	replace: "Find and replace text across multiple files",
	task: "Spawn a sub-agent to handle complex tasks",
	web_fetch: "Fetch and render URLs into clean text for LLM consumption",
	web_search: "Search the web for information",
};

/**
 * Anti-bash rules - explicit patterns that MUST use specialized tools instead of bash.
 * These rules are critical for preventing LLM from falling back to shell commands.
 */
const _antiBashRules = `## Tool Usage Rules — MANDATORY

### Forbidden Bash Patterns
NEVER use bash for these operations:

| Operation | Forbidden | Required Tool |
|-----------|-----------|---------------|
| File reading | cat, head, tail, less, more | read |
| Content search | grep, rg, ag, ack | grep |
| File finding | find, fd, locate | find |
| Directory listing | ls | ls (or find) |
| File editing | sed, awk, perl -pi, echo >, cat <<EOF | edit or replace |

### Tool Preference Ladder (highest → lowest priority)
1. **lsp** — Go-to-definition, find references, hover info — DETERMINISTIC
2. **ast** — Structural code search/replace (function shapes, impl blocks, patterns)
3. **grep** — Text/regex search in file contents
4. **find** — Locate files by glob pattern
5. **read** — Read file contents (with offset/limit for large files)
6. **edit** — Precise text replacement (old text must exist exactly)
7. **replace** — Multi-file regex find/replace
8. **bash** — ONLY for commands that have no tool equivalent (git, npm, docker, make, cargo, etc.)

### LSP — Preferred for Semantic Queries
Use \`lsp\` instead of grep/bash when you need:
- **Where is X defined?** → \`lsp goToDefinition\`
- **What calls X?** → \`lsp findReferences\` or \`lsp incomingCalls\`
- **What does X call?** → \`lsp outgoingCalls\`
- **What type is X?** → \`lsp hover\`
- **What symbols are in this file?** → \`lsp documentSymbol\`
- **Find symbol across codebase** → \`lsp workspaceSymbol\`

LSP returns **precise, compiler-verified results**. Grep returns text matches that may include comments, strings, or false positives.

### AST Tool Patterns (ast-grep)
Use \`ast\` for patterns that grep cannot express:

**Rust examples:**
- Find unsafe blocks: \`unsafe { $$BODY }\`
- Find trait impls: \`impl $TRAIT for $TYPE { $$BODY }\`
- Find unwrap calls: \`$EXPR.unwrap()\`
- Find function signatures: \`fn $NAME($$PARAMS) -> Result<$T, $E>\`
- Find async functions: \`async fn $NAME($$PARAMS) $BODY\`
- Find macro invocations: \`$MACRO!($$ARGS)\`

**TypeScript/JavaScript examples:**
- Find React components: \`function $NAME($$PROPS) { $$BODY }\` with JSX
- Find async arrow functions: \`async ($$PARAMS) => $$BODY\`
- Find imports: \`import { $$NAMES } from "$MODULE"\`

**When to use AST vs Grep:**
- **ast**: Code structure (function shapes, impl blocks, call patterns, type patterns)
- **grep**: Text content (strings, comments, error messages, config values, symbols)

### Search-First Protocol
Before reading any file:
1. If you don't know the codebase structure → \`find pattern: "*.rs"\` to see layout
2. If you know roughly where to look → \`grep\` for the specific symbol/error
3. Use \`read offset/limit\` for specific line ranges, not entire large files
4. Never read an entire large file hoping to find something — search first
`;

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
	const hasReplace = tools.includes("replace");
	const hasAst = tools.includes("ast");
	const hasLsp = tools.includes("lsp");

	// Only show rules if we have specialized tools that should be preferred
	const hasSpecializedTools = hasRead || hasGrep || hasFind || hasLs || hasEdit || hasReplace;
	if (!hasSpecializedTools) return null;

	const lines: string[] = [];
	lines.push("## Tool Usage Rules — MANDATORY\n");
	lines.push("### Forbidden Bash Patterns");
	lines.push("NEVER use bash for these operations:\n");

	if (hasRead) lines.push("- **File reading**: Use `read` instead of cat/head/tail/less/more");
	if (hasGrep) lines.push("- **Content search**: Use `grep` instead of grep/rg/ag/ack");
	if (hasFind) lines.push("- **File finding**: Use `find` instead of find/fd/locate");
	if (hasLs) lines.push("- **Directory listing**: Use `ls` instead of bash ls");
	if (hasEdit || hasReplace)
		lines.push("- **File editing**: Use `edit`/`replace` instead of sed/awk/perl -pi/echo >/cat <<EOF");

	lines.push("\n### Tool Preference (highest → lowest priority)");
	const ladder: string[] = [];
	if (hasLsp) ladder.push("lsp (go-to-definition, references, type info) — DETERMINISTIC");
	if (hasAst) ladder.push("ast (structural code patterns)");
	if (hasGrep) ladder.push("grep (text/regex search)");
	if (hasFind) ladder.push("find (locate files by pattern)");
	if (hasRead) ladder.push("read (view file contents)");
	if (hasEdit) ladder.push("edit (precise text replacement)");
	if (hasReplace) ladder.push("replace (multi-file find/replace)");
	ladder.push("bash (ONLY for git, npm, docker, make, cargo, etc.)");
	lines.push(ladder.map((t, i) => `${i + 1}. ${t}`).join("\n"));

	// Add LSP guidance if available
	if (hasLsp) {
		lines.push("\n### LSP — Preferred for Semantic Queries");
		lines.push("Use `lsp` instead of grep/bash when you need:");
		lines.push("- **Where is X defined?** → `lsp goToDefinition`");
		lines.push("- **What calls X?** → `lsp findReferences` or `lsp incomingCalls`");
		lines.push("- **What does X call?** → `lsp outgoingCalls`");
		lines.push("- **What type is X?** → `lsp hover`");
		lines.push("- **What symbols are in this file?** → `lsp documentSymbol`");
		lines.push("- **Find symbol across codebase** → `lsp workspaceSymbol`\n");
		lines.push("LSP returns **precise, compiler-verified results**. Grep returns text matches that may include comments, strings, or false positives.");
	}

	// Add AST examples if ast tool is available
	if (hasAst) {
		lines.push("\n### AST Tool Patterns");
		lines.push("Use `ast` for structural patterns that grep cannot express:\n");
		lines.push("**Rust**: `unsafe { $$BODY }`, `impl $TRAIT for $TYPE { $$BODY }`, `$EXPR.unwrap()`");
		lines.push('**JS/TS**: `async ($$PARAMS) => $$BODY`, `import { $$NAMES } from "$MODULE"`\n');
		lines.push("**ast vs grep**: ast for code structure, grep for text/strings/comments");
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

/** Look for AGENTS.md or CLAUDE.md in a directory (prefers AGENTS.md) */
function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	const candidates = ["AGENTS.md", "CLAUDE.md"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				return {
					path: filePath,
					content: readFileSync(filePath, "utf-8"),
				};
			} catch (error) {
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}
	return null;
}

export interface LoadContextFilesOptions {
	/** Working directory to start walking up from. Default: process.cwd() */
	cwd?: string;
	/** Agent config directory for global context. Default: from getAgentDir() */
	agentDir?: string;
}

/**
 * Load all project context files in order:
 * 1. Global: agentDir/AGENTS.md or CLAUDE.md
 * 2. Parent directories (top-most first) down to cwd
 * Each returns {path, content} for separate messages
 */
export function loadProjectContextFiles(
	options: LoadContextFilesOptions = {},
): Array<{ path: string; content: string }> {
	const resolvedCwd = options.cwd ?? process.cwd();
	const resolvedAgentDir = options.agentDir ?? getAgentDir();

	const contextFiles: Array<{ path: string; content: string }> = [];
	const seenPaths = new Set<string>();

	// 1. Load global context from agentDir
	const globalContext = loadContextFileFromDir(resolvedAgentDir);
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	// 2. Walk up from cwd to root, collecting all context files
	const ancestorContextFiles: Array<{ path: string; content: string }> = [];

	let currentDir = resolvedCwd;
	const root = resolve("/");

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		if (contextFile && !seenPaths.has(contextFile.path)) {
			// Add to beginning so we get top-most parent first
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}

		// Stop if we've reached root
		if (currentDir === root) break;

		// Move up one directory
		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) break; // Safety check
		currentDir = parentDir;
	}

	// Add ancestor files in order (top-most → cwd)
	contextFiles.push(...ancestorContextFiles);

	return contextFiles;
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: ToolName[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Skills settings for discovery. */
	skillsSettings?: SkillsSettings;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Agent config directory. Default: from getAgentDir() */
	agentDir?: string;
	/** Pre-loaded context files (skips discovery if provided). */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills (skips discovery if provided). */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		appendSystemPrompt,
		skillsSettings,
		cwd,
		agentDir,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd ?? process.cwd();
	const resolvedCustomPrompt = resolvePromptInput(customPrompt, "system prompt");
	const resolvedAppendPrompt = resolvePromptInput(appendSystemPrompt, "append system prompt");

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

	const appendSection = resolvedAppendPrompt ? `\n\n${resolvedAppendPrompt}` : "";

	// Resolve context files: use provided or discover
	const contextFiles = providedContextFiles ?? loadProjectContextFiles({ cwd: resolvedCwd, agentDir });

	// Resolve skills: use provided or discover
	const skills =
		providedSkills ??
		(skillsSettings?.enabled !== false ? loadSkills({ ...skillsSettings, cwd: resolvedCwd, agentDir }).skills : []);

	if (resolvedCustomPrompt) {
		let prompt = resolvedCustomPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "The following project context files have been loaded:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append git context if in a git repo
		const gitContext = loadGitContext(resolvedCwd);
		if (gitContext) {
			prompt += `\n\n# Git Status\n\n${gitContext}`;
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date/time and working directory last
		prompt += `\nCurrent date and time: ${dateTime}`;
		prompt += `\nCurrent working directory: ${resolvedCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools
	const tools = selectedTools || (["read", "bash", "edit", "write"] as ToolName[]);
	const toolsList = tools.map((t) => `- ${t}: ${toolDescriptions[t]}`).join("\n");

	// Generate anti-bash rules (returns null if not applicable)
	const antiBashSection = generateAntiBashRules(tools);

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];

	const hasBash = tools.includes("bash");
	const hasEdit = tools.includes("edit");
	const hasWrite = tools.includes("write");
	const hasRead = tools.includes("read");

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
	let prompt = `You are an expert coding assistant. You help users with coding tasks by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}
${antiBashSection ? `\n${antiBashSection}\n` : ""}
Guidelines:
${guidelines}

Documentation:
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (hooks, custom tools, SDK)
- When asked to create: custom models/providers (README.md), hooks (docs/hooks.md, examples/hooks/), custom tools (docs/custom-tools.md, docs/tui.md, examples/custom-tools/), themes (docs/theme.md), skills (docs/skills.md)
- Always read the doc, examples, AND follow .md cross-references before implementing`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "The following project context files have been loaded:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append git context if in a git repo
	const gitContext = loadGitContext(resolvedCwd);
	if (gitContext) {
		prompt += `\n\n# Git Status\n\n${gitContext}`;
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date/time and working directory last
	prompt += `\nCurrent date and time: ${dateTime}`;
	prompt += `\nCurrent working directory: ${resolvedCwd}`;

	return prompt;
}
