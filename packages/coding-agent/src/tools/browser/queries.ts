import { untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ElementHandle, Frame, Page } from "puppeteer-core";
import { isNavigatedContextError } from "./navigation";

/** Default computed-style properties returned by `tab.styles()`. */
export const DEFAULT_STYLE_PROPERTIES = [
	"font-family",
	"font-size",
	"font-weight",
	"color",
	"background-color",
	"display",
	"visibility",
	"opacity",
	"position",
	"z-index",
	"width",
	"height",
	"margin",
	"padding",
] as const;

/** JSON-safe element bounds in page coordinates. */
export interface QueryBox {
	/** Left edge in CSS pixels. */
	x: number;
	/** Top edge in CSS pixels. */
	y: number;
	/** Element width in CSS pixels. */
	width: number;
	/** Element height in CSS pixels. */
	height: number;
}

/** Read-only helpers attached to browser element handles. */
export interface ElementQueryHelpers {
	/** Return this element's rendered text. */
	text(): Promise<string>;
	/** Return this element's inner HTML. */
	html(): Promise<string>;
	/** Return this form element's current value, or `null` when unsupported. */
	value(): Promise<string | null>;
	/** Return one attribute value, or `null` when absent. */
	attr(name: string): Promise<string | null>;
	/** Return selected computed styles. */
	styles(props?: string[]): Promise<Record<string, string>>;
	/** Report whether this element is enabled. */
	isEnabled(): Promise<boolean>;
	/** Report whether this element is checked. */
	isChecked(): Promise<boolean>;
}

/** Per-operation guard used to keep element query helpers abort-aware. */
export type ElementQueryGuard = <T>(label: string, fn: (signal: AbortSignal) => Promise<T>) => Promise<T>;

async function firstHandle(page: Page, selector: string, signal: AbortSignal): Promise<ElementHandle | null> {
	return (await untilAborted(signal, () => page.$(selector))) as ElementHandle | null;
}

/** Return the first matching element's rendered text, or `null`. */
export async function queryText(page: Page, selector: string, signal: AbortSignal): Promise<string | null> {
	const handle = await firstHandle(page, selector, signal);
	if (!handle) return null;
	try {
		return (await untilAborted(signal, () =>
			handle.evaluate(element =>
				((element as unknown as { innerText?: string }).innerText ?? element.textContent ?? "").trim(),
			),
		)) as string;
	} finally {
		await handle.dispose().catch(() => undefined);
	}
}

/** Return the first matching element's inner HTML, or `null`. */
export async function queryHtml(page: Page, selector: string, signal: AbortSignal): Promise<string | null> {
	const handle = await firstHandle(page, selector, signal);
	if (!handle) return null;
	try {
		return (await untilAborted(signal, () => handle.evaluate(element => element.innerHTML))) as string;
	} finally {
		await handle.dispose().catch(() => undefined);
	}
}

/** Return the first matching form element's current value, or `null`. */
export async function queryValue(page: Page, selector: string, signal: AbortSignal): Promise<string | null> {
	const handle = await firstHandle(page, selector, signal);
	if (!handle) return null;
	try {
		return (await untilAborted(signal, () =>
			handle.evaluate(element => {
				const candidate = element as Element & { value?: unknown };
				return "value" in candidate && candidate.value != null ? String(candidate.value) : null;
			}),
		)) as string | null;
	} finally {
		await handle.dispose().catch(() => undefined);
	}
}

/** Return an attribute from the first matching element, or `null`. */
export async function queryAttribute(
	page: Page,
	selector: string,
	name: string,
	signal: AbortSignal,
): Promise<string | null> {
	const handle = await firstHandle(page, selector, signal);
	if (!handle) return null;
	try {
		return (await untilAborted(signal, () =>
			handle.evaluate((element, attribute) => element.getAttribute(attribute), name),
		)) as string | null;
	} finally {
		await handle.dispose().catch(() => undefined);
	}
}

/** Count elements matching a selector. */
export async function queryCount(page: Page, selector: string, signal: AbortSignal): Promise<number> {
	const handles = (await untilAborted(signal, () => page.$$(selector))) as ElementHandle[];
	try {
		return handles.length;
	} finally {
		await Promise.all(handles.map(async handle => handle.dispose().catch(() => undefined)));
	}
}

/** Return the first matching element's bounds, or `null`. */
export async function queryBox(page: Page, selector: string, signal: AbortSignal): Promise<QueryBox | null> {
	const handle = await firstHandle(page, selector, signal);
	if (!handle) return null;
	try {
		return (await untilAborted(signal, () => handle.boundingBox())) as QueryBox | null;
	} finally {
		await handle.dispose().catch(() => undefined);
	}
}

/** Return computed styles for the first matching element, or `null`. */
export async function queryStyles(
	page: Page,
	selector: string,
	props: string[] | undefined,
	signal: AbortSignal,
): Promise<Record<string, string> | null> {
	const handle = await firstHandle(page, selector, signal);
	if (!handle) return null;
	try {
		return (await untilAborted(signal, () =>
			handle.evaluate(
				(element, properties) => {
					const computed = getComputedStyle(element) as unknown as {
						getPropertyValue(property: string): string;
					};
					return Object.fromEntries(properties.map(property => [property, computed.getPropertyValue(property)]));
				},
				props ?? [...DEFAULT_STYLE_PROPERTIES],
			),
		)) as Record<string, string>;
	} finally {
		await handle.dispose().catch(() => undefined);
	}
}

/** Report whether the first matching element is visible. */
export async function queryVisible(page: Page, selector: string, signal: AbortSignal): Promise<boolean> {
	const handle = await firstHandle(page, selector, signal);
	if (!handle) return false;
	try {
		return await untilAborted(signal, () => handle.isVisible());
	} finally {
		await handle.dispose().catch(() => undefined);
	}
}

/** Report whether the first matching element is enabled. */
export async function queryEnabled(page: Page, selector: string, signal: AbortSignal): Promise<boolean> {
	const handle = await firstHandle(page, selector, signal);
	if (!handle) return false;
	try {
		return (await untilAborted(signal, () =>
			handle.evaluate(element => !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true"),
		)) as boolean;
	} finally {
		await handle.dispose().catch(() => undefined);
	}
}

/** Report whether the first matching element is checked. */
export async function queryChecked(page: Page, selector: string, signal: AbortSignal): Promise<boolean> {
	const handle = await firstHandle(page, selector, signal);
	if (!handle) return false;
	try {
		return (await untilAborted(signal, () =>
			handle.evaluate(element => {
				const candidate = element as Element & { checked?: unknown };
				return typeof candidate.checked === "boolean"
					? candidate.checked
					: element.getAttribute("aria-checked") === "true";
			}),
		)) as boolean;
	} finally {
		await handle.dispose().catch(() => undefined);
	}
}

/** Attach browser-tool query methods to a Puppeteer element handle. */
export function enrichElementQueries<T extends ElementHandle>(
	handle: T,
	guard: ElementQueryGuard,
): T & ElementQueryHelpers {
	const enriched = handle as T & ElementQueryHelpers;
	enriched.text = () =>
		guard("handle.text()", signal =>
			untilAborted(signal, () =>
				handle.evaluate(element =>
					((element as unknown as { innerText?: string }).innerText ?? element.textContent ?? "").trim(),
				),
			),
		) as Promise<string>;
	enriched.html = () =>
		guard("handle.html()", signal =>
			untilAborted(signal, () => handle.evaluate(element => element.innerHTML)),
		) as Promise<string>;
	enriched.value = () =>
		guard("handle.value()", signal =>
			untilAborted(signal, () =>
				handle.evaluate(element => {
					const candidate = element as Element & { value?: unknown };
					return "value" in candidate && candidate.value != null ? String(candidate.value) : null;
				}),
			),
		) as Promise<string | null>;
	enriched.attr = name =>
		guard("handle.attr()", signal =>
			untilAborted(signal, () => handle.evaluate((element, attribute) => element.getAttribute(attribute), name)),
		) as Promise<string | null>;
	enriched.styles = props =>
		guard("handle.styles()", signal =>
			untilAborted(signal, () =>
				handle.evaluate(
					(element, properties) => {
						const computed = getComputedStyle(element) as unknown as {
							getPropertyValue(property: string): string;
						};
						return Object.fromEntries(
							properties.map(property => [property, computed.getPropertyValue(property)]),
						);
					},
					props ?? [...DEFAULT_STYLE_PROPERTIES],
				),
			),
		) as Promise<Record<string, string>>;
	enriched.isEnabled = () =>
		guard("handle.isEnabled()", signal =>
			untilAborted(signal, () =>
				handle.evaluate(
					element => !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true",
				),
			),
		) as Promise<boolean>;
	enriched.isChecked = () =>
		guard("handle.isChecked()", signal =>
			untilAborted(signal, () =>
				handle.evaluate(element => {
					const candidate = element as Element & { checked?: unknown };
					return typeof candidate.checked === "boolean"
						? candidate.checked
						: element.getAttribute("aria-checked") === "true";
				}),
			),
		) as Promise<boolean>;
	return enriched;
}

/**
 * Call `check` every `interval` ms until it answers, and resolve with its answer; `undefined` means "not yet".
 * A check the page's navigation interrupts counts as "not yet": the condition may hold on the page coming in.
 */
async function pollPage<T>(
	check: () => Promise<T | undefined>,
	opts: { timeout: number; interval: number; signal: AbortSignal },
	timeoutMessage: string,
): Promise<T> {
	const deadline = Date.now() + opts.timeout;
	while (Date.now() <= deadline) {
		let answer: T | undefined;
		try {
			answer = await check();
		} catch (error) {
			if (opts.signal.aborted || !isNavigatedContextError(error)) throw error;
			answer = undefined;
		}
		if (answer !== undefined) return answer;
		await untilAborted(opts.signal, () => Bun.sleep(Math.min(opts.interval, Math.max(1, deadline - Date.now()))));
	}
	throw new ToolError(timeoutMessage);
}

/** Wait until text appears in the document body or a scoped element. */
export async function waitForPageText(
	page: Page,
	text: string,
	opts: { timeout: number; selector?: string; exact?: boolean; signal: AbortSignal },
): Promise<void> {
	await pollPage(
		async () => {
			const content = opts.selector
				? await queryText(page, opts.selector, opts.signal)
				: ((await untilAborted(opts.signal, () =>
						page.evaluate(() => {
							const pageGlobal = globalThis as unknown as {
								document: { body?: { innerText?: string } };
							};
							return pageGlobal.document.body?.innerText ?? "";
						}),
					)) as string);
			if (content === null) return undefined;
			const candidate = content.trim();
			return (opts.exact ? candidate === text : candidate.includes(text)) ? true : undefined;
		},
		{ timeout: opts.timeout, interval: 100, signal: opts.signal },
		`tab.waitForText(${JSON.stringify(text)}) timed out after ${opts.timeout}ms`,
	);
}

/** Options for {@link waitForPagePredicate}. */
export interface PagePredicateWaitOptions {
	/** Give up after this many ms. */
	timeout: number;
	/** Poll interval in ms (default 100, floor 10). */
	polling?: number;
	/** JSON values passed to a function predicate. */
	args?: unknown[];
	signal: AbortSignal;
}

/** Whether a source string is a function (`function …`, `async (…) => …`, `x => …`) rather than an expression. */
export function isFunctionSource(source: string): boolean {
	return /^\s*(?:async\b\s*)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(source);
}

/**
 * Poll a page-world predicate in `frame`'s main world, where the page's own globals live (the world
 * `tab.evaluate` uses), until it returns a truthy value, and resolve with that value. A function, or a string
 * holding one, is called with `args`; any other string is an expression. Truthiness is decided in the page, so
 * a truthy value that cannot be copied out (a node, a function, a cyclic object) resolves the wait with `true`.
 * Polls on a timer rather than animation frames, which a background tab does not run.
 */
export async function waitForPagePredicate(
	frame: Frame,
	label: string,
	predicate: unknown,
	opts: PagePredicateWaitOptions,
): Promise<unknown> {
	if (typeof predicate !== "string" && typeof predicate !== "function") {
		throw new ToolError(`${label} expects a function or an expression string; got ${typeof predicate}`);
	}
	const source = String(predicate);
	const call =
		typeof predicate === "function" || isFunctionSource(source)
			? `(${source}\n)(...${JSON.stringify(opts.args ?? [])})`
			: `(${source}\n)`;
	const script = `(async () => {
	const value = await ${call};
	if (!value) return { held: false };
	if (typeof value !== "object" && typeof value !== "function") return { held: true, value };
	if (typeof Node === "function" && value instanceof Node) return { held: true, value: true };
	try {
		const json = JSON.stringify(value);
		return { held: true, value: json === undefined ? true : JSON.parse(json) };
	} catch {
		return { held: true, value: true };
	}
})()`;
	return await pollPage(
		async () => {
			let answer: { held: boolean; value?: unknown };
			try {
				answer = (await untilAborted(opts.signal, () => frame.mainRealm().evaluate(script))) as typeof answer;
			} catch (error) {
				if (opts.signal.aborted || isNavigatedContextError(error) || error instanceof ToolError) throw error;
				throw new ToolError(`${label} threw a JavaScript exception:\n${(error as Error).message ?? String(error)}`);
			}
			return answer?.held ? answer.value : undefined;
		},
		{ timeout: opts.timeout, interval: Math.max(10, opts.polling ?? 100), signal: opts.signal },
		`${label} timed out after ${opts.timeout}ms`,
	);
}
