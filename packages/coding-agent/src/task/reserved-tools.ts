/**
 * Child sessions cannot replace these built-in completion tools.
 *
 * The names are the exact lowercase registry keys. Task and eval preflight and
 * the SDK child registry share this lookup so neither path can admit a different
 * spelling of the reservation error.
 */
const RESERVED_CHILD_TOOL_NAMES: Record<string, true> = {
	yield: true,
	handback: true,
};

export function isReservedChildToolName(name: string): boolean {
	return RESERVED_CHILD_TOOL_NAMES[name] === true;
}

/** Exact validation text required at every child admission boundary. */
export function reservedChildToolMessage(name: string): string {
	return `tool name "${name}" is reserved`;
}
