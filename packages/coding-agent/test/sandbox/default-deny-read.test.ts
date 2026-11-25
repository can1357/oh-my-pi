import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	readSandboxConfig,
	resolveFsPolicy,
	type SandboxPolicyContext,
} from "@oh-my-pi/pi-coding-agent/sandbox/policy";
import { getAgentDir, getConfigRootDir, TempDir } from "@oh-my-pi/pi-utils";
import {
	beginSettingsTest,
	restoreEnvValue,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../helpers/settings-test-state";

describe("default sandbox denyRead covers every .env omp loads", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;

	beforeEach(() => {
		state = beginSettingsTest();
		restoreEnvValue("PI_SANDBOX", undefined);
		restoreEnvValue("PI_CONFIG_FILES", undefined);
		tempDir = TempDir.createSync("@pi-sandbox-default-deny-");
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		tempDir.removeSync();
	});

	it("denies ~/.env, <configRoot>/.env and <agentDir>/.env under the default settings", async () => {
		const settings = await Settings.loadReadOnly({ agentDir: tempDir.join("agent"), cwd: tempDir.join("project") });
		const config = readSandboxConfig(settings);
		const ctx: SandboxPolicyContext = {
			workspace: tempDir.join("project"),
			home: tempDir.join("home"),
			tmpdir: tempDir.join("tmp"),
			platform: process.platform,
			rootEntries: [],
			discovered: { readonlyPaths: [], readwritePaths: [] },
			runtimePaths: [],
		};
		const denied = resolveFsPolicy(config, ctx).deniedPaths;
		expect(denied).toContain(path.join(ctx.home, ".env"));
		expect(denied).toContain(path.join(getConfigRootDir(), ".env"));
		expect(denied).toContain(path.join(getAgentDir(), ".env"));
	});
});
