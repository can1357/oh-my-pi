import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isSettingsInitialized, resetSettingsForTest, type Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import {
	applySandboxChange,
	hostApprovalFor,
	sandboxHostPrompt,
	sandboxPanelModel,
	setSandboxListMember,
} from "@oh-my-pi/pi-coding-agent/modes/sandbox-panel";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import {
	cfgSandboxAllowedHosts,
	cfgSandboxAllowWrite,
	cfgSandboxEnabled,
	cfgSandboxMode,
	cfgSandboxNetworkMode,
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

const UNAVAILABLE = {
	supported: false,
	reason: "bwrap\tmissing\x1b[31m",
	proxy: false,
	warnings: [],
	networkMissing: [],
};
/** bubblewrap without MXC's network tooling: only `deny` is enforceable. */
const NO_NETWORK_TOOLS = {
	supported: true,
	backend: "bubblewrap" as const,
	proxy: false,
	warnings: [],
	networkMissing: ["slirp4netns", "ip"],
};
const ALLOW_REASON =
	'Network mode "allow" is unavailable on this host: packages slirp4netns, iproute2 are missing (commands: slirp4netns, ip). Install them to use this mode.';
const ALLOWLIST_REASON =
	'Network mode "allowlist" is unavailable on this host: packages slirp4netns, iproute2 are missing (commands: slirp4netns, ip). Install them to use this mode.';
/** A runtime view for the panel model that reports nothing. */
const IDLE_RUNTIME = {
	status: () => ({ state: "off" as const }),
	effectivePolicy: () => ({ readwritePaths: [], readonlyPaths: [], deniedPaths: [], protectedPaths: [] }),
	blockedHosts: () => [],
	sessionPaths: () => ({ write: [], read: [] }),
	sessionExec: () => [],
	createdPaths: () => [],
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
		// Persisted settings opened <agentDir>/agent.db; Windows cannot delete an open file.
		AgentStorage.close();
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

	it.each([
		["project config", "Sandbox disabled in your config, but project config keeps it on here.", "off"],
		["$PI_SANDBOX", "Sandbox disabled in your config, but $PI_SANDBOX keeps it on here.", "off"],
		["a session override", "Sandbox enabled in your config, but a session override keeps it off here.", "on"],
	] as const)("names %s as the layer that overrides the global write", async (layer, message, command) => {
		const settings = await init(layer === "a session override" ? {} : { project: { enabled: true } });
		if (layer === "$PI_SANDBOX") restoreEnvValue("PI_SANDBOX", "1");
		if (layer === "a session override") cfgSandboxEnabled.override(settings, false);
		expect(await sandbox(command)).toBe(message);
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
		await init();
		const shown = createSettingsHost().entries;
		for (const [id] of editors)
			expect([id, shown.find(entry => entry.path === id)?.condition?.()]).toEqual([id, true]);
		const project: Record<string, unknown> = {};
		for (const [, value] of editors) Object.assign(project, value);
		resetSettingsForTest();
		await init({ project: { ...project, filesystem: { allowWrite: ["/x"], allowRead: ["/x"], denyRead: ["/x"] } } });
		const entries = createSettingsHost().entries;
		for (const [id] of editors)
			expect([id, entries.find(entry => entry.path === id)?.condition?.()]).toEqual([id, false]);
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

	it("counts distinct entries when a layer repeats one", async () => {
		// Project repeats `a` and omits `b`: one entry dropped, though the lengths match.
		const settings = await init({
			global: { network: { allowedHosts: ["a.test", "b.test"] }, filesystem: { denyRead: ["/a", "/a"] } },
			project: { network: { allowedHosts: ["a.test", "a.test"] }, filesystem: { denyRead: ["/a", "/b"] } },
		});
		const model = sandboxPanelModel(settings, IDLE_RUNTIME);
		expect(model.listNotes.allowedHosts).toBe("Project config narrows this list here: 1 entry does not apply.");
		expect(model.listNotes.denyRead).toBe("Project config denies 1 more path here.");
	});

	it("does not count a repeated operator entry as one the project dropped", async () => {
		const settings = await init({
			global: { network: { allowedHosts: ["a.test", "a.test", "b.test"] } },
			project: { network: { allowedHosts: ["a.test", "b.test"] } },
		});
		expect(sandboxPanelModel(settings, IDLE_RUNTIME).listNotes.allowedHosts).toBeUndefined();
	});

	it("locks scope when the project adds entries to it, and only then", async () => {
		const widened = await init({ global: { scope: ["bash"] }, project: { scope: ["bash", "eval"] } });
		const model = sandboxPanelModel(widened, IDLE_RUNTIME);
		expect(model.scope).toEqual(["bash"]);
		expect(model.locked.scope).toBe("Tightened by project config");
		resetSettingsForTest();
		const same = await init({ global: { scope: ["bash", "eval"] }, project: { scope: ["bash", "eval"] } });
		expect(sandboxPanelModel(same, IDLE_RUNTIME).locked.scope).toBeUndefined();
	});
});

describe("network modes this host cannot enforce", () => {
	it("carry their reason in the panel model", async () => {
		SandboxRuntime.resetForTest(NO_NETWORK_TOOLS);
		const settings = await init();
		expect(sandboxPanelModel(settings, IDLE_RUNTIME).networkUnavailable).toEqual({
			allowlist: ALLOWLIST_REASON,
			allow: ALLOW_REASON,
		});
		SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
		expect(sandboxPanelModel(settings, IDLE_RUNTIME).networkUnavailable).toEqual({});
	});

	it("are refused by the panel, which writes nothing; deny is written", async () => {
		SandboxRuntime.resetForTest(NO_NETWORK_TOOLS);
		const settings = await init();
		expect(() => applySandboxChange(settings, { id: "networkMode", value: "allow" })).toThrow(ALLOW_REASON);
		expect(cfgSandboxNetworkMode.provenance(settings)).toBe("default");
		applySandboxChange(settings, { id: "networkMode", value: "deny" });
		expect(cfgSandboxNetworkMode.get(settings)).toBe("deny");
	});

	it("are disabled in /settings with the reason, and refused there", async () => {
		SandboxRuntime.resetForTest(NO_NETWORK_TOOLS);
		const settings = await init();
		const host = createSettingsHost();
		const ui = host.entries.find(entry => entry.path === "sandbox.network.mode")?.ui;
		expect(ui?.options).toEqual([
			{ value: "allowlist", label: "Allowlist (unavailable)", description: ALLOWLIST_REASON, disabled: true },
			{ value: "deny", label: "Deny", description: "No network access." },
			{ value: "allow", label: "Allow (unavailable)", description: ALLOW_REASON, disabled: true },
		]);
		// The row's wrapped description carries every reason, so a plain terminal shows the packages.
		expect(ui?.description).toBe(`Network access of contained commands. ${ALLOWLIST_REASON} ${ALLOW_REASON}`);
		expect(() => host.set("sandbox.network.mode", "allow")).toThrow(ALLOW_REASON);
		expect(cfgSandboxNetworkMode.provenance(settings)).toBe("default");
		host.set("sandbox.network.mode", "deny");
		expect(cfgSandboxNetworkMode.get(settings)).toBe("deny");
	});

	it("are all offered by /settings where the host enforces them", async () => {
		const settings = await init();
		const host = createSettingsHost();
		const options = host.entries.find(entry => entry.path === "sandbox.network.mode")?.ui?.options;
		expect(options === "runtime" ? options : options?.map(option => option.disabled)).toEqual([
			undefined,
			undefined,
			undefined,
		]);
		expect(host.entries.find(entry => entry.path === "sandbox.network.mode")?.ui?.description).toBe(
			"Network access of contained commands",
		);
		host.set("sandbox.network.mode", "allow");
		expect(cfgSandboxNetworkMode.get(settings)).toBe("allow");
	});

	it("are named once by /sandbox status when configured, which shows the network denied", async () => {
		SandboxRuntime.resetForTest(NO_NETWORK_TOOLS);
		await init({ global: { enabled: true, network: { mode: "allow" } } });
		const status = await sandbox("status");
		expect(status).toContain("· network deny ·");
		expect(status.split(ALLOW_REASON)).toHaveLength(2);
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
		expect(prompt.full).toMatch(/evil +\.test:443/);
		expect(prompt.full).not.toMatch(/[\x00-\x1f]/);
		expect(prompt.grants?.[0]?.alwaysLabel).toMatch(/^Always allow evil +\.test$/);
	});
});
