/**
 * `tools.xdevForceMount` lets a small-context session move an essential or
 * top-level-pinned tool under `xd://`, where its schema leaves every request
 * and `read xd://<tool>` fetches it on demand. The transport invariant from
 * issue #5764 still holds: `read` and `write` can never be demoted.
 */
import { describe, expect, it } from "bun:test";
import { compileToolNameGlobs, isMountableUnderXdev } from "@oh-my-pi/pi-coding-agent/tools/xdev";

describe("tools.xdevForceMount", () => {
	it("leaves presentation unchanged when the list is empty", () => {
		const none = compileToolNameGlobs([]);
		expect(isMountableUnderXdev({ name: "eval", loadMode: "essential" }, none)).toBe(false);
		expect(isMountableUnderXdev({ name: "grep", loadMode: "discoverable" }, none)).toBe(false);
		expect(isMountableUnderXdev({ name: "lsp", loadMode: "discoverable" }, none)).toBe(true);
	});

	it("mounts an essential tool when its name matches", () => {
		const globs = compileToolNameGlobs(["eval", "hub"]);
		expect(isMountableUnderXdev({ name: "eval", loadMode: "essential" }, globs)).toBe(true);
		expect(isMountableUnderXdev({ name: "hub", loadMode: "essential" }, globs)).toBe(true);
		// A name outside the list keeps its declared presentation.
		expect(isMountableUnderXdev({ name: "bash", loadMode: "essential" }, globs)).toBe(false);
	});

	it("mounts a XDEV_KEEP_TOP_LEVEL tool when the user opts in explicitly", () => {
		const globs = compileToolNameGlobs(["grep", "todo", "web_search", "ask"]);
		for (const name of ["grep", "todo", "web_search", "ask"]) {
			expect(isMountableUnderXdev({ name, loadMode: "discoverable" }, globs)).toBe(true);
		}
	});

	it("never demotes the xd:// transport tools, whatever the pattern says", () => {
		const globs = compileToolNameGlobs(["*"]);
		expect(isMountableUnderXdev({ name: "read", loadMode: "essential" }, globs)).toBe(false);
		expect(isMountableUnderXdev({ name: "write", loadMode: "essential" }, globs)).toBe(false);
		// Everything else under the same wildcard does mount.
		expect(isMountableUnderXdev({ name: "edit", loadMode: "essential" }, globs)).toBe(true);
	});

	it("matches glob patterns, not just exact names", () => {
		const globs = compileToolNameGlobs(["mcp__*"]);
		expect(isMountableUnderXdev({ name: "mcp__server_tool", loadMode: "essential" }, globs)).toBe(true);
		expect(isMountableUnderXdev({ name: "bash", loadMode: "essential" }, globs)).toBe(false);
	});

	it("ignores malformed entries instead of throwing", () => {
		const globs = compileToolNameGlobs(["", "eval", 7 as unknown as string]);
		expect(isMountableUnderXdev({ name: "eval", loadMode: "essential" }, globs)).toBe(true);
		expect(isMountableUnderXdev({ name: "bash", loadMode: "essential" }, globs)).toBe(false);
	});
});
