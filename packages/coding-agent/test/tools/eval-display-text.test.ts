import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import type { EvalDisplayOutput } from "@oh-my-pi/pi-coding-agent/eval/types";
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

function baseResult(output: string, displayOutputs: EvalDisplayOutput[] = []) {
	return {
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		artifactId: undefined,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
		displayOutputs,
	};
}

function modelText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(c => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function makeRedPng(width: number, height: number): Promise<string> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const upscaled = await new Bun.Image(seed).resize(width, height, { filter: "nearest" }).png().bytes();
	return Buffer.from(upscaled).toString("base64");
}

describe("EvalTool printed views", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("gives the model exactly the printed text and puts the view on the cell", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const printed = "  a  b\n0  1  2";
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult(`before\n${printed}\n`, [
				{
					type: "view",
					text: `${printed}\n`,
					view: {
						kind: "table",
						columns: [{ head: "" }, { head: "a", numeric: true }, { head: "b", numeric: true }],
						rows: [["0", "1", "2"]],
					},
				},
			]) as never,
		);

		const result = await new EvalTool(makeSession()).execute("call-view", { language: "js", code: "print(df)" });

		expect(modelText(result)).toBe(`before\n${printed}`);
		const cell = result.details?.cells?.[0];
		expect(cell?.output).toBe(`before\n${printed}`);
		expect(cell?.views).toEqual([
			{
				// Stored text is trimmed; the renderer still finds it inside `output`.
				text: printed.trim(),
				view: {
					kind: "table",
					columns: [{ head: "" }, { head: "a", numeric: true }, { head: "b", numeric: true }],
					rows: [["0", "1", "2"]],
				},
			},
		]);
	});

	it("caps views at 16 per cell, drops oversized and empty ones, and leaves cells without views bare", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const views: EvalDisplayOutput[] = [
			{ type: "view", text: "huge", view: { kind: "markdown", text: "x".repeat(33 * 1024) } },
			{ type: "view", text: "  \n", view: { kind: "markdown", text: "blank" } },
		];
		for (let i = 0; i < 20; i++) views.push({ type: "view", text: `v${i}`, view: { kind: "json", value: [i] } });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(baseResult("text\n", views) as never);

		const result = await new EvalTool(makeSession()).execute("call-caps", { language: "js", code: "print(x)" });

		const kept = result.details?.cells?.[0]?.views ?? [];
		expect(kept).toHaveLength(16);
		expect(kept.map(entry => entry.text)).toEqual(Array.from({ length: 16 }, (_, i) => `v${i}`));
		expect(modelText(result)).toBe("text");
	});

	it("omits views when nothing qualified", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(baseResult("plain\n") as never);

		const result = await new EvalTool(makeSession()).execute("call-plain", { language: "js", code: "print(1)" });

		expect(result.details?.cells?.[0]?.views).toBeUndefined();
	});

	it("surfaces printed images to the model as ImageContent blocks, not inlined base64", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const base64 = Buffer.from([0, 1, 2, 3]).toString("base64");
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult("", [{ type: "image", data: base64, mimeType: "image/png" }]) as never,
		);

		const result = await new EvalTool(makeSession()).execute("call-image", { language: "js", code: "print(img)" });

		const imageBlocks = result.content.filter(c => c.type === "image");
		expect(imageBlocks).toHaveLength(1);
		expect(imageBlocks[0]).toMatchObject({ type: "image", data: base64, mimeType: "image/png" });
		const text = modelText(result);
		expect(text).not.toContain(base64);
		expect(text).toMatch(/\(1 image; no text output\)/);
		expect(result.details?.images).toBeUndefined();
	});

	it("downscales printed images before returning ImageContent", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const base64 = await makeRedPng(2400, 1200);
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult("", [{ type: "image", data: base64, mimeType: "image/png" }]) as never,
		);

		const result = await new EvalTool(makeSession()).execute("call-large-image", {
			language: "js",
			code: "print(largePng)",
		});

		const image = result.content.find(c => c.type === "image");
		if (image?.type !== "image") throw new Error("Expected image content");
		expect(image.data).not.toBe(base64);
		const { width, height } = await new Bun.Image(Buffer.from(image.data, "base64")).metadata();
		expect(width).toBeLessThanOrEqual(1568);
		expect(height).toBeLessThanOrEqual(1568);
		const text = modelText(result);
		expect(text).toContain("original 2400x1200");
		expect(text).not.toContain(base64);
	});
});
