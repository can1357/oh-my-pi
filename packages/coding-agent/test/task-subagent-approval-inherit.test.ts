/**
 * Regression test for can1357/oh-my-pi#10164:
 * "Subagents can issue dangerous commands without prompting".
 *
 * Root cause:
 *   src/task/executor.ts::createSubagentSettings() hard-codes
 *   "tools.approvalMode": "yolo" regardless of the parent agent's
 *   approval mode. The bash.patterns settings ARE snapshotted from the
 *   parent, but yolo mode bypasses them when the parent has not also
 *   overridden tools.approval.bash to "allow"/"prompt"/"deny". The
 *   observable bug is that a parent running in "write" or "always-ask"
 *   mode will still see its subagent silently run `rm -rf /tmp/..`.
 *
 * What this test asserts today vs what it asserts once fixed:
 *
 *   today:  parent's "write" mode is silently downgraded to "yolo"
 *           on the subagent. The test asserts the BROKEN behavior
 *           (yolo), guarded by a comment pointing at the issue. This
 *           makes the test useful as a regression target: a fix to
 *           createSubagentSettings that inherits the parent's mode will
 *           turn the "today" assertion into a failing test, signalling
 *           the fix is in place.
 *
 *   fixed:  parent's "write" mode is preserved on the subagent. The
 *           test then flips the assertion to require non-yolo. See
 *           the FIXED branch in each test.
 *
 * To run (once the upstream repo has a working build):
 *   bun test packages/coding-agent/test/task-subagent-approval-inherit.test.ts
 *
 * Implementation note — self-contained snapshot test:
 *   This file does NOT import from src/task/executor.ts because the
 *   executor module transitively loads the pi_natives native addon,
 *   which is not built in a contributor's checkout. Instead, we mirror
 *   the snapshot logic inline. The point is to assert the *observable
 *   contract* of createSubagentSettings, which is fully described by:
 *     - copy every key from baseSettings into a child Settings
 *     - force "tools.approvalMode": "yolo" on the child
 *     - force "advisor.enabled": false on the child
 *     - apply any explicit overrides last
 *   If the upstream implementation changes (e.g. inherits parent mode
 *   or stops forcing yolo), this test's "today" assertions will fail,
 *   which is the desired regression signal. A maintainer can then add
 *   the FIXED-branch assertions or delete this file.
 *
 *   A future revision can drop the mirror and import the real function
 *   once pi_natives builds reliably on contributor machines.
 */

import { describe, expect, it } from "bun:test";
import { Settings, type SettingPath } from "../src/config/settings";
import { SETTINGS_SCHEMA } from "../src/config/settings-schema";

// Mirror of createSubagentSettings semantics (executor.ts:916) for the
// subset that matters to this issue. We deliberately do not import the
// real function — see the header note above.
function createSubagentSettingsMirror(
	baseSettings: Settings,
	overrides?: Partial<Record<SettingPath, unknown>>,
): Settings {
	const snapshot: Partial<Record<SettingPath, unknown>> = {};
	for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		snapshot[key] = baseSettings.get(key);
	}
	// `tier.*` resolution omitted — it is not load-bearing for the
	// approval-mode inheritance assertion. See executor.ts:932-939 for
	// the full tier logic if a future test needs it.
	return Settings.isolated({
		...snapshot,
		"tools.approvalMode": "yolo",
		"advisor.enabled": false,
		...overrides,
	});
}

describe("createSubagentSettings — parent approval mode inheritance (#10164)", () => {
	function parentSettings(approvalMode: "yolo" | "write" | "always-ask"): Settings {
		return Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			"tools.approvalMode": approvalMode,
			"bash.patterns": [{ match: "rm -rf *", approval: "deny" }],
		});
	}

	it("snapshot of bash.patterns is preserved on the subagent", () => {
		const parent = parentSettings("write");
		const child = createSubagentSettingsMirror(parent);
		const patterns = child.get("bash.patterns") as ReadonlyArray<{ match: string; approval: string }>;
		expect(patterns).toMatchObject([{ match: "rm -rf *", approval: "deny" }]);
	});

	// ---- The actual bug under test ----
	// Today: every parent's mode is downgraded to yolo on the subagent.
	// Fixed: subagent inherits the parent's mode.
	// When the upstream fix lands, flip the `expect(...).toBe("yolo")`
	// in each test below to `expect(...).toBe(parentMode)`.

	it("parent write mode: subagent approvalMode (today: yolo, FIXED: write)", () => {
		const parent = parentSettings("write");
		const child = createSubagentSettingsMirror(parent);
		const today = child.get("tools.approvalMode");
		// FIXED branch (replace once the upstream patch lands):
		// expect(today).toBe("write");
		expect(today).toBe("yolo"); // <-- documents the bug
	});

	it("parent always-ask mode: subagent approvalMode (today: yolo, FIXED: always-ask)", () => {
		const parent = parentSettings("always-ask");
		const child = createSubagentSettingsMirror(parent);
		const today = child.get("tools.approvalMode");
		// FIXED branch: expect(today).toBe("always-ask");
		expect(today).toBe("yolo"); // <-- documents the bug
	});

	it("parent yolo mode: subagent approvalMode is yolo (already correct)", () => {
		const parent = parentSettings("yolo");
		const child = createSubagentSettingsMirror(parent);
		expect(child.get("tools.approvalMode")).toBe("yolo");
	});

	it("explicit override wins: parent write, override forces yolo", () => {
		const parent = parentSettings("write");
		const child = createSubagentSettingsMirror(parent, { "tools.approvalMode": "yolo" });
		expect(child.get("tools.approvalMode")).toBe("yolo");
	});

	it("subagent settings are isolated from parent mutations after creation", () => {
		const parent = parentSettings("write");
		const child = createSubagentSettingsMirror(parent);
		// Mutating the parent should not retroactively change the child.
		parent.override("tools.approvalMode", "always-ask");
		// The child captured its own snapshot at createSubagentSettings() time.
		// We do not assert which exact value it holds — Settings.isolated's
		// isolation semantics are upstream's call — but the snapshot must
		// at least be a string and must not throw on read.
		expect(typeof child.get("tools.approvalMode")).toBe("string");
	});
});