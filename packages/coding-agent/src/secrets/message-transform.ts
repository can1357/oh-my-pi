import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
	AnthropicCompactionPayload,
	AssistantMessage,
	ImageContent,
	Message,
	ProviderPayload,
	TextContent,
} from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionContext } from "../session/session-context";
import { type JsonValue, mapJsonStrings } from "./json-strings";
import type { SecretObfuscator } from "./obfuscator";

// Encoding is idempotent: placeholder-shaped tokens are opaque, so text the
// model wrote from placeholders encodes to itself and replays byte-identical.
// Everything outbound is encoded, whatever its role; only content that still
// holds plaintext (written while redaction was off, or before a secret was
// configured) changes, and a signature over changed content is dropped.

// ═══════════════════════════════════════════════════════════════════════════
// Display restore (stored placeholders → local display)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The session context for display, with the model's placeholders restored.
 * The placeholder map is first rebuilt from the plaintext in the same context,
 * so placeholders the model wrote in an earlier process restore too. Only a
 * display copy is restored: the agent replays the stored context as written.
 */
export function deobfuscateSessionContext(
	sessionContext: SessionContext,
	obfuscator: SecretObfuscator | undefined,
): SessionContext {
	if (!obfuscator?.hasSecrets()) return sessionContext;
	learnFromPlaintext(obfuscator, sessionContext.messages);
	const messages = deobfuscateAgentMessages(obfuscator, sessionContext.messages);
	return messages === sessionContext.messages ? sessionContext : { ...sessionContext, messages };
}

/** Mint the placeholders for every secret in `messages` (see `SecretObfuscator.learn`). */
export function learnFromPlaintext(obfuscator: SecretObfuscator, messages: readonly AgentMessage[]): void {
	const texts: string[] = [];
	for (const message of messages) collectTexts(message, texts);
	if (texts.length === 0) return;
	obfuscator.batch(() => {
		obfuscator.prescan(texts);
		obfuscator.learn(texts);
	});
}

/** Every string under `value`, skipping image payloads. */
function collectTexts(value: unknown, texts: string[]): void {
	if (typeof value === "string") {
		texts.push(value);
	} else if (Array.isArray(value)) {
		for (const item of value) collectTexts(item, texts);
	} else if (isRecord(value) && value.type !== "image") {
		for (const item of Object.values(value)) collectTexts(item, texts);
	}
}

/** Display copies of `messages` with the model's placeholders restored. */
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

/** Apply `transform` to assistant text, thinking, and tool-call arguments/intent/rawBlock. */
function mapAssistantContent(
	content: AssistantMessage["content"],
	transform: (text: string) => string,
): AssistantMessage["content"] {
	let changed = false;
	const result = content.map((block): AssistantMessage["content"][number] => {
		if (block.type === "text") {
			const text = transform(block.text);
			if (text === block.text) return block;
			changed = true;
			return { ...block, text };
		}
		if (block.type === "thinking") {
			const thinking = transform(block.thinking);
			if (thinking === block.thinking) return block;
			changed = true;
			return { ...block, thinking };
		}
		if (block.type === "toolCall") {
			const args = mapJsonStrings(block.arguments as JsonValue, transform) as Record<string, unknown>;
			const intent = block.intent === undefined ? undefined : transform(block.intent);
			const rawBlock = block.rawBlock === undefined ? undefined : transform(block.rawBlock);
			if (args === block.arguments && intent === block.intent && rawBlock === block.rawBlock) return block;
			changed = true;
			return { ...block, arguments: args, intent, rawBlock };
		}
		return block;
	});
	return changed ? result : content;
}

/** Restore placeholders in assistant content for display. */
export function deobfuscateAssistantContent(
	obfuscator: SecretObfuscator,
	content: AssistantMessage["content"],
): AssistantMessage["content"] {
	if (!obfuscator.hasSecrets()) return content;
	return mapAssistantContent(content, text => obfuscator.deobfuscate(text));
}

/**
 * Encode assistant content. Placeholder-form blocks pass through by reference.
 * A block that changes held plaintext and loses the signature bound to it: a
 * thinking block its `thinkingSignature`, and a tool call whose arguments
 * changed its Gemini `thoughtSignature`, an attestation over the call it rides
 * on (https://ai.google.dev/gemini-api/docs/thought-signatures). `intent` and
 * `rawBlock` are harness-side and keep it.
 */
function obfuscateAssistantContent(
	obfuscator: SecretObfuscator,
	content: AssistantMessage["content"],
): AssistantMessage["content"] {
	const encoded = mapAssistantContent(content, text => obfuscator.obfuscate(text));
	if (encoded === content) return content;
	return encoded.map((block, index): AssistantMessage["content"][number] => {
		const original = content[index]!;
		if (block === original) return block;
		if (block.type === "thinking") return { ...block, thinkingSignature: undefined };
		if (block.type === "toolCall" && original.type === "toolCall" && block.arguments !== original.arguments) {
			return { ...block, thoughtSignature: undefined };
		}
		return block;
	});
}

/**
 * Restore placeholders in model-authored argument values, where a tool runs
 * them. Argument keys name tool parameters and must remain unchanged.
 */
export function deobfuscateToolArguments(
	obfuscator: SecretObfuscator,
	args: Record<string, unknown>,
): Record<string, unknown> {
	if (!obfuscator.hasSecrets()) return args;
	return mapJsonStrings(args as JsonValue, s => obfuscator.deobfuscate(s)) as Record<string, unknown>;
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

/** Visit every native-replay plaintext field encoding rewrites. */
function forEachNativeReplayText(
	message: { providerPayload?: ProviderPayload; preserveData?: Record<string, unknown> },
	visit: (text: string) => void,
): void {
	const payload = message.providerPayload;
	const remote = message.preserveData?.openaiRemoteCompaction;
	if (payload?.type !== "openaiResponsesHistory" && !isRecord(remote)) return;
	const visitItem = (item: unknown): unknown =>
		mapNativeReplayItem(item, text => {
			visit(text);
			return text;
		});
	if (payload?.type === "openaiResponsesHistory") mapNativeArray(payload.items, visitItem);
	if (isRecord(remote)) {
		if (payload?.type !== "openaiResponsesHistory" || remote.replacementHistory !== payload.items) {
			mapNativeArray(remote.replacementHistory, visitItem);
		}
		visitItem(remote.compactionItem);
	}
}

/**
 * Encode native replay and its next-compaction source. These are protocol
 * slots the harness assembles from history, so their plaintext slots are
 * encoded whatever role carries them; placeholders already there stay.
 */
export function obfuscateNativeReplay<
	T extends { providerPayload?: ProviderPayload; preserveData?: Record<string, unknown> },
>(obfuscator: SecretObfuscator, message: T): T {
	if (!obfuscator.obfuscates()) return message;
	const payload = message.providerPayload;
	const remote = message.preserveData?.openaiRemoteCompaction;
	if (payload?.type !== "openaiResponsesHistory" && !isRecord(remote)) return message;
	const transform = (text: string): string => obfuscator.obfuscate(text);
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
// Outbound encoding (local → provider)
// ═══════════════════════════════════════════════════════════════════════════

/** Encode `text` blocks of a content array; image and other blocks pass through. */
function obfuscateTextBlocks(
	obfuscator: SecretObfuscator,
	content: (TextContent | ImageContent)[],
): (TextContent | ImageContent)[] {
	let changed = false;
	const result = content.map((block): TextContent | ImageContent => {
		if (block.type !== "text") return block;
		const text = obfuscator.obfuscate(block.text);
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
 * Harness file metadata riding on a natively-replayed compaction summary.
 * The provider converter emits it beside the verbatim block's retained tail,
 * so it is encoded like other harness plaintext. The verbatim block content
 * itself stays untouched: it must match the opaque provider state replayed
 * beside it.
 */
function anthropicCompactionPayload(message: Message): AnthropicCompactionPayload | undefined {
	if (message.role !== "user" && message.role !== "developer" && message.role !== "assistant") return undefined;
	const payload = message.providerPayload;
	return payload?.type === "anthropicCompaction" ? payload : undefined;
}

function obfuscateAnthropicCompactionFiles(
	obfuscator: SecretObfuscator,
	payload: AnthropicCompactionPayload,
): AnthropicCompactionPayload {
	const filesText = payload.filesText === undefined ? undefined : obfuscator.obfuscate(payload.filesText);
	let retainedChanged = false;
	const retainedFiles = payload.retainedFiles?.map(files => {
		const text = obfuscator.obfuscate(files.text);
		if (text === files.text) return files;
		retainedChanged = true;
		return { ...files, text };
	});
	if (filesText === payload.filesText && !retainedChanged) return payload;
	return { ...payload, filesText, retainedFiles };
}

/** Visit every text of `message` encoding rewrites. */
function forEachPlaintext(message: Message, visit: (text: string) => void): void {
	const compaction = anthropicCompactionPayload(message);
	if (compaction?.filesText) visit(compaction.filesText);
	for (const files of compaction?.retainedFiles ?? []) visit(files.text);
	if (message.role !== "toolResult") forEachNativeReplayText(message, visit);
	if (message.role === "assistant") {
		mapAssistantContent(message.content, text => {
			visit(text);
			return text;
		});
		return;
	}
	if (typeof message.content === "string") {
		visit(message.content);
		return;
	}
	for (const block of message.content) {
		if (block.type === "text") visit(block.text);
	}
}

/**
 * Encode outbound messages, every role. Placeholder-form text is unchanged,
 * so the model's own messages normally pass through by reference and keep
 * their signatures and cache prefix. Native replay slots and compaction file
 * metadata are encoded too; inline image bytes are never walked. Runs on the
 * way to a provider (the agent's `convertToLlm`).
 */
export function obfuscateMessages(obfuscator: SecretObfuscator, messages: Message[]): Message[] {
	if (!obfuscator.obfuscates()) return messages;
	return obfuscator.batch(() => {
		const texts: string[] = [];
		for (const message of messages) forEachPlaintext(message, text => texts.push(text));
		obfuscator.prescan(texts);
		let changed = false;
		const result = messages.map((message): Message => {
			let current = message;
			const compaction = anthropicCompactionPayload(current);
			if (compaction !== undefined) {
				const providerPayload = obfuscateAnthropicCompactionFiles(obfuscator, compaction);
				if (providerPayload !== compaction) current = { ...current, providerPayload } as Message;
			}
			if (current.role !== "toolResult") current = obfuscateNativeReplay(obfuscator, current);
			if (current.role === "assistant") {
				const content = obfuscateAssistantContent(obfuscator, current.content);
				if (content !== current.content) current = { ...current, content };
			} else if (typeof current.content === "string") {
				const content = obfuscator.obfuscate(current.content);
				if (content !== current.content) current = { ...current, content } as Message;
			} else {
				const content = obfuscateTextBlocks(obfuscator, current.content);
				if (content !== current.content) current = { ...current, content } as Message;
			}
			if (current !== message) changed = true;
			return current;
		});
		return changed ? result : messages;
	});
}
