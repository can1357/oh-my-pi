import { AsyncLocalStorage } from "node:async_hooks";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";

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
	AxSelectTextOptions,
	AxSnapshotOptions,
	AxTextSelection,
	CaptureRegion,
	DesktopCapabilities,
	DesktopCapture,
	DesktopDisplay,
	DesktopFocusReturn,
	DesktopPoint,
	DesktopScreenState,
	DesktopSessionOptions,
	DesktopWindow,
	OpenedApplication,
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
	type ComputerEscapeScope,
	type ComputerScreenshot,
	type ComputerSessionSnapshot,
	type ComputerWorkerInbound,
	type ComputerWorkerTransport,
	ESCAPE_AFTER_CALL_MESSAGE,
	ESCAPE_STOPPED_MESSAGE,
	type RunErrorPayload,
	SCREEN_LOCKED_CAPTURE_NOTE,
	type SettleReport,
	screenStateNotice,
	type ToolReply,
} from "./protocol";
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
	RefWindows,
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
import { describeWindowMiss } from "./window-miss";

/** A native input call; resolves to its takeover focus report when it took over. */
type InputCall = Promise<DesktopFocusReturn | null | void>;

/** Native desktop operations consumed by the script runtime. */
export interface NativeDesktopSession {
	readonly capabilities: DesktopCapabilities;
	/** Lock and display-sleep state, read without waiting behind queued native work. */
	readonly screenState: DesktopScreenState;
	/** Physical-Escape stops of takeover input under the session's key; host cancels never count. */
	readonly escapeStops: number;
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
	/** Keep the display awake from the next activity until `releaseDisplayAwake()`, not just for the grace period. */
	holdDisplayUntilReleased(): void;
	/** Let a turn's hold go now (activity outside a turn keeps its grace); later activity gets the grace again. */
	releaseDisplayAwake(): void;
	/** Sets when the current run ends, `remainingMs` from now; bounds how long input waits for the user to pause. */
	setRunDeadline(remainingMs: number): void;
	listApplications(options?: ApplicationQuery): Promise<Application[]>;
	openApplication(id: string, options?: ApplicationOpenOptions): Promise<OpenedApplication>;
	menuItems(target: string, path?: string[]): Promise<MenuItem[]>;
	menuSelect(target: string, path: string[]): Promise<void>;
	observe(
		target: string,
		caps?: { maxWidth?: number; maxHeight?: number },
		options?: AxOptions,
	): Promise<NativeObservation>;
	holdKeys(target: string, keys: string[], options: NativeHoldOptions): InputCall;
	holdMouse(target: string, x: number, y: number, options: NativeHoldOptions): InputCall;
	acquireControl(): Promise<DesktopControlState>;
	releaseControl(): void;
	controlState(): DesktopControlState;
	bringToCurrentSpace(windowId: string): Promise<void>;
	click(target: string, x: number, y: number, opts?: PointerOptions | null): InputCall;
	moveMouse(target: string, x: number, y: number, opts?: PointerOptions | null): InputCall;
	drag(target: string, points: DesktopPoint[], opts?: PointerOptions | null): InputCall;
	scroll(target: string, x: number, y: number, dx: number, dy: number, opts?: PointerOptions | null): InputCall;
	typeText(target: string, text: string, opts?: PointerOptions | null): InputCall;
	keyChord(target: string, keys: string[], opts?: PointerOptions | null): InputCall;
	raiseWindow(windowId: string): Promise<void>;
	axSnapshot(target: string, opts?: AxSnapshotOptions | null): Promise<{ text: string }>;
	axQuery(target: string, query: AxQuery): Promise<AxNode[]>;
	axElementAt(target: string, x: number, y: number): Promise<AxNode | null | undefined>;
	axFocused(): Promise<AxNode | null | undefined>;
	axNode(ref: string): Promise<AxNode>;
	axAttributes(ref: string): Promise<Array<[string, string]>>;
	axChildren(ref: string): Promise<AxNode[]>;
	axParent(ref: string): Promise<AxNode | null | undefined>;
	axPerform(ref: string, action: string, menu?: string[] | null): Promise<void>;
	axSetValue(ref: string, value: string): Promise<void>;
	axSelectText(ref: string, text: string, opts?: AxSelectTextOptions | null): Promise<AxTextSelection>;
	axFocus(ref: string): Promise<void>;
	axClick(ref: string, opts?: PointerOptions | null): InputCall;
	axType(ref: string, text: string, opts?: PointerOptions | null): InputCall;
	axKeyChord(ref: string, keys: string[], opts?: PointerOptions | null): InputCall;
	/** Resolves once `pids` have sent no counted accessibility notification for `quietMs`, or at `capMs`. */
	waitForUiQuiet(pids: number[], options?: UiQuietOptions | null): Promise<UiQuiet>;
	close(): Promise<void>;
}

/** Creates the native session co-located with the computer worker runtime. */
export type NativeDesktopSessionFactory = (
	options: DesktopSessionOptions,
) => NativeDesktopSession | Promise<NativeDesktopSession>;

type WindowFilter = { id?: string | number; app?: string; title?: string };
/** Window listings are session-transcript payload; `window()` lookups search the whole native list. */
const MAX_LISTED_WINDOWS = 48;

/** Whether input on this target is global (the desktop or one display) rather than addressed to a window. */
function isRootTarget(target: string): boolean {
	return target === "desktop" || target.startsWith("display:");
}

/**
 * Input settles once the apps it reached have sent no accessibility
 * notification for this long, measured from when the wait starts, and at the
 * latest after the cap; the read or input that follows sees them done
 * reacting.
 */
const SETTLE_QUIET_MS = 250;
const SETTLE_CAP_MS = 5_000;
/** Without an app whose notifications can be watched, input settles this long after it ended. */
const SETTLE_FIXED_MS = 500;
/** A report's reads stop this long before its request times out, so the report built so far returns. */
const SETTLE_HEADROOM_MS = 2_000;

type InputOptions = { takeover?: boolean };
type ScreenshotOptions = { silent?: boolean };
type ScreenshotResult = Pick<
	ComputerScreenshot,
	"path" | "width" | "height" | "coordinateWidth" | "coordinateHeight" | "region" | "screenLocked"
>;
type MenuOptions = { menu?: string[] };
type ClickOptions = InputOptions & MenuOptions & { button?: string; count?: number; modifiers?: string[] };
type DragOptions = InputOptions & { modifiers?: string[]; keys?: string[] };
type ScrollOptions = InputOptions & { dx?: number; dy?: number };
type AxOptions = Pick<AxSnapshotOptions, "all" | "maxDepth">;
type HoldOptions = Pick<NativeHoldOptions, "duration" | "takeover">;
type HoldMouseOptions = Pick<NativeHoldOptions, "duration" | "button" | "keys" | "takeover">;
type ObservationResult = ScreenshotResult & { ax: string; nodeCount: number; truncated: boolean };

type PendingTool = { resolve(value: unknown): void; reject(reason?: unknown): void };
interface ActiveRun {
	id: string;
	kind: "run" | "settle";
	/** Settles once the run has let go of the worker. */
	ended: Promise<void>;
	/** Escape stops the user acknowledged; any more stop the run. */
	acknowledgedEscapeStops: number;
	ac: AbortController;
	signal: AbortSignal;
	pendingTools: Map<string, PendingTool>;
	/** The agent turn the run belongs to, if any; a resume while it starts carries it into the turn that went on. */
	displayTurn?: number;
	/** The stop the user's Escape set on this run, reported as its result. */
	escapeStop?: ToolError;
}

/** The run context: the cell a desktop call belongs to, and the signal it runs under. */
interface ComputerRunContext {
	signal: AbortSignal;
	cell: CellKey;
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

/**
 * Native pointer options, each read once from the model's object, so the
 * `refuse` check and the native call see the same `takeover`.
 */
function pointerOptions(options?: ClickOptions | DragOptions | InputOptions): PointerOptions {
	const { button, count, modifiers, keys, menu, takeover }: Partial<ClickOptions & DragOptions> = options ?? {};
	const mapped: PointerOptions = {};
	if (button !== undefined) mapped.button = button;
	if (count !== undefined) mapped.count = count;
	if (modifiers !== undefined) mapped.modifiers = modifiers;
	if (keys !== undefined) mapped.keys = keys;
	if (menu !== undefined) mapped.menu = menuOption({ menu });
	if (takeover !== undefined) mapped.takeover = takeover;
	return mapped;
}

/** The item path of a `menu` option, checked before anything is sent. */
function menuOption(options?: MenuOptions): string[] | undefined {
	if (options?.menu === undefined) return undefined;
	validateKeys(options.menu, "menu path");
	return options.menu;
}

/** Whether `press`'s first argument is its options rather than a chord. */
function isMenuOptions(value: unknown): value is MenuOptions {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chordKeys(chord: unknown): string[] {
	const keys =
		typeof chord === "string"
			? chord
					.split("+")
					.map(key => key.trim())
					.filter(Boolean)
			: chord;
	if (!isStringList(keys) || keys.length === 0) {
		throw new ToolError(
			`press(chord) requires a key chord such as "cmd+shift+p" or ["cmd", "shift", "p"], got ${describeArgument(chord)}`,
		);
	}
	return keys;
}

/** Keys and menu titles share one rule: an array of strings, none blank. */
function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string" && item.trim() !== "");
}

function validateKeys(value: unknown, label: string): asserts value is string[] {
	if (!isStringList(value) || value.length === 0) {
		throw new ToolError(`${label} requires a non-empty array of non-empty strings`);
	}
}

function describeArgument(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return typeof value === "string" ? JSON.stringify(value) : typeof value;
}

/** Names the helper and parameter in place of the native addon's conversion error, which names neither. */
function validateString(value: unknown, call: string, options?: { nonEmpty?: boolean }): asserts value is string {
	if (typeof value === "string" && (!options?.nonEmpty || value.trim())) return;
	throw new ToolError(
		`${call} requires ${options?.nonEmpty ? "a non-empty string" : "a string"}, got ${describeArgument(value)}`,
	);
}

/** A menu path is one title, an array of titles, or the titles as separate arguments. */
function menuPath(method: string, args: unknown[], options?: { allowEmpty?: boolean }): string[] {
	const path: unknown[] = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
	if (isStringList(path) && (options?.allowEmpty || path.length > 0)) return path;
	let got = "no path";
	if (args.length > 0) {
		const shown = args.length === 1 ? args[0] : args;
		try {
			got = JSON.stringify(shown) ?? describeArgument(shown);
		} catch {
			// BigInt and cyclic values do not serialize; the type still tells the caller what it passed.
			got = describeArgument(shown);
		}
	}
	throw new ToolError(
		`${method} requires a menu path of non-empty titles: one title ("File"), an array (["File", "Export…"]), or separate titles ("File", "Export…"); got ${got}`,
	);
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

/** Native options for the tool's own takeover rerun of a refused background call. */
type Fallback = { takeover: true; returnFocus: true };
const FALLBACK: Fallback = { takeover: true, returnFocus: true };
const BACKGROUND_UNAVAILABLE = "BackgroundUnavailable: ";
/** A refusal's closing "nothing was sent", true of the refused background attempt only. */
const UNSENT_CLAUSE = /(?:;|,? so) (?:nothing|no input) was sent$/;

/** A `BackgroundUnavailable` refusal sent nothing: native raises it before any input, and no takeover rerun ran. */
function refusedUnsent(error: unknown): boolean {
	return (
		error instanceof ToolError &&
		error.message.startsWith(BACKGROUND_UNAVAILABLE) &&
		!error.message.includes(" fell back to takeover because ")
	);
}
const RAISE_ROUTE = "Background input and screenshots reach a covered window, so no raise is needed.";
const OPEN_ROUTE = "Use press() on a button that does the same, or tell the user the step needs their screen.";

/**
 * Under `computer.backgroundFallback: "refuse"` the user's setting beats the
 * model: a call that would bring an application forward or drive the user's
 * own pointer or keyboard is refused before anything is sent. `effect` says
 * what the call would do; `route` names the background way to the same end.
 */
function refuseForeground(
	context: ComputerRunContext,
	call: string,
	effect: string,
	route: string,
	target?: string,
): void {
	if (context.snapshot.backgroundFallback !== "refuse") return;
	const to = target === undefined ? "" : ` to ${target}`;
	throw new ToolError(
		`${BACKGROUND_UNAVAILABLE}${call} would ${effect}, and the user's computer.backgroundFallback setting is "refuse", which keeps the agent in the background; nothing was sent${to}. ${route}`,
	);
}

const MENU_ROUTE =
	"Use the window's menu bar with win.menu.select(...), or an element action such as press(), instead.";
/** AX roles of the controls that open a menu when pressed, as native's `open_menu` reads them. */
const MENU_CONTROL_ROLES = ["AXPopUpButton", "AXMenuButton"];
const MENU_CONTROL_ROUTE =
	"Its options are chosen only through that menu: use the window's menu bar with win.menu.select(...) if it has the same command, or tell the user the step needs their screen.";

/**
 * Under `refuse`, a macOS call that opens a menu is refused before anything is
 * sent: `WindowServer` sends the user's keys to an open menu, so even one
 * closed at once costs the user about a keystroke.
 */
function refuseMenu(
	session: NativeDesktopSession,
	context: ComputerRunContext,
	call: string,
	menu: string,
	route: string,
	target: string,
): void {
	if (context.snapshot.backgroundFallback !== "refuse" || session.capabilities.backend !== "quartz") return;
	refuseForeground(context, call, `open ${menu}, which takes the user's keyboard while it is open`, route, target);
}

/** `refuseMenu` for an element call that opens the menu of a popup button or menu button. */
function refuseControlMenu(
	session: NativeDesktopSession,
	context: ComputerRunContext,
	call: string,
	role: string,
	target: string,
): void {
	if (!MENU_CONTROL_ROLES.includes(role)) return;
	refuseMenu(session, context, `${call} on an ${role}`, "its menu", MENU_CONTROL_ROUTE, target);
}

/**
 * `refuseMenu` for pointer input: a secondary press (the right button, or the
 * left with Control held, as native's `may_open_context_menu` reads it) opens
 * a context menu in most views, a primary click on a popup button or menu
 * button (`role`, for an element click) opens its menu, and a `menu` option
 * names an item of the menu the press opens.
 */
function refusePointerMenu(
	session: NativeDesktopSession,
	context: ComputerRunContext,
	method: string,
	{ button, modifiers, keys, menu }: PointerOptions,
	target: string,
	role?: string,
): void {
	const pressed = typeof button === "string" ? button.trim().toLowerCase() : "left";
	const control = [modifiers, keys].some(
		list =>
			Array.isArray(list) &&
			list.some(
				entry =>
					typeof entry === "string" &&
					entry.split("+").some(key => ["ctrl", "control"].includes(key.trim().toLowerCase())),
			),
	);
	if (pressed === "right") {
		refuseMenu(session, context, `${method} with button: "right"`, "a context menu", MENU_ROUTE, target);
	} else if (pressed === "left" && control) {
		refuseMenu(session, context, `${method} with Control held`, "a context menu", MENU_ROUTE, target);
	} else if (pressed === "left" && role !== undefined) {
		refuseControlMenu(session, context, method, role, target);
	}
	if (menu !== undefined) refuseMenu(session, context, `${method} with menu`, "a menu", MENU_ROUTE, target);
}

/**
 * Under `refuse` on macOS, asks native to refuse a background click that lands
 * on a popup button or menu button, or a hold or drag that starts on one, whose
 * menu would take the user's keyboard; only native can tell what a pixel lands
 * on.
 */
function refuseMenuPress(
	session: NativeDesktopSession,
	context: ComputerRunContext,
	native: { refuseMenu?: boolean },
): void {
	if (context.snapshot.backgroundFallback === "refuse" && session.capabilities.backend === "quartz") {
		native.refuseMenu = true;
	}
}

/** Native's `refuseMenu` refusal; its first group is the press, as `refuseMenu`'s `call`. */
const MENU_CONTROL_REFUSAL =
	/^BackgroundUnavailable: (the .+, which (?:lands|starts) on a menu button or popup button,) would open its menu; nothing was sent$/;

/** App names by pid from the window list, empty when the listing fails. */
async function appNames(session: NativeDesktopSession, signal: AbortSignal): Promise<Map<number, string>> {
	try {
		const windows = await nativeCall(signal, () => session.listWindows());
		return new Map(windows.flatMap(window => (window.pid === undefined ? [] : [[window.pid, window.app]])));
	} catch (error) {
		if (error instanceof ToolAbortError) throw error;
		return new Map();
	}
}

/**
 * Says where focus ended after a fallback takeover, from native's
 * WindowServer reading taken when the takeover finished.
 */
async function focusReport(
	session: NativeDesktopSession,
	signal: AbortSignal,
	report: DesktopFocusReturn | null | void,
	target?: number,
): Promise<string> {
	if (!report || report.frontPid == null) return "focus was not confirmed afterwards";
	const { frontPid, previousPid, handedBack } = report;
	const names = await appNames(session, signal);
	const name = (pid: number) => names.get(pid) ?? `pid ${pid}`;
	const front = name(frontPid);
	if (previousPid == null) return `focus is on ${front}`;
	if (frontPid === previousPid) return handedBack ? `focus returned to ${front}` : `focus is on ${front}`;
	const user = name(previousPid);
	if (handedBack) return `focus was handed back to ${user}, but ${front} is now front`;
	if (frontPid === target) return `focus stayed on ${front}; it did not return to ${user}`;
	return `focus is on ${front}; it did not return to ${user}`;
}

/**
 * Sends one window input call. A model-supplied `takeover: true` is refused
 * under `computer.backgroundFallback: "refuse"` before anything waits or is
 * sent; otherwise the call, its takeover rerun included, is one input to
 * `to` for `observer`.
 */
async function sendInput(
	session: NativeDesktopSession,
	observer: InputObserver,
	context: ComputerRunContext,
	method: string,
	takeover: boolean | undefined,
	send: (fallback?: Fallback) => InputCall,
	to: InputTarget,
	target?: number,
): Promise<void> {
	if (takeover === true) {
		refuseForeground(
			context,
			`${method} with takeover: true`,
			"bring its application to the front and take the user's keyboard and pointer",
			"Call it without takeover: window input runs in the background.",
		);
	}
	await observer.input(context, to, () => deliverInput(session, context, method, takeover, send, target));
}

/**
 * When the background route throws `BackgroundUnavailable`, which native
 * raises only before any of the call's input was sent (a user who came to the
 * target gets `UserIntervened`, which is never rerun), and the call did not
 * set `takeover`, the setting decides: `takeover` reruns that call in
 * takeover, handing focus back to the user's app, and reports it in the run
 * output; `refuse` fails without taking over.
 */
async function deliverInput(
	session: NativeDesktopSession,
	context: ComputerRunContext,
	method: string,
	takeover: boolean | undefined,
	send: (fallback?: Fallback) => InputCall,
	target?: number,
): Promise<void> {
	try {
		await nativeCall(context.signal, () => send());
		return;
	} catch (error) {
		if (!(error instanceof ToolError) || !error.message.startsWith(BACKGROUND_UNAVAILABLE)) throw error;
		const refuse = context.snapshot.backgroundFallback === "refuse";
		// Native refuses a menu control's press only for the setting, so it says so
		// even when the call set `takeover: false`.
		const control = refuse ? MENU_CONTROL_REFUSAL.exec(error.message) : null;
		if (control)
			refuseForeground(
				context,
				control[1],
				"open its menu, which takes the user's keyboard while it is open",
				MENU_CONTROL_ROUTE,
			);
		if (takeover !== undefined) throw error;
		const reason = error.message.slice(BACKGROUND_UNAVAILABLE.length);
		const why = reason.replace(UNSENT_CLAUSE, "");
		if (refuse) {
			throw new ToolError(
				`${error.message}; the user's computer.backgroundFallback setting is "refuse", which keeps the agent in the background, so no takeover happened`,
			);
		}
		if (!session.capabilities.takeover) {
			throw new ToolError(`${error.message}; this desktop backend has no takeover, so no takeover happened`);
		}
		let report: DesktopFocusReturn | null | void;
		try {
			report = await nativeCall(context.signal, () => send(FALLBACK));
		} catch (rerun) {
			if (rerun instanceof ToolAbortError) throw rerun;
			const message = rerun instanceof Error ? rerun.message : String(rerun);
			// Keep the rerun's error code in front, as every computer error has it.
			const [, code, detail] = /^(\w+): ([\s\S]*)$/.exec(message) ?? [];
			const failed = code === undefined ? message : detail;
			throw new ToolError(
				`${code === undefined ? "" : `${code}: `}${method} fell back to takeover because ${why}, and the takeover failed: ${failed}`,
			);
		}
		const focus = await focusReport(session, context.signal, report, target);
		context.output.push({
			type: "text",
			text: `${method} ran in takeover because ${why}; the input was delivered, and ${focus}`,
		});
	}
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
	readonly #observer: InputObserver;
	/** The window the element was read from, when known: input on it waits for that window's app. */
	readonly #window?: InputWindow;

	constructor(
		session: NativeDesktopSession,
		getContext: RunContextAccessor,
		observer: InputObserver,
		node: AxNode,
		window: InputWindow | undefined,
	) {
		this.#session = session;
		this.#getContext = getContext;
		this.#observer = observer;
		this.#window = window;
		this.ref = node.ref;
		this.role = node.role;
		this.nativeRole = node.nativeRole;
		this.title = node.title;
		this.description = node.description;
		this.enabled = node.enabled;
		this.focused = node.focused;
		this.childCount = node.childCount;
	}

	/** A read of this element, once earlier input has settled. */
	async #read<T>(call: () => Promise<T>): Promise<T> {
		const context = this.#getContext();
		await this.#observer.settle(context.signal);
		return await this.#observer.read(context, this.#window, call);
	}

	/** A direct AX input on this element: one input to its window. */
	async #input<T>(context: ComputerRunContext, call: () => Promise<T>): Promise<T> {
		return await this.#observer.input(context, { window: this.#window }, () => nativeCall(context.signal, call));
	}

	async value(): Promise<string | undefined> {
		return (await this.#read(() => this.#session.axNode(this.ref))).value;
	}

	async setValue(value: string): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "setValue");
		validateString(value, "setValue(value)");
		// Native chooses a popup's option by opening its menu and pressing the item.
		if (this.nativeRole === "AXPopUpButton")
			refuseControlMenu(this.#session, context, "setValue()", this.nativeRole, `element ${this.ref}`);
		await this.#input(context, () => this.#session.axSetValue(this.ref, value));
	}

	async selectText(text: string, options?: AxSelectTextOptions): Promise<AxTextSelection> {
		const context = this.#getContext();
		guardRun(context, "selectText");
		validateString(text, "selectText(text)");
		return await this.#input(context, () => this.#session.axSelectText(this.ref, text, options));
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

	async perform(action: string, options?: MenuOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "perform");
		validateString(action, "perform(action)", { nonEmpty: true });
		// The names native `axPerform` runs as `AXRaise` (its `action_name` mapping).
		if (action.trim().toLowerCase() === "raise" || action === "AXRaise") {
			refuseForeground(
				context,
				`perform(${JSON.stringify(action)})`,
				"bring the window's application to the front",
				RAISE_ROUTE,
				`element ${this.ref}`,
			);
		}
		// The names native `axPerform` runs as `AXOpen` (`action_name` prefixes "AX"
		// to any other name). On an item in Chrome's Open panel it brings the
		// panel's application to the front, even when the action fails, and it
		// stays there.
		if (this.#session.capabilities.backend === "quartz" && (action === "AXOpen" || action === "Open")) {
			refuseForeground(
				context,
				`perform(${JSON.stringify(action)})`,
				"bring the window's application to the front, as it can on an item in an Open panel even when the action fails",
				OPEN_ROUTE,
				`element ${this.ref}`,
			);
		}
		const menu = menuOption(options);
		// The names native `axPerform` runs as `AXShowMenu`, which opens the element's context menu.
		if (["showmenu", "show_menu"].includes(action.trim().toLowerCase()) || action === "AXShowMenu") {
			refuseMenu(
				this.#session,
				context,
				`perform(${JSON.stringify(action)})`,
				"a context menu",
				MENU_ROUTE,
				`element ${this.ref}`,
			);
		}
		if (menu !== undefined)
			refuseMenu(this.#session, context, "perform with menu", "a menu", MENU_ROUTE, `element ${this.ref}`);
		// The names native `axPerform` runs as `AXPress`.
		if (action.trim().toLowerCase() === "press" || action === "AXPress") {
			refuseControlMenu(
				this.#session,
				context,
				`perform(${JSON.stringify(action)})`,
				this.nativeRole,
				`element ${this.ref}`,
			);
		}
		await this.#input(context, () => this.#session.axPerform(this.ref, action, menu));
	}

	/**
	 * Without a chord, the element's native press action, choosing `menu`'s item in the menu it opens;
	 * with one, that chord typed into the element.
	 */
	async press(chord?: string | string[] | MenuOptions, options?: InputOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "press");
		if (chord === undefined || isMenuOptions(chord)) {
			const menu = menuOption(chord);
			if (menu !== undefined)
				refuseMenu(this.#session, context, "press with menu", "a menu", MENU_ROUTE, `element ${this.ref}`);
			refuseControlMenu(this.#session, context, "press()", this.nativeRole, `element ${this.ref}`);
			await this.#input(context, () => this.#session.axPerform(this.ref, "press", menu));
			return;
		}
		const keys = chordKeys(chord);
		const native = pointerOptions(options);
		await sendInput(
			this.#session,
			this.#observer,
			context,
			"press",
			native.takeover,
			fallback => this.#session.axKeyChord(this.ref, keys, { ...native, ...fallback }),
			{ window: this.#window },
		);
	}

	async type(text: string, options?: InputOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "type");
		validateString(text, "type(text)");
		const native = pointerOptions(options);
		await sendInput(
			this.#session,
			this.#observer,
			context,
			"type",
			native.takeover,
			fallback => this.#session.axType(this.ref, text, { ...native, ...fallback }),
			{ window: this.#window },
		);
	}

	async click(options?: ClickOptions): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "click");
		const native = pointerOptions(options);
		refusePointerMenu(this.#session, context, "click", native, `element ${this.ref}`, this.nativeRole);
		refuseMenuPress(this.#session, context, native);
		await sendInput(
			this.#session,
			this.#observer,
			context,
			"click",
			native.takeover,
			fallback => this.#session.axClick(this.ref, { ...native, ...fallback }),
			{ window: this.#window },
		);
	}

	async doubleClick(options?: Omit<ClickOptions, "count">): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "doubleClick");
		const native = { ...pointerOptions(options), count: 2 };
		refusePointerMenu(this.#session, context, "doubleClick", native, `element ${this.ref}`, this.nativeRole);
		refuseMenuPress(this.#session, context, native);
		await sendInput(
			this.#session,
			this.#observer,
			context,
			"doubleClick",
			native.takeover,
			fallback => this.#session.axClick(this.ref, { ...native, ...fallback }),
			{ window: this.#window },
		);
	}

	async focus(): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "focus");
		// macOS sets AXFocused inside the app without activating it; Windows
		// (UIA SetFocus) and Linux (AT-SPI grab_focus) move keyboard focus.
		if (this.#session.capabilities.backend !== "quartz") {
			refuseForeground(
				context,
				"focus()",
				"move the user's keyboard focus to this element",
				"Use setValue(), press() or another AX action, which need no focus.",
				`element ${this.ref}`,
			);
		}
		await this.#input(context, () => this.#session.axFocus(this.ref));
	}

	async parent(): Promise<El | null> {
		const node = await this.#read(() => this.#session.axParent(this.ref));
		return node ? this.#observer.element(this.#getContext, node, this.#window) : null;
	}

	async children(): Promise<El[]> {
		return (await this.#read(() => this.#session.axChildren(this.ref))).map(node =>
			this.#observer.element(this.#getContext, node, this.#window),
		);
	}
}

const ELEMENT_FIELDS = ["ref", "role", "nativeRole", "title", "description", "enabled", "focused", "childCount"];

/** `find()`'s array answers element field reads and calls with how to pick one, instead of `undefined` or "is not a function". */
function foundElements(elements: El[]): El[] {
	const pickOne = (member: string): TypeError =>
		new TypeError(
			`find() returns an array (length ${elements.length}), not one element, so it has no ${member}; pick one first: const [el] = await win.find(query)`,
		);
	for (const method of Object.getOwnPropertyNames(El.prototype)) {
		if (method === "constructor") continue;
		Object.defineProperty(elements, method, {
			value: () => {
				throw pickOne(`${method}()`);
			},
		});
	}
	for (const field of ELEMENT_FIELDS) {
		Object.defineProperty(elements, field, {
			get: () => {
				throw pickOne(field);
			},
		});
	}
	return elements;
}

/** `await ref("e5")` resolves the element; its methods chain on the handle and await the lookup first. */
class ElRef implements PromiseLike<El> {
	readonly ref: string;
	readonly #getContext: RunContextAccessor;
	readonly #lookup: () => Promise<El>;
	#element?: Promise<El>;

	constructor(ref: string, getContext: RunContextAccessor, lookup: () => Promise<El>) {
		this.ref = ref;
		this.#getContext = getContext;
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
		// Reject a read-only run or a bad argument before the ref lookup reaches the native addon.
		guardRun(this.#getContext(), "setValue");
		validateString(value, "setValue(value)");
		await (await this.#resolve()).setValue(value);
	}

	async selectText(text: string, options?: AxSelectTextOptions): Promise<AxTextSelection> {
		guardRun(this.#getContext(), "selectText");
		validateString(text, "selectText(text)");
		return (await this.#resolve()).selectText(text, options);
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

	async perform(action: string, options?: MenuOptions): Promise<void> {
		guardRun(this.#getContext(), "perform");
		validateString(action, "perform(action)", { nonEmpty: true });
		await (await this.#resolve()).perform(action, options);
	}

	async press(chord?: string | string[] | MenuOptions, options?: InputOptions): Promise<void> {
		guardRun(this.#getContext(), "press");
		if (chord !== undefined && !isMenuOptions(chord)) chordKeys(chord);
		await (await this.#resolve()).press(chord, options);
	}

	async type(text: string, options?: InputOptions): Promise<void> {
		guardRun(this.#getContext(), "type");
		validateString(text, "type(text)");
		await (await this.#resolve()).type(text, options);
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

	/** This window, or undefined for the desktop or a display. */
	get #window(): InputWindow | undefined {
		return isRootTarget(this.id) ? undefined : { id: this.id, pid: this.pid };
	}

	/** Where input on this handle goes; desktop and display input carries its pointer `point`, if any. */
	#to(point?: { x: number; y: number }): InputTarget {
		const window = this.#window;
		return window ? { window } : { root: this.id, point };
	}

	/**
	 * `guardRun` for an input call. Under `refuse`, input to the desktop or a
	 * display target is refused: it drives the user's own pointer and keyboard.
	 */
	#guardInput(method: string): ComputerRunContext {
		const context = this.#getContext();
		guardRun(context, method);
		if (isRootTarget(this.id)) {
			refuseForeground(
				context,
				`${method} on the ${this.id} target`,
				"drive the user's own pointer and keyboard",
				"Send it to a window handle from computer.window(...), which takes input in the background.",
			);
		}
		return context;
	}

	async click(x: number, y: number, options?: ClickOptions): Promise<void> {
		const context = this.#guardInput("click");
		const native = pointerOptions(options);
		refusePointerMenu(this.#session, context, "click", native, `window ${this.id}`);
		refuseMenuPress(this.#session, context, native);
		await sendInput(
			this.#session,
			this.#observer,
			context,
			"click",
			native.takeover,
			fallback => this.#session.click(this.id, x, y, { ...native, ...fallback }),
			this.#to({ x, y }),
			this.pid,
		);
	}

	async doubleClick(x: number, y: number, options?: Omit<ClickOptions, "count">): Promise<void> {
		const context = this.#guardInput("doubleClick");
		const native = { ...pointerOptions(options), count: 2 };
		refusePointerMenu(this.#session, context, "doubleClick", native, `window ${this.id}`);
		refuseMenuPress(this.#session, context, native);
		await sendInput(
			this.#session,
			this.#observer,
			context,
			"doubleClick",
			native.takeover,
			fallback => this.#session.click(this.id, x, y, { ...native, ...fallback }),
			this.#to({ x, y }),
			this.pid,
		);
	}

	async move(x: number, y: number, options?: InputOptions): Promise<void> {
		const context = this.#guardInput("move");
		const native = pointerOptions(options);
		await sendInput(
			this.#session,
			this.#observer,
			context,
			"move",
			native.takeover,
			fallback => this.#session.moveMouse(this.id, x, y, { ...native, ...fallback }),
			this.#to({ x, y }),
			this.pid,
		);
	}

	async drag(points: Array<[number, number]>, options?: DragOptions): Promise<void> {
		const context = this.#guardInput("drag");
		const native = pointerOptions(options);
		refusePointerMenu(this.#session, context, "drag", native, `window ${this.id}`);
		refuseMenuPress(this.#session, context, native);
		const start = Array.isArray(points) ? points[0] : undefined;
		await sendInput(
			this.#session,
			this.#observer,
			context,
			"drag",
			native.takeover,
			fallback =>
				this.#session.drag(
					this.id,
					points.map(([x, y]) => ({ x, y })),
					{ ...native, ...fallback },
				),
			this.#to(Array.isArray(start) ? { x: start[0], y: start[1] } : undefined),
			this.pid,
		);
	}

	async scroll(x: number, y: number, options: ScrollOptions = {}): Promise<void> {
		const context = this.#guardInput("scroll");
		const dx = options.dx ?? 0;
		const dy = options.dy ?? 0;
		const native = pointerOptions(options);
		await sendInput(
			this.#session,
			this.#observer,
			context,
			"scroll",
			native.takeover,
			fallback => this.#session.scroll(this.id, x, y, dx, dy, { ...native, ...fallback }),
			this.#to({ x, y }),
			this.pid,
		);
	}

	async type(text: string, options?: InputOptions): Promise<void> {
		const context = this.#guardInput("type");
		validateString(text, "type(text)");
		const native = pointerOptions(options);
		await sendInput(
			this.#session,
			this.#observer,
			context,
			"type",
			native.takeover,
			fallback => this.#session.typeText(this.id, text, { ...native, ...fallback }),
			this.#to(),
			this.pid,
		);
	}

	async press(chord: string | string[], options?: InputOptions): Promise<void> {
		const context = this.#guardInput("press");
		const keys = chordKeys(chord);
		const native = pointerOptions(options);
		await sendInput(
			this.#session,
			this.#observer,
			context,
			"press",
			native.takeover,
			fallback => this.#session.keyChord(this.id, keys, { ...native, ...fallback }),
			this.#to(),
			this.pid,
		);
	}

	async holdKeys(keys: string[], options: HoldOptions): Promise<void> {
		const context = this.#guardInput("holdKeys");
		// One read of each option, so the `refuse` check and the native call agree.
		const { duration, takeover } = { ...options };
		validateHold({ duration, takeover });
		validateKeys(keys, "keys");
		await sendInput(
			this.#session,
			this.#observer,
			context,
			"holdKeys",
			takeover,
			fallback => this.#session.holdKeys(this.id, keys, { duration, takeover, ...fallback }),
			this.#to(),
			this.pid,
		);
	}

	async holdMouse(x: number, y: number, options: HoldMouseOptions): Promise<void> {
		const context = this.#guardInput("holdMouse");
		const { duration, button, keys, takeover } = { ...options };
		validateHold({ duration, takeover });
		if (keys !== undefined) validateKeys(keys, "keys");
		refusePointerMenu(this.#session, context, "holdMouse", { button, keys }, `window ${this.id}`);
		const native: NativeHoldOptions = { duration, button, keys, takeover };
		refuseMenuPress(this.#session, context, native);
		await sendInput(
			this.#session,
			this.#observer,
			context,
			"holdMouse",
			takeover,
			fallback => this.#session.holdMouse(this.id, x, y, { ...native, ...fallback }),
			this.#to({ x, y }),
			this.pid,
		);
	}

	async observe(options?: ScreenshotOptions & AxOptions): Promise<ObservationResult> {
		const context = this.#getContext();
		await this.#observer.settle(context.signal);
		// Sent now, so an input sent after it does not make this a post-input read.
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
		const window = this.#window;
		const text = result.accessibility.text;
		if (window) this.#observer.ledger.recordRead(context.cell, window, text, axReadOptions(options), issued);
		else this.#observer.noteRootCapture(this.id, result.capture.displays);
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
			items: async (...path: string[] | [path?: string | string[]]): Promise<MenuItem[]> => {
				const context = this.#getContext();
				// On macOS the read makes the window key first, so it is not inspection-only.
				guardRun(context, "menu.items");
				// An omitted path, or one passed on as `undefined`, lists the top-level menus.
				const segments =
					path.length <= 1 && path[0] === undefined
						? undefined
						: menuPath("menu.items", path, { allowEmpty: true });
				return await this.#observer.input(context, this.#to(), () =>
					nativeCall(context.signal, () => this.#session.menuItems(this.id, segments)),
				);
			},
			select: async (...path: [string, ...string[]] | [string[]]): Promise<void> => {
				const context = this.#getContext();
				guardRun(context, "menu.select");
				const segments = menuPath("menu.select", path);
				await this.#observer.input(context, this.#to(), () =>
					nativeCall(context.signal, () => this.#session.menuSelect(this.id, segments)),
				);
			},
		};
	}

	async bringToCurrentSpace(): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "bringToCurrentSpace");
		await this.#observer.input(context, this.#to(), () =>
			nativeCall(context.signal, () => this.#session.bringToCurrentSpace(this.id)),
		);
	}

	async raise(): Promise<void> {
		const context = this.#getContext();
		guardRun(context, "raise");
		refuseForeground(
			context,
			"raise()",
			"bring the window's application to the front",
			RAISE_ROUTE,
			`window ${this.id}`,
		);
		await this.#observer.input(context, this.#to(), () =>
			nativeCall(context.signal, () => this.#session.raiseWindow(this.id)),
		);
	}

	async ax(options?: AxOptions): Promise<string> {
		const { signal, cell } = this.#getContext();
		await this.#observer.settle(signal);
		// Sent now, so an input sent after it does not make this a post-input read.
		const issued = this.#observer.ledger.sequence;
		const text = (await nativeCall(signal, () => this.#session.axSnapshot(this.id, options))).text;
		const window = this.#window;
		if (window) this.#observer.ledger.recordRead(cell, window, text, axReadOptions(options), issued);
		return text;
	}

	async find(query: AxQuery): Promise<El[]> {
		const { signal } = this.#getContext();
		await this.#observer.settle(signal);
		return foundElements(
			(await nativeCall(signal, () => this.#session.axQuery(this.id, query))).map(node =>
				this.#observer.element(this.#getContext, node, this.#window),
			),
		);
	}

	ref(ref: string): ElRef {
		validateString(ref, "ref(ref)", { nonEmpty: true });
		return new ElRef(ref, this.#getContext, async () => {
			const window = this.#observer.refs.windowOf(ref) ?? this.#window;
			const node = await this.#observer.read(this.#getContext(), window, () => this.#session.axNode(ref));
			return this.#observer.element(this.#getContext, node, window);
		});
	}
}

/** The comparable part of `ax()` options: what a read-back must repeat to match the model's tree. */
function axReadOptions(options: AxOptions | undefined): AxReadOptions {
	return { all: options?.all, maxDepth: options?.maxDepth };
}

/**
 * Where an input goes: a window (unknown for an element whose window was
 * never read), or the desktop or a display (`root`) with, for pointer input,
 * the point in pixels of that target's latest screenshot.
 */
type InputTarget = { window?: InputWindow } | { root: string; point?: { x: number; y: number } };

/** Input since the UI last settled: the processes it reached, the cells that sent it, and when it ended. */
interface Unsettled {
	pids: Set<number>;
	cells: Set<CellKey>;
	endedAt: number;
	/** Inputs that joined this record; one that turns out to have sent nothing leaves. */
	inputs: number;
}

/** Makes reads and input wait until the apps earlier input reached have gone quiet, and records them in the ledger. */
class InputObserver {
	readonly refs = new RefWindows();
	readonly ledger = new ObservationLedger(this.refs);
	readonly #session: NativeDesktopSession;
	/** Unguarded, for the window list read beside an input: it must not count as a call the user's Escape came after. */
	readonly #unguarded: NativeDesktopSession;
	/** Display regions of each root target's latest screenshot, whose pixels its pointer input is given in. */
	readonly #rootDisplays = new Map<string, DesktopDisplay[]>();
	/** Input since the UI last settled; undefined once settled. */
	#unsettled?: Unsettled;
	/** The wait in progress: every call issued meanwhile waits for it too. */
	#settling?: Promise<SettleOutcome>;
	/** Settles once the latest input has dispatched: inputs reach the native session in call order. */
	#dispatched: Promise<void> = Promise.resolve();
	/** Inputs still being sent: their wait is owed however old the first of them is. */
	#sending = 0;

	constructor(session: NativeDesktopSession, unguarded: NativeDesktopSession) {
		this.#session = session;
		this.#unguarded = unguarded;
	}

	/** A desktop or display screenshot was taken: that target's pointer input is given in its pixels. */
	noteRootCapture(target: string, displays: DesktopDisplay[]): void {
		this.#rootDisplays.set(target, displays);
	}

	/** Wrap a node read from `window`, remembering that window for its ref. */
	element(getContext: RunContextAccessor, node: AxNode, window: InputWindow | undefined): El {
		if (window) this.refs.record(window, [node.ref]);
		return new El(this.#session, getContext, this, node, window);
	}

	/** A read addressed by ref. When it fails, the cell's report shows the ref's window. */
	async read<T>(context: ComputerRunContext, window: InputWindow | undefined, call: () => Promise<T>): Promise<T> {
		try {
			return await nativeCall(context.signal, call);
		} catch (error) {
			if (window && !(error instanceof ToolAbortError)) this.ledger.noteFailure(context.cell, window);
			throw error;
		}
	}

	/**
	 * Wait until the apps that input since the last settle reached have gone
	 * quiet. Every read pays this first and every input before it is sent, so
	 * nothing reads or acts on a half-drawn UI; calls issued during a wait
	 * share it. Without a process to watch, the wait is a fixed time after the
	 * input. Input sent during a wait is waited for next, and a wait that is
	 * cancelled leaves its input owed. Input that ended the cap ago or more
	 * owes nothing: the wait would give its apps no longer than they have had.
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
			if (this.#sending === 0 && Date.now() - unsettled.endedAt >= SETTLE_CAP_MS) continue;
			const settling = this.#wait(unsettled, signal);
			this.#settling = settling;
			let outcome: SettleOutcome;
			try {
				outcome = await settling;
			} catch (error) {
				this.#restore(unsettled);
				throw error;
			} finally {
				this.#settling = undefined;
			}
			this.ledger.noteOutcome(unsettled.cells, outcome);
		}
	}

	/** Input a wait did not settle is owed again, with any input sent since. */
	#restore(unsettled: Unsettled): void {
		const current = this.#unsettled;
		if (!current) {
			this.#unsettled = unsettled;
			return;
		}
		for (const pid of unsettled.pids) current.pids.add(pid);
		for (const cell of unsettled.cells) current.cells.add(cell);
		current.endedAt = Math.max(current.endedAt, unsettled.endedAt);
		current.inputs += unsettled.inputs;
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
	 * Dispatch one input once earlier input has settled, and owe a wait for
	 * the process it reaches. Root input reaches the topmost window under its
	 * point, or the focused window for keys; its process stays unknown when
	 * that window is; a key also owes the app focused after it, which it may
	 * have activated. `opens` names what an app launch opened (process, window),
	 * which the next call waits for too. A refusal that sent nothing owes nothing.
	 * Concurrent inputs dispatch in call order.
	 */
	async input<T>(
		{ signal, cell }: ComputerRunContext,
		to: InputTarget,
		dispatch: () => Promise<T>,
		opens?: (result: T) => { pid?: number; window?: InputWindow },
	): Promise<T> {
		const previous = this.#dispatched;
		const { promise: dispatched, resolve: markDispatched } = Promise.withResolvers<void>();
		this.#dispatched = dispatched;
		let unsettled: Unsettled | undefined;
		let unsent = false;
		let window = "window" in to ? to.window : undefined;
		try {
			await previous;
			// A cancelled cell's state is discarded; input it still sends must not record more.
			throwIfAborted(signal);
			// Keys and clicks sent while an app still draws what the last input opened land on the wrong control.
			await this.settle(signal);
			let roster: Promise<DesktopWindow[] | undefined> | undefined;
			if (this.ledger.wantsRoster(cell)) {
				const claim = this.ledger.claimRoster(cell);
				// Queued before the input, so native lists the windows as they were before it.
				roster = this.#optional(signal, () => this.#unguarded.listWindows());
				roster.then(claim.resolve, () => claim.resolve(undefined));
			}
			if ("root" in to) {
				const at = to.point && desktopPoint(this.#rootDisplays.get(to.root) ?? [], to.point);
				if (!to.point || at) window = await this.windowReached(signal, at, await roster);
			}
			let pid: number | undefined;
			if (opens) this.ledger.noteAppInput(cell);
			else pid = this.ledger.noteInput(cell, window);
			unsettled = this.#unsettled ??= { pids: new Set(), cells: new Set(), endedAt: Date.now(), inputs: 0 };
			unsettled.inputs++;
			unsettled.cells.add(cell);
			if (pid !== undefined) unsettled.pids.add(pid);
			this.#sending++;
			const call = dispatch();
			markDispatched();
			let result: T;
			try {
				result = await call;
			} catch (error) {
				unsent = refusedUnsent(error);
				throw error;
			}
			if (opens) {
				const opened = opens(result);
				const started = opened.window?.pid ?? opened.pid;
				if (started !== undefined) unsettled.pids.add(started);
				this.ledger.noteOpened(cell, opened);
			}
			// A key can activate another app (cmd+tab, Spotlight): the app focused after it reacts too.
			if ("root" in to && !to.point) {
				const focused = await this.windowReached(signal);
				if (focused?.pid !== undefined) unsettled.pids.add(focused.pid);
			}
			return result;
		} catch (error) {
			if (window && !(error instanceof ToolAbortError)) this.ledger.noteFailure(cell, window);
			throw error;
		} finally {
			markDispatched();
			if (unsettled) {
				this.#sending--;
				if (unsent && --unsettled.inputs === 0) {
					if (this.#unsettled === unsettled) this.#unsettled = undefined;
				} else {
					unsettled.endedAt = Date.now();
					// A read or input during this one took the record and waited before this input ended.
					if (this.#unsettled !== unsettled) this.#restore(unsettled);
				}
			}
		}
	}

	/**
	 * The window a desktop point lies in (see `windowAt`), or without a point
	 * the focused window; undefined when unknown.
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
	#runtime?: JsRuntime;
	#active: ActiveRun | null = null;
	/** `#session` as the desktop scope sees it, checking for the user's Escape on every access. */
	#guarded?: NativeDesktopSession;
	/** Which apps input reached and has yet to settle; lives and dies with `#session`. */
	#observer?: InputObserver;
	/** Settles when this worker's latest `clipboard.write` finished. */
	#clipboardWrite: Promise<void> = Promise.resolve();
	/**
	 * Per-run context, carried through AsyncLocalStorage so async work leaked
	 * from an ended run (timers, dangling promises) keeps that run's aborted
	 * context instead of borrowing the next run's signal and read-only policy.
	 */
	readonly #runContexts = new AsyncLocalStorage<ComputerRunContext>();
	#closed = false;
	/** The latest agent turn whose end was sent here; a run of that turn or earlier, arriving late, holds nothing. */
	#releasedTurn = 0;
	/** Runs and settles waiting for the other kind to end, by request id, so an abort reaches them. */
	readonly #queued = new Map<string, AbortController>();

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
			case "release-display":
				this.#releasedTurn = Math.max(this.#releasedTurn, message.turn);
				this.#session?.releaseDisplayAwake();
				return;
			case "resume-display":
				if (this.#active?.displayTurn !== message.from) return;
				this.#active.displayTurn = message.turn;
				this.#session?.holdDisplayUntilReleased();
				return;
			case "tool-reply":
				this.#deliverToolReply(message.id, message.reply);
				return;
			case "close":
				void this.#close();
		}
	}

	/** Returns the raw session; the desktop scope gets `#guarded`, which checks for the user's Escape on every access. */
	async #ensureSession(snapshot: ComputerSessionSnapshot, escape: ComputerEscapeScope): Promise<NativeDesktopSession> {
		if (this.#session) return this.#session;
		// Single-flight: share one creation promise so a run and a capabilities
		// request racing on a cold worker cannot each build (and leak) a session.
		this.#sessionInit ??= (async () => {
			try {
				// The worker must answer its readiness handshake without loading the native
				// addon; normal CLI startup and selector pings never execute desktop code.
				const createSession =
					this.#createSession ?? (await import("@oh-my-pi/pi-natives/desktop")).createDesktopSession;
				const session = await createSession({ display: snapshot.display, escapeStopKey: escape.key });
				const guarded = this.#guard(session);
				this.#session = session;
				this.#guarded = guarded;
				this.#observer = new InputObserver(guarded, session);
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
	 * abortable run. A cell's report and another cell's run take turns, each
	 * within its own budget and abort; a run that finds another run in flight is
	 * refused as busy.
	 */
	async #run(message: Extract<ComputerWorkerInbound, { type: "run" | "settle" }>): Promise<void> {
		const startedAt = Date.now();
		const timeoutSignal = AbortSignal.timeout(message.timeoutMs);
		const deadline = performance.now() + message.timeoutMs;
		const ac = new AbortController();
		const timedOut = (): ToolError =>
			new ToolError(
				message.type === "settle"
					? `the post-input report timed out after ${message.timeoutMs}ms`
					: `Computer code execution timed out after ${message.timeoutMs}ms`,
			);
		while (this.#active && !this.#closed && (message.type === "settle" || this.#active.kind === "settle")) {
			this.#queued.set(message.id, ac);
			try {
				await untilAborted(AbortSignal.any([timeoutSignal, ac.signal]), this.#active.ended);
			} catch {
				const error = timeoutSignal.aborted ? timedOut() : new ToolAbortError();
				this.#transport.send({ type: "result", id: message.id, ok: false, error: errorPayload(error) });
				return;
			} finally {
				this.#queued.delete(message.id);
			}
		}
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
				error: errorPayload(
					new ToolError(
						"Computer worker is busy: another computer call from this session is still running. Await each call before starting the next instead of running them together (Promise.all, asyncio.gather), or group the steps in one computer.run(...)",
					),
				),
			});
			return;
		}
		const runAc = new AbortController();
		const signal = AbortSignal.any([timeoutSignal, ac.signal, runAc.signal]);
		const ended = Promise.withResolvers<void>();
		const active: ActiveRun = {
			id: message.id,
			kind: message.type,
			ended: ended.promise,
			acknowledgedEscapeStops: message.escape.acknowledged,
			ac,
			signal,
			pendingTools: new Map(),
			displayTurn: message.session.displayTurn,
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
			await this.#ensureSession(message.session, message.escape);
			const session = this.#guarded!;
			throwIfAborted(signal);
			// An Escape after the host's check still ends the run before the script starts.
			this.#checkEscape();
			session.setRunDeadline(deadline - performance.now());
			const { displayTurn } = active;
			if (displayTurn !== undefined && displayTurn > this.#releasedTurn) session.holdDisplayUntilReleased();
			// Under `refuse` no foreground control stands, including a grant the
			// model acquired before the user chose `refuse`.
			if (message.session.backgroundFallback === "refuse" && session.controlState().active) session.releaseControl();
			const observer = this.#observer!;
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
				// The user's Escape ends the run with its own message, not as a bare abort, so the host reports it
				// even when the user's next message already lifted the stop.
				const abortError =
					signal.reason === active.escapeStop || signal.reason instanceof ToolAbortError
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
				capabilities = (await this.#ensureSession(message.session, message.escape)).capabilities;
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
	 * Report what the cell's input changed once its apps went quiet: each touched window re-read once and diffed
	 * against the model's last tree, which a failed or cancelled report leaves as the baseline. `forget`: the
	 * conversation was rewritten, so windows print whole. The cell's record is gone afterwards.
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
	 * The report for one cell's pending input. Windows not read by `readDeadline`, or past the inline output
	 * budget, are named instead and keep the model's last tree. `whole` prints every window whole, for a
	 * conversation rewritten while the report was made.
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
		/** A window's section, whole too, the line naming it instead, and the tree it would make the model's. */
		const sections: Array<{ text: string } | { text: string; whole: string; leftOut: string; shown: Shown }> = [];
		if (focused) ledger.attributeToFocused(pending, focused);
		else if (pending.unattributed > 0) sections.push({ text: reportNote({ noFocusedWindow: true }) });
		const latest = pending.outcome?.latest;
		const unwatchedMs = latest && !latest.watched ? latest.sinceInputMs : undefined;
		// A sheet, popover or chooser that left the list hands its app's focus on: that window is read right after it.
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
		// Windows that appeared while the input ran hold the model's next step, and it has no tree of them. In the
		// background they often open without the focus: a rename field, a date picker, the document another app
		// opened. Those of the processes the input reached are read; after input to a window, any app's are.
		if (roster && pending.rosterBefore) {
			const before = new Set(pending.rosterBefore.map(window => window.id));
			for (const opened of roster) {
				if (before.has(opened.id) || reported.has(opened.id)) continue;
				if (!pending.windowInput && !(opened.pid !== undefined && pending.pids.has(opened.pid))) continue;
				reported.add(opened.id);
				const read = await budgeted(() => session.axSnapshot(opened.id, {}));
				// Unreadable or out of time, it is still named.
				if (!("value" in read)) {
					sections.push({ text: newWindowName(opened) });
					continue;
				}
				const text = read.value.text;
				sections.push({
					text: renderNewWindow(opened, text),
					whole: renderNewWindow(opened, text),
					leftOut: reportNote({ leftOut: newWindowName(opened) }),
					shown: { window: { id: opened.id, pid: opened.pid }, text, options: {} },
				});
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
			// Budget left with every window named by its line; each section in turn replaces its line if it fits.
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
	 * The user's physical Escape ends the active run for good: the run is
	 * aborted and this access refused, so a script that catches the cancelled
	 * operation sends nothing more.
	 */
	#checkEscape(cause?: unknown, notice = ESCAPE_STOPPED_MESSAGE): void {
		const active = this.#active;
		if (!active || !this.#session || this.#session.escapeStops <= active.acknowledgedEscapeStops) return;
		if (active.escapeStop) throw active.escapeStop;
		// What the stopped operation reported (a key left held, the user's app not handed back) stays first.
		const stopped = new ToolError(cause === undefined ? notice : `${nativeError(cause).message}\n\n${notice}`);
		active.escapeStop = stopped;
		active.ac.abort(stopped);
		throw stopped;
	}

	/** Checks for the user's Escape before every access to the session and again when each native promise settles. */
	#guard(session: NativeDesktopSession): NativeDesktopSession {
		return new Proxy(session, {
			get: (target, property) => {
				this.#checkEscape();
				const value = Reflect.get(target, property, target);
				if (typeof value !== "function") return value;
				return (...args: unknown[]): unknown => {
					this.#checkEscape();
					const result = Reflect.apply(value, target, args);
					if (!(result instanceof Promise)) return result;
					return result.then(
						settled => {
							// The call finished and its input went out; the stop ends the run after it.
							this.#checkEscape(undefined, ESCAPE_AFTER_CALL_MESSAGE);
							return settled;
						},
						error => {
							this.#checkEscape(error);
							throw error;
						},
					);
				};
			},
		});
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
			const session = await this.#ensureSession(message.session, message.escape);
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
				// A bridged tool acts outside the desktop session, so the user's Escape is checked here too.
				this.#checkEscape();
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

	/** Every desktop facade operation starts here, so the user's Escape stops clipboard and other non-native work too. */
	#currentRunContext = (): ComputerRunContext => {
		const context = this.#runContexts.getStore();
		if (!context) throw new ToolError("no active computer run");
		this.#checkEscape();
		return context;
	};

	#createDesktopScope(session: NativeDesktopSession, observer: InputObserver): object {
		const getContext = this.#currentRunContext;
		const makeWin = (window: DesktopWindow): Win => new Win(session, getContext, observer, window);
		const desktopTarget = new Win(session, getContext, observer, {
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
				open: async (
					id: string,
					options?: ApplicationOpenOptions,
				): Promise<Application & { window: Win | null }> => {
					const context = getContext();
					guardRun(context, "apps.open");
					validateString(id, "apps.open(id)", { nonEmpty: true });
					// One read of each option, so the `refuse` check and the native call agree.
					const open = { ...options };
					if (open.activate === true) {
						refuseForeground(
							context,
							"apps.open with activate: true",
							"bring the application to the front",
							"Call apps.open without activate, which opens the application behind the user's.",
						);
					}
					const { window: shown, ...application } = await observer.input(
						context,
						{},
						() => nativeCall(context.signal, () => session.openApplication(id, open)),
						opened => ({
							pid: opened.pid,
							window: opened.window && { id: opened.window.id, pid: opened.window.pid },
						}),
					);
					return { ...application, window: shown ? makeWin(shown) : null };
				},
			},
			control: {
				acquire: async (options: { reason: string }): Promise<{ active: boolean }> => {
					const context = getContext();
					guardRun(context, "control.acquire");
					refuseForeground(
						context,
						"control.acquire",
						"hand the agent foreground control of the desktop",
						"Window input needs no control; it runs in the background.",
					);
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
				return (await nativeCall(signal, () => session.listWindows()))
					.filter(window => matchesFilter(window, filter))
					.slice(0, MAX_LISTED_WINDOWS);
			},
			window: async (selector: string | number | WindowFilter): Promise<Win> => {
				const { signal } = getContext();
				await observer.settle(signal);
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
				await observer.settle(signal);
				const window = (await nativeCall(signal, () => session.listWindows())).find(candidate => candidate.focused);
				return window ? makeWin(window) : null;
			},
			screenshot: (options?: ScreenshotOptions) =>
				captureScreenshot(session, getContext, observer, "desktop", options),
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
			ref: (ref: string): ElRef => {
				validateString(ref, "ref(ref)", { nonEmpty: true });
				return new ElRef(ref, getContext, async () => {
					const window = observer.refs.windowOf(ref);
					const node = await observer.read(getContext(), window, () => session.axNode(ref));
					return observer.element(getContext, node, window);
				});
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
					validateString(text, "clipboard.write(text)");
					// Clipboard access is part of the native desktop surface and remains
					// outside the worker's readiness-only import graph.
					const { copyToClipboard } = await import("../../utils/clipboard");
					// `copyToClipboard` queues behind the previous write; wait out this worker's own writes
					// first, so the Escape check below is the last step before this one starts.
					const previous = this.#clipboardWrite;
					const { promise, resolve } = Promise.withResolvers<void>();
					this.#clipboardWrite = promise;
					try {
						await previous;
						guardRun(getContext(), "clipboard.write");
						await copyToClipboard(text);
					} finally {
						resolve();
					}
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
			this.#guarded = undefined;
			this.#observer = undefined;
			this.#sessionInit = undefined;
			this.#unsubscribe();
			this.#transport.send({ type: "closed" });
			this.#transport.close();
		}
	}
}
