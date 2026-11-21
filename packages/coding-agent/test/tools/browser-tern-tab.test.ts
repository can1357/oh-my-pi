import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { RunOutput } from "@oh-my-pi/pi-coding-agent/tools/browser/run-output";
import type { ScreenshotResult } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { TernElementHandle, TernTab, userSourceFunction } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/tern-tab";
import { parseTernSelector } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/selectors";
import { TernError, TernSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/wire";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
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

	it.each(["about:blank", "https://example.test/"])(
		"does not take an about:blank load reported after the first goto for that navigation (state at %s)",
		async stateUrl => {
			// Tern reported the blank page's load before the goto and again after it, then never
			// loaded the address (its `state` names either page, settled): the open must not return
			// as if the page had arrived.
			let seq = 0;
			let goto = false;
			let afterGoto = 0;
			const fake = await startFakeDaemon((op): FakeAnswer => {
				if (op.op === "open") return { ok: { block: 7, url: "about:blank" } };
				if (op.op === "goto") goto = true;
				if (op.op === "state") return { ok: { url: stateUrl, loading: false, width: 800, height: 600 } };
				if (op.op !== "events") return { ok: {} };
				const batch = seq === 0 || (goto && afterGoto++ === 0) ? BLANK_LOAD : [];
				const events = batch.map(event => ({ seq: ++seq, ...event }));
				return { ok: { events, next: seq, dropped: 0 } };
			});
			daemon = fake;
			client = new TernSocketClient({ socketPath: fake.socketPath });
			const failure = await TernTab.open(client, {
				name: "main",
				pane: 3,
				viewport: { width: 800, height: 600 },
				timeoutMs: 1_500,
				url: "https://example.test/",
			}).catch((error: unknown) => error);
			expect(String(failure)).toContain('tab.goto("https://example.test/") timed out');
			expect(String(failure)).toContain("about:blank load since the goto");
			// The PiP of the failed open is closed again.
			expect(opsOf(fake)).toContain("close");
		},
	);

	it("opens at about:blank without a goto, which a Tern web view would never load", async () => {
		const fake = await startPage({ eventBatches: [], kit: {} });
		await openTab(fake, { url: "about:blank" });
		expect(opsOf(fake)).not.toContain("goto");
	});

	it("reloads for a goto to the address the page shows, which an older Tern never navigates", async () => {
		const fake = await startPage({
			eventBatches: [[], [], [{ type: "committed", url: "https://example.test/" }, { type: "loaded" }]],
			kit: {},
		});
		const tab = await openTab(fake);
		// Tern's `state` reports the page at https://example.test/.
		await tab.readyInfo();
		await tab.goto("https://example.test");
		expect(fake.requests.find(request => request.op.op === "nav")?.op).toMatchObject({ go: "reload", block: 7 });
		expect(opsOf(fake)).not.toContain("goto");
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

	it("presses the requested button for a selector click", async () => {
		const fake = await startPage({
			eventBatches: [],
			kit: { target: () => ({ ok: true, x: 40, y: 20, width: 30, height: 12, count: 1 }) },
		});
		const tab = await openTab(fake);
		await tab.click("#menu", { button: "right" });
		const input = fake.requests.find(request => request.op.op === "input")!.op;
		expect(input.events).toEqual([
			{ type: "mouse", action: "move", x: 40, y: 20, button: "right", clicks: 0, mods: [] },
			{ type: "mouse", action: "down", x: 40, y: 20, button: "right", clicks: 1, mods: [] },
			{ type: "mouse", action: "up", x: 40, y: 20, button: "right", clicks: 1, mods: [] },
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

	it("presses Enter on a native ref handle without sending that ref to the page kit", async () => {
		const node = {
			ref: "e1-5",
			tag: "input",
			role: "textbox",
			states: ["editable"],
			rect: [20, 10, 40, 20],
		};
		daemon = await startFakeDaemon(
			(op): FakeAnswer => {
				if (op.op === "dom") {
					return {
						ok:
							op.read === "query"
								? { nodes: [node], total: 1 }
								: { state: "ok", point: [40, 20], rect: node.rect, node },
					};
				}
				if (op.op === "eval") return { error: { kind: "js", message: "native refs cannot reach the page kit" } };
				return { ok: {} };
			},
			{ welcome: { ops: ["dom"] } },
		);
		client = new TernSocketClient({ socketPath: daemon.socketPath });
		await client.connect();
		const tab = new TernTab({ client, block: 7, name: "main", viewport: { width: 800, height: 600 } });
		await new TernElementHandle(tab, { engine: "ref", ref: node.ref }, null).press("Enter");
		const events = daemon.requests.filter(request => request.op.op === "input").flatMap(request => request.op.events);
		expect(events).toContainEqual(expect.objectContaining({ type: "key", action: "down", key: "Enter" }));
		expect(events).toContainEqual(expect.objectContaining({ type: "key", action: "up", key: "Enter" }));
	});

	it("sends one key press to an uncovered element and none to an element a dialog covers", async () => {
		let covered = false;
		const fake = await startPage({
			eventBatches: [],
			kit: {
				target: () =>
					covered
						? { ok: false, reason: "covered", count: 1, detail: "<dialog#modal>" }
						: { ok: true, x: 5, y: 5, width: 100, height: 20, count: 1 },
				focus: () => null,
			},
		});
		const tab = await openTab(fake);
		// A short cell budget, so the refused press stops polling the covered target quickly.
		tab.setRunContext({
			timeoutMs: 2_000,
			deadline: Date.now() + 2_000,
			signal: new AbortController().signal,
			session: { cwd: os.tmpdir() },
			output: new RunOutput(),
			screenshots: [],
		});
		await tab.press("Enter", { selector: "#name" });
		const inputs = () => fake.requests.filter(request => request.op.op === "input").length;
		expect(inputs()).toBe(1);
		covered = true;
		const refused = await tab.press("Enter", { selector: "#name" }).catch((error: unknown) => String(error));
		expect(refused).toContain('tab.press("Enter", { selector: "#name" }) timed out');
		expect(refused).toContain("covered by <dialog#modal>");
		expect(inputs()).toBe(1);
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

	it("reads the page body when text or html gets no selector", async () => {
		const reads: unknown[][] = [];
		const fake = await startPage({
			eventBatches: [],
			kit: {
				read: args => {
					reads.push(args.slice(0, 2));
					return "page";
				},
			},
		});
		const tab = await openTab(fake);
		expect(await tab.text()).toBe("page");
		expect(await tab.html()).toBe("page");
		expect(reads).toEqual([
			[parseTernSelector("body"), "text"],
			[parseTernSelector("body"), "html"],
		]);
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

	it("reports a block the window no longer lists as gone, with how to reopen, and sends nothing more", async () => {
		let gone = false;
		daemon = await startFakeDaemon((op): FakeAnswer => {
			switch (op.op) {
				case "open":
					return { ok: { block: 7, url: "about:blank" } };
				case "events":
					return { ok: { events: BLANK_LOAD.map((event, index) => ({ seq: index + 1, ...event })), next: 2 } };
				case "blocks":
					return { ok: { blocks: gone ? [] : [{ block: 7, url: "about:blank", title: "", owner: 3 }] } };
				case "state":
					if (gone) return { error: { kind: "not_found", message: "no browser block 7 in this window" } };
					return { ok: { url: "about:blank", width: 800, height: 600 } };
				default:
					return { ok: {} };
			}
		});
		const fake = daemon;
		const tab = await openTab(fake);
		gone = true;
		const failure = await tab.readyInfo().catch((error: unknown) => error);
		expect(String(failure)).toContain(
			'Tab "main" is gone: its Tern browser block 7 is no longer in this Tern window',
		);
		expect(String(failure)).toContain('browser.targets({ app: "tern" })');
		expect(tab.gone).toContain("browser block 7 is no longer in this Tern window");
		const before = fake.requests.length;
		await expect(tab.readyInfo()).rejects.toBe(failure);
		expect(fake.requests.length).toBe(before);
	});

	it("keeps a not_found for a block the window still lists as that op's own failure", async () => {
		daemon = await startFakeDaemon((op): FakeAnswer => {
			if (op.op === "open") return { ok: { block: 7, url: "about:blank" } };
			if (op.op === "events") {
				return { ok: { events: BLANK_LOAD.map((event, index) => ({ seq: index + 1, ...event })), next: 2 } };
			}
			if (op.op === "blocks") return { ok: { blocks: [{ block: 7, url: "about:blank", title: "", owner: 3 }] } };
			if (op.op === "state") return { error: { kind: "not_found", message: "stale ref e3" } };
			return { ok: {} };
		});
		const tab = await openTab(daemon);
		await expect(tab.readyInfo()).rejects.toThrow("stale ref e3");
		expect(tab.gone).toBeUndefined();
	});

	it("says how to get a fixed viewport when the block was docked", async () => {
		daemon = await startFakeDaemon((op): FakeAnswer => {
			switch (op.op) {
				case "open":
					return { ok: { block: 7, url: "about:blank" } };
				case "events":
					return { ok: { events: BLANK_LOAD.map((event, index) => ({ seq: index + 1, ...event })), next: 2 } };
				case "viewport":
					return { error: { kind: "failed", message: "the block is docked: its page takes the block's size" } };
				case "blocks":
					return { ok: { blocks: [{ block: 7, url: "https://example.test/", title: "", owner: null }] } };
				case "state":
					return { ok: { url: "https://example.test/", width: 843, height: 632 } };
				default:
					return { ok: {} };
			}
		});
		const tab = await openTab(daemon);
		const failure = await tab.setViewport({ width: 1000, height: 900 }).catch((error: unknown) => error);
		expect(String(failure)).toContain("is docked, so its page takes the block's size (843x632 now)");
		expect(String(failure)).toContain('app: "own"');
	});

	it("names the backend and the helpers to use for page event listeners", () => {
		const tab = new TernTab({
			client: new TernSocketClient({ socketPath: "/nonexistent" }),
			block: 7,
			name: "main",
			viewport: { width: 800, height: 600 },
		});
		expect(() => tab.page.on("request", () => {})).toThrow(
			/page\.on\("request"\) is not supported on the Tern browser backend: .*tab\.requests\(\)/,
		);
		expect(() => tab.page.once("console", () => {})).toThrow(/tab\.console\(\)/);
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

describe("TernTab on an unresponsive page", () => {
	async function runTab(fake: FakeDaemon, timeoutMs: number): Promise<TernTab> {
		client = new TernSocketClient({ socketPath: fake.socketPath });
		// The welcome says what the host does: a tab reads it from the connected client.
		await client.connect();
		const tab = new TernTab({ client, block: 7, name: "main", viewport: { width: 800, height: 600 } });
		tab.setRunContext({
			timeoutMs,
			deadline: Date.now() + timeoutMs,
			signal: new AbortController().signal,
			session: { cwd: os.tmpdir() },
			output: new RunOutput(),
			screenshots: [],
		});
		return tab;
	}

	it.each([
		{ ops: ["browser", "dom", "responsive"], failFast: true },
		{ ops: ["browser", "dom"], failFast: undefined },
	])(
		"asks a host that watches responsiveness ($ops) to fail a read at once, and names the way out",
		async ({ ops, failFast }) => {
			daemon = await startFakeDaemon(
				(op): FakeAnswer =>
					op.op === "dom"
						? {
								error: {
									kind: "unresponsive",
									message:
										"dom: the page is unresponsive: a script keeps its web process busy (no answer for 3.0 s)",
								},
							}
						: { ok: {} },
				{ welcome: { ops } },
			);
			const tab = await runTab(daemon, 5_000);
			const error = await tab.observe().catch((failure: unknown) => failure);
			// Only a host that lists `responsive` strips the member before the engine reads the request.
			expect(daemon.requests.find(request => request.op.op === "dom")?.op.failUnresponsive).toBe(failFast);
			if (!(error instanceof TernError)) throw error;
			expect(error.kind).toBe("unresponsive");
			if (failFast)
				expect(error.message).toContain('In tab "main", tab.reload() or tab.goto() ends that web process');
		},
	);

	it("names an unresponsive page as the cause of a timed-out call when the host's state says so", async () => {
		daemon = await startFakeDaemon(
			(op): FakeAnswer => {
				if (op.op === "eval") return null;
				if (op.op === "state") return { ok: { url: "https://example.test/", responsive: false } };
				return { ok: {} };
			},
			{ welcome: { ops: ["browser", "dom", "responsive"] } },
		);
		const tab = await runTab(daemon, 1_500);
		const error = await tab.evaluate(() => 1).catch((failure: unknown) => failure);
		if (!(error instanceof TernError)) throw error;
		expect(error.kind).toBe("unresponsive");
		expect(error.message).toContain("timed out");
		expect(error.message).toContain("the page is unresponsive");
	});
});

describe("TernTab screenshots", () => {
	it("sizes the screenshot by the scale the capture was taken at, not one set while it ran", async () => {
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
			deadline: Date.now() + 5_000,
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
		// At scale 1 the 1200x700 capture is the viewport in CSS pixels; read at the later 2 it would shrink to 600x350.
		expect(text).toBe("Screenshot 1200x700.");
		for (const saved of screenshots) await fs.rm(saved.dest);
	});

	it("reads clickAt positions on a scaled screenshot, and page.mouse positions as CSS pixels", async () => {
		// A 4000x400 viewport reaches the model at half size, 2000x200.
		const png = encodeRawPng(new Uint8Array(4000 * 400 * 3), 4000, 400, 3).toBase64();
		daemon = await startFakeDaemon(op => (op.op === "capture" ? { ok: { data: png } } : { ok: {} }));
		client = new TernSocketClient({ socketPath: daemon.socketPath });
		const tab = new TernTab({
			client,
			block: 7,
			name: "main",
			viewport: { width: 4000, height: 400, deviceScaleFactor: 1 },
		});
		const screenshots: ScreenshotResult[] = [];
		tab.setRunContext({
			timeoutMs: 5_000,
			deadline: Date.now() + 5_000,
			signal: new AbortController().signal,
			session: { cwd: os.tmpdir() },
			output: new RunOutput(),
			screenshots,
		});
		await tab.screenshot();
		await tab.clickAt(1000, 100);
		await tab.page.mouse.click(1000, 100);

		// Where each click's pointer first moved: the image's centre is the viewport's, raw page input is not mapped.
		const moves = daemon.requests.flatMap(request => {
			const first: unknown = Array.isArray(request.op.events) ? request.op.events[0] : undefined;
			return isRecord(first) ? [[first.x, first.y]] : [];
		});
		expect(moves).toEqual([
			[2000, 200],
			[1000, 100],
		]);

		// The picture is of another viewport once it is resized.
		await tab.setViewport({ width: 1000, height: 600 });
		await expect(tab.clickAt(1000, 100)).rejects.toThrow(/new screenshot/);
		for (const saved of screenshots) await fs.rm(saved.dest);
	});
});
