import { untilAborted } from "@oh-my-pi/pi-utils";
import type { ElementHandle, ElementScreenshotOptions, Frame, Page } from "puppeteer-core";
import { throwIfAborted } from "../tool-errors";
import { markHandled } from "../run-scope";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	type AriaSnapshotOptions,
	assertSelectorString,
	assertWaitSelector,
	captureAriaSnapshot,
	parseAriaRefSelector,
	resolveAriaRefHandle,
} from "./aria/aria-snapshot";
import {
	clickElement,
	fillViaHandle,
	focusKeyTarget,
	pressKey,
	typeIntoElement,
	withLiveElement,
} from "./interactions";
import { readPageViewport } from "./launch";
import { waitForPagePredicate } from "./queries";
import { emitScreenshot, type ScreenshotRun, whileDrawing } from "./screenshot";
import { optionalSelectorArgs, pressArgs } from "./tab-arguments";
import { selectorWaitOptions, type SelectorWaitOptions, waitForDetached, waitForSelectorHandle } from "./selector-wait";

/** JSON-safe metadata for one document frame. */
export interface BrowserFrameInfo {
	/** DevTools frame identifier. */
	id: string;
	/** Frame name or element id. */
	name: string;
	/** Current frame URL. */
	url: string;
	/** Parent frame identifier, or null for the main frame. */
	parentId: string | null;
	/** Best-effort selector for the owning frame element. */
	selector?: string;
}

/** Options accepted by frame-scoped keyboard input. */
export interface FramePressOptions {
	/** Focus this selector before pressing the key. */
	selector?: string;
}

/** Options accepted by frame-scoped selector waits. */
export type FrameWaitOptions = SelectorWaitOptions;

/** A frame-scoped helper object exposed by `tab.frame()`. */
export interface BrowserFrameApi {
	/** Click a matching element in this frame, optionally with another button or click count. */
	click(
		selector: string,
		options?: { button?: "left" | "right" | "middle" | "back" | "forward"; count?: number },
	): Promise<void>;
	/** Replace a matching form control's value. */
	fill(selector: string, value: string): Promise<void>;
	/** Type text into a matching element. */
	type(selector: string, text: string): Promise<void>;
	/** Press a keyboard key, optionally after focusing an element. */
	press(key: string, options?: FramePressOptions | string): Promise<void>;
	/** Return a matching element's text content; without a selector, the frame's `<body>`. */
	text(selector?: string): Promise<string>;
	/** Return a matching element's inner HTML; without a selector, the frame's `<body>`. */
	html(selector?: string): Promise<string>;
	/** Return a matching form control's value. */
	value(selector: string): Promise<string>;
	/** Return a matching element attribute. */
	attr(selector: string, name: string): Promise<string | null>;
	/** Count matching elements. */
	count(selector: string): Promise<number>;
	/** Report whether a matching element is visible. */
	isVisible(selector: string): Promise<boolean>;
	/** Capture a Playwright-format ARIA snapshot inside this frame. */
	ariaSnapshot(selector?: string | AriaSnapshotOptions, options?: AriaSnapshotOptions): Promise<string>;
	/** Evaluate a function or expression in this frame. */
	evaluate<R, TArgs extends unknown[]>(fn: string | ((...args: TArgs) => R | Promise<R>), ...args: TArgs): Promise<R>;
	/** Wait for a selector and report whether it appeared. */
	waitFor(selector: string, options?: FrameWaitOptions): Promise<boolean>;
	/** Wait for a selector and report whether it appeared. */
	waitForSelector(selector: string, options?: FrameWaitOptions): Promise<boolean>;
	/** Wait until a function (called with `args`) or expression in this frame is truthy, and resolve with its value. */
	waitForFunction(
		predicate: string | ((...args: unknown[]) => unknown),
		options?: { timeout?: number; polling?: number },
		...args: unknown[]
	): Promise<unknown>;
	/** Capture a matching element inside this frame; without a selector, the whole frame. */
	screenshot(selector?: string): Promise<string>;
}

/** Per-operation guard supplied by the tab worker. */
export type FrameOperation = <T>(
	label: string,
	deadlineMs: number,
	operation: (signal: AbortSignal) => Promise<T>,
	selectorOptions?: { selector?: string; zeroMatchAfterMs?: number },
) => Promise<T>;

/** Worker hooks needed to build a frame-scoped helper without coupling it to WorkerCore. */
export interface FrameApiHooks {
	/** Quick read deadline. */
	quickOpMs: number;
	/** Interactive action deadline. */
	actionOpMs: number;
	/** Zero-match fast-fail deadline. */
	zeroMatchAfterMs: number;
	/** Normalize a public selector for Puppeteer. */
	normalizeSelector(selector: string): string;
	/** Resolve an explicit wait timeout against the active cell budget. */
	waitMs(timeout?: number): number;
	/** Run a named, abort-aware operation. */
	op: FrameOperation;
	/** Run an input action like {@link op}, so the tab's next look waits for its effects. */
	act: FrameOperation;
	/** Persist and report a frame element screenshot. */
	captureScreenshot(frame: Frame, selector: string | undefined, signal: AbortSignal): Promise<string>;
}

/** A frame's DevTools identifier, the id CDP events name it by. */
export function devtoolsFrameId(frame: Frame): string {
	// Puppeteer keeps the DevTools id on an internal field its public types omit.
	const internal = frame as unknown as { _id: string };
	return internal._id;
}

/** List the page's current main and child frames with stable DevTools identifiers. */
export async function listFrames(page: Page, signal?: AbortSignal): Promise<BrowserFrameInfo[]> {
	const result: BrowserFrameInfo[] = [];
	for (const frame of page.frames()) {
		const parent = frame.parentFrame();
		const info: BrowserFrameInfo = {
			id: devtoolsFrameId(frame),
			name: frame.name(),
			url: frame.url(),
			parentId: parent ? devtoolsFrameId(parent) : null,
		};
		if (parent) {
			let element: ElementHandle | null = null;
			try {
				element = await untilAborted(signal, () => frame.frameElement());
				const attributes = await untilAborted(signal, () =>
					element!.evaluate(node => {
						const frameElement = node as unknown as {
							localName: string;
							getAttribute(name: string): string | null;
						};
						return {
							tag: frameElement.localName,
							id: frameElement.getAttribute("id"),
							name: frameElement.getAttribute("name"),
						};
					}),
				);
				if (attributes.id) info.selector = `${attributes.tag}[id=${JSON.stringify(attributes.id)}]`;
				else if (attributes.name) info.selector = `${attributes.tag}[name=${JSON.stringify(attributes.name)}]`;
			} catch {
				// Detached or cross-process frame elements may disappear while enumerating.
			} finally {
				await element?.dispose().catch(() => undefined);
			}
		}
		result.push(info);
	}
	return result;
}

/** Resolve a frame by owning-element selector, frame name, or exact frame URL. */
export async function resolveFrame(
	page: Page,
	selectorOrNameOrUrl: string,
	normalizeSelector: (selector: string) => string,
	signal?: AbortSignal,
): Promise<Frame> {
	let element: ElementHandle | null = null;
	try {
		const selector = normalizeSelector(selectorOrNameOrUrl);
		element = await untilAborted(signal, () => page.$(selector));
		if (element) {
			const frame = await untilAborted(signal, () => element!.contentFrame());
			if (!frame)
				throw new ToolError(`tab.frame(${JSON.stringify(selectorOrNameOrUrl)}) matched an element without a frame`);
			return frame;
		}
	} catch (error) {
		throwIfAborted(signal);
		if (element) throw error;
		// URL-like and name strings are often not valid CSS selectors; match them below.
	} finally {
		await element?.dispose().catch(() => undefined);
	}
	const frame = page
		.frames()
		.find(candidate => candidate.name() === selectorOrNameOrUrl || candidate.url() === selectorOrNameOrUrl);
	if (!frame) throw new ToolError(`tab.frame(${JSON.stringify(selectorOrNameOrUrl)}) found no matching frame`);
	return frame;
}

/** Build the scoped operations for one already-resolved Puppeteer frame. */
export function createFrameApi(frame: Frame, hooks: FrameApiHooks): BrowserFrameApi {
	const selectorOptions = (selector: string): { selector: string; zeroMatchAfterMs: number } => ({
		selector,
		zeroMatchAfterMs: hooks.zeroMatchAfterMs,
	});
	const waitForSelector = (selector: string, options?: FrameWaitOptions): Promise<boolean> => {
		try {
			assertWaitSelector("frame.waitForSelector", selector);
			options = selectorWaitOptions(options);
		} catch (error) {
			return markHandled(Promise.reject(error));
		}
		const deadline = hooks.waitMs(options?.timeout);
		return hooks.op(
			`frame.waitForSelector(${JSON.stringify(selector)})`,
			deadline,
			async signal => {
				const ref = parseAriaRefSelector(selector);
				if (ref !== null) {
					const handle = await waitForSelectorHandle(() => resolveAriaRefHandle(frame, ref), options, signal);
					await handle?.dispose().catch(() => undefined);
					return true;
				}
				if (options?.state === "detached") {
					const normalized = hooks.normalizeSelector(selector);
					await waitForDetached(() => frame.$(normalized), signal);
					return true;
				}
				const handle = await untilAborted(signal, () =>
					frame.waitForSelector(hooks.normalizeSelector(selector), {
						timeout: deadline,
						visible: options?.visible,
						hidden: options?.hidden,
						signal,
					}),
				);
				await handle?.dispose().catch(() => undefined);
				return true;
			},
			{
				selector,
				zeroMatchAfterMs:
					options?.timeout === undefined && !options?.hidden && options?.state !== "detached"
						? hooks.zeroMatchAfterMs
						: undefined,
			},
		);
	};
	/**
	 * Wait for an actionable match without Puppeteer's `Locator` preconditions:
	 * those wait on animation-frame and IntersectionObserver callbacks a
	 * backgrounded headless tab never delivers (#12892).
	 */
	const actionHandle = async (label: string, selector: string, signal: AbortSignal): Promise<ElementHandle> => {
		const handle = await untilAborted(signal, () =>
			frame.waitForSelector(hooks.normalizeSelector(selector), {
				timeout: hooks.actionOpMs,
				visible: true,
				signal,
			}),
		);
		if (!handle) throw new ToolError(`${label} matched no visible element`);
		return handle;
	};
	return {
		click: (selector, options) =>
			hooks.act(
				`frame.click(${JSON.stringify(selector)})`,
				hooks.actionOpMs,
				async signal => {
					const label = `frame.click(${JSON.stringify(selector)})`;
					await withLiveElement(
						() => actionHandle(label, selector, signal),
						async handle => {
							try {
								await clickElement(handle, label, signal, {
									button: options?.button,
									count: options?.count,
								});
							} finally {
								await handle.dispose().catch(() => undefined);
							}
						},
						signal,
					);
				},
				selectorOptions(selector),
			),
		fill: (selector, value) =>
			hooks.act(
				`frame.fill(${JSON.stringify(selector)})`,
				hooks.actionOpMs,
				async signal => {
					const handle = await actionHandle(`frame.fill(${JSON.stringify(selector)})`, selector, signal);
					try {
						await fillViaHandle(handle, value, `frame.fill(${JSON.stringify(selector)})`, signal);
					} finally {
						await handle.dispose().catch(() => undefined);
					}
				},
				selectorOptions(selector),
			),
		type: (selector, text) =>
			hooks.act(
				`frame.type(${JSON.stringify(selector)})`,
				hooks.actionOpMs,
				async signal => {
					const handle = await untilAborted(signal, () => frame.$(hooks.normalizeSelector(selector)));
					if (!handle) throw new ToolError(`frame.type(${JSON.stringify(selector)}) matched no element`);
					try {
						await typeIntoElement(handle, text, `frame.type(${JSON.stringify(selector)})`, signal);
					} finally {
						await handle.dispose().catch(() => undefined);
					}
				},
				selectorOptions(selector),
			),
		press: (keyArg, optionsArg) => {
			const { key, opts: options } = pressArgs(keyArg, optionsArg);
			return hooks.act(`frame.press(${JSON.stringify(key)})`, hooks.actionOpMs, async signal => {
				if (options?.selector) {
					const selector = hooks.normalizeSelector(options.selector);
					const handle = await untilAborted(signal, () => frame.$(selector));
					if (!handle) throw new ToolError(`No element found for selector: ${selector}`);
					try {
						await focusKeyTarget(
							handle,
							`frame.press(${JSON.stringify(key)}, { selector: ${JSON.stringify(options.selector)} })`,
							signal,
						);
					} finally {
						await handle.dispose().catch(() => undefined);
					}
				}
				await pressKey(frame.page(), key, undefined, signal);
			});
		},
		// Without a selector, the frame's `<body>`; any value passed, `null` included, is still checked as a selector.
		text: (selector = "body") =>
			hooks.op(
				`frame.text(${JSON.stringify(selector)})`,
				hooks.quickOpMs,
				signal =>
					untilAborted(signal, () =>
						frame.$eval(hooks.normalizeSelector(selector), element => {
							const rendered = "innerText" in element ? element.innerText : undefined;
							return (typeof rendered === "string" ? rendered : (element.textContent ?? "")).trim();
						}),
					),
				selectorOptions(selector),
			),
		html: (selector = "body") =>
			hooks.op(
				`frame.html(${JSON.stringify(selector)})`,
				hooks.quickOpMs,
				signal =>
					untilAborted(signal, () => frame.$eval(hooks.normalizeSelector(selector), element => element.innerHTML)),
				selectorOptions(selector),
			),
		value: selector =>
			hooks.op(
				`frame.value(${JSON.stringify(selector)})`,
				hooks.quickOpMs,
				signal =>
					untilAborted(signal, () =>
						frame.$eval(hooks.normalizeSelector(selector), element => {
							const control = element as unknown as { value: string };
							return control.value;
						}),
					),
				selectorOptions(selector),
			),
		attr: (selector, name) =>
			hooks.op(
				`frame.attr(${JSON.stringify(selector)}, ${JSON.stringify(name)})`,
				hooks.quickOpMs,
				signal =>
					untilAborted(signal, () =>
						frame.$eval(
							hooks.normalizeSelector(selector),
							(element, attribute) => element.getAttribute(attribute),
							name,
						),
					),
				selectorOptions(selector),
			),
		count: selector =>
			hooks.op(`frame.count(${JSON.stringify(selector)})`, hooks.quickOpMs, signal =>
				untilAborted(signal, () => frame.$$eval(hooks.normalizeSelector(selector), elements => elements.length)),
			),
		isVisible: selector =>
			hooks.op(`frame.isVisible(${JSON.stringify(selector)})`, hooks.quickOpMs, async signal => {
				const handle = await untilAborted(signal, () => frame.$(hooks.normalizeSelector(selector)));
				if (!handle) return false;
				try {
					return await untilAborted(signal, () => handle.isVisible());
				} finally {
					await handle.dispose().catch(() => undefined);
				}
			}),
		ariaSnapshot: (selectorArg, optionsArg) => {
			const { selector, opts: options } = optionalSelectorArgs(selectorArg, optionsArg);
			if (selector !== undefined) assertSelectorString(selector);
			return hooks.op("frame.ariaSnapshot()", hooks.quickOpMs, async signal => {
				const root = selector ? await untilAborted(signal, () => frame.$(hooks.normalizeSelector(selector))) : null;
				try {
					if (selector && !root)
						throw new ToolError(`frame.ariaSnapshot: selector ${selector} matched no element`);
					return await untilAborted(signal, () => captureAriaSnapshot(frame, root, options));
				} finally {
					await root?.dispose().catch(() => undefined);
				}
			});
		},
		evaluate: ((fn: string | ((...args: unknown[]) => unknown), ...args: unknown[]) =>
			hooks.op("frame.evaluate()", Number.POSITIVE_INFINITY, signal =>
				untilAborted(signal, () => frame.evaluate(fn as never, ...args)),
			)) as BrowserFrameApi["evaluate"],
		waitFor: (selector, options) => {
			try {
				assertWaitSelector("frame.waitFor", selector);
			} catch (error) {
				return markHandled(Promise.reject(error));
			}
			return waitForSelector(selector, options);
		},
		waitForSelector,
		waitForFunction: (predicate, options, ...args) => {
			const deadline = hooks.waitMs(options?.timeout);
			return hooks.op("frame.waitForFunction()", deadline, signal =>
				waitForPagePredicate(frame, "frame.waitForFunction()", predicate, {
					timeout: deadline,
					polling: options?.polling,
					args,
					signal,
				}),
			);
		},
		screenshot: selector =>
			hooks.op(
				selector === undefined ? "frame.screenshot()" : `frame.screenshot(${JSON.stringify(selector)})`,
				hooks.quickOpMs,
				signal => hooks.captureScreenshot(frame, selector, signal),
				selector === undefined ? undefined : selectorOptions(selector),
			),
	};
}

/**
 * Persist a frame-scoped element screenshot and emit the normal Eval image output. Without a selector the frame's
 * own `<iframe>` element is captured, which shows the whole frame.
 */
export async function captureFrameScreenshot(
	frame: Frame,
	selector: string | undefined,
	signal: AbortSignal,
	normalizeSelector: (selector: string) => string,
	run: ScreenshotRun,
): Promise<string> {
	const handle =
		selector === undefined
			? await untilAborted(signal, () => frame.frameElement())
			: await untilAborted(signal, () => frame.$(normalizeSelector(selector)));
	if (!handle) {
		throw new ToolError(
			selector === undefined
				? "frame.screenshot(): the main frame has no frame element; use tab.screenshot()"
				: `frame.screenshot(${JSON.stringify(selector)}) matched no element`,
		);
	}
	let buffer: Buffer;
	let captureScale: number;
	try {
		await untilAborted(signal, () =>
			handle.evaluate(element => {
				const target = element as unknown as {
					scrollIntoView(options: { behavior: string; block: string; inline: string }): void;
				};
				target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
			}),
		).catch(() => undefined);
		captureScale = (await readPageViewport(frame.page(), signal)).deviceScaleFactor ?? 1;
		const screenshotOptions: ElementScreenshotOptions = { type: "png", scrollIntoView: false };
		buffer = (await whileDrawing(frame.page(), signal, () =>
			untilAborted(signal, () => handle.screenshot(screenshotOptions)),
		)) as Buffer;
	} finally {
		await handle.dispose().catch(() => undefined);
	}
	return await emitScreenshot(
		{ bytes: buffer, mimeType: "image/png", area: "element", scale: captureScale, inFrame: true },
		run,
		signal,
	);
}
