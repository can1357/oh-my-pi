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
 * call hands none, as a signal of its own that follows it, aborting with a copy of its reason —
 * the reason is the caller's own object, which it reads again after the abort. A function is behavior, not data,
 * wherever it sits — a field of a record or of an instance, an array element, a map's key or
 * value, a set's member, an error's property: a bound method or an arrow function reaches the
 * private state of whatever made it. It is dropped, as the session file drops it when the host
 * persists the same record (an array keeps the slot, `undefined`). Symbol-keyed host markers stay
 * with the host, as `structuredClone` leaves them.
 *
 * The copy is iterative, so how deeply the data nests does not matter: a session tree that grows
 * two levels with every entry is copied whole however long the conversation has run. What is
 * bounded is how many objects one copy makes ({@link HOST_DATA_NODE_LIMIT}): a getter can answer
 * a fresh object on every read, and no identity check ends that walk. Past the bound the copy
 * throws a `RangeError` naming it, rather than answering a value that looks complete and is not.
 * Cycles are copied as cycles.
 */
export function copyHostData<T>(value: T, signals?: HandedSignals): T {
	try {
		return new HostCopier(signals).copy(value) as T;
	} catch (error) {
		throw copiedFailure(error);
	}
}

/**
 * A failure raised while host data was being copied — a getter of the host's that threw, the
 * object bound — as whoever receives the copy is handed it: a copy too, never the host's own
 * exception, which may hold the host's callables. The failure still reaches them. One that cannot
 * be copied either becomes an error of the receiver's own saying so.
 */
function copiedFailure(error: unknown): unknown {
	try {
		return new HostCopier().copy(error);
	} catch {
		return new Error("Host data could not be handed over, and neither could the reason it failed");
	}
}

/**
 * Runs one call into the host for an extension, and hands its failure over as a copy
 * ({@link copiedFailure}) — thrown synchronously or by a returned promise's rejection — never the
 * host's own exception, which may hold the host's callables. What it answers is the caller's to
 * copy. A copy is taken around the host call itself: copying only what the call returned leaves
 * the failure it raised before returning.
 */
export function fromHostCall<T>(call: () => T): T {
	let result: T;
	try {
		result = call();
	} catch (error) {
		throw copiedFailure(error);
	}
	if (result instanceof Promise) {
		return result.catch((error: unknown) => {
			throw copiedFailure(error);
		}) as T;
	}
	return result;
}

/** The constructor of every `async` function, so a facade can tell which of its members answer
 *  with a promise: an async member refuses by rejecting, as every other failure of it does. */
const AsyncFunction: unknown = Object.getPrototypeOf(async () => {}).constructor;

/** What a session's admission is asked to run when only its answer is wanted: nothing. */
const ADMISSION_ONLY = (): undefined => undefined;

/**
 * Runs one host call for a session's facade: refused once that session has gone — even while its
 * runtime serves the next, and inside a dispatch it is finishing — with the refusal every other
 * call of that session meets (the owner's own `runOwned`), and its failure handed over as a copy
 * ({@link fromHostCall}). The host call itself runs outside the admission: it is the host's work,
 * which the session neither holds open nor owns. An owner with no admission of its own (an
 * embedder's runtime whose callbacks run as the host's) refuses nothing.
 */
export function sessionHostCall<T>(owner: ExtensionCallbackOwner, call: () => T): T {
	if (typeof owner.runOwned === "function") owner.runOwned(ADMISSION_ONLY);
	return fromHostCall(call);
}

/**
 * A session's facade over the host: every member is a host call that session makes
 * ({@link sessionHostCall}) — a method's call and a getter's read alike, and a function a getter
 * answers with when it is called later — so what refuses once the session has gone is the member,
 * never whichever argument it happens to copy. A member taking `undefined`, or nothing, is refused
 * as surely as one taking a string. `answers` names the members that call no host: they answer
 * from what the facade was made with, or are facades of their own that refuse member by member.
 */
export function handSessionFacade<T extends object>(
	facade: T,
	owner: ExtensionCallbackOwner,
	answers: ReadonlySet<PropertyKey> = new Set(),
): T {
	const admitted = <R>(fn: Function, receiver: unknown, args: unknown[]): R =>
		fn instanceof (AsyncFunction as FunctionConstructor)
			? ((async () => sessionHostCall(owner, () => Reflect.apply(fn, receiver, args)))() as R)
			: sessionHostCall(owner, () => Reflect.apply(fn, receiver, args) as R);
	for (const key of Reflect.ownKeys(facade)) {
		if (answers.has(key)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(facade, key);
		if (!descriptor?.configurable) continue;
		const method: unknown = descriptor.value;
		if (typeof method === "function") {
			Object.defineProperty(facade, key, {
				...descriptor,
				value(this: unknown, ...args: unknown[]): unknown {
					return admitted(method, this, args);
				},
			});
		} else if (descriptor.get) {
			const get = descriptor.get;
			Object.defineProperty(facade, key, {
				...descriptor,
				get(this: unknown): unknown {
					const value: unknown = admitted(get, this, []);
					return typeof value === "function"
						? function (this: unknown, ...args: unknown[]): unknown {
								return admitted(value, this, args);
							}
						: value;
				},
			});
		}
	}
	return facade;
}

/**
 * How many objects one copy of host data handed to an extension may make ({@link copyHostData}).
 * Chosen here, not derived, and set against what real payloads measure (round 49 of #17402):
 * a session tree costs about 20 objects per turn, so about 50,000 turns reach it; the bundled
 * model catalog is 8,630 objects for 5,703 models; and a parsed document of 250,000 records is
 * 750,002 objects, so one of about 334,000 records is refused. Refusing is not silent and does
 * not end the turn: the hook is reported failed (`onError` carries this bound's message) and the
 * dispatch returns. A walk that would never end — a getter answering a fresh object on every
 * read — is stopped here too, after about one to two seconds and some 150 MB on a loaded machine.
 */
export const HOST_DATA_NODE_LIMIT = 1_000_000;

/** What a copy answers for a function it leaves out, so a record or a map drops the entry and an
 *  array keeps the slot as `undefined`. */
const DROPPED: unique symbol = Symbol("dropped");

/**
 * One copy of host data, made without recursion: each object is copied shallowly — its copy made
 * and recorded at once, so a cycle finds it — and filling it in is queued, so no chain of nested
 * objects deepens the call stack. Every object copied counts against {@link HOST_DATA_NODE_LIMIT}.
 */
class HostCopier {
	readonly #signals: HandedSignals | undefined;
	/** What a function found in the data becomes: dropped, unless the copy hands callbacks in. */
	readonly #onFunction: ((fn: Function) => unknown) | undefined;
	/** Copies made as data (own enumerable fields) and as read (`readableKeys`), by original. */
	readonly #copies = new Map<object, unknown>();
	readonly #readCopies = new Map<object, unknown>();
	/** Copies made by a declared shape, by shape and original. */
	readonly #declaredCopies = new Map<AuthorDataSchema, Map<object, unknown>>();
	readonly #work: Array<() => void> = [];
	#objects = 0;

	constructor(signals?: HandedSignals, onFunction?: (fn: Function) => unknown) {
		this.#signals = signals;
		this.#onFunction = onFunction;
	}

	/** `value`, copied completely. */
	copy(value: unknown): unknown {
		const copied = this.value(value, false);
		this.finish();
		return copied;
	}

	/** Fills in every copy queued so far. */
	finish(): void {
		for (let fill = this.#work.pop(); fill !== undefined; fill = this.#work.pop()) fill();
	}

	#count(): void {
		if (++this.#objects > HOST_DATA_NODE_LIMIT) {
			throw new RangeError(
				`Host data handed to an extension holds more than ${HOST_DATA_NODE_LIMIT} objects; it is not handed over in part`,
			);
		}
	}

	/** The copy of `value`, made shallowly; what it holds is filled in by {@link finish}. `byRead`
	 *  reads an object as the host reads it (`readableKeys`) rather than by its own enumerable
	 *  fields. */
	value(value: unknown, byRead: boolean): unknown {
		const child = this.#child(value, byRead);
		return child === DROPPED ? undefined : child;
	}

	/** The copy of one value found in the data, or {@link DROPPED} for a function the copy leaves
	 *  out: a function is behavior, not data, unless this copy hands callbacks in. */
	#child(value: unknown, byRead: boolean): unknown {
		if (typeof value === "function") return this.#onFunction ? this.#onFunction(value) : DROPPED;
		if (typeof value !== "object" || value === null) return value;
		const copies = byRead ? this.#readCopies : this.#copies;
		const known = copies.get(value);
		if (known !== undefined) return known;
		this.#count();
		const record = <C>(copy: C): C => {
			copies.set(value, copy);
			return copy;
		};
		if (value instanceof AbortSignal) {
			return record(this.#signals ? this.#signals.admit(value) : followWithCopiedReason(value));
		}
		const builtIn = copyBuiltInData(value);
		if (builtIn !== undefined) return record(builtIn);
		if (types.isRegExp(value)) return record(new RegExp(value));
		if (value instanceof URL) return record(new URL(value.href));
		if (value instanceof URLSearchParams) return record(new URLSearchParams(value));
		if (Array.isArray(value)) {
			const copy: unknown[] = record([]);
			this.#work.push(() => {
				for (let index = 0; index < value.length; index++) copy[index] = this.value(value[index], byRead);
			});
			return copy;
		}
		if (types.isMap(value)) {
			const copy = record(new Map<unknown, unknown>());
			this.#work.push(() => {
				for (const [key, item] of value) {
					const keyCopy = this.#child(key, byRead);
					const itemCopy = this.#child(item, byRead);
					if (keyCopy === DROPPED || itemCopy === DROPPED) continue;
					copy.set(keyCopy, itemCopy);
				}
			});
			return copy;
		}
		if (types.isSet(value)) {
			const copy = record(new Set<unknown>());
			this.#work.push(() => {
				for (const item of value) {
					const itemCopy = this.#child(item, byRead);
					if (itemCopy !== DROPPED) copy.add(itemCopy);
				}
			});
			return copy;
		}
		// `DOMException` is no native error to the engine's check, but it is the platform's error class.
		if (types.isNativeError(value) || value instanceof DOMException) return this.#error(value, record, byRead);
		const copy: Record<string, unknown> = record({});
		this.#work.push(() => {
			for (const key of byRead ? readableKeys(value) : Object.keys(value)) {
				const item = this.#child(Reflect.get(value, key), byRead);
				if (item === DROPPED) continue;
				// Assigning an own `__proto__` key would set the copy's prototype; defined, it stays data.
				if (key === "__proto__") {
					Object.defineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true });
				} else {
					copy[key] = item;
				}
			}
		});
		return copy;
	}

	#error(value: object, record: <C>(copy: C) => C, byRead: boolean): Error {
		// Read as the host reads them: a host error class may answer them from its prototype. An
		// error is a report of a failure, so a property whose read itself fails is left out: the
		// exception that read throws is the host's own object, and must not be what crosses.
		const name: unknown = readQuietly(value, "name");
		const message: unknown = readQuietly(value, "message");
		const domException = value instanceof DOMException;
		const copy = record(
			builtInErrorOf(value)(typeof message === "string" ? message : "", typeof name === "string" ? name : "Error"),
		);
		const define = (key: string, item: unknown, enumerable: boolean): void => {
			Object.defineProperty(copy, key, { value: item, enumerable, writable: true, configurable: true });
		};
		this.#work.push(() => {
			for (const key of Object.getOwnPropertyNames(value)) {
				// A `DOMException`'s name, message and code are its brand's, set by its constructor.
				if (domException && (key === "name" || key === "message" || key === "code")) continue;
				const item = this.#child(readQuietly(value, key), byRead);
				if (item === DROPPED) continue;
				define(key, item, Object.getOwnPropertyDescriptor(value, key)?.enumerable === true);
			}
			if (domException) return;
			// What a host error class answers from its prototype is kept as data on the copy.
			if (typeof name === "string" && !Object.hasOwn(copy, "name") && name !== copy.name)
				define("name", name, false);
			const code: unknown = readQuietly(value, "code");
			if ((typeof code === "string" || typeof code === "number") && !Object.hasOwn(copy, "code")) {
				define("code", code, false);
			}
		});
		return copy;
	}

	/**
	 * The copy of host data by the schema of what it is declared to be: a known shape field by
	 * field, read the way a field read reads it — so a class's getter and an inherited field arrive
	 * as the host sees them, which a copy of own enumerable fields would miss — and an open value as
	 * data read the same way. The host's counterpart of `snapshotAuthorData`, without its refusal of
	 * functions: this is the host's data, not an author's. Shallow, as {@link value} is.
	 */
	declared(value: unknown, schema: AuthorDataSchema): unknown {
		if (typeof value !== "object" || value === null) return value;
		if (schema.kind === "data" || schema.kind === "callback") return this.value(value, true);
		if (schema.kind === "items" ? !Array.isArray(value) : Array.isArray(value)) return this.value(value, true);
		let copies = this.#declaredCopies.get(schema);
		if (!copies) {
			copies = new Map();
			this.#declaredCopies.set(schema, copies);
		}
		const known = copies.get(value);
		if (known !== undefined) return known;
		if (schema.kind === "items") {
			const source = value as unknown[];
			this.#count();
			const copy: unknown[] = [];
			copies.set(value, copy);
			this.#work.push(() => {
				for (let index = 0; index < source.length; index++)
					copy[index] = this.declared(source[index], schema.items);
			});
			return copy;
		}
		let fields: AuthorDataFields["fields"] | undefined;
		let tag: unknown;
		if (schema.kind === "variants") {
			tag = Reflect.get(value, schema.by);
			const variant = schema.variants.get(tag);
			if (!variant) return this.value(value, true);
			fields = variant.fields;
		} else if (schema.kind === "fields") {
			fields = schema.fields;
		}
		this.#count();
		const copy: Record<PropertyKey, unknown> = {};
		copies.set(value, copy);
		if (schema.kind === "variants" && tag !== undefined) copy[schema.by] = tag;
		this.#work.push(() => {
			if (fields) {
				for (const [field, fieldSchema] of fields) {
					const item = this.declared(Reflect.get(value, field), fieldSchema);
					if (item !== undefined) copy[field] = item;
				}
				return;
			}
			if (schema.kind !== "entries") return;
			for (const key of Object.keys(value)) {
				const item = this.declared(Reflect.get(value, key), schema.entries);
				// Assigning an own `__proto__` key would set the copy's prototype; defined, it stays data.
				Object.defineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true });
			}
		});
		return copy;
	}
}

/** A signal of the copy's own that follows `signal`, aborting with a copy of its reason: the
 *  reason is the caller's own object, which it may read again after the abort. */
function followWithCopiedReason(signal: AbortSignal): AbortSignal {
	const controller = new AbortController();
	const reason = (): unknown => {
		try {
			return copyHostData(signal.reason);
		} catch {
			return new Error("The operation was aborted");
		}
	};
	if (signal.aborted) {
		controller.abort(reason());
	} else {
		signal.addEventListener("abort", () => controller.abort(reason()), { once: true });
	}
	return controller.signal;
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
 * does when the host reads the model. The copy is bounded as {@link copyHostData}'s is. A
 * `resolveHeaders` is the host's code, not data: the copy's calls it on the host's model, with a
 * signal of the host's own that follows the one the extension passes, and answers a copy.
 */
export function handHostModel(model: Model<Api>): Model<Api> {
	try {
		const copier = new HostCopier();
		const copy: Record<PropertyKey, unknown> = {};
		for (const [field, schema] of MODEL_ROW.fields) {
			const value: unknown = Reflect.get(model, field);
			if (value === undefined) continue;
			copy[field] =
				field === "resolveHeaders" && typeof value === "function"
					? handHostResolver(value, model)
					: copier.declared(value, schema);
		}
		copier.finish();
		// Built from every field `Model` declares (`MODEL_ROW` is checked against it), so it is one.
		const handed = copy as unknown as Model<Api>;
		return handed;
	} catch (error) {
		// A getter of the host's model that throws fails the read, as it does for the host — with a
		// copy of its exception, not the host's own.
		throw copiedFailure(error);
	}
}

function handHostResolver(resolver: Function, model: Model<Api>): NonNullable<Model<Api>["resolveHeaders"]> {
	return async signal => {
		const followed = signal === undefined ? undefined : AbortSignal.any([signal]);
		// The resolver is the host's code: what it throws, synchronously or by rejecting, is the
		// host's object, and crosses as a copy.
		const headers = await fromHostCall(
			(): Promise<Record<string, string> | undefined> | Record<string, string> | undefined =>
				Reflect.apply(resolver, model, [followed]),
		);
		return copyHostData(headers);
	};
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

/** The language's and the platform's own error classes, by prototype, and how to construct one: an
 *  error copy is one of these, made by its constructor so it carries the built-in brand — a copy of
 *  a copy is the same kind of error again, and `structuredClone` and `DOMException`'s accessors
 *  accept it — and never an instance of a host error class, whose prototype is the host's code.
 *  `DOMException` is the platform's (an `AbortError` is one); its `name`, `message` and `code`
 *  live in its brand, so it is constructed from what they read. */
const BUILT_IN_ERRORS: ReadonlyMap<object, (message: string, name: string) => Error> = new Map<
	object,
	(message: string, name: string) => Error
>([
	[Error.prototype, message => new Error(message)],
	[EvalError.prototype, message => new EvalError(message)],
	[RangeError.prototype, message => new RangeError(message)],
	[ReferenceError.prototype, message => new ReferenceError(message)],
	[SyntaxError.prototype, message => new SyntaxError(message)],
	[TypeError.prototype, message => new TypeError(message)],
	[URIError.prototype, message => new URIError(message)],
	[AggregateError.prototype, message => new AggregateError([], message)],
	[DOMException.prototype, (message, name) => new DOMException(message, name)],
]);

/** The constructor of the nearest built-in error class `error` extends. */
function builtInErrorOf(error: object): (message: string, name: string) => Error {
	for (
		let prototype: object | null = Object.getPrototypeOf(error);
		prototype !== null;
		prototype = Object.getPrototypeOf(prototype)
	) {
		const construct = BUILT_IN_ERRORS.get(prototype);
		if (construct) return construct;
	}
	return message => new Error(message);
}

/** `key` of `source` as a read answers it, or `undefined` when the read throws. */
function readQuietly(source: object, key: string): unknown {
	try {
		return Reflect.get(source, key);
	} catch {
		return undefined;
	}
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
	// A tool registered while a session runs is that session's (`ExtensionCallbackOwner.registrant`
	// names the runtime it is a session of). Withdrawing it unlists it, but a host may still hold
	// what it was handed — a tool adapter, a renderer it mounted — so every callback it captured
	// answers for that session alone: refused once it has ended, whichever session the runtime
	// serves next. One registered at load serves every session, through the runner's admission.
	const session = owner.registrant === undefined ? undefined : owner;
	for (const [field, keep] of Object.entries<ToolDefinitionField>(TOOL_DEFINITION_FIELDS)) {
		const value: unknown = Reflect.get(definition, field);
		if (value === undefined) continue;
		if (typeof keep === "object" && "admitted" in keep) {
			admitted[field] = keep.admitted(value, { owner, receiver: definition, extensionPath, subject });
		} else if (typeof value === "function" && keep === "bound") {
			// Applied to the definition the extension registered, so a class keeps its receiver.
			const call = (...args: unknown[]): unknown => Reflect.apply(value, definition, args);
			admitted[field] = session === undefined ? call : boundToSession(field, call, session, subject);
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
	admittedToolOwners.set(admitted, owner);
	return admitted as T;
}

/** The owner each admitted tool definition was registered under ({@link admitToolDefinition}). */
const admittedToolOwners = new WeakMap<object, ExtensionCallbackOwner>();

/**
 * Who a registered tool belongs to: the session that registered it, or the runtime whose factory
 * registered it at load. A host that runs the tool for another runtime's session — a definition
 * handed across — still runs it, cancels it and draws what it returns as this owner's work, so
 * nothing of the tool answers to the executing session's lifetime instead. `undefined` for a
 * definition this admission did not make.
 */
export function registeredToolOwner(definition: object): ExtensionCallbackOwner | undefined {
	return admittedToolOwners.get(definition);
}

/**
 * A `bound` tool callback of a tool one session registered, as the host keeps it: run as that
 * session's work, and not at all once it has ended. `execute` then fails, naming why — a call the
 * model made gets an answer, not a silent nothing; a renderer, a describer and `onSession` answer
 * nothing, so the host draws its own default and notifies no one.
 */
function boundToSession(
	field: string,
	call: (...args: unknown[]) => unknown,
	session: ExtensionCallbackOwner,
	subject: string,
): (...args: unknown[]) => unknown {
	if (field === "execute") {
		return (...args: unknown[]): unknown => {
			if (session.isRetired) {
				throw new Error(`${subject}: the session that registered this tool has ended, so it can no longer run`);
			}
			return session.runOwned(() => call(...args));
		};
	}
	return (...args: unknown[]): unknown => (session.isRetired ? undefined : session.runOwned(() => call(...args)));
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
 *  `OmpErrors` ({@link rebuildOmpErrors}) — read here, inside the call, where a message formatter
 *  of the extension's runs — and anything else copied as data. */
function copySchemaAnswer(out: unknown, site: AuthorDataSite): unknown {
	if (!(out instanceof OmpErrors)) return snapshotAuthorData(out, DATA, site, new Map());
	return rebuildOmpErrors(out);
}

/** Validation failures as an `OmpErrors` of the reader's own: each entry's path, expectation,
 *  message and value, copied, and read as the original reads — alternatives ("A or B") stay
 *  alternatives rather than becoming independent failures. An `OmpErrors` always holds at least
 *  one failure. */
function rebuildOmpErrors(out: OmpErrors): OmpErrors {
	const rebuilt = Array.from(
		out,
		entry =>
			new OmpErrors(Array.from(entry.path), String(entry.expected), copyHostData(entry.data), {
				message: String(entry.message),
			}),
	).reduce((copy, failure) => copy.append(failure));
	return out.rendersAsAlternatives === true ? rebuilt.asAlternatives() : rebuilt;
}

/**
 * Options an extension passes into the host's code, as that code is handed them: data copied, and
 * each function among them — a JSON Schema `fallback` — called with copies of what the host passes
 * it and answering a copy of what it returns. The host's code hands a callback its own objects (an
 * emitted node holding a schema's default), so without the copy the extension would keep them;
 * and what the callback answers becomes part of the host's output, so it is the host's own copy.
 */
function handInCallbacks(value: unknown): unknown {
	return new HostCopier(
		undefined,
		callback =>
			(...args: unknown[]): unknown =>
				copyHostData(
					Reflect.apply(
						callback,
						undefined,
						args.map(arg => copyHostData(arg)),
					),
				),
	).copy(value);
}

/** Runs a call into host code for an extension: what it throws is thrown as a copy
 *  ({@link copyHostData}), so neither the host's exception nor a callable it holds is handed over. */
function fromHost<T>(call: () => T): T {
	try {
		return call();
	} catch (error) {
		// The copy of a failure cannot itself fail with a host object: whatever goes wrong copying
		// it, the extension is handed an error of its own.
		let copied: unknown;
		try {
			copied = copyHostData(error);
		} catch {
			copied = new Error("The host failed, and its failure could not be handed over");
		}
		throw copied;
	}
}

/** Each host schema handed out, so every read of one tool hands the same schema. */
const handedHostSchemas = new WeakMap<Function, Function>();

/**
 * A callable schema the host holds — a built-in tool's, or the one a registered tool's admission
 * made — as `pi.getAllTools()` hands it: a frozen schema of the extension's own with the members
 * a schema is used through, each calling the host's. Everything crossing in either direction is a
 * copy: calling it or its `assert` validates a copy of the value with the host's schema and
 * answers a copy (a failure as `OmpErrors` rebuilt so it reads as the host's does); `toJsonSchema`
 * hands the host's schema the extension's options with their callbacks taking and answering
 * copies ({@link handInCallbacks}), and answers a copy; and an exception any of them throws is a
 * copy ({@link fromHost}). The host's object is never handed: it is the one the host validates and
 * builds requests with, and caches its wire schema on, so neither freezing it nor letting the
 * extension set members on it is safe. Handed back to `pi.registerTool`, it is admitted as any
 * callable schema is.
 */
export function handHostSchema(schema: Function): Function {
	const known = handedHostSchemas.get(schema);
	if (known) return known;
	const check = (data: unknown): unknown =>
		fromHost(() => {
			const out: unknown = Reflect.apply(schema, undefined, [copyHostData(data)]);
			return out instanceof OmpErrors ? rebuildOmpErrors(out) : copyHostData(out);
		});
	const handed = Object.freeze(
		Object.assign((data: unknown): unknown => check(data), {
			toJsonSchema: (options?: unknown): unknown => {
				const handedOptions = options === undefined ? [] : [handInCallbacks(options)];
				return fromHost(() => {
					const toJsonSchema: unknown = Reflect.get(schema, "toJsonSchema");
					if (typeof toJsonSchema !== "function")
						throw new TypeError("This tool's schema has no JSON Schema form");
					return copyHostData(Reflect.apply(toJsonSchema, schema, handedOptions));
				});
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
