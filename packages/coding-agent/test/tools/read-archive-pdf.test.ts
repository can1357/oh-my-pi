import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import * as piNatives from "@oh-my-pi/pi-natives";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as pdfRead from "@oh-my-pi/pi-coding-agent/tools/read-pdf";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import * as markit from "@oh-my-pi/pi-coding-agent/utils/markit";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import * as ar from "@oh-my-pi/pi-utils/ar";
import { restoreEnvValue } from "../helpers/settings-test-state";

const MEMBER = "folder/sample document.pdf";
const SENTINEL = "Archive PDF text sentinel";
const ONE_PX_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);

function textPdf(): Uint8Array {
	const stream = `BT /F1 12 Tf 72 720 Td (${SENTINEL}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
	];
	// The standard binary marker makes the old UTF-8-only archive path reject it.
	let document = "%PDF-1.4\n%\x80\x81\x82\x83\n";
	const offsets: number[] = [];
	for (const [index, object] of objects.entries()) {
		offsets.push(document.length);
		document += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xrefOffset = document.length;
	document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) document += `${offset.toString().padStart(10, "0")} 00000 n \n`;
	document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(document, "latin1");
}

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "images.autoResize": false, "read.renderMarkdown": true }),
	};
}

function textOf(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("\n");
}

describe("PDF archive members", () => {
	let temp: TempDir;
	let pdf: Uint8Array;
	let originalAgentDir: string | undefined;
	let originalOmpProfile: string | undefined;
	let originalPiProfile: string | undefined;

	beforeEach(async () => {
		temp = await TempDir.create("@read-archive-pdf-");
		pdf = textPdf();
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		originalOmpProfile = process.env.OMP_PROFILE;
		originalPiProfile = process.env.PI_PROFILE;
		setAgentDir(temp.join("agent"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDir);
		restoreEnvValue("OMP_PROFILE", originalOmpProfile);
		restoreEnvValue("PI_PROFILE", originalPiProfile);
		__resetDirsFromEnvForTests();
		await temp.remove();
	});

	for (const format of ["zip", "tar"] as const) {
		it(`extracts a text-bearing PDF in ${format} with spaces and immutable member provenance`, async () => {
			const archivePath = temp.join(`documents.${format}`);
			await ar.writeArchive(archivePath, format, [[MEMBER, pdf]]);
			await Bun.write(temp.join("sample.pdf"), pdf);
			const tool = new ReadTool(makeSession(temp.path()));

			const result = await tool.execute("archive-pdf", { path: `${archivePath}:${MEMBER}` });
			const ordinary = await tool.execute("ordinary-pdf", { path: temp.join("sample.pdf") });
			expect(textOf(result)).toContain(SENTINEL);
			expect(textOf(ordinary)).toContain(SENTINEL);
			expect(textOf(result)).not.toContain("Cannot read binary archive entry");
			expect(textOf(result)).not.toMatch(/\[[^\n]+#[A-F0-9]{4}\]/);
			expect(result.details?.resolvedPath).toBe(`${archivePath}:${MEMBER}`);
			expect(result.details?.contentType).toBe("text/markdown");
			expect(await Bun.file(temp.join(MEMBER)).exists()).toBe(false);
		});
	}

	it("applies line, multi-range, tail, and raw selectors to the converted PDF text", async () => {
		const archivePath = temp.join("selectors.zip");
		await ar.writeArchive(archivePath, "zip", [[MEMBER, pdf]]);
		const converted = Array.from({ length: 80 }, (_, index) => `pdf line ${index + 1}`).join("\n");
		vi.spyOn(markit, "convertBufferWithMarkit").mockResolvedValue({ ok: true, content: converted });
		const tool = new ReadTool(makeSession(temp.path()));
		for (const [selector, included, excluded] of [
			["30-31", ["pdf line 30", "pdf line 31"], ["pdf line 1\n"]],
			["10-11,60-61", ["pdf line 10", "pdf line 61"], ["pdf line 40"]],
			["-2", ["pdf line 79", "pdf line 80"], ["pdf line 1\n"]],
		] as const) {
			const text = textOf(await tool.execute("pdf-selector", { path: `${archivePath}:${MEMBER}:${selector}` }));
			for (const line of included) expect(text).toContain(line);
			for (const line of excluded) expect(text).not.toContain(line);
		}
		const raw = await tool.execute("pdf-raw-range", { path: `${archivePath}:${MEMBER}:30-31:raw` });
		expect(textOf(raw)).toBe("pdf line 30\npdf line 31");
	});

	it("keeps the scanned-PDF guidance from the existing converter", async () => {
		vi.spyOn(piNatives, "pdfToMarkdown").mockResolvedValue({
			markdown: "",
			pageCount: 3,
			pagesNeedingOcr: [2, 3],
			hasEncodingIssues: false,
		});
		const archivePath = temp.join("scanned.tar");
		await ar.writeArchive(archivePath, "tar", [[MEMBER, pdf]]);
		const result = await new ReadTool(makeSession(temp.path())).execute("scanned-pdf", {
			path: `${archivePath}:${MEMBER}`,
		});
		expect(textOf(result)).toContain("Text extraction is incomplete for PDF pages 2, 3");
		expect(textOf(result)).toContain(":page2.png");
	});

	for (const outcome of ["success", "failure", "abort"] as const) {
		it(`cleans up owned PDF page materialization after ${outcome}`, async () => {
			const archivePath = temp.join(`page-${outcome}.zip`);
			await ar.writeArchive(archivePath, "zip", [[MEMBER, pdf]]);
			const screenshotPath = temp.join("page.png");
			await Bun.write(screenshotPath, ONE_PX_PNG);
			const controller = new AbortController();
			let scratchPath: string | undefined;
			vi.spyOn(pdfRead, "renderPdfPageScreenshot").mockImplementation(async (_session, file, page, signal) => {
				scratchPath = file;
				expect<Uint8Array>(await Bun.file(file).bytes()).toEqual(pdf);
				expect(file.startsWith(`${temp.path()}${path.sep}`)).toBe(false);
				expect(page).toBe(2);
				expect(signal).toBe(controller.signal);
				if (outcome === "failure") throw new Error("page render failed");
				if (outcome === "abort") {
					controller.abort();
					throw new ToolAbortError();
				}
				return {
					dest: screenshotPath,
					mimeType: "image/png",
					bytes: ONE_PX_PNG.byteLength,
					width: 1,
					height: 1,
				};
			});
			const read = new ReadTool(makeSession(temp.path())).execute(
				"pdf-page",
				{ path: `${archivePath}:${MEMBER}:page2.png` },
				controller.signal,
			);
			if (outcome === "success") {
				const result = await read;
				expect(result.content.some(content => content.type === "image" && content.mimeType === "image/png")).toBe(
					true,
				);
				expect(result.details?.resolvedPath).toBe(`${archivePath}:${MEMBER}`);
			} else {
				await expect(read).rejects.toThrow(outcome === "failure" ? "page render failed" : "abort");
			}
			expect(scratchPath).toBeDefined();
			expect(await Bun.file(scratchPath!).exists()).toBe(false);
			await expect(fs.stat(path.dirname(scratchPath!))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await Bun.file(temp.join(MEMBER)).exists()).toBe(false);
		});
	}

	it("reports corrupt PDFs through conversion errors and leaves unsupported binary members unchanged", async () => {
		const archivePath = temp.join("binary.zip");
		await ar.writeArchive(archivePath, "zip", [
			["broken.pdf", new Uint8Array([0, 255, 1, 2])],
			["unsupported.bin", new Uint8Array([0, 255, 1, 2])],
		]);
		const tool = new ReadTool(makeSession(temp.path()));
		const broken = await tool.execute("broken-pdf", { path: `${archivePath}:broken.pdf` });
		expect(textOf(broken)).toContain("Cannot read .pdf file:");
		expect(textOf(broken)).not.toContain("Cannot read binary archive entry");
		const binary = await tool.execute("unsupported", { path: `${archivePath}:unsupported.bin` });
		expect(textOf(binary)).toContain("Cannot read binary archive entry 'unsupported.bin'");
	});

	it("enforces the selected-member extraction limit before invoking the PDF converter", async () => {
		const archivePath = temp.join("bounded.zip");
		await ar.writeArchive(archivePath, "zip", [[MEMBER, pdf]]);
		const archive = await ar.openArchive(archivePath);
		const bounded = new ar.ArchiveReader("zip", [...archive.indexEntries()], {
			...archive.limits,
			maxMemberSize: pdf.byteLength - 1,
		});
		vi.spyOn(ar, "openArchive").mockResolvedValue(bounded);
		const convert = vi.spyOn(markit, "convertBufferWithMarkit");
		await expect(
			new ReadTool(makeSession(temp.path())).execute("bounded-pdf", { path: `${archivePath}:${MEMBER}` }),
		).rejects.toThrow("too large to extract");
		expect(convert).not.toHaveBeenCalled();
	});
});
