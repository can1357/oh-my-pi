// oxlint-disable no-template-curly-in-string -- literal `${…}` sandbox path tokens
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isSettingsInitialized, type Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import {
	applySandboxChange,
	hostApprovalFor,
	sandboxAccessView,
	sandboxHostPrompt,
	sandboxPanelModel,
	setSandboxListMember,
} from "@oh-my-pi/pi-coding-agent/modes/sandbox-panel";
import { SandboxRuntime, sandboxAccessEffect } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import {
	cfgSandboxAllowedHosts,
	cfgSandboxAllowWrite,
	cfgSandboxEnabled,
	cfgSandboxMode,
	cfgSandboxScope,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	beginSettingsTest,
	restoreEnvValue,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../helpers/settings-test-state";
import { initSandboxSettings, SANDBOX_SUPPORTED } from "../helpers/sandbox-test-state";

const UNAVAILABLE = { supported: false, reason: "bwrap\tmissing\x1b[31m", proxy: false, warnings: [] };
/** A runtime view for the panel model that reports nothing. */
const IDLE_RUNTIME = {
	status: () => ({ state: "off" as const }),
	effectivePolicy: () => ({ readwritePaths: [], readonlyPaths: [], deniedPaths: [] }),
	blockedHosts: () => [],
	sessionPaths: () => ({ write: [], read: [] }),
};

let state: SettingsTestState | undefined;
let scratch: TempDir;
let workspace: string;
let agentDir: string;

beforeEach(() => {
	state = beginSettingsTest();
	restoreEnvValue("PI_SANDBOX", undefined);
	scratch = TempDir.createSync("@omp-sandbox-panel-");
	const root = fs.realpathSync(scratch.path());
	workspace = path.join(root, "workspace");
	agentDir = path.join(root, "agent");
	for (const dir of [workspace, agentDir]) fs.mkdirSync(dir);
	SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
});

afterEach(async () => {
	try {
		// Pure tests never initialise settings; resolving a runtime would init them against the real agent dir.
		if (isSettingsInitialized()) await (await SandboxRuntime.for(workspace)).dispose();
		SandboxRuntime.resetForTest();
	} finally {
		restoreSettingsTestState(state);
		state = undefined;
		scratch.removeSync();
	}
});

/** Settings with optional global and project `sandbox:` sections. */
function init(layers: { global?: object; project?: object } = {}): Promise<Settings> {
	return initSandboxSettings({ agentDir, workspace }, layers);
}

/** Run `/sandbox …` through its non-TUI handler; returns what it printed. */
async function sandbox(args: string): Promise<string> {
	const output: string[] = [];
	const runtime = {
		session: { sessionManager: { getCwd: () => workspace } },
		output: (text: string) => void output.push(text),
	} as unknown as SlashCommandRuntime;
	expect(await executeAcpBuiltinSlashCommand(`/sandbox${args ? ` ${args}` : ""}`, runtime)).toMatchObject({
		consumed: true,
	});
	return output.join("\n");
}

describe("/sandbox command", () => {
	it("turns the sandbox on and off in the global layer", async () => {
		const settings = await init();
		expect(await sandbox("on")).toBe("Sandbox enabled.");
		expect(cfgSandboxEnabled.provenance(settings)).toBe("global");
		expect(cfgSandboxEnabled.get(settings)).toBe(true);
		expect(await sandbox("off")).toBe("Sandbox disabled.");
		expect(cfgSandboxEnabled.get(settings)).toBe(false);
	});

	it("names the layer that keeps the sandbox on when the global write cannot turn it off", async () => {
		await init({ project: { enabled: true } });
		expect(await sandbox("off")).toBe("Sandbox disabled in your config, but project config keeps it on here.");
		restoreEnvValue("PI_SANDBOX", "1");
		expect(await sandbox("off")).toBe("Sandbox disabled in your config, but $PI_SANDBOX keeps it on here.");
	});

	it("names a session override that keeps the sandbox off", async () => {
		const settings = await init();
		cfgSandboxEnabled.override(settings, false);
		expect(await sandbox("on")).toBe("Sandbox enabled in your config, but a session override keeps it off here.");
	});

	it("says, sanitized, why an enabled sandbox runs commands unsandboxed", async () => {
		SandboxRuntime.resetForTest(UNAVAILABLE);
		await init();
		expect(await sandbox("on")).toMatch(
			/^Sandbox enabled, but unavailable here: bwrap +missing \(commands run unsandboxed\)\.$/,
		);
	});

	it("reports state, hosts blocked this session and ignored project values, sanitized", async () => {
		await init({ global: { enabled: true }, project: { enabled: false } });
		vi.spyOn(SandboxRuntime.prototype, "blockedHosts").mockReturnValue(["evil\t\x1b[31m.test"]);
		const status = await sandbox("status");
		expect(status).toContain("Sandbox: active (seatbelt)");
		expect(status).toMatch(/Blocked this session: evil +\.test/);
		expect(status).toContain("Ignored project value sandbox.enabled:");
		expect(status).not.toContain("\t");
		expect(status).not.toContain("\x1b");
	});

	it("points the bare form at the TUI", async () => {
		await init();
		expect(await sandbox("")).toBe(
			"/sandbox opens an interactive panel and is only available in the interactive TUI.",
		);
	});
});

describe("/settings sandbox list editors", () => {
	const editors = [
		["sandbox.scope", { scope: ["bash"] }],
		["sandbox.filesystem.allowWrite", { filesystem: { allowWrite: ["/x"] } }],
		["sandbox.filesystem.allowRead", { filesystem: { allowRead: ["/x"] } }],
		["sandbox.filesystem.denyRead", { filesystem: { denyRead: ["/x"] } }],
		["sandbox.network.allowedHosts", { network: { allowedHosts: ["x.test"] } }],
	] as const;

	it("are hidden while the project supplies the list, so it is never promoted to global", async () => {
		const project: Record<string, unknown> = {};
		for (const [, value] of editors) Object.assign(project, value);
		await init({ project: { ...project, filesystem: { allowWrite: ["/x"], allowRead: ["/x"], denyRead: ["/x"] } } });
		const entries = createSettingsHost().entries;
		for (const [id] of editors)
			expect([id, entries.find(entry => entry.path === id)?.condition?.()]).toEqual([id, false]);
	});

	it("show while only the global layer supplies them", async () => {
		await init();
		const entries = createSettingsHost().entries;
		for (const [id] of editors)
			expect([id, entries.find(entry => entry.path === id)?.condition?.()]).toEqual([id, true]);
	});
});

describe("/sandbox panel writes", () => {
	it("persist only operator entries when the project supplies lists and scope", async () => {
		const settings = await init({
			global: { network: { allowedHosts: ["github.com"] }, filesystem: { allowWrite: ["~/cache"] } },
			project: {
				scope: ["bash", "eval", "exec"],
				network: { allowedHosts: ["exfil.test"] },
				filesystem: { allowWrite: ["/etc"] },
			},
		});
		cfgSandboxScope.set(settings, ["bash"]);
		setSandboxListMember(settings, "allowedHosts", "added.test", true);
		setSandboxListMember(settings, "allowWrite", "~/cache", false);
		// The panel shows (and toggles) scope from the operator layers.
		const model = sandboxPanelModel(settings, IDLE_RUNTIME);
		expect(model.scope).toEqual(["bash"]);
		applySandboxChange(settings, { id: "scope", value: [...model.scope, "exec"] });
		const operator = settings.grantAuthority();
		expect(cfgSandboxScope.get(operator)).toEqual(["bash", "exec"]);
		expect(cfgSandboxAllowedHosts.get(operator)).toEqual(["github.com", "added.test"]);
		expect(cfgSandboxAllowWrite.get(operator)).toEqual([]);
	});

	it("leaves the default list alone when the added host is already on it", async () => {
		const settings = await init();
		setSandboxListMember(settings, "allowedHosts", "github.com", true);
		expect(cfgSandboxAllowedHosts.provenance(settings)).toBe("default");
	});

	it("rejects an unknown path token without writing", async () => {
		const settings = await init();
		expect(() => setSandboxListMember(settings, "allowWrite", "${HOME}/x", true)).toThrow("unknown path token");
		expect(cfgSandboxAllowWrite.get(settings)).toEqual([]);
	});
});

describe("/sandbox panel model", () => {
	it("locks what another layer decides, and notes a list the project narrows", async () => {
		const settings = await init({
			global: { network: { allowedHosts: ["github.com", "pypi.org"] } },
			project: { mode: "read-only", network: { allowedHosts: ["github.com"] } },
		});
		restoreEnvValue("PI_SANDBOX", "1");
		const model = sandboxPanelModel(settings, IDLE_RUNTIME);
		expect(model.locked).toEqual({ enabled: "Set by $PI_SANDBOX", mode: "Tightened by project config" });
		expect(model.allowedHosts).toEqual(["github.com", "pypi.org"]);
		expect(model.listNotes.allowedHosts).toBe("Project config narrows this list here: 1 entry does not apply.");
	});

	it("locks a setting a session override decides, which a global write could not change", async () => {
		const settings = await init();
		cfgSandboxMode.override(settings, "read-only");
		expect(sandboxPanelModel(settings, IDLE_RUNTIME).locked).toEqual({ mode: "Set by a session override" });
	});
});

describe("sandbox access request in the panel and the dialog", () => {
	it("shows omp's own effect sentence, never the agent's text, and passes canAlways through", () => {
		const view = sandboxAccessView({
			kind: "write",
			target: "/work/out",
			intent: "Contained commands will be able to do anything.",
			workspace: "/work",
			canAlways: false,
		});
		expect(view.effect).toBe(sandboxAccessEffect("write", "/work/out"));
		expect(view.effect).not.toBe(view.intent);
		expect(view.canAlways).toBe(false);
	});
});

describe("sandbox host approval", () => {
	it("maps the dialog's answers to the runtime's", () => {
		expect(hostApprovalFor("once")).toBe("once");
		expect(hostApprovalFor({ grant: "target", always: false })).toBe("session");
		expect(hostApprovalFor({ grant: "target", always: true })).toBe("always");
		// Dismissing or aborting the dialog answers deny.
		expect(hostApprovalFor("deny")).toBe("deny");
	});

	it("names the host cleaned in the prompt", () => {
		const prompt = sandboxHostPrompt("evil\t\x1b[31m.test", 443);
		expect(prompt.full).toMatch(
			/^A sandboxed command wants to connect to evil +\.test:443, which is not on the network allowlist\.$/,
		);
		expect(prompt.grants?.[0]?.alwaysLabel).toMatch(/^Always allow evil +\.test$/);
	});
});
