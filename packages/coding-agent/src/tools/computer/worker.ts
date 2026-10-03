import { AsyncLocalStorage } from "node:async_hooks";
import { scheduler } from "node:timers/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
	AxNode,
	AxQuery,
	AxSnapshotOptions,
	DesktopCapabilities,
	DesktopDisplay,
	DesktopPoint,
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
	type AxReadOptions,
	desktopPoint,
	describeRosterChanges,
	diffTree,
	type InputWindow,
	ObservationLedger,
	renderGone,
	renderReadBack,
	renderUnreadable,
	windowAt,
} from "./observation";
import type {
	ComputerScreenshot,
	ComputerSessionSnapshot,
	ComputerWorkerInbound,
	ComputerWorkerTransport,
	RunErrorPayload,
	ToolReply,
} from "./protocol";

/** Native desktop operations consumed by the script runtime. */
export interface NativeDesktopSession {
	readonly capabilities: DesktopCapabilities;
	listDisplays(): Promise<DesktopDisplay[]>;
	listWindows(): Promise<DesktopWindow[]>;
	capture(
		target: string,
		caps?: { maxWidth?: number; maxHeight?: number } | null,
	): Promise<{
		data: Uint8Array;
		width: number;
		height: number;
		sourceWidth: number;
		sourceHeight: number;
		target: string;
		/** Display regions in the capture's pixels (desktop captures); maps desktop pointer pixels. */
		displays?: DesktopDisplay[];
	}>;
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

/** Target id of desktop-root input: keys reach the focused window, pointer input the window under it. */
const DESKTOP_TARGET = "desktop";
/**
 * A settling cell reads windows back no sooner than this after its last input,
 * so the app can react. One read per window: a second would retire the refs
 * the model held before the cell.
 */
const SETTLE_DELAY_MS = 500;
/** Past this much of the settle's own budget, remaining windows are named instead of read. */
const SETTLE_READ_BUDGET_MS = 10_000;
type InputOptions = { takeover?: boolean };
type ScreenshotOptions = { silent?: boolean };
type ClickOptions = InputOptions & { button?: string; count?: number; modifiers?: string[] };
type DragOptions = InputOptions & { modifiers?: string[] };
type ScrollOptions = InputOptions & { dx?: number; dy?: number };
type AxOptions = Pick<AxSnapshotOptions, "all" | "maxDepth">;

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

async function nativeCall<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
	throwIfAborted(signal);
	try {
		const value = await call();
		throwIfAborted(signal);
		return value;
	} catch (error) {
		if (error instanceof ToolAbortError) throw error;
		throw nativeError(error);
	}
}

function pointerOptions(options?: ClickOptions | DragOptions | InputOptions): PointerOptions | undefined {
	if (!options) return undefined;
	const mapped: PointerOptions = {};
	if ("button" in options && options.button !== undefined) mapped.button = options.button;
	if ("count" in options && options.count !== undefined) mapped.count = options.count;
	if ("modifiers" in options && options.modifiers !== undefined) mapped.modifiers = options.modifiers;
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
): Promise<{ path: string; width: number; height: number }> {
	const context = getContext();
	const frame = await nativeCall(context.signal, () =>
		session.capture(target, {
			maxWidth: context.snapshot.captureMaxWidth,
			maxHeight: context.snapshot.captureMaxHeight,
		}),
	);
	if (target === DESKTOP_TARGET) observer.noteDesktopCapture(frame.displays ?? []);
	const destination = path.join(os.tmpdir(), `omp-computer-${Snowflake.next()}.png`);
	await Bun.write(destination, frame.data);
	const scaled = frame.width !== frame.sourceWidth || frame.height !== frame.sourceHeight;
	context.screenshots.push({
		path: destination,
		width: frame.width,
		height: frame.height,
		sourceWidth: frame.sourceWidth,
		sourceHeight: frame.sourceHeight,
		target: frame.target,
	});
	if (!options?.silent) {
		context.output.push({
			type: "text",
			text: scaled
				? `screenshot ${frame.target} ${frame.width}×${frame.height} (scaled from ${frame.sourceWidth}×${frame.sourceHeight}) → ${destination}`
				: `screenshot ${frame.target} ${frame.width}×${frame.height} → ${destination}`,
		});
		context.output.push({
			type: "image",
			data: Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength).toString("base64"),
			mimeType: "image/png",
		});
	}
	return { path: destination, width: frame.width, height: frame.height };
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

	/** A read of this element; a failure (an expired ref) has the settle renew the window's tree. */
	#read<T>(method: string, call: () => Promise<T>): Promise<T> {
		return this.#observer.read(this.#getContext().signal, this.ref, `${method} ${this.ref}`, call);
	}

	/** An input on this element, recorded for the cell's post-input read-back. */
	async #input(method: string, label: string, dispatch: () => Promise<void>): Promise<void> {
		const context = this.#getContext();
		guardRun(context, method);
		await this.#observer.input(context.signal, this.#observer.windowOf(this.ref), label, dispatch);
	}

	async value(): Promise<string | undefined> {
		return (await this.#read("value", () => this.#session.axNode(this.ref))).value;
	}

	setValue(value: string): Promise<void> {
		return this.#input("setValue", `setValue ${this.ref}`, () => this.#session.axSetValue(this.ref, value));
	}

	async bounds(): Promise<{ x: number; y: number; width: number; height: number } | null> {
		const node = await this.#read("bounds", () => this.#session.axNode(this.ref));
		if (node.x === undefined || node.y === undefined || node.width === undefined || node.height === undefined)
			return null;
		return { x: node.x, y: node.y, width: node.width, height: node.height };
	}

	async attributes(): Promise<Record<string, string>> {
		return Object.fromEntries(await this.#read("attributes", () => this.#session.axAttributes(this.ref)));
	}

	async actions(): Promise<string[]> {
		return (await this.#read("actions", () => this.#session.axNode(this.ref))).actions ?? [];
	}

	perform(action: string): Promise<void> {
		return this.#input("perform", `perform ${this.ref} ${action}`, () => this.#session.axPerform(this.ref, action));
	}

	press(): Promise<void> {
		return this.#input("press", `press ${this.ref}`, () => this.#session.axPerform(this.ref, "press"));
	}

	click(options?: InputOptions): Promise<void> {
		return this.#input("click", `click ${this.ref}`, () => this.#session.axClick(this.ref, pointerOptions(options)));
	}

	focus(): Promise<void> {
		return this.#input("focus", `focus ${this.ref}`, () => this.#session.axFocus(this.ref));
	}

	async parent(): Promise<El | null> {
		const node = await this.#read("parent", () => this.#session.axParent(this.ref));
		return node ? this.#observer.element(this.#getContext, node, this.#observer.windowOf(this.ref)) : null;
	}

	async children(): Promise<El[]> {
		return (await this.#read("children", () => this.#session.axChildren(this.ref))).map(node =>
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

	screenshot(options?: ScreenshotOptions): Promise<{ path: string; width: number; height: number }> {
		return captureScreenshot(this.#session, this.#getContext, this.#observer, this.id, options);
	}

	/**
	 * An input on this window, recorded for the cell's read-back. Desktop-root
	 * input is recorded on the window it reaches when sent: the one under
	 * `point` for pointer input, the focused one for keys.
	 */
	async #input(
		method: string,
		label: string,
		dispatch: () => Promise<void>,
		point?: { x: number; y: number },
	): Promise<void> {
		const context = this.#getContext();
		guardRun(context, method);
		if (this.id === DESKTOP_TARGET) {
			await this.#observer.input(context.signal, undefined, `desktop ${label}`, dispatch, { point });
			return;
		}
		await this.#observer.input(context.signal, { id: this.id, pid: this.pid }, label, dispatch);
	}

	click(x: number, y: number, options?: ClickOptions): Promise<void> {
		return this.#input(
			"click",
			`click ${x},${y}`,
			() => this.#session.click(this.id, x, y, pointerOptions(options)),
			{ x, y },
		);
	}

	doubleClick(x: number, y: number, options?: Omit<ClickOptions, "count">): Promise<void> {
		return this.#input(
			"doubleClick",
			`doubleClick ${x},${y}`,
			() => this.#session.click(this.id, x, y, pointerOptions({ ...options, count: 2 })),
			{ x, y },
		);
	}

	move(x: number, y: number): Promise<void> {
		return this.#input("move", `move ${x},${y}`, () => this.#session.moveMouse(this.id, x, y), { x, y });
	}

	drag(points: Array<[number, number]>, options?: DragOptions): Promise<void> {
		const [start] = points;
		return this.#input(
			"drag",
			"drag",
			() =>
				this.#session.drag(
					this.id,
					points.map(([x, y]) => ({ x, y })),
					pointerOptions(options),
				),
			start && { x: start[0], y: start[1] },
		);
	}

	scroll(x: number, y: number, options: ScrollOptions = {}): Promise<void> {
		return this.#input(
			"scroll",
			`scroll ${x},${y}`,
			() => this.#session.scroll(this.id, x, y, options.dx ?? 0, options.dy ?? 0, pointerOptions(options)),
			{ x, y },
		);
	}

	type(text: string, options?: InputOptions): Promise<void> {
		const shown = text.length > 24 ? `${text.slice(0, 23)}…` : text;
		return this.#input("type", `type ${JSON.stringify(shown)}`, () =>
			this.#session.typeText(this.id, text, pointerOptions(options)),
		);
	}

	press(chord: string | string[], options?: InputOptions): Promise<void> {
		const keys = chordKeys(chord);
		return this.#input("press", `press ${keys.join("+")}`, () =>
			this.#session.keyChord(this.id, keys, pointerOptions(options)),
		);
	}

	raise(): Promise<void> {
		return this.#input("raise", "raise", () => this.#session.raiseWindow(this.id));
	}

	async ax(options?: AxOptions): Promise<string> {
		const { signal } = this.#getContext();
		const text = (await nativeCall(signal, () => this.#session.axSnapshot(this.id, options))).text;
		this.#observer.ledger.recordRead({ id: this.id, pid: this.pid }, text, axReadOptions(options));
		return text;
	}

	async find(query: AxQuery): Promise<El[]> {
		const { signal } = this.#getContext();
		const window = { id: this.id, pid: this.pid };
		return (await nativeCall(signal, () => this.#session.axQuery(this.id, query))).map(node =>
			this.#observer.element(this.#getContext, node, window),
		);
	}

	async ref(ref: string): Promise<El> {
		const node = await this.#observer.read(this.#getContext().signal, ref, `ref ${ref}`, () =>
			this.#session.axNode(ref),
		);
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
	/** Display regions of the latest desktop screenshot, whose pixels desktop pointer input is given in. */
	#desktopDisplays: DesktopDisplay[] = [];

	constructor(session: NativeDesktopSession) {
		this.#session = session;
	}

	windowOf(ref: string): InputWindow | undefined {
		return this.ledger.windowOf(ref);
	}

	/** A desktop screenshot was taken: desktop pointer input is given in its pixels. */
	noteDesktopCapture(displays: DesktopDisplay[]): void {
		this.#desktopDisplays = displays;
	}

	/** Wrap a resolved node, remembering the window it was read from. */
	element(getContext: RunContextAccessor, node: AxNode, window: InputWindow | undefined): El {
		if (window) this.ledger.recordRefs(window.id, [node.ref]);
		return new El(this.#session, getContext, this, node);
	}

	/** A read addressed by ref. When it fails, the settle prints the ref's window afresh. */
	async read<T>(signal: AbortSignal, ref: string, label: string, call: () => Promise<T>): Promise<T> {
		try {
			return await nativeCall(signal, call);
		} catch (error) {
			const window = this.ledger.windowOf(ref);
			if (window && !(error instanceof ToolAbortError))
				this.ledger.noteFailure(window, label, error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	/**
	 * Dispatch one input, capturing the roster first when it opens the cell's
	 * input. Desktop-root input (`root`) is recorded on the window it reaches:
	 * the topmost window under `root.point` (desktop-screenshot pixels), or the
	 * focused window for keys; it stays unattributed when that is unknown.
	 */
	async input(
		signal: AbortSignal,
		window: InputWindow | undefined,
		label: string,
		dispatch: () => Promise<void>,
		root?: { point?: { x: number; y: number } },
	): Promise<void> {
		let roster: DesktopWindow[] | undefined;
		if (this.ledger.wantsRoster) {
			// Claimed before the await, so concurrent inputs take one roster, the earliest.
			const claim = this.ledger.claimRoster();
			roster = await this.#optional(signal, () => this.#session.listWindows());
			claim.resolve(roster);
		}
		if (root) {
			const at = root.point && desktopPoint(this.#desktopDisplays, root.point);
			if (!root.point || at) window = await this.windowReached(signal, at, roster);
		}
		this.ledger.noteInput(window, label);
		try {
			await nativeCall(signal, dispatch);
		} catch (error) {
			if (window && !(error instanceof ToolAbortError))
				this.ledger.noteFailure(window, label, error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			this.ledger.noteInputEnded();
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
			case "abort":
				if (this.#active?.id === message.id) this.#active.ac.abort(new ToolAbortError());
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

	/** Runs desktop code, or settles the cell that just ended (`settle`), as one abortable run. */
	async #run(message: Extract<ComputerWorkerInbound, { type: "run" | "settle" }>): Promise<void> {
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
		const output = new RunOutput();
		const screenshots: ComputerScreenshot[] = [];
		const runContext: ComputerRunContext = {
			signal,
			readOnly: message.session.readOnly,
			snapshot: message.session,
			output,
			screenshots,
		};
		let returnValue: unknown;
		let failure: { error: unknown } | undefined;
		let completed = false;
		try {
			throwIfAborted(signal);
			const session = await this.#ensureSession(message.session);
			const observer = (this.#observer ??= new InputObserver(session));
			let body: () => Promise<unknown>;
			if (message.type === "settle") {
				body = () => this.#settle(session, observer, signal, message.output);
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
				returnValue = await Promise.race([this.#runContexts.run(runContext, body), cancelRejection]);
				completed = true;
			} finally {
				signal.removeEventListener("abort", onCancel);
			}
		} catch (error) {
			failure = { error };
		} finally {
			runAc.abort(postmortem.markExpectedCleanupError(new ToolAbortError("Computer run ended")));
			if (this.#active?.id === message.id) this.#active = null;
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
	 * Re-reads every window the cell's input touched and says, once, what it
	 * left behind: each window's current tree marked against the last tree the
	 * model received, then windows the input opened, closed or focused. Each
	 * window is read once, so refs from the tree the model held before the cell
	 * stay valid (the native registry keeps one previous generation) and the
	 * printed refs are live. A window the cell read with `ax()` after its input
	 * is skipped only when `output`, what the cell printed, carries that tree.
	 * Input whose window is unknown is reported on the focused window. Nothing
	 * when the cell sent no input and no ref failed.
	 */
	async #settle(
		session: NativeDesktopSession,
		observer: InputObserver,
		signal: AbortSignal,
		output: string,
	): Promise<string | undefined> {
		const pending = observer.ledger.take(output);
		if (!pending) return undefined;
		const deadline = Date.now() + SETTLE_READ_BUDGET_MS;
		const settleIn = pending.lastInputAt + SETTLE_DELAY_MS - Date.now();
		if (settleIn > 0) await scheduler.wait(settleIn, { signal });
		// Loaded here, like the desktop session above: the readiness handshake must not load the addon.
		const { diffLineRuns } = await import("@oh-my-pi/pi-natives");
		const failure = (error: unknown): string => {
			if (signal.aborted) throw error;
			return error instanceof Error ? error.message : String(error);
		};
		let roster: DesktopWindow[] | undefined;
		try {
			roster = await nativeCall(signal, () => session.listWindows());
		} catch (error) {
			failure(error);
		}
		const focused = roster?.find(window => window.focused);
		if (focused) observer.ledger.attributeToFocused(pending, focused);
		const sections: string[] = [];
		for (const touched of pending.touched) {
			const window = roster?.find(candidate => candidate.id === touched.id);
			if (roster && !window) {
				sections.push(renderGone(touched));
				continue;
			}
			if (Date.now() > deadline) {
				sections.push(
					`window ${JSON.stringify(touched.id)} was not read back: the report's time budget is spent; read it yourself`,
				);
				continue;
			}
			try {
				const text = (await nativeCall(signal, () => session.axSnapshot(touched.id, touched.options))).text;
				const change = touched.baseline === undefined ? undefined : diffTree(touched.baseline, text, diffLineRuns);
				observer.ledger.recordShown({ id: touched.id, pid: window?.pid }, text, touched.options);
				sections.push(
					renderReadBack({ touched, window, text, change, sinceInputMs: Date.now() - pending.lastInputAt }),
				);
			} catch (error) {
				sections.push(renderUnreadable(touched, window, failure(error)));
			}
		}
		if (roster && pending.rosterBefore) {
			const reported = new Set(pending.touched.map(touched => touched.id));
			const changes = describeRosterChanges(pending.rosterBefore, roster, pending.pids, reported);
			if (changes.length > 0) sections.push(changes.join("\n"));
		}
		return sections.length > 0 ? sections.join("\n\n") : undefined;
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
			windows: async (filter?: WindowFilter): Promise<DesktopWindow[]> => {
				const { signal } = getContext();
				return (await nativeCall(signal, () => session.listWindows())).filter(window =>
					matchesFilter(window, filter),
				);
			},
			window: async (selector: string | number | WindowFilter): Promise<Win> => {
				const { signal } = getContext();
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
				const window = (await nativeCall(signal, () => session.listWindows())).find(candidate => candidate.focused);
				return window ? makeWin(window) : null;
			},
			screenshot: (options?: ScreenshotOptions) =>
				captureScreenshot(session, getContext, observer, DESKTOP_TARGET, options),
			click: desktopTarget.click.bind(desktopTarget),
			doubleClick: desktopTarget.doubleClick.bind(desktopTarget),
			move: desktopTarget.move.bind(desktopTarget),
			drag: desktopTarget.drag.bind(desktopTarget),
			scroll: desktopTarget.scroll.bind(desktopTarget),
			type: desktopTarget.type.bind(desktopTarget),
			press: desktopTarget.press.bind(desktopTarget),
			elementAt: async (x: number, y: number): Promise<El | null> => {
				const { signal } = getContext();
				const node = await nativeCall(signal, () => session.axElementAt("desktop", x, y));
				return node ? observer.element(getContext, node, await observer.windowReached(signal, { x, y })) : null;
			},
			focusedElement: async (): Promise<El | null> => {
				const { signal } = getContext();
				const node = await nativeCall(signal, () => session.axFocused());
				return node ? observer.element(getContext, node, await observer.windowReached(signal)) : null;
			},
			ref: async (ref: string): Promise<El> => {
				const node = await observer.read(getContext().signal, ref, `ref ${ref}`, () => session.axNode(ref));
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
