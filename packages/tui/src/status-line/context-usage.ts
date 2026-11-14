import type { AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { CompactionSettings } from "@oh-my-pi/pi-agent-core/compaction";
import { effectiveReserveTokens, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Tool as AiTool, Model } from "@oh-my-pi/pi-ai";
import { renderToolExamples } from "@oh-my-pi/pi-ai/dialect";
import { stripSchemaDescriptions, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";

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
				instructionFilesTokens: number;
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
	snapcompact?: ContextSavingsEstimate;
}

type CategoryId = "systemPrompt" | "systemContext" | "systemTools" | "instructionFiles" | "skills" | "messages";

interface CategoryInfo {
	id: CategoryId;
	label: string;
	tokens: number;
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
	readonly model?: Model;
	readonly systemPrompt?: readonly string[];
	readonly agent?: {
		readonly state?: {
			readonly tools?: readonly ContextTool[];
		};
		/**
		 * Whether requests to `model` ship description-stripped tool specs because
		 * the catalog rides in the system prompt (`Agent.prunesToolDescriptions`).
		 */
		prunesToolDescriptions?(model: Model | undefined): boolean;
	};
	/** Context files and skills located in the built prompt; see {@link claimPromptSources}. */
	readonly systemPromptSources?: SystemPromptSources;
}

/** Shared empty system-prompt part list, avoiding an allocation per render. */
export const EMPTY_STRING_PARTS: string[] = [];
const EMPTY_TOOLS: readonly ContextTool[] = [];

/** A context file or skill located in a built system-prompt block. */
export interface SystemPromptSource {
	readonly id: string;
	readonly kind: "instruction-files" | "skills";
	readonly label: string;
	readonly path?: string;
	/** Index of the built block holding this source. */
	readonly block: number;
	/** UTF-16 range of the source in that block. */
	readonly start: number;
	readonly end: number;
}

/** Sources paired with the blocks they were built into; valid only while those blocks are unchanged. */
export interface SystemPromptSources {
	readonly blocks: readonly string[];
	readonly sources: readonly SystemPromptSource[];
}

/** Attribution of built sources in an effective system prompt. */
export interface PromptSourceClaims {
	/** Sources of each block the effective prompt holds unchanged at its built index, in block order. */
	readonly byBlock: ReadonlyMap<number, readonly SystemPromptSource[]>;
	/** Sources left in their block because it changed or moved after the build. */
	readonly left: readonly SystemPromptSource[];
}

/**
 * Attributes each source whose built block the effective prompt still holds unchanged at the same
 * index. The status line and the `/context` viewer both count sources through this, so they agree.
 */
export function claimPromptSources(
	effective: readonly (string | undefined)[],
	metadata: SystemPromptSources | undefined,
): PromptSourceClaims {
	const byBlock = new Map<number, SystemPromptSource[]>();
	const left: SystemPromptSource[] = [];
	if (!metadata) return { byBlock, left };
	for (const source of metadata.sources) {
		if (effective[source.block] !== metadata.blocks[source.block]) {
			left.push(source);
			continue;
		}
		const sources = byBlock.get(source.block) ?? [];
		sources.push(source);
		byBlock.set(source.block, sources);
	}
	for (const sources of byBlock.values()) sources.sort((a, b) => a.start - b.start);
	return { byBlock, left };
}

type ToolSchemaSource = readonly ContextTool[];

interface ToolSchemaTokenCache {
	revision: number;
	byTokenizer: WeakMap<
		Tokenizer,
		{ revision: number; sourceRevision: number; pruneDescriptions: boolean; tokens: number }
	>;
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

/** Provider-visible text of one tool definition, in wire order. */
export interface ToolSchemaFragments {
	/** Name, description, wire schema JSON, then rendered examples; fields that cannot be serialized are omitted. */
	readonly fragments: string[];
	/** `fragments` with the schema JSON indented for reading; present only when a display indent was requested. */
	readonly display?: string[];
	/** Why serialization stopped; the schema or examples after that point are missing from `fragments`. */
	readonly schemaError?: string;
}

/** How {@link toolSchemaFragments} renders one tool definition. */
export interface ToolSchemaFragmentOptions {
	/** Also return `display`: the same fragments with the schema JSON indented by this many spaces. */
	displayIndent?: number;
	/**
	 * Mirror `normalizeTools({ pruneDescriptions: true })`: the wire spec is the
	 * name plus the description-stripped schema, with no description or examples.
	 */
	pruneDescriptions?: boolean;
}

/**
 * Provider-visible text of one tool definition. `displayIndent` additionally
 * returns `display`, the same fragments with the schema JSON indented, from
 * the same schema conversion.
 */
export function toolSchemaFragments(tool: ContextTool, options: ToolSchemaFragmentOptions = {}): ToolSchemaFragments {
	const { displayIndent, pruneDescriptions = false } = options;
	// Extension-supplied tools may carry a non-string name/description or a
	// parameters value whose wire schema stringifies to `undefined` (e.g. a
	// callable schema that escaped normalization). A non-string fragment is
	// fatal inside the native tokenizer, so only real strings are kept.
	const { name, description, parameters } = tool;
	const fragments: string[] = [];
	const display: string[] | undefined = displayIndent === undefined ? undefined : [];
	const push = (wire: string, shown: string = wire): void => {
		fragments.push(wire);
		display?.push(shown);
	};
	if (typeof name === "string") push(name);
	if (!pruneDescriptions && typeof description === "string") push(description);
	try {
		const wireTool: AiTool = {
			name,
			description,
			parameters: parameters as AiTool["parameters"],
			examples: tool.examples,
		};
		const fullSchema = toolWireSchema(wireTool) ?? {};
		const wireSchema = pruneDescriptions ? stripSchemaDescriptions(fullSchema) : fullSchema;
		const wireJson = JSON.stringify(wireSchema);
		if (typeof wireJson === "string")
			push(wireJson, display ? JSON.stringify(wireSchema, null, displayIndent) : wireJson);
		// The agent loop appends rendered examples to the wire description,
		// which pruning empties.
		const examplesBlock = pruneDescriptions ? undefined : renderToolExamples(wireTool);
		if (examplesBlock) push(examplesBlock);
	} catch (error) {
		// Schema may contain functions or cycles.
		return { fragments, display, schemaError: error instanceof Error ? error.message : String(error) };
	}
	return { fragments, display };
}

/** Inputs that select which tool-schema estimate applies, beyond the roster and tokenizer. */
export interface ToolSchemaEstimateOptions {
	/** Caller settings/source revision; a change invalidates the cached estimate. */
	sourceRevision?: number;
	/** Count the description-stripped specs sent when the catalog rides in the system prompt. */
	pruneDescriptions?: boolean;
}

/**
 * Estimate provider-visible tool-schema tokens.
 *
 * Results are cached by roster-array identity, tokenizer identity, the
 * caller-supplied settings/source revision, the prune mode, and the roster's
 * explicit dynamic metadata revision. Callers whose descriptions or schemas are
 * live getters must either advance `sourceRevision` or call
 * {@link invalidateToolSchemaMetadata} when those inputs change.
 */
export function estimateToolSchemaTokens(
	tools: ToolSchemaSource,
	tokenizer: Tokenizer,
	options: ToolSchemaEstimateOptions = {},
): number {
	const { sourceRevision = 0, pruneDescriptions = false } = options;
	const cache = toolSchemaTokenCache(tools);
	const cached = cache.byTokenizer.get(tokenizer);
	if (
		cached?.revision === cache.revision &&
		cached.sourceRevision === sourceRevision &&
		cached.pruneDescriptions === pruneDescriptions
	)
		return cached.tokens;

	const fragments = tools.flatMap(tool => toolSchemaFragments(tool, { pruneDescriptions }).fragments);
	const tokens = tokenizer.countTokens(fragments);
	cache.byTokenizer.set(tokenizer, { revision: cache.revision, sourceRevision, pruneDescriptions, tokens });
	return tokens;
}

/** Count schemas carried on every request, excluding server-side deferred catalogs. */
export function estimateContextToolSchemaTokens(
	tools: ToolSchemaSource,
	tokenizer: Tokenizer,
	model: Model | undefined,
	options: ToolSchemaEstimateOptions = {},
): number {
	return model?.toolSchemasInContext === false ? 0 : estimateToolSchemaTokens(tools, tokenizer, options);
}

/**
 * Compute just the NON-MESSAGE token total: system prompt (with its skills
 * section subtracted, since skills are tokenized separately) + system context
 * (the rest of the system-prompt array) + tools + skills.
 *
 * Exposed so callers like `StatusLineComponent` can cache the non-message
 * total separately from the growing message total. A model switch can change
 * which tool schemas occupy context without changing the roster; a prune-mode
 * change (`Agent.prunesToolDescriptions`) changes how much of each spec ships.
 */
// The per-turn threshold and compaction paths call these helpers repeatedly.
// Cache by prompt, prompt sources, roster, tokenizer, revision, model schema policy,
// and prune mode; setSystemPrompt/setTools replace their arrays rather than mutating them.
interface NonMessageTokenCache {
	systemPromptRef: readonly string[];
	promptSourcesRef: SystemPromptSources | undefined;
	toolsRef: ToolSchemaSource;
	toolSchemasInContext: boolean;
	pruneToolDescriptions: boolean;
	toolsRevision: number;
	sourceRevision: number;
	// The Agent swaps its Tokenizer instance when the model's encoding changes,
	// so instance identity doubles as the encoding key.
	tokenizerRef: Tokenizer;
	tokens: number | undefined;
	breakdown: NonMessageBreakdown | undefined;
}

/** Non-message token totals, with instruction files and skills counted through {@link claimPromptSources}. */
export interface NonMessageBreakdown {
	skillsTokens: number;
	instructionFilesTokens: number;
	toolsTokens: number;
	/** Blocks after the first, without attributed sources. */
	systemContextTokens: number;
	/** The first block, without attributed sources. */
	systemPromptTokens: number;
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
	const toolSchemasInContext = session.model?.toolSchemasInContext !== false;
	const pruneToolDescriptions = session.agent?.prunesToolDescriptions?.(session.model) === true;
	const toolsRevision = getToolSchemaMetadataRevision(toolsRef);
	const promptSourcesRef = session.systemPromptSources;
	let entry = cachedSession[NON_MESSAGE_TOKEN_CACHE];
	if (
		entry &&
		entry.systemPromptRef === systemPromptRef &&
		entry.toolsRef === toolsRef &&
		entry.toolSchemasInContext === toolSchemasInContext &&
		entry.pruneToolDescriptions === pruneToolDescriptions &&
		entry.toolsRevision === toolsRevision &&
		entry.sourceRevision === sourceRevision &&
		entry.promptSourcesRef === promptSourcesRef &&
		entry.tokenizerRef === tokenizer
	) {
		return entry;
	}
	entry = {
		systemPromptRef,
		promptSourcesRef,
		toolsRef,
		toolSchemasInContext,
		pruneToolDescriptions,
		toolsRevision,
		sourceRevision,
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
		estimateContextToolSchemaTokens(tools, tokenizer, session.model, {
			sourceRevision,
			pruneDescriptions: entry.pruneToolDescriptions,
		});
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
): NonMessageBreakdown {
	const entry = nonMessageTokenCacheEntry(session, tokenizer, sourceRevision);
	if (entry.breakdown) return entry.breakdown;
	const tools = session.agent?.state?.tools ?? EMPTY_TOOLS;
	const toolsTokens = estimateContextToolSchemaTokens(tools, tokenizer, session.model, {
		sourceRevision,
		pruneDescriptions: entry.pruneToolDescriptions,
	});
	const systemPromptParts = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const { byBlock } = claimPromptSources(systemPromptParts, session.systemPromptSources);
	let skillsTokens = 0;
	let instructionFilesTokens = 0;
	let systemContextTokens = 0;
	let systemPromptTokens = 0;
	for (const [index, part] of systemPromptParts.entries()) {
		const block = part ?? "";
		let remaining = "";
		let cursor = 0;
		for (const source of byBlock.get(index) ?? []) {
			remaining += block.slice(cursor, source.start);
			const tokens = tokenizer.countTokens(block.slice(source.start, source.end));
			if (source.kind === "skills") skillsTokens += tokens;
			else instructionFilesTokens += tokens;
			cursor = source.end;
		}
		const tokens = tokenizer.countTokens(cursor === 0 ? block : remaining + block.slice(cursor));
		if (index === 0) systemPromptTokens = tokens;
		else systemContextTokens += tokens;
	}
	const breakdown = { skillsTokens, instructionFilesTokens, toolsTokens, systemContextTokens, systemPromptTokens };
	entry.breakdown = breakdown;
	return breakdown;
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
	let instructionFilesTokens = 0;
	let toolsTokens = 0;
	let systemContextTokens = 0;
	let systemPromptTokens = 0;
	let usedTokens = 0;

	if (breakdown) {
		messagesTokens = breakdown.messagesTokens;
		skillsTokens = breakdown.skillsTokens;
		instructionFilesTokens = breakdown.instructionFilesTokens;
		toolsTokens = breakdown.systemToolsTokens;
		systemContextTokens = breakdown.systemContextTokens;
		systemPromptTokens = breakdown.systemPromptTokens;
		usedTokens = breakdown.usedTokens;
	} else {
		// Category split needs a messages-only number, so this walk stays local:
		// an anchored total folds the system prompt and tool schemas into it.
		messagesTokens = tokenizer.countMessages(session.messages ?? []);
		const nonMessage = computeNonMessageBreakdown(session, tokenizer, options.sourceRevision);
		skillsTokens = nonMessage.skillsTokens;
		instructionFilesTokens = nonMessage.instructionFilesTokens;
		toolsTokens = nonMessage.toolsTokens;
		systemContextTokens = nonMessage.systemContextTokens;
		systemPromptTokens = nonMessage.systemPromptTokens;
		usedTokens =
			skillsTokens +
			instructionFilesTokens +
			toolsTokens +
			systemContextTokens +
			systemPromptTokens +
			messagesTokens;
	}

	const categories: CategoryInfo[] = [
		{ id: "systemPrompt", label: "System prompt", tokens: systemPromptTokens },
		{ id: "systemTools", label: "System tools", tokens: toolsTokens },
		{ id: "systemContext", label: "System context", tokens: systemContextTokens },
		{ id: "instructionFiles", label: "Instruction files", tokens: instructionFilesTokens },
		{ id: "skills", label: "Skills", tokens: skillsTokens },
		{ id: "messages", label: "Messages", tokens: messagesTokens },
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
