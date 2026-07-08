import { type CacheStats, countTokens } from "@pk-nerdsaver-ai/pi-agent-core";
import type { CompactionSettings } from "@pk-nerdsaver-ai/pi-agent-core/compaction";
import {
	effectiveReserveTokens,
	estimateTokens,
	resolveThresholdTokens,
} from "@pk-nerdsaver-ai/pi-agent-core/compaction";
import type { Tool as AiTool, Model } from "@pk-nerdsaver-ai/pi-ai";
import { toolWireSchema } from "@pk-nerdsaver-ai/pi-ai/utils/schema";
import { formatNumber } from "@pk-nerdsaver-ai/pi-utils";
import type { Skill } from "../../extensibility/skills";
import type { AgentSession } from "../../session/agent-session";
import { estimateInlineSavings, type SnapcompactSavingsEstimate } from "../../session/snapcompact-inline";
import type { Tool } from "../../tools";
import type { theme as Theme } from "../theme/theme";

const GRID_COLS = 20;
const GRID_ROWS = 10;
const GRID_CELLS = GRID_COLS * GRID_ROWS;
const GRID_GUTTER = "   ";

const CELL_FILLED = "⛁";
const CELL_FILLED_MESSAGES = "⛃";
const CELL_FREE = "⛶";
const CELL_BUFFER = "⛝";

type CategoryId = "systemPrompt" | "systemContext" | "systemTools" | "skills" | "messages";

interface CategoryInfo {
	id: CategoryId;
	label: string;
	tokens: number;
	color: "accent" | "warning" | "success" | "userMessageText" | "customMessageLabel";
	glyph: string;
}

export interface ContextBreakdown {
	model: Model | undefined;
	contextWindow: number;
	categories: CategoryInfo[];
	usedTokens: number;
	autoCompactBufferTokens: number;
	freeTokens: number;
	/** Estimated snapcompact wire savings; set when requested and a snapcompact.* setting is enabled. */
	snapcompact?: SnapcompactSavingsEstimate;
	/** Tool-result waste audit; set when requested. */
	waste?: ContextWaste;
	/** Prompt-cache stats with attributed break causes; set when requested. */
	cache?: CacheStats;
}

/** Per-tool token spend for one tool's results still live in context. */
export interface ToolResultSpend {
	toolName: string;
	tokens: number;
	count: number;
}

/**
 * PICHAY-style structural-waste audit of the live message history: where
 * tool-result tokens sit (by tool), and how much the per-turn masking passes
 * have already reclaimed (results carrying `prunedAt`).
 */
export interface ContextWaste {
	/** Tool-result token spend by tool, largest first. */
	toolResults: ToolResultSpend[];
	/** Total tokens across all live (unmasked) tool results. */
	totalToolResultTokens: number;
	/** Count of results already replaced by masking placeholders. */
	maskedCount: number;
	/** Tokens the masked placeholders still occupy (the residue, not the savings). */
	maskedResidueTokens: number;
}

const EMPTY_STRING_PARTS: readonly string[] = [];
const EMPTY_TOOLS: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">> = [];

export function estimateSkillsTokens(skills: readonly Skill[]): number {
	const fragments: string[] = [];
	for (const skill of skills) {
		// "- name: description\n" wire framing tokenizes ~identically to the
		// concatenated form, so encode each piece separately and sum.
		fragments.push(skill.name, skill.description);
	}
	return countTokens(fragments);
}

export function estimateToolSchemaTokens(
	tools: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">>,
): number {
	const fragments: string[] = [];
	for (const tool of tools) {
		fragments.push(tool.name, tool.description);
		try {
			const wireTool: AiTool = {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters as AiTool["parameters"],
			};
			fragments.push(JSON.stringify(toolWireSchema(wireTool) ?? {}));
		} catch {
			// Schema may contain functions or cycles; ignore.
		}
	}
	return countTokens(fragments);
}

/**
 * Compute just the NON-MESSAGE token total: system prompt (with its skills
 * section subtracted, since skills are tokenized separately) + system context
 * (the rest of the system-prompt array) + tools + skills.
 *
 * Exposed so callers like `StatusLineComponent` can cache the non-message
 * total separately from the message total. Non-message inputs (skills,
 * tools, system prompt) change rarely; the message list grows on every
 * streaming turn. Splitting the two lets the caller refresh each on its own
 * cadence — non-message recomputed only when the inputs identity changes,
 * messages walked incrementally as new entries append.
 */
export function computeNonMessageTokens(session: AgentSession): number {
	const systemPromptParts = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const tools = session.agent?.state?.tools ?? EMPTY_TOOLS;
	return countTokens(systemPromptParts) + estimateToolSchemaTokens(tools);
}

/**
 * Shared helper for the four non-message token totals used by
 * `computeContextBreakdown` (/context panel). Keep this category split stable:
 * the status-line fast path intentionally uses the equivalent collapsed total
 * in `computeNonMessageTokens`.
 */
export function computeNonMessageBreakdown(session: AgentSession): {
	skillsTokens: number;
	toolsTokens: number;
	systemContextTokens: number;
	systemPromptTokens: number;
} {
	const skillsTokens = estimateSkillsTokens(session.skills ?? []);
	const toolsTokens = estimateToolSchemaTokens(session.agent?.state?.tools ?? []);
	const systemPromptParts = session.systemPrompt ?? [];
	const systemContextTokens = countTokens(systemPromptParts.slice(1));
	const systemPromptTokens = Math.max(0, countTokens(systemPromptParts[0] ?? "") - skillsTokens);
	return { skillsTokens, toolsTokens, systemContextTokens, systemPromptTokens };
}

/**
 * Audit tool-result token spend in the live message history: per-tool totals
 * for results still occupying context, plus how many results the masking
 * passes have already replaced with placeholders.
 */
export function computeContextWaste(session: AgentSession): ContextWaste {
	const perTool = new Map<string, ToolResultSpend>();
	let totalToolResultTokens = 0;
	let maskedCount = 0;
	let maskedResidueTokens = 0;
	for (const message of session.messages ?? []) {
		if (message.role !== "toolResult") continue;
		const tokens = estimateTokens(message);
		if (message.prunedAt !== undefined) {
			maskedCount += 1;
			maskedResidueTokens += tokens;
			continue;
		}
		totalToolResultTokens += tokens;
		const name = message.toolName || "(unknown)";
		const spend = perTool.get(name);
		if (spend) {
			spend.tokens += tokens;
			spend.count += 1;
		} else {
			perTool.set(name, { toolName: name, tokens, count: 1 });
		}
	}
	return {
		toolResults: [...perTool.values()].sort((a, b) => b.tokens - a.tokens),
		totalToolResultTokens,
		maskedCount,
		maskedResidueTokens,
	};
}

/**
 * Compute a breakdown of estimated context usage by category for the active
 * session and model.
 */
export function computeContextBreakdown(
	session: AgentSession,
	options?: { snapcompactSavings?: boolean; waste?: boolean },
): ContextBreakdown {
	const model = session.model;
	const contextWindow = model?.contextWindow ?? 0;

	const breakdown = typeof session.getContextBreakdown === "function" ? session.getContextBreakdown() : undefined;

	let messagesTokens = 0;
	let skillsTokens = 0;
	let toolsTokens = 0;
	let systemContextTokens = 0;
	let systemPromptTokens = 0;
	let usedTokens = 0;

	if (breakdown) {
		messagesTokens = breakdown.messagesTokens;
		skillsTokens = breakdown.skillsTokens;
		toolsTokens = breakdown.systemToolsTokens;
		systemContextTokens = breakdown.systemContextTokens;
		systemPromptTokens = breakdown.systemPromptTokens;
		usedTokens = breakdown.usedTokens;
	} else {
		const convo = session.messages;
		if (convo) {
			for (const message of convo) {
				messagesTokens += estimateTokens(message);
			}
		}
		const nonMessage = computeNonMessageBreakdown(session);
		skillsTokens = nonMessage.skillsTokens;
		toolsTokens = nonMessage.toolsTokens;
		systemContextTokens = nonMessage.systemContextTokens;
		systemPromptTokens = nonMessage.systemPromptTokens;
		usedTokens = skillsTokens + toolsTokens + systemContextTokens + systemPromptTokens + messagesTokens;
	}

	const categories: CategoryInfo[] = [
		{ id: "systemPrompt", label: "System prompt", tokens: systemPromptTokens, color: "accent", glyph: CELL_FILLED },
		{ id: "systemTools", label: "System tools", tokens: toolsTokens, color: "warning", glyph: CELL_FILLED },
		{
			id: "systemContext",
			label: "System context",
			tokens: systemContextTokens,
			color: "customMessageLabel",
			glyph: CELL_FILLED,
		},
		{ id: "skills", label: "Skills", tokens: skillsTokens, color: "success", glyph: CELL_FILLED },
		{
			id: "messages",
			label: "Messages",
			tokens: messagesTokens,
			color: "userMessageText",
			glyph: CELL_FILLED_MESSAGES,
		},
	];

	let autoCompactBufferTokens = 0;
	if (contextWindow > 0) {
		const compactionSettings = session.settings.getGroup("compaction") as CompactionSettings;
		if (compactionSettings.enabled && compactionSettings.strategy !== "off") {
			const threshold = resolveThresholdTokens(contextWindow, compactionSettings);
			autoCompactBufferTokens = Math.max(0, contextWindow - threshold);
		} else {
			autoCompactBufferTokens = 0;
		}
		// Even when fully disabled, fall back to a sensible reserve floor for display.
		if (autoCompactBufferTokens === 0 && compactionSettings.enabled) {
			autoCompactBufferTokens = effectiveReserveTokens(contextWindow, compactionSettings);
		}
	}
	autoCompactBufferTokens = Math.min(autoCompactBufferTokens, Math.max(0, contextWindow - usedTokens));

	const freeTokens = Math.max(0, contextWindow - usedTokens - autoCompactBufferTokens);

	// Estimated wire savings from snapcompact inline imaging. Opt-in: only the
	// /context surfaces need it; other callers skip the extra token counting.
	let snapcompactSavings: SnapcompactSavingsEstimate | undefined;
	if (options?.snapcompactSavings) {
		const renderSystemPrompt = session.settings.get("snapcompact.systemPrompt");
		const renderToolResults = session.settings.get("snapcompact.toolResults");
		if (renderSystemPrompt !== "none" || renderToolResults) {
			snapcompactSavings = estimateInlineSavings({
				options: { renderSystemPrompt, renderToolResults, shape: session.settings.get("snapcompact.shape") },
				model,
				systemPrompt: session.systemPrompt ?? [],
				messages: session.messages ?? [],
			});
		}
	}

	return {
		model,
		contextWindow,
		categories,
		usedTokens,
		autoCompactBufferTokens,
		freeTokens,
		snapcompact: snapcompactSavings,
		waste: options?.waste ? computeContextWaste(session) : undefined,
		cache: options?.waste && typeof session.getCacheStats === "function" ? session.getCacheStats() : undefined,
	};
}

interface CellSpec {
	glyph: string;
	color: "accent" | "warning" | "success" | "userMessageText" | "customMessageLabel" | "muted" | "dim";
}

function planCells(breakdown: ContextBreakdown): CellSpec[] {
	const cells: CellSpec[] = [];
	const window = breakdown.contextWindow;

	if (window <= 0) {
		for (let i = 0; i < GRID_CELLS; i++) {
			cells.push({ glyph: CELL_FREE, color: "dim" });
		}
		return cells;
	}

	const tokensPerCell = window / GRID_CELLS;

	const ratioCells = (tokens: number): number => {
		if (tokens <= 0) return 0;
		return Math.max(1, Math.round(tokens / tokensPerCell));
	};

	const categoryCounts = breakdown.categories.map(category => ({
		category,
		count: ratioCells(category.tokens),
	}));

	let bufferCount = ratioCells(breakdown.autoCompactBufferTokens);

	let usedCount = categoryCounts.reduce((sum, c) => sum + c.count, 0);

	// Prevent the visualization from over-running the grid.
	const maxUsable = GRID_CELLS - bufferCount;
	if (usedCount > maxUsable) {
		// Scale categories proportionally down to fit.
		let overflow = usedCount - maxUsable;
		// Trim from the largest categories first to preserve visibility for small ones.
		const order = [...categoryCounts].sort((a, b) => b.count - a.count);
		for (const entry of order) {
			while (overflow > 0 && entry.count > 1) {
				entry.count -= 1;
				overflow -= 1;
			}
		}
		usedCount = categoryCounts.reduce((sum, c) => sum + c.count, 0);
		if (usedCount + bufferCount > GRID_CELLS) {
			bufferCount = Math.max(0, GRID_CELLS - usedCount);
		}
	}

	for (const { category, count } of categoryCounts) {
		for (let i = 0; i < count; i++) {
			cells.push({ glyph: category.glyph, color: category.color });
		}
	}

	const freeCount = Math.max(0, GRID_CELLS - cells.length - bufferCount);
	for (let i = 0; i < freeCount; i++) {
		cells.push({ glyph: CELL_FREE, color: "dim" });
	}
	for (let i = 0; i < bufferCount; i++) {
		cells.push({ glyph: CELL_BUFFER, color: "warning" });
	}

	// Pad to exactly GRID_CELLS in case rounding undershot.
	while (cells.length < GRID_CELLS) {
		cells.push({ glyph: CELL_FREE, color: "dim" });
	}
	return cells.slice(0, GRID_CELLS);
}

function percentString(part: number, whole: number, fractionDigits = 1): string {
	if (whole <= 0) return "0%";
	const pct = (part / whole) * 100;
	if (pct > 0 && pct < 0.05) return "<0.1%";
	return `${pct.toFixed(fractionDigits)}%`;
}

function buildLegendLines(breakdown: ContextBreakdown, theme: typeof Theme): string[] {
	const lines: string[] = [];
	const { model, contextWindow, categories, usedTokens, autoCompactBufferTokens, freeTokens } = breakdown;

	const modelName = model?.name ?? model?.id ?? "no model";
	const modelId = model?.id ?? "unknown";
	const windowLabel = formatNumber(contextWindow).toLowerCase();

	lines.push(theme.bold(`${modelName}`) + theme.fg("dim", ` (${windowLabel} context)`));
	lines.push(theme.fg("muted", `${modelId}[${windowLabel}]`));
	lines.push(
		`${theme.bold(formatNumber(usedTokens))}${theme.fg("dim", `/${windowLabel} tokens`)}` +
			theme.fg("muted", ` (${percentString(usedTokens, contextWindow)})`),
	);
	lines.push("");
	lines.push(theme.fg("muted", "Estimated usage by category"));

	for (const category of categories) {
		const dot = theme.fg(category.color, category.glyph);
		const label = category.label;
		const tokens = formatNumber(category.tokens);
		const pct = percentString(category.tokens, contextWindow);
		lines.push(`${dot} ${label}: ${theme.bold(tokens)} ${theme.fg("dim", `tokens (${pct})`)}`);
	}

	const freeDot = theme.fg("dim", CELL_FREE);
	lines.push(
		`${freeDot} Free space: ${theme.bold(formatNumber(freeTokens))} ${theme.fg("dim", `(${percentString(freeTokens, contextWindow)})`)}`,
	);

	if (autoCompactBufferTokens > 0) {
		const bufferDot = theme.fg("warning", CELL_BUFFER);
		lines.push(
			`${bufferDot} Autocompact buffer: ${theme.bold(formatNumber(autoCompactBufferTokens))} ${theme.fg(
				"dim",
				`tokens (${percentString(autoCompactBufferTokens, contextWindow)})`,
			)}`,
		);
	}

	const waste = breakdown.waste;
	if (waste && (waste.toolResults.length > 0 || waste.maskedCount > 0)) {
		lines.push("");
		lines.push(theme.fg("muted", "Tool results in context"));
		for (const spend of waste.toolResults.slice(0, 5)) {
			lines.push(
				`  ${spend.toolName}: ${theme.bold(formatNumber(spend.tokens))} ${theme.fg(
					"dim",
					`tokens (${spend.count} result${spend.count === 1 ? "" : "s"})`,
				)}`,
			);
		}
		if (waste.toolResults.length > 5) {
			const restTokens = waste.toolResults.slice(5).reduce((sum, spend) => sum + spend.tokens, 0);
			lines.push(
				theme.fg("dim", `  +${waste.toolResults.length - 5} more tools (${formatNumber(restTokens)} tokens)`),
			);
		}
		if (waste.maskedCount > 0) {
			lines.push(
				theme.fg(
					"dim",
					`  ${waste.maskedCount} result${waste.maskedCount === 1 ? "" : "s"} already masked (${formatNumber(waste.maskedResidueTokens)} tokens residue)`,
				),
			);
		}
	}

	const cache = breakdown.cache;
	if (cache?.cachingObserved && cache.requests > 0) {
		lines.push("");
		lines.push(
			theme.fg("muted", "Prompt cache: ") +
				theme.bold(percentString(cache.cacheReadTokens, cache.promptTokens, 0)) +
				theme.fg("dim", ` hit rate over ${cache.requests} request${cache.requests === 1 ? "" : "s"}`),
		);
		if (cache.breaks > 0) {
			const causes = Object.entries(cache.breaksByCause)
				.filter(([, count]) => count > 0)
				.map(([cause, count]) => `${count} ${cause}`)
				.join(", ");
			lines.push(theme.fg("dim", `  ${cache.breaks} cache break${cache.breaks === 1 ? "" : "s"}: ${causes}`));
		}
	}

	const snap = breakdown.snapcompact;
	if (snap) {
		lines.push("");
		if (!snap.visionCapable) {
			lines.push(theme.fg("muted", "Snapcompact: inactive (model has no image input)"));
		} else {
			lines.push(theme.fg("muted", "Snapcompact (estimated wire savings)"));
			if (snap.systemPrompt) {
				const sp = snap.systemPrompt;
				if (sp.applied) {
					lines.push(
						`  System prompt (${sp.scope === "agents-md" ? "AGENTS.md" : "all"}): saves ${theme.bold(`~${formatNumber(sp.savedTokens)}`)} ` +
							theme.fg(
								"dim",
								`(${formatNumber(sp.textTokens)} text → ${sp.frames} frame${sp.frames === 1 ? "" : "s"} ≈ ${formatNumber(sp.imageTokens)})`,
							),
					);
				} else {
					const reason =
						sp.reason === "budget"
							? "image budget exhausted"
							: sp.reason === "empty"
								? "nothing to image"
								: "frames would not save tokens";
					lines.push(
						`  System prompt (${sp.scope === "agents-md" ? "AGENTS.md" : "all"}): ${theme.fg("dim", `stays text (${reason})`)}`,
					);
				}
			}
			if (snap.toolResults) {
				const tr = snap.toolResults;
				if (tr.swapped > 0) {
					lines.push(
						`  Tool results: saves ${theme.bold(`~${formatNumber(tr.savedTokens)}`)} ` +
							theme.fg(
								"dim",
								`(${tr.swapped}/${tr.total} imaged, ${formatNumber(tr.textTokens)} text → ${tr.frames} frames ≈ ${formatNumber(tr.imageTokens)})`,
							),
					);
				} else {
					lines.push(`  Tool results: ${theme.fg("dim", `none imaged (${tr.total} in history)`)}`);
				}
			}
			if (snap.savedTokens > 0) {
				lines.push(
					`  Next request: ${theme.bold(`~${formatNumber(Math.max(0, usedTokens - snap.savedTokens))}`)} ${theme.fg("dim", "tokens on the wire")}`,
				);
			}
		}
	}

	return lines;
}

/**
 * Render a colorful context-usage panel as ANSI text. Output is a series of
 * lines pairing the grid (left) with the legend (right).
 */
export function renderContextUsage(breakdown: ContextBreakdown, theme: typeof Theme): string {
	if (breakdown.contextWindow <= 0) {
		return theme.fg("muted", "Context usage is unavailable: no model is selected for this session.");
	}

	const cells = planCells(breakdown);
	const legend = buildLegendLines(breakdown, theme);

	const totalLines = Math.max(GRID_ROWS, legend.length);
	const lines: string[] = [];

	for (let row = 0; row < totalLines; row++) {
		let gridSegment = "";
		if (row < GRID_ROWS) {
			const rowCells: string[] = [];
			for (let col = 0; col < GRID_COLS; col++) {
				const cell = cells[row * GRID_COLS + col];
				rowCells.push(theme.fg(cell.color, cell.glyph));
			}
			gridSegment = rowCells.join(" ");
		} else {
			// Pad with blanks the same visible width as a grid row so legend lines
			// past the grid stay aligned with their column.
			const blank = " ".repeat(GRID_COLS * 2 - 1);
			gridSegment = blank;
		}

		const legendSegment = legend[row] ?? "";
		const line = legendSegment.length > 0 ? `${gridSegment}${GRID_GUTTER}${legendSegment}` : gridSegment;
		lines.push(line);
	}

	return lines.join("\n");
}
