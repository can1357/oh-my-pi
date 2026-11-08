import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgTemperature } from "@oh-my-pi/pi-coding-agent/session/settings";
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

	it("reports the project layer as written on a worker mirror, rejected values included", async () => {
		// `getProjectSettings` answers "what does the project file say", which the merged layers can no
		// longer tell: a rejected value is dropped as the file loads. A worker that saw `{}` instead
		// would overwrite a project-owned compaction threshold it was meant to leave alone
		// (`session/model-compaction-threshold.ts`), and the legacy `SettingsManager` shim reads it too.
		using dir = TempDir.createSync("@pi-approval-mirror-project-");
		const written = { compaction: { modelThresholds: { "a/b": "80%" } } };
		fs.mkdirSync(dir.join(".omp"), { recursive: true });
		fs.writeFileSync(dir.join(".omp/config.yml"), YAML.stringify(written));
		const source = await Settings.init({ cwd: dir.path(), agentDir: dir.join("agent") });
		expect(source.getProjectSettings()).toMatchObject(written);

		const mirror = Settings.mirror(mirrorSource(source), source.mirrorState());
		expect(mirror.getProjectSettings()).toEqual(source.getProjectSettings());
	});

	it("names the file an ignored value came from on a worker mirror, and lists it once", async () => {
		// A mirror opens no config file of its own. Without the main instance's paths it reports the
		// same rejected value twice — once as carried, once with no source — and logs the second with
		// no file to go and fix.
		using dir = TempDir.createSync("@pi-approval-mirror-source-");
		const agentDir = dir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		const global = path.join(agentDir, "config.yml");
		fs.writeFileSync(global, YAML.stringify({ tools: { approval: "deny-bash" }, temperature: "warm" }));
		const source = await Settings.init({ cwd: dir.path(), agentDir });
		// A rejected value outside an approval setting is recorded when its setting is first read.
		cfgTemperature.get(source);
		const listed = (settings: Settings) =>
			settings
				.ignoredValues()
				.map(({ setting, source: file }) => `${setting.id}@${file ?? "<none>"}`)
				.sort();
		expect(listed(source)).toEqual([`temperature@${global}`, `tools.approval@${global}`]);

		const mirror = Settings.mirror(mirrorSource(source), source.mirrorState());
		expect(listed(mirror)).toEqual(listed(source));
	});

	it("names the config file its main instance read when a worker reports a bad shellPath", async () => {
		// The same class again: `#shellPathSource` fell back to the default `config.yml`, so a worker
		// told someone to fix a file that does not exist when the main instance read `config.yaml`.
		using dir = TempDir.createSync("@pi-approval-mirror-shell-");
		const agentDir = dir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		const legacy = path.join(agentDir, "config.yaml");
		fs.writeFileSync(legacy, YAML.stringify({ shellPath: dir.join("no-such-shell") }));
		const source = await Settings.init({ cwd: dir.path(), agentDir });
		// A shell that does not exist makes the guidance name the file to edit.
		const guidance = (settings: Settings) => {
			try {
				settings.getShellConfig();
			} catch (error) {
				return String(error);
			}
			throw new Error("expected a missing shell to be reported");
		};
		expect(guidance(source)).toContain(`Please update shellPath in ${legacy}`);

		const mirror = Settings.mirror(mirrorSource(source), source.mirrorState());
		expect(guidance(mirror)).toBe(guidance(source));
	});
});
