/**
 * Custom API provider registry.
 *
 * Allows extensions to register streaming functions for custom API types
 * (e.g., "vertex-claude-api") that are not built into stream.ts.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
	callThroughGate,
	type GatedRegistration,
	type ProviderCallGate,
	selectLiveRegistration,
} from "./auth/provider-gate";
import * as AIError from "./error";
import type { Api, Context, KnownApi, Model, SimpleStreamOptions, StreamOptions } from "./types";
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
 * live. What its functions return goes through {@link admittedStream} before anything consumes
 * it.
 */
export function getCustomApi(api: string): RegisteredCustomApi | undefined {
	const registrations = customApiRegistry.get(api);
	return registrations ? selectLiveRegistration(registrations)?.view : undefined;
}

/** Runs a function in the async context a session's call into its API was admitted in. */
type AdmissionScope = <R>(fn: () => R) => R;

/** A stream a session's registration produced: the scope its production was admitted in, how to
 *  let go of the caller's signal, and — once {@link admittedStream} has started consuming it —
 *  the stream that consumer feeds. */
interface AdmittedProduction {
	readonly scope: AdmissionScope;
	readonly release: () => void;
	forwarded?: AssistantMessageEventStream;
}

const admittedProductions = new WeakMap<object, AdmittedProduction>();

/**
 * Calls a session's registered stream function as that session's work.
 *
 * The kind is declared here, where it is known: a registered API returns a producer that keeps
 * working after it is handed back, so the session stays open until that producer reports its
 * terminal result. The async context captured inside the admitted call has the owning session
 * entered: that snapshot IS the session's admission, carried to everything the host later asks
 * of the producer. The producer is recorded, never wrapped.
 */
function produceAdmitted<O extends { signal?: AbortSignal }>(
	gate: ProviderCallGate,
	options: O | undefined,
	produce: (options: O | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	let admission: AdmittedProduction | undefined;
	try {
		return callThroughGate(
			gate,
			() => {
				const scope: AdmissionScope = AsyncLocalStorage.snapshot();
				const caller = options?.signal;
				const signal = caller ? admittedSignal(caller, scope) : undefined;
				admission = { scope, release: signal?.release ?? (() => {}) };
				// The caller's options with only `signal` replaced, which leaves them an `O`.
				const admittedOptions = (signal ? { ...options, signal: signal.signal } : options) as O | undefined;
				const produced = produce(admittedOptions);
				if ((typeof produced === "object" && produced !== null) || typeof produced === "function") {
					admittedProductions.set(produced, admission);
				}
				return produced;
			},
			"stream",
		);
	} catch (error) {
		// Refused or thrown, by the producer or by the gate after it: nothing will consume it.
		admission?.release();
		throw error;
	}
}

/**
 * The signal a session's producer is called with in place of the caller's.
 *
 * It is a different object because an author's abort listener runs inside the host's
 * `controller.abort()`, in the caller's async context: Bun's `EventTarget` does not carry the
 * context from `addEventListener`. This one aborts inside the admission scope, with the caller's
 * reason, so the listeners on it run as the session's work.
 *
 * It says what the caller's says wherever the producer can look. Already aborted, it is aborted
 * before the producer is called. Otherwise the forwarding listener is added just before the call,
 * so it fires where the producer's own listener on the caller's signal would have, in the same
 * turn. The listener comes off when the abort fires (`once`), when the call fails, and when the
 * consumer {@link admittedStream} started stops at the producer's terminal, so a long-lived caller
 * signal gathers none across requests.
 */
function admittedSignal(caller: AbortSignal, scope: AdmissionScope): { signal: AbortSignal; release: () => void } {
	const controller = new AbortController();
	if (caller.aborted) {
		controller.abort(caller.reason);
		return { signal: controller.signal, release: () => {} };
	}
	const forward = () => scope(() => controller.abort(caller.reason));
	caller.addEventListener("abort", forward, { once: true });
	return { signal: controller.signal, release: () => caller.removeEventListener("abort", forward) };
}

/**
 * The stream the host consumes in place of one a custom API produced. A host registration's
 * stream comes back as it is, the same object. A session's comes back as a host stream that
 * one consumer, started in the scope its production was admitted in, feeds from it.
 *
 * The host invokes the producer's protocol — its async iterator, `next()`, `return()`,
 * `result()`, the local-work getters — and an extension may have written any of them, so each
 * of those calls is the session's work like the call that produced the stream. The producer is
 * never wrapped, copied or proxied: the consumer calls its methods on it.
 *
 * Admission is checked once, at production: the gate refuses there if the session has retired.
 * Nothing is refused part-way. A session's disposal releases its claim and then waits for the
 * turn it is running, and that turn IS this consumption, so refusing a step would fail a turn
 * that its own session is waiting for. Every host site starts consuming in the same synchronous
 * turn that produced the stream, so the session cannot retire between the two.
 */
export function admittedStream(produced: AssistantMessageEventStream): AssistantMessageEventStream {
	const admission = admittedProductions.get(produced);
	if (!admission) return produced;
	// One consumer per producer: asking again returns the stream that consumer already feeds.
	admission.forwarded ??= admission.scope(() => consumeAdmitted(produced, admission));
	return admission.forwarded;
}

/**
 * Feeds a host stream from `producer` until the producer's terminal, as the leaked-thinking healer
 * and the loop guard already do one layer further on. It is called inside the admission scope, so
 * every continuation of the consumer below runs as the session's work.
 *
 * The consumer is eager, and that has two costs where a caller used to hold the producer itself:
 * with an official endpoint, no loop guard and no in-flight limit, an authored iterator now runs
 * ahead of the caller. And `return()` reaches the producer's iterator when this consumer stops at
 * the terminal, not when a caller stops early. The abort still reaches the producer: its signal
 * follows the caller's (see {@link admittedSignal}).
 */
function consumeAdmitted(
	producer: AssistantMessageEventStream,
	admission: AdmittedProduction,
): AssistantMessageEventStream {
	const { scope } = admission;
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
	void (async () => {
		try {
			for await (const event of producer) {
				forwarded.push(event);
				if (forwarded.done) return;
			}
			// Ended without a terminal event. The iteration ends as the producer's did, and the stream
			// settles as the producer's own result does — the same value or the same rejection, which
			// `end()` would replace with one of its own.
			try {
				forwarded.resolveFinalResult(await producer.result());
			} catch (error) {
				forwarded.rejectFinalResult(error);
			}
			forwarded.resultSettled = true;
			forwarded.end();
		} catch (error) {
			forwarded.fail(error);
		} finally {
			forwarded.forwardLocalWorkFrom(undefined);
			// The producer's stream is over, however it ended: its signal lets go of the caller's.
			admission.release();
		}
	})();
	return forwarded;
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
