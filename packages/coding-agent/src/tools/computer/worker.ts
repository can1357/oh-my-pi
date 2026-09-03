import { AsyncLocalStorage } from "node:async_hooks";
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
import { ToolAbortError, ToolError, throwIfAborted } from "../tool-errors";
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
export type NativeDesktopSessionFactory = (options: DesktopSessionOptions) => NativeDesktopSession;

type WindowFilter = { app?: string; title?: string };
type DeliveryOptions = { delivery?: string };
type ScreenshotOptions = { silent?: boolean };
type ClickOptions = DeliveryOptions & { button?: string; count?: number; modifiers?: string[] };
type DragOptions = DeliveryOptions & { modifiers?: string[] };
type ScrollOptions = DeliveryOptions & { dx?: number; dy?: number };
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

function pointerOptions(options?: ClickOptions | DragOptions | DeliveryOptions): PointerOptions | undefined {
	if (!options) return undefined;
	const mapped: PointerOptions = {};
	if ("button" in options && options.button !== undefined) mapped.button = options.button;
	if ("count" in options && options.count !== undefined) mapped.count = options.count;
	if ("modifiers" in options && options.modifiers !== undefined) mapped.modifiers = options.modifiers;
	if (options.delivery !== undefined) mapped.deliveryMode = options.delivery;
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
): Promise<{ path: string; width: number; height: number }> {
	const context = getContext();
	const frame = await nativeCall(context.signal, () =>
		session.capture(target, {
			maxWidth: context.snapshot.captureMaxWidth,
			maxHeight: context.snapshot.captureMaxHeight,
		}),
	);
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

	async click(options?: DeliveryOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "click");
		await nativeCall(context.signal, () => this.#session.axClick(this.ref, pointerOptions(options)));
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

	screenshot(options?: ScreenshotOptions): Promise<{ path: string; width: number; height: number }> {
		return captureScreenshot(this.#session, this.#getContext, this.id, options);
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
		await nativeCall(context.signal, () => this.#session.moveMouse(this.id, x, y));
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

	async type(text: string, options?: DeliveryOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "type");
		await nativeCall(context.signal, () => this.#session.typeText(this.id, text, pointerOptions(options)));
	}

	async press(chord: string | string[], options?: DeliveryOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "press");
		await nativeCall(context.signal, () =>
			this.#session.keyChord(this.id, chordKeys(chord), pointerOptions(options)),
		);
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
		return (await nativeCall(signal, () => this.#session.axQuery(this.id, query))).map(
			node => new El(this.#session, this.#getContext, node),
		);
	}

	async ref(ref: string): Promise<El> {
		const { signal } = this.#getContext();
		return new El(this.#session, this.#getContext, await nativeCall(signal, () => this.#session.axNode(ref)));
	}
}

/** Hosts the persistent JavaScript runtime and native desktop session. */
export class ComputerWorkerCore {
	readonly #transport: ComputerWorkerTransport;
	readonly #createSession?: NativeDesktopSessionFactory;
	readonly #unsubscribe: () => void;
	#session?: NativeDesktopSession;
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
		try {
			// The worker must answer its readiness handshake without loading the native
			// addon; normal CLI startup and selector pings never execute desktop code.
			const createSession =
				this.#createSession ?? (await import("@oh-my-pi/pi-natives/desktop")).createDesktopSession;
			this.#session = createSession({ display: snapshot.display });
			return this.#session;
		} catch (error) {
			throw nativeError(error);
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
			windows: async (filter?: WindowFilter): Promise<DesktopWindow[]> => {
				const { signal } = getContext();
				return (await nativeCall(signal, () => session.listWindows())).filter(window =>
					matchesFilter(window, filter),
				);
			},
			window: async (selector: string | WindowFilter): Promise<Win> => {
				const { signal } = getContext();
				const windows = await nativeCall(signal, () => session.listWindows());
				const matches =
					typeof selector === "string"
						? windows.filter(window => window.id === selector)
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
			screenshot: (options?: ScreenshotOptions) => captureScreenshot(session, getContext, "desktop", options),
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
				return node ? el(node) : null;
			},
			focusedElement: async (): Promise<El | null> => {
				const { signal } = getContext();
				const node = await nativeCall(signal, () => session.axFocused());
				return node ? el(node) : null;
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
			this.#unsubscribe();
			this.#transport.send({ type: "closed" });
			this.#transport.close();
		}
	}
}
