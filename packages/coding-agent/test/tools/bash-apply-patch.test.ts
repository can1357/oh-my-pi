import { describe, expect, it } from "bun:test";
import { applyPatchShellInput } from "@oh-my-pi/pi-coding-agent/tools/bash-apply-patch";

const PATCH = "*** Begin Patch\n*** Update File: a.ts\n@@\n-const a = `$x`;\n+const a = 1;\n*** End Patch";

describe("applyPatchShellInput", () => {
	it("takes a Codex-style patch literally from a heredoc or a quoted argument", () => {
		expect(applyPatchShellInput(`apply_patch <<'EOF'\n${PATCH}\nEOF\n`)).toBe(PATCH);
		expect(applyPatchShellInput(`apply_patch <<EOF\n${PATCH}\nEOF`)).toBe(PATCH);
		expect(applyPatchShellInput(`apply_patch '${PATCH}'`)).toBe(PATCH);
		expect(applyPatchShellInput(`apply_patch "${PATCH.replaceAll("`", "\\`").replaceAll("$", "\\$")}"`)).toBe(PATCH);
	});

	it("tells an unparsable apply_patch call (null) from a command that runs something else (undefined)", () => {
		expect(applyPatchShellInput("apply_patch < fix.patch")).toBeNull();
		expect(applyPatchShellInput("apply_patcher x")).toBeUndefined();
		expect(applyPatchShellInput("git apply fix.patch")).toBeUndefined();
	});
});
