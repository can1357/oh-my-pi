/**
 * The `/debug` viewers as Tern receives them: the raw SSE stream is a page of
 * its own (`omp.debug`) with the bar docked under it, the log viewer a bare
 * picker over the session, and the system, terminal and protocol reports
 * transcript blocks. Closing a viewer brings the debug menu back.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveRawSseDebugBuffer } from "@oh-my-pi/pi-coding-agent/debug/raw-sse-buffer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getLogPath, TempDir } from "@oh-my-pi/pi-utils";
import type { TspNode, TspPickerProps } from "@oh-my-pi/pi-wire";
import { initTheme } from "../src/ui/theme/service";
import { setImageBlobWriter } from "../src/ui/transcript/image-links";
import { createModeTerminal } from "./helpers/mode-terminal";
import { nativeShell } from "./helpers/native-shell";

const ESCAPE = "\x1b[27u";
const CTRL_C = "\x1b[99;5u";

/** The native-shell helper these checks drive. */
type NativeDocument = Awaited<ReturnType<typeof nativeShell>>;

/** The open surface of `mode` with each region's nodes as whole trees; undefined when none is open. */
function surfaceOf(ui: NativeDocument, mode: "inline" | "screen") {
	const surface = ui.surface(mode);
	if (!surface) return undefined;
	const trees = (nodes: readonly { readonly id: string }[]) => nodes.map(node => ui.tree(node.id));
	return { role: surface.role, main: trees(surface.main), dock: trees(surface.dock), layer: trees(surface.layer) };
}

/** A wire node's props as plain data (each kind types its own; these checks read them by name). */
function propsOf(node: TspNode): Readonly<Record<string, unknown>> {
	return { ...node.p };
}

/** `kind:role` of a node. */
function sig(node: TspNode): string {
	const role = propsOf(node).role;
	return typeof role === "string" ? `${node.k}:${role}` : node.k;
}

/** The text a node shows: its spans or plain text, and its children's. */
function textOf(node: TspNode): string {
	const { text, spans } = propsOf(node);
	const own = Array.isArray(spans)
		? spans.map((span: { t: string }) => span.t).join("")
		: typeof text === "string"
			? text
			: "";
	return [own, ...(node.c ?? []).map(textOf)].filter(Boolean).join(" ");
}

/** The first node under `nodes` that `test` accepts. */
function find(nodes: readonly TspNode[], test: (node: TspNode) => boolean): TspNode | undefined {
	for (const node of nodes) {
		if (test(node)) return node;
		const inner = find(node.c ?? [], test);
		if (inner) return inner;
	}
	return undefined;
}

/** The click action a control advertises. */
function clickOf(node: TspNode): string | undefined {
	const actions = propsOf(node).actions;
	if (!actions || typeof actions !== "object" || !("click" in actions)) return undefined;
	return typeof actions.click === "string" ? actions.click : undefined;
}

/** Whether the native document holds a node of `kind`. */
function has(ui: NativeDocument, kind: string): boolean {
	try {
		ui.node(kind);
		return true;
	} catch {
		return false;
	}
}

/**
 * Wait for `ready`. The debug tools read real files before they mount anything and the menu is a
 * lazily imported module, neither behind a promise a test can hold, so this polls the document.
 */
async function until(ready: () => boolean): Promise<void> {
	for (let turn = 0; turn < 500 && !ready(); turn++) await Bun.sleep(1);
	expect(ready()).toBe(true);
}

describe("debug viewers in a Tern terminal", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-debug-viewers-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({}),
			modelRegistry,
		});
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			createModeTerminal().frame,
		);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** Open the debug menu and pick `entry` from it. */
	const pick = async (ui: NativeDocument, entry: string): Promise<void> => {
		await mode.showDebugSelector();
		ui.send({ ev: "select", sf: ui.sf, id: ui.node("list", "list").id, item: entry });
	};
	/** Whether the debug menu stands in the composer's place. */
	const menuOpen = (ui: NativeDocument): boolean => has(ui, "list") && !has(ui, "editor");
	/** Run the click action `act` of the control that advertises it under `nodes`. */
	const clickAction = (ui: NativeDocument, nodes: readonly TspNode[], act: string): void => {
		const control = find(nodes, node => clickOf(node) === act);
		if (!control) throw new Error(`No control with the click action ${act}`);
		ui.send({ ev: "action", sf: ui.sf, id: control.id, act });
	};

	it("opens the raw SSE stream as an omp.debug page with the bar docked, and Escape returns to the menu", async () => {
		await using ui = await nativeShell(mode.shell);
		await pick(ui, "raw-sse");
		await until(() => surfaceOf(ui, "screen") !== undefined);

		const page = surfaceOf(ui, "screen")!;
		expect(page.role).toBe("omp.debug");
		expect(page.main.map(sig)).toEqual(["row:omp.app.head", "col:omp.app.empty"]);
		expect(textOf(page.main[0]!)).toBe("Raw provider stream 0 events · 0 records · waiting for first frame");
		expect(textOf(page.main[1]!)).toContain("No raw SSE frames captured yet");
		expect(page.dock.map(sig)).toEqual(["col:omp.debug.bar"]);
		expect(page.dock[0]!.c!.map(sig)).toEqual(["row:omp.actions"]);
		expect(page.layer).toEqual([]);
		// The page is no sheet of the session, and the menu is gone while it is up.
		expect(surfaceOf(ui, "inline")?.layer).toEqual([]);

		ui.type(CTRL_C);
		const bar = surfaceOf(ui, "screen")!.dock[0]!;
		expect(bar.c!.map(sig)).toEqual(["text:omp.app.status", "row:omp.actions"]);
		expect(propsOf(bar.c![0]!)).toMatchObject({ spans: [{ s: "error", t: "No raw SSE frames to copy" }] });

		ui.type(ESCAPE);
		await until(() => surfaceOf(ui, "screen") === undefined);
		await until(() => menuOpen(ui));
		const menu = find(surfaceOf(ui, "inline")!.dock, node => node.k === "card");
		expect(menu && propsOf(menu)).toMatchObject({ head: "Debug Tools" });
	});

	it("streams captured frames into the page's block and closes from the bar's Close button", async () => {
		const buffer = resolveRawSseDebugBuffer(session);
		buffer.recordEvent({ event: "message", data: '{"n":1}', raw: ["event: message", 'data: {"n":1}'] });
		await using ui = await nativeShell(mode.shell);
		await pick(ui, "raw-sse");
		await until(() => surfaceOf(ui, "screen") !== undefined);

		const page = () => surfaceOf(ui, "screen")!;
		expect(page().main.map(sig)).toEqual(["row:omp.app.head", "ansi:omp.debug.stream"]);
		expect(textOf(page().main[0]!)).toStartWith("Raw provider stream 1 events · 1 records · last ");
		expect(propsOf(page().main[1]!)).toMatchObject({
			text: 'event: message\ndata: {"n":1}\n\n',
			follow: true,
			max: { h: 1 },
		});

		buffer.recordEvent({ event: "message", data: '{"n":2}', raw: ["event: message", 'data: {"n":2}'] });
		expect(textOf(page().main[0]!)).toStartWith("Raw provider stream 2 events · 2 records · last ");
		expect(propsOf(page().main[1]!).text).toEndWith('data: {"n":2}\n\n');

		clickAction(ui, page().dock, "close");
		await until(() => surfaceOf(ui, "screen") === undefined);
		await until(() => menuOpen(ui));

		ui.type(ESCAPE);
		expect(has(ui, "card")).toBe(false);
		expect(has(ui, "editor")).toBe(true);
	});

	it("opens the recent logs as a bare picker over the session: typing filters it, Escape returns to the menu", async () => {
		const marker = `debug-viewers-${Bun.randomUUIDv7()}`;
		const logPath = getLogPath();
		fs.mkdirSync(path.dirname(logPath), { recursive: true });
		fs.appendFileSync(
			logPath,
			`${JSON.stringify({ timestamp: new Date().toISOString(), level: "warn", pid: process.pid, message: `${marker} entry`, reason: "fixture" })}\n`,
		);
		await using ui = await nativeShell(mode.shell);
		await pick(ui, "logs");
		await until(() => has(ui, "picker"));

		const picker = () => ui.node("picker");
		expect(surfaceOf(ui, "screen")).toBeUndefined();
		expect(picker().parent).toBe("layer");
		expect(picker().p).toMatchObject({ title: "Recent logs", noun: "entries", layout: "rows", size: "lg" });
		// The sheet floats over the session: the composer stays docked under it and the menu is gone.
		expect(has(ui, "editor")).toBe(true);
		expect(has(ui, "list")).toBe(false);

		ui.type(marker);
		const filtered: TspPickerProps = picker().p;
		expect(filtered.query).toBe(marker);
		// Only the fixture entry matches (older days' files add their "load older" row).
		expect(filtered.items?.filter(item => item.id !== "older")).toMatchObject([
			{ label: `${marker} entry`, detail: "reason=fixture", dot: "warning" },
		]);
		expect(filtered.preview).toBe("below");

		ui.type(ESCAPE);
		await until(() => !has(ui, "picker"));
		await until(() => menuOpen(ui));
	});

	it("reports system info and terminal state as transcript blocks of one wrapped text between hidden rules", async () => {
		await using ui = await nativeShell(mode.shell);
		const blocks = () => surfaceOf(ui, "inline")!.main;
		for (const [entry, title] of [
			["system", "System Information"],
			["terminal", "Terminal State"],
		] as const) {
			const before = blocks().length;
			await pick(ui, entry);
			await until(() => blocks().length > before);

			const block = blocks().at(-1)!;
			expect(block.k).toBe("col");
			expect(block.c!.map(sig)).toEqual(["col", "text", "col"]);
			expect(propsOf(block.c![0]!)).toEqual({ hidden: true });
			expect(propsOf(block.c![2]!)).toEqual({ hidden: true });
			expect(propsOf(block.c![1]!)).toEqual({
				wrap: "word",
				spans: [{ t: expect.stringMatching(new RegExp(`^${title}\\n━+\\n`)) }],
			});
			if (entry === "terminal") {
				// The sections released reports, in its order.
				expect(
					textOf(block)
						.split("\n")
						.filter(line => line && !line.startsWith(" ") && !line.includes(":")),
				).toEqual(["Terminal State", "━━━━━━━━━━━━━━", "Subprotocols", "Scrollback", "Detection signals"]);
				expect(textOf(block)).toContain("\nDetected:     tern\nGeometry:     ");
			}
			// No page, no sheet: the composer is back under the transcript.
			expect(surfaceOf(ui, "screen")).toBeUndefined();
			expect(surfaceOf(ui, "inline")!.layer).toEqual([]);
			expect(has(ui, "editor")).toBe(true);
		}
	});

	it("reports the protocol test under a spacer, its sample image opening a blob copy from its menu", async () => {
		const blobPath = path.join(tempDir.path(), "sample.png");
		using _writer = { [Symbol.dispose]: setImageBlobWriter(() => ({ displayPath: blobPath })) };
		await using ui = await nativeShell(mode.shell);
		const blocks = () => surfaceOf(ui, "inline")!.main;
		const before = blocks().length;
		await pick(ui, "protocols");
		await until(() => blocks().length > before);

		const [spacer, panel] = blocks().slice(-2);
		expect(spacer).toMatchObject({ k: "spacer", p: { size: "sm" } });
		expect(textOf(panel!)).toStartWith("Terminal Protocol Test");
		const image = find([panel!], node => node.k === "image")!;
		expect(propsOf(image)).toMatchObject({
			href: Bun.pathToFileURL(blobPath).href,
			actions: { menu: ["open"] },
			max: { w: "20ch", h: "16lines" },
		});
		expect(surfaceOf(ui, "screen")).toBeUndefined();
		expect(has(ui, "editor")).toBe(true);
	});
});
