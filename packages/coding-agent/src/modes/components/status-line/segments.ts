import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import { TERMINAL } from "@pk-nerdsaver-ai/pi-tui";
import {
	formatDuration,
	formatNumber,
	getProjectDir,
	pathIsWithin,
	relativePathWithinRoot,
} from "@pk-nerdsaver-ai/pi-utils";
import { type ThemeColor, theme } from "../../../modes/theme/theme";
import { computeFusionTokenSplit } from "../../../session/fusion-usage";
import { shortenPath } from "../../../tools/render-utils";
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

function stripDisplayRoot(pwd: string): string {
	for (const root of ["/work", path.join(os.homedir(), "Projects")]) {
		const relative = relativePathWithinRoot(root, pwd);
		if (relative) return relative;
	}
	return pwd;
}

function normalizePremiumRequests(value: number): number {
	return Math.round((value + Number.EPSILON) * 100) / 100;
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

		// Keep the fast-mode indicator immediately beside the model name. A bright
		// bolt is on; the muted bolt preserves the indicator's position when off.
		const fastModeIndicator = theme.icon.fast ? ` ${theme.icon.fast}` : "";

		// Thinking-level suffix trails the model/advisor indicators.
		// theme.fg resets only the fg, so spans are concatenated (not nested) to
		// keep each color intact.
		let tail = "";

		if (opts.showThinkingLevel !== false && state.model?.thinking) {
			if (ctx.session.isAutoThinking) {
				// Pending (no turn classified yet / classifying) shows a symbol-theme
				// question-box marker; once resolved it shows `<level>`.
				const resolved = ctx.session.autoResolvedThinkingLevel();
				const resolvedText = resolved ? (theme.thinking[resolved as keyof typeof theme.thinking] ?? resolved) : "";
				tail += `${theme.sep.dot}${resolved ? resolvedText : `${theme.thinking.autoPending} auto`}`;
			} else {
				const level = state.thinkingLevel ?? ThinkingLevel.Off;
				if (level !== ThinkingLevel.Off) {
					const thinkingText = theme.thinking[level as keyof typeof theme.thinking];
					if (thinkingText) {
						tail += `${theme.sep.dot}${thinkingText}`;
					}
				}
			}
		}

		// `statusLineModel` is aliased to `accent` in many themes, so indicators
		// use distinct colors that remain legible beside the model name.
		let content = theme.fg("statusLineModel", withIcon(theme.icon.model, modelName));
		if (fastModeIndicator) {
			// `isFastModeActive` (not `isFastModeEnabled`): the bolt reports whether
			// fast mode applies to the NEXT REQUEST, so a scoped tier that does not
			// match the current model's provider (e.g. `openai-only` on an Anthropic
			// model) must read as off. Keying off the merely-configured tier lit the
			// bolt on providers that never realize it, making the signal useless.
			content += theme.fg(ctx.session.isFastModeActive() ? "warning" : "muted", fastModeIndicator);
		}
		if (ctx.session.isAdvisorActive()) {
			content += theme.fg("success", "++");
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

		const goal = ctx.goalMode;
		if (goal && (goal.enabled || goal.paused)) {
			return renderGoalMode(ctx, goal);
		}

		const loop = ctx.loopMode;
		if (loop?.enabled) {
			const content = withIcon(theme.icon.loop, "Loop");
			return { content: theme.fg("customMessageLabel", content), visible: true };
		}

		return { content: "", visible: false };
	},
};

const pathSegment: StatusLineSegment = {
	id: "path",
	render(ctx) {
		const opts = ctx.options.path ?? {};

		const projectDir = getProjectDir();
		const { scratch, relative } = classifyProjectDir(projectDir);
		let pwd = projectDir;

		if (opts.stripWorkPrefix !== false) {
			if (scratch) {
				if (relative) pwd = relative;
			} else {
				pwd = stripDisplayRoot(pwd);
			}
		}
		if (opts.abbreviate !== false) {
			pwd = shortenPath(pwd);
		}

		const maxLen = opts.maxLength ?? 40;
		if (pwd.length > maxLen) {
			const ellipsis = "…";
			const sliceLen = Math.max(0, maxLen - ellipsis.length);
			pwd = `${ellipsis}${pwd.slice(-sliceLen)}`;
		}

		// The active nested repo suffix is appended after truncation so it stays
		// visible even when the parent cwd gets clipped.
		if (ctx.activeRepo) {
			pwd = `${pwd} ↳ ${ctx.activeRepo.relativeRepoRoot}`;
		}

		const showScratchIcon = scratch && opts.stripWorkPrefix !== false;
		const icon = showScratchIcon ? theme.icon.scratchFolder : theme.icon.folder;
		const content = withIcon(icon, pwd);
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
		// turn, making the cumulative sum N×context_size. The dedicated cache_read
		// segment handles cache monitoring; the cost segment handles billing.
		const { input, output, cacheWrite } = ctx.usageStats;
		const total = input + output + cacheWrite;
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

		const content = withIcon(theme.icon.output, `${tokensPerSecond.toFixed(1)}/s`);
		return { content: theme.fg("statusLineOutput", content), visible: true };
	},
};

const costSegment: StatusLineSegment = {
	id: "cost",
	render(ctx) {
		const { cost, premiumRequests } = ctx.usageStats;
		const normalizedPremiumRequests = normalizePremiumRequests(premiumRequests);
		const state = ctx.session.state;
		const usingSubscription = state.model ? ctx.session.modelRegistry.isUsingOAuth(state.model) : false;

		if (!cost && !usingSubscription && !normalizedPremiumRequests) {
			return { content: "", visible: false };
		}

		const billingParts: string[] = [];
		if (cost) billingParts.push(`$${cost.toFixed(2)}`);
		if (normalizedPremiumRequests) billingParts.push(`★ ${formatNumber(normalizedPremiumRequests)}`);
		if (usingSubscription) billingParts.push("(sub)");

		return { content: theme.fg("statusLineCost", billingParts.join(" ")), visible: true };
	},
};

const contextPctSegment: StatusLineSegment = {
	id: "context_pct",
	render(ctx) {
		const pct = ctx.contextPercent;
		const window = ctx.contextWindow;

		const autoIcon = ctx.autoCompactEnabled && theme.icon.auto ? ` ${theme.icon.auto}` : "";
		const text = `${formatContextUsage(pct, window, ctx.contextTokens)}${autoIcon}`;

		const color = getContextUsageThemeColor(getContextUsageLevel(pct ?? 0, window));
		const content = withIcon(theme.icon.context, theme.fg(color, text));

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

const timeSpentSegment: StatusLineSegment = {
	id: "time_spent",
	render(ctx) {
		const elapsed = Date.now() - ctx.sessionStartTime;
		if (elapsed < 1000) return { content: "", visible: false };

		return { content: withIcon(theme.icon.time, formatDuration(elapsed)), visible: true };
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

		const parts = [theme.icon.cache, theme.icon.output, formatNumber(cacheRead)].filter(Boolean);
		const content = parts.join(" ");
		return { content: theme.fg("statusLineSpend", content), visible: true };
	},
};

const cacheWriteSegment: StatusLineSegment = {
	id: "cache_write",
	render(ctx) {
		const { cacheWrite } = ctx.usageStats;
		if (!cacheWrite) return { content: "", visible: false };

		const parts = [theme.icon.cache, theme.icon.input, formatNumber(cacheWrite)].filter(Boolean);
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
		const name = sessionManager?.getSessionName();
		if (!name) return { content: "", visible: false };

		const ansi =
			getSessionAccentAnsi(
				getSessionAccentHex(name, theme.getMajorThemeColorHexes(), theme.accentSurfaceLuminance),
			) ?? theme.getFgAnsi("accent");
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
		if (!u || (!u.fiveHour && !u.sevenDay)) {
			return { content: "", visible: false };
		}
		const parts: string[] = [];
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
		let joined = parts.join(theme.sep.dot);
		if (u.tier) {
			const tierLabel = sanitizeStatusText(u.tier);
			if (tierLabel) joined += theme.fg("muted", ` ${tierLabel}`);
		}
		const content = withIcon(theme.icon.time, joined);
		return { content, visible: true };
	},
};

const moaSegment: StatusLineSegment = {
	id: "moa",
	render(ctx) {
		if (!ctx.session.isMoaActive?.()) return { content: "", visible: false };
		const labels = ctx.session.getMoaLaneLabels?.() ?? [];
		if (labels.length === 0) return { content: "", visible: false };
		const summary = `${labels.length}->active`;
		const content = withIcon(theme.icon.agents, summary);
		return { content: theme.fg("accent", content), visible: true };
	},
};

const fusionSegment: StatusLineSegment = {
	id: "fusion",
	render(ctx) {
		const settings = ctx.session.settings;
		const mode = settings?.get("fusion.mode");
		const active = settings?.get("fusion.enabled") === true && mode !== "off";
		if (!active) {
			const configured =
				settings?.isConfigured("fusion.enabled") === true || settings?.isConfigured("fusion.mode") === true;
			if (!configured) return { content: "", visible: false };
			const content = withIcon(theme.icon.agents, "fusion off");
			return { content: theme.fg("muted", content), visible: true };
		}
		// Budget-fusion: a nonzero sidekick request budget hard-caps each sidekick
		// run, so surface the cap alongside the mode.
		const budget = settings?.get("fusion.sidekickRequestBudget");
		const summary =
			typeof budget === "number" && budget > 0
				? `fusion on ${mode}${theme.sep.dot}cap ${budget}`
				: `fusion on ${mode}`;
		const content = withIcon(theme.icon.agents, summary);
		return { content: theme.fg("accent", content), visible: true };
	},
};

const fusionSavingsSegment: StatusLineSegment = {
	id: "fusion_savings",
	render(ctx) {
		if (ctx.session.settings?.get("fusion.enabled") !== true) return { content: "", visible: false };
		if (ctx.session.settings?.get("fusion.mode") === "off") return { content: "", visible: false };
		if (ctx.session.settings?.get("fusion.showSavings") !== true) return { content: "", visible: false };
		const split = ctx.session.getFusionUsageSplit?.();
		if (!split) return { content: "", visible: false };
		const { share, sidekickTokens, frontierTokens } = computeFusionTokenSplit(split);
		if (sidekickTokens <= 0) return { content: "", visible: false };
		const summary = `sk ${Math.round(share)}% ${formatNumber(sidekickTokens)}${theme.sep.dot}main ${formatNumber(frontierTokens)}`;
		const content = withIcon(theme.icon.agents, summary);
		return { content: theme.fg("statusLineSpend", content), visible: true };
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
	moa: moaSegment,
	fusion: fusionSegment,
	fusion_savings: fusionSavingsSegment,
};

export function renderSegment(id: StatusLineSegmentId, ctx: SegmentContext): RenderedSegment {
	const segment = SEGMENTS[id];
	if (!segment) {
		return { content: "", visible: false };
	}
	return segment.render(ctx);
}

export const ALL_SEGMENT_IDS: StatusLineSegmentId[] = Object.keys(SEGMENTS) as StatusLineSegmentId[];
