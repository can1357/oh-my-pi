import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool, type ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as pdfRead from "@oh-my-pi/pi-coding-agent/tools/read-pdf";
import * as markit from "@oh-my-pi/pi-coding-agent/utils/markit";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const ONE_PX_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "images.autoResize": false, "inspect_image.mode": "off" }),
	} as ToolSession;
}

function textOf(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text)
		.join("\n");
}

describe("read PDF page screenshots", () => {
	let testDir: string;
	let pdfPath: string;
	let screenshotPath: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-pdf-page-"));
		pdfPath = path.join(testDir, "doc.pdf");
		await fs.writeFile(pdfPath, `%PDF-stub-${testDir}`);
		screenshotPath = path.join(testDir, "rendered.png");
		await fs.writeFile(screenshotPath, ONE_PX_PNG);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(testDir);
	});

	it("renders former image-member reads through Chromium", async () => {
		const render = vi.spyOn(pdfRead, "renderPdfPageScreenshot").mockResolvedValue({
			dest: screenshotPath,
			mimeType: "image/png",
			bytes: ONE_PX_PNG.byteLength,
			width: 1,
			height: 1,
		});
		const tool = new ReadTool(makeSession(testDir));

		for (const [readPath, page] of [
			[`${pdfPath}:`, 1],
			[`${pdfPath}:p2-img0.png`, 2],
		] as const) {
			const result = await tool.execute("read-pdf-image", { path: readPath });
			expect(result.content.some(entry => entry.type === "image" && entry.mimeType === "image/png")).toBe(true);
			expect(textOf(result)).toContain("Read image file [image/png]");
			expect(result.details?.resolvedPath).toBe(pdfPath);
			expect(render).toHaveBeenLastCalledWith(expect.anything(), pdfPath, page, undefined);
		}
		expect(tool.approval({ path: `${pdfPath}:p1-img0.png` })).toBe("exec");
		expect(tool.approval({ path: `${pdfPath}:2-2` })).toBe("read");
	});

	it("preserves a literal filename that looks like a PDF image listing", async () => {
		const literalPath = `${pdfPath}:`;
		await fs.writeFile(literalPath, "literal colon path wins\n");

		const result = await new ReadTool(makeSession(testDir)).execute("read-literal", { path: literalPath });
		expect(textOf(result)).toContain("literal colon path wins");
	});

	it("routes PDF line selectors through normal document conversion", async () => {
		const convert = vi.spyOn(markit, "convertFileWithMarkit").mockResolvedValue({
			ok: true,
			content: "first line\nselected line\nthird line\n",
		});

		const result = await new ReadTool(makeSession(testDir)).execute("read-pdf-lines", { path: `${pdfPath}:2-2` });
		expect(convert).toHaveBeenCalledTimes(1);
		expect(textOf(result)).toContain("selected line");
	});
});
