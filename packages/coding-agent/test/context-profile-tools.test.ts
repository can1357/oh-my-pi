/**
 * Context profiles change tool presentation without changing the enabled
 * capability set. The transport tools always stay native.
 */
import { describe, expect, it } from "bun:test";
import { isMountableUnderXdev } from "@oh-my-pi/pi-coding-agent/tools/xdev";

describe("context-profile tool presentation", () => {
	it("preserves default load-mode behavior under full", () => {
		expect(isMountableUnderXdev({ name: "eval", loadMode: "essential" }, "full")).toBe(false);
		expect(isMountableUnderXdev({ name: "grep", loadMode: "discoverable" }, "full")).toBe(false);
		expect(isMountableUnderXdev({ name: "lsp", loadMode: "discoverable" }, "full")).toBe(true);
	});

	it("keeps editing, search, provider thinking, and interaction-integrated tools native under balanced", () => {
		for (const name of ["read", "write", "bash", "edit", "grep", "glob", "think", "todo", "ask"]) {
			expect(isMountableUnderXdev({ name, loadMode: "essential" }, "balanced")).toBe(false);
		}
		for (const name of ["eval", "task", "web_search", "mcp__server_tool"]) {
			expect(isMountableUnderXdev({ name, loadMode: "essential" }, "balanced")).toBe(true);
		}
	});

	it("keeps transport, provider thinking, and interaction-integrated tools native under aggressive", () => {
		for (const name of ["read", "write", "bash", "think", "todo", "ask"]) {
			expect(isMountableUnderXdev({ name, loadMode: "essential" }, "aggressive")).toBe(false);
		}
		for (const name of ["edit", "grep", "glob", "eval", "task"]) {
			expect(isMountableUnderXdev({ name, loadMode: "essential" }, "aggressive")).toBe(true);
		}
	});
});
