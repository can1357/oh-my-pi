/**
 * Step summaries (`display.stepSummaries`): after each agent step that called
 * tools, one plain-English line saying what came of it leads the step's usage
 * row.
 *
 * Steps made only of successful `read`, `grep`, and `glob` calls are captioned
 * locally from their arguments and result counts, with no model request.
 * Every other step goes to a small model, which sees a bounded digest of the
 * step (thinking, calls with their purposes, the head of each result, the
 * request it serves, and the last few captions) rather than the conversation,
 * so a caption costs a few hundred input tokens whatever the session's context
 * size. The model comes from the `summary` role when configured, else the
 * `tiny` role. Any failure, timeout, or missing model yields no caption: the
 * row stays as it was.
 */
import { type AssistantMessage, completeSimple, type TextContent, type ToolResultMessage } from "@oh-my-pi/pi-ai";
import { parseTextSignature } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { isRecord, logger, prompt } from "@oh-my-pi/pi-utils";
import { splitPathAndSel } from "@oh-my-pi/pi-tui/tools/read";
import type { StepSummary, StepSummaryTone } from "@oh-my-pi/pi-tui/overlays/usage-row";
import type { ModelRegistry } from "../config/model-registry";
import { roleCandidatePool } from "../config/model-roles";
import { getModelMatchPreferences, resolveModelRoleValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import stepSummaryPrompt from "../prompts/system/step-summary.md" with { type: "text" };
import type { SecretObfuscator } from "../secrets/obfuscator";

const SYSTEM_PROMPT = prompt.render(stepSummaryPrompt);

/** Session custom-entry type that persists a caption for replay: data is {@link StepSummaryEntryData}. */
export const STEP_SUMMARY_CUSTOM_TYPE = "step-summary";

export interface StepSummaryEntryData {
	/** `timestamp` of the assistant message the caption describes. */
	messageTimestamp: number;
	summary: string;
	/** Marker tone; absent when every tool call in the step succeeded. */
	tone?: StepSummaryTone;
}

/** Hard cap; a caption is ~20 tokens, the headroom covers backends that ignore `disableReasoning`. */
const MAX_TOKENS = 512;
/** A caption that lands later than this is not worth the wait. */
const TIMEOUT_MS = 15_000;
/** Longest caption shown; the prompt asks for 12 words. */
const MAX_SUMMARY_CHARS = 120;
/** Captions of earlier steps given as context, newest last. */
const RECENT_SUMMARIES = 2;

const REQUEST_CHARS = 400;
const THINKING_CHARS = 2000;
const TEXT_CHARS = 600;
const ARGS_CHARS = 300;
const RESULT_CHARS = 600;
const DIGEST_CHARS = 6000;
/** File names a local `read` caption lists before counting the rest. */
const LOCAL_NAMES_SHOWN = 3;
/** Longest search pattern quoted in a local caption. */
const LOCAL_PATTERN_CHARS = 40;

export interface StepSummaryInput {
	message: AssistantMessage;
	toolResults: readonly ToolResultMessage[];
	/** The user request this step serves. */
	request?: string;
}

export interface StepSummarizerDeps {
	settings: Settings;
	registry: ModelRegistry;
	sessionId: string;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	/** The session's secret obfuscator, read per request so toggles apply. */
	obfuscator?: () => SecretObfuscator | undefined;
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function resultText(result: ToolResultMessage): string {
	let out = "";
	for (const block of result.content) {
		if (block.type === "text") out += `${block.text}\n`;
		else out += "[image]\n";
	}
	return out;
}

/**
 * The model's answer text. Codex-style backends can stream a `commentary`
 * preamble before the `final_answer` item; only the answer is the caption.
 */
function replyText(content: AssistantMessage["content"]): string {
	const texts = content.filter((block): block is TextContent => block.type === "text" && block.text.trim() !== "");
	const answers = texts.filter(block => parseTextSignature(block.textSignature)?.phase === "final_answer");
	if (answers.length > 0) return answers.map(block => block.text).join("\n");
	return texts.at(-1)?.text ?? "";
}

/**
 * The bounded text a caption is written from, or `undefined` when the step
 * called no tools (its reply text already says what it did).
 */
export function buildStepDigest(input: StepSummaryInput, recent: readonly string[] = []): string | undefined {
	const calls = input.message.content.filter(block => block.type === "toolCall");
	if (calls.length === 0) return undefined;
	const lines: string[] = [];
	const request = input.request?.trim();
	if (request) lines.push(`Request: ${clip(request, REQUEST_CHARS)}`);
	if (recent.length > 0) lines.push(`Earlier steps: ${recent.join("; ")}`);
	let thinking = "";
	let said = "";
	for (const block of input.message.content) {
		if (block.type === "thinking") thinking += `${block.thinking} `;
		else if (block.type === "text") said += `${block.text} `;
	}
	if (thinking.trim()) lines.push(`Thinking: ${clip(thinking, THINKING_CHARS)}`);
	if (said.trim()) lines.push(`Said: ${clip(said, TEXT_CHARS)}`);
	const results = new Map(input.toolResults.map(result => [result.toolCallId, result]));
	calls.forEach((call, index) => {
		const n = index + 1;
		const intent = call.intent?.trim();
		lines.push(
			`Call ${n}: ${call.name}${intent ? `, for: ${clip(intent, 120)}` : ""} ${clip(JSON.stringify(call.arguments ?? {}), ARGS_CHARS)}`,
		);
		const result = results.get(call.id);
		if (result) {
			lines.push(
				`Result ${n}${result.isError ? " (error)" : ""}: ${clip(resultText(result), RESULT_CHARS) || "(empty)"}`,
			);
		} else {
			lines.push(`Result ${n}: (none)`);
		}
	});
	const digest = lines.join("\n");
	return digest.length <= DIGEST_CHARS ? digest : `${digest.slice(0, DIGEST_CHARS - 1)}…`;
}

function countOf(details: unknown, key: string): number | undefined {
	if (!isRecord(details)) return undefined;
	const value = details[key];
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function plural(count: number, noun: string, nouns = `${noun}s`): string {
	return `${count} ${count === 1 ? noun : nouns}`;
}

function listNames(names: readonly string[]): string {
	if (names.length <= LOCAL_NAMES_SHOWN) {
		return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
	}
	return `${names.slice(0, LOCAL_NAMES_SHOWN).join(", ")} and ${names.length - LOCAL_NAMES_SHOWN} more`;
}

/**
 * A caption written without a model, for steps made only of successful
 * `read`, `grep`, and `glob` calls: their outcome is fully stated by the
 * files read and the match counts. `undefined` for any other step, including
 * one where such a call failed, reached a URL, or lacks the counts.
 */
export function localStepSummary(input: StepSummaryInput): string | undefined {
	const calls = input.message.content.filter(block => block.type === "toolCall");
	if (calls.length === 0) return undefined;
	const results = new Map(input.toolResults.map(result => [result.toolCallId, result]));
	const read: string[] = [];
	const searches: string[] = [];
	for (const call of calls) {
		const result = results.get(call.id);
		if (!result || result.isError) return undefined;
		if (isRecord(result.details) && result.details.error !== undefined) return undefined;
		const args = isRecord(call.arguments) ? call.arguments : {};
		const target = typeof args.path === "string" ? args.path.trim() : "";
		if (call.name === "read") {
			if (!target || target.includes("://")) return undefined;
			const name = splitPathAndSel(target)
				.path.split(/[\\/]/)
				.findLast(part => part !== "");
			if (!name) return undefined;
			if (!read.includes(name)) read.push(name);
		} else if (call.name === "grep") {
			const pattern = typeof args.pattern === "string" ? clip(args.pattern, LOCAL_PATTERN_CHARS) : "";
			const matches = countOf(result.details, "matchCount");
			if (!pattern || matches === undefined) return undefined;
			const files = countOf(result.details, "fileCount");
			searches.push(
				matches === 0
					? `No matches for ${pattern}`
					: `Found ${plural(matches, "match", "matches")} for ${pattern}${files ? ` in ${plural(files, "file")}` : ""}`,
			);
		} else if (call.name === "glob") {
			const files = countOf(result.details, "fileCount");
			if (files === undefined) return undefined;
			const pattern = target ? ` matching ${clip(target, LOCAL_PATTERN_CHARS)}` : "";
			searches.push(files === 0 ? `No files${pattern}` : `Found ${plural(files, "file")}${pattern}`);
		} else {
			return undefined;
		}
	}
	const parts = [...searches];
	if (read.length > 0) parts.push(`Read ${listNames(read)}`);
	const caption = parts.map((part, index) => (index === 0 ? part : part[0]!.toLowerCase() + part.slice(1))).join("; ");
	return caption.length <= MAX_SUMMARY_CHARS ? caption : `${caption.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

/** First line of a reply with markdown, quotes, and the trailing period stripped; `undefined` when nothing is left. */
export function normalizeStepSummary(reply: string): string | undefined {
	const line = reply
		.split("\n")
		.map(part => part.trim())
		.find(part => part.length > 0);
	if (!line) return undefined;
	// Emphasis and code marks go first so the label, quote, and period checks see bare text;
	// `_` stays because captions name snake_case identifiers.
	const cleaned = line
		.replace(/[*`]/g, "")
		.replace(/^[->#\s]+/, "")
		.replace(/^(?:summary|caption)\s*:\s*/i, "")
		.replace(/[.\s]+$/, "")
		.replace(/^["'“‘]+|["'”’]+$/g, "")
		.replace(/[.\s]+$/, "")
		.trim();
	if (!cleaned) return undefined;
	return cleaned.length <= MAX_SUMMARY_CHARS ? cleaned : `${cleaned.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

/** Per-session caption service. One instance per event controller; {@link dispose} cancels requests in flight. */
export class StepSummarizer {
	readonly #deps: StepSummarizerDeps;
	readonly #abort = new AbortController();
	readonly #recent: string[] = [];

	constructor(deps: StepSummarizerDeps) {
		this.#deps = deps;
	}

	/** Caption one step; `undefined` when the step needs none or no caption could be produced. */
	async summarize(input: StepSummaryInput): Promise<string | undefined> {
		if (this.#abort.signal.aborted) return undefined;
		const local = localStepSummary(input);
		if (local) return this.#remember(local);
		const digest = buildStepDigest(input, this.#recent);
		if (!digest) return undefined;
		const { settings, registry } = this.#deps;
		// A dedicated id keeps caption traffic out of the foreground session's provider state and prompt cache.
		const sessionId = `${this.#deps.sessionId}-step-summary`;
		try {
			const role = settings.getModelRole("summary") ? "summary" : "tiny";
			const model = resolveModelRoleValue(`@${role}`, roleCandidatePool(role, settings, registry), {
				settings,
				matchPreferences: getModelMatchPreferences(settings),
			}).model;
			if (!model) return undefined;
			const apiKey = await registry.getApiKey(model, sessionId);
			if (!apiKey || this.#abort.signal.aborted) return undefined;
			const obfuscator = this.#deps.obfuscator?.();
			const response = await completeSimple(
				model,
				{
					systemPrompt: [SYSTEM_PROMPT],
					messages: [{ role: "user", content: obfuscator?.obfuscate(digest) ?? digest, timestamp: Date.now() }],
				},
				{
					apiKey: registry.resolver(model, sessionId),
					sessionId,
					maxTokens: MAX_TOKENS,
					disableReasoning: true,
					temperature: 0,
					metadata: this.#deps.metadataResolver?.(model.provider),
					signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(TIMEOUT_MS)]),
				},
			);
			if (response.stopReason === "error" || response.stopReason === "aborted") {
				logger.debug("step-summary: request failed", { model: model.id, error: response.errorMessage });
				return undefined;
			}
			const reply = replyText(response.content);
			const summary = normalizeStepSummary(obfuscator ? obfuscator.deobfuscate(reply) : reply);
			if (!summary) return undefined;
			return this.#remember(summary);
		} catch (error) {
			if (!this.#abort.signal.aborted) {
				logger.debug("step-summary: request threw", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return undefined;
		}
	}

	/** Keep a caption as context for the next ones, newest last. */
	#remember(summary: string): string {
		this.#recent.push(summary);
		if (this.#recent.length > RECENT_SUMMARIES) this.#recent.shift();
		return summary;
	}

	dispose(): void {
		this.#abort.abort();
	}
}

/** Marker tone for a step: `error` when every tool call failed, `warning` when some did, else none. */
export function stepSummaryTone(toolResults: readonly ToolResultMessage[]): StepSummaryTone | undefined {
	const failed = toolResults.filter(result => result.isError).length;
	if (failed === 0) return undefined;
	return failed === toolResults.length ? "error" : "warning";
}

/** Persisted captions by assistant-message timestamp, for transcript replay. */
export function stepSummariesFromEntries(
	entries: readonly { type: string; customType?: string; data?: unknown }[],
): Map<number, StepSummary> {
	const summaries = new Map<number, StepSummary>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== STEP_SUMMARY_CUSTOM_TYPE) continue;
		const data = entry.data;
		if (!isRecord(data)) continue;
		const { messageTimestamp, summary, tone } = data;
		if (typeof messageTimestamp === "number" && typeof summary === "string" && summary) {
			summaries.set(
				messageTimestamp,
				tone === "warning" || tone === "error" ? { text: summary, tone } : { text: summary },
			);
		}
	}
	return summaries;
}
