import { AsyncLocalStorage } from "node:async_hooks";
import { scheduler } from "node:timers/promises";
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
	DesktopSessionOptions,
	DesktopWindow,
	PointerOptions,
	UiQuiet,
	UiQuietOptions,
} from "@oh-my-pi/pi-natives";
import { untilAborted } from "@oh-my-pi/pi-utils/abortable";
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
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-tui/tools/streaming-output";
import {
	appWindow,
	type AxReadOptions,
	type CellKey,
	desktopPoint,
	describeRosterChanges,
	diffTree,
	type InputWindow,
	newWindowName,
	ObservationLedger,
	type PendingSettle,
	readBackName,
	renderGone,
	renderNewWindow,
	renderReadBack,
	renderUnreadable,
	reportNote,
	type SettleOutcome,
	type TouchedWindow,
	WEB_AREA_ROW,
	windowAt,
} from "./observation";
import type {
	ComputerScreenshot,
	ComputerSessionSnapshot,
	ComputerWorkerInbound,
	ComputerWorkerTransport,
	RunErrorPayload,
	SettleReport,
	ToolReply,
} from "./protocol";

/** Native desktop operations consumed by the script runtime. */
export interface NativeDesktopSession {
	readonly capabilities: DesktopCapabilities;
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
	waitForUiQuiet(pids: number[], options?: UiQuietOptions | null): Promise<UiQuiet>;
	close(): Promise<void>;
}

/** Creates the native session co-located with the computer worker runtime. */
export type NativeDesktopSessionFactory = (
	options: DesktopSessionOptions,
) => NativeDesktopSession | Promise<NativeDesktopSession>;

type WindowFilter = { id?: string | number; app?: string; title?: string };

/** Target id of desktop-root input: keys reach the focused window, pointer input the window under it. */
const DESKTOP_TARGET = "desktop";

/** Whether input on this target is global (the desktop or one display) rather than addressed to a window. */
function isRootTarget(target: string): boolean {
	return target === DESKTOP_TARGET || target.startsWith("display:");
}

/**
 * Input settles once the apps it reached have sent no accessibility
 * notification for this long, measured from when the wait starts, and at the
 * latest after the cap; the read that follows sees them done reacting. One
 * read per window: a ref expires once its element is missing from the
 * window's last two snapshots, so a second read would expire refs the model
 * held before the cell.
 */
const SETTLE_QUIET_MS = 250;
const SETTLE_CAP_MS = 5_000;
/** Without an app whose notifications can be watched, input settles this long after it ended. */
const SETTLE_FIXED_MS = 500;
/**
 * Reads of a cell's report stop this long before the settle request's own
 * budget runs out: windows not read by then are named, and the report built
 * so far returns before the request times out.
 */
const SETTLE_HEADROOM_MS = 2_000;
type InputOptions = { takeover?: boolean };
type ScreenshotOptions = { silent?: boolean };
type ScreenshotResult = Pick<
	ComputerScreenshot,
	"path" | "width" | "height" | "coordinateWidth" | "coordinateHeight" | "region"
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
	kind: "run" | "settle";
	/** Settles once the run has let go of the worker. */
	ended: Promise<void>;
	ac: AbortController;
	signal: AbortSignal;
	pendingTools: Map<string, PendingTool>;
}

/** The cell a desktop call belongs to, and the signal it runs under. */
interface CellScope {
	signal: AbortSignal;
	cell: CellKey;
}

interface ComputerRunContext extends CellScope {
	readOnly: boolean;
	snapshot: ComputerSessionSnapshot;
	output: RunOutput;
	confirmControl(reason: string): Promise<boolean>;
	screenshots: ComputerScreenshot[];
}

/** Input since the UI last settled: the processes it reached, the cells that sent it, and when it ended. */
interface Unsettled {
	pids: Set<number>;
	cells: Set<CellKey>;
	endedAt: number;
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
	observer: InputObserver,
	target: string,
	options?: ScreenshotOptions,
	region?: CaptureRegion,
): Promise<ScreenshotResult> {
	const context = getContext();
	await observer.settle(context.signal);
	const caps = {
		maxWidth: context.snapshot.captureMaxWidth,
		maxHeight: context.snapshot.captureMaxHeight,
	};
	const frame = await nativeCall(context.signal, () =>
		region === undefined ? session.capture(target, caps) : session.captureRegion(target, region, caps),
	);
	if (isRootTarget(target) && region === undefined) observer.noteRootCapture(target, frame.displays);
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
		context.output.push({
			type: "text",
			text: frame.region
				? `zoom ${frame.target} ${dimensions}; region=${JSON.stringify(frame.region)}; ${coordinates}; use the base full screenshot coordinates for input, not zoom pixels → ${destination}`
				: `screenshot ${frame.target} ${dimensions}; ${coordinates} → ${destination}`,
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
	readonly #observer: InputObserver;

	constructor(session: NativeDesktopSession, getContext: RunContextAccessor, observer: InputObserver, node: AxNode) {
		this.#session = session;
		this.#getContext = getContext;
		this.#observer = observer;
		this.ref = node.ref;
		this.role = node.role;
		this.nativeRole = node.nativeRole;
		this.title = node.title;
		this.description = node.description;
		this.enabled = node.enabled;
		this.focused = node.focused;
		this.childCount = node.childCount;
	}

	/** A read of this element, once the cell's input has settled; a failure (an expired ref) has the settle report the window. */
	async #read<T>(call: () => Promise<T>): Promise<T> {
		const context = this.#getContext();
		await this.#observer.settle(context.signal);
		return await this.#observer.read(context, this.ref, call);
	}

	/** An input on this element, recorded for the cell's post-input report. */
	async #input(method: string, dispatch: () => Promise<void>): Promise<void> {
		const context = this.#getContext();
		guardRun(context, method);
		await this.#observer.input(context, this.#observer.windowOf(this.ref), dispatch);
	}

	async value(): Promise<string | undefined> {
		return (await this.#read(() => this.#session.axNode(this.ref))).value;
	}

	setValue(value: string): Promise<void> {
		return this.#input("setValue", () => this.#session.axSetValue(this.ref, value));
	}

	async bounds(): Promise<{ x: number; y: number; width: number; height: number } | null> {
		const node = await this.#read(() => this.#session.axNode(this.ref));
		if (node.x === undefined || node.y === undefined || node.width === undefined || node.height === undefined)
			return null;
		return { x: node.x, y: node.y, width: node.width, height: node.height };
	}

	async attributes(): Promise<Record<string, string>> {
		return Object.fromEntries(await this.#read(() => this.#session.axAttributes(this.ref)));
	}

	async actions(): Promise<string[]> {
		return (await this.#read(() => this.#session.axNode(this.ref))).actions ?? [];
	}

	perform(action: string): Promise<void> {
		return this.#input("perform", () => this.#session.axPerform(this.ref, action));
	}

	press(): Promise<void> {
		return this.#input("press", () => this.#session.axPerform(this.ref, "press"));
	}

	click(options?: InputOptions): Promise<void> {
		return this.#input("click", () => this.#session.axClick(this.ref, pointerOptions(options)));
	}

	focus(): Promise<void> {
		return this.#input("focus", () => this.#session.axFocus(this.ref));
	}

	async parent(): Promise<El | null> {
		const node = await this.#read(() => this.#session.axParent(this.ref));
		return node ? this.#observer.element(this.#getContext, node, this.#observer.windowOf(this.ref)) : null;
	}

	async children(): Promise<El[]> {
		return (await this.#read(() => this.#session.axChildren(this.ref))).map(node =>
			this.#observer.element(this.#getContext, node, this.#observer.windowOf(this.ref)),
		);
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
	readonly #observer: InputObserver;

	constructor(
		session: NativeDesktopSession,
		getContext: RunContextAccessor,
		observer: InputObserver,
		window: DesktopWindow,
	) {
		this.#session = session;
		this.#getContext = getContext;
		this.#observer = observer;
		this.id = window.id;
		this.app = window.app;
		this.title = window.title;
		this.pid = window.pid;
		this.bounds = { x: window.x, y: window.y, width: window.width, height: window.height };
		this.focused = window.focused;
	}

	screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult> {
		return captureScreenshot(this.#session, this.#getContext, this.#observer, this.id, options);
	}

	zoom(region: CaptureRegion, options?: ScreenshotOptions): Promise<ScreenshotResult> {
		if (!region || typeof region !== "object" || Array.isArray(region)) {
			throw new ToolError("zoom requires a region { x, y, width, height } in the last full screenshot's pixels");
		}
		return captureScreenshot(this.#session, this.#getContext, this.#observer, this.id, options, region);
	}

	/** The run context, once the read-only guard has passed: every input helper calls this before touching its arguments. */
	#guard(method: string): ComputerRunContext {
		const context = this.#getContext();
		guardRun(context, method);
		return context;
	}

	/**
	 * An input on this window, recorded for the cell's report. Desktop-root
	 * input is recorded on the window it reaches when sent: the one under
	 * `point` for pointer input, the focused one for keys.
	 */
	async #input(
		context: ComputerRunContext,
		dispatch: () => Promise<void>,
		point?: { x: number; y: number },
	): Promise<void> {
		if (isRootTarget(this.id)) {
			await this.#observer.input(context, undefined, dispatch, { root: { target: this.id, point } });
			return;
		}
		await this.#observer.input(context, { id: this.id, pid: this.pid }, dispatch);
	}

	async click(x: number, y: number, options?: ClickOptions): Promise<void> {
		const context = this.#guard("click");
		return this.#input(context, () => this.#session.click(this.id, x, y, pointerOptions(options)), { x, y });
	}

	async doubleClick(x: number, y: number, options?: Omit<ClickOptions, "count">): Promise<void> {
		const context = this.#guard("doubleClick");
		return this.#input(context, () => this.#session.click(this.id, x, y, pointerOptions({ ...options, count: 2 })), {
			x,
			y,
		});
	}

	async move(x: number, y: number): Promise<void> {
		const context = this.#guard("move");
		return this.#input(context, () => this.#session.moveMouse(this.id, x, y, pointerOptions()), { x, y });
	}

	async drag(points: Array<[number, number]>, options?: DragOptions): Promise<void> {
		const context = this.#guard("drag");
		const start = Array.isArray(points) ? points[0] : undefined;
		return this.#input(
			context,
			() =>
				this.#session.drag(
					this.id,
					points.map(([x, y]) => ({ x, y })),
					pointerOptions(options),
				),
			Array.isArray(start) ? { x: start[0], y: start[1] } : undefined,
		);
	}

	async scroll(x: number, y: number, options: ScrollOptions = {}): Promise<void> {
		const context = this.#guard("scroll");
		return this.#input(
			context,
			() => this.#session.scroll(this.id, x, y, options.dx ?? 0, options.dy ?? 0, pointerOptions(options)),
			{ x, y },
		);
	}

	async type(text: string, options?: InputOptions): Promise<void> {
		const context = this.#guard("type");
		return this.#input(context, () => this.#session.typeText(this.id, text, pointerOptions(options)));
	}

	async press(chord: string | string[], options?: InputOptions): Promise<void> {
		const context = this.#guard("press");
		return this.#input(context, () => this.#session.keyChord(this.id, chordKeys(chord), pointerOptions(options)));
	}

	async holdKeys(keys: string[], options: HoldOptions): Promise<void> {
		const context = this.#guard("holdKeys");
		validateHold(options);
		validateKeys(keys, "keys");
		return this.#input(context, () => this.#session.holdKeys(this.id, keys, options));
	}

	async holdMouse(x: number, y: number, options: HoldMouseOptions): Promise<void> {
		const context = this.#guard("holdMouse");
		validateHold(options);
		if (options.keys !== undefined) validateKeys(options.keys, "keys");
		return this.#input(context, () => this.#session.holdMouse(this.id, x, y, options), { x, y });
	}

	async observe(options?: ScreenshotOptions & AxOptions): Promise<ObservationResult> {
		const context = this.#getContext();
		await this.#observer.settle(context.signal);
		// Sent now: an input sent after it does not make this a post-input read, however late it returns.
		const issued = this.#observer.ledger.sequence;
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
		if (isRootTarget(this.id)) this.#observer.noteRootCapture(this.id, result.capture.displays);
		else
			this.#observer.ledger.recordRead(
				context.cell,
				{ id: this.id, pid: this.pid },
				result.accessibility.text,
				axReadOptions(options),
				issued,
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
				await this.#observer.settle(context.signal);
				return await nativeCall(context.signal, () => this.#session.menuItems(this.id, segments));
			},
			select: async (path: string[]): Promise<void> => {
				const context = this.#guard("menu.select");
				validateKeys(path, "menu path");
				return this.#input(context, () => this.#session.menuSelect(this.id, path));
			},
		};
	}

	async bringToCurrentSpace(): Promise<void> {
		const context = this.#guard("bringToCurrentSpace");
		return this.#input(context, () => this.#session.bringToCurrentSpace(this.id));
	}

	async raise(): Promise<void> {
		return this.#input(this.#guard("raise"), () => this.#session.raiseWindow(this.id));
	}

	async ax(options?: AxOptions): Promise<string> {
		const { signal, cell } = this.#getContext();
		await this.#observer.settle(signal);
		// Sent now: an input sent after it does not make this a post-input read, however late it returns.
		const issued = this.#observer.ledger.sequence;
		const text = (await nativeCall(signal, () => this.#session.axSnapshot(this.id, options))).text;
		this.#observer.ledger.recordRead(cell, { id: this.id, pid: this.pid }, text, axReadOptions(options), issued);
		return text;
	}

	async find(query: AxQuery): Promise<El[]> {
		const { signal } = this.#getContext();
		await this.#observer.settle(signal);
		const window = { id: this.id, pid: this.pid };
		return (await nativeCall(signal, () => this.#session.axQuery(this.id, query))).map(node =>
			this.#observer.element(this.#getContext, node, window),
		);
	}

	async ref(ref: string): Promise<El> {
		const node = await this.#observer.read(this.#getContext(), ref, () => this.#session.axNode(ref));
		return this.#observer.element(this.#getContext, node, this.#observer.windowOf(ref));
	}
}

/** The comparable part of `ax()` options: what a read-back must repeat to match the model's tree. */
function axReadOptions(options: AxOptions | undefined): AxReadOptions {
	return { all: options?.all, maxDepth: options?.maxDepth };
}

/** Routes one native session's inputs and element reads through its observation ledger. */
class InputObserver {
	readonly ledger = new ObservationLedger();
	readonly #session: NativeDesktopSession;
	/** Display regions of each root target's latest screenshot, whose pixels its pointer input is given in. */
	readonly #rootDisplays = new Map<string, DesktopDisplay[]>();
	/** Input since the UI last settled: the processes it reached, the cells that sent it, and when it ended; undefined once settled. */
	#unsettled?: Unsettled;
	/** The wait in progress: every read issued meanwhile waits for it too. */
	#settling?: Promise<SettleOutcome>;
	/** Settles once the latest input has dispatched: inputs reach the native session in call order. */
	#dispatched: Promise<void> = Promise.resolve();

	constructor(session: NativeDesktopSession) {
		this.#session = session;
	}

	windowOf(ref: string): InputWindow | undefined {
		return this.ledger.windowOf(ref);
	}

	/** A desktop or display screenshot was taken: that target's pointer input is given in its pixels. */
	noteRootCapture(target: string, displays: DesktopDisplay[]): void {
		this.#rootDisplays.set(target, displays);
	}

	/** Wrap a resolved node, remembering the window it was read from. */
	element(getContext: RunContextAccessor, node: AxNode, window: InputWindow | undefined): El {
		if (window) this.ledger.recordRefs(window, [node.ref]);
		return new El(this.#session, getContext, this, node);
	}

	/** A read addressed by ref. When it fails, the cell's report shows the ref's window. */
	async read<T>(scope: CellScope, ref: string, call: () => Promise<T>): Promise<T> {
		try {
			return await nativeCall(scope.signal, call);
		} catch (error) {
			const window = this.ledger.windowOf(ref);
			if (window && !(error instanceof ToolAbortError)) this.ledger.noteFailure(scope.cell, window);
			throw error;
		}
	}

	/**
	 * Wait until the apps that input since the last settle reached have gone
	 * quiet. Every observation pays this before it reads, and so does the cell's
	 * report, so a batch of inputs pays one wait and nothing reads a half-drawn
	 * UI; reads issued during a wait share it. Without a process to watch, the
	 * wait is a fixed time after the input. Input sent during a wait is waited
	 * for next. How each wait ended goes on the record of every cell whose
	 * input it waited for.
	 */
	async settle(signal: AbortSignal): Promise<void> {
		for (;;) {
			if (this.#settling) {
				await this.#settling;
				continue;
			}
			const unsettled = this.#unsettled;
			if (!unsettled) return;
			this.#unsettled = undefined;
			const settling = this.#wait(unsettled, signal);
			this.#settling = settling;
			try {
				this.ledger.noteOutcome(unsettled.cells, await settling);
			} finally {
				this.#settling = undefined;
			}
		}
	}

	async #wait(unsettled: Unsettled, signal: AbortSignal): Promise<SettleOutcome> {
		if (unsettled.pids.size > 0) {
			const quiet = await this.#optional(signal, () =>
				this.#session.waitForUiQuiet([...unsettled.pids], { quietMs: SETTLE_QUIET_MS, capMs: SETTLE_CAP_MS }),
			);
			if (quiet && quiet.watched > 0)
				return { watched: true, timedOut: quiet.timedOut, sinceInputMs: Date.now() - unsettled.endedAt };
		}
		const remaining = unsettled.endedAt + SETTLE_FIXED_MS - Date.now();
		if (remaining > 0) await scheduler.wait(remaining, { signal });
		return { watched: false, timedOut: false, sinceInputMs: Date.now() - unsettled.endedAt };
	}

	/**
	 * Dispatch one input, capturing the roster first when it opens the cell's
	 * input. Desktop-root input (`root`) is recorded on the window it reaches:
	 * the topmost window under `root.point` (pixels of the root target's latest
	 * screenshot), or the focused window for keys; it stays unattributed when
	 * that is unknown. `opens` names what an app launch opened: the process,
	 * whose settling the next read waits for too, and its window when known;
	 * that input is reported on the app's window, never the focused one.
	 * Concurrent inputs dispatch in call order, each after the reads that
	 * precede the one before it.
	 */
	async input<T>(
		scope: CellScope,
		window: InputWindow | undefined,
		dispatch: () => Promise<T>,
		options?: {
			root?: { target: string; point?: { x: number; y: number } };
			opens?: (result: T) => { pid?: number; window?: InputWindow };
		},
	): Promise<T> {
		const previous = this.#dispatched;
		const { promise: dispatched, resolve: markDispatched } = Promise.withResolvers<void>();
		this.#dispatched = dispatched;
		let unsettled: Unsettled | undefined;
		const { signal, cell } = scope;
		try {
			await previous;
			// A cancelled cell's state is discarded; input it still sends must not record more.
			throwIfAborted(signal);
			let roster: DesktopWindow[] | undefined;
			if (this.ledger.wantsRoster(cell)) {
				const claim = this.ledger.claimRoster(cell);
				roster = await this.#optional(signal, () => this.#session.listWindows());
				claim.resolve(roster);
			}
			const root = options?.root;
			if (root) {
				const at = root.point && desktopPoint(this.#rootDisplays.get(root.target) ?? [], root.point);
				if (!root.point || at) window = await this.windowReached(signal, at, roster);
			}
			let pid: number | undefined;
			if (options?.opens) this.ledger.noteAppInput(cell);
			else pid = this.ledger.noteInput(cell, window);
			unsettled = this.#unsettled ??= { pids: new Set(), cells: new Set(), endedAt: Date.now() };
			unsettled.cells.add(cell);
			if (pid !== undefined) unsettled.pids.add(pid);
			const call = nativeCall(signal, dispatch);
			markDispatched();
			const result = await call;
			if (options?.opens) {
				const opened = options.opens(result);
				const started = opened.window?.pid ?? opened.pid;
				if (started !== undefined) unsettled.pids.add(started);
				this.ledger.noteOpened(cell, opened);
			}
			return result;
		} catch (error) {
			if (window && !(error instanceof ToolAbortError)) this.ledger.noteFailure(cell, window);
			throw error;
		} finally {
			markDispatched();
			if (unsettled) unsettled.endedAt = Date.now();
		}
	}

	/**
	 * The window a desktop point lies in (see `windowAt` in observation.ts), or
	 * without a point the focused window; undefined when unknown. `roster` is a
	 * window list read just before, if any.
	 */
	async windowReached(
		signal: AbortSignal,
		point?: { x: number; y: number },
		roster?: DesktopWindow[],
	): Promise<InputWindow | undefined> {
		roster ??= await this.#optional(signal, () => this.#session.listWindows());
		if (!roster) return undefined;
		let window: DesktopWindow | undefined;
		if (point) {
			const displays = await this.#optional(signal, () => this.#session.listDisplays());
			window = displays && windowAt(roster, displays, point);
		} else window = roster.find(candidate => candidate.focused);
		return window && { id: window.id, pid: window.pid };
	}

	/** A native read, or undefined when it fails; a cancellation still throws. */
	async #optional<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T | undefined> {
		try {
			return await nativeCall(signal, call);
		} catch (error) {
			if (error instanceof ToolAbortError) throw error;
			return undefined;
		}
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
	/** What the model saw of each window and what input touched since; lives and dies with `#session`. */
	#observer?: InputObserver;
	#runtime?: JsRuntime;
	#active: ActiveRun | null = null;
	/** Runs and settles waiting for the other kind to end, by request id, so an abort reaches them. */
	readonly #queued = new Map<string, AbortController>();
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
			case "settle":
				void this.#run(message);
				return;
			case "capabilities":
				void this.#capabilities(message);
				return;
			case "discard":
				this.#observer?.ledger.discard(message.cell);
				return;
			case "abort":
				if (this.#active?.id === message.id) this.#active.ac.abort(new ToolAbortError());
				else this.#queued.get(message.id)?.abort(new ToolAbortError());
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

	/**
	 * Runs desktop code, or settles the cell that just ended (`settle`), as one
	 * abortable run. A cell's report and another cell's run take turns: each
	 * waits for the other to end, within its own budget and abort. A run that
	 * finds another run in flight is refused as busy.
	 */
	async #run(message: Extract<ComputerWorkerInbound, { type: "run" | "settle" }>): Promise<void> {
		const startedAt = Date.now();
		const timeoutSignal = AbortSignal.timeout(message.timeoutMs);
		const ac = new AbortController();
		const timedOut = (): ToolError =>
			new ToolError(
				message.type === "settle"
					? `the post-input report timed out after ${message.timeoutMs}ms`
					: `Computer code execution timed out after ${message.timeoutMs}ms`,
			);
		for (;;) {
			if (this.#closed) {
				this.#transport.send({
					type: "result",
					id: message.id,
					ok: false,
					error: errorPayload(new ToolError("Computer worker is closed")),
				});
				return;
			}
			const busy = this.#active;
			if (!busy) break;
			if (message.type === "run" && busy.kind === "run") {
				this.#transport.send({
					type: "result",
					id: message.id,
					ok: false,
					error: errorPayload(new ToolError("Computer worker is busy")),
				});
				return;
			}
			this.#queued.set(message.id, ac);
			try {
				await untilAborted(AbortSignal.any([timeoutSignal, ac.signal]), busy.ended);
			} catch {
				const error = timeoutSignal.aborted ? timedOut() : new ToolAbortError();
				this.#transport.send({ type: "result", id: message.id, ok: false, error: errorPayload(error) });
				return;
			} finally {
				this.#queued.delete(message.id);
			}
		}
		const runAc = new AbortController();
		const signal = AbortSignal.any([timeoutSignal, ac.signal, runAc.signal]);
		const ended = Promise.withResolvers<void>();
		const active: ActiveRun = {
			id: message.id,
			kind: message.type,
			ac,
			signal,
			pendingTools: new Map(),
			ended: ended.promise,
		};
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
			cell: message.cell,
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
			const observer = (this.#observer ??= new InputObserver(session));
			let body: () => Promise<unknown>;
			if (message.type === "settle") {
				const request = {
					output: message.output,
					forget: message.forget === true,
					cell: message.cell,
					readDeadline: startedAt + message.timeoutMs - SETTLE_HEADROOM_MS,
				};
				body = () => this.#settle(session, observer, signal, request);
			} else {
				const code = message.code;
				const runtime = this.#ensureRuntime(message.session);
				runtime.setCwd(message.session.cwd);
				const desktop = this.#createDesktopScope(session, observer);
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
				body = () =>
					runtime.run(code, `computer-run-${message.id}.js`, this.#runtimeHooks(active, output), {
						runId: message.id,
						cwd: message.session.cwd,
					});
			}
			const { promise: cancelRejection, reject: rejectCancel } = Promise.withResolvers<never>();
			const onCancel = (): void => {
				const abortError =
					signal.reason instanceof ToolAbortError
						? signal.reason
						: new ToolAbortError(undefined, { cause: signal.reason });
				rejectCancel(timeoutSignal.aborted ? timedOut() : abortError);
				const toolAbort = timeoutSignal.aborted
					? postmortem.markExpectedCleanupError(new ToolAbortError(undefined, { cause: timeoutSignal.reason }))
					: abortError;
				for (const pending of active.pendingTools.values()) pending.reject(toolAbort);
				active.pendingTools.clear();
			};
			if (signal.aborted) onCancel();
			else signal.addEventListener("abort", onCancel, { once: true });
			try {
				returnValue = await Promise.race([this.#runContexts.run(runContext, body), cancelRejection]);
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
			ended.resolve();
		}
		if (failure !== undefined) {
			this.#transport.send({ type: "result", id: message.id, ok: false, error: errorPayload(failure.error) });
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
	 * Report what the cell's input changed: once the apps it reached have gone
	 * quiet, re-read each window it touched and print how it differs from the
	 * model's last tree of that window, then, whole, a window the input opened
	 * and focused. Each window is read once, so a ref the model held before the
	 * cell expires only if its element is missing from both that tree and this
	 * read. The reads become the model's trees only once the whole report is
	 * written: a report that fails or is cancelled leaves the trees the model
	 * last received as the baseline. `forget`: the model's context was rewritten
	 * since the last settle, so trees it saw before may be gone from it and
	 * windows print whole. Only the settling cell's input is reported, and its
	 * record is gone afterwards however the report ends.
	 */
	async #settle(
		session: NativeDesktopSession,
		observer: InputObserver,
		signal: AbortSignal,
		request: { output: string; forget: boolean; cell: CellKey; readDeadline: number },
	): Promise<SettleReport | undefined> {
		const { ledger } = observer;
		try {
			if (request.forget) ledger.forgetShown();
			// A read inside the cell may have paid the wait already; its outcome is on the cell's record.
			if (ledger.hasInput(request.cell)) await observer.settle(signal);
			const pending = ledger.take(request.cell, request.output);
			if (!pending) return undefined;
			return await this.#report(session, ledger, signal, pending, request.readDeadline);
		} finally {
			ledger.discard(request.cell);
		}
	}

	/**
	 * The report for one cell's pending input. Reads stop at `readDeadline`,
	 * short of the settle request's own timeout: windows not read by then are
	 * named, and the sections already built still return. The report stays
	 * within the inline output budget: a window section that would pass it is
	 * replaced by a line naming the window, and that window keeps the model's
	 * last tree as its baseline. `whole` is the same report with every window
	 * printed whole, for a host whose conversation was rewritten while the
	 * report was made, so the trees the diffs refer to may be gone.
	 */
	async #report(
		session: NativeDesktopSession,
		ledger: ObservationLedger,
		signal: AbortSignal,
		pending: PendingSettle,
		readDeadline: number,
	): Promise<SettleReport | undefined> {
		const deadline = AbortSignal.timeout(Math.max(0, readDeadline - Date.now()));
		const readSignal = AbortSignal.any([signal, deadline]);
		/** A native read under the deadline: its value, its failure, or neither once the deadline passed. */
		const budgeted = async <T>(call: () => Promise<T>): Promise<{ value: T } | { error?: string }> => {
			if (deadline.aborted) return {};
			try {
				return { value: await untilAborted(readSignal, () => nativeCall(readSignal, call)) };
			} catch (error) {
				if (signal.aborted) throw error;
				if (deadline.aborted) return {};
				return { error: error instanceof Error ? error.message : String(error) };
			}
		};
		const listed = await budgeted(() => session.listWindows());
		const roster = "value" in listed ? listed.value : undefined;
		const focused = roster?.find(window => window.focused);
		type Shown = { window: InputWindow; text: string; options: AxReadOptions };
		/**
		 * A window's section, whole too, with the line that names it instead and the tree it would make the
		 * model's.
		 */
		const sections: Array<{ text: string } | { text: string; whole: string; leftOut: string; shown: Shown }> = [];
		// Only `apps.open` input leaves both empty: whatever it opened is its app's, read below by pid.
		const windowInput = pending.touched.length > 0 || pending.unattributed > 0;
		if (focused) ledger.attributeToFocused(pending, focused);
		else if (pending.unattributed > 0) sections.push({ text: reportNote({ noFocusedWindow: true }) });
		const latest = pending.outcome?.latest;
		const unwatchedMs = latest && !latest.watched ? latest.sinceInputMs : undefined;
		// A sheet, popover or chooser that left the list hands its app's focus on, usually to its parent: the next
		// step is there, so that window is read right after the line naming the one that went.
		const successors = new Map<string, DesktopWindow>();
		const claimed = new Set<string>();
		if (roster) {
			for (const touched of pending.touched) {
				if (roster.some(candidate => candidate.id === touched.id)) continue;
				const pid = touched.pid ?? pending.rosterBefore?.find(candidate => candidate.id === touched.id)?.pid;
				const next = pid === undefined ? undefined : appWindow(roster, pid);
				if (!next || claimed.has(next.id)) continue;
				successors.set(touched.id, next);
				claimed.add(next.id);
			}
		}
		const queue: TouchedWindow[] = [];
		for (const touched of pending.touched) {
			if (claimed.has(touched.id)) continue;
			queue.push(touched);
			const next = successors.get(touched.id);
			if (next) {
				const own = pending.touched.find(candidate => candidate.id === next.id);
				queue.push({ ...(own ?? ledger.entry(next)), after: touched.id });
			}
		}
		const reported = new Set(queue.map(touched => touched.id));
		// An app the cell opened is shown on its own window, never on the user's focused one.
		if (roster) {
			for (const pid of pending.opened) {
				const window = appWindow(roster, pid);
				if (!window || reported.has(window.id)) continue;
				reported.add(window.id);
				queue.push(ledger.entry(window));
			}
		}
		for (const touched of queue) {
			const window = roster?.find(candidate => candidate.id === touched.id);
			if (roster && !window) {
				sections.push({ text: renderGone(touched) });
				continue;
			}
			const read = await budgeted(() => session.axSnapshot(touched.id, touched.options));
			if ("value" in read) {
				const text = read.value.text;
				const change = touched.baseline === undefined ? undefined : diffTree(touched.baseline, text);
				const readBack = { touched, window, text, change, unwatchedMs };
				sections.push({
					text: renderReadBack(readBack),
					whole: renderReadBack({ ...readBack, change: undefined }),
					leftOut: reportNote({ leftOut: readBackName(readBack) }),
					shown: { window: { id: touched.id, pid: window?.pid }, text, options: touched.options },
				});
			} else if (read.error !== undefined) sections.push({ text: renderUnreadable(touched, window, read.error) });
			else sections.push({ text: reportNote({ budgetSpent: JSON.stringify(touched.id) }) });
		}
		// A window the input opened and focused holds the model's next step, and it has no tree of it.
		const opened =
			focused &&
			pending.rosterBefore &&
			!reported.has(focused.id) &&
			!pending.rosterBefore.some(window => window.id === focused.id) &&
			(windowInput || (focused.pid !== undefined && pending.pids.has(focused.pid)))
				? focused
				: undefined;
		if (opened) {
			// Unreadable or out of time, it is still named by the roster line below.
			const read = await budgeted(() => session.axSnapshot(opened.id, {}));
			if ("value" in read) {
				const text = read.value.text;
				sections.push({
					text: renderNewWindow(opened, text),
					whole: renderNewWindow(opened, text),
					leftOut: reportNote({ leftOut: newWindowName(opened) }),
					shown: { window: { id: opened.id, pid: opened.pid }, text, options: {} },
				});
				reported.add(opened.id);
			}
		}
		const tail: string[] = [];
		if (roster && pending.rosterBefore) {
			const changes = describeRosterChanges(pending.rosterBefore, roster, pending.pids, reported);
			if (changes.length > 0) tail.push(changes.join("\n"));
		}
		const capped = pending.outcome?.capped;
		if (capped) tail.push(reportNote({ stillChanging: (capped.sinceInputMs / 1000).toFixed(1) }));
		const webNote = reportNote({ webContent: true });
		const mayNoteWeb = sections.some(section => "shown" in section && WEB_AREA_ROW.test(section.shown.text));
		/** The report with each window's section in its `form`, and the trees it printed. */
		const fit = (form: "text" | "whole"): { text: string; shown: Shown[] } => {
			// Budget left once every window is named by its short line; each section in turn takes its line's place if it fits.
			let room =
				DEFAULT_MAX_BYTES -
				Buffer.byteLength(
					[...sections.map(section => ("leftOut" in section ? section.leftOut : section.text)), ...tail]
						.concat(mayNoteWeb ? [webNote] : [])
						.join("\n\n"),
				);
			const shown: Shown[] = [];
			const texts = sections.map(section => {
				if (!("shown" in section)) return section.text;
				const extra = Buffer.byteLength(section[form]) - Buffer.byteLength(section.leftOut);
				if (extra > room) return section.leftOut;
				room -= extra;
				shown.push(section.shown);
				return section[form];
			});
			const notes = shown.some(({ text }) => WEB_AREA_ROW.test(text)) ? [webNote] : [];
			return { text: [...texts, ...tail, ...notes].join("\n\n"), shown };
		};
		const report = fit("text");
		if (report.text === "") return undefined;
		for (const { window, text, options } of report.shown) ledger.recordShown(window, text, options);
		const whole = fit("whole").text;
		return whole === report.text ? { text: report.text } : { text: report.text, whole };
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

	#createDesktopScope(session: NativeDesktopSession, observer: InputObserver): object {
		const getContext = this.#currentRunContext;
		const makeWin = (window: DesktopWindow): Win => new Win(session, getContext, observer, window);
		const desktopTarget = new Win(session, getContext, observer, {
			id: DESKTOP_TARGET,
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
				const target = new Win(session, getContext, observer, {
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
					return await observer.input(context, undefined, () => session.openApplication(id, options), {
						opens: application => ({ pid: application.pid ?? undefined }),
					});
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
				await observer.settle(signal);
				return (await nativeCall(signal, () => session.listWindows())).filter(window =>
					matchesFilter(window, filter),
				);
			},
			window: async (selector: string | number | WindowFilter): Promise<Win> => {
				const { signal } = getContext();
				await observer.settle(signal);
				const windows = await nativeCall(signal, () => session.listWindows());
				const matches =
					typeof selector === "string" || typeof selector === "number"
						? windows.filter(window => window.id === String(selector))
						: windows.filter(window => matchesFilter(window, selector));
				if (matches.length === 0) throw new ToolError(`no window matches ${JSON.stringify(selector)}`);
				if (matches.length > 1) {
					const candidates = matches
						.map(window => `${window.id} ${window.app} ${JSON.stringify(window.title)}`)
						.join("\n");
					throw new ToolError(`multiple windows match ${JSON.stringify(selector)}:\n${candidates}`);
				}
				return makeWin(matches[0]!);
			},
			focusedWindow: async (): Promise<Win | null> => {
				const { signal } = getContext();
				await observer.settle(signal);
				const window = (await nativeCall(signal, () => session.listWindows())).find(candidate => candidate.focused);
				return window ? makeWin(window) : null;
			},
			screenshot: (options?: ScreenshotOptions) =>
				captureScreenshot(session, getContext, observer, DESKTOP_TARGET, options),
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
				await observer.settle(signal);
				const node = await nativeCall(signal, () => session.axElementAt("desktop", x, y));
				return node ? observer.element(getContext, node, await observer.windowReached(signal, { x, y })) : null;
			},
			focusedElement: async (): Promise<El | null> => {
				const { signal } = getContext();
				await observer.settle(signal);
				const node = await nativeCall(signal, () => session.axFocused());
				return node ? observer.element(getContext, node, await observer.windowReached(signal)) : null;
			},
			ref: async (ref: string): Promise<El> => {
				const node = await observer.read(getContext(), ref, () => session.axNode(ref));
				return observer.element(getContext, node, observer.windowOf(ref));
			},
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
			this.#observer = undefined;
			this.#sessionInit = undefined;
			this.#unsubscribe();
			this.#transport.send({ type: "closed" });
			this.#transport.close();
		}
	}
}
