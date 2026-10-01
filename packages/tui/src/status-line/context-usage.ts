import type { AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { CompactionSettings } from "@oh-my-pi/pi-agent-core/compaction";
import { effectiveReserveTokens, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Tool as AiTool, Model } from "@oh-my-pi/pi-ai";
import { renderToolExamples } from "@oh-my-pi/pi-ai/dialect";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { Theme, ThemeColor } from "../theme";
import { Container } from "../tui";
import { Text } from "../components/text";
import { Spacer } from "../components/spacer";
import { DynamicBorder } from "../chrome/dynamic-border";
import type { TspSpan, TspText } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeNode } from "../native/node";
import { card, col, node, row, span, text } from "../native/describe";

interface ContextSkill {
	readonly name: string;
	readonly description?: string;
	readonly hide?: boolean;
}

type ContextTool = Pick<AiTool, "name" | "description" | "parameters" | "examples">;

/** Savings computed by the host's inline-image planner, not by the renderer. */
export interface ContextSavingsEstimate {
	visionCapable: boolean;
	systemPrompt?: {
		applied: boolean;
		reason?: "empty" | "margin" | "budget";
		textTokens: number;
		frames: number;
		imageTokens: number;
		savedTokens: number;
		scope: "agents-md" | "all";
	};
	toolResults?: {
		total: number;
		swapped: number;
		textTokens: number;
		frames: number;
		imageTokens: number;
		savedTokens: number;
	};
	savedTokens: number;
}

/** Real sessions satisfy this view without wrapping or copying their state. */
export interface ContextUsageSession extends NonMessageTokenSource {
	readonly model: Model | undefined;
	readonly agent: {
		readonly tokenizer: Tokenizer;
		readonly state?: { readonly tools?: readonly ContextTool[] };
	};
	readonly messages?: AgentMessage[];
	getContextBreakdown?():
		| {
				messagesTokens: number;
				skillsTokens: number;
				systemToolsTokens: number;
				systemContextTokens: number;
				systemPromptTokens: number;
				usedTokens: number;
		  }
		| undefined;
}

export interface ContextUsageOptions {
	compaction: CompactionSettings;
	sourceRevision?: number;
	skillful?: boolean;
	snapcompact?: ContextSavingsEstimate;
}

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
	/** Where auto-compaction fires, in tokens; undefined when compaction is off. */
	thresholdTokens?: number;
	/** Estimated snapcompact wire savings; set when requested and a snapcompact.* setting is enabled. */
	snapcompact?: ContextSavingsEstimate;
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
 * renders without markers. The host supplies a lead only when its configured
 * method and async policy allow speculative compaction.
 */
export function computeCompactionBoundaries(
	compactionSettings: CompactionSettings,
	contextWindow: number,
	speculationLeadTokens?: number,
): CompactionBoundaries | null {
	if (!(contextWindow > 0)) return null;
	if (!compactionSettings.enabled || compactionSettings.strategy === "off") return null;
	const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
	if (!(thresholdTokens > 0) || thresholdTokens > contextWindow) return null;
	return {
		thresholdPercent: (thresholdTokens / contextWindow) * 100,
		speculationPercent:
			speculationLeadTokens === undefined
				? null
				: (Math.max(0, thresholdTokens - speculationLeadTokens) / contextWindow) * 100,
	};
}

/** Stable inputs used to cache non-message token estimates. */
export interface NonMessageTokenSource {
	readonly systemPrompt?: readonly string[];
	readonly agent?: {
		readonly state?: {
			readonly tools?: readonly ContextTool[];
		};
	};
	readonly skills?: readonly ContextSkill[];
	/** Provider-facing, session-frozen descriptions when available. */
	readonly renderedSkills?: readonly ContextSkill[];
}

/** Shared empty system-prompt part list, avoiding an allocation per render. */
export const EMPTY_STRING_PARTS: string[] = [];
const EMPTY_TOOLS: readonly ContextTool[] = [];
const EMPTY_SKILLS: readonly ContextSkill[] = [];

export interface ContextTokenDetail {
	readonly name: string;
	readonly tokens: number;
}

export interface ContextUsageDetails {
	readonly tools: readonly ContextTokenDetail[];
	readonly skills: readonly ContextTokenDetail[];
}

/**
 * Skills actually rendered into the system prompt, mirroring the filter in
 * `buildSystemPrompt` (`system-prompt.ts`): the `read` tool must be present so
 * the model can fetch skill content, and skills with frontmatter `hide: true`
 * (or `disable-model-invocation`, normalized onto `hide`) are excluded.
 * Accounting must count only these so the Skills category and the System-prompt
 * subtraction stay aligned with the provider-facing prompt.
 */
function renderedSkills(skills: readonly ContextSkill[], tools: readonly ContextTool[]): readonly ContextSkill[] {
	if (!tools.some(tool => tool.name === "read")) return EMPTY_SKILLS;
	return skills.filter(skill => skill.hide !== true);
}

export function estimateSkillsTokens(skills: readonly ContextSkill[], tokenizer: Tokenizer): number {
	const fragments: string[] = [];
	for (const skill of skills) {
		fragments.push(skill.name, skill.description ?? "");
	}
	return tokenizer.countTokens(fragments);
}

function estimateSkillsTokenDetails(skills: readonly ContextSkill[], tokenizer: Tokenizer): ContextTokenDetail[] {
	return skills.map(skill => ({
		name: skill.name,
		// "- name: description\n" wire framing tokenizes ~identically to the
		// concatenated form, so encode each piece separately and sum.
		tokens: tokenizer.countTokens([skill.name, skill.description ?? ""]),
	}));
}

type ToolSchemaSource = readonly ContextTool[];

interface ToolSchemaTokenEstimate {
	revision: number;
	sourceRevision: number;
	tokens: number;
	details?: ContextTokenDetail[];
}

interface ToolSchemaTokenCache {
	revision: number;
	byTokenizer: WeakMap<Tokenizer, ToolSchemaTokenEstimate>;
}

/**
 * Per-roster metadata revisions and token estimates. Tool arrays are
 * caller-owned and may be frozen, so a WeakMap is the only safe place to keep
 * cache state without changing their observable shape.
 */
const TOOL_SCHEMA_TOKEN_CACHE = new WeakMap<ToolSchemaSource, ToolSchemaTokenCache>();

function toolSchemaTokenCache(tools: ToolSchemaSource): ToolSchemaTokenCache {
	let cache = TOOL_SCHEMA_TOKEN_CACHE.get(tools);
	if (!cache) {
		cache = { revision: 0, byTokenizer: new WeakMap() };
		TOOL_SCHEMA_TOKEN_CACHE.set(tools, cache);
	}
	return cache;
}

/**
 * Current dynamic metadata revision for one tool roster.
 *
 * Consumers caching a larger context breakdown must key on both the tools
 * array identity and this revision. Array replacement covers roster changes;
 * {@link invalidateToolSchemaMetadata} covers live description/schema changes
 * while the roster object remains stable.
 */
export function getToolSchemaMetadataRevision(tools: ToolSchemaSource): number {
	return TOOL_SCHEMA_TOKEN_CACHE.get(tools)?.revision ?? 0;
}

/**
 * Invalidate token estimates after a live tool description or parameter schema
 * can change without replacing the tools array (settings, model, policy, or
 * discovered-agent metadata changes).
 */
export function invalidateToolSchemaMetadata(tools: ToolSchemaSource): void {
	toolSchemaTokenCache(tools).revision++;
}

function appendToolSchemaFragments(tool: ContextTool, fragments: string[]): string | undefined {
	// Extension-supplied tools may carry a non-string name/description or a
	// parameters value whose wire schema stringifies to `undefined` (e.g. a
	// callable schema that escaped normalization). A non-string fragment is
	// fatal inside the native tokenizer, so only real strings are counted.
	const name = tool.name;
	const description = tool.description;
	const parameters = tool.parameters;
	if (typeof name === "string") fragments.push(name);
	if (typeof description === "string") fragments.push(description);
	try {
		const wireTool: AiTool = {
			name,
			description,
			parameters: parameters as AiTool["parameters"],
			examples: tool.examples,
		};
		const wireJson = JSON.stringify(toolWireSchema(wireTool) ?? {});
		if (typeof wireJson === "string") fragments.push(wireJson);
		// The agent loop appends rendered examples to the wire description.
		const examplesBlock = renderToolExamples(wireTool);
		if (examplesBlock) fragments.push(examplesBlock);
	} catch {
		// Schema may contain functions or cycles; ignore.
	}
	return typeof name === "string" ? name : undefined;
}

/**
 * Estimate provider-visible tool-schema tokens.
 *
 * Results are cached by roster-array identity, tokenizer identity, the
 * caller-supplied settings/source revision, and the roster's explicit dynamic
 * metadata revision. Callers whose descriptions or schemas are live getters
 * must either advance `sourceRevision` or call
 * {@link invalidateToolSchemaMetadata} when those inputs change.
 */
function estimateToolSchemas(
	tools: ToolSchemaSource,
	tokenizer: Tokenizer,
	sourceRevision: number,
): ToolSchemaTokenEstimate {
	const cache = toolSchemaTokenCache(tools);
	const cached = cache.byTokenizer.get(tokenizer);
	if (cached?.revision === cache.revision && cached.sourceRevision === sourceRevision) return cached;

	const fragments: string[] = [];
	for (const tool of tools) appendToolSchemaFragments(tool, fragments);
	const tokens = tokenizer.countTokens(fragments);
	const estimate = { revision: cache.revision, sourceRevision, tokens };
	cache.byTokenizer.set(tokenizer, estimate);
	return estimate;
}

function estimateToolSchemaTokenDetails(
	tools: ToolSchemaSource,
	tokenizer: Tokenizer,
	sourceRevision = 0,
): readonly ContextTokenDetail[] {
	const estimate = estimateToolSchemas(tools, tokenizer, sourceRevision);
	if (estimate.details) return estimate.details;

	const details: ContextTokenDetail[] = [];
	for (const tool of tools) {
		const fragments: string[] = [];
		const name = appendToolSchemaFragments(tool, fragments);
		details.push({ name: name ?? "(unnamed)", tokens: tokenizer.countTokens(fragments) });
	}
	estimate.details = details;
	return details;
}

export function estimateToolSchemaTokens(tools: ToolSchemaSource, tokenizer: Tokenizer, sourceRevision = 0): number {
	return estimateToolSchemas(tools, tokenizer, sourceRevision).tokens;
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
	toolsRef: ToolSchemaSource;
	toolsRevision: number;
	sourceRevision: number;
	skillful: boolean;
	skillsRef: readonly ContextSkill[];
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

function nonMessageTokenCacheEntry(
	session: NonMessageTokenSource,
	tokenizer: Tokenizer,
	sourceRevision: number,
): NonMessageTokenCache {
	const cachedSession: CachedNonMessageTokenSource = session;
	const systemPromptRef = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const toolsRef = session.agent?.state?.tools ?? EMPTY_TOOLS;
	const toolsRevision = getToolSchemaMetadataRevision(toolsRef);
	const skillsRef = session.renderedSkills ?? session.skills ?? EMPTY_SKILLS;
	let entry = cachedSession[NON_MESSAGE_TOKEN_CACHE];
	if (
		entry &&
		entry.systemPromptRef === systemPromptRef &&
		entry.toolsRef === toolsRef &&
		entry.toolsRevision === toolsRevision &&
		entry.sourceRevision === sourceRevision &&
		entry.skillsRef === skillsRef &&
		entry.tokenizerRef === tokenizer
	) {
		return entry;
	}
	entry = {
		systemPromptRef,
		toolsRef,
		toolsRevision,
		sourceRevision,
		skillful: true,
		skillsRef,
		tokenizerRef: tokenizer,
		tokens: undefined,
		breakdown: undefined,
	};
	cachedSession[NON_MESSAGE_TOKEN_CACHE] = entry;
	return entry;
}

export function computeNonMessageTokens(
	session: NonMessageTokenSource,
	tokenizer: Tokenizer,
	sourceRevision = 0,
): number {
	const entry = nonMessageTokenCacheEntry(session, tokenizer, sourceRevision);
	if (entry.tokens !== undefined) return entry.tokens;
	const systemPromptParts = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const tools = session.agent?.state?.tools ?? EMPTY_TOOLS;
	const tokens =
		tokenizer.countTokens(Array.from(systemPromptParts, part => part ?? "")) +
		estimateToolSchemaTokens(tools, tokenizer, sourceRevision);
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
	sourceRevision = 0,
	skillful = true,
): {
	skillsTokens: number;
	toolsTokens: number;
	systemContextTokens: number;
	systemPromptTokens: number;
} {
	const entry = nonMessageTokenCacheEntry(session, tokenizer, sourceRevision);
	if (entry.breakdown && entry.skillful === skillful) return entry.breakdown;
	const tools = session.agent?.state?.tools ?? EMPTY_TOOLS;
	const skillsTokens =
		skillful === false
			? 0
			: estimateSkillsTokens(
					renderedSkills(session.renderedSkills ?? session.skills ?? EMPTY_SKILLS, tools),
					tokenizer,
				);
	const toolsTokens = estimateToolSchemaTokens(tools, tokenizer, sourceRevision);
	const systemPromptParts = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const systemContextTokens = tokenizer.countTokens(Array.from(systemPromptParts.slice(1), part => part ?? ""));
	const systemPromptTokens = Math.max(0, tokenizer.countTokens(systemPromptParts[0] ?? "") - skillsTokens);
	const breakdown = { skillsTokens, toolsTokens, systemContextTokens, systemPromptTokens };
	entry.skillful = skillful;
	entry.breakdown = breakdown;
	return breakdown;
}

/** Per-tool and per-skill estimates shown by `/context all`. */
export function computeContextUsageDetails(
	session: ContextUsageSession,
	options: Pick<ContextUsageOptions, "sourceRevision" | "skillful"> = {},
): ContextUsageDetails {
	const tokenizer = session.agent.tokenizer;
	const tools = session.agent.state?.tools ?? EMPTY_TOOLS;
	const skills =
		options.skillful === false
			? EMPTY_SKILLS
			: renderedSkills(session.renderedSkills ?? session.skills ?? EMPTY_SKILLS, tools);
	const byLargest = (left: ContextTokenDetail, right: ContextTokenDetail): number =>
		right.tokens - left.tokens || left.name.localeCompare(right.name);
	return {
		tools: estimateToolSchemaTokenDetails(tools, tokenizer, options.sourceRevision)
			.map(detail => ({ ...detail }))
			.sort(byLargest),
		skills: estimateSkillsTokenDetails(skills, tokenizer).sort(byLargest),
	};
}

/**
 * Compute a breakdown of estimated context usage by category for the active
 * session and model.
 */
export function computeContextBreakdown(session: ContextUsageSession, options: ContextUsageOptions): ContextBreakdown {
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
		const nonMessage = computeNonMessageBreakdown(session, tokenizer, options.sourceRevision, options.skillful);
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
	let thresholdTokens: number | undefined;
	if (contextWindow > 0) {
		const compactionSettings = options.compaction;
		if (compactionSettings.enabled && compactionSettings.strategy !== "off") {
			const threshold = resolveThresholdTokens(contextWindow, compactionSettings);
			if (threshold > 0 && threshold <= contextWindow) thresholdTokens = threshold;
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

	return {
		model,
		contextWindow,
		categories,
		usedTokens,
		autoCompactBufferTokens,
		freeTokens,
		thresholdTokens,
		snapcompact: options.snapcompact,
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

/** One styled run of a legend line: bold (`strong`), a theme color, or plain. */
interface LegendPart {
	t: string;
	s?: ThemeColor | "strong";
}

/** Legend lines as styled runs, shared by the ANSI panel and the native description. */
function buildLegendParts(breakdown: ContextBreakdown): LegendPart[][] {
	const lines: LegendPart[][] = [];
	const { model, contextWindow, categories, usedTokens, autoCompactBufferTokens, freeTokens } = breakdown;

	const modelName = model?.name ?? model?.id ?? "no model";
	const modelId = model?.id ?? "unknown";
	const windowLabel = formatNumber(contextWindow).toLowerCase();

	lines.push([
		{ t: `${modelName}`, s: "strong" },
		{ t: ` (${windowLabel} context)`, s: "dim" },
	]);
	lines.push([{ t: `${modelId}[${windowLabel}]`, s: "muted" }]);
	lines.push([
		{ t: formatNumber(usedTokens), s: "strong" },
		{ t: `/${windowLabel} tokens`, s: "dim" },
		{ t: ` (${percentString(usedTokens, contextWindow)})`, s: "muted" },
	]);
	lines.push([]);
	lines.push([{ t: "Estimated usage by category", s: "muted" }]);

	for (const category of categories) {
		const pct = percentString(category.tokens, contextWindow);
		lines.push([
			{ t: category.glyph, s: category.color },
			{ t: ` ${category.label}: ` },
			{ t: formatNumber(category.tokens), s: "strong" },
			{ t: " " },
			{ t: `tokens (${pct})`, s: "dim" },
		]);
	}

	lines.push([
		{ t: CELL_FREE, s: "dim" },
		{ t: " Free space: " },
		{ t: formatNumber(freeTokens), s: "strong" },
		{ t: " " },
		{ t: `(${percentString(freeTokens, contextWindow)})`, s: "dim" },
	]);

	if (autoCompactBufferTokens > 0) {
		lines.push([
			{ t: CELL_BUFFER, s: "warning" },
			{ t: " Autocompact buffer: " },
			{ t: formatNumber(autoCompactBufferTokens), s: "strong" },
			{ t: " " },
			{ t: `tokens (${percentString(autoCompactBufferTokens, contextWindow)})`, s: "dim" },
		]);
	}

	const snap = buildSnapcompactParts(breakdown);
	if (snap.length > 0) lines.push([], ...snap);
	return lines;
}

/** Snapcompact savings lines of the legend; empty when no snapcompact setting is on. */
function buildSnapcompactParts(breakdown: ContextBreakdown): LegendPart[][] {
	const lines: LegendPart[][] = [];
	const { usedTokens } = breakdown;
	const snap = breakdown.snapcompact;
	if (snap) {
		if (!snap.visionCapable) {
			lines.push([{ t: "Snapcompact: inactive (model has no image input)", s: "muted" }]);
		} else {
			lines.push([{ t: "Snapcompact (estimated wire savings)", s: "muted" }]);
			if (snap.systemPrompt) {
				const sp = snap.systemPrompt;
				const scope = sp.scope === "agents-md" ? "AGENTS.md" : "all";
				if (sp.applied) {
					lines.push([
						{ t: `  System prompt (${scope}): saves ` },
						{ t: `~${formatNumber(sp.savedTokens)}`, s: "strong" },
						{ t: " " },
						{
							t: `(${formatNumber(sp.textTokens)} text → ${sp.frames} frame${sp.frames === 1 ? "" : "s"} ≈ ${formatNumber(sp.imageTokens)})`,
							s: "dim",
						},
					]);
				} else {
					const reason =
						sp.reason === "budget"
							? "image budget exhausted"
							: sp.reason === "empty"
								? "nothing to image"
								: "frames would not save tokens";
					lines.push([{ t: `  System prompt (${scope}): ` }, { t: `stays text (${reason})`, s: "dim" }]);
				}
			}
			if (snap.toolResults) {
				const tr = snap.toolResults;
				if (tr.swapped > 0) {
					lines.push([
						{ t: "  Tool results: saves " },
						{ t: `~${formatNumber(tr.savedTokens)}`, s: "strong" },
						{ t: " " },
						{
							t: `(${tr.swapped}/${tr.total} imaged, ${formatNumber(tr.textTokens)} text → ${tr.frames} frames ≈ ${formatNumber(tr.imageTokens)})`,
							s: "dim",
						},
					]);
				} else {
					lines.push([{ t: "  Tool results: " }, { t: `none imaged (${tr.total} in history)`, s: "dim" }]);
				}
			}
			if (snap.savedTokens > 0) {
				lines.push([
					{ t: "  Next request: " },
					{ t: `~${formatNumber(Math.max(0, usedTokens - snap.savedTokens))}`, s: "strong" },
					{ t: " " },
					{ t: "tokens on the wire", s: "dim" },
				]);
			}
		}
	}

	return lines;
}

function buildLegendLines(breakdown: ContextBreakdown, theme: Theme): string[] {
	return buildLegendParts(breakdown).map(line => {
		let out = "";
		for (const part of line) {
			out += part.s === "strong" ? theme.bold(part.t) : part.s ? theme.fg(part.s, part.t) : part.t;
		}
		return out;
	});
}

function buildContextDetailParts(details: ContextUsageDetails): LegendPart[][] {
	const lines: LegendPart[][] = [];
	const append = (label: string, entries: readonly ContextTokenDetail[]): void => {
		lines.push([], [{ t: label, s: "muted" }]);
		if (entries.length === 0) {
			lines.push([{ t: "└ None", s: "dim" }]);
			return;
		}
		for (let index = 0; index < entries.length; index++) {
			const detail = entries[index];
			lines.push([
				{ t: `${index === entries.length - 1 ? "└" : "├"} ${detail.name}: ` },
				{ t: String(detail.tokens), s: "strong" },
				{ t: " tokens", s: "dim" },
			]);
		}
	};
	append("System tools", details.tools);
	append("Skills", details.skills);
	return lines;
}

function renderContextDetails(details: ContextUsageDetails, theme: Theme): string[] {
	return buildContextDetailParts(details).map(line =>
		line
			.map(part => (part.s === "strong" ? theme.bold(part.t) : part.s ? theme.fg(part.s, part.t) : part.t))
			.join(""),
	);
}

function describeContextDetails(details: ContextUsageDetails): NativeNode {
	return node(
		"section",
		{ role: "omp.context.details" },
		buildContextDetailParts(details).map((line, index) =>
			node("text", { spans: line.length > 0 ? line : [{ t: " " }], wrap: "word" }, undefined, `detail-${index}`),
		),
		"details",
	);
}

/** Stacked meter parts in grid order: the categories, free space as the empty track, then the hatched buffer. */
function contextMeterParts(
	breakdown: ContextBreakdown,
): { value: number; token?: string; label?: string; hatch?: boolean }[] {
	const window = breakdown.contextWindow;
	const parts: { value: number; token?: string; label?: string; hatch?: boolean }[] = breakdown.categories
		.filter(category => category.tokens > 0)
		.map(category => ({
			value: category.tokens / window,
			token: category.color,
			label: `${category.label} · ${formatNumber(category.tokens)} tokens (${percentString(category.tokens, window)})`,
		}));
	parts.push({
		value: breakdown.freeTokens / window,
		token: "track",
		label: `Free space · ${formatNumber(breakdown.freeTokens)} tokens (${percentString(breakdown.freeTokens, window)})`,
	});
	if (breakdown.autoCompactBufferTokens > 0) {
		parts.push({
			value: breakdown.autoCompactBufferTokens / window,
			token: "warning",
			hatch: true,
			label: `Autocompact buffer · ${formatNumber(breakdown.autoCompactBufferTokens)} tokens (${percentString(breakdown.autoCompactBufferTokens, window)})`,
		});
	}
	return parts;
}

/**
 * The `/context` frame for terminals that draw `meter`: a blocks meter
 * beside a legend `kv` (swatch · label → tokens · %), then a full-width bar
 * of the same parts marked where auto-compaction fires, then the snapcompact
 * estimate when one is on. The head names the model and window once.
 */
function describeContextFrame(breakdown: ContextBreakdown, details?: ContextUsageDetails): NativeNode {
	const { contextWindow: window, usedTokens, freeTokens, autoCompactBufferTokens, thresholdTokens } = breakdown;
	const parts = contextMeterParts(breakdown);
	const used = Math.min(1, usedTokens / window);
	const swatch = (token: string, glyph = "■"): TspSpan => span(glyph, token);
	const figure = (tokens: number): TspText => [
		span(formatNumber(tokens)),
		span(`  ${percentString(tokens, window)}`, "dim"),
	];
	const items: { k: TspText; v: TspText }[] = [
		{
			k: [span("Used", "strong")],
			v: [
				span(`${formatNumber(usedTokens)} / ${formatNumber(window).toLowerCase()}`),
				span(`  ${percentString(usedTokens, window)}`, "dim"),
			],
		},
	];
	for (const category of breakdown.categories) {
		items.push({ k: [swatch(category.color), span(` ${category.label}`)], v: figure(category.tokens) });
	}
	items.push({ k: [swatch("dim", "□"), span(" Free space")], v: figure(freeTokens) });
	if (autoCompactBufferTokens > 0) {
		items.push({ k: [swatch("warning", "▨"), span(" Autocompact buffer")], v: figure(autoCompactBufferTokens) });
	}
	const marks =
		thresholdTokens !== undefined
			? [
					{
						at: thresholdTokens / window,
						tone: "warning" as const,
						title: `Auto-compaction at ${percentString(thresholdTokens, window, 0)} (${formatNumber(thresholdTokens)} tokens)`,
					},
				]
			: undefined;
	const children = [
		node(
			"row",
			{ role: "omp.context.body" },
			[
				node("meter", { value: used, style: "blocks", size: "lg", parts, aria: "Context usage by category" }),
				node("kv", { items, layout: "grid", role: "omp.context.legend" }),
			],
			"body",
		),
		node(
			"meter",
			{ value: used, style: "bar", size: "lg", parts, ...(marks ? { marks } : {}), grow: 1 },
			undefined,
			"bar",
		),
	];
	const snap = buildSnapcompactParts(breakdown);
	if (snap.length > 0) {
		children.push(
			node(
				"section",
				{},
				snap.map((line, index) => node("text", { spans: line, wrap: "word" }, undefined, `snap-${index}`)),
				"snapcompact",
			),
		);
	}
	if (details) children.push(describeContextDetails(details));
	const modelName = breakdown.model?.name ?? breakdown.model?.id ?? "no model";
	return card(
		{
			role: "omp.context",
			head: [
				span("Context", "strong"),
				span(` · ${modelName}`, "muted"),
				span(` · ${formatNumber(window).toLowerCase()}`, "dim"),
			],
		},
		children,
	);
}

/**
 * Native context-usage panel for terminals without `meter`: the cell grid as
 * unwrapped styled rows beside the legend. The terminal places the legend
 * beside the grid, or below it when narrow.
 */
export function describeContextUsage(breakdown: ContextBreakdown): NativeNode {
	if (breakdown.contextWindow <= 0) {
		return text([{ t: "Context usage is unavailable: no model is selected for this session.", s: "muted" }]);
	}
	const cells = planCells(breakdown);
	const grid: NativeNode[] = [];
	for (let gridRow = 0; gridRow < GRID_ROWS; gridRow++) {
		const spans: TspSpan[] = [];
		for (let gridCol = 0; gridCol < GRID_COLS; gridCol++) {
			const cell = cells[gridRow * GRID_COLS + gridCol]!;
			spans.push({ t: gridCol === 0 ? cell.glyph : ` ${cell.glyph}`, s: cell.color });
		}
		grid.push(node("text", { spans, wrap: "none" }, undefined, `row-${gridRow}`));
	}
	const legend = buildLegendParts(breakdown).map((line, index) =>
		node("text", { spans: line.length > 0 ? line : [{ t: " " }] }, undefined, `legend-${index}`),
	);
	return row([col(grid), col(legend)], {
		gap: "lg",
		wrap: true,
		role: "omp.context.usage",
	});
}

/**
 * The `/context` transcript block: ANSI renders the titled cell grid between
 * rules; natively it is one frame, drawn with `meter`s where the terminal
 * has them and as the glyph grid otherwise.
 */
export class ContextUsageView extends Container {
	readonly #breakdown: ContextBreakdown;
	readonly #details?: ContextUsageDetails;
	#native: { meter: boolean; node: NativeNode } | undefined;

	constructor(breakdown: ContextBreakdown, theme: Theme, details?: ContextUsageDetails) {
		super();
		this.#breakdown = breakdown;
		this.#details = details;
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "Context Usage")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(renderContextUsage(breakdown, theme, details), 1, 0));
		this.addChild(new DynamicBorder());
	}

	override describe(cx: DescribeContext): NativeNode {
		const meter = cx.supports("meter");
		if (this.#native?.meter === meter) return this.#native.node;
		const breakdown = this.#breakdown;
		const described =
			breakdown.contextWindow <= 0
				? describeContextUsage(breakdown)
				: meter
					? describeContextFrame(breakdown, this.#details)
					: card({ role: "omp.context", head: [span("Context usage", "strong")] }, [
							describeContextUsage(breakdown),
							...(this.#details ? [describeContextDetails(this.#details)] : []),
						]);
		this.#native = { meter, node: described };
		return described;
	}
}

/**
 * Render a colorful context-usage panel as ANSI text. Output is a series of
 * lines pairing the grid (left) with the legend (right).
 */
export function renderContextUsage(breakdown: ContextBreakdown, theme: Theme, details?: ContextUsageDetails): string {
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

	if (details) lines.push(...renderContextDetails(details, theme));
	return lines.join("\n");
}
