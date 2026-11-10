import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { messageEstimateVersion } from "@oh-my-pi/pi-agent-core/compaction/message-cache";
import type {
	AnthropicCompactionPayload,
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	ProviderPayload,
	TextContent,
} from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionContext } from "../session/session-context";
import type { JsonValue, SecretObfuscator } from "./obfuscator";
import { collectJsonRegexSecretValues, mapJsonStrings } from "./placeholder-scan";
import { SecretValueSet } from "./placeholder";

// ═══════════════════════════════════════════════════════════════════════════
// Display restore (inbound, persisted/provider → local display)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Restore secret placeholders for local display. Only message kinds the model
 * itself authored from obfuscated context carry placeholders — assistant
 * content and the LLM-written branch/compaction summaries. User, developer, and
 * tool-result messages are persisted with their literal text, so operator-authored
 * placeholder-shaped text must survive untouched; those roles are never walked.
 */
export function deobfuscateSessionContext(
	sessionContext: SessionContext,
	obfuscator: SecretObfuscator | undefined,
): SessionContext {
	if (!obfuscator?.hasSecrets()) return sessionContext;
	const messages = deobfuscateAgentMessages(obfuscator, sessionContext.messages);
	return messages === sessionContext.messages ? sessionContext : { ...sessionContext, messages };
}

export function deobfuscateAgentMessages(obfuscator: SecretObfuscator, messages: AgentMessage[]): AgentMessage[] {
	const deob = (text: string): string => obfuscator.deobfuscate(text);
	let changed = false;
	const result = messages.map((message): AgentMessage => {
		switch (message.role) {
			case "assistant": {
				const content = deobfuscateAssistantContent(obfuscator, message.content);
				if (content === message.content) return message;
				changed = true;
				return { ...message, content };
			}
			case "branchSummary": {
				const summary = deob(message.summary);
				if (summary === message.summary) return message;
				changed = true;
				return { ...message, summary };
			}
			case "compactionSummary": {
				const summary = deob(message.summary);
				const shortSummary = message.shortSummary === undefined ? undefined : deob(message.shortSummary);
				const blocks = message.blocks === undefined ? undefined : deobfuscateTextBlocks(obfuscator, message.blocks);
				if (summary === message.summary && shortSummary === message.shortSummary && blocks === message.blocks) {
					return message;
				}
				changed = true;
				return { ...message, summary, shortSummary, blocks };
			}
			default:
				return message;
		}
	});
	return changed ? result : messages;
}

/**
 * Restore placeholders in assistant content: visible text and tool-call
 * arguments/intent/rawBlock. Thinking and signatures are opaque
 * provider-replay/hidden-reasoning data and pass through byte-identical.
 */
export function deobfuscateAssistantContent(
	obfuscator: SecretObfuscator,
	content: AssistantMessage["content"],
): AssistantMessage["content"] {
	if (!obfuscator.hasSecrets()) return content;
	const deob = (text: string): string => obfuscator.deobfuscate(text);
	let changed = false;
	const result = content.map((block): AssistantMessage["content"][number] => {
		if (block.type === "text") {
			const text = deob(block.text);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		}

		if (block.type === "toolCall") {
			const args = deobfuscateToolArguments(obfuscator, block.arguments);
			const intent = block.intent === undefined ? undefined : deob(block.intent);
			const rawBlock = block.rawBlock === undefined ? undefined : deob(block.rawBlock);
			if (args === block.arguments && intent === block.intent && rawBlock === block.rawBlock) return block;
			changed = true;
			return { ...block, arguments: args, intent, rawBlock };
		}
		return block;
	});
	return changed ? result : content;
}

/**
 * Restore placeholders in model-authored argument values. Argument keys name
 * tool parameters and must remain unchanged.
 */
export function deobfuscateToolArguments(
	obfuscator: SecretObfuscator,
	args: Record<string, unknown>,
): Record<string, unknown> {
	if (!obfuscator.hasSecrets()) return args;
	return mapJsonStrings(args as JsonValue, s => obfuscator.deobfuscate(s)) as Record<string, unknown>;
}

/** Redact secrets inside a tool call's arguments (same JSON-walk exception as {@link deobfuscateToolArguments}). */
export function obfuscateToolArguments(
	obfuscator: SecretObfuscator,
	args: Record<string, unknown>,
	sharedRegexSecretValues?: ReadonlySet<string>,
): Record<string, unknown> {
	if (!obfuscator.hasSecrets()) return args;
	// `batch()` joins an outer batch when one is already open.
	return obfuscator.batch(() => {
		const regexSecretValues = sharedRegexSecretValues ?? collectJsonRegexSecretValues(obfuscator, args as JsonValue);
		return mapJsonStrings(args as JsonValue, s => obfuscator.obfuscate(s, regexSecretValues)) as Record<
			string,
			unknown
		>;
	});
}

/** Copy native replay containers only when a provider-visible plaintext field changes. */
function mapNativeArray(value: unknown, transform: (value: unknown) => unknown): unknown {
	if (!Array.isArray(value)) return value;
	let result: unknown[] | undefined;
	for (let index = 0; index < value.length; index++) {
		const next = transform(value[index]);
		if (next !== value[index]) {
			result ??= value.slice();
			result![index] = next;
		}
	}
	return result ?? value;
}

function mapNativeField(
	item: Record<string, unknown>,
	key: string,
	transform: (value: unknown) => unknown,
): Record<string, unknown> {
	const next = transform(item[key]);
	return next === item[key] ? item : { ...item, [key]: next };
}

/** Schema maps name properties/definitions; their keys are identifiers, not annotations. */
function mapNativeSchemaMap(value: unknown, transform: (text: string) => string): unknown {
	if (!isRecord(value)) return value;
	let mapped: Record<string, unknown> | undefined;
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		// Legacy dependencies can contain property-name arrays instead of schemas.
		const next = Array.isArray(value[key]) ? value[key] : mapNativeSchema(value[key], transform);
		if (next !== value[key]) {
			mapped ??= { ...value };
			mapped[key] = next;
		}
	}
	return mapped ?? value;
}

/** Walk schema-valued positions, rewriting only descriptive annotations and examples. */
function mapNativeSchema(value: unknown, transform: (text: string) => string): unknown {
	if (!isRecord(value)) return value;
	let mapped: Record<string, unknown> | undefined;
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		const child = value[key];
		let next: unknown;
		switch (key) {
			case "title":
			case "description":
			case "$comment":
			case "example":
			case "examples":
				next = mapJsonStrings(child as JsonValue, transform);
				break;
			case "properties":
			case "patternProperties":
			case "$defs":
			case "definitions":
			case "dependentSchemas":
			case "dependencies":
				next = mapNativeSchemaMap(child, transform);
				break;
			case "items":
			case "additionalItems":
			case "additionalProperties":
			case "unevaluatedItems":
			case "unevaluatedProperties":
			case "contains":
			case "propertyNames":
			case "not":
			case "if":
			case "then":
			case "else":
			case "contentSchema":
			case "allOf":
			case "anyOf":
			case "oneOf":
			case "prefixItems":
				next = Array.isArray(child)
					? mapNativeArray(child, schema => mapNativeSchema(schema, transform))
					: mapNativeSchema(child, transform);
				break;
			default:
				// Constraints (including enum/const), execution defaults and unknown
				// extensions are not prose. Rewriting them can invalidate tool inputs.
				continue;
		}
		if (next !== child) {
			mapped ??= { ...value };
			mapped[key] = next;
		}
	}
	return mapped ?? value;
}

/** Dynamic history definitions only; static request tools are intentionally outside this visitor. */
function mapNativeToolDefinition(value: unknown, transform: (text: string) => string): unknown {
	if (!isRecord(value)) return value;
	const text = (value: unknown): unknown => (typeof value === "string" ? transform(value) : value);
	switch (value.type) {
		case "function":
		case "tool_search":
			return mapNativeField(mapNativeField(value, "description", text), "parameters", schema =>
				mapNativeSchema(schema, transform),
			);
		case "namespace":
			return mapNativeField(mapNativeField(value, "description", text), "tools", tools =>
				mapNativeArray(tools, tool => mapNativeToolDefinition(tool, transform)),
			);
		case "custom":
			// Grammar definitions are executable validation controls, not prose.
			return mapNativeField(value, "description", text);
		case "mcp":
			// Connection credentials, endpoints and tool/approval selectors are transport controls.
			return mapNativeField(value, "server_description", text);
		case "shell":
			return mapNativeField(value, "environment", environment => {
				if (!isRecord(environment) || (environment.type !== "local" && environment.type !== "container_auto"))
					return environment;
				return mapNativeField(environment, "skills", skills =>
					mapNativeArray(skills, skill => {
						// Only descriptions are prose; references, paths and bundled bytes stay opaque.
						if (!isRecord(skill) || (environment.type === "container_auto" && skill.type !== "inline"))
							return skill;
						return mapNativeField(skill, "description", text);
					}),
				);
			});
		default:
			return value;
	}
}

/**
 * Responses history is a protocol, not arbitrary JSON. Only its plaintext slots
 * are walked; encrypted reasoning, IDs, tool names, images and file bytes stay
 * opaque. The same walk collects collisions and rewrites replay/preserve data.
 */
function mapNativeReplayItem(value: unknown, transform: (text: string) => string): unknown {
	if (!isRecord(value)) return value;
	const text = (value: unknown): unknown => (typeof value === "string" ? transform(value) : value);
	const content = (value: unknown): unknown =>
		typeof value === "string"
			? transform(value)
			: mapNativeArray(value, part => mapNativeReplayItem(part, transform));
	const args = (value: unknown): unknown => {
		if (typeof value !== "string") return mapJsonStrings(value as JsonValue, transform);
		let parsed: JsonValue;
		try {
			parsed = JSON.parse(value) as JsonValue;
		} catch {
			return transform(value);
		}
		const next = mapJsonStrings(parsed, transform);
		return next === parsed ? value : JSON.stringify(next);
	};
	switch (value.type) {
		case undefined:
			if (
				value.role !== "user" &&
				value.role !== "assistant" &&
				value.role !== "developer" &&
				value.role !== "system"
			)
				return value;
			return mapNativeField(value, "content", content);
		case "message":
			return mapNativeField(value, "content", content);
		case "input_text":
		case "output_text":
		case "summary_text":
		case "reasoning_text":
			return mapNativeField(value, "text", text);
		case "refusal":
			return mapNativeField(value, "refusal", text);
		case "reasoning":
			return mapNativeField(mapNativeField(value, "summary", content), "content", content);
		case "compaction":
		case "compaction_summary":
			return mapNativeField(value, "summary", content);
		case "function_call":
			// Nonempty encrypted argument metadata denotes opaque collaboration data.
			if (Array.isArray(value.encrypted_function_args) && value.encrypted_function_args.length > 0) return value;
			return mapNativeField(value, "arguments", args);
		case "file_search_call":
			return mapNativeField(
				mapNativeField(value, "queries", queries => mapNativeArray(queries, text)),
				"results",
				results =>
					mapNativeArray(results, result => {
						if (!isRecord(result)) return result;
						return mapNativeField(
							mapNativeField(mapNativeField(result, "text", text), "filename", text),
							"attributes",
							attributes => {
								if (!isRecord(attributes)) return attributes;
								// File-search attributes are a flat string/number/boolean map, not arbitrary JSON.
								let mapped: Record<string, unknown> | undefined;
								for (const key of Object.keys(attributes)) {
									const next = text(attributes[key]);
									if (next !== attributes[key]) {
										mapped ??= { ...attributes };
										mapped[key] = next;
									}
								}
								return mapped ?? attributes;
							},
						);
					}),
			);
		case "web_search_call":
			return mapNativeField(value, "action", action => {
				if (!isRecord(action)) return action;
				switch (action.type) {
					case "search":
						return mapNativeField(
							mapNativeField(
								mapNativeField(action, "queries", queries => mapNativeArray(queries, text)),
								"query",
								text,
							),
							"sources",
							sources =>
								mapNativeArray(sources, source =>
									isRecord(source) && source.type === "url" ? mapNativeField(source, "url", text) : source,
								),
						);
					case "open_page":
						return mapNativeField(action, "url", text);
					case "find_in_page":
						return mapNativeField(mapNativeField(action, "pattern", text), "url", text);
					default:
						return action;
				}
			});
		case "tool_search_call":
		case "mcp_approval_request":
			return mapNativeField(value, "arguments", args);
		case "tool_search_output":
		case "additional_tools":
			return mapNativeField(value, "tools", tools =>
				mapNativeArray(tools, tool => mapNativeToolDefinition(tool, transform)),
			);
		case "mcp_call":
			return mapNativeField(mapNativeField(mapNativeField(value, "arguments", args), "output", text), "error", text);
		case "custom_tool_call":
			return mapNativeField(value, "input", text);
		case "function_call_output":
		case "custom_tool_call_output":
		case "local_shell_call_output":
		case "apply_patch_call_output":
			return mapNativeField(value, "output", content);
		case "code_interpreter_call":
			return mapNativeField(mapNativeField(value, "code", text), "outputs", content);
		case "logs":
			return mapNativeField(value, "logs", text);
		case "computer_call":
			return mapNativeField(
				mapNativeField(value, "action", action => mapNativeReplayItem(action, transform)),
				"actions",
				content,
			);
		case "type":
			return mapNativeField(value, "text", text);
		case "shell_call":
		case "local_shell_call":
			return mapNativeField(value, "action", action => {
				if (!isRecord(action)) return action;
				let result = mapNativeField(action, "commands", commands => mapNativeArray(commands, text));
				result = mapNativeField(result, "command", command => mapNativeArray(command, text));
				result = mapNativeField(result, "env", env => mapJsonStrings(env as JsonValue, transform));
				return mapNativeField(result, "working_directory", text);
			});
		case "shell_call_output":
			return mapNativeField(value, "output", output =>
				mapNativeArray(output, part =>
					isRecord(part) ? mapNativeField(mapNativeField(part, "stdout", text), "stderr", text) : part,
				),
			);
		case "apply_patch_call":
			return mapNativeField(value, "operation", operation =>
				isRecord(operation) ? mapNativeField(mapNativeField(operation, "path", text), "diff", text) : operation,
			);
		case "mcp_list_tools":
			return mapNativeField(mapNativeField(value, "error", text), "tools", tools =>
				mapNativeArray(tools, tool => {
					if (!isRecord(tool)) return tool;
					return mapNativeField(
						mapNativeField(mapNativeField(tool, "description", text), "input_schema", schema =>
							mapNativeSchema(schema, transform),
						),
						"annotations",
						annotations => mapJsonStrings(annotations as JsonValue, transform),
					);
				}),
			);
		case "mcp_approval_response":
			return mapNativeField(value, "reason", text);
		default:
			return value;
	}
}

/** Collect native plaintext before any replay fields lose regex values through redaction. */
export function collectNativeReplayRegexSecretValues(
	obfuscator: SecretObfuscator,
	message: { providerPayload?: ProviderPayload; preserveData?: Record<string, unknown> },
	values: Set<string>,
): void {
	if (!obfuscator.hasSecrets()) return;
	const payload = message.providerPayload;
	const remote = message.preserveData?.openaiRemoteCompaction;
	if (payload?.type !== "openaiResponsesHistory" && !isRecord(remote)) return;
	const collectItem = (item: unknown): unknown =>
		mapNativeReplayItem(item, text => {
			for (const value of obfuscator.collectRegexSecretValuesForObfuscation(text)) values.add(value);
			return text;
		});
	if (payload?.type === "openaiResponsesHistory") mapNativeArray(payload.items, collectItem);
	if (isRecord(remote)) {
		if (payload?.type !== "openaiResponsesHistory" || remote.replacementHistory !== payload.items) {
			mapNativeArray(remote.replacementHistory, collectItem);
		}
		collectItem(remote.compactionItem);
	}
}

/** Re-obfuscate native replay and its next-compaction source with one collision set. */
export function obfuscateNativeReplay<
	T extends { providerPayload?: ProviderPayload; preserveData?: Record<string, unknown> },
>(obfuscator: SecretObfuscator, message: T, sharedRegexSecretValues: ReadonlySet<string>): T {
	if (!obfuscator.hasSecrets()) return message;
	const payload = message.providerPayload;
	const remote = message.preserveData?.openaiRemoteCompaction;
	if (payload?.type !== "openaiResponsesHistory" && !isRecord(remote)) return message;
	const transform = (text: string): string => obfuscator.obfuscate(text, sharedRegexSecretValues);
	const mapItem = (item: unknown): unknown => mapNativeReplayItem(item, transform);
	const items = payload?.type === "openaiResponsesHistory" ? mapNativeArray(payload.items, mapItem) : undefined;
	const providerPayload =
		payload?.type === "openaiResponsesHistory" && items !== payload.items
			? { ...payload, items: items as Array<Record<string, unknown>> }
			: payload;
	let preserveData = message.preserveData;
	if (isRecord(remote)) {
		const replacementHistory =
			payload?.type === "openaiResponsesHistory" && remote.replacementHistory === payload.items
				? items
				: mapNativeArray(remote.replacementHistory, mapItem);
		const compactionItem = mapItem(remote.compactionItem);
		if (replacementHistory !== remote.replacementHistory || compactionItem !== remote.compactionItem) {
			preserveData = {
				...preserveData,
				openaiRemoteCompaction: {
					...remote,
					replacementHistory,
					...(compactionItem !== remote.compactionItem ? { compactionItem } : {}),
				},
			};
		}
	}
	return providerPayload === payload && preserveData === message.preserveData
		? message
		: {
				...message,
				...(providerPayload !== payload ? { providerPayload } : {}),
				...(preserveData !== message.preserveData ? { preserveData } : {}),
			};
}

// ═══════════════════════════════════════════════════════════════════════════
// Outbound obfuscation (local → provider)
// ═══════════════════════════════════════════════════════════════════════════

type UserFacingMessage = Extract<Message, { role: "user" | "developer" | "toolResult" }>;

/** Obfuscate `text` blocks of a content array; image and other blocks pass through. */
function obfuscateTextBlocks(
	obfuscator: SecretObfuscator,
	content: (TextContent | ImageContent)[],
	sharedRegexSecretValues?: ReadonlySet<string>,
): (TextContent | ImageContent)[] {
	let changed = false;
	const result = content.map((block): TextContent | ImageContent => {
		if (block.type !== "text") return block;
		const text = obfuscator.obfuscate(block.text, sharedRegexSecretValues);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? result : content;
}

/** Restore placeholders in `text` blocks of a content array; image and other blocks pass through. */
function deobfuscateTextBlocks(
	obfuscator: SecretObfuscator,
	content: (TextContent | ImageContent)[],
): (TextContent | ImageContent)[] {
	let changed = false;
	const result = content.map((block): TextContent | ImageContent => {
		if (block.type !== "text") return block;
		const text = obfuscator.deobfuscate(block.text);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? result : content;
}

/**
 * Re-obfuscate assistant content before it returns to a provider after session
 * restoration, removing friendly prefixes made unsafe by this batch. A changed
 * thinking block loses its byte-bound replay signature, and so does a tool call
 * whose arguments changed: the Gemini `thoughtSignature` is an encrypted
 * attestation over the function call it rides on, so replaying obfuscated
 * arguments under a signature issued for the raw ones pairs a valid signature
 * with a payload it does not cover. `intent` and `rawBlock` are harness-side
 * fields the signed part never carries, so they keep it.
 * https://ai.google.dev/gemini-api/docs/thought-signatures
 */
function obfuscateAssistantContentForReplay(
	obfuscator: SecretObfuscator,
	content: AssistantMessage["content"],
	sharedRegexSecretValues: ReadonlySet<string>,
): AssistantMessage["content"] {
	const obfuscate = (text: string): string =>
		obfuscator.stripUnsafeFriendlyPlaceholderPrefixes(
			obfuscator.obfuscate(text, sharedRegexSecretValues),
			sharedRegexSecretValues,
		);
	let changed = false;
	const result = content.map((block): AssistantMessage["content"][number] => {
		if (block.type === "text") {
			const text = obfuscate(block.text);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		}
		if (block.type === "thinking") {
			const thinking = obfuscate(block.thinking);
			if (thinking === block.thinking) return block;
			changed = true;
			return { ...block, thinking, thinkingSignature: undefined };
		}
		if (block.type === "toolCall") {
			const args = mapJsonStrings(block.arguments as JsonValue, obfuscate) as Record<string, unknown>;
			const intent = block.intent === undefined ? undefined : obfuscate(block.intent);
			const rawBlock = block.rawBlock === undefined ? undefined : obfuscate(block.rawBlock);
			if (args === block.arguments && intent === block.intent && rawBlock === block.rawBlock) return block;
			changed = true;
			return args === block.arguments
				? { ...block, intent, rawBlock }
				: { ...block, arguments: args, intent, rawBlock, thoughtSignature: undefined };
		}
		return block;
	});
	return changed ? result : content;
}

/**
 * Harness file metadata riding on a natively-replayed compaction summary.
 * The provider converter emits it beside the verbatim block's retained tail, so it must pass
 * the same outbound boundary as the summary text it was split from. The
 * verbatim block content itself stays untouched: it must match the opaque
 * provider state replayed beside it.
 */
function anthropicCompactionPayload(message: Message): AnthropicCompactionPayload | undefined {
	if (message.role !== "user" && message.role !== "developer" && message.role !== "assistant") return undefined;
	const payload = message.providerPayload;
	return payload?.type === "anthropicCompaction" ? payload : undefined;
}

function anthropicCompactionFilesText(message: Message): string | undefined {
	const filesText = anthropicCompactionPayload(message)?.filesText;
	return typeof filesText === "string" && filesText.length > 0 ? filesText : undefined;
}

function obfuscateAnthropicCompactionFiles(
	obfuscator: SecretObfuscator,
	payload: AnthropicCompactionPayload,
	sharedRegexSecretValues: SecretValueSet,
): AnthropicCompactionPayload {
	const filesText =
		payload.filesText === undefined ? undefined : obfuscator.obfuscate(payload.filesText, sharedRegexSecretValues);
	let retainedChanged = false;
	const retainedFiles = payload.retainedFiles?.map(files => {
		const text = obfuscator.obfuscate(files.text, sharedRegexSecretValues);
		if (text === files.text) return files;
		retainedChanged = true;
		return { ...files, text };
	});
	if (filesText === payload.filesText && !retainedChanged) return payload;
	return { ...payload, filesText, retainedFiles };
}

/** Add the regex secret values one outbound message contributes to the request-wide shared set. */
function collectMessageRegexSecretValues(obfuscator: SecretObfuscator, message: Message, values: Set<string>): void {
	const addText = (text: string | undefined): void => {
		if (text === undefined) return;
		for (const value of obfuscator.collectRegexSecretValuesForObfuscation(text)) {
			values.add(value);
		}
	};
	// File metadata replayed beside a native compaction block carries the
	// same harness paths as the summary text, so its regex-secret values
	// join the shared set.
	const compactionFiles = anthropicCompactionFilesText(message);
	if (compactionFiles !== undefined) addText(compactionFiles);
	for (const files of anthropicCompactionPayload(message)?.retainedFiles ?? []) addText(files.text);
	if (message.role === "user" || message.role === "developer" || message.role === "assistant") {
		collectNativeReplayRegexSecretValues(obfuscator, message, values);
	}
	if (message.role === "assistant") {
		for (const block of message.content) {
			if (block.type === "text") addText(block.text);
			else if (block.type === "thinking") addText(block.thinking);
			else if (block.type === "toolCall") {
				for (const value of collectJsonRegexSecretValues(obfuscator, block.arguments as JsonValue)) {
					values.add(value);
				}
				addText(block.intent);
				addText(block.rawBlock);
			}
		}
		return;
	}
	if (
		message.role !== "user" &&
		message.role !== "toolResult" &&
		!(message.role === "developer" && message.attribution === "user")
	) {
		return;
	}
	const target = message as UserFacingMessage;
	if (typeof target.content === "string") {
		addText(target.content);
		return;
	}
	for (const block of target.content) {
		if (block.type === "text") addText(block.text);
	}
}

/** Redact one outbound message against the request-wide shared regex values; unchanged messages come back as-is. */
function obfuscateMessage(
	obfuscator: SecretObfuscator,
	message: Message,
	sharedRegexSecretValues: SecretValueSet,
): Message {
	let current = message;
	const compactionPayload = anthropicCompactionPayload(current);
	if (compactionPayload !== undefined) {
		const providerPayload = obfuscateAnthropicCompactionFiles(obfuscator, compactionPayload, sharedRegexSecretValues);
		if (providerPayload !== compactionPayload) current = { ...current, providerPayload } as Message;
	}
	if (current.role === "user" || current.role === "developer" || current.role === "assistant") {
		current = obfuscateNativeReplay(obfuscator, current, sharedRegexSecretValues);
	}
	if (
		current.role !== "user" &&
		current.role !== "toolResult" &&
		!(current.role === "developer" && current.attribution === "user")
	) {
		if (current.role !== "assistant") return current;
		const content = obfuscateAssistantContentForReplay(obfuscator, current.content, sharedRegexSecretValues);
		return content === current.content ? current : { ...current, content };
	}
	const target = current as UserFacingMessage;
	if (typeof target.content === "string") {
		const content = obfuscator.obfuscate(target.content, sharedRegexSecretValues);
		return content === target.content ? current : ({ ...target, content } as Message);
	}
	const content = obfuscateTextBlocks(obfuscator, target.content, sharedRegexSecretValues);
	return content === target.content ? current : ({ ...target, content } as Message);
}

/**
 * One message's outbound redaction state in an {@link ObfuscatorMemo}. A dirty
 * entry is valid while `revision` (and, for `output`, `sharedVersion`) holds.
 * A clean entry is a message whose every text scanned clean in both collection
 * and redaction: it contributes no regex values and redacts to itself, so it is
 * valid while `literalRevision` holds, across mints and shared-set changes.
 */
interface ObfuscatedMessage {
	/** {@link SecretObfuscator.revision} `regexValues`, and `output` once set, were computed under. */
	revision: number;
	/** {@link SecretObfuscator.literalRevision} when `regexValues` were collected. */
	literalRevision: number;
	/** {@link messageEstimateVersion} of the message; owners bump it when they rewrite a message in place. */
	messageVersion: number;
	/** Whether the message is clean under `literalRevision`; then `output` is the message itself. */
	clean: boolean;
	/** Regex secret values this message contributes to the request-wide shared set. */
	regexValues: readonly string[];
	/** {@link ObfuscatorMemo.sharedVersion} `output` was redacted under. */
	sharedVersion: number;
	/** Redacted message (may be the input itself); unset until redacted under `revision`. */
	output: Message | undefined;
}

/**
 * Redaction state of one outbound message stream (one conversation at one
 * {@link obfuscateMessages} call site), created by
 * {@link createMessageRedactionMemo} and owned by the caller. Opaque outside
 * this module.
 */
export interface ObfuscatorMemo {
	/** The obfuscator the entries were computed by; a different one resets the memo. */
	obfuscator: SecretObfuscator | undefined;
	/** Keyed by message identity; an entry lives as long as its message. */
	messages: WeakMap<Message, ObfuscatedMessage>;
	/** The previous request's shared regex values. */
	shared: ReadonlySet<string>;
	/** Version of `shared`; bumped whenever a request's shared set differs from it. */
	sharedVersion: number;
}

/**
 * A memo for one stream of {@link obfuscateMessages} calls. Each stream needs
 * its own: requests over different message lists have different shared regex
 * values, and alternating them through one memo would invalidate it every call.
 */
export function createMessageRedactionMemo(): ObfuscatorMemo {
	return { obfuscator: undefined, messages: new WeakMap(), shared: new Set(), sharedVersion: 0 };
}

const NO_REGEX_VALUES: readonly string[] = [];

function sameValues(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const value of a) {
		if (!b.has(value)) return false;
	}
	return true;
}

/**
 * Redact secrets from outbound messages. User messages, tool results, and
 * user-authored developer messages (e.g. `@file` mentions) are obfuscated.
 * Assistant replay content is re-obfuscated too, because session restoration
 * expands keyed placeholders locally before the next provider request. Inline
 * image bytes are never walked.
 *
 * With a `memo`, unchanged history is not re-scanned: each message's regex
 * values and redacted form are kept by message identity and reused while the
 * registry revision, the message's version and the request-wide shared values
 * hold. A message with no secret-bearing text (the common case) is reused while
 * only the configured literals hold, since it redacts to itself regardless.
 * Without a memo, every message is scanned and redacted.
 */
export function obfuscateMessages(obfuscator: SecretObfuscator, messages: Message[], memo?: ObfuscatorMemo): Message[] {
	if (!obfuscator.obfuscates()) return messages;
	return obfuscator.batch(() =>
		memo === undefined
			? obfuscateMessageBatch(obfuscator, messages)
			: obfuscateMemoizedBatch(obfuscator, messages, memo),
	);
}

function obfuscateMessageBatch(obfuscator: SecretObfuscator, messages: Message[]): Message[] {
	// Every message's regex values join one request-wide set, so a value found
	// in one message is redacted wherever it appears.
	const sharedRegexSecretValues = new SecretValueSet();
	for (const message of messages) collectMessageRegexSecretValues(obfuscator, message, sharedRegexSecretValues);
	let changed = false;
	const result = messages.map((message): Message => {
		const output = obfuscateMessage(obfuscator, message, sharedRegexSecretValues);
		if (output !== message) changed = true;
		return output;
	});
	return changed ? result : messages;
}

function obfuscateMemoizedBatch(obfuscator: SecretObfuscator, messages: Message[], memo: ObfuscatorMemo): Message[] {
	if (memo.obfuscator !== obfuscator) {
		memo.obfuscator = obfuscator;
		memo.messages = new WeakMap();
		memo.shared = new Set();
	}
	const entries: ObfuscatedMessage[] = [];
	// Whether each message was collected in this request with every text clean.
	const collectedClean: boolean[] = [];
	const sharedRegexSecretValues = new SecretValueSet();
	for (const message of messages) {
		const revision = obfuscator.revision;
		const literalRevision = obfuscator.literalRevision;
		const messageVersion = messageEstimateVersion(message);
		let entry = memo.messages.get(message);
		let clean = false;
		if (
			entry === undefined ||
			entry.messageVersion !== messageVersion ||
			(entry.clean ? entry.literalRevision !== literalRevision : entry.revision !== revision)
		) {
			const dirtyScans = obfuscator.dirtyScans;
			const values = new Set<string>();
			collectMessageRegexSecretValues(obfuscator, message, values);
			clean = obfuscator.dirtyScans === dirtyScans;
			const regexValues = values.size === 0 ? NO_REGEX_VALUES : [...values];
			if (entry === undefined) {
				entry = {
					revision,
					literalRevision,
					messageVersion,
					clean: false,
					regexValues,
					sharedVersion: 0,
					output: undefined,
				};
				memo.messages.set(message, entry);
			} else {
				entry.revision = revision;
				entry.literalRevision = literalRevision;
				entry.messageVersion = messageVersion;
				entry.clean = false;
				entry.regexValues = regexValues;
				entry.output = undefined;
			}
		}
		for (const value of entry.regexValues) sharedRegexSecretValues.add(value);
		entries.push(entry);
		collectedClean.push(clean);
	}
	// Redaction depends on the shared set, so it is versioned once per request.
	if (!sameValues(sharedRegexSecretValues, memo.shared)) {
		memo.shared = sharedRegexSecretValues;
		memo.sharedVersion++;
	}
	const sharedVersion = memo.sharedVersion;
	// Clean messages skip `obfuscate`, which would resolve a lazy key first
	// when the shared values mint; resolve it here so they see it as a literal.
	obfuscator.prepareSharedValues(sharedRegexSecretValues);
	let changed = false;
	const result = messages.map((message, index): Message => {
		const entry = entries[index];
		// Re-checked per message: resolving the key (above, or while redacting an
		// earlier message) is a literal change that can make this text dirty.
		if (entry.clean && entry.literalRevision === obfuscator.literalRevision) return message;
		const revision = obfuscator.revision;
		let output = entry.output;
		if (entry.clean || output === undefined || entry.revision !== revision || entry.sharedVersion !== sharedVersion) {
			const dirtyScans = obfuscator.dirtyScans;
			output = obfuscateMessage(obfuscator, message, sharedRegexSecretValues);
			if (
				collectedClean[index] &&
				obfuscator.dirtyScans === dirtyScans &&
				output === message &&
				obfuscator.literalRevision === entry.literalRevision
			) {
				// Clean through collection and redaction under unchanged literals.
				entry.clean = true;
				entry.output = message;
			} else if (!entry.clean && entry.revision === revision && obfuscator.revision === revision) {
				// Kept only when collection and redaction both ran under the current
				// registry; a mint in between ties the result to an older state.
				entry.output = output;
				entry.sharedVersion = sharedVersion;
			} else {
				// A clean entry outdated by a literal change is collected afresh next time.
				entry.clean = false;
				entry.output = undefined;
			}
		}
		if (output !== message) changed = true;
		return output;
	});
	return changed ? result : messages;
}

/**
 * Redact outbound provider context. Only conversation messages are rewritten;
 * the static system prompt and tool schemas pass through unchanged. `memo` is
 * passed to {@link obfuscateMessages}.
 */
export function obfuscateProviderContext(
	obfuscator: SecretObfuscator | undefined,
	context: Context,
	memo?: ObfuscatorMemo,
): Context {
	if (!obfuscator?.obfuscates()) return context;
	const messages = obfuscateMessages(obfuscator, context.messages, memo);
	return messages === context.messages ? context : { ...context, messages };
}
