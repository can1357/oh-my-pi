/**
 * What the host copies at the boundary between an extension's hooks and tools and the host: the
 * schema of each value a hook returns and of what a tool returns, and the copy of host data the
 * host hands in. See "What the host keeps, and when" in `docs/extensions.md`.
 */
import { types } from "node:util";
import type { AgentMessage, AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import {
	type ContextHistoryIndexCarrier,
	kContextHistoryIndex,
	kStreamingPartialJson,
} from "@oh-my-pi/pi-ai/utils/block-symbols";
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
import { type AuthorDataSchema, copyBuiltInData, DATA, fieldsOf, snapshotAuthorData, variantsOf } from "./author-data";
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
 * The copy of host data the host hands in to an extension's callback — a hook's event, a tool's
 * arguments, a fallback's request — so that what the callback does to it (an edit in place, an
 * installed getter) stays on the copy, and the host's own record reads the same afterwards.
 *
 * Plain objects, arrays, maps and sets are copied all the way down; strings and the other
 * primitives are shared, since nothing can change them. Binary data and dates are copied
 * (`copyBuiltInData`). An error is copied with its own properties (`message`, `code`, `errno`)
 * and keeps its class. Any other class instance is a capability the host hands over on purpose —
 * an `AbortSignal` above all — and is handed as itself, as is a function. Symbol-keyed host
 * markers stay with the host, as `structuredClone` leaves them.
 */
export function copyHostData<T>(value: T): T {
	return copyHostValue(value, new Map()) as T;
}

function copyHostValue(value: unknown, copies: Map<object, unknown>): unknown {
	if (typeof value !== "object" || value === null) return value;
	const known = copies.get(value);
	if (known !== undefined) return known;
	const builtIn = copyBuiltInData(value);
	if (builtIn !== undefined) {
		copies.set(value, builtIn);
		return builtIn;
	}
	if (Array.isArray(value)) {
		const copy: unknown[] = [];
		copies.set(value, copy);
		for (let index = 0; index < value.length; index++) copy[index] = copyHostValue(value[index], copies);
		return copy;
	}
	if (types.isMap(value)) {
		const copy = new Map<unknown, unknown>();
		copies.set(value, copy);
		for (const [key, item] of value) copy.set(copyHostValue(key, copies), copyHostValue(item, copies));
		return copy;
	}
	if (types.isSet(value)) {
		const copy = new Set<unknown>();
		copies.set(value, copy);
		for (const item of value) copy.add(copyHostValue(item, copies));
		return copy;
	}
	if (types.isNativeError(value)) {
		const copy: object = Object.create(Object.getPrototypeOf(value));
		copies.set(value, copy);
		for (const key of Object.getOwnPropertyNames(value)) {
			Object.defineProperty(copy, key, {
				value: copyHostValue(Reflect.get(value, key), copies),
				enumerable: Object.getOwnPropertyDescriptor(value, key)?.enumerable === true,
				writable: true,
				configurable: true,
			});
		}
		return copy;
	}
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	const copy: Record<string, unknown> = {};
	copies.set(value, copy);
	for (const key of Object.keys(value)) {
		const item = copyHostValue(Reflect.get(value, key), copies);
		// Assigning an own `__proto__` key would set the copy's prototype; defined, it stays data.
		if (key === "__proto__") {
			Object.defineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true });
		} else {
			copy[key] = item;
		}
	}
	return copy;
}

/**
 * How the host keeps one field of a tool definition an extension registers.
 *
 * - `data`: copied as data, once, at registration.
 * - `kept`: the value as it was at registration, not copied: the parameter schema (a TypeBox
 *   object, a Zod or ArkType schema — class instances and functions that cannot be copied as
 *   data) and `speculation`, an object of callbacks.
 * - `bound`: a callback captured once, applied to the extension's own object. Either the host
 *   already invokes it inside an admission of its own (`execute` through the tool wrapper,
 *   `onSession`), or its invocation is a rendering surface outside this boundary (`renderCall`,
 *   `renderResult`, `describeCall`, `describeResult`, `openArgStream`).
 * - `owned`: a callback the host invokes from its own code and then acts on what it answers — an
 *   approval decision, a remembered grant's targets, a shell's environment. Captured once, it
 *   runs as the session's work (refused once the session has gone), on copies of the host's
 *   arguments, and its answer is copied by `owned` before the call returns. A value that is not
 *   a function (`approval: "read"`, `concurrency: "exclusive"`) is data.
 */
type ToolDefinitionField = "data" | "kept" | "bound" | { readonly owned: AuthorDataSchema };

/** Every field the host reads off a registered tool: the definition's own, and the agent-tool
 *  fields the tool adapter forwards from it. */
type RegisterableTool = ToolDefinition & Omit<AgentTool, keyof ToolDefinition>;

/** One entry for every field, so a field added to either type does not compile until it says how
 *  the host keeps it. */
const TOOL_DEFINITION_FIELDS: { readonly [K in keyof RegisterableTool]-?: ToolDefinitionField } = {
	name: "data",
	label: "data",
	description: "data",
	parameters: "kept",
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
	openArgStream: "bound",
	summary: "data",
	delegationGuidance: "data",
	docTopics: { owned: DATA },
	concurrency: { owned: DATA },
	speculation: "kept",
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
		if (keep === "kept") {
			admitted[field] = value;
		} else if (typeof value === "function" && keep === "bound") {
			// Applied to the definition the extension registered, so a class keeps its receiver.
			admitted[field] = (...args: unknown[]): unknown => Reflect.apply(value, definition, args);
		} else if (typeof value === "function" && typeof keep === "object") {
			admitted[field] = owner.ownCallback((...args: unknown[]): unknown =>
				snapshotAuthorData(
					Reflect.apply(value, definition, args.map(copyHostData)),
					keep.owned,
					{ subject, path: [`${field}() result`], advice: RETURNING_ADVICE },
					new Map(),
				),
			);
		} else {
			const site = { subject, path: [`registerTool() ${field}`], advice: REGISTERING_ADVICE };
			admitted[field] = snapshotAuthorData(value, DATA, site, copies);
		}
	}
	return admitted as T;
}
