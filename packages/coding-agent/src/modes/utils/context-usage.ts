import type { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { CompactionSettings } from "@oh-my-pi/pi-agent-core/compaction";
import { effectiveReserveTokens, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Tool as AiTool, Model } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { Skill } from "../../extensibility/skills";
import type { AgentSession } from "../../session/agent-session";
import { resolveSpeculationMethod } from "../../session/compaction-methods";
import { estimateInlineSavings, type SnapcompactSavingsEstimate } from "../../session/snapcompact-inline";
import { resolveSpeculationLeadTokens } from "../../session/speculation-lead";
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
}

/** Percent positions (0–100 of the context window) for the auto-compaction boundaries. */
export interface CompactionBoundaries {
	/** Where auto-compaction fires. */
	thresholdPercent: number;
	/**
	 * Where the background speculative summarizer starts (threshold − lead), or
	 * `null` when no speculation will run (async compaction disabled, or the
	 * first available method is local — snapcompact/shake — and thus instant).
	 */
	speculationPercent: number | null;
}

/**
 * Boundary positions for the status line's annotated context gauge. `null`
 * when compaction is disabled/off or the window is unknown — the gauge then
 * renders without markers. `model` resolves which configured method a real
 * pass would run; without it, model-gated methods count as unavailable.
 */
export function computeCompactionBoundaries(
	settings: AgentSession["settings"],
	contextWindow: number,
	model?: Model | null,
): CompactionBoundaries | null {
	if (!(contextWindow > 0)) return null;
	const configured = settings.getGroup("compaction");
	const compactionSettings = configured as CompactionSettings;
	if (!configured.enabled || compactionSettings.strategy === "off") return null;
	const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
	if (!(thresholdTokens > 0) || thresholdTokens > contextWindow) return null;
	const speculates = configured.asyncEnabled !== false && resolveSpeculationMethod(model, configured) !== undefined;
	const leadTokens = resolveSpeculationLeadTokens(thresholdTokens);
	return {
		thresholdPercent: (thresholdTokens / contextWindow) * 100,
		speculationPercent: speculates ? (Math.max(0, thresholdTokens - leadTokens) / contextWindow) * 100 : null,
	};
}

/** Stable inputs used to cache non-message token estimates. */
export interface NonMessageTokenSource {
	readonly systemPrompt?: string[];
	readonly agent?: {
		readonly state?: {
			readonly tools?: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">>;
		};
	};
	readonly skills?: readonly Skill[];
}

const EMPTY_STRING_PARTS: string[] = [];
const EMPTY_TOOLS: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">> = [];
const EMPTY_SKILLS: readonly Skill[] = [];

/**
 * Skills actually rendered into the system prompt, mirroring the filter in
 * `buildSystemPrompt` (`system-prompt.ts`): the `read` tool must be present so
 * the model can fetch skill content, and skills with frontmatter `hide: true`
 * (or `disable-model-invocation`, normalized onto `hide`) are excluded.
 * Accounting must count only these so the Skills category and the System-prompt
 * subtraction stay aligned with the provider-facing prompt.
 */
function renderedSkills(
	skills: readonly Skill[],
	tools: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">>,
): readonly Skill[] {
	if (!tools.some(tool => tool.name === "read")) return EMPTY_SKILLS;
	return skills.filter(skill => skill.hide !== true);
}

export function estimateSkillsTokens(skills: readonly Skill[], tokenizer: Tokenizer): number {
	const fragments: string[] = [];
	for (const skill of skills) {
		// "- name: description\n" wire framing tokenizes ~identically to the
		// concatenated form, so encode each piece separately and sum.
		fragments.push(skill.name, skill.description ?? "");
	}
	return tokenizer.countTokens(fragments);
}

export function estimateToolSchemaTokens(
	tools: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">>,
	tokenizer: Tokenizer,
): number {
	const fragments: string[] = [];
	for (const tool of tools) {
		// Extension-supplied tools may carry a non-string name/description or a
		// parameters value whose wire schema stringifies to `undefined` (e.g. a
		// callable schema that escaped normalization). A non-string fragment is
		// fatal inside the native tokenizer, so only real strings are counted.
		if (typeof tool.name === "string") fragments.push(tool.name);
		if (typeof tool.description === "string") fragments.push(tool.description);
		try {
			const wireTool: AiTool = {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters as AiTool["parameters"],
			};
			const wireJson = JSON.stringify(toolWireSchema(wireTool) ?? {});
			if (typeof wireJson === "string") fragments.push(wireJson);
		} catch {
			// Schema may contain functions or cycles; ignore.
		}
	}
	return tokenizer.countTokens(fragments);
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
// Non-message inputs (system prompt, tools, skills) change rarely — at most
// once per turn via setSystemPrompt/setTools — but the per-turn compaction and
// threshold paths call these helpers several times: getContextBreakdown calls
// both, and #estimateStoredContextTokens adds a third. Memoize on the identity
// of the three input arrays so the expensive parts (system-prompt tokenization
// and the per-tool JSON.stringify(toolWireSchema) inside estimateToolSchemaTokens)
// run at most once per input change rather than per call. The identity keys are
// the same stable references the StatusLineComponent cache already trusts
// (setSystemPrompt/setTools replace the array reference rather than mutating it).
interface NonMessageTokenCache {
	systemPromptRef: readonly string[];
	toolsRef: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">>;
	skillsRef: readonly Skill[];
	// The Agent swaps its Tokenizer instance when the model's encoding changes,
	// so instance identity doubles as the encoding key.
	tokenizerRef: Tokenizer;
	tokens: number | undefined;
	breakdown:
		| {
				skillsTokens: number;
				toolsTokens: number;
				systemContextTokens: number;
				systemPromptTokens: number;
		  }
		| undefined;
}

const NON_MESSAGE_TOKEN_CACHE = Symbol("non-message-token-cache");

interface CachedNonMessageTokenSource extends NonMessageTokenSource {
	[NON_MESSAGE_TOKEN_CACHE]?: NonMessageTokenCache;
}

function nonMessageTokenCacheEntry(session: NonMessageTokenSource, tokenizer: Tokenizer): NonMessageTokenCache {
	const cachedSession: CachedNonMessageTokenSource = session;
	const systemPromptRef = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const toolsRef = session.agent?.state?.tools ?? EMPTY_TOOLS;
	const skillsRef = session.skills ?? EMPTY_SKILLS;
	let entry = cachedSession[NON_MESSAGE_TOKEN_CACHE];
	if (
		entry &&
		entry.systemPromptRef === systemPromptRef &&
		entry.toolsRef === toolsRef &&
		entry.skillsRef === skillsRef &&
		entry.tokenizerRef === tokenizer
	) {
		return entry;
	}
	entry = { systemPromptRef, toolsRef, skillsRef, tokenizerRef: tokenizer, tokens: undefined, breakdown: undefined };
	cachedSession[NON_MESSAGE_TOKEN_CACHE] = entry;
	return entry;
}

export function computeNonMessageTokens(session: NonMessageTokenSource, tokenizer: Tokenizer): number {
	const entry = nonMessageTokenCacheEntry(session, tokenizer);
	if (entry.tokens !== undefined) return entry.tokens;
	const systemPromptParts = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const tools = session.agent?.state?.tools ?? EMPTY_TOOLS;
	const tokens =
		tokenizer.countTokens(Array.from(systemPromptParts, part => part ?? "")) +
		estimateToolSchemaTokens(tools, tokenizer);
	entry.tokens = tokens;
	return tokens;
}

/**
 * Shared helper for the four non-message token totals used by
 * `computeContextBreakdown` (/context panel). Keep this category split stable:
 * the status-line fast path intentionally uses the equivalent collapsed total
 * in `computeNonMessageTokens`.
 */
export function computeNonMessageBreakdown(
	session: NonMessageTokenSource,
	tokenizer: Tokenizer,
): {
	skillsTokens: number;
	toolsTokens: number;
	systemContextTokens: number;
	systemPromptTokens: number;
} {
	const entry = nonMessageTokenCacheEntry(session, tokenizer);
	if (entry.breakdown) return entry.breakdown;
	const tools = session.agent?.state?.tools ?? EMPTY_TOOLS;
	const skillsTokens = estimateSkillsTokens(renderedSkills(session.skills ?? EMPTY_SKILLS, tools), tokenizer);
	const toolsTokens = estimateToolSchemaTokens(tools, tokenizer);
	const systemPromptParts = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const systemContextTokens = tokenizer.countTokens(Array.from(systemPromptParts.slice(1), part => part ?? ""));
	const systemPromptTokens = Math.max(0, tokenizer.countTokens(systemPromptParts[0] ?? "") - skillsTokens);
	const breakdown = { skillsTokens, toolsTokens, systemContextTokens, systemPromptTokens };
	entry.breakdown = breakdown;
	return breakdown;
}

/**
 * Compute a breakdown of estimated context usage by category for the active
 * session and model.
 */
export function computeContextBreakdown(
	session: AgentSession,
	options?: { snapcompactSavings?: boolean },
): ContextBreakdown {
	const model = session.model;
	const tokenizer = session.agent.tokenizer;
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
		// Category split needs a messages-only number, so this walk stays local:
		// an anchored total folds the system prompt and tool schemas into it.
		messagesTokens = tokenizer.countMessages(session.messages ?? []);
		const nonMessage = computeNonMessageBreakdown(session, tokenizer);
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
