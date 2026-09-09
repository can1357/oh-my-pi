import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import * as pyKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	};
}

function baseResult(overrides: Record<string, unknown> = {}) {
	return {
		output: "",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		artifactId: undefined,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
		displayOutputs: [] as unknown[],
		...overrides,
	};
}

const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function makeRedPng(width: number, height: number): Promise<string> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const upscaled = await new Bun.Image(seed).resize(width, height, { filter: "nearest" }).png().bytes();
	return Buffer.from(upscaled).toString("base64");
}

describe("EvalTool display() text surfacing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("includes display() JSON values in the text content the model sees", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				displayOutputs: [{ type: "json", data: { stdout: "hi", exit_code: 0 } }],
			}) as never,
		);

		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-display-json", {
			language: "js",
			code: "```js\ndisplay({ stdout: 'hi', exit_code: 0 });\n```\n",
		});

		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("display[1]");
		expect(text).toContain('"stdout": "hi"');
		expect(text).toContain('"exit_code": 0');
		expect(text).not.toBe("(no text output)");
	});

	it("interleaves stdout text and display() JSON values", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				output: "before\n",
				displayOutputs: [{ type: "json", data: [1, 2, 3] }],
			}) as never,
		);

		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-mixed", {
			language: "js",
			code: "```js\nprint('before'); display([1,2,3]);\n```\n",
		});

		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("before");
		expect(text.indexOf("before")).toBeLessThan(text.indexOf("display[1]"));
		expect(text).toContain("[\n  1,\n  2,\n  3\n]");
	});

	it("surfaces displayed images to the model as ImageContent blocks, not inlined base64", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const base64 = Buffer.from([0, 1, 2, 3]).toString("base64");
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				displayOutputs: [{ type: "image", data: base64, mimeType: "image/png" }],
			}) as never,
		);

		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-image", {
			language: "js",
			code: "```js\ndisplay({ type: 'image', data: '...', mimeType: 'image/png' });\n```\n",
		});

		const imageBlocks = result.content.filter(c => c.type === "image");
		expect(imageBlocks).toHaveLength(1);
		expect(imageBlocks[0]).toMatchObject({ type: "image", data: base64, mimeType: "image/png" });

		const textBlocks = result.content.filter(c => c.type === "text");
		const text = textBlocks.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).not.toContain(base64); // base64 must not leak into text channel
		expect(text).toMatch(/displayed 1 image/);

		// Image is in content, so details.images must be empty to avoid double-rendering.
		expect(result.details?.images).toBeUndefined();
	});

	it("downscales displayed images before returning ImageContent", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const base64 = await makeRedPng(2400, 1200);
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				displayOutputs: [{ type: "image", data: base64, mimeType: "image/png" }],
			}) as never,
		);

		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-large-image", {
			language: "js",
			code: "```js\ndisplay({ type: 'image', data: largePng, mimeType: 'image/png' });\n```\n",
		});

		const image = result.content.find(c => c.type === "image");
		expect(image).toBeDefined();
		if (image?.type !== "image") throw new Error("Expected image content");
		expect(image.data).not.toBe(base64);

		const { width, height } = await new Bun.Image(Buffer.from(image.data, "base64")).metadata();
		expect(width).toBeLessThanOrEqual(1568);
		expect(height).toBeLessThanOrEqual(1568);

		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("display image 1:");
		expect(text).toContain("original 2400x1200");
		expect(text).not.toContain(base64);
	});

	it("still reports (no text output) when nothing was printed or displayed", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(baseResult() as never);

		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-empty", {
			language: "js",
			code: "```js\nconst x = 1;\n```\n",
		});

		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("(no output)");
	});

	it("truncates oversized display values rather than blasting the context", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const huge = "x".repeat(20000);
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				displayOutputs: [{ type: "json", data: { payload: huge } }],
			}) as never,
		);

		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-huge", {
			language: "js",
			code: "```js\ndisplay({ payload: 'x'.repeat(20000) });\n```\n",
		});

		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("ch elided");
		expect(text.length).toBeLessThan(20000);
	});
});
