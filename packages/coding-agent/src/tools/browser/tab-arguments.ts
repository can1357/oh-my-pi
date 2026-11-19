import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** `tab.press(key, {selector})`; a `press(selector, key)` call (a string second argument) means the same. */
export function pressArgs<S>(
	key: string,
	options?: { selector?: S } | string,
): { key: string; opts?: { selector?: S } } {
	if (typeof options === "string") return { key: options, opts: { selector: key as S } };
	return { key, opts: options };
}

/**
 * An element lookup that can be used before it settles: every method call waits for the handle, then calls it, so
 * `tab.id(n).click()` works inside `tab.run` the way it does in the cell, and `(await tab.id(n)).click()` still does.
 */
export type PendingElement<T extends object> = Promise<T> & {
	[K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

/** Wrap a pending element lookup as a {@link PendingElement}. */
export function pendingElement<T extends object>(pending: Promise<T>): PendingElement<T> {
	// A rejection surfaces where the caller awaits a method or the lookup; an unused lookup must not crash the run.
	pending.catch(() => undefined);
	return new Proxy(pending, {
		get(target, property) {
			if (property === "then" || property === "catch" || property === "finally") {
				const method = Reflect.get(target, property) as (...args: unknown[]) => unknown;
				return method.bind(target);
			}
			if (typeof property === "symbol") return Reflect.get(target, property);
			return async (...args: unknown[]) => {
				const handle = (await target) as Record<string, unknown>;
				const method = handle[property];
				if (typeof method !== "function") throw new ToolError(`element.${property} is not a function`);
				return await method.apply(handle, args);
			};
		},
	}) as PendingElement<T>;
}

/** Whether `value` is a plain options object (`{…}` or a Python kwargs dict), not a selector or handle. */
function isPlainOptions(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Split the arguments of a helper whose selector is optional (`ariaSnapshot(selector?, opts?)`): a plain object in
 * the selector position is the options, as Python keyword arguments and `ariaSnapshot({compact: true})` pass it.
 */
export function optionalSelectorArgs<O extends object>(
	selector: unknown,
	opts: O | undefined,
): { selector: unknown; opts: O | undefined } {
	if (opts === undefined && isPlainOptions(selector)) return { selector: undefined, opts: selector as O };
	return { selector, opts };
}

/**
 * The wheel deltas of `scroll(dx, dy)`/`wheel(dx, dy)` as numbers. An object first argument (`scroll({y: 500})`,
 * `{deltaX, deltaY}`) gives its deltas.
 */
export function scrollDeltas(label: string, deltaX: unknown, deltaY: unknown): { deltaX: number; deltaY: number } {
	if (isPlainOptions(deltaX)) {
		const x = deltaX.deltaX ?? deltaX.x ?? 0;
		const y = deltaX.deltaY ?? deltaX.y ?? 0;
		return scrollDeltas(label, x, y);
	}
	const x = deltaX ?? 0;
	const y = deltaY ?? 0;
	if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
		throw new ToolError(
			`${label} takes pixel deltas as numbers: (dx, dy) or ({x, y}); got (${String(deltaX)}, ${String(deltaY)})`,
		);
	}
	return { deltaX: x, deltaY: y };
}
