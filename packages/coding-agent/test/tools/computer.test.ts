import { afterAll, afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { inspect } from "node:util";
import { createContext, runInContext } from "node:vm";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { computerApproval, createComputerPrelude } from "@oh-my-pi/pi-coding-agent/tools/computer";
import { isReadOnlyComputerCall, renderComputerCall } from "@oh-my-pi/pi-coding-agent/tools/computer/call";
import {
	type ComputerSessionSnapshot,
	type ComputerWorkerInbound,
	type ComputerWorkerOutbound,
	type ComputerWorkerTransport,
	ESCAPE_AFTER_CALL_MESSAGE,
	ESCAPE_STOPPED_MESSAGE,
	SCREEN_LOCKED_CAPTURE_NOTE,
	type SettleReport,
} from "@oh-my-pi/pi-coding-agent/tools/computer/protocol";
import {
	beginComputerTurnForOwner,
	type ComputerController,
	type ComputerEscapeStops,
	ComputerSupervisor,
	type ComputerWorkerHandle,
	endComputerTurnForOwner,
	registerComputerController,
	resumeComputerUseForOwner,
} from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import {
	diffTree,
	ObservationLedger,
	parseTreeRow,
	RefWindows,
	refRuns,
	renderReadBack,
} from "@oh-my-pi/pi-coding-agent/tools/computer/observation";
import { ComputerWorkerCore, type NativeDesktopSession } from "@oh-my-pi/pi-coding-agent/tools/computer/worker";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import type {
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
	DesktopWindow,
	HoldOptions as NativeHoldOptions,
	PointerOptions,
	UiQuiet,
	UiQuietOptions,
} from "@oh-my-pi/pi-natives";

import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { cfgComputerEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

/** Method name of the last step in a facade call chain, or "" when the chain is malformed. */
function terminalMethod(chain: unknown): string {
	if (!Array.isArray(chain) || chain.length === 0) return "";
	const terminal: unknown = chain[chain.length - 1];
	if (terminal === null || typeof terminal !== "object" || !("method" in terminal)) return "";
	return typeof terminal.method === "string" ? terminal.method : "";
}

const capabilities: DesktopCapabilities = {
	backend: "fake",
	displayServer: "memory",
	capture: true,
	input: true,
	ax: true,
	backgroundWindowInput: true,
	takeover: true,
	globalEscape: true,
	capturePermission: "granted",
	inputPermission: "granted",
	axPermission: "granted",
	displayCount: 1,
	applications: true,
	menus: true,
	heldInput: true,
	spaces: true,
	screenLocked: false,
	displayAsleep: false,
};

const display: DesktopDisplay = {
	id: "display-1",
	name: "Primary",
	x: 0,
	y: 0,
	width: 64,
	height: 32,
	scale: 1,
	pixelX: 0,
	pixelY: 0,
	pixelWidth: 64,
	pixelHeight: 32,
	isPrimary: true,
};

const windowFixture: DesktopWindow = {
	id: "42",
	title: "Editor",
	app: "Code",
	pid: 123,
	x: 4,
	y: 5,
	width: 40,
	height: 20,
	focused: true,
};

const axNode: AxNode = {
	ref: "e1",
	role: "button",
	nativeRole: "button",
	title: "Save",
	enabled: true,
	focused: false,
	childCount: 0,
	x: 7,
	y: 8,
	width: 9,
	height: 10,
};

/** Escape-stop counts for supervisor tests that exercise no Escape stop, so they never read the native addon. */
const NO_ESCAPE_STOPS: ComputerEscapeStops = { read: () => 0, forget: () => {} };

class FakeNativeSession implements NativeDesktopSession {
	/** Lock and sleep state reported by captures, capabilities and screenState, as the native session reads it live. */
	screenLocked = false;
	displayAsleep = false;
	get capabilities(): DesktopCapabilities {
		return { ...capabilities, screenLocked: this.screenLocked, displayAsleep: this.displayAsleep };
	}
	get screenState(): DesktopScreenState {
		return { screenLocked: this.screenLocked, displayAsleep: this.displayAsleep };
	}
	escapeStops = 0;
	clickCount = 0;
	closeCount = 0;
	cancelCount = 0;
	retireCount = 0;
	controlActive = false;
	acquireCount = 0;
	readonly operations: string[] = [];
	readonly takeovers: (boolean | undefined)[] = [];
	sourceWidth = 64;
	sourceHeight = 32;

	async listDisplays(): Promise<DesktopDisplay[]> {
		return [display];
	}
	async listWindows(): Promise<DesktopWindow[]> {
		return [windowFixture];
	}
	async capture(target: string): Promise<DesktopCapture> {
		return {
			data: Uint8Array.of(137, 80, 78, 71),
			width: 64,
			height: 32,
			coordinateWidth: 64,
			coordinateHeight: 32,
			sourceWidth: this.sourceWidth,
			sourceHeight: this.sourceHeight,
			target,
			displays: [display],
			backend: "fake",
			screenLocked: this.screenLocked,
		};
	}
	async captureRegion(_target: string, _region: CaptureRegion): Promise<DesktopCapture> {
		throw new Error("Unexpected region capture");
	}
	cancel(): void {
		this.cancelCount += 1;
		this.controlActive = false;
	}
	retire(): void {
		this.retireCount += 1;
	}
	/** Display-hold calls in order: `turn` for holdDisplayUntilReleased, `release` for releaseDisplayAwake. */
	readonly displayHolds: string[] = [];
	holdDisplayUntilReleased(): void {
		this.displayHolds.push("turn");
	}
	releaseDisplayAwake(): void {
		this.displayHolds.push("release");
	}
	setRunDeadline(_remainingMs: number): void {}
	async listApplications() {
		return [{ id: "test.editor", name: "Editor", path: "/Applications/Editor.app", running: true, pid: 123 }];
	}
	async openApplication(id: string) {
		this.operations.push(`open:${id}`);
		return { ...(await this.listApplications())[0]!, window: windowFixture };
	}
	async menuItems(_target: string, path: string[] = []) {
		return [{ title: "Save", path: [...path, "Save"], enabled: true, checked: false, hasSubmenu: false }];
	}
	async menuSelect(target: string, path: string[]) {
		this.operations.push(`menu:${target}:${path.join("/")}`);
	}
	async observe(target: string) {
		return {
			capture: await this.capture(target),
			accessibility: { text: "- button [ref=e1]", nodeCount: 1, truncated: false },
		};
	}
	async holdKeys(target: string, keys: string[], options: { duration: number }) {
		this.operations.push(`holdKeys:${target}:${keys.join("+")}:${options.duration}`);
	}
	async holdMouse(target: string, x: number, y: number, options: { duration: number }) {
		this.operations.push(`holdMouse:${target}:${x},${y}:${options.duration}`);
	}
	async acquireControl() {
		this.acquireCount += 1;
		this.controlActive = true;
		return { active: true };
	}
	releaseControl(): void {
		this.controlActive = false;
	}
	controlState() {
		return { active: this.controlActive };
	}
	async bringToCurrentSpace(target: string) {
		this.operations.push(`space:${target}`);
	}
	async click(
		_target: string,
		_x: number,
		_y: number,
		_opts?: PointerOptions | null,
	): Promise<DesktopFocusReturn | null | void> {
		this.clickCount += 1;
		this.takeovers.push(_opts?.takeover);
	}
	async moveMouse(_target: string, _x: number, _y: number, _opts?: PointerOptions | null): Promise<void> {
		this.takeovers.push(_opts?.takeover);
	}
	async drag(_target: string, _points: DesktopPoint[], _opts?: PointerOptions | null): Promise<void> {}
	async scroll(
		_target: string,
		_x: number,
		_y: number,
		_dx: number,
		_dy: number,
		_opts?: PointerOptions | null,
	): Promise<void> {}
	async typeText(_target: string, _text: string, _opts?: PointerOptions | null): Promise<void> {}
	async keyChord(_target: string, _keys: string[], _opts?: PointerOptions | null): Promise<void> {}
	async raiseWindow(_windowId: string): Promise<void> {}
	async axSnapshot(_target: string, _opts?: AxSnapshotOptions | null): Promise<{ text: string }> {
		return { text: "- button [ref=e1]" };
	}
	async axQuery(_target: string, _query: AxQuery): Promise<AxNode[]> {
		return [axNode];
	}
	async axElementAt(_target: string, _x: number, _y: number): Promise<AxNode | null> {
		return axNode;
	}
	async axFocused(): Promise<AxNode | null> {
		return axNode;
	}
	async axNode(_ref: string): Promise<AxNode> {
		return axNode;
	}
	async axAttributes(_ref: string): Promise<Array<[string, string]>> {
		return [];
	}
	async axChildren(_ref: string): Promise<AxNode[]> {
		return [];
	}
	async axParent(_ref: string): Promise<AxNode | null> {
		return null;
	}
	async axPerform(_ref: string, _action: string): Promise<void> {}
	async axSetValue(_ref: string, _value: string): Promise<void> {}
	readonly selections: string[] = [];
	async axSelectText(_ref: string, text: string, _opts?: AxSelectTextOptions | null): Promise<AxTextSelection> {
		this.selections.push(text);
		return { start: 0, length: text.length, text, focused: true };
	}
	async axFocus(_ref: string): Promise<void> {}
	async axClick(_ref: string, _opts?: PointerOptions | null): Promise<void> {}
	async axType(_ref: string, _text: string, _opts?: PointerOptions | null): Promise<void> {}
	async axKeyChord(_ref: string, _keys: string[], _opts?: PointerOptions | null): Promise<void> {}
	/** Processes each `waitForUiQuiet` call watched, in call order. */
	readonly quietWaits: number[][] = [];
	/** What `waitForUiQuiet` answers: by default a watched app that was already quiet. */
	quiet: UiQuiet = { waitedMs: 0, events: 0, timedOut: false, watched: 1 };
	async waitForUiQuiet(pids: number[], _options?: UiQuietOptions | null): Promise<UiQuiet> {
		this.quietWaits.push([...pids]);
		return this.quiet;
	}
	async close(): Promise<void> {
		this.closeCount += 1;
		this.controlActive = false;
	}
}

/** The user presses physical Escape during the next click, as the native takeover monitor reports it. */
class EscapeNativeSession extends FakeNativeSession {
	escapeOnClick = false;
	capabilityReads = 0;
	/** What the stopped click rejects with, as native reports a cancelled operation. */
	escapeError = "Cancelled: desktop operation cancelled; input may be partial; inspect before retrying";
	/** Runs as the Escape lands, before the click rejects. */
	onEscape?: () => void;

	override get capabilities(): DesktopCapabilities {
		this.capabilityReads += 1;
		return super.capabilities;
	}
	override async axSetValue(ref: string, value: string): Promise<void> {
		this.operations.push(`setValue:${ref}:${value}`);
	}

	override async click(target: string, x: number, y: number, opts?: PointerOptions | null): Promise<void> {
		if (!this.escapeOnClick) {
			await super.click(target, x, y, opts);
			return;
		}
		this.escapeOnClick = false;
		this.escapeStops += 1;
		this.onEscape?.();
		throw new Error(this.escapeError);
	}
}

/** A backend with independent full frames and native-detail crops, not a facade response stub. */
class ZoomNativeSession extends FakeNativeSession {
	readonly fullFrames = new Map<string, DesktopCapture>();
	readonly fullCaptureCounts = new Map<string, number>();
	readonly clicks: Array<{ target: string; x: number; y: number }> = [];

	override async capture(target: string): Promise<DesktopCapture> {
		const frame = await super.capture(target);
		this.fullFrames.set(target, frame);
		this.fullCaptureCounts.set(target, (this.fullCaptureCounts.get(target) ?? 0) + 1);
		return frame;
	}

	override async captureRegion(target: string, region: CaptureRegion): Promise<DesktopCapture> {
		const frame = this.fullFrames.get(target);
		if (!frame) throw new Error(`InvalidCoordinateFrame: screenshot ${target} first`);
		return {
			...frame,
			width: 128,
			height: 64,
			sourceWidth: 128,
			sourceHeight: 64,
			region,
		};
	}

	override async click(target: string, x: number, y: number): Promise<void> {
		const frame = this.fullFrames.get(target);
		if (!frame || x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
			throw new Error("InvalidCoordinateFrame: click outside the full screenshot");
		}
		this.clicks.push({ target, x, y });
	}
}

class MemoryTransport implements ComputerWorkerTransport {
	readonly outbound: ComputerWorkerOutbound[] = [];
	#handler?: (message: ComputerWorkerInbound) => void;
	readonly listeners = new Set<(message: ComputerWorkerOutbound) => void>();
	#waiters = new Set<{
		predicate: (message: ComputerWorkerOutbound) => boolean;
		resolve: (message: ComputerWorkerOutbound) => void;
	}>();

	send(message: ComputerWorkerOutbound): void {
		this.outbound.push(message);
		for (const listener of this.listeners) listener(message);
		for (const waiter of this.#waiters) {
			if (!waiter.predicate(message)) continue;
			this.#waiters.delete(waiter);
			waiter.resolve(message);
		}
	}
	onMessage(handler: (message: ComputerWorkerInbound) => void): () => void {
		this.#handler = handler;
		return () => {
			if (this.#handler === handler) this.#handler = undefined;
		};
	}
	close(): void {}
	inbound(message: ComputerWorkerInbound): void {
		this.#handler?.(message);
	}
	waitFor(predicate: (message: ComputerWorkerOutbound) => boolean): Promise<ComputerWorkerOutbound> {
		const existing = this.outbound.find(predicate);
		if (existing) return Promise.resolve(existing);
		const pending = Promise.withResolvers<ComputerWorkerOutbound>();
		this.#waiters.add({ predicate, resolve: pending.resolve });
		return pending.promise;
	}
}

/** No Escape stop acknowledged, under a key no other test shares. */
const escapeScope = () => ({ key: `computer-test-${crypto.randomUUID()}`, acknowledged: 0 });

const snapshot = (
	readOnly = false,
	displayTurn?: number,
	backgroundFallback: ComputerSessionSnapshot["backgroundFallback"] = "takeover",
): ComputerSessionSnapshot => ({
	cwd: import.meta.dir,
	sessionId: crypto.randomUUID(),
	captureMaxWidth: 1280,
	captureMaxHeight: 896,
	display: "active",
	readOnly,
	displayTurn,
	backgroundFallback,
});

async function runWorker(
	transport: MemoryTransport,
	id: string,
	code: string,
	readOnly = false,
	timeoutMs = 2_000,
): Promise<Extract<ComputerWorkerOutbound, { type: "result" }>> {
	transport.inbound({ type: "run", id, code, timeoutMs, session: snapshot(readOnly), escape: escapeScope() });
	const message = await transport.waitFor(candidate => candidate.type === "result" && candidate.id === id);
	if (message.type !== "result") throw new Error(`Expected computer result, received ${message.type}`);
	return message;
}

function toolSession(): ToolSession {
	return {
		cwd: import.meta.dir,
		hasUI: false,
		settings: Settings.isolated({ "computer.enabled": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

/** Exercise the shipped host approval/call rendering and worker, with only native OS work substituted. */
function workerPrelude(session: ToolSession, native: NativeDesktopSession): EvalPreludeDefinition {
	const transport = new MemoryTransport();
	new ComputerWorkerCore(transport, () => native);
	return createComputerPrelude(session, () => ({
		async run(code, timeoutMs, runSnapshot) {
			const id = crypto.randomUUID();
			transport.inbound({ type: "run", id, code, timeoutMs, session: runSnapshot, escape: escapeScope() });
			const result = await transport.waitFor(message => message.type === "result" && message.id === id);
			if (result.type !== "result") throw new Error("Expected a computer result");
			if (!result.ok) throw new Error(result.error.message);
			return result.payload;
		},
		async capabilities() {
			return native.capabilities;
		},
		async close() {
			transport.inbound({ type: "close" });
			await transport.waitFor(message => message.type === "closed");
		},
	}));
}

afterAll(async () => {
	await disposeAllKernelSessions();
});

describe("computer prelude", () => {
	it("validates action shapes and maps explicitly read-only runs to read approval", async () => {
		const prelude = createComputerPrelude(toolSession(), () => ({
			async run() {
				return { displays: [], returnValue: undefined, screenshots: [] };
			},
			async capabilities() {
				return undefined;
			},
			async close() {},
		}));
		const context = { session: toolSession(), toolCallId: "computer-validation" };

		await expect(prelude.invoke({}, context)).rejects.toThrow("computer received invalid arguments");
		await expect(prelude.invoke({ action: "run", code: "1", unexpected: true }, context)).rejects.toThrow(
			"computer received invalid arguments",
		);
		await expect(prelude.invoke({ action: "capabilities", code: "1" }, context)).rejects.toThrow(
			"computer received invalid arguments",
		);
		await expect(prelude.invoke({ action: "run" }, context)).rejects.toThrow(
			"Action 'run' requires exactly one of 'code' or 'fn'.",
		);
		await expect(prelude.invoke({ action: "run", code: "1", fn: "() => 1" }, context)).rejects.toThrow(
			"Action 'run' requires exactly one of 'code' or 'fn'.",
		);
		await expect(prelude.invoke({ action: "call" }, context)).rejects.toThrow("computer received invalid arguments");
		await expect(prelude.invoke({ action: "call", chain: [], read_only: true }, context)).rejects.toThrow(
			"computer received invalid arguments",
		);
		await expect(
			prelude.invoke({ action: "call", chain: [{ method: "launch", args: [] }] }, context),
		).rejects.toThrow('Unknown desktop method "launch"');

		expect(computerApproval({ action: "run", code: "1", read_only: true })).toBe("read");
		expect(computerApproval({ action: "run", code: "1", read_only: false })).toBe("exec");
		expect(computerApproval({ action: "call", chain: [{ method: "windows", args: [] }] })).toBe("read");
		expect(
			computerApproval({
				action: "call",
				chain: [
					{ method: "window", args: ["42"] },
					{ method: "ax", args: [] },
				],
			}),
		).toBe("read");
		expect(
			computerApproval({
				action: "call",
				chain: [
					{ method: "ref", args: ["e1"] },
					{ method: "press", args: [] },
				],
			}),
		).toBe("exec");
		expect(computerApproval({ action: "call", chain: [{ method: "launch", args: [] }] })).toBe("exec");
		expect(computerApproval({ action: "call", chain: [null] })).toBe("exec");
		expect(computerApproval({ action: "call" })).toBe("exec");
		expect(computerApproval({ action: "capabilities" })).toBe("read");
		expect(computerApproval({ action: "close" })).toBe("exec");
		expect(computerApproval("garbage")).toBe("exec");
		await prelude.invoke({ action: "close" }, context);
	});

	it("routes run, capabilities, images, cancellation inputs, and close through one host controller", async () => {
		const calls: Array<{
			code: string;
			timeoutMs: number;
			snapshot: ComputerSessionSnapshot;
			signal?: AbortSignal;
		}> = [];
		let closeCount = 0;
		const controller: ComputerController = {
			async run(code: string, timeoutMs: number, runSnapshot: ComputerSessionSnapshot, signal?: AbortSignal) {
				calls.push({ code, timeoutMs, snapshot: runSnapshot, signal });
				return {
					displays: [
						{ type: "text", text: "captured" },
						{ type: "image", data: "iVBORw==", mimeType: "image/png" },
					],
					returnValue: { windows: 1 },
					screenshots: [],
					capabilities,
				};
			},
			async capabilities() {
				return capabilities;
			},
			async close() {
				closeCount += 1;
			},
		};
		const session = toolSession();
		const prelude = createComputerPrelude(session, () => controller);
		const abort = new AbortController();
		const context = { session, toolCallId: "computer-run", signal: abort.signal };

		const result = await prelude.invoke(
			{ action: "run", code: "await desktop.windows()", read_only: true, timeout: 7 },
			context,
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			code: "await desktop.windows()",
			timeoutMs: 7_000,
			snapshot: { readOnly: true, display: "active" },
			signal: abort.signal,
		});
		expect(result.content).toEqual([
			{ type: "text", text: "captured" },
			{ type: "image", data: "iVBORw==", mimeType: "image/png", detail: "original" },
		]);
		expect(result.details).toMatchObject({
			code: "await desktop.windows()",
			readOnly: true,
			backend: "fake",
			value: { windows: 1 },
		});

		const functionResult = await prelude.invoke(
			{ action: "run", fn: "(_scope, count) => count", args: [7] },
			context,
		);
		expect(calls[1]?.code).toBe("return await ((_scope, count) => count)({ desktop, wait, assert }, 7);");
		expect(functionResult.details).toMatchObject({ value: { windows: 1 } });

		await prelude.invoke(
			{
				action: "call",
				chain: [
					{ method: "window", args: ["42"] },
					{ method: "ax", args: [{ maxDepth: 3 }] },
				],
			},
			context,
		);
		await prelude.invoke({ action: "call", chain: [{ method: "press", args: ["cmd+s"] }], timeout: 9 }, context);
		expect(calls[2]).toMatchObject({
			code: 'return await (await desktop.window("42")).ax({"maxDepth":3});',
			snapshot: { readOnly: true },
		});
		expect(calls[3]).toMatchObject({
			code: 'return await desktop.press("cmd+s");',
			timeoutMs: 9_000,
			snapshot: { readOnly: false },
		});

		const cancelled = new AbortController();
		cancelled.abort();
		await expect(
			prelude.invoke(
				{ action: "run", code: "await desktop.windows()" },
				{ session, toolCallId: "computer-cancelled", signal: cancelled.signal },
			),
		).rejects.toMatchObject({ name: "ToolAbortError" });
		expect(calls).toHaveLength(4);

		const capabilityResult = await prelude.invoke({ action: "capabilities" }, context);
		expect(capabilityResult.details).toEqual(capabilities);
		await prelude.invoke({ action: "close" }, context);
		await prelude.invoke({ action: "close" }, context);
		expect(closeCount).toBe(1);
		await expect(prelude.invoke({ action: "run", code: "await desktop.windows()" }, context)).rejects.toThrow(
			"Computer session is closed",
		);
	});

	it("installs a frozen JavaScript facade with handle proxies, runs, direct values, and display text", async () => {
		const session = toolSession();
		const prelude = createComputerPrelude(session, () => ({
			async run() {
				return { displays: [], returnValue: undefined, screenshots: [] };
			},
			async capabilities() {
				return undefined;
			},
			async close() {},
		}));
		const calls: unknown[] = [];
		const displays: unknown[] = [];
		const windowSnapshot = {
			id: "42",
			app: "Code",
			title: "main.ts",
			pid: 7,
			bounds: { x: 1, y: 2, width: 3, height: 4 },
			focused: true,
		};
		const elementSnapshot = {
			ref: "e1",
			role: "button",
			nativeRole: "AXButton",
			title: "Save",
			enabled: true,
			focused: false,
			childCount: 0,
		};
		const callValues: Record<string, unknown> = {
			window: windowSnapshot,
			focusedWindow: null,
			windows: [windowSnapshot],
			ax: "- button [ref=e1]",
			find: [elementSnapshot],
			ref: elementSnapshot,
			elementAt: elementSnapshot,
			press: undefined,
			parent: null,
			children: [elementSnapshot, elementSnapshot],
			bounds: { x: 7, y: 8, width: 9, height: 10 },
			"clipboard.read": "copied",
		};
		const realm = createContext({
			__omp_log__: (_level: string, value: unknown) => displays.push(value),
			__omp_prelude__: async (name: unknown, parameters: unknown) => {
				expect(name).toBe("computer");
				calls.push(parameters);
				if (parameters === null || typeof parameters !== "object" || !("action" in parameters)) return undefined;
				if (parameters.action === "run") return { text: "inner display", details: { value: 42 } };
				if (parameters.action === "capabilities") return { text: "", details: capabilities };
				if (parameters.action === "call" && "chain" in parameters) {
					return { text: "", details: { value: callValues[terminalMethod(parameters.chain)] } };
				}
				return undefined;
			},
		});
		runInContext(prelude.javascript, realm);

		const fn = (_scope: unknown, count: number): number => count;
		const argFn = (value: number): number => value;
		Reflect.set(realm, "fn", fn);
		Reflect.set(realm, "argFn", argFn);
		expect(
			await runInContext("computer.run(fn, { args: [7, /save/gi, argFn], read_only: true, timeout: 5 })", realm),
		).toBe(42);
		expect(
			await runInContext(
				'computer.run("41 + 1", { timeout: 2, action: "close", code: "old", fn: "old", unexpected: true })',
				realm,
			),
		).toBe(42);
		expect(await runInContext("computer.capabilities()", realm)).toEqual(capabilities);

		expect(
			await runInContext(
				'(async () => { globalThis.win = await computer.window({ app: "Code" }); return { ...win }; })()',
				realm,
			),
		).toEqual(windowSnapshot);
		expect(await runInContext("computer.focusedWindow()", realm)).toBeNull();
		expect(await runInContext("win.ax({ maxDepth: 3 })", realm)).toBe("- button [ref=e1]");
		expect(await runInContext("win.press('cmd+s', undefined)", realm)).toBeUndefined();
		expect(
			await runInContext(
				'(async () => { globalThis.el = await win.ref("e1"); return [el.ref, el.role, el.title]; })()',
				realm,
			),
		).toEqual(["e1", "button", "Save"]);
		expect(await runInContext("el.bounds()", realm)).toEqual({ x: 7, y: 8, width: 9, height: 10 });
		expect(await runInContext("el.parent()", realm)).toBeNull();
		expect(await runInContext("el.children().then(kids => kids.map(kid => kid.ref))", realm)).toEqual(["e1", "e1"]);
		expect(await runInContext('win.find({ role: "button" }).then(found => found[0].role)', realm)).toBe("button");
		expect(await runInContext("computer.elementAt(3, 4).then(found => found.ref)", realm)).toBe("e1");
		expect(await runInContext("computer.clipboard.read()", realm)).toBe("copied");
		await runInContext("computer.close()", realm);

		expect(calls).toEqual([
			{
				action: "run",
				fn: String(fn),
				args: [7, { __omp_re: { source: "save", flags: "gi" } }, { __omp_fn: String(argFn) }],
				read_only: true,
				timeout: 5,
			},
			{ action: "run", code: "41 + 1", timeout: 2 },
			{ action: "capabilities" },
			{ action: "call", chain: [{ method: "window", args: [{ app: "Code" }] }] },
			{ action: "call", chain: [{ method: "focusedWindow", args: [] }] },
			{
				action: "call",
				chain: [
					{ method: "window", args: ["42"] },
					{ method: "ax", args: [{ maxDepth: 3 }] },
				],
			},
			{
				action: "call",
				chain: [
					{ method: "window", args: ["42"] },
					{ method: "press", args: ["cmd+s"] },
				],
			},
			{ action: "call", chain: [{ method: "ref", args: ["e1"] }] },
			{
				action: "call",
				chain: [
					{ method: "ref", args: ["e1"] },
					{ method: "bounds", args: [] },
				],
			},
			{
				action: "call",
				chain: [
					{ method: "ref", args: ["e1"] },
					{ method: "parent", args: [] },
				],
			},
			{
				action: "call",
				chain: [
					{ method: "ref", args: ["e1"] },
					{ method: "children", args: [] },
				],
			},
			{
				action: "call",
				chain: [
					{ method: "window", args: ["42"] },
					{ method: "find", args: [{ role: "button" }] },
				],
			},
			{ action: "call", chain: [{ method: "elementAt", args: [3, 4] }] },
			{ action: "call", chain: [{ method: "clipboard.read", args: [] }] },
			{ action: "close" },
		]);
		expect(displays).toEqual(["inner display", "inner display"]);
		expect(
			runInContext(
				"Object.isFrozen(computer) && Object.isFrozen(computer.clipboard) && Object.isFrozen(win) && Object.isFrozen(el)",
				realm,
			),
		).toBe(true);
		await expect(runInContext("computer.run({ code: '1 + 1' })", realm)).rejects.toThrow(
			"computer.run() expects a function or code string",
		);
		await expect(runInContext('computer.run("1", null)', realm)).rejects.toThrow(
			"computer.run() expects an options object",
		);
		await expect(runInContext("computer.run(Math.max)", realm)).rejects.toThrow(
			"computer.run() cannot serialize a native or bound function",
		);
	});

	it("refuses run args it would drop before anything runs, and still runs empty or null args", async () => {
		const prelude = createComputerPrelude(toolSession(), () => ({
			async run() {
				return { displays: [], returnValue: undefined, screenshots: [] };
			},
			async capabilities() {
				return undefined;
			},
			async close() {},
		}));
		const calls: unknown[] = [];
		const realm = createContext({
			__omp_log__: () => {},
			__omp_prelude__: async (_name: unknown, parameters: unknown) => {
				calls.push(parameters);
				return { text: "", details: { value: "ran" } };
			},
		});
		runInContext(prelude.javascript, realm);

		await expect(
			runInContext('computer.run(async (_scope, path) => path, { args: { path: "/tmp" } })', realm),
		).rejects.toThrow("computer.run() args must be an array of the function's arguments after its scope");
		await expect(runInContext('computer.run("return 1;", { args: ["/tmp"] })', realm)).rejects.toThrow(
			"computer.run() passes args only to a function; a code string receives none",
		);
		expect(calls).toEqual([]);

		expect(await runInContext('computer.run("return 1;", { args: [] })', realm)).toBe("ran");
		expect(await runInContext("computer.run(async () => 1, { args: null })", realm)).toBe("ran");
		expect(calls).toEqual([
			{ code: "return 1;", action: "run" },
			{ fn: "async () => 1", args: [], action: "run" },
		]);
	});

	it("tells a caller running direct helpers together to await each one or use one run", async () => {
		const gate = Promise.withResolvers<void>();
		class GatedSession extends FakeNativeSession {
			override async listWindows(): Promise<DesktopWindow[]> {
				await gate.promise;
				return super.listWindows();
			}
		}
		const session = toolSession();
		const prelude = workerPrelude(session, new GatedSession());
		const context = { session, toolCallId: "parallel-direct-js" };
		const realm = createContext({
			__omp_log__: () => {},
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const result = await prelude.invoke(parameters, context);
				return { text: "", details: result.details };
			},
		});
		runInContext(prelude.javascript, realm);
		try {
			const calls = runInContext("[computer.window(42), computer.window(42)]", realm) as Promise<unknown>[];
			// The first lookup holds the worker in native code until the gate opens, so the other one is refused.
			const refused = await Promise.any(
				calls.map(call =>
					call.then(
						() => {
							throw new Error("not refused");
						},
						error => error,
					),
				),
			);
			gate.resolve();
			const results = await Promise.allSettled(calls);
			expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
			const error = String(refused);
			expect(error).toContain("Computer worker is busy");
			expect(error).toContain("Await each call before starting the next");
			expect(error).toContain("computer.run(");
		} finally {
			gate.resolve();
			await prelude.invoke({ action: "close" }, context);
		}
	});

	it("returns direct values and prints inner display text from the Python facade in a real kernel", async () => {
		const calls: unknown[] = [];
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = {
			...toolSession(),
			getEvalPreludes: () => definitions,
		};
		const shipped = createComputerPrelude(session, () => ({
			async run() {
				return { displays: [], returnValue: undefined, screenshots: [] };
			},
			async capabilities() {
				return undefined;
			},
			async close() {},
		}));
		const callValues: Record<string, unknown> = {
			window: {
				id: "42",
				app: "Code",
				title: "main.ts",
				bounds: { x: 1, y: 2, width: 3, height: 4 },
				focused: true,
			},
			ax: "- button [ref=e1]",
			ref: { ref: "e1", role: "button", nativeRole: "AXButton", enabled: true, focused: false, childCount: 0 },
			press: undefined,
			selectText: { start: 7, length: 0, text: "", focused: true },
			raise: undefined,
			click: undefined,
		};
		const definition: EvalPreludeDefinition = {
			...shipped,
			async invoke(parameters) {
				calls.push(parameters);
				if (parameters !== null && typeof parameters === "object" && "chain" in parameters) {
					return { content: [], details: { value: callValues[terminalMethod(parameters.chain)] } };
				}
				return {
					content: [{ type: "text", text: "computer inner display" }],
					details: { value: { answer: 42 } },
				};
			},
		};
		definitions = [definition];

		const result = await executePython(
			[
				'value = await computer.run("return 6 * 7;", read_only=True, timeout=3)',
				'print(value["answer"])',
				"try:",
				"    await computer.run(lambda: 42)",
				"except TypeError as error:",
				"    print(str(error))",
				'win = await computer.window(app="Code")',
				"print(repr(win), win.bounds)",
				"print(await win.ax(maxDepth=3))",
				'el = await win.ref("e1")',
				"print(repr(el))",
				"await el.press()",
				'print((await el.selectText("cat", prefix="red ", select="end"))["start"])',
				"await win.raise_()",
				"await win.click(10, 20, button='right', takeover=None)",
			].join("\n"),
			{
				cwd: process.cwd(),
				sessionId: `computer-facade-py-${crypto.randomUUID()}`,
				toolSession: session,
				kernelMode: "per-call",
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.output.trim().split("\n")).toEqual([
			"computer inner display",
			"42",
			"computer.run() expects a JavaScript code string",
			"<computer.Window id='42' app='Code'> {'x': 1, 'y': 2, 'width': 3, 'height': 4}",
			"- button [ref=e1]",
			"<computer.Element ref='e1' role='button'>",
			"7",
		]);
		expect(calls).toEqual([
			{ action: "run", code: "return 6 * 7;", read_only: true, timeout: 3 },
			{ action: "call", chain: [{ method: "window", args: [{ app: "Code" }] }] },
			{
				action: "call",
				chain: [
					{ method: "window", args: ["42"] },
					{ method: "ax", args: [{ maxDepth: 3 }] },
				],
			},
			{ action: "call", chain: [{ method: "ref", args: ["e1"] }] },
			{
				action: "call",
				chain: [
					{ method: "ref", args: ["e1"] },
					{ method: "press", args: [] },
				],
			},
			{
				action: "call",
				chain: [
					{ method: "ref", args: ["e1"] },
					{ method: "selectText", args: ["cat", { prefix: "red ", select: "end" }] },
				],
			},
			{
				action: "call",
				chain: [
					{ method: "window", args: ["42"] },
					{ method: "raise", args: [] },
				],
			},
			{
				action: "call",
				chain: [
					{ method: "window", args: ["42"] },
					{ method: "click", args: [10, 20, { button: "right" }] },
				],
			},
		]);
	});

	it("keeps full target click frames across direct JavaScript and run zooms", async () => {
		const session = toolSession();
		const native = new ZoomNativeSession();
		const prelude = workerPrelude(session, native);
		const emitted: unknown[] = [];
		const context = { session, toolCallId: "zoom-js" };
		const realm = createContext({
			__omp_log__: () => {},
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const result = await prelude.invoke(parameters, context);
				emitted.push(...result.content);
				return {
					text: result.content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n"),
					details: result.details,
				};
			},
		});
		runInContext(prelude.javascript, realm);
		try {
			const zooms = await runInContext(
				`(async () => {
					await computer.screenshot({ silent: true });
					const win = await computer.window(42);
					await win.screenshot({ silent: true });
					const region = { x: 8, y: 4, width: 16, height: 8 };
					const desktopZoom = await computer.zoom(region);
					const windowZoom = await win.zoom(region, { silent: true });
					await computer.click(60, 30);
					await win.click(60, 30);
					const runZoom = await computer.run(async ({ desktop }) => {
						const win = await desktop.window(42);
						const zoom = await win.zoom({ x: 8, y: 4, width: 16, height: 8 }, { silent: true });
						await win.click(60, 30);
						return zoom;
					});
					return [desktopZoom, windowZoom, runZoom];
				})()`,
				realm,
			);
			for (const zoom of zooms) {
				expect(zoom.path).toMatch(/omp-computer-.*\.png$/);
				expect(zoom).toMatchObject({
					width: 128,
					height: 64,
					coordinateWidth: 64,
					coordinateHeight: 32,
					region: { x: 8, y: 4, width: 16, height: 8 },
				});
			}
			expect(native.fullCaptureCounts).toEqual(
				new Map([
					["desktop", 1],
					["42", 1],
				]),
			);
			expect(native.clicks).toEqual([
				{ target: "desktop", x: 60, y: 30 },
				{ target: "42", x: 60, y: 30 },
				{ target: "42", x: 60, y: 30 },
			]);
			expect(emitted).toContainEqual({
				type: "image",
				data: "iVBORw==",
				mimeType: "image/png",
				detail: "original",
			});
			expect(emitted).toContainEqual({
				type: "text",
				text: expect.stringContaining(
					'region={"x":8,"y":4,"width":16,"height":8}; coordinateWidth=64 coordinateHeight=32; use the base full screenshot coordinates for input, not zoom pixels',
				),
			});
		} finally {
			await prelude.invoke({ action: "close" }, context);
		}
	});

	it("keeps full target click frames across direct Python and run zooms", async () => {
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = { ...toolSession(), getEvalPreludes: () => definitions };
		const native = new ZoomNativeSession();
		const prelude = workerPrelude(session, native);
		definitions = [prelude];
		try {
			const result = await executePython(
				[
					"import json",
					"await computer.screenshot(silent=True)",
					"win = await computer.window(42)",
					"await win.screenshot(silent=True)",
					'region = {"x": 8, "y": 4, "width": 16, "height": 8}',
					"desktop_zoom = await computer.zoom(region, silent=True)",
					"window_zoom = await win.zoom(region, silent=True)",
					"await computer.click(60, 30)",
					"await win.click(60, 30)",
					`run_zoom = await computer.run('const zoom = await desktop.zoom({ x: 8, y: 4, width: 16, height: 8 }, { silent: true }); await desktop.click(60, 30); return zoom;')`,
					"print(json.dumps([desktop_zoom, window_zoom, run_zoom]))",
				].join("\n"),
				{
					cwd: process.cwd(),
					sessionId: `computer-zoom-py-${crypto.randomUUID()}`,
					toolSession: session,
					kernelMode: "per-call",
				},
			);
			expect(result.exitCode).toBe(0);
			const zooms = JSON.parse(result.output.trim());
			expect(zooms).toHaveLength(3);
			for (const zoom of zooms) {
				expect(zoom).toMatchObject({
					width: 128,
					height: 64,
					coordinateWidth: 64,
					coordinateHeight: 32,
					region: { x: 8, y: 4, width: 16, height: 8 },
				});
			}
			expect(native.fullCaptureCounts).toEqual(
				new Map([
					["desktop", 1],
					["42", 1],
				]),
			);
			expect(native.clicks).toEqual([
				{ target: "desktop", x: 60, y: 30 },
				{ target: "42", x: 60, y: 30 },
				{ target: "desktop", x: 60, y: 30 },
			]);
		} finally {
			await prelude.invoke({ action: "close" }, { session, toolCallId: "zoom-py-close" });
		}
	});

	class RefCallSession extends FakeNativeSession {
		readonly axCalls: unknown[] = [];
		override async axNode(ref: string): Promise<AxNode> {
			this.axCalls.push(["axNode", ref]);
			return axNode;
		}
		override async axPerform(ref: string, action: string): Promise<void> {
			this.axCalls.push(["axPerform", ref, action]);
		}
		override async axClick(ref: string, opts?: PointerOptions | null): Promise<void> {
			this.axCalls.push(["axClick", ref, opts]);
		}
		override async axKeyChord(ref: string, keys: string[], opts?: PointerOptions | null): Promise<void> {
			this.axCalls.push(["axKeyChord", ref, keys, opts]);
		}
	}

	it("chains element calls on JavaScript ref() handles, direct and in runs, and double-clicks", async () => {
		const session = toolSession();
		const native = new RefCallSession();
		const prelude = workerPrelude(session, native);
		const context = { session, toolCallId: "ref-chain-js" };
		const realm = createContext({
			__omp_log__: () => {},
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const result = await prelude.invoke(parameters, context);
				return { text: "", details: result.details };
			},
		});
		runInContext(prelude.javascript, realm);
		try {
			const role = await runInContext(
				`(async () => {
					const win = await computer.window(42);
					await win.ref("e1").click({ count: 2 });
					await computer.ref("e1").press();
					const el = await win.ref("e1");
					await el.click({ count: 2, button: "right" });
					await computer.run(async ({ desktop }) => {
						const win = await desktop.window(42);
						await win.ref("e1").click({ count: 2 });
						await desktop.ref("e1").press();
					});
					return el.role;
				})()`,
				realm,
			);
			expect(role).toBe("button");
			expect(native.axCalls).toEqual([
				["axNode", "e1"],
				["axClick", "e1", { count: 2 }],
				["axNode", "e1"],
				["axPerform", "e1", "press"],
				["axNode", "e1"],
				["axNode", "e1"],
				["axClick", "e1", { button: "right", count: 2 }],
				["axNode", "e1"],
				["axClick", "e1", { count: 2 }],
				["axNode", "e1"],
				["axPerform", "e1", "press"],
			]);
		} finally {
			await prelude.invoke({ action: "close" }, context);
		}
	});

	it("presses a chord into a JavaScript element and keeps press() without a chord the native press", async () => {
		const session = toolSession();
		const native = new RefCallSession();
		const prelude = workerPrelude(session, native);
		const context = { session, toolCallId: "element-keys-js" };
		const realm = createContext({
			__omp_display__: () => {},
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const result = await prelude.invoke(parameters, context);
				return { text: "", details: result.details };
			},
		});
		runInContext(prelude.javascript, realm);
		try {
			await runInContext(
				`(async () => {
					const win = await computer.window(42);
					await win.ref("e1").press("cmd+a");
					await win.ref("e1").press();
					await computer.run(async ({ desktop }) => {
						const el = await desktop.ref("e1");
						await el.press(["shift", "tab"]);
						await el.press();
					});
				})()`,
				realm,
			);
			expect(native.axCalls.filter(call => (call as unknown[])[0] !== "axNode")).toEqual([
				["axKeyChord", "e1", ["cmd", "a"], {}],
				["axPerform", "e1", "press"],
				["axKeyChord", "e1", ["shift", "tab"], {}],
				["axPerform", "e1", "press"],
			]);
		} finally {
			await prelude.invoke({ action: "close" }, context);
		}
	});

	it("chains element calls on Python ref() handles and still awaits them to elements", async () => {
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = { ...toolSession(), getEvalPreludes: () => definitions };
		const native = new RefCallSession();
		const prelude = workerPrelude(session, native);
		definitions = [prelude];
		try {
			const result = await executePython(
				[
					"win = await computer.window(42)",
					'await win.ref("e1").click(count=2)',
					'await computer.ref("e1").press()',
					'el = await win.ref("e1")',
					"print(repr(el))",
				].join("\n"),
				{
					cwd: process.cwd(),
					sessionId: `computer-ref-chain-py-${crypto.randomUUID()}`,
					toolSession: session,
					kernelMode: "per-call",
				},
			);
			expect(result.exitCode).toBe(0);
			expect(result.output.trim()).toBe("<computer.Element ref='e1' role='button'>");
			expect(native.axCalls).toEqual([
				["axNode", "e1"],
				["axClick", "e1", { count: 2 }],
				["axNode", "e1"],
				["axPerform", "e1", "press"],
				["axNode", "e1"],
			]);
		} finally {
			await prelude.invoke({ action: "close" }, { session, toolCallId: "ref-chain-py-close" });
		}
	});

	it("double-clicks JavaScript elements and names the element call made on find()'s array", async () => {
		const session = toolSession();
		const native = new RefCallSession();
		const prelude = workerPrelude(session, native);
		const context = { session, toolCallId: "element-shape-js" };
		const realm = createContext({
			__omp_log__: () => {},
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const result = await prelude.invoke(parameters, context);
				return { text: "", details: result.details };
			},
		});
		runInContext(prelude.javascript, realm);
		try {
			const shape = await runInContext(
				`(async () => {
					const win = await computer.window(42);
					await win.ref("e1").doubleClick({ button: "right" });
					await (await win.ref("e1")).doubleClick({ count: 3 });
					const found = await win.find({ role: "button" });
					await found[0].doubleClick();
					await computer.run(async ({ desktop }) => {
						await desktop.ref("e1").doubleClick();
						const [el] = await (await desktop.window(42)).find({ role: "button" });
						await el.doubleClick();
					});
					return { json: JSON.stringify(found), keys: Object.keys(found), spread: [...found].length };
				})()`,
				realm,
			);
			expect({ ...shape, json: JSON.parse(shape.json) }).toEqual({
				json: [expect.objectContaining({ ref: "e1", role: "button" })],
				keys: ["0"],
				spread: 1,
			});
			expect(native.axCalls.filter(call => (call as unknown[])[0] === "axClick")).toEqual([
				["axClick", "e1", { button: "right", count: 2 }],
				["axClick", "e1", { count: 2 }],
				["axClick", "e1", { count: 2 }],
				["axClick", "e1", { count: 2 }],
				["axClick", "e1", { count: 2 }],
			]);
			const misuse = await runInContext(
				`(async () => {
					const win = await computer.window(42);
					const found = await win.find({ role: "button", title: "Run" });
					const messages = [];
					for (const misuse of [() => found.press(), () => win.ref(found.ref)]) {
						try {
							await misuse();
						} catch (error) {
							messages.push(error.message);
						}
					}
					return messages;
				})()`,
				realm,
			);
			expect(misuse).toHaveLength(2);
			expect(misuse[0]).toContain("find() returns an array (length 1), not one element, so it has no press()");
			expect(misuse[0]).toContain("const [el] = await win.find(");
			expect(misuse[1]).toContain("find() returns an array (length 1), not one element, so it has no ref;");
		} finally {
			await prelude.invoke({ action: "close" }, context);
		}
	});

	it("double-clicks Python elements and names the element attribute read on find()'s list", async () => {
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = { ...toolSession(), getEvalPreludes: () => definitions };
		const native = new RefCallSession();
		const prelude = workerPrelude(session, native);
		definitions = [prelude];
		try {
			const result = await executePython(
				[
					"import copy",
					"win = await computer.window(42)",
					'await win.ref("e1").doubleClick(button="right")',
					'found = await win.find({"role": "button"})',
					"await found[0].doubleClick()",
					"try:",
					"    await found.press()",
					"except AttributeError as error:",
					"    print(error)",
					"print(hasattr(found, 'click'), hasattr(found, 'nope'))",
					"print([element.ref for element in found], found)",
					"print(type(copy.copy(found)).__name__, type(copy.deepcopy(found)).__name__)",
				].join("\n"),
				{
					cwd: process.cwd(),
					sessionId: `computer-element-shape-py-${crypto.randomUUID()}`,
					toolSession: session,
					kernelMode: "per-call",
				},
			);
			expect(result.exitCode).toBe(0);
			const lines = result.output.trim().split("\n");
			expect(lines[0]).toContain("find() returns a list (length 1), not one element, so it has no press");
			expect(lines[0]).toContain("el = (await win.find(query))[0]");
			expect(lines[1]).toBe("False False");
			expect(lines[2]).toStartWith("['e1'] [<");
			expect(lines[3]).toBe("list list");
			expect(native.axCalls.filter(call => (call as unknown[])[0] === "axClick")).toEqual([
				["axClick", "e1", { button: "right", count: 2 }],
				["axClick", "e1", { count: 2 }],
			]);
		} finally {
			await prelude.invoke({ action: "close" }, { session, toolCallId: "element-shape-py-close" });
		}
	});

	it("treats text-only Python host responses as unavailable capabilities", async () => {
		const calls: unknown[] = [];
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = {
			...toolSession(),
			getEvalPreludes: () => definitions,
		};
		const shipped = createComputerPrelude(session, () => ({
			async run() {
				return { displays: [], returnValue: undefined, screenshots: [] };
			},
			async capabilities() {
				return undefined;
			},
			async close() {},
		}));
		definitions = [
			{
				...shipped,
				async invoke(parameters) {
					calls.push(parameters);
					return { content: [{ type: "text", text: "Computer capabilities unavailable" }] };
				},
			},
		];

		const result = await executePython("print(await computer.capabilities())", {
			cwd: process.cwd(),
			sessionId: `computer-unavailable-py-${crypto.randomUUID()}`,
			toolSession: session,
			kernelMode: "per-call",
		});

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("None");
		expect(calls).toEqual([{ action: "capabilities" }]);
	});

	it("reflects the live enabled setting", () => {
		const session = toolSession();
		const prelude = createComputerPrelude(session, () => ({
			async run() {
				return { displays: [], returnValue: undefined, screenshots: [] };
			},
			async capabilities() {
				return undefined;
			},
			async close() {},
		}));

		expect(prelude.enabled?.()).toBe(true);
		cfgComputerEnabled.override(session.settings, false);
		expect(prelude.enabled?.()).toBe(false);
	});
});

describe("computer worker round trips", () => {
	it("lists windows and returns screenshot caption, image, and detail through a fake native session", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, options => {
			expect(options).toEqual({ display: "active", escapeStopKey: expect.stringMatching(/^computer-test-/) });
			return native;
		});

		const result = await runWorker(
			transport,
			"capture",
			"const windows = await desktop.windows(); await desktop.screenshot(); ({ count: windows.length })",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.payload.returnValue).toEqual({ count: 1 });
		const texts = result.payload.displays.filter(block => block.type === "text");
		const images = result.payload.displays.filter(block => block.type === "image");
		expect(texts).toHaveLength(1);
		expect(texts[0]?.text).toMatch(
			/^screenshot desktop 64×32; coordinateWidth=64 coordinateHeight=32 → .*omp-computer-.*\.png$/,
		);
		expect(images).toEqual([{ type: "image", data: "iVBORw==", mimeType: "image/png", detail: "original" }]);
		expect(result.payload.screenshots).toHaveLength(1);
		expect(result.payload.screenshots[0]).toMatchObject({ width: 64, height: 32, target: "desktop" });
		expect(result.payload.screenshots[0]?.path).toMatch(/omp-computer-.*\.png$/);
	});

	it("reports source dimensions when a screenshot is scaled", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		native.sourceWidth = 128;
		native.sourceHeight = 64;
		new ComputerWorkerCore(transport, () => native);

		const result = await runWorker(transport, "scaled-capture", "await desktop.screenshot()");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.payload.displays[0]).toEqual(
			expect.objectContaining({
				type: "text",
				text: expect.stringMatching(
					/^screenshot desktop 64×32 \(scaled from 128×64\); coordinateWidth=64 coordinateHeight=32 → .*omp-computer-.*\.png$/,
				),
			}),
		);
		expect(result.payload.screenshots[0]).toMatchObject({
			width: 64,
			height: 32,
			sourceWidth: 128,
			sourceHeight: 64,
		});
	});

	it("marks a screenshot taken behind the lock screen, and only then", async () => {
		for (const locked of [true, false]) {
			const transport = new MemoryTransport();
			const native = new FakeNativeSession();
			native.screenLocked = locked;
			new ComputerWorkerCore(transport, () => native);

			const result = await runWorker(transport, `locked-${locked}`, "return await desktop.screenshot()");
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const [caption] = result.payload.displays.filter(block => block.type === "text");
			const lines = caption?.type === "text" ? caption.text.split("\n") : [];
			if (locked) {
				expect(lines).toHaveLength(2);
				expect(lines[1]).toBe(SCREEN_LOCKED_CAPTURE_NOTE);
				expect(result.payload.screenshots[0]?.screenLocked).toBe(true);
				expect(result.payload.returnValue).toMatchObject({ screenLocked: true });
			} else {
				expect(lines).toHaveLength(1);
				expect(result.payload.screenshots[0]).not.toHaveProperty("screenLocked");
				expect(result.payload.returnValue).not.toHaveProperty("screenLocked");
			}
		}
	});

	it("tells the model a run ended on a locked screen without refusing its input", async () => {
		for (const locked of [true, false]) {
			const session = toolSession();
			const native = new FakeNativeSession();
			native.screenLocked = locked;
			const prelude = workerPrelude(session, native);
			const result = await prelude.invoke(
				{ action: "run", code: "await desktop.screenshot({ silent: true }); await desktop.click(1, 2)" },
				{ session, toolCallId: `locked-run-${locked}`, signal: new AbortController().signal },
			);
			expect(native.clickCount).toBe(1);
			const notes = result.content.filter(block => block.type === "text" && block.text.startsWith("Note: "));
			if (locked) {
				expect(result.content[0]).toMatchObject({
					type: "text",
					text: expect.stringMatching(/^Note: when this run ended the screen is locked\. /),
				});
			} else {
				expect(notes).toEqual([]);
			}
		}
	});

	it("keeps a failed run's own error first and adds the lock state after it", async () => {
		for (const locked of [true, false]) {
			const transport = new MemoryTransport();
			const native = new FakeNativeSession();
			native.screenLocked = locked;
			new ComputerWorkerCore(transport, () => native);
			const result = await runWorker(
				transport,
				`failed-${locked}`,
				'await desktop.screenshot({ silent: true }); await desktop.click(1, 2); assert(false, "verification failed")',
			);
			expect(native.clickCount).toBe(1);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			const [first, ...rest] = result.error.message.split("\n");
			expect(first).toBe("verification failed");
			if (locked) expect(rest.join("\n")).toMatch(/^Note: when this run ended the screen is locked\. /);
			else expect(rest).toEqual([]);
		}
	});

	it("scopes a display-sleep notice to the session's display", async () => {
		const session = toolSession();
		const native = new FakeNativeSession();
		native.displayAsleep = true;
		const prelude = workerPrelude(session, native);
		const result = await prelude.invoke(
			{ action: "run", code: "await desktop.click(1, 2)" },
			{ session, toolCallId: "asleep-run", signal: new AbortController().signal },
		);
		const [note] = result.content;
		const text = note?.type === "text" ? note.text : "";
		expect(text).toMatch(/^Note: when this run ended the session's display is asleep\. /);
		expect(text).toContain("Nothing on that display can be captured or clicked until it wakes.");
		expect(text).toContain("`computer.display`");
	});

	it("adds the lock state to a run timed out by a hung native call without reading capabilities", async () => {
		const started = Promise.withResolvers<void>();
		const hung = Promise.withResolvers<DesktopCapture>();
		class HungSession extends FakeNativeSession {
			/** Native capabilities reads queue behind the hung call when no snapshot exists. */
			blockingReads = 0;
			override get capabilities(): DesktopCapabilities {
				this.blockingReads += 1;
				return super.capabilities;
			}
			override async capture(): Promise<DesktopCapture> {
				started.resolve();
				// Stuck in the OS: cancellation does not settle it.
				return hung.promise;
			}
		}
		const native = new HungSession();
		native.screenLocked = true;
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => native);
		const pending = runWorker(transport, "hung", "await desktop.screenshot({ silent: true })", false, 50);
		await started.promise;
		const result = await pending;
		// Let the script's runtime finish so later tests can start theirs.
		hung.reject(new Error("released"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const [first, ...rest] = result.error.message.split("\n");
		expect(first).toBe("Computer code execution timed out after 50ms");
		expect(rest.join("\n")).toMatch(/^Note: when this run ended the screen is locked\. /);
		expect(native.blockingReads).toBe(0);
	});

	it("blocks read-only click after capture before invoking native input", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		const result = await runWorker(
			transport,
			"read-only",
			"await desktop.screenshot({ silent: true }); await desktop.click(1, 2)",
			true,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.isToolError).toBe(true);
		expect(result.error.message).toBe("read-only run: 'click' requires read_only: false");
		expect(native.clickCount).toBe(0);
	});

	it("rejects an aborted run with an abort error", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		transport.inbound({
			type: "run",
			id: "abort",
			code: "await wait(5_000)",
			timeoutMs: 5_000,
			session: snapshot(),
			escape: escapeScope(),
		});
		await Promise.resolve();
		transport.inbound({ type: "abort", id: "abort" });
		const result = await transport.waitFor(message => message.type === "result" && message.id === "abort");
		expect(result.type).toBe("result");
		if (result.type !== "result" || result.ok) return;
		expect(result.error.isAbort).toBe(true);
		expect(result.error.name).toBe("ToolAbortError");
	});

	it("reports the worker watchdog timeout budget explicitly", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());

		const result = await runWorker(transport, "timeout", "await wait(5_000)", false, 10);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatchObject({
			isToolError: true,
			message: "Computer code execution timed out after 10ms",
		});
	});

	it.each(["abort", "timeout"] as const)("cancels native work on %s and reuses the same session", async reason => {
		const started = Promise.withResolvers<void>();
		const pendingCapture = Promise.withResolvers<DesktopCapture>();
		class CancellableSession extends FakeNativeSession {
			#block = true;

			override async capture(target: string): Promise<DesktopCapture> {
				if (!this.#block) return super.capture(target);
				this.#block = false;
				started.resolve();
				return pendingCapture.promise;
			}

			override cancel(): void {
				super.cancel();
				pendingCapture.reject(new Error("Cancelled: native capture stopped"));
			}
		}
		const native = new CancellableSession();
		const transport = new MemoryTransport();
		let creations = 0;
		new ComputerWorkerCore(transport, () => {
			creations += 1;
			return native;
		});
		const pending = runWorker(
			transport,
			"cancel-native",
			"await desktop.screenshot({ silent: true }); await desktop.click(1, 2)",
			false,
			reason === "timeout" ? 100 : 2_000,
		);
		await started.promise;
		if (reason === "abort") {
			transport.inbound({ type: "abort", id: "cancel-native" });
			// The native signal is synchronous, not deferred until Promise.race settles.
			expect(native.cancelCount).toBe(1);
		}
		const cancelled = await pending;
		expect(cancelled.ok).toBe(false);
		if (!cancelled.ok) {
			expect(cancelled.error.message).toContain(reason === "timeout" ? "timed out after 100ms" : "aborted");
		}
		expect(native.cancelCount).toBe(1);
		expect(native.clickCount).toBe(0);
		const recovered = await runWorker(
			transport,
			"after-native-cancel",
			"await desktop.screenshot({ silent: true }); await desktop.click(1, 2)",
		);
		expect(recovered.ok).toBe(true);
		expect(native.clickCount).toBe(1);
		expect(native.cancelCount).toBe(1);
		expect(native.retireCount).toBe(1);
		expect(native.closeCount).toBe(0);
		expect(creations).toBe(1);
	});

	it("does not let a finished run's watchdog or stale abort cancel the next native operation", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);
		const first = await runWorker(transport, "finished", "42", false, 100);
		expect(first.ok).toBe(true);
		expect(native.retireCount).toBe(1);
		expect(native.cancelCount).toBe(0);
		const second = runWorker(
			transport,
			"next",
			"await wait(150); await desktop.screenshot({ silent: true }); await desktop.click(1, 2)",
		);
		transport.inbound({ type: "abort", id: "finished" });
		expect((await second).ok).toBe(true);
		expect(native.retireCount).toBe(2);
		expect(native.cancelCount).toBe(0);
		expect(native.clickCount).toBe(1);
	});

	it("cancels unawaited native mutations before the next run without cancelling that run", async () => {
		const releaseOld = Promise.withResolvers<void>();
		const oldSettled = Promise.withResolvers<void>();
		class QueuedInputSession extends FakeNativeSession {
			#generation = 0;
			readonly delivered: number[] = [];

			override async click(_target: string, x: number): Promise<void> {
				const generation = this.#generation;
				if (x === 1) {
					try {
						await releaseOld.promise;
						if (generation !== this.#generation) throw new Error("Cancelled: old input generation");
						this.delivered.push(x);
					} finally {
						oldSettled.resolve();
					}
				} else {
					this.delivered.push(x);
				}
			}

			override cancel(): void {
				super.cancel();
				this.#generation += 1;
			}
			override retire(): void {
				super.retire();
				this.#generation += 1;
			}
		}
		const native = new QueuedInputSession();
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => native);
		const first = await runWorker(transport, "floating-input", 'void desktop.click(1, 1); "returned"');
		expect(first.ok).toBe(true);
		if (first.ok) expect(first.payload.returnValue).toBe("returned");

		const second = runWorker(
			transport,
			"next-input",
			'await tool.inputBarrier(); await desktop.click(2, 2); "fresh"',
		);
		const barrier = await transport.waitFor(
			message => message.type === "tool-call" && message.runId === "next-input",
		);
		if (barrier.type !== "tool-call") throw new Error("Expected next run's input barrier");
		// Let the old queued input reach its event-delivery check while the next
		// run is active. It must observe the retired generation and deliver nothing.
		releaseOld.resolve();
		await oldSettled.promise;
		expect(native.delivered).toEqual([]);
		expect(native.retireCount).toBe(1);
		transport.inbound({ type: "tool-reply", id: barrier.id, reply: { ok: true, value: null } });
		const recovered = await second;
		expect(recovered.ok).toBe(true);
		if (recovered.ok) expect(recovered.payload.returnValue).toBe("fresh");
		expect(native.delivered).toEqual([2]);
		expect(native.retireCount).toBe(2);
	});

	it("requires a full screenshot of the same target before zoom and never replaces it for invalid input", async () => {
		const transport = new MemoryTransport();
		const native = new ZoomNativeSession();
		new ComputerWorkerCore(transport, () => native);
		expect((await runWorker(transport, "desktop-only", "await desktop.screenshot({ silent: true })")).ok).toBe(true);
		const missing = await runWorker(
			transport,
			"missing-window-frame",
			"await (await desktop.window(42)).zoom({ x: 8, y: 4, width: 16, height: 8 })",
			true,
		);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error.message).toContain("screenshot 42 first");
		const invalid = await runWorker(transport, "missing-region", "await desktop.zoom(undefined)", true);
		expect(invalid.ok).toBe(false);
		expect(native.fullCaptureCounts).toEqual(new Map([["desktop", 1]]));
		expect((await runWorker(transport, "original-frame", "await desktop.click(60, 30)")).ok).toBe(true);
	});

	it("round-trips tool calls and resolves the in-script promise", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		const resultPromise = runWorker(transport, "bridge", "await tool.echo({ value: 7 })");
		const call = await transport.waitFor(message => message.type === "tool-call" && message.runId === "bridge");
		expect(call).toMatchObject({ type: "tool-call", runId: "bridge", name: "echo", args: { value: 7 } });
		if (call.type !== "tool-call") return;
		transport.inbound({ type: "tool-reply", id: call.id, reply: { ok: true, value: { echoed: 7 } } });
		const result = await resultPromise;
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.payload.returnValue).toEqual({ echoed: 7 });
	});

	it("uses a retained window screenshot in the current run payload", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());

		const first = await runWorker(
			transport,
			"retain-window-screenshot",
			'globalThis.retainedWin = await desktop.window("42")',
		);
		expect(first.ok).toBe(true);
		const second = await runWorker(
			transport,
			"reuse-window-screenshot",
			"await globalThis.retainedWin.screenshot({ silent: true })",
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.payload.screenshots).toHaveLength(1);
		expect(second.payload.screenshots[0]).toMatchObject({
			width: 64,
			height: 32,
			sourceWidth: 64,
			sourceHeight: 32,
			target: "42",
		});
	});

	describe("window selector misses", () => {
		const desktopWindows: DesktopWindow[] = [
			windowFixture,
			{ ...windowFixture, id: "43", title: "", focused: false },
			{ ...windowFixture, id: "7", app: "Finder", title: "Downloads", pid: 9, focused: false },
			{ ...windowFixture, id: "8", app: "TextEdit", title: "notes.txt", pid: 10, focused: false },
			{ ...windowFixture, id: "9", app: "TextEdit", title: "draft.txt", pid: 10, focused: false },
		];

		async function missMessage(windows: DesktopWindow[], selector: string): Promise<string> {
			const transport = new MemoryTransport();
			const native = new FakeNativeSession();
			native.listWindows = async () => windows;
			new ComputerWorkerCore(transport, () => native);
			const result = await runWorker(transport, "window-miss", `await desktop.window(${selector})`);
			expect(result.ok).toBe(false);
			return result.ok ? "" : result.error.message;
		}

		it("leads with the requested app's windows when its title filter misses", async () => {
			const message = await missMessage(desktopWindows, '{ app: "textedit", title: "report" }');
			expect(message.split("\n").slice(0, 3)).toEqual([
				'no window matches {"app":"textedit","title":"report"}',
				'Open windows by app (id "title"):',
				'- TextEdit: 8 "notes.txt", 9 "draft.txt"',
			]);
		});

		it("says the app has no window and lists every app's windows, untitled ones included", async () => {
			const lines = (await missMessage(desktopWindows, '{ app: "Calendar" }')).split("\n");
			expect(lines).toContain('No open window belongs to an app matching "Calendar".');
			expect(lines).toContain('- Code: 42 "Editor", 43 ""');
			expect(lines).toContain('- Finder: 7 "Downloads"');
			expect(lines).toContain('- TextEdit: 8 "notes.txt", 9 "draft.txt"');
		});

		it("lists untitled windows by id after titled ones, as when macOS hides other apps' titles", async () => {
			const blank = (id: string): DesktopWindow => ({
				...windowFixture,
				id,
				app: "Notes",
				title: "",
				focused: false,
			});
			const message = await missMessage(
				[windowFixture, blank("50"), blank("51"), blank("52"), { ...blank("53"), title: "Inbox" }],
				'"404"',
			);
			expect(message.split("\n")).toContain('- Notes: 53 "Inbox", 50 "", 51 "", 1 more');
		});

		it("bounds the listing on a desktop with many apps and long titles", async () => {
			const crowded = Array.from({ length: 40 }, (_, app) =>
				Array.from({ length: 4 }, (_, index) => ({
					...windowFixture,
					id: `${app}-${index}`,
					app: `App ${String(app).padStart(2, "0")}`,
					title: "t".repeat(300),
					focused: false,
				})),
			).flat();
			const message = await missMessage(crowded, '{ app: "Calendar" }');
			expect(message.length).toBeLessThan(5_000);
			expect(message.split("\n").at(-1)).toBe("- 28 more apps with 112 windows");
		});
	});

	it("resolves ref() to a populated live element and find() to every match", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		const result = await runWorker(
			transport,
			"ref-resolve",
			'const win = await desktop.window("42"); const el = await win.ref("e1"); const all = await win.find({ role: "button" }); ({ role: el.role, count: all.length })',
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.payload.returnValue).toEqual({ role: "button", count: 1 });
	});

	it("blocks read-only selectText before invoking the native session", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);
		const result = await runWorker(
			transport,
			"select-text-read-only",
			'await (await desktop.window("42")).ref("e1").selectText("cat")',
			true,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("read-only run: 'selectText'");
		expect(native.selections).toEqual([]);
	});

	it("names selectText's text argument on a resolved element before the native call", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);
		const result = await runWorker(
			transport,
			"select-text-resolved-argument",
			'const el = await (await desktop.window("42")).ref("e1"); await el.selectText(7)',
		);
		expect(result.ok ? undefined : result.error).toMatchObject({
			isToolError: true,
			message: "selectText(text) requires a string, got number",
		});
		expect(native.selections).toEqual([]);
	});

	describe("numeric window ids", () => {
		class TwoWindowSession extends FakeNativeSession {
			override async listWindows(): Promise<DesktopWindow[]> {
				return [windowFixture, { ...windowFixture, id: "7", app: "Numbers", title: "99", focused: false }];
			}
		}

		it.each([
			["a number", "desktop.window(42)"],
			["an { id } number", "desktop.window({ id: 42 })"],
		])("resolves %s as that window id", async (_label, selector) => {
			const transport = new MemoryTransport();
			new ComputerWorkerCore(transport, () => new TwoWindowSession());
			const result = await runWorker(transport, "numeric-id", `(await ${selector}).id`);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.payload.returnValue).toBe("42");
		});

		it.each([
			["a missing id", 404],
			["a number that is another window's title", 99],
		])("throws a miss for %s", async (_label, id) => {
			const transport = new MemoryTransport();
			new ComputerWorkerCore(transport, () => new TwoWindowSession());
			const result = await runWorker(transport, "numeric-miss", `await desktop.window(${id})`);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.message.split("\n")[0]).toBe(`no window matches ${id}`);
		});
	});

	describe("more windows than the listing cap", () => {
		class CrowdedSession extends FakeNativeSession {
			override async listWindows(): Promise<DesktopWindow[]> {
				const front = Array.from({ length: 59 }, (_, index) => ({
					...windowFixture,
					id: String(index + 100),
					app: "Front",
					focused: false,
				}));
				return [...front, { ...windowFixture, id: "999", app: "Rear", focused: false }];
			}
		}

		it("caps the listing after filtering and finds a window behind the cap by id or app", async () => {
			const transport = new MemoryTransport();
			new ComputerWorkerCore(transport, () => new CrowdedSession());
			const result = await runWorker(
				transport,
				"crowded-desktop",
				'({ listed: (await desktop.windows()).length, filtered: (await desktop.windows({ app: "rear" })).map(w => w.id), byId: (await desktop.window(999)).app, byApp: (await desktop.window({ app: "rear" })).id })',
			);
			expect(result.ok).toBe(true);
			if (result.ok)
				expect(result.payload.returnValue).toEqual({ listed: 48, filtered: ["999"], byId: "Rear", byApp: "999" });
		});

		it("lists at most 48 candidates for an ambiguous filter", async () => {
			const transport = new MemoryTransport();
			new ComputerWorkerCore(transport, () => new CrowdedSession());
			const result = await runWorker(transport, "crowded-ambiguous", 'await desktop.window({ app: "front" })');
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.message).toContain("147 Front");
			expect(result.error.message).not.toContain("148 Front");
			expect(result.error.message).toContain("… 11 more");
		});
	});

	it("returns plain identity snapshots for rendered handle calls and enforces the derived read-only tier", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		const win = await runWorker(
			transport,
			"call-window",
			renderComputerCall([{ method: "window", args: ["42"] }]),
			true,
		);
		expect(win.ok).toBe(true);
		if (win.ok) {
			expect(win.payload.returnValue).toEqual({
				id: "42",
				app: "Code",
				title: "Editor",
				pid: 123,
				bounds: { x: 4, y: 5, width: 40, height: 20 },
				focused: true,
			});
		}

		const el = await runWorker(transport, "call-ref", renderComputerCall([{ method: "ref", args: ["e1"] }]), true);
		expect(el.ok).toBe(true);
		if (el.ok) {
			expect(el.payload.returnValue).toEqual({
				ref: "e1",
				role: "button",
				nativeRole: "button",
				title: "Save",
				enabled: true,
				focused: false,
				childCount: 0,
			});
		}

		const clickChain = [
			{ method: "window", args: ["42"] },
			{ method: "click", args: [1, 2] },
		];
		const blocked = await runWorker(transport, "call-click-ro", renderComputerCall(clickChain), true);
		expect(blocked.ok).toBe(false);
		expect(native.clickCount).toBe(0);
		const clicked = await runWorker(
			transport,
			"call-click",
			renderComputerCall(clickChain),
			isReadOnlyComputerCall(clickChain),
		);
		expect(clicked.ok).toBe(true);
		expect(native.clickCount).toBe(1);
	});

	it("returns find() results as plain arrays whose element calls name the pick, and gates element doubleClick as exec", async () => {
		const transport = new MemoryTransport();
		const axClicks: unknown[] = [];
		new ComputerWorkerCore(
			transport,
			() =>
				new (class extends FakeNativeSession {
					override async axClick(ref: string, opts?: PointerOptions | null): Promise<void> {
						axClicks.push([ref, opts]);
					}
				})(),
		);

		const found = await runWorker(
			transport,
			"call-find",
			renderComputerCall([
				{ method: "window", args: ["42"] },
				{ method: "find", args: [{ role: "button" }] },
			]),
			true,
		);
		expect(found.ok).toBe(true);
		if (found.ok) expect(found.payload.returnValue).toEqual([expect.objectContaining({ ref: "e1", role: "button" })]);

		const misuse = await runWorker(
			transport,
			"find-misuse",
			'await (await (await desktop.window(42)).find({ role: "button" })).doubleClick()',
		);
		expect(misuse.ok).toBe(false);
		if (!misuse.ok) {
			expect(misuse.error.message).toContain(
				"find() returns an array (length 1), not one element, so it has no doubleClick()",
			);
		}
		const fieldRead = await runWorker(
			transport,
			"find-field-read",
			'(await (await desktop.window(42)).find({ role: "button" })).enabled',
		);
		expect(fieldRead.ok).toBe(false);
		if (!fieldRead.ok) {
			expect(fieldRead.error.message).toContain(
				"find() returns an array (length 1), not one element, so it has no enabled;",
			);
		}

		const doubleClick = [
			{ method: "ref", args: ["e1"] },
			{ method: "doubleClick", args: [] },
		];
		const blocked = await runWorker(transport, "call-double-click-ro", renderComputerCall(doubleClick), true);
		expect(blocked.ok).toBe(false);
		expect(axClicks).toEqual([]);
		const clicked = await runWorker(
			transport,
			"call-double-click",
			renderComputerCall(doubleClick),
			isReadOnlyComputerCall(doubleClick),
		);
		expect(clicked.ok).toBe(true);
		expect(axClicks).toEqual([["e1", { count: 2 }]]);
	});

	it("applies the current read-only policy to a retained writable window", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		const first = await runWorker(
			transport,
			"retain-writable-window",
			'globalThis.retainedWin = await desktop.window("42")',
		);
		expect(first.ok).toBe(true);
		const second = await runWorker(
			transport,
			"reuse-window-read-only",
			"await globalThis.retainedWin.click(1, 1)",
			true,
		);
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.error.message).toBe("read-only run: 'click' requires read_only: false");
		expect(native.clickCount).toBe(0);
	});

	it("allows a retained read-only window to mutate in a later exec run", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		const first = await runWorker(
			transport,
			"retain-read-only-window",
			'globalThis.retainedWin = await desktop.window("42")',
			true,
		);
		expect(first.ok).toBe(true);
		const second = await runWorker(
			transport,
			"reuse-window-exec",
			"await globalThis.retainedWin.screenshot({ silent: true }); await globalThis.retainedWin.click(1, 1)",
		);
		expect(second.ok).toBe(true);
		expect(native.clickCount).toBe(1);
	});

	it("denies async continuations leaked from an ended run the next run's authority", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		// Run 1 (exec) leaks a promise continuation that clicks once triggered.
		// The continuation is registered inside run 1's async context, so it must
		// retain run 1's (aborted) context even when it executes during run 2.
		const first = await runWorker(
			transport,
			"leak-continuation",
			[
				'globalThis.leakWin = await desktop.window("42");',
				"globalThis.leakErr = null;",
				"const { promise: trigger, resolve: fireLeak } = Promise.withResolvers(); globalThis.fireLeak = fireLeak;",
				"globalThis.leakDone = trigger.then(() => globalThis.leakWin.click(1, 1)).catch(err => { globalThis.leakErr = String(err); });",
				'"armed"',
			].join("\n"),
		);
		expect(first.ok).toBe(true);
		// Run 2 (exec) fires the leaked continuation and awaits its settlement; the
		// click must fail with run 1's abort instead of borrowing run 2's policy.
		const second = await runWorker(
			transport,
			"leak-victim",
			"globalThis.fireLeak(); await globalThis.leakDone; globalThis.leakErr",
		);
		expect(second.ok).toBe(true);
		if (second.ok) expect(String(second.payload.returnValue)).toContain("Computer run ended");
		expect(native.clickCount).toBe(0);
	});

	it("uses a retained AX element in the current run", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());

		const first = await runWorker(
			transport,
			"retain-element",
			'globalThis.retainedEl = (await (await desktop.window("42")).find({ role: "button" }))[0]',
		);
		expect(first.ok).toBe(true);
		const second = await runWorker(transport, "reuse-element", "await globalThis.retainedEl.bounds()");
		expect(second.ok).toBe(true);
		if (second.ok) expect(second.payload.returnValue).toEqual({ x: 7, y: 8, width: 9, height: 10 });
	});

	it("refuses an empty menu path before anything is sent", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		const result = await runWorker(
			transport,
			"empty-menu-path",
			'const el = await (await desktop.window("42")).ref("e1"); return await el.press({ menu: [] }).then(() => "sent", error => error.message)',
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.payload.returnValue).not.toBe("sent");
		expect(result.payload.returnValue).toContain("menu path");
	});

	it("answers a direct capabilities request without a prior run", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		transport.inbound({ type: "capabilities", id: "caps", session: snapshot(true), escape: escapeScope() });
		const reply = await transport.waitFor(message => message.type === "capabilities" && message.id === "caps");
		expect(reply.type).toBe("capabilities");
		if (reply.type !== "capabilities" || !reply.ok) throw new Error("expected a successful capabilities reply");
		expect(reply.capabilities).toEqual(capabilities);
	});

	it("creates the native session once when a run and capabilities race a cold worker", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		let creations = 0;
		const release = Promise.withResolvers<void>();
		// Async factory reproduces the real `import(...)` suspension so both
		// handlers reach session creation before it resolves.
		new ComputerWorkerCore(transport, async () => {
			creations += 1;
			await release.promise;
			return native;
		});

		transport.inbound({
			type: "run",
			id: "race-run",
			code: "42",
			timeoutMs: 2_000,
			session: snapshot(true),
			escape: escapeScope(),
		});
		transport.inbound({ type: "capabilities", id: "race-caps", session: snapshot(true), escape: escapeScope() });
		release.resolve();

		const runReply = await transport.waitFor(message => message.type === "result" && message.id === "race-run");
		const capsReply = await transport.waitFor(
			message => message.type === "capabilities" && message.id === "race-caps",
		);
		expect(runReply.type === "result" && runReply.ok).toBe(true);
		expect(capsReply.type === "capabilities" && capsReply.ok).toBe(true);
		expect(creations).toBe(1);
	});
});

function liveWorker(native: NativeDesktopSession): ComputerWorkerHandle {
	const transport = new MemoryTransport();
	new ComputerWorkerCore(transport, () => native);
	return {
		send: message => transport.inbound(message),
		onMessage: handler => {
			transport.listeners.add(handler);
			queueMicrotask(() => handler({ type: "ready" }));
			return () => {
				transport.listeners.delete(handler);
			};
		},
		onError: () => () => {},
		terminate: async () => {
			transport.inbound({ type: "close" });
		},
	};
}

const CLICK = {
	action: "call",
	chain: [
		{ method: "window", args: ["42"] },
		{ method: "click", args: [1, 2] },
	],
};

/** A real supervisor, worker and prelude over a native session whose Escape stops the host reads, as it does natively. */
function escapeHarness() {
	const native = new EscapeNativeSession();
	const ownerId = `escape-owner-${crypto.randomUUID()}`;
	const session: ToolSession = { ...toolSession(), getEvalKernelOwnerId: () => ownerId };
	const runListeners = new Set<() => void>();
	const sent = {
		types: [] as string[],
		onRun(listener: () => void) {
			runListeners.add(listener);
			return () => runListeners.delete(listener);
		},
	};
	const supervisor = new ComputerSupervisor(
		session,
		() => {
			const worker = liveWorker(native);
			return {
				...worker,
				send: message => {
					sent.types.push(message.type);
					worker.send(message);
					if (message.type === "run") for (const listener of runListeners) listener();
				},
			};
		},
		undefined,
		undefined,
		{ read: () => native.escapeStops, forget: () => {} },
	);
	const unregister = registerComputerController(ownerId, supervisor);
	const prelude = createComputerPrelude(session, () => supervisor);
	return {
		native,
		prelude,
		sent,
		ownerId,
		context: { session, toolCallId: "escape-stop" },
		close: async () => {
			unregister();
			await supervisor.close();
		},
	};
}

function confirmationContext(confirm: NonNullable<AgentToolContext["ui"]>["confirm"]): AgentToolContext {
	return { hasUI: true, ui: { confirm } } as AgentToolContext;
}

describe("expanded computer APIs", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([true, false])(
		"requires an actual live approval answer (%s), retaining only approved mode across helpers",
		async approved => {
			const native = new FakeNativeSession();
			const session = toolSession();
			const supervisor = new ComputerSupervisor(
				session,
				() => liveWorker(native),
				undefined,
				undefined,
				NO_ESCAPE_STOPS,
			);
			const prelude = createComputerPrelude(session, () => supervisor);
			const answer = Promise.withResolvers<boolean>();
			const shown = Promise.withResolvers<void>();
			const context = confirmationContext(async (_title, reason, options) => {
				expect(reason).toContain("Edit the target");
				expect(reason).toContain("Use the host interrupt");
				expect(options?.signal).toBeInstanceOf(AbortSignal);
				shown.resolve();
				return await answer.promise;
			});
			try {
				const acquiring = prelude.invoke(
					{ action: "call", chain: [{ method: "control.acquire", args: [{ reason: "Edit the target" }] }] },
					{ session, toolCallId: "live-human-approval", context },
				);
				await shown.promise;
				expect(native.acquireCount).toBe(0);
				answer.resolve(approved);
				expect((await acquiring).details).toMatchObject({ value: { active: approved } });
				expect(
					(await supervisor.run("return await desktop.control.state()", 2000, snapshot(true))).returnValue,
				).toEqual({ active: approved });
				expect(native.acquireCount).toBe(approved ? 1 : 0);
				await supervisor.run(
					"const win = await desktop.window(42); await win.click(1, 2); await win.click(1, 2, { takeover: false }); await win.click(1, 2, { takeover: true }); await win.move(1, 2); await win.move(1, 2, { takeover: true });",
					2000,
					snapshot(),
				);
				// The grant never fills in an omitted takeover; only the call decides.
				expect(native.takeovers).toEqual([undefined, false, true, undefined, true]);
				await supervisor.revokeControl();
				expect(native.controlActive).toBe(false);
				expect(
					(await supervisor.run("return await desktop.control.state()", 2000, snapshot(true))).returnValue,
				).toEqual({ active: false });
			} finally {
				await supervisor.close();
			}
		},
	);

	it("denies headless control and ignores a late yes after cancellation", async () => {
		const native = new FakeNativeSession();
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => liveWorker(native),
			undefined,
			undefined,
			NO_ESCAPE_STOPS,
		);
		try {
			expect(
				(await supervisor.run('return await desktop.control.acquire({ reason: "Headless" })', 2000, snapshot()))
					.returnValue,
			).toEqual({ active: false });
			expect(native.acquireCount).toBe(0);
			const answer = Promise.withResolvers<boolean>();
			const shown = Promise.withResolvers<void>();
			const abort = new AbortController();
			const pending = supervisor.run(
				'return await desktop.control.acquire({ reason: "Cancelled" })',
				2000,
				snapshot(),
				abort.signal,
				confirmationContext(async () => {
					shown.resolve();
					return await answer.promise;
				}),
			);
			await shown.promise;
			abort.abort();
			answer.resolve(true);
			await expect(pending).rejects.toThrow();
			expect(native.acquireCount).toBe(0);
			expect(native.controlActive).toBe(false);
		} finally {
			await supervisor.close();
		}
	});

	it("revokes an acquired grant on worker error and disposal", async () => {
		const native = new FakeNativeSession();
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => liveWorker(native),
			undefined,
			undefined,
			NO_ESCAPE_STOPS,
		);
		const context = confirmationContext(async () => true);
		await supervisor.run(
			'await desktop.control.acquire({ reason: "Test task" })',
			2000,
			snapshot(),
			undefined,
			context,
		);
		await expect(supervisor.run('throw new Error("stop")', 2000, snapshot())).rejects.toThrow("stop");
		expect(native.controlActive).toBe(false);
		await supervisor.run(
			'await desktop.control.acquire({ reason: "New task" })',
			2000,
			snapshot(),
			undefined,
			context,
		);
		await supervisor.close();
		expect(native.controlActive).toBe(false);
		expect(native.closeCount).toBe(1);
	});

	it("refuses computer use after the user's Escape until their next message, and not after a host abort", async () => {
		const { native, prelude, sent, ownerId, context, close } = escapeHarness();
		try {
			await prelude.invoke(CLICK, context);
			const abort = new AbortController();
			const runSent = Promise.withResolvers<void>();
			const unsubscribe = sent.onRun(runSent.resolve);
			const hung = prelude.invoke(
				{ action: "run", code: "await wait(5_000)" },
				{ ...context, signal: abort.signal },
			);
			await runSent.promise;
			unsubscribe();
			const cancels = native.cancelCount;
			abort.abort();
			await expect(hung).rejects.toThrow();
			expect(native.cancelCount).toBeGreaterThan(cancels);
			await prelude.invoke(CLICK, context);
			expect(native.clickCount).toBe(2);

			native.escapeOnClick = true;
			await expect(prelude.invoke(CLICK, context)).rejects.toThrow(ESCAPE_STOPPED_MESSAGE);
			const sentAfterStop = sent.types.length;
			for (const parameters of [CLICK, { action: "run", code: "return 1" }, { action: "capabilities" }]) {
				await expect(prelude.invoke(parameters, context)).rejects.toThrow("the user pressed Escape");
			}
			expect(sent.types.length).toBe(sentAfterStop);
			expect(native.clickCount).toBe(2);

			resumeComputerUseForOwner(ownerId);
			await prelude.invoke(CLICK, context);
			expect(native.clickCount).toBe(3);
		} finally {
			await close();
		}
	});

	it("says a call that finished sent its input when the user's Escape lands as it returns", async () => {
		class EscapeAsClickReturns extends FakeNativeSession {
			override async click(target: string, x: number, y: number, opts?: PointerOptions | null): Promise<void> {
				await super.click(target, x, y, opts);
				// Every event went out; the Escape lands in the call's tail, before it returns.
				this.escapeStops = 1;
			}
		}
		const transport = new MemoryTransport();
		const native = new EscapeAsClickReturns();
		new ComputerWorkerCore(transport, () => native);
		const result = await runWorker(transport, "finished-click", "await (await desktop.window(42)).click(1, 2)");
		expect(native.clickCount).toBe(1);
		expect(result.ok ? result.payload.returnValue : result.error).toMatchObject({
			isAbort: false,
			message: ESCAPE_AFTER_CALL_MESSAGE,
		});
	});

	it("reports what the stopped operation said, such as a failed restoration, ahead of the stop", async () => {
		const { native, prelude, context, close } = escapeHarness();
		try {
			native.escapeOnClick = true;
			native.escapeError =
				"Cancelled: desktop operation cancelled; input may be partial; restoration also failed: key up for shift was not posted; inspect the desktop before retrying";
			const stopped = prelude.invoke(
				{ action: "run", code: "await (await desktop.window(42)).click(1, 2)" },
				context,
			);
			await expect(stopped).rejects.toThrow(`restoration also failed: key up for shift was not posted`);
			await expect(stopped).rejects.toThrow(ESCAPE_STOPPED_MESSAGE);
		} finally {
			await close();
		}
	});

	it("still words a run as the user's stop when their next message lifted it while the run ended", async () => {
		const { native, prelude, ownerId, context, close } = escapeHarness();
		try {
			native.escapeOnClick = true;
			// The user's message lands while the stopped run is still ending, so the host sees no stop pending.
			native.onEscape = () => resumeComputerUseForOwner(ownerId);
			await expect(
				prelude.invoke({ action: "run", code: "await (await desktop.window(42)).click(1, 2)" }, context),
			).rejects.toThrow(ESCAPE_STOPPED_MESSAGE);
			await prelude.invoke(CLICK, context);
			expect(native.clickCount).toBe(1);
		} finally {
			await close();
		}
	});

	it("answers a capabilities request while a stopped run is still ending, leaving the refusal to the host", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);
		const run = runWorker(transport, "stopped-run", "await tool.barrier({})");
		const call = await transport.waitFor(message => message.type === "tool-call" && message.runId === "stopped-run");
		// The user's Escape lands while the run waits on its tool; the run is not told until its next check.
		native.escapeStops = 1;
		transport.inbound({ type: "capabilities", id: "during-stop", session: snapshot(true), escape: escapeScope() });
		const reply = await transport.waitFor(message => message.type === "capabilities" && message.id === "during-stop");
		expect(reply).toMatchObject({ type: "capabilities", ok: true });
		if (call.type === "tool-call")
			transport.inbound({ type: "tool-reply", id: call.id, reply: { ok: true, value: null } });
		await run;
	});

	it("sends nothing more from a run whose script catches the cancelled operation", async () => {
		const { native, prelude, context, close } = escapeHarness();
		try {
			native.escapeOnClick = true;
			const code = `
				const win = await desktop.window(42);
				try { await win.click(1, 2); } catch {}
				for (const next of [() => win.click(1, 2), () => desktop.ref("e1").setValue("x"), () => desktop.capabilities()]) {
					try { await next(); } catch {}
				}
				return 1;`;
			const reads = native.capabilityReads;
			await expect(prelude.invoke({ action: "run", code }, context)).rejects.toThrow(ESCAPE_STOPPED_MESSAGE);
			expect(native.clickCount).toBe(0);
			expect(native.operations).toEqual([]);
			expect(native.capabilityReads).toBe(reads);
		} finally {
			await close();
		}
	});

	it.each([
		["a clipboard write", 'await desktop.clipboard.write("after");'],
		["a bridged tool call", "await tool.echo({ value: 7 });"],
	])("stops a run before %s after an Escape between native calls", async (_path, effect) => {
		/** The user's Escape lands right after `listWindows` settled and passed its check, while no native call runs. */
		class LateEscapeSession extends FakeNativeSession {
			#readsSinceList: number | undefined;
			constructor() {
				super();
				// The base class declares `escapeStops` as a field, which an accessor override would not shadow.
				Object.defineProperty(this, "escapeStops", {
					get: () => {
						if (this.#readsSinceList === undefined) return 0;
						this.#readsSinceList += 1;
						return this.#readsSinceList > 1 ? 1 : 0;
					},
				});
			}
			override async listWindows(): Promise<DesktopWindow[]> {
				this.#readsSinceList = 0;
				return await super.listWindows();
			}
		}
		const written: string[] = [];
		vi.spyOn(clipboard, "copyToClipboard").mockImplementation(async text => {
			written.push(text);
		});
		const transport = new MemoryTransport();
		// Answer a tool call a regression would send, so the run still ends.
		transport.listeners.add(message => {
			if (message.type === "tool-call")
				transport.inbound({ type: "tool-reply", id: message.id, reply: { ok: true, value: null } });
		});
		new ComputerWorkerCore(transport, () => new LateEscapeSession());
		const result = await runWorker(transport, "effect-after-escape", `await desktop.windows(); ${effect} return 1;`);
		// The worker ends the run with the user's stop, not a bare abort.
		expect(result.ok ? result.payload.returnValue : result.error).toMatchObject({
			isAbort: false,
			message: ESCAPE_STOPPED_MESSAGE,
		});
		expect(written).toEqual([]);
		expect(transport.outbound.filter(message => message.type === "tool-call")).toEqual([]);
	});

	it("starts a clipboard write only once the previous one finished, so its Escape check comes last", async () => {
		// `copyToClipboard` queues a write behind one in flight; an Escape during that wait would follow the check.
		const started: Array<{ text: string; overlapping: boolean }> = [];
		let inFlight = 0;
		vi.spyOn(clipboard, "copyToClipboard").mockImplementation(async text => {
			started.push({ text, overlapping: inFlight > 0 });
			inFlight += 1;
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			await promise;
			inFlight -= 1;
		});
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		const result = await runWorker(
			transport,
			"queued-clipboard",
			'await Promise.all([desktop.clipboard.write("first"), desktop.clipboard.write("second")]);',
		);
		expect(result.ok).toBe(true);
		expect(started).toEqual([
			{ text: "first", overlapping: false },
			{ text: "second", overlapping: false },
		]);
	});

	it("refuses capabilities and runs after an Escape between calls that no run reported", async () => {
		const { native, prelude, sent, ownerId, context, close } = escapeHarness();
		try {
			await prelude.invoke(CLICK, context);
			const sentBefore = sent.types.length;
			// Held control stopped between calls: no run observes it before the next call.
			native.escapeStops += 1;
			await expect(prelude.invoke({ action: "capabilities" }, context)).rejects.toThrow("the user pressed Escape");
			await expect(prelude.invoke(CLICK, context)).rejects.toThrow("the user pressed Escape");
			expect(sent.types.length).toBe(sentBefore);

			// The user's message acknowledges that stop even though no run saw it.
			resumeComputerUseForOwner(ownerId);
			await prelude.invoke(CLICK, context);
			expect(native.clickCount).toBe(2);
			native.escapeStops += 1;
			await expect(prelude.invoke(CLICK, context)).rejects.toThrow("the user pressed Escape");
		} finally {
			await close();
		}
	});

	it("keeps an Escape stop that no result reported across a worker restart", async () => {
		let stops = 0;
		let workers = 0;
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => {
				workers += 1;
				const worker = new SupervisorWorker(false);
				return {
					send: message => {
						// The user's Escape lands while the hung run holds the worker.
						if (message.type === "run") stops += 1;
						worker.send(message);
					},
					onMessage: handler => worker.onMessage(handler),
					onError: handler => worker.onError(handler),
					terminate: () => worker.terminate(),
				};
			},
			{ startMs: 200, closeMs: 200 },
			undefined,
			{ read: () => stops, forget: () => {} },
		);
		try {
			await expect(supervisor.run("while (true) {}", 5, snapshot())).rejects.toThrow(ESCAPE_STOPPED_MESSAGE);
			await expect(supervisor.run("1", 1_000, snapshot())).rejects.toThrow("the user pressed Escape");
			await expect(supervisor.capabilities(snapshot(true))).rejects.toThrow("the user pressed Escape");
			expect(workers).toBe(1);
		} finally {
			await supervisor.close();
		}
	});

	it("keeps a run's result, led by the stop, when the stop lands after the worker answered", async () => {
		let stops = 0;
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => {
				const worker = new SupervisorWorker(true);
				return {
					send: message => {
						worker.send(message);
						if (message.type === "run") queueMicrotask(() => (stops += 1));
					},
					onMessage: handler => worker.onMessage(handler),
					onError: handler => worker.onError(handler),
					terminate: () => worker.terminate(),
				};
			},
			{ startMs: 200, closeMs: 200 },
			undefined,
			{ read: () => stops, forget: () => {} },
		);
		try {
			const result = await supervisor.run("1", 1_000, snapshot());
			expect(result.returnValue).toBe("fresh");
			expect(result.displays[0]).toEqual({ type: "text", text: ESCAPE_AFTER_CALL_MESSAGE });
			await expect(supervisor.run("1", 1_000, snapshot())).rejects.toThrow("the user pressed Escape");
		} finally {
			await supervisor.close();
		}
	});

	it("reports a stop that lands while a capabilities request is in flight", async () => {
		let stops = 0;
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => {
				const worker = new SupervisorWorker(true);
				return {
					send: message => {
						worker.send(message);
						// Held control keeps the monitor armed between runs; the worker's capabilities reply cannot see it.
						if (message.type === "capabilities") stops += 1;
					},
					onMessage: handler => worker.onMessage(handler),
					onError: handler => worker.onError(handler),
					terminate: () => worker.terminate(),
				};
			},
			{ startMs: 200, closeMs: 200 },
			undefined,
			{ read: () => stops, forget: () => {} },
		);
		try {
			await expect(supervisor.capabilities(snapshot(true))).rejects.toThrow("the user pressed Escape");
		} finally {
			await supervisor.close();
		}
	});

	it("keeps the worker's own error ahead of the stop it reports", async () => {
		let stops = 0;
		const partial = "type: 3 of 10 characters were sent before the input was cancelled";
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => {
				const handlers = new Set<(message: ComputerWorkerOutbound) => void>();
				const emit = (message: ComputerWorkerOutbound) => {
					for (const handler of handlers) handler(message);
				};
				return {
					send: message => {
						if (message.type === "close") queueMicrotask(() => emit({ type: "closed" }));
						if (message.type !== "run") return;
						stops += 1;
						const error = { name: "ToolError", message: partial, isToolError: true, isAbort: false };
						queueMicrotask(() => emit({ type: "result", id: message.id, ok: false, error }));
					},
					onMessage: handler => {
						handlers.add(handler);
						queueMicrotask(() => emit({ type: "ready" }));
						return () => handlers.delete(handler);
					},
					onError: () => () => {},
					terminate: async () => {},
				};
			},
			{ startMs: 200, closeMs: 200 },
			undefined,
			{ read: () => stops, forget: () => {} },
		);
		try {
			await expect(supervisor.run("1", 1_000, snapshot())).rejects.toThrow(
				`${partial}\n\n${ESCAPE_STOPPED_MESSAGE}`,
			);
		} finally {
			await supervisor.close();
		}
	});

	it("delivers the user's message and keeps the stop when the native count cannot be read", async () => {
		let stops = 0;
		let unreadable = false;
		const ownerId = `escape-owner-${crypto.randomUUID()}`;
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => new SupervisorWorker(true),
			{ startMs: 200, closeMs: 200 },
			undefined,
			{
				read: () => {
					// The stale-addon stub `desktopEscapeStops` falls back to.
					if (unreadable) throw new Error("@oh-my-pi/pi-natives export `desktopEscapeStops` is missing");
					return stops;
				},
				forget: () => {},
			},
		);
		const unregister = registerComputerController(ownerId, supervisor);
		try {
			await supervisor.run("1", 1_000, snapshot());
			stops = 1;
			unreadable = true;
			// AgentSession calls this while delivering the user's message; a throw would reject its event handling.
			resumeComputerUseForOwner(ownerId);
			unreadable = false;
			await expect(supervisor.run("1", 1_000, snapshot())).rejects.toThrow("the user pressed Escape");
		} finally {
			unregister();
			await supervisor.close();
		}
	});

	it("terminates the worker on close when the native count cannot be dropped", async () => {
		let terminated = false;
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => {
				const worker = new SupervisorWorker(true);
				return {
					send: message => worker.send(message),
					onMessage: handler => worker.onMessage(handler),
					onError: handler => worker.onError(handler),
					terminate: () => {
						terminated = true;
						return worker.terminate();
					},
				};
			},
			{ startMs: 200, closeMs: 200 },
			undefined,
			{
				read: () => 0,
				forget: () => {
					throw new Error("@oh-my-pi/pi-natives export `forgetDesktopEscapeStops` is missing");
				},
			},
		);
		await supervisor.run("1", 1_000, snapshot());
		await supervisor.close();
		expect(terminated).toBe(true);
	});

	it("routes nested menus, displays, observation, applications and bounded holds through the JS facade and worker", async () => {
		const session = toolSession();
		const native = new ZoomNativeSession();
		const prelude = workerPrelude(session, native);
		const context = { session, toolCallId: "expanded-js" };
		const images: unknown[] = [];
		const realm = createContext({
			__omp_log__: () => {},
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const result = await prelude.invoke(parameters, context);
				images.push(...result.content.filter(block => block.type === "image"));
				return { details: result.details };
			},
		});
		runInContext(prelude.javascript, realm);
		try {
			const value = await runInContext(
				`(async () => {
				const win = await computer.window(42);
				const menu = await win.menu.items("File");
				await win.menu.select(menu[0].path);
				const observation = await win.observe();
				await win.click(60, 30);
				const display = await computer.display("display-1");
				await display.screenshot({ silent: true });
				await display.zoom({ x: 2, y: 2, width: 4, height: 4 }, { silent: true });
				await display.click(60, 30);
				await display.holdKeys(["space"], { duration: 0 });
				await win.holdMouse(1, 2, { duration: 0, keys: ["space"] });
				const apps = await computer.apps.list({ runningOnly: true });
				const opened = await computer.apps.open(apps[0].id, { activate: false });
				await opened.window.click(7, 8);
				return { menu, observation, display: { ...display }, apps, opened: { ...opened, window: String(opened.window) } };
			})()`,
				realm,
			);
			expect(value.menu[0].path).toEqual(["File", "Save"]);
			expect(value.observation).toMatchObject({
				coordinateWidth: 64,
				coordinateHeight: 32,
				nodeCount: 1,
				truncated: false,
				ax: "- button [ref=e1]",
			});
			expect(value.display).toEqual({ id: "display-1" });
			expect(value.opened).toEqual({ ...value.apps[0], window: "<window 42 Code>" });
			expect(native.clicks).toEqual([
				{ target: "42", x: 60, y: 30 },
				{ target: "display:display-1", x: 60, y: 30 },
				{ target: "42", x: 7, y: 8 },
			]);
			expect(native.operations).toEqual([
				"menu:42:File/Save",
				"holdKeys:display:display-1:space:0",
				"holdMouse:42:1,2:0",
				"open:test.editor",
			]);
			expect(images).toEqual([{ type: "image", data: "iVBORw==", mimeType: "image/png", detail: "original" }]);
		} finally {
			await prelude.invoke({ action: "close" }, context);
		}
	});

	it("routes Python nested handles and new methods through the actual kernel and worker", async () => {
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = { ...toolSession(), getEvalPreludes: () => definitions };
		const native = new ZoomNativeSession();
		const prelude = workerPrelude(session, native);
		definitions = [prelude];
		try {
			const result = await executePython(
				[
					"win = await computer.window(42)",
					"items = await win.menu.items('File')",
					"await win.menu.select(items[0]['path'])",
					"await win.menu.select('File', 'Save')",
					"await win.menu.select(path=['File', 'Save'])",
					"print((await win.menu.items(path='File'))[0]['path'])",
					"try:\n    await win.menu.select('File', None)\nexcept Exception as error:\n    print('select-none:', error)",
					"obs = await win.observe(silent=True)",
					"await win.click(60, 30)",
					"monitor = await computer.display('display-1')",
					"await monitor.screenshot(silent=True)",
					"await monitor.holdKeys(['space'], duration=0)",
					"await win.holdMouse(1, 2, duration=0)",
					"apps = await computer.apps.list(runningOnly=True)",
					"opened = await computer.apps.open(apps[0]['id'], activate=False)",
					"print(obs['nodeCount'], monitor.id, (await computer.control.state())['active'], opened['name'], opened['window'])",
				].join("\n"),
				{
					cwd: process.cwd(),
					sessionId: `computer-expanded-${crypto.randomUUID()}`,
					toolSession: session,
					kernelMode: "per-call",
				},
			);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("1 display-1 False Editor <computer.Window id='42' app='Code'>");
			expect(result.output).toContain("['File', 'Save']");
			expect(result.output).toContain("select-none: menu.select requires a menu path");
			expect(result.output).toContain('got ["File",null]');
			expect(native.controlActive).toBe(false);
			expect(native.operations.filter(operation => operation.startsWith("menu:"))).toEqual([
				"menu:42:File/Save",
				"menu:42:File/Save",
				"menu:42:File/Save",
			]);
		} finally {
			await prelude.invoke({ action: "close" }, { session, toolCallId: "expanded-py" });
		}
	});

	it("takes a menu path as one title, an array, or separate titles, and names those forms when it is malformed", async () => {
		const session = toolSession();
		const native = new FakeNativeSession();
		const prelude = workerPrelude(session, native);
		const context = { session, toolCallId: "menu-path-js" };
		const realm = createContext({
			__omp_log__: () => {},
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const result = await prelude.invoke(parameters, context);
				return { text: "", details: result.details };
			},
		});
		runInContext(prelude.javascript, realm);
		try {
			const items = await runInContext(
				`(async () => {
					const win = await computer.window(42);
					await win.menu.select("File", "Save");
					await win.menu.select(["File", "Save"]);
					return [await win.menu.items("File", "Save"), await win.menu.items(["File"]), await win.menu.items()];
				})()`,
				realm,
			);
			expect(items.map((list: Array<{ path: string[] }>) => list[0]!.path)).toEqual([
				["File", "Save", "Save"],
				["File", "Save"],
				["Save"],
			]);
			expect(native.operations).toEqual(["menu:42:File/Save", "menu:42:File/Save"]);
			const forms =
				'requires a menu path of non-empty titles: one title ("File"), an array (["File", "Export…"]), or separate titles ("File", "Export…")';
			for (const [call, got] of [
				["select()", "no path"],
				['select(["File"], "Save")', '[["File"],"Save"]'],
				['select("File", "")', '["File",""]'],
				['select("File", undefined)', '["File",null]'],
			]) {
				await expect(
					runInContext(`(async () => (await computer.window(42)).menu.${call})()`, realm),
				).rejects.toThrow(`menu.select ${forms}; got ${got}`);
			}
			expect(native.operations).toHaveLength(2);

			// Worker-side code may pass an optional path on as `undefined`, or a value JSON cannot show.
			const transport = new MemoryTransport();
			new ComputerWorkerCore(transport, () => native);
			const root = await runWorker(
				transport,
				"menu-undefined",
				"return (await (await desktop.window(42)).menu.items(undefined))[0].path",
			);
			expect(root.ok ? root.payload.returnValue : root.error).toEqual(["Save"]);
			for (const [code, got] of [
				["menu.select(1n)", "bigint"],
				["menu.select((() => { const path = []; path.push(path); return path; })())", "an array"],
			]) {
				const result = await runWorker(transport, `menu-${got}`, `await (await desktop.window(42)).${code}`);
				expect(result.ok ? undefined : result.error).toMatchObject({
					isToolError: true,
					message: `menu.select ${forms}; got ${got}`,
				});
			}
		} finally {
			await prelude.invoke({ action: "close" }, context);
		}
	});

	it("names the helper and argument for a missing or non-string text argument before any native call", async () => {
		class ArgumentSession extends FakeNativeSession {
			readonly calls: string[] = [];
			override async axNode(ref: string): Promise<AxNode> {
				this.calls.push(`axNode:${ref}`);
				return axNode;
			}
			override async axSetValue(ref: string, _value: string): Promise<void> {
				this.calls.push(`axSetValue:${ref}`);
			}
			override async axSelectText(
				ref: string,
				text: string,
				opts?: AxSelectTextOptions | null,
			): Promise<AxTextSelection> {
				this.calls.push(`axSelectText:${ref}`);
				return super.axSelectText(ref, text, opts);
			}
			override async axPerform(ref: string, _action: string): Promise<void> {
				this.calls.push(`axPerform:${ref}`);
			}
			override async typeText(target: string, _text: string): Promise<void> {
				this.calls.push(`typeText:${target}`);
			}
			override async keyChord(target: string, _keys: string[]): Promise<void> {
				this.calls.push(`keyChord:${target}`);
			}
			override async axType(ref: string, _text: string): Promise<void> {
				this.calls.push(`axType:${ref}`);
			}
			override async axKeyChord(ref: string, _keys: string[]): Promise<void> {
				this.calls.push(`axKeyChord:${ref}`);
			}
			override async openApplication(id: string) {
				this.calls.push(`open:${id}`);
				return super.openApplication(id);
			}
		}
		const transport = new MemoryTransport();
		const native = new ArgumentSession();
		new ComputerWorkerCore(transport, () => native);
		for (const [code, message] of [
			['await desktop.ref("e1").setValue()', "setValue(value) requires a string, got undefined"],
			['await desktop.ref("e1").setValue(42)', "setValue(value) requires a string, got number"],
			['await desktop.ref("e1").selectText()', "selectText(text) requires a string, got undefined"],
			['await desktop.ref("e1").selectText(["cat"])', "selectText(text) requires a string, got an array"],
			['await desktop.ref("e1").perform("")', 'perform(action) requires a non-empty string, got ""'],
			['await desktop.ref("e1").type()', "type(text) requires a string, got undefined"],
			[
				'await desktop.ref("e1").press([])',
				'press(chord) requires a key chord such as "cmd+shift+p" or ["cmd", "shift", "p"], got an array',
			],
			["desktop.ref()", "ref(ref) requires a non-empty string, got undefined"],
			["(await desktop.window(42)).ref(null)", "ref(ref) requires a non-empty string, got null"],
			["await (await desktop.window(42)).type()", "type(text) requires a string, got undefined"],
			["await desktop.type(['a'])", "type(text) requires a string, got an array"],
			[
				"await desktop.press()",
				'press(chord) requires a key chord such as "cmd+shift+p" or ["cmd", "shift", "p"], got undefined',
			],
			[
				"await desktop.press(['cmd', 1])",
				'press(chord) requires a key chord such as "cmd+shift+p" or ["cmd", "shift", "p"], got an array',
			],
			["await desktop.apps.open()", "apps.open(id) requires a non-empty string, got undefined"],
			// Last: reverting the fix would hand undefined to the real clipboard.
			["await desktop.clipboard.write()", "clipboard.write(text) requires a string, got undefined"],
		]) {
			const result = await runWorker(transport, `argument-${code}`, code);
			expect(result.ok ? undefined : result.error).toMatchObject({ isToolError: true, message });
		}
		// A read-only run still reports the read-only refusal first.
		const readOnly = await runWorker(transport, "argument-read-only", 'await desktop.ref("e1").setValue()', true);
		expect(readOnly.ok ? undefined : readOnly.error.message).toBe(
			"read-only run: 'setValue' requires read_only: false",
		);
		// A menu read makes its macOS window key, so a read-only run refuses it too.
		const menuRead = await runWorker(
			transport,
			"menu-read-only",
			"await (await desktop.window(42)).menu.items()",
			true,
		);
		expect(menuRead.ok ? undefined : menuRead.error.message).toBe(
			"read-only run: 'menu.items' requires read_only: false",
		);
		// The JavaScript facade's direct ref call checks the argument before the ref lookup too.
		const session = toolSession();
		const prelude = workerPrelude(session, native);
		const context = { session, toolCallId: "argument-facade" };
		const realm = createContext({
			__omp_log__: () => {},
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const result = await prelude.invoke(parameters, context);
				return { text: "", details: result.details };
			},
		});
		runInContext(prelude.javascript, realm);
		try {
			await expect(runInContext('computer.ref("e1").setValue()', realm)).rejects.toThrow(
				"setValue(value) requires a string, got undefined",
			);
			await expect(runInContext('computer.ref("e1").perform()', realm)).rejects.toThrow(
				"perform(action) requires a non-empty string, got undefined",
			);
			await expect(runInContext('computer.ref("e1").selectText()', realm)).rejects.toThrow(
				"selectText(text) requires a string, got undefined",
			);
		} finally {
			await prelude.invoke({ action: "close" }, context);
		}
		expect(native.calls).toEqual([]);
	});

	it("leaves a printed observe() tree out of the JavaScript value's echo, but keeps ax readable", async () => {
		const session = toolSession();
		const native = new ZoomNativeSession();
		const prelude = workerPrelude(session, native);
		const context = { session, toolCallId: "observe-once-js" };
		const printed: string[] = [];
		const realm = createContext({
			__omp_log__: (_level: string, text: string) => printed.push(text),
			__omp_prelude__: async (_name: string, parameters: unknown) => {
				const result = await prelude.invoke(parameters, context);
				const text = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
				return { text, details: result.details };
			},
		});
		runInContext(prelude.javascript, realm);
		try {
			const [mutated, observation, silent] = await runInContext(
				`(async () => {
					const win = await computer.window(42);
					const options = { silent: true };
					const pending = win.observe(options);
					options.silent = false;
					const mutated = await pending;
					return [mutated, await win.observe(), await win.observe({ silent: true })];
				})()`,
				realm,
			);
			expect(printed.join("\n").split("- button [ref=e1]")).toHaveLength(2);
			expect(observation.ax).toBe("- button [ref=e1]");
			// Eval echoes a trailing value the way console.log prints it.
			expect(inspect(observation)).not.toContain("- button [ref=e1]");
			expect(structuredClone(observation)).toMatchObject({ nodeCount: 1, truncated: false });
			expect({ ...observation }).not.toHaveProperty("ax");
			expect(JSON.parse(JSON.stringify(observation))).not.toHaveProperty("ax");
			expect(structuredClone(silent)).toMatchObject({ ax: "- button [ref=e1]", nodeCount: 1 });
			// The call ran silent, so its value keeps the only copy of the tree.
			expect(structuredClone(mutated)).toMatchObject({ ax: "- button [ref=e1]" });
		} finally {
			await prelude.invoke({ action: "close" }, context);
		}
	});

	it("prints a trailing Python observe() tree once and keeps ax readable", async () => {
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session: ToolSession = { ...toolSession(), getEvalPreludes: () => definitions };
		const native = new ZoomNativeSession();
		const prelude = workerPrelude(session, native);
		definitions = [prelude];
		const run = (code: string) =>
			executePython(code, {
				cwd: process.cwd(),
				sessionId: `computer-observe-once-${crypto.randomUUID()}`,
				toolSession: session,
				kernelMode: "per-call",
			});
		// Everything the model reads from a cell: printed text and non-view outputs (views are user-only).
		const trees = async (call: string) => {
			const result = await run(`win = await computer.window(42)\n${call}`);
			expect(result.exitCode).toBe(0);
			const modelOutputs = result.displayOutputs.filter(output => output.type !== "view");
			return `${result.output}${JSON.stringify(modelOutputs)}`.split("- button [ref=e1]").length - 1;
		};
		try {
			for (const call of [
				"await win.observe()",
				"print(await win.observe())",
				"await win.observe(silent=True)",
				"await win.observe({'silent': True})",
				"await win.observe({'silent': True}, silent=None)",
				"await win.observe({'silent': True}, silent=False)",
				"await win.observe({'silent': False}, silent=True)",
			]) {
				expect([call, await trees(call)]).toEqual([call, 1]);
			}
			const read = await run(
				"obs = await (await computer.window(42)).observe()\nprint(obs['ax'] == '- button [ref=e1]')",
			);
			expect(read.output.trim().split("\n").at(-1)).toBe("True");
			const pickled = await run(
				"import pickle\nobs = await (await computer.window(42)).observe()\ncopy = pickle.loads(pickle.dumps(obs))\nprint(type(copy) is dict and copy == dict(obs) and 'ax' in copy)",
			);
			expect(pickled.output.trim().split("\n").at(-1)).toBe("True");
		} finally {
			await prelude.invoke({ action: "close" }, { session, toolCallId: "observe-once-py" });
		}
	});

	it("does not emit a failed observation or replace the prior frame before the next click", async () => {
		class FailingObservation extends ZoomNativeSession {
			override async observe(_target: string): Promise<{
				capture: DesktopCapture;
				accessibility: { text: string; nodeCount: number; truncated: boolean };
			}> {
				throw new Error("AccessibilityUnavailable");
			}
		}
		const native = new FailingObservation();
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => native);
		await runWorker(transport, "observe-base", "await (await desktop.window(42)).screenshot({ silent: true })");
		const failed = await runWorker(transport, "observe-error", "await (await desktop.window(42)).observe()");
		expect(failed.ok).toBe(false);
		expect(native.fullCaptureCounts.get("42")).toBe(1);
		expect(
			(await runWorker(transport, "observe-prior-click", "await (await desktop.window(42)).click(60, 30)")).ok,
		).toBe(true);
		expect(native.clicks).toEqual([{ target: "42", x: 60, y: 30 }]);
	});

	it("classifies all new nested read and exec calls without permitting window methods on display handles", () => {
		for (const method of ["apps.list", "control.state", "display"])
			expect(isReadOnlyComputerCall([{ method, args: [] }])).toBe(true);
		for (const method of ["apps.open", "control.acquire", "control.release", "holdKeys", "holdMouse"])
			expect(isReadOnlyComputerCall([{ method, args: [] }])).toBe(false);
		for (const method of ["observe"])
			expect(
				isReadOnlyComputerCall([
					{ method: "window", args: [42] },
					{ method, args: [] },
				]),
			).toBe(true);
		for (const method of ["menu.items", "menu.select", "bringToCurrentSpace", "holdKeys", "holdMouse"])
			expect(
				isReadOnlyComputerCall([
					{ method: "window", args: [42] },
					{ method, args: [] },
				]),
			).toBe(false);
		expect(() =>
			renderComputerCall([
				{ method: "display", args: ["all"] },
				{ method: "menu.select", args: [["File"]] },
			]),
		).toThrow("Unknown display method");
	});
});

class SupervisorWorker implements ComputerWorkerHandle {
	readonly #respond: boolean;
	#messageHandlers = new Set<(message: ComputerWorkerOutbound) => void>();
	#terminated = false;

	constructor(respond: boolean) {
		this.#respond = respond;
	}
	send(message: ComputerWorkerInbound): void {
		if (message.type === "run" && this.#respond) {
			queueMicrotask(() =>
				this.#emit({
					type: "result",
					id: message.id,
					ok: true,
					payload: { displays: [], returnValue: "fresh", screenshots: [], capabilities },
				}),
			);
		} else if (message.type === "capabilities" && this.#respond) {
			queueMicrotask(() => this.#emit({ type: "capabilities", id: message.id, ok: true, capabilities }));
		} else if (message.type === "close") {
			queueMicrotask(() => this.#emit({ type: "closed" }));
		}
	}
	onMessage(handler: (message: ComputerWorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		queueMicrotask(() => this.#emit({ type: "ready" }));
		return () => this.#messageHandlers.delete(handler);
	}
	onError(_handler: (error: Error) => void): () => void {
		return () => {};
	}
	async terminate(): Promise<void> {
		this.#terminated = true;
	}
	#emit(message: ComputerWorkerOutbound): void {
		if (this.#terminated) return;
		for (const handler of this.#messageHandlers) handler(message);
	}
}

describe("computer supervisor recovery", () => {
	it("surfaces a timeout ToolError and creates a fresh worker for the next run", async () => {
		let workers = 0;
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => new SupervisorWorker(++workers > 1),
			{
				startMs: 200,
				closeMs: 200,
			},
			undefined,
			NO_ESCAPE_STOPS,
		);
		await expect(supervisor.run("await new Promise(() => {})", 5, snapshot())).rejects.toEqual(
			expect.objectContaining({
				name: "ToolError",
				message: "computer worker restarted; captures and ax refs were reset",
			}),
		);
		const result = await supervisor.run("41 + 1", 1_000, snapshot());
		expect(result.returnValue).toBe("fresh");
		expect(workers).toBe(2);
		await supervisor.close();
	});

	it("resolves direct capabilities before any run instead of a stale cache", async () => {
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => new SupervisorWorker(true),
			{
				startMs: 200,
				closeMs: 200,
			},
			undefined,
			NO_ESCAPE_STOPS,
		);
		// Regression (#11169): capabilities() used to return the run-populated
		// cache, so a fresh session yielded undefined until a run happened.
		const direct = await supervisor.capabilities(snapshot(true));
		expect(direct).toEqual(capabilities);
		await supervisor.close();
	});
});

describe("display hold follows the agent turn", () => {
	async function runTurn(transport: MemoryTransport, id: string, code: string, displayTurn?: number) {
		transport.inbound({
			type: "run",
			id,
			code,
			timeoutMs: 2_000,
			session: snapshot(false, displayTurn),
			escape: escapeScope(),
		});
		const message = await transport.waitFor(candidate => candidate.type === "result" && candidate.id === id);
		if (message.type !== "result" || !message.ok) throw new Error(`run ${id} failed`);
		return message.payload.returnValue;
	}

	it("holds the display for a run inside a turn, and the turn's end releases only the hold", async () => {
		const native = new FakeNativeSession();
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => native);

		expect(
			await runTurn(transport, "turn-1", "globalThis.kept = (await desktop.windows())[0].id; return kept;", 1),
		).toBe("42");
		expect(native.displayHolds).toEqual(["turn"]);
		await native.acquireControl();
		const before = { cancel: native.cancelCount, retire: native.retireCount, close: native.closeCount };

		transport.inbound({ type: "release-display", turn: 1 });
		expect(native.displayHolds).toEqual(["turn", "release"]);
		expect({ cancel: native.cancelCount, retire: native.retireCount, close: native.closeCount }).toEqual(before);
		expect(native.controlState()).toEqual({ active: true });

		// A run of the ended turn that arrives after its end (work outliving the turn) is left to the grace period.
		await runTurn(transport, "turn-1-late", "return kept;", 1);
		expect(native.displayHolds).toEqual(["turn", "release"]);

		// The next turn's first run holds it again, in the same native session and runtime.
		expect(await runTurn(transport, "turn-2", "return kept;", 2)).toBe("42");
		expect(native.displayHolds).toEqual(["turn", "release", "turn"]);
	});

	it("leaves a run outside any turn to the native grace period", async () => {
		const native = new FakeNativeSession();
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => native);
		await runTurn(transport, "no-turn", "return (await desktop.windows()).length;");
		expect(native.displayHolds).toEqual([]);
	});

	it("holds the display again for a run whose turn goes on after a dialog", async () => {
		const native = new FakeNativeSession();
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => native);
		transport.inbound({
			type: "run",
			id: "confirming",
			code: 'await desktop.control.acquire({ reason: "Edit" }); return 1;',
			timeoutMs: 2_000,
			session: snapshot(false, 1),
			escape: escapeScope(),
		});
		const confirm = await transport.waitFor(
			message => message.type === "control-request" && message.runId === "confirming",
		);
		if (confirm.type !== "control-request") throw new Error("Expected the run's control confirmation");
		expect(native.displayHolds).toEqual(["turn"]);
		// The confirmation dialog ends turn 1; the answer resumes it as turn 2.
		transport.inbound({ type: "release-display", turn: 1 });
		transport.inbound({ type: "resume-display", from: 5, turn: 6 });
		expect(native.displayHolds).toEqual(["turn", "release"]);
		transport.inbound({ type: "resume-display", from: 1, turn: 2 });
		expect(native.displayHolds).toEqual(["turn", "release", "turn"]);
		transport.inbound({ type: "tool-reply", id: confirm.id, reply: { ok: true, value: true } });
		await transport.waitFor(message => message.type === "result" && message.id === "confirming");

		// With no run of that turn active, a resume holds nothing.
		transport.inbound({ type: "resume-display", from: 2, turn: 3 });
		expect(native.displayHolds).toEqual(["turn", "release", "turn"]);
	});

	it("carries a turn resumed while a cold run starts into that run's hold", async () => {
		const native = new FakeNativeSession();
		const transport = new MemoryTransport();
		const created = Promise.withResolvers<void>();
		new ComputerWorkerCore(transport, async () => {
			await created.promise;
			return native;
		});
		transport.inbound({
			type: "run",
			id: "cold",
			code: "return 1;",
			timeoutMs: 2_000,
			session: snapshot(false, 1),
			escape: escapeScope(),
		});
		// A dialog opens and is answered while the native session is still being created.
		transport.inbound({ type: "release-display", turn: 1 });
		transport.inbound({ type: "resume-display", from: 1, turn: 2 });
		created.resolve();
		await transport.waitFor(message => message.type === "result" && message.id === "cold");
		expect(native.displayHolds).toEqual(["turn"]);
	});

	it("numbers runs by the owner's turn and releases the owner's sessions once when it ends", async () => {
		const owner = `computer-turn-${crypto.randomUUID()}`;
		const snapshots: ComputerSessionSnapshot[] = [];
		const releases: number[] = [];
		const session: ToolSession = { ...toolSession(), getEvalKernelOwnerId: () => owner };
		const prelude = createComputerPrelude(session, () => ({
			async run(_code, _timeoutMs, runSnapshot) {
				snapshots.push(runSnapshot);
				return { displays: [], returnValue: undefined, screenshots: [] };
			},
			async capabilities() {
				return capabilities;
			},
			releaseDisplay(turn) {
				releases.push(turn);
			},
			async close() {},
		}));
		const context = { session, toolCallId: "computer-turn", signal: new AbortController().signal };
		const run = () => prelude.invoke({ action: "run", code: "await desktop.windows()" }, context);

		// No agent turn (SDK or eval use): the run keeps the grace period.
		await run();
		beginComputerTurnForOwner(owner);
		await run();
		await run();
		expect(releases).toEqual([]);
		endComputerTurnForOwner(owner);
		expect(releases).toEqual([1]);
		endComputerTurnForOwner(owner);
		expect(releases).toEqual([1]);
		await run();
		beginComputerTurnForOwner(owner);
		await run();
		endComputerTurnForOwner(owner);
		expect(snapshots.map(entry => entry.displayTurn)).toEqual([undefined, 1, 1, undefined, 2]);
		expect(releases).toEqual([1, 2]);
		await prelude.invoke({ action: "close" }, context);
	});

	it("sends the turn's end to a running worker and starts none for it", async () => {
		const sent: ComputerWorkerInbound[] = [];
		let workers = 0;
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => {
				workers += 1;
				const worker = new SupervisorWorker(true);
				const send = worker.send.bind(worker);
				worker.send = message => {
					sent.push(message);
					send(message);
				};
				return worker;
			},
			{ startMs: 200, closeMs: 200 },
			undefined,
			NO_ESCAPE_STOPS,
		);
		supervisor.releaseDisplay(1);
		expect(workers).toBe(0);
		await supervisor.run("1", 1_000, snapshot(false, 2));
		supervisor.releaseDisplay(2);
		expect(sent.map(message => message.type)).toEqual(["run", "release-display"]);
		expect(sent[1]).toEqual({ type: "release-display", turn: 2 });
		expect(workers).toBe(1);
		await supervisor.close();
	});

	it("holds the display for a run whose turn goes on while its worker is still starting", async () => {
		const native = new FakeNativeSession();
		const ready = Promise.withResolvers<void>();
		const supervisor = new ComputerSupervisor(
			toolSession(),
			() => {
				const transport = new MemoryTransport();
				new ComputerWorkerCore(transport, () => native);
				return {
					send: message => transport.inbound(message),
					onMessage: handler => {
						transport.listeners.add(handler);
						void ready.promise.then(() => handler({ type: "ready" }));
						return () => {
							transport.listeners.delete(handler);
						};
					},
					onError: () => () => {},
					terminate: async () => {
						transport.inbound({ type: "close" });
					},
				};
			},
			{ startMs: 1_000, closeMs: 200 },
			undefined,
			NO_ESCAPE_STOPS,
		);
		const run = supervisor.run("return 1;", 2_000, snapshot(false, 1));
		// A dialog opens and is answered before the cold worker's handshake, so before the run reaches it.
		supervisor.releaseDisplay(1);
		supervisor.resumeDisplay(1, 2);
		ready.resolve();
		await run;
		expect(native.displayHolds).toEqual(["turn"]);
		await supervisor.close();
	});
});

describe("computer background fallback", () => {
	const reason = "window 42 (Wish) reads the hardware pointer for button presses";
	const ran = `click ran in takeover because ${reason}; the input was delivered, and `;
	const clickTarget = 'await (await desktop.window("42")).click(1, 2)';

	/**
	 * Refuses background clicks the way the native backend does; a takeover
	 * click resolves to `report`, native's focus outcome. The window list's
	 * `focused` flag stays on Notes throughout, as a stale listing would.
	 */
	class RefusingSession extends FakeNativeSession {
		readonly sent: Array<PointerOptions | null | undefined> = [];
		refusal = `BackgroundUnavailable: ${reason}; nothing was sent`;
		report: DesktopFocusReturn | null = { handedBack: true, previousPid: 300, frontPid: 300 };

		override async listWindows(): Promise<DesktopWindow[]> {
			return [
				{ ...windowFixture, id: "42", app: "Wish", pid: 200, focused: false },
				{ ...windowFixture, id: "7", app: "Notes", pid: 300, focused: true },
				{ ...windowFixture, id: "9", app: "Mail", pid: 400, focused: false },
			];
		}

		override async click(
			_target: string,
			_x: number,
			_y: number,
			opts?: PointerOptions | null,
		): Promise<DesktopFocusReturn | null | void> {
			this.sent.push(opts);
			if (opts?.takeover !== true) throw new Error(this.refusal);
			return this.report;
		}
	}

	/** The single fallback notice of a successful run. */
	function notice(result: Extract<ComputerWorkerOutbound, { type: "result" }>): string {
		const [text, ...rest] = texts(result);
		expect(rest).toEqual([]);
		expect(text).toStartWith(ran);
		return text.slice(ran.length);
	}

	async function run(
		native: NativeDesktopSession,
		code: string,
		backgroundFallback: ComputerSessionSnapshot["backgroundFallback"],
	): Promise<Extract<ComputerWorkerOutbound, { type: "result" }>> {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => native);
		const id = crypto.randomUUID();
		transport.inbound({
			type: "run",
			id,
			code,
			timeoutMs: 2_000,
			session: snapshot(false, undefined, backgroundFallback),
			escape: escapeScope(),
		});
		const message = await transport.waitFor(candidate => candidate.type === "result" && candidate.id === id);
		if (message.type !== "result") throw new Error(`Expected computer result, received ${message.type}`);
		return message;
	}

	function texts(result: Extract<ComputerWorkerOutbound, { type: "result" }>): string[] {
		if (!result.ok) throw new Error(`run failed: ${result.error.message}`);
		return result.payload.displays.flatMap(block => (block.type === "text" ? [block.text] : []));
	}

	it("reruns a refused background call once in takeover and says so, naming the app focus returned to", async () => {
		const native = new RefusingSession();
		const result = await run(native, clickTarget, "takeover");
		expect(notice(result)).toContain("returned to Notes");
		expect(native.sent).toEqual([{}, { takeover: true, returnFocus: true }]);

		// Negative control: an error other than BackgroundUnavailable is never rerun.
		const failing = new RefusingSession();
		failing.refusal = "InputFailed: window 42 rejected the event";
		const failed = await run(failing, clickTarget, "takeover");
		expect(failed.ok).toBe(false);
		if (failed.ok) return;
		expect(failed.error.message).toStartWith("InputFailed: window 42 rejected the event");
		expect(failing.sent).toHaveLength(1);
	});

	it("reports a rerun as delivered, dropping the refused attempt's 'nothing was sent'", async () => {
		for (const unsent of ["; nothing was sent", ", so nothing was sent", "; no input was sent"]) {
			const native = new RefusingSession();
			native.refusal = `BackgroundUnavailable: ${reason}${unsent}`;
			const result = await run(native, clickTarget, "takeover");
			expect(texts(result), unsent).toEqual([`${ran}focus returned to Notes`]);
		}
	});

	it("refuses without a takeover under refuse, and tells the model so without suggesting one", async () => {
		const native = new RefusingSession();
		const result = await run(native, clickTarget, "refuse");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toStartWith(`BackgroundUnavailable: ${reason}`);
		expect(result.error.message).toContain('"refuse"');
		expect(result.error.message).toContain("no takeover happened");
		expect(result.error.message).not.toContain("takeover:");
		expect(native.sent).toEqual([{}]);
	});

	it("passes an explicit takeover through under takeover; false never falls back", async () => {
		const forced = new RefusingSession();
		const result = await run(
			forced,
			'await (await desktop.window("42")).click(1, 2, { takeover: true })',
			"takeover",
		);
		expect(texts(result)).toEqual([]);
		expect(forced.sent).toEqual([{ takeover: true }]);

		const background = new RefusingSession();
		const refused = await run(
			background,
			'await (await desktop.window("42")).click(1, 2, { takeover: false })',
			"takeover",
		);
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.error.message).toStartWith(`BackgroundUnavailable: ${reason}`);
		expect(background.sent).toEqual([{ takeover: false }]);
	});

	it("never reruns a call the user stepped into, and keeps the code of a failed rerun", async () => {
		const stepped = new RefusingSession();
		stepped.refusal =
			"UserIntervened: window 42's application came to the front during background input; no further input was sent; inspect the window";
		const intervened = await run(stepped, clickTarget, "takeover");
		expect(intervened.ok).toBe(false);
		if (intervened.ok) return;
		expect(intervened.error.message).toStartWith("UserIntervened: window 42's application came to the front");
		expect(stepped.sent).toEqual([{}]);

		class FailingRerun extends RefusingSession {
			override async click(
				_target: string,
				_x: number,
				_y: number,
				opts?: PointerOptions | null,
			): Promise<DesktopFocusReturn | null | void> {
				this.sent.push(opts);
				throw new Error(opts?.takeover === true ? "InputFailed: window 42 rejected the event" : this.refusal);
			}
		}
		const failing = new FailingRerun();
		const failed = await run(failing, clickTarget, "takeover");
		expect(failed.ok).toBe(false);
		if (failed.ok) return;
		expect(failed.error.message).toBe(
			`InputFailed: click fell back to takeover because ${reason}, and the takeover failed: window 42 rejected the event`,
		);
		expect(failing.sent).toEqual([{}, { takeover: true, returnFocus: true }]);
	});

	describe("refuse beats the model's own foreground requests", () => {
		/** Records every native call that could take the user's foreground. */
		class ForegroundSession extends FakeNativeSession {
			readonly calls: string[] = [];

			override async click(target: string, _x: number, _y: number, opts?: PointerOptions | null): Promise<void> {
				this.calls.push(`click:${target}:${opts?.takeover ?? "-"}`);
			}
			override async keyChord(target: string, _keys: string[], opts?: PointerOptions | null): Promise<void> {
				this.calls.push(`press:${target}:${opts?.takeover ?? "-"}`);
			}
			override async typeText(target: string, _text: string, opts?: PointerOptions | null): Promise<void> {
				this.calls.push(`type:${target}:${opts?.takeover ?? "-"}`);
			}
			override async raiseWindow(windowId: string): Promise<void> {
				this.calls.push(`raise:${windowId}`);
			}
			override async axPerform(_ref: string, action: string): Promise<void> {
				this.calls.push(`perform:${action}`);
			}
			override async axClick(_ref: string, opts?: PointerOptions | null): Promise<void> {
				this.calls.push(`axClick:${opts?.takeover ?? "-"}`);
			}
			override async axType(_ref: string, _text: string, opts?: PointerOptions | null): Promise<void> {
				this.calls.push(`axType:${opts?.takeover ?? "-"}`);
			}
			override async axKeyChord(_ref: string, _keys: string[], opts?: PointerOptions | null): Promise<void> {
				this.calls.push(`axKeyChord:${opts?.takeover ?? "-"}`);
			}
			override async axFocus(ref: string): Promise<void> {
				this.calls.push(`focus:${ref}`);
			}
			override async holdKeys(target: string, _keys: string[], options: NativeHoldOptions): Promise<void> {
				this.calls.push(`holdKeys:${target}:${options.takeover ?? "-"}`);
			}
			override async openApplication(id: string, options?: { activate?: boolean }) {
				this.calls.push(`open:${id}:${options?.activate ?? "-"}`);
				return { ...(await this.listApplications())[0]!, window: windowFixture };
			}
		}

		/** Each call that would bring an app forward or drive the user's own input, and the route its refusal names. */
		const foreground: Array<{ code: string; call: string; route: string }> = [
			{
				code: 'await (await desktop.window("42")).press("a", { takeover: true })',
				call: "press:42:true",
				route: "Call it without takeover",
			},
			{
				code: 'await (await desktop.ref("e1")).click({ takeover: true })',
				call: "axClick:true",
				route: "Call it without takeover",
			},
			{
				code: 'await (await desktop.ref("e1")).type("a", { takeover: true })',
				call: "axType:true",
				route: "Call it without takeover",
			},
			{
				code: 'await (await desktop.ref("e1")).press("cmd+a", { takeover: true })',
				call: "axKeyChord:true",
				route: "Call it without takeover",
			},
			{ code: 'await (await desktop.window("42")).raise()', call: "raise:42", route: "no raise is needed" },
			{
				code: 'await (await desktop.ref("e1")).perform("AXRaise")',
				call: "perform:AXRaise",
				route: "no raise is needed",
			},
			{
				code: 'await (await desktop.ref("e1")).perform(" Raise ")',
				call: "perform: Raise ",
				route: "no raise is needed",
			},
			{
				code: 'await desktop.apps.open("test.editor", { activate: true })',
				call: "open:test.editor:true",
				route: "without activate",
			},
			{ code: 'await desktop.type("x")', call: "type:desktop:-", route: "window handle" },
			{
				code: 'await (await desktop.display("active")).click(1, 2)',
				call: "click:display:active:-",
				route: "window handle",
			},
		];

		it("refuses each before anything is sent, saying the user's setting keeps the agent in the background", async () => {
			for (const { code, route } of foreground) {
				const native = new ForegroundSession();
				const result = await run(native, code, "refuse");
				expect(result.ok, code).toBe(false);
				if (result.ok) continue;
				expect(result.error.message, code).toStartWith("BackgroundUnavailable: ");
				expect(result.error.message, code).toContain("keeps the agent in the background; nothing was sent");
				expect(result.error.message, code).toContain(route);
				expect(native.calls, code).toEqual([]);
			}
		});

		it("names the window or element a refusal kept input from", async () => {
			for (const [code, target] of [
				['await (await desktop.window("42")).raise()', "window 42"],
				['await (await desktop.ref("e1")).perform("AXRaise")', "element e1"],
			] as const) {
				const result = await run(new ForegroundSession(), code, "refuse");
				expect(result.ok, code).toBe(false);
				if (result.ok) continue;
				expect(result.error.message, code).toContain(`nothing was sent to ${target}.`);
			}
		});

		it("sends each as before under takeover", async () => {
			for (const { code, call } of foreground) {
				const native = new ForegroundSession();
				const result = await run(native, code, "takeover");
				expect(result.ok, code).toBe(true);
				expect(native.calls, code).toEqual([call]);
			}
		});

		it("still sends background requests under refuse", async () => {
			const native = new ForegroundSession();
			const code = [
				'await (await desktop.window("42")).press("a");',
				'await (await desktop.window("42")).press("a", { takeover: false });',
				'await (await desktop.ref("e1")).perform("press");',
				'await desktop.apps.open("test.editor");',
			].join("\n");
			expect((await run(native, code, "refuse")).ok).toBe(true);
			expect(native.calls).toEqual(["press:42:-", "press:42:false", "perform:press", "open:test.editor:-"]);
		});

		it("checks and sends the same option value when a getter changes between reads", async () => {
			// Each getter answers false on its first read and true afterwards.
			const flip = "(() => { let reads = 0; return () => reads++ > 0; })()";
			const code = [
				`const takeover = ${flip}, activate = ${flip}, held = ${flip}, element = ${flip};`,
				'await (await desktop.window("42")).press("a", { get takeover() { return takeover(); } });',
				'await (await desktop.ref("e1")).click({ get takeover() { return element(); } });',
				'await (await desktop.window("42")).holdKeys(["a"], { duration: 0, get takeover() { return held(); } });',
				'await desktop.apps.open("test.editor", { get activate() { return activate(); } });',
			].join("\n");
			const native = new ForegroundSession();
			expect((await run(native, code, "refuse")).ok).toBe(true);
			expect(native.calls).toEqual([
				"press:42:false",
				"axClick:false",
				"holdKeys:42:false",
				"open:test.editor:false",
			]);
		});

		it("refuses focus() off macOS, where it moves keyboard focus, and keeps macOS's background focus", async () => {
			const elsewhere = new ForegroundSession();
			const refused = await run(elsewhere, 'await (await desktop.ref("e1")).focus()', "refuse");
			expect(refused.ok).toBe(false);
			if (refused.ok) return;
			expect(refused.error.message).toStartWith("BackgroundUnavailable: focus() would");
			expect(refused.error.message).toContain("Use setValue(), press() or another AX action");
			expect(elsewhere.calls).toEqual([]);

			expect((await run(elsewhere, 'await (await desktop.ref("e1")).focus()', "takeover")).ok).toBe(true);
			expect(elsewhere.calls).toEqual(["focus:e1"]);

			class MacSession extends ForegroundSession {
				override get capabilities(): DesktopCapabilities {
					return { ...super.capabilities, backend: "quartz" };
				}
			}
			const mac = new MacSession();
			expect((await run(mac, 'await (await desktop.ref("e1")).focus()', "refuse")).ok).toBe(true);
			expect(mac.calls).toEqual(["focus:e1"]);
		});

		it("refuses AXOpen on macOS, which brings an Open panel's application forward even when it fails", async () => {
			class MacSession extends ForegroundSession {
				override get capabilities(): DesktopCapabilities {
					return { ...super.capabilities, backend: "quartz" };
				}
			}
			// Native `action_name` runs exactly these two as AXOpen.
			for (const action of ["AXOpen", "Open"]) {
				const code = `await (await desktop.ref("e1")).perform(${JSON.stringify(action)})`;
				const mac = new MacSession();
				const refused = await run(mac, code, "refuse");
				expect(refused.ok, action).toBe(false);
				if (refused.ok) continue;
				expect(refused.error.message, action).toStartWith(
					`BackgroundUnavailable: perform(${JSON.stringify(action)}) would bring the window's application to the front`,
				);
				expect(refused.error.message, action).toContain("keeps the agent in the background; nothing was sent");
				expect(refused.error.message, action).toContain("Use press() on a button that does the same");
				expect(mac.calls, action).toEqual([]);

				expect((await run(mac, code, "takeover")).ok, action).toBe(true);
				expect(mac.calls, action).toEqual([`perform:${action}`]);
			}

			// Other spellings reach native as other actions ("AXopen", "AX Open ").
			const other = new MacSession();
			const others = ['perform("open")', 'perform(" Open ")'].map(
				call => `await (await desktop.ref("e1")).${call};`,
			);
			expect((await run(other, others.join("\n"), "refuse")).ok).toBe(true);
			expect(other.calls).toEqual(["perform:open", "perform: Open "]);

			const elsewhere = new ForegroundSession();
			expect((await run(elsewhere, 'await (await desktop.ref("e1")).perform("AXOpen")', "refuse")).ok).toBe(true);
			expect(elsewhere.calls).toEqual(["perform:AXOpen"]);
		});

		describe("macOS calls that open a menu", () => {
			class MacSession extends ForegroundSession {
				override get capabilities(): DesktopCapabilities {
					return { ...super.capabilities, backend: "quartz" };
				}
				override async drag(target: string, _points: DesktopPoint[], opts?: PointerOptions | null): Promise<void> {
					this.calls.push(`drag:${target}:${opts?.takeover ?? "-"}`);
				}
				override async holdMouse(
					target: string,
					_x: number,
					_y: number,
					options: NativeHoldOptions,
				): Promise<void> {
					this.calls.push(`holdMouse:${target}:${options.takeover ?? "-"}`);
				}
			}

			const win = 'await (await desktop.window("42"))';
			const el = 'await (await desktop.ref("e1"))';
			/** Each call kind that opens a context menu or names an item of the menu it opens, and the call its refusal names. */
			const menus: Array<{ code: string; call: string; named: string }> = [
				{
					code: `${el}.perform("AXShowMenu")`,
					call: "perform:AXShowMenu",
					named: 'perform("AXShowMenu") would open a context menu',
				},
				{
					code: `${el}.perform(" showMenu ")`,
					call: "perform: showMenu ",
					named: 'perform(" showMenu ") would open a context menu',
				},
				{
					code: `${el}.perform("show_menu")`,
					call: "perform:show_menu",
					named: 'perform("show_menu") would open a context menu',
				},
				{
					code: `${el}.perform("AXShowMenu", { menu: ["Copy"] })`,
					call: "perform:AXShowMenu",
					named: "would open a context menu",
				},
				{
					code: `${el}.perform("press", { menu: ["New Folder"] })`,
					call: "perform:press",
					named: "perform with menu would open a menu",
				},
				{
					code: `${el}.press({ menu: ["New Folder"] })`,
					call: "perform:press",
					named: "press with menu would open a menu",
				},
				{
					code: 'await desktop.ref("e1").press({ menu: ["New Folder"] })',
					call: "perform:press",
					named: "press with menu would open a menu",
				},
				{
					code: `${win}.click(1, 2, { button: "right" })`,
					call: "click:42:-",
					named: 'click with button: "right" would open a context menu',
				},
				{
					code: `${win}.click(1, 2, { button: " Right " })`,
					call: "click:42:-",
					named: "would open a context menu",
				},
				{
					code: `${win}.click(1, 2, { modifiers: ["ctrl"] })`,
					call: "click:42:-",
					named: "click with Control held would open a context menu",
				},
				{
					code: `${win}.click(1, 2, { modifiers: ["cmd+Control"] })`,
					call: "click:42:-",
					named: "click with Control held",
				},
				{
					code: `${win}.click(1, 2, { menu: ["Fonts"] })`,
					call: "click:42:-",
					named: "click with menu would open a menu",
				},
				{
					code: `${win}.doubleClick(1, 2, { button: "right" })`,
					call: "click:42:-",
					named: 'doubleClick with button: "right"',
				},
				{
					code: `${win}.drag([[1, 2], [3, 4]], { keys: ["control"] })`,
					call: "drag:42:-",
					named: "drag with Control held",
				},
				{
					code: `${win}.holdMouse(1, 2, { duration: 0, button: "right" })`,
					call: "holdMouse:42:-",
					named: 'holdMouse with button: "right"',
				},
				{
					code: `${el}.click({ button: "right" })`,
					call: "axClick:-",
					named: 'click with button: "right" would open a context menu',
				},
				{ code: `${el}.click({ modifiers: ["ctrl"] })`, call: "axClick:-", named: "click with Control held" },
				{
					code: `${el}.doubleClick({ button: "right" })`,
					call: "axClick:-",
					named: 'doubleClick with button: "right"',
				},
				{
					code: 'await desktop.ref("e1").click({ button: "right", menu: ["Copy"] })',
					call: "axClick:-",
					named: "would open a context menu",
				},
			];

			it("refuses each under refuse before anything is sent, naming the keyboard, the menu bar and the setting", async () => {
				for (const { code, named } of menus) {
					const native = new MacSession();
					const result = await run(native, code, "refuse");
					expect(result.ok, code).toBe(false);
					if (result.ok) continue;
					expect(result.error.message, code).toStartWith("BackgroundUnavailable: ");
					expect(result.error.message, code).toContain(named);
					expect(result.error.message, code).toContain("which takes the user's keyboard while it is open");
					expect(result.error.message, code).toContain('computer.backgroundFallback setting is "refuse"');
					expect(result.error.message, code).toContain("win.menu.select(...)");
					expect(result.error.message, code).toContain("an element action such as press()");
					expect(native.calls, code).toEqual([]);
				}
			});

			it("sends each as before under takeover", async () => {
				for (const { code, call } of menus) {
					const native = new MacSession();
					const result = await run(native, code, "takeover");
					expect(result.ok, code).toBe(true);
					expect(native.calls, code).toEqual([call]);
				}
			});

			it("still sends primary clicks, presses and other AX actions under refuse, and menu calls off macOS", async () => {
				const mac = new MacSession();
				const code = [
					`${win}.click(1, 2);`,
					`${win}.click(1, 2, { button: "middle", modifiers: ["ctrl"] });`,
					`${win}.click(1, 2, { modifiers: ["cmd", "shift"] });`,
					`${win}.drag([[1, 2], [3, 4]], { keys: ["space"] });`,
					`${el}.press();`,
					`${el}.perform("AXIncrement");`,
					`${el}.click();`,
				].join("\n");
				expect((await run(mac, code, "refuse")).ok).toBe(true);
				expect(mac.calls).toEqual([
					"click:42:-",
					"click:42:-",
					"click:42:-",
					"drag:42:-",
					"perform:press",
					"perform:AXIncrement",
					"axClick:-",
				]);

				const elsewhere = new ForegroundSession();
				const menu = [
					`${win}.click(1, 2, { button: "right" });`,
					`${el}.perform("AXShowMenu");`,
					`${el}.press({ menu: ["New Folder"] });`,
				].join("\n");
				expect((await run(elsewhere, menu, "refuse")).ok).toBe(true);
				expect(elsewhere.calls).toEqual(["click:42:-", "perform:AXShowMenu", "perform:press"]);
			});

			describe("popup buttons and menu buttons", () => {
				/** A macOS session whose elements are controls of `role`, recording the `refuseMenu` native gets. */
				class ControlSession extends MacSession {
					constructor(readonly role = "AXButton") {
						super();
					}
					override async axNode(ref: string): Promise<AxNode> {
						return { ...axNode, ref, nativeRole: this.role };
					}
					override async axSetValue(_ref: string, value: string): Promise<void> {
						this.calls.push(`setValue:${value}`);
					}
					override async click(
						target: string,
						_x: number,
						_y: number,
						opts?: PointerOptions | null,
					): Promise<void> {
						this.calls.push(`click:${target}:${opts?.refuseMenu ?? "-"}`);
					}
					override async axClick(_ref: string, opts?: PointerOptions | null): Promise<void> {
						this.calls.push(`axClick:${opts?.refuseMenu ?? "-"}`);
					}
					override async drag(
						target: string,
						_points: DesktopPoint[],
						opts?: PointerOptions | null,
					): Promise<void> {
						this.calls.push(`drag:${target}:${opts?.refuseMenu ?? "-"}`);
					}
					override async holdMouse(
						target: string,
						_x: number,
						_y: number,
						options: NativeHoldOptions,
					): Promise<void> {
						this.calls.push(`holdMouse:${target}:${options.refuseMenu ?? "-"}`);
					}
				}

				/** Each element call that opens a popup button's or menu button's menu, as measured on guest B. */
				const controls: Array<{ role: string; code: string; call: string; named: string }> = [
					{
						role: "AXPopUpButton",
						code: `${el}.press()`,
						call: "perform:press",
						named: "press() on an AXPopUpButton",
					},
					{
						role: "AXMenuButton",
						code: `${el}.press()`,
						call: "perform:press",
						named: "press() on an AXMenuButton",
					},
					{
						role: "AXPopUpButton",
						code: 'await desktop.ref("e1").press()',
						call: "perform:press",
						named: "press() on an AXPopUpButton",
					},
					{
						role: "AXPopUpButton",
						code: `${el}.perform("AXPress")`,
						call: "perform:AXPress",
						named: 'perform("AXPress") on an AXPopUpButton',
					},
					{
						role: "AXMenuButton",
						code: `${el}.perform(" Press ")`,
						call: "perform: Press ",
						named: 'perform(" Press ") on an AXMenuButton',
					},
					{
						role: "AXPopUpButton",
						code: `${el}.setValue("Large")`,
						call: "setValue:Large",
						named: "setValue() on an AXPopUpButton",
					},
					{ role: "AXPopUpButton", code: `${el}.click()`, call: "axClick:-", named: "click on an AXPopUpButton" },
					{
						role: "AXMenuButton",
						code: `${el}.doubleClick()`,
						call: "axClick:-",
						named: "doubleClick on an AXMenuButton",
					},
				];

				it("refuses each under refuse before anything is sent, naming the keyboard and the menu bar", async () => {
					for (const { role, code, named } of controls) {
						const native = new ControlSession(role);
						const result = await run(native, code, "refuse");
						expect(result.ok, code).toBe(false);
						if (result.ok) continue;
						expect(result.error.message, code).toStartWith("BackgroundUnavailable: ");
						expect(result.error.message, code).toContain(`${named} would open its menu`);
						expect(result.error.message, code).toContain("which takes the user's keyboard while it is open");
						expect(result.error.message, code).toContain('computer.backgroundFallback setting is "refuse"');
						expect(result.error.message, code).toContain("win.menu.select(...)");
						expect(result.error.message, code).toContain("tell the user the step needs their screen");
						expect(native.calls, code).toEqual([]);
					}
				});

				it("sends each as before under takeover", async () => {
					for (const { role, code, call } of controls) {
						const native = new ControlSession(role);
						expect((await run(native, code, "takeover")).ok, code).toBe(true);
						expect(native.calls, code).toEqual([call]);
					}
				});

				it("still presses, sets and clicks other controls under refuse, and menu buttons off macOS", async () => {
					const button = new ControlSession();
					const code = [
						`${el}.press();`,
						`${el}.perform("AXPress");`,
						`${el}.setValue("x");`,
						`${el}.click();`,
					].join("\n");
					expect((await run(button, code, "refuse")).ok).toBe(true);
					expect(button.calls).toEqual(["perform:press", "perform:AXPress", "setValue:x", "axClick:true"]);

					// A menu button's menu is a pull-down, so setValue and other actions do not open it.
					const menuButton = new ControlSession("AXMenuButton");
					const other = [`${el}.setValue("x");`, `${el}.perform("AXShowDefaultUI");`].join("\n");
					expect((await run(menuButton, other, "refuse")).ok).toBe(true);
					expect(menuButton.calls).toEqual(["setValue:x", "perform:AXShowDefaultUI"]);

					class ElsewhereSession extends ForegroundSession {
						override async axNode(ref: string): Promise<AxNode> {
							return { ...axNode, ref, nativeRole: "AXPopUpButton" };
						}
					}
					const elsewhere = new ElsewhereSession();
					expect((await run(elsewhere, `${el}.press();\n${el}.click();`, "refuse")).ok).toBe(true);
					expect(elsewhere.calls).toEqual(["perform:press", "axClick:-"]);
				});

				it("asks native to refuse a click landing on one, or a hold or drag starting on one, only under refuse on macOS", async () => {
					const code = [
						`${win}.click(1, 2);`,
						`${win}.doubleClick(1, 2);`,
						`${el}.click();`,
						`${win}.holdMouse(1, 2, { duration: 0 });`,
						`${win}.drag([[1, 2], [3, 4]]);`,
					].join("\n");
					const refusing = new ControlSession();
					expect((await run(refusing, code, "refuse")).ok).toBe(true);
					expect(refusing.calls).toEqual([
						"click:42:true",
						"click:42:true",
						"axClick:true",
						"holdMouse:42:true",
						"drag:42:true",
					]);

					const taking = new ControlSession();
					expect((await run(taking, code, "takeover")).ok).toBe(true);
					expect(taking.calls).toEqual(["click:42:-", "click:42:-", "axClick:-", "holdMouse:42:-", "drag:42:-"]);
				});

				it("reports native's refusal of such a press with the reason, the setting and the alternatives", async () => {
					const refusals = {
						click: "the click on window 42 (Code), which lands on a menu button or popup button,",
						drag: "the drag on window 42 (Code), which starts on a menu button or popup button,",
					};
					class LandingSession extends ControlSession {
						override async click(
							target: string,
							x: number,
							y: number,
							opts?: PointerOptions | null,
						): Promise<void> {
							await super.click(target, x, y, opts);
							if (opts?.refuseMenu)
								throw new Error(
									`BackgroundUnavailable: ${refusals.click} would open its menu; nothing was sent`,
								);
						}
						override async drag(
							target: string,
							points: DesktopPoint[],
							opts?: PointerOptions | null,
						): Promise<void> {
							await super.drag(target, points, opts);
							if (opts?.refuseMenu)
								throw new Error(
									`BackgroundUnavailable: ${refusals.drag} would open its menu; nothing was sent`,
								);
						}
					}
					for (const [method, code] of [
						["click", `${win}.click(1, 2)`],
						["drag", `${win}.drag([[1, 2], [3, 4]])`],
						// The setting refused the press, not the model's `takeover: false`.
						["click", `${win}.click(1, 2, { takeover: false })`],
					] as const) {
						const native = new LandingSession();
						const result = await run(native, code, "refuse");
						expect(result.ok, code).toBe(false);
						if (result.ok) continue;
						const message = result.error.message;
						// The same shape as the worker's own menu refusals: the press and its effect, the setting, the way around.
						expect(message, code).toStartWith(
							`BackgroundUnavailable: ${refusals[method]} would open its menu, which takes the user's keyboard while it is open`,
						);
						expect(message, code).toContain('computer.backgroundFallback setting is "refuse"');
						expect(message, code).toContain("win.menu.select(...)");
						expect(message, code).toContain("tell the user the step needs their screen");
						expect(message, code).not.toContain("no takeover happened");
						expect(native.calls, code).toEqual([`${method}:42:true`]);
					}
				});
			});
		});

		it("refuses control.acquire without asking the user", async () => {
			const transport = new MemoryTransport();
			const native = new ForegroundSession();
			new ComputerWorkerCore(transport, () => native);
			const id = crypto.randomUUID();
			transport.inbound({
				type: "run",
				id,
				code: 'await desktop.control.acquire({ reason: "Test task" })',
				timeoutMs: 2_000,
				session: snapshot(false, undefined, "refuse"),
				escape: escapeScope(),
			});
			const result = await transport.waitFor(candidate => candidate.type === "result" && candidate.id === id);
			if (result.type !== "result" || result.ok) throw new Error("control.acquire was not refused");
			expect(result.error.message).toStartWith("BackgroundUnavailable: control.acquire would");
			expect(result.error.message).toContain("Window input needs no control");
			expect(transport.outbound.some(message => message.type === "control-request")).toBe(false);
			expect(native.acquireCount).toBe(0);
		});

		it("releases a grant acquired before the user chose refuse, at the next run", async () => {
			const held = new ForegroundSession();
			held.controlActive = true;
			expect((await run(held, "return 1", "takeover")).ok).toBe(true);
			expect(held.controlActive).toBe(true);
			expect((await run(held, "return 1", "refuse")).ok).toBe(true);
			expect(held.controlActive).toBe(false);
		});
	});

	it("never forwards a model-supplied returnFocus on holds; only the host's rerun sets it", async () => {
		const native = new RefusingSession();
		const holds: NativeHoldOptions[] = [];
		native.holdKeys = async (_target: string, _keys: string[], options: NativeHoldOptions) => {
			holds.push(options);
			if (options.takeover !== true) throw new Error(native.refusal);
		};
		native.holdMouse = async (_target: string, _x: number, _y: number, options: NativeHoldOptions) => {
			holds.push(options);
		};
		const code = [
			'const win = await desktop.window("42");',
			"await win.holdMouse(1, 2, { duration: 0, takeover: true, returnFocus: true });",
			"await win.holdKeys(['a'], { duration: 0, returnFocus: true });",
		].join("\n");
		await run(native, code, "takeover");
		expect(holds.map(options => options.returnFocus)).toEqual([undefined, undefined, true]);
	});

	it("reports where native saw focus end, not the window list's focused flag", async () => {
		const elsewhere = new RefusingSession();
		elsewhere.report = { handedBack: false, previousPid: 300, frontPid: 400 };
		const third = notice(await run(elsewhere, clickTarget, "takeover"));
		expect(third).toContain("on Mail");
		expect(third).toContain("did not return to Notes");
		expect(third).not.toContain("returned to");

		const stuck = new RefusingSession();
		stuck.report = { handedBack: false, previousPid: 300, frontPid: 200 };
		const stayed = notice(await run(stuck, clickTarget, "takeover"));
		expect(stayed).toContain("stayed on Wish");
		expect(stayed).toContain("did not return to Notes");

		const unknown = new RefusingSession();
		unknown.report = null;
		const unread = notice(await run(unknown, clickTarget, "takeover"));
		expect(unread).toContain("not confirmed");
		expect(unread).not.toContain("Notes");

		const front = new RefusingSession();
		front.report = { handedBack: true, previousPid: 300 };
		expect(notice(await run(front, clickTarget, "takeover"))).toContain("not confirmed");
	});
});

describe("computer input waits for the UI to settle", () => {
	it("pays the wait before each input to an app that owes it and at the read after them, and none to resolve a ref", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		const run = await runWorker(
			transport,
			"batch-then-read",
			'const win = await desktop.window("42"); await win.ax(); await win.press("shift"); const el = await desktop.ref("e1"); await el.press(); return await win.ax()',
		);
		expect(run.ok).toBe(true);
		// The ref's window is known from the read, so its press waits for that app like window input.
		expect(native.quietWaits).toEqual([[123], [123]]);
	});

	it("sends input only once its app has gone quiet after the input before it", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		const calls: string[] = [];
		native.keyChord = async (_target, keys) => {
			calls.push(`press ${keys.join("+")}`);
		};
		native.typeText = async (_target, text) => {
			calls.push(`type ${text}`);
		};
		native.waitForUiQuiet = async pids => {
			calls.push(`quiet ${pids.join(",")}`);
			return native.quiet;
		};
		new ComputerWorkerCore(transport, () => native);

		await runWorker(
			transport,
			"save-then-name",
			'const win = await desktop.window("42"); await win.press("cmd+s"); await win.type("name")',
		);
		// The sheet the shortcut opens is in place before the name is typed.
		expect(calls).toEqual(["press cmd+s", "quiet 123", "type name"]);
	});

	it("makes input to one app wait for the app earlier input reached, so a paste follows its copy", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		const windows = [windowFixture, { ...windowFixture, id: "43", title: "Other", pid: 456, focused: false }];
		native.listWindows = async () => windows;
		const calls: string[] = [];
		native.keyChord = async (target, keys) => {
			calls.push(`press ${target} ${keys.join("+")}`);
		};
		native.waitForUiQuiet = async pids => {
			calls.push(`quiet ${pids.join(",")}`);
			return native.quiet;
		};
		new ComputerWorkerCore(transport, () => native);

		await runWorker(
			transport,
			"copy-paste",
			'const a = await desktop.window("42"); const b = await desktop.window("43"); await a.press("cmd+c"); await b.press("cmd+v"); await desktop.press("return")',
		);
		// The paste goes out once the app that took the copy has gone quiet, and keys to the desktop after the paste.
		expect(calls).toEqual(["press 42 cmd+c", "quiet 123", "press 43 cmd+v", "quiet 456", "press desktop return"]);
	});

	it("keeps input owed when the wait for it is cancelled, so the next input still waits", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		const calls: string[] = [];
		native.keyChord = async (_target, keys) => {
			calls.push(`press ${keys.join("+")}`);
		};
		let hang = true;
		let cancelWait: (() => void) | undefined;
		const waiting = Promise.withResolvers<void>();
		native.waitForUiQuiet = async pids => {
			calls.push(`quiet ${pids.join(",")}`);
			if (!hang) return native.quiet;
			const { promise, reject } = Promise.withResolvers<UiQuiet>();
			cancelWait = () => reject(new Error("Cancelled: operation was cancelled"));
			waiting.resolve();
			return await promise;
		};
		native.cancel = () => cancelWait?.();
		new ComputerWorkerCore(transport, () => native);

		await runWorker(transport, "a", 'await (await desktop.window("42")).press("a")');
		transport.inbound({
			type: "run",
			id: "b",
			code: 'await (await desktop.window("42")).press("b")',
			timeoutMs: 2_000,
			session: snapshot(false),
			escape: escapeScope(),
		});
		await waiting.promise;
		transport.inbound({ type: "abort", id: "b" });
		const cancelled = await transport.waitFor(message => message.type === "result" && message.id === "b");
		expect(cancelled.type === "result" && cancelled.ok).toBe(false);
		hang = false;
		await runWorker(transport, "c", 'await (await desktop.window("42")).press("c")');
		// The cancelled cell never sent its key, and the next input waited for the first one's app.
		expect(calls).toEqual(["press a", "quiet 123", "quiet 123", "press c"]);
	});

	it("owes no wait for input that ended the cap ago or more", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);

		try {
			await runWorker(transport, "key", 'await (await desktop.window("42")).press("shift")');
			// The model thinks for longer than the wait could last before its next cell.
			setSystemTime(new Date(Date.now() + 5_000));
			expect((await runWorker(transport, "read", 'await (await desktop.window("42")).ax()')).ok).toBe(true);
		} finally {
			setSystemTime();
		}
		expect(native.quietWaits).toEqual([]);
		// A read right after input still waits.
		await runWorker(transport, "key-again", 'await (await desktop.window("42")).press("shift")');
		await runWorker(transport, "read-again", 'await (await desktop.window("42")).ax()');
		expect(native.quietWaits).toEqual([[123]]);
	});

	// The fallback is a real half-second timer in the worker; the test checks it against the clock.
	it("makes reads issued together after input no app can be watched for share one half-second wait", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		native.quiet = { waitedMs: 0, events: 0, timedOut: false, watched: 0 };
		let pressedAt = 0;
		native.keyChord = async () => {
			pressedAt = Date.now();
		};
		const readAt: number[] = [];
		native.axSnapshot = async () => {
			readAt.push(Date.now());
			return { text: "- button [ref=e1]" };
		};
		new ComputerWorkerCore(transport, () => native);

		const run = await runWorker(
			transport,
			"together",
			'const w = await desktop.window("42"); await w.press("shift"); await Promise.all([w.ax(), w.ax()])',
		);
		expect(run.ok).toBe(true);
		expect(native.quietWaits).toHaveLength(1);
		expect(readAt).toHaveLength(2);
		for (const at of readAt) expect(at - pressedAt).toBeGreaterThanOrEqual(490);
	});

	it("dispatches concurrent inputs in call order, after the window lookup desktop keys need", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		const order: string[] = [];
		native.listWindows = async () => {
			// Answer only after every pending microtask: a later input that skips the lookup dispatches first.
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			await promise;
			order.push("windows");
			return [windowFixture];
		};
		native.click = async () => {
			order.push("click");
		};
		native.keyChord = async () => {
			order.push("key");
		};
		new ComputerWorkerCore(transport, () => native);

		const run = await runWorker(
			transport,
			"together",
			'const w = await desktop.window("42"); await Promise.all([desktop.press("shift"), w.click(1, 2)])',
		);
		expect(run.ok).toBe(true);
		// The last lookup finds the app the key left focused, which it may have activated.
		expect(order).toEqual(["windows", "windows", "key", "click", "windows"]);
	});

	it.each([
		{ target: "desktop", label: "desktop" },
		{ target: '(await desktop.display("active"))', label: "display:active" },
	])("waits for the app under $label pointer input, not the focused one", async ({ target }) => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		// A 128×64 px screenshot of a 64×32 display: pointer pixels are halved.
		native.capture = async captured => ({
			data: Uint8Array.of(137, 80, 78, 71),
			width: 128,
			height: 64,
			coordinateWidth: 128,
			coordinateHeight: 64,
			sourceWidth: 128,
			sourceHeight: 64,
			target: captured,
			displays: [{ ...display, pixelWidth: 128, pixelHeight: 64 }],
			backend: "fake",
			screenLocked: false,
		});
		const behind: DesktopWindow = { ...windowFixture, id: "43", pid: 777, x: 44, y: 0, width: 20, height: 30 };
		// Listed above app windows and covering the display, like the macOS Dock's overlay: not where input went.
		const overlay: DesktopWindow = {
			...windowFixture,
			id: "6",
			app: "Dock",
			pid: 9,
			x: 0,
			y: 0,
			width: 64,
			height: 32,
		};
		native.listWindows = async () => [{ ...overlay, focused: false }, windowFixture, behind];
		new ComputerWorkerCore(transport, () => native);

		await runWorker(transport, "shot", `await ${target}.screenshot({ silent: true })`);
		await runWorker(transport, "scroll", `await ${target}.scroll(110, 20, { dy: 100 }); await desktop.windows()`);
		expect(native.quietWaits).toEqual([[777]]);
		// The report reads that window whole (the model has no tree of it), not the focused one or the overlay.
		transport.inbound({
			type: "settle",
			id: "settle",
			timeoutMs: 5_000,
			session: snapshot(true),
			escape: escapeScope(),
			output: "",
		});
		const settled = await transport.waitFor(message => message.type === "result" && message.id === "settle");
		const report = settled.type === "result" && settled.ok && (settled.payload.returnValue as SettleReport).text;
		expect(report).toStartWith('window "43" ');
		expect(report).not.toMatch(/window "(42|6)"/);
	});

	it("waits for the app apps.open opened, not the one in front", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		native.openApplication = async () => ({
			...(await native.listApplications())[0]!,
			pid: 777,
			window: { ...windowFixture, id: "50", app: "Font Book", pid: 777, focused: false },
		});
		new ComputerWorkerCore(transport, () => native);

		await runWorker(transport, "open", 'await desktop.apps.open("test.editor"); await desktop.windows()');
		expect(native.quietWaits).toEqual([[777]]);
	});

	it("waits after an unawaited input ends, though a read during it already waited", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		const calls: string[] = [];
		native.keyChord = async () => {
			calls.push("key-start");
			await Bun.sleep(150);
			calls.push("key-end");
		};
		native.axSnapshot = async () => {
			calls.push("ax");
			return { text: "- button [ref=e1]" };
		};
		native.waitForUiQuiet = async pids => {
			calls.push(`quiet ${pids.join(",")}`);
			return native.quiet;
		};
		new ComputerWorkerCore(transport, () => native);
		const run = await runWorker(
			transport,
			"overlap",
			'const w = await desktop.window("42"); const p = w.press("cmd+s"); await wait(30); await w.ax(); await p; await w.ax()',
		);
		expect(run.ok).toBe(true);
		expect(calls.slice(calls.indexOf("key-end"))).toEqual(["key-end", "quiet 123", "ax"]);
	});

	it("makes a desktop key wait for the app it activated too", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		let front = 123;
		native.listWindows = async () => [
			{ ...windowFixture, focused: front === 123 },
			{ ...windowFixture, id: "43", app: "Mail", pid: 456, focused: front === 456 },
		];
		native.keyChord = async () => {
			front = 456;
		};
		new ComputerWorkerCore(transport, () => native);
		await runWorker(transport, "switch", 'await desktop.press("cmd+tab"); await desktop.windows()');
		expect(native.quietWaits.map(pids => pids.toSorted())).toEqual([[123, 456]]);
	});

	it("makes input after menu.items wait, since listing a menu makes its window key", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		const calls: string[] = [];
		native.menuItems = async () => {
			calls.push("menu");
			return [];
		};
		native.keyChord = async () => {
			calls.push("key");
		};
		native.waitForUiQuiet = async pids => {
			calls.push(`quiet ${pids.join(",")}`);
			return native.quiet;
		};
		new ComputerWorkerCore(transport, () => native);
		await runWorker(
			transport,
			"menu",
			'const w = await desktop.window("42"); await w.menu.items(); await w.press("cmd+n")',
		);
		expect(calls).toEqual(["menu", "quiet 123", "key"]);
	});

	it("owes no wait for a click native refused before sending anything", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		native.click = async () => {
			throw new Error("BackgroundUnavailable: window 42 has no background route for this click; nothing was sent");
		};
		new ComputerWorkerCore(transport, () => native);
		transport.inbound({
			type: "run",
			id: "refused",
			code: 'await (await desktop.window("42")).click(1, 2)',
			timeoutMs: 2_000,
			session: snapshot(false, undefined, "refuse"),
			escape: escapeScope(),
		});
		const refused = await transport.waitFor(message => message.type === "result" && message.id === "refused");
		expect(refused.type === "result" && !refused.ok && refused.error.message).toContain("BackgroundUnavailable");
		await runWorker(transport, "read", 'await (await desktop.window("42")).ax()');
		expect(native.quietWaits).toEqual([]);
	});

	it("makes a refused call pay no wait and leaves the earlier input owed", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, () => native);
		const refuse = async (id: string, code: string) => {
			transport.inbound({
				type: "run",
				id,
				code,
				timeoutMs: 2_000,
				session: snapshot(false, undefined, "refuse"),
				escape: escapeScope(),
			});
			const result = await transport.waitFor(message => message.type === "result" && message.id === id);
			return result.type === "result" && !result.ok ? result.error.message : "";
		};

		expect(
			await refuse(
				"refused",
				'const w = await desktop.window("42"); await w.press("shift"); await w.press("a", { takeover: true })',
			),
		).toContain("nothing was sent");
		expect(native.quietWaits).toEqual([]);
		await runWorker(transport, "read", 'await (await desktop.window("42")).ax()');
		expect(native.quietWaits).toEqual([[123]]);
	});
});

/**
 * A window whose tree answers inputs the way an app does: pressing "Edit"
 * turns it into "Done" and reveals a field. Like the native registry, an
 * element keeps its ref across snapshots until its label changes, and a ref
 * resolves while its element is in the current or the previous snapshot.
 */
class EditableWindowSession extends FakeNativeSession {
	editing = false;
	snapshots = 0;
	/** Extra read-only text rows, to make the window's tree large. */
	filler = 0;
	/** Value of the window's text row, to vary it between reads. */
	status = "Ready";
	/** Whether the window holds a web view. */
	web = false;
	windows: DesktopWindow[] = [windowFixture];
	/** What a key chord sent to window 42 sets the text row to, as the app reacting to it. */
	keyStatus?: () => string;
	/** A window whose reads hang; `hung` resolves when one starts. */
	hangOn?: string;
	readonly hung = Promise.withResolvers<void>();
	#nextRef = 1;
	/** Element → its ref and the label that ref was minted for. */
	readonly #elements = new Map<string, { ref: string; label: string }>();
	#live = new Set<string>();
	#previous = new Set<string>();

	#resolves(ref: string): boolean {
		return this.#live.has(ref) || this.#previous.has(ref);
	}
	override async listWindows(): Promise<DesktopWindow[]> {
		return this.windows;
	}
	override async keyChord(target: string, _keys: string[]): Promise<void> {
		if (target === "42" && this.keyStatus) this.status = this.keyStatus();
	}
	override async axSnapshot(target?: string): Promise<{ text: string }> {
		if (target !== undefined && target === this.hangOn) {
			this.hung.resolve();
			return await Promise.withResolvers<{ text: string }>().promise;
		}
		this.snapshots += 1;
		this.#previous = this.#live;
		this.#live = new Set();
		const ref = (element: string, label = ""): string => {
			let known = this.#elements.get(element);
			if (!known || known.label !== label) {
				known = { ref: `e${this.#nextRef++}`, label };
				this.#elements.set(element, known);
			}
			this.#live.add(known.ref);
			return known.ref;
		};
		const editLabel = this.editing ? "Done" : "Edit";
		const rows = [
			`- window "Editor" [ref=${ref("window")}] app=Code (focused)`,
			`  - toolbar [ref=${ref("toolbar")}]`,
			`    - button "${editLabel}" [ref=${ref("edit", editLabel)}]`,
			...(this.editing ? [`    - textfield "Phone" [ref=${ref("phone")}]: "555"`] : []),
			`    - button "Share" [ref=${ref("share")}]`,
			`  - statictext [ref=${ref("status")}]: "${this.status}"`,
			...(this.web ? [`  - webarea "Page" [ref=${ref("page")}]`] : []),
			...(this.filler > 0 ? [`  - list [ref=${ref("list")}]`] : []),
			...Array.from({ length: this.filler }, (_, index) => {
				const label = `Row ${index} of the ${this.status} transcript`;
				return `    - statictext "${label}" [ref=${ref(`row ${index}`, label)}]`;
			}),
		];
		return { text: rows.join("\n") };
	}
	override async axNode(ref: string): Promise<AxNode> {
		if (!this.#resolves(ref)) throw new Error(`StaleRef: ${ref} expired; re-run ax()/find()`);
		return { ...axNode, ref };
	}
	override async axPerform(ref: string, _action: string): Promise<void> {
		if (!this.#resolves(ref)) throw new Error(`StaleRef: ${ref} expired; re-run ax()/find()`);
		this.editing = !this.editing;
	}
}

/** A second window of the editor's app, behind it. */
const otherWindow: DesktopWindow = { ...windowFixture, id: "43", title: "Other", focused: false };
/** A document another app opened. */
const textEditDocument: DesktopWindow = {
	...windowFixture,
	id: "50",
	app: "TextEdit",
	title: "notes.txt",
	pid: 777,
	focused: false,
};
const CAPPED: UiQuiet = { waitedMs: 5_000, events: 120, timedOut: true, watched: 1 };
const STILL_CHANGING = /\n\nthe app was still changing when this was read, \d\.\d s after the input$/;
const unchanged = (id = "42", title = "Editor"): string =>
	`window "${id}" Code "${title}": no change since your last tree`;
const changed = (rows: string[], count = rows.length): string =>
	[`window "42" Code "Editor": ${count} ${count === 1 ? "change" : "changes"} since your last tree`, ...rows].join(
		"\n",
	);
const DONE_ROWS = [
	'    + button "Done" [ref=e6] (in e2)',
	'    + textfield "Phone" [ref=e7]: "555" (in e2)',
	"removed: e3",
];

/**
 * A worker on `native` and the steps report tests take, each with its own request id: `run` returns what the
 * code returned (in Eval cell `cell` when given), `read` is a cell that prints a window's tree, settled, so the
 * model has seen it, `key` presses keys in a window, and `report`/`settle` settle the cell that just ended with
 * what it printed and whether the conversation was rewritten.
 */
function reportWorker(native = new EditableWindowSession()) {
	const transport = new MemoryTransport();
	new ComputerWorkerCore(transport, () => native);
	let step = 0;
	const result = async (message: Extract<ComputerWorkerInbound, { id: string }>) => {
		transport.inbound(message);
		const reply = await transport.waitFor(candidate => candidate.type === "result" && candidate.id === message.id);
		if (reply.type !== "result") throw new Error(`Expected a result for ${message.id}`);
		return reply;
	};
	const attempt = (code: string, cell?: string) =>
		result({
			type: "run",
			id: `run-${++step}`,
			code,
			timeoutMs: 2_000,
			session: snapshot(false),
			escape: escapeScope(),
			cell,
		});
	const run = async (code: string, cell?: string): Promise<unknown> => {
		const reply = await attempt(code, cell);
		if (!reply.ok) throw new Error(`run failed: ${reply.error.message}`);
		return reply.payload.returnValue;
	};
	const settleMessage = (
		output = "",
		forget = false,
		{ cell, timeoutMs = 5_000 }: { cell?: string; timeoutMs?: number } = {},
	): Extract<ComputerWorkerInbound, { type: "settle" }> => ({
		type: "settle",
		id: `settle-${++step}`,
		timeoutMs,
		session: snapshot(true),
		escape: escapeScope(),
		output,
		forget,
		cell,
	});
	const report = async (...args: Parameters<typeof settleMessage>): Promise<SettleReport | undefined> => {
		const reply = await result(settleMessage(...args));
		if (!reply.ok) throw new Error(`settle failed: ${reply.error.message}`);
		return reply.payload.returnValue as SettleReport | undefined;
	};
	const settle = async (...args: Parameters<typeof settleMessage>) => (await report(...args))?.text;
	const read = async (window = "42"): Promise<string> => {
		const tree = String(await run(`return await (await desktop.window("${window}")).ax()`));
		expect(await settle(tree)).toBeUndefined();
		return tree;
	};
	const key = (keys = "shift", window = "42", cell?: string) =>
		run(`await (await desktop.window("${window}")).press("${keys}")`, cell);
	return { transport, native, result, attempt, run, settleMessage, report, settle, read, key };
}

/**
 * The shipped computer prelude on a controller whose report is `settle`, and `act`: one cell that reaches the
 * desktop, then its settle. `rewrite()` stands for a conversation rewrite.
 */
function reportPrelude(
	settle: NonNullable<ComputerController["settle"]>,
	discard?: NonNullable<ComputerController["discard"]>,
) {
	let revision = 0;
	const session: ToolSession = { ...toolSession(), getHistoryRevision: () => revision };
	const prelude = createComputerPrelude(session, () => ({
		run: async () => ({ displays: [], returnValue: undefined, screenshots: [] }),
		capabilities: async () => undefined,
		settle,
		discard,
		close: async () => {},
	}));
	const press = {
		action: "call",
		chain: [
			{ method: "ref", args: ["e3"] },
			{ method: "press", args: [] },
		],
	};
	const invoke = (cell: { signal: AbortSignal }) => prelude.invoke(press, { session, toolCallId: "press", cell });
	const act = async (controller = new AbortController()) => {
		const cell = { signal: controller.signal };
		await invoke(cell);
		return await prelude.settleCell?.(cell, { failed: false, output: "" });
	};
	return { prelude, invoke, act, rewrite: () => void revision++ };
}

describe("computer cell settlement", () => {
	it("reports only the rows that changed since the model's last tree, and every ref it holds stays live", async () => {
		const { native, run, read, key, report, settle } = reportWorker();

		expect(await read()).toContain('- button "Edit" [ref=e3]');
		await run('await (await desktop.ref("e3")).press()');
		// "Edit" relabelled to "Done" gets a new ref; the field is new; Share and the rest are unchanged and absent.
		const first = await report();
		expect(first?.text).toBe(changed(DONE_ROWS));
		// Kept whole too, for a conversation rewritten while the report was made.
		expect(first?.whole).toStartWith('window "42" Code "Editor":\n- window "Editor" [ref=e1]');
		expect(first?.whole).toContain('- button "Done" [ref=e6]');
		// Refs of unchanged rows from the earlier tree still resolve, and the report's refs act.
		expect(await run('return (await desktop.ref("e4")).ref')).toBe("e4");
		await run('await (await desktop.ref("e6")).press()');
		expect(native.editing).toBe(false);
		expect(await settle()).toBe(changed(['    + button "Edit" [ref=e8] (in e2)', "removed: e6-e7"], 3));
		// Nothing new since that read: a further settle has nothing to say.
		expect(await settle()).toBeUndefined();
		// After a rewrite the window prints whole, and that is the model's tree again: the next report diffs.
		await key();
		const whole = await report("", true);
		expect(whole?.text).toStartWith('window "42" Code "Editor":\n- window "Editor" [ref=e1]');
		expect(whole?.whole).toBeUndefined();
		await key();
		expect(await settle()).toBe(unchanged());
	});

	it("answers an unchanged window in one line after one read and one wait, ignoring native object addresses", async () => {
		const { native, run, read, key, settle } = reportWorker();
		// No app can be watched: the wait is a fixed half second after the input, and the line says so.
		native.quiet = { waitedMs: 0, events: 0, timedOut: false, watched: 0 };
		native.status = "<AXUIElement 0x600003b2c0f0> {pid=123}";
		await read();
		native.status = "<AXUIElement 0x600003b2d9a0> {pid=123}";
		const started = Date.now();
		await key();
		const before = native.snapshots;
		expect(await settle()).toMatch(
			/^window "42" Code "Editor": no change since your last tree, \d\.\d s after the input$/,
		);
		expect(Date.now() - started).toBeGreaterThanOrEqual(490);
		expect(native.snapshots).toBe(before + 1);
		expect(native.quietWaits).toEqual([[123]]);
		expect(await run('return (await desktop.ref("e3")).ref')).toBe("e3");
	});

	it("keeps a large window's report to the rows that changed", async () => {
		const native = new EditableWindowSession();
		native.filler = 2_000;
		const { run, read, settle } = reportWorker(native);
		expect((await read()).length).toBeGreaterThan(80_000);
		await run('await (await desktop.ref("e3")).press()');
		expect(await settle()).toBe(
			changed([
				'    + button "Done" [ref=e2007] (in e2)',
				'    + textfield "Phone" [ref=e2008]: "555" (in e2)',
				"removed: e3",
			]),
		);
	});

	it("says the app was still changing when the cap ended the wait, also when a read inside the cell paid it", async () => {
		const { native, run, read, key, settle } = reportWorker();
		native.quiet = CAPPED;
		let saves = 0;
		native.keyStatus = () => `Saving ${++saves}`;
		await read();
		await key("cmd+s");
		const report = String(await settle());
		expect(report).toStartWith(changed(['  ~ statictext [ref=e5]: "Saving 1"']));
		expect(report).toMatch(STILL_CHANGING);

		await run('const w = await desktop.window("42"); await w.press("shift"); await w.ax()');
		expect(String(await settle())).toContain("the app was still changing");
		const printed = await run('const w = await desktop.window("42"); await w.press("shift"); return await w.ax()');
		// The printed tree is the settled one: no read-back, but the cap still has to be said.
		expect(await settle(String(printed))).toMatch(/^the app was still changing/);
		expect(native.quietWaits).toHaveLength(3);
	});

	it("still says an app was changing when a later wait in the cell, for another app, went quiet", async () => {
		const native = new EditableWindowSession();
		native.windows = [windowFixture, { ...otherWindow, pid: 456 }];
		const waits: UiQuiet[] = [CAPPED, { waitedMs: 300, events: 2, timedOut: false, watched: 1 }];
		native.waitForUiQuiet = async pids => {
			native.quietWaits.push([...pids]);
			return waits.shift() ?? native.quiet;
		};
		const { run, settle } = reportWorker(native);
		// App 123 hits the cap at the lookup of window 43; app 456 goes quiet before the read.
		await run(
			'await (await desktop.window("42")).press("shift"); const b = await desktop.window("43"); await b.press("shift"); await b.ax()',
		);
		expect(native.quietWaits).toEqual([[123], [456]]);
		expect(String(await settle())).toMatch(STILL_CHANGING);
	});

	it("says a web page may still load after the report's read", async () => {
		const { native, read, key, settle } = reportWorker();
		native.web = true;
		native.keyStatus = () => "Loading";
		await read();
		await key("return");
		expect(await settle()).toBe(
			`${changed(['  ~ statictext [ref=e5]: "Loading"'])}\n\nweb pages send no accessibility notification while they wait on the network or a timer, so this read may predate a load; the next report shows what lands later`,
		);
	});

	it("leaves the model's last tree as the baseline when a report is cancelled", async () => {
		const native = new EditableWindowSession();
		native.windows = [windowFixture, otherWindow];
		native.keyStatus = () => "Saving";
		const { transport, result, read, run, key, settle, settleMessage } = reportWorker(native);
		await read();
		await read("43");
		await run('await (await desktop.window("42")).press("shift"); await (await desktop.window("43")).press("shift")');
		native.hangOn = "43";
		const message = settleMessage();
		const cancelled = result(message);
		// Window 42 is read; the report is cancelled while it reads window 43.
		await native.hung.promise;
		transport.inbound({ type: "abort", id: message.id });
		expect((await cancelled).ok).toBe(false);
		native.hangOn = undefined;

		await key();
		expect(String(await settle())).toContain('~ statictext [ref=e5]: "Saving"');
	});

	it.each([
		{
			// Against the tree the model saw, not the one the cell's code discarded.
			name: "the cell read after its input but did not print",
			code: 'const win = await desktop.window("42"); await (await desktop.ref("e3")).press(); await win.ax(); return "done"',
			expected: changed(DONE_ROWS),
		},
		{
			name: "the cell printed before its input, naming the same refs as a re-read it did not print",
			code: 'const win = await desktop.window("42"); const before = await win.ax(); await win.press("cmd+s"); await win.ax(); return before',
			expected: changed(['  ~ statictext [ref=e5]: "Saved"']),
		},
		{
			name: "changed after the cell's own read of it",
			code: 'const win = await desktop.window("42"); const before = await win.ax(); await win.press("cmd+s"); await win.ax(); return before',
			expected: changed(['  ~ statictext [ref=e5]: "Saved"']),
			late: true,
		},
	])("reports a window $name", async ({ code, expected, late }) => {
		const native = new EditableWindowSession();
		const { read, run, settle } = reportWorker(native);
		if (late) {
			// The app reacts after the cell's re-read, before the settle's.
			let readsSinceKey = -1;
			native.keyChord = async () => void (readsSinceKey = 0);
			const axSnapshot = native.axSnapshot.bind(native);
			native.axSnapshot = async () => {
				if (readsSinceKey >= 0 && ++readsSinceKey === 2) native.status = "Saved";
				return axSnapshot();
			};
		} else native.keyStatus = () => "Saved";
		await read();
		expect(await settle(String(await run(code)))).toBe(expected);
	});

	it("does not count an empty post-input read as printed", async () => {
		const native = new EditableWindowSession();
		const { read, run, settle } = reportWorker(native);
		const axSnapshot = native.axSnapshot.bind(native);
		let blank = false;
		native.axSnapshot = async () => (blank ? { text: "" } : axSnapshot());
		await read();
		blank = true;
		await run('const win = await desktop.window("42"); await win.press("cmd+s"); await win.ax(); return "done"');
		blank = false;
		expect(await settle("done")).toBe(unchanged());
	});

	it("holds one tree per window across a read loop, a bounded few after an input, and reports a window that overflowed them", () => {
		const ledger = new ObservationLedger(new RefWindows());
		const window = { id: "42" };
		const reads = (prefix: string) => {
			let last = "";
			for (let index = 0; index < 100; index++) {
				last = `- statictext "${prefix}${index}" [ref=e1]`;
				ledger.recordRead("cell", window, last, {});
			}
			return last;
		};
		reads("");
		expect(ledger.retainedReads).toBe(1);
		ledger.noteInput("cell", window);
		const last = reads("after ");
		expect(ledger.retainedReads).toBeLessThanOrEqual(8);
		// The cell printed its last read, but reads it dropped could have been the printed copy.
		expect(ledger.take("cell", last)?.touched.map(touched => touched.id)).toEqual(["42"]);
	});

	it("counts a read sent before an input as read before it, however late it returns", async () => {
		const native = new EditableWindowSession();
		native.keyStatus = () => "Saved";
		const { read, run, settle } = reportWorker(native);
		await read();
		native.status = "Edited";
		// The tree is taken when the read is sent and returns after the input.
		const axSnapshot = native.axSnapshot.bind(native);
		native.axSnapshot = async (target?: string) => {
			const snapshot = axSnapshot(target);
			const later = Promise.withResolvers<void>();
			setImmediate(later.resolve);
			await later.promise;
			return await snapshot;
		};
		const printed = String(
			await run('const w = await desktop.window("42"); const t = w.ax(); await w.press("cmd+s"); return await t'),
		);
		expect(printed).toContain('"Edited"');
		// The printed tree predates the input: the report still shows what the input changed.
		expect(await settle(printed)).toBe(changed(['  ~ statictext [ref=e5]: "Saved"']));
	});

	it("reports the window after a call fails on an expired ref, whole when the model has no tree of it", async () => {
		const { native, run, attempt, settle } = reportWorker();
		native.editing = true;
		const ax = 'return await (await desktop.window("42")).ax()';
		await run(ax);
		// The field is gone from the next two snapshots, so its ref expires.
		native.editing = false;
		await run(ax);
		await run(ax);
		expect((await attempt('await (await desktop.ref("e4")).press()')).ok).toBe(false);
		const [header, ...tree] = String(await settle()).split("\n");
		expect(header).toBe('window "42" Code "Editor":');
		expect(tree).toContain('    - button "Edit" [ref=e7]');
		expect(tree.join("\n")).not.toContain("[ref=e4]");
	});

	it("reports desktop key input on the window focused when it was sent, or says it reached none", async () => {
		const native = new EditableWindowSession();
		native.windows = [{ ...windowFixture, focused: false }];
		const { run, read, settle } = reportWorker(native);
		await run('await desktop.press("cmd+e")');
		expect(String(await settle())).toStartWith("input whose window was unknown reached no window to read back");

		native.windows = [windowFixture, otherWindow];
		await read();
		// The key reaches the focused window and then moves focus away from it.
		native.keyChord = async () => {
			native.editing = true;
			native.windows = [
				{ ...windowFixture, focused: false },
				{ ...otherWindow, focused: true },
			];
		};
		await run('await desktop.press("cmd+e")');
		const report = String(await settle());
		expect(report).toStartWith(changed(DONE_ROWS.slice(0, 1), 3));
		expect(report).not.toContain('window "43" Code "Other":');
		expect(report).toEndWith('\n\nfocus moved to window "43" Code "Other"');
	});

	it.each([
		{ via: "find()", element: 'const [el] = await (await desktop.window("42")).find({ role: "button" })' },
		{ via: "elementAt()", element: "const el = await desktop.elementAt(10, 10)" },
	])("watches the app of an element first found by $via", async ({ element }) => {
		// The plain fake: its elements resolve without a tree read first.
		const { native, run, settle } = reportWorker(new FakeNativeSession() as EditableWindowSession);
		await run(`${element}; await el.press()`);
		expect(await settle()).toBeDefined();
		// The element's window came with its process: the report waits for that app, not a fixed time.
		expect(native.quietWaits).toEqual([[123]]);
	});

	it("reports a window's menu selection against the model's last read", async () => {
		const { native, run, read, settle } = reportWorker();
		native.menuSelect = async () => void (native.status = "Saved");
		await read();
		await run('await (await desktop.window("42")).menu.select(["File", "Save"])');
		expect(await settle()).toBe(changed(['  ~ statictext [ref=e5]: "Saved"']));
	});

	it("reports apps.open on the opened app's window, never the user's focused one, and waits for the app", async () => {
		const { native, run, read, settle } = reportWorker();
		// The user's terminal is in front; the editor (pid 123, the window `openApplication` returns) is behind it.
		const terminal: DesktopWindow = { ...windowFixture, id: "9", app: "Terminal", title: "zsh", pid: 999 };
		const editor = { ...windowFixture, focused: false };
		native.windows = [terminal, editor];
		await read();
		// While the app launches, the user opens and focuses another terminal window: not the launch's doing.
		native.openApplication = async () => {
			native.windows = [{ ...terminal, id: "10" }, { ...terminal, focused: false }, editor];
			return { ...(await native.listApplications())[0]!, window: editor };
		};
		await run('await desktop.apps.open("test.editor")');
		// The roster line names the new focused window, as for any cell; its tree is not read.
		expect(await settle()).toBe(`${unchanged()}\n\nnew window "10" Terminal "zsh" 40×20 (focused)`);
		// The opened window's app is waited for, not the focused terminal's.
		expect(native.quietWaits).toEqual([[123]]);
	});

	it("follows a touched sheet that closed with its app's window that took the focus, diffed against the model's tree", async () => {
		const { native, run, read, settle } = reportWorker();
		const parent: DesktopWindow = { ...windowFixture, focused: false };
		const sheet: DesktopWindow = { ...windowFixture, id: "43", title: "Sort", width: 30, height: 12, focused: true };
		native.windows = [sheet, parent];
		await read();
		await read("43");
		// Pressing the sheet's button closes it and changes the parent behind it.
		native.axPerform = async () => {
			native.editing = true;
			native.windows = [{ ...parent, focused: true }];
		};
		// The cell sends the parent a key first, so it is queued before the sheet; it still reads after the sheet's line.
		await run('await (await desktop.window("42")).press("shift"); await (await desktop.ref("e3")).press()');
		expect(await settle()).toBe(
			[
				'window "43" is gone from the window list (closed, minimized or off screen)',
				"",
				'window "42" Code "Editor" (now focused in place of window "43"): 3 changes since your last tree',
				...DONE_ROWS,
				"",
				'focus moved to window "42" Code "Editor"',
			].join("\n"),
		);
	});

	it("prints a window the cell's input opened and focused whole, once", async () => {
		const { native, run, read, settle } = reportWorker();
		await read();
		const dialog: DesktopWindow = { ...windowFixture, id: "43", title: "Save", width: 30, height: 12, focused: true };
		native.axPerform = async () => void (native.windows = [{ ...windowFixture, focused: false }, dialog]);
		await run('await (await desktop.ref("e2")).press()');
		const report = String(await settle());
		expect(report).toStartWith(`${unchanged()}\n\nnew window "43" Code "Save" 30×12 (focused):\n- window `);
		expect(report.match(/new window "43"/g)).toHaveLength(1);
	});

	it("prints windows the input opened without the focus whole: its app's, and after window input another app's", async () => {
		const { native, run, read, settle } = reportWorker();
		await read();
		// In the background the editor keeps the focus: its rename field opens beside it, and a document opens in
		// another app (Finder opening a file in TextEdit).
		const field: DesktopWindow = { ...windowFixture, id: "43", title: "", width: 30, height: 4, focused: false };
		native.axPerform = async () => void (native.windows = [windowFixture, field, textEditDocument]);
		await run('await (await desktop.ref("e2")).press()');
		const report = String(await settle());
		expect(report).toContain('\n\nnew window "43" Code "" 30×4:\n- window ');
		expect(report).toContain('\n\nnew window "50" TextEdit "notes.txt" 40×20:\n- window ');
		expect(report.match(/new window "/g)).toHaveLength(2);
	});

	it("prints another app's new window after input to a window, even when the cell printed that window's tree", async () => {
		const { native, run, read, settle } = reportWorker();
		await read();
		native.axPerform = async () => {
			native.editing = true;
			native.windows = [windowFixture, textEditDocument];
		};
		// The cell prints the touched window's new tree itself, so that window needs no read-back.
		const printed = await run(
			'await (await desktop.ref("e2")).press(); return await (await desktop.window("42")).ax()',
		);
		const report = String(await settle(String(printed)));
		expect(report).toStartWith('new window "50" TextEdit "notes.txt" 40×20:\n- window ');
		expect(report).not.toContain('window "42"');
	});

	it("names a new window it could not read", async () => {
		const { native, run, read, settle } = reportWorker();
		await read();
		native.axPerform = async () => void (native.windows = [windowFixture, textEditDocument]);
		const axSnapshot = native.axSnapshot.bind(native);
		native.axSnapshot = async (target?: string) => {
			if (target === "50") throw new Error("AxFailed: the window did not answer");
			return await axSnapshot(target);
		};
		await run('await (await desktop.ref("e2")).press()');
		expect(await settle()).toContain(
			'new window "50" TextEdit "notes.txt" 40×20 could not be read back through AX: AxFailed: the window did not answer',
		);
	});

	it("does not print another app's window that opens during desktop input that reached no window", async () => {
		const { native, run, read, settle } = reportWorker();
		await read();
		native.click = async () => void (native.windows = [windowFixture, textEditDocument]);
		await run("await desktop.click(1, 2)");
		expect(String(await settle())).not.toContain("TextEdit");
	});

	it("counts the new windows past the inline budget in one line, without reading their trees", async () => {
		const { native, run, read, settle } = reportWorker();
		await read();
		const opened = Array.from({ length: 400 }, (_, index) => ({
			...textEditDocument,
			id: `${1000 + index}`,
			app: `App${index}`,
			title: `Window title number ${index} with some words in it`,
			pid: 2000 + index,
		}));
		native.axPerform = async () => void (native.windows = [windowFixture, ...opened]);
		await run('await (await desktop.ref("e2")).press()');
		const snapshots = native.snapshots;
		const report = String(await settle());
		expect(Buffer.byteLength(report)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		const shown = report.match(/^new window "/gm)?.length ?? 0;
		const more = Number(
			/\nand (\d+) more windows were left out to keep this report short; desktop\.windows\(\) lists them/.exec(
				report,
			)?.[1],
		);
		expect(shown + more).toBe(400);
		expect(native.snapshots - snapshots).toBeLessThan(400);
	});

	it("lists the windows before an input that opens one, though the list answers late", async () => {
		const native = new EditableWindowSession();
		const listWindows = native.listWindows.bind(native);
		native.listWindows = async () => {
			const later = Promise.withResolvers<void>();
			setTimeout(later.resolve, 20);
			await later.promise;
			return await listWindows();
		};
		const { run, read, settle } = reportWorker(native);
		await read();
		native.axPerform = async () => void (native.windows = [windowFixture, textEditDocument]);
		await run('await (await desktop.ref("e2")).press()');
		expect(String(await settle())).toContain('new window "50" TextEdit "notes.txt" 40×20:\n- window ');
	});

	it("keeps a cell's own output inside the inline cap, naming the windows its report has no room for", async () => {
		const native = new EditableWindowSession();
		native.filler = 400;
		const { run, settle } = reportWorker(native);
		await run('await (await desktop.window("42")).press("shift")');
		const output = `${"cell output line\n".repeat(2_400)}`;
		const report = String(await settle(output));
		expect(Buffer.byteLength(output) + 2 + Buffer.byteLength(report)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(report).toBe(
			'window "42" Code "Editor": its tree was left out to keep this report short; win.ax() prints it',
		);
	});

	it("prints a diff that fits when the whole tree it would prefer does not", async () => {
		// 800 rows whose values a key changes for 60% of them: past half, so the whole tree reads better, but beside
		// the cell's output only the diff fits.
		let changed = 0;
		const rows = (count: number) =>
			Array.from(
				{ length: 800 },
				(_, index) =>
					`  - statictext [ref=e${100 + index}]: "Row ${index} ${index < count ? "after" : "before"} the edit, padding"`,
			);
		const native = new EditableWindowSession();
		native.axSnapshot = async () => ({
			text: ['- window "Editor" [ref=e1] app=Code (focused)', ...rows(changed)].join("\n"),
		});
		native.keyStatus = () => {
			changed = 480;
			return "Saved";
		};
		const { run, read, settle } = reportWorker(native);
		const tree = await read();
		await run('await (await desktop.window("42")).press("cmd+s")');
		const output = "x".repeat(DEFAULT_MAX_BYTES - tree.length + 1_000);
		const report = String(await settle(output));
		expect(report).toStartWith('window "42" Code "Editor": 480 changes since your last tree\n');
		expect(Buffer.byteLength(output) + 2 + Buffer.byteLength(report)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	});

	it("keeps the report within the inline budget, naming windows left out, which keep the model's last tree", async () => {
		const native = new EditableWindowSession();
		native.filler = 300;
		const ids = ["42", "43", "44", "45", "46"];
		native.windows = ids.map(id => (id === "42" ? windowFixture : { ...otherWindow, id, title: `W${id}` }));
		const { run, key, settle } = reportWorker(native);
		// The model has no tree of any of them: each would print whole.
		await run(`for (const id of ${JSON.stringify(ids)}) await (await desktop.window(id)).press("shift")`);
		const report = String(await settle());
		expect(Buffer.byteLength(report)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(report).toStartWith('window "42" Code "Editor":\n- window "Editor"');
		expect(report).toContain(
			'\n\nwindow "46" Code "W46": its tree was left out to keep this report short; win.ax() prints it',
		);
		// A window printed in that report is the model's tree; one left out is still unseen, so it prints whole.
		await key("shift", "46");
		expect(String(await settle())).toStartWith('window "46" Code "W46":\n- window "Editor"');
		await key();
		expect(await settle()).toBe(unchanged());
	});

	it("returns what it read before the time budget ran out and names the windows it did not read, or says it timed out", async () => {
		const native = new EditableWindowSession();
		native.windows = [windowFixture, { ...otherWindow, title: "Slow" }, { ...otherWindow, id: "44", title: "Later" }];
		native.keyStatus = () => "Saving";
		const { run, read, settle, result, settleMessage } = reportWorker(native);
		await read();
		await run('for (const id of ["42", "43", "44"]) await (await desktop.window(id)).press("shift")');
		native.hangOn = "43";
		// Reads stop 2 s short of the request's budget: 0.3 s here.
		const spent = (id: string, title: string) =>
			`window "${id}" Code "${title}" was not read back: the report's time budget is spent; read it yourself`;
		expect(await settle("", false, { timeoutMs: 2_300 })).toBe(
			[changed(['  ~ statictext [ref=e5]: "Saving"']), spent("43", "Slow"), spent("44", "Later")].join("\n\n"),
		);

		native.waitForUiQuiet = async () => await Promise.withResolvers<UiQuiet>().promise;
		await run('await (await desktop.window("44")).press("shift")');
		const timedOut = await result(settleMessage("", false, { timeoutMs: 100 }));
		expect(!timedOut.ok && timedOut.error.message).toBe("the post-input report timed out after 100ms");
	});

	it("reports each cell's own input when cells interleave, and drops a cancelled cell's", async () => {
		const native = new EditableWindowSession();
		native.windows = [windowFixture, otherWindow];
		const { transport, key, settle } = reportWorker(native);
		await key("shift", "42", "background");
		await key("shift", "43", "foreground");
		await key("shift", "42", "background");
		await key("shift", "42", "cancelled");
		transport.inbound({ type: "discard", cell: "cancelled" });

		const foreground = String(await settle("", false, { cell: "foreground" }));
		expect(foreground).toStartWith('window "43" Code "Other":\n');
		expect(foreground).not.toContain('window "42"');
		const background = String(await settle("", false, { cell: "background" }));
		expect(background).toStartWith('window "42" Code "Editor":\n');
		expect(background).not.toContain('window "43"');
		expect(await settle("", false, { cell: "cancelled" })).toBeUndefined();
	});

	it("makes a report and another cell's run take turns instead of refusing either as busy", async () => {
		const native = new EditableWindowSession();
		let keyGate: PromiseWithResolvers<void> | undefined;
		const keyEntered = Promise.withResolvers<void>();
		native.keyChord = async (_target: string, keys: string[]) => {
			if (!keys.includes("cmd") || !keyGate) return;
			keyEntered.resolve();
			await keyGate.promise;
		};
		let readGate: PromiseWithResolvers<void> | undefined;
		let readEntered = Promise.withResolvers<void>();
		const axSnapshot = native.axSnapshot.bind(native);
		native.axSnapshot = async (target?: string) => {
			if (readGate) {
				readEntered.resolve();
				await readGate.promise;
			}
			return await axSnapshot(target);
		};
		const { transport, result, key, settleMessage } = reportWorker(native);
		const runMessage = (id: string, cell: string, keys: string): Extract<ComputerWorkerInbound, { type: "run" }> => ({
			type: "run",
			id,
			code: `await (await desktop.window("42")).press("${keys}")`,
			timeoutMs: 5_000,
			session: snapshot(false),
			escape: escapeScope(),
			cell,
		});

		// A report arriving during another cell's run waits for it.
		await key("shift", "42", "b");
		keyGate = Promise.withResolvers<void>();
		const aRun = result(runMessage("a-run", "a", "cmd+s"));
		await keyEntered.promise;
		const bSettle = result(settleMessage("", false, { cell: "b" }));
		keyGate.resolve();
		keyGate = undefined;
		expect((await aRun).ok).toBe(true);
		expect((await bSettle).ok).toBe(true);

		// A run arriving during another cell's report waits for it.
		readGate = Promise.withResolvers<void>();
		const aSettle = result(settleMessage("", false, { cell: "a" }));
		await readEntered.promise;
		const cRun = result(runMessage("c-run", "c", "shift"));
		readGate.resolve();
		readGate = undefined;
		expect((await aSettle).ok).toBe(true);
		expect((await cRun).ok).toBe(true);

		// A waiting run still answers its abort.
		readEntered = Promise.withResolvers<void>();
		readGate = Promise.withResolvers<void>();
		const cSettle = result(settleMessage("", false, { cell: "c" }));
		await readEntered.promise;
		const dRun = result(runMessage("d-run", "d", "shift"));
		transport.inbound({ type: "abort", id: "d-run" });
		const aborted = await dRun;
		expect(!aborted.ok && aborted.error.isAbort).toBe(true);
		readGate.resolve();
		expect((await cSettle).ok).toBe(true);
	});

	it("settles only cells whose code reached the desktop, says when a settle fails, and passes a rewrite on until a settle delivers it", async () => {
		let fail: string | undefined;
		const forgets: boolean[] = [];
		const { prelude, invoke, act, rewrite } = reportPrelude(async (_snapshot, _output, _signal, forget) => {
			forgets.push(forget === true);
			if (fail) throw new Error(fail);
			return { text: 'window "42": no change' };
		});
		const acting = { signal: new AbortController().signal };
		await invoke(acting);
		const idle = { signal: new AbortController().signal };
		expect(await prelude.settleCell?.(idle, { failed: false, output: "" })).toBeUndefined();
		expect(await prelude.settleCell?.(acting, { failed: false, output: "" })).toEqual({
			text: 'window "42": no change',
		});
		expect(await prelude.settleCell?.(acting, { failed: false, output: "" })).toBeUndefined();

		// A settle that fails does not deliver the rewrite: the next one still forgets, and only that one.
		rewrite();
		fail = "computer worker restarted; captures and ax refs were reset";
		expect((await act())?.text).toBe(
			"No post-input report for this cell (computer worker restarted; captures and ax refs were reset); read the windows it touched before continuing.",
		);
		fail = undefined;
		expect(await act()).toEqual({ text: 'window "42": no change' });
		await act();
		expect(forgets).toEqual([false, true, true, false]);

		// A settle that failed after the worker took its trees as seen leaves the next report printing whole.
		fail = "the post-input report timed out after 16000ms";
		await act();
		fail = undefined;
		await act();
		expect(forgets.slice(-2)).toEqual([false, true]);
	});

	it("forgets trees of a report its cancelled cell dropped, and discards a cell cancelled before it settled once", async () => {
		let cancelOnReturn: AbortController | undefined;
		const forgets: boolean[] = [];
		const discards: string[] = [];
		const { invoke, act } = reportPrelude(
			async (_snapshot, _output, _signal, forget) => {
				forgets.push(forget === true);
				// The cell is cancelled once the worker built its report.
				cancelOnReturn?.abort();
				return { text: 'window "42": no change' };
			},
			cell => void discards.push(cell),
		);
		cancelOnReturn = new AbortController();
		expect(await act(cancelOnReturn)).toBeUndefined();
		cancelOnReturn = undefined;
		await act();
		await act();
		expect(forgets).toEqual([false, true, false]);
		// Settled cells are not discarded, even when cancelled afterwards.
		expect(discards).toEqual([]);

		// Two calls of one cell: one id, discarded once.
		const cancelled = new AbortController();
		const cell = { signal: cancelled.signal };
		await invoke(cell);
		await invoke(cell);
		cancelled.abort();
		expect(discards).toHaveLength(1);
		expect(discards[0]).toMatch(/^cell-/);
	});

	it("delivers whole trees when the conversation is rewritten during a report, and forgets on the next", async () => {
		let rewriteDuring = true;
		const forgets: boolean[] = [];
		const { act, rewrite } = reportPrelude(async (_snapshot, _output, _signal, forget) => {
			forgets.push(forget === true);
			// Compaction lands while the report is made.
			if (rewriteDuring) rewrite();
			return { text: "diff", whole: "whole" };
		});
		expect(await act()).toEqual({ text: "whole" });
		rewriteDuring = false;
		expect(await act()).toEqual({ text: "diff" });
		expect(await act()).toEqual({ text: "diff" });
		expect(forgets).toEqual([false, true, false]);
	});

	it("ends a cell the user's Escape stopped without a report or a line asking to read the windows", async () => {
		const { native, prelude, sent, context, close } = escapeHarness();
		try {
			native.escapeOnClick = true;
			const cell = { signal: new AbortController().signal };
			const code = "await (await desktop.window(42)).click(1, 2)";
			await expect(prelude.invoke({ action: "run", code }, { ...context, cell })).rejects.toThrow(
				ESCAPE_STOPPED_MESSAGE,
			);
			expect(await prelude.settleCell?.(cell, { failed: true, output: "" })).toBeUndefined();
			expect(sent.types).not.toContain("settle");
		} finally {
			await close();
		}
	});
});

describe("post-input report diff", () => {
	const tree = (...rows: string[]): string => rows.join("\n");
	/** Unchanged rows, so a small change stays well under half the tree. */
	const filler = Array.from(
		{ length: 8 },
		(_, index) => `  - statictext "Unchanged row ${index}" [ref=e${100 + index}]`,
	);

	it("lists changed, added and moved rows at their depth, anchors them, and names reorders and removed runs", () => {
		const before = tree(
			'- window "A" [ref=e1] app=X',
			...filler,
			"  - group [ref=e2]",
			'    - button "x" [ref=e3]',
			"  - list [ref=e4]",
			'    - row "a" [ref=e5]',
			'    - row "b" [ref=e6]',
			'    - row "c" [ref=e7]',
			'    - row "d" [ref=e8]',
			'  - checkbox "Lock" [ref=e9]: "0"',
		);
		const after = tree(
			'- window "A" [ref=e1] app=X',
			...filler,
			"  - group [ref=e2]",
			"  - list [ref=e4]",
			'    - row "b" [ref=e6]',
			'    - row "a" [ref=e5]',
			'    - button "x" [ref=e3]',
			'  - checkbox "Lock" [ref=e9]: "1"',
			"  - sheet [ref=e10]",
			'    - button "OK" [ref=e11]',
		);
		const change = diffTree(before, after);
		expect(change.lines).toEqual([
			'    ~ button "x" [ref=e3] (in e4)',
			'  ~ checkbox "Lock" [ref=e9]: "1"',
			"  + sheet [ref=e10] (in e1)",
			'    + button "OK" [ref=e11]',
			"order of e4's children: e6 e5 e3",
		]);
		expect(renderReadBack({ touched: { id: "7", options: {} }, text: after, change })).toBe(
			['window "7": 7 changes since your last tree', ...change.lines, "removed: e7-e8"].join("\n"),
		);
	});

	it("prints the whole tree when the changes would not be shorter", () => {
		const before = tree('- window "A" [ref=e1] app=X', '  - button "x" [ref=e2]');
		const after = tree('- window "A" [ref=e3] app=X', '  - button "x" [ref=e4]');
		const change = diffTree(before, after);
		expect(renderReadBack({ touched: { id: "7", options: {} }, text: after, change })).toBe(`window "7":\n${after}`);
	});

	it("prints the whole tree when the changes would take half its length or more", () => {
		// Half the rows relabelled: shorter than the tree, still a diff models re-read the tree after.
		const rows = (label: string, first: number) =>
			Array.from({ length: 4 }, (_, index) => `  - row "${label} ${index}" [ref=e${first + index}]`);
		const before = tree('- window "A" [ref=e1] app=X', ...rows("kept", 2), ...rows("old", 6));
		const after = tree('- window "A" [ref=e1] app=X', ...rows("kept", 2), ...rows("new", 10));
		const change = diffTree(before, after);
		const diff = [...change.lines, `removed: ${refRuns(change.removed)}`].join("\n");
		expect(diff.length).toBeLessThan(after.length);
		expect(diff.length * 2).toBeGreaterThanOrEqual(after.length);
		expect(renderReadBack({ touched: { id: "7", options: {} }, text: after, change })).toBe(`window "7":\n${after}`);
		// A quarter of them relabelled stays a diff.
		const most = tree('- window "A" [ref=e1] app=X', ...rows("kept", 2), ...rows("old", 6), ...rows("more", 20));
		const fewer = tree('- window "A" [ref=e1] app=X', ...rows("kept", 2), ...rows("new", 10), ...rows("more", 20));
		expect(
			renderReadBack({ touched: { id: "7", options: {} }, text: fewer, change: diffTree(most, fewer) }),
		).toStartWith('window "7": 8 changes since your last tree\n');
	});

	it("keeps rows past a truncated read's node limit apart from removed ones", () => {
		const before = tree(
			'- window "A" [ref=e1] app=X',
			...filler,
			'  - row "a" [ref=e2]',
			'  - row "b" [ref=e3]',
			'  - row "c" [ref=e4]',
			'  - row "d" [ref=e5]',
			'  - row "e" [ref=e6]',
			"… truncated (14 nodes)",
		);
		// A row added above the cut pushes the last rows past the node limit; "b" is really gone.
		const after = tree(
			'- window "A" [ref=e1] app=X',
			...filler,
			'  - row "new" [ref=e9]',
			'  - row "a" [ref=e2]',
			'  - row "c" [ref=e4]',
			"… truncated (12 nodes)",
		);
		const change = diffTree(before, after);
		expect(change.removed).toEqual(["e3"]);
		expect(change.pastLimit).toEqual(["e5", "e6"]);
		expect(renderReadBack({ touched: { id: "7", options: {} }, text: after, change }).split("\n")).toEqual([
			'window "7": 3 changes since your last tree',
			'  + row "new" [ref=e9] (in e1)',
			"… truncated (12 nodes)",
			"removed: e3",
			"past this read's node limit: e5-e6",
		]);
	});

	it("carries a new trailer and ignores a label holding ref-shaped text", () => {
		const before = tree('- window "A [ref=e9]" [ref=e1] app=X', "  - list [ref=e2]");
		const after = tree('- window "A [ref=e9]" [ref=e1] app=X', "  - list [ref=e2]", "… truncated (800 nodes)");
		expect(diffTree(before, after)).toEqual({
			lines: ["… truncated (800 nodes)"],
			added: 0,
			changed: 0,
			removed: [],
			pastLimit: [],
		});
		expect(parseTreeRow('- window "A [ref=e9]" [ref=e1] app=X')?.ref).toBe("e1");
		expect(refRuns(["e3", "e4", "e5", "e9", "e11", "e12"])).toBe("e3-e5, e9, e11-e12");
	});
});
