import type { UsageReport } from "@oh-my-pi/pi-ai";
import {
	padding,
	renderTableRow,
	replaceTabs,
	type TableColumn,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { formatProviderName } from "@oh-my-pi/pi-tui/chrome/format";
import {
	formatContext,
	formatCostPair,
	formatIntelligence,
	formatModelPerformance,
} from "@oh-my-pi/pi-tui/overlays/model-browser";
import { formatModelSelectorValue } from "@oh-my-pi/pi-tui/overlays/model-selector";
import {
	buildProviderCards,
	CARD_MAX_WINDOWS,
	renderUsageBar,
	usageStatusColor,
} from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { thinkingLevelGlyph } from "@oh-my-pi/pi-tui/render/render-utils";
import { type ConfiguredThinkingLevel, getConfiguredThinkingLevelMetadata } from "@oh-my-pi/pi-tui/thinking";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import {
	PROFILE_SETTINGS_GROUPS,
	type ProfileAgentRow,
	type ProfileRoleRow,
	type ProfileSnapshot,
} from "../../profiles/types";
import type { ProfileDashboardSetupRef } from "./profile-dashboard";

const TABLE_INDENT = "  ";
const TABLE_GAP = "  ";
const USAGE_BAR_WIDTH = 10;

function cleanLine(value: unknown): string {
	return replaceTabs(sanitizeText(String(value ?? "")))
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function wrapLines(lines: readonly string[], width: number): string[] {
	const safeWidth = Math.max(1, width);
	const wrapped: string[] = [];
	for (const line of lines) {
		if (visibleWidth(line) <= safeWidth) wrapped.push(line);
		else wrapped.push(...wrapTextWithAnsi(line, safeWidth));
	}
	return wrapped;
}

function pushIndented(lines: string[], value: string, indent: number, width: number): void {
	const safeWidth = Math.max(1, width);
	const safeIndent = Math.min(indent, Math.max(0, safeWidth - 1));
	const prefix = padding(safeIndent);
	for (const line of wrapTextWithAnsi(value, Math.max(1, safeWidth - safeIndent))) lines.push(`${prefix}${line}`);
}

function muted(text: string): string {
	return theme.fg("muted", text);
}

function dim(text: string): string {
	return theme.fg("dim", text);
}

function sectionHeading(label: string, detail?: string): string {
	const heading = theme.bold(theme.fg("accent", cleanLine(label)));
	return detail ? `${heading}${dim(` · ${detail}`)}` : heading;
}

interface CompactColumn {
	header: string;
	/** One cell per row; `""` is "no value" and renders as `placeholder`. */
	cells: readonly string[];
	align?: "left" | "right";
	placeholder?: string;
	/** Upper bound on the column's natural width. */
	max?: number;
	/** Set on the one column that absorbs leftover width and truncates; it is never dropped. */
	flexMin?: number;
	/**
	 * Dropped, lowest first, when the pane is too narrow. Such a column is also
	 * left out when no row has a value. Columns without it always stay.
	 */
	drop?: number;
}

/**
 * One line per row at any width: optional columns drop out before anything
 * wraps, and only the flex column shrinks, truncating with an ellipsis.
 */
function renderCompactTable(columns: readonly CompactColumn[], width: number): string[] {
	const natural = (column: CompactColumn): number =>
		Math.min(
			column.max ?? Number.MAX_SAFE_INTEGER,
			Math.max(
				visibleWidth(column.header),
				...column.cells.map(cell => visibleWidth(cell || column.placeholder || "")),
			),
		);
	const gapWidth = visibleWidth(TABLE_GAP);
	const available = Math.max(1, width - visibleWidth(TABLE_INDENT));
	const needed = (set: readonly CompactColumn[]): number =>
		set.reduce(
			(sum, column) =>
				sum + (column.flexMin === undefined ? natural(column) : Math.min(column.flexMin, natural(column))),
			gapWidth * (set.length - 1),
		);
	let kept = columns.filter(column => column.drop === undefined || column.cells.some(Boolean));
	const droppable = kept.filter(column => column.drop !== undefined).sort((a, b) => a.drop! - b.drop!);
	for (const column of droppable) {
		if (needed(kept) <= available) break;
		kept = kept.filter(candidate => candidate !== column);
	}
	const fixed = kept.reduce(
		(sum, column) => (column.flexMin === undefined ? sum + natural(column) : sum),
		gapWidth * (kept.length - 1),
	);
	const tableColumns: TableColumn[] = kept.map(column => ({
		width: column.flexMin === undefined ? natural(column) : Math.max(1, Math.min(natural(column), available - fixed)),
		align: column.align ?? "left",
		overflow: "truncate",
		priority: column.flexMin === undefined ? 1 : 0,
	}));
	const options = { indent: TABLE_INDENT, gap: TABLE_GAP };
	const lines = [
		renderTableRow(
			kept.map(column => ({ text: column.header, style: muted })),
			tableColumns,
			width,
			options,
		),
	];
	const rowCount = Math.max(0, ...kept.map(column => column.cells.length));
	for (let row = 0; row < rowCount; row++) {
		lines.push(
			renderTableRow(
				kept.map(column => ({ text: column.cells[row] || column.placeholder || "" })),
				tableColumns,
				width,
				options,
			),
		);
	}
	return lines;
}

/** One line per distinct warning, naming every entry that shares it. */
function groupedWarnings(entries: ReadonlyArray<{ name: string; warning?: string }>, width: number): string[] {
	const grouped = new Map<string, string[]>();
	for (const entry of entries) {
		const warning = cleanLine(entry.warning);
		if (!warning) continue;
		const names = grouped.get(warning) ?? [];
		const name = cleanLine(entry.name) || "Unnamed";
		if (!names.includes(name)) names.push(name);
		grouped.set(warning, names);
	}
	const lines: string[] = [];
	for (const [warning, names] of grouped) {
		pushIndented(lines, theme.fg("warning", `${theme.status.warning} ${names.join(", ")}: ${warning}`), 2, width);
	}
	return lines;
}

function thinkingText(level: ConfiguredThinkingLevel | undefined): string {
	if (level === undefined) return "";
	const glyph = thinkingLevelGlyph(level, theme);
	const label = getConfiguredThinkingLevelMetadata(level).label;
	return glyph ? `${glyph} ${label}` : label;
}

// ─── Summary ─────────────────────────────────────────────────────────────────

function renderSummary(setup: ProfileDashboardSetupRef, snapshot: ProfileSnapshot, width: number): string[] {
	const parts: string[] = [];
	if (setup.kind === "current") {
		parts.push(`${muted("Settings:")} all groups · current session`);
	} else {
		const enabled = new Set(setup.metadata?.enabledGroups ?? []);
		const included = PROFILE_SETTINGS_GROUPS.filter(group => enabled.has(group.id)).map(group =>
			cleanLine(group.label),
		);
		const inherited = PROFILE_SETTINGS_GROUPS.length - included.length;
		parts.push(`${muted("Includes:")} ${included.length > 0 ? included.join(", ") : "models only"}`);
		if (inherited > 0) parts.push(dim(`${inherited} group${inherited === 1 ? "" : "s"} inherited`));
	}
	const { backend, scope, storageLabel } = snapshot.memory;
	parts.push(`${muted("Memory:")} ${cleanLine(backend)}${scope ? ` (${cleanLine(scope)})` : ""}`);
	parts.push(`${muted("Storage:")} ${cleanLine(storageLabel)}`);
	return wrapTextWithAnsi(parts.join(dim(" · ")), Math.max(1, width));
}

// ─── Models ──────────────────────────────────────────────────────────────────

function roleIdentity(role: ProfileRoleRow): string {
	const selector = cleanLine(role.selector);
	const separatorIndex = selector.indexOf("/");
	const model = cleanLine(role.modelId ?? (separatorIndex >= 0 ? selector.slice(separatorIndex + 1) : selector));
	const provider = cleanLine(role.provider ?? (separatorIndex >= 0 ? selector.slice(0, separatorIndex) : ""));
	const plainTarget = provider ? `${provider}/${model}` : model;
	let target: string;
	let alias = "";
	if (model || provider) {
		target = role.automatic ? dim(`auto → ${plainTarget}`) : provider ? `${dim(`${provider}/`)}${model}` : model;
		const canonicalSelector = formatModelSelectorValue(plainTarget, role.thinkingLevel);
		if (selector && selector !== plainTarget && selector !== canonicalSelector) alias = dim(` ← ${selector}`);
	} else {
		target = dim("—");
	}
	const dot = theme.fg(
		role.warning ? "warning" : role.automatic ? "dim" : "success",
		role.automatic ? theme.status.shadowed : theme.status.enabled,
	);
	return `${dot} ${target}${alias}`;
}

function isEmptyRole(role: ProfileRoleRow): boolean {
	return (
		!cleanLine(role.selector) &&
		!cleanLine(role.provider) &&
		!cleanLine(role.modelId) &&
		role.thinkingLevel === undefined &&
		role.int === undefined &&
		role.tps === undefined &&
		role.contextWindow === undefined &&
		role.perf === undefined &&
		role.cost === undefined &&
		!cleanLine(role.warning)
	);
}

function renderModels(snapshot: ProfileSnapshot, width: number): string[] {
	const roles = snapshot.roles.filter(role => !isEmptyRole(role));
	const unassigned = snapshot.roles.filter(isEmptyRole).map(role => cleanLine(role.role) || "Unnamed role");
	const lines = [
		sectionHeading(`Models (${roles.length})`, roles.some(role => role.cost) ? "$ per 1M tokens" : undefined),
	];
	for (const warning of new Set(snapshot.warnings.map(cleanLine).filter(Boolean))) {
		pushIndented(lines, theme.fg("warning", `${theme.status.warning} ${warning}`), 2, width);
	}
	if (roles.length > 0) {
		const none = dim("—");
		lines.push(
			...renderCompactTable(
				[
					{ header: "Role", cells: roles.map(role => cleanLine(role.role)), max: 16 },
					{ header: "Model", cells: roles.map(roleIdentity), flexMin: 24 },
					{
						header: "Think",
						cells: roles.map(role => thinkingText(role.thinkingLevel)),
						placeholder: none,
						max: 12,
						drop: 5,
					},
					{
						header: "Int",
						cells: roles.map(role => formatIntelligence(role)),
						align: "right",
						placeholder: none,
						drop: 4,
					},
					{
						header: "TTFT · t/s",
						cells: roles.map(role => formatModelPerformance(role, role.perf)),
						align: "right",
						placeholder: none,
						max: 14,
						drop: 3,
					},
					{
						header: "Ctx",
						cells: roles.map(role => formatContext(role)),
						align: "right",
						placeholder: none,
						drop: 2,
					},
					{
						header: "$ in/out",
						cells: roles.map(role => (role.cost ? formatCostPair(role) : "")),
						align: "right",
						placeholder: none,
						max: 14,
						drop: 1,
					},
				],
				width,
			),
		);
	} else if (unassigned.length === 0) {
		lines.push(`${TABLE_INDENT}${dim("No roles assigned")}`);
	}
	if (unassigned.length > 0) pushIndented(lines, dim(`Unassigned: ${unassigned.join(", ")}`), 2, width);
	lines.push(
		...groupedWarnings(
			roles.map(role => ({ name: role.role, warning: role.warning })),
			width,
		),
	);
	return lines;
}

// ─── Agents ──────────────────────────────────────────────────────────────────

function agentTarget(agent: ProfileAgentRow): string {
	const provider = cleanLine(agent.provider);
	const model = cleanLine(agent.modelId);
	return provider && model ? `${provider}/${model}` : model || provider;
}

function agentModel(agent: ProfileAgentRow): string {
	const provider = cleanLine(agent.provider);
	const model = cleanLine(agent.modelId);
	if (provider && model) return `${dim(`${provider}/`)}${model}`;
	return agentTarget(agent) || cleanLine(agent.selector) || dim("Fallback: default role");
}

/** The configured selector when it names the model indirectly (an alias or a pattern). */
function agentVia(agent: ProfileAgentRow): string {
	const selector = cleanLine(agent.selector);
	const target = agentTarget(agent);
	if (!selector || !target || selector === target) return "";
	return selector === formatModelSelectorValue(target, agent.thinkingLevel) ? "" : selector;
}

function renderAgents(snapshot: ProfileSnapshot, width: number): string[] {
	const agents = snapshot.agents;
	const enabled = agents.filter(agent => agent.enabled).length;
	const sources = new Set(agents.map(agent => cleanLine(agent.source) || "unknown"));
	const details: string[] = [];
	if (agents.length > 0) {
		details.push(
			enabled === agents.length ? "all enabled" : `${enabled} enabled · ${agents.length - enabled} disabled`,
		);
		if (sources.size === 1) details.push([...sources][0]!);
	}
	const lines = [sectionHeading(`Agents (${agents.length})`, details.join(" · ") || undefined)];
	if (agents.length === 0) {
		lines.push(`${TABLE_INDENT}${dim("No agent assignments")}`);
		return lines;
	}
	lines.push(
		...renderCompactTable(
			[
				{ header: "Agent", cells: agents.map(agent => cleanLine(agent.name)), max: 22 },
				{ header: "Model", cells: agents.map(agentModel), flexMin: 20 },
				{ header: "Via", cells: agents.map(agentVia), max: 20, drop: 2 },
				{
					header: "Think",
					cells: agents.map(agent => thinkingText(agent.thinkingLevel)),
					placeholder: dim("—"),
					max: 12,
					drop: 3,
				},
				// Uniform sources are already named in the heading.
				{
					header: "Source",
					cells: sources.size > 1 ? agents.map(agent => dim(cleanLine(agent.source) || "unknown")) : [],
					max: 12,
					drop: 1,
				},
				{
					header: "Status",
					cells: agents.map(agent =>
						theme.fg(
							agent.warning ? "warning" : agent.enabled ? "success" : "dim",
							agent.enabled ? `${theme.status.enabled} enabled` : `${theme.status.shadowed} disabled`,
						),
					),
				},
			],
			width,
		),
	);
	lines.push(
		...groupedWarnings(
			agents.map(agent => ({ name: agent.name, warning: agent.warning })),
			width,
		),
	);
	return lines;
}

// ─── Usage ───────────────────────────────────────────────────────────────────

/**
 * Quota left on the providers this profile's models use, aggregated as the
 * `/usage` dashboard does. Every profile draws on this machine's accounts, so
 * profiles differ in which providers' quota they use; the rows compare that.
 */
function renderUsage(reports: readonly UsageReport[], snapshot: ProfileSnapshot, width: number): string[] {
	const now = Date.now();
	const roleUsers = new Map<string, string[]>();
	for (const role of snapshot.roles) {
		if (!role.provider) continue;
		const names = roleUsers.get(role.provider) ?? [];
		names.push(cleanLine(role.role));
		roleUsers.set(role.provider, names);
	}
	const agentUsers = new Map<string, number>();
	for (const agent of snapshot.agents) {
		if (agent.provider) agentUsers.set(agent.provider, (agentUsers.get(agent.provider) ?? 0) + 1);
	}
	const inUse = new Set([...roleUsers.keys(), ...agentUsers.keys()]);
	const profileReports = reports.filter(report => inUse.has(report.provider));
	const cards = buildProviderCards(profileReports, now);
	const latest = Math.max(0, ...profileReports.map(report => report.fetchedAt ?? 0));
	const fractions = cards.flatMap(card => card.windows.map(window => window.fraction)).filter(f => f !== undefined);
	const details = [
		...(fractions.length > 0 ? [`lowest ${Math.max(0, Math.round((1 - Math.max(...fractions)) * 100))}% free`] : []),
		...(latest > 0 ? [`updated ${formatDuration(now - latest)} ago`] : []),
	];
	const lines = [sectionHeading("Usage & limits", details.join(" · ") || undefined)];
	const providers: string[] = [];
	const limits: string[] = [];
	const bars: string[] = [];
	const free: string[] = [];
	const resets: string[] = [];
	const users: string[] = [];
	const push = (provider: string, limit: string, bar = "", left = "", reset = "", usedBy = ""): void => {
		providers.push(provider);
		limits.push(limit);
		bars.push(bar);
		free.push(left);
		resets.push(reset);
		users.push(usedBy);
	};
	for (const card of cards) {
		const name =
			card.accounts > 1 ? `${cleanLine(card.name)} ${dim(`${card.accounts} accts`)}` : cleanLine(card.name);
		const agents = agentUsers.get(card.provider) ?? 0;
		const usedBy = dim(
			[
				...(roleUsers.get(card.provider) ?? []),
				...(agents > 0 ? [`${agents} agent${agents === 1 ? "" : "s"}`] : []),
			].join(", "),
		);
		if (card.unlimited) {
			push(name, dim("no limits"), "", "", "", usedBy);
			continue;
		}
		for (const [index, window] of card.windows.slice(0, CARD_MAX_WINDOWS).entries()) {
			const label = `${muted(cleanLine(window.label))}${window.windowTag ? dim(` ${cleanLine(window.windowTag)}`) : ""}`;
			const reset = window.resetMs !== undefined ? dim(formatDuration(window.resetMs)) : "";
			const first = index === 0;
			if (window.fraction === undefined) {
				push(
					first ? name : "",
					label,
					"",
					dim(cleanLine(window.usedText ?? "no data")),
					reset,
					first ? usedBy : "",
				);
				continue;
			}
			push(
				first ? name : "",
				label,
				renderUsageBar(window.fraction, window.status, USAGE_BAR_WIDTH),
				theme.fg(usageStatusColor(window.status), `${Math.max(0, Math.round((1 - window.fraction) * 100))}%`),
				reset,
				first ? usedBy : "",
			);
		}
		const hidden = card.windows.length - CARD_MAX_WINDOWS;
		if (hidden > 0) push("", dim(`+${hidden} more`));
	}
	if (providers.length > 0) {
		lines.push(
			...renderCompactTable(
				[
					{ header: "Provider", cells: providers, max: 24 },
					{ header: "Limit", cells: limits, flexMin: 12 },
					{ header: "Used", cells: bars, drop: 3 },
					{ header: "Free", cells: free, align: "right", max: 16 },
					{ header: "Resets in", cells: resets, align: "right", drop: 2 },
					{ header: "Used by", cells: users, max: 28, drop: 1 },
				],
				width,
			),
		);
	}
	const reported = new Set(reports.map(report => report.provider));
	const unreported = [...inUse]
		.filter(provider => !reported.has(provider))
		.map(provider => cleanLine(formatProviderName(provider)));
	if (unreported.length > 0) pushIndented(lines, dim(`Not reported: ${unreported.join(" · ")}`), 2, width);
	if (inUse.size === 0) lines.push(`${TABLE_INDENT}${dim("No models assigned, so no provider quota applies")}`);
	return lines;
}

/**
 * The read-only profile overview: one summary line, then Models, Agents, and
 * Usage for the providers the profile uses, each as a one-line-per-row table
 * so profiles compare at a glance. The draft editor holds the full detail.
 */
export function buildProfilePreviewOverview(options: {
	setup: ProfileDashboardSetupRef;
	snapshot: ProfileSnapshot;
	width: number;
	/** This session's account usage reports; shown last, filtered to the profile's providers. */
	usage?: readonly UsageReport[];
}): string[] {
	const { setup, snapshot } = options;
	const width = Math.max(1, options.width);
	const rule = dim(theme.boxSharp.horizontal.repeat(width));
	const lines = [
		...renderSummary(setup, snapshot, width),
		rule,
		...renderModels(snapshot, width),
		rule,
		...renderAgents(snapshot, width),
	];
	if (options.usage && options.usage.length > 0) lines.push(rule, ...renderUsage(options.usage, snapshot, width));
	return wrapLines(lines, width);
}
