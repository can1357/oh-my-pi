import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { FindTool } from "@oh-my-pi/pi-coding-agent/tools/jfind";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function session(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "tools.xdev": false }),
	};
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

/** The `mode` a find result's details carry, read after checking the details are an object that has one. */
function modeOf(result: { details?: unknown }): unknown {
	const details = result.details;
	return typeof details === "object" && details !== null && "mode" in details ? details.mode : undefined;
}
describe("find, one tool for contents and names", () => {
	let dir: string;
	let find: FindTool;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "find-unified-"));
		await fs.mkdir(path.join(dir, "src"), { recursive: true });
		await Bun.write(path.join(dir, "src", "retry.ts"), "export const MaxRetries = 3;\n");
		await Bun.write(path.join(dir, "src", "notes.md"), "MaxRetries is documented here\n");
		await Bun.write(path.join(dir, "README.md"), "# readme\n");
		find = new FindTool(session(dir));
	});

	afterEach(async () => {
		await removeWithRetries(dir);
	});

	it("matches contents exactly with `pattern` and tags the result as content mode", async () => {
		const result = await find.execute("c1", { pattern: "MaxRetries" });
		expect(text(result)).toContain("retry.ts");
		expect(text(result)).toContain("notes.md");
		expect(modeOf(result)).toBe("content");
	});

	it("limits the files a content search reads with `glob`", async () => {
		const result = await find.execute("c2", { pattern: "MaxRetries", glob: "*.ts" });
		expect(text(result)).toContain("retry.ts");
		expect(text(result)).not.toContain("notes.md");
	});

	it("lists names with `glob` alone and tags the result as names mode", async () => {
		const result = await find.execute("n1", { glob: "**/*.md" });
		expect(text(result)).toContain("README.md");
		expect(text(result)).toContain("notes.md");
		expect(text(result)).not.toContain("retry.ts");
		expect(modeOf(result)).toBe("names");
	});

	it("lists a directory with `path` alone", async () => {
		const result = await find.execute("n2", { path: "src" });
		expect(text(result)).toContain("retry.ts");
	});

	it("says a case-sensitive miss has a differently cased match, and how to find it", async () => {
		const miss = await find.execute("m1", { pattern: "maxretries" });
		expect(text(miss)).toContain("Matches exist ignoring case");
		expect(text(miss)).toContain("`case: false`");
		const hit = await find.execute("m2", { pattern: "maxretries", case: false });
		expect(text(hit)).toContain("retry.ts");
	});

	it("reports no case note when nothing matches in any case", async () => {
		const result = await find.execute("m3", { pattern: "zzz-not-present" });
		expect(text(result)).not.toContain("Matches exist ignoring case");
	});

	it("names the nearest existing directory when the searched path is missing", async () => {
		await expect(find.execute("p1", { pattern: "x", path: "src/nope/deeper.ts" })).rejects.toThrow(
			/Path not found: src\/nope\/deeper\.ts.*`src` exists and holds: .*retry\.ts/s,
		);
	});

	it("suggests the same name in its real case for a miscased path", async () => {
		await expect(find.execute("p2", { pattern: "x", path: "SRC/retry.ts" })).rejects.toThrow(/Did you mean/);
	});

	it("refuses a judged query combined with an exact mode, naming both modes", async () => {
		await expect(find.execute("x1", { query: "where is retry", pattern: "Retries" })).rejects.toThrow(
			/judged search that can miss/,
		);
	});

	it("refuses an empty call by listing the three modes", async () => {
		await expect(find.execute("x2", {})).rejects.toThrow(/`query`[\s\S]*`pattern`[\s\S]*`glob`/);
	});
});
