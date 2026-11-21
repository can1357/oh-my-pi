import { describe, expect, it } from "bun:test";
import { formatLocation } from "@oh-my-pi/pi-coding-agent/lsp/utils";

function definitionAt(uri: string) {
	return {
		uri,
		range: { start: { line: 2902, character: 4 }, end: { line: 2902, character: 18 } },
	};
}

describe("formatLocation across checkouts (issue #12569)", () => {
	it("shows the absolute target checkout for cross-worktree definitions", () => {
		const out = formatLocation(
			definitionAt("file:///c%3A/src/harmonic-analyzer/cad/scripts/_common.py"),
			"C:/src/harmonic-e2e-failure-20260919",
		);
		expect(out).toBe("c:/src/harmonic-analyzer/cad/scripts/_common.py:2903:5");
		expect(out).not.toContain("..");
	});

	it("keeps same-checkout definitions workspace-relative", () => {
		const out = formatLocation(
			definitionAt("file:///c%3A/src/harmonic-analyzer/cad/scripts/_common.py"),
			"C:/src/harmonic-analyzer",
		);
		expect(out).toBe("cad/scripts/_common.py:2903:5");
	});
});
