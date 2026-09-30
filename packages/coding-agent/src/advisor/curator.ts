import { type ChoiceQuestion, type Model, type NoulQuestion } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { resolveJudge } from "../judgment";
import curatorAddressedPrompt from "../prompts/advisor/curator-addressed.md" with { type: "text" };
import curatorActionPrompt from "../prompts/advisor/curator-action.md" with { type: "text" };
import curatorDuplicateNonePrompt from "../prompts/advisor/curator-duplicate-none.md" with { type: "text" };
import curatorDuplicateOfPrompt from "../prompts/advisor/curator-duplicate-of.md" with { type: "text" };
import type { AdvisorSeverity } from "@oh-my-pi/pi-tui/chat/messages";
import { cfgAdvisorCurator } from "./settings";
export interface AdvisorCuratorCandidate {
	id: string;
	note: string;
	severity?: AdvisorSeverity;
	advisor?: string;
	coveredTurn: number;
}
export interface AdvisorCuratorContext {
	recentPrimaryMessages: string;
}
export type AdvisorCuratorAction = "keep" | "drop" | "merge";
export interface AdvisorCuratorDecision {
	candidateId: string;
	action: AdvisorCuratorAction;
	mergeInto?: string;
}
export interface AdvisorCuratorResult {
	decisions: readonly AdvisorCuratorDecision[];
}
export interface CurateAdvisorCandidatesOptions {
	settings: Settings;
	registry: ModelRegistry;
	candidates: readonly AdvisorCuratorCandidate[];
	context: AdvisorCuratorContext;
	model?: Model;
	sessionId?: string;
	signal?: AbortSignal;
}
/** Longest note text quoted into a question; notes are short, this only bounds outliers. */
const MAX_QUOTED_NOTE_CHARS = 600;
/**
 * `addressed` probability at or above which a nit is withheld. Only nits reach the curator (concerns and blockers
 * are delivered without waiting). Measured on labeled batches, true cases scored >= 0.84 and false ones <= 0.13,
 * so this bar sits inside that margin.
 */
const NIT_DROP_THRESHOLD = 0.5;

function quote(note: string): string {
	const flat = note.replace(/\s+/g, " ").trim();
	return flat.length > MAX_QUOTED_NOTE_CHARS ? `${flat.slice(0, MAX_QUOTED_NOTE_CHARS)}…` : flat;
}
/**
 * Questions name the note they are about. A generic question repeated per id
 * leaves the judge to guess which candidate it concerns; measured, that
 * dropped unrelated notes and merged distinct issues.
 */
function addressedQuestion(candidate: AdvisorCuratorCandidate): NoulQuestion {
	return {
		type: "noul",
		instructions: prompt.render(curatorAddressedPrompt, { id: candidate.id, note: quote(candidate.note) }).trim(),
	};
}
function duplicateQuestion(
	candidate: AdvisorCuratorCandidate,
	candidates: readonly AdvisorCuratorCandidate[],
): ChoiceQuestion<string> {
	const criteria: Record<string, string> = {
		none: prompt.render(curatorDuplicateNonePrompt, { id: candidate.id }).trim(),
	};
	for (const other of candidates) {
		if (other.id === candidate.id) continue;
		criteria[`c${other.id}`] = prompt
			.render(curatorDuplicateOfPrompt, { id: candidate.id, other: other.id, note: quote(other.note) })
			.trim();
	}
	return {
		type: "choice",
		instructions: prompt.render(curatorActionPrompt, { id: candidate.id, note: quote(candidate.note) }).trim(),
		criteria,
	};
}
function severityRank(severity: AdvisorSeverity | undefined): number {
	return severity === "concern" ? 2 : severity === "nit" ? 1 : 0;
}
function representative(a: AdvisorCuratorCandidate, b: AdvisorCuratorCandidate): AdvisorCuratorCandidate {
	const rank = severityRank(a.severity) - severityRank(b.severity);
	if (rank !== 0) return rank > 0 ? a : b;
	if (a.coveredTurn !== b.coveredTurn) return a.coveredTurn > b.coveredTurn ? a : b;
	return a.id < b.id ? a : b;
}
export async function curateAdvisorCandidates(options: CurateAdvisorCandidatesOptions): Promise<AdvisorCuratorResult> {
	const { candidates, context } = options;
	const keep = (): AdvisorCuratorResult => ({
		decisions: candidates.map(candidate => ({ candidateId: candidate.id, action: "keep" })),
	});
	if (candidates.length === 0 || cfgAdvisorCurator.get(options.settings) === "off") return keep();
	try {
		const judge = resolveJudge({
			settings: options.settings,
			registry: options.registry,
			sessionModel: options.model,
			sessionId: options.sessionId,
			purpose: "advisor-curator",
		});
		const state = {
			recent_primary_work: context.recentPrimaryMessages,
			candidates: candidates.map(candidate => ({
				id: candidate.id,
				note: candidate.note,
				severity: candidate.severity ?? "nit",
				advisor: candidate.advisor ?? "default",
				covered_turn: candidate.coveredTurn,
			})),
		};
		const questions: Record<string, NoulQuestion | ChoiceQuestion<string>> = {};
		for (const candidate of candidates) {
			questions[`addressed:${candidate.id}`] = addressedQuestion(candidate);
			if (candidates.length > 1) questions[`duplicate:${candidate.id}`] = duplicateQuestion(candidate, candidates);
		}
		const result = await judge.judge({ state, questions }, { signal: options.signal });
		const decisions: AdvisorCuratorDecision[] = candidates.map(candidate => {
			const answer = result.answers[`addressed:${candidate.id}`];
			return {
				candidateId: candidate.id,
				action:
					candidate.severity === undefined || candidate.severity === "nit"
						? answer?.type === "noul" && answer.noul >= NIT_DROP_THRESHOLD
							? "drop"
							: "keep"
						: "keep",
			};
		});
		// Duplicate links form groups by union-find over the notes still kept:
		// each connected group keeps exactly one representative, so two notes
		// naming each other cannot cycle into zero survivors, and two unrelated
		// duplicate pairs stay two notes instead of collapsing into one.
		const kept = new Map(
			candidates
				.filter((_, index) => decisions[index]!.action === "keep")
				.map(candidate => [candidate.id, candidate]),
		);
		const parent = new Map([...kept.keys()].map(id => [id, id]));
		const root = (id: string): string => {
			let current = id;
			while (parent.get(current) !== current) current = parent.get(current)!;
			return current;
		};
		for (const candidate of kept.values()) {
			const answer = result.answers[`duplicate:${candidate.id}`];
			if (answer?.type !== "choice" || answer.choice === "none") continue;
			const targetId = answer.choice.slice(1);
			if (!kept.has(targetId)) continue;
			parent.set(root(candidate.id), root(targetId));
		}
		const groups = new Map<string, AdvisorCuratorCandidate[]>();
		for (const candidate of kept.values()) {
			const group = groups.get(root(candidate.id));
			if (group) group.push(candidate);
			else groups.set(root(candidate.id), [candidate]);
		}
		for (const group of groups.values()) {
			if (group.length < 2) continue;
			const target = group.reduce(representative);
			for (const candidate of group) {
				if (candidate.id === target.id) continue;
				const decision = decisions.find(entry => entry.candidateId === candidate.id)!;
				decision.action = "merge";
				decision.mergeInto = target.id;
			}
		}
		return { decisions };
	} catch (error) {
		logger.debug("advisor curator failed open", { error: error instanceof Error ? error.message : String(error) });
		return keep();
	}
}
export function attributeMergedAdvisorNote(note: string, advisors: readonly (string | undefined)[]): string {
	const sources = [...new Set(advisors.filter((advisor): advisor is string => Boolean(advisor)))];
	return sources.length === 0 ? note : `${note}\n\nAlso raised by ${sources.join(", ")}.`;
}

/**
 * Flatten one primary message into the plain text the curator judges against.
 * Only text blocks carry evidence of what the primary actually did; images and
 * binary payloads are skipped rather than described.
 */
export function advisorEvidenceText(message: { role: string; content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") parts.push(block);
		else if (isTextBlock(block)) parts.push(block.text);
	}
	return parts.join("\n");
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { type?: unknown }).type === "text" &&
		typeof (value as { text?: unknown }).text === "string"
	);
}

/**
 * Apply curator decisions to the batch the primary will actually see.
 *
 * `decisions` refer to `notes` by position. A merged note contributes only its
 * advisor name to the surviving original, so the primary reads one issue with
 * its corroboration instead of the same point restated by every advisor that
 * noticed it.
 */
export function applyAdvisorCuration<
	T extends { note: string; severity?: AdvisorSeverity; advisor?: string; curated?: boolean },
>(notes: readonly T[], decisions: readonly AdvisorCuratorDecision[]): T[] {
	const byId = new Map(notes.map((note, index) => [String(index), note]));
	const decisionFor = new Map(decisions.map(decision => [decision.candidateId, decision]));
	const mergedSources = new Map<T, string[]>();
	for (const [id, note] of byId) {
		const decision = decisionFor.get(id);
		if (decision?.action !== "merge" || decision.mergeInto === undefined) continue;
		const target = byId.get(decision.mergeInto);
		if (target === undefined || target === note) continue;
		const sources = mergedSources.get(target) ?? [];
		if (note.advisor !== undefined) sources.push(note.advisor);
		mergedSources.set(target, sources);
	}
	const removed = new Set<T>();
	for (const [id, note] of byId) {
		const action = decisionFor.get(id)?.action;
		if (action === "drop" || (action === "merge" && !mergedSources.has(note))) removed.add(note);
	}
	return notes
		.filter(note => !removed.has(note))
		.map(note => {
			const sources = mergedSources.get(note);
			return sources === undefined
				? note
				: { ...note, note: attributeMergedAdvisorNote(note.note, sources), curated: true };
		});
}
