/**
 * Cursor movement over a filtered option list where some rows cannot be
 * selected: a move counts only enabled rows it lands on, and a coerced
 * index settles on the nearest enabled row (ahead first, then behind).
 */

/** The index `delta` enabled rows from `index` (`wrap`: past an edge to the other end); `index` when nothing moves. */
export function menuMove(
	total: number,
	index: number,
	delta: number,
	disabled: (index: number) => boolean,
	wrap = false,
): number {
	if (total === 0 || delta === 0) return index;
	const direction = delta < 0 ? -1 : 1;
	let remaining = Math.max(1, Math.abs(Math.trunc(delta)));
	let at = index;
	for (let attempts = 0; attempts < total && remaining > 0; attempts++) {
		let next = at + direction;
		if (next < 0 || next >= total) {
			if (!wrap) break;
			next = direction > 0 ? 0 : total - 1;
		}
		if (next === at) break;
		at = next;
		if (!disabled(at)) remaining--;
	}
	return at === index ? index : menuCoerce(total, at, direction, disabled);
}

/** `index` clamped into the list and moved to the nearest enabled row (`direction` first); -1 for an empty list. */
export function menuCoerce(
	total: number,
	index: number,
	direction: -1 | 1,
	disabled: (index: number) => boolean,
): number {
	if (total === 0) return -1;
	const clamped = Math.max(0, Math.min(Math.trunc(index), total - 1));
	if (!disabled(clamped)) return clamped;
	for (let next = clamped + direction; next >= 0 && next < total; next += direction) if (!disabled(next)) return next;
	for (let next = clamped - direction; next >= 0 && next < total; next -= direction) if (!disabled(next)) return next;
	return clamped;
}
