import { describe, expect, it } from "bun:test";
import { getThemeByName } from "../src/theme";
import type { DefaultToolRenderInput } from "../src/tools/default-renderer";
import { describeDefaultToolExecution, formatDefaultToolExecution } from "../src/tools/default-renderer";
import type { RenderResultOptions } from "../src/tools/renderer";

/** A generic (MCP/custom/extension) tool call that fell through to the fallback card. */
function mcpResult(output: string, expanded: boolean): DefaultToolRenderInput {
	return {
		label: "srv/mcp_tool",
		args: { query: "tokyo" },
		result: { output, isError: false },
		options: { expanded, isPartial: false } satisfies RenderResultOptions,
	};
}

describe("generic fallback card", () => {
	it("expands past 12 lines — Ctrl+O reveals the whole output", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		// 40 numbered rows: well past both the 12-row expanded cap and the 4-row collapsed window.
		const rows = Array.from({ length: 40 }, (_, i) => `row-${i}`);

		const collapsed = Bun.stripANSI(formatDefaultToolExecution(mcpResult(rows.join("\n"), false), 80, theme));
		expect(collapsed).toContain("row-0");
		expect(collapsed).toContain("row-3");
		expect(collapsed).not.toContain("row-10");

		const expanded = Bun.stripANSI(formatDefaultToolExecution(mcpResult(rows.join("\n"), true), 80, theme));
		// One exact ordered assertion: every row on its own line, no missing, extra, or reordered rows.
		expect(expanded.split("\n").slice(5).map(row => row.trimEnd())).toEqual(rows);
		expect(expanded).toContain("row-39");
		expect(expanded).not.toMatch(/more lines/);
	});

	it("keeps a >64 KiB result whole in the native view — no pre-slice before the terminal clamp", () => {
		// 100 KiB of newline-joined text: past the old 64 KiB construction-time cut.
		const rows = Array.from({ length: 4096 }, (_, i) => `line-${i}-${"x".repeat(20)}`);
		const output = `${rows.join("\n")}\n`;
		expect(output.length).toBeGreaterThan(64 * 1024);

		const view = describeDefaultToolExecution(mcpResult(output, false));
		const body = view.body ?? [];
		expect(body).toHaveLength(1);
		const child = body[0];
		expect(child !== undefined && "k" in child && child.k).toBe("ansi");
		const props = child && "k" in child ? child.p : undefined;
		const text = props && "text" in props ? props.text : undefined;
		expect(typeof text).toBe("string");
		// Every byte survives construction; the terminal's disclosure clamp is the only bound.
		expect(text).toBe(output.trimEnd());
		expect(text?.length).toBeGreaterThan(64 * 1024);
		expect(text?.endsWith(`line-4095-${"x".repeat(20)}`)).toBe(true);
	});

	it("routes JSON by size — the tree below 64 KiB, the lossless raw text above it", () => {
		// describeJsonTree clips every string scalar at 2,000 chars and the whole tree
		// at 200 rows, so a payload past that budget could never expand to as much as
		// the raw view shows; it has to keep the raw path instead of the tree.
		const small = JSON.stringify({ query: "tokyo", hits: [1, 2, 3] });
		const smallChild = (describeDefaultToolExecution(mcpResult(small, true)).body ?? [])[0];
		expect(smallChild !== undefined && "k" in smallChild && smallChild.k).toBe("tree");

		const large = JSON.stringify({ blob: "x".repeat(100 * 1024) });
		expect(large.length).toBeGreaterThan(64 * 1024);
		const largeChild = (describeDefaultToolExecution(mcpResult(large, true)).body ?? [])[0];
		expect(largeChild !== undefined && "k" in largeChild && largeChild.k).toBe("ansi");
		const props = largeChild && "k" in largeChild ? largeChild.p : undefined;
		const text = props && "text" in props ? props.text : undefined;
		expect(text).toBe(large);
	});
});
