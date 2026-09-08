import { describe, expect, it } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";

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
		settings.set("browser.enabled", false);
		const prelude = createBrowserPrelude(makeSession(settings));

		expect(prelude.enabled?.()).toBe(false);
		settings.set("browser.enabled", true);
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

	it("owns actions and exposes tab handles instead of browser.run", async () => {
		const calls: unknown[] = [];
		const displayed: unknown[] = [];
		const context = createContext({
			__omp_display__: (value: unknown) => displayed.push(value),
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
