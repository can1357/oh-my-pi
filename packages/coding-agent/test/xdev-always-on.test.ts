import { describe, expect, it } from "bun:test";
import { compileXdevGlobs, isMountableUnderXdev, isXdevAlwaysOn } from "@oh-my-pi/pi-coding-agent/tools/xdev";

const discoverable = (name: string) => ({ name, loadMode: "discoverable" as const });

describe("tools.xdevAlwaysOn predicate", () => {
	it("matches tool names against the compiled globs", () => {
		const globs = compileXdevGlobs(["mcp__server_alpha_*"]);
		expect(isXdevAlwaysOn("mcp__server_alpha_run", globs)).toBe(true);
		expect(isXdevAlwaysOn("mcp__server_beta_other", globs)).toBe(false);
		expect(isXdevAlwaysOn("mcp__server_alpha", globs)).toBe(false);
	});

	it("pins a matching discoverable tool top-level and leaves the rest mountable", () => {
		const globs = compileXdevGlobs(["mcp__server_alpha_*"]);
		expect(isMountableUnderXdev(discoverable("mcp__server_alpha_run"), globs)).toBe(false);
		expect(isMountableUnderXdev(discoverable("mcp__server_beta_other"), globs)).toBe(true);
	});

	it("is a no-op when the setting is empty or unset", () => {
		expect(isMountableUnderXdev(discoverable("mcp__server_alpha_run"))).toBe(true);
		expect(isMountableUnderXdev(discoverable("mcp__server_alpha_run"), compileXdevGlobs([]))).toBe(true);
	});

	it("supports several patterns and exact names", () => {
		const globs = compileXdevGlobs(["mcp__server_alpha_*", "lsp"]);
		expect(isMountableUnderXdev(discoverable("lsp"), globs)).toBe(false);
		expect(isMountableUnderXdev(discoverable("mcp__server_alpha_run"), globs)).toBe(false);
		expect(isMountableUnderXdev(discoverable("browser"), globs)).toBe(true);
	});

	it("ignores malformed pattern entries instead of throwing", () => {
		const malformed = ["", 7, null, "mcp__server_alpha_*"] as unknown as string[];
		const globs = compileXdevGlobs(malformed);
		expect(globs).toHaveLength(1);
		expect(isXdevAlwaysOn("mcp__server_alpha_run", globs)).toBe(true);
		expect(compileXdevGlobs("mcp__server_alpha_*" as unknown as string[])).toEqual([]);
	});

	it("keeps the xd:// transport tools unmountable regardless", () => {
		expect(isMountableUnderXdev(discoverable("read"), compileXdevGlobs(["nothing"]))).toBe(false);
		expect(isMountableUnderXdev(discoverable("write"))).toBe(false);
	});
});
