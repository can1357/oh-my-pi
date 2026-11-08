/**
 * Mid-conversation tool additions via `additional_tools` input items
 * (`model.compat.supportsMidConversationToolChanges` on the Responses and
 * Codex providers).
 *
 * The tools a session's first request declares stay its declaration, so the
 * cached prompt prefix survives a tool that becomes active later. Each later
 * addition is carried as an `additional_tools` developer item inserted at the
 * tail of the transcript — before the user message it takes effect on, or
 * after the latest tool result when the tool is added inside a tool loop —
 * and replayed at that position on every subsequent request. The model can
 * call a tool from the point its item appears. Mirrors the Anthropic
 * provider's `tool_addition` controls.
 *
 * The Responses API has no removal item, so a request that drops a declared
 * or added tool re-declares its own tools and starts a new baseline, which is
 * what every request did before. A history rewritten under a recorded
 * addition (compaction, branch switch, `/clear`) does the same.
 *
 * State lives in each provider's session state, keyed per conversation, like
 * the effort controls; a side request plans against a copy of its parent's.
 */
/** The fields of an input item the planner reads; any other field only enters the history fingerprint. */
interface PlannedItem {
	type?: string | null;
	role?: string;
	id?: string | null;
	status?: string | null;
}

/** A Responses tool declaration as sent on the wire; function and custom tools carry `name`, hosted tools only `type`. */
export interface ResponsesWireTool {
	type: string;
	name?: string;
}

/** `additional_tools` developer input item. */
export interface AdditionalToolsItem<TTool extends ResponsesWireTool = ResponsesWireTool> {
	type: "additional_tools";
	role: "developer";
	tools: TTool[];
}

interface ToolAddition {
	/** Input-array position the item is spliced into (before `input[index]`). */
	index: number;
	/** Fingerprint of `input[0..index)` at record time; a mismatch means the history was rewritten. */
	anchor: string;
	/** Keys of the tools added there, in request order. */
	keys: string[];
}

/** Per-conversation tool declaration and recorded additions. */
export interface OpenAIToolControlState {
	sessionId: string;
	/** Keys of the declared tools, in wire order; unset until the first request. */
	declared?: string[];
	additions: ToolAddition[];
}

const MAX_TOOL_CONTROL_STATES = 16;

function toolKey(tool: ResponsesWireTool): string {
	return tool.name ?? `type:${tool.type}`;
}

/**
 * Fingerprints of the history before each position in `indices`, from one pass
 * over `input`. Output-only lifecycle fields are left out (a live response
 * item carries `id`/`status` that its sanitized replay drops), and so are
 * `additional_tools` items: the leading Responses Lite declaration follows the
 * current tools, and mid-conversation items are spliced in after planning.
 */
function historyAnchors(input: readonly PlannedItem[], indices: readonly number[]): Map<number, string> {
	const anchors = new Map<number, string>();
	const wanted = new Set(indices);
	let hash: bigint | number = 0;
	for (let index = 0; index <= input.length; index++) {
		if (wanted.has(index)) anchors.set(index, String(hash));
		const item = input[index];
		if (!item || item.type === "additional_tools") continue;
		const { id: _id, status: _status, ...stable } = item;
		hash = Bun.hash(JSON.stringify(stable), hash);
	}
	return anchors;
}

/**
 * Control state a Responses or Codex request plans against, from a provider's
 * bounded per-session map. A side request (`parentSessionId`) gets a throwaway
 * copy of its parent's state, so it sends the parent's prefix and its own
 * additions never reach the parent.
 */
export function resolveOpenAIToolControlState(
	states: Map<string, OpenAIToolControlState>,
	keyOf: (sessionId: string) => string,
	sessionId: string,
	parentSessionId: string | undefined,
): OpenAIToolControlState {
	if (parentSessionId !== undefined && parentSessionId !== sessionId) {
		const parent = states.get(keyOf(parentSessionId));
		return parent ? { ...structuredClone(parent), sessionId } : { sessionId, additions: [] };
	}
	const key = keyOf(sessionId);
	const existing = states.get(key);
	if (existing) {
		states.delete(key);
		states.set(key, existing);
		return existing;
	}
	const created: OpenAIToolControlState = { sessionId, additions: [] };
	states.set(key, created);
	if (states.size > MAX_TOOL_CONTROL_STATES) {
		const oldest = states.keys().next().value;
		if (oldest !== undefined) states.delete(oldest);
	}
	return created;
}

/** Release one conversation's tool state from the Responses and Codex `releaseSession` implementations. */
export function releaseOpenAIToolControlSession(states: Map<string, OpenAIToolControlState>, sessionId: string): void {
	for (const [key, state] of states) {
		if (state.sessionId === sessionId) states.delete(key);
	}
}

/**
 * Keep the declared tools to the session baseline and splice pending
 * `additional_tools` items into `input` (mutated in place).
 *
 * `input` is the freshly built transcript for this request, without any
 * mid-conversation `additional_tools` items; `tools` is what the request would
 * otherwise declare. Returns the tools to declare: the baseline in its
 * original order with current definitions, or `tools` itself when this request
 * sets a new baseline.
 */
export function planStableOpenAITools<TTool extends ResponsesWireTool>(
	state: OpenAIToolControlState,
	input: PlannedItem[],
	tools: readonly TTool[],
): TTool[] {
	const byKey = new Map(tools.map(tool => [toolKey(tool), tool]));
	const rebaseline = () => {
		state.declared = [...byKey.keys()];
		state.additions = [];
		return [...tools];
	};
	if (!state.declared) return rebaseline();
	const last = input[input.length - 1];
	const index = last?.role === "user" ? input.length - 1 : input.length;
	const anchors = historyAnchors(input, [...state.additions.map(addition => addition.index), index]);
	for (const addition of state.additions) {
		if (addition.index > input.length || addition.anchor !== anchors.get(addition.index)) return rebaseline();
	}
	const known = [...state.declared, ...state.additions.flatMap(addition => addition.keys)];
	if (known.some(key => !byKey.has(key))) return rebaseline();
	const knownSet = new Set(known);
	const added = [...byKey.keys()].filter(key => !knownSet.has(key));
	if (added.length > 0) state.additions.push({ index, anchor: anchors.get(index)!, keys: added });
	let offset = 0;
	for (const addition of state.additions) {
		const item: AdditionalToolsItem<TTool> = {
			type: "additional_tools",
			role: "developer",
			tools: addition.keys.map(key => byKey.get(key)!),
		};
		input.splice(addition.index + offset, 0, item);
		offset++;
	}
	return state.declared.map(key => byKey.get(key)!);
}
