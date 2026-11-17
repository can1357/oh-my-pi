import { expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import type { ToolSession } from "../src/sdk";
import { postProcessToolResult } from "../src/tools/output-meta";
import { buildInMemoryTextResult } from "../src/tools/read-format";
import { cfgToolsArtifactSpillThreshold } from "../src/tools/settings";

for (const { words, count, threshold } of [
	{ words: 20, count: 900, threshold: 50 },
	{ words: 3, count: 3000, threshold: 50 },
	{ words: 20, count: 900, threshold: 20 },
]) {
	test(`in-memory pagination preserves source coordinates (${words} words, ${threshold} KiB)`, async () => {
		const settings = Settings.isolated({ "edit.mode": "hashline", "read.summarize.enabled": false });
		cfgToolsArtifactSpillThreshold.set(settings, threshold);
		const session = { cwd: "/tmp", settings, enableLsp: false } as ToolSession;
		const source = Array.from({ length: count }, (_, i) => `paragraph ${i + 1} ${"evidence ".repeat(words)}`).join(
			"\n",
		);
		let spills = 0;
		const context = {
			settings,
			sessionManager: {
				saveArtifact: async () => {
					spills++;
					return "unexpected";
				},
			},
		} as unknown as Parameters<typeof postProcessToolResult>[2];
		const read = async (offset?: number) =>
			postProcessToolResult(
				await buildInMemoryTextResult(session, source, offset, undefined, {
					details: {},
					sourcePath: "/tmp/converted.pdf",
					entityLabel: "document",
				}),
				"read",
				context,
			);
		const first = await read();
		expect(first.details.totalLines).toBe(count);
		expect(first.details.meta.truncation.totalLines).toBe(count);
		expect(first.details.meta.truncation.direction).toBe("head");
		const next = first.details.meta.truncation.nextOffset;
		expect(next).toBeGreaterThan(1);
		expect(next).toBeLessThan(count);
		const second = await read(next);
		const body = second.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");
		expect(body).toContain(`paragraph ${next} `);
		expect(second.details.meta.truncation.nextOffset).toBeGreaterThan(next);
		expect(spills).toBe(0);
	});
}

test("an in-memory page exceeding the rendered allowance retains the spill fallback", async () => {
	const settings = Settings.isolated({ "edit.mode": "hashline", "read.summarize.enabled": false });
	cfgToolsArtifactSpillThreshold.set(settings, 4);
	const session = { cwd: "/tmp", settings, enableLsp: false } as ToolSession;
	const source = Array.from({ length: 10000 }, () => "").join("\n");
	const page = await buildInMemoryTextResult(session, source, undefined, undefined, {
		details: {},
		sourcePath: "/tmp/converted.pdf",
		entityLabel: "document",
	});
	expect(page.details?.meta?.pagedSource).not.toBe(true);
	let saved = "";
	const result = await postProcessToolResult(page, "read", {
		settings,
		sessionManager: {
			saveArtifact: async (text: string) => {
				saved = text;
				return "bounded";
			},
		},
	} as unknown as Parameters<typeof postProcessToolResult>[2]);
	expect(saved).toBe(
		page.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n"),
	);
	expect(result.details.meta.truncation.artifactId).toBe("bounded");
});

test("formatting slack does not turn a complete in-memory read into an artifact preview", async () => {
	const settings = Settings.isolated({ "edit.mode": "hashline", "read.summarize.enabled": false });
	cfgToolsArtifactSpillThreshold.set(settings, 20);
	const session = { cwd: "/tmp", settings, enableLsp: false } as ToolSession;
	const source = "x".repeat(20 * 1024 - 10);
	const page = await buildInMemoryTextResult(session, source, undefined, undefined, {
		details: {},
		sourcePath: "/tmp/formatting-slack.txt",
		entityLabel: "file",
	});
	const text = page.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
	expect(Buffer.byteLength(text)).toBeGreaterThan(20 * 1024);
	expect(Buffer.byteLength(text)).toBeLessThanOrEqual(22 * 1024);
	let spills = 0;
	const result = await postProcessToolResult(page, "read", {
		settings,
		sessionManager: {
			saveArtifact: async () => {
				spills++;
				return "unexpected";
			},
		},
	} as unknown as Parameters<typeof postProcessToolResult>[2]);
	expect(
		result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n"),
	).toContain(source);
	expect(spills).toBe(0);
});
