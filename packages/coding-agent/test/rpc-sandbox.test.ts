// oxlint-disable no-template-curly-in-string -- literal `${…}` sandbox path tokens
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isSettingsInitialized, type Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	RpcSandboxController,
	type RpcSandboxCommand,
	RpcSandboxError,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-sandbox";
import type { RpcSandboxFrame, RpcSandboxState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { EgressProxy, type EgressProxyOptions } from "@oh-my-pi/pi-coding-agent/sandbox/egress-proxy";
import { SandboxRuntime, sandboxAccessEffect } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import {
	cfgSandboxAllowedHosts,
	cfgSandboxAllowWrite,
	cfgSandboxEnabled,
	cfgSandboxMode,
	cfgSandboxNetworkMode,
	cfgSandboxScope,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	beginSettingsTest,
	restoreEnvValue,
	restoreSettingsTestState,
	type SettingsTestState,
} from "./helpers/settings-test-state";
import {
	initSandboxSettings,
	SANDBOX_SUPPORTED as SUPPORTED,
	SANDBOX_UNAVAILABLE as UNAVAILABLE,
} from "./helpers/sandbox-test-state";

type FrameOf<T extends RpcSandboxFrame["type"]> = Extract<RpcSandboxFrame, { type: T }>;

let state: SettingsTestState | undefined;
let scratch: TempDir;
/** `<scratch>/workspace`, realpath'd, outside the (spied) tmpdir. */
let workspace: string;
let agentDir: string;
let cwd: string;
let frames: RpcSandboxFrame[];
let frameWaiters: { type: RpcSandboxFrame["type"]; resolve: (frame: RpcSandboxFrame) => void }[];
let controllers: RpcSandboxController[];

beforeEach(() => {
	state = beginSettingsTest();
	restoreEnvValue("PI_SANDBOX", undefined);
	scratch = TempDir.createSync("@omp-rpc-sandbox-");
	const root = fs.realpathSync(scratch.path());
	workspace = path.join(root, "workspace");
	agentDir = path.join(root, "agent");
	const tmp = path.join(root, "tmp");
	for (const dir of [workspace, agentDir, tmp]) fs.mkdirSync(dir);
	vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
	cwd = workspace;
	frames = [];
	frameWaiters = [];
	controllers = [];
	SandboxRuntime.resetForTest(SUPPORTED);
});

afterEach(async () => {
	try {
		for (const controller of controllers) controller.dispose();
		// Resolving a runtime would init settings against the real agent dir when a test never did.
		if (isSettingsInitialized()) {
			for (const dir of new Set([workspace, cwd])) await (await SandboxRuntime.for(dir)).dispose();
		}
		SandboxRuntime.resetForTest();
		SandboxRuntime.setHostApprover(undefined);
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

function controller(options: { hostRequestTimeoutMs?: number } = {}): RpcSandboxController {
	const instance = new RpcSandboxController({
		cwd: () => cwd,
		output: frame => {
			frames.push(frame);
			const ready = frameWaiters.filter(waiter => waiter.type === frame.type);
			frameWaiters = frameWaiters.filter(waiter => waiter.type !== frame.type);
			for (const waiter of ready) waiter.resolve(frame);
		},
		...options,
	});
	controllers.push(instance);
	return instance;
}

function nextFrame<T extends RpcSandboxFrame["type"]>(type: T): Promise<FrameOf<T>> {
	const { promise, resolve } = Promise.withResolvers<FrameOf<T>>();
	frameWaiters.push({ type, resolve: frame => resolve(frame as FrameOf<T>) });
	return promise;
}

function framesOf<T extends RpcSandboxFrame["type"]>(type: T): FrameOf<T>[] {
	return frames.filter((frame): frame is FrameOf<T> => frame.type === type);
}

/** Lets every pending `sandbox_update` tick run. */
async function settle(): Promise<void> {
	for (let i = 0; i < 3; i++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

async function stateOf(instance: RpcSandboxController, command: RpcSandboxCommand): Promise<RpcSandboxState> {
	return (await instance.handle(command)) as RpcSandboxState;
}

/** The refusal of `command`, which must fail. */
async function refusal(instance: RpcSandboxController, command: RpcSandboxCommand): Promise<RpcSandboxError> {
	const error = await instance.handle(command).then(
		() => new Error(`expected ${command.type} to fail`),
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(RpcSandboxError);
	return error as RpcSandboxError;
}

/**
 * The egress proxy's hooks into the runtime (`decide` asks the approver, `onBlocked` records a
 * refusal), captured from the runtime's first allowlist spawn; the proxy itself never starts.
 */
async function proxyHooks(): Promise<EgressProxyOptions> {
	const captured = Promise.withResolvers<EgressProxyOptions>();
	vi.spyOn(EgressProxy, "start").mockImplementation(async options => {
		captured.resolve(options);
		return { url: "http://127.0.0.1:9", port: 9, close: async () => {} } as unknown as EgressProxy;
	});
	const runtime = await SandboxRuntime.for(workspace);
	// The spawn itself may fail where no backend exists; the proxy was asked for before it.
	const child = await runtime
		.spawn({ argv: ["/usr/bin/true"], cwd: workspace, env: {}, network: "allowlist" })
		.catch(() => undefined);
	if (child) {
		child.kill();
		await child.exited;
	}
	return captured.promise;
}

describe("get_sandbox", () => {
	it("reports an off sandbox with the operator values and no session state", async () => {
		await init();
		const snapshot = await stateOf(controller(), { type: "get_sandbox" });
		expect(snapshot).toMatchObject({
			workspace,
			status: { state: "off" },
			settings: {
				enabled: false,
				mode: "workspace-write",
				scope: ["bash", "eval", "exec"],
				fallback: "warn",
				readScope: "all",
				networkMode: "allowlist",
				allowWrite: [],
				allowRead: [],
			},
			locked: {},
			listNotes: {},
			ignored: [],
			blockedHosts: [],
			sessionHosts: [],
			hostPrompts: false,
		});
		expect(snapshot.settings.allowedHosts).toContain("github.com");
		expect(snapshot.effective.readwritePaths).toContain(workspace);
	});

	it("reports an active backend and an unavailable one with its reason", async () => {
		await init({ global: { enabled: true, network: { mode: "deny" } } });
		expect((await stateOf(controller(), { type: "get_sandbox" })).status).toEqual({
			state: "active",
			backend: "seatbelt",
			network: "deny",
			warnings: [],
		});
		SandboxRuntime.resetForTest(UNAVAILABLE);
		expect((await stateOf(controller(), { type: "get_sandbox" })).status).toEqual({
			state: "unavailable",
			reason: UNAVAILABLE.reason,
			fallback: "warn",
		});
	});

	it("summarizes the status for get_state", async () => {
		await init();
		const instance = controller();
		expect(await instance.summary()).toEqual({ state: "off" });
		await instance.handle({ type: "set_sandbox_setting", setting: "enabled", value: true });
		expect(await instance.summary()).toEqual({ state: "active", backend: "seatbelt" });
	});

	it("reports project values dropped by the tighten-only rule and lists the project narrows", async () => {
		await init({
			global: { network: { allowedHosts: ["github.com", "pypi.org"] } },
			project: { filesystem: { allowWrite: ["/etc"] }, network: { allowedHosts: ["github.com"] } },
		});
		const snapshot = await stateOf(controller(), { type: "get_sandbox" });
		expect(snapshot.ignored).toContainEqual({
			id: expect.stringContaining("allowWrite"),
			reason: expect.any(String),
		});
		expect(snapshot.settings.allowWrite).toEqual([]);
		expect(snapshot.listNotes.allowedHosts).toBeString();
		expect(snapshot.settings.allowedHosts).toEqual(["github.com", "pypi.org"]);
	});
});

describe("sandbox mutations", () => {
	it("write each setting to the global layer and answer the new state", async () => {
		const settings = await init();
		const instance = controller();
		const writes = [
			["enabled", true],
			["mode", "read-only"],
			["scope", ["bash"]],
			["fallback", "block"],
			["readScope", "workspace"],
			["networkMode", "deny"],
			["allowWrite", ["~/cache"]],
			["allowRead", ["/opt/data"]],
			["denyRead", ["~/.ssh"]],
			["allowedHosts", ["example.test"]],
		] as const;
		for (const [setting, value] of writes) {
			const answer = await stateOf(instance, { type: "set_sandbox_setting", setting, value: value as never });
			expect([setting, answer.settings[setting]]).toEqual([setting, value]);
		}
		expect(cfgSandboxMode.provenance(settings)).toBe("global");
		expect(cfgSandboxScope.get(settings.grantAuthority())).toEqual(["bash"]);
		expect(cfgSandboxAllowedHosts.get(settings.grantAuthority())).toEqual(["example.test"]);
	});

	it("reset drops the global value of a scalar and of a list", async () => {
		const settings = await init({ global: { mode: "read-only", filesystem: { allowWrite: ["/x"] } } });
		const instance = controller();
		const scalar = await stateOf(instance, { type: "reset_sandbox_setting", setting: "mode" });
		expect(scalar.settings.mode).toBe("workspace-write");
		expect(cfgSandboxMode.provenance(settings)).toBe("default");
		const list = await stateOf(instance, { type: "reset_sandbox_setting", setting: "allowWrite" });
		expect(list.settings.allowWrite).toEqual([]);
		expect(cfgSandboxAllowWrite.provenance(settings)).toBe("default");
	});

	it("adds, removes and replaces list entries", async () => {
		const settings = await init();
		const instance = controller();
		const edit = (op: "add" | "remove" | "replace", entry: string, replacement?: string) =>
			stateOf(instance, { type: "edit_sandbox_list", list: "allowWrite", op, entry, replacement });
		expect((await edit("add", "~/a")).settings.allowWrite).toEqual(["~/a"]);
		expect((await edit("add", "~/b")).settings.allowWrite).toEqual(["~/a", "~/b"]);
		expect((await edit("replace", "~/a", "~/c")).settings.allowWrite).toEqual(["~/b", "~/c"]);
		// Replacing an entry with itself keeps it.
		expect((await edit("replace", "~/b", "~/b")).settings.allowWrite).toEqual(["~/b", "~/c"]);
		expect((await edit("remove", "~/b")).settings.allowWrite).toEqual(["~/c"]);
		expect(cfgSandboxAllowWrite.provenance(settings)).toBe("global");
		// A replacement the validator rejects leaves the entry in place.
		const rejected = await refusal(instance, {
			type: "edit_sandbox_list",
			list: "allowWrite",
			op: "replace",
			entry: "~/c",
			replacement: "${bogus}/x",
		});
		expect(rejected.code).toBe("invalid_value");
		expect(cfgSandboxAllowWrite.get(settings)).toEqual(["~/c"]);
	});

	it("grants a host for the session without settings, always into the global allowlist, and revokes", async () => {
		const settings = await init({ global: { network: { allowedHosts: [] } } });
		const instance = controller();
		const session = await stateOf(instance, { type: "grant_sandbox_host", host: "session.test", scope: "session" });
		expect(session.sessionHosts).toEqual(["session.test"]);
		expect(session.settings.allowedHosts).toEqual([]);
		const always = await stateOf(instance, { type: "grant_sandbox_host", host: "always.test", scope: "always" });
		expect(always.settings.allowedHosts).toEqual(["always.test"]);
		expect(always.sessionHosts).toEqual(["session.test"]);
		expect(cfgSandboxAllowedHosts.get(settings.grantAuthority())).toEqual(["always.test"]);
		const revoked = await stateOf(instance, { type: "revoke_sandbox_host", host: "session.test" });
		expect(revoked.sessionHosts).toEqual([]);
	});
});

describe("sandbox_locked", () => {
	it("refuses a setting $PI_SANDBOX decides, without writing", async () => {
		const settings = await init();
		restoreEnvValue("PI_SANDBOX", "1");
		const instance = controller();
		expect((await stateOf(instance, { type: "get_sandbox" })).locked.enabled).toBeString();
		const error = await refusal(instance, { type: "set_sandbox_setting", setting: "enabled", value: false });
		expect(error.code).toBe("sandbox_locked");
		expect((await refusal(instance, { type: "reset_sandbox_setting", setting: "enabled" })).code).toBe(
			"sandbox_locked",
		);
		restoreEnvValue("PI_SANDBOX", undefined);
		expect(cfgSandboxEnabled.provenance(settings)).toBe("default");
	});

	it("refuses a setting a session override decides, without writing", async () => {
		const settings = await init();
		cfgSandboxMode.override(settings, "read-only");
		const error = await refusal(controller(), { type: "set_sandbox_setting", setting: "mode", value: "read-only" });
		expect(error.code).toBe("sandbox_locked");
		cfgSandboxMode.clearOverride(settings);
		expect(cfgSandboxMode.provenance(settings)).toBe("default");
	});

	it("refuses a setting project config tightens, without writing", async () => {
		const settings = await init({ project: { network: { mode: "deny" } } });
		const error = await refusal(controller(), {
			type: "set_sandbox_setting",
			setting: "networkMode",
			value: "allow",
		});
		expect(error.code).toBe("sandbox_locked");
		expect(cfgSandboxNetworkMode.provenance(settings.grantAuthority())).toBe("default");
	});

	it("refuses edits of a locked list, and an always grant while the allowlist is locked", async () => {
		const settings = await init({ global: { network: { allowedHosts: [] } } });
		cfgSandboxAllowWrite.override(settings, ["/locked"]);
		cfgSandboxAllowedHosts.override(settings, ["locked.test"]);
		const instance = controller();
		const edit = await refusal(instance, { type: "edit_sandbox_list", list: "allowWrite", op: "add", entry: "/x" });
		expect(edit.code).toBe("sandbox_locked");
		const always = await refusal(instance, { type: "grant_sandbox_host", host: "x.test", scope: "always" });
		expect(always.code).toBe("sandbox_locked");
		// Nothing was granted on the way to the refusal; a session grant writes no setting and stays allowed.
		expect((await stateOf(instance, { type: "get_sandbox" })).sessionHosts).toEqual([]);
		const session = await stateOf(instance, { type: "grant_sandbox_host", host: "x.test", scope: "session" });
		expect(session.sessionHosts).toEqual(["x.test"]);
		cfgSandboxAllowWrite.clearOverride(settings);
		cfgSandboxAllowedHosts.clearOverride(settings);
		expect(cfgSandboxAllowWrite.provenance(settings)).toBe("default");
		expect(cfgSandboxAllowedHosts.get(settings)).toEqual([]);
	});

	it("refuses an always answer to a host request while the allowlist is locked, keeping it pending", async () => {
		const settings = await init({ global: { enabled: true, network: { allowedHosts: [] } } });
		const instance = controller();
		await instance.start();
		const hooks = await proxyHooks();
		await instance.handle({ type: "set_sandbox_host_prompts", enabled: true });
		cfgSandboxAllowedHosts.override(settings, ["locked.test"]);
		const request = nextFrame("sandbox_host_request");
		const answer = hooks.decide?.("asked.test", 443);
		const frame = await request;
		const always = await refusal(instance, { type: "respond_sandbox_host", requestId: frame.id, decision: "always" });
		expect(always.code).toBe("sandbox_locked");
		// Still pending: a session answer settles it, and nothing reached the global allowlist.
		await instance.handle({ type: "respond_sandbox_host", requestId: frame.id, decision: "session" });
		expect(await answer).toBe(true);
		cfgSandboxAllowedHosts.clearOverride(settings);
		expect(cfgSandboxAllowedHosts.get(settings)).toEqual([]);
	});
});

describe("invalid_value", () => {
	it("refuses wrong value types, unknown tokens, enum members and ids", async () => {
		const settings = await init();
		const instance = controller();
		const commands: RpcSandboxCommand[] = [
			{ type: "set_sandbox_setting", setting: "enabled", value: "yes" },
			{ type: "set_sandbox_setting", setting: "mode", value: true },
			{ type: "set_sandbox_setting", setting: "mode", value: "everything" },
			{ type: "set_sandbox_setting", setting: "scope", value: ["bash", "kernel"] },
			{ type: "set_sandbox_setting", setting: "allowWrite", value: "~/x" },
			{ type: "set_sandbox_setting", setting: "allowWrite", value: ["${HOME}/x"] },
			{ type: "set_sandbox_setting", setting: "allowedHosts", value: [""] },
			{ type: "set_sandbox_setting", setting: "bogus" as never, value: true },
			{ type: "reset_sandbox_setting", setting: "toString" as never },
			{ type: "edit_sandbox_list", list: "scope" as never, op: "add", entry: "bash" },
			{ type: "edit_sandbox_list", list: "allowRead", op: "add", entry: " " },
			{ type: "edit_sandbox_list", list: "allowRead", op: "add", entry: "${bogus}" },
			{ type: "edit_sandbox_list", list: "allowRead", op: "move" as never, entry: "/x" },
			{ type: "edit_sandbox_list", list: "allowRead", op: "replace", entry: "/x" },
			{ type: "grant_sandbox_host", host: "", scope: "session" },
			{ type: "grant_sandbox_host", host: "x.test", scope: "forever" as never },
			{ type: "revoke_sandbox_host", host: 7 as never },
			{ type: "set_sandbox_host_prompts", enabled: "yes" as never },
			{ type: "respond_sandbox_host", requestId: "r", decision: "maybe" as never },
		];
		for (const command of commands) {
			const error = await refusal(instance, command);
			expect([JSON.stringify(command), error.code]).toEqual([JSON.stringify(command), "invalid_value"]);
		}
		for (const setting of [cfgSandboxEnabled, cfgSandboxMode, cfgSandboxScope, cfgSandboxAllowWrite]) {
			expect([setting.id, setting.provenance(settings)]).toEqual([setting.id, "default"]);
		}
	});
});

describe("sandbox_update", () => {
	it("is not sent at start while the sandbox is off", async () => {
		await init();
		await controller().start();
		await settle();
		expect(framesOf("sandbox_update")).toEqual([]);
	});

	it("is sent once at start while the sandbox is enabled, so an unavailable backend is reported", async () => {
		SandboxRuntime.resetForTest(UNAVAILABLE);
		restoreEnvValue("PI_SANDBOX", "1");
		await init();
		await controller().start();
		await settle();
		const updates = framesOf("sandbox_update");
		expect(updates).toHaveLength(1);
		expect(updates[0].state.status).toEqual({ state: "unavailable", reason: UNAVAILABLE.reason, fallback: "warn" });
	});

	it("follows a settings change made elsewhere", async () => {
		const settings = await init();
		await controller().start();
		const update = nextFrame("sandbox_update");
		cfgSandboxEnabled.set(settings, true);
		cfgSandboxMode.set(settings, "read-only");
		cfgSandboxNetworkMode.set(settings, "deny");
		expect((await update).state.settings).toMatchObject({ enabled: true, mode: "read-only", networkMode: "deny" });
		await settle();
		expect(framesOf("sandbox_update")).toHaveLength(1);
	});

	it("follows an allowlist change made elsewhere, which leaves the policy fingerprint alone", async () => {
		const settings = await init({ global: { network: { allowedHosts: [] } } });
		await controller().start();
		const update = nextFrame("sandbox_update");
		cfgSandboxAllowedHosts.set(settings, ["added.test"]);
		expect((await update).state.settings.allowedHosts).toEqual(["added.test"]);
		await settle();
		expect(framesOf("sandbox_update")).toHaveLength(1);
	});

	it("follows blocked hosts, coalescing one tick into one frame, a grant and a revoke", async () => {
		await init({ global: { enabled: true, network: { allowedHosts: [] } } });
		const instance = controller();
		await instance.start();
		await settle();
		const hooks = await proxyHooks();
		await settle();
		frames = [];
		// Two runtime notifications in one tick make one frame carrying both.
		const blocked = nextFrame("sandbox_update");
		hooks.onBlocked?.("first.test", 443);
		hooks.onBlocked?.("second.test", 443);
		expect((await blocked).state.blockedHosts).toEqual(["second.test", "first.test"]);
		await settle();
		expect(framesOf("sandbox_update")).toHaveLength(1);
		const granted = nextFrame("sandbox_update");
		await instance.handle({ type: "grant_sandbox_host", host: "first.test", scope: "session" });
		const after = (await granted).state;
		expect(after.blockedHosts).toEqual(["second.test"]);
		expect(after.sessionHosts).toEqual(["first.test"]);
		const revoked = nextFrame("sandbox_update");
		await instance.handle({ type: "revoke_sandbox_host", host: "first.test" });
		expect((await revoked).state.sessionHosts).toEqual([]);
	});

	it("moves to the session's new workspace and stops following the old one", async () => {
		await init();
		const instance = controller();
		await instance.start();
		const other = path.join(path.dirname(workspace), "other");
		fs.mkdirSync(other);
		cwd = other;
		const moved = nextFrame("sandbox_update");
		instance.syncWorkspace();
		expect((await moved).state.workspace).toBe(other);
		await settle();
		frames = [];
		(await SandboxRuntime.for(workspace)).notify();
		await settle();
		expect(framesOf("sandbox_update")).toEqual([]);
		(await SandboxRuntime.for(other)).notify();
		await nextFrame("sandbox_update");
	});

	it("stops after dispose", async () => {
		const settings = await init();
		const instance = controller();
		await instance.start();
		instance.dispose();
		cfgSandboxEnabled.set(settings, true);
		await settle();
		expect(framesOf("sandbox_update")).toEqual([]);
	});
});

describe("sandbox host prompts", () => {
	it("are off by default: an unknown host is refused without a frame", async () => {
		await init({ global: { enabled: true, network: { allowedHosts: [] } } });
		await controller().start();
		const hooks = await proxyHooks();
		expect(await hooks.decide?.("unknown.test", 443)).toBe(false);
		await settle();
		expect(framesOf("sandbox_host_request")).toEqual([]);
	});

	it("round-trip each decision through the proxy; session and always are recorded by the runtime", async () => {
		const settings = await init({ global: { enabled: true, network: { allowedHosts: [] } } });
		const instance = controller();
		await instance.start();
		const hooks = await proxyHooks();
		const decide = (host: string) => hooks.decide?.(host, 443) ?? Promise.resolve(false);
		await settle();
		const promptsOn = nextFrame("sandbox_update");
		expect(await instance.handle({ type: "set_sandbox_host_prompts", enabled: true })).toEqual({ enabled: true });
		expect((await promptsOn).state.hostPrompts).toBe(true);
		const answers: Record<string, boolean> = {};
		let lastId = "";
		for (const decision of ["once", "session", "always", "deny"] as const) {
			const host = `${decision}.test`;
			const request = nextFrame("sandbox_host_request");
			const answer = decide(host);
			const frame = await request;
			lastId = frame.id;
			expect(frame).toMatchObject({ host, port: 443, timeoutMs: 120_000 });
			expect(await instance.handle({ type: "respond_sandbox_host", requestId: frame.id, decision })).toBeUndefined();
			answers[decision] = await answer;
		}
		expect(answers).toEqual({ once: true, session: true, always: true, deny: false });
		const after = await stateOf(instance, { type: "get_sandbox" });
		expect(after.sessionHosts).toEqual(["session.test"]);
		expect(cfgSandboxAllowedHosts.get(settings.grantAuthority())).toEqual(["always.test"]);
		// The session grant answers the next ask without a prompt.
		frames = [];
		expect(await decide("session.test")).toBe(true);
		expect(framesOf("sandbox_host_request")).toEqual([]);
		// An answered request cannot be answered again.
		const stale = await refusal(instance, { type: "respond_sandbox_host", requestId: lastId, decision: "once" });
		expect(stale.code).toBe("unknown_request");
	});

	it("deny and cancel a request left unanswered past its timeout", async () => {
		await init({ global: { enabled: true, network: { allowedHosts: [] } } });
		const instance = controller({ hostRequestTimeoutMs: 20 });
		await instance.start();
		const hooks = await proxyHooks();
		await instance.handle({ type: "set_sandbox_host_prompts", enabled: true });
		const request = nextFrame("sandbox_host_request");
		const cancelled = nextFrame("sandbox_host_request_cancelled");
		const answer = hooks.decide?.("slow.test", 443);
		const frame = await request;
		expect(frame.timeoutMs).toBe(20);
		expect(await cancelled).toEqual({ type: "sandbox_host_request_cancelled", id: frame.id, reason: "timeout" });
		expect(await answer).toBe(false);
		const late = await refusal(instance, { type: "respond_sandbox_host", requestId: frame.id, decision: "once" });
		expect(late.code).toBe("unknown_request");
	});

	it("ask once per host while a request is pending", async () => {
		await init({ global: { enabled: true, network: { allowedHosts: [] } } });
		const instance = controller();
		await instance.start();
		const hooks = await proxyHooks();
		await instance.handle({ type: "set_sandbox_host_prompts", enabled: true });
		const request = nextFrame("sandbox_host_request");
		const first = hooks.decide?.("twice.test", 443);
		const frame = await request;
		const second = hooks.decide?.("twice.test", 8443);
		await settle();
		expect(framesOf("sandbox_host_request")).toHaveLength(1);
		await instance.handle({ type: "respond_sandbox_host", requestId: frame.id, decision: "once" });
		expect([await first, await second]).toEqual([true, true]);
	});

	for (const [label, end] of [
		[
			"turning prompts off",
			(instance: RpcSandboxController) => instance.handle({ type: "set_sandbox_host_prompts", enabled: false }),
		],
		["ending the session", (instance: RpcSandboxController) => instance.dispose()],
	] as const) {
		it(`${label} denies and cancels pending requests and uninstalls the approver`, async () => {
			await init({ global: { enabled: true, network: { allowedHosts: [] } } });
			const instance = controller();
			await instance.start();
			const hooks = await proxyHooks();
			await instance.handle({ type: "set_sandbox_host_prompts", enabled: true });
			const request = nextFrame("sandbox_host_request");
			const answer = hooks.decide?.("pending.test", 443);
			const frame = await request;
			await end(instance);
			expect(framesOf("sandbox_host_request_cancelled")).toEqual([
				{ type: "sandbox_host_request_cancelled", id: frame.id, reason: "aborted" },
			]);
			expect(await answer).toBe(false);
			expect(await hooks.decide?.("later.test", 443)).toBe(false);
			expect(framesOf("sandbox_host_request")).toHaveLength(1);
		});
	}

	it("cannot be turned on after the session ended", async () => {
		await init({ global: { enabled: true, network: { allowedHosts: [] } } });
		const instance = controller();
		await instance.start();
		const hooks = await proxyHooks();
		instance.dispose();
		expect(await instance.handle({ type: "set_sandbox_host_prompts", enabled: true })).toEqual({ enabled: false });
		expect(await hooks.decide?.("late.test", 443)).toBe(false);
		expect(framesOf("sandbox_host_request")).toEqual([]);
	});
});

describe("sandbox access requests", () => {
	/** `<scratch>/outside`: not writable or listed, outside the workspace and the (spied) tmpdir. */
	let outside: string;

	beforeEach(() => {
		outside = path.join(path.dirname(workspace), "outside");
		fs.mkdirSync(outside);
	});

	/** The runtime of `workspace` with the sandbox enabled, and a controller over it. */
	async function enabled(options: { prompts?: boolean } = {}) {
		const settings = await init({ global: { enabled: true } });
		const instance = controller();
		await instance.start();
		if (options.prompts !== false) {
			expect(await instance.handle({ type: "set_sandbox_access_prompts", enabled: true })).toEqual({
				enabled: true,
			});
		}
		await settle();
		return { settings, instance, runtime: await SandboxRuntime.for(workspace) };
	}

	it("are refused without a frame unless the client opted in", async () => {
		const { runtime } = await enabled({ prompts: false });
		const outcome = await runtime.requestAccess({
			kind: "write",
			target: outside,
			intent: "Write the build output.",
		});
		expect(outcome.status).toBe("refused");
		expect(framesOf("sandbox_access_request")).toEqual([]);
	});

	it("round-trip each decision; grants show up in the state and in global config", async () => {
		const { settings, instance, runtime } = await enabled();
		expect((await stateOf(instance, { type: "get_sandbox" })).accessPrompts).toBe(true);
		const outcomes: Record<string, unknown> = {};
		for (const decision of ["session", "always", "deny", "instruct"] as const) {
			const target = path.join(outside, decision);
			fs.mkdirSync(target);
			const request = nextFrame("sandbox_access_request");
			const outcome = runtime.requestAccess({
				kind: "write",
				target,
				intent: "Write the release build output.",
				command: "make release",
				alternative: "Write it under ./out instead.",
			});
			const frame = await request;
			expect(frame).toEqual({
				type: "sandbox_access_request",
				id: frame.id,
				kind: "write",
				target,
				intent: "Write the release build output.",
				command: "make release",
				alternative: "Write it under ./out instead.",
				effect: sandboxAccessEffect("write", target),
				workspace,
				canAlways: true,
			});
			const answer =
				decision === "instruct"
					? ({
							type: "respond_sandbox_access",
							requestId: frame.id,
							decision,
							instructions: "Use ./out.",
						} as const)
					: ({ type: "respond_sandbox_access", requestId: frame.id, decision } as const);
			expect(await instance.handle(answer)).toBeUndefined();
			outcomes[decision] = await outcome;
		}
		expect(outcomes).toEqual({
			session: { status: "granted", scope: "session", target: path.join(outside, "session") },
			always: { status: "granted", scope: "always", target: path.join(outside, "always") },
			deny: { status: "denied", target: path.join(outside, "deny") },
			instruct: { status: "instructed", target: path.join(outside, "instruct"), instructions: "Use ./out." },
		});
		const after = await stateOf(instance, { type: "get_sandbox" });
		expect(after.sessionPaths.write).toEqual([path.join(outside, "session")]);
		expect(cfgSandboxAllowWrite.get(settings.grantAuthority())).toEqual([path.join(outside, "always")]);
	});

	it("refuse a blank instruction and an unknown id, keeping the request pending", async () => {
		const { instance, runtime } = await enabled();
		const request = nextFrame("sandbox_access_request");
		const outcome = runtime.requestAccess({ kind: "write", target: outside, intent: "Write the build output." });
		const frame = await request;
		const blank = await refusal(instance, {
			type: "respond_sandbox_access",
			requestId: frame.id,
			decision: "instruct",
			instructions: "  ",
		});
		expect(blank.code).toBe("invalid_value");
		const missing = await refusal(instance, {
			type: "respond_sandbox_access",
			requestId: frame.id,
			decision: "instruct",
		});
		expect(missing.code).toBe("invalid_value");
		const unknown = await refusal(instance, { type: "respond_sandbox_access", requestId: "nope", decision: "deny" });
		expect(unknown.code).toBe("unknown_request");
		await instance.handle({ type: "respond_sandbox_access", requestId: frame.id, decision: "deny" });
		expect(await outcome).toEqual({ status: "denied", target: outside });
		const answered = await refusal(instance, {
			type: "respond_sandbox_access",
			requestId: frame.id,
			decision: "deny",
		});
		expect(answered.code).toBe("unknown_request");
	});

	it("refuse an always answer while the backing list is locked, keeping the request pending", async () => {
		const { settings, instance, runtime } = await enabled();
		cfgSandboxAllowWrite.override(settings, ["/locked"]);
		const request = nextFrame("sandbox_access_request");
		const outcome = runtime.requestAccess({ kind: "write", target: outside, intent: "Write the build output." });
		const frame = await request;
		expect(frame.canAlways).toBe(false);
		const always = await refusal(instance, {
			type: "respond_sandbox_access",
			requestId: frame.id,
			decision: "always",
		});
		expect(always.code).toBe("sandbox_locked");
		await instance.handle({ type: "respond_sandbox_access", requestId: frame.id, decision: "session" });
		expect(await outcome).toEqual({ status: "granted", scope: "session", target: outside });
		cfgSandboxAllowWrite.clearOverride(settings);
		expect(cfgSandboxAllowWrite.provenance(settings)).toBe("default");
	});

	it("refuse an always answer when project config supplies the backing list, keeping the request pending", async () => {
		const settings = await init({ global: { enabled: true }, project: { filesystem: { allowWrite: [] } } });
		const instance = controller();
		await instance.start();
		await instance.handle({ type: "set_sandbox_access_prompts", enabled: true });
		const runtime = await SandboxRuntime.for(workspace);
		const request = nextFrame("sandbox_access_request");
		const outcome = runtime.requestAccess({ kind: "write", target: outside, intent: "Write the build output." });
		const frame = await request;
		expect(frame.canAlways).toBe(false);
		const always = await refusal(instance, {
			type: "respond_sandbox_access",
			requestId: frame.id,
			decision: "always",
		});
		expect(always.code).toBe("sandbox_locked");
		await instance.handle({ type: "respond_sandbox_access", requestId: frame.id, decision: "session" });
		expect(await outcome).toEqual({ status: "granted", scope: "session", target: outside });
		expect(cfgSandboxAllowWrite.get(settings.grantAuthority())).toEqual([]);
	});

	it("cancel a pending request when its tool call is aborted", async () => {
		const { runtime } = await enabled();
		const abort = new AbortController();
		const request = nextFrame("sandbox_access_request");
		const outcome = runtime
			.requestAccess({ kind: "write", target: outside, intent: "Write the build output." }, abort.signal)
			.catch((error: unknown) => error);
		const frame = await request;
		abort.abort();
		await outcome;
		expect(framesOf("sandbox_access_request_cancelled")).toEqual([
			{ type: "sandbox_access_request_cancelled", id: frame.id, reason: "aborted" },
		]);
		expect(runtime.sessionPaths().write).toEqual([]);
	});

	for (const [label, end] of [
		[
			"turning prompts off",
			(instance: RpcSandboxController) => instance.handle({ type: "set_sandbox_access_prompts", enabled: false }),
		],
		["ending the session", (instance: RpcSandboxController) => instance.dispose()],
	] as const) {
		it(`${label} denies and cancels pending requests, drops queued ones and uninstalls the approver`, async () => {
			const { instance, runtime } = await enabled();
			const request = nextFrame("sandbox_access_request");
			const outcome = runtime.requestAccess({ kind: "write", target: outside, intent: "Write the build output." });
			const frame = await request;
			// Queued behind the open request: it must not raise a frame once prompts are gone.
			const queuedTarget = path.join(outside, "queued");
			const queued = runtime.requestAccess({ kind: "write", target: queuedTarget, intent: "Write the cache." });
			await end(instance);
			expect(framesOf("sandbox_access_request_cancelled")).toEqual([
				{ type: "sandbox_access_request_cancelled", id: frame.id, reason: "aborted" },
			]);
			expect(await outcome).toEqual({ status: "denied", target: outside });
			expect(await queued).toEqual({ status: "denied", target: queuedTarget });
			const later = await runtime.requestAccess({
				kind: "write",
				target: outside,
				intent: "Write the build output.",
			});
			expect(later.status).toBe("refused");
			expect(framesOf("sandbox_access_request")).toHaveLength(1);
		});
	}

	it("cannot be turned on after the session ended", async () => {
		const { instance, runtime } = await enabled({ prompts: false });
		instance.dispose();
		expect(await instance.handle({ type: "set_sandbox_access_prompts", enabled: true })).toEqual({ enabled: false });
		const outcome = await runtime.requestAccess({
			kind: "write",
			target: outside,
			intent: "Write the build output.",
		});
		expect(outcome.status).toBe("refused");
		expect(framesOf("sandbox_access_request")).toEqual([]);
	});

	it("grant and revoke a session path, each answering and pushing the new state", async () => {
		const { instance } = await enabled({ prompts: false });
		const granted = nextFrame("sandbox_update");
		const answer = await stateOf(instance, { type: "grant_sandbox_path", kind: "write", path: outside });
		expect(answer.sessionPaths).toEqual({ write: [outside], read: [] });
		expect(answer.effective.readwritePaths).toContain(outside);
		expect((await granted).state.sessionPaths.write).toEqual([outside]);
		const revoked = nextFrame("sandbox_update");
		const after = await stateOf(instance, { type: "revoke_sandbox_path", kind: "write", path: outside });
		expect(after.sessionPaths).toEqual({ write: [], read: [] });
		expect((await revoked).state.sessionPaths.write).toEqual([]);
	});

	it("refuse a path the runtime will not grant, and a bad kind", async () => {
		const { instance } = await enabled({ prompts: false });
		const root = await refusal(instance, { type: "grant_sandbox_path", kind: "write", path: "/" });
		expect(root.code).toBe("invalid_value");
		const kind = await refusal(instance, { type: "grant_sandbox_path", kind: "host" as never, path: outside });
		expect(kind.code).toBe("invalid_value");
		expect((await stateOf(instance, { type: "get_sandbox" })).sessionPaths).toEqual({ write: [], read: [] });
	});
});
