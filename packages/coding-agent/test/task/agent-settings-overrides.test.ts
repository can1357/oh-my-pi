import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { compileXdevPromoteSet, isMountableUnderXdev } from "@oh-my-pi/pi-coding-agent/tools/xdev";

/**
 * Observable contract: a subagent's effective `tools.xdevPromote` (built by
 * `createSubagentSettings` from parent settings + agent frontmatter override)
 * must drive the `isMountableUnderXdev` mounting decision — not merely echo
 * the supplied value back. A promoted discoverable tool stays top-level; an
 * explicitly empty override remounts it under `xd://`.
 */
describe("createSubagentSettings xdevPromote override drives mounting", () => {
	const discoverableTool = { name: "lsp", loadMode: "discoverable" as const };
	const parent = Settings.isolated({ "tools.xdevPromote": ["lsp"] });

	it("inherits the parent's promotion, keeping the discoverable tool top-level", () => {
		const child = createSubagentSettings(parent);
		const promoted = compileXdevPromoteSet(child.get("tools.xdevPromote"));
		expect(isMountableUnderXdev(discoverableTool, promoted)).toBe(false);
	});

	it("lets an agent frontmatter xdevPromote replace the inherited promotion", () => {
		const child = createSubagentSettings(parent, { "tools.xdevPromote": ["ast_edit"] });
		const promoted = compileXdevPromoteSet(child.get("tools.xdevPromote"));
		// lsp is no longer promoted -> remounts under xd://
		expect(isMountableUnderXdev(discoverableTool, promoted)).toBe(true);
		// ast_edit is promoted instead
		expect(isMountableUnderXdev({ name: "ast_edit", loadMode: "discoverable" }, promoted)).toBe(false);
	});

	it("lets an explicitly empty xdevPromote clear the inherited promotion (remount under xd://)", () => {
		const child = createSubagentSettings(parent, { "tools.xdevPromote": [] });
		const promoted = compileXdevPromoteSet(child.get("tools.xdevPromote"));
		expect(promoted).toBeUndefined();
		expect(isMountableUnderXdev(discoverableTool, promoted)).toBe(true);
	});

	it("keeps readSummarize false and xdevPromote independent overrides", () => {
		const child = createSubagentSettings(parent, {
			"read.summarize.enabled": false,
			"tools.xdevPromote": ["ast_edit"],
		});
		expect(child.get("read.summarize.enabled")).toBe(false);
		const promoted = compileXdevPromoteSet(child.get("tools.xdevPromote"));
		expect(isMountableUnderXdev({ name: "ast_edit", loadMode: "discoverable" }, promoted)).toBe(false);
	});
});
