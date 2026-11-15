import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import { RunOutput } from "@oh-my-pi/pi-coding-agent/tools/browser/run-output";
import { type DomQuery, domQueryFor } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/dom";
import { parseTernSelector, type TernSelector } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/selectors";
import { TernTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/tern-tab";
import { TernSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/wire";
import { type FakeAnswer, type FakeDaemon, startFakeDaemon } from "./tern-fake-daemon";

type Fields = Record<string, unknown>;

let daemon: FakeDaemon | undefined;
let client: TernSocketClient | undefined;

afterEach(async () => {
	client?.close();
	client = undefined;
	await daemon?.close();
	daemon = undefined;
});

/**
 * A tab on a daemon whose engine answers `dom` reads through `dom`; `kit`
 * stubs the page kit's methods for the helpers that still use it.
 */
async function nativeTab(
	dom: (request: Fields) => unknown,
	kit: Record<string, (args: unknown[]) => unknown> = {},
): Promise<{ fake: FakeDaemon; tab: TernTab }> {
	daemon = await startFakeDaemon(
		(op): FakeAnswer => {
			if (op.op === "dom") return { ok: dom(op) };
			if (op.op === "eval") {
				const args = Array.isArray(op.args) ? op.args : [];
				const stub = typeof args[0] === "string" ? kit[args[0]] : undefined;
				if (!stub) return { error: { kind: "js", message: `Error: kit method ${String(args[0])} not stubbed` } };
				return { ok: { value: { value: stub(Array.isArray(args[1]) ? args[1] : []) } } };
			}
			return { ok: {} };
		},
		{ welcome: { ops: ["dom"] } },
	);
	client = new TernSocketClient({ socketPath: daemon.socketPath });
	await client.connect();
	return { fake: daemon, tab: new TernTab({ client, block: 7, name: "main", viewport: { width: 800, height: 600 } }) };
}

/** Give actions `actionMs` to find an actionable element (the run's budget less its 1 s slack). */
function actionBudget(tab: TernTab, actionMs: number): void {
	tab.setRunContext({
		timeoutMs: actionMs + 1_000,
		deadline: Date.now() + actionMs + 1_000,
		signal: new AbortController().signal,
		session: { cwd: os.tmpdir() },
		output: new RunOutput(),
		screenshots: [],
	});
}

/** The ops sent to the page in order, each named by its op (a `dom` op by its read); event-stream reads left out. */
function trace(fake: FakeDaemon): string[] {
	return fake.requests
		.filter(request => request.op.op !== "events")
		.map(request => String(request.op.op === "dom" ? request.op.read : request.op.op));
}

function domRequests(fake: FakeDaemon, read: string): Fields[] {
	return fake.requests
		.filter(request => request.op.op === "dom" && request.op.read === read)
		.map(request => request.op);
}

function inputEvents(fake: FakeDaemon): unknown[] {
	return fake.requests.filter(request => request.op.op === "input").map(request => request.op.events);
}

const BUTTON = { ref: "e1-5", tag: "button", role: "button", name: "Sign in", states: [], rect: [20, 10, 40, 20] };
const OK = { state: "ok", point: [40, 20], rect: [20, 10, 40, 20], node: BUTTON };
const CLICK_AT_40_20 = [
	{ type: "mouse", action: "move", x: 40, y: 20, button: "left", clicks: 0, mods: [] },
	{ type: "mouse", action: "down", x: 40, y: 20, button: "left", clicks: 1, mods: [] },
	{ type: "mouse", action: "up", x: 40, y: 20, button: "left", clicks: 1, mods: [] },
];

const SNAPSHOT = {
	url: "https://example.test/login",
	title: "Login",
	viewport: { width: 800, height: 600, scale: 2 },
	scroll: { x: 0, y: 120, width: 800, height: 600, scrollWidth: 800, scrollHeight: 2400 },
	truncated: false,
	nodes: [
		{
			ref: "e1-1",
			tag: "form",
			role: "form",
			name: "Login",
			states: [],
			rect: [0, 0, 400, 300],
			children: [
				{
					ref: "e1-2",
					tag: "input",
					role: "checkbox",
					name: "Remember me",
					states: ["checked", "focused"],
					rect: [10, 10, 16, 16],
				},
				{ role: "text", name: "or", rect: [30, 10, 20, 16] },
				{
					ref: "e1-3",
					tag: "input",
					role: "slider",
					name: "Volume",
					value: "40",
					states: ["disabled"],
					rect: [10, 40, 100, 16],
				},
			],
		},
		{
			ref: "e1-4",
			tag: "button",
			role: "button",
			name: "Menu",
			states: ["collapsed", "haspopup", "clickable"],
			rect: [10, 320, 80, 24],
		},
	],
};

describe("TernTab on native DOM reads", () => {
	it("maps a snapshot to an observation and resolves its ids to the nodes' refs", async () => {
		const { fake, tab } = await nativeTab(request => {
			if (request.read === "snapshot") return SNAPSHOT;
			if (request.read === "query") return { nodes: [{ ...BUTTON, ref: request.value }], total: 1 };
			return OK;
		});
		const observation = await tab.observe({ includeAll: true });
		expect(domRequests(fake, "snapshot")).toEqual([{ op: "dom", block: 7, read: "snapshot", includeAll: true }]);
		expect(observation).toEqual({
			url: "https://example.test/login",
			title: "Login",
			viewport: { width: 800, height: 600, deviceScaleFactor: 2 },
			scroll: SNAPSHOT.scroll,
			elements: [
				{ id: 1, role: "form", name: "Login", states: [] },
				{ id: 2, role: "checkbox", name: "Remember me", states: ["checked=true", "focused"] },
				{ id: 3, role: "slider", name: "Volume", value: 40, states: ["disabled"] },
				{ id: 4, role: "button", name: "Menu", states: ["expanded=false", "haspopup"] },
			],
		});
		await (await tab.id(4)).click();
		expect(domRequests(fake, "resolve").map(request => request.ref)).toEqual(["e1-4"]);
		expect(trace(fake)).not.toContain("eval");
	});

	it("refuses an id the last observe did not list, and one whose element left the page", async () => {
		const { tab } = await nativeTab(request =>
			request.read === "snapshot" ? SNAPSHOT : { nodes: request.value === "e1-2" ? [] : [BUTTON], total: 0 },
		);
		await tab.observe();
		await expect(tab.id(9)).rejects.toThrow("Unknown element id 9. Run tab.observe() to refresh the element list.");
		await expect(tab.id(2)).rejects.toThrow("Element id 2 is stale. Run tab.observe() again.");
	});

	it("clicks by resolving the selector natively and pressing the resolved point, with no page script", async () => {
		const { fake, tab } = await nativeTab(request => (request.read === "query" ? { nodes: [BUTTON], total: 1 } : OK));
		await tab.click("text/Sign in");
		expect(trace(fake)).toEqual(["query", "resolve", "input"]);
		expect(fake.requests[0]!.op).toEqual({
			op: "dom",
			block: 7,
			read: "query",
			by: "text",
			value: "Sign in",
			limit: 1,
		});
		expect(fake.requests[1]!.op).toMatchObject({ read: "resolve", ref: "e1-5", action: "click", stable: 2 });
		expect(inputEvents(fake)).toEqual([CLICK_AT_40_20]);
	});

	it("wheels an element that is out of view into it before resolving again", async () => {
		let resolves = 0;
		const { fake, tab } = await nativeTab(request => {
			if (request.read === "query") return { nodes: [BUTTON], total: 1 };
			return resolves++ === 0
				? { state: "offViewport", node: BUTTON, scroll: { at: [400, 300], dx: 0, dy: 900 } }
				: OK;
		});
		await tab.click("#below");
		expect(trace(fake).filter(step => step !== "query")).toEqual(["resolve", "input", "resolve", "input"]);
		expect(inputEvents(fake)).toEqual([
			[{ type: "wheel", x: 400, y: 300, dx: 0, dy: 900, mods: [] }],
			CLICK_AT_40_20,
		]);
	});

	it("spends one re-centring wheel on a covered element, then names what covers it", async () => {
		const { fake, tab } = await nativeTab(request =>
			request.read === "query"
				? { nodes: [BUTTON], total: 1 }
				: {
						state: "covered",
						node: BUTTON,
						point: [40, 20],
						scroll: { at: [400, 300], dx: 0, dy: -80 },
						coveredBy: {
							ref: "e1-8",
							tag: "div",
							role: "dialog",
							name: "Cookies",
							states: [],
							rect: [0, 0, 800, 60],
						},
					},
		);
		actionBudget(tab, 150);
		await expect(tab.click("#under")).rejects.toThrow(
			/tab\.click\("#under"\) timed out after \d+ms: the element is covered by div\[role=dialog\] "Cookies" \(1 match\(es\)\)/,
		);
		expect(inputEvents(fake)).toEqual([[{ type: "wheel", x: 400, y: 300, dx: 0, dy: -80, mods: [] }]]);
	});

	it.each([
		["hidden", "the element is not visible (1 match(es))"],
		["disabled", "the element is disabled (1 match(es))"],
		["notEditable", "the element is not editable (1 match(es))"],
		["unstable", "the element keeps moving (1 match(es))"],
		["offViewport", "the element is outside the viewport (1 match(es))"],
		["detached", "no element matches (wrong page or selector?) (0 match(es))"],
	])("fails an action whose element stays %s without sending input", async (state, why) => {
		const { fake, tab } = await nativeTab(request =>
			request.read === "query" ? { nodes: [BUTTON], total: 1 } : { state, node: BUTTON },
		);
		actionBudget(tab, 150);
		await expect(tab.click("#x")).rejects.toThrow(why);
		expect(trace(fake)).not.toContain("input");
	});

	it("waits natively and hands out a handle holding the matched node's ref", async () => {
		const { fake, tab } = await nativeTab(request =>
			request.read === "wait" ? { matched: true, nodes: [{ ...BUTTON, ref: "e1-9" }] } : OK,
		);
		const handle = await tab.waitFor("#late", { timeout: 4_000 });
		expect(domRequests(fake, "wait")).toEqual([
			{ op: "dom", block: 7, read: "wait", for: { by: "css", value: "#late" }, state: "visible", timeout: 4_000 },
		]);
		await handle.click();
		// The handle names the node itself: the selector is not resolved again.
		expect(trace(fake)).toEqual(["wait", "resolve", "input"]);
		expect(domRequests(fake, "resolve")[0]!.ref).toBe("e1-9");
	});

	it("rejects a wait the engine reports as timed out", async () => {
		const { tab } = await nativeTab(() => ({ matched: false }));
		await expect(tab.waitFor("#never", { timeout: 50 })).rejects.toThrow(
			'tab.waitFor("#never") timed out after 50ms',
		);
		await expect(tab.waitForSelector("#gone", { hidden: true, timeout: 50 })).rejects.toThrow(
			'tab.waitForSelector("#gone") timed out after 50ms',
		);
	});

	it("fills by clicking the resolved point, selecting all through the edit op, then inserting text", async () => {
		const input = { ref: "e1-6", tag: "input", role: "textbox", states: ["editable"], rect: [20, 10, 40, 20] };
		const { fake, tab } = await nativeTab(request =>
			request.read === "query"
				? { nodes: [{ ...input, attributes: { type: "email" } }], total: 1 }
				: { ...OK, node: input },
		);
		await tab.fill("#email", "a@b.test");
		expect(domRequests(fake, "resolve")[0]).toMatchObject({ ref: "e1-6", action: "type" });
		const actions = fake.requests
			.filter(request => request.op.op !== "dom" && request.op.op !== "events")
			.map(request => request.op);
		expect(actions).toEqual([
			{ op: "input", block: 7, events: CLICK_AT_40_20 },
			{ op: "edit", block: 7, action: "selectAll" },
			{ op: "input", block: 7, events: [{ type: "text", text: "a@b.test" }] },
		]);
	});

	it("reads text trimmed and inner HTML out of the node's outer HTML", async () => {
		const { fake, tab } = await nativeTab(() => ({
			nodes: [{ ...BUTTON, tag: "div", text: "  hi\n", html: '<div title="a>b" hidden><b>hi</b></div>' }],
			total: 1,
		}));
		expect(await tab.text("#a")).toBe("hi");
		expect(await tab.html("#a")).toBe("<b>hi</b>");
		expect(domRequests(fake, "query").map(request => request.include)).toEqual([["text"], ["html"]]);
	});

	it("surfaces the engine's own message for a read it refuses", async () => {
		const { tab } = await nativeTab(() => ({
			error: { kind: "invalid", message: "':bad(' is not a valid selector" },
		}));
		await expect(tab.count(":bad(")).rejects.toThrow("':bad(' is not a valid selector");
	});

	it("marks the engine's node for a helper only the kit provides, and unmarks every candidate", async () => {
		const select = { ref: "e1-2", tag: "select", role: "combobox", states: [], rect: [10, 10, 80, 20] };
		const kitCalls: Array<[string, unknown[]]> = [];
		let marked = false;
		const { tab } = await nativeTab(
			request => {
				if (request.read === "snapshot") return { ...SNAPSHOT, nodes: [select] };
				if (request.read === "resolve") return { ...OK, node: select };
				const attributes: Record<string, string> = { name: "state", class: 'a "b"' };
				if (marked) attributes["data-omp-tern-handle"] = "other t2";
				return { nodes: [{ ...select, attributes }], total: 1 };
			},
			{
				markAll: args => {
					kitCalls.push(["markAll", args]);
					marked = true;
					return ["t1", "t2"];
				},
				unmark: args => {
					kitCalls.push(["unmark", args]);
					return null;
				},
				select: args => {
					kitCalls.push(["select", args]);
					return ["ca"];
				},
			},
		);
		await tab.observe();
		expect(await (await tab.id(1)).select("ca")).toEqual(["ca"]);
		expect(kitCalls).toEqual([
			["markAll", [{ engine: "pierce", query: 'select[name="state"][class="a \\"b\\""]' }]],
			["unmark", [["t1"]]],
			["select", [{ engine: "handle", token: "t2" }, ["ca"]]],
			["unmark", ["t2"]],
		]);
	});
});

describe("domQueryFor", () => {
	it.each<[string, DomQuery]>([
		["pierce/.card", { by: "css", value: ".card" }],
		["xpath///main//a", { by: "xpath", value: "//main//a" }],
		["aria/Save changes", { by: "role", name: "Save changes", exact: true }],
		['aria/Save[role="button"]', { by: "role", value: "button", name: "Save", exact: true }],
		['role/button[name="Save" exact]', { by: "role", value: "button", name: "save", exact: true }],
		["role/link", { by: "role", value: "link" }],
		["label/Email", { by: "label", value: "Email" }],
		["placeholder/Search", { by: "attribute", attribute: "placeholder", value: "Search" }],
		["testid/submit", { by: "attribute", attribute: "data-testid", value: "submit", exact: true }],
	])("maps %s to the native query", (selector, query) => {
		const parsed = parseTernSelector(selector) as Exclude<TernSelector, { engine: "id" | "ariaRef" }>;
		expect(domQueryFor(parsed)).toEqual(query);
	});
});
