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
	it("cold revival inherits a parent promotion when the persisted init carries the frozen effective value", () => {
		// Spawn side: nested agent with no xdevPromote frontmatter inherits the
		// parent's promotion; the executor freezes that effective value into
		// session_init (executor.ts `subagentSettings.get("tools.xdevPromote")`).
		const spawned = createSubagentSettings(parent);
		const frozen = spawned.get("tools.xdevPromote");
		expect(frozen).toEqual(["lsp"]);
		// Revival side: persisted-revive replays the frozen value over the root
		// settings. Root settings carry no promotion — replaying raw frontmatter
		// (`undefined`) here would remount `lsp` under xd:// after a restart.
		const root = Settings.isolated();
		const revived = createSubagentSettings(root, { "tools.xdevPromote": frozen });
		const promoted = compileXdevPromoteSet(revived.get("tools.xdevPromote"));
		expect(isMountableUnderXdev(discoverableTool, promoted)).toBe(false);
	});

	it("cold revival from a pre-freeze session file (persisted xdevPromote absent) falls back to global inheritance", () => {
		const root = Settings.isolated();
		// init.xdevPromote === undefined branch in persisted-revive: no override,
		// so the child snapshots root settings, whose default promotes nothing.
		const revived = createSubagentSettings(root);
		const promoted = compileXdevPromoteSet(revived.get("tools.xdevPromote"));
		expect(promoted).toBeUndefined();
		expect(isMountableUnderXdev(discoverableTool, promoted)).toBe(true);
	});
});
