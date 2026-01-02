import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Component, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { execSync } from "child_process";
import { existsSync, type FSWatcher, readFileSync, watch } from "fs";
import { dirname, join } from "path";
import type { AgentSession } from "../../../core/agent-session.js";
import { theme } from "../theme/theme.js";

// Nerd Font icons (matching Claude/statusline-nerd.sh)
const ICONS = {
	model: "\uf4bc", //  robot/model
	folder: "\uf115", //  folder
	branch: "\uf126", //  git branch
	sep: "\ue0b1", //  powerline thin chevron
	tokens: "\uf0ce", //  table/tokens
} as const;

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Find the git root directory by walking up from cwd.
 * Returns the path to .git/HEAD if found, null otherwise.
 */
function findGitHeadPath(): string | null {
	let dir = process.cwd();
	while (true) {
		const gitHeadPath = join(dir, ".git", "HEAD");
		if (existsSync(gitHeadPath)) {
			return gitHeadPath;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			// Reached filesystem root
			return null;
		}
		dir = parent;
	}
}

/**
 * Footer component that shows pwd, token stats, and context usage
 */
export class FooterComponent implements Component {
	private session: AgentSession;
	private cachedBranch: string | null | undefined = undefined; // undefined = not checked yet, null = not in git repo, string = branch name
	private gitWatcher: FSWatcher | null = null;
	private onBranchChange: (() => void) | null = null;
	private autoCompactEnabled: boolean = true;
	private hookStatuses: Map<string, string> = new Map();

	constructor(session: AgentSession) {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * Set hook status text to display in the footer.
	 * Text is sanitized (newlines/tabs replaced with spaces) and truncated to terminal width.
	 * ANSI escape codes for styling are preserved.
	 * @param key - Unique key to identify this status
	 * @param text - Status text, or undefined to clear
	 */
	setHookStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.hookStatuses.delete(key);
		} else {
			this.hookStatuses.set(key, text);
		}
	}

	/**
	 * Set up a file watcher on .git/HEAD to detect branch changes.
	 * Call the provided callback when branch changes.
	 */
	watchBranch(onBranchChange: () => void): void {
		this.onBranchChange = onBranchChange;
		this.setupGitWatcher();
	}

	private setupGitWatcher(): void {
		// Clean up existing watcher
		if (this.gitWatcher) {
			this.gitWatcher.close();
			this.gitWatcher = null;
		}

		const gitHeadPath = findGitHeadPath();
		if (!gitHeadPath) {
			return;
		}

		try {
			this.gitWatcher = watch(gitHeadPath, () => {
				this.cachedBranch = undefined; // Invalidate cache
				if (this.onBranchChange) {
					this.onBranchChange();
				}
			});
		} catch {
			// Silently fail if we can't watch
		}
	}

	/**
	 * Clean up the file watcher
	 */
	dispose(): void {
		if (this.gitWatcher) {
			this.gitWatcher.close();
			this.gitWatcher = null;
		}
	}

	invalidate(): void {
		// Invalidate cached branch so it gets re-read on next render
		this.cachedBranch = undefined;
	}

	/**
	 * Get current git branch by reading .git/HEAD directly.
	 * Returns null if not in a git repo, branch name otherwise.
	 */
	private getCurrentBranch(): string | null {
		// Return cached value if available
		if (this.cachedBranch !== undefined) {
			return this.cachedBranch;
		}

		try {
			const gitHeadPath = findGitHeadPath();
			if (!gitHeadPath) {
				this.cachedBranch = null;
				return null;
			}
			const content = readFileSync(gitHeadPath, "utf8").trim();

			if (content.startsWith("ref: refs/heads/")) {
				// Normal branch: extract branch name
				this.cachedBranch = content.slice(16);
			} else {
				// Detached HEAD state
				this.cachedBranch = "detached";
			}
		} catch {
			// Not in a git repo or error reading file
			this.cachedBranch = null;
		}

		return this.cachedBranch;
	}

	/**
	 * Get git status indicators (staged, unstaged, untracked counts).
	 * Returns null if not in a git repo.
	 */
	private getGitStatus(): { staged: number; unstaged: number; untracked: number } | null {
		try {
			const output = execSync("git status --porcelain 2>/dev/null", {
				encoding: "utf8",
				timeout: 1000,
				stdio: ["pipe", "pipe", "pipe"],
			});

			let staged = 0;
			let unstaged = 0;
			let untracked = 0;

			for (const line of output.split("\n")) {
				if (!line) continue;
				const x = line[0]; // Index (staged) status
				const y = line[1]; // Working tree status

				// Untracked files
				if (x === "?" && y === "?") {
					untracked++;
					continue;
				}

				// Staged changes (first column is not space or ?)
				if (x && x !== " " && x !== "?") {
					staged++;
				}

				// Unstaged changes (second column is not space)
				if (y && y !== " ") {
					unstaged++;
				}
			}

			return { staged, unstaged, untracked };
		} catch {
			return null;
		}
	}

	render(width: number): string[] {
		const state = this.session.state;

		// Calculate cumulative usage from ALL session entries
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}
		}

		// Get context percentage from last assistant message
		const lastAssistantMessage = state.messages
			.slice()
			.reverse()
			.find((m) => m.role === "assistant" && m.stopReason !== "aborted") as AssistantMessage | undefined;

		const contextTokens = lastAssistantMessage
			? lastAssistantMessage.usage.input +
				lastAssistantMessage.usage.output +
				lastAssistantMessage.usage.cacheRead +
				lastAssistantMessage.usage.cacheWrite
			: 0;
		const contextWindow = state.model?.contextWindow || 0;
		const contextPercentValue = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

		// Format helpers
		const formatTokens = (n: number): string => {
			if (n < 1000) return n.toString();
			if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
			if (n < 1000000) return `${Math.round(n / 1000)}k`;
			if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
			return `${Math.round(n / 1000000)}M`;
		};

		// Powerline separator (very dim)
		const sep = theme.fg("footerSep", ` ${ICONS.sep} `);

		// ═══════════════════════════════════════════════════════════════════════
		// SEGMENT 1: Model (Gold/White)
		// ═══════════════════════════════════════════════════════════════════════
		const modelName = state.model?.id || "no-model";
		let modelSegment = theme.fg("footerModel", `${ICONS.model} ${modelName}`);
		if (state.model?.reasoning) {
			const level = state.thinkingLevel || "off";
			if (level !== "off") {
				modelSegment += theme.fg("footerSep", " · ") + theme.fg("footerModel", level);
			}
		}

		// ═══════════════════════════════════════════════════════════════════════
		// SEGMENT 2: Path (Cyan with dim separators)
		// Replace home with ~, strip /work/, color separators
		// ═══════════════════════════════════════════════════════════════════════
		let pwd = process.cwd();
		const home = process.env.HOME || process.env.USERPROFILE;
		if (home && pwd.startsWith(home)) {
			pwd = `~${pwd.slice(home.length)}`;
		}
		// Strip /work/ prefix
		if (pwd.startsWith("/work/")) {
			pwd = pwd.slice(6);
		}
		// Color path with dim separators: ~/foo/bar -> ~/foo/bar (separators dim)
		const pathColored = pwd
			.split("/")
			.map((part) => theme.fg("footerPath", part))
			.join(theme.fg("footerSep", "/"));
		const pathSegment = theme.fg("footerIcon", `${ICONS.folder}  `) + pathColored;

		// ═══════════════════════════════════════════════════════════════════════
		// SEGMENT 3: Git Branch + Status (Green/Yellow)
		// ═══════════════════════════════════════════════════════════════════════
		const branch = this.getCurrentBranch();
		let gitSegment = "";
		if (branch) {
			const gitStatus = this.getGitStatus();
			const isDirty = gitStatus && (gitStatus.staged > 0 || gitStatus.unstaged > 0 || gitStatus.untracked > 0);

			// Branch name - green if clean, yellow if dirty
			const branchColor = isDirty ? "footerDirty" : "footerBranch";
			gitSegment = theme.fg("footerIcon", `${ICONS.branch} `) + theme.fg(branchColor, branch);

			// Add status indicators
			if (gitStatus) {
				const indicators: string[] = [];
				if (gitStatus.unstaged > 0) {
					indicators.push(theme.fg("footerDirty", `*${gitStatus.unstaged}`));
				}
				if (gitStatus.staged > 0) {
					indicators.push(theme.fg("footerStaged", `+${gitStatus.staged}`));
				}
				if (gitStatus.untracked > 0) {
					indicators.push(theme.fg("footerUntracked", `!${gitStatus.untracked}`));
				}
				if (indicators.length > 0) {
					gitSegment += ` ${indicators.join(" ")}`;
				}
			}
		}

		// ═══════════════════════════════════════════════════════════════════════
		// SEGMENT 4: Stats (Pink/Magenta tones)
		// Concise: total tokens, cost, context%
		// ═══════════════════════════════════════════════════════════════════════
		const statParts: string[] = [];

		// Total tokens (input + output + cache)
		const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheWrite;
		if (totalTokens) {
			statParts.push(theme.fg("footerOutput", `${ICONS.tokens} ${formatTokens(totalTokens)}`));
		}

		// Cost (pink)
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		if (totalCost || usingSubscription) {
			const costDisplay = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			statParts.push(theme.fg("footerCost", costDisplay));
		}

		// Context percentage with severity coloring
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextDisplay = `${contextPercentValue.toFixed(1)}%/${formatTokens(contextWindow)}${autoIndicator}`;
		let contextColored: string;
		if (contextPercentValue > 90) {
			contextColored = theme.fg("error", contextDisplay);
		} else if (contextPercentValue > 70) {
			contextColored = theme.fg("warning", contextDisplay);
		} else {
			contextColored = theme.fg("footerSep", contextDisplay);
		}
		statParts.push(contextColored);

		const statsSegment = statParts.join("  ");

		// ═══════════════════════════════════════════════════════════════════════
		// Assemble single powerline-style line
		// [Model] > [Path] > [Git] > [Stats]
		// ═══════════════════════════════════════════════════════════════════════
		const segments = [modelSegment, pathSegment];
		if (gitSegment) segments.push(gitSegment);
		segments.push(statsSegment);

		let statusLine = segments.join(sep);

		// Truncate if needed
		if (visibleWidth(statusLine) > width) {
			statusLine = truncateToWidth(statusLine, width, theme.fg("footerSep", "…"));
		}

		const lines = [statusLine];

		// Hook statuses (optional second line)
		if (this.hookStatuses.size > 0) {
			const sortedStatuses = Array.from(this.hookStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const hookLine = sortedStatuses.join(" ");
			lines.push(truncateToWidth(hookLine, width, theme.fg("footerSep", "…")));
		}

		return lines;
	}
}
