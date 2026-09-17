/**
 * Text bridge: answers {@link Questions} with any model that completes text.
 *
 * Questions render into one system prompt asking for keyword answers (an
 * option label, `yes`/`no`, or a level number); the state is the user message,
 * so the question part stays byte-identical across calls and prompt caches
 * hit. Several questions batch into a single completion answered one line per
 * question id. Answers are one-hot: a parsed keyword yields probability 1 and
 * confidence 1, since a text completion carries no distribution.
 *
 * The {@link TextBackend} decides *how* text is completed — a chat model via
 * {@link chatTextBackend}, or an on-device worker — so this file never
 * depends on chat transports.
 */
import { escapeXmlAttribute, escapeXmlText, prompt } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type { Usage } from "../types";
import textJudgeStateTemplate from "./text-judge-state.md" with { type: "text" };
import textJudgeTemplate from "./text-judge.md" with { type: "text" };
import {
	type Answer,
	type Judge,
	type JudgeOptions,
	type JudgmentRequest,
	type JudgmentResult,
	JudgmentParseError,
	type JudgmentState,
	type JsonValue,
	type Question,
	type Questions,
	tokenUsage,
} from "./types";

export interface TextPrompt {
	system: string;
	user: string;
}

export interface TextCompletion {
	text: string;
	/** Omitted by backends that do not meter tokens (on-device workers). */
	usage?: Usage;
}

/** Completes a rendered judgment prompt; identifies itself for usage attribution. */
export interface TextBackend {
	readonly api: string;
	readonly provider: string;
	readonly model: string;
	complete(prompt: TextPrompt, options: JudgeOptions): Promise<TextCompletion>;
}

interface RenderedQuestion {
	id: string;
	instructions: string;
	options?: { label: string; description: string | null }[];
	levels?: { index: number; description: string }[];
	yesno?: boolean;
	yes?: string;
	no?: string;
}

const XML_TAG_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function isJsonArray(value: JudgmentState): value is readonly JsonValue[] {
	return Array.isArray(value);
}

/** Render judgment state as top-level XML fields; nested values use block YAML. */
export function renderJudgmentState(state: JudgmentState): string {
	if (typeof state !== "object" || state === null || isJsonArray(state)) {
		return renderStateField("state", state);
	}
	const fields: string[] = [];
	for (const key in state) {
		if (!Object.hasOwn(state, key)) continue;
		fields.push(renderStateField(key, state[key]));
	}
	return fields.length > 0 ? fields.join("\n") : "<state>{}</state>";
}

function renderStateField(key: string, value: JsonValue): string {
	const validTag = XML_TAG_NAME.test(key);
	const open = validTag ? `<${key}>` : `<field name="${escapeXmlAttribute(key)}">`;
	const close = validTag ? `</${key}>` : "</field>";
	if (typeof value !== "object" || value === null) {
		return `${open}${escapeXmlText(value === null ? "null" : String(value))}${close}`;
	}
	const yaml = YAML.stringify(value, null, 2).trimEnd();
	return `${open}\n${escapeXmlText(yaml)}\n${close}`;
}

/**
 * Render a request: the system prompt carries the preamble and question
 * definitions (constant across states, so prompt caches hit); the user message
 * carries XML-field state followed by the answer-format cue. Small models act
 * on a bare request (answer it, emit tool calls) instead of classifying it —
 * explicit tags and the trailing cue keep them on task.
 */
export function renderJudgmentPrompt(request: JudgmentRequest): TextPrompt {
	const questions: RenderedQuestion[] = [];
	for (const id in request.questions) {
		const question = request.questions[id];
		const rendered: RenderedQuestion = { id, instructions: question.instructions };
		switch (question.type) {
			case "choice": {
				const options: RenderedQuestion["options"] = [];
				for (const label in question.criteria) options.push({ label, description: question.criteria[label] });
				rendered.options = options;
				break;
			}
			case "score":
				rendered.levels = question.criteria.map((description, index) => ({ index, description }));
				break;
			case "noul":
				rendered.yesno = true;
				rendered.yes = question.criteria?.true;
				rendered.no = question.criteria?.false;
				break;
		}
		questions.push(rendered);
	}
	const multi = questions.length > 1;
	return {
		system: prompt.render(textJudgeTemplate, { questions, multi }),
		user: prompt.render(textJudgeStateTemplate, {
			...questions[0],
			multi,
			state: renderJudgmentState(request.state),
		}),
	};
}

const WORD = /[\p{L}\p{N}_]/u;

/** Index of the earliest whole-word, case-insensitive occurrence of `needle` in `text`, or -1. */
function indexOfWord(text: string, needle: string): number {
	const lower = text.toLowerCase();
	const target = needle.toLowerCase();
	let from = 0;
	while (from <= lower.length - target.length) {
		const at = lower.indexOf(target, from);
		if (at < 0) return -1;
		const before = at > 0 ? lower[at - 1] : "";
		const after = lower[at + target.length] ?? "";
		const boundedBefore = before === "" || !WORD.test(before) || !WORD.test(target[0]);
		const boundedAfter = after === "" || !WORD.test(after) || !WORD.test(target[target.length - 1]);
		if (boundedBefore && boundedAfter) return at;
		from = at + 1;
	}
	return -1;
}

/**
 * Earliest option label mentioned in `text`; a longer label wins a tie at the
 * same position (so `xhigh` beats `high` where both start together).
 */
export function parseChoiceReply<L extends string>(text: string, labels: readonly L[]): L | undefined {
	let best: L | undefined;
	let bestAt = Number.POSITIVE_INFINITY;
	for (const label of labels) {
		const at = indexOfWord(text, label);
		if (at < 0) continue;
		if (at < bestAt || (at === bestAt && best !== undefined && label.length > best.length)) {
			best = label;
			bestAt = at;
		}
	}
	return best;
}

/** `true` when a yes-word precedes any no-word, `false` for the reverse, `undefined` when neither appears. */
export function parseNoulReply(text: string): boolean | undefined {
	const yes = [indexOfWord(text, "yes"), indexOfWord(text, "true")].filter(at => at >= 0);
	const no = [indexOfWord(text, "no"), indexOfWord(text, "false")].filter(at => at >= 0);
	const yesAt = yes.length > 0 ? Math.min(...yes) : -1;
	const noAt = no.length > 0 ? Math.min(...no) : -1;
	if (yesAt < 0 && noAt < 0) return undefined;
	if (noAt < 0) return true;
	if (yesAt < 0) return false;
	return yesAt < noAt;
}

/** Standalone integers: not glued to a word (`v2`) and not one side of a decimal (`1.5`); a trailing period is fine. */
const INTEGER = /(?<![\p{L}\p{N}_])(?<!\d\.)(\d+)(?![\p{L}\p{N}_])(?!\.\d)/gu;

/** First standalone integer in `[0, levels)`, or `undefined`. */
export function parseScoreReply(text: string, levels: number): number | undefined {
	for (const match of text.matchAll(INTEGER)) {
		const value = Number(match[1]);
		if (value < levels) return value;
	}
	return undefined;
}

/**
 * Split a multi-question reply into `id → answer text`. Lines are matched as
 * `<id>: <answer>` (also `=` / `-` separators and quoted ids); unknown ids are
 * ignored so a chatty preamble does not poison parsing.
 */
export function splitAnswerLines(text: string, ids: readonly string[]): Map<string, string> {
	const byId = new Map<string, string>();
	const wanted = new Set(ids);
	for (const rawLine of text.split("\n")) {
		const line = rawLine.replace(/^[\s\-*•]+/, "").trim();
		const separator = line.search(/\s*[:=]\s*|\s+-\s+/);
		if (separator <= 0) continue;
		const id = line.slice(0, separator).replace(/^[`"']|[`"']$/g, "");
		if (!wanted.has(id) || byId.has(id)) continue;
		byId.set(id, line.slice(separator).replace(/^\s*[:=-]\s*/, ""));
	}
	return byId;
}

function oneHot<L extends string>(labels: readonly L[], chosen: L): Record<L, number> {
	const probabilities = {} as Record<L, number>;
	for (const label of labels) probabilities[label] = label === chosen ? 1 : 0;
	return probabilities;
}

/** Parse one question's keyword reply into its typed, one-hot answer. */
export function parseAnswer(id: string, question: Question, reply: string): Answer {
	switch (question.type) {
		case "choice": {
			const labels = Object.keys(question.criteria);
			const choice = parseChoiceReply(reply, labels);
			if (choice === undefined) throw new JudgmentParseError(id, reply, "no option label in reply");
			return { type: "choice", choice, probabilities: oneHot(labels, choice), confidence: 1 };
		}
		case "noul": {
			const verdict = parseNoulReply(reply);
			if (verdict === undefined) throw new JudgmentParseError(id, reply, "no yes/no in reply");
			return { type: "noul", noul: verdict ? 1 : 0 };
		}
		case "score": {
			const level = parseScoreReply(reply, question.criteria.length);
			if (level === undefined) throw new JudgmentParseError(id, reply, "no level number in reply");
			const probabilities: Record<string, number> = {};
			for (let index = 0; index < question.criteria.length; index++) {
				probabilities[String(index)] = index === level ? 1 : 0;
			}
			return { type: "score", score: level, probabilities, confidence: 1 };
		}
	}
}

export class TextJudge implements Judge {
	readonly label: string;
	readonly #backend: TextBackend;

	constructor(backend: TextBackend) {
		this.#backend = backend;
		this.label = `${backend.provider}/${backend.model}`;
	}

	async judge<Q extends Questions>(
		request: JudgmentRequest<Q>,
		options: JudgeOptions = {},
	): Promise<JudgmentResult<Q>> {
		const ids = Object.keys(request.questions);
		if (ids.length === 0) throw new Error("judgment request has no questions");
		const completion = await this.#backend.complete(renderJudgmentPrompt(request), options);
		const replies = ids.length === 1 ? new Map([[ids[0], completion.text]]) : splitAnswerLines(completion.text, ids);
		const answers: Record<string, Answer> = {};
		for (const id of ids) {
			const reply = replies.get(id);
			if (reply === undefined) throw new JudgmentParseError(id, completion.text, "no answer line for question");
			answers[id] = parseAnswer(id, request.questions[id], reply);
		}
		return {
			api: this.#backend.api,
			provider: this.#backend.provider,
			model: this.#backend.model,
			answers: answers as JudgmentResult<Q>["answers"],
			usage: completion.usage ?? tokenUsage(0, 0),
		};
	}
}
