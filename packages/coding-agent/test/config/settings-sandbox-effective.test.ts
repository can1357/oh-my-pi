import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	beginSettingsTest,
	restoreEnvValue,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../helpers/settings-test-state";
import { initSandboxSettings } from "../helpers/sandbox-test-state";

let state: SettingsTestState | undefined;
let scratch: TempDir;
let workspace: string;
let agentDir: string;

beforeEach(() => {
	state = beginSettingsTest();
	restoreEnvValue("PI_SANDBOX", undefined);
	scratch = TempDir.createSync("@omp-settings-sandbox-effective-");
	const root = fs.realpathSync(scratch.path());
	workspace = path.join(root, "workspace");
	agentDir = path.join(root, "agent");
	for (const dir of [workspace, agentDir]) fs.mkdirSync(dir);
});

afterEach(() => {
	restoreSettingsTestState(state);
	state = undefined;
	scratch.removeSync();
});

describe("/settings sandbox rows", () => {
	it("show the effective value when the project layer tries to loosen the sandbox", async () => {
		await initSandboxSettings(
			{ agentDir, workspace },
			{
				global: { enabled: true, fallback: "block", network: { mode: "allowlist" } },
				project: { enabled: false, fallback: "warn", network: { mode: "allow" } },
			},
		);
		const host = createSettingsHost();
		expect(host.get("sandbox.enabled")).toBe(true);
		expect(host.get("sandbox.fallback")).toBe("block");
		expect(host.get("sandbox.network.mode")).toBe("allowlist");
	});

	it("show the project value when it tightens the sandbox", async () => {
		await initSandboxSettings(
			{ agentDir, workspace },
			{
				global: { mode: "workspace-write", filesystem: { readScope: "all" } },
				project: { mode: "read-only", filesystem: { readScope: "workspace" } },
			},
		);
		const host = createSettingsHost();
		expect(host.get("sandbox.mode")).toBe("read-only");
		expect(host.get("sandbox.filesystem.readScope")).toBe("workspace");
	});

	it("reflect an edit, which writes the global layer", async () => {
		await initSandboxSettings({ agentDir, workspace }, { global: { network: { mode: "allow" } } });
		const host = createSettingsHost();
		host.set("sandbox.network.mode", "deny");
		expect(host.get("sandbox.network.mode")).toBe("deny");
	});
});
