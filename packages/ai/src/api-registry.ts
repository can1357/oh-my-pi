/**
 * Custom API provider registry.
 *
 * Allows extensions to register streaming functions for custom API types
 * (e.g., "vertex-claude-api") that are not built into stream.ts.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
	AdmittedSignal,
	callThroughGate,
	type GatedRegistration,
	type ProviderCallGate,
	selectLiveRegistration,
} from "./auth/provider-gate";
import * as AIError from "./error";
import type { Api, AssistantMessage, Context, KnownApi, Model, SimpleStreamOptions, StreamOptions } from "./types";
import { AssistantMessageEventStream } from "./utils/event-stream";

const BUILTIN_API_IDS = [
	"openai-completions",
	"openai-responses",
	"openrouter",
	"openai-codex-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-gemini-cli",
	"google-vertex",
	"ollama-chat",
	"cursor-agent",
	"factory-droid-agent",
	"gitlab-duo-agent",
	"devin-agent",
	"apple-foundation-models",
] as const satisfies readonly KnownApi[];

type _MissingBuiltinApis = Exclude<KnownApi, (typeof BUILTIN_API_IDS)[number]>;
type _CheckBuiltinApis = _MissingBuiltinApis extends never
	? true
	: ["BUILTIN_APIS is missing KnownApi values", _MissingBuiltinApis];
true satisfies _CheckBuiltinApis;

const BUILTIN_APIS = new Set<KnownApi>(BUILTIN_API_IDS);

export type CustomStreamFn = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;
export type CustomStreamSimpleFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface RegisteredCustomApi {
	stream: CustomStreamFn;
	streamSimple: CustomStreamSimpleFn;
	sourceId?: string;
}

/** One registration of a custom API. `registered` holds the functions as they were registered;
 *  `view` is what {@link getCustomApi} hands out: `registered` itself for the host, or a record
 *  whose functions run `registered`'s as the owning session's work. */
interface CustomApiRegistration extends GatedRegistration {
	readonly registered: RegisteredCustomApi;
	readonly view: RegisteredCustomApi;
}

/** Registrations by API id, oldest first. A parent session and a subagent that rebinds its
 *  extensions register the same id; the newest live one answers. A retired registration stays
 *  until it is unregistered: retirement only stops it being selected. */
const customApiRegistry = new Map<string, CustomApiRegistration[]>();

function assertCustomApiName(api: string): void {
	if (BUILTIN_APIS.has(api as KnownApi)) {
		throw new AIError.ConfigurationError(`Cannot register custom API "${api}": built-in API names are reserved.`);
	}
}

/**
 * Register a custom API streaming function. `gate` is the lifetime of the session that registered
 * it, omitted for the host's own. Registering an API again with the same gate (or, for the host,
 * again without one) replaces that registration in place.
 */
export function registerCustomApi(
	api: string,
	streamSimple: CustomStreamSimpleFn,
	sourceId?: string,
	stream?: CustomStreamFn,
	gate?: ProviderCallGate,
): void {
	assertCustomApiName(api);
	const registered: RegisteredCustomApi = {
		stream: stream ?? ((model, context, options) => streamSimple(model, context, options as SimpleStreamOptions)),
		streamSimple,
		sourceId,
	};
	const registration: CustomApiRegistration = {
		registered,
		// A session's view is this registry's own record, so its functions can run the registered
		// ones through the gate. Those are called unchanged, on `registered`: the receiver they had
		// when the registry handed out `registered` itself.
		view: gate
			? {
					stream: (model, context, options) =>
						produceAdmitted(gate, options, admitted => registered.stream(model, context, admitted)),
					streamSimple: (model, context, options) =>
						produceAdmitted(gate, options, admitted => registered.streamSimple(model, context, admitted)),
					sourceId,
				}
			: registered,
		gate,
	};
	const registrations = customApiRegistry.get(api);
	if (!registrations) {
		customApiRegistry.set(api, [registration]);
		return;
	}
	const index = registrations.findIndex(entry => entry.gate === gate);
	if (index === -1) {
		registrations.push(registration);
	} else {
		registrations[index] = registration;
	}
}

/**
 * Get a custom API provider by API identifier: the newest registration whose session is still
 * live. A session's functions hand back the host stream that consumes what the session produced
 * (see {@link produceAdmitted}); the host's own hand back their stream as it is.
 */
export function getCustomApi(api: string): RegisteredCustomApi | undefined {
	const registrations = customApiRegistry.get(api);
	return registrations ? selectLiveRegistration(registrations)?.view : undefined;
}

/**
 * A session's producer being consumed into a host stream: the admitted work of kind `stream` that
 * {@link produceAdmitted} hands its gate.
 *
 * `stream` is what the caller holds. Its result settles at the producer's terminal, as a
 * provider's does, so a caller may await it before anything else finishes. `result()` is what the
 * session is held open by, and it settles only when the consumption is over: after the terminal,
 * after the iterator close the consumer starts there — an authored `finally` included — after the
 * producer's own reported result, and after the caller's signal is let go. They are different
 * objects because they answer different questions: making the caller's result wait for the close
 * would hang a caller that awaits it before letting that close finish.
 *
 * The cost is deliberate: an authored `finally` that never settles keeps the session's account-pool
 * restriction for the life of the process, because the only way to lift it is to release
 * credentials while the author's code is still running.
 */
interface AdmittedConsumption {
	readonly stream: AssistantMessageEventStream;
	result(): Promise<void>;
}

/**
 * Calls a session's registered stream function as that session's work, and returns the host stream
 * that consumes what it produced.
 *
 * The kind is declared here, where it is known. The admitted call produces the session's stream and
 * starts the one consumer that feeds a host stream from it, and what it hands the gate is that
 * consumption ({@link AdmittedConsumption}): work that keeps going after the call returns and says
 * through `result()` when it is over. So the session is held open from production to the end of
 * everything production started, the close and its cleanup included.
 *
 * Admission is checked once, at production: the gate refuses there if the session has retired.
 * Nothing is refused part-way. A session's disposal releases its claim and then waits for the turn
 * it is running, and that turn IS this consumption, so refusing a step would fail a turn its own
 * session is waiting for. Consumption starts inside the admitted call, so there is no moment
 * between the two at which the session could retire, and no producer that nobody consumes.
 */
function produceAdmitted<O extends { signal?: AbortSignal }>(
	gate: ProviderCallGate,
	options: O | undefined,
	produce: (options: O | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const signal = new AdmittedSignal(gate, options?.signal);
	try {
		const consumption = callThroughGate(
			gate,
			(): AdmittedConsumption => {
				const admitted = signal.admit();
				// The caller's options with only `signal` replaced, which leaves them an `O`.
				const admittedOptions = (admitted ? { ...options, signal: admitted } : options) as O | undefined;
				return consumeAdmitted(produce(admittedOptions), signal.release);
			},
			"stream",
		);
		return consumption.stream;
	} catch (error) {
		// Refused or thrown, by the producer, by this boundary or by the gate: nothing consumes it.
		signal.release();
		throw error;
	}
}

/**
 * Starts feeding a host stream from `producer` until the producer's terminal, as the leaked-thinking
 * healer and the loop guard already do one layer further on. Called inside the admitted call, so
 * every continuation of the consumer runs as the session's work.
 *
 * The host invokes the producer's protocol — `result()`, its async iterator, `next()`, `return()`,
 * the local-work getters — and an extension may have written any of them. The producer is never
 * wrapped, copied or proxied: its methods are called on it. And each property is read ONCE, because
 * a read is an operation and a getter may answer differently the next time: `result` is read and
 * called here, at production, and its one answer is both what holds the session and what the
 * caller's stream settles to when the producer ends without a terminal; the iterator is obtained
 * here, and the loop reads its `next` once and its `return` once, at the close. A producer that
 * reports no completion is refused here, at production, where refusing is still possible.
 *
 * The consumer is eager, and that has two costs where a caller used to hold the producer itself:
 * with an official endpoint, no loop guard and no in-flight limit, an authored iterator now runs
 * ahead of the caller. And `return()` reaches the producer's iterator when this consumer stops at
 * the terminal, not when a caller stops early. The abort still reaches the producer: its signal
 * follows the caller's (see {@link AdmittedSignal}).
 */
function consumeAdmitted(producer: AssistantMessageEventStream, release: () => void): AdmittedConsumption {
	const result: unknown = producer.result;
	if (typeof result !== "function") {
		throw new Error("Extension stream reported no completion; this session cannot own it");
	}
	const { promise: reported, resolve } = Promise.withResolvers<AssistantMessage>();
	// Called on the producer, once; one that throws refuses here. `resolve` asks the answer's `then`
	// once and adopts it, as `await` would.
	resolve(Reflect.apply(result, producer, []));
	const reportSettled = reported.then(
		() => {},
		() => {},
	);
	const iterator = producer[Symbol.asyncIterator]();
	// The async context of the admitted call: the session's admission, for the questions the host
	// asks the producer later from its own.
	const scope = AsyncLocalStorage.snapshot();
	const forwarded = new AssistantMessageEventStream();
	// The watchdog's question goes to the producer, as the session's work, while its stream lasts.
	forwarded.forwardLocalWorkFrom({
		get hasPendingLocalWork() {
			return scope(() => producer.hasPendingLocalWork);
		},
		get localWorkSettledAt() {
			return scope(() => producer.localWorkSettledAt);
		},
	});
	const consumed = (async () => {
		try {
			// The iterator obtained above, handed to the loop as it is: the loop reads its `next` once
			// and, stopping at the terminal, awaits its `return()` before this function goes on.
			for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
				forwarded.push(event);
				if (forwarded.done) return;
			}
			// Ended without a terminal event. The iteration ends as the producer's did, and the stream
			// settles as the producer's own result does — the same value or the same rejection, which
			// `end()` would replace with one of its own.
			try {
				forwarded.resolveFinalResult(await reported);
			} catch (error) {
				forwarded.rejectFinalResult(error);
			}
			forwarded.resultSettled = true;
			forwarded.end();
		} catch (error) {
			forwarded.fail(error);
		} finally {
			forwarded.forwardLocalWorkFrom(undefined);
			// Until the producer itself says it is finished, it is still the session's work.
			await reportSettled;
			// The consumption is over, however it ended: its signal lets go of the caller's.
			release();
		}
	})();
	return { stream: forwarded, result: () => consumed };
}

/**
 * Withdraw one registration of a custom API: `gate`'s, or the host's own when no gate is given.
 * Another session's registration of the same id stays to be selected, whether or not that
 * session is still live — retirement only stops an entry being selected; the registrar alone
 * withdraws it.
 */
export function unregisterCustomApi(api: string, gate?: ProviderCallGate): void {
	const registrations = customApiRegistry.get(api);
	if (!registrations) return;
	const kept = registrations.filter(entry => entry.gate !== gate);
	if (kept.length === 0) {
		customApiRegistry.delete(api);
	} else if (kept.length !== registrations.length) {
		customApiRegistry.set(api, kept);
	}
}

/**
 * Remove the custom APIs registered by a specific source (e.g., extension path): only `gate`'s
 * registrations when a gate is given, every session's otherwise.
 */
export function unregisterCustomApis(sourceId: string, gate?: ProviderCallGate): void {
	for (const [api, registrations] of customApiRegistry) {
		const kept = registrations.filter(
			entry => entry.registered.sourceId !== sourceId || (gate !== undefined && entry.gate !== gate),
		);
		if (kept.length === 0) {
			customApiRegistry.delete(api);
		} else if (kept.length !== registrations.length) {
			customApiRegistry.set(api, kept);
		}
	}
}

/**
 * Clear all custom API registrations.
 */
export function clearCustomApis(): void {
	customApiRegistry.clear();
}
