/**
 * Splits a user request into subtasks that can run concurrently, for `task.autoParallel`.
 *
 * {@link segmentRequest} cuts the request into items; one native judgment then answers each item's
 * role (context, task, wrap-up) and, for every pair of items, whether they are coupled. Task items
 * joined by a pair at {@link COUPLED_AT} or above share a subtask, so each subtask is a connected
 * component of the coupling graph.
 *
 * Pairs, not "how many tasks, then which task is each item": the judge answers every question on its
 * own, so per-item labels `t1…tN` never agree on what `tN` means, and the counts it gives run high.
 * On a 34-request benchmark (labelled by hand and by the slow model) count-then-assign and a
 * confidence sweep over N reproduced 16–18 plans and split 23–25 coupled pairs; pairs reproduced all
 * 34 and split none.
 */
import { type Answer, judgeQuestions, type Questions, renderQuestion } from "@oh-my-pi/pi-ai";
import { truncate } from "@oh-my-pi/pi-utils";
import { hasNativeJudge, judgeNatively, type NativeJudgmentDeps } from "../judgment";
import questionFile from "../prompts/judge/auto-parallel.json" with { type: "json" };
import { cleanTinyMessage } from "../tiny/message-preproc";

const QUESTIONS = judgeQuestions(questionFile);

/**
 * `P(coupled)` at which two task items share a subtask. Low on purpose: a missed split only costs
 * time, a wrong one puts two workers on coupled code. The benchmark split no coupled pair from 0.25
 * through 0.35 and began to at 0.4.
 */
export const COUPLED_AT = 0.35;

/** Most items judged: pair questions grow quadratically (16 items ask 136 questions in ~0.4 s). Longer requests are not split. */
export const MAX_ITEMS = 16;

/** A judgment slower than this gives way to the unmodified turn; an optimization never makes the user wait longer. */
export const AUTO_PARALLEL_TIMEOUT_MS = 4000;

/** Longest item text the judge sees; an item's head carries its intent. */
const MAX_ITEM_CHARS = 600;

const ROLES = ["context", "task", "wrapup"] as const;
type ItemRole = (typeof ROLES)[number];

/** How a request splits; item indices are 0-based into {@link ParallelPlan.items}. */
export interface ParallelPlan {
	/** The request's items in order, cleaned and bounded as the judge saw them. */
	items: string[];
	/** Items every subtask needs and none owns: background, goals, lead-ins of a list. */
	context: number[];
	/** Follow-ups over the whole request that run after every subtask: checks, commits, changelog. */
	wrapup: number[];
	/** Task items partitioned into subtasks that can run concurrently, ordered by their first item. */
	subtasks: number[][];
}

/** A list entry (`-`, `*`, `+`, `•`, `1.`, `1)`) and the whitespace after its marker. */
const LIST_MARKER = /^\s*(?:[-*+•]|\d+[.)])\s+/;
/** A code fence opener or closer. */
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Cuts `request` into items: every top-level list entry and every other line starts one; lines
 * indented to a list entry's text (nested lists, wrapped prose) and fenced blocks continue the open
 * item. A plain line never absorbs the list under it (`can you:` and its entries are separate
 * items). Blank lines are dropped, and so are list markers, so the user's own numbering never
 * competes with the judge's `[n]`.
 *
 * @example
 * segmentRequest("fix these:\n- a\n  - a detail\n- b"); // ["fix these:", "a\n- a detail", "b"]
 */
export function segmentRequest(request: string): string[] {
	const items: { lines: string[]; nestAt: number }[] = [];
	let fence: string | undefined;
	for (const line of request.split("\n")) {
		const open = items.at(-1);
		const mark = FENCE.exec(line)?.[1];
		if (fence !== undefined || mark !== undefined) {
			// A closer repeats the opener's character at least as many times.
			if (fence === undefined) fence = mark;
			else if (mark?.startsWith(fence)) fence = undefined;
			if (open) open.lines.push(line);
			else items.push({ lines: [line], nestAt: Infinity });
			continue;
		}
		const text = line.trim();
		if (!text) continue;
		const indent = line.length - line.trimStart().length;
		if (open && indent >= open.nestAt) {
			open.lines.push(text);
			continue;
		}
		const marker = LIST_MARKER.exec(line)?.[0];
		items.push(
			marker
				? { lines: [line.slice(marker.length).trim()], nestAt: marker.length }
				: { lines: [text], nestAt: Infinity },
		);
	}
	return items.map(item => item.lines.join("\n"));
}

/** One role question per item and one coupling question per pair, keyed `role_<n>` and `coupled_<a>_<b>` (1-based). */
function buildQuestions(count: number): Questions {
	const questions: Questions = {};
	for (let a = 1; a <= count; a++) {
		questions[`role_${a}`] = renderQuestion(QUESTIONS.role, { item: a });
		for (let b = a + 1; b <= count; b++) questions[`coupled_${a}_${b}`] = renderQuestion(QUESTIONS.coupled, { a, b });
	}
	return questions;
}

function isRole(choice: string): choice is ItemRole {
	return (ROLES as readonly string[]).includes(choice);
}

function roleOf(answers: Readonly<Record<string, Answer>>, item: number): ItemRole {
	const id = `role_${item + 1}`;
	const answer: Answer | undefined = answers[id];
	if (answer?.type !== "choice" || !isRole(answer.choice)) {
		throw new Error(`auto-parallel: the judge returned a malformed answer to ${id}`);
	}
	return answer.choice;
}

function coupledOf(answers: Readonly<Record<string, Answer>>, a: number, b: number): number {
	const id = `coupled_${a + 1}_${b + 1}`;
	const answer: Answer | undefined = answers[id];
	if (answer?.type !== "noul" || !(answer.noul >= 0 && answer.noul <= 1)) {
		throw new Error(`auto-parallel: the judge returned a malformed answer to ${id}`);
	}
	return answer.noul;
}

/**
 * The plan `answers` (to {@link buildQuestions} over `items`) make: task items linked by a coupled pair
 * at {@link COUPLED_AT} or above share a subtask, transitively.
 * @throws when an answer is missing, of the wrong kind, or out of range.
 */
export function planFromAnswers(items: string[], answers: Readonly<Record<string, Answer>>): ParallelPlan {
	const roles = items.map((_, item) => roleOf(answers, item));
	const component = items.map((_, item) => item);
	for (let a = 0; a < items.length; a++) {
		for (let b = a + 1; b < items.length; b++) {
			if (roles[a] !== "task" || roles[b] !== "task" || coupledOf(answers, a, b) < COUPLED_AT) continue;
			const from = component[b];
			const to = component[a];
			if (from === to) continue;
			for (let item = 0; item < component.length; item++) if (component[item] === from) component[item] = to;
		}
	}
	const context: number[] = [];
	const wrapup: number[] = [];
	const subtasks = new Map<number, number[]>();
	for (const [item, role] of roles.entries()) {
		if (role === "context") context.push(item);
		else if (role === "wrapup") wrapup.push(item);
		else {
			const subtask = subtasks.get(component[item]);
			if (subtask) subtask.push(item);
			else subtasks.set(component[item], [item]);
		}
	}
	return { items, context, wrapup, subtasks: [...subtasks.values()] };
}

/**
 * Splits `request` into concurrent subtasks with the native judge.
 * @returns `undefined` without judging when the request has fewer than two items or more than
 * {@link MAX_ITEMS}, or when the `judge` role does not resolve first to a native backend.
 * @throws when the judge cannot answer within {@link AUTO_PARALLEL_TIMEOUT_MS} or answers malformed.
 */
export async function planParallel(request: string, deps: NativeJudgmentDeps): Promise<ParallelPlan | undefined> {
	const items = segmentRequest(request).map(item => truncate(cleanTinyMessage(item), MAX_ITEM_CHARS));
	if (items.length < 2 || items.length > MAX_ITEMS || !hasNativeJudge(deps.settings, deps.registry)) return undefined;
	const { answers } = await judgeNatively(
		"auto-parallel",
		{
			// `[n]` before each item, its continuation lines indented under it.
			state: { request: items.map((item, n) => `[${n + 1}] ${item.replaceAll("\n", "\n    ")}`).join("\n") },
			questions: buildQuestions(items.length),
		},
		deps,
		AUTO_PARALLEL_TIMEOUT_MS,
	);
	return planFromAnswers(items, answers);
}
