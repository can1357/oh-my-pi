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
import type {
	AnthropicFallbackContent,
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	ContextSnapshot,
	KnownApi,
	Model,
	ProviderFileReference,
	SimpleStreamOptions,
	StopDetails,
	StreamOptions,
	Usage,
} from "./types";
import { kStreamingPartialJson } from "./utils/block-symbols";
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
						produceAdmitted(api, gate, options, admitted => registered.stream(model, context, admitted)),
					streamSimple: (model, context, options) =>
						produceAdmitted(api, gate, options, admitted => registered.streamSimple(model, context, admitted)),
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
	api: string,
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
				return consumeAdmitted(api, produce(admittedOptions), signal.release);
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
 * What the producer hands over is the session's code as much as its methods are: an event and a
 * reported result may carry getters, and the host reads them long after this call — the agent loop
 * keeps the final message, the session persists it. So each event and the reported result are
 * copied by schema here, as the session's work, before the host stream sees them, and the host
 * reads only the copies (see {@link copyStreamValue}). The producer's terminal settles the caller's
 * result to that event's copy; with no terminal, it settles to the copy of the reported result.
 *
 * The consumer is eager, and that has two costs where a caller used to hold the producer itself:
 * with an official endpoint, no loop guard and no in-flight limit, an authored iterator now runs
 * ahead of the caller. And `return()` reaches the producer's iterator when this consumer stops at
 * the terminal, not when a caller stops early. The abort still reaches the producer: its signal
 * follows the caller's (see {@link AdmittedSignal}).
 */
function consumeAdmitted(api: string, producer: AssistantMessageEventStream, release: () => void): AdmittedConsumption {
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
			let index = 0;
			for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
				forwarded.push(
					copyStreamValue(event, STREAM_EVENT, {
						api,
						path: [`events[${index++}]`],
						copies: new Map(),
					}) as AssistantMessageEvent,
				);
				if (forwarded.done) return;
			}
			// Ended without a terminal event. The iteration ends as the producer's did, and the stream
			// settles as the producer's own result does — a copy of the same value, or the same
			// rejection, which `end()` would replace with one of its own.
			try {
				const message = await reported;
				forwarded.resolveFinalResult(
					copyStreamValue(message, ASSISTANT_MESSAGE, {
						api,
						path: ["result()"],
						copies: new Map(),
					}) as AssistantMessage,
				);
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
 * How {@link copyStreamValue} copies one value a session's stream hands over.
 *
 * - `data`: an open value — a record whose keys are its content (`arguments`, `providerPayload`),
 *   a list, or a primitive. Copied as JSON copies it: each own enumerable string key and each
 *   array element, read once.
 * - `fields`: a known shape — a message, its usage. Copied by reading each field the shape has,
 *   string- or symbol-keyed, the way a field read reads it, so an inherited field and a prototype
 *   getter arrive as they would for the host. Nothing else on the object is read.
 * - `items`: a list whose items all have one schema.
 * - `variants`: a union told apart by `type` — an event, a content block. `type` is read once and
 *   the fields of the variant it names are copied. A `type` no variant has is a shape the host
 *   does not know; it is copied as data, which is what the host forwarded of it before.
 */
type StreamSchema =
	| { readonly kind: "data" }
	| FieldsSchema
	| { readonly kind: "items"; readonly items: StreamSchema }
	| { readonly kind: "variants"; readonly variants: ReadonlyMap<unknown, FieldsSchema> };

type FieldsSchema = {
	readonly kind: "fields";
	readonly fields: readonly (readonly [field: PropertyKey, schema: StreamSchema])[];
};

/** One entry for every field of `T`, so a field added to `T` does not compile until it says how it
 *  is copied. */
type FieldSchemas<T> = { readonly [K in keyof T]-?: StreamSchema };

const DATA: StreamSchema = { kind: "data" };

/** A known shape. */
function fieldsOf<T>(fields: FieldSchemas<T>): FieldsSchema {
	return {
		kind: "fields",
		fields: Reflect.ownKeys(fields).map((field): FieldsSchema["fields"][number] => [
			field,
			Reflect.get(fields, field),
		]),
	};
}

/** A union told apart by `type`: every variant, each with every field but `type`. */
function variantsOf<U extends { type: string }>(variants: {
	readonly [T in U["type"]]: FieldSchemas<Omit<Extract<U, { type: T }>, "type">>;
}): StreamSchema {
	return {
		kind: "variants",
		variants: new Map(
			Object.entries<FieldSchemas<object>>(variants).map(([type, fields]) => [type, fieldsOf(fields)]),
		),
	};
}

/** A content block. An event's `toolCall` and `content` use this schema too, so that a block an
 *  event names beside its partial is copied once and stays the block in that partial's copy. */
const CONTENT_BLOCK = variantsOf<AssistantMessage["content"][number]>({
	text: { text: DATA, textSignature: DATA },
	thinking: { thinking: DATA, thinkingSignature: DATA, itemId: DATA, summary: DATA, narration: DATA },
	redactedThinking: { data: DATA },
	fallback: {
		from: fieldsOf<AnthropicFallbackContent["from"]>({ model: DATA }),
		to: fieldsOf<AnthropicFallbackContent["to"]>({ model: DATA }),
	},
	anthropicServerTool: { block: DATA },
	image: {
		data: DATA,
		mimeType: DATA,
		detail: DATA,
		providerFile: fieldsOf<ProviderFileReference>({ provider: DATA, id: DATA, uri: DATA, expiresAt: DATA }),
		url: DATA,
	},
	toolCall: {
		id: DATA,
		name: DATA,
		arguments: DATA,
		// Read by live renderers while the arguments stream.
		[kStreamingPartialJson]: DATA,
		thoughtSignature: DATA,
		intent: DATA,
		rawBlock: DATA,
		customWireName: DATA,
		providerMetadata: DATA,
	},
});

const ASSISTANT_MESSAGE = fieldsOf<AssistantMessage>({
	role: DATA,
	content: { kind: "items", items: CONTENT_BLOCK },
	api: DATA,
	provider: DATA,
	model: DATA,
	credentialId: DATA,
	contextSnapshot: fieldsOf<ContextSnapshot>({
		promptTokens: DATA,
		nonMessageTokens: DATA,
		toolSchemaTokens: DATA,
		historyRewriteTokensRemoved: DATA,
		compactionEpoch: DATA,
		lastMessageTimestamp: DATA,
	}),
	retryRecovery: DATA,
	responseId: DATA,
	upstreamProvider: DATA,
	upstreamModel: DATA,
	serviceTier: DATA,
	usage: fieldsOf<Usage>({
		input: DATA,
		output: DATA,
		cacheRead: DATA,
		cacheWrite: DATA,
		totalTokens: DATA,
		contextTokens: DATA,
		orchestration: fieldsOf<NonNullable<Usage["orchestration"]>>({ input: DATA, cacheRead: DATA, output: DATA }),
		premiumRequests: DATA,
		reasoningTokens: DATA,
		cttl: fieldsOf<NonNullable<Usage["cttl"]>>({ ephemeral5m: DATA, ephemeral1h: DATA }),
		server: fieldsOf<NonNullable<Usage["server"]>>({ webSearch: DATA, webFetch: DATA }),
		credits: fieldsOf<NonNullable<Usage["credits"]>>({ cost: DATA, committedCost: DATA, acuCost: DATA }),
		cost: fieldsOf<Usage["cost"]>({ input: DATA, output: DATA, cacheRead: DATA, cacheWrite: DATA, total: DATA }),
	}),
	elidedOutputTokens: DATA,
	stopReason: DATA,
	stopDetails: fieldsOf<StopDetails>({
		type: DATA,
		category: DATA,
		explanation: DATA,
		fallback_credit_token: DATA,
		fallback_has_prefill_claim: DATA,
	}),
	errorMessage: DATA,
	errorClassificationMessage: DATA,
	requestBodyReadTimeoutFullReplay: DATA,
	toolCallAbortMessages: DATA,
	errorStatus: DATA,
	errorId: DATA,
	disabledFeatures: DATA,
	inputTransformations: DATA,
	requestControls: DATA,
	providerPayload: DATA,
	fallbackCreditHandle: DATA,
	timestamp: DATA,
	duration: DATA,
	ttft: DATA,
	completedAt: DATA,
});

const STREAM_EVENT = variantsOf<AssistantMessageEvent>({
	start: { contentIndex: DATA, partial: ASSISTANT_MESSAGE },
	text_start: { contentIndex: DATA, partial: ASSISTANT_MESSAGE },
	text_delta: { contentIndex: DATA, delta: DATA, partial: ASSISTANT_MESSAGE },
	text_end: { contentIndex: DATA, content: DATA, partial: ASSISTANT_MESSAGE },
	thinking_start: { contentIndex: DATA, partial: ASSISTANT_MESSAGE },
	thinking_delta: { contentIndex: DATA, delta: DATA, partial: ASSISTANT_MESSAGE },
	thinking_end: { contentIndex: DATA, content: DATA, partial: ASSISTANT_MESSAGE },
	image_end: { contentIndex: DATA, content: CONTENT_BLOCK, partial: ASSISTANT_MESSAGE },
	toolcall_start: { contentIndex: DATA, partial: ASSISTANT_MESSAGE },
	toolcall_delta: { contentIndex: DATA, delta: DATA, partial: ASSISTANT_MESSAGE },
	toolcall_end: { contentIndex: DATA, toolCall: CONTENT_BLOCK, partial: ASSISTANT_MESSAGE },
	done: { contentIndex: DATA, reason: DATA, message: ASSISTANT_MESSAGE },
	error: { contentIndex: DATA, reason: DATA, error: ASSISTANT_MESSAGE },
});

/** One copy being taken. `path` and `api` say where, for the error that refuses a function where
 *  data belongs. `copies` holds what is already copied, keyed by the object alone, so an object
 *  reached twice is copied once: a stream that puts one object where two different shapes belong
 *  gets the first copy in both places, which is the host's either way. */
interface StreamCopy {
	readonly api: string;
	/** The path walked to the value, what the producer handed over first. */
	readonly path: PropertyKey[];
	readonly copies: Map<object, unknown>;
}

function renderStreamPath(path: readonly PropertyKey[]): string {
	let rendered = "";
	for (const step of path) {
		if (rendered === "") rendered = String(step);
		else if (typeof step === "number" || typeof step === "symbol") rendered += `[${String(step)}]`;
		else if (/^[A-Za-z_$][\w$]*$/.test(step)) rendered += `.${step}`;
		else rendered += `[${JSON.stringify(step)}]`;
	}
	return rendered;
}

function copyStreamFields(
	value: object,
	fields: FieldsSchema["fields"],
	copy: Record<PropertyKey, unknown>,
	site: StreamCopy,
): void {
	for (let index = 0; index < fields.length; index++) {
		const [field, schema] = fields[index]!;
		site.path.push(field);
		const item = copyStreamValue(Reflect.get(value, field), schema, site);
		site.path.pop();
		if (item !== undefined) copy[field] = item;
	}
}

function copyStreamData(value: object, copy: Record<string, unknown>, site: StreamCopy, skip?: string): void {
	for (const key of Object.keys(value)) {
		if (key === skip) continue;
		site.path.push(key);
		const item = copyStreamValue(Reflect.get(value, key), DATA, site);
		site.path.pop();
		// Assigning an own `__proto__` key would set the copy's prototype; defined, it stays data.
		if (key === "__proto__") {
			Object.defineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true });
		} else {
			copy[key] = item;
		}
	}
}

/**
 * A host-owned plain copy of what a session's stream handed over — one event it yielded, or the
 * result it reported — taken inside the session's admission: the event's own fields, its partial
 * or final message, and that message's blocks. These are the author's code as much as the iterator
 * that yielded them — a getter or a Proxy trap runs whenever the host reads them — and the host
 * reads them long after the admitted call: the agent loop keeps a partial as the turn's message,
 * and keeps the final one. So each value is read once, here, and the host reads only the copy. A
 * function where data belongs is author code the host would otherwise run later with no
 * admission; it is refused, naming where it was found.
 *
 * By schema, like `copyUsageReport` (`./usage.ts`) and `copyOAuthCredentials`
 * (`./auth/provider-gate.ts`): the fields the types declare. One copy per event, because a stream
 * mutates its partial between events; within the event, an object reached twice — the tool call an
 * event ends and the same block in its partial — is copied once. A host registration's events are
 * the host's and are never copied.
 */
function copyStreamValue(value: unknown, schema: StreamSchema, site: StreamCopy): unknown {
	if (typeof value === "function") {
		throw new Error(
			`Custom API "${site.api}": ${renderStreamPath(site.path)} is a function, but it must be data. Compute the value before the stream hands it over.`,
		);
	}
	if (typeof value !== "object" || value === null) return value;
	const known = site.copies.get(value);
	if (known !== undefined) return known;
	if (Array.isArray(value)) {
		const itemSchema = schema.kind === "items" ? schema.items : DATA;
		const copy: unknown[] = [];
		site.copies.set(value, copy);
		const length = value.length;
		for (let index = 0; index < length; index++) {
			site.path.push(index);
			copy[index] = copyStreamValue(value[index], itemSchema, site);
			site.path.pop();
		}
		return copy;
	}
	const copy: Record<PropertyKey, unknown> = {};
	site.copies.set(value, copy);
	switch (schema.kind) {
		case "fields":
			copyStreamFields(value, schema.fields, copy, site);
			return copy;
		case "variants": {
			site.path.push("type");
			const type = copyStreamValue(Reflect.get(value, "type"), DATA, site);
			site.path.pop();
			if (type !== undefined) copy.type = type;
			const variant = schema.variants.get(type);
			if (variant) copyStreamFields(value, variant.fields, copy, site);
			else copyStreamData(value, copy, site, "type");
			return copy;
		}
		default:
			copyStreamData(value, copy, site);
			return copy;
	}
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
