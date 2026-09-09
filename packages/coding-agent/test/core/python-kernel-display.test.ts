import { describe, expect, it } from "bun:test";
import { renderKernelDisplay } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";

describe("PythonKernel display rendering", () => {
	it("normalizes text/plain output and returns no display outputs", async () => {
		const { text, outputs } = await renderKernelDisplay({
			data: { "text/plain": "hello" },
		});

		expect(text).toBe("hello\n");
		expect(outputs).toHaveLength(0);
	});

	it("collects image and json display outputs without text", async () => {
		const { text, outputs } = await renderKernelDisplay({
			data: { "image/png": "abc", "application/json": { foo: "bar" } },
		});

		expect(text).toBe("");
		expect(outputs).toEqual([
			{ type: "image", data: "abc", mimeType: "image/png" },
			{ type: "json", data: { foo: "bar" } },
		]);
	});

	it("converts text/html to markdown", async () => {
		const { text, outputs } = await renderKernelDisplay({
			data: { "text/html": "<p><strong>Hello</strong></p>" },
		});

		expect(outputs).toHaveLength(0);
		expect(text).toBe("**Hello**\n");
	});

	it("combines text/plain with json output", async () => {
		const { text, outputs } = await renderKernelDisplay({
			data: { "text/plain": "value", "application/json": { ok: true } },
		});

		expect(text).toBe("value\n");
		expect(outputs).toEqual([{ type: "json", data: { ok: true } }]);
	});
});
