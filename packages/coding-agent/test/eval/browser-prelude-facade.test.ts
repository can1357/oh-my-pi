import { afterAll, describe, expect, it } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
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
			"browser.enabled": true,
			"browser.headless": true,
			"browser.relay": false,
			"browser.cmux": false,
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
			__omp_display__: (value: unknown) => displays.push(value),
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
			].join("\n"),
			{ cwd: process.cwd(), sessionId: `browser-facade-js-${crypto.randomUUID()}`, session },
		);

		expect(result.exitCode).toBe(0);
		expect(result.output.trim().split("\n")).toEqual([
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
		);

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
				__omp_display__: (value: unknown) => displayed.push(value),
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
					await runInContext("__e2eTab.run('display(\"worker display text\"); return { value: 3 };')", context),
				).toEqual({ value: 3 });
				expect(displayed).toContain("worker display text");

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
