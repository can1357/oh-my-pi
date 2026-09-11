import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, ImageContent, Message, ProviderPayload, TextContent } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionContext } from "../session/session-context";
import type { JsonValue, SecretObfuscator } from "./obfuscator";
import { collectJsonRegexSecretValues, mapJsonStrings } from "./placeholder-scan";

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
	const regexSecretValues = sharedRegexSecretValues ?? collectJsonRegexSecretValues(obfuscator, args as JsonValue);
	return mapJsonStrings(args as JsonValue, s => obfuscator.obfuscate(s, regexSecretValues)) as Record<string, unknown>;
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
 * thinking block loses its byte-bound replay signature.
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
			return { ...block, arguments: args, intent, rawBlock };
		}
		return block;
	});
	return changed ? result : content;
}

function collectMessageRegexSecretValues(obfuscator: SecretObfuscator, messages: Message[]): Set<string> {
	const values = new Set<string>();
	const addText = (text: string | undefined): void => {
		if (text === undefined) return;
		for (const value of obfuscator.collectRegexSecretValuesForObfuscation(text)) {
			values.add(value);
		}
	};
	for (const message of messages) {
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
			continue;
		}
		if (
			message.role !== "user" &&
			message.role !== "toolResult" &&
			!(message.role === "developer" && message.attribution === "user")
		) {
			continue;
		}
		const target = message as UserFacingMessage;
		if (typeof target.content === "string") {
			addText(target.content);
			continue;
		}
		for (const block of target.content) {
			if (block.type === "text") addText(block.text);
		}
	}
	return values;
}

/**
 * Redact secrets from outbound messages. User messages, tool results, and
 * user-authored developer messages (e.g. `@file` mentions) are obfuscated.
 * Assistant replay content is re-obfuscated too, because session restoration
 * expands keyed placeholders locally before the next provider request. Inline
 * image bytes are never walked.
 */
export function obfuscateMessages(obfuscator: SecretObfuscator, messages: Message[]): Message[] {
	if (!obfuscator.hasSecrets()) return messages;
	const sharedRegexSecretValues = collectMessageRegexSecretValues(obfuscator, messages);
	let changed = false;
	const result = messages.map((message): Message => {
		if (message.role === "user" || message.role === "developer" || message.role === "assistant") {
			const replay = obfuscateNativeReplay(obfuscator, message, sharedRegexSecretValues);
			if (replay !== message) {
				changed = true;
				message = replay;
			}
		}
		if (
			message.role !== "user" &&
			message.role !== "toolResult" &&
			!(message.role === "developer" && message.attribution === "user")
		) {
			if (message.role !== "assistant") return message;
			const content = obfuscateAssistantContentForReplay(obfuscator, message.content, sharedRegexSecretValues);
			if (content === message.content) return message;
			changed = true;
			return { ...message, content };
		}
		const target = message as UserFacingMessage;
		if (typeof target.content === "string") {
			const content = obfuscator.obfuscate(target.content, sharedRegexSecretValues);
			if (content === target.content) return message;
			changed = true;
			return { ...target, content } as Message;
		}
		const content = obfuscateTextBlocks(obfuscator, target.content, sharedRegexSecretValues);
		if (content === target.content) return message;
		changed = true;
		return { ...target, content } as Message;
	});
	return changed ? result : messages;
}

/**
 * Redact outbound provider context. Only conversation messages are rewritten;
 * the static system prompt and tool schemas pass through unchanged.
 */
export function obfuscateProviderContext(obfuscator: SecretObfuscator | undefined, context: Context): Context {
	if (!obfuscator?.hasSecrets()) return context;
	const messages = obfuscateMessages(obfuscator, context.messages);
	return messages === context.messages ? context : { ...context, messages };
}
