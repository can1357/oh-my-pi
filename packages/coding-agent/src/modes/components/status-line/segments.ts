import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber, getProjectDir, pathIsWithin, relativePathWithinRoot } from "@oh-my-pi/pi-utils";
import { type Theme, type ThemeColor, theme } from "../../../modes/theme/theme";
import { shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../../../tools/render-utils";
import { fileHyperlink } from "../../../tui/hyperlink";
import { getSessionAccentAnsi, getSessionAccentHex } from "../../../utils/session-color";
import { sanitizeStatusText } from "../../shared";
import { formatContextUsage, getContextUsageLevel, getContextUsageThemeColor } from "./context-thresholds";
import type { RenderedSegment, SegmentContext, StatusLineSegment, StatusLineSegmentId } from "./types";

export type { SegmentContext } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function withIcon(icon: string, text: string): string {
	return icon ? `${icon} ${text}` : text;
}

/** Left-truncate a path/label to `maxLen`, prefixing an ellipsis when clipped. */
function clampPathLength(pwd: string, maxLen: number): string {
	if (pwd.length <= maxLen) return pwd;
	const ellipsis = "…";
	return `${ellipsis}${pwd.slice(-Math.max(0, maxLen - ellipsis.length))}`;
}

/**
 * Leading glyph of a thinking-level display string (e.g. "◉ xhigh" → "◉").
 * Compact mode promotes this glyph to the model-segment icon so the level
 * stays visible without the verbose " · <level>" tail.
 */
function thinkingGlyph(display: string): string {
	const space = display.indexOf(" ");
	return space === -1 ? display : display.slice(0, space);
}

function stripDisplayRoot(pwd: string): string {
	for (const root of [path.join(os.homedir(), "Projects"), "/work"]) {
		const relative = relativePathWithinRoot(root, pwd);
		if (relative) return relative;
	}
	return pwd;
}

function normalizePremiumRequests(value: number): number {
	return Math.round((value + Number.EPSILON) * 100) / 100;
}
function formatSpend(amount: number, usingSubscription: boolean, uiTheme: Theme): string {
	const formatted = amount.toFixed(2);
	if (!usingSubscription) return `$${formatted}`;
	if (uiTheme.getSymbolPreset() === "nerd") {
		const icon = uiTheme.icon.subscription;
		return icon ? `${icon} ${formatted}` : `S${formatted}`;
	}
	return `S${formatted}`;
}

function formatAdvisorSpend(amount: number, usingSubscription: boolean, uiTheme: Theme): string {
	const spend = formatSpend(amount, usingSubscription, uiTheme);
	const icon = uiTheme.icon.advisor;
	if (icon && icon !== "(adv)") {
		return `${icon} ${spend}`;
	}
	return `${spend} (adv)`;
}

const SCRATCH_ROOTS: readonly string[] = (() => {
	const roots = new Set<string>([os.tmpdir(), path.join(os.homedir(), "tmp")]);
	if (process.platform === "win32") {
		const { TEMP, TMP, SystemRoot } = process.env;
		if (TEMP) roots.add(TEMP);
		if (TMP) roots.add(TMP);
		if (SystemRoot) roots.add(path.join(SystemRoot, "Temp"));
	} else {
		roots.add("/tmp");
		roots.add("/var/tmp");
		if (process.platform === "darwin") {
			roots.add("/private/tmp");
			roots.add("/private/var/tmp");
		}
	}
	return [...roots];
})();

function classifyProjectDir(pwd: string): { scratch: boolean; relative: string | null } {
	for (const root of SCRATCH_ROOTS) {
		if (pathIsWithin(root, pwd)) {
			return { scratch: true, relative: relativePathWithinRoot(root, pwd) };
		}
	}
	return { scratch: false, relative: null };
}

// ═══════════════════════════════════════════════════════════════════════════
// Segment Implementations
// ═══════════════════════════════════════════════════════════════════════════

const piSegment: StatusLineSegment = {
	id: "pi",
	render(ctx) {
		if (ctx.focusedAgentId) {
			const icon = theme.icon.ghost ? `${theme.icon.ghost} ` : "";
			return { content: theme.fg("warning", `${icon}${ctx.focusedAgentId} `), visible: true };
		}
		const content = theme.icon.pi ? `${theme.icon.pi} ` : "";
		return { content: theme.fg("accent", content), visible: true };
	},
};

const modelSegment: StatusLineSegment = {
	id: "model",
	render(ctx) {
		const state = ctx.session.state;
		const opts = ctx.options.model ?? {};

		let modelName = state.model?.name || state.model?.id || "no-model";
		if (modelName.startsWith("Claude ")) {
			modelName = modelName.slice(7);
		}

		// Resolve the current thinking-level display ("◉ xhigh", "⟳ auto", …)
		// when the model supports thinking and the segment isn't hiding it.
		let thinkingDisplay = "";
		if (opts.showThinkingLevel !== false && state.model?.thinking) {
			if (ctx.session.isAutoThinking) {
				// Pending (no turn classified yet / classifying) shows a symbol-theme
				// question-box marker; once resolved it shows `<level>`.
				const resolved = ctx.session.autoResolvedThinkingLevel();
				thinkingDisplay = resolved
					? (theme.thinking[resolved as keyof typeof theme.thinking] ?? resolved)
					: `${theme.thinking.autoPending} auto`;
			} else {
				const level = state.thinkingLevel ?? ThinkingLevel.Off;
				thinkingDisplay =
					level === ThinkingLevel.Off
						? `${theme.status.disabled} off`
						: (theme.thinking[level as keyof typeof theme.thinking] ?? level);
			}
		}

		// Compact mode swaps the model icon for the thinking-level glyph and drops
		// the " · <level>" tail, keeping the level visible as a single icon.
		const compact = ctx.compactThinkingLevel && thinkingDisplay !== "";
		const modelIcon = compact ? thinkingGlyph(thinkingDisplay) : theme.icon.model;

		// Fast-mode icon and thinking-level suffix trail the model name and are
		// colored together with it as `statusLineModel`. The advisor symbol sits
		// between the name and that tail, so it reads as a distinct marker.
		// theme.fg resets only the fg, so the spans are concatenated (not
		// nested) to keep each color intact.
		let tail = "";
		if (ctx.session.isFastModeActive() && theme.icon.fast) {
			tail += ` ${theme.icon.fast}`;
		}
		if (!compact && thinkingDisplay) {
			tail += `${theme.sep.dot}${thinkingDisplay}`;
		}

		// `statusLineModel` is aliased to `accent` in many themes, so the badge
		// uses status colors to stay visibly distinct from the model name color.
		let content = theme.fg("statusLineModel", withIcon(modelIcon, modelName));
		// Advisor symbol, colored by the worst status in the roster:
		// success = all running, warning = quota-exhausted, error = failed,
		// dim = everything paused/no-model. Per-advisor detail lives in
		// `/advisor status`.
		// Optional chaining: lightweight session doubles (test mocks) that don't
		// implement getAdvisorStatusOverview skip the badge instead of crashing.
		const advisorIcon = theme.icon.advisor;
		const advisorStats = ctx.session.getAdvisorStatusOverview?.();
		if (advisorIcon && advisorStats?.configured && advisorStats.advisors.length > 0) {
			const statuses = advisorStats.advisors.map(a => a.status);
			const badgeColor = statuses.includes("error")
				? "error"
				: statuses.includes("quota_exhausted")
					? "warning"
					: statuses.includes("running")
						? "success"
						: "dim";
			content += theme.fg(badgeColor, ` ${advisorIcon}`);
		}
		if (tail) {
			content += theme.fg("statusLineModel", tail);
		}

		return { content, visible: true };
	},
};

function formatGoalBudget(current: number, budget?: number): string {
	const used = formatNumber(current);
	if (budget === undefined) return used;
	return `${used}/${formatNumber(budget)}`;
}

function renderGoalMode(ctx: SegmentContext, mode: { enabled: boolean; paused: boolean }): RenderedSegment {
	const goal = ctx.session.getGoalModeState()?.goal;
	const status = goal?.status ?? (mode.paused ? "paused" : "active");

	let icon: string = theme.icon.goal;
	let color: ThemeColor = "accent";
	switch (status) {
		case "paused":
			icon = theme.icon.pause || theme.symbol("status.pending");
			color = "warning";
			break;
		case "complete":
			icon = theme.symbol("status.success");
			color = "success";
			break;
		case "budget-limited":
			icon = theme.symbol("status.warning");
			color = "warning";
			break;
		case "dropped":
			icon = theme.symbol("status.aborted");
			color = "dim";
			break;
		default:
			break;
	}

	const parts: string[] = [withIcon(icon, "Goal")];
	const showBudget = ctx.session.settings.get("goal.statusInFooter") === true;
	if (showBudget && goal) {
		parts.push(formatGoalBudget(goal.tokensUsed, goal.tokenBudget));
	}
	return { content: theme.fg(color, parts.join(" ")), visible: true };
}

function formatLoopLimit(limit: NonNullable<SegmentContext["loopMode"]>["limit"]): string | undefined {
	if (!limit) return undefined;
	if (limit.kind === "iterations") return `${limit.remaining}/${limit.initial}`;

	const totalSeconds = Math.max(0, Math.ceil((limit.deadlineMs - Date.now()) / 1_000));
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ""} left`;
	if (minutes > 0) return `${minutes}m${seconds > 0 ? `${seconds}s` : ""} left`;
	return `${seconds}s left`;
}

const modeSegment: StatusLineSegment = {
	id: "mode",
	render(ctx) {
		const pauseSuffix = theme.icon.pause ? ` ${theme.icon.pause}` : " (paused)";

		const plan = ctx.planMode;
		if (plan && (plan.enabled || plan.paused)) {
			const label = plan.paused ? `Plan${pauseSuffix}` : "Plan";
			const content = withIcon(theme.icon.plan, label);
			const color = plan.paused ? "warning" : "accent";
			return { content: theme.fg(color, content), visible: true };
		}

		const prewalk = ctx.prewalk;
		if (prewalk?.enabled) {
			const content = withIcon(theme.icon.prewalk, "Prewalk");
			return { content: theme.fg("accent", content), visible: true };
		}

		const goal = ctx.goalMode;
		if (goal && (goal.enabled || goal.paused)) {
			return renderGoalMode(ctx, goal);
		}

		const vibe = ctx.vibeMode;
		if (vibe?.enabled) {
			const content = withIcon(theme.icon.agents, "Vibe");
			return { content: theme.fg("accent", content), visible: true };
		}

		const loop = ctx.loopMode;
		if (loop) {
			const icon = loop.state === "paused" ? theme.icon.pause || theme.icon.loop : theme.icon.loop;
			const color: ThemeColor = loop.state === "paused" ? "warning" : "customMessageLabel";
			const parts = [withIcon(icon, `Loop ${loop.state}`)];
			const limit = formatLoopLimit(loop.limit);
			if (limit) parts.push(limit);
			return { content: theme.fg(color, parts.join(" ")), visible: true };
		}

		return { content: "", visible: false };
	},
};

const pathSegment: StatusLineSegment = {
	id: "path",
	render(ctx) {
		const opts = ctx.options.path ?? {};
		const stripPrefix = opts.stripWorkPrefix !== false;

		// Linked git worktree: the on-disk path nests the worktree base, the
		// project, and a worktree dir that usually duplicates the branch (already
		// shown by the git segment). Collapse to the project name, appending the
		// worktree dir only when it diverges from the branch.
		if (stripPrefix && ctx.worktree) {
			const { projectName, worktreeName } = ctx.worktree;
			const label = ctx.git.branch === worktreeName ? projectName : `${projectName}/${worktreeName}`;
			const text = fileHyperlink(getProjectDir(), clampPathLength(label, opts.maxLength ?? 40));
			const content = withIcon(theme.icon.worktree, text);
			return { content: theme.fg("statusLinePath", content), visible: true };
		}

		const projectDir = ctx.activeRepo?.cwd ?? getProjectDir();
		const { scratch, relative } = classifyProjectDir(projectDir);
		let pwd = projectDir;

		if (stripPrefix) {
			if (scratch) {
				if (relative) pwd = relative;
			} else {
				pwd = stripDisplayRoot(pwd);
			}
		}
		const repoSuffix = ctx.activeRepo ? ` ↳ ${ctx.activeRepo.relativeRepoRoot}` : "";
		if (opts.abbreviate !== false) {
			pwd = shortenPath(pwd);
		}

		pwd = clampPathLength(pwd, opts.maxLength ?? 40);

		const showScratchIcon = scratch && stripPrefix;
		const icon = showScratchIcon ? theme.icon.scratchFolder : theme.icon.folder;
		const content = withIcon(icon, `${fileHyperlink(projectDir, pwd)}${repoSuffix}`);
		return { content: theme.fg("statusLinePath", content), visible: true };
	},
};

const gitSegment: StatusLineSegment = {
	id: "git",
	render(ctx) {
		const { branch, status } = ctx.git;
		if (!branch && !status) return { content: "", visible: false };

		const opts = ctx.options.git ?? {};
		const gitStatus = status;
		const isDirty = gitStatus && (gitStatus.staged > 0 || gitStatus.unstaged > 0 || gitStatus.untracked > 0);

		const showBranch = opts.showBranch !== false;
		let content = "";
		if (showBranch && branch) {
			content = withIcon(theme.icon.branch, branch);
		}

		// Add status indicators
		if (gitStatus) {
			const indicators: string[] = [];
			if (opts.showUnstaged !== false && gitStatus.unstaged > 0) {
				indicators.push(theme.fg("statusLineDirty", `*${gitStatus.unstaged}`));
			}
			if (opts.showStaged !== false && gitStatus.staged > 0) {
				indicators.push(theme.fg("statusLineStaged", `+${gitStatus.staged}`));
			}
			if (opts.showUntracked !== false && gitStatus.untracked > 0) {
				indicators.push(theme.fg("statusLineUntracked", `?${gitStatus.untracked}`));
			}
			if (indicators.length > 0) {
				const indicatorText = indicators.join(" ");
				if (!content && showBranch === false) {
					content = withIcon(theme.icon.git, indicatorText);
				} else {
					content += content ? ` ${indicatorText}` : indicatorText;
				}
			}
		}

		if (!content) return { content: "", visible: false };

		const colorName = isDirty ? "statusLineGitDirty" : "statusLineGitClean";
		return { content: theme.fg(colorName, content), visible: true };
	},
};

const prSegment: StatusLineSegment = {
	id: "pr",
	render(ctx) {
		const { pr } = ctx.git;
		if (!pr) return { content: "", visible: false };

		const label = withIcon(theme.icon.pr, `#${pr.number}`);
		const content = TERMINAL.hyperlinks ? `\x1b]8;;${pr.url}\x07${label}\x1b]8;;\x07` : label;
		return { content: theme.fg("accent", content), visible: true };
	},
};

const subagentsSegment: StatusLineSegment = {
	id: "subagents",
	render(ctx) {
		if (ctx.subagentCount === 0) {
			return { content: "", visible: false };
		}
		const content = withIcon(theme.icon.agents, `${ctx.subagentCount}`);
		return { content: theme.fg("statusLineSubagents", content), visible: true };
	},
};

const tokenInSegment: StatusLineSegment = {
	id: "token_in",
	render(ctx) {
		const { input } = ctx.usageStats;
		if (!input) return { content: "", visible: false };

		const content = withIcon(theme.icon.input, formatNumber(input));
		return { content: theme.fg("statusLineSpend", content), visible: true };
	},
};

const tokenOutSegment: StatusLineSegment = {
	id: "token_out",
	render(ctx) {
		const { output } = ctx.usageStats;
		if (!output) return { content: "", visible: false };

		const content = withIcon(theme.icon.output, formatNumber(output));
		return { content: theme.fg("statusLineOutput", content), visible: true };
	},
};

const tokenTotalSegment: StatusLineSegment = {
	id: "token_total",
	render(ctx) {
		// Excludes cacheRead: that field re-reads the full cached context every
		// turn, making the cumulative sum N×context_size. Orchestration cache read
		// follows the same rule; orchestration input/output remain in the total so
		// provider-side service work is preserved without labeling it prompt input.
		const { input, output, cacheWrite, orchestrationInput, orchestrationOutput } = ctx.usageStats;
		const total = input + output + cacheWrite + orchestrationInput + orchestrationOutput;
		if (!total) return { content: "", visible: false };

		const content = withIcon(theme.icon.tokens, formatNumber(total));
		return { content: theme.fg("statusLineSpend", content), visible: true };
	},
};

const tokenRateSegment: StatusLineSegment = {
	id: "token_rate",
	render(ctx) {
		const { tokensPerSecond } = ctx.usageStats;
		if (!tokensPerSecond) return { content: "", visible: false };

		const content = withIcon(theme.icon.throughput, `${tokensPerSecond.toFixed(1)} tok/s`);
		return { content: theme.fg("statusLineOutput", content), visible: true };
	},
};

const costSegment: StatusLineSegment = {
	id: "cost",
	render(ctx) {
		const { cost, premiumRequests } = ctx.usageStats;
		const advisorCost = ctx.session.getAdvisorCost?.() ?? 0;
		const normalizedPremiumRequests = normalizePremiumRequests(premiumRequests);
		const state = ctx.session.state;
		const usingSubscription = state.model ? (ctx.session.modelRegistry?.isUsingOAuth(state.model) ?? false) : false;
		const advisorUsingSubscription = ctx.session.isAdvisorUsingSubscription?.() ?? false;

		if (!cost && !advisorCost && !usingSubscription && !normalizedPremiumRequests) {
			return { content: "", visible: false };
		}

		const billingParts: string[] = [];
		if (cost) {
			billingParts.push(formatSpend(cost, usingSubscription, theme));
		} else if (usingSubscription) {
			billingParts.push(
				theme.getSymbolPreset() === "nerd" && theme.icon.subscription ? theme.icon.subscription : "(sub)",
			);
		}
		if (normalizedPremiumRequests) billingParts.push(`★ ${formatNumber(normalizedPremiumRequests)}`);
		if (advisorCost) {
			const prefix = billingParts.length ? "+ " : "";
			billingParts.push(`${prefix}${formatAdvisorSpend(advisorCost, advisorUsingSubscription, theme)}`);
		}
		if (billingParts.length === 0) return { content: "", visible: false };

		return { content: theme.fg("statusLineCost", billingParts.join(" ")), visible: true };
	},
};

const contextPctSegment: StatusLineSegment = {
	id: "context_pct",
	render(ctx) {
		const pct = ctx.contextPercent;
		const window = ctx.contextWindow;

		const color = getContextUsageThemeColor(getContextUsageLevel(pct ?? 0, window));
		// Async-compaction indicator: pulse the auto icon while a background
		// speculation runs, hold it in accent once a result is armed.
		let autoIcon = "";
		if (ctx.autoCompactEnabled && theme.icon.auto) {
			const speculation = ctx.compactionSpeculation;
			const iconColor =
				speculation === "running"
					? ctx.speculationBlinkOn
						? "accent"
						: "muted"
					: speculation === "armed"
						? "accent"
						: color;
			autoIcon = ` ${theme.fg(iconColor, theme.icon.auto)}`;
		}
		const text = theme.fg(color, formatContextUsage(pct, window, ctx.contextTokens));
		const content = withIcon(theme.icon.context, `${text}${autoIcon}`);

		return { content, visible: true };
	},
};

const contextTotalSegment: StatusLineSegment = {
	id: "context_total",
	render(ctx) {
		const window = ctx.contextWindow;
		if (!window) return { content: "", visible: false };
		return {
			content: theme.fg("statusLineContext", withIcon(theme.icon.context, formatNumber(window))),
			visible: true,
		};
	},
};

/**
 * Total time the agent was actively processing this session — the union of
 * every `agent_start`→`agent_end` window plus the currently-running window,
 * sourced from {@link SegmentContext.activeMs}. Idle wall-clock between turns
 * never accumulates, so the displayed total reflects how long the agent has
 * been working for the user, not how long the session has been open. Hidden
 * before the first second of activity to avoid flashing `0s` at session start.
 */
const timeSpentSegment: StatusLineSegment = {
	id: "time_spent",
	render(ctx) {
		if (ctx.activeMs < 1000) return { content: "", visible: false };
		return { content: withIcon(theme.icon.time, formatDuration(ctx.activeMs)), visible: true };
	},
};

const timeSegment: StatusLineSegment = {
	id: "time",
	render(ctx) {
		const opts = ctx.options.time ?? {};
		const now = new Date();

		let hours = now.getHours();
		let suffix = "";
		if (opts.format === "12h") {
			suffix = hours >= 12 ? "pm" : "am";
			hours = hours % 12 || 12;
		}

		const mins = now.getMinutes().toString().padStart(2, "0");
		let timeStr = `${hours}:${mins}`;
		if (opts.showSeconds) {
			timeStr += `:${now.getSeconds().toString().padStart(2, "0")}`;
		}
		timeStr += suffix;

		return { content: withIcon(theme.icon.time, timeStr), visible: true };
	},
};

const sessionSegment: StatusLineSegment = {
	id: "session",
	render(ctx) {
		const sessionManager = ctx.session.sessionManager;
		const sessionId = sessionManager?.getSessionId?.();
		const display = sessionId?.slice(0, 8) || "new";

		return { content: withIcon(theme.icon.session, display), visible: true };
	},
};

const hostnameSegment: StatusLineSegment = {
	id: "hostname",
	render(_ctx) {
		const name = os.hostname().split(".")[0];
		return { content: withIcon(theme.icon.host, name), visible: true };
	},
};

const cacheReadSegment: StatusLineSegment = {
	id: "cache_read",
	render(ctx) {
		const { cacheRead } = ctx.usageStats;
		if (!cacheRead) return { content: "", visible: false };

		const parts = [theme.icon.cache, formatNumber(cacheRead)].filter(Boolean);
		const content = parts.join(" ");
		return { content: theme.fg("statusLineSpend", content), visible: true };
	},
};

const cacheWriteSegment: StatusLineSegment = {
	id: "cache_write",
	render(ctx) {
		const { cacheWrite } = ctx.usageStats;
		if (!cacheWrite) return { content: "", visible: false };

		const parts = [theme.icon.cache, formatNumber(cacheWrite)].filter(Boolean);
		const content = parts.join(" ");
		return { content: theme.fg("statusLineOutput", content), visible: true };
	},
};

const cacheHitSegment: StatusLineSegment = {
	id: "cache_hit",
	render(ctx) {
		const { cacheRead, cacheWrite, input } = ctx.usageStats;
		if (!cacheRead) return { content: "", visible: false };

		// Hit rate = cacheRead / total prompt tokens. The prompt is the sum of
		// cacheRead (served from cache), cacheWrite (newly cached this turn) and
		// input (uncached). Including uncached input keeps the denominator honest
		// for Anthropic/OpenRouter; DeepSeek reports its miss as input with
		// cacheWrite 0, so this still yields hit/(hit+miss).
		const total = cacheRead + cacheWrite + input;

		const rate = (cacheRead / total) * 100;
		const rateStr = rate.toFixed(2);

		const parts: string[] = [theme.icon.cache];
		parts.push(theme.fg("statusLineSpend", `${rateStr}%`));
		return { content: parts.join(" "), visible: true };
	},
};

const sessionNameSegment: StatusLineSegment = {
	id: "session_name",
	render(ctx) {
		const sessionManager = ctx.session.sessionManager;
		const name = sessionManager?.getSessionName() || ctx.previewTitle;
		if (!name) return { content: "", visible: false };

		const accentEnabled = ctx.sessionAccent !== false;
		const ansi = accentEnabled
			? (getSessionAccentAnsi(
					getSessionAccentHex(name, theme.getMajorThemeColorHexes(), theme.accentSurfaceLuminance),
				) ?? theme.getFgAnsi("accent"))
			: theme.getFgAnsi("accent");
		return { content: `${ansi}${sanitizeStatusText(name)}\x1b[39m`, visible: true };
	},
};

const collabSegment: StatusLineSegment = {
	id: "collab",
	render(ctx) {
		if (!ctx.collab) return { content: "", visible: false };
		const label =
			ctx.collab.role === "host"
				? `⇄ collab:${ctx.collab.participantCount}`
				: `⇄ collab guest:${ctx.collab.participantCount}`;
		return { content: theme.fg("accent", label), visible: true };
	},
};

function pickUsageColor(percent: number): "muted" | "warning" | "error" {
	if (percent >= 80) return "error";
	if (percent >= 50) return "warning";
	return "muted";
}

function formatUsageReset(value: number, unit: "m" | "h"): string {
	if (unit === "m") {
		// total minutes (5h window: max 300)
		if (value < 60) return `${value}m`;
		const hours = Math.floor(value / 60);
		const mins = value % 60;
		return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	}
	// total hours (7d window: max 168)
	if (value < 24) return `${value}h`;
	const days = Math.floor(value / 24);
	const hours = value % 24;
	return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

const usageSegment: StatusLineSegment = {
	id: "usage",
	render(ctx) {
		const u = ctx.usage;
		if (!u || (!u.fiveHour && !u.sevenDay && !u.monthly)) {
			return { content: "", visible: false };
		}
		const parts: string[] = [];
		if (u.tier) {
			const tier = truncateToWidth(sanitizeStatusText(u.tier), TRUNCATE_LENGTHS.SHORT);
			if (tier) parts.push(theme.fg("accent", tier));
		}
		if (u.fiveHour) {
			const pct = u.fiveHour.percent;
			const pctText = theme.fg(pickUsageColor(pct), `${Math.round(pct)}%`);
			const reset =
				u.fiveHour.resetMinutes !== undefined
					? theme.fg("muted", ` (${formatUsageReset(u.fiveHour.resetMinutes, "m")})`)
					: "";
			parts.push(`5h ${pctText}${reset}`);
		}
		if (u.sevenDay) {
			const pct = u.sevenDay.percent;
			const pctText = theme.fg(pickUsageColor(pct), `${Math.round(pct)}%`);
			const reset =
				u.sevenDay.resetHours !== undefined
					? theme.fg("muted", ` (${formatUsageReset(u.sevenDay.resetHours, "h")})`)
					: "";
			parts.push(`7d ${pctText}${reset}`);
		}
		if (u.monthly) {
			const pct = u.monthly.percent;
			// Cursor and OpenCode Go (normalize gates monthly to those providers).
			// Both floor used percents upstream (Cursor's dashboard shows 1.88 →
			// "1% used"; OpenCode's endpoint already emits floored integers).
			const pctText = theme.fg(pickUsageColor(pct), `${Math.floor(pct)}%`);
			const reset =
				u.monthly.resetHours !== undefined
					? theme.fg("muted", ` (${formatUsageReset(u.monthly.resetHours, "h")})`)
					: "";
			parts.push(`mo ${pctText}${reset}`);
		}
		const content = withIcon(theme.icon.time, parts.join(theme.sep.dot));
		return { content, visible: true };
	},
};

// ═══════════════════════════════════════════════════════════════════════════
// Segment Registry
// ═══════════════════════════════════════════════════════════════════════════

export const SEGMENTS: Record<StatusLineSegmentId, StatusLineSegment> = {
	pi: piSegment,
	model: modelSegment,
	mode: modeSegment,
	path: pathSegment,
	git: gitSegment,
	pr: prSegment,
	subagents: subagentsSegment,
	token_in: tokenInSegment,
	token_out: tokenOutSegment,
	token_total: tokenTotalSegment,
	token_rate: tokenRateSegment,
	cost: costSegment,
	context_pct: contextPctSegment,
	context_total: contextTotalSegment,
	time_spent: timeSpentSegment,
	time: timeSegment,
	session: sessionSegment,
	hostname: hostnameSegment,
	cache_read: cacheReadSegment,
	cache_write: cacheWriteSegment,
	cache_hit: cacheHitSegment,
	session_name: sessionNameSegment,
	usage: usageSegment,
	collab: collabSegment,
};

export function renderSegment(id: StatusLineSegmentId, ctx: SegmentContext): RenderedSegment {
	const segment = SEGMENTS[id];
	if (!segment) {
		return { content: "", visible: false };
	}
	return segment.render(ctx);
}

export const ALL_SEGMENT_IDS: StatusLineSegmentId[] = Object.keys(SEGMENTS) as StatusLineSegmentId[];
