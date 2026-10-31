import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

/** Minified JSON — the pretty-printed rendering of it does not contain `"needle":"x"`. */
const MINIFIED_JSON = '{"needle":"x"}';

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

describe("GrepTool external URL selectors", () => {
	let tmpDir: string;
	let server: Bun.Server<undefined> | undefined;
	let url: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-url-"));
		server = Bun.serve({
			port: 0,
			fetch: () => new Response(MINIFIED_JSON, { headers: { "content-type": "application/json" } }),
		});
		url = `http://127.0.0.1:${server.port}/page`;
	});

	afterEach(async () => {
		server?.stop(true);
		server = undefined;
		await removeWithRetries(tmpDir);
	});

	function createSession(): ToolSession {
		return {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => tmpDir,
			settings: Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 }),
		};
	}

	it("searches the verbatim response body when the URL carries the :raw selector (issue #14092)", async () => {
		const tool = new GrepTool(createSession());

		// `:raw` must reach the fetch: the minified body matches, while the
		// rendered (pretty-printed) body does not contain the same bytes.
		const raw = await tool.execute("raw", { pattern: '"needle":"x"', path: `${url}:raw` });
		expect(getResultText(raw)).toContain(MINIFIED_JSON);

		const rendered = await tool.execute("rendered", { pattern: '"needle":"x"', path: url });
		expect(getResultText(rendered)).toContain("No matches found");
	});

	it("uses grep body line numbers for URL read ranges", async () => {
		server?.stop(true);
		const body = `${Array.from({ length: 20 }, (_, i) =>
			i === 11 ? "REMAINING_TARGET_LINE" : `BODY_LINE_${i + 1}`,
		).join("\n")}\n`;
		server = Bun.serve({
			port: 0,
			fetch: () => new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } }),
		});
		url = `http://127.0.0.1:${server.port}/source.txt`;
		const session = createSession();
		const match = getResultText(
			await new GrepTool(session).execute("grep", { pattern: "REMAINING_TARGET_LINE", path: url }),
		);
		const read = new ReadTool(session);
		const selected = getResultText(await read.execute("read", { path: `${url}:12:raw` }));
		const ranged = getResultText(await read.execute("range", { path: `${url}:11-13:raw` }));

		expect(match).toContain("*12|REMAINING_TARGET_LINE");
		expect(selected).toBe("REMAINING_TARGET_LINE");
		expect(ranged).toBe("BODY_LINE_11\nREMAINING_TARGET_LINE\nBODY_LINE_13");
	});

	it("searches the whole fetched resource when the URL carries the :conflicts selector", async () => {
		const tool = new GrepTool(createSession());

		const result = await tool.execute("conflicts", { pattern: '"needle"', path: `${url}:conflicts` });
		expect(getResultText(result)).toContain("needle");
	});

	it("still rejects a URL tail selector that cannot filter matches by line number", async () => {
		const tool = new GrepTool(createSession());

		await expect(tool.execute("tail", { pattern: "needle", path: `${url}:-5` })).rejects.toThrow(/invalid selector/i);
		await expect(tool.execute("tail-conflicts", { pattern: "needle", path: `${url}:-5:conflicts` })).rejects.toThrow(
			/invalid selector/i,
		);
	});

	it("keeps a line range that precedes :conflicts as a match filter", async () => {
		const tool = new GrepTool(createSession());

		// The rendered body puts the match on line 2: a 1-1 range excludes it, a 2-2 range keeps it.
		const outside = await tool.execute("range-conflicts", { pattern: "needle", path: `${url}:1-1:conflicts` });
		expect(getResultText(outside)).not.toContain("needle");
		const inside = await tool.execute("range-conflicts-hit", { pattern: "needle", path: `${url}:2-2:conflicts` });
		expect(getResultText(inside)).toContain("needle");
	});

	it("fetches an archive-named URL with :raw instead of opening it as a local archive member", async () => {
		const tool = new GrepTool(createSession());

		// The `:raw` request is fetched like the bare URL, not parsed as archive `bundle.zip` + member `raw`.
		const raw = await tool.execute("archive-url-raw", { pattern: "needle", path: `${url}/bundle.zip:raw` });
		const bare = await tool.execute("archive-url", { pattern: "needle", path: `${url}/bundle.zip` });
		expect(getResultText(raw)).toBe(getResultText(bare));
	});

	// `:` is not allowed in Windows file names.
	it.skipIf(process.platform === "win32")(
		"searches a literal file named like a host with a selector rather than fetching the host",
		async () => {
			await Bun.write(path.join(tmpDir, "www.example.com:conflicts"), "local needle\n");
			const tool = new GrepTool(createSession());

			const result = await tool.execute("literal", { pattern: "needle", path: "www.example.com:conflicts" });
			expect(getResultText(result)).toContain("local needle");
		},
	);
});
