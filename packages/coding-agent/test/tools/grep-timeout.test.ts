import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type GrepMatch, type GrepOptions, type GrepResult, grep } from "@oh-my-pi/pi-natives";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { GrepTool } from "../../src/tools/grep";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

function hit(file: string, lineNumber: number, line: string): GrepMatch {
	return { path: file, lineNumber, line };
}

function found(matches: GrepMatch[], extra: Partial<GrepResult> = {}): GrepResult {
	return {
		matches,
		totalMatches: matches.length,
		filesWithMatches: new Set(matches.map(match => match.path)).size,
		filesSearched: matches.length,
		...extra,
	};
}

describe("grep timeout", () => {
	let cwd: string;
	let session: ToolSession;

	beforeEach(async () => {
		cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-grep-timeout-")));
		session = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("returns the matches found before the timeout, marked partial", async () => {
		await Bun.write(path.join(cwd, "a.txt"), "needle one\n");
		const tool = new GrepTool(session, {
			timeoutMs: 2_000,
			nativeGrep: async () => found([hit("a.txt", 1, "needle one")], { timedOut: true }),
		});

		const result = await tool.execute("partial", { pattern: "needle", path: "." });

		const text = textOf(result);
		expect(text).toContain("needle one");
		expect(text).toContain("Grep timed out after 2s; results are partial");
		expect(result.details?.timedOut).toBe(true);
		expect(result.details?.truncated).toBe(true);
		expect(result.details?.matchCount).toBe(1);
	});

	it("says no match was found before the timeout instead of failing", async () => {
		await Bun.write(path.join(cwd, "a.txt"), "hay\n");
		const tool = new GrepTool(session, {
			nativeGrep: async () => found([], { timedOut: true }),
		});

		const text = textOf(await tool.execute("none", { pattern: "needle", path: "." }));

		expect(text).toContain("No matches found before the timeout");
		expect(text).toContain("Grep timed out after 30s; results are partial");
	});

	it("reports a search that could not stop in time as partial, not as an error", async () => {
		await Bun.write(path.join(cwd, "a.txt"), "needle\n");
		const tool = new GrepTool(session, {
			nativeGrep: async () => {
				throw new Error("GenericFailure, Aborted: Timeout");
			},
		});

		const text = textOf(await tool.execute("backstop", { pattern: "needle", path: "." }));

		expect(text).toContain("No matches found before the timeout");
		expect(text).toContain("results are partial");
	});

	it("keeps the earlier targets' matches and stops at the target that timed out", async () => {
		for (const name of ["one", "two", "three"]) {
			await Bun.write(path.join(cwd, name, "f.txt"), `needle ${name}\n`);
		}
		const searched: string[] = [];
		const tool = new GrepTool(session, {
			nativeGrep: async (options: GrepOptions) => {
				const target = path.basename(options.path);
				searched.push(target);
				const match = hit("f.txt", 1, `needle ${target}`);
				return target === "two" ? found([match], { timedOut: true }) : found([match]);
			},
		});

		const result = await tool.execute("multi", { pattern: "needle", path: "one;two;three" });

		const text = textOf(result);
		expect(searched).toEqual(["one", "two"]);
		expect(text).toContain("needle one");
		expect(text).toContain("needle two");
		expect(text).not.toContain("needle three");
		expect(text).toContain("results are partial");
	});

	it("keeps the earlier targets' matches when a later target cannot stop in time", async () => {
		for (const name of ["one", "two"]) {
			await Bun.write(path.join(cwd, name, "f.txt"), `needle ${name}\n`);
		}
		const tool = new GrepTool(session, {
			nativeGrep: async (options: GrepOptions) => {
				if (path.basename(options.path) === "two") throw new Error("Aborted: Timeout");
				return found([hit("f.txt", 1, "needle one")]);
			},
		});

		const text = textOf(await tool.execute("multi-backstop", { pattern: "needle", path: "one;two" }));

		expect(text).toContain("needle one");
		expect(text).toContain("results are partial");
	});

	it("returns partial native results from a real tree that outlasts the budget", async () => {
		// Enough files that the walk cannot finish within a millisecond.
		for (let dir = 0; dir < 40; dir++) {
			await Promise.all(
				Array.from({ length: 100 }, (_, file) =>
					Bun.write(path.join(cwd, `d${String(dir).padStart(2, "0")}`, `f${file}.txt`), "needle\n"),
				),
			);
		}
		const direct = await grep({ pattern: "needle", path: cwd, timeoutMs: 1 });
		expect(direct.timedOut).toBe(true);
		expect(direct.filesSearched).toBeLessThan(4_000);

		const tool = new GrepTool(session, { timeoutMs: 1 });
		const result = await tool.execute("native", { pattern: "needle", path: "." });
		expect(result.details?.timedOut).toBe(true);
		expect(textOf(result)).toContain("results are partial");
	});

	it("finds a match past 4 MB in a directory search, and names a file a multiline search read in part", async () => {
		const filler = "filler line of haystack text\n".repeat(160_000);
		await Bun.write(path.join(cwd, "big.txt"), `needle head\n${filler}needle tail\nend marker\n`);
		const tool = new GrepTool(session);

		const whole = await tool.execute("large", { pattern: "needle tail", path: "." });
		expect(textOf(whole)).toContain("needle tail");
		expect(textOf(whole)).not.toContain("Searched only part");

		const multiline = await tool.execute("large-multiline", { pattern: "needle tail\nend", path: "." });
		const text = textOf(multiline);
		expect(text).toContain("Searched only part of these files");
		expect(text).toContain("big.txt");
	});
});
