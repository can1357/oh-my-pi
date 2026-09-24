import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Snowflake, untilAborted } from "@oh-my-pi/pi-utils";
import type { ElementHandle, ElementScreenshotOptions, Frame, KeyInput, Page } from "puppeteer-core";
import { formatScreenshot, resizeImage } from "../../utils/image-resize";
import { throwIfAborted } from "../tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { type AriaSnapshotOptions, buildAriaSnapshotScript } from "./aria/aria-snapshot";
import { clickElement, fillViaHandle } from "./interactions";
import { RunOutput } from "./run-output";
import type { ScreenshotResult, SessionSnapshot } from "./tab-protocol";

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
export interface FrameWaitOptions {
	/** Maximum wait in milliseconds. */
	timeout?: number;
	/** Require a visible matching element. */
	visible?: boolean;
	/** Require the matching element to become hidden. */
	hidden?: boolean;
}

/** A frame-scoped helper object exposed by `tab.frame()`. */
export interface BrowserFrameApi {
	/** Click a matching element in this frame. */
	click(selector: string): Promise<void>;
	/** Replace a matching form control's value. */
	fill(selector: string, value: string): Promise<void>;
	/** Type text into a matching element. */
	type(selector: string, text: string): Promise<void>;
	/** Press a keyboard key, optionally after focusing an element. */
	press(key: KeyInput, options?: FramePressOptions): Promise<void>;
	/** Return a matching element's text content. */
	text(selector: string): Promise<string>;
	/** Return a matching element's inner HTML. */
	html(selector: string): Promise<string>;
	/** Return a matching form control's value. */
	value(selector: string): Promise<string>;
	/** Return a matching element attribute. */
	attr(selector: string, name: string): Promise<string | null>;
	/** Count matching elements. */
	count(selector: string): Promise<number>;
	/** Report whether a matching element is visible. */
	isVisible(selector: string): Promise<boolean>;
	/** Capture a Playwright-format ARIA snapshot inside this frame. */
	ariaSnapshot(selector?: string, options?: AriaSnapshotOptions): Promise<string>;
	/** Evaluate a function or expression in this frame. */
	evaluate<R, TArgs extends unknown[]>(fn: string | ((...args: TArgs) => R | Promise<R>), ...args: TArgs): Promise<R>;
	/** Wait for a selector and report whether it appeared. */
	waitFor(selector: string, options?: FrameWaitOptions): Promise<boolean>;
	/** Wait for a selector and report whether it appeared. */
	waitForSelector(selector: string, options?: FrameWaitOptions): Promise<boolean>;
	/** Capture a matching element inside this frame. */
	screenshot(selector: string): Promise<string>;
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
	/** Persist and report a frame element screenshot. */
	captureScreenshot(frame: Frame, selector: string, signal: AbortSignal): Promise<string>;
}

/** List the page's current main and child frames with stable DevTools identifiers. */
export async function listFrames(page: Page, signal?: AbortSignal): Promise<BrowserFrameInfo[]> {
	const result: BrowserFrameInfo[] = [];
	for (const frame of page.frames()) {
		const parent = frame.parentFrame();
		const internalFrame = frame as unknown as { _id: string };
		const internalParent = parent as unknown as { _id: string } | null;
		const info: BrowserFrameInfo = {
			id: internalFrame._id,
			name: frame.name(),
			url: frame.url(),
			parentId: internalParent?._id ?? null,
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
		const deadline = hooks.waitMs(options?.timeout);
		return hooks.op(
			`frame.waitForSelector(${JSON.stringify(selector)})`,
			deadline,
			async signal => {
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
				zeroMatchAfterMs: options?.timeout === undefined && !options?.hidden ? hooks.zeroMatchAfterMs : undefined,
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
		click: selector =>
			hooks.op(
				`frame.click(${JSON.stringify(selector)})`,
				hooks.actionOpMs,
				async signal => {
					const label = `frame.click(${JSON.stringify(selector)})`;
					const handle = await actionHandle(label, selector, signal);
					try {
						await clickElement(handle, label, signal);
					} finally {
						await handle.dispose().catch(() => undefined);
					}
				},
				selectorOptions(selector),
			),
		fill: (selector, value) =>
			hooks.op(
				`frame.fill(${JSON.stringify(selector)})`,
				hooks.actionOpMs,
				async signal => {
					const handle = await actionHandle(`frame.fill(${JSON.stringify(selector)})`, selector, signal);
					try {
						await fillViaHandle(handle, value, signal);
					} finally {
						await handle.dispose().catch(() => undefined);
					}
				},
				selectorOptions(selector),
			),
		type: (selector, text) =>
			hooks.op(
				`frame.type(${JSON.stringify(selector)})`,
				hooks.actionOpMs,
				async signal => {
					const handle = await untilAborted(signal, () => frame.$(hooks.normalizeSelector(selector)));
					if (!handle) throw new ToolError(`frame.type(${JSON.stringify(selector)}) matched no element`);
					try {
						await untilAborted(signal, () => handle.type(text, { delay: 0 }));
					} finally {
						await handle.dispose().catch(() => undefined);
					}
				},
				selectorOptions(selector),
			),
		press: (key, options) =>
			hooks.op(`frame.press(${JSON.stringify(key)})`, hooks.actionOpMs, async signal => {
				if (options?.selector)
					await untilAborted(signal, () => frame.focus(hooks.normalizeSelector(options.selector!)));
				await untilAborted(signal, () => frame.page().keyboard.press(key));
			}),
		text: selector =>
			hooks.op(
				`frame.text(${JSON.stringify(selector)})`,
				hooks.quickOpMs,
				signal =>
					untilAborted(signal, () =>
						frame.$eval(hooks.normalizeSelector(selector), element => element.textContent ?? ""),
					),
				selectorOptions(selector),
			),
		html: selector =>
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
		ariaSnapshot: (selector, options) =>
			hooks.op("frame.ariaSnapshot()", hooks.quickOpMs, async signal => {
				return (await untilAborted(signal, () =>
					frame.evaluate(buildAriaSnapshotScript(selector, options)),
				)) as string;
			}),
		evaluate: ((fn: string | ((...args: unknown[]) => unknown), ...args: unknown[]) =>
			hooks.op("frame.evaluate()", Number.POSITIVE_INFINITY, signal =>
				untilAborted(signal, () => frame.evaluate(fn as never, ...args)),
			)) as BrowserFrameApi["evaluate"],
		waitFor: waitForSelector,
		waitForSelector,
		screenshot: selector =>
			hooks.op(
				`frame.screenshot(${JSON.stringify(selector)})`,
				hooks.quickOpMs,
				signal => hooks.captureScreenshot(frame, selector, signal),
				selectorOptions(selector),
			),
	};
}

/** Persist a frame-scoped element screenshot and emit the normal Eval image output. */
export async function captureFrameScreenshot(
	frame: Frame,
	selector: string,
	signal: AbortSignal,
	normalizeSelector: (selector: string) => string,
	session: SessionSnapshot,
	output: RunOutput,
	screenshots: ScreenshotResult[],
): Promise<string> {
	const handle = await untilAborted(signal, () => frame.$(normalizeSelector(selector)));
	if (!handle) throw new ToolError(`frame.screenshot(${JSON.stringify(selector)}) matched no element`);
	let buffer: Buffer;
	try {
		await untilAborted(signal, () =>
			handle.evaluate(element => {
				const target = element as unknown as {
					scrollIntoView(options: { behavior: string; block: string; inline: string }): void;
				};
				target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
			}),
		).catch(() => undefined);
		const screenshotOptions: ElementScreenshotOptions = { type: "png", scrollIntoView: false };
		buffer = (await untilAborted(signal, () => handle.screenshot(screenshotOptions))) as Buffer;
	} finally {
		await handle.dispose().catch(() => undefined);
	}
	const resized = await resizeImage(
		{ type: "image", data: buffer.toBase64(), mimeType: "image/png" },
		{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70, excludeWebP: session.excludeWebP },
	);
	const saveFullRes = !!session.browserScreenshotDir;
	const savedBuffer = saveFullRes ? buffer : resized.buffer;
	const savedMimeType = saveFullRes ? ("image/png" as const) : resized.mimeType;
	const ext = savedMimeType === "image/webp" ? "webp" : savedMimeType === "image/jpeg" ? "jpg" : "png";
	const dest = session.browserScreenshotDir
		? path.join(
				session.browserScreenshotDir,
				`frame-screenshot-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1)}.${ext}`,
			)
		: path.join(os.tmpdir(), `omp-frame-sshots-${Snowflake.next()}.${ext}`);
	await fs.promises.mkdir(path.dirname(dest), { recursive: true });
	await Bun.write(dest, savedBuffer);
	screenshots.push({
		dest,
		mimeType: savedMimeType,
		bytes: savedBuffer.length,
		width: resized.width,
		height: resized.height,
	});
	output.push({
		type: "text",
		text: formatScreenshot({
			saveFullRes,
			savedMimeType,
			savedByteLength: savedBuffer.length,
			dest,
			resized,
		}).join("\n"),
	});
	output.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
	return dest;
}
