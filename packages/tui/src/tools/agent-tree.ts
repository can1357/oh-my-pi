import { formatContextUsage } from "../chrome/context-thresholds";
import {
	FEED_MODEL_BADGE_WIDTH,
	formatBadge,
	formatDuration,
	formatFeedModelBadge,
	formatNumber,
	formatStatusIcon,
	isFeedModelBadgeEnabled,
	truncateToWidth,
	type ConfiguredThinkingLevel,
} from "../render/render-utils";
import type { Theme } from "../theme/theme";
import { visibleWidth } from "../utils";

/** Counters displayed alongside an agent name. */
export interface AgentStats {
	toolCount?: number;
	requests?: number;
	contextTokens?: number;
	contextWindow?: number;
	cost?: number;
}

/** Format the shared tool-count, request, context, and cost stat run. */
export function formatAgentStatRun(stats: AgentStats, theme: Theme): string {
	let line = "";
	if (stats.toolCount) {
		line += `${theme.sep.dot}${theme.fg("dim", `${formatNumber(stats.toolCount)} ${theme.icon.extensionTool}`)}`;
	}
	if (stats.requests) {
		line += `${theme.sep.dot}${theme.fg("dim", `${formatNumber(stats.requests)} req`)}`;
	}
	if (stats.contextTokens && stats.contextTokens > 0) {
		const context =
			stats.contextWindow && stats.contextWindow > 0
				? formatContextUsage((stats.contextTokens / stats.contextWindow) * 100, stats.contextWindow)
				: formatNumber(stats.contextTokens);
		line += `${theme.sep.dot}${theme.fg("dim", context)}`;
	}
	if (stats.cost && stats.cost > 0)
		line += `${theme.sep.dot}${theme.fg("statusLineCost", `$${stats.cost.toFixed(2)}`)}`;
	return line;
}

/** Tool-specific presentation layered onto a bounded agent progress row. */
export interface AgentTreeRowOptions {
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	presentation: "task" | "eval";
	prefix: string;
	id: string;
	width: number;
	model?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	advisor?: boolean;
	spinnerFrame?: number;
	frozen?: boolean;
	roleBadge?: string;
	statusBadge?: string;
	description?: string;
	preview?: string;
	stats?: AgentStats;
	durationMs?: number;
}

/** Render an agent row while reserving its identifier and required status badges. */
export function renderAgentTreeRow(
	options: AgentTreeRowOptions,
	theme: Theme,
): { line: string; descriptionShown: boolean } {
	const { status, width, description } = options;
	const task = options.presentation === "task";
	const live = status === "pending" || status === "running";
	const failed = status === "failed" || status === "aborted";
	const iconColor = status === "completed" ? "success" : failed ? "error" : "accent";
	const nameColor = task && live && options.frozen ? "dim" : task && status === "completed" ? "text" : "accent";
	const iconStatus = status === "failed" ? "error" : status === "completed" ? "done" : status;
	const icon =
		task && !failed
			? theme.styledSymbol("status.done", nameColor)
			: !task && status === "completed"
				? theme.styledSymbol("tool.eval", "accent")
				: theme.fg(
						iconColor,
						formatStatusIcon(iconStatus, theme, status === "running" ? options.spinnerFrame : undefined),
					);
	const lead = `${options.prefix}${options.prefix || !task ? " " : ""}${icon} `;
	const statusBadge = options.statusBadge ?? (failed ? ` ${formatBadge(status, iconColor, theme)}` : "");
	const id = Number.isFinite(width)
		? truncateToWidth(options.id, Math.max(0, width - visibleWidth(lead) - visibleWidth(statusBadge)))
		: options.id;
	const roleBadge =
		options.roleBadge && Number.isFinite(width)
			? truncateToWidth(
					options.roleBadge,
					Math.max(0, width - visibleWidth(lead) - visibleWidth(id) - visibleWidth(statusBadge)),
				)
			: (options.roleBadge ?? "");
	const badges = `${roleBadge}${statusBadge}`;
	const modelWidth = width - visibleWidth(lead) - visibleWidth(id) - visibleWidth(badges) - 1;
	const model =
		isFeedModelBadgeEnabled() && (task || options.model)
			? formatFeedModelBadge(
					options.model,
					options.thinkingLevel,
					options.advisor,
					theme,
					Math.min(FEED_MODEL_BADGE_WIDTH, task ? Math.max(0, modelWidth) : modelWidth),
				)
			: "";
	const modelLead = model ? `${model} ` : "";
	const descriptionShown = Boolean(
		description && visibleWidth(`${lead}${modelLead}${id}: ${description}${badges}`) <= width,
	);
	let title = descriptionShown ? `${theme.bold(id)}: ${description}` : task ? id : theme.bold(id);
	if (task && live && descriptionShown) {
		title = `${theme.fg(nameColor, theme.bold(id))}${theme.fg(nameColor, ":")} ${theme.fg(nameColor, description!)}`;
	} else {
		title = theme.fg(nameColor, title);
	}
	let line = `${lead}${modelLead}${title}${badges}`;
	if (options.preview) line += options.preview;
	if (options.stats) line += formatAgentStatRun(options.stats, theme);
	if (options.durationMs !== undefined && options.durationMs > 0) {
		line += `${theme.sep.dot}${theme.fg("dim", formatDuration(options.durationMs))}`;
	}
	return { line: Number.isFinite(width) ? truncateToWidth(line, width, "") : line, descriptionShown };
}
