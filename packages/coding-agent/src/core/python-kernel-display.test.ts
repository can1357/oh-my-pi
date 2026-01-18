import { describe, expect, it } from "bun:test";
import { type KernelDisplayOutput, PythonKernel } from "./python-kernel";

const renderDisplay = (
	PythonKernel as unknown as {
		prototype: {
			renderDisplay: (content: Record<string, unknown>) => {
				text: string;
				outputs: KernelDisplayOutput[];
			};
		};
	}
).prototype.renderDisplay;

describe("PythonKernel display rendering", () => {
	it("normalizes text/plain output and returns no display outputs", () => {
		const { text, outputs } = renderDisplay.call({} as PythonKernel, {
			data: { "text/plain": "hello" },
		});

		expect(text).toBe("hello\n");
		expect(outputs).toHaveLength(0);
	});

	it("collects image and json display outputs without text", () => {
		const { text, outputs } = renderDisplay.call({} as PythonKernel, {
			data: { "image/png": "abc", "application/json": { foo: "bar" } },
		});

		expect(text).toBe("");
		expect(outputs).toEqual([
			{ type: "image", data: "abc", mimeType: "image/png" },
			{ type: "json", data: { foo: "bar" } },
		]);
	});

	it("converts text/html to markdown", () => {
		const { text, outputs } = renderDisplay.call({} as PythonKernel, {
			data: { "text/html": "<p><strong>Hello</strong></p>" },
		});

		expect(outputs).toHaveLength(0);
		expect(text).toBe("**Hello**\n");
	});

	it("combines text/plain with json output", () => {
		const { text, outputs } = renderDisplay.call({} as PythonKernel, {
			data: { "text/plain": "value", "application/json": { ok: true } },
		});

		expect(text).toBe("value\n");
		expect(outputs).toEqual([{ type: "json", data: { ok: true } }]);
	});
});
