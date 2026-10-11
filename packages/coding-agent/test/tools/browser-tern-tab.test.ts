import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { RunOutput } from "@oh-my-pi/pi-coding-agent/tools/browser/run-output";
import type { ScreenshotResult } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { TernElementHandle, TernTab, userSourceFunction } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/tern-tab";
import { TernSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/wire";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import { type FakeAnswer, type FakeDaemon, startFakeDaemon } from "./tern-fake-daemon";

interface FakePage {
	/** Event batches the `events` op hands out, one per poll. */
	eventBatches: Array<Array<Record<string, unknown>>>;
	/** Kit method stubs (isolated-world `__ompTernKit` calls). */
	kit: Record<string, (args: unknown[]) => unknown>;
	/** Which `events` answer (0-based) first reports the PiP's initial about:blank load (default 0). */
	blankLoadPoll?: number;
}

/** The events of the initial about:blank load every PiP makes after `open`. */
const BLANK_LOAD = [
	{ type: "committed", url: "about:blank" },
	{ type: "loaded", url: "about:blank" },
];

let daemon: FakeDaemon | undefined;
let client: TernSocketClient | undefined;

afterEach(async () => {
	client?.close();
	client = undefined;
	await daemon?.close();
	daemon = undefined;
});

async function startPage(page: FakePage): Promise<FakeDaemon> {
	let seq = 0;
	let polls = 0;
	daemon = await startFakeDaemon((op): FakeAnswer => {
		switch (op.op) {
			case "open":
				return { ok: { block: 7, url: "about:blank" } };
			case "events": {
				const batch = page.eventBatches.shift() ?? [];
				if (polls++ === (page.blankLoadPoll ?? 0)) batch.unshift(...BLANK_LOAD);
				return { ok: { events: batch.map(event => ({ seq: ++seq, ...event })), next: seq, dropped: 0 } };
			}
			case "state":
				return {
					ok: {
						url: "https://example.test/",
						title: "Example",
						loading: true,
						back: false,
						forward: false,
						width: 800,
						height: 600,
					},
				};
			case "eval": {
				const args = Array.isArray(op.args) ? op.args : [];
				if (String(op.function).includes("__ompTernKit") && typeof args[0] === "string") {
					const stub = page.kit[args[0]];
					if (!stub) return { error: { kind: "js", message: `Error: kit method ${args[0]} not stubbed` } };
					return { ok: { value: { value: stub(Array.isArray(args[1]) ? args[1] : []) } } };
				}
				return { ok: {} };
			}
			case "dialog":
				return { ok: {} };
			default:
				return { ok: {} };
		}
	});
	return daemon;
}

/** A `message` event carrying one page-capture report. */
function capture(message: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "message",
		world: "page",
		main: true,
		url: "https://example.test/",
		body: JSON.stringify({ omp: "tern", ts: 1, ...message }),
	};
}

function opsOf(fake: FakeDaemon): string[] {
	return fake.requests.map(request => String(request.op.op));
}

async function openTab(
	fake: FakeDaemon,
	extra: { url?: string; dialogs?: "accept" | "dismiss" } = {},
): Promise<TernTab> {
	client = new TernSocketClient({ socketPath: fake.socketPath });
	return await TernTab.open(client, {
		name: "main",
		pane: 3,
		viewport: { width: 800, height: 600 },
		timeoutMs: 5_000,
		allowedDomains: ["example.test"],
		...extra,
	});
}

describe("TernTab", () => {
	it("configures the PiP before its first navigation and resolves on that navigation's own load", async () => {
		// Tern reports the initial about:blank load only in its third events answer: a goto sent
		// before it would take that late `loaded` for its own and resolve before the page loads.
		const page: FakePage = {
			blankLoadPoll: 2,
			eventBatches: [
				[],
				[],
				[],
				[],
				[{ type: "committed", url: "https://example.test/" }],
				[{ type: "loaded", url: "https://example.test/" }],
			],
			kit: {},
		};
		const fake = await startPage(page);
		const tab = await openTab(fake, { url: "https://example.test/", dialogs: "accept" });
		const ops = opsOf(fake);
		expect(fake.requests[0]!.op).toMatchObject({ op: "open", owner: 3, url: "about:blank", width: 800, height: 600 });
		expect(fake.requests.find(request => request.op.op === "dialogs")!.op).toMatchObject({
			block: 7,
			policy: "accept",
		});
		expect(fake.requests.find(request => request.op.op === "allow")!.op).toMatchObject({ hosts: ["example.test"] });
		const scripts = ops.indexOf("scripts");
		const gotoAt = ops.indexOf("goto");
		expect(scripts).toBeGreaterThan(0);
		expect(gotoAt).toBeGreaterThan(scripts);
		// open resolved only once Tern reported the document's own `loaded`.
		expect(page.eventBatches).toEqual([]);
		expect(tab.url()).toBe("https://example.test/");
	});

	it("fails a navigation Tern reports as failed", async () => {
		const fake = await startPage({
			eventBatches: [
				[],
				[],
				[{ type: "failed", message: "A server with the specified hostname could not be found." }],
			],
			kit: {},
		});
		client = new TernSocketClient({ socketPath: fake.socketPath });
		const tab = await TernTab.open(client, {
			name: "main",
			pane: 3,
			viewport: { width: 800, height: 600 },
			timeoutMs: 5_000,
		});
		const failure = await tab.goto("https://nowhere.test/").catch((error: unknown) => error);
		expect(String(failure)).toContain("hostname could not be found");
	});

	it("clicks with trusted mouse events at the actionable element centre", async () => {
		const targets: unknown[] = [];
		const fake = await startPage({
			eventBatches: [],
			kit: {
				target: args => {
					targets.push(args);
					return { ok: true, x: 40, y: 20, width: 30, height: 12, count: 1 };
				},
			},
		});
		const tab = await openTab(fake);
		await tab.click("text/Sign in");
		expect(targets).toEqual([[{ engine: "text", query: "Sign in" }, "click"]]);
		const input = fake.requests.find(request => request.op.op === "input")!.op;
		expect(input.events).toEqual([
			{ type: "mouse", action: "move", x: 40, y: 20, button: "left", clicks: 0, mods: [] },
			{ type: "mouse", action: "down", x: 40, y: 20, button: "left", clicks: 1, mods: [] },
			{ type: "mouse", action: "up", x: 40, y: 20, button: "left", clicks: 1, mods: [] },
		]);
	});

	it("presses the requested button and click count for an element click", async () => {
		const fake = await startPage({
			eventBatches: [],
			kit: { target: () => ({ ok: true, x: 40, y: 20, width: 30, height: 12, count: 1 }) },
		});
		const tab = await openTab(fake);
		await new TernElementHandle(tab, { engine: "css", query: "#menu" }, null).click({ button: "right", count: 2 });
		const input = fake.requests.find(request => request.op.op === "input")!.op;
		expect(input.events).toEqual([
			{ type: "mouse", action: "move", x: 40, y: 20, button: "right", clicks: 0, mods: [] },
			{ type: "mouse", action: "down", x: 40, y: 20, button: "right", clicks: 1, mods: [] },
			{ type: "mouse", action: "up", x: 40, y: 20, button: "right", clicks: 1, mods: [] },
			{ type: "mouse", action: "down", x: 40, y: 20, button: "right", clicks: 2, mods: [] },
			{ type: "mouse", action: "up", x: 40, y: 20, button: "right", clicks: 2, mods: [] },
		]);
	});

	it("fills text controls with trusted text input after the kit selects their content", async () => {
		const fake = await startPage({
			eventBatches: [],
			kit: {
				target: () => ({ ok: true, x: 5, y: 5, width: 100, height: 20, count: 1 }),
				prepareFill: () => ({ mode: "insert" }),
			},
		});
		const tab = await openTab(fake);
		await tab.fill("#email", "a@b.test");
		const input = fake.requests.find(request => request.op.op === "input")!.op;
		expect(input.events).toEqual([{ type: "text", text: "a@b.test" }]);
	});

	it("reports a held dialog and answers it through the dialog op", async () => {
		const fake = await startPage({
			eventBatches: [
				[],
				[
					{
						type: "dialog",
						kind: "prompt",
						message: "Name?",
						default: "x",
						url: "https://example.test/",
						handled: null,
					},
				],
			],
			kit: {},
		});
		const tab = await openTab(fake);
		expect(await tab.dialog()).toEqual({ open: true, type: "prompt", message: "Name?", defaultValue: "x" });
		await tab.handleDialog({ accept: true, text: "omp" });
		expect(fake.requests.find(request => request.op.op === "dialog")!.op).toMatchObject({
			accept: true,
			text: "omp",
		});
		expect(await tab.dialog()).toEqual({ open: false });
	});

	it("resolves waitForResponse by response arrival, including requests already in flight", async () => {
		const fake = await startPage({
			eventBatches: [
				[],
				[
					capture({
						kind: "request",
						id: "d:1",
						method: "GET",
						url: "https://example.test/slow",
						resourceType: "fetch",
						headers: {},
					}),
					capture({
						kind: "request",
						id: "d:2",
						method: "GET",
						url: "https://example.test/fast",
						resourceType: "fetch",
						headers: {},
					}),
				],
				[capture({ kind: "response", id: "d:2", url: "https://example.test/fast", status: 200, headers: {} })],
				[capture({ kind: "response", id: "d:1", url: "https://example.test/slow", status: 201, headers: {} })],
				[
					{
						type: "response",
						url: "https://example.test/",
						status: 200,
						mime: "text/html",
						headers: { "Content-Type": "text/html" },
						main: true,
					},
				],
			],
			kit: {},
		});
		const tab = await openTab(fake);
		const response = await tab.waitForResponse("/slow", { timeout: 5_000 });
		expect(response.status()).toBe(201);
		const navigation = (await tab.requests()).find(record => record.resourceType === "document")!;
		expect(navigation.responseHeaders).toEqual({ "content-type": "text/html" });
	});

	it("runs a string evaluate exactly once, as an expression or as statements", async () => {
		expect(userSourceFunction("1 + 1")).toContain("return (\n1 + 1\n);");
		expect(userSourceFunction("const a = 1; return a;")).toBe("function () {\nconst a = 1; return a;\n}");
		const fake = await startPage({ eventBatches: [], kit: {} });
		const tab = await openTab(fake);
		const before = fake.requests.length;
		await tab.evaluate("const response = await fetch('/api', { method: 'POST' }); return JSON.parse('{')");
		const evals = fake.requests.slice(before).filter(request => request.op.op === "eval");
		expect(evals).toHaveLength(1);
	});

	it("returns one handle per match from page.$$", async () => {
		const reads: unknown[] = [];
		const fake = await startPage({
			eventBatches: [],
			kit: {
				markAll: () => ["t1", "t2"],
				read: args => {
					reads.push(args[0]);
					return "row";
				},
			},
		});
		const tab = await openTab(fake);
		const handles = await tab.page.$$("li");
		expect(handles).toHaveLength(2);
		await handles[1]!.text();
		expect(reads).toEqual([{ engine: "handle", token: "t2" }]);
	});

	it("closes the PiP of an open that was abandoned before Tern answered", async () => {
		const opened = Promise.withResolvers<number>();
		const closed = Promise.withResolvers<unknown>();
		daemon = await startFakeDaemon((op, id) => {
			if (op.op === "open") {
				opened.resolve(id);
				return null;
			}
			if (op.op === "close") closed.resolve(op.block);
			return { ok: {} };
		});
		client = new TernSocketClient({ socketPath: daemon.socketPath });
		const aborter = new AbortController();
		const opening = TernTab.open(client, {
			name: "main",
			pane: 3,
			viewport: { width: 800, height: 600 },
			timeoutMs: 5_000,
			signal: aborter.signal,
		}).catch((error: unknown) => error);
		const id = await opened.promise;
		aborter.abort(new Error("caller gave up"));
		expect(((await opening) as Error).message).toBe("caller gave up");
		daemon.answer(id, { ok: { block: 44, url: "about:blank" } });
		expect(await closed.promise).toBe(44);
	});

	it("passes optional arguments a helper omits to the page as undefined", async () => {
		const area: Record<string, string> = { a: "1", b: "2" };
		const names = ["a", "b"];
		daemon = await startFakeDaemon(op => {
			if (op.op === "open") return { ok: { block: 7, url: "about:blank" } };
			if (op.op === "events") {
				const events = BLANK_LOAD.map((event, index) => ({ seq: index + 1, ...event }));
				return { ok: { events, next: events.length, dropped: 0 } };
			}
			const source = String(op.function);
			if (op.op !== "eval" || !source.includes("localStorage")) return { ok: {} };
			// The page: the helper's function runs against a stand-in Web Storage area.
			const localStorage = {
				length: names.length,
				key: (index: number) => names[index] ?? null,
				getItem: (name: string) => area[name] ?? null,
			};
			const run: (...args: unknown[]) => unknown = new Function("globalThis", `return (${source});`)({
				localStorage,
			});
			return { ok: { value: run(...(Array.isArray(op.args) ? op.args : [])) } };
		});
		client = new TernSocketClient({ socketPath: daemon.socketPath });
		const tab = await TernTab.open(client, {
			name: "main",
			pane: 3,
			viewport: { width: 800, height: 600 },
			timeoutMs: 5_000,
		});
		expect(await tab.storage("local")).toEqual({ a: "1", b: "2" });
		expect(await tab.storage("local", { key: "b" })).toBe("2");
	});

	it("names the Tern backend and the reason for helpers it cannot provide", async () => {
		const fake = await startPage({ eventBatches: [], kit: {} });
		const tab = await openTab(fake);
		await expect(tab.traceStart()).rejects.toThrow(
			/tab\.traceStart\(\) is not supported on the Tern browser backend/,
		);
		await expect(tab.pdf({ format: "a4", margin: { top: 1 } })).rejects.toThrow(
			/options format, margin are unavailable/,
		);
		const before = fake.requests.length;
		await expect(tab.emulate({ timezone: "Europe/Paris", viewport: { width: 1, height: 1 } })).rejects.toThrow(
			/timezone cannot be overridden/,
		);
		await expect(tab.emulate({ reducedMotion: false })).rejects.toThrow(/prefers-reduced-motion/);
		await expect(tab.route("**/*.png", { resourceType: "image", abort: true })).rejects.toThrow(
			/resourceType image: only the page's fetch and xhr requests can be routed/,
		);
		expect(fake.requests.length).toBe(before);
	});
});

describe("TernTab screenshots", () => {
	it("states the coordinate scale the capture was taken at, not one set while it ran", async () => {
		const captureAsked = Promise.withResolvers<number>();
		daemon = await startFakeDaemon((op, id) => {
			if (op.op !== "capture") return { ok: {} };
			captureAsked.resolve(id);
			return null;
		});
		client = new TernSocketClient({ socketPath: daemon.socketPath });
		const tab = new TernTab({
			client,
			block: 7,
			name: "main",
			viewport: { width: 1200, height: 700, deviceScaleFactor: 1 },
		});
		const output = new RunOutput();
		const screenshots: ScreenshotResult[] = [];
		tab.setRunContext({
			timeoutMs: 5_000,
			signal: new AbortController().signal,
			session: { cwd: os.tmpdir() },
			output,
			screenshots,
		});
		const shot = tab.screenshot();
		const captureId = await captureAsked.promise;
		await tab.setViewport({ width: 1200, height: 700, deviceScaleFactor: 2 });
		daemon.answer(captureId, { ok: { data: encodeRawPng(new Uint8Array(1200 * 700 * 3), 1200, 700, 3).toBase64() } });
		await shot;
		const text = output
			.finish()
			.flatMap(block => (block.type === "text" ? [block.text] : []))
			.join("\n");
		expect(daemon.requests.find(request => request.op.op === "capture")?.op.scale).toBe(1);
		expect(text).toContain("by 1.17 to get viewport CSS pixels for tab.clickAt");
		for (const saved of screenshots) await fs.rm(saved.dest);
	});
});
