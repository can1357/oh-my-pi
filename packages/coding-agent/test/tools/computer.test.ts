import { afterAll, describe, expect, it } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { computerApproval, createComputerPrelude } from "@oh-my-pi/pi-coding-agent/tools/computer";
import { isReadOnlyComputerCall, renderComputerCall } from "@oh-my-pi/pi-coding-agent/tools/computer/call";
import type {
	ComputerSessionSnapshot,
	ComputerWorkerInbound,
	ComputerWorkerOutbound,
	ComputerWorkerTransport,
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
	DesktopCapabilities,
	DesktopDisplay,
	DesktopPoint,
	DesktopWindow,
	PointerOptions,
} from "@oh-my-pi/pi-natives";

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
	deliveryModes: ["background", "foreground"],
	capturePermission: "granted",
	inputPermission: "granted",
	axPermission: "granted",
	displayCount: 1,
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
	readonly capabilities = capabilities;
	clickCount = 0;
	closeCount = 0;
	sourceWidth = 64;
	sourceHeight = 32;

	async listDisplays(): Promise<DesktopDisplay[]> {
		return [display];
	}
	async listWindows(): Promise<DesktopWindow[]> {
		return [windowFixture];
	}
	async capture(target: string): Promise<{
		data: Uint8Array;
		width: number;
		height: number;
		sourceWidth: number;
		sourceHeight: number;
		target: string;
	}> {
		return {
			data: Uint8Array.of(137, 80, 78, 71),
			width: 64,
			height: 32,
			sourceWidth: this.sourceWidth,
			sourceHeight: this.sourceHeight,
			target,
		};
	}
	async click(_target: string, _x: number, _y: number, _opts?: PointerOptions | null): Promise<void> {
		this.clickCount += 1;
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
	}
}

class MemoryTransport implements ComputerWorkerTransport {
	readonly outbound: ComputerWorkerOutbound[] = [];
	#handler?: (message: ComputerWorkerInbound) => void;
	#waiters = new Set<{
		predicate: (message: ComputerWorkerOutbound) => boolean;
		resolve: (message: ComputerWorkerOutbound) => void;
	}>();

	send(message: ComputerWorkerOutbound): void {
		this.outbound.push(message);
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
	display: "all",
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
			snapshot: { readOnly: true, display: "all" },
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
				"await win.click(10, 20, button='right', delivery=None)",
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
		session.settings.override("computer.enabled", false);
		expect(prelude.enabled?.()).toBe(false);
	});
});

describe("computer worker round trips", () => {
	it("lists windows and returns screenshot caption, image, and detail through a fake native session", async () => {
		const transport = new MemoryTransport();
		const native = new FakeNativeSession();
		new ComputerWorkerCore(transport, options => {
			expect(options).toEqual({ display: "all" });
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
		expect(texts[0]?.text).toMatch(/^screenshot desktop 64×32 → .*omp-computer-.*\.png$/);
		expect(images).toEqual([{ type: "image", data: "iVBORw==", mimeType: "image/png" }]);
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
				text: expect.stringMatching(/^screenshot desktop 64×32 \(scaled from 128×64\) → .*omp-computer-.*\.png$/),
			}),
		);
		expect(result.payload.screenshots[0]).toMatchObject({
			width: 64,
			height: 32,
			sourceWidth: 128,
			sourceHeight: 64,
		});
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
});
