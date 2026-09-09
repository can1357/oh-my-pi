import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import type { JsDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/js/shared/types";

const PNG_BASE64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");

function collect(callTool: RuntimeHooks["callTool"]): { hooks: RuntimeHooks; displays: JsDisplayOutput[] } {
	const displays: JsDisplayOutput[] = [];
	const hooks: RuntimeHooks = {
		onText: () => {},
		onDisplay: output => displays.push(output),
		callTool,
	};
	return { hooks, displays };
}

describe("bridged tool image display", () => {
	let runtime: JsRuntime;

	beforeAll(() => {
		runtime = new JsRuntime({ initialCwd: process.cwd(), sessionId: "tool-bridge-image-test" });
	});

	afterAll(() => {
		runtime.dispose();
	});

	it("surfaces bridged image blocks as display outputs and strips the base64 payload", async () => {
		// Under Code Mode `tool.read()` on an image is the only read path; the
		// image must reach the model as a real image content block, not as a
		// base64 blob inside the returned value.
		const { hooks, displays } = collect(async () => ({
			text: "1024x768 png",
			images: [{ mimeType: "image/png", data: PNG_BASE64 }],
		}));
		const value = await runtime.run("await tool.read({ path: 'img.png' })", undefined, hooks);
		expect(displays).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
		expect(value).toEqual({ text: "1024x768 png", images: "(1 image displayed)" });
	});

	it("returns image-free bridge values untouched", async () => {
		const { hooks, displays } = collect(async () => ({ text: "plain", details: { lines: 3 } }));
		const value = await runtime.run("await tool.read({ path: 'file.txt' })", undefined, hooks);
		expect(displays).toEqual([]);
		expect(value).toEqual({ text: "plain", details: { lines: 3 } });
	});
});
