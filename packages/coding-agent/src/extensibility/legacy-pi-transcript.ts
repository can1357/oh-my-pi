/**
 * Compatibility port of upstream pi-ai's transcript-replay helpers for legacy
 * extensions importing the aliased package roots (`@earendil-works/pi-ai`,
 * `@mariozechner/pi-ai`).
 *
 * Upstream pi-ai 1.x exposes a transcript-replay module
 * (`src/utils/transcript.ts`, present since at least 1.0.2) and re-exports it
 * from the package root (`normalizeContext`, `getCurrentSystemMessage`,
 * `getCurrentTools`, `resolveTranscriptTools`, …). OMP forked before that
 * module existed and has no equivalent anywhere in `@oh-my-pi/pi-ai`, so the
 * star re-export in `legacy-pi-ai-shim.ts` cannot satisfy these imports and
 * legacy extensions fail Bun's static named-export check (observed with
 * `pi-optchat` importing `getCurrentSystemMessage`).
 *
 * The logic below is ported verbatim from upstream `pi-ai` 1.1.0
 * (`src/utils/transcript.ts` + the `contentText`/`getSystemMessageText` helpers
 * from `src/utils/text.ts`). Types are structural: the compat layer must not
 * depend on OMP's exact `SystemMessage`/`Tool` drift, and legacy callers pass
 * plain message arrays (upstream's own `TranscriptMessages` is `readonly {role}[]`).
 */

/** A message-like entry; replay helpers only read entries whose role is `"system"`. */
interface TranscriptMessageLike {
	role: string;
	content?: unknown;
	timestamp?: number;
	sections?: Record<string, string | null> | undefined;
	toolsAdded?: TranscriptToolLike[] | undefined;
	toolsRemoved?: TranscriptToolReferenceLike[] | undefined;
}

/** A tool-like declaration as carried by system-message tool state. */
interface TranscriptToolLike {
	name: string;
	description?: string;
	parameters: unknown;
	constrainedSampling?: boolean | undefined;
}

/** Upstream `ToolReference`: a by-name removal marker. */
interface TranscriptToolReferenceLike {
	name: string;
}

/** Extract and join text from message content (upstream `text.ts`). */
function contentText(content: unknown, separator = "\n"): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string"
		) {
			parts.push(block.text);
		}
	}
	return parts.join(separator);
}

/** Render a system message as a complete prompt: its content followed by its sections. */
function getSystemMessageText(message: TranscriptMessageLike): string {
	const parts = [contentText(message.content)];
	for (const text of Object.values(message.sections ?? {})) {
		if (text !== null) parts.push(text);
	}
	return parts.filter(part => part.length > 0).join("\n\n");
}

/** Shared predicate for replay helpers: only `"system"` entries carry tool/section state (9 call sites must stay in lockstep; mirrors upstream's own helper). */
function isSystemMessage(message: TranscriptMessageLike): boolean {
	return message.role === "system";
}

/** Upstream `TranscriptContext`: a context whose system prompt and tools are folded into messages. */
export interface TranscriptContext {
	messages: TranscriptMessageLike[];
}

/** Build the leading system message for a prompt and tool set. Returns undefined when both are empty, so an empty transcript stays empty. */
export function createInitialSystemMessage(
	systemPrompt: string | undefined,
	tools: TranscriptToolLike[] | undefined,
): TranscriptMessageLike | undefined {
	const hasSystemPrompt = systemPrompt !== undefined && systemPrompt.length > 0;
	const hasTools = tools !== undefined && tools.length > 0;
	if (!hasSystemPrompt && !hasTools) return undefined;
	return {
		role: "system",
		content: systemPrompt ?? "",
		...(hasTools ? { toolsAdded: tools } : {}),
		timestamp: 0,
	};
}

/**
 * Fold `Context.systemPrompt` and `Context.tools` into a leading system message.
 * This is the only entry point that produces a {@link TranscriptContext}; every
 * provider-facing function expects the result.
 */
export function normalizeContext(context: {
	systemPrompt?: string | undefined;
	tools?: TranscriptToolLike[] | undefined;
	messages: TranscriptMessageLike[];
}): TranscriptContext {
	const initialMessage = createInitialSystemMessage(context.systemPrompt, context.tools);
	const messages = initialMessage ? [initialMessage, ...context.messages] : context.messages;
	return { messages };
}

/** Return the leading system message, if the transcript starts with one. */
export function getInitialSystemMessage(messages: readonly TranscriptMessageLike[]): TranscriptMessageLike | undefined {
	const first = messages[0];
	return first && isSystemMessage(first) ? first : undefined;
}

/** Drop the leading system message for APIs that carry the prompt outside the message list. */
export function withoutInitialSystemMessage<T extends TranscriptMessageLike>(messages: readonly T[]): T[] {
	return getInitialSystemMessage(messages) ? messages.slice(1) : [...messages];
}

/** Resolve the tools available after applying every transcript delta in order. */
export function getCurrentTools(messages: readonly TranscriptMessageLike[]): TranscriptToolLike[] {
	const tools = new Map<string, TranscriptToolLike>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return [...tools.values()];
}

/**
 * Replay every system message into one leading system message holding the current
 * prompt and tools. Later `content` is appended to the base prompt, `sections` are
 * patched by name, and tools are resolved with {@link getCurrentTools}.
 */
export function getCurrentSystemMessage(messages: readonly TranscriptMessageLike[]): TranscriptMessageLike | undefined {
	const content: string[] = [];
	const sections = new Map<string, string | null>();
	let timestamp: number | undefined;
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		timestamp ??= message.timestamp;
		const text = contentText(message.content);
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
	}
	const tools = getCurrentTools(messages);
	if (timestamp === undefined && tools.length === 0) return undefined;
	return {
		role: "system",
		content: content.join("\n\n"),
		...(sections.size > 0 ? { sections: Object.fromEntries(sections) } : {}),
		...(tools.length > 0 ? { toolsAdded: tools } : {}),
		timestamp: timestamp ?? 0,
	};
}

/** Render the current system prompt text after replaying every system message. */
export function getCurrentSystemPrompt(messages: readonly TranscriptMessageLike[]): string {
	const message = getCurrentSystemMessage(messages);
	return message ? getSystemMessageText(message) : "";
}

/** Rebuild the transcript for APIs without mid-conversation system messages: the replayed system message leads, and every later system message is dropped. */
export function collapseSystemMessages(context: TranscriptContext): TranscriptContext {
	const head = getCurrentSystemMessage(context.messages);
	const messages = context.messages.filter(message => message.role !== "system");
	return { messages: head ? [head, ...messages] : messages };
}

/** Keep later system messages in place when the model accepts them; otherwise collapse them. */
export function resolveTranscript(
	context: TranscriptContext,
	supportsMidConvoSystemMessages: boolean | undefined,
): TranscriptContext {
	return supportsMidConvoSystemMessages ? context : collapseSystemMessages(context);
}

/** Strip executable and display-only fields from a tool before transcript comparison or persistence. */
export function toToolDeclaration(tool: TranscriptToolLike): Record<string, unknown> {
	return {
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters)),
		...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
	};
}

/**
 * Whether two tools declare the same interface to the model.
 *
 * Both sides go through {@link toToolDeclaration} first: its JSON round-trip drops the
 * typebox symbol keys and `undefined` fields that a structural comparison would see, and
 * builds both objects with the same key order, so comparing the serialized declarations
 * is exact. This avoids a deep-equal dependency in a browser-safe package.
 */
export function declarationsEqual(left: TranscriptToolLike, right: TranscriptToolLike): boolean {
	return JSON.stringify(toToolDeclaration(left)) === JSON.stringify(toToolDeclaration(right));
}

export interface TranscriptToolStateChanges {
	toolsAdded: Record<string, unknown>[];
	toolsRemoved: TranscriptToolReferenceLike[];
}

/** Compare two complete tool states. A changed definition is a removal followed by an addition. */
export function getToolStateChanges(
	previous: readonly TranscriptToolLike[],
	current: readonly TranscriptToolLike[],
): TranscriptToolStateChanges {
	const previousTools = new Map(previous.map(tool => [tool.name, tool]));
	const currentTools = new Map(current.map(tool => [tool.name, tool]));
	return {
		toolsAdded: current
			.filter(tool => {
				const previousTool = previousTools.get(tool.name);
				return previousTool === undefined || !declarationsEqual(previousTool, tool);
			})
			.map(toToolDeclaration),
		toolsRemoved: previous
			.filter(tool => {
				const currentTool = currentTools.get(tool.name);
				return currentTool === undefined || !declarationsEqual(tool, currentTool);
			})
			.map(tool => ({ name: tool.name })),
	};
}

/** Every definition referenced by transcript tool state, in first-declaration order. */
export function getDeclaredTools(messages: readonly TranscriptMessageLike[]): TranscriptToolLike[] {
	const definitions = new Map<string, TranscriptToolLike>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of message.toolsAdded ?? []) definitions.set(tool.name, tool);
	}
	return [...definitions.values()];
}

/**
 * Whether a tool name was declared twice with different definitions. A transport that
 * can only reference previously declared tools by name cannot replay such a history.
 *
 * External compatibility requirement: upstream pi-ai 1.1.0 marks this function
 * `@deprecated` but keeps it exported for legacy API consumers, and this compat
 * layer must reproduce upstream's public surface 1:1 for legacy extensions that
 * import it by name. Removal follows upstream's removal, not ours.
 */
export function hasToolRedefinitions(messages: readonly TranscriptMessageLike[]): boolean {
	const declared = new Map<string, TranscriptToolLike>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		for (const tool of message.toolsAdded ?? []) {
			const previous = declared.get(tool.name);
			if (previous !== undefined && !declarationsEqual(previous, tool)) return true;
			declared.set(tool.name, tool);
		}
	}
	return false;
}

/** Whether tool history contains a removal or same-name redeclaration that an addition-only transport cannot replay. */
export function hasNonAdditiveToolChanges(messages: readonly TranscriptMessageLike[]): boolean {
	const declared = new Set<string>();
	for (const message of messages) {
		if (!isSystemMessage(message)) continue;
		if ((message.toolsRemoved?.length ?? 0) > 0) return true;
		for (const tool of message.toolsAdded ?? []) {
			if (declared.has(tool.name)) return true;
			declared.add(tool.name);
		}
	}
	return false;
}

export interface TranscriptTools {
	/** Tools sent in the top-level request field. */
	requestTools: TranscriptToolLike[];
	/**
	 * Whether later system messages carry their own `toolsAdded` as in-place additions.
	 * When false, `requestTools` already holds the complete current tool set.
	 */
	anchorsAdditions: boolean;
}

/**
 * Split tool declarations between the top-level request field and in-place additions.
 * Transports that can anchor additions at a system message keep the initial tools at the
 * top and load later ones where they appear; that only works when no tool was removed or
 * redeclared, so everything else sends the current tool list.
 */
export function resolveTranscriptTools(
	messages: readonly TranscriptMessageLike[],
	supportsToolAdditions: boolean,
): TranscriptTools {
	const anchorsAdditions = supportsToolAdditions && !hasNonAdditiveToolChanges(messages);
	return {
		requestTools: anchorsAdditions
			? (getInitialSystemMessage(messages)?.toolsAdded ?? [])
			: getCurrentTools(messages),
		anchorsAdditions,
	};
}
