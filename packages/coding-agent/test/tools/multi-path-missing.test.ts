import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { GlobTool } from "../../src/tools/glob";
import { GrepTool } from "../../src/tools/grep";

const testSettings = Settings.isolated();

// Regression for grievances #208 (find) and #209 (search): a multi-path call
// that includes an entry which does not exist on disk must not abort the whole
// lookup. The tool should skip the missing entry and return matches from the
// surviving entries, with a non-fatal "skipped missing paths" notice.

function createTestSession(cwd: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: testSettings,
		...overrides,
	};
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

describe("multi-path tools tolerate missing entries", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-multi-path-missing-"));
		await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
		await Bun.write(path.join(tempDir, "src", "alpha.ts"), "shared-needle alpha\n");
		await Bun.write(path.join(tempDir, "src", "beta.ts"), "shared-needle beta\n");
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
	});

	it("search returns matches from existing paths and reports the missing one", async () => {
		const tool = new GrepTool(createTestSession(tempDir));

		const result = await tool.execute("search-multi-missing", {
			pattern: "shared-needle",
			path: "src/; tests/",
		});

		const text = getText(result);
		const details = result.details as { fileCount?: number; missingPaths?: string[] } | undefined;

		expect(text).toContain("shared-needle alpha");
		expect(text).toContain("shared-needle beta");
		expect(text).toContain("Skipped missing paths: tests/");
		expect(details?.fileCount).toBe(2);
		expect(details?.missingPaths).toEqual(["tests/"]);
	});

	it("search errors only when every path is missing", async () => {
		const tool = new GrepTool(createTestSession(tempDir));

		const promise = tool.execute("search-all-missing", {
			pattern: "shared-needle",
			path: "does-not-exist/; also-missing/",
		});

		await expect(promise).rejects.toThrow(/Path not found.*does-not-exist.*also-missing/s);
	});

	it("find returns matches from existing globs and reports the missing one", async () => {
		const tool = new GlobTool(createTestSession(tempDir), { rootPathAlias: true });

		const result = await tool.execute("find-multi-missing", {
			path: "src/**/*.ts; tests/**/*.ts",
		});

		const text = getText(result);
		const details = result.details as { fileCount?: number; missingPaths?: string[]; files?: string[] } | undefined;

		expect(text).toContain("# src/");
		expect(text).toContain("alpha.ts");
		expect(text).toContain("beta.ts");
		expect(details?.files).toEqual(expect.arrayContaining(["src/alpha.ts", "src/beta.ts"]));
		expect(text).toContain("Skipped missing paths: tests/**/*.ts");
		expect(details?.fileCount).toBe(2);
		expect(details?.missingPaths).toEqual(["tests/**/*.ts"]);
	});

	it("find errors only when every glob's base directory is missing", async () => {
		const tool = new GlobTool(createTestSession(tempDir), { rootPathAlias: true });

		const promise = tool.execute("find-all-missing", {
			path: "nope/**/*.ts; also-nope/**/*.ts",
		});

		await expect(promise).rejects.toThrow(/Path not found.*nope.*also-nope/s);
	});
});
