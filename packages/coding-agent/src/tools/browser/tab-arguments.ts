import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

export function assertTabPressArgs(key: unknown, options?: unknown): void {
	if (typeof options === "string") {
		throw new ToolError(
			`tab.press() takes (key, options) but was called as (selector, key). ` +
				`Did you mean tab.press(${JSON.stringify(options)}, { selector: ${JSON.stringify(key)} })?`,
		);
	}
}

/** Unit `(dx, dy)` per `{ direction }` an agent may pass in place of the deltas. */
const SCROLL_DIRECTIONS: Record<string, readonly [number, number]> = {
	up: [0, -1],
	down: [0, 1],
	left: [-1, 0],
	right: [1, 0],
};

function formatScrollArg(value: unknown): string {
	if (typeof value === "number" || typeof value === "bigint" || value === undefined) return String(value);
	return JSON.stringify(value) ?? String(value);
}

/** The positional call matching a `{ direction, amount, selector? }` object, when it names one. */
function scrollObjectHint(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { direction, amount, selector } = value as { direction?: unknown; amount?: unknown; selector?: unknown };
	const unit = typeof direction === "string" ? SCROLL_DIRECTIONS[direction.toLowerCase()] : undefined;
	if (!unit || typeof amount !== "number" || !Number.isFinite(amount)) return undefined;
	const [dx, dy] = unit.map(sign => sign * amount);
	const options = typeof selector === "string" ? `, { selector: ${JSON.stringify(selector)} }` : "";
	return `tab.scroll(${dx}, ${dy}${options})`;
}

/**
 * Reject `tab.scroll()` deltas that are not finite numbers before they reach the backend, where
 * CDP fails with an opaque deserialization error and other backends forward the bad value.
 */
export function assertTabScrollArgs(dx: unknown, dy: unknown, options?: unknown): void {
	if (Number.isFinite(dx) && Number.isFinite(dy)) return;
	const shown = [dx, dy, options];
	while (shown.length > 0 && shown.at(-1) === undefined) shown.pop();
	const hint = scrollObjectHint(dx);
	throw new ToolError(
		`tab.scroll() takes finite pixel deltas (dx, dy, { selector? }) but was called as ` +
			`tab.scroll(${shown.map(formatScrollArg).join(", ")}).${hint ? ` Did you mean ${hint}?` : ""}`,
	);
}
