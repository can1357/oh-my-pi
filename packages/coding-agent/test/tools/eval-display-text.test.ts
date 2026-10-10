import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { formatOutputNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import * as pyKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

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

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text" && typeof c.text === "string")
		.map(c => c.text as string)
		.join("\n");
}

function readSession(cwd: string): ToolSession {
	return { ...makeSession(), cwd } as ToolSession;
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

	it("keeps a read's continuation notice when the display preview is capped", async () => {
		// A read that hit the size limit ends its text with `[Showing … Use :N
		// to continue]`. That line is the only thing telling the model how to
		// get the rest of the file, and a head-only truncation of the serialised
		// JSON drops it — `details`, which carries nextOffset, is serialised
		// after it and goes with it.
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const body = "y".repeat(20_000);
		const notice = "[Showing lines 1-488 of 921 (50.0KB limit). Use :489 to continue]";
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				displayOutputs: [
					{
						type: "json",
						data: { text: `${body}\n${notice}`, details: { truncation: { nextOffset: 488 } } },
					},
				],
			}) as never,
		);

		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-continuation", {
			language: "js",
			code: "display(read('big.txt'));",
		});

		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		// The notice is the part the model acts on: it names the offset to read
		// next. `details.truncation.nextOffset` is serialised *after* the text
		// field and still falls inside the cut — see the PR body.
		expect(text).toContain("Use :489 to continue");
		// Re-attached as a tail, so it must not also appear inline as well.
		expect(text.split("Use :489 to continue").length - 1).toBe(1);
		expect(text).toContain("ch elided");
	});

	it("keeps a streaming read's continuation notice when the display preview is capped", async () => {
		// Past `SNAPSHOT_MAX_BYTES` the read cannot buffer the file, so it
		// streams a window, never reaches EOF and appends
		// `[More lines in file (… total; not scanned to EOF). Use :N to
		// continue]`. That branch sets `details = {}`, so no `truncation`
		// object survives to hint at the offset either: this tail line is the
		// only place the model is told how to get the rest of the file.
		using tempDir = TempDir.createSync("@omp-eval-display-");
		const dir = tempDir.path();
		const bigPath = tempDir.join("big.txt");
		const chunk = `${"y".repeat(4096)}\n`;
		const handle = fs.openSync(bigPath, "w");
		for (let i = 0; i < 6 * 256; i++) fs.writeSync(handle, chunk);
		fs.closeSync(handle);
		expect(fs.statSync(bigPath).size).toBeGreaterThan(4 * 1024 * 1024);

		const read = new ReadTool(readSession(dir));
		const realText = toolText((await read.execute("probe-stream", { path: "big.txt" } as never)) as never);
		expect(realText).toContain("not scanned to EOF");
		expect(realText.endsWith("]")).toBe(true);

		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				displayOutputs: [{ type: "json", data: { text: realText, details: {} } }],
			}) as never,
		);

		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-stream", {
			language: "js",
			code: "display(read('big.txt'));",
		});

		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("ch elided");
		expect(text).toContain("not scanned to EOF). Use :");
		expect(text.split("not scanned to EOF").length - 1).toBe(1);
	}, 120_000);

	it("keeps a directory listing's continuation notice when the display preview is capped", async () => {
		// `read('dir:1-400')` slices the rendered listing and appends
		// `[N more lines in listing. Use :N to continue]`. Same failure mode:
		// the notice is the tail of the `text` field, so a head-only cut of
		// the serialised JSON loses the only paging instruction.
		using tempDir = TempDir.createSync("@omp-eval-display-");
		const dir = tempDir.path();
		for (let d = 0; d < 60; d++) {
			const sub = tempDir.join(`subdir-${String(d).padStart(3, "0")}`);
			fs.mkdirSync(sub);
			// Long enough names that the 400-line slice clears the 8 KB cap.
			for (let f = 0; f < 12; f++) {
				const longName = `${f}-${"segment".repeat(6)}-${f}.txt`;
				fs.writeFileSync(path.join(sub, longName), "x\n");
			}
		}

		const read = new ReadTool(readSession(dir));
		const realText = toolText((await read.execute("probe-dir", { path: ".:1-400" } as never)) as never);
		expect(realText).toContain("more lines in listing");
		expect(Buffer.byteLength(realText)).toBeGreaterThan(8000);

		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				displayOutputs: [{ type: "json", data: { text: realText, details: {} } }],
			}) as never,
		);

		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-dir", {
			language: "js",
			code: "display(read('dir:1-400'));",
		});

		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("ch elided");
		expect(text).toContain("more lines in listing. Use :401 to continue]");
		expect(text.split("more lines in listing").length - 1).toBe(1);
	}, 120_000);

	it("keeps the re-attached notice tail inside the same 8 KB budget", async () => {
		// Every entry is a read that hit its own limit, so the serialised value
		// carries hundreds of notices. The re-attached tail shared no budget with
		// the capped head, so the preview grew well past the cap.
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const reads = Array.from({ length: 400 }, (_, i) => ({
			text: `${"z".repeat(200)}\n[Showing lines 1-${i + 2} of ${i + 3}. Use :${i + 3} to continue]`,
		}));
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				displayOutputs: [{ type: "json", data: reads }],
			}) as never,
		);

		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-many-notices", {
			language: "js",
			code: "display(reads);",
		});

		const text = toolText(result);
		const label = "display[1]:\n";
		const preview = text.slice(text.indexOf(label) + label.length);
		expect(Buffer.byteLength(preview, "utf-8")).toBeLessThanOrEqual(8000);
		expect(text).toContain("ch elided");
		// The model has to be able to tell that notices went missing, otherwise a
		// short tail reads as "that was all of them".
		expect(text).toContain("more notices elided");
	});

	it("does not re-attach a notice that the file content merely mentions", async () => {
		// A source file that quotes the notice, or a log that records one, makes
		// the notice text appear inside a field without being that field's tail.
		// Re-attaching it hands the model a paging hint for content it is not
		// looking at.
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const body = `${"y".repeat(20_000)}\n--- docs/notice.md ---\n[Showing lines 1-488 of 921 (50.0KB limit). Use :489 to continue]\nsee read() for the real format\n`;
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				displayOutputs: [{ type: "json", data: { text: body } }],
			}) as never,
		);

		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-quoted-notice", {
			language: "js",
			code: "display({ text: body });",
		});

		const text = toolText(result);
		expect(text).toContain("ch elided");
		expect(text).not.toContain("Use :489 to continue");
	});

	it("keeps oversized display details bounded and spills the full value to the artifact", async () => {
		using tempDir = TempDir.createSync("@omp-eval-display-");
		const artifactPath = tempDir.join("eval.log");
		const huge = `start-${"x".repeat(100_000)}-end`;
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				displayOutputs: [{ type: "json", data: { payload: huge } }],
			}) as never,
		);

		const tool = new EvalTool({
			...makeSession(),
			allocateOutputArtifact: async () => ({ id: "large-display", path: artifactPath }),
		});
		const result = await tool.execute("call-huge-details", {
			language: "js",
			code: "display({ payload: huge });",
		});

		expect(Buffer.byteLength(JSON.stringify(result.details), "utf-8")).toBeLessThan(20_000);
		expect(await Bun.file(artifactPath).text()).toContain(huge);
		expect(result.details?.meta?.truncation?.artifactId).toBe("large-display");
	});

	it("retains the full display value in details when no artifact is available", async () => {
		const huge = `start-${"x".repeat(100_000)}-end`;
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				displayOutputs: [{ type: "json", data: { payload: huge } }],
			}) as never,
		);

		// makeSession() has no allocateOutputArtifact, mirroring a non-persistent
		// SDK session: there is no session JSONL to bloat, so the full structured
		// value must survive in details for SDK consumers.
		const tool = new EvalTool(makeSession());
		const result = await tool.execute("call-huge-no-artifact", {
			language: "js",
			code: "display({ payload: huge });",
		});

		expect(result.details?.jsonOutputs?.[0]).toEqual({ payload: huge });
		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("ch elided");
		expect(text).not.toContain(huge);
	});

	it("restores the full display value when the artifact write fails", async () => {
		using tempDir = TempDir.createSync("@omp-eval-display-fail-");
		// Parent directory is never created, so the spill FileSink cannot open —
		// OutputSink swallows the error, so persistence must be treated as
		// unconfirmed and the full value restored into details.
		const artifactPath = tempDir.join("missing", "eval.log");
		const huge = `start-${"x".repeat(100_000)}-end`;
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				displayOutputs: [{ type: "json", data: { payload: huge } }],
			}) as never,
		);

		const tool = new EvalTool({
			...makeSession(),
			allocateOutputArtifact: async () => ({ id: "doomed-display", path: artifactPath }),
		});
		const result = await tool.execute("call-huge-failed-spill", {
			language: "js",
			code: "display({ payload: huge });",
		});

		expect(await Bun.file(artifactPath).exists()).toBe(false);
		expect(result.details?.jsonOutputs?.[0]).toEqual({ payload: huge });
		expect(result.details?.meta?.truncation?.artifactId).toBeUndefined();
	});

	it("restores the full display value when the artifact cap cut the spill", async () => {
		using tempDir = TempDir.createSync("@omp-eval-display-capped-");
		const artifactPath = tempDir.join("eval.log");
		// 3 MiB spill against a 1 MB artifact cap: the middle of the value is
		// never written, so the artifact cannot stand in for it.
		const huge = `start-${"x".repeat(3 * 1024 * 1024)}-end`;
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(
			baseResult({
				displayOutputs: [{ type: "json", data: { payload: huge } }],
			}) as never,
		);

		const tool = new EvalTool({
			...makeSession(),
			settings: Settings.isolated({ "tools.artifactMaxBytes": 1 }),
			allocateOutputArtifact: async () => ({ id: "capped-display", path: artifactPath }),
		});
		const result = await tool.execute("call-huge-capped-spill", {
			language: "js",
			code: "display({ payload: huge });",
		});

		expect(await Bun.file(artifactPath).text()).toContain("[ARTIFACT TRUNCATED:");
		expect(result.details?.jsonOutputs?.[0]).toEqual({ payload: huge });
		expect(result.details?.meta?.truncation?.artifactId).toBe("capped-display");
		expect(result.details?.meta?.truncation?.artifactElidedBytes).toBeGreaterThan(0);
		const notice = formatOutputNotice(result.details?.meta);
		expect(notice).toContain("Read artifact://capped-display for a head/tail sample of the output");
		expect(notice).not.toContain("for full output");
	});
});
