/**
 * Custom API provider registry.
 *
 * Allows extensions to register streaming functions for custom API types
 * (e.g., "vertex-claude-api") that are not built into stream.ts.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ApiKeyResolveContext } from "./auth-retry";
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
	LiveSteerClaim,
	LiveSteering,
	Message,
	Model,
	ProviderFileReference,
	ProviderResponseMetadata,
	RawSseEvent,
	SimpleStreamOptions,
	StopDetails,
	StreamOptions,
	Tool,
	Usage,
} from "./types";
import { kStreamingPartialJson } from "./utils/block-symbols";
import { AssistantMessageEventStream } from "./utils/event-stream";
import { arkToWireSchema, isArkSchema } from "./utils/schema/wire";

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
 *  whose functions run `registered`'s as the owning session's work, on copies of their inputs. */
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
						produceAdmitted(api, gate, model, context, options, (m, c, o) => registered.stream(m, c, o)),
					streamSimple: (model, context, options) =>
						produceAdmitted(api, gate, model, context, options, (m, c, o) => registered.streamSimple(m, c, o)),
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
 *
 * The model, context and options are the host's own records, and the host reads them again after
 * the call: the agent loop keeps the context's messages as its transcript, the session keeps its
 * model, and the options carry headers and schemas the host reuses on every request. An object
 * handed to the author is the author's from then on — a getter installed on it would answer every
 * later host read, outside this admission and after the session has gone. So the function is
 * handed copies, taken here by schema, and the host never reads them; the callbacks among the
 * options are handed as functions of the session's own that apply the host's on copies of what the
 * author passes them (see {@link copyStreamValue}). The signal is the admitted one
 * ({@link AdmittedSignal}). A host registration is the host's code and is called with the host's
 * objects as they are.
 */
function produceAdmitted<O extends StreamOptions | SimpleStreamOptions>(
	api: string,
	gate: ProviderCallGate,
	model: Model<Api>,
	context: Context,
	options: O | undefined,
	produce: (model: Model<Api>, context: Context, options: O | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const signal = new AdmittedSignal(gate, options?.signal);
	try {
		const consumption = callThroughGate(
			gate,
			(): AdmittedConsumption => {
				// One copy across the three, so an object they share stays shared in what is handed.
				const copies = new Map<object, unknown>();
				const site = (root: string): StreamCopy => ({
					api,
					direction: "hand",
					path: [root],
					copies,
					advice: "Compute the value before passing it to the host.",
				});
				const handedModel = copyStreamValue(model, MODEL, site("model")) as Model<Api>;
				const handedContext = copyStreamValue(context, CONTEXT, site("context")) as Context;
				const handedOptions =
					options === undefined ? undefined : (copyStreamValue(options, STREAM_OPTIONS, site("options")) as O);
				const admitted = signal.admit();
				if (handedOptions && admitted) handedOptions.signal = admitted;
				return consumeAdmitted(api, produce(handedModel, handedContext, handedOptions), signal.release);
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
	const { promise: reported, resolve, reject } = Promise.withResolvers<AssistantMessage>();
	// Called on the producer, once; one that throws refuses here. Then its answer's `then` is
	// read ONCE, here, inside the admission, and that one callable is applied — `resolve` would
	// read it again in a later microtask, outside this scope and possibly after the session had
	// gone, and adopt whatever that read answered.
	const answered: unknown = Reflect.apply(result, producer, []);
	const settle: unknown =
		answered !== null && (typeof answered === "object" || typeof answered === "function")
			? (answered as PromiseLike<AssistantMessage>).then
			: undefined;
	if (typeof settle === "function") {
		try {
			Reflect.apply(settle, answered, [resolve, reject]);
		} catch (error) {
			reject(error);
		}
	} else {
		resolve(answered as AssistantMessage);
	}
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
						direction: "take",
						path: [`events[${index++}]`],
						copies: new Map(),
						advice: STREAM_ADVICE,
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
						direction: "take",
						path: ["result()"],
						copies: new Map(),
						advice: STREAM_ADVICE,
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
 * How {@link copyStreamValue} copies one value crossing a custom API's boundary: what a session's
 * stream hands over (`take`), and the model, context and options the host hands a session's stream
 * function (`hand`), with what crosses back through the callbacks among them.
 *
 * - `data`: an open value — a record whose keys are its content (`arguments`, `providerPayload`,
 *   `headers`), a list, or a primitive. Copied as JSON copies it: each own enumerable string key
 *   and each array element, read once. A function in it is refused when a session hands it over;
 *   in the host's own data it is left out, as JSON leaves it out, and the host's typed arrays and
 *   buffers are cloned rather than spelled out key by key.
 * - `fields`: a known shape — a message, its usage. Copied by reading each field the shape has,
 *   string- or symbol-keyed, the way a field read reads it, so an inherited field and a prototype
 *   getter arrive as they would for the host. Nothing else on the object is read.
 * - `items`: a list whose items all have one schema.
 * - `variants`: a union told apart by one field — `type` for an event or a content block, `role`
 *   for a message. That field is read once and the fields of the variant it names are copied. A
 *   value no variant names is a shape the host does not know; it is copied as data, which is what
 *   the host forwarded of it before.
 * - `callback`: a host function a session is handed. The session gets a function of its own that
 *   applies the host's to the object it was read from, on copies of the session's arguments by
 *   `args` — taken during the session's call — and hands back a copy of the answer by `result`, or
 *   a promise of one. A function a session puts there in what it hands back is not carried: the
 *   host calls no session function it finds in data.
 * - `signal`: an `AbortSignal` a session passes a host callback. The host gets one of its own that
 *   follows it; anything else is refused.
 * - `toolSchema`: a tool's parameters. A live ArkType schema is host code, so a session is handed
 *   the JSON Schema the wire sends for it instead; any other schema is data.
 * - `fetchInput` / `fetchInit`: what a session passes the host's `fetch`. The target is read once,
 *   as a string, or cloned when it is a `Request`. The init is copied as data, but for a `Headers`
 *   (cloned), a body of bytes (cloned) or one the platform reads as it sends — a string, blob, form
 *   or stream, passed as it is — and the signal.
 * - `opaque`: kept as it is — an error, whose identity carries the classification retries route
 *   on, and the `Response` the host's fetch made for that one call.
 * - `withheld`: never handed.
 */
type StreamSchema =
	| { readonly kind: "data" }
	| FieldsSchema
	| { readonly kind: "items"; readonly items: StreamSchema }
	| {
			readonly kind: "variants";
			readonly key: string;
			readonly variants: ReadonlyMap<unknown, FieldsSchema>;
	  }
	| CallbackSchema
	| { readonly kind: "signal" | "toolSchema" | "fetchInput" | "fetchInit" | "opaque" | "withheld" };

type FieldsSchema = {
	readonly kind: "fields";
	readonly fields: readonly (readonly [field: PropertyKey, schema: StreamSchema])[];
};

type CallbackSchema = {
	readonly kind: "callback";
	readonly args: readonly StreamSchema[];
	readonly result: StreamSchema;
};

/** One entry for every field of `T`, so a field added to `T` does not compile until it says how it
 *  is copied. */
type FieldSchemas<T> = { readonly [K in keyof T]-?: StreamSchema };

const DATA: StreamSchema = { kind: "data" };
const SIGNAL: StreamSchema = { kind: "signal" };
const OPAQUE: StreamSchema = { kind: "opaque" };
const WITHHELD: StreamSchema = { kind: "withheld" };

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

/** A union told apart by `key`: every variant, each with every field but `key`, which is read once
 *  for all of them. */
function variantsOf<K extends string, U extends { readonly [P in K]: string }>(
	key: K,
	variants: { readonly [T in U[K]]: FieldSchemas<Omit<Extract<U, { readonly [P in K]: T }>, K>> },
): StreamSchema {
	return {
		kind: "variants",
		key,
		variants: new Map(
			Object.entries<FieldSchemas<object>>(variants).map(([name, fields]) => {
				const { fields: entries } = fieldsOf(fields);
				return [name, { kind: "fields", fields: entries.filter(([field]) => field !== key) }];
			}),
		),
	};
}

/** A host function, handed as one of the session's own; see {@link handCallback}. */
function callbackOf(args: readonly StreamSchema[], result: StreamSchema): CallbackSchema {
	return { kind: "callback", args, result };
}

/** A content block. An event's `toolCall` and `content` use this schema too, so that a block an
 *  event names beside its partial is copied once and stays the block in that partial's copy. */
const CONTENT_BLOCK = variantsOf<"type", AssistantMessage["content"][number]>("type", {
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

const ASSISTANT_MESSAGE_FIELDS: FieldSchemas<AssistantMessage> = {
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
};

const ASSISTANT_MESSAGE = fieldsOf<AssistantMessage>(ASSISTANT_MESSAGE_FIELDS);

const STREAM_EVENT = variantsOf<"type", AssistantMessageEvent>("type", {
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

const MESSAGE_CONTENT: StreamSchema = { kind: "items", items: CONTENT_BLOCK };

/** A message of the context a session's stream function is handed. */
const MESSAGE = variantsOf<"role", Message>("role", {
	user: {
		content: MESSAGE_CONTENT,
		synthetic: DATA,
		steering: DATA,
		liveSteered: DATA,
		historyRewriteAt: DATA,
		attribution: DATA,
		providerPayload: DATA,
		timestamp: DATA,
	},
	developer: {
		content: MESSAGE_CONTENT,
		attribution: DATA,
		synthetic: DATA,
		userInitiated: DATA,
		providerPayload: DATA,
		timestamp: DATA,
	},
	assistant: ASSISTANT_MESSAGE_FIELDS,
	toolResult: {
		toolCallId: DATA,
		toolName: DATA,
		content: MESSAGE_CONTENT,
		details: DATA,
		isError: DATA,
		attribution: DATA,
		prunedAt: DATA,
		providerMetadata: DATA,
		useless: DATA,
		timestamp: DATA,
	},
});

const MESSAGES: StreamSchema = { kind: "items", items: MESSAGE };

const TOOLS: StreamSchema = {
	kind: "items",
	items: fieldsOf<Tool>({
		name: DATA,
		description: DATA,
		parameters: { kind: "toolSchema" },
		strict: DATA,
		deferLoading: DATA,
		customFormat: DATA,
		customWireName: DATA,
		native: DATA,
		examples: DATA,
	}),
};

const CONTEXT = fieldsOf<Context>({ systemPrompt: DATA, messages: MESSAGES, tools: TOOLS, inactiveTools: TOOLS });

/** The model a session's stream function is handed: the host's catalog row. */
const MODEL = fieldsOf<Model<Api>>({
	id: DATA,
	kind: DATA,
	kindConfig: DATA,
	webSearch: DATA,
	webSearchModel: DATA,
	hostedImage: DATA,
	imageModel: DATA,
	identity: DATA,
	requiresGlyphTokenization: DATA,
	requiresCursorToolSchemaProjection: DATA,
	toolSchemasInContext: DATA,
	requiresToolResultImageHoisting: DATA,
	supportsAssistantPrefill: DATA,
	requestModelId: DATA,
	reasoningMode: DATA,
	name: DATA,
	api: DATA,
	provider: DATA,
	providerType: DATA,
	baseUrl: DATA,
	reasoning: DATA,
	tokenizer: DATA,
	input: DATA,
	imageInputDecoder: DATA,
	imageCountBudget: DATA,
	supportsTools: DATA,
	supportsComputerUse: DATA,
	supportsComputerUseConfig: DATA,
	gitlabDuoWorkflowRootNamespaceId: DATA,
	cursorMaxMode: DATA,
	cursorMaxModeRoutes: DATA,
	antigravityWireProfiles: DATA,
	accountAccess: DATA,
	cursorModelParameters: DATA,
	cursorModelRoutes: DATA,
	cursorPrice: DATA,
	cursorRequiresDataRetention: DATA,
	cursorSupportsAgent: DATA,
	cursorSupportsSandboxing: DATA,
	factoryDroidApiProviders: DATA,
	factoryDroidRoutingSource: DATA,
	factoryDroidCredits: DATA,
	factoryDroidOrgId: DATA,
	cost: DATA,
	promptCache: DATA,
	promptCacheConfig: DATA,
	pricingStatus: DATA,
	premiumMultiplier: DATA,
	contextWindow: DATA,
	contextWindowAuthoritative: DATA,
	longContextWindowUncapped: DATA,
	maxContextWindow: DATA,
	maxTokens: DATA,
	omitMaxOutputTokens: DATA,
	headers: DATA,
	resolveHeaders: callbackOf([SIGNAL], DATA),
	transport: DATA,
	preferWebsockets: DATA,
	useResponsesLite: DATA,
	serviceTiers: DATA,
	contextPromotionTarget: DATA,
	compactionModel: DATA,
	remoteCompaction: DATA,
	priority: DATA,
	serviceTierCost: DATA,
	description: DATA,
	isNew: DATA,
	isBeta: DATA,
	isProviderDefault: DATA,
	isRecommended: DATA,
	thinking: DATA,
	int: DATA,
	tps: DATA,
	compat: DATA,
	compatConfig: DATA,
	applyPatchToolType: DATA,
	editPromptVariant: DATA,
	isOAuth: DATA,
	guardrailIdentifier: DATA,
	guardrailVersion: DATA,
	guardrailTrace: DATA,
	requestMetadata: DATA,
});

/**
 * The options a session's stream function is handed, `stream`'s and `streamSimple`'s alike.
 *
 * Withheld: the signal, which {@link produceAdmitted} replaces with the admitted one, and what the
 * host keeps for itself and built-in transports. `providerSessionState` is the session's store of
 * provider state, which the host reads and closes; the Cursor exec handlers and tool-result hook,
 * and the Anthropic slow-mode state machine, serve only the built-in transports they were made for.
 */
const STREAM_OPTIONS = fieldsOf<SimpleStreamOptions>({
	temperature: DATA,
	topP: DATA,
	topK: DATA,
	minP: DATA,
	presencePenalty: DATA,
	repetitionPenalty: DATA,
	stopSequences: DATA,
	frequencyPenalty: DATA,
	maxTokens: DATA,
	signal: WITHHELD,
	maxHttpAttempts: DATA,
	apiKey: callbackOf(
		[
			fieldsOf<ApiKeyResolveContext>({
				lastChance: DATA,
				error: OPAQUE,
				previousKey: DATA,
				signal: SIGNAL,
			}),
		],
		DATA,
	),
	credentialId: DATA,
	oauthIdentity: DATA,
	cacheRetention: DATA,
	anthropicPrefixMismatchBehavior: DATA,
	anthropicCompaction: DATA,
	userProfileId: DATA,
	headers: DATA,
	initiatorOverride: DATA,
	maxRetryDelayMs: DATA,
	metadata: DATA,
	providerOptions: DATA,
	include: DATA,
	loopGuard: DATA,
	taskBudget: DATA,
	sessionId: DATA,
	promptCacheKey: DATA,
	promptCache: DATA,
	statefulResponses: DATA,
	storeResponses: DATA,
	forceReasoningOff: DATA,
	providerSessionState: WITHHELD,
	parentSessionId: DATA,
	minimizeEffort: DATA,
	liveSteering: fieldsOf<LiveSteering>({
		wait: callbackOf([SIGNAL], WITHHELD),
		claim: callbackOf(
			[SIGNAL],
			fieldsOf<LiveSteerClaim>({
				messages: MESSAGES,
				accept: callbackOf([], WITHHELD),
				reject: callbackOf([], WITHHELD),
			}),
		),
	}),
	codexCompaction: DATA,
	codexAccessPrograms: DATA,
	maxInFlightRequests: DATA,
	waitForTerminalDrain: DATA,
	onPayload: callbackOf([DATA, MODEL, SIGNAL], DATA),
	onResponse: callbackOf(
		[
			fieldsOf<ProviderResponseMetadata>({ status: DATA, headers: DATA, requestId: DATA, metadata: DATA }),
			MODEL,
			SIGNAL,
		],
		WITHHELD,
	),
	onSseEvent: callbackOf([fieldsOf<RawSseEvent>({ event: DATA, data: DATA, raw: DATA }), MODEL], WITHHELD),
	streamFirstEventTimeoutMs: DATA,
	streamIdleTimeoutMs: DATA,
	codexSseMaxAttempts: DATA,
	providerRetryWait: callbackOf([DATA, SIGNAL], WITHHELD),
	acceptEmptyResponse: DATA,
	fetch: callbackOf([{ kind: "fetchInput" }, { kind: "fetchInit" }], OPAQUE),
	cwd: DATA,
	execHandlers: WITHHELD,
	fallbackCreditRedemption: DATA,
	anthropicSlowMode: WITHHELD,
	reasoning: DATA,
	disableReasoning: DATA,
	disableServerSideFallback: DATA,
	hideThinkingSummary: DATA,
	textVerbosity: DATA,
	thinkingBudgets: DATA,
	cursorExecHandlers: WITHHELD,
	cursorOnToolResult: WITHHELD,
	cursorExternalToolExecutor: DATA,
	guardrailIdentifier: DATA,
	guardrailVersion: DATA,
	guardrailTrace: DATA,
	requestMetadata: DATA,
	toolChoice: DATA,
	serviceTier: DATA,
	kimiApiFormat: DATA,
	syntheticApiFormat: DATA,
	preferWebsockets: DATA,
	openrouterVariant: DATA,
	cachedContent: DATA,
	antigravityEndpointMode: DATA,
	fallbacks: DATA,
});

/** What a refusal in a stream's events or result tells the author to do instead. */
const STREAM_ADVICE = "Compute the value before the stream hands it over.";

/** One copy being taken. `path` and `api` say where, for the error that refuses a function where
 *  data belongs. `copies` holds what is already copied, keyed by the object alone, so an object
 *  reached twice is copied once: a stream that puts one object where two different shapes belong
 *  gets the first copy in both places, which is the host's either way. */
interface StreamCopy {
	readonly api: string;
	/** `take` for what a session hands the host; `hand` for what the host hands a session. */
	readonly direction: "take" | "hand";
	/** The path walked to the value, its root first. */
	readonly path: PropertyKey[];
	readonly copies: Map<object, unknown>;
	/** What a refusal tells the author to do instead; for a `hand` copy, a refusal in the arguments
	 *  of the callbacks it hands. */
	readonly advice: string;
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
		const item = copyStreamValue(Reflect.get(value, field), schema, site, value);
		site.path.pop();
		if (item !== undefined) copy[field] = item;
	}
}

/** Sets `key` on a copy as data: assigning an own `__proto__` key would set the copy's prototype. */
function setCopiedKey(copy: Record<string, unknown>, key: string, item: unknown): void {
	if (key === "__proto__") {
		Object.defineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true });
	} else {
		copy[key] = item;
	}
}

function copyStreamData(value: object, copy: Record<string, unknown>, site: StreamCopy, skip?: string): void {
	for (const key of Object.keys(value)) {
		if (key === skip) continue;
		site.path.push(key);
		const item = copyStreamValue(Reflect.get(value, key), DATA, site);
		site.path.pop();
		setCopiedKey(copy, key, item);
	}
}

/**
 * A host-owned plain copy of one value crossing a custom API's boundary, taken inside the owning
 * session's admission.
 *
 * What a session's stream hands over — one event it yielded, or the result it reported — is the
 * author's code as much as the iterator that yielded it: a getter or a Proxy trap runs whenever the
 * host reads it, and the host reads it long after the admitted call — the agent loop keeps a
 * partial as the turn's message, and keeps the final one. So each value is read once, here, and
 * the host reads only the copy. A function where data belongs is author code the host would
 * otherwise run later with no admission; it is refused, naming where it was found.
 *
 * What the host hands a session's stream function is the host's own record, which the author can
 * change as soon as it has it; the host keeps the record and the author gets the copy (see
 * {@link produceAdmitted}). The arguments the author passes the host's callbacks cross the other
 * way again, and are copied as a stream's events are, during the author's call.
 *
 * By schema, like `copyUsageReport` (`./usage.ts`) and `copyOAuthCredentials`
 * (`./auth/provider-gate.ts`): the fields the types declare. One copy per event, because a stream
 * mutates its partial between events; within the event, an object reached twice — the tool call an
 * event ends and the same block in its partial — is copied once. A host registration's events and
 * inputs are the host's and are never copied. `holder` is the object a callback was read from.
 */
function copyStreamValue(value: unknown, schema: StreamSchema, site: StreamCopy, holder?: object): unknown {
	switch (schema.kind) {
		case "withheld":
			return undefined;
		case "opaque":
			return value;
		case "signal":
			return followSignal(value, site);
		case "fetchInput":
			return value instanceof Request ? new Request(value) : String(value);
		case "fetchInit":
			return copyFetchInit(value, site);
		case "callback":
			if (typeof value === "function") {
				// Applied to the object it was read from, as the host's own call would apply it.
				return site.direction === "hand"
					? handCallback(args => Reflect.apply(value, holder, args), schema, site)
					: undefined;
			}
			break;
		case "toolSchema":
			if (site.direction === "hand" && isArkSchema(value)) {
				return copyStreamValue(arkToWireSchema(value), DATA, site);
			}
			break;
	}
	if (typeof value === "function") {
		if (site.direction === "hand") return undefined;
		throw new Error(
			`Custom API "${site.api}": ${renderStreamPath(site.path)} is a function, but it must be data. ${site.advice}`,
		);
	}
	if (typeof value !== "object" || value === null) return value;
	const known = site.copies.get(value);
	if (known !== undefined) return known;
	if (site.direction === "hand" && (ArrayBuffer.isView(value) || value instanceof ArrayBuffer)) {
		const copy = structuredClone(value);
		site.copies.set(value, copy);
		return copy;
	}
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
			site.path.push(schema.key);
			const name = copyStreamValue(Reflect.get(value, schema.key), DATA, site);
			site.path.pop();
			if (name !== undefined) copy[schema.key] = name;
			const variant = schema.variants.get(name);
			if (variant) copyStreamFields(value, variant.fields, copy, site);
			else copyStreamData(value, copy, site, schema.key);
			return copy;
		}
		default:
			copyStreamData(value, copy, site);
			return copy;
	}
}

/**
 * The function a session is handed in place of a host callback, which `apply` calls.
 *
 * A host callback is the host's code and its receiver the host's object: handed either, the author
 * could replace a method the host calls again later, or install a getter the host's own call reads.
 * So the author gets a function of its own. Each call copies the arguments by schema — during the
 * author's call, where the author's getters run once — and applies the host's function with the
 * copies; the answer is handed back as a copy too, or a promise of one. What the host's function
 * throws or rejects with reaches the author as it is.
 */
function handCallback(
	apply: (args: unknown[]) => unknown,
	schema: CallbackSchema,
	site: StreamCopy,
): (...args: unknown[]) => unknown {
	const { api, advice } = site;
	const path = [...site.path];
	return (...args: unknown[]): unknown => {
		const copies = new Map<object, unknown>();
		const taken = schema.args.map((argument, index) =>
			copyStreamValue(args[index], argument, {
				api,
				direction: "take",
				path: [...path, "arguments", index],
				copies,
				advice,
			}),
		);
		const answer = apply(taken);
		const answered: StreamCopy = { api, direction: "hand", path: [...path, "()"], copies: new Map(), advice };
		if (answer !== null && typeof answer === "object" && "then" in answer && typeof answer.then === "function") {
			return Promise.resolve(answer).then(value => copyStreamValue(value, schema.result, answered));
		}
		return copyStreamValue(answer, schema.result, answered);
	};
}

/** A host signal following the `AbortSignal` a session passed: `AbortSignal.any` reads the signal's
 *  own state, never a property the author could have replaced. */
function followSignal(value: unknown, site: StreamCopy): AbortSignal | null | undefined {
	if (value === undefined || value === null) return value;
	try {
		// Checked by `AbortSignal.any` itself, which refuses anything but a signal.
		return AbortSignal.any([value as AbortSignal]);
	} catch {
		throw new Error(`Custom API "${site.api}": ${renderStreamPath(site.path)} is not an AbortSignal.`);
	}
}

/** The init a session passes the host's `fetch`, as {@link StreamSchema} says. */
function copyFetchInit(value: unknown, site: StreamCopy): unknown {
	if (typeof value !== "object" || value === null) return copyStreamValue(value, DATA, site);
	const copy: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		const item: unknown = Reflect.get(value, key);
		site.path.push(key);
		let copied: unknown;
		if (key === "signal") copied = followSignal(item, site);
		else if (key === "headers" && item instanceof Headers) copied = new Headers(item);
		else if (key === "body" && item instanceof ArrayBuffer) copied = ArrayBuffer.prototype.slice.call(item, 0);
		else if (key === "body" && ArrayBuffer.isView(item)) {
			copied = new Uint8Array(item.buffer, item.byteOffset, item.byteLength).slice();
		} else if (key === "body" && typeof item === "object") copied = item;
		else copied = copyStreamValue(item, DATA, site);
		site.path.pop();
		setCopiedKey(copy, key, copied);
	}
	return copy;
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
