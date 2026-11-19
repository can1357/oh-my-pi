import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { processFileArguments } from "@oh-my-pi/pi-coding-agent/cli/file-processor";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

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

describe("processFileArguments", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pdf-file-args-"));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("converts PDF file arguments before adding them to the prompt", async () => {
		const pdfPath = path.join(testDir, "document.pdf");
		fs.writeFileSync(pdfPath, createPdfWithText("Hello PDF from issue 1401"));

		const result = await processFileArguments([pdfPath], { autoResizeImages: false });

		expect(result.images).toEqual([]);
		expect(result.text).toContain("Hello PDF from issue 1401");
		expect(result.text).not.toContain("%PDF-1.4");
		expect(result.text).not.toContain("stream");
	});
});
