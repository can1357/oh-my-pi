/**
 * Mental-model bootstrap, caching, and rendering for the Hindsight backend.
 *
 * Mental models are persisted, named summaries on the Hindsight server. They
 * are populated by a background reflect at create time and refreshed
 * automatically by their trigger (`refresh_after_consolidation` and/or
 * `refresh_cron`). A failed refresh pauses both automatic triggers until a
 * manual refresh succeeds, so {@link mentalModelRefreshState} surfaces that
 * instead of letting preserved content read as current.
 *
 * This module:
 *   1. **Seeds** a small, curated set of mental models on first session boot
 *      for a given bank (idempotent: never modifies an existing model).
 *   2. **Loads** the seeded + any operator-curated models into a cached
 *      `<mental_models>` block that the backend splices into developer
 *      instructions on every prompt rebuild — bypassing per-turn recall HTTP
 *      cost for stable knowledge.
 *   3. **Renders** content inside `<mental_models>` wrappers; the Hindsight
 *      memory instructions tell the LLM to treat them as background knowledge,
 *      not as commands.
 *
 * Tag discipline (foot-gun):
 * The Hindsight refresh path filters source memories with `all_strict` tag
 * matching against the model's tags. A seed tagged with something we never
 * write at retain time will refresh empty. Therefore seed tags MUST be a
 * subset of the tags actually attached by `retainSession` / `enqueueRetain`
 * for the active scoping mode. In `per-project-tagged` we only carry
 * `project:<cwd>`; do not invent new tag axes here without first wiring the
 * retain side to emit them.
 *
 * Seed tags are baked from `seeds.json` plus, for `projectTagged: true`
 * entries, the active scope's `retainTags` (i.e. `project:<cwd>`). In
 * `per-project-tagged`, those project seeds also get project-suffixed ids so
 * each tag can own its conventions/decisions models in the shared bank.
 * Untagged seeds (e.g. `user-preferences`) read every memory in the bank — the
 * reflect call applies no tag filter when `tags` is empty.
 *
 * Seed lifecycle is **create-only**: changes to `source_query`, `tags`,
 * `max_tokens`, or `trigger` in `seeds.json` will NOT propagate to existing
 * models on the server. Operators who want a structural change must
 * `/memory mm refresh <id>` (content-only) or `/memory mm delete <id>`
 * followed by a re-seed.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { Semaphore } from "../task/parallel";
import type { BankScope } from "./bank";
import type {
	HindsightClientApi,
	MentalModelListResponse,
	MentalModelSummary,
	MentalModelTrigger,
	WaitForOperationOptions,
} from "./client";
import type { HindsightScoping } from "./config";
import seedsData from "./seeds.json" with { type: "json" };

interface RawSeed {
	id: string;
	name: string;
	source_query: string;
	scopes: HindsightScoping[];
	projectTagged: boolean;
	trigger?: MentalModelTrigger;
	max_tokens?: number;
	extra_tags?: string[];
}

interface SeedsFile {
	seeds: RawSeed[];
}

const BUILTIN_SEEDS: RawSeed[] = (seedsData as SeedsFile).seeds;

export interface MentalModelSeed {
	id: string;
	name: string;
	sourceQuery: string;
	tags: string[];
	maxTokens?: number;
	/** Legacy unqualified seed ids accepted as already-present when tags match. */
	legacyIds?: string[];
	trigger?: MentalModelTrigger;
}

/**
 * Resolve the seed list that applies to the active bank scope. Per-project
 * seeds are skipped in `global` mode (where there is no project axis) and
 * `projectTagged` seeds inherit the scope's `retainTags`. In shared tagged
 * banks, project seeds use project-suffixed ids and accept matching legacy
 * bare ids as already present.
 */
export function resolveSeedsForScope(scope: BankScope, scoping: HindsightScoping): MentalModelSeed[] {
	const out: MentalModelSeed[] = [];
	for (const seed of BUILTIN_SEEDS) {
		if (!seed.scopes.includes(scoping)) continue;
		const tags = collectSeedTags(seed, scope);
		const id = resolveSeedId(seed, tags, scoping);
		out.push({
			id,
			name: seed.name,
			sourceQuery: seed.source_query,
			tags,
			maxTokens: seed.max_tokens,
			trigger: seed.trigger,
			legacyIds: id === seed.id ? undefined : [seed.id],
		});
	}
	return out;
}

const PROJECT_TAG_PREFIX = "project:";

function resolveSeedId(seed: RawSeed, tags: string[], scoping: HindsightScoping): string {
	if (scoping !== "per-project-tagged" || !seed.projectTagged || tags.length === 0) return seed.id;
	return `${seed.id}-${seedIdSuffixFromProjectTag(tags[0])}`;
}

function seedIdSuffixFromProjectTag(tag: string): string {
	const raw = tag.startsWith(PROJECT_TAG_PREFIX) ? tag.slice(PROJECT_TAG_PREFIX.length) : tag;
	const sanitized = raw
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "project";
}
function collectSeedTags(seed: RawSeed, scope: BankScope): string[] {
	const collected: string[] = [];
	if (seed.projectTagged && scope.retainTags) collected.push(...scope.retainTags);
	if (seed.extra_tags) collected.push(...seed.extra_tags);
	return dedupe(collected);
}

function dedupe<T>(items: T[]): T[] {
	return [...new Set(items)];
}

/**
 * Idempotently create any seed mental models that don't already exist on the
 * bank. Best-effort: a list/create failure does not throw — mental models are
 * an optimization, not a precondition for retain/recall, and we mirror the
 * swallow-on-failure pattern used by `ensureBankExists`.
 *
 * Existing models are NEVER modified. See module docstring.
 */
export async function ensureMentalModels(
	client: HindsightClientApi,
	bankId: string,
	seeds: MentalModelSeed[],
	debug: boolean,
): Promise<void> {
	if (seeds.length === 0) return;

	let existing: MentalModelSummary[];
	try {
		const list = await client.listMentalModels(bankId, { detail: "metadata" });
		existing = list.items ?? [];
	} catch (err) {
		logger.debug("Hindsight: ensureMentalModels list failed", { bankId, error: String(err) });
		return;
	}

	for (const seed of seeds) {
		if (seedAlreadyExists(seed, existing)) continue;
		try {
			await client.createMentalModel(bankId, seed.name, seed.sourceQuery, {
				id: seed.id,
				tags: seed.tags.length > 0 ? seed.tags : undefined,
				maxTokens: seed.maxTokens,
				trigger: seed.trigger,
			});
			if (debug) {
				logger.debug("Hindsight: seeded mental model", { bankId, id: seed.id, tags: seed.tags });
			}
		} catch (err) {
			logger.debug("Hindsight: createMentalModel failed", { bankId, id: seed.id, error: String(err) });
		}
	}
}

/** Return whether a seed is already represented by current bank metadata. */
export function seedAlreadyExists(seed: MentalModelSeed, models: readonly MentalModelSummary[]): boolean {
	for (const model of models) {
		if (model.id === seed.id) return true;
		if (seed.legacyIds?.includes(model.id) && sameStringSet(model.tags ?? [], seed.tags)) return true;
	}
	return false;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every(item => right.includes(item));
}

/**
 * Default character budget for the rendered `<mental_models>` block. Mental
 * models are injected on every prompt rebuild; an unbounded block can crowd
 * out the user's actual context (and we cannot trust a curated/operator
 * model to stay small without enforcement). The budget is a coarse char cap
 * — token-accurate accounting would require a model-specific tokenizer we
 * don't carry here.
 */
export const MENTAL_MODEL_RENDER_BUDGET_CHARS_DEFAULT = 16_000;

/** Outcome of loading a rendered mental-model block with fetch failure kept distinct from empty content. */
export type MentalModelsBlockLoadResult =
	| { ok: true; block: string | undefined; refreshWarning?: string }
	| { ok: false };

/**
 * Pull the current mental-model snapshot while preserving whether the server
 * request failed. Boundary reloads use this distinction to retain a previously
 * rendered snapshot when Hindsight is unavailable.
 */
export async function tryLoadMentalModelsBlock(
	client: HindsightClientApi,
	bankId: string,
	budgetChars: number = MENTAL_MODEL_RENDER_BUDGET_CHARS_DEFAULT,
	visibleTags?: readonly string[],
): Promise<MentalModelsBlockLoadResult> {
	let response: MentalModelListResponse;
	try {
		response = await client.listMentalModels(bankId, { detail: "content" });
	} catch (err) {
		logger.debug("Hindsight: loadMentalModelsBlock list failed", { bankId, error: String(err) });
		return { ok: false };
	}

	const models = (response.items ?? []).filter(
		m => modelVisibleForTags(m, visibleTags) && typeof m.content === "string" && m.content.trim().length > 0,
	);
	if (models.length === 0) return { ok: true, block: undefined };

	models.sort((a, b) => a.name.localeCompare(b.name));
	const block = renderMentalModelsBlock(models, budgetChars);
	return { ok: true, block: block || undefined, refreshWarning: mentalModelRefreshWarning(models) };
}

/**
 * Pull the current mental-model snapshot from the server and render it into a
 * `<mental_models>` block ready to be appended to developer instructions.
 *
 * Returns `undefined` when the server has no models yet, when the API call
 * fails, or when every model still has empty content (e.g. the background
 * reflect for a freshly-seeded model hasn't completed yet).
 *
 * The rendered block is bounded by `budgetChars` (default
 * MENTAL_MODEL_RENDER_BUDGET_CHARS_DEFAULT). When `visibleTags` is supplied,
 * tagged models must match at least one active tag; untagged models remain
 * visible in every scope. Per-model content is truncated before assembly; if
 * assembly still exceeds the budget, trailing models are dropped. A budget
 * overflow leaves a `…` marker so the LLM can tell the snapshot is truncated.
 */
export async function loadMentalModelsBlock(
	client: HindsightClientApi,
	bankId: string,
	budgetChars: number = MENTAL_MODEL_RENDER_BUDGET_CHARS_DEFAULT,
	visibleTags?: readonly string[],
): Promise<string | undefined> {
	const result = await tryLoadMentalModelsBlock(client, bankId, budgetChars, visibleTags);
	return result.ok ? result.block : undefined;
}

function modelVisibleForTags(model: MentalModelSummary, visibleTags?: readonly string[]): boolean {
	if (!visibleTags || visibleTags.length === 0) return true;
	const tags = model.tags ?? [];
	if (tags.length === 0) return true;
	return tags.some(tag => visibleTags.includes(tag));
}

const TRUNCATION_MARKER = "\n\n…[mental-model snapshot truncated at render budget]";
const SECTION_SEPARATOR = "\n\n";

/**
 * Format a sorted list of models into the final `<mental_models>` wrapper,
 * bounded by `budgetChars`. Per-model truncation is divided proportionally
 * across the visible models; an overflow is signalled with a marker so the
 * model can tell context is missing.
 *
 * Exported for unit testing of the budget contract — callers should go
 * through `loadMentalModelsBlock`.
 */
/**
 * Minimum room for actual content beyond the wrapper. Below this, no
 * mental-model block can be meaningfully rendered.
 */
const MIN_CONTENT_ROOM_CHARS = 64;

/** Smallest budget that can yield a usable block (wrapper + marker + a few chars of content). */
function minRenderBudgetChars(): number {
	const cleanOverhead = `<mental_models>\n\n</mental_models>`.length;
	return cleanOverhead + MIN_CONTENT_ROOM_CHARS;
}

function sectionHeader(model: MentalModelSummary): string {
	// Volatile `last_refreshed_at` is deliberately kept OUT of the model-facing
	// heading: a background reflect that only bumps the timestamp would
	// otherwise rewrite the cached prefix on identical content (#11961). The
	// timestamp still surfaces in the user-facing `/memory mm list`/`show`.
	return `# ${model.name}\n`;
}

export function renderMentalModelsBlock(models: MentalModelSummary[], budgetChars: number): string {
	if (models.length === 0) return "";

	// Refuse to render below the minimum: any block we'd emit would either
	// shear the wrapper (breaking `stripMemoryTags`) or carry no real
	// content. The caller treats `""` as "skip injection" and falls through
	// to recall-only context.
	if (budgetChars < minRenderBudgetChars()) return "";

	const truncatedOverhead = `<mental_models>\n${TRUNCATION_MARKER}\n</mental_models>`.length;
	const cleanOverhead = `<mental_models>\n\n</mental_models>`.length;
	const innerBudget = Math.max(0, budgetChars - truncatedOverhead);
	const headerCost = models.reduce((sum, m) => sum + sectionHeader(m).length, 0);
	const separatorCost = SECTION_SEPARATOR.length * Math.max(0, models.length - 1);
	const perModelBudget = Math.max(
		120,
		Math.floor((innerBudget - headerCost - separatorCost) / Math.max(1, models.length)),
	);

	const sections: string[] = [];
	let consumed = 0;
	let truncated = false;
	for (const model of models) {
		const header = sectionHeader(model);
		const body = (model.content ?? "").trim();
		const truncatedBody = truncateTo(body, perModelBudget);
		if (truncatedBody.length < body.length) truncated = true;
		const section = `${header}${truncatedBody}`;
		const sectionCost = section.length + (sections.length > 0 ? SECTION_SEPARATOR.length : 0);
		if (consumed + sectionCost > innerBudget && sections.length > 0) {
			truncated = true;
			break;
		}
		sections.push(section);
		consumed += sectionCost;
	}

	const tail = truncated ? TRUNCATION_MARKER : "";
	let assembled = `<mental_models>\n${sections.join(SECTION_SEPARATOR)}${tail}\n</mental_models>`;

	// Final hard-cap: if the careful per-model budgeting still slips past the
	// requested ceiling (small budgets, long headings, etc.), brutally truncate
	// the body region while keeping the wrapper intact so `stripMemoryTags` can
	// still find the closing tag.
	if (assembled.length > budgetChars) {
		const overhead = truncated ? truncatedOverhead : cleanOverhead;
		const room = Math.max(0, budgetChars - overhead);
		const body = sections.join(SECTION_SEPARATOR).slice(0, room).trimEnd();
		assembled = `<mental_models>\n${body}${TRUNCATION_MARKER}\n</mental_models>`;
	}
	return assembled;
}

function truncateTo(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 1) return "…";
	return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** What the server's refresh metadata says about whether a model's content can be trusted as current. */
export type MentalModelRefreshState = "paused" | "stale" | "unsourced" | "fresh";

/**
 * `paused`: the last refresh failed, so automatic triggers skip the model until a manual refresh succeeds.
 * `stale`: in-scope memories were written after the content was last synthesized.
 * `unsourced`: no refresh has stamped a source-memory watermark, so the content was not synthesized from memories.
 */
export function mentalModelRefreshState(model: MentalModelSummary): MentalModelRefreshState {
	if (model.last_refresh_failed_at) return "paused";
	if (model.is_stale === true) return "stale";
	if (!model.last_memory_seen_at) return "unsourced";
	return "fresh";
}

/** Whether a trigger refreshes the model without operator action. Manual-only models have neither trigger. */
export function isAutoRefreshedMentalModel(model: MentalModelSummary): boolean {
	const trigger = model.trigger;
	return trigger?.refresh_after_consolidation === true || (trigger?.refresh_cron?.trim().length ?? 0) > 0;
}

export function describeMentalModelRefreshState(model: MentalModelSummary): string {
	switch (mentalModelRefreshState(model)) {
		case "paused":
			return `paused: refresh failed ${model.last_refresh_failed_at}, automatic refresh stopped until a manual refresh succeeds`;
		case "stale":
			return "stale: newer memories are not reflected yet";
		case "unsourced":
			return "no source memories seen yet";
		case "fresh":
			return "fresh";
	}
}

/** Inventory line used by the `/memory mm list` command. */
export function summarizeMentalModel(model: MentalModelSummary): string {
	const tags = model.tags && model.tags.length > 0 ? ` [${model.tags.join(", ")}]` : "";
	const refreshed = model.last_refreshed_at ? `refreshed ${model.last_refreshed_at}` : "never refreshed";
	return `- ${model.id}: ${model.name}${tags} (${describeMentalModelRefreshState(model)}; ${refreshed})`;
}

/**
 * Models whose injected content will not recover on its own: paused after a failed refresh, or stale with no
 * trigger to refresh them. Stale models an active trigger will refresh are routine and not reported.
 */
export function mentalModelRefreshWarning(models: readonly MentalModelSummary[]): string | undefined {
	const paused = models.filter(model => mentalModelRefreshState(model) === "paused");
	const stuckStale = models.filter(
		model => mentalModelRefreshState(model) === "stale" && !isAutoRefreshedMentalModel(model),
	);
	if (paused.length === 0 && stuckStale.length === 0) return undefined;
	const parts: string[] = [];
	if (paused.length > 0) parts.push(`refresh failed, automatic refresh paused: ${paused.map(m => m.id).join(", ")}`);
	if (stuckStale.length > 0) parts.push(`stale with no automatic refresh: ${stuckStale.map(m => m.id).join(", ")}`);
	return `Mental-model guidance may be out of date (${parts.join("; ")}). Run /memory mm refresh <id> to recover.`;
}

export interface MentalModelRefreshOutcome {
	id: string;
	/** Present when the refresh could not be queued or did not complete; absent after a completed operation. */
	error?: string;
}

/**
 * Queue a refresh for each id with at most four concurrent refresh/poll tasks and wait for its terminal
 * state, so callers act only after content was rewritten. Failure, cancellation and timeout are reported per id.
 */
export async function refreshMentalModelsAndWait(
	client: HindsightApi,
	bankId: string,
	ids: readonly string[],
	options?: WaitForOperationOptions,
): Promise<MentalModelRefreshOutcome[]> {
	const slots = new Semaphore(4);
	return Promise.all(
		ids.map(async (id): Promise<MentalModelRefreshOutcome> => {
			try {
				await slots.acquire(options?.signal);
				try {
					const { operation_id } = await client.refreshMentalModel(bankId, id, { signal: options?.signal });
					await client.waitForOperation(bankId, operation_id, options);
					return { id };
				} finally {
					slots.release();
				}
			} catch (error) {
				return { id, error: error instanceof Error ? error.message : String(error) };
			}
		}),
	);
}

/**
 * Render a unified-style line diff between the previous and current content
 * of a mental model. Hindsight's history endpoint returns the previous
 * snapshot only; the diff is computed locally for display purposes.
 *
 * This is intentionally minimal — for "what changed" at a glance, not for a
 * full structural diff. Each side is capped at `MAX_LCS_LINES` lines BEFORE
 * the O(n*m) LCS table is built so a long curated model can never hang the
 * TUI; output is then capped at `maxLines` so the rendered diff stays
 * readable. The cap is signalled inline.
 */
/** Hard cap on input line count per side before LCS. Keeps the O(n*m) table tractable. */
export const MAX_LCS_LINES = 1_000;

export function diffMentalModelContent(previous: string | null, current: string, maxLines = 200): string {
	const prevRaw = previous ? previous.split("\n") : [];
	const currRaw = current ? current.split("\n") : [];
	const prevTrimmed = prevRaw.length > MAX_LCS_LINES;
	const currTrimmed = currRaw.length > MAX_LCS_LINES;
	const prev = prevTrimmed ? prevRaw.slice(0, MAX_LCS_LINES) : prevRaw;
	const curr = currTrimmed ? currRaw.slice(0, MAX_LCS_LINES) : currRaw;
	const lcs = longestCommonSubsequence(prev, curr);
	const out: string[] = [];
	let i = 0;
	let j = 0;
	let k = 0;
	while (i < prev.length && j < curr.length && k < lcs.length) {
		if (prev[i] === lcs[k] && curr[j] === lcs[k]) {
			out.push(`  ${prev[i]}`);
			i++;
			j++;
			k++;
			continue;
		}
		if (prev[i] !== lcs[k]) {
			out.push(`- ${prev[i]}`);
			i++;
			continue;
		}
		out.push(`+ ${curr[j]}`);
		j++;
	}
	while (i < prev.length) out.push(`- ${prev[i++]}`);
	while (j < curr.length) out.push(`+ ${curr[j++]}`);

	if (prevTrimmed || currTrimmed) {
		out.push(`… input capped at ${MAX_LCS_LINES} lines per side before diff`);
	}

	if (out.length > maxLines) {
		const dropped = out.length - maxLines;
		return `${out.slice(0, maxLines).join("\n")}\n[…${dropped}ln elided…]`;
	}
	return out.join("\n");
}

function longestCommonSubsequence(a: string[], b: string[]): string[] {
	const n = a.length;
	const m = b.length;
	if (n === 0 || m === 0) return [];
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const table: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < m; j++) {
			table[i + 1][j + 1] = a[i] === b[j] ? table[i][j] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}
	const out: string[] = [];
	let i = n;
	let j = m;
	while (i > 0 && j > 0) {
		if (a[i - 1] === b[j - 1]) {
			out.push(a[i - 1]);
			i--;
			j--;
		} else if (table[i - 1][j] >= table[i][j - 1]) {
			i--;
		} else {
			j--;
		}
	}
	return out.reverse();
}

/** Awaited only by the first-turn race in `beforeAgentStartPrompt`. */
export const MENTAL_MODEL_FIRST_TURN_DEADLINE_MS = 1500;

/** Need-only export of the raw seed list for tests. */
export const builtinSeedsForTest: ReadonlyArray<Readonly<RawSeed>> = BUILTIN_SEEDS;
