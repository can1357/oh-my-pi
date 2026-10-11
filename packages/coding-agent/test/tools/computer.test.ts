import { afterAll, describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
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
	SCREEN_LOCKED_CAPTURE_NOTE,
} from "@oh-my-pi/pi-coding-agent/tools/computer/protocol";
import {
	type ComputerController,
	ComputerSupervisor,
	type ComputerWorkerHandle,
} from "@oh-my-pi/pi-coding-agent/tools/computer/supervisor";
import { ComputerWorkerCore, type NativeDesktopSession } from "@oh-my-pi/pi-coding-agent/tools/computer/worker";
import type {
	AxNode,
	AxQuery,
	AxSnapshotOptions,
	CaptureRegion,
	DesktopCapabilities,
	DesktopCapture,
	DesktopDisplay,
	DesktopPoint,
	DesktopScreenState,
	DesktopWindow,
	PointerOptions,
} from "@oh-my-pi/pi-natives";

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
	clickCount = 0;
	closeCount = 0;
	cancelCount = 0;
	retireCount = 0;
	controlActive = false;
	acquireCount = 0;
	readonly operations: string[] = [];
	readonly inputModes: boolean[] = [];
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
	async listApplications() {
		return [{ id: "test.editor", name: "Editor", path: "/Applications/Editor.app", running: true, pid: 123 }];
	}
	async openApplication(id: string) {
		this.operations.push(`open:${id}`);
		return (await this.listApplications())[0]!;
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
	async click(_target: string, _x: number, _y: number, _opts?: PointerOptions | null): Promise<void> {
		this.clickCount += 1;
		this.inputModes.push(_opts?.takeover ?? this.controlActive);
	}
	async moveMouse(_target: string, _x: number, _y: number, _opts?: PointerOptions | null): Promise<void> {}
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
	async axFocus(_ref: string): Promise<void> {}
	async axClick(_ref: string, _opts?: PointerOptions | null): Promise<void> {}
	async close(): Promise<void> {
		this.closeCount += 1;
		this.controlActive = false;
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

const snapshot = (readOnly = false): ComputerSessionSnapshot => ({
	cwd: import.meta.dir,
	sessionId: crypto.randomUUID(),
	captureMaxWidth: 1280,
	captureMaxHeight: 896,
	display: "active",
	readOnly,
});

async function runWorker(
	transport: MemoryTransport,
	id: string,
	code: string,
	readOnly = false,
	timeoutMs = 2_000,
): Promise<Extract<ComputerWorkerOutbound, { type: "result" }>> {
	transport.inbound({ type: "run", id, code, timeoutMs, session: snapshot(readOnly) });
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
			transport.inbound({ type: "run", id, code, timeoutMs, session: runSnapshot });
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
			__omp_display__: (value: unknown) => displays.push(value),
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
			__omp_display__: () => {},
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
	}

	it("chains element calls on JavaScript ref() handles, direct and in runs, and double-clicks", async () => {
		const session = toolSession();
		const native = new RefCallSession();
		const prelude = workerPrelude(session, native);
		const context = { session, toolCallId: "ref-chain-js" };
		const realm = createContext({
			__omp_display__: () => {},
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
			__omp_display__: () => {},
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
					try {
						await (await win.find({ role: "button", title: "Run" })).press();
					} catch (error) {
						return error.message;
					}
				})()`,
				realm,
			);
			expect(misuse).toContain("find() returns an array (length 1), not one element, so it has no press()");
			expect(misuse).toContain("const [el] = await win.find(");
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
			expect(options).toEqual({ display: "active" });
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
		transport.inbound({ type: "run", id: "abort", code: "await wait(5_000)", timeoutMs: 5_000, session: snapshot() });
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

	it("answers a direct capabilities request without a prior run", async () => {
		const transport = new MemoryTransport();
		new ComputerWorkerCore(transport, () => new FakeNativeSession());
		transport.inbound({ type: "capabilities", id: "caps", session: snapshot(true) });
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

		transport.inbound({ type: "run", id: "race-run", code: "42", timeoutMs: 2_000, session: snapshot(true) });
		transport.inbound({ type: "capabilities", id: "race-caps", session: snapshot(true) });
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

function confirmationContext(confirm: NonNullable<AgentToolContext["ui"]>["confirm"]): AgentToolContext {
	return { hasUI: true, ui: { confirm } } as AgentToolContext;
}

describe("expanded computer APIs", () => {
	it.each([true, false])(
		"requires an actual live approval answer (%s), retaining only approved mode across helpers",
		async approved => {
			const native = new FakeNativeSession();
			const session = toolSession();
			const supervisor = new ComputerSupervisor(session, () => liveWorker(native));
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
					"const win = await desktop.window(42); await win.click(1, 2); await win.click(1, 2, { takeover: false });",
					2000,
					snapshot(),
				);
				expect(native.inputModes).toEqual([approved, false]);
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
		const supervisor = new ComputerSupervisor(toolSession(), () => liveWorker(native));
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
		const supervisor = new ComputerSupervisor(toolSession(), () => liveWorker(native));
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

	it("routes nested menus, displays, observation, applications and bounded holds through the JS facade and worker", async () => {
		const session = toolSession();
		const native = new ZoomNativeSession();
		const prelude = workerPrelude(session, native);
		const context = { session, toolCallId: "expanded-js" };
		const images: unknown[] = [];
		const realm = createContext({
			__omp_display__: () => {},
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
				await computer.apps.open(apps[0].id, { activate: false });
				return { menu, observation, display: { ...display }, apps };
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
			expect(native.clicks).toEqual([
				{ target: "42", x: 60, y: 30 },
				{ target: "display:display-1", x: 60, y: 30 },
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
					"obs = await win.observe(silent=True)",
					"await win.click(60, 30)",
					"monitor = await computer.display('display-1')",
					"await monitor.screenshot(silent=True)",
					"await monitor.holdKeys(['space'], duration=0)",
					"await win.holdMouse(1, 2, duration=0)",
					"apps = await computer.apps.list(runningOnly=True)",
					"await computer.apps.open(apps[0]['id'], activate=False)",
					"print(obs['nodeCount'], monitor.id, (await computer.control.state())['active'])",
				].join("\n"),
				{
					cwd: process.cwd(),
					sessionId: `computer-expanded-${crypto.randomUUID()}`,
					toolSession: session,
					kernelMode: "per-call",
				},
			);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("1 display-1 False");
			expect(native.controlActive).toBe(false);
		} finally {
			await prelude.invoke({ action: "close" }, { session, toolCallId: "expanded-py" });
		}
	});

	it("leaves a printed observe() tree out of the JavaScript value's display, but keeps ax readable", async () => {
		const session = toolSession();
		const native = new ZoomNativeSession();
		const prelude = workerPrelude(session, native);
		const context = { session, toolCallId: "observe-once-js" };
		const printed: string[] = [];
		const realm = createContext({
			__omp_display__: (text: string) => printed.push(text),
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
			// Eval displays a trailing value as its structured clone.
			expect(structuredClone(observation)).not.toHaveProperty("ax");
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
		// Everything the model reads from a cell: printed text and structured displays.
		const trees = async (call: string) => {
			const result = await run(`win = await computer.window(42)\n${call}`);
			expect(result.exitCode).toBe(0);
			return `${result.output}${JSON.stringify(result.displayOutputs)}`.split("- button [ref=e1]").length - 1;
		};
		try {
			for (const call of [
				"await win.observe()",
				"display(await win.observe())",
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
		for (const method of ["observe", "menu.items"])
			expect(
				isReadOnlyComputerCall([
					{ method: "window", args: [42] },
					{ method, args: [] },
				]),
			).toBe(true);
		for (const method of ["menu.select", "bringToCurrentSpace", "holdKeys", "holdMouse"])
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
		const supervisor = new ComputerSupervisor(toolSession(), () => new SupervisorWorker(++workers > 1), {
			startMs: 200,
			closeMs: 200,
		});
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
		const supervisor = new ComputerSupervisor(toolSession(), () => new SupervisorWorker(true), {
			startMs: 200,
			closeMs: 200,
		});
		// Regression (#11169): capabilities() used to return the run-populated
		// cache, so a fresh session yielded undefined until a run happened.
		const direct = await supervisor.capabilities(snapshot(true));
		expect(direct).toEqual(capabilities);
		await supervisor.close();
	});
});
