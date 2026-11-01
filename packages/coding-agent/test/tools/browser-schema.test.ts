import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { resolveWaitTimeout } from "@oh-my-pi/pi-coding-agent/tools/browser/op-timeouts";
import { cfgBrowserEnabled } from "@oh-my-pi/pi-coding-agent/tools/browser/settings";
import * as supervisor from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";

afterEach(() => {
	vi.restoreAllMocks();
});

function makeSession(settings = Settings.isolated({ "browser.enabled": true })): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

describe("browser prelude", () => {
	it("tracks the live browser capability setting", () => {
		const settings = Settings.isolated();
		cfgBrowserEnabled.set(settings, false);
		const prelude = createBrowserPrelude(makeSession(settings));

		expect(prelude.enabled?.()).toBe(false);
		cfgBrowserEnabled.set(settings, true);
		expect(prelude.enabled?.()).toBe(true);
	});

	it("validates host arguments before dispatch", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-invalid-arguments" };

		await expect(prelude.invoke({ action: "run", name: "x", code: 42 }, context)).rejects.toThrow(
			/browser received invalid arguments/,
		);
		await expect(prelude.invoke({ action: "run", name: "x" }, context)).rejects.toThrow(
			"Action 'run' requires exactly one of 'code' or 'fn'.",
		);
		await expect(
			prelude.invoke({ action: "run", name: "x", code: "return 1", fn: "() => 1" }, context),
		).rejects.toThrow("Action 'run' requires exactly one of 'code' or 'fn'.");
		await expect(prelude.invoke({ action: "run", name: "x", code: "   " }, context)).rejects.toThrow(
			"Action 'run' requires exactly one of 'code' or 'fn'.",
		);
		await expect(prelude.invoke({ action: "call", name: "x", chain: [] }, context)).rejects.toThrow(
			"Action 'call' requires a non-empty 'chain'.",
		);
		for (const invalid of [
			{ init_scripts: ["valid", 1] },
			{ downloads: false },
			{ user_agent: 1 },
			{ ignore_https_errors: "yes" },
			{ allow_file_access: 1 },
			{ headed: "yes" },
		]) {
			await expect(prelude.invoke({ action: "open", ...invalid }, context)).rejects.toThrow(
				/browser received invalid arguments/,
			);
		}
	});

	it("closes through the real host for an absent named tab", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const result = await prelude.invoke(
			{ action: "close", name: `missing-${crypto.randomUUID()}` },
			{ session, toolCallId: "browser-close-missing" },
		);

		expect(result.content).toEqual([
			{
				type: "text",
				text: expect.stringMatching(/^No tab named "missing-/),
			},
		]);
	});

	it("gives a direct wait helper the budget its explicit timeout needs (#17617)", async () => {
		const budgets: number[] = [];
		spyOn(supervisor, "runInTab").mockImplementation(async (_name, opts) => {
			budgets.push(opts.timeoutMs);
			return { displays: [], returnValue: true, screenshots: [] };
		});
		const effectiveWait = async (parameters: Record<string, unknown>, waitTimeout: number): Promise<number> => {
			const session = makeSession();
			await createBrowserPrelude(session).invoke(
				{ action: "call", name: "docs", ...parameters },
				{ session, toolCallId: "browser-call-budget" },
			);
			return resolveWaitTimeout(budgets.at(-1)!, waitTimeout);
		};
		const waitChain = [{ method: "waitForSelector", args: ["#closed", { timeout: 50_000 }] }];

		// Eval's `tab.waitForSelector(sel, { timeout: 50000 })` used to stop at 29000ms.
		expect(await effectiveWait({ chain: waitChain }, 50_000)).toBe(50_000);
	});

	it("preserves an infinite wait's bounded timeout through the rendered browser call", async () => {
		let actualWaitMs: number | undefined;
		spyOn(supervisor, "runInTab").mockImplementation(async (_name, opts) => {
			const waitForSelector = (_selector: string, options: { timeout: number }): object => {
				actualWaitMs = resolveWaitTimeout(opts.timeoutMs, options.timeout);
				return {};
			};
			const tab = { waitForSelector };
			const returnValue = await runInContext(`(async () => { ${opts.code} })()`, createContext({ tab }));
			return { displays: [], returnValue, screenshots: [] };
		});
		const session = makeSession();
		const call = async (chain: unknown[]): Promise<void> => {
			await createBrowserPrelude(session).invoke(
				{ action: "call", name: "docs", chain },
				{ session, toolCallId: "browser-infinite-wait" },
			);
		};

		await call([{ method: "waitForSelector", args: ["#closed", { timeout: Infinity }] }]);
		expect(actualWaitMs).toBe(299_000);
	});

	it("owns actions and exposes tab handles instead of browser.run", async () => {
		const calls: unknown[] = [];
		const displayed: unknown[] = [];
		const context = createContext({
			__omp_log__: (_level: string, value: unknown) => displayed.push(value),
			__omp_prelude__: async (name: string, parameters: unknown) => {
				calls.push({ name, parameters });
				if (parameters === null || typeof parameters !== "object") return { text: "", details: {} };
				const action = Reflect.get(parameters, "action");
				const tabName = Reflect.get(parameters, "name");
				return {
					text: action === "open" ? "Opened tab" : "",
					details: {
						name: typeof tabName === "string" ? tabName : "main",
						value: action === "call" ? "page title" : undefined,
					},
				};
			},
		});
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		runInContext(prelude.javascript, context);
		const browser = runInContext("browser", context);

		const tab = await browser.open({ action: "close", name: "docs", url: "https://example.com" });
		expect(tab.name).toBe("docs");
		expect(String(tab)).toBe("<tab docs>");
		expect(String(tab.id(5))).toBe("<element tab.id(5) on docs>");
		expect(await tab.title()).toBe("page title");
		expect(browser.run).toBeUndefined();
		await browser.close({ action: "run", all: true });
		await expect(browser.open(null)).rejects.toThrow(/expects an options object/);
		expect(displayed).toEqual(["Opened tab"]);
		expect(calls).toEqual([
			{
				name: "browser",
				parameters: { action: "open", name: "docs", url: "https://example.com" },
			},
			{
				name: "browser",
				parameters: { action: "call", name: "docs", chain: [{ method: "title", args: [] }] },
			},
			{
				name: "browser",
				parameters: { action: "close", all: true },
			},
		]);
	});
});
