/** Stores streamed tool-call argument JSON for live renderers and parser recovery. */
export const kStreamingPartialJson = Symbol("provider.block.partialJson");

/** Carries streamed tool-call argument JSON without exposing a string-keyed property. */
export type StreamingPartialJsonCarrier = object & { [kStreamingPartialJson]?: string };

/** Reads streamed tool-call argument JSON from a block or event snapshot. */
export function getStreamingPartialJson(block: StreamingPartialJsonCarrier | null | undefined): string | undefined {
	return block?.[kStreamingPartialJson];
}

/** Writes streamed tool-call argument JSON to a block or clears it with `undefined`. */
export function setStreamingPartialJson(block: StreamingPartialJsonCarrier, value: string | undefined): void {
	block[kStreamingPartialJson] = value;
}

/** Clears streamed tool-call argument JSON without deleting or changing object shape. */
export function clearStreamingPartialJson(block: StreamingPartialJsonCarrier): void {
	if (Object.hasOwn(block, kStreamingPartialJson)) block[kStreamingPartialJson] = undefined;
}

/** Stores a provider-local stream block index without exposing a string-keyed property. */
export const kStreamingBlockIndex = Symbol("provider.block.index");

/** Stores the last parsed argument prefix length for throttled streaming JSON parsing. */
export const kStreamingLastParseLen = Symbol("provider.block.lastParseLen");

/**
 * The Cursor interaction envelope's `call_id` for a streamed tool-call block.
 *
 * Tracked separately from the block's own `id` because they are NOT the same
 * key: MCP and Pi blocks are filed under the id inside the call's `args`, which
 * is what the exec channel pairs its result under, while every streamed
 * `ToolCall*Update` correlates on the envelope's `call_id`. Matching
 * completions against the block id would mis-route every call whose args carry
 * their own id.
 */
export const kStreamingEnvelopeId = Symbol("provider.block.envelopeId");

/** Marks streamed tool-call arguments that already received an authoritative done payload. */
export const kStreamingArgumentsDone = Symbol("provider.block.argumentsDone");

/** Classifies Cursor's in-flight tool-call kind without leaking provider-private state. */
export const kStreamingBlockKind = Symbol("provider.block.kind");

/**
 * Marks a `toolCall` content block that Cursor's exec channel already
 * executed server-side (via the coding-agent bridge) and whose result is
 * buffered separately for emission via the assistant-loop stream.
 *
 * `agent-loop.ts` MUST skip execution of blocks carrying this marker —
 * treating them as a fresh runnable tool call would run the same
 * side-effecting tool (bash, write, delete, …) a second time. Symbol-keyed
 * so it never persists across the JSONL round-trip, where rebuild instead
 * pairs the block with its already-persisted `toolResult` message by id.
 */
export const kCursorExecResolved = Symbol("provider.block.cursorExecResolved");

/** Carries the resolved marker without exposing a string-keyed property. */
export type CursorExecResolvedCarrier = object & { [kCursorExecResolved]?: true };

/** True when a toolCall block was already executed by Cursor's exec channel. */
export function isCursorExecResolved(block: CursorExecResolvedCarrier | null | undefined): boolean {
	return block?.[kCursorExecResolved] === true;
}

/**
 * Copy {@link kCursorExecResolved} onto a cloned/projected toolCall block.
 *
 * Stream projectors (owned/in-band dialect, leaked-thinking heal) rebuild
 * toolCall objects field-by-field. Dropping this marker lets `agent-loop.ts`
 * re-execute a call Cursor already settled — duplicate toolResults and a
 * second bash/write/delete. Partial-JSON is already copied explicitly; this
 * marker is the other load-bearing symbol that must survive the same way.
 */
export function copyCursorExecResolved(target: CursorExecResolvedCarrier, source: CursorExecResolvedCarrier): void {
	if (source[kCursorExecResolved] === true) target[kCursorExecResolved] = true;
}

/**
 * Marks a text block synthesized by cross-model thinking demotion in
 * `transformMessages`. Converters that flatten adjacent text blocks into one
 * string (openai-completions) insert a paragraph separator after marked
 * blocks; unmarked adjacent blocks keep their original byte sequence.
 * Symbol-keyed so the marker never persists across the JSONL round-trip and
 * never reaches the wire.
 */
export const kDemotedThinking = Symbol("provider.block.demotedThinking");

/** Carries the demoted-thinking marker without exposing a string-keyed property. */
export type DemotedThinkingCarrier = object & { [kDemotedThinking]?: boolean };

/** True for text blocks synthesized by cross-model thinking demotion. */
export function isDemotedThinking(block: DemotedThinkingCarrier | null | undefined): boolean {
	return block?.[kDemotedThinking] === true;
}

/**
 * Marks a thinking block that `transformMessages` carried natively from
 * another host serving the same model (see `compat/reasoning-carry` in the
 * catalog). Its host-bound signature and item id are gone, so encoders that
 * replay reasoning from stored payloads (Responses) emit a plaintext item for
 * it instead. Symbol-keyed so the marker never persists or reaches the wire.
 */
export const kCarriedReasoning = Symbol("provider.block.carriedReasoning");

/** Carries the carried-reasoning marker without exposing a string-keyed property. */
export type CarriedReasoningCarrier = object & { [kCarriedReasoning]?: boolean };

/** True for thinking blocks carried natively from another host of the same model. */
export function isCarriedReasoning(block: CarriedReasoningCarrier | null | undefined): boolean {
	return block?.[kCarriedReasoning] === true;
}

/**
 * Marks an Anthropic wire message that was serialized from a source
 * `role: "user"` message.
 *
 * The wire role alone cannot answer this. `convertAnthropicMessages` emits
 * `role: "user"` for several things that are not a conversational turn:
 * `developer` messages on models without mid-conversation `system` support,
 * `tool_result` runs, and the synthetic `Continue.` pads inserted between
 * adjacent assistants. Prompt-cache decimation counts conversational turns,
 * so it reads this marker instead of guessing from wire content.
 *
 * Symbol-keyed so the marker never persists across the JSONL round-trip and
 * never reaches the wire.
 */
export const kConversationalUser = Symbol("provider.message.conversationalUser");

/** Carries the conversational-user marker without exposing a string-keyed property. */
export type ConversationalUserCarrier = object & { [kConversationalUser]?: boolean };

/** True for wire messages serialized from a source `role: "user"` message. */
export function isConversationalUser(message: ConversationalUserCarrier | null | undefined): boolean {
	return message?.[kConversationalUser] === true;
}

/**
 * Marks a `role: "user"` message that `transformMessages` synthesized rather
 * than one the user sent.
 *
 * The stale-tool-result note is deliberately emitted as `user` so no provider
 * elevates untrusted tool output to instruction priority, which leaves it
 * indistinguishable from a real turn by role alone. Prompt-cache decimation
 * must not count it, or an orphan result appearing or disappearing in a
 * compacted history shifts every later checkpoint.
 *
 * Symbol-keyed so the marker never persists across the JSONL round-trip and
 * never reaches the wire.
 */
export const kSyntheticUser = Symbol("provider.message.syntheticUser");

/** Carries the synthetic-user marker without exposing a string-keyed property. */
export type SyntheticUserCarrier = object & { [kSyntheticUser]?: boolean };

/** True for `user` messages synthesized by message transformation. */
export function isSyntheticUser(message: SyntheticUserCarrier | null | undefined): boolean {
	return message?.[kSyntheticUser] === true;
}

/**
 * Marks a message synthesized by a per-call context transform rather than
 * loaded from persisted conversation history.
 *
 * Prompt-cache boundaries must skip these messages: their content is rebuilt
 * for each request and cannot anchor a prefix reused by the next turn.
 * Symbol-keyed so the marker never persists or reaches the provider wire.
 */
export const kPerCallContextMessage = Symbol("agent.message.perCallContext");

/** Carries per-call context provenance without exposing a string-keyed property. */
export type PerCallContextMessageCarrier = object & { [kPerCallContextMessage]?: true };

/** Marks a message as synthesized for the current provider call. */
export function markPerCallContextMessage(message: PerCallContextMessageCarrier): void {
	message[kPerCallContextMessage] = true;
}

/** Copies per-call context provenance to a converted or projected message. */
export function copyPerCallContextMessage(
	target: PerCallContextMessageCarrier,
	source: PerCallContextMessageCarrier,
): void {
	if (source[kPerCallContextMessage] === true) target[kPerCallContextMessage] = true;
}

/** True when a message was synthesized for the current provider call. */
export function isPerCallContextMessage(message: PerCallContextMessageCarrier | null | undefined): boolean {
	return message?.[kPerCallContextMessage] === true;
}

/**
 * Identity of one claimable aside (the agent loop's `ASIDE_MESSAGE_CLAIM`),
 * carried onto every message converted or projected from it, so the loop can
 * tell at the request hand-off whether the provider-bound context still holds
 * that very aside rather than only text like it. An own enumerable
 * symbol-keyed property: object-spread transforms keep it, and a conversion or
 * clone made from the aside itself copies it ({@link copyAsideProvenance}).
 * It is never inferred from equal bytes or an equal position: an object that
 * does not descend from the aside does not carry it. It never persists or
 * reaches the provider wire. The producer gives the aside its identity when
 * it builds it ({@link markAsideProvenance}), before anything can convert it.
 */
export const kAsideProvenance = Symbol("agent.message.asideProvenance");

/** Carries a claimable aside's identity without exposing a string-keyed property. */
export type AsideProvenanceCarrier = object & { [kAsideProvenance]?: object };

/** Give `message` an identity of its own, unless it has one. */
export function markAsideProvenance<T extends AsideProvenanceCarrier>(message: T): T {
	message[kAsideProvenance] ??= {};
	return message;
}

/**
 * Make `target` carry exactly `source`'s identity, or none: only for an object
 * made from `source` itself (its conversion, its clone).
 */
export function copyAsideProvenance(target: AsideProvenanceCarrier, source: AsideProvenanceCarrier): void {
	const provenance = source[kAsideProvenance];
	if (provenance !== undefined) target[kAsideProvenance] = provenance;
	else if (target[kAsideProvenance] !== undefined) delete target[kAsideProvenance];
}

/**
 * Identities of claimable asides that a sent request carried. Any later
 * request may carry them again (they are history now); nothing else that
 * carries an aside identity may be sent, by any request path.
 */
const deliveredAsides = new WeakSet<object>();

/** Record that a sent request carried `message`, a claimable aside. */
export function markAsideDelivered(message: AsideProvenanceCarrier): void {
	const provenance = message[kAsideProvenance];
	if (provenance !== undefined) deliveredAsides.add(provenance);
}

/**
 * `context` without every message that carries an aside identity which is
 * neither delivered nor in `claiming` (the asides the request is claiming at
 * this hand-off): a descendant of an aside that was withdrawn, replaced or
 * handed back unsent, which a host cache, a context extension or a transform
 * returned again. Its producer has already settled it, so sending it would
 * deliver a notice that ended unread. Every provider entry point applies this,
 * so a side request, a handoff or a summary cannot send one either. Returns
 * `context` itself when nothing is withheld.
 */
export function withholdUndeliveredAsides<T extends { messages: readonly object[] }>(
	context: T,
	claiming: readonly AsideProvenanceCarrier[] = [],
): T {
	let live: Set<object> | undefined;
	for (const message of claiming) {
		const provenance = message[kAsideProvenance];
		if (provenance !== undefined) (live ??= new Set()).add(provenance);
	}
	const sendable = (message: object): boolean => {
		const provenance = (message as AsideProvenanceCarrier)[kAsideProvenance];
		return provenance === undefined || deliveredAsides.has(provenance) || live?.has(provenance) === true;
	};
	if (context.messages.every(sendable)) return context;
	return { ...context, messages: context.messages.filter(sendable) };
}

/**
 * Original history position carried by a context message clone.
 *
 * Object-spread transforms retain this symbol, allowing the extension runner
 * to distinguish byte-identical historical copies from inserted messages.
 */
export const kContextHistoryIndex = Symbol("agent.message.contextHistoryIndex");

/** Carries a context message's original history position. */
export type ContextHistoryIndexCarrier = object & { [kContextHistoryIndex]?: number };

/** Reads a context message's original history position. */
export function getContextHistoryIndex(message: ContextHistoryIndexCarrier | null | undefined): number | undefined {
	return message?.[kContextHistoryIndex];
}

/** Records a context message's original history position. */
export function setContextHistoryIndex(message: ContextHistoryIndexCarrier, index: number): void {
	message[kContextHistoryIndex] = index;
}

/** Removes context-history tracking before provider conversion. */
export function clearContextHistoryIndex(message: ContextHistoryIndexCarrier): void {
	delete message[kContextHistoryIndex];
}
