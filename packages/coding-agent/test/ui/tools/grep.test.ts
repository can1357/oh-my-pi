import { describe, expect, it } from "bun:test";
import "../../../src/ui/styles/tools/grep";
import { grepPresenter, parseGrepOutput } from "../../../src/ui/tools/grep";
import { toolScreenSuite } from "./presenter-corpus";

toolScreenSuite("grep", "grep", grepPresenter);

describe("parseGrepOutput", () => {
	it("resolves file headers at any depth against the directory chain above them", () => {
		const output = [
			"# AGENTS.md",
			"*57│top-level file",
			"",
			"# services/",
			"",
			"## src/icr/",
			"### server.py",
			"*178│nested match",
			"    │...",
			" 180│context",
		].join("\n");
		expect(parseGrepOutput(output).map(group => [group.path, group.lines.map(line => line.line)])).toEqual([
			["AGENTS.md", [57]],
			["services/src/icr/server.py", [178, 180]],
		]);
	});
});
