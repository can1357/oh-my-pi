import { describe, expect, test } from "bun:test";
import {
	admitWindowsHeredocCommand,
	shouldEnforceWindowsHeredocDiscipline,
} from "../../src/tools/bash-command-fixup";
import { resolveToolProfile } from "../../src/tools/tool-profiles";

describe("windows heredoc admission", () => {
	test("unrestricted profiles are not rejected", () => {
		const decision = admitWindowsHeredocCommand(
			"cat <<'EOF'\nhello\nEOF",
			undefined,
			"win32",
		);
		expect(decision.allow).toBe(true);
		expect(decision.reasonCode).toBe("allow");
	});

	test("bound windows profiles request enforcement but soft-spot leaves parser gap explicit", () => {
		const profile = resolveToolProfile({ tier: "mid", autonomy: "bound" });
		expect(shouldEnforceWindowsHeredocDiscipline(profile, "win32")).toBe(true);
		expect(shouldEnforceWindowsHeredocDiscipline(profile, "linux")).toBe(false);

		const decision = admitWindowsHeredocCommand(
			"cat <<'EOF'\nhello\nEOF",
			profile,
			"win32",
		);
		// SOFT-SPOT(WIN-HEREDOC-PARSER): no safe native heredoc predicate yet.
		expect(decision.reasonCode).toBe("soft-spot-unenforced");
		expect(decision.recoveryHint).toBe("write script file -> execute file");
		expect(decision.allow).toBe(true);
	});
});
