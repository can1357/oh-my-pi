/**
 * Bounded computer-use decisions via factorized System One questions.
 *
 * Backend order (Jev is last, optional):
 *   deterministic rules → local semantic rerank → Jev (when armed)
 *
 * Mirrors NousResearch/hermes-agent#113850 and awlevin/typesafe-computer-use.
 */
import type { ChoiceQuestion, Judge, NoulQuestion, Questions } from "@oh-my-pi/pi-ai";

export const COMPUTER_ACTIONS = [
	"click",
	"type",
	"key",
	"scroll",
	"wait",
	"done",
	"escalate",
] as const;

export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

export type ComputerDecisionBackend = "rules" | "rerank" | "jev" | "none";

export interface ComputerCandidate {
	id: string;
	label: string;
	role?: string;
	region?: string;
	source?: "ax" | "ocr" | "ax+ocr";
}

export interface ComputerDecisionState {
	goal: string;
	recent_actions?: readonly string[];
	focused_field?: { label?: string; placeholder?: string; value?: string };
	candidates: readonly ComputerCandidate[];
	app?: string;
	url?: string;
}

export interface ComputerDecision {
	action: ComputerAction;
	target?: string;
	needsVision: boolean;
	needsGeneration: boolean;
	done: boolean;
	confidence: number;
	backend: ComputerDecisionBackend;
	model?: string;
}

/** Replayable packet — no screenshots or secrets by default. */
export interface ComputerDecisionPacket extends ComputerDecision {
	latencyMs: number;
	state: ComputerDecisionState;
	scores?: Record<string, number>;
}


export interface AxLikeElement {
	ref: string;
	role?: string;
	title?: string;
	description?: string;
}

/** Map live AX element handles into decision candidates. */
export function candidatesFromElements(elements: readonly AxLikeElement[]): ComputerCandidate[] {
	return elements.map(element => {
		const label = [element.title, element.description, element.role, element.ref]
			.map(part => (typeof part === "string" ? part.trim() : ""))
			.find(Boolean);
		return {
			id: element.ref,
			label: label ?? element.ref,
			role: element.role,
			source: "ax" as const,
		};
	});
}

export const DEFAULT_MIN_CONFIDENCE = 0.4;
export const JEV_BUDGET_MS = 2500;
const NONE_TARGET = "none";

const ACTION_INSTRUCTIONS =
	"What is the next high-level action for this computer-use step? Pick one mutually exclusive action — do not combine click and type into one choice.";

const TARGET_INSTRUCTIONS =
	"Which currently visible semantic element should this step act on? Pick exactly one candidate, or none when the action does not target a specific element.";

const tokenize = (text: string): string[] =>
	text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(token => token.length > 1);

function overlapScore(goal: string, label: string): number {
	const goalTokens = new Set(tokenize(goal));
	const labelTokens = tokenize(label);
	if (goalTokens.size === 0 || labelTokens.length === 0) return 0;
	let hits = 0;
	for (const token of labelTokens) {
		if (goalTokens.has(token)) hits++;
	}
	return hits / labelTokens.length;
}

function normalizeCandidates(candidates: readonly ComputerCandidate[]): ComputerCandidate[] {
	const seen = new Set<string>();
	const out: ComputerCandidate[] = [];
	for (const candidate of candidates) {
		const id = candidate.id.trim();
		const label = candidate.label.trim();
		if (!id || !label || seen.has(id)) continue;
		seen.add(id);
		out.push({ ...candidate, id, label });
		if (out.length >= 240) break;
	}
	return out;
}

function packet(
	decision: Omit<ComputerDecision, "backend"> & { backend: ComputerDecisionBackend; model?: string },
	state: ComputerDecisionState,
	latencyMs: number,
	scores?: Record<string, number>,
): ComputerDecisionPacket {
	return { ...decision, latencyMs, state, scores };
}

/** Fast deterministic path before any model call. */
export function applyDeterministicRules(
	state: ComputerDecisionState,
	minConfidence = DEFAULT_MIN_CONFIDENCE,
): ComputerDecision | null {
	const goal = state.goal.trim().toLowerCase();
	const candidates = normalizeCandidates(state.candidates);
	const recent = state.recent_actions ?? [];

	if (!goal) {
		return {
			action: "done",
			needsVision: false,
			needsGeneration: false,
			done: true,
			confidence: 1,
			backend: "rules",
		};
	}

	if (/\b(stop|finished|complete|done)\b/.test(goal)) {
		return {
			action: "done",
			needsVision: false,
			needsGeneration: false,
			done: true,
			confidence: 0.95,
			backend: "rules",
		};
	}

	const waits = recent.filter(line => /\bwait\b/i.test(line)).length;
	if (waits >= 2) {
		return {
			action: "escalate",
			needsVision: false,
			needsGeneration: false,
			done: false,
			confidence: 0.85,
			backend: "rules",
		};
	}

	if (candidates.length === 0) {
		return {
			action: "wait",
			needsVision: false,
			needsGeneration: false,
			done: false,
			confidence: 0.7,
			backend: "rules",
		};
	}

	if (/\bscroll\b/.test(goal)) {
		return {
			action: "scroll",
			needsVision: false,
			needsGeneration: false,
			done: false,
			confidence: 0.75,
			backend: "rules",
		};
	}

	if (state.focused_field && /\btype\b|\benter\b|\bfill\b/.test(goal)) {
		return {
			action: "type",
			target: candidates[0]?.id,
			needsVision: false,
			needsGeneration: /\bcompose\b|\bwrite\b|\bdraft\b/.test(goal),
			done: false,
			confidence: 0.72,
			backend: "rules",
		};
	}

	if (candidates.length === 1 && /\bclick\b|\bpress\b|\bopen\b|\btap\b/.test(goal)) {
		const confidence = 0.65 + overlapScore(goal, candidates[0].label) * 0.3;
		if (confidence >= minConfidence) {
			return {
				action: "click",
				target: candidates[0].id,
				needsVision: false,
				needsGeneration: false,
				done: false,
				confidence,
				backend: "rules",
			};
		}
	}

	return null;
}

/** Local semantic rerank: token overlap over candidate labels. */
export function applySemanticRerank(
	state: ComputerDecisionState,
	minConfidence = DEFAULT_MIN_CONFIDENCE,
): ComputerDecision | null {
	const candidates = normalizeCandidates(state.candidates);
	if (candidates.length === 0) return null;

	const scored = candidates
		.map(candidate => ({ candidate, score: overlapScore(state.goal, candidate.label) }))
		.sort((a, b) => b.score - a.score);

	const [top, second] = scored;
	if (!top || top.score < 0.45) return null;

	const gap = second ? top.score - second.score : top.score;
	const confidence = Math.min(0.95, top.score + gap * 0.5);
	if (confidence < minConfidence) return null;

	const wantsType = /\btype\b|\benter\b|\bfill\b/.test(state.goal.toLowerCase());
	const action: ComputerAction = wantsType ? "type" : "click";

	return {
		action,
		target: top.candidate.id,
		needsVision: false,
		needsGeneration: wantsType && /\bcompose\b|\bwrite\b|\bdraft\b/.test(state.goal.toLowerCase()),
		done: false,
		confidence,
		backend: "rerank",
	};
}

export function buildFactorizedQuestions(candidates: readonly ComputerCandidate[]): Questions {
	const normalized = normalizeCandidates(candidates);
	const actionCriteria: Record<ComputerAction, string | null> = {
		click: "Press or activate a visible control or link.",
		type: "Enter text into the focused or target field.",
		key: "Send a keyboard shortcut (Enter, Escape, arrows, etc.).",
		scroll: "Scroll the current surface to reveal more content.",
		wait: "The UI is still loading; no input yet.",
		done: "The stated goal is already satisfied; stop the loop.",
		escalate: "Confidence is too low or the planner must take over.",
	};
	const targetCriteria: Record<string, string | null> = { [NONE_TARGET]: "No specific element; action is global." };
	for (const candidate of normalized) {
		const hint = [candidate.role, candidate.region, candidate.source ? `source=${candidate.source}` : undefined]
			.filter(Boolean)
			.join(", ");
		targetCriteria[candidate.id] = hint ? `${candidate.label} (${hint})` : candidate.label;
	}

	const action: ChoiceQuestion<ComputerAction> = {
		type: "choice",
		instructions: ACTION_INSTRUCTIONS,
		criteria: actionCriteria,
	};
	const target: ChoiceQuestion = {
		type: "choice",
		instructions: TARGET_INSTRUCTIONS,
		criteria: targetCriteria,
	};
	const needsVision: NoulQuestion = {
		type: "noul",
		instructions: "Must the agent capture or re-read a screenshot before this action can succeed?",
	};
	const needsGeneration: NoulQuestion = {
		type: "noul",
		instructions: "Must a writing model compose free text for this step (not pick from visible labels)?",
	};
	const done: NoulQuestion = {
		type: "noul",
		instructions: "Is the user's stated goal already satisfied on the current screen?",
	};

	return { action, target, needsVision, needsGeneration, done };
}

function parseJevDecision(
	answers: Record<string, { choice?: string; probabilities?: Record<string, number>; noul?: number } | undefined>,
	candidates: readonly ComputerCandidate[],
): ComputerDecision | null {
	const action = String(answers.action?.choice ?? "") as ComputerAction;
	if (!COMPUTER_ACTIONS.includes(action)) return null;

	const allowedTargets = new Set(normalizeCandidates(candidates).map(c => c.id));
	const targetChoice = String(answers.target?.choice ?? "");
	const target =
		targetChoice && targetChoice !== NONE_TARGET && allowedTargets.has(targetChoice) ? targetChoice : undefined;

	const actionProb = Number(answers.action?.probabilities?.[action] ?? (answers.action?.choice ? 0.5 : 0));
	const confidence = Number.isFinite(actionProb) ? actionProb : 0.5;

	return {
		action,
		target,
		needsVision: Number(answers.needsVision?.noul ?? 0) >= 0.5,
		needsGeneration: Number(answers.needsGeneration?.noul ?? 0) >= 0.5,
		done: Number(answers.done?.noul ?? 0) >= 0.5 || action === "done",
		confidence,
		backend: "jev",
	};
}

export async function decideWithJev(input: {
	state: ComputerDecisionState;
	judge: Judge;
	signal?: AbortSignal;
	minConfidence?: number;
	budgetMs?: number;
}): Promise<ComputerDecision | null> {
	const candidates = normalizeCandidates(input.state.candidates);
	const questions = buildFactorizedQuestions(candidates);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), input.budgetMs ?? JEV_BUDGET_MS);
	const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;

	try {
		const result = await input.judge.judge(
			{
				state: {
					goal: input.state.goal.slice(0, 4000),
					recent_actions: input.state.recent_actions?.slice(-8) ?? [],
					app: input.state.app ?? "",
					url: input.state.url ?? "",
					focused_field: input.state.focused_field ?? null,
					candidate_count: candidates.length,
				},
				questions,
			},
			{ signal },
		);

		const decision = parseJevDecision(result.answers, candidates);
		if (!decision) return null;
		decision.model = result.model;
		if (decision.confidence < (input.minConfidence ?? DEFAULT_MIN_CONFIDENCE)) return null;
		return decision;
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

/** Run the full decision ladder; `null` means fail-open to the planner. */
export async function decideComputerStep(input: {
	state: ComputerDecisionState;
	judge?: Judge;
	useJev: boolean;
	signal?: AbortSignal;
	minConfidence?: number;
}): Promise<ComputerDecisionPacket | null> {
	const started = performance.now();
	const state: ComputerDecisionState = {
		...input.state,
		goal: input.state.goal.trim(),
		candidates: normalizeCandidates(input.state.candidates),
	};

	const minConfidence = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

	const ruled = applyDeterministicRules(state, minConfidence);
	if (ruled) {
		return packet(ruled, state, performance.now() - started);
	}

	const reranked = applySemanticRerank(state, minConfidence);
	if (reranked) {
		const scores: Record<string, number> = {};
		for (const candidate of state.candidates) {
			scores[candidate.id] = overlapScore(state.goal, candidate.label);
		}
		return packet(reranked, state, performance.now() - started, scores);
	}

	if (!input.useJev || !input.judge) {
		return null;
	}

	const jev = await decideWithJev({
		state,
		judge: input.judge,
		signal: input.signal,
		minConfidence,
	});
	if (!jev) return null;
	return packet(jev, state, performance.now() - started);
}
