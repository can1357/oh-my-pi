import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import type { ReadToolDetails, ReadTruncationStats, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { formatTruncationMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool, readToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/read";
import { writeArchive } from "@oh-my-pi/pi-utils/ar";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

function persistedResult(result: AgentToolResult<ReadToolDetails>): AgentToolResult<ReadToolDetails> {
	const persisted: AgentToolResult<ReadToolDetails> = JSON.parse(JSON.stringify(result));
	expect(persisted.details?.truncation).toBeDefined();
	expect(persisted.details?.truncation).not.toHaveProperty("content");
	return persisted;
}

describe("read truncation metadata", () => {
	let root: string;
	let session: ToolSession;
	let tool: ReadTool;
	let uiTheme: Theme;

	beforeAll(async () => {
		await initTheme(false, undefined, undefined, "dark", "light");
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		uiTheme = theme;
	});

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "read-truncation-metadata-"));
		const getArtifactsDir = () => path.join(root, "artifacts");
		session = {
			cwd: root,
			hasUI: false,
			getSessionFile: () => path.join(root, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir,
			localProtocolOptions: { getArtifactsDir },
			settings: Settings.isolated({
				"read.summarize.enabled": false,
				"edit.mode": "hashline",
				readLineNumbers: true,
				"tools.outputMaxColumns": 0,
			}),
		};
		tool = new ReadTool(session);
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("keeps byte-limited local content and its continuation without serializing a second truncation body", async () => {
		const lines = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(4, "0")}${"x".repeat(1020)}`);
		await Bun.write(path.join(root, "bytes.txt"), lines.join("\n"));

		const result = persistedResult(await tool.execute("local-bytes", { path: "bytes.txt:raw:1-100" }));
		const expectedBody = lines.slice(0, 49).join("\n");
		expect(textOutput(result)).toBe(expectedBody);
		expect(result.details?.displayContent?.text).toBe(expectedBody);
		expect(result.details?.truncation).toMatchObject({
			truncated: true,
			truncatedBy: "bytes",
			totalLines: 100,
			totalBytes: Buffer.byteLength(lines.join("\n")),
			outputLines: 49,
			outputBytes: Buffer.byteLength(expectedBody),
			firstLineExceedsLimit: false,
			lastLinePartial: false,
		} satisfies ReadTruncationStats);
		expect(result.details?.meta?.truncation).toMatchObject({
			shownRange: { start: 1, end: 49 },
			nextOffset: 50,
		});
		const meta = result.details?.meta?.truncation;
		if (!meta) throw new Error("Expected continuation metadata");
		expect(formatTruncationMetaNotice(meta)).toContain("Use :50 to continue");
	});

	it("does not turn an oversized local first line into an editable partial hashline", async () => {
		const line = "x".repeat(DEFAULT_MAX_BYTES + 1);
		await Bun.write(path.join(root, "wide.txt"), `${line}\nlast`);
		const result = persistedResult(await tool.execute("local-wide", { path: "wide.txt:1-1" }));

		expect(textOutput(result)).toContain("cannot emit an editable numbered preview");
		expect(textOutput(result)).not.toContain("1:xxx");
		expect(result.details?.truncation).toMatchObject({
			firstLineExceedsLimit: true,
			lastLinePartial: false,
			totalBytes: DEFAULT_MAX_BYTES + 1,
			outputBytes: DEFAULT_MAX_BYTES,
		});
		expect(result.details?.meta?.truncation).toMatchObject({ partialLine: true, shownRange: { start: 1, end: 1 } });
		expect(result.details?.meta?.truncation?.nextOffset).toBeUndefined();
	});

	it("retains the partial UTF-8 preview and oversized-line warning for streamed artifact reads", async () => {
		const line = "é".repeat(36_000);
		await Bun.write(path.join(root, "artifacts", "0.read.log"), `before\n${line}\nafter`);
		const result = persistedResult(await tool.execute("artifact-line", { path: "artifact://0:raw:2-2" }));
		const preview = line.slice(0, DEFAULT_MAX_BYTES / 2);

		expect(textOutput(result)).toBe(preview);
		expect(result.details?.displayContent).toMatchObject({ text: preview, startLine: 2, lineNumbers: [2] });
		expect(result.details?.truncation).toMatchObject({
			firstLineExceedsLimit: true,
			lastLinePartial: false,
			totalBytes: Buffer.byteLength(line),
			outputBytes: Buffer.byteLength(preview),
			outputLines: 1,
		});
		expect(result.details?.meta?.truncation).toMatchObject({
			partialLine: true,
			shownRange: { start: 2, end: 2 },
			outputBytes: Buffer.byteLength(preview),
		});
		expect(result.details?.meta?.truncation?.nextOffset).toBeUndefined();
		const rendered = readToolRenderer
			.renderResult(result, { expanded: false, isPartial: false }, uiTheme, { path: "artifact://0:raw:2-2" })
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("First line exceeds");
		expect(rendered).not.toContain("Showing 0 of");
	});

	it("preserves the in-memory line cap and rendering of legacy metadata with or without display content", async () => {
		const lines = Array.from(
			{ length: DEFAULT_MAX_LINES + 5 },
			(_, index) => `row-${String(index + 1).padStart(4, "0")}`,
		);
		await writeArchive(path.join(root, "rows.zip"), "zip", [["rows.txt", lines.join("\n")]]);
		const result = persistedResult(await tool.execute("archive-lines", { path: "rows.zip:rows.txt" }));
		const displayBody = lines.slice(0, DEFAULT_MAX_LINES).join("\n");
		expect(textOutput(result)).toBe(
			lines
				.slice(0, DEFAULT_MAX_LINES)
				.map((line, index) => `${index + 1}|${line}`)
				.join("\n"),
		);
		expect(result.details?.displayContent?.text).toBe(displayBody);
		expect(result.details?.truncation).toMatchObject({
			truncatedBy: "lines",
			totalLines: DEFAULT_MAX_LINES + 5,
			outputLines: DEFAULT_MAX_LINES,
			outputBytes: Buffer.byteLength(displayBody),
			firstLineExceedsLimit: false,
			lastLinePartial: false,
		});
		expect(result.details?.meta?.truncation).toMatchObject({
			shownRange: { start: 1, end: DEFAULT_MAX_LINES },
			nextOffset: DEFAULT_MAX_LINES + 1,
		});

		for (const expanded of [false, true]) {
			for (const withDisplayContent of [false, true]) {
				const details = {
					...result.details,
					displayContent: withDisplayContent ? result.details?.displayContent : undefined,
				};
				const legacy: AgentToolResult<ReadToolDetails> = JSON.parse(
					JSON.stringify({
						...result,
						details: { ...details, truncation: { ...details.truncation, content: displayBody } },
					}),
				);
				const options = { expanded, isPartial: false };
				const args = { path: "rows.zip:rows.txt" };
				const current = readToolRenderer.renderResult({ ...result, details }, options, uiTheme, args).render(100);
				const previous = readToolRenderer.renderResult(legacy, options, uiTheme, args).render(100);
				expect(current).toEqual(previous);
				expect(current.map(line => Bun.stripANSI(line)).join("\n")).toContain("row-0001");
			}
		}
	});

	it("keeps in-memory oversized-first-line metadata even when no complete source line fits", async () => {
		const line = "x".repeat(DEFAULT_MAX_BYTES + 1);
		await writeArchive(path.join(root, "wide.zip"), "zip", [["wide.txt", `${line}\nlast`]]);
		const result = persistedResult(await tool.execute("archive-wide", { path: "wide.zip:wide.txt:raw" }));

		expect(textOutput(result)).toBe(line.slice(0, DEFAULT_MAX_BYTES));
		expect(result.details?.displayContent?.text).toBe(line.slice(0, DEFAULT_MAX_BYTES));
		expect(result.details?.truncation).toMatchObject({
			firstLineExceedsLimit: true,
			lastLinePartial: false,
			totalLines: 2,
			totalBytes: DEFAULT_MAX_BYTES + 6,
			outputLines: 0,
			outputBytes: 0,
		});
		expect(result.details?.meta?.truncation).toMatchObject({ partialLine: true, shownRange: { start: 1, end: 1 } });
	});

	it.each(["directory", "archive", "sqlite"] as const)(
		"keeps byte-limited %s listings and statistics without storing a duplicate body",
		async kind => {
			// SQLite bounds each rendered row to 120 columns; 450 names cross the byte cap
			// without hitting its separate 500-table cap. Other listings keep the full names.
			const names = Array.from(
				{ length: 450 },
				(_, index) => `item-${String(index).padStart(4, "0")}-${"x".repeat(110)}`,
			);
			let target: string;
			if (kind === "directory") {
				target = path.join(root, "listing");
				for (const name of names) await Bun.write(path.join(target, name), "");
			} else if (kind === "archive") {
				target = path.join(root, "listing.zip");
				await writeArchive(
					target,
					"zip",
					names.map(name => [name, ""] as const),
				);
			} else {
				target = path.join(root, "listing.sqlite");
				const db = new Database(target);
				try {
					db.transaction(() => {
						for (const name of names) db.run(`CREATE TABLE "${name}" (id INTEGER)`);
					})();
				} finally {
					db.close();
				}
			}

			const result = persistedResult(await tool.execute(`listing-${kind}`, { path: target }));
			const body = textOutput(result);
			expect(body).toMatch(/item-\d{4}-x+/);
			expect(Buffer.byteLength(body)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
			expect(result.details?.truncation).toMatchObject({
				truncatedBy: "bytes",
				totalLines: names.length + (kind === "directory" ? 1 : 0),
				outputLines: body.split("\n").length,
				outputBytes: Buffer.byteLength(body),
				lastLinePartial: false,
			});
			expect(result.details?.truncation?.totalBytes).toBeGreaterThan(DEFAULT_MAX_BYTES);
			expect(result.details?.meta?.truncation).toMatchObject({
				truncatedBy: "bytes",
				outputBytes: Buffer.byteLength(body),
			});
		},
	);
});
