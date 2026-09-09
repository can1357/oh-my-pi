import { describe, expect, it } from "bun:test";
import { renderKernelDisplay } from "@oh-my-pi/pi-coding-agent/eval/py/display";

describe("renderKernelDisplay (raw bundle shape)", () => {
	it("renders status events without text output", async () => {
		const { text, outputs } = await renderKernelDisplay({
			"application/x-omp-status": { op: "glob", count: 12, pattern: "foo" },
		});
		expect(text).toBe("");
		expect(outputs).toEqual([{ type: "status", event: { op: "glob", count: 12, pattern: "foo" } }]);
	});

	it("prefers text/markdown over text/plain", async () => {
		const { text, outputs } = await renderKernelDisplay({
			"text/markdown": "**bold**",
			"text/plain": "bold",
		});
		expect(text).toBe("**bold**\n");
		expect(outputs).toContainEqual({ type: "markdown" });
	});

	it("collects image/png alongside text/plain", async () => {
		const { text, outputs } = await renderKernelDisplay({
			"image/png": "base64data",
			"text/plain": "<Figure>",
		});
		expect(text).toBe("<Figure>\n");
		expect(outputs).toContainEqual({ type: "image", data: "base64data", mimeType: "image/png" });
	});

	it("emits json bundle and includes text/plain when present", async () => {
		const { text, outputs } = await renderKernelDisplay({
			"application/json": { ok: true },
			"text/plain": "{ ok: true }",
		});
		expect(text).toBe("{ ok: true }\n");
		expect(outputs).toEqual([{ type: "json", data: { ok: true } }]);
	});
});
