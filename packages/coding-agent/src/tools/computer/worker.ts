import { AsyncLocalStorage } from "node:async_hooks";
import * as os from "node:os";
import * as path from "node:path";

import type {
	Application,
	ApplicationQuery,
	ApplicationOpenOptions,
	DesktopMenuItem as MenuItem,
	DesktopObservation as NativeObservation,
	DesktopControlState,
	HoldOptions as NativeHoldOptions,
	AxNode,
	AxQuery,
	AxSnapshotOptions,
	CaptureRegion,
	DesktopCapabilities,
	DesktopCapture,
	DesktopDisplay,
	DesktopPoint,
	DesktopScreenState,
	DesktopSessionOptions,
	DesktopWindow,
	PointerOptions,
} from "@oh-my-pi/pi-natives";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";
import { JsRuntime, type RuntimeHooks } from "../../eval/js/shared/runtime";
import { cloneSafe, RunOutput } from "../browser/run-output";
import {
	bindRunFacade,
	markHandled,
	resolvePredicateTimeout,
	type WaitPredicateOptions,
	waitForRun,
} from "../run-scope";
import { ToolAbortError, throwIfAborted } from "../tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	type ComputerScreenshot,
	type ComputerSessionSnapshot,
	type ComputerWorkerInbound,
	type ComputerWorkerTransport,
	type RunErrorPayload,
	SCREEN_LOCKED_CAPTURE_NOTE,
	screenStateNotice,
	type ToolReply,
} from "./protocol";
import { describeWindowMiss } from "./window-miss";

/** Native desktop operations consumed by the script runtime. */
export interface NativeDesktopSession {
	readonly capabilities: DesktopCapabilities;
	/** Lock and display-sleep state, read without waiting behind queued native work. */
	readonly screenState: DesktopScreenState;
	listDisplays(): Promise<DesktopDisplay[]>;
	listWindows(): Promise<DesktopWindow[]>;
	capture(target: string, caps?: { maxWidth?: number; maxHeight?: number } | null): Promise<DesktopCapture>;
	captureRegion(
		target: string,
		region: CaptureRegion,
		caps?: { maxWidth?: number; maxHeight?: number } | null,
	): Promise<DesktopCapture>;
	cancel(): void;
	retire(): void;
	listApplications(options?: ApplicationQuery): Promise<Application[]>;
	openApplication(id: string, options?: ApplicationOpenOptions): Promise<Application>;
	menuItems(target: string, path?: string[]): Promise<MenuItem[]>;
	menuSelect(target: string, path: string[]): Promise<void>;
	observe(
		target: string,
		caps?: { maxWidth?: number; maxHeight?: number },
		options?: AxOptions,
	): Promise<NativeObservation>;
	holdKeys(target: string, keys: string[], options: NativeHoldOptions): Promise<void>;
	holdMouse(target: string, x: number, y: number, options: NativeHoldOptions): Promise<void>;
	acquireControl(): Promise<DesktopControlState>;
	releaseControl(): void;
	controlState(): DesktopControlState;
	bringToCurrentSpace(windowId: string): Promise<void>;
	click(target: string, x: number, y: number, opts?: PointerOptions | null): Promise<void>;
	moveMouse(target: string, x: number, y: number, opts?: PointerOptions | null): Promise<void>;
	drag(target: string, points: DesktopPoint[], opts?: PointerOptions | null): Promise<void>;
	scroll(target: string, x: number, y: number, dx: number, dy: number, opts?: PointerOptions | null): Promise<void>;
	typeText(target: string, text: string, opts?: PointerOptions | null): Promise<void>;
	keyChord(target: string, keys: string[], opts?: PointerOptions | null): Promise<void>;
	raiseWindow(windowId: string): Promise<void>;
	axSnapshot(target: string, opts?: AxSnapshotOptions | null): Promise<{ text: string }>;
	axQuery(target: string, query: AxQuery): Promise<AxNode[]>;
	axElementAt(target: string, x: number, y: number): Promise<AxNode | null | undefined>;
	axFocused(): Promise<AxNode | null | undefined>;
	axNode(ref: string): Promise<AxNode>;
	axAttributes(ref: string): Promise<Array<[string, string]>>;
	axChildren(ref: string): Promise<AxNode[]>;
	axParent(ref: string): Promise<AxNode | null | undefined>;
	axPerform(ref: string, action: string): Promise<void>;
	axSetValue(ref: string, value: string): Promise<void>;
	axFocus(ref: string): Promise<void>;
	axClick(ref: string, opts?: PointerOptions | null): Promise<void>;
	close(): Promise<void>;
}

/** Creates the native session co-located with the computer worker runtime. */
export type NativeDesktopSessionFactory = (
	options: DesktopSessionOptions,
) => NativeDesktopSession | Promise<NativeDesktopSession>;

type WindowFilter = { id?: string | number; app?: string; title?: string };
/** Window listings are session-transcript payload; `window()` lookups search the whole native list. */
const MAX_LISTED_WINDOWS = 48;
type InputOptions = { takeover?: boolean };
type ScreenshotOptions = { silent?: boolean };
type ScreenshotResult = Pick<
	ComputerScreenshot,
	"path" | "width" | "height" | "coordinateWidth" | "coordinateHeight" | "region" | "screenLocked"
>;
type ClickOptions = InputOptions & { button?: string; count?: number; modifiers?: string[] };
type DragOptions = InputOptions & { modifiers?: string[]; keys?: string[] };
type ScrollOptions = InputOptions & { dx?: number; dy?: number };
type AxOptions = Pick<AxSnapshotOptions, "all" | "maxDepth">;
type HoldOptions = Pick<NativeHoldOptions, "duration" | "takeover">;
type HoldMouseOptions = NativeHoldOptions;
type ObservationResult = ScreenshotResult & { ax: string; nodeCount: number; truncated: boolean };

type PendingTool = { resolve(value: unknown): void; reject(reason?: unknown): void };
interface ActiveRun {
	id: string;
	ac: AbortController;
	signal: AbortSignal;
	pendingTools: Map<string, PendingTool>;
}

interface ComputerRunContext {
	signal: AbortSignal;
	readOnly: boolean;
	snapshot: ComputerSessionSnapshot;
	output: RunOutput;
	confirmControl(reason: string): Promise<boolean>;
	screenshots: ComputerScreenshot[];
}

type RunContextAccessor = () => ComputerRunContext;

function errorPayload(error: unknown): RunErrorPayload {
	if (error instanceof ToolAbortError) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: true };
	}
	if (error instanceof ToolError) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: true, isAbort: false };
	}
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: false };
	}
	return { name: "Error", message: String(error), isToolError: false, isAbort: false };
}

function replyError(payload: RunErrorPayload): Error {
	if (payload.isAbort) {
		const error = new ToolAbortError(payload.message || "Tool call aborted");
		if (payload.stack) error.stack = payload.stack;
		return error;
	}
	const ErrorType = payload.isToolError ? ToolError : Error;
	const error = new ErrorType(payload.message);
	if (payload.name) error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

function nativeError(error: unknown): ToolError {
	return new ToolError(error instanceof Error ? error.message : String(error));
}

async function nativeCall<T>(signal: AbortSignal, call: () => T | Promise<T>): Promise<T> {
	throwIfAborted(signal);
	try {
		const value = await call();
		throwIfAborted(signal);
		return value;
	} catch (error) {
		throwIfAborted(signal);
		if (error instanceof ToolAbortError) throw error;
		throw nativeError(error);
	}
}

function pointerOptions(options?: ClickOptions | DragOptions | InputOptions): PointerOptions {
	const mapped: PointerOptions = {};
	if (!options) return mapped;
	if ("button" in options && options.button !== undefined) mapped.button = options.button;
	if ("count" in options && options.count !== undefined) mapped.count = options.count;
	if ("modifiers" in options && options.modifiers !== undefined) mapped.modifiers = options.modifiers;
	if ("keys" in options && options.keys !== undefined) mapped.keys = options.keys;
	if (options.takeover !== undefined) mapped.takeover = options.takeover;
	return mapped;
}

function chordKeys(chord: string | string[]): string[] {
	return typeof chord === "string"
		? chord
				.split("+")
				.map(key => key.trim())
				.filter(Boolean)
		: chord;
}

function validateKeys(value: unknown, label: string, options?: { allowEmpty?: boolean }): asserts value is string[] {
	if (
		!Array.isArray(value) ||
		(!options?.allowEmpty && value.length === 0) ||
		value.some(key => typeof key !== "string" || !key.trim())
	) {
		throw new ToolError(`${label} requires a non-empty array of non-empty strings`);
	}
}

function validateHold(options: HoldOptions): void {
	if (
		!options ||
		typeof options.duration !== "number" ||
		!Number.isFinite(options.duration) ||
		options.duration < 0 ||
		options.duration > 100
	) {
		throw new ToolError("duration must be seconds in the range 0..100");
	}
}

function strictObject(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some(key => !allowed.includes(key))
	) {
		throw new ToolError(`${label} must be an object with only: ${allowed.join(", ")}`);
	}
}

function matchesFilter(window: DesktopWindow, filter?: WindowFilter): boolean {
	if (!filter) return true;
	const app = filter.app?.toLocaleLowerCase();
	const title = filter.title?.toLocaleLowerCase();
	return (
		(filter.id === undefined || window.id === String(filter.id)) &&
		(!app || window.app.toLocaleLowerCase().includes(app)) &&
		(!title || window.title.toLocaleLowerCase().includes(title))
	);
}

function guardRun(context: ComputerRunContext, method: string): void {
	if (context.readOnly) throw new ToolError(`read-only run: '${method}' requires read_only: false`);
	throwIfAborted(context.signal);
}

async function captureScreenshot(
	session: NativeDesktopSession,
	getContext: RunContextAccessor,
	target: string,
	options?: ScreenshotOptions,
	region?: CaptureRegion,
): Promise<ScreenshotResult> {
	const context = getContext();
	const caps = {
		maxWidth: context.snapshot.captureMaxWidth,
		maxHeight: context.snapshot.captureMaxHeight,
	};
	const frame = await nativeCall(context.signal, () =>
		region === undefined ? session.capture(target, caps) : session.captureRegion(target, region, caps),
	);
	return await emitScreenshot(context, frame, options);
}

async function emitScreenshot(
	context: ComputerRunContext,
	frame: DesktopCapture,
	options?: ScreenshotOptions,
): Promise<ScreenshotResult> {
	const destination = path.join(os.tmpdir(), `omp-computer-${Snowflake.next()}.png`);
	await Bun.write(destination, frame.data);
	throwIfAborted(context.signal);
	const result: ScreenshotResult = {
		path: destination,
		width: frame.width,
		height: frame.height,
		coordinateWidth: frame.coordinateWidth,
		coordinateHeight: frame.coordinateHeight,
		...(frame.region ? { region: frame.region } : {}),
	};
	if (frame.screenLocked) result.screenLocked = true;
	const scaled = frame.width !== frame.sourceWidth || frame.height !== frame.sourceHeight;
	context.screenshots.push({
		...result,
		sourceWidth: frame.sourceWidth,
		sourceHeight: frame.sourceHeight,
		target: frame.target,
	});
	if (!options?.silent) {
		const dimensions = `${frame.width}×${frame.height}${scaled ? ` (scaled from ${frame.sourceWidth}×${frame.sourceHeight})` : ""}`;
		const coordinates = `coordinateWidth=${frame.coordinateWidth} coordinateHeight=${frame.coordinateHeight}`;
		const captured = frame.region
			? `zoom ${frame.target} ${dimensions}; region=${JSON.stringify(frame.region)}; ${coordinates}; use the base full screenshot coordinates for input, not zoom pixels → ${destination}`
			: `screenshot ${frame.target} ${dimensions}; ${coordinates} → ${destination}`;
		context.output.push({
			type: "text",
			text: frame.screenLocked ? `${captured}\n${SCREEN_LOCKED_CAPTURE_NOTE}` : captured,
		});
		context.output.push({
			type: "image",
			data: Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength).toString("base64"),
			mimeType: "image/png",
			detail: "original",
		});
	}
	return result;
}

class El {
	readonly ref: string;
	readonly role: string;
	readonly nativeRole: string;
	readonly title?: string;
	readonly description?: string;
	readonly enabled: boolean;
	readonly focused: boolean;
	readonly childCount: number;
	readonly #session: NativeDesktopSession;
	readonly #getContext: RunContextAccessor;

	constructor(session: NativeDesktopSession, getContext: RunContextAccessor, node: AxNode) {
		this.#session = session;
		this.#getContext = getContext;
		this.ref = node.ref;
		this.role = node.role;
		this.nativeRole = node.nativeRole;
		this.title = node.title;
		this.description = node.description;
		this.enabled = node.enabled;
		this.focused = node.focused;
		this.childCount = node.childCount;
	}

	async value(): Promise<string | undefined> {
		const { signal } = this.#getContext();
		return (await nativeCall(signal, () => this.#session.axNode(this.ref))).value;
	}

	async setValue(value: string): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "setValue");
		await nativeCall(context.signal, () => this.#session.axSetValue(this.ref, value));
	}

	async bounds(): Promise<{ x: number; y: number; width: number; height: number } | null> {
		const { signal } = this.#getContext();
		const node = await nativeCall(signal, () => this.#session.axNode(this.ref));
		if (node.x === undefined || node.y === undefined || node.width === undefined || node.height === undefined)
			return null;
		return { x: node.x, y: node.y, width: node.width, height: node.height };
	}

	async attributes(): Promise<Record<string, string>> {
		const { signal } = this.#getContext();
		return Object.fromEntries(await nativeCall(signal, () => this.#session.axAttributes(this.ref)));
	}

	async actions(): Promise<string[]> {
		const { signal } = this.#getContext();
		return (await nativeCall(signal, () => this.#session.axNode(this.ref))).actions ?? [];
	}

	async perform(action: string): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "perform");
		await nativeCall(context.signal, () => this.#session.axPerform(this.ref, action));
	}

	async press(): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "press");
		await nativeCall(context.signal, () => this.#session.axPerform(this.ref, "press"));
	}

	async click(options?: ClickOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "click");
		await nativeCall(context.signal, () => this.#session.axClick(this.ref, pointerOptions(options)));
	}

	async doubleClick(options?: Omit<ClickOptions, "count">): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "doubleClick");
		await nativeCall(context.signal, () => this.#session.axClick(this.ref, pointerOptions({ ...options, count: 2 })));
	}

	async focus(): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "focus");
		await nativeCall(context.signal, () => this.#session.axFocus(this.ref));
	}

	async parent(): Promise<El | null> {
		const { signal } = this.#getContext();
		const node = await nativeCall(signal, () => this.#session.axParent(this.ref));
		return node ? new El(this.#session, this.#getContext, node) : null;
	}

	async children(): Promise<El[]> {
		const { signal } = this.#getContext();
		return (await nativeCall(signal, () => this.#session.axChildren(this.ref))).map(
			node => new El(this.#session, this.#getContext, node),
		);
	}
}

/** `find()`'s array answers element calls with how to pick one, instead of "is not a function". */
function foundElements(elements: El[]): El[] {
	for (const method of Object.getOwnPropertyNames(El.prototype)) {
		if (method === "constructor") continue;
		Object.defineProperty(elements, method, {
			value: () => {
				throw new TypeError(
					`find() returns an array (length ${elements.length}), not one element, so it has no ${method}(); pick one first: const [el] = await win.find(query)`,
				);
			},
		});
	}
	return elements;
}

/** `await ref("e5")` resolves the element; its methods chain on the handle and await the lookup first. */
class ElRef implements PromiseLike<El> {
	readonly ref: string;
	readonly #lookup: () => Promise<El>;
	#element?: Promise<El>;

	constructor(ref: string, lookup: () => Promise<El>) {
		this.ref = ref;
		this.#lookup = lookup;
	}

	#resolve(): Promise<El> {
		this.#element ??= this.#lookup();
		return this.#element;
	}

	// oxlint-disable-next-line unicorn/no-thenable -- the handle is awaitable by design: `await ref("e5")` resolves the element.
	then<A = El, B = never>(
		onFulfilled?: ((element: El) => A | PromiseLike<A>) | null,
		onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
	): Promise<A | B> {
		return this.#resolve().then(onFulfilled, onRejected);
	}

	catch<B = never>(onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<El | B> {
		return this.#resolve().catch(onRejected);
	}

	finally(onFinally?: (() => void) | null): Promise<El> {
		return this.#resolve().finally(onFinally);
	}

	async value(): Promise<string | undefined> {
		return (await this.#resolve()).value();
	}

	async setValue(value: string): Promise<void> {
		await (await this.#resolve()).setValue(value);
	}

	async bounds(): Promise<{ x: number; y: number; width: number; height: number } | null> {
		return (await this.#resolve()).bounds();
	}

	async attributes(): Promise<Record<string, string>> {
		return (await this.#resolve()).attributes();
	}

	async actions(): Promise<string[]> {
		return (await this.#resolve()).actions();
	}

	async perform(action: string): Promise<void> {
		await (await this.#resolve()).perform(action);
	}

	async press(): Promise<void> {
		await (await this.#resolve()).press();
	}

	async click(options?: ClickOptions): Promise<void> {
		await (await this.#resolve()).click(options);
	}

	async doubleClick(options?: Omit<ClickOptions, "count">): Promise<void> {
		await (await this.#resolve()).doubleClick(options);
	}

	async focus(): Promise<void> {
		await (await this.#resolve()).focus();
	}

	async parent(): Promise<El | null> {
		return (await this.#resolve()).parent();
	}

	async children(): Promise<El[]> {
		return (await this.#resolve()).children();
	}
}

class Win {
	readonly id: string;
	readonly app: string;
	readonly title: string;
	readonly pid?: number;
	readonly bounds: { x: number; y: number; width: number; height: number };
	readonly focused: boolean;
	readonly #session: NativeDesktopSession;
	readonly #getContext: RunContextAccessor;

	constructor(session: NativeDesktopSession, getContext: RunContextAccessor, window: DesktopWindow) {
		this.#session = session;
		this.#getContext = getContext;
		this.id = window.id;
		this.app = window.app;
		this.title = window.title;
		this.pid = window.pid;
		this.bounds = { x: window.x, y: window.y, width: window.width, height: window.height };
		this.focused = window.focused;
	}

	screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult> {
		return captureScreenshot(this.#session, this.#getContext, this.id, options);
	}

	zoom(region: CaptureRegion, options?: ScreenshotOptions): Promise<ScreenshotResult> {
		if (!region || typeof region !== "object" || Array.isArray(region)) {
			throw new ToolError("zoom requires a region { x, y, width, height } in the last full screenshot's pixels");
		}
		return captureScreenshot(this.#session, this.#getContext, this.id, options, region);
	}

	async click(x: number, y: number, options?: ClickOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "click");
		await nativeCall(context.signal, () => this.#session.click(this.id, x, y, pointerOptions(options)));
	}

	async doubleClick(x: number, y: number, options?: Omit<ClickOptions, "count">): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "doubleClick");
		await nativeCall(context.signal, () =>
			this.#session.click(this.id, x, y, pointerOptions({ ...options, count: 2 })),
		);
	}

	async move(x: number, y: number): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "move");
		await nativeCall(context.signal, () => this.#session.moveMouse(this.id, x, y, pointerOptions()));
	}

	async drag(points: Array<[number, number]>, options?: DragOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "drag");
		await nativeCall(context.signal, () =>
			this.#session.drag(
				this.id,
				points.map(([x, y]) => ({ x, y })),
				pointerOptions(options),
			),
		);
	}

	async scroll(x: number, y: number, options: ScrollOptions = {}): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "scroll");
		await nativeCall(context.signal, () =>
			this.#session.scroll(this.id, x, y, options.dx ?? 0, options.dy ?? 0, pointerOptions(options)),
		);
	}

	async type(text: string, options?: InputOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "type");
		await nativeCall(context.signal, () => this.#session.typeText(this.id, text, pointerOptions(options)));
	}

	async press(chord: string | string[], options?: InputOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "press");
		await nativeCall(context.signal, () =>
			this.#session.keyChord(this.id, chordKeys(chord), pointerOptions(options)),
		);
	}

	async holdKeys(keys: string[], options: HoldOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "holdKeys");
		validateHold(options);
		validateKeys(keys, "keys");
		await nativeCall(context.signal, () => this.#session.holdKeys(this.id, keys, options));
	}

	async holdMouse(x: number, y: number, options: HoldMouseOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "holdMouse");
		validateHold(options);
		if (options.keys !== undefined) validateKeys(options.keys, "keys");
		await nativeCall(context.signal, () => this.#session.holdMouse(this.id, x, y, options));
	}

	async observe(options?: ScreenshotOptions & AxOptions): Promise<ObservationResult> {
		const context = this.#getContext();
		const result = await nativeCall(context.signal, () =>
			this.#session.observe(
				this.id,
				{
					maxWidth: context.snapshot.captureMaxWidth,
					maxHeight: context.snapshot.captureMaxHeight,
				},
				options && { all: options.all, maxDepth: options.maxDepth },
			),
		);
		const screenshot = await emitScreenshot(context, result.capture, options);
		if (!options?.silent) context.output.push({ type: "text", text: result.accessibility.text });
		return {
			...screenshot,
			ax: result.accessibility.text,
			nodeCount: result.accessibility.nodeCount,
			truncated: result.accessibility.truncated,
		};
	}

	get menu() {
		return {
			items: async (path?: string | string[]): Promise<MenuItem[]> => {
				const context = this.#getContext();
				const segments = path === undefined ? undefined : typeof path === "string" ? [path] : path;
				if (segments !== undefined) validateKeys(segments, "menu path", { allowEmpty: true });
				return await nativeCall(context.signal, () => this.#session.menuItems(this.id, segments));
			},
			select: async (path: string[]): Promise<void> => {
				const context = this.#getContext();
				guardRun(context, "menu.select");
				validateKeys(path, "menu path");
				await nativeCall(context.signal, () => this.#session.menuSelect(this.id, path));
			},
		};
	}

	async bringToCurrentSpace(): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "bringToCurrentSpace");
		await nativeCall(context.signal, () => this.#session.bringToCurrentSpace(this.id));
	}

	async raise(): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "raise");
		await nativeCall(context.signal, () => this.#session.raiseWindow(this.id));
	}

	async ax(options?: AxOptions): Promise<string> {
		const { signal } = this.#getContext();
		return (await nativeCall(signal, () => this.#session.axSnapshot(this.id, options))).text;
	}

	async find(query: AxQuery): Promise<El[]> {
		const { signal } = this.#getContext();
		return foundElements(
			(await nativeCall(signal, () => this.#session.axQuery(this.id, query))).map(
				node => new El(this.#session, this.#getContext, node),
			),
		);
	}

	ref(ref: string): ElRef {
		return new ElRef(ref, async () => {
			const { signal } = this.#getContext();
			return new El(this.#session, this.#getContext, await nativeCall(signal, () => this.#session.axNode(ref)));
		});
	}
}

/** Hosts the persistent JavaScript runtime and native desktop session. */
export class ComputerWorkerCore {
	readonly #transport: ComputerWorkerTransport;
	readonly #createSession?: NativeDesktopSessionFactory;
	readonly #unsubscribe: () => void;
	#session?: NativeDesktopSession;
	/** In-flight lazy session creation, shared so concurrent run/capabilities requests never double-create. */
	#sessionInit?: Promise<NativeDesktopSession>;
	#runtime?: JsRuntime;
	#active: ActiveRun | null = null;
	/**
	 * Per-run context, carried through AsyncLocalStorage so async work leaked
	 * from an ended run (timers, dangling promises) keeps that run's aborted
	 * context instead of borrowing the next run's signal and read-only policy.
	 */
	readonly #runContexts = new AsyncLocalStorage<ComputerRunContext>();
	#closed = false;

	constructor(transport: ComputerWorkerTransport, createSession?: NativeDesktopSessionFactory) {
		this.#transport = transport;
		this.#createSession = createSession;
		this.#unsubscribe = transport.onMessage(message => this.handle(message));
		this.#transport.send({ type: "ready" });
	}

	/** Routes one supervisor command into the persistent worker state. */
	handle(message: ComputerWorkerInbound): void {
		switch (message.type) {
			case "ping":
				this.#transport.send({ type: "pong", id: message.id });
				return;
			case "run":
				void this.#run(message);
				return;
			case "capabilities":
				void this.#capabilities(message);
				return;
			case "abort":
				if (this.#active?.id === message.id) this.#active.ac.abort(new ToolAbortError());
				return;
			case "revoke-control":
				this.#active?.ac.abort(new ToolAbortError("Computer control revoked"));
				this.#session?.cancel();
				this.#transport.send({ type: "control-revoked", id: message.id });
				return;
			case "tool-reply":
				this.#deliverToolReply(message.id, message.reply);
				return;
			case "close":
				void this.#close();
		}
	}

	async #ensureSession(snapshot: ComputerSessionSnapshot): Promise<NativeDesktopSession> {
		if (this.#session) return this.#session;
		// Single-flight: share one creation promise so a run and a capabilities
		// request racing on a cold worker cannot each build (and leak) a session.
		this.#sessionInit ??= (async () => {
			try {
				// The worker must answer its readiness handshake without loading the native
				// addon; normal CLI startup and selector pings never execute desktop code.
				const createSession =
					this.#createSession ?? (await import("@oh-my-pi/pi-natives/desktop")).createDesktopSession;
				const session = await createSession({ display: snapshot.display });
				this.#session = session;
				return session;
			} catch (error) {
				throw nativeError(error);
			}
		})();
		try {
			return await this.#sessionInit;
		} catch (error) {
			// A failed attempt must not pin the rejection; let the next request retry.
			this.#sessionInit = undefined;
			throw error;
		}
	}

	#ensureRuntime(snapshot: ComputerSessionSnapshot): JsRuntime {
		if (this.#runtime) return this.#runtime;
		this.#runtime = new JsRuntime({ initialCwd: snapshot.cwd, sessionId: snapshot.sessionId });
		return this.#runtime;
	}

	async #run(message: Extract<ComputerWorkerInbound, { type: "run" }>): Promise<void> {
		if (this.#closed) {
			this.#transport.send({
				type: "result",
				id: message.id,
				ok: false,
				error: errorPayload(new ToolError("Computer worker is closed")),
			});
			return;
		}
		if (this.#active) {
			this.#transport.send({
				type: "result",
				id: message.id,
				ok: false,
				error: errorPayload(new ToolError("Computer worker is busy")),
			});
			return;
		}
		const timeoutSignal = AbortSignal.timeout(message.timeoutMs);
		const ac = new AbortController();
		const runAc = new AbortController();
		const signal = AbortSignal.any([timeoutSignal, ac.signal, runAc.signal]);
		const active: ActiveRun = { id: message.id, ac, signal, pendingTools: new Map() };
		this.#active = active;
		// Cancel synchronously while this run owns the native session, including
		// fire-and-forget operations still pending when the script returns.
		let nativeCancelled = false;
		const onNativeCancel = (): void => {
			if (this.#active === active && this.#session) {
				this.#session.cancel();
				nativeCancelled = true;
			}
		};
		signal.addEventListener("abort", onNativeCancel, { once: true });
		const output = new RunOutput();
		const screenshots: ComputerScreenshot[] = [];
		const runContext: ComputerRunContext = {
			signal,
			readOnly: message.session.readOnly,
			snapshot: message.session,
			output,
			screenshots,
			confirmControl: reason => this.#confirmControl(active, reason),
		};
		let returnValue: unknown;
		let failure: { error: unknown } | undefined;
		let completed = false;
		try {
			throwIfAborted(signal);
			const session = await this.#ensureSession(message.session);
			throwIfAborted(signal);
			const runtime = this.#ensureRuntime(message.session);
			runtime.setCwd(message.session.cwd);
			const desktop = this.#createDesktopScope(session);
			runtime.setRunScope({
				desktop: bindRunFacade(desktop, signal),
				assert: (condition: unknown, text?: string): void => {
					if (!condition) throw new ToolError(text ?? "Assertion failed");
				},
				wait: (msOrPredicate: number | (() => unknown), options?: WaitPredicateOptions): Promise<unknown> => {
					const resolved =
						typeof msOrPredicate === "number"
							? undefined
							: {
									timeout: resolvePredicateTimeout(message.timeoutMs, options?.timeout),
									interval: options?.interval,
								};
					return markHandled(waitForRun(msOrPredicate, signal, resolved));
				},
			});
			const { promise: cancelRejection, reject: rejectCancel } = Promise.withResolvers<never>();
			const onCancel = (): void => {
				const abortError =
					signal.reason instanceof ToolAbortError
						? signal.reason
						: new ToolAbortError(undefined, { cause: signal.reason });
				rejectCancel(
					timeoutSignal.aborted
						? new ToolError(`Computer code execution timed out after ${message.timeoutMs}ms`)
						: abortError,
				);
				const toolAbort = timeoutSignal.aborted
					? postmortem.markExpectedCleanupError(new ToolAbortError(undefined, { cause: timeoutSignal.reason }))
					: abortError;
				for (const pending of active.pendingTools.values()) pending.reject(toolAbort);
				active.pendingTools.clear();
			};
			if (signal.aborted) onCancel();
			else signal.addEventListener("abort", onCancel, { once: true });
			try {
				returnValue = await Promise.race([
					this.#runContexts.run(runContext, () =>
						runtime.run(message.code, `computer-run-${message.id}.js`, this.#runtimeHooks(active, output), {
							runId: message.id,
							cwd: message.session.cwd,
						}),
					),
					cancelRejection,
				]);
				completed = true;
			} finally {
				signal.removeEventListener("abort", onCancel);
			}
		} catch (error) {
			failure = { error };
		} finally {
			// Successful helper completion invalidates outstanding native work but
			// preserves an explicitly acquired task grant. Errors revoke it.
			signal.removeEventListener("abort", onNativeCancel);
			if (failure === undefined && !signal.aborted) this.#session?.retire();
			else if (!nativeCancelled) this.#session?.cancel();
			runAc.abort(postmortem.markExpectedCleanupError(new ToolAbortError("Computer run ended")));
			if (this.#active?.id === message.id) this.#active = null;
		}
		if (failure !== undefined) {
			this.#transport.send({
				type: "result",
				id: message.id,
				ok: false,
				error: this.#withScreenState(errorPayload(failure.error)),
			});
			return;
		}
		if (completed) {
			let capabilities: DesktopCapabilities;
			try {
				capabilities = (await this.#ensureSession(message.session)).capabilities;
			} catch (error) {
				this.#transport.send({
					type: "result",
					id: message.id,
					ok: false,
					error: errorPayload(nativeError(error)),
				});
				return;
			}
			this.#transport.send({
				type: "result",
				id: message.id,
				ok: true,
				payload: { displays: output.finish(), returnValue: cloneSafe(returnValue), screenshots, capabilities },
			});
		}
	}

	/**
	 * A run that fails while the macOS screen is locked or the display asleep
	 * says so after its own message, which stays first and intact. Aborts and
	 * sessions that never started are returned unchanged. The state is read
	 * without queuing, since the failure may be a native request that hangs.
	 */
	#withScreenState(payload: RunErrorPayload): RunErrorPayload {
		if (payload.isAbort || !this.#session) return payload;
		const notice = screenStateNotice(this.#session.screenState);
		if (!notice) return payload;
		const message = payload.message ? `${payload.message}\n${notice}` : notice;
		const stack =
			payload.stack && payload.message ? payload.stack.replace(payload.message, () => message) : payload.stack;
		return { ...payload, message, stack };
	}

	/**
	 * Answers a direct capabilities request without executing a script. Unlike a
	 * run, this never touches `#active`, so it resolves even while a run is in
	 * flight and always reports the session's current permission/backend state.
	 */
	async #capabilities(message: Extract<ComputerWorkerInbound, { type: "capabilities" }>): Promise<void> {
		if (this.#closed) {
			this.#transport.send({
				type: "capabilities",
				id: message.id,
				ok: false,
				error: errorPayload(new ToolError("Computer worker is closed")),
			});
			return;
		}
		try {
			const session = await this.#ensureSession(message.session);
			this.#transport.send({ type: "capabilities", id: message.id, ok: true, capabilities: session.capabilities });
		} catch (error) {
			this.#transport.send({
				type: "capabilities",
				id: message.id,
				ok: false,
				error: errorPayload(error instanceof ToolAbortError ? error : nativeError(error)),
			});
		}
	}

	#runtimeHooks(active: ActiveRun, output: RunOutput): RuntimeHooks {
		return {
			onText: chunk => {
				throwIfAborted(active.signal);
				output.pushText(chunk);
			},
			onDisplay: display => {
				throwIfAborted(active.signal);
				output.pushDisplay(display);
			},
			callTool: (name, args) => {
				throwIfAborted(active.signal);
				return this.#callTool(active, name, args);
			},
		};
	}

	async #callTool(active: ActiveRun, name: string, args: unknown): Promise<unknown> {
		const id = `computer-tc-${active.id}-${crypto.randomUUID()}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		active.pendingTools.set(id, { resolve, reject });
		this.#transport.send({ type: "tool-call", id, runId: active.id, name, args });
		return await promise;
	}

	async #confirmControl(active: ActiveRun, reason: string): Promise<boolean> {
		throwIfAborted(active.signal);
		const id = `computer-control-${active.id}-${crypto.randomUUID()}`;
		const pending = Promise.withResolvers<unknown>();
		active.pendingTools.set(id, pending);
		this.#transport.send({ type: "control-request", id, runId: active.id, reason });
		return (await pending.promise) === true;
	}

	#deliverToolReply(id: string, reply: ToolReply): void {
		const pending = this.#active?.pendingTools.get(id);
		if (!pending) return;
		this.#active?.pendingTools.delete(id);
		if (reply.ok) pending.resolve(reply.value);
		else pending.reject(replyError(reply.error));
	}

	#currentRunContext = (): ComputerRunContext => {
		const context = this.#runContexts.getStore();
		if (!context) throw new ToolError("no active computer run");
		return context;
	};

	#createDesktopScope(session: NativeDesktopSession): object {
		const getContext = this.#currentRunContext;
		const makeWin = (window: DesktopWindow): Win => new Win(session, getContext, window);
		const el = (node: AxNode): El => new El(session, getContext, node);
		const desktopTarget = new Win(session, getContext, {
			id: "desktop",
			app: "desktop",
			title: "desktop",
			x: 0,
			y: 0,
			width: 0,
			height: 0,
			focused: false,
		});
		return {
			capabilities: (): DesktopCapabilities => {
				const { signal } = getContext();
				throwIfAborted(signal);
				try {
					return session.capabilities;
				} catch (error) {
					throw nativeError(error);
				}
			},
			displays: async (): Promise<DesktopDisplay[]> => {
				const { signal } = getContext();
				return await nativeCall(signal, () => session.listDisplays());
			},
			display: async (selector: string): Promise<object> => {
				const { signal } = getContext();
				if (typeof selector !== "string" || !selector)
					throw new ToolError("display requires an id, 'active', or 'all'");
				if (selector !== "active" && selector !== "all") {
					const displays = await nativeCall(signal, () => session.listDisplays());
					if (!displays.some(display => display.id === selector))
						throw new ToolError(`Unknown display: ${selector}`);
				}
				const target = new Win(session, getContext, {
					id: `display:${selector}`,
					app: "",
					title: "",
					x: 0,
					y: 0,
					width: 0,
					height: 0,
					focused: false,
				});
				return {
					id: selector,
					screenshot: target.screenshot.bind(target),
					zoom: target.zoom.bind(target),
					click: target.click.bind(target),
					doubleClick: target.doubleClick.bind(target),
					move: target.move.bind(target),
					drag: target.drag.bind(target),
					scroll: target.scroll.bind(target),
					type: target.type.bind(target),
					press: target.press.bind(target),
					holdKeys: target.holdKeys.bind(target),
					holdMouse: target.holdMouse.bind(target),
				};
			},
			apps: {
				list: async (options?: ApplicationQuery): Promise<Application[]> => {
					const { signal } = getContext();
					return await nativeCall(signal, () => session.listApplications(options));
				},
				open: async (id: string, options?: ApplicationOpenOptions): Promise<Application> => {
					const context = getContext();
					guardRun(context, "apps.open");
					return await nativeCall(context.signal, () => session.openApplication(id, options));
				},
			},
			control: {
				acquire: async (options: { reason: string }): Promise<{ active: boolean }> => {
					const context = getContext();
					guardRun(context, "control.acquire");
					strictObject(options, ["reason"], "control.acquire");
					if (typeof options.reason !== "string" || !options.reason.trim())
						throw new ToolError("control.acquire requires a non-empty reason");
					if (session.controlState().active) return { active: true };
					const approved = await context.confirmControl(options.reason);
					throwIfAborted(context.signal);
					if (!approved) return { active: false };
					return await nativeCall(context.signal, () => session.acquireControl());
				},
				release: async (): Promise<void> => {
					const context = getContext();
					guardRun(context, "control.release");
					await nativeCall(context.signal, () => session.releaseControl());
				},
				state: async (): Promise<{ active: boolean }> => {
					throwIfAborted(getContext().signal);
					return session.controlState();
				},
			},
			windows: async (filter?: WindowFilter): Promise<DesktopWindow[]> => {
				const { signal } = getContext();
				return (await nativeCall(signal, () => session.listWindows()))
					.filter(window => matchesFilter(window, filter))
					.slice(0, MAX_LISTED_WINDOWS);
			},
			window: async (selector: string | number | WindowFilter): Promise<Win> => {
				const { signal } = getContext();
				const windows = await nativeCall(signal, () => session.listWindows());
				const matches =
					typeof selector === "string" || typeof selector === "number"
						? windows.filter(window => window.id === String(selector))
						: windows.filter(window => matchesFilter(window, selector));
				if (matches.length === 0) {
					// Untyped scripts may pass `null`, which `matchesFilter` accepts as no filter.
					const app = typeof selector === "object" ? selector?.app : undefined;
					throw new ToolError(
						`no window matches ${JSON.stringify(selector)}\n${describeWindowMiss(windows, app)}`,
					);
				}
				if (matches.length > 1) {
					const candidates = matches
						.slice(0, MAX_LISTED_WINDOWS)
						.map(window => `${window.id} ${window.app} ${JSON.stringify(window.title)}`)
						.join("\n");
					const omitted = matches.length - MAX_LISTED_WINDOWS;
					const more = omitted > 0 ? `\n… ${omitted} more` : "";
					throw new ToolError(`multiple windows match ${JSON.stringify(selector)}:\n${candidates}${more}`);
				}
				return makeWin(matches[0]!);
			},
			focusedWindow: async (): Promise<Win | null> => {
				const { signal } = getContext();
				const window = (await nativeCall(signal, () => session.listWindows())).find(candidate => candidate.focused);
				return window ? makeWin(window) : null;
			},
			screenshot: (options?: ScreenshotOptions) => captureScreenshot(session, getContext, "desktop", options),
			zoom: desktopTarget.zoom.bind(desktopTarget),
			click: desktopTarget.click.bind(desktopTarget),
			doubleClick: desktopTarget.doubleClick.bind(desktopTarget),
			move: desktopTarget.move.bind(desktopTarget),
			drag: desktopTarget.drag.bind(desktopTarget),
			scroll: desktopTarget.scroll.bind(desktopTarget),
			type: desktopTarget.type.bind(desktopTarget),
			press: desktopTarget.press.bind(desktopTarget),
			holdKeys: desktopTarget.holdKeys.bind(desktopTarget),
			holdMouse: desktopTarget.holdMouse.bind(desktopTarget),
			elementAt: async (x: number, y: number): Promise<El | null> => {
				const { signal } = getContext();
				const node = await nativeCall(signal, () => session.axElementAt("desktop", x, y));
				return node ? el(node) : null;
			},
			focusedElement: async (): Promise<El | null> => {
				const { signal } = getContext();
				const node = await nativeCall(signal, () => session.axFocused());
				return node ? el(node) : null;
			},
			ref: (ref: string): ElRef =>
				new ElRef(ref, async () => {
					const { signal } = getContext();
					return el(await nativeCall(signal, () => session.axNode(ref)));
				}),
			clipboard: {
				read: async (): Promise<string> => {
					const { signal } = getContext();
					throwIfAborted(signal);
					// Clipboard access is part of the native desktop surface and remains
					// outside the worker's readiness-only import graph.
					const { readTextFromClipboard } = await import("../../utils/clipboard");
					const text = await readTextFromClipboard();
					throwIfAborted(signal);
					return text;
				},
				write: async (text: string): Promise<void> => {
					const context = getContext();
					guardRun(context, "clipboard.write");
					// Clipboard access is part of the native desktop surface and remains
					// outside the worker's readiness-only import graph.
					const { copyToClipboard } = await import("../../utils/clipboard");
					await copyToClipboard(text);
					throwIfAborted(context.signal);
				},
			},
		};
	}

	async #close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#active?.ac.abort(new ToolAbortError());
		try {
			await this.#session?.close();
		} catch {
			// Closing is best-effort; the worker is exiting and has no request to report this against.
		} finally {
			this.#session = undefined;
			this.#sessionInit = undefined;
			this.#unsubscribe();
			this.#transport.send({ type: "closed" });
			this.#transport.close();
		}
	}
}
