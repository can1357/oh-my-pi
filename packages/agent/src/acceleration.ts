import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
} from "@pk-nerdsaver-ai/pi-ai";
import { AssistantMessageEventStream } from "@pk-nerdsaver-ai/pi-ai/utils/event-stream";
import { logger, prompt } from "@pk-nerdsaver-ai/pi-utils";
import lookaheadPlannerPrompt from "./prompts/acceleration-lookahead-planner.md" with { type: "text" };
import lookaheadTargetContextPrompt from "./prompts/acceleration-lookahead-target-context.md" with { type: "text" };
import lookaheadVerifierPrompt from "./prompts/acceleration-lookahead-verifier.md" with { type: "text" };
import type { StreamFn } from "./types";

export const ACCELERATION_MODES = ["baseline", "token_speculative", "lookahead_reasoning", "combined"] as const;
export type AccelerationMode = (typeof ACCELERATION_MODES)[number];

export interface AccelerationConfig {
	enabled: boolean;
	mode: AccelerationMode;
	draft_model?: string;
	target_model?: string;
	verifier_model?: string;
	gamma_initial: number;
	gamma_min: number;
	gamma_max: number;
	acceptance_rate_increase_threshold: number;
	acceptance_rate_decrease_threshold: number;
	lookahead_steps_initial: number;
	lookahead_steps_max: number;
	enable_streaming: boolean;
	enable_batch_verification: boolean;
	fallback_to_baseline_on_error: boolean;
	force_lookahead: boolean;
}

export interface DraftToken {
	text: string;
}

export interface TokenVerificationResult {
	acceptedTokens: DraftToken[];
	rejectedTokens: DraftToken[];
	exact: boolean;
}

export interface DraftModel {
	model: Model<Api>;
	generateDraftTokens(input: DraftTokenInput): Promise<DraftToken[]>;
}

export interface TargetModel {
	model: Model<Api>;
	generate(input: TargetGenerationInput): AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
}

export interface Verifier {
	model: Model<Api>;
	verifyDraftTokens?(input: DraftTokenVerificationInput): Promise<TokenVerificationResult>;
	verifyLookaheadSteps?(input: LookaheadVerificationInput): Promise<LookaheadVerificationResult>;
}

export interface DraftTokenInput {
	context: Context;
	gamma: number;
	options: SimpleStreamOptions;
}

export interface TargetGenerationInput {
	context: Context;
	options: SimpleStreamOptions;
}

export interface DraftTokenVerificationInput {
	context: Context;
	draftTokens: readonly DraftToken[];
	options: SimpleStreamOptions;
}

export interface SpeculativeDecodeResult {
	message: AssistantMessage;
	acceptedTokens: number;
	rejectedTokens: number;
	passes: number;
	acceptanceRate: number;
}

export interface LookaheadStep {
	step_id: number;
	intent: string;
	expected_state_change: string;
	dependencies: number[];
}

export interface LookaheadVerificationInput {
	context: Context;
	steps: readonly LookaheadStep[];
	acceptedSteps: readonly LookaheadStep[];
	options: SimpleStreamOptions;
}

export interface LookaheadVerificationResult {
	accepted: LookaheadStep[];
	rejected: LookaheadStep[];
}

export interface AccelerationTelemetry {
	mode: AccelerationMode;
	totalLatencyMs: number;
	timeToFirstTokenMs?: number;
	tokensPerSecond?: number;
	draftModelLatencyMs: number;
	targetModelLatencyMs: number;
	verifierLatencyMs: number;
	speculativeAcceptanceRate: number;
	averageAcceptedTokensPerPass: number;
	rejectedTokens: number;
	lookaheadStepsProposed: number;
	lookaheadStepsAccepted: number;
	lookaheadStepsRejected: number;
	fallbackCount: number;
	costEstimate?: number;
	notes: string[];
}

export interface AccelerationStreamDeps {
	baseStream: StreamFn;
	config: AccelerationConfig;
	draftModel?: Model<Api>;
	verifierModel?: Model<Api>;
	getApiKey?: (
		model: Model<Api>,
		signal?: AbortSignal,
	) => SimpleStreamOptions["apiKey"] | Promise<SimpleStreamOptions["apiKey"]>;
	onTelemetry?: (telemetry: AccelerationTelemetry) => void;
	now?: () => number;
}

export const DEFAULT_ACCELERATION_CONFIG: AccelerationConfig = {
	enabled: false,
	mode: "baseline",
	gamma_initial: 4,
	gamma_min: 1,
	gamma_max: 8,
	acceptance_rate_increase_threshold: 0.75,
	acceptance_rate_decrease_threshold: 0.55,
	lookahead_steps_initial: 3,
	lookahead_steps_max: 5,
	enable_streaming: true,
	enable_batch_verification: true,
	fallback_to_baseline_on_error: true,
	force_lookahead: false,
};

const ZERO_TELEMETRY: AccelerationTelemetry = {
	mode: "baseline",
	totalLatencyMs: 0,
	draftModelLatencyMs: 0,
	targetModelLatencyMs: 0,
	verifierLatencyMs: 0,
	speculativeAcceptanceRate: 0,
	averageAcceptedTokensPerPass: 0,
	rejectedTokens: 0,
	lookaheadStepsProposed: 0,
	lookaheadStepsAccepted: 0,
	lookaheadStepsRejected: 0,
	fallbackCount: 0,
	notes: [],
};

interface TimedTextResult {
	text: string;
	message: AssistantMessage;
	latencyMs: number;
	ttftMs?: number;
}

interface AccelerationRunContext {
	requestedMode: AccelerationMode;
	context: Context;
	model: Model<Api>;
	options: SimpleStreamOptions;
	startedAt: number;
	telemetry: AccelerationTelemetry;
}

export function normalizeAccelerationConfig(input: Partial<AccelerationConfig> | undefined): AccelerationConfig {
	const merged = { ...DEFAULT_ACCELERATION_CONFIG, ...input };
	const gammaMin = positiveInt(merged.gamma_min, DEFAULT_ACCELERATION_CONFIG.gamma_min);
	const gammaMax = Math.max(gammaMin, positiveInt(merged.gamma_max, DEFAULT_ACCELERATION_CONFIG.gamma_max));
	const gammaInitial = clampInt(merged.gamma_initial, gammaMin, gammaMax);
	const lookaheadMax = positiveInt(merged.lookahead_steps_max, DEFAULT_ACCELERATION_CONFIG.lookahead_steps_max);
	return {
		...merged,
		mode: ACCELERATION_MODES.includes(merged.mode) ? merged.mode : "baseline",
		gamma_min: gammaMin,
		gamma_max: gammaMax,
		gamma_initial: gammaInitial,
		acceptance_rate_increase_threshold: clampNumber(
			merged.acceptance_rate_increase_threshold,
			0,
			1,
			DEFAULT_ACCELERATION_CONFIG.acceptance_rate_increase_threshold,
		),
		acceptance_rate_decrease_threshold: clampNumber(
			merged.acceptance_rate_decrease_threshold,
			0,
			1,
			DEFAULT_ACCELERATION_CONFIG.acceptance_rate_decrease_threshold,
		),
		lookahead_steps_max: lookaheadMax,
		lookahead_steps_initial: clampInt(merged.lookahead_steps_initial, 1, lookaheadMax),
	};
}

export function updateAdaptiveGamma(current: number, acceptanceRate: number, config: AccelerationConfig): number {
	if (acceptanceRate >= config.acceptance_rate_increase_threshold) return Math.min(config.gamma_max, current + 1);
	if (acceptanceRate <= config.acceptance_rate_decrease_threshold) return Math.max(config.gamma_min, current - 1);
	return current;
}

export function shouldUseLookaheadReasoning(
	context: Context,
	config: Pick<AccelerationConfig, "force_lookahead">,
): boolean {
	if (config.force_lookahead) return true;
	const promptText = latestUserText(context).toLowerCase();
	if (promptText.length > 1200) return true;
	const markers = [
		"reason",
		"prove",
		"derive",
		"math",
		"plan",
		"multi-step",
		"debug",
		"architecture",
		"design",
		"implement",
		"analyze",
		"compare",
	];
	return markers.some(marker => promptText.includes(marker));
}

export function createAccelerationStreamFn(deps: AccelerationStreamDeps): StreamFn {
	const config = normalizeAccelerationConfig(deps.config);
	if (!config.enabled || config.mode === "baseline") return deps.baseStream;
	return (model, context, options) => {
		const out = new AssistantMessageEventStream();
		void runAcceleratedStream(out, deps, config, model, context, options ?? {});
		return out;
	};
}

export class SpeculativeDecoder {
	#target: TargetModel;
	#verifier?: Verifier;

	constructor(args: { target: TargetModel; verifier?: Verifier; config: AccelerationConfig }) {
		this.#target = args.target;
		this.#verifier = args.verifier;
		void args.config;
	}

	async decode(input: {
		context: Context;
		draftTokens: readonly DraftToken[];
		options: SimpleStreamOptions;
	}): Promise<SpeculativeDecodeResult> {
		const verification = await this.#verifier?.verifyDraftTokens?.({
			context: input.context,
			draftTokens: input.draftTokens,
			options: input.options,
		});
		if (!verification?.exact) {
			throw new Error("Exact token verification is unavailable for this backend");
		}
		const acceptedTokens = verification.acceptedTokens.length;
		const rejectedTokens = verification.rejectedTokens.length;
		const acceptanceRate = input.draftTokens.length === 0 ? 0 : acceptedTokens / input.draftTokens.length;
		const stream = await this.#target.generate({ context: input.context, options: input.options });
		const message = await stream.result();
		return { message, acceptedTokens, rejectedTokens, passes: 1, acceptanceRate };
	}
}

export class LookaheadPlanner {
	#draftModel: Model<Api>;
	#stream: StreamFn;
	#getApiKey?: AccelerationStreamDeps["getApiKey"];
	#now: () => number;

	constructor(args: {
		draftModel: Model<Api>;
		stream: StreamFn;
		getApiKey?: AccelerationStreamDeps["getApiKey"];
		now: () => number;
	}) {
		this.#draftModel = args.draftModel;
		this.#stream = args.stream;
		this.#getApiKey = args.getApiKey;
		this.#now = args.now;
	}

	async propose(
		context: Context,
		options: SimpleStreamOptions,
		stepCount: number,
	): Promise<{ steps: LookaheadStep[]; latencyMs: number }> {
		const plannerContext: Context = {
			systemPrompt: [prompt.render(lookaheadPlannerPrompt, { stepCount })],
			messages: context.messages,
			tools: [],
		};
		const result = await runModelToText(
			this.#stream,
			this.#draftModel,
			plannerContext,
			{
				...options,
				apiKey: await this.#getApiKey?.(this.#draftModel, options.signal),
				toolChoice: "none",
				maxTokens: Math.min(options.maxTokens ?? 512, 512),
			},
			this.#now,
		);
		return { steps: parseLookaheadSteps(result.text), latencyMs: result.latencyMs };
	}
}

export class LookaheadVerifier {
	#model: Model<Api>;
	#stream: StreamFn;
	#getApiKey?: AccelerationStreamDeps["getApiKey"];
	#now: () => number;

	constructor(args: {
		model: Model<Api>;
		stream: StreamFn;
		getApiKey?: AccelerationStreamDeps["getApiKey"];
		now: () => number;
	}) {
		this.#model = args.model;
		this.#stream = args.stream;
		this.#getApiKey = args.getApiKey;
		this.#now = args.now;
	}

	async verify(input: LookaheadVerificationInput): Promise<LookaheadVerificationResult & { latencyMs: number }> {
		const verifierContext: Context = {
			systemPrompt: [
				prompt.render(lookaheadVerifierPrompt, {
					stepsJson: JSON.stringify(input.steps),
					acceptedStepsJson: JSON.stringify(input.acceptedSteps),
				}),
			],
			messages: input.context.messages,
			tools: [],
		};
		const result = await runModelToText(
			this.#stream,
			this.#model,
			verifierContext,
			{
				...input.options,
				apiKey: await this.#getApiKey?.(this.#model, input.options.signal),
				toolChoice: "none",
				maxTokens: Math.min(input.options.maxTokens ?? 512, 512),
			},
			this.#now,
		);
		return { ...parseLookaheadVerification(result.text, input.steps), latencyMs: result.latencyMs };
	}
}

export class AccelerationOrchestrator {
	#deps: AccelerationStreamDeps;
	#config: AccelerationConfig;
	#now: () => number;

	constructor(deps: AccelerationStreamDeps) {
		this.#deps = deps;
		this.#config = normalizeAccelerationConfig(deps.config);
		this.#now = deps.now ?? Date.now;
	}

	async run(model: Model<Api>, context: Context, options: SimpleStreamOptions): Promise<AssistantMessageEventStream> {
		const out = new AssistantMessageEventStream();
		void runAcceleratedStream(out, this.#deps, this.#config, model, context, options, this.#now);
		return out;
	}
}

async function runAcceleratedStream(
	out: AssistantMessageEventStream,
	deps: AccelerationStreamDeps,
	config: AccelerationConfig,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions,
	now: () => number = deps.now ?? Date.now,
): Promise<void> {
	const run: AccelerationRunContext = {
		requestedMode: config.mode,
		context,
		model,
		options,
		startedAt: now(),
		telemetry: { ...ZERO_TELEMETRY, mode: config.mode, notes: [] },
	};
	if (!config.enabled || config.mode === "baseline") {
		await pipeBaseline(out, deps, run, now, "baseline mode");
		return;
	}
	try {
		if (config.mode === "token_speculative") {
			await runTokenSpeculative(out, deps, run, now);
		} else if (config.mode === "lookahead_reasoning") {
			await runLookahead(out, deps, config, run, now, false);
		} else if (config.mode === "combined") {
			await runLookahead(out, deps, config, run, now, true);
		} else {
			await pipeBaseline(out, deps, run, now, "baseline mode");
		}
	} catch (error) {
		if (!config.fallback_to_baseline_on_error) {
			out.fail(error);
			return;
		}
		run.telemetry.fallbackCount += 1;
		run.telemetry.notes.push(`fallback_after_error:${error instanceof Error ? error.message : String(error)}`);
		await pipeBaseline(out, deps, run, now, "fallback after acceleration error");
	}
}

async function runTokenSpeculative(
	out: AssistantMessageEventStream,
	deps: AccelerationStreamDeps,
	run: AccelerationRunContext,
	now: () => number,
): Promise<void> {
	// No provider in this repo exposes target next-token verification/logprobs.
	// Without verification, we cannot preserve target-quality semantics, so
	// always fall back to baseline. Re-introduce a draft+verify path when a
	// provider with next-token logprobs becomes available.
	run.telemetry.notes.push("token_speculative_disabled_no_next_token_verification");
	run.telemetry.speculativeAcceptanceRate = 0;
	run.telemetry.averageAcceptedTokensPerPass = 0;
	run.telemetry.rejectedTokens = 0;
	await pipeBaseline(out, deps, run, now, "token verification unavailable; falling back to baseline");
}

async function runLookahead(
	out: AssistantMessageEventStream,
	deps: AccelerationStreamDeps,
	config: AccelerationConfig,
	run: AccelerationRunContext,
	now: () => number,
	useTokenSpeculationInside: boolean,
): Promise<void> {
	if (!shouldUseLookaheadReasoning(run.context, config)) {
		await pipeBaseline(out, deps, run, now, "lookahead gate declined");
		return;
	}
	if (!deps.draftModel) {
		await pipeBaseline(out, deps, run, now, "missing lookahead draft model");
		return;
	}
	const verifierModel = deps.verifierModel ?? run.model;
	const planner = new LookaheadPlanner({
		draftModel: deps.draftModel,
		stream: deps.baseStream,
		getApiKey: deps.getApiKey,
		now,
	});
	const verifier = new LookaheadVerifier({
		model: verifierModel,
		stream: deps.baseStream,
		getApiKey: deps.getApiKey,
		now,
	});
	const proposed = await planner.propose(run.context, run.options, config.lookahead_steps_initial);
	run.telemetry.draftModelLatencyMs += proposed.latencyMs;
	run.telemetry.lookaheadStepsProposed += proposed.steps.length;
	if (proposed.steps.length === 0) {
		await pipeBaseline(out, deps, run, now, "lookahead planner returned no steps");
		return;
	}
	const verified = await verifier.verify({
		context: run.context,
		steps: proposed.steps,
		acceptedSteps: [],
		options: run.options,
	});
	run.telemetry.verifierLatencyMs += verified.latencyMs;
	run.telemetry.lookaheadStepsAccepted += verified.accepted.length;
	run.telemetry.lookaheadStepsRejected += verified.rejected.length;
	if (verified.accepted.length === 0) {
		await pipeBaseline(out, deps, run, now, "lookahead verifier rejected all steps");
		return;
	}
	const augmentedContext = appendDeveloperMessage(
		run.context,
		prompt.render(lookaheadTargetContextPrompt, { stepsJson: JSON.stringify(verified.accepted) }),
	);
	if (useTokenSpeculationInside) {
		run.telemetry.notes.push("combined_token_layer_fell_back_exact_verification_unavailable");
	}
	await pipeTarget(out, deps, { ...run, context: augmentedContext }, now);
}

async function pipeBaseline(
	out: AssistantMessageEventStream,
	deps: AccelerationStreamDeps,
	run: AccelerationRunContext,
	now: () => number,
	note: string,
): Promise<void> {
	run.telemetry.fallbackCount += run.requestedMode === "baseline" ? 0 : 1;
	run.telemetry.notes.push(note);
	await pipeTarget(out, deps, run, now);
}

async function pipeTarget(
	out: AssistantMessageEventStream,
	deps: AccelerationStreamDeps,
	run: AccelerationRunContext,
	now: () => number,
): Promise<void> {
	const targetStartedAt = now();
	let ttftMs: number | undefined;
	let finalMessage: AssistantMessage | undefined;
	const stream = await deps.baseStream(run.model, run.context, run.options);
	try {
		for await (const event of stream) {
			if (ttftMs === undefined && isFirstVisibleTokenEvent(event)) ttftMs = now() - run.startedAt;
			if (event.type === "done") finalMessage = event.message;
			if (event.type === "error") finalMessage = event.error;
			out.push(event);
		}
		if (!finalMessage) finalMessage = await stream.result();
		run.telemetry.targetModelLatencyMs += now() - targetStartedAt;
		finishTelemetry(run, finalMessage, ttftMs, now);
		deps.onTelemetry?.(run.telemetry);
		logger.debug("Acceleration telemetry", { ...run.telemetry });
	} catch (error) {
		out.fail(error);
	}
}

async function runModelToText(
	streamFn: StreamFn,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions,
	now: () => number,
): Promise<TimedTextResult> {
	const startedAt = now();
	let ttftMs: number | undefined;
	let text = "";
	const stream = await streamFn(model, context, options);
	for await (const event of stream) {
		if (event.type === "text_delta") {
			if (ttftMs === undefined) ttftMs = now() - startedAt;
			text += event.delta;
		}
	}
	const message = await stream.result();
	return { text: text || assistantText(message), message, latencyMs: now() - startedAt, ttftMs };
}

function finishTelemetry(
	run: AccelerationRunContext,
	message: AssistantMessage,
	ttftMs: number | undefined,
	now: () => number,
): void {
	run.telemetry.totalLatencyMs = now() - run.startedAt;
	if (ttftMs !== undefined) run.telemetry.timeToFirstTokenMs = ttftMs;
	const outputTokens = message.usage.output || estimateTokens(assistantText(message));
	if (run.telemetry.totalLatencyMs > 0)
		run.telemetry.tokensPerSecond = outputTokens / (run.telemetry.totalLatencyMs / 1000);
	const cost = message.usage.cost?.total;
	if (typeof cost === "number") run.telemetry.costEstimate = cost;
}

function isFirstVisibleTokenEvent(event: AssistantMessageEvent): boolean {
	return event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta";
}

function appendDeveloperMessage(context: Context, content: string): Context {
	const message: Message = { role: "developer", content, attribution: "agent", timestamp: Date.now() };
	return { ...context, messages: [...context.messages, message] };
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((item): item is TextContent => item.type === "text")
		.map(item => item.text)
		.join("");
}

function latestUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((item): item is TextContent => item.type === "text")
			.map(item => item.text)
			.join("\n");
	}
	return "";
}

function parseLookaheadSteps(text: string): LookaheadStep[] {
	const parsed = parseJsonPayload(text);
	const rawSteps = Array.isArray(parsed)
		? parsed
		: isRecord(parsed) && Array.isArray(parsed.steps)
			? parsed.steps
			: [];
	return rawSteps
		.map((step, index) => normalizeStep(step, index + 1))
		.filter((step): step is LookaheadStep => step !== undefined);
}

function parseLookaheadVerification(
	text: string,
	candidateSteps: readonly LookaheadStep[],
): LookaheadVerificationResult {
	const parsed = parseJsonPayload(text);
	const acceptedIds = new Set<number>(
		isRecord(parsed) && Array.isArray(parsed.accepted_step_ids)
			? parsed.accepted_step_ids.filter((id): id is number => typeof id === "number")
			: [],
	);
	const rejectedIds = new Set<number>(
		isRecord(parsed) && Array.isArray(parsed.rejected_step_ids)
			? parsed.rejected_step_ids.filter((id): id is number => typeof id === "number")
			: [],
	);
	const accepted = candidateSteps.filter(step => acceptedIds.has(step.step_id) && !rejectedIds.has(step.step_id));
	const rejected = candidateSteps.filter(step => !acceptedIds.has(step.step_id) || rejectedIds.has(step.step_id));
	return { accepted, rejected };
}

function normalizeStep(value: unknown, fallbackId: number): LookaheadStep | undefined {
	if (!isRecord(value)) return undefined;
	const stepId = typeof value.step_id === "number" ? value.step_id : fallbackId;
	const intent = typeof value.intent === "string" ? value.intent.trim() : "";
	const expected = typeof value.expected_state_change === "string" ? value.expected_state_change.trim() : "";
	const dependencies = Array.isArray(value.dependencies)
		? value.dependencies.filter((item): item is number => typeof item === "number")
		: [];
	if (!intent || !expected) return undefined;
	return { step_id: stepId, intent, expected_state_change: expected, dependencies };
}

function parseJsonPayload(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	return tryJsonParse(trimmed) ?? extractJsonSlice(trimmed, "{", "}") ?? extractJsonSlice(trimmed, "[", "]");
}

function tryJsonParse(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

function extractJsonSlice(text: string, openChar: string, closeChar: string): unknown {
	const start = text.indexOf(openChar);
	const end = text.lastIndexOf(closeChar);
	if (start === -1 || end <= start) return undefined;
	return tryJsonParse(text.slice(start, end + 1));
}

function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf-8") / 4));
}

function positiveInt(value: number, fallback: number): number {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function clampInt(value: number, min: number, max: number): number {
	const normalized = Number.isFinite(value) ? Math.floor(value) : min;
	return Math.max(min, Math.min(max, normalized));
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
	return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
