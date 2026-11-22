/**
 * Contract: a config layer that names an unknown path token (`${HOME}`) fails the load with a
 * {@link ConfigError} that names the file that supplied the value and the setting. Nothing is
 * loaded in its place: the entry is not dropped. For settings whose layers merge (records), the
 * error names the layer and file whose own entries fail, never a layer or file that did not
 * contribute the failing value.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ConfigError } from "@oh-my-pi/pi-coding-agent/config/config-file";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initSandboxSettings } from "../helpers/sandbox-test-state";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const BAD_LAYER = { sandbox: { filesystem: { allowWrite: ["${HOME}/x"] } } };

let state: SettingsTestState | undefined;
let scratch: TempDir;
let root: string;
let workspace: string;
let agentDir: string;

beforeEach(() => {
	state = beginSettingsTest();
	scratch = TempDir.createSync("@omp-settings-load-path-token-");
	root = fs.realpathSync(scratch.path());
	workspace = path.join(root, "workspace");
	agentDir = path.join(root, "agent");
	for (const dir of [workspace, agentDir]) fs.mkdirSync(dir);
});

afterEach(() => {
	restoreSettingsTestState(state);
	state = undefined;
	scratch.removeSync();
});

/** The error a load raises: the load must reject, so this fails when nothing is thrown. */
async function expectLoadError(load: () => Promise<Settings>): Promise<ConfigError> {
	try {
		await load();
	} catch (error) {
		if (error instanceof ConfigError) return error;
		throw new Error(`expected a ConfigError, got: ${String(error)}`);
	}
	throw new Error("expected the load to fail");
}

describe("settings load with an unknown path token", () => {
	it("names the project config file and the setting when the bad token comes from the project layer", async () => {
		const error = await expectLoadError(() =>
			initSandboxSettings({ agentDir, workspace }, { project: BAD_LAYER.sandbox }),
		);

		expect(error.message).toContain(path.join(workspace, ".omp", "config.yml"));
		expect(error.message).toContain(
			'Validate(sandbox.filesystem.allowWrite) error: sandbox.filesystem.allowWrite: unknown path token ${HOME} in "${HOME}/x"',
		);
	});

	it("names the overlay file, and not the global config.yml, when the bad token comes from a config overlay", async () => {
		const overlay = path.join(root, "overlay.yml");
		fs.writeFileSync(overlay, 'sandbox:\n  filesystem:\n    allowWrite:\n      - "${HOME}/x"\n');

		const error = await expectLoadError(() => Settings.init({ agentDir, cwd: workspace, configFiles: [overlay] }));

		expect(error.message).toContain(overlay);
		expect(error.message).not.toContain(path.join(agentDir, "config.yml"));
		expect(error.message).toContain("Validate(sandbox.filesystem.allowWrite)");
	});
});

describe("settings load error names the layer at fault for merged settings", () => {
	const GLOBAL = () => path.join(agentDir, "config.yml");
	const PROJECT = () => path.join(workspace, ".omp", "config.yml");

	function writeGlobal(yaml: string): void {
		fs.writeFileSync(GLOBAL(), yaml);
	}

	function writeProject(yaml: string): void {
		fs.mkdirSync(path.join(workspace, ".omp"), { recursive: true });
		fs.writeFileSync(PROJECT(), yaml);
	}

	it("names only the global layer when its own record entry fails and the project layer merges a valid one", async () => {
		writeGlobal("providers:\n  maxInFlightRequests:\n    anthropic: 0\n");
		writeProject("providers:\n  maxInFlightRequests:\n    openai: 2\n");

		const error = await expectLoadError(() => Settings.init({ agentDir, cwd: workspace }));

		expect(error.message).toContain(GLOBAL());
		expect(error.message).not.toContain(PROJECT());
		expect(error.message).toContain("Validate(providers.maxInFlightRequests)");
	});

	it("names the project layer when it holds the failing record entry over a valid global one", async () => {
		writeGlobal("providers:\n  maxInFlightRequests:\n    anthropic: 1\n");
		writeProject("providers:\n  maxInFlightRequests:\n    openai: 0\n");

		const error = await expectLoadError(() => Settings.init({ agentDir, cwd: workspace }));

		expect(error.message).toContain(PROJECT());
		expect(error.message).not.toContain(GLOBAL());
	});

	it("names both layers when each holds a failing entry under a different key", async () => {
		writeGlobal("providers:\n  maxInFlightRequests:\n    anthropic: 0\n");
		writeProject("providers:\n  maxInFlightRequests:\n    openai: 0\n");

		const error = await expectLoadError(() => Settings.init({ agentDir, cwd: workspace }));

		expect(error.message).toContain(GLOBAL());
		expect(error.message).toContain(PROJECT());
	});

	it("does not blame a lower layer's entry that a higher layer overrides with a valid value", async () => {
		writeGlobal("providers:\n  maxInFlightRequests:\n    anthropic: 0\n");
		writeProject("providers:\n  maxInFlightRequests:\n    anthropic: 2\n    openai: 0\n");

		const error = await expectLoadError(() => Settings.init({ agentDir, cwd: workspace }));

		expect(error.message).toContain(PROJECT());
		expect(error.message).not.toContain(GLOBAL());
	});

	it("does not blame a layer below a higher layer that replaces the record with a non-record value", async () => {
		writeGlobal("providers:\n  maxInFlightRequests:\n    anthropic: 0\n");
		writeProject("providers:\n  maxInFlightRequests: 7\n");
		const overlay = path.join(root, "a.yml");
		fs.writeFileSync(overlay, "providers:\n  maxInFlightRequests:\n    openai: 0\n");

		const error = await expectLoadError(() => Settings.init({ agentDir, cwd: workspace, configFiles: [overlay] }));

		expect(error.message).toContain(overlay);
		expect(error.message).not.toContain(GLOBAL());
	});

	it("names only the project file that sets the value, not other project settings files", async () => {
		writeProject("providers:\n  maxInFlightRequests:\n    openai: 0\n");
		fs.mkdirSync(path.join(workspace, ".claude"), { recursive: true });
		const claudeSettings = path.join(workspace, ".claude", "settings.json");
		fs.writeFileSync(claudeSettings, JSON.stringify({ compaction: { enabled: true } }));

		const error = await expectLoadError(() => Settings.init({ agentDir, cwd: workspace }));

		expect(error.message).toContain(PROJECT());
		expect(error.message).not.toContain(claudeSettings);
	});

	it("names only the overlay file that sets the value when several overlays are given", async () => {
		const bad = path.join(root, "a.yml");
		const other = path.join(root, "b.yml");
		fs.writeFileSync(bad, "providers:\n  maxInFlightRequests:\n    openai: 0\n");
		fs.writeFileSync(other, "compaction:\n  enabled: true\n");

		const error = await expectLoadError(() => Settings.init({ agentDir, cwd: workspace, configFiles: [bad, other] }));

		expect(error.message).toContain(bad);
		expect(error.message).not.toContain(other);
	});
});
