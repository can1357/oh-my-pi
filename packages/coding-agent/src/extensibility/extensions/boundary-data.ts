/**
 * What the host copies at the boundary between an extension's hooks and tools and the host: the
 * schema of each value a hook returns and of what a tool returns, the copy of host data the host
 * hands in, and how each field of a registered tool is kept. See "What the host keeps, and when"
 * in `docs/extensions.md`.
 */
import { types } from "node:util";
import { OmpErrors } from "@oh-my-pi/omptype";
import type {
	AgentMessage,
	AgentTool,
	AgentToolArgStream,
	AgentToolArgStreamInit,
	AgentToolResult,
	SpeculativeAuthorization,
	SpeculativeChildDefinition,
	SpeculativeChildHandle,
	SpeculativeLaunchContext,
	SpeculativeOperationSink,
	SpeculativePhysicalOutcome,
	SpeculativeToolReference,
	ToolSpeculationAssessment,
	ToolSpeculationPolicy,
	ToolSpeculationStreamContext,
	ToolSpeculationStreamSession,
} from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Api, AssistantMessage, ImageContent, Model, TextContent } from "@oh-my-pi/pi-ai";
import { AdmittedSignal, type ProviderCallGate } from "@oh-my-pi/pi-ai/auth/provider-gate";
import {
	type ContextHistoryIndexCarrier,
	kContextHistoryIndex,
	kStreamingPartialJson,
} from "@oh-my-pi/pi-ai/utils/block-symbols";
import { wireJsonSchemaOptions } from "@oh-my-pi/pi-ai/utils/schema";
import type { NativeToolView } from "@oh-my-pi/pi-tui/tools/renderer";
import { MODEL_ROW } from "../../config/model-registry";
import type { PythonResult } from "../../eval/py/executor";
import type { BashResult } from "../../exec/bash-executor";
import type { CustomMessagePayload } from "../../session/messages";
import type {
	CacheWarmingDecisionEventResult,
	SessionBeforeBranchResult,
	SessionBeforeCompactResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionCompactingResult,
	SessionStopEventResult,
	ToolCallEventResult,
	ToolResultEventResult,
} from "../shared-events";
import {
	type AuthorDataFields,
	type AuthorDataSchema,
	type AuthorDataSite,
	copyBuiltInData,
	DATA,
	fieldsOf,
	snapshotAuthorData,
	variantsOf,
} from "./author-data";
import { providerCallGate } from "./callback-ownership";
import type {
	AssistantMessageRewriteResult,
	BeforeSubagentSpawnEventResult,
	BeforeAgentStartEventResult,
	ContextEventResult,
	ExtensionCallbackOwner,
	ExtensionEvent,
	InputEventResult,
	ResourcesDiscoverResult,
	ToolDefinition,
	UserBashEventResult,
	UserPythonEventResult,
} from "./types";

const RETURNING_ADVICE = "Compute the value before returning it.";

const IMAGE_FIELDS = {
	data: DATA,
	mimeType: DATA,
	detail: DATA,
	providerFile: fieldsOf<NonNullable<ImageContent["providerFile"]>>({
		provider: DATA,
		id: DATA,
		uri: DATA,
		expiresAt: DATA,
	}),
	url: DATA,
} as const;

/** A text or image block: what a tool result, a user message and a custom message carry. */
const TEXT_OR_IMAGE = variantsOf<TextContent | ImageContent, "type">("type", {
	text: { text: DATA, textSignature: DATA },
	image: IMAGE_FIELDS,
});
const TEXT_OR_IMAGE_LIST: AuthorDataSchema = { kind: "items", items: TEXT_OR_IMAGE };
const IMAGE_LIST: AuthorDataSchema = {
	kind: "items",
	items: variantsOf<ImageContent, "type">("type", { image: IMAGE_FIELDS }),
};

/** A block of an assistant message. */
const ASSISTANT_BLOCK = variantsOf<AssistantMessage["content"][number], "type">("type", {
	text: { text: DATA, textSignature: DATA },
	thinking: { thinking: DATA, thinkingSignature: DATA, itemId: DATA, summary: DATA, narration: DATA },
	redactedThinking: { data: DATA },
	fallback: { from: DATA, to: DATA },
	anthropicServerTool: { block: DATA },
	image: IMAGE_FIELDS,
	toolCall: {
		id: DATA,
		name: DATA,
		arguments: DATA,
		[kStreamingPartialJson]: DATA,
		thoughtSignature: DATA,
		intent: DATA,
		rawBlock: DATA,
		customWireName: DATA,
		providerMetadata: DATA,
	},
});
const ASSISTANT_CONTENT: AuthorDataSchema = { kind: "items", items: ASSISTANT_BLOCK };

/**
 * Host content as the copy of an `assistant_message` replacement reads it: the fields each block
 * declares, without the host's symbol-keyed markers. What a replacement is compared against, so a
 * block the handler left alone compares equal to the block it was handed.
 */
export function assistantContentAsCopied(content: AssistantMessage["content"]): AssistantMessage["content"] {
	return snapshotAuthorData(
		content,
		ASSISTANT_CONTENT,
		{ subject: "Host", path: ["assistant content"], advice: "" },
		new Map(),
	) as AssistantMessage["content"];
}

/** The position in history the host gave a message it handed a `context` hook — read back from
 *  the message the hook returns, so a message kept as it was is recognized as that entry. */
const HISTORY_INDEX = { [kContextHistoryIndex]: DATA } as const;
const CUSTOM_MESSAGE_FIELDS = {
	customType: DATA,
	content: TEXT_OR_IMAGE_LIST,
	display: DATA,
	details: DATA,
	attribution: DATA,
	timestamp: DATA,
} as const;

/** A message a `context` hook returns, by role. */
const CONTEXT_MESSAGE = variantsOf<AgentMessage & ContextHistoryIndexCarrier, "role">("role", {
	user: {
		...HISTORY_INDEX,
		content: TEXT_OR_IMAGE_LIST,
		synthetic: DATA,
		steering: DATA,
		liveSteered: DATA,
		historyRewriteAt: DATA,
		attribution: DATA,
		providerPayload: DATA,
		timestamp: DATA,
	},
	developer: {
		...HISTORY_INDEX,
		content: TEXT_OR_IMAGE_LIST,
		attribution: DATA,
		synthetic: DATA,
		userInitiated: DATA,
		providerPayload: DATA,
		timestamp: DATA,
	},
	assistant: {
		...HISTORY_INDEX,
		content: ASSISTANT_CONTENT,
		api: DATA,
		provider: DATA,
		model: DATA,
		credentialId: DATA,
		contextSnapshot: DATA,
		retryRecovery: DATA,
		responseId: DATA,
		upstreamProvider: DATA,
		upstreamModel: DATA,
		serviceTier: DATA,
		usage: DATA,
		elidedOutputTokens: DATA,
		stopReason: DATA,
		stopDetails: DATA,
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
	},
	toolResult: {
		...HISTORY_INDEX,
		toolCallId: DATA,
		toolName: DATA,
		content: TEXT_OR_IMAGE_LIST,
		details: DATA,
		isError: DATA,
		attribution: DATA,
		prunedAt: DATA,
		providerMetadata: DATA,
		useless: DATA,
		timestamp: DATA,
	},
	custom: { ...HISTORY_INDEX, ...CUSTOM_MESSAGE_FIELDS },
	hookMessage: { ...HISTORY_INDEX, ...CUSTOM_MESSAGE_FIELDS },
	branchSummary: { ...HISTORY_INDEX, summary: DATA, fromId: DATA, timestamp: DATA },
	compactionSummary: {
		...HISTORY_INDEX,
		summary: DATA,
		shortSummary: DATA,
		tokensBefore: DATA,
		tokensAfter: DATA,
		method: DATA,
		providerPayload: DATA,
		blocks: TEXT_OR_IMAGE_LIST,
		images: IMAGE_LIST,
		warning: DATA,
		historyRewriteAt: DATA,
		timestamp: DATA,
	},
	bashExecution: {
		...HISTORY_INDEX,
		command: DATA,
		output: DATA,
		exitCode: DATA,
		cancelled: DATA,
		truncated: DATA,
		images: IMAGE_LIST,
		meta: DATA,
		timestamp: DATA,
		excludeFromContext: DATA,
	},
	pythonExecution: {
		...HISTORY_INDEX,
		code: DATA,
		output: DATA,
		exitCode: DATA,
		cancelled: DATA,
		truncated: DATA,
		meta: DATA,
		timestamp: DATA,
		excludeFromContext: DATA,
	},
	fileMention: { ...HISTORY_INDEX, files: DATA, timestamp: DATA },
});

const COMPACTION_RESULT = fieldsOf<CompactionResult>({
	summary: DATA,
	shortSummary: DATA,
	firstKeptEntryId: DATA,
	tokensBefore: DATA,
	details: DATA,
	preserveData: DATA,
	providerReplayThroughEntryId: DATA,
});

const COMMAND_OUTPUT_FIELDS = {
	output: DATA,
	exitCode: DATA,
	cancelled: DATA,
	truncated: DATA,
	artifactId: DATA,
	artifactElidedBytes: DATA,
	artifactError: DATA,
	totalLines: DATA,
	totalBytes: DATA,
	outputLines: DATA,
	outputBytes: DATA,
} as const;

/**
 * What the host reads of each hook's result, by event. `null` where the host reads nothing of
 * what the handler returns — the result is discarded unread. One entry for every event, so an
 * event added to `ExtensionEvent` does not compile until it says which.
 */
const HANDLER_RESULTS: { readonly [T in ExtensionEvent["type"]]-?: AuthorDataSchema | null } = {
	resources_discover: fieldsOf<ResourcesDiscoverResult>({ skillPaths: DATA, promptPaths: DATA, themePaths: DATA }),
	session_start: null,
	session_before_switch: fieldsOf<SessionBeforeSwitchResult>({ cancel: DATA }),
	session_switch: null,
	session_before_branch: fieldsOf<SessionBeforeBranchResult>({ cancel: DATA, skipConversationRestore: DATA }),
	session_branch: null,
	session_before_compact: fieldsOf<SessionBeforeCompactResult>({ cancel: DATA, compaction: COMPACTION_RESULT }),
	"session.compacting": fieldsOf<SessionCompactingResult>({ context: DATA, prompt: DATA, preserveData: DATA }),
	session_compact: null,
	session_stop: fieldsOf<SessionStopEventResult>({
		continue: DATA,
		additionalContext: DATA,
		decision: DATA,
		reason: DATA,
	}),
	session_shutdown: null,
	session_before_tree: fieldsOf<SessionBeforeTreeResult>({
		cancel: DATA,
		summary: fieldsOf<NonNullable<SessionBeforeTreeResult["summary"]>>({ summary: DATA, details: DATA }),
	}),
	session_tree: null,
	goal_updated: null,
	context: fieldsOf<ContextEventResult>({ messages: { kind: "items", items: CONTEXT_MESSAGE } }),
	cache_warming_decision: fieldsOf<CacheWarmingDecisionEventResult>({ action: DATA }),
	// The replacement payload is the request body itself: an open record, sent as it is.
	before_provider_request: DATA,
	after_provider_response: null,
	before_agent_start: fieldsOf<BeforeAgentStartEventResult>({
		message: fieldsOf<Exclude<CustomMessagePayload, string>>({
			customType: DATA,
			content: TEXT_OR_IMAGE_LIST,
			display: DATA,
			details: DATA,
			attribution: DATA,
		}),
		systemPrompt: DATA,
	}),
	before_subagent_spawn: fieldsOf<BeforeSubagentSpawnEventResult>({
		model: DATA,
		block: DATA,
		reason: DATA,
		note: DATA,
	}),
	agent_start: null,
	agent_end: null,
	turn_start: null,
	turn_end: null,
	message_start: null,
	message_update: null,
	message_end: null,
	assistant_message: fieldsOf<AssistantMessageRewriteResult>({ content: ASSISTANT_CONTENT }),
	tool_execution_start: null,
	tool_execution_update: null,
	tool_execution_end: null,
	auto_compaction_start: null,
	auto_compaction_end: null,
	auto_retry_start: null,
	auto_retry_end: null,
	retry_fallback_applied: null,
	retry_fallback_succeeded: null,
	ttsr_triggered: null,
	todo_reminder: null,
	credential_disabled: null,
	mcp_notification: null,
	link_activate: null,
	user_bash: fieldsOf<UserBashEventResult>({
		result: fieldsOf<BashResult>({ ...COMMAND_OUTPUT_FIELDS, timedOut: DATA, workingDir: DATA, images: IMAGE_LIST }),
	}),
	user_python: fieldsOf<UserPythonEventResult>({
		result: fieldsOf<PythonResult>({ ...COMMAND_OUTPUT_FIELDS, displayOutputs: DATA, stdinRequested: DATA }),
	}),
	input: fieldsOf<InputEventResult>({ handled: DATA, text: DATA, images: IMAGE_LIST }),
	tool_call: fieldsOf<ToolCallEventResult>({ block: DATA, reason: DATA, input: DATA, additionalContext: DATA }),
	tool_result: fieldsOf<ToolResultEventResult>({
		content: TEXT_OR_IMAGE_LIST,
		details: DATA,
		isError: DATA,
		additionalContext: DATA,
	}),
	tool_approval_requested: null,
	tool_approval_resolved: null,
	plan_review_requested: null,
	plan_review_resolved: null,
	mode_changed: null,
};

/**
 * The host's copy of what one hook handler returned, taken inside the handler's admission —
 * call it in the admitted call, then use only the copy. `undefined` for an event whose result
 * the host never reads; that result is not touched at all. A function where data belongs is
 * refused with its field path, as a registration's is.
 */
export function copyHandlerResult(eventType: string, value: unknown, extensionPath: string): unknown {
	const schema = (HANDLER_RESULTS as Readonly<Record<string, AuthorDataSchema | null>>)[eventType];
	if (!schema) return undefined;
	return snapshotAuthorData(
		value,
		schema,
		{ subject: `Extension ${extensionPath}`, path: [`${eventType} handler result`], advice: RETURNING_ADVICE },
		new Map(),
	);
}

const TOOL_RESULT = fieldsOf<AgentToolResult>({
	content: TEXT_OR_IMAGE_LIST,
	details: DATA,
	isError: DATA,
	providerMetadata: DATA,
	useless: DATA,
});

/**
 * The host's copy of a result an extension tool produced — what `execute` resolved with, or a
 * partial result it passed to `onUpdate` — taken inside the tool's admission.
 */
export function copyToolResult(
	value: unknown,
	toolName: string,
	extensionPath: string,
	origin: "execute() result" | "onUpdate() partial result",
): AgentToolResult {
	return snapshotAuthorData(
		value,
		TOOL_RESULT,
		{ subject: `Extension ${extensionPath}`, path: [`tool ${toolName} ${origin}`], advice: RETURNING_ADVICE },
		new Map(),
	) as AgentToolResult;
}

/**
 * The host's copy of a view an extension tool's `describeCall` or `describeResult` answered,
 * taken inside the tool's admission. A view is data — head spans, body nodes — so it is copied as
 * data, and a function anywhere in it is refused with its path.
 */
export function copyToolView(
	value: NativeToolView | undefined,
	toolName: string,
	extensionPath: string,
	origin: "describeCall() view" | "describeResult() view",
): NativeToolView | undefined {
	return snapshotAuthorData(
		value,
		DATA,
		{ subject: `Extension ${extensionPath}`, path: [`tool ${toolName} ${origin}`], advice: RETURNING_ADVICE },
		new Map(),
	) as NativeToolView | undefined;
}

/**
 * The signals one admitted call hands its author, each in place of a signal of the caller's: one
 * {@link AdmittedSignal} per caller signal, admitted inside the call and let go of together at its
 * terminal. A hook's event can carry several (`session_stop`, `session_before_compact` and
 * `session_before_tree` each carry one); `copyHostData` swaps each for its admitted counterpart.
 *
 * An author's abort listener on the caller's own signal would run inside the caller's
 * `controller.abort()`, outside the session that installed it, and after that session has gone.
 * On the admitted one it runs inside the admission, with the caller's reason and in the same turn;
 * a caller already aborted is aborted before the author is called; and at {@link release} it
 * stops following the caller, so nothing the author installed outlives the call.
 */
export class HandedSignals {
	readonly #gate: ProviderCallGate | undefined;
	readonly #admitted = new Map<AbortSignal, AdmittedSignal>();
	#released = false;

	/** `gate` is the owning session's (`providerCallGate`), absent for a runner without an owner,
	 *  whose callbacks run as the host's own and are handed the caller's signals. */
	constructor(gate: ProviderCallGate | undefined) {
		this.#gate = gate;
	}

	/** The signal to hand the author in place of `caller`. Call it inside the admitted call. Asked
	 *  after {@link release}, it follows the caller no further. */
	admit(caller: AbortSignal): AbortSignal {
		let admitted = this.#admitted.get(caller);
		if (!admitted) {
			admitted = new AdmittedSignal(this.#gate, caller);
			this.#admitted.set(caller, admitted);
		}
		const signal = admitted.admit() ?? caller;
		if (this.#released) admitted.release();
		return signal;
	}

	/** Lets go of every caller signal: the call site's, at the terminal of the call. Bound, and
	 *  harmless to call again. */
	readonly release = (): void => {
		this.#released = true;
		for (const admitted of this.#admitted.values()) admitted.release();
	};
}

/**
 * The copy of host data the host hands in to an extension's callback — a hook's event, a tool's
 * arguments, a fallback's request — so that what the callback does to it (an edit in place, an
 * installed getter) stays on the copy, and the host's own record reads the same afterwards.
 *
 * What reaches here is data, and it is copied as data whatever it was built with. Whether a value
 * crosses the boundary as itself is decided by what it is for, never by its shape or by what holds
 * it: the host hands a capability only through a surface built for it (`context-surfaces.ts`,
 * {@link handHostModel}, a callable tool schema in `getAllTools()`, a thinking renderer's
 * `requestRender`), and nothing found inside data is one.
 *
 * Objects, arrays, maps and sets are copied all the way down; strings and the other primitives are
 * shared, since nothing can change them. Binary data and dates are copied (`copyBuiltInData`), and
 * a regular expression and a URL are rebuilt from what they hold. An object of any other class is
 * copied as the data it holds, as `structuredClone` copies one: its own enumerable string-keyed
 * fields, onto a plain object, without its prototype's methods. An error is copied with its own
 * properties (`message`, `code`, `errno`) and its `name` and `message` as they read, onto the
 * nearest of the language's own error classes it extends (`TypeError`, `RangeError`, `Error`): a
 * host's error class is the host's code, and its prototype's getters and methods reach whatever
 * made it. An `AbortSignal` is handed as the counterpart `signals` admits for it, or, when the
 * call hands none, as a signal of its own that follows it. A function is behavior, not data,
 * wherever it sits — a field of a record or of an instance, an array element, a map's key or
 * value, a set's member, an error's property: a bound method or an arrow function reaches the
 * private state of whatever made it. It is dropped, as the session file drops it when the host
 * persists the same record (an array keeps the slot, `undefined`). Symbol-keyed host markers stay
 * with the host, as `structuredClone` leaves them.
 *
 * The walk stops at {@link HOST_DATA_DEPTH_LIMIT} levels: an object nested deeper is left out, as
 * a dropped function is (`undefined` in its place). Cycles are copied as cycles, but a getter can
 * answer a fresh object on every read, and no identity check ends that walk; the bound does, at
 * the same place whatever the stack, and real host data nests nowhere near it.
 */
export function copyHostData<T>(value: T, signals?: HandedSignals): T {
	return copyHostValue(value, new Map(), signals, false, 0) as T;
}

/** How deep host data handed to an extension is copied ({@link copyHostData}). */
export const HOST_DATA_DEPTH_LIMIT = 512;

function pastHostDepth(depth: number): boolean {
	return depth > HOST_DATA_DEPTH_LIMIT;
}

/**
 * A model the host hands an extension — the session's (`ctx.model`, `ctx.models.current()`), a
 * registry row (`ctx.models.list()`, `ctx.modelRegistry.find()`) — copied by what a model is,
 * whatever object holds it: a registry row and a class an SDK caller selected are handed alike.
 *
 * The host goes on building requests from its own model after the extension is done with this one
 * — the credential `provider` chooses, the endpoint `baseUrl` names — so the copy is the
 * extension's alone: every field a model declares ({@link MODEL_ROW}), and every field of the
 * shapes those fields declare in turn — its cost, its identity, its thinking — each read as the
 * host reads it (a class's getter or an inherited field included) and copied onto a plain object.
 * A field the type leaves open (`compat`, `kindConfig`, `headers`, `requestMetadata`) is read the
 * same way all the way down: the host reads a value there by property access, so an object held
 * there arrives with what its accessors answer — its own, enumerable or not, and its classes' —
 * not as the `{}` its own enumerable fields would make. A getter that throws throws here, as it
 * does when the host reads the model. The walk is bounded as {@link copyHostData}'s is. A
 * `resolveHeaders` is the host's code, not data: the copy's calls it on the host's model, with a
 * signal of the host's own that follows the one the extension passes, and answers a copy.
 */
export function handHostModel(model: Model<Api>): Model<Api> {
	const copies = new Map<AuthorDataSchema, Map<object, unknown>>();
	const copy: Record<PropertyKey, unknown> = {};
	for (const [field, schema] of MODEL_ROW.fields) {
		const value: unknown = Reflect.get(model, field);
		if (value === undefined) continue;
		copy[field] =
			field === "resolveHeaders" && typeof value === "function"
				? handHostResolver(value, model)
				: copyHostDeclared(value, schema, copies, 1);
	}
	// Built from every field `Model` declares (`MODEL_ROW` is checked against it), so it is one.
	const handed = copy as unknown as Model<Api>;
	return handed;
}

/**
 * Host data copied by the schema of what it is declared to be: a known shape field by field, read
 * the way a field read reads it — so a class's getter and an inherited field arrive as the host
 * sees them, which a copy of own enumerable fields would miss — and an open value as data read the
 * same way ({@link copyHostRead}). The host's counterpart of `snapshotAuthorData`, without its
 * refusal of functions: this is the host's data, not an author's.
 */
function copyHostDeclared(
	value: unknown,
	schema: AuthorDataSchema,
	copies: Map<AuthorDataSchema, Map<object, unknown>>,
	depth: number,
): unknown {
	if (typeof value !== "object" || value === null) return value;
	if (pastHostDepth(depth)) return undefined;
	if (schema.kind === "data" || schema.kind === "callback") return copyHostRead(value, depth);
	let copied = copies.get(schema);
	if (!copied) {
		copied = new Map();
		copies.set(schema, copied);
	}
	const known = copied.get(value);
	if (known !== undefined) return known;
	if (schema.kind === "items") {
		if (!Array.isArray(value)) return copyHostRead(value, depth);
		const copy: unknown[] = [];
		copied.set(value, copy);
		for (let index = 0; index < value.length; index++)
			copy[index] = copyHostDeclared(value[index], schema.items, copies, depth + 1);
		return copy;
	}
	if (Array.isArray(value)) return copyHostRead(value, depth);
	const copy: Record<PropertyKey, unknown> = {};
	copied.set(value, copy);
	const copyFields = (fields: AuthorDataFields["fields"]): void => {
		for (const [field, fieldSchema] of fields) {
			const item = copyHostDeclared(Reflect.get(value, field), fieldSchema, copies, depth + 1);
			if (item !== undefined) copy[field] = item;
		}
	};
	switch (schema.kind) {
		case "fields":
			copyFields(schema.fields);
			return copy;
		case "variants": {
			const tag: unknown = Reflect.get(value, schema.by);
			const variant = schema.variants.get(tag);
			if (!variant) return copyHostRead(value, depth);
			if (tag !== undefined) copy[schema.by] = tag;
			copyFields(variant.fields);
			return copy;
		}
		case "entries":
			for (const key of Object.keys(value)) {
				const item = copyHostDeclared(Reflect.get(value, key), schema.entries, copies, depth + 1);
				// Assigning an own `__proto__` key would set the copy's prototype; defined, it stays data.
				Object.defineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true });
			}
			return copy;
	}
}

function handHostResolver(resolver: Function, model: Model<Api>): NonNullable<Model<Api>["resolveHeaders"]> {
	return async signal => {
		const followed = signal === undefined ? undefined : AbortSignal.any([signal]);
		const headers: Record<string, string> | undefined = await Reflect.apply(resolver, model, [followed]);
		return copyHostData(headers);
	};
}

/**
 * Host data copied as {@link copyHostData} copies it, except that an object is read as the host
 * reads it: what each property a read answers for holds — its own, enumerable or not, accessors
 * included, and the getters and inherited data fields of its classes. For a value the host reads
 * by property access — a model's open fields — where a copy of own enumerable fields alone would
 * hand an extension less than the host itself sees.
 */
function copyHostRead(value: unknown, depth: number): unknown {
	return copyHostValue(value, new Map(), undefined, true, depth);
}

/** The keys a property read of `value` answers for: its own string-keyed properties, enumerable
 *  or not, then the getters and non-function data fields its classes define, nearest first. */
function readableKeys(value: object): string[] {
	const keys = new Set(Object.getOwnPropertyNames(value));
	for (
		let prototype: object | null = Object.getPrototypeOf(value);
		prototype !== null && prototype !== Object.prototype;
		prototype = Object.getPrototypeOf(prototype)
	) {
		for (const key of Object.getOwnPropertyNames(prototype)) {
			if (key === "constructor" || key === "__proto__") continue;
			const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
			if (descriptor?.get !== undefined || (descriptor !== undefined && typeof descriptor.value !== "function")) {
				keys.add(key);
			}
		}
	}
	return [...keys];
}

/** The language's and the platform's own error classes' prototypes: an error copy is built on one
 *  of these, whose members are the engine's, never on a host error class's. `DOMException` is the
 *  platform's (an `AbortError` is one); its `name`, `message` and `code` are answered from the
 *  original as own data, since its accessors read state a copy does not have. */
const INTRINSIC_ERROR_PROTOTYPES: ReadonlySet<object> = new Set([
	Error.prototype,
	EvalError.prototype,
	RangeError.prototype,
	ReferenceError.prototype,
	SyntaxError.prototype,
	TypeError.prototype,
	URIError.prototype,
	AggregateError.prototype,
	DOMException.prototype,
]);

/** The nearest of the language's own error prototypes `error` inherits from. */
function intrinsicErrorPrototype(error: object): object {
	for (
		let prototype: object | null = Object.getPrototypeOf(error);
		prototype !== null;
		prototype = Object.getPrototypeOf(prototype)
	) {
		if (INTRINSIC_ERROR_PROTOTYPES.has(prototype)) return prototype;
	}
	return Error.prototype;
}

function copyHostValue(
	value: unknown,
	copies: Map<object, unknown>,
	signals: HandedSignals | undefined,
	byRead: boolean,
	depth: number,
): unknown {
	if (typeof value === "function") return undefined;
	if (typeof value !== "object" || value === null) return value;
	const known = copies.get(value);
	if (known !== undefined) return known;
	if (pastHostDepth(depth)) return undefined;
	const next = (item: unknown): unknown => copyHostValue(item, copies, signals, byRead, depth + 1);
	if (value instanceof AbortSignal) {
		const admitted = signals ? signals.admit(value) : AbortSignal.any([value]);
		copies.set(value, admitted);
		return admitted;
	}
	const builtIn = copyBuiltInData(value);
	if (builtIn !== undefined) {
		copies.set(value, builtIn);
		return builtIn;
	}
	if (types.isRegExp(value)) {
		const copy = new RegExp(value);
		copies.set(value, copy);
		return copy;
	}
	if (value instanceof URL) {
		const copy = new URL(value.href);
		copies.set(value, copy);
		return copy;
	}
	if (value instanceof URLSearchParams) {
		const copy = new URLSearchParams(value);
		copies.set(value, copy);
		return copy;
	}
	if (Array.isArray(value)) {
		const copy: unknown[] = [];
		copies.set(value, copy);
		for (let index = 0; index < value.length; index++) copy[index] = next(value[index]);
		return copy;
	}
	if (types.isMap(value)) {
		const copy = new Map<unknown, unknown>();
		copies.set(value, copy);
		for (const [key, item] of value) {
			if (typeof key === "function" || typeof item === "function") continue;
			copy.set(next(key), next(item));
		}
		return copy;
	}
	if (types.isSet(value)) {
		const copy = new Set<unknown>();
		copies.set(value, copy);
		for (const item of value) if (typeof item !== "function") copy.add(next(item));
		return copy;
	}
	// `DOMException` is no native error to the engine's check, but it is the platform's error class.
	if (types.isNativeError(value) || value instanceof DOMException) {
		const copy: object = Object.create(intrinsicErrorPrototype(value));
		copies.set(value, copy);
		const define = (key: string, item: unknown, enumerable: boolean): void => {
			Object.defineProperty(copy, key, { value: item, enumerable, writable: true, configurable: true });
		};
		for (const key of Object.getOwnPropertyNames(value)) {
			const raw: unknown = Reflect.get(value, key);
			if (typeof raw === "function") continue;
			define(key, next(raw), Object.getOwnPropertyDescriptor(value, key)?.enumerable === true);
		}
		// A host error class may answer its name and message from its prototype; the copy's
		// prototype is the language's, so what they read is kept as data, as is a `code`.
		for (const key of ["name", "message", "code"]) {
			if (Object.hasOwn(copy, key)) continue;
			const read: unknown = Reflect.get(value, key);
			if ((typeof read === "string" || typeof read === "number") && key in value) define(key, read, false);
		}
		return copy;
	}
	const copy: Record<string, unknown> = {};
	copies.set(value, copy);
	for (const key of byRead ? readableKeys(value) : Object.keys(value)) {
		const raw: unknown = Reflect.get(value, key);
		if (typeof raw === "function") continue;
		const item = next(raw);
		// Assigning an own `__proto__` key would set the copy's prototype; defined, it stays data.
		if (key === "__proto__") {
			Object.defineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true });
		} else {
			copy[key] = item;
		}
	}
	return copy;
}

/** What admitting one field of a registered tool knows: whose it is and where it is kept. */
interface ToolFieldAdmission {
	readonly owner: ExtensionCallbackOwner;
	/** The extension's own object: the receiver its callbacks are applied to. */
	readonly receiver: object;
	readonly extensionPath: string;
	readonly subject: string;
}

/**
 * How the host keeps one field of a tool definition an extension registers.
 *
 * - `data`: copied as data, once, at registration.
 * - `bound`: a callback captured once, applied to the extension's own object, that the host
 *   invokes only inside an admission of its own: `execute` through the tool wrapper, `onSession`,
 *   and the renderers (`renderCall`, `renderResult`, `describeCall`, `describeResult`), which the
 *   tool adapter (`RegisteredToolAdapter`) runs on copies and refuses once the session has gone.
 * - `owned`: a callback the host invokes from its own code and then acts on what it answers — an
 *   approval decision, a remembered grant's targets, a shell's environment. Captured once, it
 *   runs as the session's work (refused once the session has gone), on copies of the host's
 *   arguments, and its answer is copied by `owned` before the call returns. A value that is not
 *   a function (`approval: "read"`, `concurrency: "exclusive"`) is data.
 * - `admitted`: a field whose shape takes more than one of those — the parameter schema (data,
 *   or a schema whose checks are the extension's code), `openArgStream` and `speculation` (a
 *   callback that hands back an object of callbacks). Its function says how, below.
 */
type ToolDefinitionField =
	| "data"
	| "bound"
	| { readonly owned: AuthorDataSchema }
	| { readonly admitted: (value: unknown, admission: ToolFieldAdmission) => unknown };

/** Every field the host reads off a registered tool: the definition's own, and the agent-tool
 *  fields the tool adapter forwards from it. */
type RegisterableTool = ToolDefinition & Omit<AgentTool, keyof ToolDefinition>;

/** One entry for every field, so a field added to either type does not compile until it says how
 *  the host keeps it. */
const TOOL_DEFINITION_FIELDS: { readonly [K in keyof RegisterableTool]-?: ToolDefinitionField } = {
	name: "data",
	label: "data",
	description: "data",
	parameters: { admitted: admitParameterSchema },
	hidden: "data",
	defaultInactive: "data",
	loadMode: "data",
	deferrable: "data",
	readsSkillUris: "data",
	approval: { owned: DATA },
	approvalCacheTargets: { owned: DATA },
	strict: "data",
	mcpServerName: "data",
	mcpToolName: "data",
	mcpReadOnlyHint: "data",
	legacyName: "data",
	shellEnv: { owned: DATA },
	sourcePath: "data",
	execute: "bound",
	onSession: "bound",
	renderCall: "bound",
	renderResult: "bound",
	describeCall: "bound",
	describeResult: "bound",
	openArgStream: { admitted: admitArgStream },
	summary: "data",
	delegationGuidance: "data",
	docTopics: { owned: DATA },
	concurrency: { owned: DATA },
	speculation: { admitted: admitSpeculationPolicy },
	lenientArgValidation: "data",
	interruptible: { owned: DATA },
	handlesToolInterrupt: "data",
	intent: { owned: DATA },
	matcherDigest: { owned: DATA },
	matcherPaths: { owned: DATA },
	matcherEntries: { owned: DATA },
	formatApprovalDetails: { owned: DATA },
	approvalRestrictionPaths: { owned: DATA },
	deferLoading: "data",
	customFormat: "data",
	customWireName: "data",
	native: "data",
	examples: "data",
};

const REGISTERING_ADVICE = "Compute the value before registering the tool.";

/**
 * The host's copy of a tool definition an extension registers, taken inside the registering
 * call — the extension's factory or a handler, both its admission.
 *
 * The definition is the extension's object, and everything the host later reads off it would be
 * the extension's code: a getter on `description` runs whenever a request is built, an
 * `approvalCacheTargets` decides which grants an approval records, a `shellEnv` chooses the
 * environment a shell is started with — all from host code, outside the session's admission and
 * after its retirement. So each field is read once, here: data is copied, the callbacks are
 * captured as they were and kept on the extension's own object as receiver, and the ones whose
 * answer the host acts on run as the session's work on copies of the host's arguments, their
 * answer copied before they return. A field neither type declares is not kept.
 *
 * Also the copy of a tool a speculation stream session hands its coordinator as a child, and of
 * the tool reference it asks a launch for: those reach host code the same way.
 */
export function admitToolDefinition<T extends ToolDefinition<any, any>>(
	definition: T,
	owner: ExtensionCallbackOwner,
	extensionPath: string,
): T {
	const subject = `Extension ${extensionPath}`;
	const admitted: Record<string, unknown> = {};
	const copies = new Map<AuthorDataSchema, Map<object, unknown>>();
	for (const [field, keep] of Object.entries<ToolDefinitionField>(TOOL_DEFINITION_FIELDS)) {
		const value: unknown = Reflect.get(definition, field);
		if (value === undefined) continue;
		if (typeof keep === "object" && "admitted" in keep) {
			admitted[field] = keep.admitted(value, { owner, receiver: definition, extensionPath, subject });
		} else if (typeof value === "function" && keep === "bound") {
			// Applied to the definition the extension registered, so a class keeps its receiver.
			admitted[field] = (...args: unknown[]): unknown => Reflect.apply(value, definition, args);
		} else if (typeof value === "function" && typeof keep === "object") {
			admitted[field] = owner.ownCallback((...args: unknown[]): unknown =>
				snapshotAuthorData(
					Reflect.apply(
						value,
						definition,
						args.map(arg => copyHostData(arg)),
					),
					keep.owned,
					{ subject, path: [`${field}() result`], advice: RETURNING_ADVICE },
					new Map(),
				),
			);
		} else {
			admitted[field] = snapshotAuthorData(value, DATA, registrationSite(subject, field), copies);
		}
	}
	return admitted as T;
}

function registrationSite(subject: string, field: string): AuthorDataSite {
	return { subject, path: [`registerTool() ${field}`], advice: REGISTERING_ADVICE };
}

/** A callback an extension hands over, as the host holds it until it applies it. */
type AuthorCallback = (...args: never[]) => unknown;

/** The callback `holder[key]`, read once, or `undefined` when there is none. A value that is not
 *  one is refused, naming its path — the host would otherwise call it later and fail there. */
function optionalCallbackOf(holder: object, key: string, subject: string, at: string): AuthorCallback | undefined {
	const value: unknown = Reflect.get(holder, key);
	if (value === undefined) return undefined;
	if (typeof value !== "function") throw new Error(`${subject}: ${at}.${key} is not a function.`);
	return value as AuthorCallback;
}

/** {@link optionalCallbackOf} for a callback the host cannot do without. */
function callbackOf(holder: object, key: string, subject: string, at: string): AuthorCallback {
	const callback = optionalCallbackOf(holder, key, subject, at);
	if (!callback) throw new Error(`${subject}: ${at}.${key} is not a function.`);
	return callback;
}

/**
 * `callback` as the host calls it when nothing the host does depends on its answer — a stream's
 * `push`, a session's `discard`: as the session's work, on copies of the host's arguments, and a
 * no-op once the session has gone, since there is nothing left for it to act on. The author's
 * answer is returned so that the session waits for it when it is a promise.
 */
function inertOnceRetired(owner: ExtensionCallbackOwner, callback: AuthorCallback, receiver: object) {
	return owner.ownCallback((...args: unknown[]): unknown =>
		Reflect.apply(
			callback,
			receiver,
			args.map(arg => copyHostData(arg)),
		),
	);
}

/**
 * A registered tool's parameter schema, as the host keeps it.
 *
 * A JSON Schema document — plain objects and arrays, the shape a legacy TypeBox schema has too —
 * is copied as data: each own enumerable key read once, here, and a function anywhere in it
 * refused with its path. Validation and the wire schema read that copy; the extension's object is
 * never read again, so an edit to it after registration changes nothing the host checks.
 *
 * A callable schema — omptype's `type`, `pi.zod` or `pi.typebox` builders, an ArkType `Type` —
 * cannot be copied that way: its checks are code, and some of that code is the extension's own
 * (`.narrow()`, `.refine()`, `.pipe()`, a message formatter). So the host keeps its own callable
 * in its place. The JSON Schema the wire carries is asked for once, here, and copied as data, so
 * building a request runs no extension code. It is asked with options of its own
 * (`wireJsonSchemaOptions`): `toJsonSchema` may be the extension's code, and a getter or a
 * replaced `fallback` it leaves on a shared options object would answer for the next schema
 * asked, another session's included. Validation calls the extension's schema as the
 * session's work — refused once the session has gone — on a copy of the arguments, and copies
 * what it answers before the call returns: the validated value as data, a failure as the host's
 * own `OmpErrors` with each message computed inside the call. The host's callable is frozen, so
 * an extension handed it back (`getAllTools()`) cannot change it either.
 */
function admitParameterSchema(value: unknown, { owner, subject }: ToolFieldAdmission): unknown {
	const site = registrationSite(subject, "parameters");
	if (typeof value === "function") {
		// Read once each: `isArkSchema` asks exactly these two, and only this read is called.
		const toJsonSchema: unknown = Reflect.get(value, "toJsonSchema");
		const assert: unknown = Reflect.get(value, "assert");
		if (typeof toJsonSchema === "function" && typeof assert === "function") {
			return admitCallableSchema(value, toJsonSchema, owner, site);
		}
	}
	return snapshotAuthorData(value, DATA, site, new Map());
}

function admitCallableSchema(
	schema: Function,
	toJsonSchema: Function,
	owner: ExtensionCallbackOwner,
	site: AuthorDataSite,
): (data: unknown) => unknown {
	const wire = snapshotAuthorData(
		Reflect.apply(toJsonSchema, schema, [wireJsonSchemaOptions()]),
		DATA,
		{ ...site, path: [...site.path, "toJsonSchema()"] },
		new Map(),
	);
	const checkSite: AuthorDataSite = {
		subject: site.subject,
		path: ["parameters schema result"],
		advice: RETURNING_ADVICE,
	};
	const check = (data: unknown): unknown =>
		owner.runOwned(() => copySchemaAnswer(Reflect.apply(schema, undefined, [copyHostData(data)]), checkSite));
	return Object.freeze(
		Object.assign((data: unknown): unknown => check(data), {
			toJsonSchema: (): unknown => structuredClone(wire),
			assert: (data: unknown): unknown => {
				const out = check(data);
				if (out instanceof OmpErrors) out.throw();
				return out;
			},
		}),
	);
}

/** What a callable schema answered, as the host keeps it: a failure rebuilt as the host's own
 *  `OmpErrors` from each entry's path and message — read here, inside the call, where a message
 *  formatter of the extension's runs — and anything else copied as data. An `OmpErrors` always
 *  holds at least one failure. */
function copySchemaAnswer(out: unknown, site: AuthorDataSite): unknown {
	if (!(out instanceof OmpErrors)) return snapshotAuthorData(out, DATA, site, new Map());
	return rebuildOmpErrors(out);
}

function rebuildOmpErrors(out: OmpErrors): OmpErrors {
	return Array.from(
		out,
		entry =>
			new OmpErrors(Array.from(entry.path), String(entry.expected), undefined, { message: String(entry.message) }),
	).reduce((copy, failure) => copy.append(failure));
}

/** Each host schema handed out, so every read of one tool hands the same schema. */
const handedHostSchemas = new WeakMap<Function, Function>();

/**
 * A callable schema the host holds — a built-in tool's, or the one a registered tool's admission
 * made — as `pi.getAllTools()` hands it: a frozen schema of the extension's own with the members
 * a schema is used through, each calling the host's. Calling it or its `assert` validates a copy
 * of the value with the host's schema and answers a copy (a failure as `OmpErrors` rebuilt from
 * each entry); `toJsonSchema` answers a copy of what the host's answers. The host's object is
 * never handed: it is the one the host validates and builds requests with, and caches its wire
 * schema on, so neither freezing it nor letting the extension set members on it is safe. Handed
 * back to `pi.registerTool`, it is admitted as any callable schema is.
 */
export function handHostSchema(schema: Function): Function {
	const known = handedHostSchemas.get(schema);
	if (known) return known;
	const check = (data: unknown): unknown => {
		const out: unknown = Reflect.apply(schema, undefined, [copyHostData(data)]);
		return out instanceof OmpErrors ? rebuildOmpErrors(out) : copyHostData(out);
	};
	const handed = Object.freeze(
		Object.assign((data: unknown): unknown => check(data), {
			toJsonSchema: (options?: unknown): unknown => {
				const toJsonSchema: unknown = Reflect.get(schema, "toJsonSchema");
				if (typeof toJsonSchema !== "function") throw new TypeError("This tool's schema has no JSON Schema form");
				return copyHostData(Reflect.apply(toJsonSchema, schema, options === undefined ? [] : [options]));
			},
			assert: (data: unknown): unknown => {
				const out = check(data);
				if (out instanceof OmpErrors) out.throw();
				return out;
			},
		}),
	);
	handedHostSchemas.set(schema, handed);
	return handed;
}

/**
 * `openArgStream` as the host keeps it. The agent loop opens it at `toolcall_start` and feeds the
 * receiver every argument delta and, at `toolcall_end`, the parsed arguments it will execute — the
 * host's own object. So the opener and each receiver method run as the session's work (the opener
 * and the methods are inert once it has gone), the receiver is handed copies, and what it pushes
 * back through `emit` is copied before the host streams it. The receiver keeps `emit` as long as
 * it likes and may call it from anywhere — a listener of its own, after the session has gone — so
 * `emit` runs as the session's work too, the update copied inside that admission, and does nothing
 * once the session has gone. An edit to the arguments the receiver
 * is handed stays on its copy: a change to the input is made by returning it from `tool_call`.
 */
function admitArgStream(open: unknown, admission: ToolFieldAdmission): unknown {
	const { owner, receiver, subject } = admission;
	if (typeof open !== "function")
		return snapshotAuthorData(open, DATA, registrationSite(subject, "openArgStream"), new Map());
	const emitSite: AuthorDataSite = { subject, path: ["openArgStream() emit() update"], advice: RETURNING_ADVICE };
	return owner.ownCallback((init: AgentToolArgStreamInit): AgentToolArgStream | undefined => {
		const hostEmit = init.emit;
		const emit = owner.ownCallback((update: unknown): void => {
			hostEmit(snapshotAuthorData(update, DATA, emitSite, new Map()));
		});
		const stream: unknown = Reflect.apply(open, receiver, [
			{
				toolCallId: init.toolCallId,
				toolName: init.toolName,
				customWireName: init.customWireName,
				emit,
			} satisfies AgentToolArgStreamInit,
		]);
		if (stream === undefined || stream === null) return undefined;
		if (typeof stream !== "object") throw new Error(`${subject}: openArgStream() returned a non-object receiver.`);
		const at = "openArgStream() result";
		return {
			push: inertOnceRetired(owner, callbackOf(stream, "push", subject, at), stream) as AgentToolArgStream["push"],
			end: inertOnceRetired(owner, callbackOf(stream, "end", subject, at), stream) as AgentToolArgStream["end"],
			cancel: inertOnceRetired(
				owner,
				callbackOf(stream, "cancel", subject, at),
				stream,
			) as AgentToolArgStream["cancel"],
		};
	});
}

const SPECULATIVE_OUTCOME = fieldsOf<SpeculativePhysicalOutcome>({
	kind: DATA,
	result: TOOL_RESULT,
	isError: DATA,
	evidence: DATA,
});

/**
 * `speculation` as the host keeps it: an object of callbacks the agent loop and its speculation
 * coordinator invoke from host code, some of them after the turn that registered them. Each is
 * read once, here, and runs as the session's work on copies of the host's arguments. One whose
 * answer the host acts on (`assess`, `execute`, `commit`, a session's `matchesFinalArgs`) has its
 * answer copied before the call returns, and is refused once the session has gone — a refusal the
 * coordinator already treats as "not speculation-safe"; the rest are no-ops then. `execute` is
 * handed an admitted signal, as a tool's `execute` is.
 */
function admitSpeculationPolicy(policy: unknown, admission: ToolFieldAdmission): unknown {
	const { subject } = admission;
	if (typeof policy !== "object" || policy === null) {
		return snapshotAuthorData(policy, DATA, registrationSite(subject, "speculation"), new Map());
	}
	const finalized: unknown = Reflect.get(policy, "finalized");
	const stream: unknown = Reflect.get(policy, "stream");
	const admitted: ToolSpeculationPolicy = {};
	if (finalized !== undefined) admitted.finalized = admitFinalizedPolicy(finalized, admission);
	if (stream !== undefined) admitted.stream = admitStreamPolicy(stream, admission);
	return admitted;
}

function admitFinalizedPolicy(
	finalized: unknown,
	{ owner, subject }: ToolFieldAdmission,
): NonNullable<ToolSpeculationPolicy["finalized"]> {
	const at = "registerTool() speculation.finalized";
	if (typeof finalized !== "object" || finalized === null) throw new Error(`${subject}: ${at} is not an object.`);
	const assess = callbackOf(finalized, "assess", subject, at);
	const execute = callbackOf(finalized, "execute", subject, at);
	const commit = optionalCallbackOf(finalized, "commit", subject, at);
	const discard = optionalCallbackOf(finalized, "discard", subject, at);
	const site = (method: string): AuthorDataSite => ({
		subject,
		path: [`speculation.finalized.${method}() result`],
		advice: RETURNING_ADVICE,
	});
	const gate = providerCallGate(owner);
	// `async`, so that a refusal once the session has gone reaches the coordinator as the
	// rejection its `await` already handles, not as a synchronous throw.
	const admitted: NonNullable<ToolSpeculationPolicy["finalized"]> = {
		assess: async context =>
			await owner.runOwned(
				async () =>
					snapshotAuthorData(
						await Reflect.apply(assess, finalized, [copyHostData(context)]),
						DATA,
						site("assess"),
						new Map(),
					) as ToolSpeculationAssessment,
			),
		execute: async (context, signal) =>
			await owner.runOwned(async () => {
				const handed = new AdmittedSignal(gate, signal);
				try {
					return snapshotAuthorData(
						await Reflect.apply(execute, finalized, [copyHostData(context), handed.admit()]),
						SPECULATIVE_OUTCOME,
						site("execute"),
						new Map(),
					) as SpeculativePhysicalOutcome;
				} finally {
					handed.release();
				}
			}),
	};
	if (commit) {
		admitted.commit = async (context, outcome) =>
			await owner.runOwned(
				async () =>
					snapshotAuthorData(
						await Reflect.apply(commit, finalized, [copyHostData(context), copyHostData(outcome)]),
						TOOL_RESULT,
						site("commit"),
						new Map(),
					) as AgentToolResult,
			);
	}
	if (discard) {
		admitted.discard = inertOnceRetired(owner, discard, finalized) as NonNullable<typeof admitted.discard>;
	}
	return admitted;
}

function admitStreamPolicy(
	stream: unknown,
	admission: ToolFieldAdmission,
): NonNullable<ToolSpeculationPolicy["stream"]> {
	const { owner, subject } = admission;
	const at = "registerTool() speculation.stream";
	if (typeof stream !== "object" || stream === null) throw new Error(`${subject}: ${at} is not an object.`);
	const open = callbackOf(stream, "open", subject, at);
	const opened = owner.ownCallback(async (context: ToolSpeculationStreamContext) => {
		const session: unknown = await Reflect.apply(open, stream, [
			{ coordinator: handCoordinator(context.coordinator, admission), parentToolCallId: context.parentToolCallId },
		]);
		// Still inside the admission: the session's callbacks are read here, once.
		return session === undefined || session === null ? undefined : admitStreamSession(session, admission);
	});
	return {
		open: async context => await opened(context),
	};
}

function admitStreamSession(session: unknown, { owner, subject }: ToolFieldAdmission): ToolSpeculationStreamSession {
	const at = "speculation.stream.open() result";
	if (typeof session !== "object" || session === null) throw new Error(`${subject}: ${at} is not an object.`);
	const contextIndependent = snapshotAuthorData(
		Reflect.get(session, "contextIndependent"),
		DATA,
		{ subject, path: [`${at}.contextIndependent`], advice: RETURNING_ADVICE },
		new Map(),
	);
	const matchesFinalArgs = optionalCallbackOf(session, "matchesFinalArgs", subject, at);
	const inert = (key: string) => inertOnceRetired(owner, callbackOf(session, key, subject, at), session);
	return {
		...(contextIndependent === undefined ? {} : { contextIndependent: contextIndependent === true }),
		update: inert("update") as ToolSpeculationStreamSession["update"],
		finalize: inert("finalize") as ToolSpeculationStreamSession["finalize"],
		commit: inert("commit") as ToolSpeculationStreamSession["commit"],
		discard: inert("discard") as ToolSpeculationStreamSession["discard"],
		...(matchesFinalArgs
			? {
					// Once the session has gone its plan authorizes nothing: the coordinator discards it.
					matchesFinalArgs: (args: Readonly<Record<string, unknown>>) =>
						!owner.isRetired &&
						owner.runOwned(() => Boolean(Reflect.apply(matchesFinalArgs, session, [copyHostData(args)]))),
				}
			: {}),
	};
}

const CHILD_DEFINITION = fieldsOf<Omit<SpeculativeChildDefinition, "tool">>({
	candidateId: DATA,
	parentToolCallId: DATA,
	dependencies: DATA,
	toolCall: DATA,
	source: DATA,
	virtualDurationMs: DATA,
});

const LAUNCH_CONTEXT = fieldsOf<Omit<SpeculativeLaunchContext, "tool">>({ toolCall: DATA, args: DATA });

/**
 * The speculation coordinator as a stream session is handed it. It is the host's, and stays so —
 * and the session keeps it as long as it likes, past the call that handed it over and past the
 * session itself. So each method runs as the session's work. What the session hands in is copied
 * inside that admission: the plain fields as data, and a tool through {@link admitToolDefinition},
 * as a registered tool is, because the coordinator acts on them from host code — a child's tool is
 * assessed and executed through its own policy, a launch's tool reference is asked for an approval.
 * Once the session has gone, each method reads nothing it is handed and does nothing: an admission
 * admits nothing, a launch is not allowed. What the coordinator answers is its own record, so the
 * session is handed copies of it ({@link handChildHandle}).
 */
function handCoordinator(
	coordinator: SpeculativeOperationSink,
	admission: ToolFieldAdmission,
): SpeculativeOperationSink {
	const { owner, extensionPath, subject } = admission;
	const site = (at: string): AuthorDataSite => ({ subject, path: [at], advice: RETURNING_ADVICE });
	const toolOf = (holder: object, at: string): object => {
		const tool: unknown = Reflect.get(holder, "tool");
		if (typeof tool !== "object" || tool === null) throw new Error(`${subject}: ${at}.tool is not a tool.`);
		return admitToolDefinition(tool as ToolDefinition, owner, extensionPath);
	};
	/** `copy` run as the session's work; `undefined`, and nothing read, once the session has gone. */
	const copied = <T>(copy: () => T): T | undefined => (owner.isRetired ? undefined : owner.runOwned(copy));
	const authorizeLaunch = coordinator.authorizeLaunch?.bind(coordinator);
	const discardChildren = coordinator.discardChildren?.bind(coordinator);
	return {
		get maxInFlight() {
			return coordinator.maxInFlight;
		},
		admit: async definition => {
			const at = "speculation coordinator.admit() definition";
			const child = copied(() => ({
				...(snapshotAuthorData(definition, CHILD_DEFINITION, site(at), new Map()) as Omit<
					SpeculativeChildDefinition,
					"tool"
				>),
				tool: toolOf(definition, at) as AgentTool,
			}));
			if (!child) return undefined;
			const handle = await coordinator.admit(child);
			return handle && handChildHandle(handle, admission);
		},
		...(authorizeLaunch
			? {
					authorizeLaunch: async (context: SpeculativeLaunchContext): Promise<SpeculativeAuthorization> => {
						const at = "speculation coordinator.authorizeLaunch() context";
						const launch = copied(() => ({
							...(snapshotAuthorData(context, LAUNCH_CONTEXT, site(at), new Map()) as Omit<
								SpeculativeLaunchContext,
								"tool"
							>),
							tool: toolOf(context, at) as SpeculativeToolReference,
						}));
						if (!launch) return { allowed: false, reason: `${subject}: the extension session has ended` };
						return copyHostData(await authorizeLaunch(launch));
					},
				}
			: {}),
		...(discardChildren
			? {
					discardChildren: async (parentToolCallId: string, reason: string) => {
						const strings = copied(() => [String(parentToolCallId), String(reason)] as const);
						if (strings) await discardChildren(...strings);
					},
				}
			: {}),
		close: async reason => {
			const text = copied(() => String(reason));
			if (text !== undefined) await coordinator.close(text);
		},
	};
}

/**
 * A child's handle as the session that admitted the child is handed it. The handle is the
 * coordinator's record of the child — its `outcome` is the result the host validates and commits,
 * its `effect` the one the host authorized — so the session is handed copies: `effect` copied,
 * `outcome` resolving to a copy of the outcome, `commit` to a copy of what was committed. What the
 * session hands back (`commit`'s arguments, `discard`'s reason) is copied inside its admission.
 * Once the session has gone, `commit` commits nothing and `discard` does nothing; the coordinator
 * discards the child on its own.
 */
function handChildHandle(
	handle: SpeculativeChildHandle,
	{ owner, subject }: ToolFieldAdmission,
): SpeculativeChildHandle {
	const outcome = handle.outcome;
	let handedOutcome: Promise<SpeculativePhysicalOutcome> | undefined;
	const argsSite: AuthorDataSite = {
		subject,
		path: ["speculation child handle.commit() arguments"],
		advice: "Compute the value before handing it over.",
	};
	return {
		candidateId: handle.candidateId,
		fingerprint: handle.fingerprint,
		effect: copyHostData(handle.effect),
		// Asked for when read, so a rejection nobody reads is not an unhandled one.
		get outcome() {
			handedOutcome ??= outcome.then(value => copyHostData(value));
			return handedOutcome;
		},
		commit: async actualArgs => {
			if (owner.isRetired) return undefined;
			const args = owner.runOwned(
				() => snapshotAuthorData(actualArgs, DATA, argsSite, new Map()) as Readonly<Record<string, unknown>>,
			);
			return copyHostData(await handle.commit(args));
		},
		discard: async reason => {
			if (owner.isRetired) return;
			await handle.discard(owner.runOwned(() => String(reason)));
		},
	};
}
