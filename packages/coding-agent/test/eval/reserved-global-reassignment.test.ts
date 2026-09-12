import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import type { JsDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/js/shared/types";

let runtime: JsRuntime;

function makeHooks(): { hooks: RuntimeHooks; texts: string[] } {
	const texts: string[] = [];
	const displays: JsDisplayOutput[] = [];
	const hooks: RuntimeHooks = {
		onText: (chunk: string) => {
			texts.push(chunk);
		},
		onDisplay: (output: JsDisplayOutput) => {
			displays.push(output);
		},
		callTool: async () => undefined,
	};
	return { hooks, texts };
}

describe("JsRuntime reserved global reassignment", () => {
	beforeAll(() => {
		runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "reserved-global-reassignment" });
	});

	afterAll(() => {
		runtime.dispose();
	});

	it("retains a user reassignment of a reserved global across cells", async () => {
		const cell1 = makeHooks();
		await runtime.run('var fs = await import("node:fs/promises");', undefined, cell1.hooks);

		const cell2 = makeHooks();
		const value = await runtime.run("typeof fs.readFileSync;", undefined, cell2.hooks);
		expect(value).toBe("undefined");
	});
});
