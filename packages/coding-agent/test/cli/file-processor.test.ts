/**
 * CLI `@file` video attachments become a compact PNG preview grid rather than
 * reading the whole container into memory. The fixture is deliberately over
 * the normal text-file limit: a normal video commonly exceeds 5 MiB, and the
 * processor must still seek frames through ffmpeg instead of skipping it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { processFileArguments } from "@oh-my-pi/pi-coding-agent/cli/file-processor";
import { $which, removeWithRetries } from "@oh-my-pi/pi-utils";

const hasFfmpeg = Boolean($which("ffmpeg") && $which("ffprobe"));

describe.skipIf(!hasFfmpeg)("processFileArguments video attachments", () => {
	let testDir: string;
	let videoPath: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-processor-video-"));
		videoPath = path.join(testDir, "clip.mp4");
		const process = Bun.spawn([
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc=duration=1:size=320x240:rate=30",
			"-pix_fmt",
			"yuv420p",
			"-c:v",
			"libx264",
			videoPath,
		]);
		expect(await process.exited).toBe(0);
		await fs.truncate(videoPath, 6 * 1024 * 1024);
	});

	afterEach(async () => {
		await removeWithRetries(testDir);
	});

	it("attaches a preview image for a video larger than the text-file limit", async () => {
		const processed = await processFileArguments([videoPath], { autoResizeImages: false });

		expect(processed.images).toHaveLength(1);
		expect(processed.images[0]?.mimeType).toBe("image/png");
		expect(processed.text).toContain("Video:");
		expect(processed.text).toContain("Preview grid: 6 frames (3x2)");
	});
});

function createPdfWithText(text: string): string {
	const chunks: string[] = [];
	let position = 0;
	const offsets = [0];
	const add = (chunk: string) => {
		chunks.push(chunk);
		position += Buffer.byteLength(chunk);
	};

	add("%PDF-1.4\n");
	offsets.push(position);
	add("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
	offsets.push(position);
	add("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
	offsets.push(position);
	add(
		"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
	);
	offsets.push(position);
	add("4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");

	const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
	offsets.push(position);
	add(`5 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`);

	const xrefPosition = position;
	add("xref\n0 6\n0000000000 65535 f \n");
	for (let i = 1; i <= 5; i++) {
		add(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
	}
	add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPosition}\n%%EOF\n`);

	return chunks.join("");
}

describe("processFileArguments PDF attachments", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pdf-file-args-"));
	});

	afterEach(async () => {
		await removeWithRetries(testDir);
	});

	it("converts PDF file arguments before adding them to the prompt", async () => {
		const pdfPath = path.join(testDir, "document.pdf");
		await fs.writeFile(pdfPath, createPdfWithText("Hello PDF attachment"));

		const result = await processFileArguments([pdfPath], { autoResizeImages: false });

		expect(result.images).toEqual([]);
		expect(result.text).toContain("Hello PDF attachment");
		expect(result.text).not.toContain("%PDF-1.4");
		expect(result.text).not.toContain("stream");
	});
});
