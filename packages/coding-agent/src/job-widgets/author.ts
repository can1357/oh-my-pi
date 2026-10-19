/**
 * The cheap-model side of job widgets: one toolless request to the `widget`
 * role (aliasing `smol`) with a forced `respond` call carrying the spec
 * schema, fed the job's brief and redacted output samples.
 */
import { type AgentTelemetryConfig, instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model, UserMessage } from "@oh-my-pi/pi-ai";
import { markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { roleDefaultModels } from "@oh-my-pi/pi-catalog/compat/behavior";
import { formatBytes, prompt, truncate } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { getModelMatchPreferences, parseModelPattern, resolveModelRoleValue } from "../config/model-resolver";
import { formatModelRoleAlias } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";
import systemPrompt from "../prompts/system/job-widget-system.md" with { type: "text" };
import userPrompt from "../prompts/system/job-widget-user.md" with { type: "text" };
import { CREDENTIAL_PATTERNS } from "../secrets/patterns";
import type { JobWidgetSourceSample } from "./runtime";
import { JOB_WIDGET_SPEC_SCHEMA, type JobWidgetSpec } from "./spec";
import type { JobWidgetBrief } from "./types";

/** What the author is asked to write a spec for. */
export interface JobWidgetAuthorRequest {
	jobId: string;
	brief: JobWidgetBrief;
	/** Per source: first and last lines, most active first; raw (the author redacts). */
	sources: readonly JobWidgetSourceSample[];
	/** Re-authoring: the spec in place and why it is being replaced (`no rule matched the last 200 lines`). */
	previous?: { spec: JobWidgetSpec; reason: string };
	/** Retry: the rejected answer and what was wrong with it. */
	rejected?: { answer: string; errors: string[] };
}

/**
 * Writes one candidate spec (unvalidated; the registry validates and retries
 * once). Resolves `undefined` when no model can write specs at all, which
 * stops further requests for the job.
 */
export type JobWidgetAuthor = (request: JobWidgetAuthorRequest, signal: AbortSignal) => Promise<unknown>;

const RESPOND_TOOL = "respond";
const MAX_BRIEF_CHARS = 1500;
const MAX_SAMPLE_LINE_CHARS = 300;
const MAX_SAMPLE_BYTES = 12 * 1024;
/** Lines of one shape (same text but for its digits and spacing) the head, and the tail, of a source keep. */
const MAX_SHAPE_REPEATS = 3;
/** Output cap of a spec request: the largest valid spec stays well under it, a runaway answer does not. */
const MAX_SPEC_TOKENS = 3000;

const CREDENTIAL_REGEXES = CREDENTIAL_PATTERNS.map(pattern => ({
	name: pattern.name,
	regex: new RegExp(pattern.source, `g${pattern.flags ?? ""}`),
}));

/**
 * Text bound for the author model with secrets removed: the session's secret
 * obfuscator when it has secrets, then the built-in credential shapes
 * (`[GitHubToken redacted]`), which apply even with secret handling off.
 */
export function redactWidgetSample(text: string, obfuscate?: (text: string) => string): string {
	let out = obfuscate ? obfuscate(text) : text;
	for (const { name, regex } of CREDENTIAL_REGEXES) {
		regex.lastIndex = 0;
		if (regex.test(out)) out = out.replace(regex, `[${name} redacted]`);
	}
	return out;
}

/** Template context of `job-widget-user.md`. */
interface PromptSource {
	id: string;
	label: string;
	size: string;
	lines: number;
	omitted: number;
	head: string[];
	tail: string[];
}

/**
 * Sample lines for the prompt: each line redacted and cut at 300 chars, the
 * first lines then the last per source, most active source first, ≤ 12 KB in
 * total with every source getting a fair share of what is left. The head and
 * the tail each keep at most three lines of one shape (a progress line
 * repeating with new numbers), so a busy source shows its distinct lines
 * rather than one line many times. Lines that would open or close the
 * prompt's code fence are left out.
 */
export function buildPromptSources(
	sources: readonly JobWidgetSourceSample[],
	redact: (text: string) => string,
): PromptSource[] {
	let budget = MAX_SAMPLE_BYTES;
	return sources.map((source, index) => {
		const share = Math.floor(budget / (sources.length - index));
		const take = (lines: readonly string[], limit: number): string[] => {
			const out: string[] = [];
			const shapes = new Map<string, number>();
			let used = 0;
			for (const line of lines) {
				const trimmed = line.trimStart();
				if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) continue;
				const shape = trimmed.replace(/\d+/g, "0").replace(/\s+/g, " ");
				const repeats = shapes.get(shape) ?? 0;
				if (repeats >= MAX_SHAPE_REPEATS) continue;
				shapes.set(shape, repeats + 1);
				const sample = truncate(redact(line), MAX_SAMPLE_LINE_CHARS);
				const bytes = Buffer.byteLength(sample) + 1;
				if (used + bytes > limit) break;
				used += bytes;
				out.push(sample);
			}
			budget -= used;
			return out;
		};
		// The newest lines show what the job prints now (and what drifted); they get two thirds of the
		// share first, newest backwards, and the first lines get what is left.
		const tail = take(
			source.tail.slice().reverse(),
			source.head.length > 0 ? Math.floor((share * 2) / 3) : share,
		).reverse();
		const tailBytes = tail.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
		const head = take(source.head, share - tailBytes);
		return {
			id: source.id,
			label: redact(source.label),
			size: formatBytes(source.size),
			lines: source.lines,
			omitted: Math.max(0, source.lines - head.length - tail.length),
			head,
			tail,
		};
	});
}

/** The `job-widget-user.md` prompt for a request. */
export function renderJobWidgetPrompt(request: JobWidgetAuthorRequest, redact: (text: string) => string): string {
	const { brief } = request;
	const excerpt = (text: string | undefined): string | undefined =>
		text?.trim() ? truncate(redact(text.trim()), MAX_BRIEF_CHARS) : undefined;
	return prompt.render(userPrompt, {
		command: excerpt(brief.command),
		task: excerpt(brief.task),
		intent: excerpt(brief.intent),
		watch: excerpt(brief.watch),
		stage: excerpt(brief.stage),
		sources: buildPromptSources(request.sources, redact),
		previous: request.previous && {
			reason: request.previous.reason,
			spec: JSON.stringify(request.previous.spec),
		},
		rejected: request.rejected && {
			answer: truncate(redact(request.rejected.answer), 4000),
			errors: request.rejected.errors,
		},
	});
}

export interface ModelJobWidgetAuthorOptions {
	settings: Settings;
	modelRegistry: ModelRegistry;
	/** The root session id, for session-sticky credentials and telemetry. */
	sessionId: () => string | undefined;
	telemetry?: () => AgentTelemetryConfig | undefined;
	/** The session's secret obfuscation, when secret handling is on. */
	obfuscate?: () => ((text: string) => string) | undefined;
	/** Each completed request's assistant message, for usage accounting (purpose `job-widget`). */
	onUsage?: (message: AssistantMessage) => void;
}

/**
 * The `widget` role's model with a usable credential: the role (configured,
 * or resolved like `smol`), then the built-in `smol` defaults.
 */
async function resolveWidgetModel(
	settings: Settings,
	registry: ModelRegistry,
	sessionId: string | undefined,
	signal: AbortSignal,
): Promise<Model<Api> | undefined> {
	const available = registry.getAvailable();
	const matchPreferences = getModelMatchPreferences(settings);
	const candidates: Model<Api>[] = [];
	const role = resolveModelRoleValue(formatModelRoleAlias("widget"), available, { settings, matchPreferences }).model;
	if (role) candidates.push(role);
	for (const pattern of roleDefaultModels().smol ?? []) {
		const model = parseModelPattern(pattern, available, matchPreferences).model;
		if (model) candidates.push(model);
	}
	for (const model of candidates) {
		if (await registry.getApiKey(model, sessionId, { signal })) return model;
	}
	return undefined;
}

/** A {@link JobWidgetAuthor} backed by the `widget` model role. */
export function createModelJobWidgetAuthor(options: ModelJobWidgetAuthorOptions): JobWidgetAuthor {
	return async (request, signal) => {
		const sessionId = options.sessionId();
		const model = await resolveWidgetModel(options.settings, options.modelRegistry, sessionId, signal);
		if (!model) return undefined;
		const obfuscate = options.obfuscate?.();
		const redact = (text: string): string => redactWidgetSample(text, obfuscate);
		const message: UserMessage = {
			role: "user",
			content: [{ type: "text", text: renderJobWidgetPrompt(request, redact) }],
			timestamp: Date.now(),
		};
		// The system prompt and schema are the reusable prefix (cached by the provider). The job's
		// samples never repeat, so a cache breakpoint on them would only bill a cache write.
		markPerCallContextMessage(message);
		const response = await instrumentedCompleteSimple(
			model,
			{
				systemPrompt: [systemPrompt],
				messages: [message],
				tools: [
					{
						name: RESPOND_TOOL,
						description: "Install the widget spec for this job.",
						parameters: JOB_WIDGET_SPEC_SCHEMA,
						strict: false,
					},
				],
			},
			{
				apiKey: options.modelRegistry.resolver(model, sessionId),
				signal,
				// Spec writing is formatting work; a forced tool call also rules out thinking on some providers.
				disableReasoning: true,
				maxTokens: MAX_SPEC_TOKENS,
				toolChoice: { type: "tool", name: RESPOND_TOOL },
			},
			{ telemetry: resolveTelemetry(options.telemetry?.(), sessionId), oneshotKind: "job_widget" },
		);
		options.onUsage?.(response);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(response.errorMessage ?? `widget spec request ${response.stopReason}`);
		}
		const call = extractToolCall(response, RESPOND_TOOL);
		if (call) return call.arguments;
		const text = extractTextContent(response);
		if (!text) throw new Error("widget spec request returned nothing");
		return parseJsonPayload(text);
	};
}
