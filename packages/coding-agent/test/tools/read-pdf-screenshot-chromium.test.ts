import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deflateSync } from "node:zlib";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	acquireBrowser,
	type BrowserHandle,
	holdBrowser,
	releaseBrowser,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { decodePng } from "@oh-my-pi/pi-coding-agent/tools/browser/screenshot";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { renderPdfPageScreenshot } from "@oh-my-pi/pi-coding-agent/tools/read-pdf";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
// Before the fix each page came back blank about half the time, so eight
// pages fail it on nearly every run.
const PAGE_COUNT = 8;
// Each render has its own 30 s deadline; on a running browser they take about 1 s.
const TEST_TIMEOUT_MS = PAGE_COUNT * 30_000;
const IMAGE_SIZE = 1600;

/** Side of page `page`'s black square as a fraction of the page, distinct per page. */
function squareFraction(page: number): number {
	return (page + 1) / (PAGE_COUNT + 3);
}

/**
 * A PDF whose pages are each one scan-sized embedded image and no text: a
 * black square on white filling the page, larger on each later page. A small
 * image painted in time even before the fix.
 */
function imageOnlyPdf(): Buffer {
	const objects: Buffer[] = [
		Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
		Buffer.from(
			`<< /Type /Pages /Kids [${Array.from({ length: PAGE_COUNT }, (_, i) => `${3 + i * 3} 0 R`).join(" ")}] /Count ${PAGE_COUNT} >>`,
		),
	];
	const content = Buffer.from("q 612 0 0 792 0 0 cm /Im0 Do Q");
	for (let page = 1; page <= PAGE_COUNT; page++) {
		const pageId = objects.length + 1;
		const pixels = Buffer.alloc(IMAGE_SIZE * IMAGE_SIZE, 0xff);
		const side = Math.round(IMAGE_SIZE * squareFraction(page));
		const start = (IMAGE_SIZE - side) >> 1;
		for (let y = start; y < start + side; y++) pixels.fill(0, y * IMAGE_SIZE + start, y * IMAGE_SIZE + start + side);
		const image = deflateSync(pixels);
		objects.push(
			Buffer.from(
				`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${pageId + 2} 0 R >> >> /Contents ${pageId + 1} 0 R >>`,
			),
			Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("\nendstream")]),
			Buffer.concat([
				Buffer.from(
					`<< /Type /XObject /Subtype /Image /Width ${IMAGE_SIZE} /Height ${IMAGE_SIZE} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`,
				),
				image,
				Buffer.from("\nendstream"),
			]),
		);
	}

	const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
	let offset = parts[0].length;
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		const object = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
		offsets.push(offset);
		offset += object.length;
		parts.push(object);
	});
	const xref = [
		"xref",
		`0 ${objects.length + 1}`,
		"0000000000 65535 f ",
		...offsets.map(o => `${String(o).padStart(10, "0")} 00000 n `),
		"trailer",
		`<< /Size ${objects.length + 1} /Root 1 0 R >>`,
		"startxref",
		String(offset),
		"%%EOF",
	].join("\n");
	parts.push(Buffer.from(xref));
	return Buffer.concat(parts);
}

/** Near-white (page) and near-black (square) pixel counts of a screenshot. */
async function countPagePixels(file: string): Promise<{ light: number; dark: number }> {
	const png = await new Bun.Image(await fs.readFile(file)).png().bytes();
	const { width, height, pixels } = decodePng(png);
	let light = 0;
	let dark = 0;
	for (let i = 0; i < width * height * 4; i += 4) {
		const min = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
		const max = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
		if (min >= 240) light++;
		else if (max <= 15) dark++;
	}
	return { light, dark };
}

describe.skipIf(!CHROMIUM_AVAILABLE)("PDF page screenshots in Chromium", () => {
	let testDir: string;
	let browser: BrowserHandle | undefined;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-pdf-chromium-"));
	});

	afterEach(async () => {
		// Close the viewer before deleting the PDF it holds open.
		await releaseAllTabs({ kill: true });
		if (browser) await releaseBrowser(browser, { kill: true });
		browser = undefined;
		await removeWithRetries(testDir);
	});

	it(
		"paints each requested image-only page instead of the empty viewer",
		async () => {
			const pdfPath = path.join(testDir, "scan.pdf");
			await fs.writeFile(pdfPath, imageOnlyPdf());
			const session = {
				cwd: testDir,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated({ "browser.headless": true, "browser.cmux": false, "browser.tern": false }),
			} as ToolSession;
			// Production renders on the long-lived project-shared Chromium; under `bun test` the
			// registry launches a process-local one instead and closes it once its last tab goes.
			// Hold it so each render opens its own tab on a running browser, as in production,
			// rather than launching and closing a Chromium per page.
			browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: testDir });
			holdBrowser(browser);

			for (let page = 1; page <= PAGE_COUNT; page++) {
				const screenshot = await renderPdfPageScreenshot(session, pdfPath, page);
				const { light, dark } = await countPagePixels(screenshot.dest).finally(() =>
					fs.rm(screenshot.dest, { force: true }),
				);
				// An unpainted frame is only the viewer's grey background. A
				// painted one shows the white page, and the share of it the black
				// square covers identifies which page was rendered. The letter page
				// covers about 76% of the square tab (43% of a 1024x576 one).
				const area = screenshot.width * screenshot.height;
				const painted = light + dark > area / 10;
				const squareShare = painted ? dark / (light + dark) : 0;
				expect({
					page,
					painted,
					rightPage: Math.abs(squareShare - squareFraction(page) ** 2) < 0.015,
					fillsShot: (light + dark) / area > 0.6,
				}).toEqual({
					page,
					painted: true,
					rightPage: true,
					fillsShot: true,
				});
			}
		},
		TEST_TIMEOUT_MS,
	);
});
