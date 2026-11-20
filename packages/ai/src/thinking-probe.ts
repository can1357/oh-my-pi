import { Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { clampThinkingLevelForModel, withoutUnverifiedThinking } from "@oh-my-pi/pi-catalog/model-thinking";
import {
	applyThinkingCapability,
	readThinkingCapability,
	type ThinkingCapability,
	type ThinkingProbeAttempt,
	type ThinkingProbeFormat,
	writeThinkingCapability,
} from "@oh-my-pi/pi-catalog/thinking-capability";
import { $env, logger, untilAborted } from "@oh-my-pi/pi-utils";
import * as AIError from "./error";
import prompt from "./prompts/thinking-probe.md" with { type: "text" };
import type { Api, Context, FetchImpl, Model, SimpleStreamOptions } from "./types";
import { AssistantMessageEventStream } from "./utils/event-stream";

const PROBE_TIMEOUT_MS = 45_000;
const PROBE_OUTPUT_TOKENS = 1024;
const TOGGLE_FORMATS: Partial<Record<ThinkingProbeFormat, true>> = {
	zai: true,
	qwen: true,
	"qwen-chat-template": true,
};

type RunRequest<TApi extends Api> = (
	model: Model<TApi>,
	context: Context,
	options: SimpleStreamOptions,
) => AssistantMessageEventStream;

interface ProbeFlight {
	controller: AbortController;
	promise: Promise<ThinkingCapability>;
	waiters: number;
}

const flights = new Map<string, ProbeFlight>();

function formatBatches(api: Api): readonly (readonly ThinkingProbeFormat[])[] {
	switch (api) {
		case "openai-completions":
			return [["openai"], ["openrouter", "zai", "qwen", "qwen-chat-template", "chat-template"]];
		case "openrouter":
			return $env.PI_OPENROUTER_RESPONSES === "0"
				? [["openai"], ["openrouter", "zai", "qwen", "qwen-chat-template", "chat-template"]]
				: [["responses"]];
		case "openai-responses":
		case "azure-openai-responses":
			return [["responses"]];
		case "anthropic-messages":
			return [["anthropic-adaptive"], ["anthropic-budget"]];
		case "google-generative-ai":
		case "google-vertex":
		case "google-gemini-cli":
			return [["google-level"], ["google-budget"]];
		default:
			return [];
	}
}

function hypothesis(format: ThinkingProbeFormat): ThinkingCapability {
	return {
		checkedAt: Date.now(),
		format,
		efforts: TOGGLE_FORMATS[format] ? [Effort.High] : THINKING_EFFORTS,
		observed: false,
		attempts: [],
	};
}

async function probeAttempt<TApi extends Api>(
	model: Model<TApi>,
	format: ThinkingProbeFormat,
	effort: Effort | undefined,
	options: SimpleStreamOptions,
	run: RunRequest<TApi>,
): Promise<ThinkingProbeAttempt | undefined> {
	const controller = new AbortController();
	const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
	const signal = AbortSignal.any([controller.signal, timeout, ...(options.signal ? [options.signal] : [])]);
	const candidate =
		format === "none" ? withoutUnverifiedThinking(model) : applyThinkingCapability(model, hypothesis(format));
	let responseStatus: number | undefined;
	let payloadCount = 0;
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const probeFetch: FetchImpl = async (input, init) => {
		// Validation retries would turn a rejected tier into a false positive.
		// Stop the adapter after its first rejected HTTP request; classification
		// below uses the original status, not the resulting local abort.
		const response = await fetchImpl(input, init);
		responseStatus = response.status;
		if (!response.ok) controller.abort();
		return response;
	};
	const context: Context = { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] };
	try {
		const result = await run(candidate, context, {
			apiKey: options.apiKey,
			credentialId: options.credentialId,
			oauthIdentity: options.oauthIdentity,
			headers: options.headers,
			fetch: probeFetch,
			signal,
			reasoning: format === "none" ? undefined : (effort ?? Effort.High),
			maxTokens: PROBE_OUTPUT_TOKENS,
			maxHttpAttempts: 1,
			maxRetryDelayMs: 0,
			maxInFlightRequests: options.maxInFlightRequests,
			beforeDispatch: options.beforeDispatch,
			streamFirstEventTimeoutMs: PROBE_TIMEOUT_MS,
			streamIdleTimeoutMs: PROBE_TIMEOUT_MS,
			cacheRetention: "none",
			statefulResponses: false,
			storeResponses: false,
			preferWebsockets: false,
			acceptEmptyResponse: true,
			loopGuard: { enabled: false },
			onPayload: () => {
				if (++payloadCount > 1) throw new Error("Thinking capability probes cannot retry");
			},
		}).result();
		options.signal?.throwIfAborted();
		if (responseStatus === 400 || responseStatus === 422) {
			return { format, effort, accepted: false, observed: false };
		}
		if (result.stopReason === "error" || result.stopReason === "aborted") return undefined;
		const observed =
			(result.usage.reasoningTokens ?? 0) > 0 ||
			result.content.some(
				block => block.type === "thinking" && (block.thinking.length > 0 || Boolean(block.thinkingSignature)),
			);
		return { format, effort, accepted: true, observed };
	} catch (error) {
		options.signal?.throwIfAborted();
		const status = responseStatus ?? AIError.status(error);
		if (status === 400 || status === 422) return { format, effort, accepted: false, observed: false };
		return undefined;
	} finally {
		controller.abort();
	}
}

function ladderComplete(
	format: ThinkingProbeFormat,
	rows: readonly ThinkingProbeAttempt[],
	effortCount: number,
): boolean {
	return rows.length === (TOGGLE_FORMATS[format] ? 1 : effortCount);
}

function capabilityFor(
	format: ThinkingProbeFormat,
	accepted: readonly ThinkingProbeAttempt[],
	attempts: readonly ThinkingProbeAttempt[],
): ThinkingCapability {
	return {
		checkedAt: Date.now(),
		format,
		efforts: TOGGLE_FORMATS[format]
			? [Effort.High]
			: THINKING_EFFORTS.filter(effort => accepted.some(attempt => attempt.effort === effort)),
		observed: accepted.some(attempt => attempt.observed),
		attempts,
	};
}

interface ProbeSelection {
	/** Present only when the chosen format and every higher-precedence format finished probing. */
	persist: ThinkingCapability | undefined;
	/** Format and efforts for this turn, avoiding rejected probes unless even the plain check was refused. */
	dispatch: ThinkingCapability;
}

async function probe<TApi extends Api>(
	model: Model<TApi>,
	options: SimpleStreamOptions,
	run: RunRequest<TApi>,
): Promise<ProbeSelection> {
	const batches = formatBatches(model.api);
	const requested = options.reasoning ?? Effort.High;
	const efforts = [requested, ...THINKING_EFFORTS.filter(effort => effort !== requested)];
	const attempts: ThinkingProbeAttempt[] = [];
	// The neutral control distinguishes unsupported thinking from a model or
	// endpoint that cannot serve even a plain request. It shares the first batch.
	let baseline: ThinkingProbeAttempt | undefined;
	for (let index = 0; index < batches.length; index++) {
		const formats = batches[index];
		if (!formats) continue;
		const probed = new Map<ThinkingProbeFormat, ThinkingProbeAttempt[]>();
		const rowsOf = (format: ThinkingProbeFormat): readonly ThinkingProbeAttempt[] => probed.get(format) ?? [];
		const jobs: { format: ThinkingProbeFormat; promise: Promise<ThinkingProbeAttempt | undefined> }[] = [];
		for (const format of formats) {
			probed.set(format, []);
			for (const effort of TOGGLE_FORMATS[format] ? [undefined] : efforts) {
				jobs.push({ format, promise: probeAttempt(model, format, effort, options, run) });
			}
		}
		if (index === 0) jobs.push({ format: "none", promise: probeAttempt(model, "none", undefined, options, run) });
		const results = await Promise.all(jobs.map(job => job.promise));
		options.signal?.throwIfAborted();
		for (let jobIndex = 0; jobIndex < jobs.length; jobIndex++) {
			const result = results[jobIndex];
			const job = jobs[jobIndex];
			if (!result || !job) continue;
			attempts.push(result);
			if (job.format === "none") baseline = result;
			else probed.get(job.format)?.push(result);
		}
		// A quota, auth, transport, or timeout failure is not a rejection, and it
		// belongs only to the format that failed. Cache a winning format only when
		// its own ladder and every preferred format ahead of it finished probing.
		let priorComplete = true;
		for (const format of formats) {
			const rows = rowsOf(format);
			const complete = ladderComplete(format, rows, efforts.length);
			const accepted = rows.filter(attempt => attempt.accepted);
			if (accepted.length > 0) {
				const capability = capabilityFor(format, accepted, attempts);
				return { persist: priorComplete && complete ? capability : undefined, dispatch: capability };
			}
			if (!complete) priorComplete = false;
		}
		// No format in this batch was accepted yet. If a format did not finish,
		// stop before later batches and dispatch its first unrejected hypothesis.
		for (const format of formats) {
			const rows = rowsOf(format);
			if (ladderComplete(format, rows, efforts.length)) continue;
			const rejected = new Set(
				rows.flatMap(attempt => (!attempt.accepted && attempt.effort !== undefined ? [attempt.effort] : [])),
			);
			if (TOGGLE_FORMATS[format] || rejected.size === 0) {
				return { persist: undefined, dispatch: { ...hypothesis(format), attempts } };
			}
			const usable = THINKING_EFFORTS.filter(effort => !rejected.has(effort));
			return {
				persist: undefined,
				dispatch: { checkedAt: Date.now(), format, efforts: usable, observed: false, attempts },
			};
		}
	}
	if (baseline?.accepted) {
		const capability: ThinkingCapability = {
			checkedAt: Date.now(),
			format: "none",
			efforts: [],
			observed: baseline.observed,
			attempts,
		};
		return { persist: capability, dispatch: capability };
	}
	// Every thinking dialect finished as a rejection. A plain check that never
	// completed is not a refusal, so send plain without saving; fall back to the
	// primary hypothesis only when the plain check was refused too.
	if (!baseline) {
		return {
			persist: undefined,
			dispatch: { checkedAt: Date.now(), format: "none", efforts: [], observed: false, attempts },
		};
	}
	const fallback = batches[0]?.[0] ?? "openai";
	return { persist: undefined, dispatch: { ...hypothesis(fallback), attempts } };
}

async function learn<TApi extends Api>(
	model: Model<TApi>,
	options: SimpleStreamOptions,
	run: RunRequest<TApi>,
): Promise<ThinkingCapability> {
	const cached = readThinkingCapability(model, options.thinkingCapabilityDbPath);
	if (cached) return cached;
	const key = JSON.stringify([
		options.thinkingCapabilityDbPath,
		model.provider,
		model.api,
		model.baseUrl,
		model.requestModelId ?? model.id,
	]);
	let flight = flights.get(key);
	if (!flight) {
		const controller = new AbortController();
		const sharedOptions = { ...options, signal: controller.signal };
		const promise = probe(model, sharedOptions, run).then(selection => {
			const capability = selection.persist;
			if (capability) {
				writeThinkingCapability(model, capability, options.thinkingCapabilityDbPath);
				logger.debug("Learned thinking capability", {
					provider: model.provider,
					model: model.id,
					format: capability.format,
					efforts: capability.efforts,
					observed: capability.observed,
				});
			}
			return selection.dispatch;
		});
		flight = { controller, promise, waiters: 0 };
		flights.set(key, flight);
		const held = flight;
		void promise
			.finally(() => {
				if (flights.get(key) === held) flights.delete(key);
			})
			.catch(() => {});
	}
	flight.waiters++;
	try {
		return await untilAborted(options.signal, () => flight.promise);
	} finally {
		if (--flight.waiters === 0) flight.controller.abort();
	}
}

/** Resolve unknown thinking controls before dispatch, keeping probe traffic out of the caller's transcript and session state. */
export function withProbedThinking<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: SimpleStreamOptions,
	run: RunRequest<TApi>,
): AssistantMessageEventStream {
	if (
		!model.thinking?.unverified ||
		options.reasoning === undefined ||
		options.disableReasoning ||
		options.forceReasoningOff ||
		model.transport === "pi-native" ||
		formatBatches(model.api).length === 0
	) {
		return run(model, context, options);
	}
	const outer = new AssistantMessageEventStream();
	void (async () => {
		try {
			const capability = await learn(model, options, run);
			options.signal?.throwIfAborted();
			// Use a format this run accepted, or the first unrejected one; fall
			// back to the primary hypothesis only if even the plain check was refused.
			const learned = applyThinkingCapability(model, capability);
			const inner = run(learned, context, {
				...options,
				reasoning: clampThinkingLevelForModel(learned, options.reasoning),
			});
			for await (const event of inner) {
				outer.push(event);
				if (outer.done) return;
			}
			if (!outer.done) outer.end(await inner.result());
		} catch (error) {
			outer.fail(error);
		}
	})();
	return outer;
}
