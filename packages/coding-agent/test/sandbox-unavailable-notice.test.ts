/**
 * Interactive mode's startup notice for an enabled but unavailable sandbox replaces the runtime's
 * own once-only warning: the first contained call must not repeat it, while other runtime warnings
 * still reach the live sink.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { sandboxUnavailableNotice } from "@oh-my-pi/pi-coding-agent/main";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import {
	cfgSandboxAllowWrite,
	cfgSandboxEnabled,
	cfgSandboxFallback,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SANDBOX_UNAVAILABLE } from "./helpers/sandbox-test-state";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let state: SettingsTestState | undefined;
let scratch: TempDir;
let root: string;
let workspace: string;
let settings: Settings;
let warnings: string[];
let runtimes: SandboxRuntime[];

beforeEach(async () => {
	state = beginSettingsTest();
	scratch = TempDir.createSync("@omp-sandbox-unavailable-notice-");
	root = fs.realpathSync(scratch.path());
	workspace = path.join(root, "workspace");
	fs.mkdirSync(workspace);
	fs.mkdirSync(path.join(root, "agent"));
	SandboxRuntime.resetForTest(SANDBOX_UNAVAILABLE);
	settings = await Settings.init({ inMemory: true, agentDir: path.join(root, "agent"), cwd: workspace });
	cfgSandboxEnabled.set(settings, true);
	warnings = [];
	runtimes = [];
	SandboxRuntime.setWarningSink(message => warnings.push(message));
});

afterEach(async () => {
	try {
		for (const instance of runtimes) await instance.dispose();
		SandboxRuntime.setWarningSink(undefined);
		SandboxRuntime.resetForTest();
	} finally {
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		scratch.removeSync();
	}
});

async function runtime(): Promise<SandboxRuntime> {
	const instance = await SandboxRuntime.for(workspace);
	runtimes.push(instance);
	return instance;
}

describe("sandboxUnavailableNotice", () => {
	it("without the startup notice, the first contained call warns once through the sink", async () => {
		const instance = await runtime();
		expect(instance.applies("bash")).toBe(false);
		expect(instance.applies("bash")).toBe(false);
		expect(warnings).toEqual([
			`Sandbox unavailable (${SANDBOX_UNAVAILABLE.reason}); running unsandboxed because sandbox.fallback is "warn".`,
		]);
	});

	it("the block notice leaves the runtime's warning unclaimed", async () => {
		cfgSandboxFallback.set(settings, "block");
		const notice = await sandboxUnavailableNotice(settings, workspace);
		expect(notice).toContain("Contained tools fail until a backend is available");
		// A later switch to `warn` still raises the runtime's own warning once.
		cfgSandboxFallback.set(settings, "warn");
		expect((await runtime()).applies("bash")).toBe(false);
		expect(warnings).toHaveLength(1);
	});

	it.skipIf(process.platform === "win32")(
		"after the warn notice, a contained call adds nothing while a re-pointed allowWrite entry still warns",
		async () => {
			const allowed = path.join(root, "allowed");
			const elsewhere = path.join(root, "elsewhere");
			fs.mkdirSync(allowed);
			fs.mkdirSync(elsewhere);
			cfgSandboxAllowWrite.set(settings, [allowed]);
			const notice = await sandboxUnavailableNotice(settings, workspace);
			expect(notice).toBe(`Sandbox unavailable: ${SANDBOX_UNAVAILABLE.reason}. Commands run unsandboxed.`);
			const instance = await runtime();
			expect(instance.applies("bash")).toBe(false);
			expect(warnings).toEqual([]);
			// Pin the entry, then re-point it: the runtime warns live through the same sink.
			expect(instance.effectivePolicy().readwritePaths).toContain(allowed);
			fs.rmSync(allowed, { recursive: true });
			fs.symlinkSync(elsewhere, allowed);
			instance.effectivePolicy();
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain(`${allowed} now resolves to ${elsewhere}`);
		},
	);
});
