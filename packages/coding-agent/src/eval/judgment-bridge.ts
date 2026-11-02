/**
 * Host-side handler for the eval `judge()` helper.
 *
 * Cell code awaits `judge(state, questions)`; the prelude forwards
 * `{ state, questions }` through {@link EVAL_JUDGMENT_BRIDGE_NAME} and this
 * module answers every question with the session's resolved {@link Judge}
 * role chain (see `../judgment`), returning the typed answers directly. Bulk
 * classification goes through `judge_batch()` (`./judgment-batch-bridge`),
 * which reuses the parsers and answer shaping exported here.
 *
 * Cell code sees the yes/no kind as `bool` (`{ type: "bool", bool: P(yes) }`);
 * the library's `noul` name stays internal.
 */
import type {
	ImageContent,
	Answer,
	ChoiceQuestion,
	JudgmentResult,
	JudgmentState,
	JsonValue,
	NoulQuestion,
	Question,
	Questions,
	ScoreQuestion,
} from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { isEmbeddedImageContent } from "@oh-my-pi/pi-ai/images/shared";
import type { LoadedImageInput } from "../utils/image-loading";
import { loadImageAttachmentInput, loadImageInput, loadSvgImageInput } from "../utils/image-loading";
import {
	type ChainJudge,
	type JudgmentUsage,
	journalJudgmentUsage,
	resolveJudge,
	sharedJudgmentCache,
} from "../judgment";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { withBridgeTimeoutPause } from "./bridge-timeout";
import { type EvalCompletionBridgeOptions, evalRequestSlots } from "./completion-bridge";

/** Synthetic bridge name reserved for the `judge()` helper across both runtimes. */
export const EVAL_JUDGMENT_BRIDGE_NAME = "__judge__";

/** Answer as the cell sees it: library `noul` answers surface as `bool`. */
export type CellAnswer = Answer | { type: "bool"; bool: number };

/** Typed answers plus the backend that produced them, returned to the cell. */
export interface EvalJudgmentResult {
	answers: Record<string, CellAnswer>;
	model: string;
}

function invalidImage(detail: string): ToolError {
	return new ToolError(`invalid judgment image source: ${detail}`);
}

/** Load paths and embedded image attachments into validated inline model images. */
export async function loadEvalJudgmentImages(value: unknown, cwd: string): Promise<ImageContent[] | undefined> {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw invalidImage("images must be an array of paths or image attachments");

	const images: ImageContent[] = [];
	for (let index = 0; index < value.length; index++) {
		const source = value[index];
		let loaded: LoadedImageInput | null | undefined;
		let detail: ImageContent["detail"];
		if (typeof source === "string") {
			if (source.length === 0) throw invalidImage(`images[${index}] path must not be empty`);
			try {
				loaded =
					(await loadSvgImageInput({ path: source, cwd, autoResize: false })) ??
					(await loadImageInput({ path: source, cwd, autoResize: false }));
			} catch (error) {
				throw invalidImage(
					`images[${index}] path ${JSON.stringify(source)} could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (!loaded) throw invalidImage(`images[${index}] path ${JSON.stringify(source)} is not a supported image`);
		} else {
			if (!isEmbeddedImageContent(source)) {
				throw invalidImage(
					`images[${index}] must be a local path or { type: "image", data, mimeType, detail? } with valid base64 data, an image MIME type, and detail auto, low, high, or original`,
				);
			}
			detail = source.detail;
			try {
				loaded = await loadImageAttachmentInput({
					image: { type: "image", data: source.data, mimeType: source.mimeType },
					label: `eval-${index}`,
					uri: "eval image attachment",
					autoResize: false,
				});
			} catch (error) {
				throw invalidImage(
					`images[${index}] attachment could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (!loaded)
				throw invalidImage(
					`images[${index}] attachment has unsupported MIME type ${JSON.stringify(source.mimeType)}`,
				);
		}
		images.push({
			type: "image",
			data: loaded.data,
			mimeType: loaded.mimeType,
			...(detail === undefined ? {} : { detail }),
		});
	}
	return images.length > 0 ? images : undefined;
}

function invalid(detail: string): ToolError {
	return new ToolError(`judge() received invalid arguments: ${detail}`);
}

function isJsonValue(value: unknown): value is JsonValue {
	switch (typeof value) {
		case "string":
		case "number":
		case "boolean":
			return true;
		case "object":
			if (value === null) return true;
			if (Array.isArray(value)) return value.every(isJsonValue);
			if (!isRecord(value)) return false;
			for (const key in value) {
				if (!isJsonValue(value[key])) return false;
			}
			return true;
		default:
			return false;
	}
}

/** Validate a cell-supplied judgment state (non-empty string or JSON value). */
export function parseState(value: unknown): JudgmentState {
	if (typeof value === "string") {
		if (value.length === 0) throw invalid("state must not be empty");
		return value;
	}
	if ((Array.isArray(value) || isRecord(value)) && isJsonValue(value)) return value;
	throw invalid("state must be a string, a JSON object, or a JSON array");
}

function parseInstructions(id: string, value: unknown): string {
	if (typeof value !== "string" || value.length === 0) {
		throw invalid(`question "${id}" needs non-empty string instructions`);
	}
	return value;
}

function parseChoice(id: string, value: Record<string, unknown>): ChoiceQuestion {
	const instructions = parseInstructions(id, value.instructions);
	if (!isRecord(value.criteria)) throw invalid(`choice question "${id}" needs criteria: { label: rubric | null }`);
	const criteria: Record<string, string | null> = {};
	let options = 0;
	for (const label in value.criteria) {
		const rubric = value.criteria[label];
		if (rubric !== null && typeof rubric !== "string") {
			throw invalid(`choice question "${id}" criteria "${label}" must be a string or null`);
		}
		criteria[label] = rubric;
		options++;
	}
	if (options < 2) throw invalid(`choice question "${id}" needs at least two options`);
	return { type: "choice", instructions, criteria };
}

function parseBool(id: string, value: Record<string, unknown>): NoulQuestion {
	const instructions = parseInstructions(id, value.instructions);
	if (value.criteria === undefined) return { type: "noul", instructions };
	if (!isRecord(value.criteria))
		throw invalid(`bool question "${id}" criteria must be { true?: string, false?: string }`);
	const criteria: NonNullable<NoulQuestion["criteria"]> = {};
	for (const side of ["true", "false"] as const) {
		const description = value.criteria[side];
		if (description === undefined) continue;
		if (typeof description !== "string") throw invalid(`bool question "${id}" criteria.${side} must be a string`);
		criteria[side] = description;
	}
	return { type: "noul", instructions, criteria };
}

function parseScore(id: string, value: Record<string, unknown>): ScoreQuestion {
	const instructions = parseInstructions(id, value.instructions);
	const levels = value.criteria;
	if (!Array.isArray(levels) || !levels.every(level => typeof level === "string")) {
		throw invalid(`score question "${id}" needs criteria: [lowest, ..., highest] level descriptions`);
	}
	const [lowest, second, ...rest] = levels;
	if (lowest === undefined || second === undefined) throw invalid(`score question "${id}" needs at least two levels`);
	return { type: "score", instructions, criteria: [lowest, second, ...rest] };
}

function parseQuestion(id: string, value: unknown): Question {
	if (!isRecord(value)) throw invalid(`question "${id}" must be an object`);
	switch (value.type) {
		case "choice":
			return parseChoice(id, value);
		case "bool":
			return parseBool(id, value);
		case "score":
			return parseScore(id, value);
		default:
			throw invalid(`question "${id}" type must be "choice", "bool", or "score"`);
	}
}

/** Validate cell-supplied questions keyed by id; `bool` maps to the library's `noul`. */
export function parseQuestions(value: unknown): Record<string, Question> {
	if (!isRecord(value)) throw invalid("questions must be an object keyed by question id");
	const questions: Record<string, Question> = {};
	let count = 0;
	for (const id in value) {
		questions[id] = parseQuestion(id, value[id]);
		count++;
	}
	if (count === 0) throw invalid("questions must contain at least one question");
	return questions;
}

/** Shape a library judgment result into the cell-facing answers and backend label. */
export function toEvalJudgmentResult(result: JudgmentResult<Questions>): EvalJudgmentResult {
	const answers: Record<string, CellAnswer> = {};
	for (const id in result.answers) {
		const answer = result.answers[id];
		answers[id] = answer.type === "noul" ? { type: "bool", bool: answer.noul } : answer;
	}
	return { answers, model: `${result.provider}/${result.model}` };
}

/**
 * Resolve the judge role chain for a bridge call's session; `purpose` labels its
 * cost on the session ledger. `onUsage` additionally observes every attempt
 * (retries and failures included) alongside the ledger.
 */
export function sessionJudge(
	options: Pick<EvalCompletionBridgeOptions, "session">,
	purpose: string,
	onUsage?: (usage: JudgmentUsage) => void,
): ChainJudge {
	const { session } = options;
	const registry = session.modelRegistry;
	if (!registry) throw new ToolError("judge() has no model registry.");
	const journal = journalJudgmentUsage(session.sessionManager);
	return resolveJudge({
		settings: session.settings,
		registry,
		sessionId: session.getSessionId?.() ?? undefined,
		purpose,
		telemetry: session.getTelemetry?.(),
		cache: sharedJudgmentCache(),
		costGate: session.costGate,
		onUsage:
			onUsage && journal
				? usage => {
						journal(usage);
						onUsage(usage);
					}
				: (onUsage ?? journal),
	});
}

/** Answer one typed judgment; the cell awaits the answers directly. */
export async function runEvalJudgment(
	args: unknown,
	options: EvalCompletionBridgeOptions,
): Promise<EvalJudgmentResult> {
	if (!isRecord(args)) throw invalid("expected { state, questions }");
	const state = parseState(args.state);
	const questions = parseQuestions(args.questions);
	const judge = sessionJudge(options, "judge");
	const signal = options.signal;
	return withBridgeTimeoutPause(options.emitStatus, async () => {
		await evalRequestSlots.acquire(signal);
		try {
			signal?.throwIfAborted();
			const images = await loadEvalJudgmentImages(args.images, options.session.cwd);
			signal?.throwIfAborted();
			return toEvalJudgmentResult(
				await judge.judge({ state, questions, ...(images === undefined ? {} : { images }) }, { signal }),
			);
		} finally {
			evalRequestSlots.release();
		}
	});
}
