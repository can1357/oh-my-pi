import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const cwd = path.resolve("/workspace/project");

function restrictionPaths(args: unknown): readonly string[] | undefined {
	const session = { cwd, settings: Settings.isolated() } as ToolSession;
	return new LspTool(session).approvalRestrictionPaths(args);
}

describe("LspTool approvalRestrictionPaths for rename_file", () => {
	it("resolves a bare new_name next to the source, as the rename itself does", () => {
		expect(restrictionPaths({ action: "rename_file", file: "src/deep/old.ts", new_name: "new.ts" })).toEqual([
			path.join(cwd, "src/deep/old.ts"),
			path.join(cwd, "src/deep/new.ts"),
		]);
	});

	it("resolves a new_name with a separator against the working directory", () => {
		expect(restrictionPaths({ action: "rename_file", file: "src/deep/old.ts", new_name: "lib/new.ts" })).toEqual([
			path.join(cwd, "src/deep/old.ts"),
			path.join(cwd, "lib/new.ts"),
		]);
	});

	it("ignores new_name for other actions", () => {
		expect(restrictionPaths({ action: "rename", file: "src/old.ts", new_name: "other" })).toEqual([
			path.join(cwd, "src/old.ts"),
		]);
	});
});
