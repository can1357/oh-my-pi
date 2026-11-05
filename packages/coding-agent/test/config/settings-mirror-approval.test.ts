import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { readUserApprovalPolicies, userApprovalPolicy } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

/** The mirror source a worker holds: every write and disk operation runs on the main instance. */
function mirrorSource(target: Settings) {
	return {
		write: () => target.mirrorState(),
		refresh: () => Promise.resolve(target.mirrorState()),
		cloneForCwd: (cwd: string) => Promise.resolve(target.cloneForCwd(cwd)),
	};
}

/**
 * A worker mirror reads the layers after their rejected values were dropped, so the rejection
 * records travel with the state. These check that an unreadable `tools.approval` reaches a worker —
 * where unset is permissive, so losing it runs calls unasked — and that repairing the file reaches
 * it too, including through a child mirror, which must read its parent's rejection live.
 */
describe("tools.approval across worker settings mirrors", () => {
	// A sibling file in this directory resets the registry; start from a known state either way.
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("asks in a worker and in its child under an unreadable global tools.approval, and allows again once repaired", async () => {
		using dir = TempDir.createSync("@pi-approval-mirror-");
		const agentDir = dir.join("agent");
		const file = path.join(agentDir, "config.yml");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const write = (value: unknown) => fs.writeFileSync(file, YAML.stringify({ tools: { approval: value } }));
		write("deny-bash");
		const source = await Settings.init({ cwd: dir.path(), agentDir });
		expect(userApprovalPolicy(readUserApprovalPolicies(source), "bash")).toMatchObject({
			policy: "prompt",
			unreadable: true,
		});

		const root = Settings.mirror(mirrorSource(source), source.mirrorState());
		const childSource = source.overlay({});
		const child = Settings.mirror(mirrorSource(childSource), childSource.mirrorState(), root);
		for (const instance of [root, child]) {
			expect(userApprovalPolicy(readUserApprovalPolicies(instance), "bash")).toMatchObject({
				policy: "prompt",
				unreadable: true,
			});
		}

		// Repairing the file must reach the worker as it reaches the main session: a child that
		// froze its parent's record would keep asking until it was restarted.
		write({ bash: "allow" });
		await source.reloadFromDisk();
		root.applyMirrorState(source.mirrorState());
		for (const instance of [source, root, child]) {
			expect(userApprovalPolicy(readUserApprovalPolicies(instance), "bash")).toEqual({
				policy: "allow",
				key: "bash",
			});
		}
	});
});
