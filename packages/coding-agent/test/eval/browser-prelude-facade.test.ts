import { afterAll, describe, expect, it } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import type { ObservationEntry } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { chromiumAvailable } from "../tools/chromium-probe";

interface FacadeResponse {
	text: string;
	details: Record<string, unknown>;
}

function field(value: unknown, name: string): unknown {
	return value !== null && typeof value === "object" ? Reflect.get(value, name) : undefined;
}

function firstChainMethod(parameters: unknown): string | undefined {
	const chain = field(parameters, "chain");
	if (!Array.isArray(chain) || chain.length === 0) return undefined;
	const method = field(chain[0], "method");
	return typeof method === "string" ? method : undefined;
}

function responseFor(parameters: unknown): FacadeResponse {
	const action = field(parameters, "action");
	if (action === "open") {
		const requestedName = field(parameters, "name");
		return {
			text: "opened display text",
			details: { name: typeof requestedName === "string" ? requestedName : "main" },
		};
	}
	if (action === "run") {
		return {
			text: "",
			details: { value: typeof field(parameters, "fn") === "string" ? 8 : { ok: true } },
		};
	}
	if (action === "call") {
		const method = firstChainMethod(parameters);
		const values: Record<string, unknown> = {
			title: "page title",
			observe: { elements: [{ id: 5, role: "button", name: "Save" }] },
			fill: true,
			evaluate: 9,
			waitFor: true,
			waitForSelector: true,
			id: true,
			ref: true,
			console: { entries: [{ seq: 1, type: "console", level: "warn", text: "low disk" }], nextSeq: 2, dropped: 0 },
			errors: { entries: [], nextSeq: 2, dropped: 0 },
		};
		return { text: "", details: { value: method === undefined ? undefined : values[method] } };
	}
	return { text: "", details: { name: "main" } };
}

function makeSession(getPreludes?: () => readonly EvalPreludeDefinition[]): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({
			// Managed Chromium, whether or not omp's WebKit engine is installed on this machine.
			"browser.webkit": false,
			"browser.enabled": true,
			"browser.headless": true,
			"browser.relay": false,
			"browser.cmux": false,
			"browser.tern": false,
			"tools.outputMaxColumns": 256,
		}),
		...(getPreludes === undefined ? {} : { getEvalPreludes: getPreludes }),
	};
}

function recorderDefinition(session: ToolSession, calls: unknown[]): EvalPreludeDefinition {
	const shipped = createBrowserPrelude(session);
	return {
		...shipped,
		async invoke(parameters) {
			calls.push(parameters);
			const response = responseFor(parameters);
			return {
				content: response.text.length > 0 ? [{ type: "text", text: response.text }] : [],
				details: response.details,
			};
		},
	};
}

function withoutFirstCallGuide<T extends { output: string }>(result: T): T {
	const guide = createBrowserPrelude(makeSession()).firstCallDocumentation?.trim();
	if (!guide) throw new Error("Expected browser first-call guide");
	expect(result.output).toContain(guide);
	const parts = result.output.split(/<eval-guide name="browser">[\s\S]*?<\/eval-guide>/);
	expect(parts).toHaveLength(2);
	return { ...result, output: `${parts[0].trimEnd()}\n${parts[1].trimStart()}` };
}

function recordingFacade() {
	const calls: unknown[] = [];
	const context = createContext({
		__omp_log__: () => {},
		__omp_prelude__: async (_name: string, parameters: unknown) => {
			calls.push(parameters);
			return responseFor(parameters);
		},
	});
	runInContext(createBrowserPrelude(makeSession()).javascript, context);
	return { calls, context };
}

afterAll(async () => {
	await Promise.all([disposeAllVmContexts(), disposeAllKernelSessions()]);
});

describe("browser JavaScript facade", () => {
	it("builds handles, chains, markers, and direct values against the shipped VM prelude", async () => {
		const calls: unknown[] = [];
		const displays: unknown[] = [];
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = createContext({
			__omp_log__: (_level: string, value: unknown) => displays.push(value),
			__omp_prelude__: async (name: string, parameters: unknown) => {
				expect(name).toBe("browser");
				calls.push(parameters);
				return responseFor(parameters);
			},
		});
		runInContext(prelude.javascript, context);

		expect(
			await runInContext(
				'(async () => { globalThis.tab = await browser.open({ name: "docs", url: "https://example.test", action: "close" }); return tab.name; })()',
				context,
			),
		).toBe("docs");
		expect(await runInContext("tab.title()", context)).toBe("page title");
		expect(await runInContext("tab.observe()", context)).toEqual({
			elements: [{ id: 5, role: "button", name: "Save" }],
		});
		expect(await runInContext('tab.id(5).fill("Ada", undefined)', context)).toBe(true);
		expect(await runInContext('tab.evaluate(value => value.length, "save", /save/i, undefined)', context)).toBe(9);
		expect(await runInContext("tab.run((_scope, count) => count + 1, { args: [7], timeout: 2 })", context)).toBe(8);
		expect(await runInContext('tab.run("return { ok: true };")', context)).toEqual({ ok: true });
		expect(await runInContext('browser.tab("other").title()', context)).toBe("page title");
		await runInContext('browser.close({ name: "docs", action: "run" })', context);

		expect(displays).toEqual(["opened display text"]);
		expect(runInContext("browser.run", context)).toBeUndefined();
		expect(
			runInContext("Object.isFrozen(browser) && Object.isFrozen(tab) && Object.isFrozen(tab.id(5))", context),
		).toBe(true);
		expect(() => runInContext('browser.tab("")', context)).toThrow("browser.tab() expects a tab name");
		await expect(runInContext("browser.open(null)", context)).rejects.toThrow(
			"browser.open() expects an options object",
		);
		await expect(runInContext("tab.run({ code: 'return 1' })", context)).rejects.toThrow(
			"tab.run() expects a function or code string",
		);
		await expect(runInContext("tab.run(Math.max)", context)).rejects.toThrow(
			"tab.run() cannot serialize a native or bound function; pass an arrow or function expression",
		);
		expect(() => runInContext("tab.evaluate(Math.max)", context)).toThrow(
			"tab helper argument cannot serialize a native or bound function; pass an arrow or function expression",
		);

		expect(calls).toEqual([
			{ action: "open", name: "docs", url: "https://example.test" },
			{ action: "call", name: "docs", chain: [{ method: "title", args: [] }] },
			{ action: "call", name: "docs", chain: [{ method: "observe", args: [] }] },
			{
				action: "call",
				name: "docs",
				chain: [
					{ method: "id", args: [5] },
					{ method: "fill", args: ["Ada"] },
				],
			},
			{
				action: "call",
				name: "docs",
				chain: [
					{
						method: "evaluate",
						args: [{ __omp_fn: "value => value.length" }, "save", { __omp_re: { source: "save", flags: "i" } }],
					},
				],
			},
			{
				action: "run",
				name: "docs",
				fn: "(_scope, count) => count + 1",
				args: [7],
				timeout: 2,
			},
			{ action: "run", name: "docs", code: "return { ok: true };" },
			{ action: "call", name: "other", chain: [{ method: "title", args: [] }] },
			{ action: "close", name: "docs" },
		]);
	});

	it("refuses run args it would drop before anything runs, and still runs empty or null args", async () => {
		const { calls, context } = recordingFacade();

		await expect(
			runInContext(
				'browser.tab("docs").run(async (_scope, url) => url, { args: { url: "https://example.test" } })',
				context,
			),
		).rejects.toThrow("tab.run() args must be an array of the function's arguments after its scope");
		await expect(runInContext('browser.tab("docs").run("return 1;", { args: [1] })', context)).rejects.toThrow(
			"tab.run() passes args only to a function; a code string receives none",
		);
		expect(calls).toEqual([]);

		expect(await runInContext('browser.tab("docs").run("return 1;", { args: [] })', context)).toEqual({ ok: true });
		expect(await runInContext('browser.tab("docs").run(async () => 1, { args: null })', context)).toBe(8);
		expect(calls).toEqual([
			{ name: "docs", code: "return 1;", action: "run" },
			{ name: "docs", fn: "async () => 1", args: [], action: "run" },
		]);
	});

	it("tells tab.run given an args array to wrap it in { args }", async () => {
		const { calls, context } = recordingFacade();

		await expect(
			runInContext('browser.tab("docs").run(async (_scope, url) => url, ["https://example.test"])', context),
		).rejects.toThrow("pass the function's arguments as { args: [...] }");
		for (const call of ['run(async () => 1, "fast")', 'run("return 1;", [1])']) {
			const message = await runInContext(`browser.tab("docs").${call}`, context).catch(
				(error: Error) => error.message,
			);
			expect(message).toContain("tab.run() expects an options object");
			expect(message).not.toContain("{ args");
		}
		expect(calls).toEqual([]);
	});

	it("tells browser.open given a URL string to pass { url, name }", async () => {
		const { calls, context } = recordingFacade();

		await expect(
			runInContext('browser.open("https://example.test", { viewport: { width: 1280, height: 900 } })', context),
		).rejects.toThrow("browser.open({ url, name })");
		const message = await runInContext("browser.open(42)", context).catch((error: Error) => error.message);
		expect(message).toContain("browser.open() expects an options object");
		expect(message).not.toContain("{ url");
		expect(calls).toEqual([]);
	});

	it("tells console() and errors() callers that treat the result as an array to read .entries", async () => {
		const { context } = recordingFacade();
		runInContext('globalThis.tab = browser.tab("docs");', context);

		for (const use of [
			"(await tab.console()).slice(-20)",
			"(await tab.console()).pop()",
			"(await tab.console()).length",
			"[...(await tab.console())]",
		]) {
			await expect(runInContext(`(async () => ${use})()`, context)).rejects.toThrow(
				"tab.console() returns { entries, nextSeq, dropped }, not an array",
			);
		}
		await expect(
			runInContext("(async () => (await tab.console()).map(entry => entry.text))()", context),
		).rejects.toThrow("read its entries: (await tab.console()).entries.map()");
		await expect(runInContext("(async () => (await tab.errors()).slice(0, 5))()", context)).rejects.toThrow(
			"tab.errors() returns { entries, nextSeq, dropped }, not an array",
		);
		expect(
			await runInContext("(async () => (await tab.console()).entries.map(entry => entry.text))()", context),
		).toEqual(["low disk"]);
		// The members it adds stay out of JSON: the result serialises as the host sent it.
		expect(JSON.parse(await runInContext("(async () => JSON.stringify(await tab.console()))()", context))).toEqual({
			entries: [{ seq: 1, type: "console", level: "warn", text: "low disk" }],
			nextSeq: 2,
			dropped: 0,
		});
	});
});

describe("browser facade in real Eval runtimes", () => {
	it("unwraps values, displays host text, and preserves JavaScript helper chains", async () => {
		const calls: unknown[] = [];
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session = makeSession(() => definitions);
		definitions = [recorderDefinition(session, calls)];
		const result = await executeJs(
			[
				'const tab = await browser.open({ name: "real-js" });',
				"print(await tab.title());",
				"print(JSON.stringify(await tab.observe()));",
				'print(await tab.id(5).fill("Grace"));',
				'print(await tab.evaluate(value => value.length, "abc", /a/i));',
				"print(await tab.run((_scope, count) => count + 1, { args: [7] }));",
				"print(JSON.stringify(await tab.console()));",
			].join("\n"),
			{ cwd: process.cwd(), sessionId: `browser-facade-js-${crypto.randomUUID()}`, session },
		).then(withoutFirstCallGuide);

		expect(result.exitCode).toBe(0);
		const output = result.output.trim().split("\n");
		const consoleResult = JSON.parse(output.pop() ?? "");
		expect(consoleResult).toEqual({
			entries: [{ seq: 1, type: "console", level: "warn", text: "low disk" }],
			nextSeq: 2,
			dropped: 0,
		});
		expect(output).toEqual([
			"opened display text",
			"page title",
			'{"elements":[{"id":5,"role":"button","name":"Save"}]}',
			"true",
			"9",
			"8",
		]);
		expect(calls).toContainEqual({
			action: "call",
			name: "real-js",
			chain: [
				{
					method: "evaluate",
					args: [{ __omp_fn: "value => value.length" }, "abc", { __omp_re: { source: "a", flags: "i" } }],
				},
			],
		});
		expect(calls).toContainEqual({
			action: "call",
			name: "real-js",
			chain: [
				{ method: "id", args: [5] },
				{ method: "fill", args: ["Grace"] },
			],
		});
	});

	it("prints every observed element, one line each, and keeps the observation's data for code", async () => {
		const elements: ObservationEntry[] = Array.from({ length: 150 }, (_, index) => ({
			id: index + 1,
			role: "button",
			name: `Item ${index + 1}`,
			value: undefined,
			description: undefined,
			keyshortcuts: undefined,
			states: [],
		}));
		elements[1] = {
			id: 2,
			role: "textbox",
			name: 'Two\nlines "quoted"',
			value: "Ada",
			description: "Full name",
			keyshortcuts: "Alt+N",
			states: ["focused", "required"],
		};
		elements[2] = { ...elements[2], value: 0 };
		elements[3] = { ...elements[3], role: "menu item" };
		const observation = {
			url: "https://example.test/list",
			title: "List",
			viewport: { width: 800, height: 600 },
			scroll: { x: 0, y: 40, width: 800, height: 600, scrollWidth: 800, scrollHeight: 4000 },
			elements,
		};
		let runValue: unknown = observation;
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session = makeSession(() => definitions);
		const shipped = createBrowserPrelude(session);
		definitions = [
			{
				...shipped,
				async invoke(parameters) {
					const action = field(parameters, "action");
					if (action === "open") return { content: [], details: { name: "many" } };
					return { content: [], details: { value: structuredClone(action === "run" ? runValue : observation) } };
				},
			},
		];
		const sessionId = `browser-facade-observe-${crypto.randomUUID()}`;
		const run = async (code: string) => {
			const result = await executeJs(code, { cwd: process.cwd(), sessionId, session });
			expect(result.exitCode).toBe(0);
			return result.output.trimEnd();
		};
		await run('globalThis.tab = await browser.open({ name: "many" });');

		const lines = [
			'url: "https://example.test/list"',
			'title: "List"',
			"viewport: { width: 800, height: 600 }",
			"scroll: { x: 0, y: 40, width: 800, height: 600, scrollWidth: 800, scrollHeight: 4000 }",
			"elements (150; tab.id(n) acts on [n]):",
			'[1] button "Item 1"',
			'[2] textbox "Two\\nlines \\"quoted\\"" value="Ada" description="Full name" keyshortcuts="Alt+N" focused required',
			'[3] button "Item 3" value=0',
			'[4] "menu item" "Item 4"',
			...elements.slice(4).map(element => `[${element.id}] button "${element.name}"`),
		];
		expect((await run("print(await tab.observe());")).split("\n")).toEqual(lines);
		expect((await run("await tab.observe()")).split("\n")).toEqual(lines);
		expect((await run("print((await tab.observe()).elements);")).split("\n")).toEqual(lines.slice(5));
		const single = await executeJs("print(await tab.observe());", { cwd: process.cwd(), sessionId, session });
		expect(single.output).toBe(`${lines.join("\n")}\n`);
		expect(await run("print(await tab.run(async ({ tab }) => tab.observe()));")).toBe(lines.join("\n"));
		expect((await run('print(await tab.observe(), "done");')).split("\n")).toEqual([...lines, " done"]);
		expect((await run('print((await tab.observe()).elements, "done");')).split("\n")).toEqual([
			...lines.slice(5),
			" done",
		]);
		const expectedJson = JSON.stringify(JSON.stringify(observation));
		expect(
			JSON.parse(
				await run(
					`const o = await tab.observe(); print(JSON.stringify({ same: JSON.stringify(o) === ${expectedJson}, keys: Object.keys(o), element: Object.keys(o.elements[0]), length: o.elements.length }));`,
				),
			),
		).toEqual({
			same: true,
			keys: ["url", "title", "viewport", "scroll", "elements"],
			element: ["id", "role", "name", "value", "description", "keyshortcuts", "states"],
			length: 150,
		});
		const nested = ["{", "  o: Observation {", ...lines.map(line => `    ${line}`), "  },", "  n: 1", "}"];
		expect((await run("print({ o: await tab.observe(), n: 1 });")).split("\n")).toEqual(nested);
		expect(
			(
				await run(
					'print(require("node:util").inspect({ o: await tab.observe(), n: 1 }, { depth: null, breakLength: 120 }));',
				)
			).split("\n"),
		).toEqual(nested);
		expect((await run("print([(await tab.observe()).elements]);")).split("\n")).toEqual([
			"[",
			"  [",
			...lines.slice(5).map(line => `    ${line}`),
			"  ]",
			"]",
		]);
		expect(await run("const p = await tab.observe(); delete p.elements; print(p);")).toContain(
			"url: 'https://example.test/list'",
		);
		runValue = { elements: [{ href: "https://example.test/link" }], count: 1 };
		const ordinary = await run(
			'const value = await tab.run(() => ({ elements: [], count: 1 })); print(value); print(Object.hasOwn(value, Symbol.for("nodejs.util.inspect.custom")), Object.hasOwn(value.elements, Symbol.for("nodejs.util.inspect.custom")));',
		);
		expect(ordinary).toContain("href:");
		expect(ordinary).not.toContain("tab.id");
		expect(ordinary).toEndWith("false false");
	});

	const ran = '{ enumerable: true, configurable: true, get() { globalThis.ran++; throw new Error("ran"); } }';
	it.each([
		["annotation", "o.elements[0].extra = 1n", "extra: 1n"],
		["cycle", "o.self = o", "[Circular"],
		["getter annotation", `Object.defineProperty(o, "extra", ${ran})`, "extra: [Getter]"],
		["getter field", `Object.defineProperty(o.elements[0], "name", ${ran})`, "name: [Getter]"],
		["getter elements", `Object.defineProperty(o, "elements", ${ran})`, "elements: [Getter]"],
		["Symbol state", 'o.elements[0].states.push(Symbol("busy"))', "Symbol(busy)"],
		["getter slot", `Object.defineProperty(o.elements, 0, ${ran})`, "[Getter]"],
		[
			"Proxy element",
			"o.elements[0] = new Proxy({}, { ownKeys() { globalThis.ran++; throw new Error('ran'); } })",
			"id: 150",
		],
		["assigned field", 'o.elements[0].name = "Renamed"', "name: 'Renamed'"],
		[
			"swapped prototype",
			"Object.setPrototypeOf(o.elements[0].states, { join() { globalThis.ran++; throw new Error('ran'); } })",
			"id: 150",
		],
		[
			"edited prototype",
			"Object.getPrototypeOf(o.elements[0].states).join = () => { globalThis.ran++; throw new Error('ran'); }",
			"id: 150",
		],
		["hidden field", 'Object.defineProperty(o.elements[0], "id", { enumerable: false })', "id: 150"],
	])(
		"prints an edited observation through plain inspect, whole, running none of its code: %s",
		async (_name, edit, expected) => {
			let definitions: readonly EvalPreludeDefinition[] = [];
			const session = makeSession(() => definitions);
			const elements = Array.from({ length: 150 }, (_, index) => ({ id: index + 1, role: "button", states: [] }));
			definitions = [
				{
					...createBrowserPrelude(session),
					invoke: async parameters => ({
						content: [],
						details:
							field(parameters, "action") === "open" ? { name: "edited" } : { value: { url: "u", elements } },
					}),
				},
			];
			// util.inspect is the call under test; `print` adds its own JSON view, which reads the value separately.
			const result = await executeJs(
				`globalThis.ran = 0; const { inspect } = require("node:util"); const tab = await browser.open({ name: "edited" }); const o = await tab.observe(); const prototype = Object.getPrototypeOf(o.elements[0].states); const join = Object.getOwnPropertyDescriptor(prototype, "join"); let text; try { ${edit}; text = inspect(o, { depth: 6, breakLength: 120 }); } finally { Object.defineProperty(prototype, "join", join); } print(text); print(inspect(Object.getOwnPropertyDescriptor(o, "elements").value ?? null, { depth: 6 })); print("ids:", text.match(/\\bid: \\d+/g)?.length ?? 0, "ran:", globalThis.ran);`,
				{ cwd: process.cwd(), sessionId: `browser-facade-edited-${crypto.randomUUID()}`, session },
			);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain(expected);
			expect(result.output).not.toContain("more items");
			expect(result.output).toMatch(_name === "getter elements" ? /ids: 0 ran: 0/ : /ids: 1(49|50) ran: 0/);
		},
	);

	it("unwraps values, prints host text, and preserves Python helper chains in a real kernel", async () => {
		const calls: unknown[] = [];
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session = makeSession(() => definitions);
		definitions = [recorderDefinition(session, calls)];
		const result = await executePython(
			[
				"import re",
				'tab = await browser.open(name="real-py")',
				"print(await tab.title())",
				'print((await tab.observe())["elements"][0]["role"])',
				'print(await tab.id(5).fill("Ada"))',
				'print(await tab.evaluate("abc", matcher=re.compile("a", re.I)))',
				'print(await tab.run("return 42;", timeout=2))',
				"await tab.close()",
			].join("\n"),
			{
				cwd: process.cwd(),
				sessionId: `browser-facade-py-${crypto.randomUUID()}`,
				toolSession: session,
				kernelMode: "per-call",
			},
		).then(withoutFirstCallGuide);

		expect(result.exitCode).toBe(0);
		expect(result.output.trim().split("\n")).toEqual([
			"opened display text",
			"page title",
			"button",
			"True",
			"9",
			"{'ok': True}",
		]);
		expect(calls).toContainEqual({
			action: "call",
			name: "real-py",
			chain: [
				{
					method: "evaluate",
					args: ["abc", { matcher: { __omp_re: { source: "a", flags: "i" } } }],
				},
			],
		});
		expect(calls).toContainEqual({
			action: "call",
			name: "real-py",
			chain: [
				{ method: "id", args: [5] },
				{ method: "fill", args: ["Ada"] },
			],
		});
		expect(calls).toContainEqual({ action: "run", name: "real-py", code: "return 42;", timeout: 2 });
	});

	it("keeps text a cell enters out of the status events the session keeps", async () => {
		const calls: unknown[] = [];
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session = makeSession(() => definitions);
		definitions = [recorderDefinition(session, calls)];
		const secret = "sentinel-password-4f9Q";
		const pin = 482913;
		const result = await executeJs(
			[
				'const tab = await browser.open({ name: "status-js" });',
				`const secret = ${JSON.stringify(secret)};`,
				'await tab.fill("#password", secret);',
				`await tab.type("#otp", ${pin}, { delay: 5 });`,
				"await tab.id(5).fill(secret);",
				'await tab.frame("#login").fill("#password", secret);',
				"await tab.clipboardWrite(secret);",
				"await tab.handleDialog({ accept: true, text: secret });",
				'await tab.click("#submit");',
			].join("\n"),
			{
				cwd: process.cwd(),
				sessionId: `browser-status-js-${crypto.randomUUID()}`,
				session,
			},
		);

		expect(result.exitCode).toBe(0);
		const details = (result.displayOutputs ?? []).flatMap(output =>
			output.type === "status" ? [String(field(output.event, "detail"))] : [],
		);
		expect(details.join("\n")).not.toContain(secret);
		expect(details.join("\n")).not.toContain(String(pin));
		expect(details).toContain('status-js.fill("#password", <hidden>)');
		expect(details).toContain('status-js.click("#submit")');

		// Python passes keyword arguments as a trailing object.
		const status = createBrowserPrelude(session).status;
		expect(
			status?.(
				{ action: "call", name: "py", chain: [{ method: "fill", args: ["#password", { value: secret }] }] },
				{ content: [] },
			),
		).toBe('py.fill("#password", <hidden>)');
	});

	it("forwards Python open timeout and persist side by side (issue #8246 review)", async () => {
		const calls: unknown[] = [];
		let definitions: readonly EvalPreludeDefinition[] = [];
		const session = makeSession(() => definitions);
		definitions = [recorderDefinition(session, calls)];
		const result = await executePython(
			[
				'tab = await browser.open(name="py-opts", timeout=7, persist=True)',
				'plain = await browser.open(name="py-plain")',
			].join("\n"),
			{
				cwd: process.cwd(),
				sessionId: `browser-facade-py-open-${crypto.randomUUID()}`,
				toolSession: session,
				kernelMode: "per-call",
			},
		);

		expect(result.exitCode).toBe(0);
		expect(calls).toContainEqual({ action: "open", name: "py-opts", timeout: 7, persist: true });
		expect(calls).toContainEqual({ action: "open", name: "py-plain" });
	});
});

const CHROMIUM_AVAILABLE = await chromiumAvailable();

describe("browser facade Chromium helper E2E", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"drives a real page through direct helpers, handles, waits, and function and code runs",
		async () => {
			const name = `facade-e2e-${crypto.randomUUID()}`;
			const session = makeSession();
			const prelude = createBrowserPrelude(session);
			const displayed: unknown[] = [];
			const html = [
				"<!doctype html>",
				"<title>Ready</title>",
				'<button id="go" onclick="document.title = \'Clicked\'">Go</button>',
				'<input aria-label="Name">',
			].join("");
			const context = createContext({
				__name__: name,
				__url__: `data:text/html,${encodeURIComponent(html)}`,
				__omp_log__: (_level: string, value: unknown) => displayed.push(value),
				__omp_prelude__: async (preludeName: string, parameters: unknown) => {
					expect(preludeName).toBe("browser");
					const result = await prelude.invoke(parameters, {
						session,
						toolCallId: `browser-e2e-${crypto.randomUUID()}`,
					});
					return {
						text: result.content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join("\n"),
						details: result.details,
					};
				},
			});
			runInContext(prelude.javascript, context);

			try {
				await runInContext(
					"(async () => { globalThis.__e2eTab = await browser.open({ name: __name__, url: __url__ }); })()",
					context,
				);
				await runInContext('__e2eTab.click("text/Go")', context);
				const title = await runInContext("__e2eTab.title()", context);
				expect(typeof title).toBe("string");
				expect(title).toBe("Clicked");
				expect(await runInContext("__e2eTab.run((_scope, value) => value + 1, { args: [7] })", context)).toBe(8);
				expect(
					await runInContext("__e2eTab.run('print(\"worker print text\"); return { value: 3 };')", context),
				).toEqual({ value: 3 });
				expect(displayed).toContain("worker print text");

				const observation = await runInContext("__e2eTab.observe()", context);
				expect(field(observation, "elements")).toBeArray();
				const buttonId = await runInContext(
					'(async () => { const observation = await __e2eTab.observe(); return observation.elements.find(element => element.name === "Go").id; })()',
					context,
				);
				expect(typeof buttonId).toBe("number");
				expect(await runInContext(`__e2eTab.id(${String(buttonId)}).isVisible()`, context)).toBe(true);
				expect(
					await runInContext(
						`__e2eTab.id(${String(buttonId)}).evaluate("element => element.textContent")`,
						context,
					),
				).toBe("Go");
				expect(await runInContext('__e2eTab.waitFor("text/Go")', context)).toBe(true);
			} finally {
				await prelude
					.invoke({ action: "close", name }, { session, toolCallId: `browser-e2e-cleanup-${crypto.randomUUID()}` })
					.catch(() => undefined);
			}
		},
		30_000,
	);
});
