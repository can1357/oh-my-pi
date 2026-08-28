/**
 * Lane Selection & Eligibility Filtering
 *
 * Deterministic storage-lane selection from task type, requested tiers, and
 * code context, plus the eligibility and deduplication rules the broker applies
 * before ranking.
 *
 * Everything here is pure and synchronous so that lane choice can be asserted
 * directly, without standing up adapters.
 */

import type {
	ContextTier,
	ExpansionSignals,
	ExtractedEntities,
	MemoryLane,
	MemoryScope,
	RetrievedMemoryCandidate,
	TaskCategory,
} from "./tiered-retrieval-types";
import { CONTEXT_TIER_ORDER, LANE_PRIORITY_ORDER } from "./tiered-retrieval-types";

/** The subset of a retrieval request that lane selection depends on. */
export interface LaneSelectionInput {
	taskType: TaskCategory;
	requestedTiers: ContextTier[];
	files?: string[];
	symbols?: string[];
	preferredLanes?: MemoryLane[];
}

/**
 * Deterministically select which storage lanes to query.
 *
 * Selection is a union of four independent rules -- always-on continuity lanes,
 * requested tiers, task type, and code context -- then sorted into
 * {@link LANE_PRIORITY_ORDER}. The result is stable for a given input.
 */
export function selectMemoryLanes(request: LaneSelectionInput): MemoryLane[] {
	const lanes = new Set<MemoryLane>();

	// Continuity (L0) and durable truth (L1/L2) are always consulted.
	lanes.add("working-state");
	lanes.add("canonical");

	for (const tier of request.requestedTiers) {
		switch (tier) {
			case "L0":
				lanes.add("working-state");
				break;
			case "L1":
			case "L2":
				lanes.add("canonical");
				break;
			case "L3":
				lanes.add("graphify");
				lanes.add("canonical");
				break;
			case "L4":
				lanes.add("memvid");
				lanes.add("mempalace");
				break;
		}
	}

	switch (request.taskType) {
		case "debugging":
		case "recovery":
			lanes.add("memvid");
			lanes.add("mempalace");
			break;
		case "architecture":
		case "repository-wide":
			lanes.add("graphify");
			break;
		default:
			break;
	}

	// Concrete code context implies the symbol graph.
	if (request.files?.length || request.symbols?.length) {
		lanes.add("graphify");
	}

	for (const lane of request.preferredLanes ?? []) {
		lanes.add(lane);
	}

	return [...lanes].sort((a, b) => lanePriority(a) - lanePriority(b));
}

/**
 * Priority index of a lane. Unknown lanes sort last, which is the safe end --
 * a bare `indexOf` would return -1 and float them to the front.
 */
function lanePriority(lane: MemoryLane): number {
	const index = LANE_PRIORITY_ORDER.indexOf(lane);
	return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * Score how well a candidate's scope matches the request scope.
 *
 * Returns 0 for a different project (a hard isolation boundary), otherwise 0.5
 * plus bonuses for matching worktree, branch, task, and agent.
 */
export function calculateScopeScore(candidate: RetrievedMemoryCandidate, requestScope: MemoryScope): number {
	if (candidate.scope.projectId !== requestScope.projectId) {
		return 0;
	}

	let score = 0.5;
	if (candidate.scope.worktreeId && candidate.scope.worktreeId === requestScope.worktreeId) score += 0.15;
	if (candidate.scope.branchId && candidate.scope.branchId === requestScope.branchId) score += 0.15;
	if (candidate.scope.taskId && candidate.scope.taskId === requestScope.taskId) score += 0.1;
	if (candidate.scope.agentId && candidate.scope.agentId === requestScope.agentId) score += 0.1;

	return Math.min(score, 1);
}

/** True when the candidate is in one of the requested tiers. Empty means no filter. */
export function candidateMatchesTier(candidate: RetrievedMemoryCandidate, requestedTiers: ContextTier[]): boolean {
	return requestedTiers.length === 0 || requestedTiers.includes(candidate.tier);
}

export interface EligibilityOptions {
	includeProvisional: boolean;
	includeHistorical: boolean;
	requestedTiers: ContextTier[];
}

/** Decide whether a candidate may be shown at all. */
export function isStatusEligible(candidate: RetrievedMemoryCandidate, options: EligibilityOptions): boolean {
	// Terminal states never surface.
	if (candidate.status === "quarantined" || candidate.status === "tombstoned") {
		return false;
	}

	// Historical states surface only when explicitly requested.
	if ((candidate.status === "superseded" || candidate.status === "archived") && !options.includeHistorical) {
		return false;
	}

	// Model-proposed records surface only when provisional content is allowed.
	if (candidate.verification === "model-proposed" && !options.includeProvisional) {
		return false;
	}

	return candidateMatchesTier(candidate, options.requestedTiers);
}

/**
 * Deduplicate candidates.
 *
 * Two rules apply:
 *   1. Identical content hashes collapse to the first occurrence.
 *   2. A record superseded by something already kept is dropped.
 *
 * Note: an earlier revision of this function also dropped any candidate that
 * shared a *single* `file:`/`test:`/`git:` source reference with an earlier one.
 * That silently discarded genuinely distinct memories about the same file, so
 * it is deliberately not reproduced. Evidence overlap is a similarity signal,
 * not an identity proof, and belongs in the redundancy penalty during
 * selection rather than in a hard filter.
 */
export function deduplicateCandidates(candidates: RetrievedMemoryCandidate[]): RetrievedMemoryCandidate[] {
	const seenHashes = new Set<string>();
	const keptIds = new Set<string>();
	const kept: RetrievedMemoryCandidate[] = [];

	for (const candidate of candidates) {
		if (seenHashes.has(candidate.contentHash)) continue;
		seenHashes.add(candidate.contentHash);
		keptIds.add(candidate.memoryId);
		kept.push(candidate);
	}

	return kept.filter(candidate => !(candidate.supersededBy && keptIds.has(candidate.supersededBy)));
}

/**
 * Infer the context tier of a candidate from its lane, status, and type.
 *
 * Order matters. Procedures and failures are checked *before* the L1 list,
 * because an earlier revision listed `procedure` in both and the L1 match won,
 * making the L2 branch unreachable for every procedure record.
 */
export function inferRecordTier(candidate: RetrievedMemoryCandidate): ContextTier {
	if (candidate.lane === "working-state") return "L0";

	// Historical states are archival detail regardless of type.
	if (candidate.status === "superseded" || candidate.status === "archived") return "L4";
	if (candidate.type === "episode") return "L4";

	if (candidate.type === "evidence" || candidate.lane === "graphify") return "L3";
	if (candidate.type === "procedure" || candidate.type === "failure") return "L2";
	if (["decision", "constraint", "preference", "fact"].includes(candidate.type)) return "L1";

	return "L2";
}

/** Choose which tiers to expand into, given the current turn's signals. */
export function selectExpansionTiers(signals: ExpansionSignals): ContextTier[] {
	const tiers = new Set<ContextTier>();

	// L2: procedures and known failures.
	if (signals.repeatedFailureCount > 0 || signals.missingProcedureCount > 0 || signals.taskComplexity > 0.5) {
		tiers.add("L2");
	}

	// L3: structural reach.
	if (signals.graphImpact >= 0.6 || signals.unfamiliarSymbolCount > 0 || signals.planBreadth >= 0.7) {
		tiers.add("L3");
	}

	// L4: history, needed to resolve contradictions or answer "what did we do".
	if (signals.contradictionCount > 0 || signals.userRequestedHistory) {
		tiers.add("L4");
	}

	// Never expand into nothing.
	if (tiers.size === 0) {
		tiers.add("L1");
	}

	return CONTEXT_TIER_ORDER.filter(tier => tiers.has(tier));
}

const FILE_PATTERN = /[\w\-/]+\.(?:ts|js|py|rs|go|java|cpp|h|json|yaml|yml|toml|md|txt)/g;
const SYMBOL_PATTERN = /\b[a-z]+(?:[A-Z][a-z]+)+[A-Za-z0-9]*\b|\b[A-Z][a-z]+(?:[A-Z][a-z]+)*\b|\b[a-z]+(?:_[a-z]+)+\b/g;
const ERROR_PATTERN = /\b(?:error|exception|failed|fail|timeout|crash)\b/gi;
const TASK_PATTERN = /\b(?:implement|fix|add|remove|update|refactor|test|debug|review)\s+\w+/gi;

/**
 * Heuristic entity extraction from a query string.
 *
 * Deliberately regex-only: this runs on every turn before retrieval and must
 * not block. It over-matches by design -- a spurious symbol costs one extra
 * graph lookup, a missed one costs the whole retrieval.
 */
export function extractEntities(query: string): ExtractedEntities {
	return {
		files: unique(query.match(FILE_PATTERN)),
		symbols: unique(query.match(SYMBOL_PATTERN)),
		errors: unique(query.match(ERROR_PATTERN)).map(match => match.toLowerCase()),
		taskNames: unique(query.match(TASK_PATTERN)).map(match => match.toLowerCase()),
		commands: [],
	};
}

function unique(matches: RegExpMatchArray | null): string[] {
	return matches ? [...new Set(matches)] : [];
}

/**
 * Classify a task prompt into the category that drives budget and lane choice.
 *
 * Order matters: recovery and repository-wide phrasings are tested before the
 * debugging keywords, because "fix all files across the repo" is repository-wide
 * work that merely mentions a fix.
 */
export function classifyTaskCategory(taskPrompt: string): TaskCategory {
	const text = taskPrompt.toLowerCase();

	if (text.length < 30 && !text.includes("fix") && !text.includes("bug") && !text.includes("crash")) {
		return "trivial";
	}
	if (/restore|recover|rollback|checkpoint/.test(text)) return "recovery";
	if (/across repo|all files|global search|full codebase|repository-wide/.test(text)) return "repository-wide";
	if (/architect|design|refactor|migration/.test(text)) return "architecture";
	if (/fix|bug|error|fail|crash/.test(text)) return "debugging";

	return "normal";
}
