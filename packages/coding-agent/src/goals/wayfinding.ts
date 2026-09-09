import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import goalWayfindingTemplate from "../prompts/goals/goal-wayfinding.md" with { type: "text" };
import type { GoalObservation, GoalWayfindingOutcome, GoalWayfindingState, GoalWaypoint } from "./state";

const MAX_GOAL_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 1_000;
const MAX_LIST_ITEMS = 8;
const MAX_LIST_ITEM_LENGTH = 400;
const MAX_TOTAL_LENGTH = 6_000;

const WAYFINDING_OUTCOMES: ReadonlySet<GoalWayfindingOutcome> = new Set([
	"succeeded",
	"partial",
	"failed",
	"unexpected",
	"blocked",
]);

export interface GoalWaypointUpdate {
	action: string;
	rationale: string;
	guidance?: string;
	successSignal?: string;
	replanIf?: string;
}

export interface GoalWayfindingUpdate {
	goalId: string;
	expectedRevision: number;
	focus?: string;
	waypoint: GoalWaypointUpdate;
	lastObservation?: GoalObservation;
	blockers?: readonly string[];
	assumptions?: readonly string[];
}

export interface NormalizedGoalWayfindingUpdate {
	goalId: string;
	expectedRevision: number;
	focus?: string;
	waypoint: GoalWaypoint;
	lastObservation?: GoalObservation;
	blockers?: readonly string[];
	assumptions?: readonly string[];
}

function normalizeRequiredText(label: string, value: string, maxLength = MAX_TEXT_LENGTH): string {
	const normalized = value.trim();
	if (!normalized) {
		throw new Error(`${label} is required`);
	}
	if (normalized.length > maxLength) {
		throw new Error(`${label} must be at most ${maxLength} characters`);
	}
	return normalized;
}

function normalizeOptionalText(label: string, value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim();
	if (!normalized) return undefined;
	if (normalized.length > MAX_TEXT_LENGTH) {
		throw new Error(`${label} must be at most ${MAX_TEXT_LENGTH} characters`);
	}
	return normalized;
}

function normalizeStringList(label: string, values: readonly string[] | undefined): readonly string[] | undefined {
	if (values === undefined) return undefined;
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const item = value.trim();
		if (!item || seen.has(item)) continue;
		if (item.length > MAX_LIST_ITEM_LENGTH) {
			throw new Error(`${label} entries must be at most ${MAX_LIST_ITEM_LENGTH} characters`);
		}
		seen.add(item);
		normalized.push(item);
	}
	if (normalized.length > MAX_LIST_ITEMS) {
		throw new Error(`${label} must contain at most ${MAX_LIST_ITEMS} entries`);
	}
	return normalized.length > 0 ? normalized : undefined;
}

function totalLength(update: Omit<NormalizedGoalWayfindingUpdate, "goalId" | "expectedRevision">): number {
	const waypoint = update.waypoint;
	let total =
		(update.focus?.length ?? 0) +
		waypoint.action.length +
		waypoint.rationale.length +
		(waypoint.guidance?.length ?? 0) +
		(waypoint.successSignal?.length ?? 0) +
		(waypoint.replanIf?.length ?? 0) +
		(update.lastObservation?.summary.length ?? 0);
	for (const item of update.blockers ?? []) total += item.length;
	for (const item of update.assumptions ?? []) total += item.length;
	return total;
}

export function normalizeGoalWayfindingUpdate(input: GoalWayfindingUpdate): NormalizedGoalWayfindingUpdate {
	const goalId = normalizeRequiredText("goal_id", input.goalId, MAX_GOAL_ID_LENGTH);
	if (
		!Number.isSafeInteger(input.expectedRevision) ||
		input.expectedRevision < 0 ||
		input.expectedRevision >= Number.MAX_SAFE_INTEGER
	) {
		throw new Error("expected_revision must be a non-negative safe integer below Number.MAX_SAFE_INTEGER");
	}

	const lastObservation = input.lastObservation
		? {
				outcome: input.lastObservation.outcome,
				summary: normalizeRequiredText("observation", input.lastObservation.summary),
			}
		: undefined;
	if (lastObservation && !WAYFINDING_OUTCOMES.has(lastObservation.outcome)) {
		throw new Error(`unsupported wayfinding outcome: ${String(lastObservation.outcome)}`);
	}

	const normalized: NormalizedGoalWayfindingUpdate = {
		goalId,
		expectedRevision: input.expectedRevision,
		focus: normalizeOptionalText("focus", input.focus),
		waypoint: {
			action: normalizeRequiredText("next_action", input.waypoint.action),
			rationale: normalizeRequiredText("why", input.waypoint.rationale),
			guidance: normalizeOptionalText("guidance", input.waypoint.guidance),
			successSignal: normalizeOptionalText("success_signal", input.waypoint.successSignal),
			replanIf: normalizeOptionalText("replan_if", input.waypoint.replanIf),
		},
		lastObservation,
		blockers: normalizeStringList("blockers", input.blockers),
		assumptions: normalizeStringList("assumptions", input.assumptions),
	};
	if (totalLength(normalized) > MAX_TOTAL_LENGTH) {
		throw new Error(`wayfinding state must be at most ${MAX_TOTAL_LENGTH} characters in total`);
	}
	return normalized;
}

const INVALID_PERSISTED_VALUE = Symbol("invalid persisted wayfinding value");

function isWayfindingOutcome(value: unknown): value is GoalWayfindingOutcome {
	return typeof value === "string" && WAYFINDING_OUTCOMES.has(value as GoalWayfindingOutcome);
}

function parsePersistedText(
	value: unknown,
	maxLength = MAX_TEXT_LENGTH,
): string | undefined | typeof INVALID_PERSISTED_VALUE {
	if (value === undefined) return undefined;
	return typeof value === "string" && value.length <= maxLength ? value : INVALID_PERSISTED_VALUE;
}

function parsePersistedList(value: unknown): readonly string[] | undefined | typeof INVALID_PERSISTED_VALUE {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) return INVALID_PERSISTED_VALUE;
	const values: string[] = [];
	for (const item of value) {
		if (typeof item !== "string" || item.length > MAX_LIST_ITEM_LENGTH) return INVALID_PERSISTED_VALUE;
		values.push(item);
	}
	return values;
}

export function parseGoalWayfindingState(value: unknown): GoalWayfindingState | undefined {
	if (!isRecord(value)) return undefined;
	const revision = value.revision;
	if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0) {
		return undefined;
	}
	if (!isRecord(value.waypoint)) return undefined;
	const action = value.waypoint.action;
	const rationale = value.waypoint.rationale;
	if (
		typeof action !== "string" ||
		action.length > MAX_TEXT_LENGTH ||
		action.trim().length === 0 ||
		typeof rationale !== "string" ||
		rationale.length > MAX_TEXT_LENGTH ||
		rationale.trim().length === 0
	) {
		return undefined;
	}

	const focus = parsePersistedText(value.focus);
	const guidance = parsePersistedText(value.waypoint.guidance);
	const successSignal = parsePersistedText(value.waypoint.successSignal);
	const replanIf = parsePersistedText(value.waypoint.replanIf);
	const blockers = parsePersistedList(value.blockers);
	const assumptions = parsePersistedList(value.assumptions);
	if (
		focus === INVALID_PERSISTED_VALUE ||
		guidance === INVALID_PERSISTED_VALUE ||
		successSignal === INVALID_PERSISTED_VALUE ||
		replanIf === INVALID_PERSISTED_VALUE ||
		blockers === INVALID_PERSISTED_VALUE ||
		assumptions === INVALID_PERSISTED_VALUE
	) {
		return undefined;
	}

	let lastObservation: GoalObservation | undefined;
	if (value.lastObservation !== undefined) {
		if (!isRecord(value.lastObservation) || !isWayfindingOutcome(value.lastObservation.outcome)) {
			return undefined;
		}
		const summary = value.lastObservation.summary;
		if (typeof summary !== "string" || summary.length > MAX_TEXT_LENGTH || summary.trim().length === 0) {
			return undefined;
		}
		lastObservation = { outcome: value.lastObservation.outcome, summary };
	}

	const totalLength =
		(focus?.length ?? 0) +
		action.length +
		rationale.length +
		(guidance?.length ?? 0) +
		(successSignal?.length ?? 0) +
		(replanIf?.length ?? 0) +
		(lastObservation?.summary.length ?? 0) +
		(blockers?.reduce((total, item) => total + item.length, 0) ?? 0) +
		(assumptions?.reduce((total, item) => total + item.length, 0) ?? 0);
	if (totalLength > MAX_TOTAL_LENGTH) return undefined;

	return {
		revision,
		focus,
		waypoint: { action, rationale, guidance, successSignal, replanIf },
		lastObservation,
		blockers,
		assumptions,
	};
}

export function createGoalWayfindingState(
	update: NormalizedGoalWayfindingUpdate,
	revision: number,
): GoalWayfindingState {
	if (!Number.isSafeInteger(revision) || revision <= 0) {
		throw new Error("wayfinding revision must be a positive safe integer");
	}
	return {
		revision,
		focus: update.focus,
		waypoint: { ...update.waypoint },
		lastObservation: update.lastObservation ? { ...update.lastObservation } : undefined,
		blockers: update.blockers ? [...update.blockers] : undefined,
		assumptions: update.assumptions ? [...update.assumptions] : undefined,
	};
}

export function cloneGoalWayfindingState(state: GoalWayfindingState | undefined): GoalWayfindingState | undefined {
	if (!state) return undefined;
	return {
		...state,
		waypoint: { ...state.waypoint },
		lastObservation: state.lastObservation ? { ...state.lastObservation } : undefined,
		blockers: state.blockers ? [...state.blockers] : undefined,
		assumptions: state.assumptions ? [...state.assumptions] : undefined,
	};
}

export function renderGoalWayfindingState(state: GoalWayfindingState | undefined): string {
	if (!state) return "";
	return prompt
		.render(goalWayfindingTemplate, {
			revision: state.revision,
			focus: state.focus,
			waypoint: state.waypoint,
			lastObservation: state.lastObservation,
			blockers: state.blockers,
			assumptions: state.assumptions,
		})
		.trim();
}
