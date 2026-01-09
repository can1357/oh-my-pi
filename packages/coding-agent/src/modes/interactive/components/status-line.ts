import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Component, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { type FSWatcher, watch } from "fs";
import { dirname, join } from "path";
import type { AgentSession } from "../../../core/agent-session";
import type { StatusLineSegmentOptions, StatusLineSettings } from "../../../core/settings-manager";
import { theme } from "../theme/theme";
import { getPreset } from "./status-line/presets";
import { renderSegment, type SegmentContext } from "./status-line/segments";
import { getSeparator } from "./status-line/separators";

// ═══════════════════════════════════════════════════════════════════════════
// Rendering Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Sanitize text for display in a single-line status */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Find the git root directory by walking up from cwd */
async function findGitHeadPath(): Promise<string | null> {
	let dir = process.cwd();
	while (true) {
		const gitHeadPath = join(dir, ".git", "HEAD");
		if (await Bun.file(gitHeadPath).exists()) {
			return gitHeadPath;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// StatusLineComponent
// ═══════════════════════════════════════════════════════════════════════════

export class StatusLineComponent implements Component {
	private session: AgentSession;
	private settings: StatusLineSettings = {};
	private cachedBranch: string | null | undefined = undefined;
	private gitWatcher: FSWatcher | null = null;
	private onBranchChange: (() => void) | null = null;
	private autoCompactEnabled: boolean = true;
	private hookStatuses: Map<string, string> = new Map();
	private subagentCount: number = 0;
	private sessionStartTime: number = Date.now();

	// Git status caching (1s TTL)
	private cachedGitStatus: { staged: number; unstaged: number; untracked: number } | null = null;
	private gitStatusLastFetch = 0;

	constructor(session: AgentSession) {
		this.session = session;
		// Load initial settings
		this.settings = session.settingsManager?.getStatusLineSettings() ?? {};
	}

	updateSettings(settings: StatusLineSettings): void {
		this.settings = settings;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	setSubagentCount(count: number): void {
		this.subagentCount = count;
	}

	setSessionStartTime(time: number): void {
		this.sessionStartTime = time;
	}

	setHookStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.hookStatuses.delete(key);
		} else {
			this.hookStatuses.set(key, text);
		}
	}

	watchBranch(onBranchChange: () => void): void {
		this.onBranchChange = onBranchChange;
		this.setupGitWatcher();
	}

	private setupGitWatcher(): void {
		if (this.gitWatcher) {
			this.gitWatcher.close();
			this.gitWatcher = null;
		}

		findGitHeadPath().then((gitHeadPath) => {
			if (!gitHeadPath) return;

			try {
				this.gitWatcher = watch(gitHeadPath, () => {
					this.cachedBranch = undefined;
					if (this.onBranchChange) {
						this.onBranchChange();
					}
				});
			} catch {
				// Silently fail
			}
		});
	}

	dispose(): void {
		if (this.gitWatcher) {
			this.gitWatcher.close();
			this.gitWatcher = null;
		}
	}

	invalidate(): void {
		this.cachedBranch = undefined;
	}

	private getCurrentBranch(): string | null {
		if (this.cachedBranch !== undefined) {
			return this.cachedBranch;
		}

		// Note: synchronous call to async function - will return undefined on first call
		// This is acceptable since it's a cached value that will update on next render
		findGitHeadPath().then(async (gitHeadPath) => {
			if (!gitHeadPath) {
				this.cachedBranch = null;
				return;
			}
			try {
				const content = (await Bun.file(gitHeadPath).text()).trim();

				if (content.startsWith("ref: refs/heads/")) {
					this.cachedBranch = content.slice(16);
				} else {
					this.cachedBranch = "detached";
				}
			} catch {
				this.cachedBranch = null;
			}
		});

		return this.cachedBranch ?? null;
	}

	private getGitStatus(): { staged: number; unstaged: number; untracked: number } | null {
		const now = Date.now();
		if (now - this.gitStatusLastFetch < 1000) {
			return this.cachedGitStatus;
		}

		try {
			const result = Bun.spawnSync(["git", "status", "--porcelain"], {
				stdout: "pipe",
				stderr: "pipe",
			});

			if (!result.success) {
				this.cachedGitStatus = null;
				this.gitStatusLastFetch = now;
				return null;
			}

			const output = result.stdout.toString("utf8");

			let staged = 0;
			let unstaged = 0;
			let untracked = 0;

			for (const line of output.split("\n")) {
				if (!line) continue;
				const x = line[0];
				const y = line[1];

				if (x === "?" && y === "?") {
					untracked++;
					continue;
				}

				if (x && x !== " " && x !== "?") {
					staged++;
				}

				if (y && y !== " ") {
					unstaged++;
				}
			}

			this.cachedGitStatus = { staged, unstaged, untracked };
			this.gitStatusLastFetch = now;
			return this.cachedGitStatus;
		} catch {
			this.cachedGitStatus = null;
			this.gitStatusLastFetch = now;
			return null;
		}
	}

	private buildSegmentContext(width: number): SegmentContext {
		const state = this.session.state;

		// Get usage statistics
		const usageStats = this.session.sessionManager?.getUsageStatistics() ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
		};

		// Get context percentage
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
		const contextPercent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

		return {
			session: this.session,
			width,
			options: this.resolveSettings().segmentOptions ?? {},
			usageStats,
			contextPercent,
			contextWindow,
			autoCompactEnabled: this.autoCompactEnabled,
			subagentCount: this.subagentCount,
			sessionStartTime: this.sessionStartTime,
			git: {
				branch: this.getCurrentBranch(),
				status: this.getGitStatus(),
			},
		};
	}

	private resolveSettings(): Required<
		Pick<StatusLineSettings, "leftSegments" | "rightSegments" | "separator" | "segmentOptions">
	> &
		StatusLineSettings {
		const preset = this.settings.preset ?? "default";
		const presetDef = getPreset(preset);
		const mergedSegmentOptions: StatusLineSettings["segmentOptions"] = {};

		for (const [segment, options] of Object.entries(presetDef.segmentOptions ?? {})) {
			mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = { ...(options as Record<string, unknown>) };
		}

		for (const [segment, options] of Object.entries(this.settings.segmentOptions ?? {})) {
			const current = mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] ?? {};
			mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = {
				...(current as Record<string, unknown>),
				...(options as Record<string, unknown>),
			};
		}

		return {
			...this.settings,
			leftSegments: this.settings.leftSegments ?? presetDef.leftSegments,
			rightSegments: this.settings.rightSegments ?? presetDef.rightSegments,
			separator: this.settings.separator ?? presetDef.separator,
			segmentOptions: mergedSegmentOptions,
		};
	}

	private buildStatusLine(width: number): string {
		const ctx = this.buildSegmentContext(width);
		const effectiveSettings = this.resolveSettings();
		const separatorDef = getSeparator(effectiveSettings.separator ?? "powerline-thin", theme);

		const bgAnsi = theme.getBgAnsi("statusLineBg");
		const fgAnsi = theme.getFgAnsi("text");
		const sepAnsi = theme.getFgAnsi("statusLineSep");

		// Collect visible segment contents
		const leftParts: string[] = [];
		for (const segId of effectiveSettings.leftSegments) {
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				leftParts.push(rendered.content);
			}
		}

		const rightParts: string[] = [];
		for (const segId of effectiveSettings.rightSegments) {
			const rendered = renderSegment(segId, ctx);
			if (rendered.visible && rendered.content) {
				rightParts.push(rendered.content);
			}
		}

		const topFillWidth = width > 0 ? Math.max(0, width - 4) : 0;
		const left = [...leftParts];
		const right = [...rightParts];

		const leftSepWidth = visibleWidth(separatorDef.left);
		const rightSepWidth = visibleWidth(separatorDef.right);
		const leftCapWidth = separatorDef.endCaps ? visibleWidth(separatorDef.endCaps.right) : 0;
		const rightCapWidth = separatorDef.endCaps ? visibleWidth(separatorDef.endCaps.left) : 0;

		const groupWidth = (parts: string[], capWidth: number, sepWidth: number): number => {
			if (parts.length === 0) return 0;
			const partsWidth = parts.reduce((sum, part) => sum + visibleWidth(part), 0);
			const sepTotal = Math.max(0, parts.length - 1) * (sepWidth + 2);
			return partsWidth + sepTotal + 2 + capWidth;
		};

		let leftWidth = groupWidth(left, leftCapWidth, leftSepWidth);
		let rightWidth = groupWidth(right, rightCapWidth, rightSepWidth);
		const totalWidth = () => leftWidth + rightWidth + (left.length > 0 && right.length > 0 ? 1 : 0);

		if (topFillWidth > 0) {
			while (totalWidth() > topFillWidth && right.length > 0) {
				right.pop();
				rightWidth = groupWidth(right, rightCapWidth, rightSepWidth);
			}
			while (totalWidth() > topFillWidth && left.length > 0) {
				left.pop();
				leftWidth = groupWidth(left, leftCapWidth, leftSepWidth);
			}
		}

		const renderGroup = (parts: string[], direction: "left" | "right"): string => {
			if (parts.length === 0) return "";
			const sep = direction === "left" ? separatorDef.left : separatorDef.right;
			const cap = separatorDef.endCaps
				? direction === "left"
					? separatorDef.endCaps.right
					: separatorDef.endCaps.left
				: "";
			const capPrefix = separatorDef.endCaps?.useBgAsFg ? bgAnsi.replace("\x1b[48;", "\x1b[38;") : bgAnsi + sepAnsi;
			const capText = cap ? `${capPrefix}${cap}\x1b[0m` : "";

			let content = bgAnsi + fgAnsi;
			content += ` ${parts.join(` ${sepAnsi}${sep}${fgAnsi} `)} `;
			content += "\x1b[0m";

			if (capText) {
				return direction === "right" ? capText + content : content + capText;
			}
			return content;
		};

		const leftGroup = renderGroup(left, "left");
		const rightGroup = renderGroup(right, "right");
		if (!leftGroup && !rightGroup) return "";

		if (topFillWidth === 0 || left.length === 0 || right.length === 0) {
			return leftGroup + (leftGroup && rightGroup ? " " : "") + rightGroup;
		}

		leftWidth = groupWidth(left, leftCapWidth, leftSepWidth);
		rightWidth = groupWidth(right, rightCapWidth, rightSepWidth);
		const gapWidth = Math.max(1, topFillWidth - leftWidth - rightWidth);
		return leftGroup + " ".repeat(gapWidth) + rightGroup;
	}

	getTopBorder(width: number): { content: string; width: number } {
		const content = this.buildStatusLine(width);
		return {
			content,
			width: visibleWidth(content),
		};
	}

	render(width: number): string[] {
		// Only render hook statuses - main status is in editor's top border
		const showHooks = this.settings.showHookStatus ?? true;
		if (!showHooks || this.hookStatuses.size === 0) {
			return [];
		}

		const sortedStatuses = Array.from(this.hookStatuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text));
		const hookLine = sortedStatuses.join(" ");
		return [truncateToWidth(hookLine, width, theme.fg("statusLineSep", theme.format.ellipsis))];
	}
}
