/**
 * Mid-conversation reasoning effort via `configuration_update` input items
 * (GPT-6 Astra; `model.compat.supportsConfigurationUpdate`).
 *
 * The request-level `reasoning.effort` is pinned to the value of the session's
 * first request so the cached prompt prefix survives an effort change. Each
 * later change is carried as a `configuration_update` item inserted at the
 * tail of the transcript — before the user message it takes effect on, or
 * after the latest tool result when the level changes inside a tool loop — and
 * replayed at that position on every subsequent request until another update
 * overrides it. Mirrors the Anthropic provider's stable `output_config.effort`
 * planning.
 *
 * Used by both the platform Responses provider and the Codex provider; the
 * state lives in each provider's session state, keyed per conversation.
 *
 * Wire constraints (verified against the Codex backend): only `gpt-6-astra`
 * accepts the item type, consecutive updates are rejected, and
 * `/responses/compact` rejects histories containing them — compaction
 * requests are built outside this planner and never carry the items.
 */

/** `configuration_update` input item; only `reasoning.effort` is updatable. */
export interface ConfigurationUpdateItem {
	type: "configuration_update";
	reasoning: { effort: string };
}

interface EffortTransition<TEffort extends string> {
	/** Input-array position the item is spliced into (before `input[index]`). */
	index: number;
	/** Fingerprint of `input[index - 1]` at record time; a mismatch means the history was rewritten. */
	anchor: string;
	effort: TEffort;
}

/** Per-conversation effort baseline and recorded transitions. */
export interface OpenAIEffortControlState<TEffort extends string = string> {
	baseEffort?: TEffort;
	currentEffort?: TEffort;
	transitions: EffortTransition<TEffort>[];
}

export function createOpenAIEffortControlState<TEffort extends string>(): OpenAIEffortControlState<TEffort> {
	return { transitions: [] };
}

const MAX_EFFORT_CONTROL_STATES = 16;

/**
 * Fetch (or create) the control state for one conversation from a provider's
 * bounded per-session map, refreshing its LRU slot.
 */
export function getOpenAIEffortControlState<TEffort extends string>(
	states: Map<string, OpenAIEffortControlState<TEffort>>,
	key: string,
): OpenAIEffortControlState<TEffort> {
	const existing = states.get(key);
	if (existing) {
		states.delete(key);
		states.set(key, existing);
		return existing;
	}
	const created = createOpenAIEffortControlState<TEffort>();
	states.set(key, created);
	if (states.size > MAX_EFFORT_CONTROL_STATES) {
		const oldest = states.keys().next().value;
		if (oldest !== undefined) states.delete(oldest);
	}
	return created;
}

interface AnchorableItem {
	type?: string | null;
	role?: string;
	id?: string | null;
	status?: string | null;
}

/**
 * Fingerprint of the item a transition sits after. Output-only lifecycle
 * fields are excluded: a live response item carries `id`/`status` that the
 * sanitized replay of the same item drops.
 */
function effortControlAnchor(input: readonly AnchorableItem[], index: number): string {
	if (index === 0) return "";
	const item = input[index - 1];
	if (!item) return "";
	const { id: _id, status: _status, ...stable } = item;
	return String(Bun.hash(JSON.stringify(stable)));
}

function resetOpenAIEffortControlState(state: OpenAIEffortControlState<string>): void {
	state.baseEffort = undefined;
	state.currentEffort = undefined;
	state.transitions = [];
}

/**
 * Discard the baseline when the request no longer continues the conversation
 * it was captured for: a wire history that shrank or was rewritten under a
 * recorded transition (compaction, branch switch, `/clear`). The next request
 * re-baselines from its own effort, which is what the API asks for after
 * compaction anyway.
 */
function syncOpenAIEffortControlState(state: OpenAIEffortControlState<string>, input: readonly AnchorableItem[]): void {
	for (const transition of state.transitions) {
		if (transition.index > input.length || transition.anchor !== effortControlAnchor(input, transition.index)) {
			resetOpenAIEffortControlState(state);
			return;
		}
	}
}

/**
 * Pin the request-level effort to the session baseline and splice pending
 * `configuration_update` items into `input` (mutated in place).
 *
 * `input` is the freshly built transcript for this request, without any
 * `configuration_update` items. `requested` is the wire effort the caller
 * would otherwise send at the request level. Returns the effort to send at the
 * request level (`requested` on the first request, the baseline afterwards).
 */
export function planStableOpenAIEffort<TItem extends AnchorableItem, TEffort extends string>(
	state: OpenAIEffortControlState<TEffort>,
	input: Array<TItem | ConfigurationUpdateItem>,
	requested: TEffort,
): TEffort {
	syncOpenAIEffortControlState(state, input);
	if (state.baseEffort === undefined) {
		state.baseEffort = requested;
		state.currentEffort = requested;
		return requested;
	}
	if (state.currentEffort !== requested) {
		const last = input[input.length - 1];
		const index = last && "role" in last && last.role === "user" ? input.length - 1 : input.length;
		const existing = state.transitions.find(transition => transition.index === index);
		if (existing) {
			existing.effort = requested;
		} else {
			state.transitions.push({ index, anchor: effortControlAnchor(input, index), effort: requested });
		}
		// A change back to the effort already in force at that position is a
		// no-op on the wire; drop it rather than send a redundant item.
		let preceding = state.baseEffort;
		let precedingIndex = -1;
		for (const transition of state.transitions) {
			if (transition.index < index && transition.index > precedingIndex) {
				preceding = transition.effort;
				precedingIndex = transition.index;
			}
		}
		if (requested === preceding) {
			state.transitions = state.transitions.filter(transition => transition.index !== index);
		}
		state.currentEffort = requested;
	}
	// Splice in ascending order so each insertion offsets only the ones after it.
	state.transitions.sort((a, b) => a.index - b.index);
	let offset = 0;
	for (const transition of state.transitions) {
		input.splice(transition.index + offset, 0, {
			type: "configuration_update",
			reasoning: { effort: transition.effort },
		});
		offset++;
	}
	return state.baseEffort;
}
