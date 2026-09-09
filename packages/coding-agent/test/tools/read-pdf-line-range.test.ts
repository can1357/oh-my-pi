/**
 * Regression test for cluster 51: line-range selectors on PDF/document
 * reads silently returned the head of the converted document. The fix
 * routes the converted markdown through the same in-memory builders that
 * notebook reads use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Markit } from "@oh-my-pi/pi-coding-agent/markit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as markit from "@oh-my-pi/pi-coding-agent/utils/markit";
import { __resetDirsFromEnvForTests, removeSyncWithRetries, Snowflake, setAgentDir } from "@oh-my-pi/pi-utils";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

function makeSession(testDir: string): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	let nextArtifactId = 0;
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		allocateOutputArtifact: async toolType => {
			const id = String(nextArtifactId++);
			return { id, path: path.join(artifactsDir, `${id}.${toolType}.log`) };
		},
		settings: Settings.isolated(),
	};
}

describe("read PDF with a line-range selector", () => {
	let testDir: string;
	let pdfPath: string;
	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `read-pdf-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
		pdfPath = path.join(testDir, "doc.pdf");
		fs.writeFileSync(pdfPath, "%PDF-stub");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(testDir);
	});

	it("honours `:N-M` against the converted markdown body", async () => {
		const converted = Array.from({ length: 200 }, (_, i) => `pdf line ${i + 1}`).join("\n");
		vi.spyOn(markit, "convertFileWithMarkit").mockResolvedValue({ ok: true, content: converted });

		const session = makeSession(testDir);
		const tool = new ReadTool(session);
		const result = await tool.execute("call", { path: `${pdfPath}:120-122` });
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");

		// The requested window must surface. Pre-fix the read silently returned
		// the head of the document (lines 1-200 head-truncated) instead.
		expect(text).toContain("pdf line 120");
		expect(text).toContain("pdf line 122");
		expect(text).not.toContain("pdf line 1\n");
		expect(text).not.toContain("pdf line 5");
	});

	it("honours `:A-B,C-D` multi-range against the converted markdown body", async () => {
		const converted = Array.from({ length: 200 }, (_, i) => `pdf line ${i + 1}`).join("\n");
		vi.spyOn(markit, "convertFileWithMarkit").mockResolvedValue({ ok: true, content: converted });

		const session = makeSession(testDir);
		const tool = new ReadTool(session);
		const result = await tool.execute("call", { path: `${pdfPath}:50-52,160-162` });
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");

		expect(text).toContain("pdf line 50");
		expect(text).toContain("pdf line 52");
		expect(text).toContain("pdf line 160");
		expect(text).toContain("pdf line 162");
		expect(text).not.toContain("pdf line 100");
	});

	it("falls back to the full converted body when no selector is provided", async () => {
		const converted = "pdf line 1\npdf line 2\npdf line 3\n";
		vi.spyOn(markit, "convertFileWithMarkit").mockResolvedValue({ ok: true, content: converted });

		const session = makeSession(testDir);
		const tool = new ReadTool(session);
		const result = await tool.execute("call", { path: pdfPath });
		const text = result.content
			.filter(c => c.type === "text")
			.map(c => c.text)
			.join("\n");

		expect(text).toContain("pdf line 1");
		expect(text).toContain("pdf line 3");
	});

	it("reuses cached converted markdown across full and selector reads of an unchanged PDF", async () => {
		const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
		const originalOmpProfile = process.env.OMP_PROFILE;
		const originalPiProfile = process.env.PI_PROFILE;
		setAgentDir(path.join(testDir, "agent"));
		try {
			const convert = vi
				.spyOn(Markit.prototype, "convert")
				.mockResolvedValue({ markdown: "pdf line 1\npdf line 2\npdf line 3\n" });

			const tool = new ReadTool(makeSession(testDir));

			const full = await tool.execute("full", { path: pdfPath });
			const fullText = full.content
				.filter(c => c.type === "text")
				.map(c => c.text)
				.join("\n");
			expect(fullText).toContain("pdf line 1");
			expect(fullText).toContain("pdf line 3");

			const selector = await tool.execute("selector", { path: `${pdfPath}:2-3` });
			const selectorText = selector.content
				.filter(c => c.type === "text")
				.map(c => c.text)
				.join("\n");
			expect(selectorText).toContain("pdf line 2");
			expect(selectorText).toContain("pdf line 3");

			expect(convert).toHaveBeenCalledTimes(1);
		} finally {
			restoreEnv("PI_CODING_AGENT_DIR", originalPiCodingAgentDir);
			restoreEnv("OMP_PROFILE", originalOmpProfile);
			restoreEnv("PI_PROFILE", originalPiProfile);
			__resetDirsFromEnvForTests();
		}
	});
});
